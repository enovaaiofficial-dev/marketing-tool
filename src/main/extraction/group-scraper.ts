import { BrowserWindow, session, app, dialog } from "electron";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createObjectCsvStringifier } from "csv-writer";
import { getDB } from "../db/connection";
import { getDecryptedToken, getValidAccountIds } from "../db/accounts-repo";
import { getSessionCookies } from "../api/facebook-login";
import { CSV_FIELDS } from "@shared/constants";
import type { ExtractionError, ExtractionProgress } from "@shared/types";

const SCRAPE_IDS_JS = `(function(){
  var r=[],s=new Set(),a=document.querySelectorAll('a[href*="/user/"]');
  for(var i=0;i<a.length;i++){
    var m=a[i].getAttribute('href').match(/\\/user\\/(\\d+)/);
    if(!m||s.has(m[1]))continue;
    s.add(m[1]);
    r.push(m[1]);
  }
  return r;
})();`;

const CHECK_BLOCK_JS = `(function(){
  var t=document.title||'';
  var b=document.body?document.body.innerText.substring(0,2000):'';
  var u=window.location.href;
  var isLogin=u.indexOf('login')!==-1||!!document.querySelector('form[action*="login"]');
  var isBlock=b.indexOf('temporarily blocked')!==-1||b.indexOf('You')!==-1&&b.indexOf('restricted')!==-1||t.indexOf('Security')!==-1;
  var isCaptcha=!!document.querySelector('iframe[src*="captcha"]')||b.indexOf('captcha')!==-1;
  return {isLogin:isLogin,isBlock:isBlock,isCaptcha:isCaptcha,title:t};
})();`;

const SCROLL_JS = "window.scrollBy({top:3000,behavior:'auto'});";

const WAIT_FOR_NEW_JS = [
  "(function(){",
  "var prevCount=arguments[0];",
  "var start=Date.now();",
  "return new Promise(function(resolve){",
  "function check(){",
  "var cur=document.querySelectorAll('a[href*=\"\\/user\\/\"]').length;",
  "if(cur>prevCount||Date.now()-start>10000)resolve(cur);",
  "else setTimeout(check,500);",
  "}",
  "check();",
  "});",
  "})(",
].join("\n");

const CSV_ID_FIELDS = ["member_id", "group_id", "extracted_at", "source_account"] as const;

const MEMORY_FLUSH_INTERVAL = 500;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 6000;
const MAX_NO_NEW = 30;
const SCROLLS_PER_BATCH = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 5000;

interface AccountSlot {
  id: number;
  token: string;
  name: string;
  failCount: number;
}

interface PersistedState {
  runId: number;
  outputPath: string;
  groupIds: string[];
  groupIndex: number;
  groupId: string;
  batch: number;
  totalExtracted: number;
  accountIdIndex: number;
}

let globalScraper: GroupScraper | null = null;

export function getActiveScraper(): GroupScraper | null {
  return globalScraper;
}

export class GroupScraper {
  private mainWin: BrowserWindow;
  private abortFlag = false;
  private seenMemberIds = new Set<string>();
  private runId: number | null = null;
  private totalExtracted = 0;
  private scraperWindow: BrowserWindow | null = null;
  private accounts: AccountSlot[] = [];
  private currentAccountIndex = 0;
  private currentGroupIndex = 0;
  private currentGroupId = "";
  private currentBatch = 0;
  private outputPath = "";
  private groupIds: string[] = [];
  private running = false;

  constructor(win: BrowserWindow) {
    this.mainWin = win;
  }

