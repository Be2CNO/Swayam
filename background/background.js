/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   background/background.js  |  MV3 Service Worker
   --------------------------------------------------------------------------
   Phase 2: Background Queue Engine, State Management & Message Passing.

   Responsibilities
   ----------------
   1. Own the ENTIRE run state in chrome.storage.local (single source of truth)
      so the service worker can be killed by Chrome at any moment and still
      resume exactly where it left off.
   2. Sequential execution ONLY: one prompt in flight at a time. The engine
      sends SEND_PROMPT to the content script and waits for RESPONSE_CAPTURED
      (or RESPONSE_FAILED / timeout) before advancing.
   3. Chat strategy: "New chat every X prompts" -> CREATE_NEW_CHAT is sent and
      the engine waits for NEW_CHAT_READY before the next SEND_PROMPT.
   4. Timers: NO setTimeout/setInterval (the SW would be terminated). All
      waiting uses chrome.alarms + chrome.storage snapshots. Every alarm is
      paired with a deadline stored in state so the engine self-corrects after
      an SW restart or a missed alarm.
   5. Error handling per spec: failed/timed-out prompts are marked FAILED,
      skipped, and retried (once) only at the VERY END as a separate pass
      (state = RETRYING_FAILED).
   6. Login state: if the content script reports NOT_LOGGED_IN the engine
      pauses and waits; the user logs in manually and presses Resume.
   7. Export: builds CSV/JSON/TXT from captured results and saves via
      chrome.downloads.download into the default Downloads folder.

   NOTE: DOM automation lives in content-scripts/content-script.js (Phase 3).
   This engine is fully testable against any script that speaks the protocol
   defined below.

   --------------------------------------------------------------------------
   MESSAGE PROTOCOL
   --------------------------------------------------------------------------
   popup -> background
     { type: "START_RUN", queue: string[] }        begin a fresh run
     { type: "PAUSE_RUN" }                         pause after current step settles
     { type: "RESUME_RUN" }                        resume a paused/interrupted run
     { type: "STOP_RUN" }                          stop; partial results kept
     { type: "GET_STATE" }                         full state snapshot (sendResponse)
     { type: "DISCARD_RECOVERY" }                  delete interrupted-run snapshot
     { type: "EXPORT_RESULTS", format: "csv"|"json"|"txt" }  chrome.downloads export

   content-script -> background
     { type: "RESPONSE_CAPTURED", index, text }    generation finished
     { type: "RESPONSE_FAILED",   index, error }   send/capture failed
     { type: "NEW_CHAT_READY", ok, error? }        confirmation of CREATE_NEW_CHAT
     { type: "NOT_LOGGED_IN" }                     login wall detected -> pause & wait

   background -> broadcast (popup + tab's content script)
     { type: "STATE_UPDATE", state }               debounced state snapshot
   background -> content-script
     { type: "SEND_PROMPT", index, text }
     { type: "CREATE_NEW_CHAT" }
     { type: "ABORT_CURRENT" }                     cancel in-flight work (pause/stop)
   ========================================================================== */

"use strict";

/* ------------------------------ Constants ------------------------------ */

const STATE_KEY = "swayam_state";
const CONFIG_KEY = "swayam_config";
const MAX_PROMPTS = 500;

/* ------------------- Randomized human-like delay (Phase 4) --------------
   Fixed delays look robotic. The engine now picks a UNIFORM random duration
   between DELAY_MIN_MS and DELAY_MAX_MS before each prompt via chrome.alarms
   (still no setTimeout/setInterval scheduling in the SW). Override from the
   popup with settings.delayMinMs / settings.delayMaxMs. */
const DELAY_MIN_MS = 3000;
const DELAY_MAX_MS = 7000;

function randomDelayMs() {
  const raw = S && S.settings ? S.settings : {};
  let min = Number(raw.delayMinMs);
  let max = Number(raw.delayMaxMs);
  if (!Number.isFinite(min) || min < 1000) min = DELAY_MIN_MS;
  if (!Number.isFinite(max) || max < min) max = Math.max(min, DELAY_MAX_MS);
  if (max > 600000) max = 600000; // sanity clamp: 10 minutes
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Run states (spec): IDLE, RUNNING, PAUSED, STOPPED, COMPLETED, RETRYING_FAILED
// WAITING_LOGIN is an internal sub-state of PAUSED used by the auto-resume alarm.
const STATUS = Object.freeze({
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
  COMPLETED: "COMPLETED",
  RETRYING_FAILED: "RETRYING_FAILED",
  WAITING_LOGIN: "WAITING_LOGIN",
});

const PHASE = Object.freeze({
  IDLE: "idle",
  DELAY: "delay",           // inter-prompt delay (alarm swayam:step)
  SENDING: "sending",       // SEND_PROMPT dispatched, awaiting RESPONSE_CAPTURED
  AWAIT_NEW_CHAT: "await_new_chat", // CREATE_NEW_CHAT dispatched, awaiting NEW_CHAT_READY
});

// Alarm names (all prefixed so they are easy to bulk-clear)
const ALARM_STEP = "swayam:step";         // generic timer edge: delay end / timeout fire
const ALARM_AUTOLOGIN = "swayam:autologin"; // poll while WAITING_LOGIN
const AUTOLOGIN_PERIOD_MIN = 0.5;          // ~30 s (Chrome clamps <30s periods in prod)

// BUGFIX (stuck prevention): if the site's "new chat" button keeps failing,
// the new-chat gate would retry forever. After this many CONSECUTIVE failures
// we stop trying and continue in the current chat (user warned via lastError).
const NEW_CHAT_MAX_FAILURES = 3;

const DEFAULT_SETTINGS = Object.freeze({
  ai: "chatgpt",
  chatStrategy: "single",   // "single" | "new-chat"
  newChatEvery: 25,
  delayMinMs: DELAY_MIN_MS, // Phase 4: randomized human-like delay lower bound
  delayMaxMs: DELAY_MAX_MS, // upper bound (engine picks uniform random in [min,max])
  responseTimeout: 120,     // seconds to wait for RESPONSE_CAPTURED
});

const SITE_HOSTS = {
  chatgpt: ["chat.openai.com", "chatgpt.com"],
  gemini: ["gemini.google.com"],
  claude: ["claude.ai"],
};

/* --------------------- In-memory mirror of the state --------------------
   The authoritative copy always lives in chrome.storage.local. This mirror
   lets us mutate synchronously; persistState() writes it back. On SW wake-up
   we rehydrate from storage before touching it. */

let S = null;

function makeIdleState(settings) {
  return {
    version: 1,
    status: STATUS.IDLE,
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    items: [],            // [{ text, status: pending|running|done|failed, response, error, attempted, completedAt }]
    currentIndex: -1,     // item currently in flight (-1 = none)
    phase: PHASE.IDLE,
    deadline: 0,          // absolute ms timestamp for the currently-scheduled alarm (0 = none)
    promptsSinceChat: 0,  // counter for "new chat every X"
    newChatFailures: 0,   // consecutive new-chat creation failures (stuck-prevention guard)
    retryQueue: [],       // indices queued for the final failed-only pass
    activeTabId: -1,
    lastError: "",
    startedAt: 0,
    updatedAt: 0,
  };
}

/** Persist the state mirror to chrome.storage.local (fire-and-await). */
async function persistState() {
  if (!S) return;
  S.updatedAt = Date.now();
  try {
    await chrome.storage.local.set({ [STATE_KEY]: S });
  } catch (err) {
    console.error("[Swayam BG] Failed to persist state:", err);
  }
}

/* --------------------------- Broadcast to UI --------------------------- */

let broadcastTimer = null;
let broadcastPending = false;

/** Debounced STATE_UPDATE broadcast (popup + active run tab's content script). */
function broadcastState() {
  broadcastPending = true;
  if (broadcastTimer !== null) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = broadcastPending;
    broadcastPending = false;
    if (!payload || !S) return;
    const message = { type: "STATE_UPDATE", state: S };
    chrome.runtime.sendMessage(message).catch(() => {
      /* no listener (popup closed) — normal, ignore */
    });
    if (S.activeTabId > 0) {
      chrome.tabs.sendMessage(S.activeTabId, message).catch(() => {});
    }
  }, 120);
}

