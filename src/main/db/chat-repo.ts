import { getDB } from "./connection";
import type {
  ChatGroupRecord,
  ChatGroupStatus,
  ChatRun,
  ChatRunSettings,
  ChatRunStatus,
} from "@shared/types";

interface CreateRunInput {
  sourceAccountId: number;
  settings: ChatRunSettings;
  memberIds: string[];
  totalUploaded: number;
  totalValid: number;
  totalInvalid: number;
  totalGroups: number;
  outputPath: string;
}

/**
 * Insert a fresh `chat_runs` row in 'running' status. Returns the run ID
 * that all subsequent inserts (groups, errors, progress updates) will
 * reference.
 */
export function createRun(input: CreateRunInput): number {
  const db = getDB();
  const result = db
    .prepare(
      `INSERT INTO chat_runs
         (source_account_id, settings_json, member_ids_json,
          total_uploaded_ids, total_valid_ids, total_invalid_ids,
          total_groups, output_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`
    )
    .run(
      input.sourceAccountId,
      JSON.stringify(input.settings),
      JSON.stringify(input.memberIds),
      input.totalUploaded,
      input.totalValid,
      input.totalInvalid,
      input.totalGroups,
      input.outputPath
    );
  return result.lastInsertRowid as number;
}

/**
 * Pre-populate the per-group rows so that pause/resume can pick the
 * next pending one without re-doing the slicing.
 */
export function insertPlannedGroups(
  runId: number,
  plan: { groupIndex: number; groupName: string; memberIds: string[] }[]
): void {
  const db = getDB();
  const insert = db.prepare(
    `INSERT INTO chat_groups_created
       (run_id, group_index, group_name, member_ids_json, member_count, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  );
  const tx = db.transaction(() => {
    for (const g of plan) {
      insert.run(
        runId,
        g.groupIndex,
        g.groupName,
        JSON.stringify(g.memberIds),
        g.memberIds.length
      );
    }
  });
  tx();
}

export function setRunStatus(runId: number, status: ChatRunStatus): void {
  const db = getDB();
  const completedAt =
    status === "completed" || status === "failed" || status === "stopped"
      ? "datetime('now')"
      : "completed_at";
  db.prepare(
    `UPDATE chat_runs SET status = ?, completed_at = ${completedAt} WHERE id = ?`
  ).run(status, runId);
}

export function updateRunCounts(
  runId: number,
  counts: {
    groups_completed?: number;
    members_added?: number;
    members_failed?: number;
  }
): void {
  const db = getDB();
  const updates: string[] = [];
  const values: any[] = [];
  if (counts.groups_completed !== undefined) {
    updates.push("groups_completed = ?");
    values.push(counts.groups_completed);
  }
  if (counts.members_added !== undefined) {
    updates.push("members_added = ?");
    values.push(counts.members_added);
  }
  if (counts.members_failed !== undefined) {
    updates.push("members_failed = ?");
    values.push(counts.members_failed);
  }
  if (updates.length === 0) return;
  values.push(runId);
  db.prepare(
    `UPDATE chat_runs SET ${updates.join(", ")} WHERE id = ?`
  ).run(...values);
}

export function setGroupStatus(
  runId: number,
  groupIndex: number,
  status: ChatGroupStatus,
  patch: { thread_id?: string | null; member_count?: number } = {}
): void {
  const db = getDB();
  const updates: string[] = ["status = ?"];
  const values: any[] = [status];
  if (status === "creating" || status === "filling") {
    updates.push("started_at = COALESCE(started_at, datetime('now'))");
  }
  if (status === "completed" || status === "failed") {
    updates.push("completed_at = datetime('now')");
  }
  if (patch.thread_id !== undefined) {
    updates.push("thread_id = ?");
    values.push(patch.thread_id);
  }
  if (patch.member_count !== undefined) {
    updates.push("member_count = ?");
    values.push(patch.member_count);
  }
  values.push(runId, groupIndex);
  db.prepare(
    `UPDATE chat_groups_created SET ${updates.join(", ")} WHERE run_id = ? AND group_index = ?`
  ).run(...values);
}

export function recordError(
  runId: number,
  errorMessage: string,
  groupIndex: number | null,
  attempt: number,
  memberIds: string[] | null
): void {
  const db = getDB();
  db.prepare(
    `INSERT INTO chat_creation_errors (run_id, group_index, attempt, member_ids_json, error_message)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    runId,
    groupIndex,
    attempt,
    memberIds ? JSON.stringify(memberIds) : null,
    errorMessage
  );
}

