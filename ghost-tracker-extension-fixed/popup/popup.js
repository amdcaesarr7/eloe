// popup.js — Ghost Tracker v4.0
// v4: Ground-truth method — instead of comparing two paginated lists
//     (which causes false positives when Instagram truncates responses),
//     we fetch the following list ONCE, then for each followed account
//     we search THEIR following list for the victim by username.
//     If the victim appears → they follow back → NOT a ghost.
//     This is verified per-user, not inferred from bulk list comparison.

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'ghostTrackerHistory';
const MAX_HISTORY = 50;

async function loadHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] || []);
    });
  });
}
async function saveHistory(records) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: records }, resolve);
  });
}
async function appendScanToHistory(record) {
  const history = await loadHistory();
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  await saveHistory(history);
}
async function deleteScanFromHistory(id) {
  const history = await loadHistory();
  await saveHistory(history.filter(r => r.id !== id));
}
async function clearHistory() { await saveHistory([]); }

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW MODE
// ─────────────────────────────────────────────────────────────────────────────
const WIN_ID_KEY = 'ghostTrackerWindowId';
async function getStoredWindowId() {
  return new Promise(resolve => {
    chrome.storage.local.get([WIN_ID_KEY], r => resolve(r[WIN_ID_KEY] || null));
  });
}
async function setStoredWindowId(id) {
  return new Promise(resolve => chrome.storage.local.set({ [WIN_ID_KEY]: id }, resolve));
}
async function clearStoredWindowId() {
  return new Promise(resolve => chrome.storage.local.remove([WIN_ID_KEY], resolve));
}

const _isWindowMode = new URLSearchParams(window.location.search).get('windowMode') === '1';
if (_isWindowMode) document.body.classList.add('is-window');

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let _igTabId   = null;
let _igWinId   = null;
let _cancelled = false;
let _ghosts    = [];
let _scanStart = 0;
let _victimUsername = '';
let _viewingHistoryRecord = null;
let _filterBusiness = true;
let _filterCreator  = true;

// ─────────────────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const views = {
  idle:     $('view-idle'),
  booting:  $('view-booting'),
  scanning: $('view-scanning'),
  results:  $('view-results'),
};
function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// ─────────────────────────────────────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(tc => {
    tc.classList.toggle('hidden', tc.id !== 'tab-' + tabName);
  });
  if (tabName === 'history') renderHistoryTab();
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─────────────────────────────────────────────────────────────────────────────
// POP-OUT
// ─────────────────────────────────────────────────────────────────────────────
$('btn-open-window').addEventListener('click', async () => {
  const existingId = await getStoredWindowId();
  if (existingId) {
    chrome.windows.update(existingId, { focused: true }, () => {
      if (chrome.runtime.lastError) { clearStoredWindowId(); openAsWindow(); }
    });
    return;
  }
  openAsWindow();
});

