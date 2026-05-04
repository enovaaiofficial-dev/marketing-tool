// Preload script for headless scraper BrowserWindows.
//
// When a BrowserWindow is created with `show: false`, Chromium reports
// `document.visibilityState === 'hidden'` to all page scripts. Many sites,
// Facebook included, gate their lazy-load logic on visibility — so a hidden
// window scrolls fine but never renders new content past the initial paint,
// breaking extraction beyond the first batch.
//
// This script overrides the Page Visibility API to always report "visible"
// before any page script runs. For the override to be observed by Facebook's
// own scripts, this preload must be loaded with `contextIsolation: false`
// in the scraper window's webPreferences (so it patches the main world that
// page scripts read from). That trade-off is acceptable here because the
// scraper window only ever loads facebook.com and never exposes any IPC
// bridge or Node APIs.

(function spoofVisibility() {
  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get() {
        return "visible";
      },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get() {
        return false;
      },
    });

    // Suppress "hidden" visibilitychange events from reaching page handlers.
    // Use capture-phase so we run before any listener registered later.
    document.addEventListener(
      "visibilitychange",
      function (e) {
        e.stopImmediatePropagation();
      },
      true
    );

    // Some sites also check `document.webkitVisibilityState` / `webkitHidden`.
    Object.defineProperty(document, "webkitVisibilityState", {
      configurable: true,
      get() {
        return "visible";
      },
    });
    Object.defineProperty(document, "webkitHidden", {
      configurable: true,
      get() {
        return false;
      },
    });
  } catch {
    // If anything blows up, scraping might be slower in headless mode
    // but it shouldn't break.
  }
})();
