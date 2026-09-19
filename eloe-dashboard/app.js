// Eloe Dashboard App Logic

// ── 1. Parallax Space Background ──
const parallaxBg = document.getElementById('parallax-bg');
document.addEventListener('mousemove', (e) => {
  const x = (window.innerWidth - e.pageX * 2) / 90;
  const y = (window.innerHeight - e.pageY * 2) / 90;
  parallaxBg.style.transform = `translate(${x}px, ${y}px)`;
});

// ── 2. Biometric Lock Screen ──
const lockScreen = document.getElementById('lock-screen');
const appScreen = document.getElementById('app');
const scannerEvent = document.querySelector('.scanner-container');

// A 1-second hover unlocks it securely
let unlockTimer;
scannerEvent.addEventListener('mouseenter', () => {
  unlockTimer = setTimeout(() => {
    document.querySelector('.lock-status').textContent = "ACCESS GRANTED";
    setTimeout(() => {
      lockScreen.classList.add('hidden');
      appScreen.classList.remove('hidden');
    }, 500);
  }, 1000);
});
scannerEvent.addEventListener('mouseleave', () => {
  clearTimeout(unlockTimer);
});


// ── 3. Database Engine (File System Access) ──
let profilesIndex = [];
let dirHandleGlobal = null;
let activeChart = null;

const btnLoad = document.getElementById('btn-load-folder');
const targetListEl = document.getElementById('target-list');

btnLoad.addEventListener('click', async () => {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    dirHandleGlobal = dirHandle;
    await indexDatabase(dirHandle);
  } catch (err) {
    console.error("Dashboard Load Cancelled:", err);
  }
});

async function indexDatabase(rootHandle) {
  targetListEl.innerHTML = '<div class="target-empty">Scanning database...</div>';
  profilesIndex = [];

  // Iterate over root subdirectories
  for await (const entry of rootHandle.values()) {
    if (entry.kind === 'directory') {
      try {
        const jsonFileHandle = await entry.getFileHandle(`${entry.name}_profile_data.json`);
        const file = await jsonFileHandle.getFile();
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Save handle for media blob rendering
        data.__folderHandle = entry;
        profilesIndex.push(data);
      } catch (e) {
        // Not an Eloe folder or missing JSON
      }
    }
  }

  renderSidebar();
  renderGlobalStats();
}

function renderGlobalStats() {
  document.getElementById('global-stats').classList.remove('hidden');
  document.getElementById('g-total-profiles').textContent = profilesIndex.length;
  
  let gGaddar = 0;
  let gMedia = 0;
  
  profilesIndex.forEach(p => {
    const following = (p.followingList || []).map(u => u.toLowerCase().trim());
    const followers = new Set((p.followersList || []).map(u => u.toLowerCase().trim()));
    
    gGaddar += following.filter(u => !followers.has(u)).length;
    
    gMedia += (p.media?.posts?.length || 0) + (p.media?.stories?.length || 0);
    gMedia += Object.keys(p.media?.highlights || {}).reduce((acc, k) => acc + p.media.highlights[k].length, 0);
  });
  
  document.getElementById('g-total-gaddars').textContent = gGaddar;
  document.getElementById('g-total-media').textContent = gMedia.toLocaleString();
}

// ── 4. UI Rendering ──

function renderSidebar() {
  targetListEl.innerHTML = '';
  const totalProfiles = profilesIndex.length;
  document.querySelector('.sidebar-header h3').innerHTML = `Targets <span class="badge">${totalProfiles}</span>`;
  
  if (totalProfiles === 0) {
    targetListEl.innerHTML = '<div class="target-empty">No Eloe JSONs found.</div>';
    return;
  }

  profilesIndex.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'target-item';
    el.innerHTML = `
      <div class="target-pfp">${p.username.charAt(0).toUpperCase()}</div>
      <div class="target-info">
        <h4>@${p.username}</h4>
        <p>${p.followers} followers</p>
      </div>
    `;
    el.addEventListener('click', () => {
      document.querySelectorAll('.target-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      loadProfileData(p);
    });
    targetListEl.appendChild(el);
  });
}

function loadProfileData(p) {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('profile-view').classList.remove('hidden');
  
  // Reset Animations
  const profileView = document.getElementById('profile-view');
  profileView.classList.remove('hidden');
  
  // Header
  document.getElementById('prof-pic-initial').textContent = p.username.charAt(0).toUpperCase();
  
  const linkEl = document.getElementById('prof-link');
  linkEl.textContent = `@${p.username}`;
  linkEl.href = `https://instagram.com/${p.username}`;
  
  document.getElementById('prof-bio').textContent = p.biography || '[No biography provided]';
  
  // Stats
  document.getElementById('prof-posts').textContent = p.postsCount.toLocaleString() || 0;
  document.getElementById('prof-followers').textContent = p.followers.toLocaleString() || 0;
  document.getElementById('prof-following').textContent = p.following.toLocaleString() || 0;

  // Ledger Extractions
  document.getElementById('prof-fetched').textContent = `Scraped At: ${new Date(p.fetchedAt).toLocaleString()}`;
  document.getElementById('ext-posts').textContent = p.media?.posts?.length || 0;
  document.getElementById('ext-stories').textContent = p.media?.stories?.length || 0;
  document.getElementById('ext-hl').textContent = Object.keys(p.media?.highlights || {}).reduce((acc, k) => acc + p.media.highlights[k].length, 0);

  // Gaddars Calculation (Pythonic Set-Subtraction Style)
  const followingList = (p.followingList || []);
  const followersList = (p.followersList || []);
  const followersSet = new Set(followersList.map(u => u.toLowerCase().trim()));
  
  // All original usernames to maintain casing for DISPLAY
  const gaddars = followingList.filter(u => !followersSet.has(u.toLowerCase().trim()));
  
  document.getElementById('gaddar-count').textContent = gaddars.length;
  const glEl = document.getElementById('gaddar-list');
  glEl.innerHTML = '';
  
  // Warning if scrape appears incomplete (Threshold lowered to 70% to account for Instagram's ghost/deactivated accounts)
  if (followersList.length < p.followers * 0.70 && p.followers > 50) {
    glEl.innerHTML = `<div style="color:#fa0; font-size:10px; margin-bottom:10px; opacity:0.8;">⚠ DATABASE INCOMPLETE: Scraped ${followersList.length}/${p.followers} followers. Traitor list may be inaccurate.</div>`;
  }
  
  if (followingList.length === 0 || followersList.length === 0) {
    glEl.innerHTML += '<div style="color:#666; font-size:12px; margin-top:10px;">Scrape list missing.</div>';
  } else if (gaddars.length === 0) {
    glEl.innerHTML += '<div style="color:#0f0; font-size:12px; margin-top:10px;">No traitors found!</div>';
  } else {
    gaddars.forEach(g => {
      const d = document.createElement('div');
      d.className = 'gaddar-item';
      d.innerHTML = `<a href="https://instagram.com/${g}" target="_blank">@${g}</a>`;
      glEl.appendChild(d);
    });
  }

  renderChart(p.followers, p.following);
  
  // Initialize Media Gallery
  initMediaGallery(p);
}

