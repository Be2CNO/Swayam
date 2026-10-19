/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/adapters/claude-adapter.js  (ClaudeAdapter)
   --------------------------------------------------------------------------
   Site: claude.ai / www.claude.ai
   Registers itself on window.__SWAYAM_ADAPTERS__.claude.

   >>> EDIT ME FIRST when Anthropic changes their UI <<<
   Everything the automation touches is declared in SELECTORS below.
   Rules for editing:
     - Each key maps to an ARRAY of fallbacks, tried top-to-bottom.
     - Use ONLY stable attributes: #id, [aria-label=..], [data-testid=..],
       [role=..], [name=..]. NEVER use hashed Tailwind classes.
     - An entry may also be { css: "...", text: ["word"] } to additionally
       require one of the words inside the element's visible text.
   ========================================================================== */

"use strict";

(function registerClaudeAdapter() {
  const U = () => window.__SWAYAM_UTILS__;

  /* ============================ CONFIG ================================== **/
  const SELECTORS = {
    // Claude composer: div[contenteditable] with role=textbox and a data-target
    // attribute that has remained stable across redesigns.
    composer: [
      'div[contenteditable="true"][data-target*="composer" i]',
      'div[contenteditable="true"][role="textbox"]',
      "#chat-input-textarea",
      'textarea[aria-label*="Message" i]',
    ],

    sendButton: [
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'div[data-action="send-message"] button',
    ],

    conversationContainer: [
      '[data-is-floating="false"] .font-claude-message',
      "main",
      "#root main",
    ],

    // One node per assistant reply ("font-claude-message" is Claude's own
    // non-hashed semantic class; aria fallbacks first).
    assistantMessageNodes: [
      'div[data-testid="assistant-message"]',
      "div.font-claude-message",
      '[role="article"]',
    ],

    stopGeneratingButton: [
      'button[aria-label="Stop generating response"]',
      'button[aria-label="Stop output"]',
      'div[data-action="stop-generation"]',
      { css: "button", text: ["stop"] },
    ],

    copyButtonInLastMessage: [
      'button[aria-label="Copy response"]',
      'button[aria-label="Copy"]',
      'div[role="menuitem"][aria-label="Copy text"]',
      { css: "button", text: ["copy"] },
    ],

    newChatButton: [
      'button[aria-label="New chat"]',
      'a[aria-label="New chat"]',
      'div[data-testid="sidebar-new-chat-button"]',
      { css: "a", text: ["new chat"] },
      { css: "button", text: ["new chat"] },
    ],

    loginWall: [
      'a[href*="/login"]',
      'button[aria-label*="Log in" i]',
      { css: "h1,h2,title", text: ["sign in", "log in", "get started", "one account for both"] },
    ],

    challengeWall: [
      { css: "title", text: ["just a moment", "verify you are human"] },
      { css: "h1,h2", text: ["attention required", "verify you are human"] },
      "#challenge-form",
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
    const s = U().queryVisible(document, SELECTORS.stopGeneratingButton);
    if (!s) return false;
    const clickable = (s.closest && (s.closest("button") || s.closest('div[role="button"]'))) || s;
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
    site: "claude",

    checkLogin() {
      if (findComposer()) return { loggedIn: true, challenged: false };
      if (U().queryFirst(document, SELECTORS.challengeWall)) {
        return { loggedIn: false, challenged: true };
      }
      if (U().queryFirst(document, SELECTORS.loginWall)) {
        return { loggedIn: false, challenged: false };
      }
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
        const urlChanged = location.href !== beforeUrl; // new chat -> /new or fresh /chat/<id>
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
      if (stop && stop.tagName !== "BUTTON" && stop.closest) {
        stop = stop.closest("button") || stop.closest('div[role="button"]') || stop;
      }
      if (stop) U().realClick(stop);
      return { ok: true };
    },

    SELECTORS,
  };

  window.__SWAYAM_ADAPTERS__ = window.__SWAYAM_ADAPTERS__ || {};
  window.__SWAYAM_ADAPTERS__.claude = adapter;
})();
