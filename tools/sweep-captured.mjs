#!/usr/bin/env node
// Sweep all Save Sample captured HTML files — detection + first-pass autofill stats.
// Usage: node sweep-captured.mjs [captured-dir] [--limit N] [--json report.json]

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { JSDOM, VirtualConsole } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FIELD_DETECTOR = fs.readFileSync(path.join(ROOT, "extension/field-detector.js"), "utf8");
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

function stripScripts(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
}

function setupDom(html) {
  const vc = new VirtualConsole();
  vc.on("error", () => {});
  vc.on("jsdomError", () => {});
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole: vc,
  });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const style = dom.window.getComputedStyle(this);
    if (style.display === "none" || style.visibility === "hidden") {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    }
    return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
    get() {
      const style = dom.window.getComputedStyle(this);
      return style.display === "none" ? null : this.parentElement;
    },
  });
  dom.window.CSS = dom.window.CSS || {
    escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c),
  };
  dom.window.MouseEvent = dom.window.MouseEvent;
  dom.window.KeyboardEvent = dom.window.KeyboardEvent;
  dom.window.eval(FIELD_DETECTOR);
  dom.window.eval(RUN_AUTOFILL);
  return dom;
}

function atsFromName(name) {
  const base = name.replace(/-frame\d+\.html$/i, ".html").replace(/\.html$/i, "");
  const host = base.replace(/-\d{8}T\d{6}Z$/i, "");
  return host || "unknown";
}

function countFields(dom) {
  const { groups, singles, loneCheckboxes } = dom.window.collectFormFields();
  return groups.length + singles.length + loneCheckboxes.length;
}

const args = process.argv.slice(2);
let capturedDir =
  args.find((a) => !a.startsWith("--")) ||
  "/mnt/hgfs/auto-apply/job-apply-project/extension/test-forms/captured";
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const timeoutIdx = args.indexOf("--timeout");
const perFileTimeoutMs = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1], 10) : 8000;
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : path.join(__dirname, "sweep-captured-report.json");

if (!fs.existsSync(capturedDir)) {
  console.error(`Captured dir not found: ${capturedDir}`);
  process.exit(1);
}

let files = fs
  .readdirSync(capturedDir)
  .filter((f) => f.endsWith(".html"))
  .sort();
if (limit > 0) files = files.slice(0, limit);

console.log(`Sweeping ${files.length} captured HTML files from:\n  ${capturedDir}\n`);
const [profile, qaBank] = await Promise.all([apiFetch("/profile"), apiFetch("/qa")]);
console.log(`Profile + QA bank loaded (${qaBank.length} QA entries)\n`);

const results = [];
const byAts = new Map();
let errors = 0;
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const full = path.join(capturedDir, file);
  const ats = atsFromName(file);
  let row = { file, ats, detected: 0, filled: 0, unmatched: 0, error: null };

  try {
    const html = stripScripts(fs.readFileSync(full, "utf8"));
    const dom = setupDom(html);
    row.detected = countFields(dom);
    const run = dom.window.runAutofillInPage(profile, qaBank);
    const { filled, unmatched } = await Promise.race([
      run,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${perFileTimeoutMs}ms`)), perFileTimeoutMs)
      ),
    ]);
    row.filled = filled.length;
    row.unmatched = unmatched.length;
    row.unmatchedLabels = unmatched
      .slice(0, 5)
      .map((u) => u.label || "(no label)")
      .filter(Boolean);
    row.gptEligible = unmatched.filter((u) => u.canGenerate).length;
    row.withOptions = unmatched.filter((u) => Array.isArray(u.options) && u.options.length > 1).length;
  } catch (err) {
    row.error = err.message || String(err);
    errors++;
  }

  results.push(row);
  if (!byAts.has(ats)) byAts.set(ats, { files: 0, detected: 0, filled: 0, unmatched: 0, zeroDetect: 0, errors: 0 });
  const agg = byAts.get(ats);
  agg.files++;
  agg.detected += row.detected;
  agg.filled += row.filled;
  agg.unmatched += row.unmatched;
  if (row.detected === 0) agg.zeroDetect++;
  if (row.error) agg.errors++;

  if ((i + 1) % 25 === 0 || i === files.length - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${i + 1}/${files.length} (${elapsed}s)`);
  }
}

console.log("\n");

const totalDetected = results.reduce((s, r) => s + r.detected, 0);
const totalFilled = results.reduce((s, r) => s + r.filled, 0);
const totalUnmatched = results.reduce((s, r) => s + r.unmatched, 0);
const zeroDetect = results.filter((r) => r.detected === 0 && !r.error).length;
const withFields = results.filter((r) => r.detected > 0);
const fullyFilled = withFields.filter((r) => r.unmatched === 0).length;

console.log("=== CAPTURED SWEEP SUMMARY ===\n");
console.log(`Files scanned:     ${results.length}`);
console.log(`Errors:            ${errors}`);
console.log(`Zero fields found: ${zeroDetect} (shadow DOM / iframe shell / empty capture)`);
console.log(`With fields:       ${withFields.length}`);
console.log(`Fully filled:      ${fullyFilled} / ${withFields.length} (first pass only)`);
console.log(`Total detected:    ${totalDetected}`);
console.log(`Total filled:      ${totalFilled}`);
console.log(`Total unmatched:   ${totalUnmatched}`);
if (withFields.length) {
  const avgFill =
    withFields.reduce((s, r) => s + r.filled / Math.max(r.detected, 1), 0) / withFields.length;
  console.log(`Avg fill rate:     ${(avgFill * 100).toFixed(1)}% (filled / detected per form)`);
}

console.log("\n=== BY ATS (top 20 by file count) ===\n");
const sortedAts = [...byAts.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 20);
for (const [ats, agg] of sortedAts) {
  const rate = agg.detected ? ((agg.filled / agg.detected) * 100).toFixed(0) : "—";
  console.log(
    `  ${String(agg.files).padStart(3)} files | detect ${String(agg.detected).padStart(4)} | fill ${String(agg.filled).padStart(4)} | ${rate}% | 0-field: ${agg.zeroDetect} | err: ${agg.errors} | ${ats}`
  );
}

const worst = withFields
  .map((r) => ({ ...r, rate: r.filled / r.detected }))
  .sort((a, b) => a.rate - b.rate)
  .slice(0, 15);

console.log("\n=== WORST FILL RATE (has fields, lowest %) ===\n");
for (const r of worst) {
  console.log(
    `  ${(r.rate * 100).toFixed(0)}% (${r.filled}/${r.detected}) ${r.file}${r.unmatchedLabels?.length ? " — e.g. " + r.unmatchedLabels[0] : ""}`
  );
}

const noLabel = results.filter((r) =>
  r.unmatchedLabels?.some((l) => l === "(no label)" || !l.trim())
);
console.log(`\nForms with blank-label unmatched: ${noLabel.length}`);

fs.writeFileSync(jsonOut, JSON.stringify({ scannedAt: new Date().toISOString(), results, byAts: Object.fromEntries(byAts) }, null, 2));
console.log(`\nFull report: ${jsonOut}\n`);
