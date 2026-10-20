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
   * SAFETY: this helper is the ONLY place the stop control is ever touched.
   * It NEVER clicks it — it only reads its presence/absence as a completion
   * signal. (abortCurrent() below is the sole sanctioned clicker, and only
   * when the user explicitly pauses/stops via the engine.)
   */
  function hasStopButton() {
    return generationRunning();
  }

  /** True when `el` visibly contains streaming/thinking placeholder text. */
  const THINKING_RE = /\b(thinking|deep in thought|analyzing|visualizing|generating|searching|browsing|reflecting|wandering|pondering)\b/i;
  function looksLikeThinking(el) {
    if (!el) return false;
    try {
      const txt = String(el.innerText || el.textContent || "").trim();
      return txt.length > 0 && txt.length <= 80 && THINKING_RE.test(txt);
    } catch (_) {
      return false;
    }
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
  function detectCompletion(ctx) {
    // EMERGENCY FIX — generation STATE MACHINE. Completion is now evaluated in
    // exactly ONE place (the poller inside observeResponse), which guarantees:
    //   * WAITING_FOR_START -> GENERATING only when REAL answer text appears
    //     (stop-button presence alone never counts as "started"), and
    //   * GENERATING -> COMPLETED only after the DOM has been quiet for
    //     `settleMs` AND the stop button is gone.
    // The previous multi-signal version captured empty/thinking placeholders
    // the instant the stop button vanished during the AI's pre-typing delay.
    const { prevCount, prevLastText, startedAt, sawStop, settleMs } = ctx;

    // Never complete before a small grace window after send — covers the
    // thinking/processing delay where the UI briefly shows no stop button.
    if (Date.now() - startedAt < 2500) return null;

    // Still generating? (stop control visible => not done, period.)
    if (hasStopButton()) return null;

    const nodesNow = Array.from(
      document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "))
    );
    if (!nodesNow.length) return null;
    const last = nodesNow[nodesNow.length - 1];

    const grew = nodesNow.length > prevCount;
    const txt = String(last.innerText || "").replace(/\u00a0/g, " ").trim();

    // Streaming/thinking placeholder ("Thinking…", "Deep in thought…") is NOT
    // an answer: keep waiting instead of capturing it.
    if (txt && looksLikeThinking(last)) return null;

    // A brand-new node whose content equals the previous last reply is just a
    // re-render artifact, not our response.
    if (grew && prevLastText && txt === prevLastText) return null;

    // No real text yet => we are still in WAITING_FOR_START.
    if (!txt) return null;

    // Quiet long enough => COMPLETED. If we ever saw the stop button, its
    // disappearance already proves generation ended; otherwise require the
    // full quiet window measured from first-seen-text.
    const quietSinceStart = Date.now() - Math.max(sawStop ? ctx.lastMutationAt : ctx.textSeenAt, 0);
    const quietOk = ctx.sawStop
      ? Date.now() - ctx.textSeenAt >= 400
      : Date.now() - ctx.textSeenAt >= settleMs;
    if (!quietOk) return null;
    void quietSinceStart;

    return last;
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
     * EMERGENCY FIX — generation STATE MACHINE:
     *
     *   WAITING_FOR_START  -> AI hasn't produced real answer text yet.
     *                         (Thinking placeholders / empty nodes do NOT
     *                         count as started; this was the premature-
     *                         capture bug.)
     *   GENERATING         -> real text has appeared; quiet timer resets on
     *                         every DOM mutation inside the last message node.
     *   COMPLETED          -> stop button gone AND no mutations for `settleMs`
     *                         (default 2000ms). Observer disconnected, text
     *                         extracted, RESPONSE_CAPTURED sent by the router.
     *
     * Hard fallbacks:
     *   - ai_did_not_start : no real text within START_TIMEOUT_MS of send.
     *   - timeout          : hardTimeoutMs exceeded in any state.
     *
     * SAFETY: observation is READ-ONLY. This function never clicks anything,
     * especially not the "Stop generating" button. The MutationObserver is
     * attached ONLY to the conversation container (never document.body when a
     * container resolves, and never the composer/input) and is ALWAYS
     * disconnected in cleanup() to prevent memory leaks.
     */
    observeResponse(opts) {
      const o = Object.assign(
        { settleMs: 2000, hardTimeoutMs: 120000, startTimeoutMs: 15000 },
        opts || {}
      );
      return new Promise((resolve) => {
        // Attach ONLY to the chat history container — never the composer/input.
        // document.body is the absolute last resort (it would also observe the
        // input box, which caused spurious mutations in earlier versions).
        let container = U().queryFirst(document, SELECTORS.conversationContainer);
        if (!container || container === document.body) {
          container = document.querySelector("main") || document.body;
        }

        const startNodes = Array.from(
          document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "))
        );
        const prevCount = startNodes.length;
        const prevLastText = prevCount
          ? String(startNodes[prevCount - 1].innerText || "").replace(/\u00a0/g, " ").trim()
          : "";

        // ---- State machine -------------------------------------------------
        const STATE = { WAITING_FOR_START: 1, GENERATING: 2, COMPLETED: 3 };

        const ctx = {
          prevCount,
          prevLastText,
          startedAt: Date.now(),
          sawStop: false,          // ever saw the stop control this turn
          lastMutationAt: Date.now(),
          textSeenAt: 0,           // when REAL answer text first appeared
          settleMs: o.settleMs,
        };

        // Live "real answer" detector (shared by seeding + poller). Returns the
        // last assistant node ONLY when it genuinely contains our new reply:
        // non-empty, not a thinking placeholder, and not just the previous
        // reply re-rendered in place.
        const currentAnswerNode = () => {
          const nodesNow = Array.from(
            document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "))
          );
          if (!nodesNow.length) return null;
          const last = nodesNow[nodesNow.length - 1];
          const txt = String(last.innerText || "").replace(/\u00a0/g, " ").trim();
          if (!txt) return null;                       // empty shell
          if (looksLikeThinking(last)) return null;    // placeholder only
          const grew = nodesNow.length > prevCount;
          if (prevLastText && txt === prevLastText) {
            // Same text as before send: acceptable ONLY if we watched this
            // very turn generate (stop button seen) — i.e. an identical
            // regenerated answer. Otherwise it's stale/re-render -> keep waiting.
            if (!(ctx.sawStop && grew)) return null;
          } else if (!grew && !ctx.sawStop) {
            // Different text but no new node and generation never observed:
            // could be any DOM churn elsewhere — require at least a growth or
            // a witnessed generation cycle before trusting it.
            return null;
          }
          return last;
        };

        let phase = STATE.WAITING_FOR_START;

        // Seed the state machine from the DOM: if generation is already
        // running (stop button visible) or real text already landed before we
        // attached, skip straight to the right phase so the 15s "did not
        // start" watchdog can never fire on an in-flight reply.
        if (hasStopButton()) {
          ctx.sawStop = true;
          phase = STATE.GENERATING;
          ctx.textSeenAt = Date.now();
        } else if (currentAnswerNode()) {
          phase = STATE.GENERATING;
          ctx.textSeenAt = Date.now();
          ctx.lastMutationAt = Date.now();
        }

        let finished = false;
        let observer = null, poller = null, hardTimer = null, startTimer = null;

        const cleanup = () => {
          try { observer && observer.disconnect(); } catch (_) {}
          observer = null;
          poller && clearInterval(poller);
          hardTimer && clearTimeout(hardTimer);
          startTimer && clearTimeout(startTimer);
        };
        const finish = (node) => {
          if (finished) return;
          finished = true;
          phase = STATE.COMPLETED;
          cleanup();
          resolve({ ok: true, text: U().extractText(node) });
        };
        const fail = (reason) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ ok: false, error: reason });
        };

        // NOTE: currentAnswerNode() is defined ABOVE (before the seeding block)
        // so the state machine can be seeded from it as well.

        observer = new MutationObserver(() => {
          ctx.lastMutationAt = Date.now();
          // In GENERATING we deliberately do NOT complete here — completion is
          // decided solely by the poller's quiet-window check so that thinking
          // pauses mid-stream can never end the capture early.
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });

        poller = setInterval(() => {
          if (finished) return;
          if (hasStopButton()) ctx.sawStop = true;

          const node = currentAnswerNode();

          if (phase === STATE.WAITING_FOR_START) {
            if (node) {
              // Text actually appeared => GENERATING. Reset the quiet timer.
              phase = STATE.GENERATING;
              ctx.textSeenAt = Date.now();
              ctx.lastMutationAt = Date.now();
            }
            return;
          }

          if (phase === STATE.GENERATING) {
            // Completion requires: stop button gone AND DOM quiet for settleMs.
            if (hasStopButton()) return;
            if (!node) return; // text vanished (re-render) — keep waiting
            const quietFor = Date.now() - Math.max(ctx.lastMutationAt, ctx.textSeenAt);
            if (quietFor >= o.settleMs && Date.now() - ctx.startedAt >= 2500) {
              finish(node);
            }
          }
        }, 250);

        // Fallback #1: AI never started typing within the start window.
        startTimer = setTimeout(() => {
          if (phase === STATE.WAITING_FOR_START) fail("ai_did_not_start");
        }, o.startTimeoutMs);

        // Fallback #2: global hard timeout (honours SEND_PROMPT timeoutSeconds).
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
