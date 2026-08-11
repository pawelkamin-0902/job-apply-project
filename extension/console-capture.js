// Injected before field-detector.js on every Auto Fill / Learn / Save Sample run.
// Patches console in the extension's isolated world so [Auto Fill] diagnostics survive
// until Save Sample writes them to disk alongside the HTML fixture.
(function () {
  const STORAGE_KEY = "__autoFillConsoleLogV1";
  const MAX_LINES = 2000;
  const buffer = [];

  function persistBuffer() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    } catch {
      /* quota / cross-origin frame */
    }
  }

  function loadBufferFromStorage() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      buffer.length = 0;
      for (const entry of parsed.slice(-MAX_LINES)) buffer.push(entry);
    } catch {
      /* ignore */
    }
  }

  function push(level, args) {
    const ts = new Date().toISOString();
    let text = "";
    try {
      text = args
        .map((a) => {
          if (a == null) return String(a);
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
    } catch {
      text = "[unserializable log]";
    }
    buffer.push({ ts, level, text });
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
    persistBuffer();
  }

  if (!window.__autoFillConsoleInstalled) {
    window.__autoFillConsoleInstalled = true;
    loadBufferFromStorage();

    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = console[level] && console[level].bind(console);
      if (!orig) continue;
      console[level] = function (...args) {
        push(level, args);
        return orig(...args);
      };
    }
  }

  window.clearAutoFillConsoleLog = function () {
    buffer.length = 0;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  window.getAutoFillConsoleLog = function () {
    if (!buffer.length) loadBufferFromStorage();
    return buffer.map((e) => `${e.ts} [${e.level}] ${e.text}`).join("\n");
  };
})();
