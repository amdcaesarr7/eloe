// content.js — Ghost Tracker — ISOLATED world bridge
// Bridges between popup (via chrome.runtime messages) and hook.js (via postMessage).

let _hookReady = false;
let _reqId = 0;
const _pending = new Map(); // reqId → { resolve, reject, timer }

// ── Listen for messages from hook.js ──────────────────────────────────────────
window.addEventListener('message', (ev) => {
  if (!ev.data?.__ghost) return;
  const { type, data } = ev.data;

  if (type === 'hookReady') {
    _hookReady = true;
  } else if (type === 'fetchApiResult') {
    const p = _pending.get(data.reqId);
    if (p) {
      clearTimeout(p.timer);
      _pending.delete(data.reqId);
      if (data.ok) {
        p.resolve(data);
      } else {
        p.reject(new Error(data.error || `API error ${data.status}`));
      }
    }
  }
});

// ── igFetch: ask hook.js to do an authenticated fetch ─────────────────────────
function igFetch(url) {
  return new Promise((resolve, reject) => {
    const id = ++_reqId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error('Timeout: ' + url));
    }, 30000);
    _pending.set(id, { resolve, reject, timer });
    window.postMessage({ __ghost: true, type: 'fetchApi', data: { reqId: id, url } }, '*');
  });
}

// ── Listen for proxy requests from popup ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'proxyIgFetch') {
    igFetch(msg.url)
      .then((res) => sendResponse({ ok: true, json: res.json }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }
});
