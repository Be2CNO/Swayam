# Swayam — Bulk AI Prompt Runner (repo: batman)

A local, privacy-first Chrome extension (Manifest V3) that sends prompts from a
CSV/TXT file to AI websites (ChatGPT, Gemini, Claude) through their **web UIs**
— no APIs, no external servers, no telemetry.

## Status: Phase 1 complete (Setup & UI)

### Project structure
```
batman/
├── manifest.json                     # MV3 manifest (all required permissions)
├── background/
│   └── background.js                 # MV3 service worker (stub — engine in Phase 2+)
├── content-scripts/
│   └── content-script.js             # DOM automation script (stub — Phase 2+)
├── popup/
│   ├── popup.html                    # UI shell: upload / config / controls / dashboard / queue
│   ├── popup.css                     # Modern dark theme, responsive layout
│   └── popup.js                      # CSV/TXT parsing (500 cap), preview, storage-backed config
└── icons/
    ├── icon16.png / icon48.png / icon128.png
```

### What Phase 1 delivers
- Robust MV3 `manifest.json` with permissions: `storage`, `activeTab`, `tabs`,
  `downloads`, `unlimitedStorage`, `scripting`, `alarms` + host permissions for
  `chat.openai.com`, `gemini.google.com`, `claude.ai` (and `chatgpt.com`).
- Popup UI with all planned sections: File Upload (drag & drop + browse),
  AI Selection, Chat Strategy ("one chat" / "new chat every X", default 25),
  Start/Pause/Stop/Resume controls, Progress Dashboard, Queue list with filter,
  Export buttons (CSV/JSON/TXT), login-warning and crash-recovery banners.
- Working local file parsing: quote-aware CSV (first column) or line-based TXT,
  hard-capped at 500 prompts per run with a visible truncation warning.
- Settings + queue snapshot persisted via `chrome.storage.local`.

### Roadmap
- **Phase 2:** Background queue engine (sequential execution, alarms timers, crash recovery).
- **Phase 3:** Content-script DOM automation + MutationObserver response detection.
- **Phase 4:** Result capture, failed-prompt retry pass, `chrome.downloads` export.

### Load unpacked for testing
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this repository folder

Privacy: 100% local. No CAPTCHA bypass, no login automation, no model switching.