export function listRuns(limit = 25): ChatRun[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT r.id, r.source_account_id, r.settings_json,
              r.total_uploaded_ids AS total_members, r.total_groups,
              r.groups_completed, r.members_added, r.members_failed,
              r.status, r.started_at, r.completed_at, r.output_path,
              a.account_name
       FROM chat_runs r
       LEFT JOIN accounts a ON a.id = r.source_account_id
       ORDER BY r.started_at DESC
       LIMIT ?`
    )
    .all(limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    source_account_id: row.source_account_id,
    source_account_name: row.account_name ?? null,
    settings: safeParse<ChatRunSettings>(row.settings_json) as ChatRunSettings,
    status: row.status,
    total_members: row.total_members,
    total_groups: row.total_groups,
    groups_completed: row.groups_completed,
    members_added: row.members_added,
    members_failed: row.members_failed,
    started_at: row.started_at,
    completed_at: row.completed_at,
    output_path: row.output_path,
  }));
}

export function getRun(runId: number): {
  run: ChatRun;
  memberIds: string[];
  groups: ChatGroupRecord[];
} | null {
  const db = getDB();
  const runRow = db
    .prepare(
      `SELECT r.*, a.account_name
       FROM chat_runs r
       LEFT JOIN accounts a ON a.id = r.source_account_id
       WHERE r.id = ?`
    )
    .get(runId) as any;
  if (!runRow) return null;

  const groups = db
    .prepare(
      `SELECT id, run_id, group_index, thread_id, group_name,
              member_count, status, started_at, completed_at, member_ids_json
       FROM chat_groups_created
       WHERE run_id = ?
       ORDER BY group_index ASC`
    )
    .all(runId) as any[];

  const memberIds = safeParse<string[]>(runRow.member_ids_json) ?? [];

  return {
    memberIds,
    run: {
      id: runRow.id,
      source_account_id: runRow.source_account_id,
      source_account_name: runRow.account_name ?? null,
      settings: safeParse<ChatRunSettings>(runRow.settings_json) as ChatRunSettings,
      status: runRow.status,
      total_members: runRow.total_uploaded_ids,
      total_groups: runRow.total_groups,
      groups_completed: runRow.groups_completed,
      members_added: runRow.members_added,
      members_failed: runRow.members_failed,
      started_at: runRow.started_at,
      completed_at: runRow.completed_at,
      output_path: runRow.output_path,
    },
    groups: groups.map((g) => ({
      id: g.id,
      run_id: g.run_id,
      group_index: g.group_index,
      thread_id: g.thread_id ?? null,
      group_name: g.group_name,
      member_count: g.member_count,
      status: g.status,
      started_at: g.started_at ?? null,
      completed_at: g.completed_at ?? null,
    })),
  };
}

/**
 * Returns the planned member IDs for a single group (used by the
 * orchestrator on resume to know exactly which IDs belong to the
 * group it's about to retry).
 */
export function getGroupMemberIds(
  runId: number,
  groupIndex: number
): string[] {
  const db = getDB();
  const row = db
    .prepare(
      `SELECT member_ids_json FROM chat_groups_created
       WHERE run_id = ? AND group_index = ?`
    )
    .get(runId, groupIndex) as any;
  if (!row) return [];
  return safeParse<string[]>(row.member_ids_json) ?? [];
}

export function listErrors(runId: number, limit = 500): {
  group_index: number | null;
  attempt: number;
  error_message: string;
  timestamp: string;
}[] {
  const db = getDB();
  return db
    .prepare(
      `SELECT group_index, attempt, error_message, timestamp
       FROM chat_creation_errors
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(runId, limit) as any[];
}

function safeParse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
