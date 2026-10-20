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

  /** True when `el` visibly contains streaming/thinking placeholder text. */
  const THINKING_RE = /\b(thinking|deep in thought|analyzing|generating|searching|browsing|pondering)\b/i;
  function looksLikeThinking(el) {
    if (!el) return false;
    try {
      const txt = String(el.innerText || el.textContent || "").trim();
      return txt.length > 0 && txt.length <= 80 && THINKING_RE.test(txt);
    } catch (_) {
      return false;
    }
  }

  function detectCompletion(ctx) {
    // EMERGENCY FIX — generation STATE MACHINE (mirrors chatgpt-adapter.js).
    // Completion is evaluated in ONE place (observeResponse's poller):
    //   WAITING_FOR_START -> GENERATING only when REAL answer text appears,
    //   GENERATING -> COMPLETED only after `settleMs` of DOM quiet AND the
    //   stop control is gone. Fixes premature/empty captures during Claude's
    //   thinking delay.
    const { prevCount, prevLastText, startedAt, settleMs } = ctx;

    if (Date.now() - startedAt < 2500) return null;      // pre-typing grace window
    if (generationRunning()) return null;                // still generating

    const nodesNow = Array.from(answerNodes());
    if (!nodesNow.length) return null;
    const last = nodesNow[nodesNow.length - 1];

    const grew = nodesNow.length > prevCount;
    const txt = String(last.innerText || "").replace(/\u00a0/g, " ").trim();

    if (txt && looksLikeThinking(last)) return null;     // placeholder, not an answer
    if (prevLastText && txt === prevLastText && !(ctx.sawStop && grew)) return null;
    if (!txt) return null;                               // no real text yet
    if (Date.now() - Math.max(ctx.textSeenAt, ctx.lastMutationAt) < settleMs) return null;

    void settleMs;
    return last;
  }

  const adapter = {
    site: "claude",

    checkLogin() {
      // BUGFIX (Claude): challenge/login walls are checked FIRST so an
      // interstitial page that also renders a composer can't be mis-reported
      // as logged in.
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
      const o = Object.assign(
        { settleMs: 2000, hardTimeoutMs: 120000, startTimeoutMs: 15000 },
        opts || {}
      );
      return new Promise((resolve) => {
        // Attach ONLY to the chat history container — never the composer/input.
        let container = U().queryFirst(document, SELECTORS.conversationContainer);
        if (!container || container === document.body) {
          container = document.querySelector("main") || document.body;
        }

        const startNodes = Array.from(answerNodes());
        const prevCount = startNodes.length;
        const prevLastText = prevCount
          ? String(startNodes[prevCount - 1].innerText || "").replace(/\u00a0/g, " ").trim()
          : "";

        // ---- State machine -------------------------------------------------
        const STATE = { WAITING_FOR_START: 1, GENERATING: 2, COMPLETED: 3 };
        const ctx = {
          prevCount, prevLastText,
          startedAt: Date.now(),
          sawStop: false,
          lastMutationAt: Date.now(),
          textSeenAt: 0,
          settleMs: o.settleMs,
        };

        // Live "real answer" detector: non-empty, not a thinking placeholder,
        // and genuinely OUR new reply (node grew, or generation was witnessed).
        const currentAnswerNode = () => {
          const nodesNow = Array.from(answerNodes());
          if (!nodesNow.length) return null;
          const last = nodesNow[nodesNow.length - 1];
          const txt = String(last.innerText || "").replace(/\u00a0/g, " ").trim();
          if (!txt) return null;
          if (looksLikeThinking(last)) return null;
          const grew = nodesNow.length > prevCount;
          if (prevLastText && txt === prevLastText) {
            if (!(ctx.sawStop && grew)) return null;
          } else if (!grew && !ctx.sawStop) {
            return null;
          }
          return last;
        };

        let phase = STATE.WAITING_FOR_START;
        if (generationRunning()) {
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

        // SAFETY: read-only observation. Never clicks anything (certainly not
        // the stop control). Completion decided only in the poller below.
        observer = new MutationObserver(() => {
          ctx.lastMutationAt = Date.now();
        });
        observer.observe(container, { childList: true, subtree: true, characterData: true });

        poller = setInterval(() => {
          if (finished) return;
          if (generationRunning()) ctx.sawStop = true;

          const node = currentAnswerNode();

          if (phase === STATE.WAITING_FOR_START) {
            if (node) {
              phase = STATE.GENERATING;   // REAL text appeared => generating
              ctx.textSeenAt = Date.now();
              ctx.lastMutationAt = Date.now();
            }
            return;
          }

          if (phase === STATE.GENERATING) {
            if (generationRunning()) return;   // still streaming
            if (!node) return;                 // text vanished — keep waiting
            const quietFor = Date.now() - Math.max(ctx.lastMutationAt, ctx.textSeenAt);
            if (quietFor >= o.settleMs && Date.now() - ctx.startedAt >= 2500) {
              finish(node);                    // COMPLETED
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
