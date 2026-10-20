/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/adapters/gemini-adapter.js  (GeminiAdapter)
   --------------------------------------------------------------------------
   Site: gemini.google.com / www.gemini.google.com
   Registers itself on window.__SWAYAM_ADAPTERS__.gemini.

   >>> EDIT ME FIRST when Google changes their UI <<<
   Everything the automation touches is declared in SELECTORS below.
   Rules for editing:
     - Each key maps to an ARRAY of fallbacks, tried top-to-bottom.
     - Use ONLY stable attributes: #id, [aria-label=..], [data-testid=..],
       [role=..], [name=..]. NEVER use hashed/Angular-scoped classes.
     - An entry may also be { css: "...", text: ["word"] } to additionally
       require one of the words inside the element's visible text.
   ========================================================================== */

"use strict";

(function registerGeminiAdapter() {
  const U = () => window.__SWAYAM_UTILS__;

  /* ============================ CONFIG ================================== **/
  const SELECTORS = {
    // Gemini's composer is a rich-textarea custom element; its inner editable
    // is a contenteditable div. Fallbacks cover plain textarea variants.
    composer: [
      "rich-textarea .ql-editor",
      'div[contenteditable="true"][role="textbox"]',
      "textarea[aria-label*='Ask' i]",
      'textarea[placeholder*="Ask Gemini"]',
    ],

    sendButton: [
      'button[aria-label="Send message"]',
      'mat-icon[data-mat-icon-name="send_gmail"]',          // icon inside the send btn
      'button.send-button',                                   // documented Angular class (kept last)
      'button[aria-label="Send"]',
    ],

    conversationContainer: [
      "conversation-container",
      "main",
      "c-wiz main",
    ],

    // One node per Gemini turn (question+answer wrapper); we take the ANSWER
    // part via model-response below.
    assistantMessageNodes: [
      "model-response",
      "message-content",
      '[data-test-id="markdown"]',
    ],

    stopGeneratingButton: [
      'button[aria-label="Stop generating response"]',
      'button[aria-label="Stop"]',
      'mat-icon[data-mat-icon-name="stop"]',
    ],

    copyButtonInLastMessage: [
      'button[aria-label="Copy"]',
      'mat-icon[data-mat-icon-name="copy"]',
      'button[aria-label="Copy response"]',
    ],

    newChatButton: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      { css: "a", text: ["new chat"] },
      { css: "button", text: ["new chat"] },
      'mat-icon[data-mat-icon-name="add"]',
    ],

    loginWall: [
      'a[href*="accounts.google.com/ServiceLogin"]',
      { css: "h1,h2,title", text: ["sign in", "log in", "google account"] },
    ],

    challengeWall: [
      { css: "title", text: ["just a moment", "verify you are human"] },
      { css: "h1,h2", text: ["unusual traffic", "not a robot"] },
      'iframe[src*="challenges.cloudflare.com"]',
    ],
  };
  /* ======================================================================= */

  function findComposer() {
    return U().queryFirst(document, SELECTORS.composer);
  }

  function answerNodes() {
    return document.querySelectorAll(SELECTORS.assistantMessageNodes.join(", "));
  }

  function generationRunning() {
    const b = U().queryVisible(document, SELECTORS.stopGeneratingButton);
    if (!b) return false;
    // The mat-icon fallback resolves to the icon, not the button — climb up.
    const clickable = b.closest ? b.closest("button") || b : b;
    return !!clickable;
  }

  function detectCompletion(prevCount, quietForMs, settleMs) {
    // Signal #2 — copy affordance on the newest answer node (independent of
    // generation state; first match wins).
    const nodesNow = Array.from(answerNodes());
    if (nodesNow.length > prevCount) {
      const lastNew = nodesNow[nodesNow.length - 1];
      if (lastNew && U().queryFirst(lastNew, SELECTORS.copyButtonInLastMessage)) {
        return lastNew;
      }
    }

    // While generation is still running nothing else can be "done".
    if (generationRunning()) return null;

    // Signal #1 — stop button gone + a new (or newly non-empty) answer exists.
    if (!nodesNow.length) return null;
    const last = nodesNow[nodesNow.length - 1];
    const txt = (last.innerText || "").trim();
    const isNew = nodesNow.length > prevCount;
    if (isNew && txt.length > 0) return last;

    // Signal #3 — same-node regeneration: only trust after `settleMs` quiet.
    if (!isNew && txt.length > 0 &&
        typeof quietForMs === "number" && typeof settleMs === "number" &&
        quietForMs >= settleMs) {
      return last;
    }
    return null;
  }

  const adapter = {
    site: "gemini",

    checkLogin() {
      // BUGFIX (Gemini): challenge/login walls are checked FIRST. The old
      // order returned loggedIn:true whenever a composer was present, which
      // could mis-report on interstitial/auth pages that also render one.
      if (U().queryFirst(document, SELECTORS.challengeWall)) {
        return { loggedIn: false, challenged: true };
      }
      if (U().queryFirst(document, SELECTORS.loginWall)) {
        return { loggedIn: false, challenged: false };
      }
      if (findComposer()) return { loggedIn: true, challenged: false };
      return { loggedIn: false, challenged: false };
    },

    async sendPrompt(text) {
      const composer = await U().waitFor(findComposer, { timeoutMs: 15000, intervalMs: 300 });
      if (!composer) return { ok: false, error: "composer_not_found" };

      if (!U().setText(composer, text)) return { ok: false, error: "composer_fill_failed" };

      const registered = await U().waitFor(() => {
        const v = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent;
        return v && v.trim().length > 0 ? true : null;
      }, { timeoutMs: 3000, intervalMs: 100 });
      if (!registered) return { ok: false, error: "composer_text_not_registered" };

      // Send button: resolve selector then climb to the enclosing <button>.
      let btn = U().queryVisible(document, SELECTORS.sendButton);
      if (btn && btn.tagName !== "BUTTON" && btn.closest) btn = btn.closest("button") || btn;
      if (btn && !btn.disabled) {
        U().realClick(btn);
        return { ok: true };
      }
      if (U().pressEnter(composer)) return { ok: true };
      return { ok: false, error: "send_control_not_found" };
    },

    observeResponse(opts) {
      const o = Object.assign({ settleMs: 2500, hardTimeoutMs: 120000 }, opts || {});
      return new Promise((resolve) => {
        const container = U().queryFirst(document, SELECTORS.conversationContainer) || document.body;
        const prevCount = answerNodes().length;

        let finished = false;
        let lastMutationAt = Date.now();
        let generationStarted = false; // saw the stop control after send
        let observer = null, poller = null, hardTimer = null;

        const finish = (node) => {
          if (finished) return;
          finished = true; cleanup();
          resolve({ ok: true, text: U().extractText(node) });
        };
        const fail = (reason) => {
          if (finished) return;
          finished = true; cleanup();
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

        poller = setInterval(() => {
          if (generationRunning()) generationStarted = true;
          const quietFor = Date.now() - lastMutationAt;
          const done = detectCompletion(prevCount, quietFor, o.settleMs);
          if (done) return finish(done);
          // Signal #3 fallback when answer count didn't change (regen/edit):
          // require that generation was actually seen running first.
          if (generationStarted && !generationRunning() && quietFor >= o.settleMs) {
            const nodes = answerNodes();
            const last = nodes.length ? nodes[nodes.length - 1] : null;
            if (last && (last.innerText || "").trim().length > 0) return finish(last);
          }
        }, 400);

        hardTimer = setTimeout(() => fail("timeout"), o.hardTimeoutMs);
      });
    },

    async createNewChat() {
      const beforeUrl = location.href;
      let btn = U().queryVisible(document, SELECTORS.newChatButton);
      if (btn && btn.tagName !== "A" && btn.tagName !== "BUTTON" && btn.closest) {
        btn = btn.closest("button") || btn.closest("a") || btn;
      }
      if (!btn) return { ok: false, error: "new_chat_button_not_found" };
      U().realClick(btn);

      const ready = await U().waitFor(() => {
        const urlChanged = location.href !== beforeUrl;
        const composer = findComposer();
        const emptyConversation = composer && answerNodes().length === 0;
        return urlChanged || emptyConversation ? true : null;
      }, { timeoutMs: 15000, intervalMs: 300 });

      if (!ready) return { ok: false, error: "new_chat_not_confirmed" };
      await U().waitFor(findComposer, { timeoutMs: 8000, intervalMs: 250 });
      return { ok: true };
    },

    abortCurrent() {
      let stop = U().queryVisible(document, SELECTORS.stopGeneratingButton);
      if (stop && stop.tagName !== "BUTTON" && stop.closest) stop = stop.closest("button") || stop;
      if (stop) U().realClick(stop);
      return { ok: true };
    },

    SELECTORS,
  };

  window.__SWAYAM_ADAPTERS__ = window.__SWAYAM_ADAPTERS__ || {};
  window.__SWAYAM_ADAPTERS__.gemini = adapter;
})();
