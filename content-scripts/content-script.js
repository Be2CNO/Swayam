/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/content-script.js  (router / protocol bridge)
   --------------------------------------------------------------------------
   Loaded AFTER the adapter files:
     adapters/adapter-utils.js, adapters/chatgpt-adapter.js,
     adapters/gemini-adapter.js, adapters/claude-adapter.js
   (all four are listed in manifest.json "content_scripts.js", and the
   background worker injects the same list via chrome.scripting as a fallback).

   Responsibilities:
     - Pick the correct adapter for location.hostname.
     - Speak the EXACT background.js protocol:
         inbound : PING, CHECK_LOGIN, SEND_PROMPT, CREATE_NEW_CHAT, ABORT_CURRENT
         outbound: RESPONSE_CAPTURED, RESPONSE_FAILED, NEW_CHAT_READY, NOT_LOGGED_IN
     - Enforce safety rules: never solve CAPTCHAs, never read credentials or
       cookies, never bypass anti-bot walls — on blockage we simply report and
       let the human take over.

   NOTE ON TIMERS: setTimeout/setInterval ARE allowed here (content scripts run
   in the page and survive as long as the tab does). The MV3 no-timer rule only
   applies to the background service worker, which uses chrome.alarms instead.
   ========================================================================== */

"use strict";