/* ----------------------------- Settings -------------------------------- */

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = data[CONFIG_KEY];
    return cfg ? { ...DEFAULT_SETTINGS, ...cfg } : { ...DEFAULT_SETTINGS };
  } catch (err) {
    console.error("[Swayam BG] Failed to load settings:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

/* --------------------------- Tab management ---------------------------- */

function hostMatches(url, candidates) {
  try {
    const host = new URL(url).hostname;
    return candidates.some((c) => host === c || host.endsWith("." + c));
  } catch (_) {
    return false;
  }
}

/**
 * Find a usable tab for the configured AI site. Prefers an already-open tab
 * (so the user's manual model selection & login session is reused — the
 * extension never logs in or switches models). Falls back to the active tab
 * if it is on the right site, otherwise opens a new tab.
 */
async function findTargetTab(ai) {
  const hosts = SITE_HOSTS[ai] || [];
  const tabs = await chrome.tabs.query({});
  let fallbackActive = null;
  for (const t of tabs) {
    if (t.url && hostMatches(t.url, hosts)) {
      if (t.active) return t;
      if (!fallbackActive) fallbackActive = t;
    }
  }
  if (fallbackActive) return fallbackActive;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && active.url && hostMatches(active.url, hosts)) return active;
  return null;
}

async function ensureTargetTab() {
  const ai = S.settings.ai;
  let tab = await findTargetTab(ai);
  if (!tab) {
    tab = await chrome.tabs.create({
      url: `https://${(SITE_HOSTS[ai] || ["chatgpt.com"])[0]}/`,
      active: true,
    });
    // Wait (alarm-driven) for the page + content script to come up.
    await new Promise((resolve) => {
      const done = () => resolve();
      const onUpdated = (id, changeInfo) => {
        if (id === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(safety);
          done();
        }
      };
      // Safety net: this setTimeout only resolves a promise during a live
      // async operation (not a cross-task timer), which MV3 tolerates.
      const safety = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        done();
      }, 15000);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }
  S.activeTabId = tab.id;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) { /* window may be closing; non-fatal */ }
  return tab;
}

/** True if the content script answers a lightweight ping. */
async function contentScriptAlive(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

/** Best-effort probe whether the user looks logged in (content script side). */
async function checkLoggedIn(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "CHECK_LOGIN" });
    return !!(res && res.loggedIn);
  } catch (_) {
    return false;
  }
}

/* ---------------------------- Alarms layer ----------------------------- */

async function clearAlarms() {
  chrome.alarms.clear(ALARM_STEP);
  chrome.alarms.clear(ALARM_AUTOLOGIN);
}

/**
 * Schedule the next timer edge. `whenMs` is an ABSOLUTE timestamp; if it has
 * already passed (e.g. we woke late after an SW restart) the alarm fires
 * immediately and handleAlarm() compares against the stored deadline to do
 * the correct thing.
 */
async function scheduleStepAlarm(whenMs) {
  chrome.alarms.clear(ALARM_STEP);
  S.deadline = whenMs;
  await chrome.alarms.create(ALARM_STEP, { when: Math.max(whenMs, Date.now()) });
}

function alarmDue() {
  // Allow a small clock-skew tolerance before treating a deadline as fired.
  return S.deadline > 0 && Date.now() >= S.deadline - 250;
}

/* --------------------------- Core engine loop -------------------------- */

function nextPendingIndex(from = 0) {
  for (let i = from; i < S.items.length; i++) {
    if (S.items[i].status === "pending") return i;
  }
  return -1;
}

function firstPendingIndex() {
  return nextPendingIndex(0);
}

/**
 * Entry point of the sequential loop. Decides what happens RIGHT NOW based
 * on state. Safe to call repeatedly — it always re-reads the state mirror.
 */
