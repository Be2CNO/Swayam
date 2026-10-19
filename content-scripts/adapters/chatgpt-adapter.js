/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/adapters/chatgpt-adapter.js  (ChatGPTAdapter)
   --------------------------------------------------------------------------
   Site: chat.openai.com / www.chatgpt.com / chatgpt.com
   Registers itself on window.__SWAYAM_ADAPTERS__.chatgpt.

   >>> EDIT ME FIRST when OpenAI changes their UI <<<
   Everything the automation touches is declared in SELECTORS below.
   Rules for editing:
     - Each key maps to an ARRAY of fallbacks, tried top-to-bottom.
     - Use ONLY stable attributes: #id, [aria-label=..], [data-testid=..],
       [role=..], [name=..]. NEVER use hashed Tailwind/CSS-module classes.
     - An entry may also be { css: "...", text: ["word"] } to additionally
       require one of the words inside the element's visible text.
   ========================================================================== */

"use strict";

(function registerChatGPTAdapter() {
  const U = () => window.__SWAYAM_UTILS__;

  /* ============================ CONFIG ================================== **/
  const SELECTORS = {
    // The prompt composer. ChatGPT currently uses a <textarea id="prompt-textarea">;
    // fallbacks cover the contenteditable variants they have shipped before.
    composer: [
      "#prompt-textarea",
      "textarea[aria-label='Prompt']",
      "textarea[placeholder]",
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
    ],

    // Send button next to the composer.
    sendButton: [
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[data-testid="send-button"]',
      'form button[type="submit"]',
    ],

    // Conversation scroll container holding all message rows.
    conversationContainer: [
      'main [data-testid="conversation-layout-box"]',
      "main",
      "#root main",
    ],

    // One row per assistant reply. Fallbacks are generic enough to survive
    // class churn because they key off role/aria attributes only.
    assistantMessageNodes: [
      '[data-testid^="message-response-wrapper"]',
      "article[data-message-author-role='assistant']",
      "response", // <response> custom element used by ChatGPT markdown renderer
      'div.message-assistant',
    ],

    // "Stop generating" button — its disappearance is completion signal #1.
    stopGeneratingButton: [
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop response"]',
    ],

    // Per-message controls bar containing Copy — appearance on the LAST
    // assistant message is completion signal #2.
    copyButtonInLastMessage: [
      'button[aria-label="Copy response"]',
      'button[aria-label="Copy"]',
      'button[data-testid="copy-response-btn"]',
    ],

    // New-chat control(s).
    newChatButton: [
      'button[aria-label="New chat"]',
      'a[aria-label="New chat"]',
      'button[data-testid="sidebar-new-chat-button"]',
      { css: "a", text: ["new chat"] },
      { css: "button", text: ["new chat"] },
    ],

    // Login / auth wall indicators. If ANY matches while no composer exists
    // -> NOT_LOGGED_IN.
    loginWall: [
      'button[aria-label="Log in"]',
      'a[href*="/login"]',
      'a[href*="auth/login"]',
      'button[data-testid="login-button"]',
      { css: "h1,h2", text: ["sign in", "log in", "get started", "choose how you want to use"] },
    ],

    // Cloudflare / challenge page indicators (manual interaction needed).
    challengeWall: [
      { css: "title", text: ["just a moment", "verify you are human", "checking your browser"] },
      { css: "h1,h2", text: ["verify you are human", "attention required"] },
      "#challenge-form",
      'iframe[src*="challenges.cloudflare.com"]',
    ],
  };
  /* ======================================================================= */

  function findComposer() {
    return U().queryFirst(document, SELECTORS.composer);
  }

  function lastAssistantNode() {
    return U().lastNodeOf(
      document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "))
    );
  }

  function generationRunning() {
    return !!U().queryVisible(document, SELECTORS.stopGeneratingButton);
  }

  /**
   * Completion signals — FIRST MATCH WINS, per Phase 3 spec:
   *   Signal #1: the stop-generating button disappeared AND a new assistant
   *              message exists with content.
   *   Signal #2: a per-message "copy" control appeared on the LAST message.
   *   Signal #3: no DOM mutations inside the last message for `settleMs`
   *              (evaluated by observeResponse's poller, not here).
   * Returns the completed node, or null.
   */
  function detectCompletion(prevCount, quietForMs, settleMs) {
    // Signal #2 — independent of generation state: copy affordance on the
    // newest assistant message that wasn't there before this turn.
    const nodesNow = Array.from(
      document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "))
    );
    if (nodesNow.length > prevCount) {
      const lastNew = nodesNow[nodesNow.length - 1];
      if (lastNew && U().queryFirst(lastNew, SELECTORS.copyButtonInLastMessage)) {
        return lastNew;
      }
    }

    // While generation is still running nothing else can be "done".
    if (generationRunning()) return null;

    // Signal #1 — stop button gone + a new (or newly non-empty) reply exists.
    const count = nodesNow.length;
    if (count === 0) return null;
    const last = nodesNow[count - 1];
    const txt = (last.innerText || "").trim();
    const isNew = count > prevCount;
    if (isNew && txt.length > 0) return last;

    // Signal #3 — same-node regeneration (count unchanged): only trust it once
    // the subtree has been quiet for settleMs.
    if (!isNew && txt.length > 0 &&
        typeof quietForMs === "number" && typeof settleMs === "number" &&
        quietForMs >= settleMs) {
      return last;
    }
    return null;
  }

  const adapter = {
    site: "chatgpt",

    checkLogin() {
      // Composer present => the app shell loaded => logged in.
      if (findComposer()) return { loggedIn: true, challenged: false };
      // Cloudflare / bot challenge => user must interact manually.
      if (U().queryFirst(document, SELECTORS.challengeWall)) {
        return { loggedIn: false, challenged: true };
      }
      // Auth wall (login prompt) or simply no composer => not usable right now.
      return { loggedIn: false, challenged: false };
    },

    /**
     * Insert `text` into the composer and press send.
     * Resolves { ok, error? }. Does NOT wait for the response.
     */
    async sendPrompt(text) {
      const composer = await U().waitFor(findComposer, { timeoutMs: 15000, intervalMs: 300 });
      if (!composer) return { ok: false, error: "composer_not_found" };

      if (!U().setText(composer, text)) return { ok: false, error: "composer_fill_failed" };

      // Verify the app registered our text before sending.
      const registered = await U().waitFor(() => {
        const v = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent;
        return v && v.trim().length > 0 ? true : null;
      }, { timeoutMs: 3000, intervalMs: 100 });
      if (!registered) return { ok: false, error: "composer_text_not_registered" };

      const btn = U().queryVisible(composer.closest("form") || document, SELECTORS.sendButton) ||
                  U().queryVisible(document, SELECTORS.sendButton);
      if (btn) {
        U().realClick(btn);
        return { ok: true };
      }
      // Fallback: Enter keydown on the composer.
      if (U().pressEnter(composer)) return { ok: true };
      return { ok: false, error: "send_control_not_found" };
    },

    /**
     * Observe the conversation until the assistant reply is complete.
     * Resolves with the captured text, or rejects via {ok:false,...} result.
     */
    observeResponse(opts) {
      const o = Object.assign({ settleMs: 2500, hardTimeoutMs: 120000 }, opts || {});
      return new Promise((resolve) => {
        const container =
          U().queryFirst(document, SELECTORS.conversationContainer) || document.body;
        const startNodes = document.querySelectorAll(
          SELECTORS.assistantMessageNodes.join(", ")
        );
        const prevCount = startNodes.length;

        let finished = false;
        let lastMutationAt = Date.now();
        let generationStarted = false; // saw the stop button after send
        let observer = null;
        let poller = null;
        let hardTimer = null;

        const finish = (node) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ ok: true, text: U().extractText(node) });
        };
        const fail = (reason) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ ok: false, error: reason });
        };
        const cleanup = () => {
          try { observer && observer.disconnect(); } catch (_) {}
          poller && clearInterval(poller);
          hardTimer && clearTimeout(hardTimer);
        };

        observer = new MutationObserver(() => {
          lastMutationAt = Date.now();
          const done = detectCompletion(prevCount, Date.now() - lastMutationAt, o.settleMs);
          if (done) finish(done);
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });

        // Poll: handles (a) instant answers where mutations settled before we
        // attached, and (b) completion signal #3 — no DOM mutation inside the
        // last message node for `settleMs`.
        poller = setInterval(() => {
          if (generationRunning()) generationStarted = true;
          const quietFor = Date.now() - lastMutationAt;
          const done = detectCompletion(prevCount, quietFor, o.settleMs);
          if (done) return finish(done);
          // Signal #3 fallback when message count didn't change (edit/regen):
          // require that generation was actually seen running first.
          if (generationStarted && !generationRunning() && quietFor >= o.settleMs) {
            const nodes = document.querySelectorAll(
              SELECTORS.assistantMessageNodes.join(", ")
            );
            const last = nodes.length ? nodes[nodes.length - 1] : null;
            if (last && (last.innerText || "").trim().length > 0) return finish(last);
          }
        }, 400);

        hardTimer = setTimeout(() => fail("timeout"), o.hardTimeoutMs);
      });
    },

    async createNewChat() {
      const beforeUrl = location.href;
      const btn = U().queryVisible(document, SELECTORS.newChatButton);
      if (!btn) return { ok: false, error: "new_chat_button_not_found" };
      U().realClick(btn);

      // Wait for either a URL change (root path or a brand-new conversation id)
      // OR a fresh empty composer with zero assistant messages.
      const ready = await U().waitFor(() => {
        const urlChanged = location.href !== beforeUrl;
        const composer = findComposer();
        const msgCount = document.querySelectorAll(
          SELECTORS.assistantMessageNodes.join(", ")
        ).length;
        const resetConversation = composer && msgCount === 0;
        return urlChanged || resetConversation ? true : null;
      }, { timeoutMs: 15000, intervalMs: 300 });

      if (!ready) return { ok: false, error: "new_chat_not_confirmed" };
      // Give the SPA a beat to mount the fresh composer.
      await U().waitFor(findComposer, { timeoutMs: 8000, intervalMs: 250 });
      return { ok: true };
    },

    abortCurrent() {
      const stop = U().queryVisible(document, SELECTORS.stopGeneratingButton);
      if (stop) U().realClick(stop);
      return { ok: true };
    },

    SELECTORS, // exposed so power users can inspect/tweak at runtime
  };

  window.__SWAYAM_ADAPTERS__ = window.__SWAYAM_ADAPTERS__ || {};
  window.__SWAYAM_ADAPTERS__.chatgpt = adapter;
})();
