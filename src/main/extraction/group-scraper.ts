import { BrowserWindow, session, app, dialog } from "electron";
import { appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createObjectCsvStringifier } from "csv-writer";
import { getDB } from "../db/connection";
import { getDecryptedToken } from "../db/accounts-repo";
import { getSessionCookies } from "../api/facebook-login";
import { CSV_FIELDS, REQUEST_DELAY_MS } from "@shared/constants";
import type { ExtractedMember, ExtractionError, ExtractionProgress } from "@shared/types";

interface ScrapedMember {
  id: string;
  name: string;
  profileUrl: string;
}

const FB_EXCLUDE_PATHS = [
  "groups", "watch", "reel", "reels", "marketplace", "gaming", "events",
  "feeds", "feed", "stories", "jobs", "ads", "pages", "developers", "help",
  "settings", "support", "notifications", "messages", "friends", "account",
  "login", "signup", "recover", "policy", "terms", "photo", "photos", "posts",
  "videos", "music", "books", "likes", "about", "overview", "members",
  "admins", "moderators", "pending", "blocked", "invite", "discussion",
  "media", "files", "userguides", "discovery", "suggested", "invitees",
  "membership", "pending_members", "hashtag", "search", "directory",
];

const SCRAPER_JS = [
  "(function scrapeMembers() {",
  "  var results = [];",
  "  var seen = new Set();",
  "",
  "  function extractProfile(href) {",
  "    if (!href) return null;",
  "    var url = href;",
  "    if (url.charAt(0) === '/') url = 'https://www.facebook.com' + url;",
  "",
  "    var groupUserMatch = url.match(/facebook\\.com\\/groups\\/\\d+\\/user\\/(\\d+)/);",
  "    if (groupUserMatch) {",
  "      return { id: groupUserMatch[1], url: 'https://www.facebook.com/profile.php?id=' + groupUserMatch[1] };",
  "    }",
  "",
  "    var profileIdMatch = url.match(/facebook\\.com\\/profile\\.php[^?]*[?&]id=(\\d+)/);",
  "    if (profileIdMatch) {",
  "      return { id: profileIdMatch[1], url: 'https://www.facebook.com/profile.php?id=' + profileIdMatch[1] };",
  "    }",
  "",
  "    var cleanUrl = url.split('?')[0].split('#')[0].replace(/\\/+$/, '');",
  "    var parts = cleanUrl.replace('https://www.facebook.com/', '').split('/');",
  "    if (parts.length >= 1 && parts[0]) {",
  "      var username = parts[0];",
  "      if (/^[a-zA-Z0-9.]{5,50}$/.test(username) && window.__fbExclude.indexOf(username) === -1) {",
  "        return { id: username, url: 'https://www.facebook.com/' + username };",
  "      }",
  "    }",
  "    return null;",
  "  }",
  "",
  "  var allLinks = document.querySelectorAll('a[href]');",
  "  for (var i = 0; i < allLinks.length; i++) {",
  "    var a = allLinks[i];",
  "    var profile = extractProfile(a.getAttribute('href'));",
  "    if (!profile) continue;",
  "    if (seen.has(profile.id)) continue;",
  "",
  "    var name = '';",
  "    var img = a.querySelector('img');",
  "    if (img) name = img.getAttribute('alt') || '';",
  "    if (!name) {",
  "      var spans = a.querySelectorAll('span');",
  "      for (var j = 0; j < spans.length; j++) {",
  "        var t = spans[j].textContent.trim();",
  "        if (t.length >= 2 && t.length <= 100 && t.indexOf('\\n') === -1) { name = t; break; }",
  "      }",
  "    }",
  "    if (!name) name = a.textContent.trim().split('\\n')[0].trim();",
  "    if (name.length < 2) continue;",
  "",
  "    seen.add(profile.id);",
  "    results.push({ id: profile.id, name: name, profileUrl: profile.url });",
  "  }",
  "  return results;",
  "})();",
].join("\n");

const DEBUG_JS = [
  "(function() {",
  "  return {",
  "    url: window.location.href,",
  "    title: document.title,",
  "    bodyLength: document.body ? document.body.innerHTML.length : 0,",
  "    linkCount: document.querySelectorAll('a[href]').length,",
  "    sampleLinks: Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(function(a) {",
  "      return { href: a.getAttribute('href'), text: (a.textContent || '').trim().substring(0, 80) };",
  "    }),",
  "    hasLogin: !!document.querySelector('form[action*=\"login\"]'),",
  "    bodySnippet: document.body ? document.body.innerHTML.substring(0, 5000) : ''",
  "  };",
  "})();",
].join("\n");

export class GroupScraper {
  private mainWin: BrowserWindow;
  private abortFlag = false;
  private seenMemberIds = new Set<string>();
  private runId: number | null = null;
  private totalExtracted = 0;
  private scraperWindow: BrowserWindow | null = null;

  constructor(win: BrowserWindow) {
    this.mainWin = win;
  }