async function runNext() {
  if (!S) return;

  // Pause requested while idle-between-steps: settle it now.
  if (S.status === STATUS.PAUSED) {
    S.phase = PHASE.IDLE;
    S.currentIndex = -1;
    await persistState();
    broadcastState();
    return;
  }
  if (S.status === STATUS.STOPPED || S.status === STATUS.IDLE || S.status === STATUS.COMPLETED) {
    await clearAlarms();
    return;
  }

  const running = S.status === STATUS.RUNNING || S.status === STATUS.RETRYING_FAILED;
  if (!running) return;

  // If we are mid-step (waiting on the site), the corresponding alarm handles it.
  if (S.phase === PHASE.SENDING || S.phase === PHASE.AWAIT_NEW_CHAT) return;

  // Pick the next index to process.
  let idx;
  if (S.status === STATUS.RETRYING_FAILED) {
    idx = S.retryQueue.length ? S.retryQueue[0] : -1;
    if (idx === -1) return finishRun();
  } else {
    idx = firstPendingIndex();
    if (idx === -1) return enterRetryPhase();
  }

  // ---- "New chat every X prompts" gate (main pass only) ----
  if (
    S.status === STATUS.RUNNING &&
    S.settings.chatStrategy === "new-chat" &&
    S.promptsSinceChat >= S.settings.newChatEvery &&
    S.promptsSinceChat > 0
  ) {
    return createNewChatThen();
  }

  // BUGFIX: infinite loop guard. If new-chat creation keeps failing, the
  // counter never resets and every runNext() re-enters the gate above forever.
  // After NEW_CHAT_MAX_FAILURES consecutive failures we stop trying and
  // continue in the current chat (the user is warned via lastError).
  if (S.newChatFailures >= NEW_CHAT_MAX_FAILURES) {
    console.warn(`[Swayam BG] New chat failed ${S.newChatFailures}x in a row — continuing in the current chat.`);
    S.promptsSinceChat = 0;
    S.lastError = `Could not open a new chat after ${NEW_CHAT_MAX_FAILURES} attempts. Continuing in the current chat — check the site UI.`;
  }

  // Inter-prompt delay applies to every dispatch EXCEPT the very first one of
  // a run/fresh resume, so the user is not kept waiting before anything has
  // even been sent.
  // BUGFIX: `attempted` alone is unreliable — sendPromptToIndex() flips it to
  // true BEFORE the prompt is actually dispatched (login guard / tab errors can
  // abort the dispatch), which made startRun's "first prompt goes out after one
  // delay" comment a lie and skipped the delay on genuinely-first sends when an
  // item was reset to pending mid-run. Count items that reached a terminal
  // state instead: zero => nothing has truly been processed yet => no delay.
  const anyProcessed = S.items.some((i) => i.status === "done" || i.status === "failed");
  if (!anyProcessed) {
    return sendPromptToIndex(idx);
  }

  return delayedDispatch();
}

/**
 * Wait out the configured inter-prompt delay via chrome.alarms. When the step
 * alarm fires in PHASE.DELAY, handleStepAlarm() re-derives the next index and
 * dispatches it — so nothing depends on a JS timer surviving SW eviction.
 */
async function delayedDispatch() {
  S.phase = PHASE.DELAY;
  const when = Date.now() + randomDelayMs(); // Phase 4: randomized 3–7 s
  await persistState();
  broadcastState();
  await scheduleStepAlarm(when);
}

/** Dispatch SEND_PROMPT for `idx` and arm the response-timeout alarm. */
async function sendPromptToIndex(idx) {
  const item = S.items[idx];
  if (!item) return runNext();

  // Fresh (non-retry) prompts start their attempt here; retries were already
  // counted as failed once, so just flip them back to running.
  if (S.status !== STATUS.RETRYING_FAILED) item.attempted = true;
  item.status = "running";
  item.error = "";
  S.currentIndex = idx;
  S.phase = PHASE.SENDING;

  await persistState();
  broadcastState();

  const timeoutMs = Math.max(10, Number(S.settings.responseTimeout) || 120) * 1000;

  try {
    await ensureTargetTab();

    // Content script may be missing right after an SW/tab restart — inject it.
    if (!(await contentScriptAlive(S.activeTabId))) {
      try {
        await chrome.scripting.executeScript({
          files: [
            "content-scripts/adapters/adapter-utils.js",
            "content-scripts/adapters/chatgpt-adapter.js",
            "content-scripts/adapters/gemini-adapter.js",
            "content-scripts/adapters/claude-adapter.js",
            "content-scripts/content-script.js",
          ],
          target: { tabId: S.activeTabId },
        });
      } catch (err) {
        console.warn("[Swayam BG] Could not inject content script:", err);
      }
    }

    // Login guard (spec: warn + pause/wait for MANUAL login; never bypass).
    const loggedIn = await checkLoggedIn(S.activeTabId);
    if (!loggedIn) {
      item.status = "pending"; // put it back — nothing was sent
      S.currentIndex = -1;
      S.phase = PHASE.IDLE;
      S.status = STATUS.WAITING_LOGIN;
      S.lastError = "Not logged in on the target site. Log in manually, then press Resume.";
      await persistState();
      broadcastState();
      chrome.alarms.clear(ALARM_STEP);
      await chrome.alarms.create(ALARM_AUTOLOGIN, { periodInMinutes: AUTOLOGIN_PERIOD_MIN });
      return;
    }

    await chrome.tabs.sendMessage(S.activeTabId, {
      type: "SEND_PROMPT",
      index: idx,
      text: item.text,
      // Content script honors this as its hard capture timeout (spec 4).
      timeoutSeconds: Math.max(10, Number(S.settings.responseTimeout) || 120),
    });

    await scheduleStepAlarm(Date.now() + timeoutMs);
  } catch (err) {
    // Tab gone / message port dead / injection blocked -> mark failed & skip.
    failItem(idx, `Could not reach the page: ${err && err.message ? err.message : err}`);
    return advanceAfterFailure();
  }
}

/**
 * Ask the site to open a fresh chat, wait for NEW_CHAT_READY (bounded by the
 * response-timeout alarm), then continue. The next prompt index is re-derived
 * when the flow resumes, so no stale index is captured here.
 */
async function createNewChatThen() {
  S.phase = PHASE.AWAIT_NEW_CHAT;
  await persistState();
  broadcastState();
  try {
    await ensureTargetTab();
    await chrome.tabs.sendMessage(S.activeTabId, { type: "CREATE_NEW_CHAT" });
    // Timeout for the new-chat confirmation = response timeout (generous).
    const timeoutMs = Math.max(10, Number(S.settings.responseTimeout) || 120) * 1000;
    await scheduleStepAlarm(Date.now() + timeoutMs);
  } catch (err) {
    // Cannot create chats -> fall back to continuing in the same chat.
    console.warn("[Swayam BG] CREATE_NEW_CHAT dispatch failed, continuing in same chat:", err);
    S.promptsSinceChat = 0;
    return delayedDispatch();
  }
}

/** Mark an item FAILED, record why, keep going (spec: SKIP and continue). */
function failItem(idx, reason) {
  const item = S.items[idx];
  if (!item) return;
  item.status = "failed";
  item.error = String(reason || "Unknown error").slice(0, 500);
  console.warn(`[Swayam BG] Prompt #${idx + 1} FAILED: ${item.error}`);
}

