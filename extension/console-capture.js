// Injected before field-detector.js on every Auto Fill / Learn / Save Sample run.
// Patches console in the extension's isolated world so [Auto Fill] diagnostics survive
// until Save Sample writes them to disk alongside the HTML fixture.
(function () {
  if (window.__autoFillConsoleInstalled) return;
  window.__autoFillConsoleInstalled = true;

  const MAX_LINES = 2000;
  const buffer = [];

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
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level] && console[level].bind(console);
    if (!orig) continue;
    console[level] = function (...args) {
      push(level, args);
      return orig(...args);
    };
  }

  window.clearAutoFillConsoleLog = function () {
    buffer.length = 0;
  };

  window.getAutoFillConsoleLog = function () {
    return buffer.map((e) => `${e.ts} [${e.level}] ${e.text}`).join("\n");
  };
})();
