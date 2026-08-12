import { apiFetch, getActivePerson, setActivePerson } from "./api.js";

const el = (id) => document.getElementById(id);

// ---- date display <-> <input type="month"> conversion ----
// The profile itself still stores/sends plain display strings ("Mar 2022", "Present") -
// exactly what resume generation and rendering already expect - so nothing downstream
// changes. Only the editing widget here is a real month/year picker; these two functions
// are the boundary that converts between the picker's "YYYY-MM" value and that display text.
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAME_TO_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseDisplayDateToMonthValue(text) {
  const m = (text || "").trim().match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (!m) return "";
  const num = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  return num ? `${m[2]}-${String(num).padStart(2, "0")}` : "";
}

function formatMonthValueToDisplay(monthValue) {
  if (!monthValue) return "";
  const [year, month] = monthValue.split("-");
  const name = MONTH_NAMES[parseInt(month, 10) - 1];
  return name ? `${name} ${year}` : "";
}

// Reads a date <input type="month"> back out as display text. If it has a value, that always
// wins (covers both "user picked a month" and "the original text parsed cleanly"). If it's
// blank, that's either a genuinely empty field OR an existing value <input type="month"> simply
// can't represent (e.g. a bare year like "2015", with no month at all) - falling back to
// data-original instead of the picker's blank value means that case is preserved as-is rather
// than silently wiped out the next time the profile is saved.
function readDateInput(monthInputEl) {
  return monthInputEl.value ? formatMonthValueToDisplay(monthInputEl.value) : monthInputEl.dataset.original || "";
}

function isPresent(text) {
  return (text || "").trim().toLowerCase() === "present";
}

// ---- section nav ----
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    el(`section-${btn.dataset.section}`).classList.add("active");
  });
});

// ---- save-state badges: a section starts "Saved", flips to "Unsaved changes" (and enables
// its Save button) the moment anything inside it changes, so it's never ambiguous whether a
// click actually did something. ----
function wireDirtyTracking(sectionEl, badgeEl, saveBtn) {
  const markDirty = () => {
    badgeEl.textContent = "Unsaved changes";
    badgeEl.className = "badge dirty";
    saveBtn.disabled = false;
  };
  const markSaved = () => {
    badgeEl.textContent = "Saved";
    badgeEl.className = "badge saved";
    saveBtn.disabled = true;
  };
  sectionEl.addEventListener("input", markDirty);
  sectionEl.addEventListener("change", markDirty);
  return { markDirty, markSaved };
}

const profileDirty = wireDirtyTracking(el("section-profile"), el("profileBadge"), el("saveProfile"));
const connectionDirty = wireDirtyTracking(el("section-connection"), el("connectionBadge"), el("saveConnection"));
const generationDirty = wireDirtyTracking(el("section-generation"), el("generationBadge"), el("saveSettings"));
const qaDirty = wireDirtyTracking(el("section-qa"), el("qaBadge"), el("saveQaBtn"));
const portalDirty = wireDirtyTracking(el("section-portal"), el("portalBadge"), el("savePortalSettings"));

async function loadConnection() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  el("baseUrl").value = baseUrl || "http://127.0.0.1:3939";
  el("token").value = token || "";
  connectionDirty.markSaved();
}

el("saveConnection").addEventListener("click", async () => {
  await chrome.storage.local.set({
    baseUrl: el("baseUrl").value.trim(),
    token: el("token").value.trim(),
  });
  el("connStatus").textContent = "Saved.";
  connectionDirty.markSaved();
  loadProfile();
  loadSettings();
});

// ---- collapsible experience/education entry cards: each renders as a one-line summary
// (title - company (dates)) with an Edit/Collapse toggle, so a profile with several roles
// stays scannable instead of becoming one long block of always-open forms. ----
function makeEntryCard(body, getSummary, { expanded }) {
  const card = document.createElement("div");
  card.className = "entry-card";

  const summary = document.createElement("div");
  summary.className = "entry-summary";
  const summaryText = document.createElement("span");
  summaryText.className = "entry-summary-text";
  const chevron = document.createElement("span");
  chevron.className = "entry-chevron";
  summary.appendChild(summaryText);
  summary.appendChild(chevron);

  const refreshSummary = () => {
    summaryText.textContent = getSummary();
  };
  const setExpanded = (open) => {
    body.style.display = open ? "" : "none";
    chevron.textContent = open ? "▾" : "▸";
    summary.setAttribute("aria-expanded", String(open));
  };

  // The whole header row toggles, not just a small button - a bigger, more obvious
  // click target than a tiny "Edit"/"Collapse" button off to the side.
  summary.addEventListener("click", () => setExpanded(body.style.display === "none"));
  body.addEventListener("input", refreshSummary);

  refreshSummary();
  setExpanded(expanded);

  card.appendChild(summary);
  card.appendChild(body);
  return card;
}