/** Advance past a failed/skipped item after the normal inter-prompt delay. */
async function advanceAfterFailure() {
  // BUGFIX: only pop the retry queue when the FAILED item actually belongs to
  // the retry pass. During the MAIN pass this used to shift an innocent index
  // off retryQueue, silently dropping that prompt from the final retry pass.
  const failedIdx = S.currentIndex;
  if (S.status === STATUS.RETRYING_FAILED && S.retryQueue.length &&
      S.retryQueue[0] === failedIdx) {
    S.retryQueue.shift();
  }
  S.currentIndex = -1;
  const nextIdx =
    S.status === STATUS.RETRYING_FAILED
      ? (S.retryQueue.length ? S.retryQueue[0] : -1)
      : firstPendingIndex();
  if (nextIdx === -1) {
    return S.status === STATUS.RETRYING_FAILED ? finishRun() : enterRetryPhase();
  }
  await delayedDispatch();
}

/** End of main pass: build the retry list of everything that failed. */
async function enterRetryPhase() {
  const failedIdx = [];
  for (let i = 0; i < S.items.length; i++) {
    if (S.items[i].status === "failed" && !S.items[i].retried) failedIdx.push(i);
  }
  if (failedIdx.length === 0) return finishRun();

  // Reset the failed items to pending for the single retry pass.
  for (const i of failedIdx) {
    S.items[i].status = "pending";
    S.items[i].retried = true;
  }
  S.status = STATUS.RETRYING_FAILED;
  S.retryQueue = failedIdx.slice();
  S.lastError = `Retrying ${failedIdx.length} failed prompt(s) now.`;
  await persistState();
  broadcastState();
  return runNext();
}

/** Everything settled: finalize, clean timers, report. */
async function finishRun() {
  S.status = STATUS.COMPLETED;
  S.phase = PHASE.IDLE;
  S.currentIndex = -1;
  S.retryQueue = [];
  S.deadline = 0;
  await clearAlarms();
  await persistState();
  broadcastState();
  const done = S.items.filter((i) => i.status === "done").length;
  const failed = S.items.filter((i) => i.status === "failed").length;
  console.log(`[Swayam BG] Run COMPLETED — ${done} succeeded, ${failed} failed.`);
}

/** Central handler for the generic step alarm — decides what the deadline was for. */
async function handleStepAlarm() {
  if (!S) return;
  if (S.status !== STATUS.RUNNING && S.status !== STATUS.RETRYING_FAILED) return;

  if (S.phase === PHASE.DELAY) {
    if (!alarmDue()) {
      // Woke early (spurious alarm) — reschedule for the remaining time.
      await chrome.alarms.create(ALARM_STEP, { when: S.deadline });
      return;
    }
    const idx =
      S.status === STATUS.RETRYING_FAILED
        ? (S.retryQueue.length ? S.retryQueue[0] : -1)
        : firstPendingIndex();
    if (idx === -1) {
      return S.status === STATUS.RETRYING_FAILED ? finishRun() : enterRetryPhase();
    }
    return sendPromptToIndex(idx);
  }

  if (S.phase === PHASE.SENDING) {
    if (!alarmDue()) {
      await chrome.alarms.create(ALARM_STEP, { when: S.deadline });
      return;
    }
    // Deadline passed with no RESPONSE_CAPTURED -> timed out. Skip it.
    const idx = S.currentIndex;
    if (idx >= 0) failItem(idx, `Timed out after ${S.settings.responseTimeout}s waiting for a response.`);
    S.currentIndex = -1;
    S.phase = PHASE.IDLE;
    await persistState();
    broadcastState();
    return advanceAfterFailure();
  }

  if (S.phase === PHASE.AWAIT_NEW_CHAT) {
    if (!alarmDue()) {
      await chrome.alarms.create(ALARM_STEP, { when: S.deadline });
      return;
    }
    // New chat didn't confirm in time — proceed anyway in whatever chat exists.
    console.warn("[Swayam BG] NEW_CHAT_READY timed out; continuing in current chat.");
    S.newChatFailures = (S.newChatFailures || 0) + 1; // counts toward the stuck-prevention guard
    S.promptsSinceChat = 0;
    const idx = firstPendingIndex();
    if (idx === -1) return enterRetryPhase();
    return sendPromptToIndex(idx);
  }
}

/* --------------------------- Public commands --------------------------- */

async function startRun(queueTexts) {
  if (!Array.isArray(queueTexts) || queueTexts.length === 0) {
    return { ok: false, error: "No prompts to run. Upload a file first." };
  }
  const texts = queueTexts.slice(0, MAX_PROMPTS);
  const settings = await loadSettings();

  await clearAlarms();
  S = makeIdleState(settings);
  S.items = texts.map((t) => ({
    text: String(t),
    status: "pending",
    response: "",
    error: "",
    attempted: false,
    retried: false,
    completedAt: null,
  }));
  S.status = STATUS.RUNNING;
  S.startedAt = Date.now();
  await persistState();
  broadcastState();
  console.log(`[Swayam BG] RUN STARTED — ${S.items.length} prompts, AI=${settings.ai}, strategy=${settings.chatStrategy}`);

  // BUGFIX: the old comment claimed "first prompt goes out after one delay"
  // but that was never true — delayedDispatch() was called directly and the
  // runNext() first-prompt branch (which skips the delay) was bypassed. Now
  // we go through runNext(), which correctly dispatches prompt #1 immediately
  // (no artificial wait before anything has been sent).
  return runNext().then(() => ({ ok: true, count: S.items.length }));
}

async function pauseRun() {
  if (!S) return { ok: false, error: "No active run." };
  if (S.status !== STATUS.RUNNING && S.status !== STATUS.RETRYING_FAILED && S.status !== STATUS.WAITING_LOGIN) {
    return { ok: false, error: `Cannot pause while ${S.status}.` };
  }
  S.status = STATUS.PAUSED;
  S.lastError = "";
  chrome.alarms.clear(ALARM_AUTOLOGIN);
  if (S.phase === PHASE.SENDING || S.phase === PHASE.AWAIT_NEW_CHAT) {
    // Let the in-flight step settle; its RESPONSE_* handler will see PAUSED.
    // If the site never answers, the existing timeout alarm still fires and
    // the settle path marks PAUSED.
    await persistState();
    broadcastState();
    return { ok: true, note: "Pausing after current step settles." };
  }
  chrome.alarms.clear(ALARM_STEP);
  S.phase = PHASE.IDLE;
  S.currentIndex = -1;
  S.deadline = 0;
  await persistState();
  broadcastState();
  return { ok: true };
}