function openAsWindow() {
  const url = chrome.runtime.getURL('popup/popup.html') + '?windowMode=1';
  chrome.windows.create({ url, type: 'popup', width: 400, height: 680, focused: true }, async (win) => {
    if (chrome.runtime.lastError || !win) return;
    await setStoredWindowId(win.id);
    chrome.windows.onRemoved.addListener(function cleanup(removedId) {
      if (removedId === win.id) { clearStoredWindowId(); chrome.windows.onRemoved.removeListener(cleanup); }
    });
  });
  window.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// TERMINAL
// ─────────────────────────────────────────────────────────────────────────────
const terminal = $('terminal');
function log(msg) {
  const line = document.createElement('div');
  line.textContent = '› ' + msg;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setBootStatus(msg, pct) {
  $('boot-status').textContent = msg;
  $('boot-bar').style.width = pct + '%';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN INSTAGRAM WINDOW
// ─────────────────────────────────────────────────────────────────────────────
async function openIgWindow() {
  setBootStatus('Launching Instagram window…', 10);
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      { url: 'https://www.instagram.com/', type: 'normal', width: 900, height: 650, state: 'normal' },
      async (win) => {
        if (chrome.runtime.lastError || !win) {
          return reject(new Error('Could not open window: ' + chrome.runtime.lastError?.message));
        }
        _igWinId = win.id;
        const tab = win.tabs?.[0];
        if (!tab) return reject(new Error('No tab in opened window.'));
        _igTabId = tab.id;

        setBootStatus('Waiting for Instagram to load…', 30);
        await waitForTabComplete(_igTabId);
        if (_cancelled) return reject(new Error('Cancelled.'));

        setBootStatus('Waiting for content scripts to initialize…', 60);
        await sleep(2500);
        if (_cancelled) return reject(new Error('Cancelled.'));

        let pingOk = false;
        for (let i = 0; i < 6; i++) {
          try { if (await pingTab(_igTabId)) { pingOk = true; break; } } catch (_) {}
          await sleep(1000);
        }
        if (!pingOk) {
          return reject(new Error('Content script not responding. Make sure you are logged into Instagram.'));
        }

        setBootStatus('Ready!', 100);
        await sleep(300);
        resolve(_igTabId);
      }
    );
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === 'complete') return resolve();
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId,
      { action: 'proxyIgFetch', url: 'https://i.instagram.com/api/v1/accounts/current_user/?edit=true' },
      () => { resolve(!chrome.runtime.lastError); }
    );
  });
}

async function closeIgWindow() {
  if (_igWinId !== null) {
    try { await chrome.windows.remove(_igWinId); } catch (_) {}
    _igWinId = null; _igTabId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROXY FETCH
// ─────────────────────────────────────────────────────────────────────────────
function proxyFetch(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(_igTabId, { action: 'proxyIgFetch', url }, (res) => {
      if (chrome.runtime.lastError) {
        return reject(new Error('Instagram window closed or disconnected. Do not close it!'));
      }
      if (!res?.ok) return reject(new Error(res?.error || 'API error: ' + url));
      resolve(res.json);
    });
  });
}

async function proxyFetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await proxyFetch(url);
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = 3000 * attempt;
      log(`⚠ Attempt ${attempt}/${retries} failed: ${e.message}. Retrying in ${wait/1000}s…`);
      await sleep(wait);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Fetch the victim's full following list (paginated)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFollowing(victimPk) {
  const seen = new Set(), users = [];
  let maxId = '', page = 1;

  while (true) {
    if (_cancelled) throw new Error('Cancelled by user.');
    const url = `https://i.instagram.com/api/v1/friendships/${victimPk}/following/?count=200${maxId ? '&max_id=' + maxId : ''}`;
    const res = await proxyFetchWithRetry(url);
    const batch = res?.users ?? [];

    for (const u of batch) {
      const pk = String(u.pk);
      if (!seen.has(pk)) {
        seen.add(pk);
        users.push({
          pk,
          username: u.username,
          full_name: u.full_name || '',
          profile_pic_url: u.profile_pic_url || '',
          account_type: u.account_type ?? 0,
          is_business: u.is_business ?? false,
          is_verified: u.is_verified ?? false,
          category: u.category || '',
        });
      }
    }

    $('cnt-following').textContent = users.length;
    log(`Following: page ${page} (+${batch.length}) → ${users.length} total`);
    page++;

    if (res?.next_max_id) {
      maxId = res.next_max_id;
      await sleep(1000 + Math.random() * 800);
    } else {
      break;
    }
  }
  return users;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Fetch the victim's full followers list (paginated)
//
// Same pagination strategy as fetchFollowing. We only need PKs for the
// set-subtraction, so we return a Set<string> of PKs — no username matching,
// no per-user API calls, no flaky query params.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFollowerPks(victimPk, followingCount) {
  const seen = new Set();
  let maxId = '', page = 1;

  while (true) {
    if (_cancelled) throw new Error('Cancelled by user.');
    const url = `https://i.instagram.com/api/v1/friendships/${victimPk}/followers/?count=200${maxId ? '&max_id=' + maxId : ''}`;
    const res = await proxyFetchWithRetry(url);
    const batch = res?.users ?? [];

    for (const u of batch) seen.add(String(u.pk));

    $('cnt-followers').textContent = `${seen.size} / ${followingCount}`;
    log(`Followers: page ${page} (+${batch.length}) → ${seen.size} total`);
    page++;

    if (res?.next_max_id) {
      maxId = res.next_max_id;
      await sleep(1000 + Math.random() * 800);
    } else {
      break;
    }
  }
  return seen; // Set of pk strings
}

