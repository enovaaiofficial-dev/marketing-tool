// IPC handlers for the Facebook Chat Groups Creator module.
//
// chat:parse-file       parse the user-supplied IDs file (Extractor CSV)
// chat:start            kick off a new run with planned groups
// chat:pause            pause the active run (resumable later)
// chat:resume           resume a previously paused/stopped run
// chat:stop             stop the active run (no further work)
// chat:list-runs        list recent runs for the resume panel
// chat:get-run          fetch a full run + groups + errors snapshot
// chat:report           summary used by the renderer for downloads

import { ipcMain, BrowserWindow } from "electron";
import { readFileSync } from "fs";
import { extname } from "path";

import { GroupCreator, planGroups, pickReportPath } from "../chat/group-creator";
import {
  getRun,
  listErrors,
  listRuns,
  setRunStatus,
} from "../db/chat-repo";
import type { ChatRunSettings } from "@shared/types";

let activeCreator: GroupCreator | null = null;

const DEFAULT_SETTINGS: ChatRunSettings = {
  group_name_prefix: "Group",
  batch_size: 10,
  batch_delay_min_s: 30,
  batch_delay_max_s: 60,
  post_group_delay_s: 300,
  group_delay_min_s: 600,
  group_delay_max_s: 1200,
  greeting_message: null,
};

interface ParseFileResult {
  total_rows: number;
  total_valid: number;
  total_invalid: number;
  unique_ids: string[];
  preview: string[]; // first 20 IDs
  planned_groups: { groupIndex: number; groupName: string; size: number }[];
  warnings: string[];
}

interface StartArgs {
  accountId: number;
  memberIds: string[];
  totalUploaded: number;
  totalInvalid: number;
  settings?: Partial<ChatRunSettings>;
}