async function resumeRun() {
  if (!S) return { ok: false, error: "Nothing to resume — no saved run state." };
  if (S.status === STATUS.RUNNING || S.status === STATUS.RETRYING_FAILED) {
    return { ok: false, error: "Already running." };
  }
  if (S.status === STATUS.COMPLETED || S.status === STATUS.STOPPED) {
    return { ok: false, error: `Run is ${S.status}. Press Start for a new run.` };
  }

  // If an in-flight step was interrupted by the crash/pause, settle it before
  // advancing so we never leave two prompts "running" simultaneously.
  const inflightIdx = S.currentIndex;
  if ((S.phase === PHASE.SENDING || S.phase === PHASE.AWAIT_NEW_CHAT) &&
      inflightIdx >= 0 && S.items[inflightIdx] && S.items[inflightIdx].status === "running") {
    failItem(inflightIdx, "Interrupted mid-request — will be retried at the end.");
  }
  for (const it of S.items) if (it.status === "running") it.status = "pending";
  S.currentIndex = -1;
  S.phase = PHASE.IDLE;
  S.deadline = 0;
  chrome.alarms.clear(ALARM_STEP);

  // PAUSED or WAITING_LOGIN -> decide which pass we belong to:
  // if any never-attempted prompt remains we re-enter the MAIN pass,
  // otherwise any remaining pendings are retry items -> RETRYING_FAILED pass.
  const mainRemaining = S.items.some((i) => i.status === "pending" && !i.retried);
  S.status = mainRemaining ? STATUS.RUNNING : STATUS.RETRYING_FAILED;
  if (S.status === STATUS.RETRYING_FAILED) {
    S.retryQueue = S.items
      .map((it, i) => (it.status === "pending" && it.retried ? i : -1))
      .filter((i) => i >= 0);
    if (S.retryQueue.length === 0) return finishRun().then(() => ({ ok: true }));
  }
  S.lastError = "";
  S.recoveredFromCrash = false;
  chrome.alarms.clear(ALARM_AUTOLOGIN);
  await persistState();
  broadcastState();
  const resumedAt = S.status === STATUS.RETRYING_FAILED ? S.retryQueue[0] : firstPendingIndex();
  console.log(`[Swayam BG] RESUMED (${S.status}) at prompt #${resumedAt + 1}.`);
  await runNext();
  return { ok: true };
}

async function stopRun() {
  if (!S) return { ok: false, error: "No active run." };
  const hadInFlight = S.phase === PHASE.SENDING || S.phase === PHASE.AWAIT_NEW_CHAT;
  const inflightIdx = S.currentIndex;
  await clearAlarms();
  if (hadInFlight && inflightIdx >= 0 && S.items[inflightIdx]) {
    // Tell the page to abort whatever it started, then treat it as failed.
    if (S.activeTabId > 0) {
      chrome.tabs.sendMessage(S.activeTabId, { type: "ABORT_CURRENT" }).catch(() => {});
    }
    S.items[inflightIdx].status = "failed";
    S.items[inflightIdx].error = "Aborted by user (Stop).";
  }
  // Any still-running stragglers revert to pending so recovery stays honest.
  for (const it of S.items) if (it.status === "running") it.status = "pending";
  S.status = STATUS.STOPPED;
  S.phase = PHASE.IDLE;
  S.currentIndex = -1;
  S.deadline = 0;
  S.retryQueue = [];
  S.lastError = "Stopped by user. Partial results kept — use Export.";
  await persistState();
  broadcastState();
  console.log("[Swayam BG] RUN STOPPED.");
  return { ok: true };
}

async function discardRecovery() {
  await clearAlarms();
  S = makeIdleState(await loadSettings());
  await persistState();
  broadcastState();
  return { ok: true };
}

/* ------------------------------ Export -------------------------------- */

function csvEscape(value) {
  const s = String(value == null ? "" : value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildExport(format) {
  const items = S ? S.items : [];
  const base = `swayam-results-${stamp()}`;
  if (format === "json") {
    const payload = {
      exportedAt: new Date().toISOString(),
      ai: S ? S.settings.ai : null,
      total: items.length,
      succeeded: items.filter((i) => i.status === "done").length,
      failed: items.filter((i) => i.status === "failed").length,
      results: items.map((i, n) => ({
        index: n + 1,
        prompt: i.text,
        status: i.status,
        response: i.response || "",
        error: i.error || "",
        completedAt: i.completedAt,
      })),
    };
    return { filename: `${base}.json`, mime: "application/json", data: JSON.stringify(payload, null, 2) };
  }
  if (format === "txt") {
    const blocks = items.map((i, n) =>
      `### Prompt #${n + 1} [${i.status.toUpperCase()}]\n${i.text}\n\n--- Response ---\n${i.response || (i.error ? `(no response: ${i.error})` : "(none)")}\n`
    );
    return { filename: `${base}.txt`, mime: "text/plain", data: blocks.join("\n====================\n\n") };
  }
  // CSV (default)
  const header = "index,prompt,status,response,error\n";
  const rows = items
    .map((i, n) => [n + 1, csvEscape(i.text), i.status, csvEscape(i.response || ""), csvEscape(i.error || "")].join(","))
    .join("\n");
  return { filename: `${base}.csv`, mime: "text/csv", data: header + rows };
}

function exportResults(format) {
  if (!S || S.items.length === 0) {
    return { ok: false, error: "No results to export yet." };
  }
  const hasAny = S.items.some((i) => i.status === "done" || i.status === "failed");
  if (!hasAny) return { ok: false, error: "Nothing has run yet — no results to export." };

  const { filename, mime, data } = buildExport(format === "json" || format === "txt" ? format : "csv");

  // Blob URL instead of a data: URL — Chrome caps data: URLs at ~2 MB, which
  // large multi-prompt exports exceed. (Blob/data URLs are valid for
  // chrome.downloads.download.) Fall back to data: if Blob is unavailable.
  let url;
  try {
    url = URL.createObjectURL(new Blob([data], { type: mime }));
  } catch (err) {
    console.warn("[Swayam BG] Blob URL failed, falling back to data: URL:", err);
    url = "data:" + mime + ";charset=utf-8," + encodeURIComponent(data);
  }

  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, saveAs: false }, // relative filename => lands in default Downloads folder
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== "number") {
          const msg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download rejected.";
          console.error("[Swayam BG] Download failed:", msg);
          revokeQuietly(url);
          resolve({ ok: false, error: msg });
        } else {
          console.log(`[Swayam BG] Exported "${filename}" (download #${downloadId}).`);
          // Revoke once the download finishes (or after a generous grace
          // period) so the blob memory is not leaked by long sessions.
          const onDone = (delta) => {
            if (delta.id === downloadId && delta.state &&
                (delta.state.current === "complete" || delta.state.current === "interrupted")) {
              chrome.downloads.onChanged.removeListener(onDone);
              revokeQuietly(url);
            }
          };
          try { chrome.downloads.onChanged.addListener(onDone); } catch (_) {}
          setTimeout(() => { chrome.downloads.onChanged.removeListener(onDone); revokeQuietly(url); }, 120000);
          resolve({ ok: true, filename, downloadId });
        }
      }
    );
  });
}

