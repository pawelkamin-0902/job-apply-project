#!/usr/bin/env node
// Sweep all test-form HTML fixtures; report fill stats and suspicious unmatched fields.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const formsDir = path.resolve(__dirname, "../extension/test-forms");
const files = fs
  .readdirSync(formsDir)
  .filter((f) => f.endsWith(".html"))
  .sort();

const results = [];
for (const f of files) {
  const full = path.join(formsDir, f);
  const r = spawnSync("node", ["test-autofill-page.mjs", full], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 120000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const filled = [...out.matchAll(/\[(\w+)\] ([^\n]+) -> /g)].map((m) => ({
    source: m[1],
    label: m[2],
  }));
  const unmatched = [...out.matchAll(/^  ([^\[]+)$/gm)]
    .map((m) => m[1].trim())
    .filter((l) => l && !l.startsWith("UNMATCHED") && !l.startsWith("FILLED") && !l.startsWith("===") && !l.startsWith("Summary"));
  const summary = out.match(/Summary: (\d+) filled, (\d+) unmatched/);
  results.push({
    file: f,
    filled: summary ? +summary[1] : filled.length,
    unmatched: summary ? +summary[2] : 0,
    unmatchedLabels: unmatched,
    exit: r.status,
    error: r.error?.message,
  });
}

console.log("\n=== FIXTURE SWEEP ===\n");
for (const r of results) {
  const flag = r.unmatched > 0 ? "!" : " ";
  console.log(`${flag} ${r.file}: ${r.filled} filled, ${r.unmatched} unmatched${r.error ? " ERR:" + r.error : ""}`);
  for (const u of r.unmatchedLabels.slice(0, 8)) console.log(`    - ${u}`);
  if (r.unmatchedLabels.length > 8) console.log(`    ... +${r.unmatchedLabels.length - 8} more`);
}

const totalUnmatched = results.reduce((s, r) => s + r.unmatched, 0);
console.log(`\nTotal: ${results.length} fixtures, ${totalUnmatched} unmatched fields\n`);