  async start(
    groupIds: string[],
    accountId: number,
    resumeRunId?: number | null
  ): Promise<string> {
    this.abortFlag = false;
    this.totalExtracted = 0;
    this.currentAccountIndex = 0;
    this.running = true;
    globalScraper = this;

    const db = getDB();
    let startGroupIndex = 0;
    let startBatch = 0;

    const allValidIds = getValidAccountIds();
    const accountIds = allValidIds.length > 1 ? allValidIds : [accountId];
    this.accounts = accountIds.map((id) => {
      const info = getDecryptedToken(id);
      return { id, token: info.token, name: info.name, failCount: 0 };
    });

    if (resumeRunId) {
      const run = db
        .prepare(
          "SELECT output_path, group_ids, current_group_index, current_group_id, current_batch, members_extracted, last_account_id FROM extraction_runs WHERE id = ?"
        )
        .get(resumeRunId) as any;
      if (!run) throw new Error("Run " + resumeRunId + " not found");
      this.outputPath = run.output_path;
      groupIds = JSON.parse(run.group_ids);
      startGroupIndex = run.current_group_index ?? 0;
      this.currentGroupId = run.current_group_id ?? "";
      startBatch = run.current_batch ?? 0;
      this.totalExtracted = run.members_extracted ?? 0;
      this.runId = resumeRunId;

      if (run.last_account_id) {
        const idx = this.accounts.findIndex((a) => a.id === run.last_account_id);
        if (idx >= 0) this.currentAccountIndex = idx;
      }

      const existing = db
        .prepare("SELECT member_id FROM extraction_members WHERE run_id = ?")
        .all(resumeRunId) as any[];
      this.seenMemberIds = new Set(existing.map((r) => r.member_id));

      this.rebuildCsvFromDb();
    } else {
      this.seenMemberIds.clear();
      const { filePath } = await dialog.showSaveDialog(this.mainWin, {
        defaultPath: join(app.getPath("documents"), "extraction-" + Date.now() + ".csv"),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!filePath) {
        this.running = false;
        globalScraper = null;
        throw new Error("No output path selected");
      }
      this.outputPath = filePath;

      const result = db
        .prepare(
          "INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)"
        )
        .run(JSON.stringify(groupIds), accountId, filePath);
      this.runId = result.lastInsertRowid as number;
      this.initializeCsv(filePath);
    }

    this.groupIds = groupIds;

    await this.initScraperWindow();

    try {
      for (let index = startGroupIndex; index < groupIds.length; index++) {
        if (this.abortFlag) break;

        const groupId = groupIds[index];
        const batchStart = index === startGroupIndex ? startBatch : 0;
        this.currentGroupIndex = index;
        this.currentGroupId = groupId;
        this.currentBatch = batchStart;

        this.emitProgress({
          current_group_id: groupId,
          current_group_index: index,
          total_groups: groupIds.length,
          members_extracted: this.totalExtracted,
          current_batch: batchStart,
          status: "running",
        });

        await this.scrapeGroup(groupId, index, groupIds.length, batchStart);
      }
    } finally {
      this.running = false;
      if (this.scraperWindow && !this.scraperWindow.isDestroyed()) {
        this.scraperWindow.destroy();
        this.scraperWindow = null;
      }
      globalScraper = null;
    }

    const finalStatus = this.abortFlag ? "stopped" : "completed";
    if (this.runId) {
      db.prepare(
        "UPDATE extraction_runs SET status = ?, completed_at = datetime('now'), members_extracted = ? WHERE id = ?"
      ).run(finalStatus, this.totalExtracted, this.runId);
    }

    this.emitProgress({
      current_group_id: this.groupIds[Math.max(0, this.groupIds.length - 1)] ?? "",
      current_group_index: Math.max(0, this.groupIds.length - 1),
      total_groups: this.groupIds.length,
      members_extracted: this.totalExtracted,
      current_batch: 0,
      status: finalStatus,
    });

    return this.outputPath;
  }

  stop() {
    this.abortFlag = true;
    this.persistState();
  }

  forceSave() {
    this.persistState();
  }

  getRunId(): number | null {
    return this.runId;
  }

  isRunning(): boolean {
    return this.running;
  }

  private getPersistedState(): PersistedState | null {
    if (!this.runId) return null;
    return {
      runId: this.runId,
      outputPath: this.outputPath,
      groupIds: this.groupIds,
      groupIndex: this.currentGroupIndex,
      groupId: this.currentGroupId,
      batch: this.currentBatch,
      totalExtracted: this.totalExtracted,
      accountIdIndex: this.currentAccountIndex,
    };
  }

  private persistState() {
    if (!this.runId) return;
    const db = getDB();
    db.prepare(
      "UPDATE extraction_runs SET status = 'stopped', current_group_index = ?, current_group_id = ?, current_batch = ?, members_extracted = ?, last_account_id = ? WHERE id = ?"
    ).run(
      this.currentGroupIndex,
      this.currentGroupId,
      this.currentBatch,
      this.totalExtracted,
      this.accounts[this.currentAccountIndex]?.id ?? null,
      this.runId
    );
  }

  private async initScraperWindow() {
    if (this.scraperWindow && !this.scraperWindow.isDestroyed()) {
      this.scraperWindow.destroy();
    }

    const account = this.accounts[this.currentAccountIndex];
    const ses = session.fromPartition("persist:scraper");
    ses.clearStorageData();

    let cookies: Awaited<ReturnType<typeof getSessionCookies>>;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        cookies = await getSessionCookies(account.token);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3) {
          this.emitProgress({
            current_group_id: this.currentGroupId,
            current_group_index: this.currentGroupIndex,
            total_groups: this.groupIds.length,
            members_extracted: this.totalExtracted,
            current_batch: this.currentBatch,
            status: "running",
          });
          await this.delay(5000 * attempt);
        }
      }
    }
    if (lastErr) throw lastErr;

    for (const cookie of cookies!) {
      await ses.cookies.set({
        url: "https://www.facebook.com",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? ".facebook.com",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? true,
        httpOnly: cookie.httponly ?? false,
      });
    }

    this.scraperWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      show: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.scraperWindow.webContents.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    this.scraperWindow.on("close", (e) => {
      e.preventDefault();
    });
  }

  private async rotateAccount(): Promise<boolean> {
    const nextIdx = this.accounts.findIndex(
      (a, i) => i !== this.currentAccountIndex && a.failCount < 3
    );
    if (nextIdx === -1) return false;

    this.currentAccountIndex = nextIdx;
    await this.initScraperWindow();
    return true;
  }

  private initializeCsv(outputPath: string) {
    const csvStringifier = createObjectCsvStringifier({
      header: CSV_ID_FIELDS.map((f) => ({ id: f, title: f })),
    });
    writeFileSync(outputPath, csvStringifier.getHeaderString() ?? "", "utf8");
  }

  private rebuildCsvFromDb() {
    if (!this.runId) return;
    const db = getDB();
    this.initializeCsv(this.outputPath);
    const rows = db
      .prepare(
        "SELECT member_id, group_id, extracted_at, source_account FROM extraction_members WHERE run_id = ? ORDER BY id"
      )
      .all(this.runId) as any[];
    if (rows.length > 0) {
      this.appendBatchToCsv(this.outputPath, rows);
    }
  }

  private async scrapeGroup(
    groupId: string,
    groupIndex: number,
    totalGroups: number,
    startBatch: number
  ) {
    const db = getDB();
    const insertMember = db.prepare(
      "INSERT OR IGNORE INTO extraction_members (run_id, member_id, group_id, group_name, extracted_at, source_account) VALUES (?, ?, ?, '', ?, ?)"
    );

    const groupUrl =
      "https://www.facebook.com/groups/" + encodeURIComponent(groupId) + "/members";

    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        const win = this.scraperWindow;
        if (!win || win.isDestroyed()) {
          await this.initScraperWindow();
        }
        await this.loadPage(this.scraperWindow!, groupUrl);
        await this.delay(3000);
        break;
      } catch (err) {
        retries++;
        if (retries >= MAX_RETRIES) {
          this.recordError(groupId, startBatch, err);
          return;
        }
        this.recordError(groupId, startBatch, new Error("Page load failed (retry " + retries + "/" + MAX_RETRIES + "), waiting..."));
        await this.delay(RETRY_BASE_MS * retries);
      }
    }

    if (startBatch > 0) {
      for (let i = 0; i < startBatch; i++) {
        const win = this.scraperWindow;
        if (!win || win.isDestroyed()) break;
        try {
          await win.webContents.executeJavaScript(SCROLL_JS);
          await this.delay(400);
        } catch {
          break;
        }
      }
      await this.delay(2000);
    }

    let currentBatch = startBatch;
    let noNewCount = 0;
    let extractCount = 0;
    let prevVisibleCount = 0;
    let consecutiveErrors = 0;

    while (!this.abortFlag) {
      currentBatch++;
      this.currentBatch = currentBatch;

      try {
        const win = this.scraperWindow;
        if (!win || win.isDestroyed()) {
          await this.initScraperWindow();
          await this.loadPage(this.scraperWindow!, groupUrl);
          await this.delay(3000);
          prevVisibleCount = 0;
          continue;
        }

        for (let s = 0; s < SCROLLS_PER_BATCH; s++) {
          await win.webContents.executeJavaScript(SCROLL_JS);
          await this.delay(600);
        }
        await win.webContents.executeJavaScript(
          "window.scrollTo(0, document.body.scrollHeight);"
        );

        try {
          const newVisibleCount: number = await win.webContents.executeJavaScript(
            WAIT_FOR_NEW_JS + String(prevVisibleCount) + ");"
          );
          prevVisibleCount = newVisibleCount;
        } catch {
          await this.delay(2000);
        }

        const blockInfo: any = await win.webContents.executeJavaScript(CHECK_BLOCK_JS);
        if (blockInfo.isLogin || blockInfo.isBlock || blockInfo.isCaptcha) {
          this.accounts[this.currentAccountIndex].failCount++;
          const reason = blockInfo.isCaptcha
            ? "Captcha detected"
            : blockInfo.isBlock
              ? "Account blocked/restricted"
              : "Session expired (login page)";
          this.recordError(groupId, currentBatch, new Error(reason + " — account: " + this.accounts[this.currentAccountIndex].name));
          this.persistState();

          const rotated = await this.rotateAccount();
          if (!rotated) {
            this.recordError(groupId, currentBatch, new Error("All accounts blocked or expired. Stopping — resume later."));
            this.persistState();
            break;
          }

          await this.loadPage(this.scraperWindow!, groupUrl);
          await this.delay(3000);
          prevVisibleCount = 0;
          continue;
        }

        const ids: string[] = await win.webContents.executeJavaScript(SCRAPE_IDS_JS);

        const newIds: string[] = [];
        for (const id of ids) {
          if (this.seenMemberIds.has(id)) continue;
          this.seenMemberIds.add(id);
          newIds.push(id);
        }

        if (newIds.length > 0) {
          noNewCount = 0;
          extractCount += newIds.length;
          consecutiveErrors = 0;
          if (!this.runId) throw new Error("Extraction run not initialized");

          const now = new Date().toISOString();
          const accountName = this.accounts[this.currentAccountIndex].name;
          const insertBatch = db.transaction((memberIds: string[]) => {
            for (const id of memberIds) {
              insertMember.run(this.runId, id, groupId, now, accountName);
            }
          });

          insertBatch(newIds);

          const rows = newIds.map((id) => ({
            member_id: id,
            group_id: groupId,
            extracted_at: now,
            source_account: accountName,
          }));
          this.appendBatchToCsv(this.outputPath, rows);
          this.totalExtracted += newIds.length;
        } else {
          noNewCount++;
        }

        if (extractCount >= MEMORY_FLUSH_INTERVAL) {
          this.seenMemberIds.clear();
          const dbIds = db
            .prepare("SELECT member_id FROM extraction_members WHERE run_id = ?")
            .all(this.runId!) as any[];
          for (const row of dbIds) this.seenMemberIds.add(row.member_id);
          extractCount = 0;
        }

        this.emitProgress({
          current_group_id: groupId,
          current_group_index: groupIndex,
          total_groups: totalGroups,
          members_extracted: this.totalExtracted,
          current_batch: currentBatch,
          status: "running",
        });

        this.persistState();

        if (noNewCount >= MAX_NO_NEW) break;

        await this.randomDelay();
      } catch (error) {
        consecutiveErrors++;
        this.recordError(groupId, currentBatch, error);

        if (consecutiveErrors >= 5) {
          this.recordError(groupId, currentBatch, new Error("Too many consecutive errors (" + consecutiveErrors + "). Saving progress — resume later."));
          this.persistState();
          break;
        }

        this.persistState();
        await this.delay(RETRY_BASE_MS * Math.min(consecutiveErrors, 3));

        const win = this.scraperWindow;
        if (!win || win.isDestroyed()) {
          try {
            await this.initScraperWindow();
            await this.loadPage(this.scraperWindow!, groupUrl);
            await this.delay(3000);
          } catch {
            this.recordError(groupId, currentBatch, new Error("Failed to recover window. Saving progress."));
            this.persistState();
            break;
          }
        } else {
          try {
            await this.loadPage(win, groupUrl);
            await this.delay(3000);
          } catch {
            this.recordError(groupId, currentBatch, new Error("Page reload failed. Saving progress."));
            this.persistState();
            break;
          }
        }
        prevVisibleCount = 0;
      }
    }

    this.persistState();
  }

  private async loadPage(scraper: BrowserWindow, url: string): Promise<void> {
    try {
      await scraper.loadURL(url);
    } catch {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Page load timed out")),
          20000
        );
        scraper.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve();
        });
        scraper.webContents.once("did-fail-load", (_e, _code, desc) => {
          clearTimeout(timer);
          reject(new Error("Page failed to load: " + (desc ?? "unknown")));
        });
        scraper.loadURL(url).catch(() => {});
      });
    }
  }

  private appendBatchToCsv(
    outputPath: string,
    rows: { member_id: string; group_id: string; extracted_at: string; source_account: string }[]
  ) {
    const csvStringifier = createObjectCsvStringifier({
      header: CSV_ID_FIELDS.map((f) => ({ id: f, title: f })),
    });
    appendFileSync(outputPath, csvStringifier.stringifyRecords(rows), "utf8");
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
      } catch {}
    }

    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:error", payload);
    }
  }

  private randomDelay(): Promise<void> {
    const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
    return this.delay(ms);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abortFlag) return resolve();
      setTimeout(resolve, ms);
    });
  }

  private emitProgress(progress: ExtractionProgress) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:progress", progress);
    }
  }
}
