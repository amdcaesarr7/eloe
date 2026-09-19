// popup.js - v8 Settings & Comprehensive Bulk Logic

const qs = new URLSearchParams(window.location.search);
const bulkUser = qs.get('bulk');
const sourceTabId = parseInt(qs.get('tabId'));

let _cancel = false;
const term = document.getElementById('terminal');

function log(msg) {
  term.textContent += '\n> ' + msg;
  term.scrollTop = term.scrollHeight;
}

// ── MAIN ROUTING ──
if (bulkUser) {
  document.getElementById('view-settings').style.display = 'none';
  document.getElementById('view-bulk').style.display = 'flex';
  document.getElementById('bulk-user').textContent = bulkUser;

  const btnStart = document.getElementById('btn-start-bulk');
  const btnStop = document.getElementById('btn-stop-bulk');

  btnStart.addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const userFolder = await handle.getDirectoryHandle(bulkUser, { create: true });
      
      btnStart.style.display = 'none';
      btnStop.style.display = 'block';
      _cancel = false;
      log(`Save folder designated: /${bulkUser}/`);
      
      await runBulkLoop(bulkUser, userFolder);

    } catch (e) {
      log('Folder selection cancelled or failed: ' + e.message);
    }
  });

  btnStop.addEventListener('click', () => {
    _cancel = true;
    log('Stopping after current batch completes...');
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping...';
  });

} else {
  // SETTINGS MODE
  document.getElementById('btn-pick-folder').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes('instagram.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'triggerPickFolder' });
      showStatus('Please check the Instagram page to select the folder.');
    } else {
      alert('Please open Instagram to select a folder.');
    }
  });

  document.getElementById('btn-reset-folder').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes('instagram.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'resetFolder' });
      showStatus('Folder selection reset.');
    } else {
      alert('Please open Instagram to reset the folder.');
    }
  });
}

function showStatus(msg) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── BULK LOGIC ──

