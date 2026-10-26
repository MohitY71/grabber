# Grabber

Paste a link and it downloads. Works with plain files (multipart, pause/resume), HLS/m3u8 streams
(merged to MP4), YouTube and most video sites, and has an in-app browser that detects videos on any page.

Developer: **Mohit Yadav** · mohit@heygeeks.in

## Layout
- `packages/core` – the engine, in TypeScript: ranged multipart downloader, HLS parser/downloader (AES-128),
  ffmpeg/mux.js remux, queue with persistent resume, and the video-site extractor (yt-dlp) integration.
- `apps/desktop` – Electron app (macOS, Windows, Linux), TypeScript bundled with esbuild.

## Commands
| | |
|---|---|
| `npm run check` | strict type-check + all engine tests |
| `npm run desktop` | build and start the app |
| `npm run dist` | package an installer for the current OS (dmg / nsis / AppImage) |
| `npm run selftest -w @grabber/desktop` | drive the real UI end-to-end |
| `npm run icons` | regenerate the app icon from `apps/desktop/assets/icon.svg` |

## Video sites (YouTube, Vimeo, …)
Players like YouTube's stream in pieces from short-lived URLs, so there is no single file to fetch.
Pasting such a link (or pressing **Download the video on this page** in the browser) hands it to
[yt-dlp](https://github.com/yt-dlp/yt-dlp), which the app downloads once into its own data folder on first use
and can update from Settings. Pick a quality cap or audio-only (MP3) next to the link box.

**Not supported:** DRM-protected streams (Widevine/FairPlay/SAMPLE-AES, e.g. Netflix, paid rentals) are refused
with a clear message, live streams, and DASH-only `.mpd` links that aren't handled by the video engine.
Only download content you have the right to save; some sites' terms forbid downloading.

## Notes
- If `npm install` leaves Electron half-extracted (seen with Node 26), unzip the cached
  `~/Library/Caches/electron/*/electron-v*.zip` into `node_modules/electron/dist` and write
  `Electron.app/Contents/MacOS/Electron` to `node_modules/electron/path.txt`.
- Cookies from the in-app browser are passed to the video engine as a private, short-lived cookie file and are
  never sent to other sites' servers.
