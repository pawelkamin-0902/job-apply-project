#!/usr/bin/env node
// Detection-only test: loads field-detector.js (same as the extension) into jsdom.
// Usage: node test-detect.mjs path/to/form.html

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIELD_DETECTOR = fs.readFileSync(
  path.join(__dirname, "../extension/field-detector.js"),
  "utf8"
);

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
  const ctx = dom.window;
  ctx.eval(FIELD_DETECTOR);
  return dom;
}

function summarize(dom) {
  const { groups, singles, loneCheckboxes } = dom.window.collectFormFields();
  const rows = [];
  for (const g of groups) {
    rows.push({
      kind: g.kind,
      label: g.label,
      required: g.required ?? null,
      options: g.options?.map((o) => o.optionLabel).slice(0, 6),
    });
  }
  for (const { element, host } of singles) {
    const label = dom.window.labelForElement(element, host);
    rows.push({
      kind: element.tagName.toLowerCase() + (element.type ? `[${element.type}]` : ""),
      label,
      required: dom.window.isRequiredField?.(element, host) ?? null,
    });
  }
  for (const { element } of loneCheckboxes) {
    const label = dom.window.labelForElement(element, element);
    rows.push({ kind: "lone-checkbox", label });
  }
  return rows;
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test-detect.mjs <file.html>");
  process.exit(1);
}
const html = fs.readFileSync(file, "utf8");
const dom = setupDom(html);
const rows = summarize(dom);
console.log(`\n=== ${path.basename(file)} — ${rows.length} field(s) ===\n`);
for (const r of rows) {
  const opts = r.options?.length ? ` [${r.options.join(" | ")}]` : "";
  const req = r.required ? " *" : "";
  console.log(`  [${r.kind}]${req} ${r.label || "(no label)"}${opts}`);
}
