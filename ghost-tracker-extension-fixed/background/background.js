// background.js — Ghost Tracker service worker
// Minimal: just keeps the extension alive. All logic is in popup + content.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Ghost Tracker] Installed.');
});
