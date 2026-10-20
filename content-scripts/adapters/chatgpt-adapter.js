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

    // Positive logged-in signals — checked FIRST by checkLogin(). The composer
    // is the primary one; the sidebar/user menu (avatar) catches pages where
    // the composer has not mounted yet but the session is clearly active.
    loggedInSignals: [
      "#prompt-textarea",
      'textarea[aria-label="Prompt"]',
      'div[contenteditable="true"][role="textbox"]',
      '[data-testid="sidebar-user-menu"]',
      '[data-testid="profile-image"]',
      'button[aria-label="Open user menu"]',
    ],

    // Login / auth wall indicators. If ANY of these is visible, we report
    // NOT_LOGGED_IN even if a composer-like element also matched (the landing
    // page shows its own prompt box next to a "Log in" CTA).
    loginWall: [
      'button[aria-label="Log in"]',
      'a[href*="/auth/login"]',
      'a[href*="/sign-up"]',
      'a[href*="/register"]',
      'button[data-testid="login-button"]',
      { css: "button,a", text: ["log in", "sign up", "sign in"] },
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
   * How long to wait (ms) for the send button to become enabled after the
   * composer text was registered. Phase 4: the first prompt used to fail
   * because we clicked while React still had the button disabled.
   */
  const SEND_ENABLE_TIMEOUT_MS = 5000;

  /** Small async sleep helper (content scripts may use timers freely). */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      // 1) Cloudflare / bot challenge => user must interact manually.
      if (U().queryFirst(document, SELECTORS.challengeWall)) {
        return { loggedIn: false, challenged: true };
      }

      // 2) Auth wall visible ("Log in" CTA etc.) => NOT_LOGGED_IN, even when a
      //    composer-like element also matched: ChatGPT's landing page renders
      //    its own prompt box next to login/signup buttons.
      if (U().queryVisible(document, SELECTORS.loginWall)) {
        return { loggedIn: false, challenged: false };
      }

      // 3) Positive logged-in signals: working composer OR the sidebar user
      //    menu / avatar (session active while the app shell still mounts).
      const composer = findComposer();
      if (composer && !U().queryVisible(document, SELECTORS.loginWall)) {
        return { loggedIn: true, challenged: false };
      }
      if (U().queryFirst(document, SELECTORS.loggedInSignals)) {
        return { loggedIn: true, challenged: false };
      }

      // Nothing usable yet.
      return { loggedIn: false, challenged: false };
    },

    /**
     * Insert `text` into the composer and press send.
     * Resolves { ok, error? }. Does NOT wait for the response.
     *
     * Phase 4 fix (first-prompt failure on ChatGPT): after the native setter
     * trick fills the textarea, React needs a tick to re-render and ENABLE the
     * send button (it is disabled while its internal state thinks the composer
     * is empty). We therefore:
     *   1. focus the composer first (ChatGPT's handlers expect it),
     *   2. write via the HTMLTextAreaElement native value setter + input event,
     *   3. POLL up to SEND_ENABLE_TIMEOUT_MS for the send button to become
     *      enabled (`disabled` attr / aria-disabled / disabled-style classes),
     *   4. click it once enabled; if it never enables within the window we do
     *      NOT fail outright yet — Enter keydown is tried as a fallback —
     *      and only then return a failure so the engine can mark/skip/retry.
     */
    async sendPrompt(text) {
      // Phase 5.1 hotfix — exact targeting per spec: the ChatGPT composer is
      // either a <textarea> (inside the prompt <form>) or a contenteditable
      // div. findComposer() already covers both; this line documents intent.
      const composer = await U().waitFor(
        () => document.querySelector("form textarea") ||
              document.querySelector('div[contenteditable="true"]') ||
              findComposer(),
        { timeoutMs: 15000, intervalMs: 300 }
      );
      if (!composer) return { ok: false, error: "composer_not_found" };

      // 1) Focus FIRST — React handlers on ChatGPT's composer expect focus
      //    before programmatic value changes are registered.
      try { composer.focus(); } catch (_) { /* non-fatal */ }

      // 2) Clear any residual text so the native setter starts from empty
      //    (stale drafts caused the first-prompt failure).
      try {
        if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
          U().setNativeValue(composer, "");
        } else if (composer.isContentEditable) {
          composer.textContent = "";
        }
      } catch (_) { /* non-fatal */ }

      // 3) Insert text using the React-bypass method:
      //    - textarea  -> HTMLTextAreaElement.prototype native value setter
      //                    + input/change events (forces React state update)
      //    - contenteditable -> document.execCommand("insertText", ...) which
      //                    fires the correct beforeinput/input InputEvents
      //                    that React contenteditables listen to.
      let filled = false;
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        filled = U().setNativeValue(composer, text);
      } else if (composer.isContentEditable) {
        try {
          composer.focus();
          filled = document.execCommand("insertText", false, text);
          if (!filled || !(composer.textContent || "").includes(text.slice(0, 20))) {
            // execCommand unsupported/blocked -> manual DOM write + events.
            composer.textContent = text;
            composer.dispatchEvent(new InputEvent("input", {
              bubbles: true, cancelable: true, inputType: "insertText", data: text,
            }));
            filled = true;
          }
        } catch (_) { filled = false; }
      }
      if (!filled) return { ok: false, error: "composer_fill_failed" };

      // 4) Dispatch events to force React to update its internal state.
      try {
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) { /* non-fatal */ }

      // Verify the app registered our text before sending.
      const registered = await U().waitFor(() => {
        const v = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent;
        return v && v.trim().length > 0 ? true : null;
      }, { timeoutMs: 3000, intervalMs: 100 });
      if (!registered) return { ok: false, error: "composer_text_not_registered" };

      // 6) Wait ~500 ms for the UI to settle and enable the send button, then
      //    poll up to SEND_ENABLE_TIMEOUT_MS (5 s) for it to become clickable.
      await sleep(500);
      const scope = () => composer.closest("form") || document;
      let btn = null;
      const deadline = Date.now() + SEND_ENABLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const candidate =
          U().queryVisible(scope(), SELECTORS.sendButton) ||
          U().queryVisible(document, SELECTORS.sendButton);
        if (candidate && !U().isDisabledLike(candidate)) { btn = candidate; break; }
        await sleep(150);
      }

      // 7) Click the send button directly (more reliable than pressing Enter).
      if (btn) {
        U().realClick(btn);
        return { ok: true };
      }

      // Button never enabled within 5 s -> fallback: Enter keydown on the
      // composer (ChatGPT submits on Enter when the model accepts it).
      if (U().pressEnter(composer)) {
        // Confirm something actually happened: composer cleared OR generation
        // started (stop button appeared) within a short grace window.
        const sent = await U().waitFor(() => {
          const v = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
            ? composer.value
            : composer.textContent;
          const cleared = !v || v.trim().length === 0;
          return cleared || generationRunning() ? true : null;
        }, { timeoutMs: 4000, intervalMs: 200 });
        if (sent) return { ok: true };
        return { ok: false, error: "send_button_never_enabled" };
      }

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
