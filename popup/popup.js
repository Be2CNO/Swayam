/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   popup/popup.js  |  Phase 2: engine-connected UI logic
   --------------------------------------------------------------------------
   Handles:
     - File parsing (CSV/TXT) with the 500-prompt cap (quote-aware parser).
     - Config persistence via chrome.storage.local ("swayam_config") — the
       background engine reads the SAME key when a run starts.
     - Control buttons (Start / Pause / Stop / Resume / Discard) forwarding to
       background.js via chrome.runtime.sendMessage.
     - Live UI updates from "STATE_UPDATE" broadcasts + a GET_STATE snapshot
       on popup open (crash-recovery resume rendering).
     - Export buttons -> EXPORT_RESULTS -> chrome.downloads in the worker.

   The queue is now owned by the background engine; this file only uploads it
   at Start and renders whatever state the engine reports.
   ========================================================================== */

"use strict";

const MAX_PROMPTS = 500;
const STORAGE_KEYS = {
  config: "swayam_config",
};

/* --------------------------- DOM references --------------------------- */
const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("engineStatusDot"),
  statusText: $("engineStatusText"),

  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  fileInfo: $("fileInfo"),
  fileName: $("fileName"),
  promptCount: $("promptCount"),
  limitWarning: $("limitWarning"),
  btnRemoveFile: $("btnRemoveFile"),

  aiSelect: $("aiSelect"),
  newChatEvery: $("newChatEvery"),
  delayMinMs: $("delayMinMs"),
  delayMaxMs: $("delayMaxMs"),
  responseTimeout: $("responseTimeout"),

  // Phase 4: connection status bar (green/yellow/red dot + label)
  connDot: $("connectionDot"),
  connText: $("connectionText"),

  btnStart: $("btnStart"),
  btnPause: $("btnPause"),
  btnStop: $("btnStop"),
  btnResume: $("btnResume"),
  loginBanner: $("loginBanner"),
  recoveryBanner: $("recoveryBanner"),
  recoveryIndex: $("recoveryIndex"),
  btnDiscardRecovery: $("btnDiscardRecovery"),

  progressFill: $("progressFill"),
  progressTrack: $("progressTrack"),
  statTotal: $("statTotal"),
  statDone: $("statDone"),
  statFailed: $("statFailed"),
  statPending: $("statPending"),

  queueSearch: $("queueSearch"),
  queueList: $("queueList"),
};

const exportButtons = Array.from(document.querySelectorAll(".export-btn"));

/* ----------------------------- App state ------------------------------ */
let prompts = [];        // local parsed preview: array of prompt strings
let lastState = null;    // most recent engine state snapshot (source of truth for UI)
let busy = false;        // guard against double-clicking controls while awaiting a reply

/* ------------------------- Messaging helpers -------------------------- */

/** Send a command to the background worker and await its JSON reply. */
async function sendToBackground(message) {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    return reply || { ok: false, error: "No response from background worker." };
  } catch (err) {
    console.error(`[Swayam Popup] sendMessage(${message.type}) failed:`, err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/* --------------------------- File parsing ----------------------------- */

/**
 * Parse raw file text into an array of prompt strings.
 * .csv  -> takes the first non-empty column of each row (quote-aware).
 * .txt  -> one prompt per line.
 */
function parseFileContent(text, isCsv) {
  if (!isCsv) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const rows = splitCsvRows(text);
  const out = [];
  for (const row of rows) {
    const cells = parseCsvRow(row);
    const first = (cells[0] || "").trim();
    if (first) out.push(first);
  }
  return out;
}

/** Split text into logical CSV rows, respecting quoted fields that contain newlines. */
function splitCsvRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Escaped quote ("") inside a quoted field
      if (inQuotes && text[i + 1] === '"') { current += '""'; i++; continue; }
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length) rows.push(current);
  return rows.filter((r) => r.trim().length > 0);
}

