/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   content-scripts/adapters/adapter-utils.js
   --------------------------------------------------------------------------
   Shared DOM helpers used by ALL site adapters. Exposed as
   window.__SWAYAM_UTILS__ (loaded FIRST, before any adapter file).

   Design rules (see Phase 3 spec):
     - Selectors live in each adapter's SELECTORS config; this file only
       provides resolution/polling primitives with fallback support.
     - Every helper is defensive: a missing element never throws, it returns
       null/false so callers can report clean failures to the engine.
   ========================================================================== */

"use strict";

(function installSwayamUtils() {
  if (window.__SWAYAM_UTILS__) return;

  const utils = {
    /**
     * Resolve the first visible-ish match across a list of selector entries.
     * Each entry is either a CSS selector string or { css, text } where
     * `text` must be contained in the element's visible text (case-insensitive).
     * Returns the element or null.
     */
    queryFirst(root, entries) {
      if (!root || !Array.isArray(entries)) return null;
      for (const entry of entries) {
        try {
          if (typeof entry === "string") {
            const el = root.querySelector(entry);
            if (el) return el;
          } else if (entry && typeof entry.css === "string") {
            const nodes = root.querySelectorAll(entry.css);
            for (const el of nodes) {
              const txt = (el.textContent || "").toLowerCase();
              const needles = [].concat(entry.text || []);
              if (!needles.length) return el;
              if (needles.some((n) => txt.includes(String(n).toLowerCase()))) {
                return el;
              }
            }
          }
        } catch (_) {
          /* invalid selector after a site change — skip it, keep trying */
        }
      }
      return null;
    },

    /** True when the element exists AND is not display:none / hidden. */
    isVisible(el) {
      if (!el) return false;
      if (el.hidden) return false;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      } catch (_) {
        return true; // detached but present — treat as usable
      }
    },

    /** queryFirst + visibility check. */
    queryVisible(root, entries) {
      if (!root || !Array.isArray(entries)) return null;
      for (const entry of entries) {
        try {
          const nodes =
            typeof entry === "string"
              ? Array.from(root.querySelectorAll(entry))
              : Array.from(root.querySelectorAll(entry.css));
          for (const el of nodes) {
            if (!utils.isVisible(el)) continue;
            if (typeof entry === "string" || !entry.text) return el;
            const txt = (el.textContent || "").toLowerCase();
            const needles = [].concat(entry.text || []);
            if (needles.some((n) => txt.includes(String(n).toLowerCase()))) {
              return el;
            }
          }
        } catch (_) {
          /* ignore invalid selector */
        }
      }
      return null;
    },

    /**
     * Poll `fn` every `intervalMs` until it returns a truthy value or the
     * timeout expires. Resolves with the truthy value, or null on timeout.
     * Uses setTimeout locally in the page context (allowed in content
     * scripts; the MV3 no-timer rule applies to the service worker only).
     */
    waitFor(fn, opts) {
      const o = Object.assign({ timeoutMs: 15000, intervalMs: 250, label: "" }, opts || {});
      return new Promise((resolve) => {
        let elapsed = 0;
        const tick = () => {
          let value = null;
          try {
            value = fn();
          } catch (_) {
            value = null;
          }
          if (value) return resolve(value);
          elapsed += o.intervalMs;
          if (elapsed >= o.timeoutMs) return resolve(null);
          setTimeout(tick, o.intervalMs);
        };
        tick();
      });
    },

    /** Insert text into a <textarea>/<input> via the native value setter. */
    setNativeValue(el, text) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement
            ? window.HTMLInputElement.prototype
            : null;
      if (!proto) return false;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (!desc || !desc.set) return false;
      desc.set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },

    /**
     * Insert text into a contenteditable composer the way React/Slate apps
     * expect: focus, select-all, execCommand('insertText') which synthesizes
     * a real InputEvent; fall back to textContent + manual events.
     */
    setContentEditableText(el, text) {
      try {
        el.focus();
      } catch (_) { /* non-fatal */ }
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand("insertText", false, text);
        if (ok && (el.textContent || "").includes(text.slice(0, Math.min(40, text.length)))) {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          return true;
        }
      } catch (_) { /* fall through to direct assignment */ }
      try {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        return (el.textContent || "").trim().length > 0;
      } catch (_) {
        return false;
      }
    },

    /** Unified writer: picks textarea/input vs contenteditable automatically. */
    setText(el, text) {
      if (!el) return false;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return utils.setNativeValue(el, text);
      }
      const editable = el.isContentEditable || el.getAttribute("contenteditable") === "true";
      if (editable) return utils.setContentEditableText(el, text);
      return false;
    },

    /**
     * Click an element like a human-ish app would expect: pointer/mouse
     * sequence (React apps often listen on pointerdown/up).
     */
    realClick(el) {
      if (!el) return false;
      try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const common = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        };
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, isPrimary: true }, common)));
        el.dispatchEvent(new MouseEvent("mousedown", common));
        el.focus && el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 1, isPrimary: true }, common)));
        el.dispatchEvent(new MouseEvent("mouseup", common));
        el.dispatchEvent(new MouseEvent("click", common));
        return true;
      } catch (_) {
        try {
          el.click();
          return true;
        } catch (e2) {
          return false;
        }
      }
    },

    /** Dispatch Enter keydown/keypress/keyup on the composer (send fallback). */
    pressEnter(el) {
      if (!el) return false;
      try {
        const opts = {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
        };
        el.focus && el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        return true;
      } catch (_) {
        return false;
      }
    },

    /** Snapshot all message nodes currently in the conversation container. */
    lastNodeOf(listLike) {
      const arr = Array.from(listLike || []);
      return arr.length ? arr[arr.length - 1] : null;
    },

    /** Clean innerText extraction: trim + collapse pathological whitespace. */
    extractText(node) {
      if (!node) return "";
      const raw = node.innerText != null ? node.innerText : node.textContent || "";
      return String(raw).replace(/\u00a0/g, " ").trim();
    },
  };

  window.__SWAYAM_UTILS__ = utils;
})();
