#!/usr/bin/env node
// Sweep captured HTML with the real extractPageInfo() — title + JD quality audit.
// Usage:
//   node sweep-extract-jd.mjs [captured-dir] [--limit N] [--json out.json] [--only-bad]
// Defaults to HGFS captured dir if present.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM, VirtualConsole } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SIDEPANEL = fs.readFileSync(path.join(ROOT, "extension/sidepanel.js"), "utf8");

// Brace-counting fails on template literals / regexes inside extractPageInfo (it is huge).
// Slice from extractPageInfo through the start of the next known top-level function instead.
function extractFunctionBetween(source, name, nextName) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = source.search(startRe);
  if (start < 0) throw new Error(`Could not find function ${name}`);
  const nextRe = new RegExp(`(?:async\\s+)?function\\s+${nextName}\\s*\\(`);
  const next = source.search(nextRe);
  if (next < 0 || next <= start) throw new Error(`Could not find next function ${nextName}`);
  return source.slice(start, next).trim();
}

const EXTRACT_PAGE_INFO = extractFunctionBetween(
  SIDEPANEL,
  "extractPageInfo",
  "sendChatGptPromptInPage"
);

function stripScriptsKeepJsonLd(html) {
  // Keep application/ld+json — extractors need it. Drop other scripts/styles for speed/safety.
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) return full;
    return "";
  }).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

function readMeta(htmlPath) {
  const jsonPath = htmlPath.replace(/\.html$/i, ".json");
  if (!fs.existsSync(jsonPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return {};
  }
}

function setupDom(html, url) {
  const vc = new VirtualConsole();
  vc.on("error", () => {});
  vc.on("jsdomError", () => {});
  const safe = stripScriptsKeepJsonLd(html);
  const dom = new JSDOM(safe, {
    pretendToBeVisual: true,
    url: url || "https://example.com/",
    runScripts: "outside-only",
    virtualConsole: vc,
  });
  // extractPageInfo uses innerText heavily; jsdom often leaves it empty — mirror textContent.
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent || "";
    },
    set(v) {
      this.textContent = v;
    },
  });
  dom.window.eval(EXTRACT_PAGE_INFO);
  return dom;
}

const CHROME_RE =
  /privacy policy|cookie (policy|preferences)|powered by|sign in|log in|create account|job openings|see all jobs|all open positions|javascript is (turned )?off|unsupported browser|enable cookies|captcha|recaptcha|hcaptcha|cloudflare|terms of (use|service)|equal opportunity|eeo statement only/i;

const GENERIC_TITLE_RE =
  /^(apply|application|job(s)?|careers?|openings?|easy apply|job details|job application|confirm your cv|upload your cv|apply now)$/i;

function looksLikeJsonBlob(s) {
  const t = (s || "").trim();
  return t.startsWith("{") || t.startsWith("[") || /"@type"\s*:/.test(t.slice(0, 200));
}

