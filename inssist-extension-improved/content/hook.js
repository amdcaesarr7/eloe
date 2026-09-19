// hook.js — v7 — MAIN WORLD content script
// Chrome injects this directly into the page context via manifest "world": "MAIN"
// This script HAS access to:  window.fetch, cookies, Instagram's session, DOM
// This script CANNOT access:  chrome.* APIs (no runtime, no tabs, no storage)
//
// Communication with content.js (ISOLATED world) is via window.postMessage only.
//
// TWO roles:
//   A) PASSIVE: Intercept fetch/XHR to capture API responses Instagram loads naturally
//   B) ACTIVE:  Receive "fetchApi" requests from content.js, execute them here
//               (where cookies + origin are correct), and return results
(function() {
  'use strict';

  // ── Messaging helper ─────────────────────────────────────────
  const post = (type, data) => {
    try { window.postMessage({ __eloe: true, type, data }, '*'); } catch(_){}
  };

  // Keep reference to the REAL fetch before anything hooks it
  const _realFetch = window.fetch.bind(window);

  // ══════════════════════════════════════════════════════════════
  // A) PASSIVE INTERCEPTION — capture API responses
  // ══════════════════════════════════════════════════════════════

  const API_HITS = [
    '/api/v1/feed/user/',
    '/api/v1/feed/reels_media',
    '/api/v1/feed/user_reels',
    '/api/v1/media/',
    '/api/v1/highlights/',
    '/api/v1/feed/timeline',
    'web_profile_info',
    'graphql/query',
    '/direct_v2/inbox',
    '/direct_v2/threads/',
  ];
  const isApi = url => API_HITS.some(p => url.includes(p));

  // Hook fetch
  window.fetch = async function(...args) {
    const res = await _realFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (isApi(url) && res.headers.get('content-type')?.includes('json')) {
        res.clone().json().then(j => post('apiJson', { url, json: j })).catch(()=>{});
      }
    } catch(_){}
    return res;
  };

  // Hook XHR
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, url, ...r) {
    this._eloeUrl = url;
    return _xhrOpen.apply(this, [m, url, ...r]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        if (isApi(this._eloeUrl || '')) {
          post('apiJson', { url: this._eloeUrl, json: JSON.parse(this.responseText) });
        }
      } catch(_){}
    });
    return _xhrSend.apply(this, args);
  };

  // ══════════════════════════════════════════════════════════════
  // B) ACTIVE API REQUESTS — content.js asks us to fetch something
  // ══════════════════════════════════════════════════════════════
  //
  // WHY: Content scripts run in an isolated world. Their fetch()
  // does NOT carry instagram.com cookies/session. So API calls
  // return 401/403. By executing the fetch HERE in the page's
  // main world, we use Instagram's actual session.

  function getCsrf() {
    return (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  }

  window.addEventListener('message', async (ev) => {
    if (!ev.data?.__eloe || ev.data.type !== 'fetchApi') return;

    const { reqId, url } = ev.data.data;

    try {
      const res = await _realFetch(url, {
        credentials: 'include',
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-csrftoken': getCsrf(),
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json, */*',
        },
      });

      if (res.headers.get('content-type')?.includes('json')) {
        const json = await res.json();
        post('fetchApiResult', { reqId, ok: res.ok, status: res.status, json });
      } else {
        post('fetchApiResult', { reqId, ok: false, status: res.status, json: null, error: 'Non-JSON response (status ' + res.status + ')' });
      }
    } catch(e) {
      post('fetchApiResult', { reqId, ok: false, status: 0, json: null, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // MSE / SourceBuffer — capture HLS video segments
  // ══════════════════════════════════════════════════════════════

  const _mseMap = new Map();
  let _mseId = 0;

  try {
    const _origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mime) {
      const sb = _origAddSB.apply(this, arguments);
      const ms = this;
      const id = ++_mseId;

      if (!_mseMap.has(ms)) {
        _mseMap.set(ms, { id, mime, chunks: [], done: false });
      }

      const _origAppend = sb.appendBuffer.bind(sb);
      sb.appendBuffer = function(buf) {
        try {
          const entry = _mseMap.get(ms);
          if (entry && !entry.done) {
            const copy = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer).slice();
            entry.chunks.push(copy);
          }
        } catch(_){}
        return _origAppend(buf);
      };

      ms.addEventListener('sourceended', () => {
        try {
          const entry = _mseMap.get(ms);
          if (entry && !entry.done && entry.chunks.length) {
            entry.done = true;
            const total = entry.chunks.reduce((s, c) => s + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of entry.chunks) { merged.set(c, off); off += c.byteLength; }
            const blob = new Blob([merged], { type: entry.mime.split(';')[0] });
            const reader = new FileReader();
            reader.onload = () => {
              post('mseVideo', { id: entry.id, mime: entry.mime.split(';')[0], size: blob.size, dataUrl: reader.result });
            };
            reader.readAsDataURL(blob);
            entry.chunks = []; // free memory
          }
        } catch(_){}
      }, { once: true });

      return sb;
    };
  } catch(_){} // MSE not available in some contexts

  // ══════════════════════════════════════════════════════════════
  // ACTIVE API REQUESTS (For Bulk Download)
  // ══════════════════════════════════════════════════════════════
  function getCsrf() { return (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || ''; }

  window.addEventListener('message', async (ev) => {
    if (!ev.data?.__eloe || ev.data.type !== 'fetchApi') return;
    const { reqId, url } = ev.data.data;
    try {
      const res = await _realFetch(url, {
        credentials: 'include',
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-csrftoken': getCsrf(),
          'x-requested-with': 'XMLHttpRequest',
          'accept': 'application/json, */*',
        },
      });
      if (res.headers.get('content-type')?.includes('json')) {
        const json = await res.json();
        post('fetchApiResult', { reqId, ok: res.ok, status: res.status, json });
      } else {
        post('fetchApiResult', { reqId, ok: false, status: res.status, json: null, error: 'Non-JSON' });
      }
    } catch(e) {
      post('fetchApiResult', { reqId, ok: false, status: 0, json: null, error: e.message });
    }
  });

  // ── Signal ready ─────────────────────────────────────────────
  post('hookReady', { version: 8 });
})();
