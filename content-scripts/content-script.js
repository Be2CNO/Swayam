/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/content-script.js
   --------------------------------------------------------------------------
   Runs on chat.openai.com / chatgpt.com / gemini.google.com / claude.ai.
   Phase 2: message-protocol skeleton only (so the background engine's PING /
   CHECK_LOGIN probes get well-formed answers). The real DOM automation —
   composer injection, MutationObserver response-completion detection,
   RESPONSE_CAPTURED / NEW_CHAT_READY / NOT_LOGGED_IN reporting — arrives in
   Phase 3. It NEVER attempts CAPTCHA bypass, login automation, or model
   switching.
   ========================================================================== */

"use strict";

(function initSwayamContentScript() {
  const site = (() => {
    const host = location.hostname;
    if (host.endsWith("chat.openai.com") || host.endsWith("chatgpt.com")) return "chatgpt";
    if (host.endsWith("gemini.google.com")) return "gemini";
    if (host.endsWith("claude.ai")) return "claude";
    return "unknown";
  })();

  console.log(`[Swayam Content] Loaded on "${site}" (${location.hostname}) — Phase 2 protocol stub.`);

  // Guard against double-injection (manifest + chrome.scripting.executeScript).
  if (window.__swayamContentLoaded) return;
  window.__swayamContentLoaded = true;

  /* ---------------- Protocol skeleton (Phase 3 fills these in) ---------- */

  function isProbablyLoggedIn() {
    // Phase 3: per-site composer/login-wall heuristics. Conservative false for
    // now so the engine never sends prompts before real detection exists.
    return false;
  }

  function handleSendPrompt(index, text) {
    // Phase 3: inject into composer, trigger send, observe completion, then
    // report RESPONSE_CAPTURED / RESPONSE_FAILED for this index.
    console.warn("[Swayam Content] SEND_PROMPT received but DOM automation lands in Phase 3.", { index, preview: String(text).slice(0, 80) });
    chrome.runtime.sendMessage({
      type: "RESPONSE_FAILED",
      index,
      error: "Content-script automation not implemented yet (Phase 3).",
    }).catch(() => {});
  }

  function handleCreateNewChat() {
    // Phase 3: click the site's "new chat" control, wait for the URL/DOM to
    // settle, then confirm with NEW_CHAT_READY.
    console.warn("[Swayam Content] CREATE_NEW_CHAT received but automation lands in Phase 3.");
    chrome.runtime.sendMessage({
      type: "NEW_CHAT_READY",
      ok: false,
      error: "Not implemented until Phase 3.",
    }).catch(() => {});
  }

  function handleAbortCurrent() {
    // Phase 3: stop generation (e.g. click the site's Stop button).
    console.log("[Swayam Content] ABORT_CURRENT — no-op until Phase 3.");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    switch (message.type) {
      case "PING":
        sendResponse({ ok: true, site });
        return false;
      case "CHECK_LOGIN":
        sendResponse({ ok: true, loggedIn: isProbablyLoggedIn(), site });
        return false;
      case "SEND_PROMPT":
        handleSendPrompt(Number(message.index), String(message.text || ""));
        sendResponse({ ok: true, accepted: true });
        return false;
      case "CREATE_NEW_CHAT":
        handleCreateNewChat();
        sendResponse({ ok: true, accepted: true });
        return false;
      case "ABORT_CURRENT":
        handleAbortCurrent();
        sendResponse({ ok: true });
        return false;
      default:
        return false; // STATE_UPDATE etc. — ignore for now
    }
  });
})();
