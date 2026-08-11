#!/usr/bin/env node
// Run the REAL runAutofillInPage from sidepanel.js + field-detector.js in jsdom.
// Usage: node test-autofill-page.mjs path/to/form.html

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

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

function setupDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
    runScripts: "dangerously",
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

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test-autofill-page.mjs <file.html>");
  process.exit(1);
}

const html = fs
  .readFileSync(file, "utf8")
  // Strip inline scripts — Lever and others throw in jsdom and can interrupt autofill.
  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
const dom = setupDom(html);
const [profile, qaBank] = await Promise.all([apiFetch("/profile"), apiFetch("/qa")]);

const runAutofillInPage = dom.window.runAutofillInPage;
const { filled, unmatched } = await runAutofillInPage(profile, qaBank);

console.log(`\n=== ${path.basename(file)} ===\n`);
console.log("FILLED:");
for (const f of filled) console.log(`  [${f.source}] ${f.label} -> ${JSON.stringify(f.value)}`);
console.log("\nUNMATCHED:");
for (const u of unmatched) {
  const gen = u.canGenerate ? " (gpt-eligible)" : "";
  const opts = u.options?.length ? ` options=${u.options.length}` : "";
  console.log(`  ${u.label || "(no label)"}${gen}${opts}`);
}
console.log(`\nSummary: ${filled.length} filled, ${unmatched.length} unmatched`);
