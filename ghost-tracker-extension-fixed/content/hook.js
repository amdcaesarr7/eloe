// hook.js — Ghost Tracker — MAIN WORLD content script
// Runs in page context so it carries Instagram's session cookies.
// Communicates with content.js (ISOLATED world) via window.postMessage ONLY.
(function () {
  'use strict';

  const post = (type, data) => {
    try { window.postMessage({ __ghost: true, type, data }, '*'); } catch (_) {}
  };

  // Keep unhooked reference to real fetch
  const _realFetch = window.fetch.bind(window);

  function getCsrf() {
    return (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  }

  // ── Listen for fetchApi requests from content.js ───────────────────────────
  window.addEventListener('message', async (ev) => {
    if (!ev.data?.__ghost || ev.data.type !== 'fetchApi') return;

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
        post('fetchApiResult', {
          reqId, ok: false, status: res.status,
          json: null, error: `Non-JSON response (status ${res.status})`
        });
      }
    } catch (e) {
      post('fetchApiResult', { reqId, ok: false, status: 0, json: null, error: e.message });
    }
  });

  // Signal ready to content.js
  post('hookReady', { version: 1 });
})();