function revokeQuietly(blobUrl) {
  try { if (blobUrl && blobUrl.startsWith("blob:")) URL.revokeObjectURL(blobUrl); } catch (_) {}
}

/* ------------------------ Content-script events ------------------------ */

/**
 * Phase 5.1 — Smart "Bad Response" heuristic. Some AI replies come back as
 * near-empty strings or canned refusals. Those are treated as FAILURES so the
 * prompt lands in retryQueue and is re-attempted during the final pass.
 */
const BAD_RESPONSE_PHRASES = [
  "i cannot answer",
  "i can't answer",
  "i cannot help with",
  "i can't help with",
  "as an ai language model",
  "as an ai assistant",
  "i'm sorry, but",
  "sorry, i can",
];
const BAD_RESPONSE_MIN_LEN = 15; // trim().length below this => bad

function isBadResponse(text) {
  const t = String(text || "").trim();
  if (t.length < BAD_RESPONSE_MIN_LEN) return "empty_or_too_short";
  const lower = t.toLowerCase();
  for (const phrase of BAD_RESPONSE_PHRASES) {
    if (lower.includes(phrase)) return "refusal_detected";
  }
  return null; // good response
}

async function onResponseCaptured(index, text) {
  if (!S) return;
  const item = S.items[index];
  // Guard against stale/duplicate messages: only accept the in-flight prompt.
  if (!item || S.currentIndex !== index || S.phase !== PHASE.SENDING) return;

  const badReason = isBadResponse(text);
  if (badReason) {
    // Mark FAILED (not done) so enterRetryPhase()/retryQueue picks it up at
    // the very end. Keep the captured text for user visibility.
    item.response = String(text || "");
    failItem(index, `Bad response (${badReason}): "${String(text || "").slice(0, 80)}"`);
    S.currentIndex = -1;
    S.phase = PHASE.IDLE;
    // BUGFIX: only pop retryQueue when this item IS the active retry item —
    // same guard as advanceAfterFailure() (which no longer shifts blindly).
    if (S.status === STATUS.RETRYING_FAILED && item.retried &&
        S.retryQueue.length && S.retryQueue[0] === index) {
      S.retryQueue.shift();
    }
    chrome.alarms.clear(ALARM_STEP);
    if (S.status === STATUS.PAUSED || S.status === STATUS.STOPPED) {
      S.deadline = 0;
      await persistState();
      broadcastState();
      return;
    }
    await persistState();
    broadcastState();
    await advanceAfterFailure();
    return;
  }

  item.status = "done";
  item.response = String(text || "");
  item.error = "";
  item.completedAt = new Date().toISOString();

  S.currentIndex = -1;
  S.phase = PHASE.IDLE;
  S.promptsSinceChat += 1;
  // BUGFIX: guard the shift — only pop when `index` is the active retry item.
  if (S.status === STATUS.RETRYING_FAILED && item.retried &&
      S.retryQueue.length && S.retryQueue[0] === index) {
    S.retryQueue.shift();
  }

  chrome.alarms.clear(ALARM_STEP);

  if (S.status === STATUS.PAUSED) {
    // Pause was requested mid-step: settle it now.
    S.deadline = 0;
    await persistState();
    broadcastState();
    return;
  }
  if (S.status === STATUS.STOPPED) { S.deadline = 0; await persistState(); broadcastState(); return; }

  await persistState();
  broadcastState();
  await advanceAfterSuccess();
}

async function advanceAfterSuccess() {
  const nextIdx =
    S.status === STATUS.RETRYING_FAILED
      ? (S.retryQueue.length ? S.retryQueue[0] : -1)
      : firstPendingIndex();
  if (nextIdx === -1) {
    return S.status === STATUS.RETRYING_FAILED ? finishRun() : enterRetryPhase();
  }
  await delayedDispatch();
}

async function onResponseFailed(index, error) {
  if (!S) return;
  const item = S.items[index];
  if (!item || S.currentIndex !== index || S.phase !== PHASE.SENDING) return;
  failItem(index, error);
  // BUGFIX: guard the shift — only pop when `index` is the active retry item.
  if (S.status === STATUS.RETRYING_FAILED && item.retried &&
      S.retryQueue.length && S.retryQueue[0] === index) {
    S.retryQueue.shift();
  }
  S.currentIndex = -1;
  S.phase = PHASE.IDLE;
  chrome.alarms.clear(ALARM_STEP);
  if (S.status === STATUS.PAUSED || S.status === STATUS.STOPPED) {
    S.deadline = 0;
    await persistState();
    broadcastState();
    return;
  }
  await persistState();
  broadcastState();
  await advanceAfterFailure();
}

async function onNewChatReady(ok, error) {
  if (!S || S.phase !== PHASE.AWAIT_NEW_CHAT) return;
  chrome.alarms.clear(ALARM_STEP);
  S.phase = PHASE.IDLE;
  S.deadline = 0;
  // BUGFIX: the AWAIT_NEW_CHAT timeout in handleStepAlarm() did NOT clear this
  // alarm after firing, so a lingering one-shot could re-enter this handler
  // later and double-count promptsSinceChat / race with an in-flight prompt.
  // Clear it here too (idempotent) for defense in depth.
  if (ok) {
    S.promptsSinceChat = 0;
    S.newChatFailures = 0; // reset the consecutive-failure guard on success
  } else {
    S.newChatFailures = (S.newChatFailures || 0) + 1;
    console.warn("[Swayam BG] New chat failed:", error, "— continuing in current chat.");
    // BUGFIX: do NOT reset promptsSinceChat on failure. The old code zeroed it,
    // which meant a single broken new-chat button silently downgraded the whole
    // run to "one chat for all" — exactly what the user asked to avoid. Keeping
    // the counter means the gate is retried before the next prompt, and the
    // engine only proceeds in the current chat after each individual failure.
    S.lastError = `New chat request failed (${error}). Retrying the new-chat step before the next prompt.`;
  }
  await persistState();
  broadcastState();
  if (S.status === STATUS.PAUSED || S.status === STATUS.STOPPED) return;
  await runNext();
}

