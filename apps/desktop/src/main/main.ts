import {
  app, BrowserWindow, ipcMain, shell, dialog, session, clipboard, Menu, MenuItem, nativeImage, Notification, Tray, powerSaveBlocker,
  webContents as allWebContents, webFrameMain, type WebContents,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { DownloadManager, isExecutableName, parsePlaylist, type JobView } from '@grabber/core';
import {
  APP_NAME, DEVELOPER, type AddRequest, type AppInfo, type ApiInfo, type BrowserCmd, type FrameScan, type HlsQuality, type MediaKind, type Settings, type SniffHit,
} from '../shared/api.ts';
import { pageHook, pageScanner, type ScanResult } from '../shared/scanner.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { AdBlocker } from './adblock.ts';
import { createApiServer, listenOnFreePort, type ApiAddBody } from './api-server.ts';
import type http from 'node:http';

const BROWSER_PARTITION = 'persist:browser';
const isDev = !app.isPackaged;
const root = path.join(__dirname, '..'); // dist/.. = apps/desktop (or the app.asar root when packaged)
const iconPath = path.join(root, 'build', 'icon.png');

if (process.env.GRABBER_HOME) {
  app.setPath('userData', path.join(process.env.GRABBER_HOME, 'userData'));
  app.setPath('downloads', path.join(process.env.GRABBER_HOME, 'Downloads'));
}
app.setName(APP_NAME);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager!: DownloadManager;
let settings!: Settings;
let adblock!: AdBlocker;
let apiServer: http.Server | null = null;
let apiPort = 0;
let quitting = false;
let sleepBlocker: number | null = null;
const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');
const sendCmd = (cmd: BrowserCmd, arg?: string): void => { win?.webContents.send('browser:cmd', cmd, arg); };

function ffmpegPath(): string {
  try {
    let p = require('ffmpeg-static') as string | null;
    if (p?.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall back to ffmpeg on PATH */ }
  return 'ffmpeg';
}

function extensionDir(): string | null {
  const candidates = [path.join(process.resourcesPath ?? '', 'extension'), path.join(root, '..', '..', 'extensions', 'browser', 'dist')];
  return candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json'))) ?? null;
}

/* ---------- download manager ---------- */
async function startManager(): Promise<void> {
  settings = loadSettings(settingsFile());
  settings.downloadDir ||= path.join(app.getPath('downloads'), APP_NAME);
  manager = await new DownloadManager({
    dataDir: path.join(app.getPath('userData'), 'engine'),
    toolsDir: path.join(app.getPath('userData'), 'tools'),
    downloadDir: settings.downloadDir,
    ffmpegPath: ffmpegPath(),
    maxConcurrent: settings.maxConcurrent, threads: settings.threads,
    onExists: settings.onExists, categoryFolders: settings.categoryFolders,
    speedLimit: settings.speedLimitKB * 1024, autoRetry: settings.autoRetry, resumeOnStart: settings.resumeOnStart,
  }).init();

  const last = new Map<string, JobView['status']>();
  for (const j of manager.list()) last.set(j.id, j.status);
  manager.on('update', (j: JobView) => {
    win?.webContents.send('dl:update', j);
    const prev = last.get(j.id);
    last.set(j.id, j.status);
    if (prev !== j.status) { notifyIfFinished(j); updateBackgroundState(); }
  });
  manager.on('removed', (id: string) => { last.delete(id); win?.webContents.send('dl:removed', id); updateBackgroundState(); });
}

/** #12: tell the user when a download finishes or fails (unless they're already looking at the window). */
function notifyIfFinished(j: JobView): void {
  if (!settings.notifications || !Notification.isSupported()) return;
  if (j.status !== 'done' && j.status !== 'error') return;
  if (j.status === 'done' && j.note?.startsWith('Added ')) return; // playlist parent
  if (win?.isVisible() && win.isFocused()) return;
  const n = new Notification({
    title: j.status === 'done' ? 'Download complete' : 'Download failed',
    body: j.status === 'done' ? j.name : `${j.name}\n${j.error ?? ''}`.trim(),
    ...(fs.existsSync(iconPath) ? { icon: nativeImage.createFromPath(iconPath) } : {}),
  });
  n.on('click', () => { showWindow(); sendCmd('showdownloads'); });
  n.show();
}

/** #23: keep the machine awake while downloading, and keep the tray menu current. */
function updateBackgroundState(): void {
  const active = manager.list().filter((j) => ['downloading', 'probing', 'merging'].includes(j.status)).length;
  if (settings.keepAwake && active > 0 && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if ((!settings.keepAwake || active === 0) && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
  tray?.setToolTip(active ? `${APP_NAME} — ${active} downloading` : APP_NAME);
}

function showWindow(): void {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createTray(): void {
  if (tray || !fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Pause all', click: () => manager.pauseAll() },
    { label: 'Resume all', click: () => manager.resumeAll() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

/* ---------- browser session: UA, permissions, ad blocker, downloads, media sniffer ---------- */
interface CookieLike { domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number; name: string; value: string }

/** Cookies as a Netscape cookie file (what yt-dlp reads), written privately and deleted after a day. */
function writeCookieFile(cookies: CookieLike[], fallbackHost: string): string | undefined {
  if (!cookies.length) return undefined;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain || fallbackHost;
    lines.push([c.httpOnly ? `#HttpOnly_${domain}` : domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path ?? '/', c.secure ? 'TRUE' : 'FALSE', String(Math.floor(c.expirationDate ?? 0)), c.name, c.value].join('\t'));
  }
  const dir = path.join(app.getPath('userData'), 'cookies');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}
function purgeOldCookieFiles(): void {
  const dir = path.join(app.getPath('userData'), 'cookies');
  try { for (const f of fs.readdirSync(dir)) if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 24 * 3600_000) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* none yet */ }
}

async function browserCookies(url: string): Promise<{ header: string | undefined; file: string | undefined }> {
  try {
    const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({ url });
    return { header: cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : undefined, file: writeCookieFile(cookies, new URL(url).hostname) };
  } catch { return { header: undefined, file: undefined }; }
}

async function browserAdd(url: string, o: AddRequest = {}): Promise<string> {
  const ck = o.useBrowserSession ? await browserCookies(url) : { header: undefined, file: undefined };
  return manager.add(url, {
    referer: o.referer, cookies: ck.header, cookiesFile: ck.file, filename: o.filename,
    userAgent: o.useBrowserSession ? session.fromPartition(BROWSER_PARTITION).getUserAgent() : undefined,
    quality: o.quality || settings.quality, threads: settings.threads,
    saveDir: o.saveDir, priority: o.priority, startAt: o.startAt, checksum: o.checksum, onExists: o.onExists,
  });
}

const kindOfUrl = (u: string): MediaKind => (/\.m3u8(\?|#|$)/i.test(u) ? 'hls' : /\.mpd(\?|#|$)/i.test(u) ? 'dash' : 'video');

function setupBrowserSession(): void {
  const ses = session.fromPartition(BROWSER_PARTITION);
  // Look like a normal Chrome: many sites refuse "Electron/x" user agents.
  ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(new RegExp(`\\s?${APP_NAME}\\/\\S+`, 'i'), ''));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(permission)));
  // A link that is a file download (zip, attachment, ...) goes to the download manager, not the webview.
  ses.on('will-download', (event, item, wc) => {
    event.preventDefault();
    const filename = item.getFilename();
    void browserAdd(item.getURL(), { referer: wc?.getURL() || undefined, useBrowserSession: true, filename: filename || undefined })
      .then(() => sendCmd('toast', `Download started: ${filename}`))
      .catch((e: Error) => sendCmd('toast', e.message));
  });

  // --- ad blocker: network layer. Counts are batched so a busy page doesn't flood the UI. ---
  const blocked = new Map<number, number>();
  const dirty = new Set<number>();
  setInterval(() => {
    for (const id of dirty) win?.webContents.send('adblock:count', { tabId: id, count: blocked.get(id) ?? 0 });
    dirty.clear();
  }, 400).unref();
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
    if (d.resourceType === 'mainFrame') { if (d.webContentsId) { blocked.set(d.webContentsId, 0); dirty.add(d.webContentsId); } return cb({}); }
    const pageUrl = d.webContents && !d.webContents.isDestroyed() ? d.webContents.getURL() : d.referrer;
    if (adblock.shouldBlock({ url: d.url, resourceType: d.resourceType, referrer: d.referrer, pageUrl })) {
      if (d.webContentsId) { blocked.set(d.webContentsId, (blocked.get(d.webContentsId) ?? 0) + 1); dirty.add(d.webContentsId); }
      return cb({ cancel: true });
    }
    cb({});
  });

  // --- media sniffer: network layer (by URL / content type) ---
  const reqHeaders = new Map<number, Record<string, string>>();
  ses.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
    reqHeaders.set(d.id, d.requestHeaders);
    if (reqHeaders.size > 2000) reqHeaders.delete(reqHeaders.keys().next().value as number);
  });
  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    cb({});
    try {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.responseHeaders ?? {})) h[k.toLowerCase()] = [v].flat()[0] ?? '';
      const type = (h['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const u = d.url;
      // Chunked player traffic (YouTube's videoplayback, DASH/HLS segments) is not a downloadable file by itself;
      // the "this page" entry hands those sites to the video engine instead.
      const isChunk = /\.(ts|m4s|aac|vtt|webvtt)(\?|#|$)/i.test(u) || /mp2t|iso\.segment/.test(type) || /videoplayback|\/range\/|[?&]range=|\bsq=\d+/.test(u);
      let kind: MediaKind | null = null;
      if (/mpegurl/.test(type) || /\.m3u8(\?|#|$)/i.test(u)) kind = 'hls';
      else if (/dash\+xml/.test(type) || /\.mpd(\?|#|$)/i.test(u)) kind = 'dash';
      else if (!isChunk && (type.startsWith('video/') || /\.(mp4|webm|mkv|mov|m4v)(\?|#|$)/i.test(u)) && type !== 'text/html') kind = 'video';
      if (!kind) return;
      let size = Number(h['content-length']) || null;
      const m = /\/(\d+)\s*$/.exec(h['content-range'] ?? '');
      if (m) size = Number(m[1]);
      if (kind === 'video' && size && size < 150 * 1024) return; // tracking pixels / tiny clips
      const rq = reqHeaders.get(d.id) ?? {};
      const hit: SniffHit = { url: u, kind, size, type, tabId: d.webContentsId ?? -1, referer: rq.Referer ?? rq.referer ?? null };
      win?.webContents.send('sniff:hit', hit);
    } catch { /* never break browsing */ }
  });
}

/** Look for media in every frame of a tab (players are often inside a cross-origin iframe). */
async function scanFrames(wcId: number): Promise<FrameScan> {
  const wc = allWebContents.fromId(wcId);
  const out: FrameScan = { items: [], title: '' };
  if (!wc || wc.isDestroyed()) return out;
  for (const frame of wc.mainFrame.framesInSubtree) {
    try {
      const r = (await frame.executeJavaScript(`(${pageScanner.toString()})()`)) as ScanResult;
      if (frame === wc.mainFrame) out.title = r.title;
      for (const u of r.urls) out.items.push({ url: u, kind: kindOfUrl(u), referer: r.page });
    } catch { /* frame navigated away or is not scriptable */ }
  }
  return out;
}

async function hlsQualities(url: string, referer?: string): Promise<HlsQuality[]> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': session.fromPartition(BROWSER_PARTITION).getUserAgent(), ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const pl = parsePlaylist(await res.text(), res.url || url);
    return pl.type === 'master' ? pl.variants.map((v) => ({ label: v.label, height: v.height, bandwidth: v.bandwidth })) : [];
  } catch { return []; }
}

/* ---------- local API for the browser extension ---------- */
async function startApi(): Promise<void> {
  await stopApi();
  if (!settings.apiEnabled) return;
  const server = createApiServer({
    version: app.getVersion(),
    token: () => settings.apiToken,
    add: async (b: ApiAddBody) => {
      const list = (b as { cookieList?: CookieLike[] }).cookieList ?? [];
      let host = ''; try { host = new URL(b.url).hostname; } catch { /* validated by the server */ }
      const id = manager.add(b.url, {
        referer: b.referer, userAgent: b.userAgent, filename: b.filename, quality: b.quality || settings.quality, threads: settings.threads, startAt: b.startAt,
        cookies: b.cookies, cookiesFile: writeCookieFile(list, host),
      });
      sendCmd('toast', `Added from your browser: ${b.filename || b.url.slice(0, 60)}`);
      return id;
    },
  });
  try { apiPort = await listenOnFreePort(server, settings.apiPort); apiServer = server; } catch { apiServer = null; apiPort = 0; }
}
async function stopApi(): Promise<void> {
  const s = apiServer; apiServer = null; apiPort = 0;
  if (s) await new Promise<void>((r) => s.close(() => r()));
}

/* ---------- IPC ---------- */
const jobById = (id: string): JobView | undefined => manager.list().find((x) => x.id === id);

function applySettings(patch: Partial<Settings>): Settings {
  const before = settings;
  settings = { ...settings, ...patch };
  if (patch.downloadDir) fs.mkdirSync(settings.downloadDir, { recursive: true });
  manager.configure({
    maxConcurrent: settings.maxConcurrent, threads: settings.threads, onExists: settings.onExists, categoryFolders: settings.categoryFolders,
    speedLimit: settings.speedLimitKB * 1024, autoRetry: settings.autoRetry, resumeOnStart: settings.resumeOnStart,
    ...(patch.downloadDir ? { downloadDir: settings.downloadDir } : {}),
  });
  adblock.enabled = settings.adblock;
  adblock.allow = new Set(settings.adblockAllow);
  saveSettings(settingsFile(), settings);
  if (before.apiEnabled !== settings.apiEnabled || before.apiPort !== settings.apiPort) void startApi();
  updateBackgroundState();
  return settings;
}

function registerIpc(): void {
  const h = ipcMain.handle.bind(ipcMain);
  h('dl:list', () => manager.list());
  h('dl:add', (_e, url: string, opts?: AddRequest) => browserAdd(url, opts));
  h('dl:pause', (_e, id: string) => manager.pause(id));
  h('dl:resume', (_e, id: string) => manager.resume(id));
  h('dl:cancel', (_e, id: string) => manager.cancel(id));
  h('dl:pauseAll', () => manager.pauseAll());
  h('dl:resumeAll', () => manager.resumeAll());
  h('dl:remove', (_e, id: string, deleteFiles?: boolean) => manager.remove(id, { deleteFiles: !!deleteFiles }));
  h('dl:resolve', (_e, id: string, choice: 'replace' | 'rename') => manager.resolveConflict(id, choice));
  h('dl:priority', (_e, id: string, p: -1 | 0 | 1) => manager.setPriority(id, p));
  h('dl:schedule', (_e, id: string, at: number | null) => manager.schedule(id, at));
  h('dl:verify', (_e, id: string, checksum: string) => manager.verify(id, checksum));
  h('dl:reveal', (_e, id: string) => { const j = jobById(id); if (j?.output) shell.showItemInFolder(j.output); });
  h('dl:open', async (_e, id: string) => {
    const j = jobById(id);
    if (!j?.output) return;
    // #14: never run anything automatically, and ask before opening a file that can execute code.
    if (isExecutableName(j.output)) {
      const r = await dialog.showMessageBox(win!, {
        type: 'warning', buttons: ['Cancel', 'Open anyway'], defaultId: 0, cancelId: 0, title: 'Open this file?',
        message: `"${path.basename(j.output)}" is a program or script.`,
        detail: 'Opening it will run it on your computer. Only continue if you trust where it came from.',
      });
      if (r.response !== 1) return;
    }
    await shell.openPath(j.output);
  });
  h('clipboard:read', () => clipboard.readText());
  h('app:copy', (_e, text: string) => clipboard.writeText(String(text)));
  h('app:openExternal', (_e, url: string) => openExternalSafe(url));
  h('app:info', (): AppInfo => ({ name: APP_NAME, version: app.getVersion(), electron: process.versions.electron, platform: process.platform, developer: DEVELOPER }));
  h('engine:status', () => manager.engineStatus());
  h('engine:update', () => manager.updateEngine());
  h('settings:get', (): Settings => settings);
  h('settings:set', (_e, patch: Partial<Settings>) => applySettings(patch));
  h('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  h('browser:scan', (_e, id: number) => scanFrames(id));
  h('hls:qualities', (_e, url: string, referer?: string) => hlsQualities(url, referer));
  h('adblock:status', () => adblock.status());
  h('adblock:update', async () => { const s = await adblock.update(); win?.webContents.send('adblock:status', s); return s; });
  h('adblock:toggleSite', (_e, host: string) => {
    const bare = host.replace(/^www\./, '');
    const allow = new Set(settings.adblockAllow);
    const nowAllowed = !allow.delete(bare);
    if (nowAllowed) allow.add(bare);
    applySettings({ adblockAllow: [...allow] });
    return nowAllowed;
  });
  h('api:info', (): ApiInfo => ({ enabled: settings.apiEnabled, running: !!apiServer, port: apiPort, token: settings.apiToken, extensionDir: extensionDir() }));
  h('api:revealExtension', async () => { const d = extensionDir(); if (d) await shell.openPath(d); });
}

/** Only web pages and mail links may be opened outside the app. */
async function openExternalSafe(url: string): Promise<void> {
  if (/^(https:|mailto:)/i.test(url)) await shell.openExternal(url);
}

/* ---------- window, menu, in-page hooks ---------- */
function createWindow(): void {
  win = new BrowserWindow({
    width: 1120, height: 780, minWidth: 820, minHeight: 560, title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: true },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { void openExternalSafe(url); return { action: 'deny' }; });
  // #23: closing the window keeps downloads running in the tray / menu bar.
  win.on('close', (e) => {
    if (quitting || !settings.runInBackground || process.env.GRABBER_SELFTEST) return;
    e.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
    if (!settings.notifications || !Notification.isSupported()) return;
    if (!fs.existsSync(path.join(app.getPath('userData'), '.tray-hint'))) {
      fs.writeFileSync(path.join(app.getPath('userData'), '.tray-hint'), '1');
      new Notification({ title: `${APP_NAME} is still running`, body: 'Downloads continue in the background. Use the tray icon to open or quit.' }).show();
    }
  });
  win.on('closed', () => { win = null; });
}

async function addFromMenu(url: string, wc: WebContents): Promise<void> {
  try { await browserAdd(url, { referer: wc.getURL(), useBrowserSession: true }); sendCmd('toast', 'Added to Downloads'); } catch (e) { sendCmd('toast', (e as Error).message); }
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  // target=_blank / window.open become new tabs in the in-app browser.
  contents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) sendCmd('newtab', url); return { action: 'deny' }; });
  // Block custom-scheme hops (intent:, itms:, ...) that would open other apps.
  contents.on('will-navigate', (e, url) => { if (!/^(https?|file|about|data|blob):/i.test(url)) e.preventDefault(); });

  // Content-based video detection: install the hook in every frame (incl. cross-origin iframes) as it loads.
  const hook = `(${pageHook.toString()})()`;
  const inject = (frame: Electron.WebFrameMain | null | undefined): void => { frame?.executeJavaScript(hook).catch(() => {}); };
  contents.on('dom-ready', () => {
    inject(contents.mainFrame);
    const css = adblock.cosmeticCss(contents.getURL());
    if (css) void contents.insertCSS(css).catch(() => {});
  });
  contents.on('did-frame-finish-load', (_ev, isMain, pid, rid) => { if (!isMain) inject(webFrameMain.fromId(pid, rid)); });
  (contents as unknown as { on(ev: string, cb: (...a: unknown[]) => void): void }).on('console-message', (...args: unknown[]) => {
    const msg = typeof args[2] === 'string' ? args[2] : (args[0] as { message?: string } | undefined)?.message;
    if (!msg?.startsWith('__GRABBER__')) return;
    try {
      const o = JSON.parse(msg.slice(11)) as { url: string; kind: MediaKind; page: string };
      const hit: SniffHit = { url: o.url, kind: o.kind, size: null, type: '', tabId: contents.id, referer: o.page };
      win?.webContents.send('sniff:hit', hit);
    } catch { /* ignore */ }
  });

  contents.on('context-menu', (_ev, p) => {
    const m = new Menu();
    const add = (label: string, click: () => void, enabled = true): void => { m.append(new MenuItem({ label, click, enabled })); };
    const sep = (): void => { m.append(new MenuItem({ type: 'separator' })); };
    if (p.linkURL) {
      add('Open link in new tab', () => sendCmd('newtab', p.linkURL));
      add('Download link', () => void addFromMenu(p.linkURL, contents));
      add('Copy link address', () => clipboard.writeText(p.linkURL));
      sep();
    }
    if (p.srcURL && (p.mediaType === 'video' || p.mediaType === 'audio')) {
      add('Download this video', () => void addFromMenu(p.srcURL, contents), !p.srcURL.startsWith('blob:'));
      add('Copy video address', () => clipboard.writeText(p.srcURL));
      sep();
    } else if (p.srcURL && p.mediaType === 'image') {
      add('Copy image address', () => clipboard.writeText(p.srcURL));
      sep();
    }
    if (p.selectionText) add('Copy', () => contents.copy());
    if (p.isEditable) { add('Cut', () => contents.cut()); add('Paste', () => contents.paste()); }
    add('Back', () => contents.goBack(), contents.canGoBack());
    add('Forward', () => contents.goForward(), contents.canGoForward());
    add('Reload', () => contents.reload());
    sep();
    add('Inspect', () => contents.inspectElement(p.x, p.y));
    m.popup();
  });
});

function showAbout(): void {
  void dialog.showMessageBox(win!, {
    type: 'info', title: `About ${APP_NAME}`, message: `${APP_NAME} ${app.getVersion()}`,
    detail: `Download videos, streams and files.\n\nDeveloped by ${DEVELOPER.name}\n${DEVELOPER.email}`,
    buttons: ['Email developer', 'Close'], defaultId: 1,
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
  }).then((r) => { if (r.response === 0) void openExternalSafe(`mailto:${DEVELOPER.email}`); });
}

function buildMenu(): void {
  const mac = process.platform === 'darwin';
  const contact = { label: `Contact Developer (${DEVELOPER.name})`, click: () => void openExternalSafe(`mailto:${DEVELOPER.email}?subject=${encodeURIComponent(`${APP_NAME} feedback`)}`) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [mac ? { role: 'close' as const } : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'Browser', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendCmd('newtab') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCmd('closetab') },
      { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => sendCmd('focusurl') },
      { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => sendCmd('reload') },
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => sendCmd('back') },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => sendCmd('forward') },
    ] },
    { role: 'editMenu' as const },
    { label: 'View', submenu: [{ role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, { role: 'togglefullscreen' as const }, ...(isDev ? [{ role: 'toggleDevTools' as const }] : [])] },
    { role: 'windowMenu' as const },
    { role: 'help' as const, submenu: [contact, ...(mac ? [] : [{ label: `About ${APP_NAME}`, click: showAbout }])] },
  ]));
}

