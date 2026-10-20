<div align="center">

# 🌟 Swayam — Bulk AI Prompt Runner

**Run hundreds of prompts across ChatGPT, Gemini & Claude — automatically, sequentially, and 100% locally.**

*No APIs. No servers. No telemetry. Just your browser doing the typing for you.*

⚠️ **Research preview.** Web UIs change without notice; selectors are user-editable (see [🔧 Troubleshooting](#-troubleshooting--selector-maintenance)).

</div>

---

## 🌟 Project Overview

**Swayam** is a Manifest V3 Chrome extension that automates bulk prompt execution directly through the **web interfaces** of popular AI assistants:

| 🤖 AI | 🌐 URL |
|---|---|
| ChatGPT | `chat.openai.com` / `chatgpt.com` |
| Gemini | `gemini.google.com` |
| Claude | `claude.ai` |

You upload a local **CSV/TXT** file of prompts → pick an AI and strategy → Swayam sends each prompt one-by-one into the site's own chat composer, waits for the reply to finish streaming, captures it, and lets you **export everything as CSV / JSON / TXT** to your Downloads folder.

It behaves exactly like a tireless human operator: one message at a time, waiting for each answer before sending the next.

---

## ⚡ Key Features

- 📦 **Bulk processing** — up to **500 prompts per run** from quote-aware CSV or line-based TXT files.
- 🔁 **Strictly sequential engine** — one active chat, one in-flight prompt, configurable delay between prompts.
- 🧠 **Chat strategies** — keep everything in *one chat*, or auto-open a *new chat every X prompts* (default 25).
- 🛡️ **Crash recovery** — full queue state lives in `chrome.storage.local`. If the browser or service worker dies mid-run, Swayam wakes up **Paused**, tells you exactly where it stopped, and resumes on demand.
- 🎯 **Smart completion detection** — `MutationObserver` + three layered signals (stop-button disappears → copy affordance appears → DOM quiet for 2.5 s), with a hard timeout fallback.
- ♻️ **Failure handling** — timed-out/failed prompts are marked, skipped, and **retried only once, at the very end** of the run.
- 📤 **One-click export** — CSV, JSON, or human-readable TXT saved via `chrome.downloads` to your default Downloads folder.
- 🪟 **Live dashboard** — progress bar, done/failed/pending stats, filterable queue with per-prompt status, current-row highlight.
- 🔐 **Privacy by design** — zero network calls by the extension itself; no cookies read, no logins touched, no CAPTCHAs bypassed.

---

## 🏗️ Architecture (MV3)

```
┌─────────────┐   START_RUN / PAUSE / RESUME / STOP / EXPORT_RESULTS
│  Popup UI   │ ─────────────────────────────────────────────┐
│ popup/*.js  │ ◄──────────── STATE_UPDATE (+ 2s poll) ──────┤
└─────────────┘                                              │
                                                     ┌───────▼────────┐
   chrome.storage.local  ◄──── single source ────────┤  Background     │
   (crash-proof state)                                │  Service Worker │
                                                     │  background.js  │
                                                     └───────┬────────┘
                    SEND_PROMPT / CREATE_NEW_CHAT / ABORT    │
              RESPONSE_CAPTURED / NEW_CHAT_READY / NOT_LOGGED_IN
                                                     ┌───────▼────────┐
                                                     │ Content Scripts │
                                                     │ adapter router  │
                                                     │  ├─ ChatGPT     │
                                                     │  ├─ Gemini      │
                                                     │  └─ Claude      │
                                                     └─────────────────┘
```

- **Background queue engine (`background/background.js`)** — owns the entire run state machine (`IDLE → RUNNING → PAUSED / RETRYING_FAILED → COMPLETED / STOPPED`). All timers use `chrome.alarms` paired with absolute deadlines, so the engine self-corrects after any service-worker eviction.
- **Adapter pattern (`content-scripts/adapters/*`)** — one adapter per site. Every DOM selector lives in a clearly-marked `SELECTORS` config object at the top of each adapter file, each entry being a primary selector plus fallbacks, using only stable attributes (`aria-label`, `data-testid`, `role`, `id`). Hashed Tailwind classes are never relied upon.
- **Composer injection** — native value-setter trick for `<textarea>` composers and `execCommand('insertText')` + `InputEvent` for contenteditable ones, so React/Angular apps register the text correctly.
- **Popup ↔ engine** — commands go over `chrome.runtime.sendMessage`; live updates arrive as `STATE_UPDATE` broadcasts with a `GET_STATE` polling fallback.

---

## 🚀 Installation

1. **Clone or download** this repository:
   ```bash
   git clone https://github.com/Be2CNO/batman.git
   ```
2. Open Chrome and go to **`chrome://extensions`**.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `batman/` folder.
5. Pin the 🧠 **Swayam** icon to your toolbar. Done!

---

## 🛠️ How to Use

1. **📄 Upload prompts** — drag & drop (or browse) a `.csv` (first column = prompts, quote-aware) or `.txt` (one prompt per line). Max 500 per run; anything beyond is truncated with a visible warning.
2. **🤖 Pick your AI** — ChatGPT, Gemini, or Claude. Log in manually in that tab first; **model selection is yours** — Swayam uses whatever model you chose in the site UI.
3. **⚙️ Configure the run** —
   - *Chat strategy:* "One chat for all" or "New chat every X prompts" (X defaults to 25).
   - *Delay between prompts* and *response timeout*.
4. **▶️ Start** — watch the dashboard: progress bar, live queue statuses (`pending → running → done/failed`), and the current row highlighted. You can **Pause**, **Resume**, or **Stop** at any time.
5. **♻️ Automatic retry pass** — after the main pass, any failed prompts are retried once at the very end (`RETRYING_FAILED`).
6. **📤 Export results** — CSV / JSON / TXT lands in your **Downloads** folder (`swayam-results-<timestamp>.<ext>`).

> 💡 **Crashed?** Reopen the popup — Swayam detects the interrupted run, shows a recovery banner with the exact stopping point, and resumes right where it left off when you press **Resume**.

---

## 🔧 Troubleshooting / Selector Maintenance

AI sites redesign their DOM constantly. When automation breaks, it is almost always a **selector**, not the engine:

1. Open the failing site with DevTools (F12).
2. Edit the matching file — `content-scripts/adapters/chatgpt-adapter.js`, `gemini-adapter.js`, or `claude-adapter.js` — and update the arrays inside the big **`SELECTORS` CONFIG** block at the top (composer, send button, message nodes, new-chat, login wall…). Each key is a fallback list: add the new selector **first**, keep old ones behind it.
3. Reload the extension (`chrome://extensions` ↻) and the page (F5). No build step required.

Common symptoms → likely cause: *"send_failed:composer_not_found"* (composer selector stale), *"response_never_started"* (message-node selectors stale), *"Waiting for login"* forever (you're logged out or hit a Cloudflare challenge — interact manually, then press Resume).

---

## 🛡️ Privacy & Security

- ✅ **100% local.** The extension makes no external network requests. Prompts/responses never leave your machine except to the AI site you are already chatting with.
- ✅ **No telemetry, no analytics, no accounts.**
- ✅ **No credential access.** It never reads cookies, tokens, or passwords, and never automates login. Not logged in? It warns and waits for you.
- ✅ **No CAPTCHA bypassing.** Challenge pages are detected and surfaced as "manual interaction needed".
- ✅ **Least-privilege MV3 permissions:** `storage`, `unlimitedStorage`, `activeTab`, `tabs`, `downloads`, `scripting`, `alarms` + host permissions limited to the supported AI domains.

---

## 🗺️ Roadmap

| Phase | Scope | Status |
|---|---|---|
| **1** | MV3 manifest, folder structure, popup UI shell (upload/config/controls/dashboard/queue) | ✅ Complete |
| **2** | Background queue engine, `chrome.storage.local` state, crash recovery, `chrome.alarms` timing, messaging protocol, exports | ✅ Complete |
| **3** | Per-site content-script adapters: composer injection, MutationObserver completion detection, new-chat automation, login/challenge guards | ✅ Complete |
| **3.5** | Full code review, integration bug fixes, robustness hardening, docs overhaul | ✅ Complete |
| **4** | End-to-end manual testing & polish | 🔜 Next |

---

## ❓ FAQ

**Does this use official APIs?** No — deliberately. Swayam drives the same web UI you use every day. Heavy automated use may violate a site's terms; you are responsible for how you use it. Keep delays reasonable.

**Why does it stop at a "Waiting for login" banner?** Because we never touch authentication. Log in in the AI tab, click Resume.

**What happens if a response takes longer than the timeout?** The prompt is marked FAILED, the queue moves on, and it gets one automatic retry at the end of the run.

---

<div align="center">

**Made with 🧘 for people who have too many prompts and too few hands.**

MIT-style local use · No warranty · As-is

</div>