/**
 * Content-script failure for a NEW-CHAT request (index -1). Without this the
 * engine would sit in AWAIT_NEW_CHAT until the timeout alarm fired.
 */
async function onNewChatFailed(error) {
  if (!S || S.phase !== PHASE.AWAIT_NEW_CHAT) return; // stray / stale message
  await onNewChatReady(false, String(error || "new_chat_failed"));
}

async function onNotLoggedIn() {
  if (!S) return;
  // Accept from RUNNING, RETRYING_FAILED, or an already-WAITING_LOGIN tab
  // (idempotent — re-arms the poll without corrupting state).
  if (S.status !== STATUS.RUNNING && S.status !== STATUS.RETRYING_FAILED &&
      S.status !== STATUS.WAITING_LOGIN) return;
  const idx = S.currentIndex;
  if (idx >= 0 && S.items[idx] && S.items[idx].status === "running") {
    S.items[idx].status = "pending"; // nothing actually got sent
  }
  chrome.alarms.clear(ALARM_STEP);
  S.currentIndex = -1;
  S.phase = PHASE.IDLE;
  S.deadline = 0;
  S.status = STATUS.WAITING_LOGIN;
  S.lastError = "Not logged in on the target site. Log in manually, then press Resume.";
  await persistState();
  broadcastState();
  await chrome.alarms.create(ALARM_AUTOLOGIN, { periodInMinutes: AUTOLOGIN_PERIOD_MIN });
}

/* ----------------------- Crash recovery on wake-up ---------------------- */

/**
 * Rebuild the state mirror from storage. If a run was INTERRUPTED (status
 * RUNNING/RETRYING_FAILED but the SW just booted), downgrade it to PAUSED and
 * flag it so the popup shows the recovery banner — per spec the user resumes
 * manually. Returns true if an interruption was recovered.
 */
async function initStateFromStorage() {
  const [stored, settings] = await Promise.all([
    chrome.storage.local.get(STATE_KEY),
    loadSettings(),
  ]);
  const saved = stored[STATE_KEY];

  if (!saved || !Array.isArray(saved.items)) {
    S = makeIdleState(settings);
    return false;
  }

  S = { ...makeIdleState(settings), ...saved, settings: { ...DEFAULT_SETTINGS, ...settings, ...(saved.settings || {}) } };

  const wasRunning = S.status === STATUS.RUNNING || S.status === STATUS.RETRYING_FAILED;
  if (wasRunning) {
    // Service worker restarted mid-run (browser crash / SW eviction).
    const idx = S.currentIndex;
    if (idx >= 0 && S.items[idx] && S.items[idx].status === "running") {
      // We cannot know whether the site received it — mark failed & skip;
      // it will be picked up in the final retry pass.
      S.items[idx].status = "failed";
      S.items[idx].error = "Interrupted (browser/extension restart) — will be retried at the end.";
    }
    for (const it of S.items) if (it.status === "running") it.status = "pending";
    S.status = STATUS.PAUSED;
    S.phase = PHASE.IDLE;
    S.currentIndex = -1;
    S.deadline = 0;
    S.lastError = "Session was interrupted. Press Resume to continue where it left off.";
    S.recoveredFromCrash = true;
    await persistState();
    console.warn("[Swayam BG] CRASH RECOVERY: interrupted run set to PAUSED at prompt #" + (firstPendingIndex() + 1));
    return true;
  }
  return false;
}

/* ------------------------------- Wiring --------------------------------- */

console.log("[Swayam BG] Service worker awake (Phase 2: queue engine).");

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Swayam BG] Installed/updated:", chrome.runtime.getManifest().version);
  await initStateFromStorage();
  broadcastState();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Swayam BG] Browser startup — checking for interrupted runs.");
  const recovered = await initStateFromStorage();
  if (recovered) broadcastState();
});

// SW wake-ups (alarms/messages) also need the mirror hydrated.
let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = initStateFromStorage().then(() => true);
  return initPromise;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInit();
  if (alarm.name === ALARM_STEP) {
    return handleStepAlarm();
  }
  if (alarm.name === ALARM_AUTOLOGIN) {
    // While WAITING_LOGIN, periodically probe; auto-continue once logged in.
    if (!S || S.status !== STATUS.WAITING_LOGIN) {
      chrome.alarms.clear(ALARM_AUTOLOGIN);
      return;
    }
    try {
      await ensureTargetTab();
      const loggedIn = await checkLoggedIn(S.activeTabId);
      if (loggedIn) {
        console.log("[Swayam BG] Login detected — auto-resuming run.");
        return resumeRun();
      }
    } catch (err) {
      console.warn("[Swayam BG] Login probe failed:", err);
    }
    return;
  }
});

/* ------------------- Phase 4: connection status probe ------------------- */

/**
 * Answer the popup's "am I connected to the selected AI?" question:
 *   green  = tab open + content script alive + logged in
 *   yellow = engine is actively processing (RUNNING / RETRYING_FAILED)
 *   red    = no usable tab, dead content script, or not logged in
 * Never mutates run state; purely a read-only snapshot for the UI.
 */
