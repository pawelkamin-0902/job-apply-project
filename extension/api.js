const DEFAULT_BASE_URL = "http://127.0.0.1:3939";
// plain fetch() has no timeout of its own - if the companion service (or the Claude/Ollama
// call inside it) ever hangs instead of erroring, an un-bounded fetch just sits forever with
// no error and no way to notice. This ceiling sits comfortably above the backend's own
// generation timeout (120s default) so a genuinely stuck request still resolves with a clear
// message instead of leaving the UI stuck on "Generating..." forever.
const DEFAULT_TIMEOUT_MS = 240000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the companion service - check its console window for errors.`);
    }
    throw new Error(`Could not reach the companion service: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// This browser install's fixed person, kept only in this browser's local storage -
// never sent to /settings - so multiple browsers sharing one companion service each
// stay pinned to their own profile regardless of what any other browser does.
export async function getActivePerson() {
  const { activePerson } = await chrome.storage.local.get(["activePerson"]);
  return activePerson || "";
}

export async function setActivePerson(name) {
  await chrome.storage.local.set({ activePerson: name || "" });
}

export async function getConnection() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  return { baseUrl: baseUrl || DEFAULT_BASE_URL, token: token || "" };
}

export async function apiFetch(path, options = {}) {
  const { baseUrl, token } = await getConnection();
  const activePerson = await getActivePerson();
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Token": token,
    "X-Person": activePerson,
    ...(options.headers || {}),
  };
  const res = await fetchWithTimeout(`${baseUrl}${path}`, { ...options, headers }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function fetchResumeFileBase64(resumeId) {
  const { baseUrl, token } = await getConnection();
  const activePerson = await getActivePerson();
  const res = await fetchWithTimeout(
    `${baseUrl}/resumes/${resumeId}/file`,
    { headers: { "X-Api-Token": token, "X-Person": activePerson } },
    DEFAULT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  const disposition = res.headers.get("content-disposition") || "";
  // Starlette/FastAPI emit ONLY `filename*=utf-8''...` (no plain filename=) when the name
  // contains spaces/non-ASCII — confirmed: "Stefan Iacob.pdf" →
  // `attachment; filename*=utf-8''Stefan%20Iacob.pdf`. The old `/filename="?([^"]+)"?/` regex
  // missed that form entirely (it does not match `filename*=`), so Attach fell back to the
  // bare name "resume" with no extension. Profiles whose uploaded files had no spaces in the
  // filename still worked because those got a quoted `filename="..."`. Parse RFC 5987
  // filename* first, then quoted/plain filename=.
  let filename = parseContentDispositionFilename(disposition);
  if (!filename) {
    filename = contentType === "application/pdf" ? "resume.pdf" : "resume";
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mimeType: contentType, filename };
}

function parseContentDispositionFilename(disposition) {
  if (!disposition) return "";
  const star = disposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;\s]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim().replace(/^"|"$/g, "");
    }
  }
  const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const plain = disposition.match(/filename\s*=\s*([^;\s]+)/i);
  if (plain) return plain[1].trim().replace(/^"|"$/g, "");
  return "";
}

export async function checkHealth() {
  const { baseUrl } = await getConnection();
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, {}, 5000);
    return res.ok;
  } catch {
    return false;
  }
}
