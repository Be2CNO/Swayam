/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/content-script.js
   --------------------------------------------------------------------------
   Runs on chat.openai.com / chatgpt.com / gemini.google.com / claude.ai.
   Phase 1: File structure established. In later phases this script will:
     - Detect the target site and locate the composer input + send button
     - Inject prompts and trigger send (typing events the sites accept)
     - Use MutationObserver to detect when a response is fully complete
     - Capture the response text and report it back to the background worker
     - Detect logged-out state and notify the engine to pause & wait
   It NEVER attempts CAPTCHA bypass, login automation, or model switching.
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

  console.log(`[Swayam Content] Loaded on "${site}" (${location.hostname}) — Phase 1 stub.`);
})();
