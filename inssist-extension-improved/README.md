# Inssist Chrome Extension

A Chrome extension to download Instagram profiles, reels, stories, photos, bios, and profile pictures.

---

## ✦ Features

- **Download Posts & Reels** — video and photo from any post or reel page
- **Download Stories** — grab active stories before they expire
- **HD Profile Picture** — full-resolution, no watermark
- **Copy Bio** — instantly copy any profile's bio text
- **Full Profile Download** — bulk-download everything from a profile:
  - All posts & photos
  - All reels
  - Active stories
  - Profile picture (HD)
  - Bio & metadata as JSON
  - Story highlights
- **Right-click context menu** — right-click any image or video on Instagram to download it
- **Download history** — keeps a log of everything you've saved

---

## 🚀 How to Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `inssist-extension` folder
5. The extension icon appears in your toolbar — pin it for easy access

---

## 📖 How to Use

### Quick Downloads
1. Navigate to any Instagram post, reel, story, or profile page
2. Click the Inssist extension icon
3. Use the **Quick** tab buttons to download what's on screen

### Full Profile Download
1. Click the extension icon → go to **Profile** tab
2. Enter a username (e.g. `natgeo` or paste the full URL)
3. Click **Load** to preview the profile
4. Select which content types to download
5. Click **Download Entire Profile** — files save to `Downloads/Inssist/`

### Right-Click Download
- On any Instagram page, right-click an image or video → **⬇ Download with Inssist**

---

## ⚙ Tech Notes

- Uses Instagram's own public web API endpoints (same as the browser)
- No login required for public profiles
- All downloads go to `Downloads/Inssist/` on your computer
- No data is sent to any external server — everything runs locally in your browser

---

## 📋 Permissions Used

| Permission | Reason |
|---|---|
| `activeTab` | Read the current Instagram page |
| `scripting` | Inject downloader into Instagram pages |
| `downloads` | Save files to your Downloads folder |
| `storage` | Remember download history |
| `tabs` | Detect which Instagram page you're on |
| `host_permissions: instagram.com` | Access Instagram pages and their CDN |

---

*Built with Antigravity Claude ✦*