export function registerChatHandlers(): void {
  // -------------------------------------------------------------------
  // Parse uploaded IDs file (Extractor CSV with member_id column)
  // -------------------------------------------------------------------
  ipcMain.handle(
    "chat:parse-file",
    async (
      _event,
      payload: { filePath?: string; rawContent?: string; namePrefix?: string }
    ): Promise<ParseFileResult> => {
      const ext = payload.filePath ? extname(payload.filePath).toLowerCase() : ".csv";
      if (![".csv", ".txt"].includes(ext)) {
        throw new Error("Unsupported file type. Use .csv or .txt.");
      }

      const text = payload.rawContent ?? readFileSync(payload.filePath!, "utf8");
      if (!text || !text.trim()) {
        throw new Error("File is empty.");
      }

      const lines = text.split(/\r?\n/);
      const warnings: string[] = [];
      const ids = new Set<string>();
      let totalRows = 0;
      let totalInvalid = 0;

      // Detect Extractor CSV: first line contains 'member_id' header
      const header = (lines[0] ?? "").toLowerCase().split(",").map((c) => c.trim());
      const memberIdCol = header.indexOf("member_id");
      const hasHeader = memberIdCol >= 0;
      if (!hasHeader) {
        warnings.push(
          "No 'member_id' column found. Treating each row as a single ID. (Recommended: upload the Group Members Extractor CSV.)"
        );
      }

      for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw == null) continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        totalRows += 1;

        // Pull the right cell out depending on whether we detected a header.
        let cell: string;
        if (hasHeader) {
          // Naive CSV split is sufficient for FB IDs (digits) but be
          // tolerant of quoted cells.
          const cells = parseCsvLine(trimmed);
          cell = cells[memberIdCol] ?? "";
        } else {
          cell = trimmed.split(",")[0] ?? "";
        }

        const id = cell.trim().replace(/^['"]|['"]$/g, "");
        if (!isValidFacebookId(id)) {
          totalInvalid += 1;
          continue;
        }
        ids.add(id);
      }

      const uniqueIds = Array.from(ids);
      if (uniqueIds.length === 0) {
        throw new Error(
          "No valid Facebook user IDs found in this file. Expected the CSV exported by Group Members Extractor (with a 'member_id' column)."
        );
      }

      const plan = planGroups(uniqueIds, payload.namePrefix ?? DEFAULT_SETTINGS.group_name_prefix);
      const planned = plan.map((g) => ({
        groupIndex: g.groupIndex,
        groupName: g.groupName,
        size: g.memberIds.length,
      }));

      return {
        total_rows: totalRows,
        total_valid: uniqueIds.length,
        total_invalid: totalInvalid,
        unique_ids: uniqueIds,
        preview: uniqueIds.slice(0, 20),
        planned_groups: planned,
        warnings,
      };
    }
  );

  // -------------------------------------------------------------------
  // Start new run
  // -------------------------------------------------------------------
  ipcMain.handle("chat:start", async (_event, args: StartArgs) => {
    if (activeCreator?.isRunning()) {
      throw new Error("A run is already in progress. Pause or stop it first.");
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window available");

    const settings: ChatRunSettings = {
      ...DEFAULT_SETTINGS,
      ...(args.settings ?? {}),
      group_name_prefix:
        (args.settings?.group_name_prefix ?? DEFAULT_SETTINGS.group_name_prefix).trim() ||
        DEFAULT_SETTINGS.group_name_prefix,
    };

    if (settings.batch_size <= 0 || settings.batch_size > 250) {
      throw new Error("batch_size must be between 1 and 250.");
    }
    if (settings.batch_delay_min_s < 0 || settings.batch_delay_max_s < settings.batch_delay_min_s) {
      throw new Error("Invalid batch delay range.");
    }
    if (settings.group_delay_min_s < 0 || settings.group_delay_max_s < settings.group_delay_min_s) {
      throw new Error("Invalid group-to-group delay range.");
    }
    if (!Array.isArray(args.memberIds) || args.memberIds.length === 0) {
      throw new Error("memberIds is required and must be non-empty.");
    }

    const outputPath = await pickReportPath(win);
    if (!outputPath) throw new Error("No report file selected.");

    const creator = new GroupCreator(win);
    activeCreator = creator;
    const handle = await creator.start({
      accountId: args.accountId,
      memberIds: args.memberIds,
      totalUploaded: args.totalUploaded ?? args.memberIds.length,
      totalInvalid: args.totalInvalid ?? 0,
      settings,
      outputPath,
    });

    // Detach: don't wait for the run to finish before returning.
    handle.done.finally(() => {
      if (activeCreator === creator) activeCreator = null;
    });

    return { runId: handle.runId, outputPath };
  });

  // -------------------------------------------------------------------
  // Pause / Resume / Stop
  // -------------------------------------------------------------------
  ipcMain.handle("chat:pause", async () => {
    if (activeCreator?.isRunning()) activeCreator.pause();
    return { paused: true };
  });

  ipcMain.handle("chat:resume", async (_event, runId: number) => {
    if (activeCreator?.isRunning()) {
      throw new Error("A run is already in progress. Pause or stop it first.");
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window available");

    const creator = new GroupCreator(win);
    activeCreator = creator;
    const handle = await creator.resume({ runId });
    handle.done.finally(() => {
      if (activeCreator === creator) activeCreator = null;
    });
    return { runId: handle.runId };
  });

  ipcMain.handle("chat:stop", async () => {
    if (activeCreator) activeCreator.stop();
    return { stopped: true };
  });

  // -------------------------------------------------------------------
  // List / get / report
  // -------------------------------------------------------------------
  ipcMain.handle("chat:list-runs", async () => {
    return listRuns(50);
  });

  ipcMain.handle("chat:get-run", async (_event, runId: number) => {
    const data = getRun(runId);
    if (!data) return null;
    const errors = listErrors(runId, 200);
    return { ...data, errors };
  });

  ipcMain.handle("chat:report", async (_event, runId: number) => {
    const data = getRun(runId);
    if (!data) throw new Error("Run not found");
    const errors = listErrors(runId, 1000);

    const startedMs = new Date(data.run.started_at).getTime();
    const endedMs = data.run.completed_at
      ? new Date(data.run.completed_at).getTime()
      : Date.now();

    return {
      run: data.run,
      groups: data.groups,
      errors,
      duration_seconds: Math.max(0, Math.round((endedMs - startedMs) / 1000)),
    };
  });
}

/**
 * Called from main.ts on app quit so a running creator gets a clean
 * pause checkpoint instead of leaving the run row in 'running' status.
 */
export function pauseActiveChatRun(): void {
  if (activeCreator?.isRunning()) {
    const runId = activeCreator.getRunId();
    activeCreator.pause();
    if (runId) setRunStatus(runId, "paused");
  }
}

// ---------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------

/**
 * Naive CSV line parser sufficient for the columns produced by the
 * Group Members Extractor (no embedded newlines, occasional commas in
 * names but typically not).
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === ",") {
        cells.push(current);
        current = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        current += ch;
      }
    }
  }
  cells.push(current);
  return cells;
}

function isValidFacebookId(id: string): boolean {
  // FB IDs are positive integers with 5-20 digits typically.
  return /^[0-9]{5,20}$/.test(id);
}
