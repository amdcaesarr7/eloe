// eloe content.js — v8 DOM INJECTED
// Operates in the ISOLATED world.

// ─────────────────────────────────────────────────────────────────────────────
// STATE & IndexedDB
// ─────────────────────────────────────────────────────────────────────────────
const _posts = new Map(); // shortcode or mediaId → mediaItems[]
const _stories = new Map(); // username/userId → mediaItems[]
let _hookReady = false;

let _dirHandle = null;

// Basic IDB wrapper for storing the directory handle
const dbName = 'eloeDB';
const storeName = 'handles';

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore(storeName); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDirHandle() {
  if (_dirHandle) return _dirHandle;
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get('saveFolder');
      req.onsuccess = async () => {
        const handle = req.result;
        if (handle) {
          // Verify we still have permission
          const status = await handle.queryPermission({ mode: 'readwrite' });
          if (status === 'granted') { _dirHandle = handle; resolve(handle); }
          else resolve(null);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function setDirHandle(handle) {
  _dirHandle = handle;
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(handle, 'saveFolder');
    tx.oncomplete = resolve;
  });
}

async function pickSaveDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setDirHandle(handle);
    return handle;
  } catch (e) {
    console.warn('[eloe] User cancelled directory picker', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE FILE WRITING (bypasses chrome.downloads)
// ─────────────────────────────────────────────────────────────────────────────
async function saveBlobToDisk(blob, filename) {
  let handle = await getDirHandle();
  if (!handle) {
    // If we don't have a handle or permission dropped, we must ask the user
    handle = await pickSaveDirectory();
  }
  if (!handle) return false;

  try {
    // Attempt to write the file natively
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    console.error('[eloe] Failed to write file:', e);
    // If we got a security error, permission was lost
    if (e.name === 'NotAllowedError') {
      alert('eloe needs permission to save to that folder. Please re-select it.');
      _dirHandle = null; // Clear bad handle
      handle = await pickSaveDirectory();
      if (handle) {
        try {
          const fileHandle = await handle.getFileHandle(filename, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          return true;
        } catch(_) {}
      }
    }
    return false;
  }
}

let _reqId = 0;
const _pending = new Map();

function igFetch(url) {
  return new Promise((resolve, reject) => {
    const id = ++_reqId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error('Timeout: ' + url));
    }, 30000);
    _pending.set(id, { resolve, reject, timer });
    window.postMessage({ __eloe: true, type: 'fetchApi', data: { reqId: id, url } }, '*');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTENER FROM HOOK.JS (MAIN WORLD)
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('message', ev => {
  if (!ev.data?.__eloe) return;
  const { type, data } = ev.data;

  if (type === 'hookReady') {
    _hookReady = true;
  } else if (type === 'apiJson') {
    _processApiJson(data.url, data.json);
  } else if (type === 'fetchApiResult') {
    const p = _pending.get(data.reqId);
    if (p) {
      clearTimeout(p.timer);
      _pending.delete(data.reqId);
      p.resolve(data);
    }
  }
});

function _processApiJson(url, j) {
  // Feed / Posts
  if (j?.items?.length) {
    for (const item of j.items) {
      if (item.code) _posts.set(item.code, _itemToMedia(item));
      if (item.id) _posts.set(item.id, _itemToMedia(item));
    }
  }

  // GraphQL timeline
  if (j?.data?.user?.edge_owner_to_timeline_media?.edges) {
    for (const edge of j.data.user.edge_owner_to_timeline_media.edges) {
      const node = edge.node;
      if (node?.shortcode) _posts.set(node.shortcode, _nodeToMedia(node));
    }
  }

  // Stories (reels_media)
  if (j?.reels_media?.length) {
    for (const reel of j.reels_media) {
      if (!reel.items) continue;
      const uname = reel.user?.username || reel.id;
      _stories.set(uname, reel.items.map(_itemToMedia).flat());
    }
  }
  
  // Highlight reels
  if (j?.reels && typeof j.reels === 'object') {
    for (const [rid, reel] of Object.entries(j.reels)) {
      if (!reel.items) continue;
      _stories.set(rid, reel.items.map(_itemToMedia).flat());
    }
  }
}

// ── Extraction Logic ─────────────────────────────────────────────────────────
function _bestVid(v) { return v?.slice().sort((a,b) => (b.width*b.height)-(a.width*a.height))[0]?.url; }
function _bestImg(v) { const c = v?.candidates; return c?.slice().sort((a,b) => (b.width*b.height)-(a.width*a.height))[0]?.url; }

function _itemToMedia(item) {
  if (item.carousel_media) {
    return item.carousel_media.map((m, i) => {
      const vid = m.media_type === 2;
      return { url: vid ? _bestVid(m.video_versions) : _bestImg(m.image_versions2), isVideo: vid, index: i };
    });
  }
  const vid = item.media_type === 2;
  return [{ url: vid ? _bestVid(item.video_versions) : _bestImg(item.image_versions2), isVideo: vid, index: 0 }];
}

function _nodeToMedia(node) {
  if (node.edge_sidecar_to_children?.edges) {
    return node.edge_sidecar_to_children.edges.map((e, i) => ({
      url: e.node.is_video ? (e.node.video_url || e.node.display_url) : e.node.display_url,
      isVideo: e.node.is_video,
      index: i
    }));
  }
  return [{ url: node.is_video ? (node.video_url || node.display_url) : node.display_url, isVideo: node.is_video, index: 0 }];
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM INJECTION & OBSERVER
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  download: `<svg aria-label="Download" class="_ab6-" color="currentColor" fill="currentColor" height="24" role="img" viewBox="0 0 24 24" width="24"><path d="M12 2v14m0 0l-5-5m5 5l5-5m-10 8h10" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`
};

function createEl(tag, className, innerHTML) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (innerHTML) el.innerHTML = innerHTML;
  return el;
}

// Finds the shortcode from an article by looking at its timestamp link
function getShortcodeFromArticle(article) {
  const a = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
  if (a) {
    const m = a.getAttribute('href').match(/\/(p|reel)\/([^/?#]+)/);
    if (m) return m[2];
  }
  return null;
}

function handleDownloadClick(e, type, identifier) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  
  if (btn.classList.contains('eloe-loading')) return;
  btn.classList.add('eloe-loading', 'eloe-picking');
  
  (async () => {
    try {
      let urls = [];
      let filenamePrefix = 'post';

      if (type === 'feed') {
        const shortcode = identifier;
        filenamePrefix = shortcode;
        const media = _posts.get(shortcode);
        
        if (media) {
          urls = media;
        } else {
          // Fallback: look at the DOM image/video
          const article = btn.closest('article');
          const vids = article.querySelectorAll('video[src]');
          const imgs = article.querySelectorAll('img[src*="cdninstagram"], img[src*="fbcdn"]');
          if (vids.length) urls = Array.from(vids).map(v => ({ url: v.src, isVideo: true, index: 0 }));
          else if (imgs.length) urls = [{ url: imgs[0].src, isVideo: false, index: 0 }];
        }
      } 
      else if (type === 'story') {
        filenamePrefix = 'story_' + Date.now();
        // Since stories disappear, the active one usually has a video tag or img
        const section = document.querySelector('section._ac0m'); // Story container
        if (section) {
          const vid = section.querySelector('video source, video[src]');
          if (vid && vid.src && !vid.src.startsWith('blob:')) {
            urls = [{ url: vid.src, isVideo: true, index: 0 }];
          } else {
            const img = section.querySelector('img._aa63, img[decoding="sync"]');
            if (img) urls = [{ url: img.src, isVideo: false, index: 0 }];
          }
        }
      }

      if (!urls.length) {
        alert('Could not find media to download. Scroll down and up to reload data.');
        return;
      }

      // Download each item
      for (const item of urls) {
        if (!item.url || item.url.startsWith('blob:')) continue; // skip blobs for now unless we resolve them
        
        // Fetch the file
        const res = await fetch(item.url);
        const blob = await res.blob();
        
        const ext = item.isVideo ? '.mp4' : '.jpg';
        const fname = urls.length > 1 ? `${filenamePrefix}_${item.index + 1}${ext}` : `${filenamePrefix}${ext}`;
        
        const success = await saveBlobToDisk(blob, fname);
        if (success) console.log('[eloe] Saved', fname);
      }
    } catch (err) {
      console.error('[eloe] Download error:', err);
      alert('Error: ' + err.message);
    } finally {
      btn.classList.remove('eloe-loading', 'eloe-picking');
    }
  })();
}

// ── Injectors ────────────────────────────────────────────────────────────────
function injectProfileButton() {
  // Only inject if checking a profile page
  if (!location.pathname.startsWith('/p/') && !location.pathname.startsWith('/reel/')) {
    const header = document.querySelector('header section');
    if (header && !header.querySelector('.eloe-profile-btn')) {
      // Find the row of buttons (Follow, Message)
      const btnRow = header.querySelector('button')?.closest('div, section') || header;
      
      const btn = createEl('button', 'eloe-profile-btn', 'Download');
      btn.style.cssText = "background: #efefef; border: none; border-radius: 8px; padding: 7px 16px; font-weight: 600; cursor: pointer; margin-left: 8px; color: #000;";
      
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const username = location.pathname.split('/').filter(Boolean)[0];
        chrome.runtime.sendMessage({ action: 'openBulkWindow', username });
      });
      
      btnRow.appendChild(btn);
    }
  }
}

function injectFeedButtons() {
  // Feed posts and Reels on timeline
  const articles = document.querySelectorAll('article');
  
  for (const article of articles) {
    // Find the action bar (Heart, Comment, Share icons)
    // The action bar is a section containing SVGs for engagement
    const actionBar = article.querySelector('section svg[aria-label="Like"], section svg[aria-label="Unlike"]')?.closest('section');
    
    if (actionBar && !actionBar.classList.contains('eloe-action-bar-injected')) {
      actionBar.classList.add('eloe-action-bar-injected');
      
      const shortcode = getShortcodeFromArticle(article);
      
      const btn = createEl('button', 'eloe-dl-btn', ICONS.download);
      btn.title = "Download with Eloe";
      btn.addEventListener('click', (e) => handleDownloadClick(e, 'feed', shortcode));
      
      // Instagram uses flexbox. Appending it will usually push it to the end.
      actionBar.appendChild(btn);
    }
  }
}

function injectStoryButtons() {
  // Story viewer container
  const storyContainer = document.querySelector('section._ac0m'); // Check IG DOM
  if (storyContainer && !storyContainer.querySelector('.eloe-overlay-btn')) {
    const btn = createEl('button', 'eloe-dl-btn eloe-overlay-btn', ICONS.download);
    btn.title = "Download Story";
    btn.addEventListener('click', (e) => handleDownloadClick(e, 'story', null));
    storyContainer.appendChild(btn);
  }
}

// ── Observer Start ───────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  injectFeedButtons();
  injectProfileButton();
  
  if (location.pathname.includes('/stories/')) {
    injectStoryButtons();
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });

// Initial run
setTimeout(() => {
  injectFeedButtons();
  injectProfileButton();
}, 2000);

// ── Chrome Message Listeners ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'triggerPickFolder') {
    pickSaveDirectory().then(handle => {
      if (handle) alert('Eloe save folder selected!');
    });
    sendResponse({ ok: true });
  } else if (msg.action === 'resetFolder') {
    _dirHandle = null;
    initDB().then(db => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete('saveFolder');
    });
    alert('Eloe save folder reset. You will be prompted on next download.');
    sendResponse({ ok: true });
  } else if (msg.action === 'proxyIgFetch') {
    igFetch(msg.url).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
});

