import { BrowserWindow, app, dialog } from "electron";
import { writeFileSync } from "fs";
import { appendFile as appendFileAsync } from "fs/promises";
import { join } from "path";
import { createObjectCsvStringifier } from "csv-writer";
import { getDB } from "../db/connection";
import { getDecryptedToken, getValidAccountIds } from "../db/accounts-repo";
import type { ExtractionError, ExtractionProgress } from "@shared/types";
import { ScraperWorker, type AccountSlot } from "./scraper-worker";

const CSV_ID_FIELDS = ["member_id", "group_id", "extracted_at", "source_account"] as const;
const PROGRESS_THROTTLE_MS = 250;
const DEFAULT_CONCURRENCY_CAP = 5;

export interface ScraperStartOptions {
  /** Max parallel workers. Defaults to min(validAccounts, DEFAULT_CONCURRENCY_CAP). */
  concurrency?: number;
  /** Show scraper BrowserWindows (debug). Defaults to false. */
  showWindow?: boolean;
}

export interface GroupJob {
  groupId: string;
  groupIndex: number; // original index in groupIds (for progress display)
}

interface CsvRow {
  member_id: string;
  group_id: string;
  extracted_at: string;
  source_account: string;
}

let globalScraper: GroupScraper | null = null;

export function getActiveScraper(): GroupScraper | null {
  return globalScraper;
}

/**
 * Orchestrator for parallel scraper extraction.
 *
 * Owns the shared run state (dedup set, CSV file, run row, progress emitter,
 * group queue) and spawns N {@link ScraperWorker}s (one per account) that
 * pull groups from the queue concurrently.
 *
 * Public surface (used by IPC handlers + on-quit hook) is unchanged from
 * the previous single-window implementation: start / stop / forceSave /
 * getRunId / isRunning.
 */
export class GroupScraper {
  private mainWin: BrowserWindow;
  private abortFlag = false;
  private running = false;

  private runId: number | null = null;
  private outputPath = "";
  private groupIds: string[] = [];

  private seenMemberIds = new Set<string>();
  private totalExtracted = 0;
  private maxBatch = 0;

  private accounts: AccountSlot[] = [];
  private workers: ScraperWorker[] = [];

  private pendingQueue: GroupJob[] = [];
  private inProgressByWorker = new Map<number, GroupJob>();
  private completedGroups = new Set<string>();
  private failedGroups = new Set<string>();

  // Async CSV write chain — every append is enqueued so writes from multiple
  // workers can never interleave on disk, while still being non-blocking
  // (no more appendFileSync stalling the event loop).
  private csvWriteChain: Promise<void> = Promise.resolve();
  private csvStringifier = createObjectCsvStringifier({
    header: CSV_ID_FIELDS.map((f) => ({ id: f, title: f })),
  });

  // Throttled progress emitter — collapses high-frequency progress events
  // from many workers into at most one IPC message per PROGRESS_THROTTLE_MS.
  private pendingProgress: ExtractionProgress | null = null;
  private lastProgressEmit = 0;
  private progressTimer: NodeJS.Timeout | null = null;

  constructor(win: BrowserWindow) {
    this.mainWin = win;
  }

  // ---------- Public API ----------