app.setAboutPanelOptions({
  applicationName: APP_NAME, applicationVersion: app.getVersion(), version: '',
  copyright: `© ${new Date().getFullYear()} ${DEVELOPER.name}`,
  credits: `Developed by ${DEVELOPER.name}\n${DEVELOPER.email}`,
  ...(fs.existsSync(iconPath) ? { iconPath } : {}),
});

// One running copy: a second launch just brings the first to the front.
if (!process.env.GRABBER_SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin' && fs.existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    await startManager();
    adblock = new AdBlocker(path.join(app.getPath('userData'), 'adblock'), settings.adblock, settings.adblockAllow);
    // GRABBER_ADBLOCK_RULES: use a fixed rule file instead of downloading the public lists (tests / custom lists).
    if (process.env.GRABBER_ADBLOCK_RULES) adblock.useRules(fs.readFileSync(process.env.GRABBER_ADBLOCK_RULES, 'utf8'));
    else void adblock.init();
    purgeOldCookieFiles();
    registerIpc();
    setupBrowserSession();
    buildMenu();
    createWindow();
    createTray();
    await startApi();
    updateBackgroundState();
    if (process.env.GRABBER_SELFTEST) {
      // Test-only code is built into its own file and is never loaded in normal use.
      const { runSelfTest } = require('./selftest.cjs') as typeof import('./selftest.ts');
      void runSelfTest(() => win!, () => manager, app, () => ({ apiPort, token: settings.apiToken }));
    }
    app.on('activate', () => { if (process.platform === 'darwin') app.dock?.show(); showWindow(); });
  });
}

app.on('before-quit', (e) => {
  quitting = true;
  if (!manager || (manager as unknown as { _down?: boolean })._down) return;
  e.preventDefault();
  (manager as unknown as { _down?: boolean })._down = true;
  void Promise.all([manager.shutdown(), stopApi()]).then(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !settings?.runInBackground) app.quit(); });
