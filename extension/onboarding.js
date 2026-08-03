import { apiFetch, checkHealth, setActivePerson } from "./api.js";

const el = (id) => document.getElementById(id);

async function saveConnection() {
  await chrome.storage.local.set({
    baseUrl: el("baseUrl").value.trim() || "http://127.0.0.1:3939",
    token: el("token").value.trim(),
  });
}

el("testConnBtn").addEventListener("click", async () => {
  await saveConnection();
  const statusEl = el("connStatus");
  statusEl.textContent = "Testing...";
  statusEl.className = "status-line";
  const ok = await checkHealth();
  statusEl.textContent = ok
    ? "Connected."
    : "Could not reach the companion service - check the URL and that it's running.";
  statusEl.className = ok ? "status-line ok" : "status-line bad";
});

el("continueBtn").addEventListener("click", async () => {
  const statusEl = el("continueStatus");
  const name = el("personName").value.trim();
  if (!name) {
    statusEl.textContent = "Enter a name first.";
    statusEl.className = "status-line bad";
    return;
  }

  await saveConnection();
  statusEl.textContent = "Setting up...";
  statusEl.className = "status-line";
  try {
    const ok = await checkHealth();
    if (!ok) throw new Error("Could not reach the companion service - check the URL and that it's running.");

    // create_person() is idempotent (just ensures the person's data dirs exist), so this is
    // safe to call even if that name already exists on the backend from another browser.
    const created = await apiFetch("/people", { method: "POST", body: JSON.stringify({ name }) });
    await setActivePerson(created);

    statusEl.textContent = "Done - opening Settings...";
    statusEl.className = "status-line ok";
    chrome.runtime.openOptionsPage();
    setTimeout(() => window.close(), 300);
  } catch (err) {
    statusEl.textContent = `Setup failed: ${err.message}`;
    statusEl.className = "status-line bad";
  }
});