  async start(groupIds: string[], accountId: number): Promise<string> {
    this.abortFlag = false;
    this.seenMemberIds.clear();
    this.totalExtracted = 0;

    const db = getDB();
    const { filePath: outputPath } = await dialog.showSaveDialog(this.mainWin, {
      defaultPath: join(app.getPath("documents"), "extraction-" + Date.now() + ".csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!outputPath) {
      throw new Error("No output path selected");
    }

    const result = db
      .prepare(
        "INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)"
      )
      .run(JSON.stringify(groupIds), accountId, outputPath);
    this.runId = result.lastInsertRowid as number;

    const { token, name: sourceAccount } = getDecryptedToken(accountId);
    this.initializeCsv(outputPath);

    const ses = session.fromPartition("persist:scraper");
    const cookies = await getSessionCookies(token);
    for (const cookie of cookies) {
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

    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    this.scraperWindow.webContents.setUserAgent(userAgent);

    try {
      for (let index = 0; index < groupIds.length; index++) {
        if (this.abortFlag) break;

        const groupId = groupIds[index];

        this.emitProgress({
          current_group_id: groupId,
          current_group_index: index,
          total_groups: groupIds.length,
          members_extracted: this.totalExtracted,
          current_batch: 0,
          status: "running",
        });

        await this.scrapeGroup({
          outputPath,
          sourceAccount,
          groupId,
          groupIndex: index,
          totalGroups: groupIds.length,
        });
      }
    } finally {
      if (this.scraperWindow && !this.scraperWindow.isDestroyed()) {
        this.scraperWindow.destroy();
        this.scraperWindow = null;
      }
    }

    const finalStatus = this.abortFlag ? "stopped" : "completed";
    if (this.runId) {
      db.prepare(
        "UPDATE extraction_runs SET status = ?, completed_at = datetime('now'), members_extracted = ? WHERE id = ?"
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

  private async scrapeGroup(params: {
    outputPath: string;
    sourceAccount: string;
    groupId: string;
    groupIndex: number;
    totalGroups: number;
  }) {
    const { outputPath, sourceAccount, groupId, groupIndex, totalGroups } = params;
    const db = getDB();
    const insertMember = db.prepare(
      "INSERT OR IGNORE INTO extraction_members " +
        "(run_id, member_id, member_name, profile_url, group_id, group_name, extracted_at, source_account) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );

    const scraper = this.scraperWindow!;
    const groupUrl = "https://www.facebook.com/groups/" + encodeURIComponent(groupId) + "/members";

    await scraper.loadURL(groupUrl);
    await this.delay(5000);

    await scraper.webContents.executeJavaScript(
      "window.__fbExclude = " + JSON.stringify(FB_EXCLUDE_PATHS) + ";"
    );

    const debug: any = await scraper.webContents.executeJavaScript(DEBUG_JS);
    const debugDir = join(dirname(outputPath), "scraper-debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(
      join(debugDir, "debug-" + groupId + ".json"),
      JSON.stringify(debug, null, 2),
      "utf8"
    );

    if (debug.hasLogin || debug.url.includes("login")) {
      throw new Error(
        "Facebook login page detected — session cookies may be invalid or expired. Try logging in again first."
      );
    }

    let currentBatch = 0;
    let noNewCount = 0;
    const MAX_NO_NEW = 5;

    while (!this.abortFlag) {
      currentBatch += 1;

      try {
        const scraped: ScrapedMember[] = await scraper.webContents.executeJavaScript(SCRAPER_JS);

        const newMembers: ExtractedMember[] = [];
        for (const m of scraped) {
          if (this.seenMemberIds.has(m.id)) continue;
          this.seenMemberIds.add(m.id);
          newMembers.push({
            member_id: m.id,
            member_name: m.name,
            profile_url: m.profileUrl,
            group_id: groupId,
            group_name: groupId,
            extracted_at: new Date().toISOString(),
            source_account: sourceAccount,
          });
        }

        if (newMembers.length > 0) {
          noNewCount = 0;
          if (!this.runId) throw new Error("Extraction run not initialized");

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

          insertBatch(newMembers);
          this.appendBatchToCsv(outputPath, newMembers);
          this.totalExtracted += newMembers.length;
        } else {
          noNewCount++;
        }

        this.emitProgress({
          current_group_id: groupId,
          current_group_index: groupIndex,
          total_groups: totalGroups,
          members_extracted: this.totalExtracted,
          current_batch: currentBatch,
          status: "running",
        });

        if (noNewCount >= MAX_NO_NEW) break;

        await this.scrollPage(scraper);
        await this.delay(REQUEST_DELAY_MS);
      } catch (error) {
        this.recordError(groupId, currentBatch, error);
        break;
      }
    }
  }

  private async scrollPage(win: BrowserWindow): Promise<void> {
    await win.webContents.executeJavaScript(
      "window.scrollBy({ top: 1200, behavior: 'smooth' });"
    );
    await this.delay(2000);
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
          "INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp) VALUES (?, ?, ?, ?, ?)"
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