// ── 5. Media Gallery Local Rendering ──
let activeMediaProfile = null;
let mediaObserver = null;

function initMediaGallery(profile) {
  activeMediaProfile = profile;
  if(mediaObserver) mediaObserver.disconnect();
  
  // Setup Lazy Loading Observer
  mediaObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if(entry.isIntersecting) {
        const path = entry.target.dataset.path;
        loadMediaBlob(entry.target, activeMediaProfile.__folderHandle, path);
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '100px' });

  // Tab Listeners
  document.querySelectorAll('.m-tab').forEach(tab => {
    tab.onclick = (e) => {
      document.querySelectorAll('.m-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      renderMediaGrid(e.target.dataset.tab);
    };
  });
  
  // Load default
  document.querySelector('.m-tab[data-tab="all"]').click();
}

function renderMediaGrid(collectionType) {
  const grid = document.getElementById('media-grid');
  grid.innerHTML = '';
  
  let paths = [];
  if (collectionType === 'all') {
    paths = [
      ...(activeMediaProfile.media?.posts || []),
      ...(activeMediaProfile.media?.stories || []),
      ...Object.values(activeMediaProfile.media?.highlights || {}).flat()
    ];
  }
  else if (collectionType === 'posts') {
    paths = (activeMediaProfile.media?.posts || []).filter(p => !p.toLowerCase().endsWith('.mp4'));
  }
  else if (collectionType === 'reels') {
    paths = (activeMediaProfile.media?.posts || []).filter(p => p.toLowerCase().endsWith('.mp4'));
  }
  else if (collectionType === 'stories') {
    paths = activeMediaProfile.media?.stories || [];
  }
  else if (collectionType === 'highlights') {
    Object.values(activeMediaProfile.media?.highlights || {}).forEach(arr => paths.push(...arr));
  }

  if (paths.length === 0) {
    grid.innerHTML = '<p style="color:#666; font-size:12px; grid-column:1/-1;">No media mapped for this section.</p>';
    return;
  }

  paths.forEach(path => {
    const el = document.createElement('div');
    el.className = `media-item ${collectionType === 'posts' ? 'img-post' : 'vid-post'}`;
    el.dataset.path = path;
    el.innerHTML = '<span class="lazy-placeholder">Loading...</span>';
    grid.appendChild(el);
    mediaObserver.observe(el);
  });
}

async function loadMediaBlob(element, rootDir, relativePath) {
  try {
    const parts = relativePath.split(/[/\\]/);
    let currDir = rootDir;
    
    // Traverse directories
    for (let i = 0; i < parts.length - 1; i++) {
        currDir = await currDir.getDirectoryHandle(parts[i]);
    }
    
    const fHandle = await currDir.getFileHandle(parts[parts.length - 1]);
    const file = await fHandle.getFile();
    const url = URL.createObjectURL(file);
    
    element.innerHTML = '';
    const isVid = file.name.endsWith('.mp4');
    
    if (isVid) {
      const vid = document.createElement('video');
      vid.src = url;
      vid.autoplay = false;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      element.appendChild(vid);
      
      // Hover to Play logic
      element.addEventListener('mouseenter', () => vid.play());
      element.addEventListener('mouseleave', () => {
        vid.pause();
        vid.currentTime = 0; // Better for a 'preview' feel, or remove this to pause in place
      });
    } else {
      const img = document.createElement('img');
      img.src = url;
      element.appendChild(img);
    }
  } catch (e) {
    element.innerHTML = '<span class="lazy-placeholder" style="color:red;">File Linked But Missing</span>';
  }
}

// ── 6. Chart.js ──
function renderChart(followers, following) {
  const ctx = document.getElementById('ratioChart').getContext('2d');
  
  if (activeChart) {
    activeChart.destroy();
  }

  Chart.defaults.color = '#fff';
  Chart.defaults.font.family = "'Space Mono', monospace";

  activeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Followers', 'Following'],
      datasets: [{
        data: [followers, following],
        backgroundColor: ['rgba(255, 255, 255, 0.8)', 'rgba(50, 50, 50, 0.8)'],
        borderColor: ['#000', '#000'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' }
      }
    }
  });
}