(function initSwayamContentScript() {
  // Guard against double-injection (manifest declaration + executeScript).
  if (window.__swayamContentLoaded) return;
  window.__swayamContentLoaded = true;

  const utils = window.__SWAYAM_UTILS__;
  if (!utils) {
    console.error("[Swayam CS] adapter-utils.js missing — automation disabled.");
    return;
  }

  /* ------------------------------ Router -------------------------------- */
  function siteFromHostname(host) {
    host = (host || "").toLowerCase();
    if (host === "chat.openai.com" || host.endsWith(".chat.openai.com")) return "chatgpt";
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return "chatgpt";
    if (host === "gemini.google.com" || host.endsWith(".gemini.google.com")) return "gemini";
    if (host === "claude.ai" || host.endsWith(".claude.ai")) return "claude";
    return "unknown";
  }

  const SITE = siteFromHostname(location.hostname);
  const REGISTRY = window.__SWAYAM_ADAPTERS__ || {};
  const adapter = REGISTRY[SITE] || null;

  if (!adapter) {
    console.warn(`[Swayam CS] No adapter registered for "${SITE}" (${location.hostname}).`);
  } else {
    console.log(`[Swayam CS] Phase 3 automation active — adapter: ${adapter.site}`);
  }

  /* --------------------------- Send helpers ------------------------------ */
  function postToBackground(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {}); // engine may be asleep/restarting
    } catch (_) {
      /* extension context invalidated (reload during dev) — ignore */
    }
  }

  /* ------------------------- In-flight job tracking ---------------------- */
  // Only ONE prompt can ever be in flight (spec: strictly sequential), so a
  // single-slot tracker is enough. abortCurrent() flips `aborted`.
  let currentJob = null;

  function newJob(index) {
    return { index, aborted: false };
  }

  /* ---------------------------- SEND_PROMPT ------------------------------ */
  async function handleSendPrompt(index, text, timeoutSeconds) {
    if (!adapter) {
      postToBackground({ type: "RESPONSE_FAILED", index, error: `no_adapter_for_${SITE}` });
      return;
    }
    if (currentJob) {
      // Defensive: engine should never overlap; refuse politely.
      postToBackground({ type: "RESPONSE_FAILED", index, error: "busy_previous_prompt_in_flight" });
      return;
    }

    const job = newJob(index);
    currentJob = job;

    // Fresh conversation snapshot BEFORE injecting anything.
    const beforeNodes = document.querySelectorAll(
      (adapter.SELECTORS.assistantMessageNodes || []).join(", ")
    );
    const prevCount = beforeNodes.length;
    const prevLastText = beforeNodes.length
      ? utils.extractText(beforeNodes[beforeNodes.length - 1])
      : "";

    // 1) Fill composer + press send.
    const sent = await adapter.sendPrompt(String(text || ""));
    if (job.aborted) { currentJob = null; return; }
    if (!sent || !sent.ok) {
      postToBackground({
        type: "RESPONSE_FAILED",
        index,
        error: `send_failed:${(sent && sent.error) || "unknown"}`,
      });
      currentJob = null;
      return;
    }

    // 2) Wait until a NEW assistant message appears (or the last one changes).
    const appeared = await utils.waitFor(() => {
      const nodes = document.querySelectorAll(
        (adapter.SELECTORS.assistantMessageNodes || []).join(", ")
      );
      if (!nodes.length) return null;
      const last = nodes[nodes.length - 1];
      const grew = nodes.length > prevCount;
      const changed = !grew && utils.extractText(last) !== prevLastText;
      return grew || changed ? last : null;
    }, { timeoutMs: 45000, intervalMs: 500 });

    if (job.aborted) { currentJob = null; return; }
    if (!appeared) {
      postToBackground({ type: "RESPONSE_FAILED", index, error: "response_never_started" });
      currentJob = null;
      return;
    }

    // 3) Completion detection (MutationObserver + signals inside the adapter).
    const hardMs = Math.max(10, Number(timeoutSeconds) || 120) * 1000;
    const result = await adapter.observeResponse({ settleMs: 2500, hardTimeoutMs: hardMs });

    if (!job.aborted) {
      if (result && result.ok) {
        postToBackground({ type: "RESPONSE_CAPTURED", index, text: result.text || "" });
      } else {
        const reason = (result && result.error) || "capture_failed";
        postToBackground({ type: "RESPONSE_FAILED", index, error: reason });
      }
    }
    currentJob = null;
  }

  /* --------------------------- CREATE_NEW_CHAT --------------------------- */
  async function handleCreateNewChat() {
    if (!adapter) {
      postToBackground({ type: "NEW_CHAT_READY", ok: false, error: `no_adapter_for_${SITE}` });
      return;
    }
    try {
      const res = await adapter.createNewChat();
      if (res && res.ok) {
        postToBackground({ type: "NEW_CHAT_READY", ok: true });
      } else {
        postToBackground({
          type: "RESPONSE_FAILED",
          index: -1,
          error: `new_chat_failed:${(res && res.error) || "unknown"}`,
        });
      }
    } catch (err) {
      postToBackground({
        type: "RESPONSE_FAILED",
        index: -1,
        error: `new_chat_failed:${String(err && err.message ? err.message : err)}`,
      });
    }
  }

  /* ---------------------------- ABORT_CURRENT ---------------------------- */
  function handleAbortCurrent() {
    if (currentJob) currentJob.aborted = true;
    if (adapter && typeof adapter.abortCurrent === "function") {
      try { adapter.abortCurrent(); } catch (_) {}
    }
  }

  /* ----------------------------- CHECK_LOGIN ----------------------------- */
  function handleCheckLogin() {
    if (!adapter) return { loggedIn: false, challenged: false, site: SITE, noAdapter: true };
    let res = { loggedIn: false, challenged: false };
    try {
      res = adapter.checkLogin() || res;
    } catch (_) { /* defensive */ }
    // Safety rule: blocked/challenged pages are reported, NEVER auto-handled.
    if (res.challenged) {
      postToBackground({ type: "NOT_LOGGED_IN", challenged: true });
    } else if (!res.loggedIn) {
      postToBackground({ type: "NOT_LOGGED_IN", challenged: false });
    }
    return { loggedIn: !!res.loggedIn, challenged: !!res.challenged, site: SITE };
  }

  /* --------------------------- Message router ---------------------------- */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    // Ignore our own outbound broadcasts echoed back / STATE_UPDATE noise.
    if (message.type === "STATE_UPDATE") return false;

    switch (message.type) {
      case "PING":
        sendResponse({ ok: true, site: SITE, automationReady: !!adapter });
        return false;

      case "CHECK_LOGIN": {
        const r = handleCheckLogin();
        sendResponse(Object.assign({ ok: true }, r));
        return false;
      }

      case "SEND_PROMPT": {
        const idx = Number(message.index);
        const txt = String(message.text || "");
        const tmo = Number(message.timeoutSeconds) || undefined;
        handleSendPrompt(idx, txt, tmo);
        sendResponse({ ok: true, accepted: true });
        return false;
      }

      case "CREATE_NEW_CHAT":
        handleCreateNewChat();
        sendResponse({ ok: true, accepted: true });
        return false;

      case "ABORT_CURRENT":
        handleAbortCurrent();
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });
})();