// Wires the "Currently..." checkbox for an end-date field: checked hides the month picker
// (the role/degree is ongoing, so there's no end month to pick) and forces the display value
// to "Present" at save time; unchecked shows the picker. Shared between experience/education.
function wireEndDateToggle(body, monthSelector, checkboxSelector) {
  const monthInput = body.querySelector(monthSelector);
  const checkbox = body.querySelector(checkboxSelector);
  const apply = () => {
    monthInput.style.display = checkbox.checked ? "none" : "";
  };
  checkbox.addEventListener("change", apply);
  apply();
}

function experienceRow(entry = {}, { expanded = false } = {}) {
  const body = document.createElement("div");
  body.className = "entry-row entry-body";
  const endIsPresent = isPresent(entry.end_date);
  body.innerHTML = `
    <label>Job title</label>
    <input class="exp-title" placeholder="e.g. Senior Software Engineer" value="${entry.title || ""}">
    <label>Company</label>
    <input class="exp-company" placeholder="e.g. Acme Corp" value="${entry.company || ""}">
    <label>Location (optional)</label>
    <input class="exp-location" placeholder="e.g. Warsaw, Poland (Remote)" value="${entry.location || ""}">
    <label>Start date</label>
    <input type="month" class="exp-start" value="${parseDisplayDateToMonthValue(entry.start_date)}" data-original="${entry.start_date || ""}">
    <label>End date</label>
    <label class="checkbox-label">
      <input type="checkbox" class="exp-end-current" ${endIsPresent ? "checked" : ""}>
      Currently working here
    </label>
    <input type="month" class="exp-end" value="${endIsPresent ? "" : parseDisplayDateToMonthValue(entry.end_date)}" data-original="${endIsPresent ? "" : entry.end_date || ""}">
    <label>Key accomplishments (one per line)</label>
    <p class="hint">
      What you actually did, concretely - the tools/tech you used and the outcome if you know it.
      e.g. "Built a payments API in Python and FastAPI handling ~10k requests/day". This is the real
      source material the AI tailors from, so detail and honesty here directly shape what gets generated.
    </p>
    <textarea class="exp-bullets" placeholder="One accomplishment per line" rows="4">${(entry.bullets || []).join("\n")}</textarea>
    <button type="button" class="remove-row btn-danger">Remove</button>
  `;
  wireEndDateToggle(body, ".exp-end", ".exp-end-current");

  const card = makeEntryCard(
    body,
    () => {
      const title = body.querySelector(".exp-title").value.trim() || "(untitled role)";
      const company = body.querySelector(".exp-company").value.trim() || "(company)";
      const start = readDateInput(body.querySelector(".exp-start"));
      const end = body.querySelector(".exp-end-current").checked ? "Present" : readDateInput(body.querySelector(".exp-end"));
      const dates = start || end ? ` (${start || "?"} - ${end || "?"})` : "";
      return `${title} - ${company}${dates}`;
    },
    { expanded }
  );
  body.querySelector(".remove-row").addEventListener("click", () => {
    card.remove();
    profileDirty.markDirty();
  });
  return card;
}