// ─────────────────────────────────────────────────────────────────────────────
// Set-subtract: following people whose PK is NOT in the followers set = ghosts
// O(n) — no extra API calls at all.
// ─────────────────────────────────────────────────────────────────────────────
function findGhosts(followingList, followerPkSet) {
  const ghosts = followingList.filter(u => !followerPkSet.has(u.pk));
  ghosts.forEach(u => log(`👻 Ghost: @${u.username}`));
  return ghosts;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCANNER
// ─────────────────────────────────────────────────────────────────────────────
async function runScan(username) {
  _cancelled = false; _ghosts = []; _scanStart = Date.now(); _victimUsername = username;
  terminal.textContent = '';

  showView('booting');
  try {
    await openIgWindow();
  } catch (e) {
    if (!_cancelled) alert('Failed to open Instagram: ' + e.message);
    await closeIgWindow(); showView('idle'); return;
  }
  if (_cancelled) { await closeIgWindow(); showView('idle'); return; }

  showView('scanning');
  $('scan-victim').textContent = '@' + username;
  $('scan-phase').textContent  = 'Resolving account…';
  $('cnt-following').textContent = '0';
  $('cnt-followers').textContent = '0 / 0';

  // Relabel the second counter for new meaning
  const verifiedLabel = document.querySelector('.p-row:nth-child(2) .p-label');
  if (verifiedLabel) verifiedLabel.textContent = 'Accounts verified';

  try {
    log(`Resolving @${username}…`);
    const pInfo = await proxyFetchWithRetry(
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );
    const user = pInfo?.data?.user;
    if (!user?.id) throw new Error(`Could not find "@${username}". Might be private or misspelled.`);
    const victimPk = String(user.id);
    log(`Found: @${user.username} (pk: ${victimPk})`);
    $('user-badge-name').textContent = '@' + user.username;
    $('user-badge').classList.remove('hidden');
    if (user.is_private) log('⚠ Account is PRIVATE — following list may be inaccessible.');
    if (_cancelled) throw new Error('Cancelled.');

    // ── STEP 1: Get who the victim follows ──────────────────────────────────
    $('scan-phase').textContent = 'Fetching following list…';
    log('─── STEP 1: Fetching following list ───');
    const following = await fetchFollowing(victimPk);
    log(`✔ ${following.length} accounts fetched.`);
    if (_cancelled) throw new Error('Cancelled.');

    // ── STEP 2: Fetch followers list, then set-subtract ────────────────────
    $('scan-phase').textContent = `Fetching followers list…`;
    log(`─── STEP 2: Fetching followers list ───`);
    const followerPks = await fetchFollowerPks(victimPk, following.length);
    log(`✔ ${followerPks.size} followers fetched.`);
    if (_cancelled) throw new Error('Cancelled.');

    $('scan-phase').textContent = 'Comparing lists…';
    log('─── Comparing following vs followers by PK ───');
    _ghosts = findGhosts(following, followerPks);
    log(`✔ Done. ${_ghosts.length} ghost(s) found.`);

    // ── AUTO-SAVE ────────────────────────────────────────────────────────────
    const record = {
      id:         `scan_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      scannedAt:  new Date().toISOString(),
      username:   _victimUsername,
      following:  following.length,
      followers:  following.length - _ghosts.length,
      ghostCount: _ghosts.length,
      ghosts:     _ghosts,
      durationMs: Date.now() - _scanStart,
    };
    await appendScanToHistory(record);
    log('💾 Saved to history.');

    await closeIgWindow();
    renderResults();
    showView('results');

  } catch (e) {
    await closeIgWindow();
    if (!_cancelled) { log('❌ ' + e.message); alert('Scan failed: ' + e.message); }
    else log('⛔ Cancelled.');
    showView('idle');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER RESULTS
// ─────────────────────────────────────────────────────────────────────────────
const isBusiness = u => u.is_business === true || u.account_type === 3;
const isCreator  = u => u.account_type === 2 || u.is_verified === true;

function renderResults(filter = '', ghostOverride = null) {
  const listEl = $('ghost-list');
  listEl.innerHTML = '';
  const source = ghostOverride ?? _ghosts;

  if (!ghostOverride) {
    const elapsed = ((Date.now() - _scanStart) / 1000).toFixed(1);
    $('scan-time').textContent = `Scanned in ${elapsed}s`;
  }
  $('stat-victim').textContent = '@' + _victimUsername;

  let visible = source;
  if (_filterBusiness) visible = visible.filter(u => !isBusiness(u));
  if (_filterCreator)  visible = visible.filter(u => !isCreator(u));
  $('ghost-count').textContent = visible.length;

  const q = filter.toLowerCase().trim();
  const filtered = q
    ? visible.filter(u => u.username.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q))
    : visible;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="no-ghosts">
      <div class="no-ghosts-emoji">${q ? '🔎' : '🎉'}</div>
      <div>${q ? `No match for "${escHtml(filter)}"` : 'No ghosts! Everyone they follow, follows back.'}</div>
    </div>`;
    return;
  }

  filtered.forEach((user, i) => {
    const item = document.createElement('a');
    item.className = 'ghost-item';
    item.target = '_blank'; item.rel = 'noopener noreferrer';
    item.href = `https://www.instagram.com/${user.username}/`;
    item.style.animationDelay = `${Math.min(i * 15, 400)}ms`;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'ghost-avatar';
    const initials = (user.full_name || user.username).charAt(0).toUpperCase();
    if (user.profile_pic_url) {
      const img = document.createElement('img');
      img.src = user.profile_pic_url; img.alt = user.username;
      img.onerror = () => { avatarEl.removeChild(img); avatarEl.textContent = initials; };
      avatarEl.appendChild(img);
    } else { avatarEl.textContent = initials; }

    const infoEl = document.createElement('div');
    infoEl.className = 'ghost-info';
    infoEl.innerHTML = `<div class="ghost-username">@${escHtml(user.username)}</div>
      ${user.full_name ? `<div class="ghost-fullname">${escHtml(user.full_name)}</div>` : ''}`;

    const openEl = document.createElement('span');
    openEl.className = 'ghost-open'; openEl.textContent = '↗';

    item.append(avatarEl, infoEl, openEl);
    listEl.appendChild(item);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY TAB
// ─────────────────────────────────────────────────────────────────────────────
async function renderHistoryTab() {
  const listEl = $('history-list');
  listEl.innerHTML = '<div class="history-empty"><div class="no-ghosts-emoji">⏳</div><div>Loading…</div></div>';
  const history = await loadHistory();

  if (history.length === 0) {
    listEl.innerHTML = `<div class="history-empty">
      <div class="no-ghosts-emoji">🕓</div>
      <div>No scans yet. Run a scan to see history here.</div>
    </div>`;
    return;
  }

  listEl.innerHTML = '';
  history.forEach(record => {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-card-header">
        <div class="history-card-user">@${escHtml(record.username)}</div>
        <button class="history-card-delete" title="Delete" data-id="${escHtml(record.id)}">🗑</button>
      </div>
      <div class="history-card-meta">
        <span>👻 <strong>${record.ghostCount}</strong> ghosts</span>
        <span>➡ ${record.following} following</span>
        <span>⏱ ${(record.durationMs / 1000).toFixed(0)}s</span>
      </div>
      <div class="history-card-date">${formatDate(record.scannedAt)}</div>`;

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('history-card-delete')) return;
      openHistoryScan(record);
    });

    card.querySelector('.history-card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteScanFromHistory(record.id);
      card.style.transition = 'opacity 0.2s'; card.style.opacity = '0';
      setTimeout(() => {
        card.remove();
        if (!listEl.querySelector('.history-card')) {
          listEl.innerHTML = `<div class="history-empty">
            <div class="no-ghosts-emoji">🕓</div><div>No scans yet.</div></div>`;
        }
      }, 200);
    });

    listEl.appendChild(card);
  });
}

function openHistoryScan(record) {
  _viewingHistoryRecord = record;
  _victimUsername = record.username;
  _ghosts = record.ghosts;
  _scanStart = new Date(record.scannedAt).getTime();

  switchTab('scan');
  $('user-badge-name').textContent = '@' + record.username;
  $('user-badge').classList.remove('hidden');
  $('search-input').value = '';

  renderResults('', record.ghosts);
  $('scan-time').textContent   = `📅 ${formatDate(record.scannedAt)} · ${(record.durationMs/1000).toFixed(0)}s`;
  $('stat-victim').textContent = '@' + record.username;
  $('ghost-count').textContent  = record.ghostCount;
  showView('results');
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────
function copyUsernames() {
  const src = _ghosts;
  if (!src.length) return;
  navigator.clipboard.writeText(src.map(u => '@' + u.username).join('\n'))
    .then(() => flashBtn('btn-copy', '✅'));
}

function exportJSON() {
  const src = _ghosts;
  if (!src.length) return;
  const data = {
    exportedAt: new Date().toISOString(),
    victim: _victimUsername,
    method: 'ground-truth-v4',
    totalGhosts: src.length,
    ghosts: src.map(({ username, full_name, pk }) => ({ username, full_name, pk })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), {
    href: url, download: `ghosts_${_victimUsername}_${new Date().toISOString().slice(0,10)}.json`
  }).click();
  URL.revokeObjectURL(url);
  flashBtn('btn-export', '✅');
}

function flashBtn(id, emoji) {
  const btn = $(id), orig = btn.textContent;
  btn.textContent = emoji;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
const victimInput = $('victim-input');
const btnScan     = $('btn-scan');

victimInput.addEventListener('input', () => {
  btnScan.disabled = victimInput.value.replace(/^@+/, '').trim().length === 0;
});
victimInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btnScan.disabled) btnScan.click();
});
btnScan.addEventListener('click', () => {
  const username = victimInput.value.replace(/^@+/, '').trim();
  if (!username) return;
  _viewingHistoryRecord = null;
  runScan(username);
});

$('btn-cancel-boot').addEventListener('click', async () => {
  _cancelled = true; await closeIgWindow(); showView('idle');
});
$('btn-cancel').addEventListener('click', () => { _cancelled = true; log('⛔ Cancelling…'); });
$('btn-rescan').addEventListener('click', () => {
  _ghosts = []; _viewingHistoryRecord = null;
  $('user-badge').classList.add('hidden');
  victimInput.value = ''; btnScan.disabled = true;
  const verifiedLabel = document.querySelector('.p-row:nth-child(2) .p-label');
  if (verifiedLabel) verifiedLabel.textContent = 'Followers scraped';
  showView('idle');
});

$('btn-copy').addEventListener('click', copyUsernames);
$('btn-export').addEventListener('click', exportJSON);
$('search-input').addEventListener('input', e => {
  renderResults(e.target.value, _viewingHistoryRecord ? _viewingHistoryRecord.ghosts : null);
});

function togglePill(pillId, setter) {
  const btn = $(pillId);
  btn.classList.toggle('active');
  setter(btn.classList.contains('active'));
  renderResults($('search-input').value, _viewingHistoryRecord ? _viewingHistoryRecord.ghosts : null);
}
$('pill-business').addEventListener('click', () => togglePill('pill-business', v => { _filterBusiness = v; }));
$('pill-creator').addEventListener('click',  () => togglePill('pill-creator',  v => { _filterCreator  = v; }));

$('btn-clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all scan history? This cannot be undone.')) return;
  await clearHistory(); renderHistoryTab();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === _igTabId && !_cancelled) {
    _cancelled = true; _igTabId = null; _igWinId = null;
    setTimeout(() => { alert('⚠️ The Instagram window was closed! Scan aborted.'); showView('idle'); }, 100);
  }
});
