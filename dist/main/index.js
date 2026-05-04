import { app, ipcMain, session, BrowserWindow, dialog } from "electron";
import { join, resolve, dirname, extname } from "path";
import Database from "better-sqlite3";
import { createDecipheriv, randomBytes, createCipheriv } from "crypto";
import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { createObjectCsvStringifier } from "csv-writer";
import { createRequire } from "module";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function createTables(db2) {
  db2.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_encrypted TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      account_name TEXT,
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'Unchecked',
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_token
      ON accounts(token_encrypted);

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_ids TEXT NOT NULL,
      source_account_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      output_path TEXT NOT NULL,
      members_extracted INTEGER DEFAULT 0,
      current_group_index INTEGER DEFAULT 0,
      current_group_id TEXT,
      current_batch INTEGER DEFAULT 0,
      scroll_position INTEGER DEFAULT 0,
      last_account_id INTEGER,
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS extraction_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      member_name TEXT,
      profile_url TEXT,
      group_id TEXT NOT NULL,
      group_name TEXT,
      extracted_at TEXT DEFAULT (datetime('now')),
      source_account TEXT,
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE,
      UNIQUE(member_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS extraction_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      batch_number INTEGER NOT NULL,
      error_message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
    );

    -- Per-group state for parallel scraper workers. A run has many groups;
    -- each group is processed by exactly one worker at a time. Used as the
    -- queue source on (re)start and for resume after stop.
    CREATE TABLE IF NOT EXISTS extraction_run_groups (
      run_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      members_count INTEGER NOT NULL DEFAULT 0,
      worker_index INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, group_id),
      FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_extraction_run_groups_status
      ON extraction_run_groups(run_id, status);

    CREATE INDEX IF NOT EXISTS idx_extraction_members_run
      ON extraction_members(run_id);

    -- ===========================================================
    -- Facebook Chat Groups Creator
    -- ===========================================================

    -- One row per "create chat groups" job. Holds settings, status,
    -- the source-of-truth ID list, and aggregate counts. Used both
    -- live (running) and after completion (reports + resume).
    CREATE TABLE IF NOT EXISTS chat_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_account_id INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      total_uploaded_ids INTEGER NOT NULL DEFAULT 0,
      total_valid_ids INTEGER NOT NULL DEFAULT 0,
      total_invalid_ids INTEGER NOT NULL DEFAULT 0,
      total_groups INTEGER NOT NULL DEFAULT 0,
      groups_completed INTEGER NOT NULL DEFAULT 0,
      members_added INTEGER NOT NULL DEFAULT 0,
      members_failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      output_path TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    -- One row per chat group created (or attempted) within a run.
    -- group_index is 0-based and identifies which slice of the ID
    -- list belongs to this group. thread_id is null until creation
    -- succeeds; status drives resume/retry decisions.
    CREATE TABLE IF NOT EXISTS chat_groups_created (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_index INTEGER NOT NULL,
      thread_id TEXT,
      group_name TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, group_index),
      FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE
    );

    -- Per-batch errors and skipped IDs. Lets the UI render an error
    -- log and lets the report enumerate failures.
    CREATE TABLE IF NOT EXISTS chat_creation_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      group_index INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      member_ids_json TEXT,
      error_message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_groups_created_run
      ON chat_groups_created(run_id, group_index);

    CREATE INDEX IF NOT EXISTS idx_chat_creation_errors_run
      ON chat_creation_errors(run_id);
  `);
}
let db = null;
function runMigrations(db2) {
  const columns = db2.pragma("table_info(extraction_runs)").map(
    (col) => col.name
  );
  const migrations = {
    current_group_index: "ALTER TABLE extraction_runs ADD COLUMN current_group_index INTEGER DEFAULT 0",
    current_group_id: "ALTER TABLE extraction_runs ADD COLUMN current_group_id TEXT",
    current_batch: "ALTER TABLE extraction_runs ADD COLUMN current_batch INTEGER DEFAULT 0",
    scroll_position: "ALTER TABLE extraction_runs ADD COLUMN scroll_position INTEGER DEFAULT 0",
    last_account_id: "ALTER TABLE extraction_runs ADD COLUMN last_account_id INTEGER"
  };
  for (const [col, sql] of Object.entries(migrations)) {
    if (!columns.includes(col)) {
      db2.exec(sql);
    }
  }
}
function initDB() {
  if (db) return db;
  const dbPath = join(app.getPath("userData"), "marketing.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  createTables(db);
  runMigrations(db);
  return db;
}
function getDB() {
  if (!db) throw new Error("Database not initialized. Call initDB() first.");
  return db;
}
const ENCRYPTION_ALGORITHM = "aes-256-cbc";
const ENCRYPTION_KEY = getEncryptionKey();
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) return Buffer.from(envKey, "hex");
  return Buffer.from("default-dev-key-do-not-use-in-production!", "utf8").subarray(0, 32);
}
function encryptToken(plain) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex")
  };
}
function decryptToken(encrypted, iv) {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    ENCRYPTION_KEY,
    Buffer.from(iv, "hex")
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
function maskToken(token) {
  if (token.length <= 8) return token + "****";
  return token.slice(0, 8) + "****";
}
function addTokens(rawTokens) {
  const db2 = getDB();
  const insert = db2.prepare(
    "INSERT INTO accounts (token_encrypted, token_iv, status) VALUES (?, ?, 'Unchecked')"
  );
  let added = 0;
  let duplicates = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const raw of rawTokens) {
    const token = raw.trim();
    if (!token || seen.has(token)) {
      if (token) duplicates++;
      continue;
    }
    seen.add(token);
    const { encrypted, iv } = encryptToken(token);
    try {
      insert.run(encrypted, iv);
      added++;
    } catch (err) {
      if (err.message?.includes("UNIQUE constraint")) {
        duplicates++;
      } else {
        throw err;
      }
    }
  }
  return { added, duplicates };
}
function getAccounts() {
  const db2 = getDB();
  const rows = db2.prepare(
    `SELECT id, token_encrypted, token_iv, account_name, account_id, status, last_check, created_at
       FROM accounts ORDER BY created_at DESC`
  ).all();
  return rows.map((row) => ({
    id: row.id,
    token_preview: maskToken(decryptToken(row.token_encrypted, row.token_iv)),
    account_name: row.account_name,
    account_id: row.account_id,
    status: row.status,
    last_check: row.last_check,
    created_at: row.created_at
  }));
}
function updateAccountStatus(id, status, name, accountId) {
  const db2 = getDB();
  db2.prepare(
    `UPDATE accounts SET status = ?, account_name = COALESCE(?, account_name), account_id = COALESCE(?, account_id), last_check = datetime('now') WHERE id = ?`
  ).run(status, name ?? null, accountId ?? null, id);
}
function deleteAccounts(ids) {
  const db2 = getDB();
  const placeholders = ids.map(() => "?").join(",");
  const deleteErrors = db2.prepare(
    `DELETE FROM extraction_errors WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteMembers = db2.prepare(
    `DELETE FROM extraction_members WHERE run_id IN (SELECT id FROM extraction_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteRuns = db2.prepare(
    `DELETE FROM extraction_runs WHERE source_account_id IN (${placeholders})`
  );
  const deleteChatErrors = db2.prepare(
    `DELETE FROM chat_creation_errors WHERE run_id IN (SELECT id FROM chat_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteChatGroups = db2.prepare(
    `DELETE FROM chat_groups_created WHERE run_id IN (SELECT id FROM chat_runs WHERE source_account_id IN (${placeholders}))`
  );
  const deleteChatRuns = db2.prepare(
    `DELETE FROM chat_runs WHERE source_account_id IN (${placeholders})`
  );
  const deleteAccounts2 = db2.prepare(
    `DELETE FROM accounts WHERE id IN (${placeholders})`
  );
  const transaction = db2.transaction(() => {
    deleteErrors.run(...ids);
    deleteMembers.run(...ids);
    deleteRuns.run(...ids);
    deleteChatErrors.run(...ids);
    deleteChatGroups.run(...ids);
    deleteChatRuns.run(...ids);
    const result = deleteAccounts2.run(...ids);
    return result.changes;
  });
  return transaction();
}
function getDecryptedToken(id) {
  const db2 = getDB();
  const row = db2.prepare("SELECT token_encrypted, token_iv, account_name FROM accounts WHERE id = ?").get(id);
  if (!row) throw new Error(`Account ${id} not found`);
  return {
    token: decryptToken(row.token_encrypted, row.token_iv),
    name: row.account_name ?? "Unknown"
  };
}
function getAccountsForValidation(ids) {
  const db2 = getDB();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    return db2.prepare(`SELECT id, token_encrypted, token_iv FROM accounts WHERE id IN (${placeholders})`).all(...ids);
  }
  return db2.prepare("SELECT id, token_encrypted, token_iv FROM accounts").all();
}
function getValidAccountIds() {
  const db2 = getDB();
  const rows = db2.prepare("SELECT id FROM accounts WHERE status = 'Valid' ORDER BY id").all();
  return rows.map((r) => r.id);
}
const GRAPH_API = "https://graph.facebook.com/v21.0";
function classifyStatus(error) {
  if (error.error_subcode === 463 || error.error_subcode === 467) return "Expired";
  if (error.code === 190 && (error.message?.toLowerCase().includes("checkpoint") || error.message?.toLowerCase().includes("logged-in"))) {
    return "Blocked";
  }
  if (error.code === 10 || error.code === 100 || error.code === 190) return "Invalid";
  if (error.error_subcode === 368 || error.code === 368 || error.message?.toLowerCase().includes("blocked")) {
    return "Blocked";
  }
  return "Invalid";
}
async function validateToken(token) {
  try {
    const res = await fetch(
      `${GRAPH_API}/me?fields=id,name&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    if (data.error) {
      return { valid: false, status: classifyStatus(data.error) };
    }
    return {
      valid: true,
      status: "Valid",
      name: data.name ?? void 0,
      id: data.id ?? void 0
    };
  } catch {
    return { valid: false, status: "Invalid" };
  }
}
function registerAccountHandlers() {
  ipcMain.handle("account:add", async (_event, tokens) => {
    return addTokens(tokens);
  });
  ipcMain.handle("account:list", async () => {
    return getAccounts();
  });
  ipcMain.handle("account:validate", async (_event, ids) => {
    const accounts = getAccountsForValidation(ids);
    const results = [];
    for (const account of accounts) {
      const token = decryptToken(account.token_encrypted, account.token_iv);
      const result = await validateToken(token);
      updateAccountStatus(account.id, result.status, result.name, result.id);
      results.push({
        id: account.id,
        status: result.status,
        name: result.name,
        accountId: result.id
      });
    }
    return { results };
  });
  ipcMain.handle("account:delete", async (_event, ids) => {
    return { deleted: deleteAccounts(ids) };
  });
  ipcMain.handle("account:export", async () => {
    return { path: "" };
  });
}
async function getSessionCookies(accessToken) {
  const appResponse = await fetch(
    `https://graph.facebook.com/app?access_token=${accessToken}`
  );
  const appData = await appResponse.json();
  if (appData.error || !appData.id) {
    throw new Error(appData.error?.message ?? "Failed to get app ID");
  }
  const sessionResponse = await fetch(
    `https://api.facebook.com/method/auth.getSessionforApp?access_token=${accessToken}&format=json&generate_session_cookies=1&new_app_id=${appData.id}`
  );
  const sessionData = await sessionResponse.json();
  if (sessionData.error_msg || !sessionData.session_cookies) {
    throw new Error(sessionData.error_msg ?? "No session cookies returned");
  }
  return sessionData.session_cookies;
}
async function loginToFacebook(accessToken, parentWindow) {
  try {
    const cookies = await getSessionCookies(accessToken);
    const ses = parentWindow ? parentWindow.webContents.session : session.defaultSession;
    for (const cookie of cookies) {
      await ses.cookies.set({
        url: "https://www.facebook.com",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? ".facebook.com",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? true,
        httpOnly: cookie.httponly ?? false
      });
    }
    const fbWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      parent: parentWindow ?? void 0,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    await fbWindow.loadURL("https://www.facebook.com");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message ?? String(err) };
  }
}
const SCRAPER_PRELOAD_PATH = resolve(__dirname, "../preload/scraper.cjs");
const OFFSCREEN_X = -1e4;
const OFFSCREEN_Y = -1e4;
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
const PAGE_HEIGHT_JS = "(function(){return document.body?document.body.scrollHeight:0;})();";
const WAIT_FOR_NEW_JS = [
  "(function(){",
  "var prevCount=arguments[0];",
  "var start=Date.now();",
  "return new Promise(function(resolve){",
  "function check(){",
  `var cur=document.querySelectorAll('a[href*="\\/user\\/"]').length;`,
  "if(cur>prevCount||Date.now()-start>10000)resolve(cur);",
  "else setTimeout(check,500);",
  "}",
  "check();",
  "});",
  "})("
].join("\n");
const MAX_NO_NEW = 10;
const SCROLLS_PER_BATCH = 3;
const SCROLL_DELAY_MS = 600;
const MIN_DELAY_MS = 2e3;
const MAX_DELAY_MS = 6e3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 5e3;
const PAGE_LOAD_TIMEOUT_MS = 2e4;
const POST_LOAD_SETTLE_MS = 3e3;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_ACCOUNT_FAILURES = 3;
class ScraperWorker {
  index;
  account;
  orchestrator;
  showWindow;
  window = null;
  constructor(opts) {
    this.index = opts.index;
    this.account = opts.account;
    this.orchestrator = opts.orchestrator;
    this.showWindow = opts.showWindow;
  }
  /** Main worker loop: pulls groups until queue empty, account dies, or run aborts. */
  async run() {
    try {
      await this.initWindow();
    } catch (err) {
      this.orchestrator.recordError(
        `(worker-${this.index})`,
        0,
        new Error(
          `Worker ${this.index} (account ${this.account.name}) failed to initialize: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }
    while (!this.orchestrator.isAborted() && this.account.failCount < MAX_ACCOUNT_FAILURES) {
      const job = this.orchestrator.takeNextGroup(this.index);
      if (!job) break;
      try {
        const result = await this.scrapeGroup(job);
        if (result.completed) {
          this.orchestrator.markGroupCompleted(this.index, job, result.extractedInGroup);
        } else if (result.requeue) {
          this.orchestrator.requeueGroup(this.index, job);
        } else {
          this.orchestrator.markGroupFailed(this.index, job);
        }
      } catch (err) {
        this.orchestrator.recordError(job.groupId, 0, err);
        this.orchestrator.requeueGroup(this.index, job);
      }
    }
    this.destroyWindow();
  }
  async initWindow() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
      this.window = null;
    }
    const partition = `persist:scraper-${this.account.id}`;
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    let cookies = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        cookies = await getSessionCookies(this.account.token);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3 && !this.orchestrator.isAborted()) {
          await this.delay(5e3 * attempt);
        }
      }
    }
    if (lastErr || !cookies) throw lastErr ?? new Error("Failed to obtain session cookies");
    for (const cookie of cookies) {
      await ses.cookies.set({
        url: "https://www.facebook.com",
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? ".facebook.com",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? true,
        httpOnly: cookie.httponly ?? false
      });
    }
    this.window = new BrowserWindow({
      width: 1280,
      height: 900,
      // Always start hidden to avoid a frame of the window being visible
      // before we move it offscreen. We'll explicitly show() below.
      show: false,
      // Don't clutter the dock/taskbar with one entry per worker when running
      // headless. Visible debug windows still show normally.
      skipTaskbar: !this.showWindow,
      title: `Scraper #${this.index + 1} — ${this.account.name}`,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        // contextIsolation must be FALSE so the scraper preload (which
        // overrides document.visibilityState) actually patches the same
        // world that Facebook's scripts read from. The window only ever
        // loads facebook.com and exposes no IPC bridge or Node APIs, so
        // this is acceptable here even though contextIsolation: true is
        // the default for the rest of the app.
        contextIsolation: false,
        preload: SCRAPER_PRELOAD_PATH,
        // Defense-in-depth against Chromium throttling hidden pages
        // (setTimeout clamping, rAF pausing, etc).
        backgroundThrottling: false
      }
    });
    this.window.webContents.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    this.window.webContents.setBackgroundThrottling(false);
    if (this.showWindow) {
      this.window.show();
    } else {
      this.window.setPosition(OFFSCREEN_X, OFFSCREEN_Y);
      this.window.showInactive();
    }
    this.window.on("close", (e) => {
      if (this.orchestrator.isRunning() && !this.orchestrator.isAborted()) {
        e.preventDefault();
      }
    });
  }
  destroyWindow() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
  /**
   * Scrape a single group. Returns:
   *  - completed: group reached end-of-list (or aborted gracefully)
   *  - requeue:   transient failure, group should go back in the queue
   */
  async scrapeGroup(job) {
    const groupUrl = "https://www.facebook.com/groups/" + encodeURIComponent(job.groupId) + "/members";
    let loaded = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.orchestrator.isAborted()) {
        return { completed: false, requeue: true, extractedInGroup: 0 };
      }
      try {
        if (!this.window || this.window.isDestroyed()) {
          await this.initWindow();
        }
        await this.loadPage(this.window, groupUrl);
        await this.delay(POST_LOAD_SETTLE_MS);
        loaded = true;
        break;
      } catch (err) {
        if (attempt >= MAX_RETRIES) {
          this.orchestrator.recordError(job.groupId, 0, err);
          return { completed: false, requeue: true, extractedInGroup: 0 };
        }
        this.orchestrator.recordError(
          job.groupId,
          0,
          new Error(`Page load failed (worker ${this.index}, retry ${attempt}/${MAX_RETRIES})`)
        );
        await this.delay(RETRY_BASE_MS * attempt);
      }
    }
    if (!loaded) {
      return { completed: false, requeue: true, extractedInGroup: 0 };
    }
    let currentBatch = 0;
    let noNewCount = 0;
    let consecutiveErrors = 0;
    let prevVisibleCount = 0;
    let lastPageHeight = 0;
    let stagnantHeightCount = 0;
    let extractedInGroup = 0;
    while (!this.orchestrator.isAborted()) {
      currentBatch++;
      try {
        const win = this.window;
        if (!win || win.isDestroyed()) {
          await this.initWindow();
          await this.loadPage(this.window, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
          prevVisibleCount = 0;
          lastPageHeight = 0;
          stagnantHeightCount = 0;
          continue;
        }
        for (let s = 0; s < SCROLLS_PER_BATCH; s++) {
          await win.webContents.executeJavaScript(SCROLL_JS);
          await this.delay(SCROLL_DELAY_MS);
        }
        await win.webContents.executeJavaScript(
          "window.scrollTo(0, document.body.scrollHeight);"
        );
        try {
          const newVisibleCount = await win.webContents.executeJavaScript(
            WAIT_FOR_NEW_JS + String(prevVisibleCount) + ");"
          );
          prevVisibleCount = newVisibleCount;
        } catch {
          await this.delay(2e3);
        }
        const blockInfo = await win.webContents.executeJavaScript(CHECK_BLOCK_JS);
        if (blockInfo.isLogin || blockInfo.isBlock || blockInfo.isCaptcha) {
          this.account.failCount++;
          const reason = blockInfo.isCaptcha ? "Captcha detected" : blockInfo.isBlock ? "Account blocked/restricted" : "Session expired (login page)";
          this.orchestrator.recordError(
            job.groupId,
            currentBatch,
            new Error(
              `${reason} — worker ${this.index} account ${this.account.name} (failCount=${this.account.failCount}/${MAX_ACCOUNT_FAILURES})`
            )
          );
          if (this.account.failCount >= MAX_ACCOUNT_FAILURES) {
            return { completed: false, requeue: true, extractedInGroup };
          }
          await this.initWindow();
          await this.loadPage(this.window, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
          prevVisibleCount = 0;
          lastPageHeight = 0;
          stagnantHeightCount = 0;
          continue;
        }
        const ids = await win.webContents.executeJavaScript(SCRAPE_IDS_JS);
        const newIds = this.orchestrator.addMembers(ids);
        if (newIds.length > 0) {
          noNewCount = 0;
          consecutiveErrors = 0;
          extractedInGroup += newIds.length;
          await this.orchestrator.persistMembers(job.groupId, this.account.name, newIds);
        } else {
          noNewCount++;
        }
        let currentHeight = lastPageHeight;
        try {
          currentHeight = await win.webContents.executeJavaScript(PAGE_HEIGHT_JS) ?? 0;
        } catch {
        }
        if (currentHeight <= lastPageHeight) {
          stagnantHeightCount++;
        } else {
          stagnantHeightCount = 0;
          lastPageHeight = currentHeight;
        }
        this.orchestrator.emitProgress({
          current_group_id: job.groupId,
          current_group_index: job.groupIndex,
          total_groups: this.orchestrator.getTotalGroups(),
          members_extracted: this.orchestrator.getTotalExtracted(),
          current_batch: currentBatch,
          status: "running"
        });
        this.orchestrator.persistRunState();
        if (noNewCount >= MAX_NO_NEW && stagnantHeightCount >= 3) {
          break;
        }
        await this.randomDelay();
      } catch (error) {
        consecutiveErrors++;
        this.orchestrator.recordError(job.groupId, currentBatch, error);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.orchestrator.recordError(
            job.groupId,
            currentBatch,
            new Error(
              `Too many consecutive errors (${consecutiveErrors}) on worker ${this.index}. Requeuing group.`
            )
          );
          return { completed: false, requeue: true, extractedInGroup };
        }
        await this.delay(RETRY_BASE_MS * Math.min(consecutiveErrors, 3));
        try {
          if (!this.window || this.window.isDestroyed()) {
            await this.initWindow();
          }
          await this.loadPage(this.window, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
        } catch (recoveryErr) {
          this.orchestrator.recordError(
            job.groupId,
            currentBatch,
            new Error(
              `Window recovery failed: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`
            )
          );
          return { completed: false, requeue: true, extractedInGroup };
        }
        prevVisibleCount = 0;
        lastPageHeight = 0;
        stagnantHeightCount = 0;
      }
    }
    return {
      completed: !this.orchestrator.isAborted(),
      requeue: this.orchestrator.isAborted(),
      extractedInGroup
    };
  }
  async loadPage(scraper, url) {
    try {
      await scraper.loadURL(url);
    } catch {
      await new Promise((resolve2, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Page load timed out")),
          PAGE_LOAD_TIMEOUT_MS
        );
        scraper.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve2();
        });
        scraper.webContents.once("did-fail-load", (_e, _code, desc) => {
          clearTimeout(timer);
          reject(new Error("Page failed to load: " + (desc ?? "unknown")));
        });
        scraper.loadURL(url).catch(() => {
        });
      });
    }
  }
  randomDelay() {
    const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
    return this.delay(ms);
  }
  delay(ms) {
    return new Promise((resolve2) => {
      if (this.orchestrator.isAborted()) return resolve2();
      setTimeout(resolve2, ms);
    });
  }
}
const CSV_ID_FIELDS = ["member_id", "group_id", "extracted_at", "source_account"];
const PROGRESS_THROTTLE_MS = 250;
const DEFAULT_CONCURRENCY_CAP = 5;
let globalScraper = null;
function getActiveScraper() {
  return globalScraper;
}
class GroupScraper {
  mainWin;
  abortFlag = false;
  running = false;
  runId = null;
  outputPath = "";
  groupIds = [];
  seenMemberIds = /* @__PURE__ */ new Set();
  totalExtracted = 0;
  maxBatch = 0;
  accounts = [];
  workers = [];
  pendingQueue = [];
  inProgressByWorker = /* @__PURE__ */ new Map();
  completedGroups = /* @__PURE__ */ new Set();
  failedGroups = /* @__PURE__ */ new Set();
  // Async CSV write chain — every append is enqueued so writes from multiple
  // workers can never interleave on disk, while still being non-blocking
  // (no more appendFileSync stalling the event loop).
  csvWriteChain = Promise.resolve();
  csvStringifier = createObjectCsvStringifier({
    header: CSV_ID_FIELDS.map((f) => ({ id: f, title: f }))
  });
  // Throttled progress emitter — collapses high-frequency progress events
  // from many workers into at most one IPC message per PROGRESS_THROTTLE_MS.
  pendingProgress = null;
  lastProgressEmit = 0;
  progressTimer = null;
  constructor(win) {
    this.mainWin = win;
  }
  // ---------- Public API ----------
  async start(groupIds, accountId, resumeRunId, options) {
    if (this.running) {
      throw new Error("A scraper run is already in progress");
    }
    this.abortFlag = false;
    this.maxBatch = 0;
    const showWindow = options?.showWindow ?? false;
    const db2 = getDB();
    const allValidIds = getValidAccountIds();
    const validSet = new Set(allValidIds);
    const orderedIds = [];
    if (accountId > 0 && validSet.has(accountId)) {
      orderedIds.push(accountId);
    }
    for (const id of allValidIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    if (orderedIds.length === 0) {
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
    const requested = Math.max(1, options?.concurrency ?? this.accounts.length);
    const concurrency = Math.min(
      requested,
      this.accounts.length,
      this.pendingQueue.length || 1,
      DEFAULT_CONCURRENCY_CAP
    );
    this.emitProgress({
      current_group_id: this.groupIds[0] ?? "",
      current_group_index: 0,
      total_groups: this.groupIds.length,
      members_extracted: this.totalExtracted,
      current_batch: 0,
      status: "running"
    });
    this.flushProgressNow();
    this.workers = [];
    const workerPromises = [];
    for (let i = 0; i < concurrency; i++) {
      const worker = new ScraperWorker({
        index: i,
        account: this.accounts[i],
        orchestrator: this,
        showWindow
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
      await this.csvWriteChain;
    } finally {
      this.running = false;
      globalScraper = null;
    }
    const finalStatus = this.abortFlag ? "stopped" : this.pendingQueue.length === 0 && this.inProgressByWorker.size === 0 ? "completed" : "stopped";
    if (this.runId) {
      db2.prepare(
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
      status: finalStatus
    });
    this.flushProgressNow();
    return this.outputPath;
  }
  stop() {
    this.abortFlag = true;
    this.persistRunState();
  }
  forceSave() {
    this.persistRunState();
  }
  getRunId() {
    return this.runId;
  }
  isRunning() {
    return this.running;
  }
  isAborted() {
    return this.abortFlag;
  }
  getTotalExtracted() {
    return this.totalExtracted;
  }
  getTotalGroups() {
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
  takeNextGroup(workerIndex) {
    if (this.abortFlag) return null;
    const job = this.pendingQueue.shift();
    if (!job) return null;
    this.inProgressByWorker.set(workerIndex, job);
    this.updateGroupStatus(job.groupId, "in_progress", workerIndex);
    return job;
  }
  markGroupCompleted(workerIndex, job, extractedInGroup) {
    this.inProgressByWorker.delete(workerIndex);
    this.completedGroups.add(job.groupId);
    this.updateGroupStatus(job.groupId, "completed", workerIndex, extractedInGroup);
  }
  markGroupFailed(workerIndex, job) {
    this.inProgressByWorker.delete(workerIndex);
    this.failedGroups.add(job.groupId);
    this.updateGroupStatus(job.groupId, "failed", workerIndex);
  }
  /**
   * Worker exhausted its account or hit a transient failure — push the group
   * back onto the queue so another worker can pick it up.
   */
  requeueGroup(workerIndex, job) {
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
  addMembers(ids) {
    const newIds = [];
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
  async persistMembers(groupId, sourceAccount, ids) {
    if (!this.runId || ids.length === 0) return;
    const db2 = getDB();
    const insertMember = db2.prepare(
      "INSERT OR IGNORE INTO extraction_members (run_id, member_id, group_id, group_name, extracted_at, source_account) VALUES (?, ?, ?, '', ?, ?)"
    );
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const insertBatch = db2.transaction((rows2) => {
      for (const id of rows2) {
        insertMember.run(this.runId, id, groupId, now, sourceAccount);
      }
    });
    insertBatch(ids);
    const rows = ids.map((id) => ({
      member_id: id,
      group_id: groupId,
      extracted_at: now,
      source_account: sourceAccount
    }));
    this.totalExtracted += ids.length;
    await this.appendCsv(rows);
  }
  emitProgress(progress) {
    if (progress.current_batch > this.maxBatch) {
      this.maxBatch = progress.current_batch;
    }
    this.pendingProgress = progress;
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
  recordError(groupId, batchNumber, error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const payload = {
      group_id: groupId,
      batch_number: batchNumber,
      error_message: errorMessage,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (this.runId) {
      try {
        getDB().prepare(
          "INSERT INTO extraction_errors (run_id, group_id, batch_number, error_message, timestamp) VALUES (?, ?, ?, ?, ?)"
        ).run(
          this.runId,
          payload.group_id,
          payload.batch_number,
          payload.error_message,
          payload.timestamp
        );
      } catch {
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
  persistRunState() {
    if (!this.runId) return;
    try {
      getDB().prepare(
        "UPDATE extraction_runs SET status = 'stopped', current_group_index = ?, current_group_id = ?, current_batch = ?, members_extracted = ? WHERE id = ?"
      ).run(
        this.completedGroups.size,
        this.inProgressByWorker.size > 0 ? Array.from(this.inProgressByWorker.values())[0]?.groupId ?? "" : "",
        this.maxBatch,
        this.totalExtracted,
        this.runId
      );
    } catch {
    }
  }
  // ---------- Private helpers ----------
  async initFreshRun(groupIds, accountId) {
    const { filePath } = await dialog.showSaveDialog(this.mainWin, {
      defaultPath: join(app.getPath("documents"), "extraction-" + Date.now() + ".csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }]
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
    const db2 = getDB();
    const result = db2.prepare(
      "INSERT INTO extraction_runs (group_ids, source_account_id, output_path) VALUES (?, ?, ?)"
    ).run(JSON.stringify(groupIds), accountId, filePath);
    this.runId = result.lastInsertRowid;
    const insertGroup = db2.prepare(
      "INSERT OR IGNORE INTO extraction_run_groups (run_id, group_id, status) VALUES (?, ?, 'pending')"
    );
    const tx = db2.transaction((ids) => {
      for (const id of ids) insertGroup.run(this.runId, id);
    });
    tx(groupIds);
    this.initializeCsv(filePath);
  }
  loadResumeState(resumeRunId) {
    const db2 = getDB();
    const run = db2.prepare(
      "SELECT output_path, group_ids, members_extracted, current_group_index FROM extraction_runs WHERE id = ?"
    ).get(resumeRunId);
    if (!run) throw new Error("Run " + resumeRunId + " not found");
    this.runId = resumeRunId;
    this.outputPath = run.output_path;
    this.groupIds = JSON.parse(run.group_ids);
    this.totalExtracted = run.members_extracted ?? 0;
    const existing = db2.prepare("SELECT member_id FROM extraction_members WHERE run_id = ?").all(resumeRunId);
    this.seenMemberIds = new Set(existing.map((r) => r.member_id));
    const existingGroups = db2.prepare("SELECT group_id, status FROM extraction_run_groups WHERE run_id = ?").all(resumeRunId);
    if (existingGroups.length === 0) {
      const legacyIndex = run.current_group_index ?? 0;
      const insertGroup = db2.prepare(
        "INSERT INTO extraction_run_groups (run_id, group_id, status) VALUES (?, ?, ?)"
      );
      const tx = db2.transaction(() => {
        for (let i = 0; i < this.groupIds.length; i++) {
          insertGroup.run(this.runId, this.groupIds[i], i < legacyIndex ? "completed" : "pending");
        }
      });
      tx();
    } else {
      db2.prepare(
        "UPDATE extraction_run_groups SET status = 'pending', worker_index = NULL WHERE run_id = ? AND status = 'in_progress'"
      ).run(resumeRunId);
    }
    const completedRows = db2.prepare(
      "SELECT group_id FROM extraction_run_groups WHERE run_id = ? AND status = 'completed'"
    ).all(resumeRunId);
    this.completedGroups = new Set(completedRows.map((r) => r.group_id));
    this.failedGroups.clear();
    this.rebuildCsvFromDb();
  }
  buildPendingQueue() {
    const db2 = getDB();
    if (!this.runId) return [];
    const pendingRows = db2.prepare(
      "SELECT group_id FROM extraction_run_groups WHERE run_id = ? AND status = 'pending'"
    ).all(this.runId);
    const indexById = new Map(this.groupIds.map((id, idx) => [id, idx]));
    return pendingRows.map((row) => ({
      groupId: row.group_id,
      groupIndex: indexById.get(row.group_id) ?? 0
    }));
  }
  updateGroupStatus(groupId, status, workerIndex, membersCount) {
    if (!this.runId) return;
    try {
      const db2 = getDB();
      if (typeof membersCount === "number") {
        db2.prepare(
          "UPDATE extraction_run_groups SET status = ?, worker_index = ?, members_count = ?, updated_at = datetime('now') WHERE run_id = ? AND group_id = ?"
        ).run(status, workerIndex, membersCount, this.runId, groupId);
      } else {
        db2.prepare(
          "UPDATE extraction_run_groups SET status = ?, worker_index = ?, updated_at = datetime('now') WHERE run_id = ? AND group_id = ?"
        ).run(status, workerIndex, this.runId, groupId);
      }
    } catch {
    }
  }
  initializeCsv(outputPath) {
    writeFileSync(outputPath, this.csvStringifier.getHeaderString() ?? "", "utf8");
  }
  rebuildCsvFromDb() {
    if (!this.runId) return;
    this.initializeCsv(this.outputPath);
    const db2 = getDB();
    const rows = db2.prepare(
      "SELECT member_id, group_id, extracted_at, source_account FROM extraction_members WHERE run_id = ? ORDER BY id"
    ).all(this.runId);
    if (rows.length > 0) {
      const fs = require2("fs");
      fs.appendFileSync(this.outputPath, this.csvStringifier.stringifyRecords(rows), "utf8");
    }
  }
  appendCsv(rows) {
    if (rows.length === 0) return Promise.resolve();
    const payload = this.csvStringifier.stringifyRecords(rows);
    this.csvWriteChain = this.csvWriteChain.then(
      () => appendFile(this.outputPath, payload, "utf8").catch((err) => {
        this.recordError("(csv)", 0, err);
      })
    );
    return this.csvWriteChain;
  }
  flushProgressNow() {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.pendingProgress && this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send("extraction:progress", this.pendingProgress);
      this.lastProgressEmit = Date.now();
      this.pendingProgress = null;
    }
  }
}
let activeScraper = null;
function registerExtractionHandlers() {
  ipcMain.handle(
    "extraction:start",
    async (_event, groupIds, accountId, options = {}) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");
      const scraperOpts = {
        concurrency: options.concurrency,
        showWindow: options.showWindow
      };
      const resumeRunId = options.resumeRunId ?? null;
      const scraper = new GroupScraper(win);
      activeScraper = scraper;
      try {
        const outputPath = await scraper.start(groupIds, accountId, resumeRunId, scraperOpts);
        return { outputPath, method: "scraper", runId: scraper.getRunId() };
      } finally {
        activeScraper = null;
      }
    }
  );
  ipcMain.handle("extraction:stop", async () => {
    if (activeScraper) {
      activeScraper.stop();
    }
    return { stopped: true };
  });
  ipcMain.handle(
    "extraction:resume-run",
    async (_event, runId, options) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("No window available");
      const scraper = new GroupScraper(win);
      activeScraper = scraper;
      try {
        const outputPath = await scraper.start([], 0, runId, options ?? {});
        return { outputPath, method: "scraper", runId: scraper.getRunId() };
      } finally {
        activeScraper = null;
      }
    }
  );
  ipcMain.handle("extraction:stopped-runs", async () => {
    const { getDB: getDB2 } = require2("../db/connection");
    const db2 = getDB2();
    return db2.prepare(
      "SELECT id, group_ids, members_extracted, current_group_index, current_batch, started_at, output_path FROM extraction_runs WHERE status = 'stopped' ORDER BY started_at DESC LIMIT 20"
    ).all();
  });
}
function saveActiveExtraction() {
  const scraper = getActiveScraper();
  if (scraper && scraper.isRunning()) {
    scraper.forceSave();
  }
  if (activeScraper) {
    activeScraper.stop();
  }
}
function registerFacebookHandlers() {
  ipcMain.handle("facebook:login", async (_event, accountId) => {
    const { token } = getDecryptedToken(accountId);
    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return loginToFacebook(token, parentWindow);
  });
}
const requireCJS = createRequire(import.meta.url);
function toAppState(cookies) {
  return cookies.map((c) => ({
    key: c.name,
    value: c.value,
    domain: c.domain ?? ".facebook.com",
    path: c.path ?? "/",
    hostOnly: false,
    creation: (/* @__PURE__ */ new Date()).toISOString(),
    lastAccessed: (/* @__PURE__ */ new Date()).toISOString(),
    secure: c.secure ?? true,
    httpOnly: c.httponly ?? false
  }));
}
async function loginWithAccessToken(accessToken, options = {}) {
  const cookies = await getSessionCookies(accessToken);
  const appState = toAppState(cookies);
  const fca = requireCJS("biar-fca");
  const timeoutMs = options.timeoutMs ?? 6e4;
  const api = await new Promise((resolve2, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`biar-fca login timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      fca.login(
        { appState },
        {
          online: true,
          updatePresence: true,
          selfListen: false,
          autoMarkDelivery: false,
          autoMarkRead: false,
          listenEvents: false,
          autoReconnect: true
        },
        (err, apiInstance) => {
          clearTimeout(timer);
          if (err) {
            const message = typeof err === "string" ? err : err?.error ?? err?.message ?? JSON.stringify(err);
            reject(new Error(`biar-fca login failed: ${message}`));
            return;
          }
          if (!apiInstance) {
            reject(new Error("biar-fca login produced no API instance"));
            return;
          }
          resolve2(apiInstance);
        }
      );
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  if (typeof api.listenMqtt === "function") {
    try {
      api.listenMqtt(() => {
      });
    } catch {
    }
  }
  await waitForMqtt(api, 15e3);
  const userId = api.getCurrentUserID();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await new Promise((resolve2) => {
        try {
          api.logout(() => resolve2());
        } catch {
          resolve2();
        }
        setTimeout(() => resolve2(), 5e3);
      });
    } catch {
    }
  };
  return { api, userId, close };
}
async function waitForMqtt(api, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (api.ctx?.mqttClient) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}
function classifyFcaError(message) {
  const m = message.toLowerCase();
  if (m.includes("checkpoint") || m.includes("login_approvals") || m.includes("1357031")) {
    return { reason: "blocked" };
  }
  if (m.includes("spam") || m.includes("too many") || m.includes("rate")) {
    return { reason: "rate_limit" };
  }
  if (m.includes("1545041") || // person currently unavailable
  m.includes("2853003") || // invalid recipient
  m.includes("invalid recipient") || m.includes("currently unavailable") || m.includes("not in this group") || m.includes("user with id")) {
    return { reason: "invalid_user" };
  }
  if (m.includes("already in the group")) {
    return { reason: "already_member" };
  }
  if (m.includes("1545012") || m.includes("not part of the conversation")) {
    return { reason: "permission" };
  }
  if (m.includes("transient") || m.includes("temporary")) {
    return { reason: "transient" };
  }
  return { reason: "unknown" };
}
function createRun(input) {
  const db2 = getDB();
  const result = db2.prepare(
    `INSERT INTO chat_runs
         (source_account_id, settings_json, member_ids_json,
          total_uploaded_ids, total_valid_ids, total_invalid_ids,
          total_groups, output_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`
  ).run(
    input.sourceAccountId,
    JSON.stringify(input.settings),
    JSON.stringify(input.memberIds),
    input.totalUploaded,
    input.totalValid,
    input.totalInvalid,
    input.totalGroups,
    input.outputPath
  );
  return result.lastInsertRowid;
}
function insertPlannedGroups(runId, plan) {
  const db2 = getDB();
  const insert = db2.prepare(
    `INSERT INTO chat_groups_created
       (run_id, group_index, group_name, member_ids_json, member_count, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  );
  const tx = db2.transaction(() => {
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
function setRunStatus(runId, status) {
  const db2 = getDB();
  const completedAt = status === "completed" || status === "failed" || status === "stopped" ? "datetime('now')" : "completed_at";
  db2.prepare(
    `UPDATE chat_runs SET status = ?, completed_at = ${completedAt} WHERE id = ?`
  ).run(status, runId);
}
function updateRunCounts(runId, counts) {
  const db2 = getDB();
  const updates = [];
  const values = [];
  if (counts.groups_completed !== void 0) {
    updates.push("groups_completed = ?");
    values.push(counts.groups_completed);
  }
  if (counts.members_added !== void 0) {
    updates.push("members_added = ?");
    values.push(counts.members_added);
  }
  if (counts.members_failed !== void 0) {
    updates.push("members_failed = ?");
    values.push(counts.members_failed);
  }
  if (updates.length === 0) return;
  values.push(runId);
  db2.prepare(
    `UPDATE chat_runs SET ${updates.join(", ")} WHERE id = ?`
  ).run(...values);
}
function setGroupStatus(runId, groupIndex, status, patch = {}) {
  const db2 = getDB();
  const updates = ["status = ?"];
  const values = [status];
  if (status === "creating" || status === "filling") {
    updates.push("started_at = COALESCE(started_at, datetime('now'))");
  }
  if (status === "completed" || status === "failed") {
    updates.push("completed_at = datetime('now')");
  }
  if (patch.thread_id !== void 0) {
    updates.push("thread_id = ?");
    values.push(patch.thread_id);
  }
  if (patch.member_count !== void 0) {
    updates.push("member_count = ?");
    values.push(patch.member_count);
  }
  values.push(runId, groupIndex);
  db2.prepare(
    `UPDATE chat_groups_created SET ${updates.join(", ")} WHERE run_id = ? AND group_index = ?`
  ).run(...values);
}
function recordError(runId, errorMessage, groupIndex, attempt, memberIds) {
  const db2 = getDB();
  db2.prepare(
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
function listRuns(limit = 25) {
  const db2 = getDB();
  const rows = db2.prepare(
    `SELECT r.id, r.source_account_id, r.settings_json,
              r.total_uploaded_ids AS total_members, r.total_groups,
              r.groups_completed, r.members_added, r.members_failed,
              r.status, r.started_at, r.completed_at, r.output_path,
              a.account_name
       FROM chat_runs r
       LEFT JOIN accounts a ON a.id = r.source_account_id
       ORDER BY r.started_at DESC
       LIMIT ?`
  ).all(limit);
  return rows.map((row) => ({
    id: row.id,
    source_account_id: row.source_account_id,
    source_account_name: row.account_name ?? null,
    settings: safeParse(row.settings_json),
    status: row.status,
    total_members: row.total_members,
    total_groups: row.total_groups,
    groups_completed: row.groups_completed,
    members_added: row.members_added,
    members_failed: row.members_failed,
    started_at: row.started_at,
    completed_at: row.completed_at,
    output_path: row.output_path
  }));
}
function getRun(runId) {
  const db2 = getDB();
  const runRow = db2.prepare(
    `SELECT r.*, a.account_name
       FROM chat_runs r
       LEFT JOIN accounts a ON a.id = r.source_account_id
       WHERE r.id = ?`
  ).get(runId);
  if (!runRow) return null;
  const groups = db2.prepare(
    `SELECT id, run_id, group_index, thread_id, group_name,
              member_count, status, started_at, completed_at, member_ids_json
       FROM chat_groups_created
       WHERE run_id = ?
       ORDER BY group_index ASC`
  ).all(runId);
  const memberIds = safeParse(runRow.member_ids_json) ?? [];
  return {
    memberIds,
    run: {
      id: runRow.id,
      source_account_id: runRow.source_account_id,
      source_account_name: runRow.account_name ?? null,
      settings: safeParse(runRow.settings_json),
      status: runRow.status,
      total_members: runRow.total_uploaded_ids,
      total_groups: runRow.total_groups,
      groups_completed: runRow.groups_completed,
      members_added: runRow.members_added,
      members_failed: runRow.members_failed,
      started_at: runRow.started_at,
      completed_at: runRow.completed_at,
      output_path: runRow.output_path
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
      completed_at: g.completed_at ?? null
    }))
  };
}
function getGroupMemberIds(runId, groupIndex) {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT member_ids_json FROM chat_groups_created
       WHERE run_id = ? AND group_index = ?`
  ).get(runId, groupIndex);
  if (!row) return [];
  return safeParse(row.member_ids_json) ?? [];
}
function listErrors(runId, limit = 500) {
  const db2 = getDB();
  return db2.prepare(
    `SELECT group_index, attempt, error_message, timestamp
       FROM chat_creation_errors
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT ?`
  ).all(runId, limit);
}
function safeParse(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
const MAX_GROUP_SIZE = 250;
const SEED_SIZES = [8, 5, 3, 2];
const MAX_SEED_ATTEMPTS = 6;
const SEED_RETRY_DELAY_MS = 2e3;
const PROGRESS_EMIT_THROTTLE_MS = 250;
class GroupCreator {
  win;
  runId = null;
  settings = null;
  session = null;
  outputPath = "";
  sourceAccountName = "";
  // Counters maintained alongside DB updates so we can throttle the
  // DB writes without losing state.
  groupsCompleted = 0;
  membersAdded = 0;
  membersFailed = 0;
  currentBatch = 0;
  currentGroupIndex = 0;
  currentGroupName = null;
  currentThreadId = null;
  remainingIds = 0;
  // Control flags. abortFlag exits the run; pauseFlag pauses between
  // groups/batches.
  abortFlag = false;
  pauseFlag = false;
  failed = false;
  lastProgressEmit = 0;
  latestMessage = "";
  constructor(win) {
    this.win = win;
  }
  getRunId() {
    return this.runId;
  }
  isRunning() {
    return this.runId !== null && !this.abortFlag && !this.failed;
  }
  pause() {
    if (!this.runId) return;
    this.pauseFlag = true;
    this.log("info", "Pause requested. Will pause after current batch.");
  }
  stop() {
    if (!this.runId) return;
    this.abortFlag = true;
    this.log("info", "Stop requested. Will stop after current batch.");
  }
  /**
   * Plan, persist, and start a brand new run. Returns a handle whose
   * `done` promise resolves once the run terminates.
   */
  async start(params) {
    this.resetCounters();
    this.settings = params.settings;
    this.outputPath = params.outputPath;
    const { token, name } = getDecryptedToken(params.accountId);
    this.sourceAccountName = name;
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
    const plan = planGroups(params.memberIds, params.settings.group_name_prefix);
    const runId = createRun({
      sourceAccountId: params.accountId,
      settings: params.settings,
      memberIds: params.memberIds,
      totalUploaded: params.totalUploaded,
      totalValid: params.memberIds.length,
      totalInvalid: params.totalInvalid,
      totalGroups: plan.length,
      outputPath: params.outputPath
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
  async resume(params) {
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
  async runLoop() {
    if (!this.runId || !this.settings) return;
    const runId = this.runId;
    try {
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
        const addedAtStart = this.membersAdded;
        const failedAtStart = this.membersFailed;
        this.emitProgress({ force: true });
        try {
          const created = await this.processGroup({
            groupIndex: group.group_index,
            groupName: group.group_name,
            existingThreadId: group.thread_id,
            plannedMembers,
            settings: this.settings
          });
          if (!created) break;
          const isLast = group.group_index === groups.length - 1;
          if (!isLast && !this.abortFlag && !this.pauseFlag) {
            await this.sleepWithCheck(this.settings.post_group_delay_s * 1e3);
            const interGroupMs = randomInRange(
              this.settings.group_delay_min_s,
              this.settings.group_delay_max_s
            ) * 1e3;
            this.log(
              "info",
              `Waiting ${(interGroupMs / 1e3).toFixed(1)}s before next group...`
            );
            await this.sleepWithCheck(interGroupMs);
          }
        } catch (err) {
          const msg = err?.message ?? String(err);
          this.log("error", `Group ${group.group_index + 1} failed: ${msg}`);
          recordError(runId, msg, group.group_index, 1, plannedMembers);
          setGroupStatus(runId, group.group_index, "failed");
          const addedDelta = this.membersAdded - addedAtStart;
          const failedDelta = this.membersFailed - failedAtStart;
          const accounted = addedDelta + failedDelta;
          const unaccounted = Math.max(0, plannedMembers.length - accounted);
          if (unaccounted > 0) {
            this.membersFailed += unaccounted;
            this.remainingIds = Math.max(0, this.remainingIds - unaccounted);
            updateRunCounts(runId, {
              members_added: this.membersAdded,
              members_failed: this.membersFailed
            });
          }
          this.emitProgress({ force: true });
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
        await this.session.close().catch(() => void 0);
        this.session = null;
      }
    }
  }
  // ===================================================================
  // Per-group: create thread, set name, add remaining members
  // ===================================================================
  async processGroup(params) {
    const { groupIndex, groupName, plannedMembers, settings } = params;
    const runId = this.runId;
    const session2 = this.session;
    if (!runId || !session2) return false;
    let threadId = params.existingThreadId;
    const alreadyInGroup = /* @__PURE__ */ new Set();
    let toAdd = [];
    if (!threadId) {
      setGroupStatus(runId, groupIndex, "creating");
      this.currentBatch = 0;
      const greeting = settings.greeting_message?.trim() || `Welcome to ${groupName}`;
      let creation;
      try {
        creation = await this.createGroupAdaptive({
          plannedMembers,
          greeting,
          groupIndex,
          groupName
        });
      } catch (err) {
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
      this.membersAdded += creation.seedAdded.length;
      this.remainingIds = Math.max(
        0,
        this.remainingIds - creation.seedAdded.length
      );
      updateRunCounts(runId, {
        members_added: this.membersAdded,
        members_failed: this.membersFailed
      });
      setGroupStatus(runId, groupIndex, "filling", { thread_id: threadId });
      this.appendGroupRow({
        groupIndex,
        groupName,
        threadId,
        memberIds: creation.seedAdded,
        status: "created"
      });
      if (creation.peeled.length > 0) {
        this.appendGroupRow({
          groupIndex,
          groupName,
          threadId,
          memberIds: creation.peeled,
          status: "rejected"
        });
      }
      try {
        await session2.api.gcname(groupName, threadId);
      } catch (nameErr) {
        this.log(
          "warn",
          `gcname failed for group ${groupIndex + 1}: ${nameErr.message ?? nameErr}`
        );
      }
      toAdd = [...creation.peeled, ...creation.remainingMembers];
      this.emitProgress();
      const interBatchMs = randomInRange(settings.batch_delay_min_s, settings.batch_delay_max_s) * 1e3;
      await this.sleepWithCheck(interBatchMs);
      if (this.abortFlag || this.pauseFlag) return false;
    } else {
      this.log("info", `Resuming group ${groupIndex + 1} (thread ${threadId})`);
      toAdd = [...plannedMembers];
    }
    const remaining = toAdd;
    let batchNumber = 1;
    for (let i = 0; i < remaining.length; i += settings.batch_size) {
      if (this.abortFlag || this.pauseFlag) return false;
      const chunk = remaining.slice(i, i + settings.batch_size).filter((id) => !alreadyInGroup.has(id));
      if (chunk.length === 0) continue;
      this.currentBatch = batchNumber;
      this.log(
        "info",
        `Group ${groupIndex + 1} batch #${batchNumber}: adding ${chunk.length} member(s)...`
      );
      try {
        const res = await session2.api.gcmember("add", chunk, threadId);
        if (res?.type === "error_gc") {
          const errMsg = res.error ?? "Unknown gcmember error";
          recordError(runId, errMsg, groupIndex, batchNumber, chunk);
          this.log("warn", `gcmember soft failure: ${errMsg}`);
          this.membersFailed += chunk.length;
          this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
        } else {
          const acceptedIds = res?.userIDs ?? chunk;
          for (const id of acceptedIds) alreadyInGroup.add(id);
          this.membersAdded += acceptedIds.length;
          this.membersFailed += chunk.length - acceptedIds.length;
          this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
          this.appendGroupRow({
            groupIndex,
            groupName,
            threadId,
            memberIds: acceptedIds,
            status: "added"
          });
        }
      } catch (err) {
        const msg = err?.message ?? String(err);
        recordError(runId, msg, groupIndex, batchNumber, chunk);
        this.log("error", `Batch failed: ${msg}`);
        this.membersFailed += chunk.length;
        this.remainingIds = Math.max(0, this.remainingIds - chunk.length);
      }
      updateRunCounts(runId, {
        members_added: this.membersAdded,
        members_failed: this.membersFailed
      });
      this.emitProgress();
      const sleepMs = randomInRange(
        settings.batch_delay_min_s,
        settings.batch_delay_max_s
      ) * 1e3;
      await this.sleepWithCheck(sleepMs);
      batchNumber += 1;
    }
    this.groupsCompleted += 1;
    setGroupStatus(runId, groupIndex, "completed", {
      thread_id: threadId,
      member_count: alreadyInGroup.size
    });
    updateRunCounts(runId, {
      groups_completed: this.groupsCompleted,
      members_added: this.membersAdded,
      members_failed: this.membersFailed
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
  async createGroupAdaptive(params) {
    const session2 = this.session;
    const runId = this.runId;
    const { plannedMembers, greeting, groupIndex, groupName } = params;
    const peeled = [];
    let cursor = 0;
    let sizeIdx = 0;
    let attempts = 0;
    while (sizeIdx < SEED_SIZES.length && attempts < MAX_SEED_ATTEMPTS) {
      const size = SEED_SIZES[sizeIdx];
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
        const result = await session2.api.sendMessage({ body: greeting }, seed);
        if (!result?.threadID) {
          throw new Error("sendMessage returned no threadID");
        }
        return {
          threadId: result.threadID,
          seedAdded: seed,
          peeled,
          remainingMembers: plannedMembers.slice(cursor + size)
        };
      } catch (err) {
        const msg = err?.message ?? String(err);
        const reason = classifyFcaError(msg).reason;
        recordError(runId, msg, groupIndex, attempts, seed);
        if (reason === "blocked" || reason === "rate_limit") {
          throw err;
        }
        const suspect = plannedMembers[cursor];
        if (suspect) {
          peeled.push(suspect);
          this.log(
            "warn",
            `Attempt ${attempts} failed (${reason}). Peeling ID ${suspect} and retrying.`
          );
        }
        cursor++;
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
  resetCounters() {
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
  fail(message) {
    this.failed = true;
    if (this.runId) {
      setRunStatus(this.runId, "failed");
      recordError(this.runId, message, this.currentGroupIndex, 1, null);
    }
    this.log("error", `Run failed: ${message}`);
    this.emitProgress({ force: true, status: "failed" });
  }
  async sleepWithCheck(ms) {
    if (ms <= 0) return;
    const step = 250;
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.abortFlag || this.pauseFlag) return;
      await new Promise((r) => setTimeout(r, Math.min(step, ms - (Date.now() - start))));
    }
  }
  initializeReport() {
    if (!this.outputPath) return;
    try {
      mkdirSync(dirname(this.outputPath), { recursive: true });
      writeFileSync(
        this.outputPath,
        "group_index,group_name,thread_id,member_id,event,timestamp\n",
        "utf8"
      );
    } catch (err) {
      this.log("warn", `Could not initialize report at ${this.outputPath}: ${err.message}`);
    }
  }
  appendGroupRow(row) {
    if (!this.outputPath) return;
    try {
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      const lines = row.memberIds.map(
        (id) => `${row.groupIndex + 1},${csvCell(row.groupName)},${csvCell(row.threadId)},${csvCell(
          id
        )},${row.status},${ts}`
      ).join("\n");
      appendFileSync(this.outputPath, lines + "\n", "utf8");
    } catch {
    }
  }
  log(level, message) {
    if (!this.runId) return;
    this.latestMessage = message;
    const entry = {
      run_id: this.runId,
      level,
      message,
      group_index: this.currentGroupIndex,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.send("chat:log", entry);
  }
  emitProgress(opts = {}) {
    if (!this.runId) return;
    const now = Date.now();
    if (!opts.force && now - this.lastProgressEmit < PROGRESS_EMIT_THROTTLE_MS) {
      return;
    }
    this.lastProgressEmit = now;
    const status = opts.status ?? (this.abortFlag ? "stopped" : this.pauseFlag ? "paused" : "running");
    const data = getRun(this.runId);
    const totalGroups = data?.run.total_groups ?? 0;
    const totalMembers = data?.run.total_members ?? 0;
    const progress = {
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
      message: this.latestMessage
    };
    this.send("chat:progress", progress);
  }
  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }
}
function planGroups(memberIds, prefix) {
  const cleanPrefix = prefix.trim() || "Group";
  const groups = [];
  for (let i = 0, idx = 0; i < memberIds.length; i += MAX_GROUP_SIZE, idx += 1) {
    groups.push({
      groupIndex: idx,
      groupName: `${cleanPrefix} ${idx + 1}`,
      memberIds: memberIds.slice(i, i + MAX_GROUP_SIZE)
    });
  }
  return groups;
}
function randomInRange(minSec, maxSec) {
  if (minSec >= maxSec) return Math.max(0, minSec);
  return minSec + Math.random() * (maxSec - minSec);
}
function csvCell(value) {
  if (value == null) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
async function pickReportPath(win) {
  const result = await dialog.showSaveDialog(win, {
    title: "Save chat groups report",
    defaultPath: join(
      app.getPath("documents"),
      `chat-groups-${Date.now()}.csv`
    ),
    filters: [{ name: "CSV", extensions: ["csv"] }]
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}
let activeCreator = null;
const DEFAULT_SETTINGS = {
  group_name_prefix: "Group",
  batch_size: 10,
  batch_delay_min_s: 30,
  batch_delay_max_s: 60,
  post_group_delay_s: 300,
  group_delay_min_s: 600,
  group_delay_max_s: 1200,
  greeting_message: null
};
function registerChatHandlers() {
  ipcMain.handle(
    "chat:parse-file",
    async (_event, payload) => {
      const ext = payload.filePath ? extname(payload.filePath).toLowerCase() : ".csv";
      if (![".csv", ".txt"].includes(ext)) {
        throw new Error("Unsupported file type. Use .csv or .txt.");
      }
      const text = payload.rawContent ?? readFileSync(payload.filePath, "utf8");
      if (!text || !text.trim()) {
        throw new Error("File is empty.");
      }
      const lines = text.split(/\r?\n/);
      const warnings = [];
      const ids = /* @__PURE__ */ new Set();
      let totalRows = 0;
      let totalInvalid = 0;
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
        let cell;
        if (hasHeader) {
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
        size: g.memberIds.length
      }));
      return {
        total_rows: totalRows,
        total_valid: uniqueIds.length,
        total_invalid: totalInvalid,
        unique_ids: uniqueIds,
        preview: uniqueIds.slice(0, 20),
        planned_groups: planned,
        warnings
      };
    }
  );
  ipcMain.handle("chat:start", async (_event, args) => {
    if (activeCreator?.isRunning()) {
      throw new Error("A run is already in progress. Pause or stop it first.");
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No window available");
    const settings = {
      ...DEFAULT_SETTINGS,
      ...args.settings ?? {},
      group_name_prefix: (args.settings?.group_name_prefix ?? DEFAULT_SETTINGS.group_name_prefix).trim() || DEFAULT_SETTINGS.group_name_prefix
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
      outputPath
    });
    handle.done.finally(() => {
      if (activeCreator === creator) activeCreator = null;
    });
    return { runId: handle.runId, outputPath };
  });
  ipcMain.handle("chat:pause", async () => {
    if (activeCreator?.isRunning()) activeCreator.pause();
    return { paused: true };
  });
  ipcMain.handle("chat:resume", async (_event, runId) => {
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
  ipcMain.handle("chat:list-runs", async () => {
    return listRuns(50);
  });
  ipcMain.handle("chat:get-run", async (_event, runId) => {
    const data = getRun(runId);
    if (!data) return null;
    const errors = listErrors(runId, 200);
    return { ...data, errors };
  });
  ipcMain.handle("chat:report", async (_event, runId) => {
    const data = getRun(runId);
    if (!data) throw new Error("Run not found");
    const errors = listErrors(runId, 1e3);
    const startedMs = new Date(data.run.started_at).getTime();
    const endedMs = data.run.completed_at ? new Date(data.run.completed_at).getTime() : Date.now();
    return {
      run: data.run,
      groups: data.groups,
      errors,
      duration_seconds: Math.max(0, Math.round((endedMs - startedMs) / 1e3))
    };
  });
}
function pauseActiveChatRun() {
  if (activeCreator?.isRunning()) {
    const runId = activeCreator.getRunId();
    activeCreator.pause();
    if (runId) setRunStatus(runId, "paused");
  }
}
function parseCsvLine(line) {
  const cells = [];
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
function isValidFacebookId(id) {
  return /^[0-9]{5,20}$/.test(id);
}
if (process.env.NODE_ENV !== "production") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-dev-shm-usage");
let mainWindow = null;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: resolve(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => {
      if (mainWindow) mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
    });
  } else {
    mainWindow.loadFile(resolve(__dirname, "../renderer/index.html"));
  }
}
app.whenReady().then(() => {
  initDB();
  registerAccountHandlers();
  registerExtractionHandlers();
  registerFacebookHandlers();
  registerChatHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  saveActiveExtraction();
  pauseActiveChatRun();
});