function educationRow(entry = {}, { expanded = false } = {}) {
  const body = document.createElement("div");
  body.className = "entry-row entry-body";
  const endIsPresent = isPresent(entry.end_date);
  body.innerHTML = `
    <label>School</label>
    <input class="edu-school" placeholder="e.g. University of Oulu" value="${entry.school || ""}">
    <label>Degree</label>
    <input class="edu-degree" placeholder="e.g. Bachelor's in Computer Science" value="${entry.degree || ""}">
    <label>Location (optional)</label>
    <input class="edu-location" placeholder="e.g. Oulu, Finland" value="${entry.location || ""}">
    <label>Start date</label>
    <input type="month" class="edu-start" value="${parseDisplayDateToMonthValue(entry.start_date)}" data-original="${entry.start_date || ""}">
    <label>End date</label>
    <label class="checkbox-label">
      <input type="checkbox" class="edu-end-current" ${endIsPresent ? "checked" : ""}>
      Currently studying here
    </label>
    <input type="month" class="edu-end" value="${endIsPresent ? "" : parseDisplayDateToMonthValue(entry.end_date)}" data-original="${endIsPresent ? "" : entry.end_date || ""}">
    <button type="button" class="remove-row btn-danger">Remove</button>
  `;
  wireEndDateToggle(body, ".edu-end", ".edu-end-current");

  const card = makeEntryCard(
    body,
    () => {
      const school = body.querySelector(".edu-school").value.trim() || "(school)";
      const degree = body.querySelector(".edu-degree").value.trim();
      const start = readDateInput(body.querySelector(".edu-start"));
      const end = body.querySelector(".edu-end-current").checked ? "Present" : readDateInput(body.querySelector(".edu-end"));
      const dates = start || end ? ` (${start || "?"} - ${end || "?"})` : "";
      return degree ? `${school} - ${degree}${dates}` : `${school}${dates}`;
    },
    { expanded }
  );
  body.querySelector(".remove-row").addEventListener("click", () => {
    card.remove();
    profileDirty.markDirty();
  });
  return card;
}

el("addExperience").addEventListener("click", () => {
  el("experienceList").appendChild(experienceRow({}, { expanded: true }));
  profileDirty.markDirty();
});
el("addEducation").addEventListener("click", () => {
  el("educationList").appendChild(educationRow({}, { expanded: true }));
  profileDirty.markDirty();
});

async function loadProfile() {
  try {
    const profile = await apiFetch("/profile");
    el("name").value = profile.contact.name || "";
    el("email").value = profile.contact.email || "";
    el("phone").value = profile.contact.phone || "";
    el("location").value = profile.contact.location || "";
    el("linkedin").value = profile.contact.linkedin || "";
    el("website").value = profile.contact.website || "";
    el("streetAddress").value = profile.contact.street_address || "";
    el("city").value = profile.contact.city || "";
    el("postalCode").value = profile.contact.postal_code || "";
    el("state").value = profile.contact.state || "";
    el("country").value = profile.contact.country || "";
    el("summary").value = profile.summary || "";
    el("skills").value = (profile.skills || []).join(", ");
    el("experienceList").innerHTML = "";
    (profile.experience || []).forEach((e) => el("experienceList").appendChild(experienceRow(e)));
    el("educationList").innerHTML = "";
    (profile.education || []).forEach((e) => el("educationList").appendChild(educationRow(e)));
    el("profileStatus").textContent = "";
    profileDirty.markSaved();
  } catch (err) {
    el("profileStatus").textContent = `Could not load profile: ${err.message}`;
  }
}

