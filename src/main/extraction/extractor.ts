import type { BrowserWindow } from "electron";
import { app, dialog } from "electron";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createObjectCsvStringifier } from "csv-writer";
import { getDB } from "../db/connection";
import { getDecryptedToken, updateAccountStatus } from "../db/accounts-repo";
import { fetchGroupInfo, fetchGroupMembers, validateToken } from "../api/platform-client";
import { CSV_FIELDS, BATCH_SIZE, REQUEST_DELAY_MS } from "@shared/constants";
import type { ExtractedMember, ExtractionError, ExtractionProgress } from "@shared/types";

export class GroupExtractor {
  private mainWin: BrowserWindow;
  private abortFlag = false;
  private failedFlag = false;
  private seenMemberIds = new Set<string>();
  private runId: number | null = null;
  private totalExtracted = 0;

  constructor(win: BrowserWindow) {
    this.mainWin = win;
  }

  async start(groupIds: string[], accountId: number): Promise<string> {
    this.abortFlag = false;
    this.failedFlag = false;
    this.seenMemberIds.clear();
    this.totalExtracted = 0;

    const db = getDB();
    const { filePath: outputPath } = await dialog.showSaveDialog(this.mainWin, {
      defaultPath: join(app.getPath("documents"), `extraction-${Date.now()}.csv`),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!outputPath) {
      throw new Error("No output path selected");
    }

    const result = db
      .prepare(
        `INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)`
      )
      .run(JSON.stringify(groupIds), accountId, outputPath);
    this.runId = result.lastInsertRowid as number;

    const { token, name: sourceAccount } = getDecryptedToken(accountId);
    const validation = await validateToken(token);
    updateAccountStatus(accountId, validation.status, validation.name, validation.id);
    if (!validation.valid) {
      if (validation.status === "Blocked") {
        throw new Error(
          "Selected account is blocked by a login checkpoint (code 190). Re-login and pass the checkpoint, then validate the token again."
        );
      }
      if (validation.status === "Expired") {
        throw new Error("Selected account token is expired. Please refresh and validate it again.");
      }
      throw new Error("Selected account token is invalid. Please refresh and validate it again.");
    }

    this.initializeCsv(outputPath);

    for (let index = 0; index < groupIds.length; index++) {
      if (this.abortFlag) {
        break;
      }

      const groupId = groupIds[index];
      const groupInfo = await fetchGroupInfo(token, groupId);
      const groupName = groupInfo?.name ?? groupId;

      this.emitProgress({
        current_group_id: groupId,
        current_group_index: index,
        total_groups: groupIds.length,
        members_extracted: this.totalExtracted,
        current_batch: 0,
        status: "running",
      });

      await this.processGroup({
        outputPath,
        token,
        sourceAccount,
        groupId,
        groupName,
        groupIndex: index,
        totalGroups: groupIds.length,
      });

      if (this.failedFlag) {
        break;
      }
    }

    const finalStatus = this.abortFlag ? "stopped" : this.failedFlag ? "failed" : "completed";
    if (this.runId) {
      db.prepare(
        `UPDATE extraction_runs
         SET status = ?, completed_at = datetime('now'), members_extracted = ?
         WHERE id = ?`
      ).run(finalStatus, this.totalExtracted, this.runId);
    }

    this.emitProgress({
      current_group_id: groupIds[Math.max(0, groupIds.length - 1)] ?? "",
      current_group_index: Math.max(0, groupIds.length - 1),
      total_groups: groupIds.length,
      members_extracted: this.totalExtracted,
      current_batch: 0,
      status: finalStatus,
    });

    return outputPath;
  }

  stop() {
    this.abortFlag = true;
  }

  private initializeCsv(outputPath: string) {
    const csvStringifier = createObjectCsvStringifier({
      header: CSV_FIELDS.map((field) => ({ id: field, title: field })),
    });
    const header = csvStringifier.getHeaderString();
    writeFileSync(outputPath, header ?? "", "utf8");
  }

  private async processGroup(params: {
    outputPath: string;
    token: string;
    sourceAccount: string;
    groupId: string;
    groupName: string;
    groupIndex: number;
    totalGroups: number;
  }) {
    const { outputPath, token, sourceAccount, groupId, groupName, groupIndex, totalGroups } = params;
    const db = getDB();
    const insertMember = db.prepare(
      `INSERT OR IGNORE INTO extraction_members
       (run_id, member_id, member_name, profile_url, group_id, group_name, extracted_at, source_account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let currentBatch = 0;
    let afterCursor: string | null = null;
    let nextPageUrl: string | null = null;
    let lastPageMarker: string | null = null;

    while (!this.abortFlag) {
      currentBatch += 1;

      try {
        const page = await fetchGroupMembers(
          token,
          groupId,
          afterCursor,
          BATCH_SIZE,
          nextPageUrl
        );
        const batchMembers = page.members
          .filter((member) => !this.seenMemberIds.has(member.id))
          .map<ExtractedMember>((member) => {
            this.seenMemberIds.add(member.id);
            return {
              member_id: member.id,
              member_name: member.name,
              profile_url: member.link,
              group_id: groupId,
              group_name: groupName,
              extracted_at: new Date().toISOString(),
              source_account: sourceAccount,
            };
          });

        if (batchMembers.length > 0) {
          if (!this.runId) {
            throw new Error("Extraction run not initialized");
          }

          const insertBatch = db.transaction((members: ExtractedMember[]) => {
            for (const member of members) {
              insertMember.run(
                this.runId,
                member.member_id,
                member.member_name,
                member.profile_url,
                member.group_id,
                member.group_name,
                member.extracted_at,
                member.source_account
              );
            }
          });

          insertBatch(batchMembers);
          this.appendBatchToCsv(outputPath, batchMembers);
          this.totalExtracted += batchMembers.length;
        }

        this.emitProgress({
          current_group_id: groupId,
          current_group_index: groupIndex,
          total_groups: totalGroups,
          members_extracted: this.totalExtracted,
          current_batch: currentBatch,
          status: "running",
        });

        if (!page.hasMore) {
          break;
        }

        const pageMarker = page.nextPageUrl ?? (page.nextCursor ? `cursor:${page.nextCursor}` : null);
        if (!pageMarker || pageMarker === lastPageMarker) {
          this.recordError(
            groupId,
            currentBatch,
            new Error("Pagination stalled before all pages were fetched")
          );
          break;
        }

        lastPageMarker = pageMarker;
        nextPageUrl = page.nextPageUrl;
        afterCursor = page.nextPageUrl ? null : page.nextCursor;
        await this.delay(REQUEST_DELAY_MS);
      } catch (error) {
        this.recordError(groupId, currentBatch, error);
        this.failedFlag = true;
        break;
      }
    }
  }

  private appendBatchToCsv(outputPath: string, members: ExtractedMember[]) {
    const csvStringifier = createObjectCsvStringifier({
      header: CSV_FIELDS.map((field) => ({ id: field, title: field })),
    });
    appendFileSync(outputPath, csvStringifier.stringifyRecords(members), "utf8");
  }

  private recordError(groupId: string, batchNumber: number, error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const payload: ExtractionError = {
      group_id: groupId,
      batch_number: batchNumber,
      error_message: errorMessage,
      timestamp: new Date().toISOString(),
    };

    if (this.runId) {
      getDB()
        .prepare(
          `INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(this.runId, payload.group_id, payload.batch_number, payload.error_message, payload.timestamp);
    }

    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:error", payload);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abortFlag) {
        resolve();
        return;
      }
      setTimeout(resolve, ms);
    });
  }

  private emitProgress(progress: ExtractionProgress) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:progress", progress);
    }
  }
}
