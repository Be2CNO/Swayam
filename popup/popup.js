/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   popup.js  |  Phase 1: UI shell logic
   --------------------------------------------------------------------------
   Handles: file parsing (CSV/TXT) with 500-prompt cap, queue preview rendering,
   config persistence via chrome.storage.local, and basic control-state wiring.
   The actual run engine (background queue + content-script automation) lands
   in later phases; Start/Pause/Stop here only manage local UI state.
   ========================================================================== */

"use strict";

const MAX_PROMPTS = 500;
const STORAGE_KEYS = {
  config: "swayam_config",
  queue: "swayam_queue",
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
  delayBetween: $("delayBetween"),
  responseTimeout: $("responseTimeout"),

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
let prompts = []; // array of { text, status: pending|running|done|failed }

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

      prompts = kept.map((text) => ({ text, status: "pending" }));

      els.fileName.textContent = file.name;
      els.promptCount.textContent = `${prompts.length} prompts`;
      els.limitWarning.classList.toggle("hidden", !truncated);
      els.fileInfo.classList.remove("hidden");
      els.dropZone.classList.add("hidden");

      updateControls();
      renderQueue();
      updateStats();
      saveQueueToStorage();
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
  updateControls();
  renderQueue();
  updateStats();
  saveQueueToStorage();
}

/* --------------------------- Queue rendering -------------------------- */

function renderQueue() {
  const filter = (els.queueSearch.value || "").toLowerCase();
  els.queueList.innerHTML = "";

  if (prompts.length === 0) {
    const li = document.createElement("li");
    li.className = "queue-empty";
    li.textContent = "No prompts loaded yet. Upload a file above.";
    els.queueList.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  prompts.forEach((p, i) => {
    if (filter && !p.text.toLowerCase().includes(filter)) return;
    const li = document.createElement("li");
    li.className = "queue-item";
    li.dataset.index = String(i);

    const idx = document.createElement("span");
    idx.className = "queue-index";
    idx.textContent = `#${i + 1}`;

    const txt = document.createElement("span");
    txt.className = "queue-text";
    txt.textContent = p.text;
    txt.title = p.text;

    const state = document.createElement("span");
    state.className = `queue-state ${p.status}`;
    state.textContent = p.status;

    li.append(idx, txt, state);
    frag.appendChild(li);
  });
  els.queueList.appendChild(frag);
}

/* ---------------------------- Stats / UI ------------------------------ */

function updateStats() {
  const total = prompts.length;
  const done = prompts.filter((p) => p.status === "done").length;
  const failed = prompts.filter((p) => p.status === "failed").length;
  const pending = total - done - failed;
  const pct = total === 0 ? 0 : Math.round(((done + failed) / total) * 100);

  els.statTotal.textContent = String(total);
  els.statDone.textContent = String(done);
  els.statFailed.textContent = String(failed);
  els.statPending.textContent = String(pending);
  els.progressFill.style.width = `${pct}%`;
  els.progressTrack.setAttribute("aria-valuenow", String(pct));

  const hasResults = done + failed > 0;
  exportButtons.forEach((b) => (b.disabled = !hasResults));
}

function setStatus(status) {
  els.statusDot.className = `status-dot ${status}`;
  els.statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

function flashStatus(message, dotClass) {
  els.statusDot.className = `status-dot ${dotClass}`;
  els.statusText.textContent = message;
}

function updateControls() {
  const hasPrompts = prompts.length > 0;
  els.btnStart.disabled = !hasPrompts;
  els.btnPause.disabled = true;  // enabled by the run engine in a later phase
  els.btnStop.disabled = true;
  els.btnResume.classList.add("hidden");
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

async function saveQueueToStorage() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.queue]: prompts });
  } catch (err) {
    console.error("[Swayam Popup] Failed saving queue snapshot:", err);
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

  // Config persistence
  [els.aiSelect, els.newChatEvery, els.delayBetween, els.responseTimeout]
    .forEach((el) => el.addEventListener("change", saveConfig));
  document.querySelectorAll('input[name="chatStrategy"]')
    .forEach((r) => r.addEventListener("change", saveConfig));

  // Run controls — wired to the engine in a later phase.
  els.btnStart.addEventListener("click", () => {
    console.log("[Swayam Popup] START clicked. Engine will be connected in Phase 2+.", collectConfigForEngine());
  });
  els.btnPause.addEventListener("click", () => console.log("[Swayam Popup] PAUSE clicked."));
  els.btnStop.addEventListener("click", () => console.log("[Swayam Popup] STOP clicked."));
  els.btnResume.addEventListener("click", () => console.log("[Swayam Popup] RESUME clicked."));
  els.btnDiscardRecovery.addEventListener("click", () => {
    els.recoveryBanner.classList.add("hidden");
    console.log("[Swayam Popup] Recovery snapshot discarded.");
  });

  // Queue filter
  els.queueSearch.addEventListener("input", renderQueue);

  // Export buttons — real chrome.downloads export arrives in a later phase.
  exportButtons.forEach((btn) =>
    btn.addEventListener("click", () =>
      console.log(`[Swayam Popup] Export as ${btn.dataset.export.toUpperCase()} requested. Will use chrome.downloads in a later phase.`)
    )
  );
}

function collectConfigForEngine() {
  const strategy = document.querySelector('input[name="chatStrategy"]:checked');
  return {
    ai: els.aiSelect.value,
    chatStrategy: strategy ? strategy.value : "single",
    newChatEvery: clampInt(els.newChatEvery.value, 1, MAX_PROMPTS, 25),
    delayBetween: clampInt(els.delayBetween.value, 1000, 600000, 3000),
    responseTimeout: clampInt(els.responseTimeout.value, 10, 3600, 120),
    promptCount: prompts.length,
  };
}

/* ------------------------------- Init -------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[Swayam Popup] Phase 1 UI shell initialized.");
  setStatus("idle");
  await loadConfig();
  bindEvents();
  renderQueue();
  updateStats();
});