el("saveProfile").addEventListener("click", async () => {
  const experience = [...document.querySelectorAll("#experienceList .entry-row")].map((row) => ({
    title: row.querySelector(".exp-title").value.trim(),
    company: row.querySelector(".exp-company").value.trim(),
    location: row.querySelector(".exp-location").value.trim() || null,
    start_date: readDateInput(row.querySelector(".exp-start")),
    end_date: row.querySelector(".exp-end-current").checked ? "Present" : readDateInput(row.querySelector(".exp-end")),
    bullets: row
      .querySelector(".exp-bullets")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
  const education = [...document.querySelectorAll("#educationList .entry-row")].map((row) => ({
    school: row.querySelector(".edu-school").value.trim(),
    degree: row.querySelector(".edu-degree").value.trim(),
    location: row.querySelector(".edu-location").value.trim() || null,
    start_date: readDateInput(row.querySelector(".edu-start")) || null,
    end_date: row.querySelector(".edu-end-current").checked
      ? "Present"
      : readDateInput(row.querySelector(".edu-end")) || null,
  }));
  const profile = {
    contact: {
      name: el("name").value.trim(),
      email: el("email").value.trim(),
      phone: el("phone").value.trim() || null,
      location: el("location").value.trim() || null,
      linkedin: el("linkedin").value.trim() || null,
      website: el("website").value.trim() || null,
      street_address: el("streetAddress").value.trim() || null,
      city: el("city").value.trim() || null,
      postal_code: el("postalCode").value.trim() || null,
      state: el("state").value.trim() || null,
      country: el("country").value.trim() || null,
    },
    summary: el("summary").value.trim(),
    experience,
    education,
    skills: el("skills")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  try {
    await apiFetch("/profile", { method: "PUT", body: JSON.stringify(profile) });
    el("profileStatus").textContent = "Profile saved.";
    profileDirty.markSaved();
  } catch (err) {
    el("profileStatus").textContent = `Save failed: ${err.message}`;
  }
});

// Mode and both provider choices are edited in the side panel now (see sidepanel.js/html) -
// this page only shows/tests whatever's currently saved. The claude/ollama/gpt config fields
// below need to show whenever EITHER provider needs them, not just one.
function applyProviderFieldVisibility() {
  const providers = [loadedSettings?.provider, loadedSettings?.answer_provider];
  el("claudeFields").style.display = providers.includes("claude") ? "" : "none";
  el("ollamaFields").style.display = providers.includes("ollama") ? "" : "none";
  el("gptHint").style.display = providers.includes("gpt") ? "" : "none";
  el("gptAutoHint").style.display = providers.includes("gpt-auto") || providers.includes("gpt-auto-headless") ? "" : "none";
  el("gptAutoHeadlessHint").style.display = providers.includes("gpt-auto-headless") ? "" : "none";
}

async function testProvider(provider, statusEl) {
  statusEl.textContent = "Testing...";
  statusEl.className = "status-line";
  // Always send whatever's currently in the form for the model/URL fields — tests those
  // pending edits even if you haven't clicked "Save settings" yet.
  const body = {
    provider,
    claude_model: el("claudeModel").value.trim() || null,
    ollama_model: el("ollamaModel").value.trim() || "qwen2.5:3b-instruct",
    ollama_base_url: el("ollamaBaseUrl").value.trim() || "http://localhost:11434",
  };
  try {
    const result = await apiFetch("/provider-test", { method: "POST", body: JSON.stringify(body) });
    statusEl.textContent = result.detail;
    statusEl.className = result.ok ? "status-line ok" : "status-line bad";
  } catch (err) {
    statusEl.textContent = `Test failed: ${err.message}`;
    statusEl.className = "status-line bad";
  }
}

el("testProviderBtn").addEventListener("click", () =>
  testProvider(loadedSettings?.provider || "claude", el("providerTestStatus"))
);
el("testAnswerProviderBtn").addEventListener("click", () =>
  testProvider(loadedSettings?.answer_provider || "ollama", el("answerProviderTestStatus"))
);

let loadedSettings = null;

// Prompt instructions are per-person (see store.get_prompt_instructions) - loaded/saved via
// their own endpoint, separately from the rest of Settings, which is still global.
async function loadPromptInstructions() {
  try {
    const { instructions } = await apiFetch("/prompt-instructions");
    el("promptInstructions").value = instructions || "";
    generationDirty.markSaved();
  } catch (err) {
    el("settingsStatus").textContent = `Could not load prompt instructions: ${err.message}`;
  }
}

// ---- Templates tab: a card per available template (thumbnail + name + description), radio-
// selected. The catalog itself (/resume-templates) is the same for everyone, so it's only
// fetched once; which one is active is per-person, refetched on every person switch. Selecting
// a card saves immediately - no separate Save button, matching the side panel's quick-switch
// selects rather than the rest of this page's dirty-tracked forms, since it's a single choice
// rather than a multi-field form.
let templateCatalogLoaded = false;

async function loadTemplateCatalog() {
  if (templateCatalogLoaded) return;
  try {
    const templates = await apiFetch("/resume-templates");
    const grid = el("templateGrid");
    grid.innerHTML = "";
    templates.forEach((t) => {
      const card = document.createElement("label");
      card.className = "template-card";
      card.innerHTML = `
        <input type="radio" name="resumeTemplate" value="${t.key}">
        <img src="assets/templates/${t.key}.png" alt="${t.name} template preview" title="Click to view full size">
        <div class="template-name">${t.name}</div>
        <div class="template-desc">${t.description}</div>
        <button type="button" class="link template-zoom-btn">View full size</button>
      `;
      card.querySelector("input").addEventListener("change", async (e) => {
        const statusEl = el("templateStatus");
        statusEl.textContent = "Saving...";
        try {
          await apiFetch("/resume-template", { method: "PUT", body: JSON.stringify({ template: e.target.value }) });
          statusEl.textContent = `Template set to ${t.name}.`;
        } catch (err) {
          statusEl.textContent = `Could not save: ${err.message}`;
        }
      });
      // Full page at 200 DPI, not the cropped/downscaled grid thumbnail - opens in a new tab
      // so you can actually zoom in and check exact formatting before picking one.
      const openFullSize = (e) => {
        e.preventDefault();
        window.open(`assets/templates/${t.key}-full.png`, "_blank");
      };
      card.querySelector("img").addEventListener("click", openFullSize);
      card.querySelector(".template-zoom-btn").addEventListener("click", openFullSize);
      grid.appendChild(card);
    });
    templateCatalogLoaded = true;
  } catch (err) {
    el("templateStatus").textContent = `Could not load templates: ${err.message}`;
  }
}

async function loadActiveTemplate() {
  await loadTemplateCatalog();
  try {
    const { template } = await apiFetch("/resume-template");
    const input = el("templateGrid").querySelector(`input[value="${template}"]`);
    if (input) input.checked = true;
    el("templateStatus").textContent = "";
  } catch (err) {
    el("templateStatus").textContent = `Could not load active template: ${err.message}`;
  }
}

async function loadSettings() {
  try {
    const settings = await apiFetch("/settings");
    loadedSettings = settings;
    el("applyRoot").value = settings.apply_root_dir || "";
    el("claudeModel").value = settings.claude_model || "";
    el("ollamaModel").value = settings.ollama_model || "";
    el("ollamaBaseUrl").value = settings.ollama_base_url || "";
    el("portalBaseUrl").value = settings.portal_base_url || "";
    el("portalUsername").value = settings.portal_username || "";
    el("portalPassword").value = settings.portal_password || "";
    el("timeoutSeconds").value = settings.timeout_seconds ?? 120;
    applyProviderFieldVisibility();
    el("settingsStatus").textContent = "";
    el("portalSettingsStatus").textContent = "";
    generationDirty.markSaved();
    portalDirty.markSaved();
    return settings;
  } catch (err) {
    el("settingsStatus").textContent = `Could not load settings: ${err.message}`;
    return null;
  }
}

function buildSettingsPayload() {
  return {
    // Both providers are edited in the side panel, not here (see sidepanel.js) - same
    // reasoning as `person` below: carry forward whatever's currently saved rather than
    // reading a control that no longer exists on this page. Mode (tailor_mode) isn't part of
    // this payload at all anymore - it's per-person now, saved via its own /tailor-mode
    // endpoint (see applyTailorMode/store.get_tailor_mode), not bundled into Settings.
    provider: loadedSettings?.provider || "claude",
    answer_provider: loadedSettings?.answer_provider || "ollama",
    delete_gpt_conversations: loadedSettings?.delete_gpt_conversations ?? true,
    apply_root_dir: el("applyRoot").value.trim(),
    // `person` here is only the server-wide fallback used for direct API/curl calls
    // with no X-Person header - this browser's own active person lives in its local
    // storage instead (see loadPeople/switchActivePerson) and must never be clobbered
    // by whatever this one browser happens to have open in the dropdown.
    person: loadedSettings?.person || "me",
    claude_model: el("claudeModel").value.trim() || null,
    ollama_model: el("ollamaModel").value.trim() || "qwen2.5:3b-instruct",
    ollama_base_url: el("ollamaBaseUrl").value.trim() || "http://localhost:11434",
    portal_base_url: el("portalBaseUrl").value.trim(),
    // Confirmed live: these two were missing here entirely - since PUT /settings replaces the
    // WHOLE settings object (not a partial patch), every save (from either tab, not just this
    // one) silently wiped portal_username/portal_password back to "" immediately afterward,
    // even right after typing them in and clicking "Save Portal settings" itself.
    portal_username: el("portalUsername").value.trim(),
    portal_password: el("portalPassword").value,
    // Edited in the side panel now (right next to "Save & Sync to Portal"), not here - same
    // carry-forward reasoning as `person`/both providers above, so a save from this page can't
    // silently reset it back to the schema default.
    portal_headless: loadedSettings?.portal_headless ?? true,
    timeout_seconds: parseFloat(el("timeoutSeconds").value) || 120.0,
  };
}

el("saveSettings").addEventListener("click", async () => {
  const statusEl = el("settingsStatus");
  try {
    await Promise.all([
      apiFetch("/settings", { method: "PUT", body: JSON.stringify(buildSettingsPayload()) }),
      apiFetch("/prompt-instructions", {
        method: "PUT",
        body: JSON.stringify({ instructions: el("promptInstructions").value }),
      }),
    ]);
    statusEl.textContent = "Saved.";
    generationDirty.markSaved();
  } catch (err) {
    statusEl.textContent = `Save failed: ${err.message}`;
  }
});

el("savePortalSettings").addEventListener("click", async () => {
  const statusEl = el("portalSettingsStatus");
  try {
    await apiFetch("/settings", { method: "PUT", body: JSON.stringify(buildSettingsPayload()) });
    statusEl.textContent = "Saved.";
    portalDirty.markSaved();
  } catch (err) {
    statusEl.textContent = `Save failed: ${err.message}`;
  }
});

// The dropdown here picks which person THIS browser is pinned to. That choice lives
// only in this browser's local storage (see api.js getActivePerson/setActivePerson) and
// is sent as the X-Person header on every API call - it is never written to the shared
// /settings, so switching it here can't affect any other browser talking to the same
// companion service.
async function loadPeople(selectName) {
  const select = el("personSelect");
  try {
    const [people, current] = await Promise.all([apiFetch("/people"), getActivePerson()]);
    const active = selectName || current || people[0] || "me";
    select.innerHTML = "";
    const names = people.includes(active) ? people : [...people, active];
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    select.value = active;
    if (active !== current) await setActivePerson(active);
    el("personStatus").textContent = `This browser is set to: ${active}`;
  } catch (err) {
    el("personStatus").textContent = `Could not load profiles: ${err.message}`;
  }
}

async function switchActivePerson(name) {
  el("personStatus").textContent = "Switching...";
  try {
    await setActivePerson(name);
    await Promise.all([loadProfile(), loadResumes(), loadQa(), loadPromptInstructions(), loadActiveTemplate()]);
    el("personStatus").textContent = `This browser is set to: ${name}`;
  } catch (err) {
    el("personStatus").textContent = `Switch failed: ${err.message}`;
  }
}

el("personSelect").addEventListener("change", () => switchActivePerson(el("personSelect").value));

el("newPersonBtn").addEventListener("click", async () => {
  const name = prompt("Name for the new profile (e.g. a friend's name):");
  if (!name || !name.trim()) return;
  try {
    const created = await apiFetch("/people", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    await loadPeople(created);
    await switchActivePerson(created);
  } catch (err) {
    el("personStatus").textContent = `Create failed: ${err.message}`;
  }
});

el("deletePersonBtn").addEventListener("click", async () => {
  const name = el("personSelect").value;
  if (!name) return;
  if (!confirm(`Delete the profile "${name}"? This removes their contact info, work history, learned answers, and uploaded resumes. This cannot be undone.`)) {
    return;
  }
  try {
    await apiFetch(`/people/${encodeURIComponent(name)}`, { method: "DELETE" });
    const remaining = await apiFetch("/people");
    const next = remaining[0] || "me";
    await loadPeople(next);
    await switchActivePerson(next);
  } catch (err) {
    el("personStatus").textContent = `Delete failed: ${err.message}`;
  }
});

function resumeRow(entry) {
  const div = document.createElement("div");
  div.className = "entry-row";
  div.innerHTML = `
    <strong>${entry.stack}</strong> - ${entry.filename}
    <button type="button" class="remove-row btn-danger">Delete</button>
  `;
  div.querySelector(".remove-row").addEventListener("click", async () => {
    try {
      await apiFetch(`/resumes/${entry.id}`, { method: "DELETE" });
      loadResumes();
    } catch (err) {
      el("resumeStatus").textContent = `Delete failed: ${err.message}`;
    }
  });
  return div;
}

async function loadResumes() {
  try {
    const resumes = await apiFetch("/resumes");
    el("resumeList").innerHTML = "";
    if (!resumes.length) {
      el("resumeList").innerHTML = '<p class="hint">No resumes uploaded yet.</p>';
    }
    resumes.forEach((entry) => el("resumeList").appendChild(resumeRow(entry)));
  } catch (err) {
    el("resumeStatus").textContent = `Could not load resumes: ${err.message}`;
  }
}

el("uploadResumeBtn").addEventListener("click", async () => {
  const stack = el("resumeStack").value.trim();
  const file = el("resumeFile").files[0];
  if (!stack || !file) {
    el("resumeStatus").textContent = "Pick a file and enter a stack label first.";
    return;
  }
  el("resumeStatus").textContent = "Uploading...";
  el("uploadResumeBtn").disabled = true;
  try {
    const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
    const activePerson = await getActivePerson();
    const formData = new FormData();
    formData.append("file", file);
    formData.append("stack", stack);
    const res = await fetch(`${baseUrl}/resumes`, {
      method: "POST",
      headers: { "X-Api-Token": token, "X-Person": activePerson },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    el("resumeStack").value = "";
    el("resumeFile").value = "";
    el("resumeStatus").textContent = "Uploaded.";
    loadResumes();
  } catch (err) {
    el("resumeStatus").textContent = `Upload failed: ${err.message}`;
  } finally {
    el("uploadResumeBtn").disabled = false;
  }
});

// Real, common default answers worth seeding for a new profile — never generated by AI,
// these are exactly the kind of stable personal facts/preferences that belong in the QA
// bank so Auto Fill can reuse them instead of leaving every application's boilerplate
// questions for you to answer by hand each time. Appended to the editable list below, not
// saved automatically — you review (and can freely edit or remove any of them) before
// clicking Save.
const DEFAULT_QA = [
  { question: "Have you ever worked at this company before?", answer: "No" },
  { question: "Are you currently working at this company?", answer: "No" },
  { question: "Do you have any relatives employed by this company?", answer: "No" },
  { question: "Have you ever lived in the US for more than 6 months?", answer: "No" },
  { question: "Have you ever lived in Canada for more than 6 months?", answer: "No" },
  { question: "Are you eligible to work in this country?", answer: "Yes" },
  { question: "Will you now or in the future require sponsorship for this role?", answer: "No" },
  // Salary / notice intentionally omitted — form-specific (currency, monthly vs yearly, days
  // vs date); Auto Fill asks GPT per field and Learn never saves those answers.
  { question: "What is your nationality?", answer: "Polish" },
  { question: "What is your race or ethnicity?", answer: "White" },
  { question: "What is your sexual orientation?", answer: "Straight / heterosexual" },
  { question: "Do you identify as transgender?", answer: "No" },
  { question: "Do you have a disability?", answer: "No disability" },
  { question: "Are you a veteran?", answer: "Not a veteran" },
];

// `qaEntries` (not the DOM) is the source of truth once loaded — with search + pagination,
// only a slice of it is ever actually rendered at once, so scraping visible rows at Save
// time (the old approach) would silently drop anything off the current page or filtered out
// by a search term. Edits to a rendered row's inputs write straight back into this array;
// Save always sends the whole thing, not just what's currently on screen.
let qaEntries = [];
let qaSearchTerm = "";
let qaPage = 0;
const QA_PAGE_SIZE = 8;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function qaSummaryText(entry) {
  const q = (entry.question || "").trim() || "(no question yet)";
  const a = (entry.answer || "").trim();
  const shortA = a.length > 50 ? `${a.slice(0, 50)}…` : a;
  return a ? `${q} — ${shortA}` : q;
}

function qaRow(entry, index) {
  const body = document.createElement("div");
  body.className = "entry-row entry-body";
  body.innerHTML = `
    <label>Question (matched by wording against each form's field)</label>
    <input class="qa-question" placeholder="e.g. Do you require visa sponsorship?" value="${escapeHtml(entry.question)}">
    <label>Answer</label>
    <textarea class="qa-answer" rows="2" placeholder="e.g. No">${escapeHtml(entry.answer)}</textarea>
    <button type="button" class="remove-row btn-danger">Remove</button>
  `;
  const questionInput = body.querySelector(".qa-question");
  const answerInput = body.querySelector(".qa-answer");
  const card = makeEntryCard(body, () => qaSummaryText(qaEntries[index] || entry), { expanded: false });

  questionInput.addEventListener("input", () => {
    qaEntries[index].question = questionInput.value;
  });
  answerInput.addEventListener("input", () => {
    qaEntries[index].answer = answerInput.value;
  });
  body.querySelector(".remove-row").addEventListener("click", () => {
    qaEntries.splice(index, 1);
    qaDirty.markDirty();
    renderQaList();
  });
  return card;
}

// Search filters against the full set before pagination slices it, and carries each match's
// real index in `qaEntries` along with it — needed so edits/removals on a filtered/paginated
// view still land on the right entry rather than whatever happens to be at that position in
// the page currently being displayed.
function qaFilteredWithIndex() {
  const withIndex = qaEntries.map((entry, originalIndex) => ({ entry, originalIndex }));
  if (!qaSearchTerm) return withIndex;
  const term = qaSearchTerm.toLowerCase();
  return withIndex.filter(
    ({ entry }) => (entry.question || "").toLowerCase().includes(term) || (entry.answer || "").toLowerCase().includes(term)
  );
}

function renderQaList() {
  const filtered = qaFilteredWithIndex();
  const totalPages = Math.max(1, Math.ceil(filtered.length / QA_PAGE_SIZE));
  qaPage = Math.min(Math.max(qaPage, 0), totalPages - 1);
  const start = qaPage * QA_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + QA_PAGE_SIZE);

  el("qaList").innerHTML = "";
  if (!pageItems.length) {
    el("qaList").innerHTML = `<p class="hint">${
      qaEntries.length
        ? "No answers match your search."
        : 'No saved answers yet — click "+ Add answer" or "+ Add common defaults" below.'
    }</p>`;
  } else {
    pageItems.forEach(({ entry, originalIndex }) => el("qaList").appendChild(qaRow(entry, originalIndex)));
  }

  el("qaPageInfo").textContent = filtered.length
    ? `Page ${qaPage + 1} of ${totalPages} — ${filtered.length} answer${filtered.length === 1 ? "" : "s"}${
        qaSearchTerm && filtered.length !== qaEntries.length ? ` matched (of ${qaEntries.length} total)` : ""
      }`
    : "";
  el("qaPrevBtn").disabled = qaPage <= 0;
  el("qaNextBtn").disabled = qaPage >= totalPages - 1;
}

el("qaSearch").addEventListener("input", (event) => {
  // Searching isn't an edit — stop this "input" event from bubbling up to the section-wide
  // dirty-tracking listener, which would otherwise incorrectly flip the tab to "Unsaved
  // changes" (and enable Save) just from typing a search term.
  event.stopPropagation();
  qaSearchTerm = el("qaSearch").value.trim();
  qaPage = 0;
  renderQaList();
});
el("qaPrevBtn").addEventListener("click", () => {
  qaPage = Math.max(0, qaPage - 1);
  renderQaList();
});
el("qaNextBtn").addEventListener("click", () => {
  qaPage += 1;
  renderQaList();
});

el("addQaBtn").addEventListener("click", () => {
  qaEntries.push({ question: "", answer: "" });
  qaDirty.markDirty();
  qaSearchTerm = "";
  el("qaSearch").value = "";
  qaPage = Math.max(0, Math.ceil(qaEntries.length / QA_PAGE_SIZE) - 1); // jump to the page the new entry lands on
  renderQaList();
});

el("addDefaultQaBtn").addEventListener("click", () => {
  qaEntries.push(...DEFAULT_QA.map((e) => ({ ...e })));
  qaDirty.markDirty();
  renderQaList();
});

async function loadQa() {
  try {
    qaEntries = await apiFetch("/qa");
    qaSearchTerm = "";
    el("qaSearch").value = "";
    qaPage = 0;
    renderQaList();
    el("qaStatus").textContent = "";
    qaDirty.markSaved();
  } catch (err) {
    el("qaStatus").textContent = `Could not load Q&A: ${err.message}`;
  }
}

el("saveQaBtn").addEventListener("click", async () => {
  const entries = qaEntries
    .map((e) => ({ question: (e.question || "").trim(), answer: (e.answer || "").trim() }))
    .filter((e) => e.question && e.answer);
  try {
    await apiFetch("/qa", { method: "PUT", body: JSON.stringify(entries) });
    el("qaStatus").textContent = "Saved.";
    qaDirty.markSaved();
    loadQa();
  } catch (err) {
    el("qaStatus").textContent = `Save failed: ${err.message}`;
  }
});

loadConnection().then(async () => {
  await loadSettings();
  await loadPeople();
  loadProfile();
  loadResumes();
  loadQa();
  loadPromptInstructions();
  loadActiveTemplate();
});
