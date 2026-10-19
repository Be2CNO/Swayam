/* ==========================================================================
   Swayam - Bulk AI Prompt Runner
   background/background.js  |  MV3 Service Worker
   --------------------------------------------------------------------------
   Phase 1: File structure established. In later phases this worker will own:
     - The sequential prompt queue (strictly one prompt at a time)
     - chrome.alarms based timers (survives service-worker suspension)
     - chrome.storage.local state snapshots for crash recovery
     - Tab orchestration + login-state checks (pause & wait, never bypass)
     - chrome.downloads based CSV/JSON/TXT export
   ========================================================================== */

"use strict";

console.log("[Swayam Background] Service worker registered (Phase 1 stub).");

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Swayam Background] Extension installed/updated to version:",
    chrome.runtime.getManifest().version);
});

// Placeholder message router — real engine messages arrive in Phase 2+.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log("[Swayam Background] Message received:", message);
  sendResponse({ ok: true, phase: 1 });
  return false; // synchronous response
});