  async start(
    groupIds: string[],
    accountId: number,
    resumeRunId?: number | null,
    options?: ScraperStartOptions
  ): Promise<string> {
    if (this.running) {
      throw new Error("A scraper run is already in progress");
    }

    this.abortFlag = false;
    this.maxBatch = 0;

    const showWindow = options?.showWindow ?? false;
    const db = getDB();

    // Build the account pool. The user's chosen account always goes first
    // so that concurrency=1 uses exactly that account; remaining valid
    // accounts fill out the pool in id order. accountId<=0 means "no
    // explicit choice" (e.g. resume path) — fall back to all valid accounts.
    const allValidIds = getValidAccountIds();
    const validSet = new Set(allValidIds);
    const orderedIds: number[] = [];
    if (accountId > 0 && validSet.has(accountId)) {
      orderedIds.push(accountId);
    }
    for (const id of allValidIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    if (orderedIds.length === 0) {
      // No valid accounts at all: fall back to the explicitly-passed one if
      // any. If even that isn't valid, getDecryptedToken will throw and we
      // surface the error to the caller.
      if (accountId <= 0) {
        throw new Error(
          "No valid accounts available. Validate at least one token in Account Manager first."
        );
      }
      orderedIds.push(accountId);
    }
    this.accounts = orderedIds.map((id) => {
      const info = getDecryptedToken(id);
      return { id, token: info.token, name: info.name, failCount: 0 };
    });

    if (resumeRunId) {
      this.loadResumeState(resumeRunId);
    } else {
      await this.initFreshRun(groupIds, accountId);
    }

    this.pendingQueue = this.buildPendingQueue();

    this.running = true;
    globalScraper = this;

    // Decide worker count.
    const requested = Math.max(1, options?.concurrency ?? this.accounts.length);
    const concurrency = Math.min(
      requested,
      this.accounts.length,
      this.pendingQueue.length || 1,
      DEFAULT_CONCURRENCY_CAP
    );

    // Initial progress event so the UI flips to "running" immediately.
    this.emitProgress({
      current_group_id: this.groupIds[0] ?? "",
      current_group_index: 0,
      total_groups: this.groupIds.length,
      members_extracted: this.totalExtracted,
      current_batch: 0,
      status: "running",
    });
    this.flushProgressNow();

    // Spawn workers. Each worker takes one account from the pool by index;
    // any extra accounts beyond `concurrency` sit unused (UI tells the user
    // to bump concurrency if they want more parallelism).
    this.workers = [];
    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const worker = new ScraperWorker({
        index: i,
        account: this.accounts[i],
        orchestrator: this,
        showWindow,
      });
      this.workers.push(worker);
      workerPromises.push(
        worker.run().catch((err) => {
          this.recordError(
            `(worker-${i})`,
            0,
            new Error(
              `Worker ${i} crashed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        })
      );
    }

    try {
      await Promise.all(workerPromises);
      // Make sure all queued CSV writes have hit disk before we return.
      await this.csvWriteChain;
    } finally {
      this.running = false;
      globalScraper = null;
    }

    const finalStatus: ExtractionProgress["status"] = this.abortFlag
      ? "stopped"
      : this.pendingQueue.length === 0 && this.inProgressByWorker.size === 0
        ? "completed"
        : "stopped";

    if (this.runId) {
      db.prepare(
        "UPDATE extraction_runs SET status = ?, completed_at = datetime('now'), members_extracted = ?, current_group_index = ?, current_batch = ? WHERE id = ?"
      ).run(
        finalStatus,
        this.totalExtracted,
        this.completedGroups.size,
        this.maxBatch,
        this.runId
      );
    }

    this.emitProgress({
      current_group_id: this.groupIds[Math.max(0, this.groupIds.length - 1)] ?? "",
      current_group_index: Math.max(0, this.groupIds.length - 1),
      total_groups: this.groupIds.length,
      members_extracted: this.totalExtracted,
      current_batch: this.maxBatch,
      status: finalStatus,
    });
    this.flushProgressNow();

    return this.outputPath;
  }

  stop(): void {
    this.abortFlag = true;
    this.persistRunState();
  }

  forceSave(): void {
    this.persistRunState();
  }

  getRunId(): number | null {
    return this.runId;
  }

  isRunning(): boolean {
    return this.running;
  }

  isAborted(): boolean {
    return this.abortFlag;
  }

  getTotalExtracted(): number {
    return this.totalExtracted;
  }

  getTotalGroups(): number {
    return this.groupIds.length;
  }

  // ---------- Worker-facing API ----------

  /**
   * Pop the next pending group from the queue and mark it in_progress.
   * Returns null when the queue is empty or the run was aborted.
   *
   * Safe under cooperative concurrency (Node.js single-threaded event loop):
   * the shift + state mutation runs synchronously, so two workers can't
   * grab the same job.
   */
  takeNextGroup(workerIndex: number): GroupJob | null {
    if (this.abortFlag) return null;
    const job = this.pendingQueue.shift();
    if (!job) return null;

    this.inProgressByWorker.set(workerIndex, job);
    this.updateGroupStatus(job.groupId, "in_progress", workerIndex);
    return job;
  }

  markGroupCompleted(workerIndex: number, job: GroupJob, extractedInGroup: number): void {
    this.inProgressByWorker.delete(workerIndex);
    this.completedGroups.add(job.groupId);
    this.updateGroupStatus(job.groupId, "completed", workerIndex, extractedInGroup);
  }

  markGroupFailed(workerIndex: number, job: GroupJob): void {
    this.inProgressByWorker.delete(workerIndex);
    this.failedGroups.add(job.groupId);
    this.updateGroupStatus(job.groupId, "failed", workerIndex);
  }

  /**
   * Worker exhausted its account or hit a transient failure — push the group
   * back onto the queue so another worker can pick it up.
   */
  requeueGroup(workerIndex: number, job: GroupJob): void {
    this.inProgressByWorker.delete(workerIndex);
    this.updateGroupStatus(job.groupId, "pending", null);
    if (!this.abortFlag) {
      this.pendingQueue.push(job);
    }
  }

  /**
   * Add IDs to the global dedup Set and return the IDs that were actually new.
   * Workers call this with whatever they scraped; the orchestrator decides
   * what's a duplicate (across all groups in this run).
   */
  addMembers(ids: string[]): string[] {
    const newIds: string[] = [];
    for (const id of ids) {
      if (!this.seenMemberIds.has(id)) {
        this.seenMemberIds.add(id);
        newIds.push(id);
      }
    }
    return newIds;
  }

  /**
   * Persist a freshly-extracted batch of IDs: insert into DB (transactional)
   * and append to CSV (asynchronous, serialized via csvWriteChain). Awaits
   * the CSV append so the caller knows the rows hit disk before progressing.
   */
  async persistMembers(groupId: string, sourceAccount: string, ids: string[]): Promise<void> {
    if (!this.runId || ids.length === 0) return;

    const db = getDB();
    const insertMember = db.prepare(
      "INSERT OR IGNORE INTO extraction_members (run_id, member_id, group_id, group_name, extracted_at, source_account) VALUES (?, ?, ?, '', ?, ?)"
    );

    const now = new Date().toISOString();
    const insertBatch = db.transaction((rows: string[]) => {
      for (const id of rows) {
        insertMember.run(this.runId, id, groupId, now, sourceAccount);
      }
    });

    insertBatch(ids);

    const rows: CsvRow[] = ids.map((id) => ({
      member_id: id,
      group_id: groupId,
      extracted_at: now,
      source_account: sourceAccount,
    }));

    this.totalExtracted += ids.length;
    await this.appendCsv(rows);
  }

  emitProgress(progress: ExtractionProgress): void {
    if (progress.current_batch > this.maxBatch) {
      this.maxBatch = progress.current_batch;
    }
    this.pendingProgress = progress;

    // Always flush terminal states immediately.
    if (progress.status !== "running") {
      this.flushProgressNow();
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastProgressEmit;
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      this.flushProgressNow();
    } else if (!this.progressTimer) {
      const remaining = PROGRESS_THROTTLE_MS - elapsed;
      this.progressTimer = setTimeout(() => this.flushProgressNow(), remaining);
    }
  }

  recordError(groupId: string, batchNumber: number, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const payload: ExtractionError = {
      group_id: groupId,
      batch_number: batchNumber,
      error_message: errorMessage,
      timestamp: new Date().toISOString(),
    };

    if (this.runId) {
      try {
        getDB()
          .prepare(
            "INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp) VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            this.runId,
            payload.group_id,
            payload.batch_number,
            payload.error_message,
            payload.timestamp
          );
      } catch {
        // best-effort logging
      }
    }

    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:error", payload);
    }
  }

  /**
   * Persist the run-level summary (legacy fields are kept for back-compat
   * with the stopped-runs UI). Per-group state is tracked separately in
   * extraction_run_groups by updateGroupStatus.
   */
  persistRunState(): void {
    if (!this.runId) return;
    try {
      getDB()
        .prepare(
          "UPDATE extraction_runs SET status = 'stopped', current_group_index = ?, current_group_id = ?, current_batch = ?, members_extracted = ? WHERE id = ?"
        )
        .run(
          this.completedGroups.size,
          this.inProgressByWorker.size > 0
            ? Array.from(this.inProgressByWorker.values())[0]?.groupId ?? ""
            : "",
          this.maxBatch,
          this.totalExtracted,
          this.runId
        );
    } catch {
      // best-effort
    }
  }

  // ---------- Private helpers ----------

  private async initFreshRun(groupIds: string[], accountId: number): Promise<void> {
    const { filePath } = await dialog.showSaveDialog(this.mainWin, {
      defaultPath: join(app.getPath("documents"), "extraction-" + Date.now() + ".csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!filePath) {
      throw new Error("No output path selected");
    }

    this.outputPath = filePath;
    this.groupIds = groupIds.slice();
    this.totalExtracted = 0;
    this.seenMemberIds.clear();
    this.completedGroups.clear();
    this.failedGroups.clear();

    const db = getDB();
    const result = db
      .prepare(
        "INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)"
      )
      .run(JSON.stringify(groupIds), accountId, filePath);
    this.runId = result.lastInsertRowid as number;

    // Seed extraction_run_groups with one row per group.
    const insertGroup = db.prepare(
      "INSERT OR IGNORE INTO extraction_run_groups (run_id, group_id, status) VALUES (?, ?, 'pending')"
    );
    const tx = db.transaction((ids: string[]) => {
      for (const id of ids) insertGroup.run(this.runId, id);
    });
    tx(groupIds);

    this.initializeCsv(filePath);
  }

  private loadResumeState(resumeRunId: number): void {
    const db = getDB();
    const run = db
      .prepare(
        "SELECT output_path, group_ids, members_extracted, current_group_index FROM extraction_runs WHERE id = ?"
      )
      .get(resumeRunId) as any;
    if (!run) throw new Error("Run " + resumeRunId + " not found");

    this.runId = resumeRunId;
    this.outputPath = run.output_path;
    this.groupIds = JSON.parse(run.group_ids);
    this.totalExtracted = run.members_extracted ?? 0;

    // Rebuild dedup set from DB (one-time cost on resume — no longer
    // periodic during normal scraping).
    const existing = db
      .prepare("SELECT member_id FROM extraction_members WHERE run_id = ?")
      .all(resumeRunId) as any[];
    this.seenMemberIds = new Set(existing.map((r) => r.member_id));

    // Make sure extraction_run_groups is populated for this run; older runs
    // (from before this table existed) won't have any rows, so backfill from
    // the legacy current_group_index field.
    const existingGroups = db
      .prepare("SELECT group_id, status FROM extraction_run_groups WHERE run_id = ?")
      .all(resumeRunId) as any[];

    if (existingGroups.length === 0) {
      const legacyIndex: number = run.current_group_index ?? 0;
      const insertGroup = db.prepare(
        "INSERT INTO extraction_run_groups (run_id, group_id, status) VALUES (?, ?, ?)"
      );
      const tx = db.transaction(() => {
        for (let i = 0; i < this.groupIds.length; i++) {
          insertGroup.run(this.runId, this.groupIds[i], i < legacyIndex ? "completed" : "pending");
        }
      });
      tx();
    } else {
      // Any group that was in_progress when the run stopped goes back to pending.
      db.prepare(
        "UPDATE extraction_run_groups SET status = 'pending', worker_index = NULL WHERE run_id = ? AND status = 'in_progress'"
      ).run(resumeRunId);
    }

    // Seed our local completed-set from the DB.
    const completedRows = db
      .prepare(
        "SELECT group_id FROM extraction_run_groups WHERE run_id = ? AND status = 'completed'"
      )
      .all(resumeRunId) as any[];
    this.completedGroups = new Set(completedRows.map((r) => r.group_id));
    this.failedGroups.clear();

    // Rewrite the CSV from the DB so it's consistent with what we'll resume from.
    // (Done synchronously up front — small fixed cost vs. the rest of the run.)
    this.rebuildCsvFromDb();
  }

  private buildPendingQueue(): GroupJob[] {
    const db = getDB();
    if (!this.runId) return [];
    const pendingRows = db
      .prepare(
        "SELECT group_id FROM extraction_run_groups WHERE run_id = ? AND status = 'pending'"
      )
      .all(this.runId) as any[];

    const indexById = new Map(this.groupIds.map((id, idx) => [id, idx]));
    return pendingRows.map((row) => ({
      groupId: row.group_id as string,
      groupIndex: indexById.get(row.group_id as string) ?? 0,
    }));
  }

  private updateGroupStatus(
    groupId: string,
    status: "pending" | "in_progress" | "completed" | "failed",
    workerIndex: number | null,
    membersCount?: number
  ): void {
    if (!this.runId) return;
    try {
      const db = getDB();
      if (typeof membersCount === "number") {
        db.prepare(
          "UPDATE extraction_run_groups SET status = ?, worker_index = ?, members_count = ?, updated_at = datetime('now') WHERE run_id = ? AND group_id = ?"
        ).run(status, workerIndex, membersCount, this.runId, groupId);
      } else {
        db.prepare(
          "UPDATE extraction_run_groups SET status = ?, worker_index = ?, updated_at = datetime('now') WHERE run_id = ? AND group_id = ?"
        ).run(status, workerIndex, this.runId, groupId);
      }
    } catch {
      // best-effort
    }
  }

  private initializeCsv(outputPath: string): void {
    writeFileSync(outputPath, this.csvStringifier.getHeaderString() ?? "", "utf8");
  }

  private rebuildCsvFromDb(): void {
    if (!this.runId) return;
    this.initializeCsv(this.outputPath);
    const db = getDB();
    const rows = db
      .prepare(
        "SELECT member_id, group_id, extracted_at, source_account FROM extraction_members WHERE run_id = ? ORDER BY id"
      )
      .all(this.runId) as CsvRow[];
    if (rows.length > 0) {
      // Synchronous bulk write is fine here — happens once at resume start,
      // not on the hot path.
      const fs = require("fs") as typeof import("fs");
      fs.appendFileSync(this.outputPath, this.csvStringifier.stringifyRecords(rows), "utf8");
    }
  }

  private appendCsv(rows: CsvRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    const payload = this.csvStringifier.stringifyRecords(rows);

    // Chain onto the existing write chain so writes from multiple workers
    // serialize on disk while not blocking the event loop. Errors on a
    // single batch shouldn't poison the chain.
    this.csvWriteChain = this.csvWriteChain.then(() =>
      appendFileAsync(this.outputPath, payload, "utf8").catch((err) => {
        this.recordError("(csv)", 0, err);
      })
    );
    return this.csvWriteChain;
  }

  private flushProgressNow(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    if (
      this.pendingProgress &&
      this.mainWin &&
      !this.mainWin.isDestroyed()
    ) {
      this.mainWin.webContents.send("extraction:progress", this.pendingProgress);
      this.lastProgressEmit = Date.now();
      this.pendingProgress = null;
    }
  }
}