/** Split a single CSV row into cell values (quote-aware, handles "" escaping). */
function parseCsvRow(row) {
  const cells = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function handleFile(file) {
  if (!file) return;
  const isCsv = /\.csv$/i.test(file.name);
  const reader = new FileReader();

  reader.onerror = () => {
    console.error("[Swayam Popup] Failed to read file:", reader.error);
    flashStatus("Failed to read file", "stopped");
  };

  reader.onload = () => {
    try {
      const parsed = parseFileContent(String(reader.result || ""), isCsv);
      const truncated = parsed.length > MAX_PROMPTS;
      const kept = parsed.slice(0, MAX_PROMPTS);

      prompts = kept;

      els.fileName.textContent = file.name;
      els.promptCount.textContent = `${prompts.length} prompts`;
      els.limitWarning.classList.toggle("hidden", !truncated);
      els.fileInfo.classList.remove("hidden");
      els.dropZone.classList.add("hidden");

      renderFromState(lastState);
      console.log(`[Swayam Popup] Loaded ${prompts.length} prompts from "${file.name}"${truncated ? " (truncated to 500)" : ""}`);
    } catch (err) {
      console.error("[Swayam Popup] Parse error:", err);
      flashStatus("Could not parse file", "stopped");
    }
  };

  reader.readAsText(file);
}

function clearFile() {
  prompts = [];
  els.fileInput.value = "";
  els.fileInfo.classList.add("hidden");
  els.dropZone.classList.remove("hidden");
  renderFromState(lastState);
}

/* --------------------------- Queue rendering -------------------------- */

/** Status shown per queue row: engine items win over the local preview. */
function rowStatus(i) {
  const eng = lastState && Array.isArray(lastState.items) ? lastState.items[i] : null;
  if (eng && eng.status) return eng.status;
  if (prompts[i] != null) return "pending";
  return "pending";
}

function rowText(i) {
  const eng = lastState && Array.isArray(lastState.items) ? lastState.items[i] : null;
  if (eng && typeof eng.text === "string") return eng.text;
  return prompts[i] != null ? prompts[i] : "";
}

function visibleRowCount() {
  const engCount = lastState && Array.isArray(lastState.items) ? lastState.items.length : 0;
  return Math.max(engCount, prompts.length);
}

function renderQueue() {
  const filter = (els.queueSearch.value || "").toLowerCase();
  els.queueList.innerHTML = "";

  const count = visibleRowCount();
  if (count === 0) {
    const li = document.createElement("li");
    li.className = "queue-empty";
    li.textContent = "No prompts loaded yet. Upload a file above.";
    els.queueList.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const text = rowText(i);
    if (filter && !text.toLowerCase().includes(filter)) continue;

    const li = document.createElement("li");
    li.className = "queue-item";
    if (lastState && lastState.currentIndex === i) li.classList.add("queue-current");
    li.dataset.index = String(i);

    const idx = document.createElement("span");
    idx.className = "queue-index";
    idx.textContent = `#${i + 1}`;

    const txt = document.createElement("span");
    txt.className = "queue-text";
    txt.textContent = text;
    txt.title = text;

    const state = document.createElement("span");
    const st = rowStatus(i);
    state.className = `queue-state ${st}`;
    state.textContent = st;

    li.append(idx, txt, state);
    frag.appendChild(li);
  }
  els.queueList.appendChild(frag);

  // Keep the in-flight row in view while running.
  if (lastState && lastState.currentIndex >= 0) {
    const cur = els.queueList.querySelector(".queue-current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
}

/* ---------------------------- Stats / UI ------------------------------ */

/** Map engine status -> dot CSS class + human label. */
const STATUS_UI = {
  IDLE:            { dot: "idle",    label: "Idle" },
  RUNNING:         { dot: "running", label: "Running" },
  RETRYING_FAILED: { dot: "running", label: "Retrying failed" },
  PAUSED:          { dot: "paused",  label: "Paused" },
  WAITING_LOGIN:   { dot: "paused",  label: "Waiting for login" },
  STOPPED:         { dot: "stopped", label: "Stopped" },
  COMPLETED:       { dot: "done",    label: "Completed" },
};

function setStatus(status) {
  const ui = STATUS_UI[status] || STATUS_UI.IDLE;
  els.statusDot.className = `status-dot ${ui.dot}`;
  els.statusText.textContent = ui.label;
}

function flashStatus(message, dotClass) {
  els.statusDot.className = `status-dot ${dotClass}`;
  els.statusText.textContent = message;
}

/**
 * Master render: derive everything (stats, progress, controls, banners,
 * queue) from the latest engine state. `state` may be null (never ran).
 */
function renderFromState(state) {
  lastState = state || null;
  const s = lastState;
  const status = s ? s.status : "IDLE";
  const items = s && Array.isArray(s.items) ? s.items : [];

  setStatus(status);

  // ----- stats & progress -----
  const total = items.length;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const pending = total - done - failed;
  const pct = total === 0 ? 0 : Math.round(((done + failed) / total) * 100);

  els.statTotal.textContent = String(total);
  els.statDone.textContent = String(done);
  els.statFailed.textContent = String(failed);
  els.statPending.textContent = String(pending);
  els.progressFill.style.width = `${pct}%`;
  els.progressTrack.setAttribute("aria-valuenow", String(pct));

  const hasResults = done + failed > 0;
  exportButtons.forEach((b) => (b.disabled = !hasResults || busy));

  // ----- control enablement -----
  const isActive = status === "RUNNING" || status === "RETRYING_FAILED";
  const resumable = status === "PAUSED" || status === "WAITING_LOGIN" ||
    !!(s && s.recoveredFromCrash && status !== "IDLE" && status !== "COMPLETED" && status !== "STOPPED");

  const canStartFresh = prompts.length > 0 || (isActive || resumable ? false : total > 0);
  els.btnStart.disabled = busy || !canStartFresh;
  els.btnPause.disabled = busy || !isActive;
  els.btnStop.disabled = busy || !(isActive || status === "PAUSED" || status === "WAITING_LOGIN");
  els.btnResume.classList.toggle("hidden", !resumable);
  els.btnResume.disabled = busy;

  // ----- banners -----
  els.loginBanner.classList.toggle("hidden", status !== "WAITING_LOGIN");

  const interrupted = !!(s && s.recoveredFromCrash && (status === "PAUSED" || status === "WAITING_LOGIN"));
  els.recoveryBanner.classList.toggle("hidden", !interrupted);
  if (interrupted) {
    const nextIdx = items.findIndex((i) => i.status === "pending");
    els.recoveryIndex.textContent = `#${nextIdx >= 0 ? nextIdx + 1 : total + 1}`;
  }

  // ----- engine info / errors as a transient status line -----
  if (s && s.lastError && !isActive) {
    els.statusText.textContent = s.lastError.length > 60 ? s.lastError.slice(0, 57) + "…" : s.lastError;
    els.statusText.title = s.lastError;
  } else {
    els.statusText.removeAttribute("title");
  }

  renderQueue();
}

/* ------------------------- Storage persistence ------------------------ */

async function saveConfig() {
  const strategy = document.querySelector('input[name="chatStrategy"]:checked');
  const config = {
    ai: els.aiSelect.value,
    chatStrategy: strategy ? strategy.value : "single",
    newChatEvery: clampInt(els.newChatEvery.value, 1, MAX_PROMPTS, 25),
    delayBetween: clampInt(els.delayBetween.value, 1000, 600000, 3000),
    responseTimeout: clampInt(els.responseTimeout.value, 10, 3600, 120),
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
  } catch (err) {
    console.error("[Swayam Popup] Failed saving config:", err);
  }
}

async function loadConfig() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.config);
    const cfg = data[STORAGE_KEYS.config];
    if (!cfg) return;
    if (cfg.ai) els.aiSelect.value = cfg.ai;
    if (cfg.chatStrategy) {
      const radio = document.querySelector(`input[name="chatStrategy"][value="${cfg.chatStrategy}"]`);
      if (radio) radio.checked = true;
    }
    if (typeof cfg.newChatEvery === "number") els.newChatEvery.value = String(cfg.newChatEvery);
    if (typeof cfg.delayBetween === "number") els.delayBetween.value = String(cfg.delayBetween);
    if (typeof cfg.responseTimeout === "number") els.responseTimeout.value = String(cfg.responseTimeout);
  } catch (err) {
    console.error("[Swayam Popup] Failed loading config:", err);
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* --------------------------- Run controls ----------------------------- */

/** Persist config first (the worker reads swayam_config at START_RUN). */
async function onStart() {
  if (prompts.length === 0) {
    flashStatus("Upload a file first", "stopped");
    return;
  }
  busy = true;
  renderFromState(lastState);
  await saveConfig();
  const reply = await sendToBackground({ type: "START_RUN", queue: prompts });
  busy = false;
  if (!reply.ok) {
    flashStatus(reply.error || "Failed to start", "stopped");
  }
  const fresh = await sendToBackground({ type: "GET_STATE" });
  renderFromState(fresh.ok ? fresh.state : lastState);
}

async function onControl(action) {
  busy = true;
  renderFromState(lastState);
  const reply = await sendToBackground({ type: action });
  if (!reply.ok) console.warn(`[Swayam Popup] ${action}:`, reply.error);
  const fresh = await sendToBackground({ type: "GET_STATE" });
  busy = false;
  renderFromState(fresh.ok ? fresh.state : lastState);
}

async function onDiscardRecovery() {
  busy = true;
  const reply = await sendToBackground({ type: "DISCARD_RECOVERY" });
  if (!reply.ok) console.warn("[Swayam Popup] DISCARD_RECOVERY:", reply.error);
  const fresh = await sendToBackground({ type: "GET_STATE" });
  busy = false;
  renderFromState(fresh.ok ? fresh.state : null);
}

async function onExport(format) {
  busy = true;
  renderFromState(lastState);
  const reply = await sendToBackground({ type: "EXPORT_RESULTS", format });
  busy = false;
  if (reply.ok) {
    flashStatus(`Saved ${reply.filename}`, "done");
  } else {
    flashStatus(reply.error || "Export failed", "stopped");
  }
  renderFromState(lastState);
}

/* ------------------------------ Events ------------------------------- */

function bindEvents() {
  // Drop zone: click + drag & drop
  els.dropZone.addEventListener("click", () => els.fileInput.click());
  els.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

  ["dragenter", "dragover"].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    els.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove("dragover");
    })
  );
  els.dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  els.btnRemoveFile.addEventListener("click", clearFile);

  // Config persistence (the engine picks these up on the next START_RUN)
  [els.aiSelect, els.newChatEvery, els.delayBetween, els.responseTimeout]
    .forEach((el) => el.addEventListener("change", saveConfig));
  document.querySelectorAll('input[name="chatStrategy"]')
    .forEach((r) => r.addEventListener("change", saveConfig));

  // Run controls -> background engine
  els.btnStart.addEventListener("click", onStart);
  els.btnPause.addEventListener("click", () => onControl("PAUSE_RUN"));
  els.btnStop.addEventListener("click", () => onControl("STOP_RUN"));
  els.btnResume.addEventListener("click", () => onControl("RESUME_RUN"));
  els.btnDiscardRecovery.addEventListener("click", onDiscardRecovery);

  // Queue filter
  els.queueSearch.addEventListener("input", renderQueue);

  // Export -> chrome.downloads via the background worker
  exportButtons.forEach((btn) =>
    btn.addEventListener("click", () => onExport(btn.dataset.export))
  );

  // Live updates from the engine
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "STATE_UPDATE" && message.state) {
      renderFromState(message.state);
    }
  });
}

/* ------------------------------ Init -------------------------------- */

/**
 * Fallback live-refresh: the popup CANNOT receive chrome.tabs.sendMessage
 * broadcasts (different extension context), so if no STATE_UPDATE arrives
 * within a couple of seconds while a run is active, poll GET_STATE directly.
 */
let statePollTimer = null;
function startStatePolling() {
  if (statePollTimer) return;
  statePollTimer = setInterval(async () => {
    const s = lastState && lastState.status;
    const active = s === "RUNNING" || s === "RETRYING_FAILED" || s === "WAITING_LOGIN";
    if (!active) return; // broadcasts handle idle states fine
    const reply = await sendToBackground({ type: "GET_STATE" });
    if (reply.ok && reply.state) renderFromState(reply.state);
  }, 2000);
}

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[Swayam Popup] Phase 2 UI initialized — engine connected.");
  await loadConfig();
  bindEvents();
  startStatePolling();

  // Fetch current engine state so a reopened popup resumes rendering
  // (progress, queue statuses, recovery banner) exactly where the run is.
  const reply = await sendToBackground({ type: "GET_STATE" });
  renderFromState(reply.ok ? reply.state : null);
});
