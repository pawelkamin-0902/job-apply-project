#!/usr/bin/env node
// Inventory Save Sample captures grouped by ATS platform.
// Usage: node tools/platform-inventory.mjs [captured-dir]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.join(__dirname, "../extension/test-forms/captured");
const mountDir = "/mnt/hgfs/auto-apply/job-apply-project/extension/test-forms/captured";

const PLATFORMS = [
  { id: "greenhouse", label: "Greenhouse", patterns: [/greenhouse/i, /boards\.greenhouse/i] },
  { id: "workday", label: "Workday", patterns: [/workday/i, /wd\d+\.myworkday/i] },
  { id: "lever", label: "Lever", patterns: [/lever\.co/i, /jobs\.lever/i] },
  { id: "smartrecruiters", label: "SmartRecruiters", patterns: [/smartrecruiters/i] },
  { id: "ashby", label: "Ashby", patterns: [/ashbyhq/i, /jobs\.ashby/i] },
  { id: "bamboohr", label: "BambooHR", patterns: [/bamboohr/i] },
  { id: "teamtailor", label: "Teamtailor", patterns: [/teamtailor/i] },
  { id: "workable", label: "Workable", patterns: [/workable/i] },
  { id: "peopleforce", label: "PeopleForce", patterns: [/peopleforce/i] },
  { id: "successfactors", label: "SAP SuccessFactors", patterns: [/sapsf/i, /successfactors/i] },
  { id: "zoho", label: "Zoho Recruit", patterns: [/zohorecruit/i, /zoho/i] },
  { id: "rippling", label: "Rippling", patterns: [/rippling/i] },
  { id: "hibob", label: "HiBob", patterns: [/hibob/i] },
  { id: "icims", label: "iCIMS", patterns: [/icims/i] },
  { id: "recruitee", label: "Recruitee", patterns: [/recruitee/i] },
  { id: "comeet", label: "Comeet", patterns: [/comeet/i] },
  { id: "other", label: "Other / unclassified", patterns: [] },
];

const TIER1 = new Set(["greenhouse", "workday", "lever", "smartrecruiters", "ashby", "bamboohr", "teamtailor"]);

function classify(text) {
  const t = String(text || "").toLowerCase();
  for (const p of PLATFORMS) {
    if (p.id === "other") continue;
    if (p.patterns.some((re) => re.test(t))) return p.id;
  }
  return "other";
}

function resolveDir(arg) {
  if (arg && fs.existsSync(arg)) return arg;
  if (fs.existsSync(mountDir)) return mountDir;
  return defaultDir;
}

function main() {
  const dir = resolveDir(process.argv[2]);
  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const htmlCount = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).length;
  const seen = new Set();
  const byPlatform = new Map(PLATFORMS.map((p) => [p.id, []]));

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const base = file.replace(/\.json$/, "").replace(/-frame\d+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    let url = base;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      url = `${data.page_url || ""} ${data.frame_url || ""} ${base}`;
    } catch {
      /* use filename */
    }
    const id = classify(url);
    byPlatform.get(id).push(base);
  }

  const unique = seen.size;
  const tier1Count = [...TIER1].reduce((n, id) => n + (byPlatform.get(id)?.length || 0), 0);

  console.log(`\nCapture inventory: ${dir}`);
  console.log(`  HTML files (incl. frames): ${htmlCount}`);
  console.log(`  Unique pages (json deduped):  ${unique}`);
  console.log(`  Tier-1 major ATS pages:       ${tier1Count} (${Math.round((100 * tier1Count) / unique)}%)\n`);

  console.log("| Platform | Tier | Samples |");
  console.log("|----------|------|--------:|");
  for (const p of PLATFORMS) {
    if (p.id === "other") continue;
    const n = byPlatform.get(p.id).length;
    if (!n) continue;
    const tier = TIER1.has(p.id) ? "**1**" : "2";
    console.log(`| ${p.label} | ${tier} | ${n} |`);
  }
  const otherN = byPlatform.get("other").length;
  console.log(`| Other / unclassified | 2 | ${otherN} |`);
  console.log("");

  const listId = process.argv.find((a) => a.startsWith("--list="))?.slice(7);
  if (listId && byPlatform.has(listId)) {
    console.log(`\n${listId} captures:\n`);
    for (const b of byPlatform.get(listId).sort()) console.log(`  ${b}`);
  }
}

main();