async function getConnectionStatus() {
  const settings = S ? S.settings : await loadSettings();
  const ai = settings.ai || DEFAULT_SETTINGS.ai;
  const status = S ? S.status : STATUS.IDLE;
  const active = status === STATUS.RUNNING || status === STATUS.RETRYING_FAILED;

  // While processing, report yellow regardless of probe noise — the engine
  // IS talking to the page, so a transient CHECK_LOGIN hiccup must not flip
  // the indicator to red mid-run.
  if (active) {
    return { ok: true, color: "yellow", label: "Processing…", ai, status };
  }

  let tab = null;
  try { tab = await findTargetTab(ai); } catch (_) { /* ignore */ }
  if (!tab) {
    return { ok: true, color: "red", label: "Not Connected", ai, status, reason: "no_tab" };
  }

  // Make sure the content script exists (inject fallback for tabs opened
  // before installation / after extension reload).
  let alive = await contentScriptAlive(tab.id);
  if (!alive) {
    try {
      await chrome.scripting.executeScript({
        files: [
          "content-scripts/adapters/adapter-utils.js",
          "content-scripts/adapters/chatgpt-adapter.js",
          "content-scripts/adapters/gemini-adapter.js",
          "content-scripts/adapters/claude-adapter.js",
          "content-scripts/content-script.js",
        ],
        target: { tabId: tab.id },
      });
      alive = await contentScriptAlive(tab.id);
    } catch (err) {
      console.warn("[Swayam BG] Status probe injection failed:", err);
      alive = false;
    }
  }
  if (!alive) {
    return { ok: true, color: "red", label: "Not Connected", ai, status, reason: "no_content_script" };
  }

  let loggedIn = false;
  let challenged = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "CHECK_LOGIN" });
    loggedIn = !!(res && res.loggedIn);
    challenged = !!(res && res.challenged);
  } catch (_) { /* treat as not connected */ }

  if (loggedIn) {
    return { ok: true, color: "green", label: `Connected to ${siteName(ai)}`, ai, status };
  }
  return {
    ok: true,
    color: "red",
    label: challenged ? "Blocked – manual action needed" : "Not Connected",
    ai, status,
    reason: challenged ? "challenge" : "not_logged_in",
  };
}

function siteName(ai) {
  return ai === "gemini" ? "Gemini" : ai === "claude" ? "Claude" : "ChatGPT";
}

/* ----------------- Phase 4: keyboard shortcut toggle ------------------- */

/**
 * Ctrl+Space (global command): RUNNING <-> PAUSED. IDLE/COMPLETED/STOPPED do
 * nothing. WAITING_LOGIN behaves like PAUSED (attempt resume by probing login).
 */
async function togglePauseResume() {
  await ensureInit();
  const st = S ? S.status : STATUS.IDLE;
  if (st === STATUS.RUNNING || st === STATUS.RETRYING_FAILED) {
    console.log("[Swayam BG] toggle-pause-resume -> pausing");
    return pauseRun();
  }
  if (st === STATUS.PAUSED || st === STATUS.WAITING_LOGIN) {
    console.log("[Swayam BG] toggle-pause-resume -> resuming");
    return resumeRun();
  }
  return { ok: false, error: `Nothing to toggle (status=${st})` };
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== "toggle-pause-resume") return;
    togglePauseResume().catch((err) => console.error("[Swayam BG] toggle failed:", err));
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  // Messages originating from our own content scripts carry sender.tab.
  const fromContentScript = !!(sender && sender.tab);

  (async () => {
    await ensureInit();

    /* ---- Phase 4: connection status probe (popup asks before mutating) ---
       GET_CONNECTION_STATUS must NOT run the generic state-refresh below so
       it stays fast and side-effect free. */
    if (message.type === "GET_CONNECTION_STATUS") {
      sendResponse(await getConnectionStatus());
      return;
    }

    // SW-eviction semantics: a freshly woken worker has a stale in-memory
    // mirror until initStateFromStorage() runs — and even after init, another
    // wake-up may have persisted newer state while we were asleep. So always
    // refresh the mirror from chrome.storage.local before acting on or
    // reporting state.
    if (!S || S.status === STATUS.IDLE || !S.items.length) {
      await initStateFromStorage();
    } else {
      try {
        const fresh = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
        if (fresh && Array.isArray(fresh.items) &&
            (!S.updatedAt || (fresh.updatedAt && fresh.updatedAt > S.updatedAt))) {
          S = fresh;
        }
      } catch (_) { /* keep in-memory mirror */ }
    }

    switch (message.type) {
      /* ---- popup -> background ---- */
      case "START_RUN":
        sendResponse(await startRun(message.queue));
        break;
      case "PAUSE_RUN":
        sendResponse(await pauseRun());
        break;
      case "RESUME_RUN":
        sendResponse(await resumeRun());
        break;
      case "STOP_RUN":
        sendResponse(await stopRun());
        break;
      case "DISCARD_RECOVERY":
        sendResponse(await discardRecovery());
        break;
      case "GET_STATE":
        sendResponse({ ok: true, state: S });
        break;
      case "EXPORT_RESULTS":
        sendResponse(await exportResults(message.format));
        break;

      /* ---- content script -> background ---- */
      case "RESPONSE_CAPTURED":
        if (fromContentScript) await onResponseCaptured(Number(message.index), message.text);
        sendResponse({ ok: true });
        break;
      case "RESPONSE_FAILED":
        if (fromContentScript) {
          const failedIdx = Number(message.index);
          // index -1 => the CREATE_NEW_CHAT flow failed, not a prompt. Route it
          // so the engine resumes immediately instead of waiting for timeout.
          if (failedIdx === -1) await onNewChatFailed(message.error);
          else await onResponseFailed(failedIdx, message.error);
        }
        sendResponse({ ok: true });
        break;
      case "NEW_CHAT_READY":
        if (fromContentScript) await onNewChatReady(!!message.ok, message.error);
        sendResponse({ ok: true });
        break;
      case "NOT_LOGGED_IN":
        if (fromContentScript) await onNotLoggedIn();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })().catch((err) => {
    console.error("[Swayam BG] Message handler error:", err);
    try { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); } catch (_) {}
  });

  return true; // keep the message channel open for the async sendResponse
});

// If the user closes the tab the run is driving, pause gracefully.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureInit();
  if (!S || S.activeTabId !== tabId) return;
  S.activeTabId = -1;
  if (S.status === STATUS.RUNNING || S.status === STATUS.RETRYING_FAILED) {
    if (S.phase === PHASE.SENDING || S.phase === PHASE.AWAIT_NEW_CHAT) {
      const idx = S.currentIndex;
      if (idx >= 0 && S.items[idx] && S.items[idx].status === "running") {
        failItem(idx, "Target tab was closed mid-response.");
        S.currentIndex = -1;
      }
      S.phase = PHASE.IDLE;
    }
    S.status = STATUS.PAUSED;
    S.lastError = "The AI tab was closed. Reopen it and press Resume.";
    chrome.alarms.clear(ALARM_STEP);
    await persistState();
    broadcastState();
  }
});
