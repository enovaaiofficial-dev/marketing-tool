"use strict";
(function spoofVisibility() {
  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get() {
        return "visible";
      }
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get() {
        return false;
      }
    });
    document.addEventListener(
      "visibilitychange",
      function(e) {
        e.stopImmediatePropagation();
      },
      true
    );
    Object.defineProperty(document, "webkitVisibilityState", {
      configurable: true,
      get() {
        return "visible";
      }
    });
    Object.defineProperty(document, "webkitHidden", {
      configurable: true,
      get() {
        return false;
      }
    });
  } catch {
  }
})();
