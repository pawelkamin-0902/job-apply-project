#!/usr/bin/env node
// Test Greenhouse autofill with a custom QA bank file.
// Usage: node test-greenhouse-qa.mjs <form.html> [--qa qa.json]

import fs from "fs";
import path from "path";
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

function setupDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: "https://job-boards.greenhouse.io/newrelic/jobs/5356493008",
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
  dom.window.eval(FIELD_DETECTOR);
  dom.window.eval(RUN_AUTOFILL);

  // jsdom has no React — inject Greenhouse menus on combobox open (portaled to body like live GH).
  const doc = dom.window.document;
  doc.addEventListener(
    "click",
    (e) => {
      const combo = e.target.closest?.('[role="combobox"]') || e.target.closest?.(".select-shell")?.querySelector('[role="combobox"]');
      if (!combo || !combo.closest(".select-shell")) return;
      if (doc.querySelector("body > .select__menu")) return;
      const label = combo.getAttribute("aria-labelledby");
      const labelText = (label && doc.getElementById(label)?.textContent) || "";
      let options = ["Yes", "No"];
      if (combo.closest(".phone-input__country")) {
        options = ["Poland (+48)", "Spain (+34)", "United States (+1)", "Germany (+49)"];
      } else if (/country of residence/i.test(labelText)) {
        options = ["Poland", "Spain", "Germany", "United States"];
      } else if (/^state/i.test(labelText.trim())) {
        options = ["Masovian", "N/A", "California"];
      } else if (/privacy|agree/i.test(labelText)) {
        options = ["I agree", "I do not agree"];
      }
      const menu = doc.createElement("div");
      menu.className = "select__menu";
      menu.setAttribute("role", "listbox");
      for (const opt of options) {
        const div = doc.createElement("div");
        div.className = "select__option";
        div.setAttribute("role", "option");
        div.textContent = opt;
        div.addEventListener("click", () => {
          const shell = combo.closest(".select-shell");
          const valueContainer = shell?.querySelector(".select__value-container");
          if (valueContainer) {
            valueContainer.querySelector(".select__placeholder")?.remove();
            let sv = valueContainer.querySelector(".select__single-value");
            if (!sv) {
              sv = doc.createElement("div");
              sv.className = "select__single-value";
              valueContainer.insertBefore(sv, valueContainer.firstChild);
            }
            sv.textContent = opt;
          }
          const hidden = shell?.querySelector('input[tabindex="-1"]');
          if (hidden) hidden.value = opt;
          combo.setAttribute("aria-expanded", "false");
          menu.remove();
        });
        menu.appendChild(div);
      }
      doc.body.appendChild(menu);
      combo.setAttribute("aria-expanded", "true");
    },
    true
  );

  return dom;
}

function profileFromQa(qaBank) {
  const get = (q) => qaBank.find((e) => e.question === q)?.answer;
  const name = `${get("First Name") || ""} ${get("Last Name") || ""}`.trim();
  return {
    contact: {
      name,
      first_name: get("First Name"),
      last_name: get("Last Name"),
      email: get("Email"),
      phone: get("Phone"),
      linkedin: get("LinkedIn URL") || get("LinkedIn Profile") || get("LinkedIn URL or personal website"),
      location: get("City"),
      city: get("City"),
      address: get("Address"),
      country: get("Current country of residence") || get("Country"),
      state: get("State"),
    },
  };
}

const args = process.argv.slice(2);
const qaIdx = args.indexOf("--qa");
const qaFile = qaIdx >= 0 ? args[qaIdx + 1] : path.join(__dirname, "fixtures/pawel-qa.json");
const htmlFile = args.find((a) => a.endsWith(".html"));
if (!htmlFile) {
  console.error("Usage: node test-greenhouse-qa.mjs <form.html> [--qa qa.json]");
  process.exit(1);
}

const qaBank = JSON.parse(fs.readFileSync(qaFile, "utf8"));
const profile = profileFromQa(qaBank);

const html = fs
  .readFileSync(htmlFile, "utf8")
  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

const dom = setupDom(html);
const { filled, unmatched } = await dom.window.runAutofillInPage(profile, qaBank);

console.log(`\n=== ${path.basename(htmlFile)} (QA: ${path.basename(qaFile)}) ===\n`);
console.log("FILLED:");
for (const f of filled) console.log(`  [${f.source}] ${f.label} -> ${JSON.stringify(f.value)}`);

console.log("\nUNMATCHED:");
for (const u of unmatched) {
  const gen = u.canGenerate ? " (gpt)" : "";
  const opts = u.options?.length ? ` [${u.options.length} opts: ${u.options.slice(0, 4).join(", ")}...]` : "";
  console.log(`  - ${u.label || "(no label)"}${gen}${opts}`);
}

// Check combobox hidden inputs (Greenhouse react-select)
const doc = dom.window.document;
const hiddenInputs = [...doc.querySelectorAll('input.remix-css-1a0ro4n-requiredInput, input[class*="requiredInput"]')];
const comboboxes = [...doc.querySelectorAll('[role="combobox"]')];
console.log("\nCOMBOBOX STATE:");
for (const cb of comboboxes) {
  const label = cb.getAttribute("aria-labelledby");
  const labelEl = label ? doc.getElementById(label) : null;
  const labelText = labelEl?.textContent?.replace(/\*/g, "").trim() || cb.id;
  const singleVal = cb.closest(".select-shell")?.querySelector(".select__single-value")?.textContent?.trim();
  const hidden = cb.closest(".select-shell")?.querySelector('input[tabindex="-1"]')?.value;
  const inputVal = cb.value;
  console.log(`  ${labelText}: single-value="${singleVal || ""}" hidden="${hidden || ""}" input="${inputVal}"`);
}

console.log(`\nSummary: ${filled.length} filled, ${unmatched.length} unmatched, ${comboboxes.length} comboboxes`);
