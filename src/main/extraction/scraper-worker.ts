import { BrowserWindow, session } from "electron";
import { resolve } from "path";
import { getSessionCookies } from "../api/facebook-login";
import type { GroupScraper, GroupJob } from "./group-scraper";

// Resolve once: the bundled scraper preload sits next to the main bundle
// in dist/preload/scraper.cjs (relative to dist/main where this file ends
// up after build).
const SCRAPER_PRELOAD_PATH = resolve(__dirname, "../preload/scraper.cjs");

// Far-off-screen coordinates used when the user picked headless mode.
// Negative enough to land off any normal multi-monitor setup but well
// above the int16 floor that some legacy windowing code clamps to.
const OFFSCREEN_X = -10000;
const OFFSCREEN_Y = -10000;

export interface AccountSlot {
  id: number;
  token: string;
  name: string;
  failCount: number;
}

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

const PAGE_HEIGHT_JS =
  "(function(){return document.body?document.body.scrollHeight:0;})();";

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

// Tighter end-of-group detection: bail after 10 batches with no new IDs AND
// no page-height growth. Old value of 30 wasted ~2.5min per group.
const MAX_NO_NEW = 10;
const SCROLLS_PER_BATCH = 3;
const SCROLL_DELAY_MS = 600;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 6000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 5000;
const PAGE_LOAD_TIMEOUT_MS = 20000;
const POST_LOAD_SETTLE_MS = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_ACCOUNT_FAILURES = 3;

interface WorkerOptions {
  index: number;
  account: AccountSlot;
  orchestrator: GroupScraper;
  showWindow: boolean;
}

/**
 * One scraper worker = one BrowserWindow on its own session partition,
 * bound to a single account. Workers pull groups from the orchestrator's
 * shared queue and process them independently. The orchestrator owns the
 * shared dedup set, CSV writer, and progress emitter.
 */
export class ScraperWorker {
  readonly index: number;
  readonly account: AccountSlot;
  private orchestrator: GroupScraper;
  private showWindow: boolean;
  private window: BrowserWindow | null = null;

  constructor(opts: WorkerOptions) {
    this.index = opts.index;
    this.account = opts.account;
    this.orchestrator = opts.orchestrator;
    this.showWindow = opts.showWindow;
  }

