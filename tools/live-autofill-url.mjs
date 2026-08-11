#!/usr/bin/env node
/**
 * Run the REAL runAutofillInPage engine in a live Chromium tab (not jsdom).
 * Usage: node live-autofill-url.mjs <apply-url> [--headed] [--wait-ms=4000]
 *
 * Requires companion service + ~/.job-apply-project/secret.token (same as extension).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FIELD_DETECTOR = fs.readFileSync(path.join(ROOT, "extension/field-detector.js"), "utf8");
const CONSOLE_CAPTURE = fs.readFileSync(path.join(ROOT, "extension/console-capture.js"), "utf8");
const SIDEPANEL = fs.readFileSync(path.join(ROOT, "extension/sidepanel.js"), "utf8");

function extractFunction(source, name) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = source.search(startRe);
  if (start < 0) throw new Error(`Could not find function ${name}`);
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces in ${name}`);
}

const RUN_AUTOFILL = extractFunction(SIDEPANEL, "runAutofillInPage");
const BASE_URL = process.env.AUTOFILL_BASE_URL || "http://127.0.0.1:3939";
const TOKEN_FILE = path.join(os.homedir(), ".job-apply-project", "secret.token");

function readToken() {
  if (process.env.AUTOFILL_TOKEN) return process.env.AUTOFILL_TOKEN.trim();
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

async function apiFetch(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    headers: { "X-Api-Token": readToken() },
  });
  if (!res.ok) throw new Error(`${res.status} ${urlPath}`);
  return res.json();
}

function parseArgs(argv) {
  const url = argv.find((a) => a.startsWith("http"));
  const headed = argv.includes("--headed");
  const waitArg = argv.find((a) => a.startsWith("--wait-ms="));
  const waitMs = waitArg ? Number(waitArg.split("=")[1]) : 4000;
  if (!url) {
    console.error("Usage: node live-autofill-url.mjs <apply-url> [--headed] [--wait-ms=4000]");
    process.exit(1);
  }
  return { url, headed, waitMs };
}

const { url, headed, waitMs } = parseArgs(process.argv.slice(2));

const [profile, qaBank] = await Promise.all([apiFetch("/profile"), apiFetch("/qa")]);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

const pageLogs = [];
page.on("console", (msg) => {
  pageLogs.push({ level: msg.type(), text: msg.text() });
});

console.log(`\nOpening: ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(waitMs);

const applySelectors = [
  'a[href*="application"]',
  'button:has-text("Apply")',
  'a:has-text("Apply for this job")',
  'a:has-text("Apply")',
];
for (const sel of applySelectors) {
  const el = page.locator(sel).first();
  if (await el.count()) {
    try {
      await el.click({ timeout: 3000 });
      await page.waitForTimeout(2500);
      console.log(`Clicked apply via: ${sel}`);
      break;
    } catch {
      /* try next */
    }
  }
}

await page.evaluate(
  ({ consoleCapture, fieldDetector, runAutofillSrc }) => {
    eval(consoleCapture);
    eval(fieldDetector);
    eval(`${runAutofillSrc}\n;window.runAutofillInPage = runAutofillInPage;`);
  },
  { consoleCapture: CONSOLE_CAPTURE, fieldDetector: FIELD_DETECTOR, runAutofillSrc: RUN_AUTOFILL }
);

console.log("Running runAutofillInPage...");
const result = await page.evaluate(
  async ({ profile, qaBank }) => {
    const out = await window.runAutofillInPage(profile, qaBank);
    const captured =
      typeof window.__autoFillConsoleDump === "function" ? window.__autoFillConsoleDump() : [];
    return { out, captured };
  },
  { profile, qaBank }
);

const { out, captured } = result;
const autoFillLogs = [
  ...captured.map((l) => `[${l.level}] ${l.text}`),
  ...pageLogs.filter((l) => /\[Auto Fill\]/i.test(l.text)).map((l) => `[page:${l.level}] ${l.text}`),
];

console.log("\n=== FILLED ===");
for (const f of out.filled || []) {
  console.log(`  [${f.source || "?"}] ${f.label} -> ${JSON.stringify(f.value)}`);
}

console.log("\n=== UNMATCHED / NEED INPUT ===");
for (const u of out.unmatched || []) {
  const opts = u.options ? ` options=${JSON.stringify(u.options)}` : "";
  console.log(`  ${u.label}${opts}${u.reason ? ` (${u.reason})` : ""}`);
}

console.log("\n=== SUMMARY ===");
console.log(
  `filled=${(out.filled || []).length} unmatched=${(out.unmatched || []).length} needsHuman=${(out.needsHuman || []).length}`
);

const retryLogs = autoFillLogs.filter((l) => /retry|combobox|discover|trusted|failed|unmatched/i.test(l));
console.log("\n=== KEY CONSOLE LINES (retries / combobox / failures) ===");
for (const line of retryLogs.slice(-80)) console.log(line);

if (autoFillLogs.length) {
  const outPath = path.join(ROOT, "tools", `live-run-${Date.now()}.console.log`);
  fs.writeFileSync(outPath, autoFillLogs.join("\n"));
  console.log(`\nFull console buffer: ${outPath}`);
}

await browser.close();
