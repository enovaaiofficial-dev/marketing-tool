// Orchestrator for the Facebook Chat Groups Creator module.
//
// Responsibilities:
//   - validate the source account token,
//   - log into biar-fca (via FCA session derived from the token),
//   - iterate over a planned list of N groups, each with up to 250
//     planned member IDs,
//   - create each group (sendMessage with array of seed users),
//     rename it (gcname), and add the remainder in batches (gcmember),
//   - emit progress + log events to the renderer at every step,
//   - persist progress to SQLite so the run is resumable after a
//     pause/stop or app restart,
//   - write a CSV report incrementally.
//
// Design notes:
//   - A run's "plan" (which IDs go into which group) is fixed at start
//     time and stored in chat_groups_created. This keeps Pause/Resume
//     deterministic.
//   - Pause vs. Stop: Pause leaves the run in 'paused' status and
//     keeps in-flight groups in 'creating'/'filling' so resume can
//     continue them. Stop marks the run 'stopped' and ends the loop.
//   - Each group seeds with FCA_SEED_BATCH (max 18) IDs at creation
//     time because Facebook's create-group endpoint chokes on bigger
//     payloads. The remaining members are added through gcmember in
//     `settings.batch_size` chunks.

import type { BrowserWindow } from "electron";
import { app, dialog } from "electron";
import { appendFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { getDecryptedToken, updateAccountStatus } from "../db/accounts-repo";
import { validateToken } from "../api/platform-client";
import {
  classifyFcaError,
  loginWithAccessToken,
  type FcaSession,
} from "../api/fca-client";
import {
  createRun,
  getGroupMemberIds,
  getRun,
  insertPlannedGroups,
  recordError,
  setGroupStatus,
  setRunStatus,
  updateRunCounts,
} from "../db/chat-repo";
import type {
  ChatLogEntry,
  ChatProgress,
  ChatRunSettings,
  ChatRunStatus,
} from "@shared/types";

const MAX_GROUP_SIZE = 250; // Facebook's hard cap; do not change.
/**
 * Adaptive seed sizes tried by `createGroupAdaptive` when the previous
 * attempt fails with an invalid-recipient style error. Smaller seeds
 * are faster to fail and more likely to succeed when the planned list
 * contains stale / unreachable IDs.
 */
const SEED_SIZES = [8, 5, 3, 2] as const;
const MAX_SEED_ATTEMPTS = 6;
const SEED_RETRY_DELAY_MS = 2000;
const PROGRESS_EMIT_THROTTLE_MS = 250;

// =====================================================================
// Public types
// =====================================================================

export interface StartParams {
  accountId: number;
  memberIds: string[];
  totalUploaded: number;
  totalInvalid: number;
  settings: ChatRunSettings;
  outputPath: string;
}

export interface ResumeParams {
  runId: number;
}

export interface RunHandle {
  runId: number;
  /** Resolves when the run finishes (completed / stopped / failed). */
  done: Promise<void>;
}

// =====================================================================
// GroupCreator class
// =====================================================================

export class GroupCreator {
  private win: BrowserWindow;
  private runId: number | null = null;
  private settings: ChatRunSettings | null = null;
  private session: FcaSession | null = null;
  private outputPath: string = "";
  private sourceAccountName = "";

  // Counters maintained alongside DB updates so we can throttle the
  // DB writes without losing state.
  private groupsCompleted = 0;
  private membersAdded = 0;
  private membersFailed = 0;
  private currentBatch = 0;
  private currentGroupIndex = 0;
  private currentGroupName: string | null = null;
  private currentThreadId: string | null = null;
  private remainingIds = 0;

  // Control flags. abortFlag exits the run; pauseFlag pauses between
  // groups/batches.
  private abortFlag = false;
  private pauseFlag = false;
  private failed = false;

  private lastProgressEmit = 0;
  private latestMessage = "";

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  getRunId(): number | null {
    return this.runId;
  }

  isRunning(): boolean {
    return this.runId !== null && !this.abortFlag && !this.failed;
  }

  pause(): void {
    if (!this.runId) return;
    this.pauseFlag = true;
    this.log("info", "Pause requested. Will pause after current batch.");
  }

  stop(): void {
    if (!this.runId) return;
    this.abortFlag = true;
    this.log("info", "Stop requested. Will stop after current batch.");
  }

  /**
   * Plan, persist, and start a brand new run. Returns a handle whose
   * `done` promise resolves once the run terminates.
   */
  async start(params: StartParams): Promise<RunHandle> {
    this.resetCounters();
    this.settings = params.settings;
    this.outputPath = params.outputPath;

    const { token, name } = getDecryptedToken(params.accountId);
    this.sourceAccountName = name;

    // Validate token via Graph API (status side-effect: updates accounts row).
    const validation = await validateToken(token);
    updateAccountStatus(
      params.accountId,
      validation.status,
      validation.name,
      validation.id
    );
    if (!validation.valid) {
      throw new Error(
        `Selected account is ${validation.status}. Refresh and validate it in Account Manager.`
      );
    }

    // Build the plan: split member IDs into groups of MAX_GROUP_SIZE.
    const plan = planGroups(params.memberIds, params.settings.group_name_prefix);

    const runId = createRun({
      sourceAccountId: params.accountId,
      settings: params.settings,
      memberIds: params.memberIds,
      totalUploaded: params.totalUploaded,
      totalValid: params.memberIds.length,
      totalInvalid: params.totalInvalid,
      totalGroups: plan.length,
      outputPath: params.outputPath,
    });
    insertPlannedGroups(runId, plan);

    this.runId = runId;
    this.remainingIds = params.memberIds.length;
    this.initializeReport();

    this.log("info", `Run #${runId} created. ${plan.length} groups planned.`);
    this.emitProgress({ force: true });

    const done = this.runLoop().catch((err) => {
      this.fail(err instanceof Error ? err.message : String(err));
    });

    return { runId, done };
  }

  /**
   * Continue a previously-paused or -stopped run. Returns a handle
   * whose `done` resolves on termination.
   */
  async resume(params: ResumeParams): Promise<RunHandle> {
    this.resetCounters();
    const data = getRun(params.runId);
    if (!data) throw new Error(`Run #${params.runId} not found`);
    if (data.run.status === "completed") {
      throw new Error(`Run #${params.runId} is already completed`);
    }

    this.runId = params.runId;
    this.settings = data.run.settings;
    this.outputPath = data.run.output_path;
    this.groupsCompleted = data.run.groups_completed;
    this.membersAdded = data.run.members_added;
    this.membersFailed = data.run.members_failed;
    this.remainingIds = Math.max(
      0,
      data.run.total_members - this.membersAdded - this.membersFailed
    );
    setRunStatus(params.runId, "running");

    const { token, name } = getDecryptedToken(data.run.source_account_id);
    this.sourceAccountName = name;
    const validation = await validateToken(token);
    updateAccountStatus(
      data.run.source_account_id,
      validation.status,
      validation.name,
      validation.id
    );
    if (!validation.valid) {
      throw new Error(
        `Source account is ${validation.status}. Refresh and validate it in Account Manager.`
      );
    }

    this.log("info", `Resuming run #${params.runId}`);
    this.emitProgress({ force: true });

    const done = this.runLoop().catch((err) => {
      this.fail(err instanceof Error ? err.message : String(err));
    });

    return { runId: params.runId, done };
  }

  // ===================================================================
  // Internal: main loop
  // ===================================================================

  private async runLoop(): Promise<void> {
    if (!this.runId || !this.settings) return;
    const runId = this.runId;

    try {
      // Re-fetch the token on every (re)start in case the user rotated it.
      const data = getRun(runId);
      if (!data) throw new Error(`Run #${runId} disappeared from the DB`);
      const { token } = getDecryptedToken(data.run.source_account_id);

      this.log("info", "Logging into Facebook chat...");
      this.session = await loginWithAccessToken(token);
      this.log("info", `Logged in as user ${this.session.userId}`);

      const groups = data.groups;
      let attemptedGroups = 0;
      for (const group of groups) {
        if (this.abortFlag || this.pauseFlag) break;
        if (group.status === "completed") continue;

        this.currentGroupIndex = group.group_index;
        this.currentGroupName = group.group_name;
        this.currentThreadId = group.thread_id;

        const plannedMembers = getGroupMemberIds(runId, group.group_index);
        attemptedGroups++;

        // Snapshot counters before processGroup so we can reconcile
        // unaccounted IDs as failed if it throws part-way through.
        const addedAtStart = this.membersAdded;
        const failedAtStart = this.membersFailed;

        this.emitProgress({ force: true });

        try {
          const created = await this.processGroup({
            groupIndex: group.group_index,
            groupName: group.group_name,
            existingThreadId: group.thread_id,
            plannedMembers,
            settings: this.settings,
          });
          if (!created) break; // pause/stop happened mid-group

          // Inter-group delay (post-group + group-to-group),
          // but only if there are more groups to process.
          const isLast = group.group_index === groups.length - 1;
          if (!isLast && !this.abortFlag && !this.pauseFlag) {
            await this.sleepWithCheck(this.settings.post_group_delay_s * 1000);
            const interGroupMs = randomInRange(
              this.settings.group_delay_min_s,
              this.settings.group_delay_max_s
            ) * 1000;
            this.log(
              "info",
              `Waiting ${(interGroupMs / 1000).toFixed(1)}s before next group...`
            );
            await this.sleepWithCheck(interGroupMs);
          }
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          this.log("error", `Group ${group.group_index + 1} failed: ${msg}`);
          recordError(runId, msg, group.group_index, 1, plannedMembers);
          setGroupStatus(runId, group.group_index, "failed");

          // Reconcile counters: anything in plannedMembers that wasn't
          // already counted as added or failed gets bucketed as failed,
          // so members_added + members_failed always sums to total.
          const addedDelta = this.membersAdded - addedAtStart;
          const failedDelta = this.membersFailed - failedAtStart;
          const accounted = addedDelta + failedDelta;
          const unaccounted = Math.max(0, plannedMembers.length - accounted);
          if (unaccounted > 0) {
            this.membersFailed += unaccounted;
            this.remainingIds = Math.max(0, this.remainingIds - unaccounted);
            updateRunCounts(runId, {
              members_added: this.membersAdded,
              members_failed: this.membersFailed,
            });
          }
          this.emitProgress({ force: true });
          // Continue with next group instead of aborting the whole run.
        }
      }

      if (this.abortFlag) {
        setRunStatus(runId, "stopped");
        this.emitProgress({ force: true, status: "stopped" });
        this.log("info", "Run stopped.");
        return;
      }
      if (this.pauseFlag) {
        setRunStatus(runId, "paused");
        this.emitProgress({ force: true, status: "paused" });
        this.log("info", "Run paused.");
        return;
      }

      // If we attempted groups but none succeeded, the run is a failure.
      // 'completed' should only be reported when at least one group
      // was actually created on Facebook.
      if (attemptedGroups > 0 && this.groupsCompleted === 0) {
        setRunStatus(runId, "failed");
        this.emitProgress({ force: true, status: "failed" });
        this.log(
          "error",
          `Run failed: ${attemptedGroups} group(s) attempted, none succeeded. Most uploaded IDs were rejected by Facebook (account blocked, deactivated, or restrictive privacy settings).`
        );
        return;
      }

      setRunStatus(runId, "completed");
      this.emitProgress({ force: true, status: "completed" });
      this.log(
        "info",
        `Run completed. ${this.groupsCompleted}/${groups.length} group(s) created. ${this.membersAdded} member(s) added, ${this.membersFailed} failed.`
      );
    } finally {
      if (this.session) {
        await this.session.close().catch(() => undefined);
        this.session = null;
      }
    }
  }

  // ===================================================================
  // Per-group: create thread, set name, add remaining members
  // ===================================================================

  private async processGroup(params: {
    groupIndex: number;
    groupName: string;
    existingThreadId: string | null;
    plannedMembers: string[];
    settings: ChatRunSettings;
  }): Promise<boolean> {
    const { groupIndex, groupName, plannedMembers, settings } = params;
    const runId = this.runId;
    const session = this.session;
    if (!runId || !session) return false;

    let threadId = params.existingThreadId;
    const alreadyInGroup = new Set<string>();
    let toAdd: string[] = []; // members still needing gcmember add

    // Phase 1: create the group (only if it doesn't exist yet)
    if (!threadId) {
      setGroupStatus(runId, groupIndex, "creating");
      this.currentBatch = 0;

      const greeting =
        settings.greeting_message?.trim() || `Welcome to ${groupName}`;

      let creation;
      try {
        creation = await this.createGroupAdaptive({
          plannedMembers,
          greeting,
          groupIndex,
          groupName,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const reason = classifyFcaError(msg).reason;
        if (reason === "blocked") {
          throw new Error(`Account blocked while creating group: ${msg}`);
        }
        throw new Error(`createGroup failed: ${msg}`);
      }

      threadId = creation.threadId;
      this.currentThreadId = threadId;
      for (const id of creation.seedAdded) alreadyInGroup.add(id);

      // Seed members count toward members_added immediately.
      this.membersAdded += creation.seedAdded.length;
      this.remainingIds = Math.max(
        0,
        this.remainingIds - creation.seedAdded.length
      );
      updateRunCounts(runId, {
        members_added: this.membersAdded,
        members_failed: this.membersFailed,
      });

      setGroupStatus(runId, groupIndex, "filling", { thread_id: threadId });
      this.appendGroupRow({
        groupIndex,
        groupName,
        threadId,
        memberIds: creation.seedAdded,
        status: "created",
      });
      // Record peeled IDs in the CSV as "rejected" so the user can see
      // which IDs Facebook flagged as unreachable at create-time. They
      // will still be re-queued into the gcmember pool below.
      if (creation.peeled.length > 0) {
        this.appendGroupRow({
          groupIndex,
          groupName,
          threadId,
          memberIds: creation.peeled,
          status: "rejected",
        });
      }

      // Try to set the name; non-fatal if it fails.
      try {
        await session.api.gcname(groupName, threadId);
      } catch (nameErr: any) {
        this.log(
          "warn",
          `gcname failed for group ${groupIndex + 1}: ${nameErr.message ?? nameErr}`
        );
      }

      // Peeled-off IDs (suspected bad) are queued for a second-chance
      // gcmember add — gcmember silently drops invalid users so this is
      // safe and gives stale-but-okay IDs another shot.
      toAdd = [...creation.peeled, ...creation.remainingMembers];

      this.emitProgress();

      const interBatchMs =
        randomInRange(settings.batch_delay_min_s, settings.batch_delay_max_s) * 1000;
      await this.sleepWithCheck(interBatchMs);
      if (this.abortFlag || this.pauseFlag) return false;
    } else {
      // Group existed (resume case); we don't know exactly which IDs
      // are in there, so we'll let gcmember filter duplicates.
      this.log("info", `Resuming group ${groupIndex + 1} (thread ${threadId})`);
      toAdd = [...plannedMembers];
    }

    // Phase 2: add the remainder in batches via gcmember
    const remaining = toAdd;
    let batchNumber = 1;
    for (let i = 0; i < remaining.length; i += settings.batch_size) {
      if (this.abortFlag || this.pauseFlag) return false;

      const chunk = remaining
        .slice(i, i + settings.batch_size)
        .filter((id) => !alreadyInGroup.has(id));
      if (chunk.length === 0) continue;

      this.currentBatch = batchNumber;
      this.log(
        "info",
        `Group ${groupIndex + 1} batch #${batchNumber}: adding ${chunk.length} member(s)...`
      );

      try {
        const res = await session.api.gcmember("add", chunk, threadId!);
        if (res?.type === "error_gc") {
          // gcmember signals soft failures via { type: "error_gc", error: ... }
          const errMsg = res.error ?? "Unknown gcmember error";
          recordError(runId, errMsg, groupIndex, batchNumber, chunk);
          this.log("warn", `gcmember soft failure: ${errMsg}`);
          this.membersFailed += chunk.length;
          this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
        } else {
          const acceptedIds = (res?.userIDs ?? chunk) as string[];
          for (const id of acceptedIds) alreadyInGroup.add(id);
          this.membersAdded += acceptedIds.length;
          this.membersFailed += chunk.length - acceptedIds.length;
          this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
          this.appendGroupRow({
            groupIndex,
            groupName,
            threadId: threadId!,
            memberIds: acceptedIds,
            status: "added",
          });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        recordError(runId, msg, groupIndex, batchNumber, chunk);
        this.log("error", `Batch failed: ${msg}`);
        this.membersFailed += chunk.length;
        this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
      }

      updateRunCounts(runId, {
        members_added: this.membersAdded,
        members_failed: this.membersFailed,
      });
      this.emitProgress();

      // Inter-batch delay (random within configured range)
      const sleepMs = randomInRange(
        settings.batch_delay_min_s,
        settings.batch_delay_max_s
      ) * 1000;
      await this.sleepWithCheck(sleepMs);
      batchNumber += 1;
    }

    // Phase 3: mark group complete
    this.groupsCompleted += 1;
    setGroupStatus(runId, groupIndex, "completed", {
      thread_id: threadId!,
      member_count: alreadyInGroup.size,
    });
    updateRunCounts(runId, {
      groups_completed: this.groupsCompleted,
      members_added: this.membersAdded,
      members_failed: this.membersFailed,
    });
    this.log(
      "info",
      `Group ${groupIndex + 1} ("${groupName}") completed with ${alreadyInGroup.size} members.`
    );
    this.emitProgress({ force: true });
    return true;
  }

  // ===================================================================
  // Adaptive seed creation
  // ===================================================================

  /**
   * Try to create a Facebook chat group from `plannedMembers` with a
   * shrinking seed batch. On invalid-recipient errors we peel off the
   * first ID (assume it's the bad apple in expectation) and retry —
   * either at the same seed size or one step smaller after every
   * second failure. The peeled-off IDs are returned alongside the
   * working seed so the caller can re-attempt them via gcmember,
   * which is far more forgiving than create-group.
   *
   * On unrecoverable errors (rate_limit / blocked) the error is
   * rethrown so the caller can short-circuit the run if appropriate.
   */
  private async createGroupAdaptive(params: {
    plannedMembers: string[];
    greeting: string;
    groupIndex: number;
    groupName: string;
  }): Promise<{
    threadId: string;
    seedAdded: string[];
    peeled: string[];
    remainingMembers: string[];
  }> {
    const session = this.session!;
    const runId = this.runId!;
    const { plannedMembers, greeting, groupIndex, groupName } = params;

    const peeled: string[] = [];
    let cursor = 0;
    let sizeIdx = 0;
    let attempts = 0;

    while (sizeIdx < SEED_SIZES.length && attempts < MAX_SEED_ATTEMPTS) {
      const size = SEED_SIZES[sizeIdx];
      // Not enough IDs left in the pool for this seed size — shrink.
      if (cursor + size > plannedMembers.length) {
        sizeIdx++;
        continue;
      }
      attempts++;
      const seed = plannedMembers.slice(cursor, cursor + size);

      this.log(
        "info",
        `Group ${groupIndex + 1} ("${groupName}"): create attempt ${attempts} with ${size} seed member(s)...`
      );

      try {
        const result = await session.api.sendMessage({ body: greeting }, seed);
        if (!result?.threadID) {
          throw new Error("sendMessage returned no threadID");
        }
        return {
          threadId: result.threadID,
          seedAdded: seed,
          peeled,
          remainingMembers: plannedMembers.slice(cursor + size),
        };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const reason = classifyFcaError(msg).reason;
        recordError(runId, msg, groupIndex, attempts, seed);

        if (reason === "blocked" || reason === "rate_limit") {
          // Don't keep hammering — propagate and let the caller decide.
          throw err;
        }

        // Peel the first ID off as the suspect, count it as failed.
        const suspect = plannedMembers[cursor];
        if (suspect) {
          peeled.push(suspect);
          this.log(
            "warn",
            `Attempt ${attempts} failed (${reason}). Peeling ID ${suspect} and retrying.`
          );
        }
        cursor++;

        // Every 2 retries, shrink the seed size to bias toward success.
        if (attempts % 2 === 0 && sizeIdx < SEED_SIZES.length - 1) {
          sizeIdx++;
        }

        await this.sleepWithCheck(SEED_RETRY_DELAY_MS);
        if (this.abortFlag || this.pauseFlag) {
          throw new Error("Aborted during seed retry");
        }
      }
    }

    throw new Error(
      `Could not create group after ${attempts} attempt(s); ${peeled.length} ID(s) rejected.`
    );
  }

  // ===================================================================
  // Helpers
  // ===================================================================

  private resetCounters() {
    this.runId = null;
    this.settings = null;
    this.outputPath = "";
    this.groupsCompleted = 0;
    this.membersAdded = 0;
    this.membersFailed = 0;
    this.currentBatch = 0;
    this.currentGroupIndex = 0;
    this.currentGroupName = null;
    this.currentThreadId = null;
    this.remainingIds = 0;
    this.abortFlag = false;
    this.pauseFlag = false;
    this.failed = false;
    this.lastProgressEmit = 0;
    this.latestMessage = "";
  }

  private fail(message: string) {
    this.failed = true;
    if (this.runId) {
      setRunStatus(this.runId, "failed");
      recordError(this.runId, message, this.currentGroupIndex, 1, null);
    }
    this.log("error", `Run failed: ${message}`);
    this.emitProgress({ force: true, status: "failed" });
  }

  private async sleepWithCheck(ms: number): Promise<void> {
    if (ms <= 0) return;
    const step = 250;
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.abortFlag || this.pauseFlag) return;
      await new Promise((r) => setTimeout(r, Math.min(step, ms - (Date.now() - start))));
    }
  }

  private initializeReport() {
    if (!this.outputPath) return;
    try {
      mkdirSync(dirname(this.outputPath), { recursive: true });
      writeFileSync(
        this.outputPath,
        "group_index,group_name,thread_id,member_id,event,timestamp\n",
        "utf8"
      );
    } catch (err: any) {
      this.log("warn", `Could not initialize report at ${this.outputPath}: ${err.message}`);
    }
  }

  private appendGroupRow(row: {
    groupIndex: number;
    groupName: string;
    threadId: string;
    memberIds: string[];
    status: "created" | "added" | "rejected";
  }) {
    if (!this.outputPath) return;
    try {
      const ts = new Date().toISOString();
      const lines = row.memberIds
        .map(
          (id) =>
            `${row.groupIndex + 1},${csvCell(row.groupName)},${csvCell(row.threadId)},${csvCell(
              id
            )},${row.status},${ts}`
        )
        .join("\n");
      appendFileSync(this.outputPath, lines + "\n", "utf8");
    } catch {
      // best effort; we don't want CSV failures to abort the run
    }
  }

  private log(level: ChatLogEntry["level"], message: string) {
    if (!this.runId) return;
    this.latestMessage = message;
    const entry: ChatLogEntry = {
      run_id: this.runId,
      level,
      message,
      group_index: this.currentGroupIndex,
      timestamp: new Date().toISOString(),
    };
    this.send("chat:log", entry);
  }

  private emitProgress(opts: { force?: boolean; status?: ChatRunStatus } = {}) {
    if (!this.runId) return;
    const now = Date.now();
    if (!opts.force && now - this.lastProgressEmit < PROGRESS_EMIT_THROTTLE_MS) {
      return;
    }
    this.lastProgressEmit = now;
    const status: ChatRunStatus =
      opts.status ??
      (this.abortFlag ? "stopped" : this.pauseFlag ? "paused" : "running");

    const data = getRun(this.runId);
    const totalGroups = data?.run.total_groups ?? 0;
    const totalMembers = data?.run.total_members ?? 0;

    const progress: ChatProgress = {
      run_id: this.runId,
      status,
      total_groups: totalGroups,
      total_members: totalMembers,
      current_group_index: this.currentGroupIndex,
      current_group_name: this.currentGroupName,
      current_thread_id: this.currentThreadId,
      current_batch: this.currentBatch,
      groups_completed: this.groupsCompleted,
      members_added: this.membersAdded,
      members_failed: this.membersFailed,
      remaining_ids: this.remainingIds,
      message: this.latestMessage,
    };
    this.send("chat:progress", progress);
  }

  private send(channel: string, payload: unknown) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }
}

// =====================================================================
// Helpers
// =====================================================================

export function planGroups(
  memberIds: string[],
  prefix: string
): { groupIndex: number; groupName: string; memberIds: string[] }[] {
  const cleanPrefix = prefix.trim() || "Group";
  const groups: { groupIndex: number; groupName: string; memberIds: string[] }[] = [];
  for (let i = 0, idx = 0; i < memberIds.length; i += MAX_GROUP_SIZE, idx += 1) {
    groups.push({
      groupIndex: idx,
      groupName: `${cleanPrefix} ${idx + 1}`,
      memberIds: memberIds.slice(i, i + MAX_GROUP_SIZE),
    });
  }
  return groups;
}

function randomInRange(minSec: number, maxSec: number): number {
  if (minSec >= maxSec) return Math.max(0, minSec);
  return minSec + Math.random() * (maxSec - minSec);
}

function csvCell(value: string): string {
  if (value == null) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// =====================================================================
// Default report path helper (used by IPC handler when start is called
// without an explicit path).
// =====================================================================

export async function pickReportPath(win: BrowserWindow): Promise<string | null> {
  const result = await dialog.showSaveDialog(win, {
    title: "Save chat groups report",
    defaultPath: join(
      app.getPath("documents"),
      `chat-groups-${Date.now()}.csv`
    ),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}