function looksLikeCode(s) {
  const t = s || "";
  if (/function\s*\(|=>\s*\{|window\.|document\.|recaptcha/i.test(t.slice(0, 500))) return true;
  if ((t.match(/;\s*$/gm) || []).length > 20 && t.includes("{")) return true;
  return false;
}

function triage(info, meta, file) {
  const title = (info.jobTitle || "").trim();
  const jd = (info.jobDescription || "").trim();
  const issues = [];

  if (!title) issues.push("empty_title");
  else if (GENERIC_TITLE_RE.test(title)) issues.push("generic_title");
  else if (title.length < 4) issues.push("short_title");
  else if (title.length > 140) issues.push("long_title");
  else if (/^(apply\s*[-–|:]\s*)/i.test(title)) issues.push("apply_prefix_title");

  if (!jd) issues.push("empty_jd");
  else if (jd.length < 120) issues.push("thin_jd");
  else if (jd.length < 250) issues.push("short_jd");
  if (jd && CHROME_RE.test(jd.slice(0, 400)) && jd.length < 800) issues.push("chrome_prefix_jd");
  if (jd && looksLikeJsonBlob(jd)) issues.push("json_blob_jd");
  if (jd && looksLikeCode(jd)) issues.push("code_like_jd");
  if (jd && /<\s*(h[1-6]|p|div|ul|li|strong)\b/i.test(jd.slice(0, 300))) issues.push("raw_html_jd");

  // Cross-check: if JSON-LD title exists in page HTML and we diverge wildly, flag.
  const htmlSnippet = meta._htmlSnippet || "";
  const ldTitle = meta._ldTitle || "";
  if (ldTitle && title && ldTitle.toLowerCase() !== title.toLowerCase()) {
    // Allow company suffix differences
    if (!title.toLowerCase().includes(ldTitle.toLowerCase().slice(0, 20)) &&
        !ldTitle.toLowerCase().includes(title.toLowerCase().slice(0, 20))) {
      issues.push("title_vs_jsonld");
    }
  }

  return issues;
}

function peekGroundTruth(html) {
  let ldTitle = "";
  let ldDescLen = 0;
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const item of items) {
        if (item && item["@type"] === "JobPosting") {
          if (item.title) ldTitle = String(item.title).trim();
          if (item.description) ldDescLen = String(item.description).length;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1 ? h1[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  return {
    ldTitle,
    ldDescLen,
    ogTitle: og ? og[1].trim() : "",
    h1: h1Text.slice(0, 150),
  };
}

const args = process.argv.slice(2);
const defaultDirs = [
  "/tmp/hgfs-user/job-apply-project/extension/test-forms/captured",
  "/mnt/hgfs/auto-apply/job-apply-project/extension/test-forms/captured",
  path.join(ROOT, "extension/test-forms/captured"),
];
let capturedDir = args.find((a) => !a.startsWith("--"));
if (!capturedDir) {
  capturedDir = defaultDirs.find((d) => fs.existsSync(d)) || defaultDirs[0];
}
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const jsonIdx = args.indexOf("--json");
const jsonOut =
  jsonIdx >= 0 ? args[jsonIdx + 1] : path.join(__dirname, "sweep-extract-jd-report.json");
const onlyBad = args.includes("--only-bad");
const includeFrames = args.includes("--frames");

if (!fs.existsSync(capturedDir)) {
  console.error(`Captured dir not found: ${capturedDir}`);
  process.exit(1);
}

let files = fs
  .readdirSync(capturedDir)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => includeFrames || !/-frame\d+\.html$/i.test(f))
  .sort();
if (limit > 0) files = files.slice(0, limit);

console.log(`Scanning ${files.length} HTML files in ${capturedDir}`);

const rows = [];
const issueCounts = Object.create(null);
let ok = 0;
let bad = 0;
let errors = 0;

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const htmlPath = path.join(capturedDir, file);
  process.stdout.write(`[${i + 1}/${files.length}] ${file.slice(0, 70)}…\r`);
  try {
    const html = fs.readFileSync(htmlPath, "utf8");
    const meta = readMeta(htmlPath);
    const url = meta.frame_url || meta.page_url || "https://example.com/";
    const gt = peekGroundTruth(html);
    const dom = setupDom(html, url);
    const info = dom.window.extractPageInfo();
    dom.window.close();

    const issues = triage(
      info,
      { ...meta, _ldTitle: gt.ldTitle, _htmlSnippet: html.slice(0, 2000) },
      file
    );
    for (const iss of issues) issueCounts[iss] = (issueCounts[iss] || 0) + 1;

    const row = {
      file,
      url: (url || "").slice(0, 160),
      company: (info.company || "").slice(0, 80),
      jobTitle: (info.jobTitle || "").slice(0, 160),
      jdLen: (info.jobDescription || "").length,
      jdPreview: (info.jobDescription || "").replace(/\s+/g, " ").slice(0, 180),
      structuredLocation: (info.structuredLocation || "").slice(0, 80),
      gt,
      issues,
    };
    if (issues.length) bad++;
    else ok++;
    if (!onlyBad || issues.length) rows.push(row);
  } catch (err) {
    errors++;
    rows.push({ file, issues: ["exception"], error: String(err && err.message ? err.message : err) });
    issueCounts.exception = (issueCounts.exception || 0) + 1;
  }
}

console.log("");
console.log(`Done. ok=${ok} bad=${bad} errors=${errors} reported=${rows.length}`);
console.log("Issue counts:", issueCounts);

const summary = {
  capturedDir,
  scanned: files.length,
  ok,
  bad,
  errors,
  issueCounts,
  rows: onlyBad ? rows : rows.filter((r) => (r.issues || []).length),
  allRows: onlyBad ? undefined : rows,
};

// Always write bad-only summary compactly + full report
fs.writeFileSync(jsonOut, JSON.stringify({ ...summary, allRows: rows }, null, 2));
const badOut = jsonOut.replace(/\.json$/i, "-bad.json");
fs.writeFileSync(
  badOut,
  JSON.stringify(
    {
      ...summary,
      rows: rows.filter((r) => (r.issues || []).length),
      allRows: undefined,
    },
    null,
    2
  )
);

console.log(`Full report: ${jsonOut}`);
console.log(`Bad-only:    ${badOut}`);

// Print worst offenders
const interesting = rows
  .filter((r) => (r.issues || []).some((i) =>
    ["empty_title", "empty_jd", "thin_jd", "json_blob_jd", "code_like_jd", "generic_title", "raw_html_jd", "chrome_prefix_jd"].includes(i)
  ))
  .slice(0, 40);
console.log("\n=== Sample bad extractions ===");
for (const r of interesting) {
  console.log(`\n${r.file}`);
  console.log(`  issues: ${r.issues.join(", ")}`);
  console.log(`  title:  ${r.jobTitle || "(empty)"}`);
  console.log(`  jdLen:  ${r.jdLen} | preview: ${(r.jdPreview || "").slice(0, 120)}`);
  if (r.gt && (r.gt.ldTitle || r.gt.h1 || r.gt.ogTitle)) {
    console.log(`  gt:     ld="${r.gt.ldTitle}" h1="${r.gt.h1}" og="${r.gt.ogTitle}" ldDesc=${r.gt.ldDescLen}`);
  }
}