  /** Main worker loop: pulls groups until queue empty, account dies, or run aborts. */
  async run(): Promise<void> {
    try {
      await this.initWindow();
    } catch (err) {
      this.orchestrator.recordError(
        `(worker-${this.index})`,
        0,
        new Error(
          `Worker ${this.index} (account ${this.account.name}) failed to initialize: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      );
      return;
    }

    while (
      !this.orchestrator.isAborted() &&
      this.account.failCount < MAX_ACCOUNT_FAILURES
    ) {
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

  private async initWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
      this.window = null;
    }

    // Each worker gets its own session partition so cookies don't collide
    // between accounts running in parallel.
    const partition = `persist:scraper-${this.account.id}`;
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();

    let cookies: Awaited<ReturnType<typeof getSessionCookies>> | null = null;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        cookies = await getSessionCookies(this.account.token);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3 && !this.orchestrator.isAborted()) {
          await this.delay(5000 * attempt);
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
        httpOnly: cookie.httponly ?? false,
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
        backgroundThrottling: false,
      },
    });

    this.window.webContents.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    this.window.webContents.setBackgroundThrottling(false);

    // Headless mode: instead of leaving show=false (which makes Chromium
    // skip compositor frames, which means IntersectionObserver never fires,
    // which means Facebook's lazy-loader never triggers further loads after
    // the first paint), bring the window up off-screen. Chromium renders it
    // as a fully-active page, FB's IntersectionObservers fire normally,
    // members keep loading on scroll — but the user never sees the window.
    //
    // showInactive() instead of show() so we don't steal focus from the
    // user's main app window.
    if (this.showWindow) {
      this.window.show();
    } else {
      this.window.setPosition(OFFSCREEN_X, OFFSCREEN_Y);
      this.window.showInactive();
    }

    // Prevent the user from closing the worker window mid-extraction.
    this.window.on("close", (e) => {
      if (this.orchestrator.isRunning() && !this.orchestrator.isAborted()) {
        e.preventDefault();
      }
    });
  }

  private destroyWindow(): void {
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
  private async scrapeGroup(
    job: GroupJob
  ): Promise<{ completed: boolean; requeue: boolean; extractedInGroup: number }> {
    const groupUrl =
      "https://www.facebook.com/groups/" + encodeURIComponent(job.groupId) + "/members";

    // Initial page load with retries.
    let loaded = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.orchestrator.isAborted()) {
        return { completed: false, requeue: true, extractedInGroup: 0 };
      }
      try {
        if (!this.window || this.window.isDestroyed()) {
          await this.initWindow();
        }
        await this.loadPage(this.window!, groupUrl);
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
          await this.loadPage(this.window!, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
          prevVisibleCount = 0;
          lastPageHeight = 0;
          stagnantHeightCount = 0;
          continue;
        }

        // Scroll a few times.
        for (let s = 0; s < SCROLLS_PER_BATCH; s++) {
          await win.webContents.executeJavaScript(SCROLL_JS);
          await this.delay(SCROLL_DELAY_MS);
        }
        await win.webContents.executeJavaScript(
          "window.scrollTo(0, document.body.scrollHeight);"
        );

        // Wait for new anchors to appear (or timeout at 10s).
        try {
          const newVisibleCount: number = await win.webContents.executeJavaScript(
            WAIT_FOR_NEW_JS + String(prevVisibleCount) + ");"
          );
          prevVisibleCount = newVisibleCount;
        } catch {
          await this.delay(2000);
        }

        // Block / login / captcha detection.
        const blockInfo: any = await win.webContents.executeJavaScript(CHECK_BLOCK_JS);
        if (blockInfo.isLogin || blockInfo.isBlock || blockInfo.isCaptcha) {
          this.account.failCount++;
          const reason = blockInfo.isCaptcha
            ? "Captcha detected"
            : blockInfo.isBlock
              ? "Account blocked/restricted"
              : "Session expired (login page)";
          this.orchestrator.recordError(
            job.groupId,
            currentBatch,
            new Error(
              `${reason} — worker ${this.index} account ${this.account.name} (failCount=${this.account.failCount}/${MAX_ACCOUNT_FAILURES})`
            )
          );

          if (this.account.failCount >= MAX_ACCOUNT_FAILURES) {
            // Worker is done — orchestrator will requeue this group for another worker.
            return { completed: false, requeue: true, extractedInGroup };
          }

          // Try once more on this account: re-init window with fresh cookies.
          await this.initWindow();
          await this.loadPage(this.window!, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
          prevVisibleCount = 0;
          lastPageHeight = 0;
          stagnantHeightCount = 0;
          continue;
        }

        // Extract IDs from the DOM.
        const ids: string[] = await win.webContents.executeJavaScript(SCRAPE_IDS_JS);
        const newIds = this.orchestrator.addMembers(ids);

        if (newIds.length > 0) {
          noNewCount = 0;
          consecutiveErrors = 0;
          extractedInGroup += newIds.length;
          await this.orchestrator.persistMembers(job.groupId, this.account.name, newIds);
        } else {
          noNewCount++;
        }

        // Page-height growth check — once the page stops growing AND we're
        // not finding new IDs, we are at the bottom of the list.
        let currentHeight = lastPageHeight;
        try {
          currentHeight = (await win.webContents.executeJavaScript(PAGE_HEIGHT_JS)) ?? 0;
        } catch {
          // ignore
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
          status: "running",
        });

        this.orchestrator.persistRunState();

        // End-of-group: no new IDs for MAX_NO_NEW batches AND page hasn't
        // grown for at least 3 batches. Either alone is too aggressive.
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

        // Try to recover the window.
        try {
          if (!this.window || this.window.isDestroyed()) {
            await this.initWindow();
          }
          await this.loadPage(this.window!, groupUrl);
          await this.delay(POST_LOAD_SETTLE_MS);
        } catch (recoveryErr) {
          this.orchestrator.recordError(
            job.groupId,
            currentBatch,
            new Error(
              `Window recovery failed: ${
                recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
              }`
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
      extractedInGroup,
    };
  }

  private async loadPage(scraper: BrowserWindow, url: string): Promise<void> {
    try {
      await scraper.loadURL(url);
    } catch {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Page load timed out")),
          PAGE_LOAD_TIMEOUT_MS
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

  private randomDelay(): Promise<void> {
    const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
    return this.delay(ms);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.orchestrator.isAborted()) return resolve();
      setTimeout(resolve, ms);
    });
  }
}