function proxyFetch(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(sourceTabId, { action: 'proxyIgFetch', url }, res => {
      if (chrome.runtime.lastError) return reject(new Error('Instagram tab closed or disconnected.'));
      if (!res || !res.ok) return reject(new Error(res?.error || `Fetch failed for ${url}`));
      resolve(res.json);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function bestVid(v) { return v?.slice().sort((a,b) => (b.width*b.height)-(a.width*a.height))[0]?.url; }
function bestImg(v) { const c = v?.candidates; return c?.slice().sort((a,b) => (b.width*b.height)-(a.width*a.height))[0]?.url; }

function sanitize(s, fallbackId) {
  let clean = String(s || '').replace(/[^a-z0-9_\-\.\u00a1-\uffff]/gi, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  if (!clean) clean = 'folder';
  let finalStr = fallbackId ? `${clean}_${fallbackId}` : clean;
  // Strictly remove Windows-forbidden characters from the final directory/file name
  finalStr = finalStr.replace(/[\\/:*?"<>|]/g, '_');
  // Chrome FileSystemAccess API absolutely forbids leading dots (.) and some unicode bullets
  finalStr = finalStr.replace(/^[^a-zA-Z0-9]+/, '');
  if (!finalStr) finalStr = 'folder_' + Date.now();
  return finalStr;
}

// Handles parsing REST v1 items or Reels items
function parseItems(item) {
  if (item.carousel_media) {
    return item.carousel_media.map((m, i) => {
      const vid = m.media_type === 2;
      return { url: vid ? bestVid(m.video_versions) : bestImg(m.image_versions2), isVid: vid, code: item.code || item.pk || Date.now(), index: i, taken: item.taken_at };
    });
  }
  const vid = item.media_type === 2;
  return [{ url: vid ? bestVid(item.video_versions) : bestImg(item.image_versions2), isVid: vid, code: item.code || item.pk || Date.now(), index: 0, taken: item.taken_at }];
}

async function runBulkLoop(username, folderHandle) {
  log(`Fetching profile info for @${username}...`);
  try {
    const pInfo = await proxyFetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`);
    const user = pInfo?.data?.user;
    if (!user) throw new Error('Could not resolve user profile.');
    
    log(`Resolved User ID: ${user.id}`);
    
    // Master Export JSON
    const exportData = {
      username: user.username,
      fullName: user.full_name || '',
      biography: user.biography || '',
      followers: user.edge_followed_by?.count || 0,
      following: user.edge_follow?.count || 0,
      postsCount: user.edge_owner_to_timeline_media?.count || 0,
      isPrivate: user.is_private,
      fetchedAt: new Date().toISOString(),
      media: {
        profilePic: '',
        posts: [],
        stories: [],
        highlights: {}
      }
    };

    let totalDownloaded = 0;

    // 1. Profile Picture
    const pfpUrl = user.hd_profile_pic_url_info?.url || user.profile_pic_url_hd || user.profile_pic_url;
    if (pfpUrl && !_cancel) {
      log('Downloading Profile Picture...');
      const fname = `${username}_pfp.jpg`;
      await downloadAndSave(pfpUrl, fname, folderHandle);
      exportData.media.profilePic = fname;
      totalDownloaded++;
    }

    // 2. Main Feed Posts (First 12 from web_profile_info directly)
    let edges = user.edge_owner_to_timeline_media?.edges || [];
    let pageInfo = user.edge_owner_to_timeline_media?.page_info;

    if (edges.length > 0 && !_cancel) {
      log(`Found ${edges.length} recent posts. Downloading...`);
      for (const edge of edges) {
        if (_cancel) break;
        const node = edge.node;
        if (!node) continue;
        
        const mediaObjs = [];
        if (node.edge_sidecar_to_children?.edges) {
          node.edge_sidecar_to_children.edges.forEach((c, i) => {
            const cn = c.node;
            mediaObjs.push({ url: cn.is_video ? (cn.video_url || cn.display_url) : cn.display_url, isVid: cn.is_video, code: node.shortcode, index: i });
          });
        } else {
          mediaObjs.push({ url: node.is_video ? (node.video_url || node.display_url) : node.display_url, isVid: node.is_video, code: node.shortcode, index: 0 });
        }

        for (const m of mediaObjs) {
          if (!m.url) continue;
          const ext = m.isVid ? '.mp4' : '.jpg';
          const fname = m.index > 0 ? `${m.code}_${m.index + 1}${ext}` : `${m.code}${ext}`;
          
          if (await downloadAndSave(m.url, fname, folderHandle)) {
            exportData.media.posts.push(fname);
            totalDownloaded++;
            log(`Saved Post: ${fname}`);
          }
          await sleep(300 + Math.random() * 200);
        }
      }
      
      if (pageInfo?.has_next_page && !_cancel) {
        log('---');
        log('Notice: Instagram Web restricts deep pagination via API. To download more than the first 12 posts, scroll down the Instagram page to load more posts, then click the "Download All Visible" feature coming in future updates!');
      }
    }

    // 3. Stories
    if (!_cancel) {
      log('Checking for active Stories...');
      try {
        const storiesRes = await proxyFetch(`https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${user.id}`);
        const storyReel = storiesRes.reels_media?.find(r => String(r.user?.pk || r.id) === String(user.id));
        
        if (storyReel?.items?.length) {
          log(`Found ${storyReel.items.length} active stories.`);
          // Create Stories Subfolder
          const storiesFolder = await folderHandle.getDirectoryHandle('stories', { create: true });
          
          for (const item of storyReel.items) {
            if (_cancel) break;
            const parsed = parseItems(item)[0];
            if (!parsed?.url) continue;

            const ext = parsed.isVid ? '.mp4' : '.jpg';
            const fname = `story_${parsed.code}${ext}`;
            
            if (await downloadAndSave(parsed.url, fname, storiesFolder)) {
              exportData.media.stories.push(`stories/${fname}`);
              totalDownloaded++;
              log(`Saved Story: ${fname}`);
            }
            await sleep(300 + Math.random() * 200);
          }
        } else {
          log('No active stories found.');
        }
      } catch (e) {
        log('Could not fetch stories (might be private or unavailable).');
      }
    }

    // 4. Highlights
    if (!_cancel) {
      log('Fetching Highlights Tray...');
      try {
        const trayRes = await proxyFetch(`https://i.instagram.com/api/v1/highlights/${user.id}/highlights_tray/`);
        const tray = trayRes.tray || [];
        
        if (tray.length > 0) {
          log(`Found ${tray.length} highlight categories.`);
          const hlRootFolder = await folderHandle.getDirectoryHandle('highlights', { create: true });

          // Fetch chunks of 5 highlights at a time to avoid huge URLs
          for (let i = 0; i < tray.length; i += 5) {
            if (_cancel) break;
            const chunk = tray.slice(i, i + 5);
            const ids = chunk.map(h => h.id).join(',');
            
            log(`Fetching highlights chunk ${i/5 + 1}...`);
            const hlRes = await proxyFetch(`https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${ids}`);
            
            for (const reel of hlRes.reels_media || []) {
              if (_cancel) break;
              const sourceTrayItem = chunk.find(h => h.id === reel.id);
              const dirName = sanitize(sourceTrayItem?.title, reel.id);
              exportData.media.highlights[dirName] = [];
              
              if (reel.items?.length) {
                log(`Downloading ${reel.items.length} items from highlight: ${dirName}`);
                const hlSubFolder = await hlRootFolder.getDirectoryHandle(dirName, { create: true });
                
                for (let j = 0; j < reel.items.length; j++) {
                  if (_cancel) break;
                  const item = reel.items[j];
                  const parsed = parseItems(item)[0];
                  if (!parsed?.url) continue;

                  const ext = parsed.isVid ? '.mp4' : '.jpg';
                  const fname = `${String(j+1).padStart(3, '0')}_${parsed.code}${ext}`;
                  
                  if (await downloadAndSave(parsed.url, fname, hlSubFolder)) {
                    exportData.media.highlights[dirName].push(`highlights/${dirName}/${fname}`);
                    totalDownloaded++;
                  }
                  await sleep(300 + Math.random() * 200);
                }
              }
            }
          }
        } else {
          log('No highlights found.');
        }
      } catch (e) {
        log('Could not fetch highlights: ' + e.message);
      }
    }

    // 4b. Fetch Following
    if (!_cancel) {
      log('Fetching Following list...');
      let maxId = '';
      exportData.followingList = [];
      while (true && !_cancel) {
        try {
          const res = await proxyFetch(`https://i.instagram.com/api/v1/friendships/${user.id}/following/?count=50${maxId ? '&max_id='+maxId : ''}`);
          if (res.users?.length) {
            exportData.followingList.push(...res.users.map(u => u.username));
            log(`Scraped ${exportData.followingList.length} following...`);
          }
          if (res.next_max_id) {
            maxId = res.next_max_id;
            await sleep(2000 + Math.random() * 2000);
          } else break;
        } catch (e) {
          log('Following fetch error: ' + e.message);
          break;
        }
      }
    }

    // 4c. Fetch Followers
    if (!_cancel) {
      log('Fetching Followers list...');
      let maxId = '';
      exportData.followersList = [];
      while (true && !_cancel) {
        try {
          const res = await proxyFetch(`https://i.instagram.com/api/v1/friendships/${user.id}/followers/?count=50${maxId ? '&max_id='+maxId : ''}`);
          if (res.users?.length) {
            exportData.followersList.push(...res.users.map(u => u.username));
            log(`Scraped ${exportData.followersList.length} followers...`);
          }
          if (res.next_max_id) {
            maxId = res.next_max_id;
            await sleep(2000 + Math.random() * 2000);
          } else break;
        } catch (e) {
          log('Followers fetch error: ' + e.message);
          break;
        }
      }
    }

    // 5. Write Master Export JSON
    if (!_cancel) {
      log('Writing master export data JSON...');
      exportData.totalDownloadedFiles = totalDownloaded;
      const jsonBlob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      await saveBlobDirectly(jsonBlob, `${username}_profile_data.json`, folderHandle);
      log(`Saved Master JSON: ${username}_profile_data.json`);
    }

    if (_cancel) log('BULK EXPORT STOPPED BY USER.');
    else log('BULK EXPORT 100% COMPLETE!');
    
    log(`Total all files downloaded: ${totalDownloaded}`);
    
  } catch(e) {
    log('FATAL ERROR: ' + e.message);
    log('If "Instagram tab closed" appears, you must keep the main Instagram window open.');
  } finally {
    btnStopDisplay('Close Window');
  }
}

// Helper to fetch blob and write
async function downloadAndSave(url, filename, folderHandle) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const blob = await res.blob();
    return await saveBlobDirectly(blob, filename, folderHandle);
  } catch(e) {
    return false;
  }
}

async function saveBlobDirectly(blob, filename, folderHandle) {
  try {
    const fh = await folderHandle.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch(e) {
    // OneDrive / Cloud Sync lock retry
    log('Write error on ' + filename + '. Retrying in 1s...');
    await sleep(1000);
    try {
      const fh = await folderHandle.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e2) {
      log('Final write error on ' + filename + ': ' + e2.message);
      return false;
    }
  }
}

function btnStopDisplay(text) {
  document.getElementById('btn-stop-bulk').style.display = 'none';
  const btn = document.getElementById('btn-start-bulk');
  btn.style.display = 'block';
  btn.textContent = text;
  btn.onclick = () => window.close();
}
