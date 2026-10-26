import type { WebviewTag } from 'electron';
import { $, esc, fmtBytes, toast } from './dom.ts';
import { icon } from './icons.ts';
import { addLink } from './downloads.ts';
import type { SniffHit } from '../shared/api.ts';

const g = window.grabber;

interface Found { url: string; kind: 'hls' | 'video'; size: number | null; referer: string | null; title: string }
interface Tab {
  id: number; el: WebviewTag; title: string; url: string; favicon: string | null;
  loading: boolean; canBack: boolean; canFwd: boolean; ready: boolean; wcId: number | null;
  found: Map<string, Found>; err: string | null;
}

const tabs: Tab[] = [];
let active: Tab | null = null;
let nextId = 1;
let panelOpen = false;
let showTab: (name: string) => void = () => {};

const HOME_LINKS: Array<[string, string]> = [['YouTube', 'https://www.youtube.com'], ['Vimeo', 'https://vimeo.com'], ['Dailymotion', 'https://www.dailymotion.com'], ['Internet Archive', 'https://archive.org/details/movies']];

export function normalizeAddress(v: string): string | null {
  v = v.trim();
  if (!v) return null;
  if (/^(https?|file):\/\//i.test(v)) return v;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(v)) return `http://${v}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v)) return `https://${v}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
}

const isBlank = (t: Tab): boolean => !t.url || t.url === 'about:blank';
const isWeb = (u: string): boolean => /^https?:\/\//i.test(u);

/* ---------- tabs ---------- */
function newTab(url?: string): Tab {
  const t: Tab = { id: nextId++, el: document.createElement('webview') as WebviewTag, title: 'New tab', url: '', favicon: null, loading: false, canBack: false, canFwd: false, ready: false, wcId: null, found: new Map(), err: null };
  t.el.setAttribute('partition', 'persist:browser');
  t.el.setAttribute('allowpopups', '');
  t.el.classList.add('hidden');
  wire(t);
  const target = url ? normalizeAddress(url) : null;
  t.el.setAttribute('src', target ?? 'about:blank');
  if (target) t.url = target;
  $('#wv-stack').append(t.el);
  tabs.push(t);
  activate(t);
  if (!target) $('#nav-url').focus();
  return t;
}

function activate(t: Tab): void {
  active = t;
  tabs.forEach((x) => x.el.classList.toggle('hidden', x !== t));
  chrome();
  renderFound();
}

function closeTab(t: Tab): void {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  t.el.remove();
  tabs.splice(i, 1);
  if (!tabs.length) { newTab(); return; }
  if (active === t) activate(tabs[Math.min(i, tabs.length - 1)]!);
  else chrome();
}

function navigate(t: Tab, input: string): void {
  const u = normalizeAddress(input);
  if (!u) return;
  t.err = null;
  t.url = u;
  if (t.ready) void t.el.loadURL(u).catch(() => { /* reported through did-fail-load */ });
  else t.el.setAttribute('src', u);
  chrome();
}

/* ---------- chrome: tab strip + nav bar ---------- */
function chrome(): void {
  $('#btab-list').replaceChildren(...tabs.map((t) => {
    const d = document.createElement('div');
    d.className = `btab${t === active ? ' active' : ''}`;
    d.title = t.title;
    const ic = document.createElement('img');
    if (t.favicon) ic.src = t.favicon; else ic.style.visibility = 'hidden';
    ic.onerror = () => { ic.style.visibility = 'hidden'; };
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = t.loading && t.title === 'New tab' ? 'Loading…' : t.title;
    const x = document.createElement('button');
    x.className = 'x'; x.innerHTML = icon('x', 13); x.title = 'Close tab'; x.setAttribute('aria-label', 'Close tab');
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    d.onclick = () => activate(t);
    d.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    d.append(ic, ttl, x);
    return d;
  }));
  if (!active) return;
  const url = $<HTMLInputElement>('#nav-url');
  if (document.activeElement !== url) url.value = isBlank(active) ? '' : active.url;
  $<HTMLButtonElement>('#nav-back').disabled = !active.canBack;
  $<HTMLButtonElement>('#nav-fwd').disabled = !active.canFwd;
  $('#nav-reload').innerHTML = icon(active.loading ? 'x' : 'reload', 17);
  $('#nav-reload').title = active.loading ? 'Stop' : 'Reload';
  const lb = $('#loadbar');
  lb.classList.toggle('on', active.loading);
  if (!active.loading) lb.querySelector<HTMLElement>('i')!.style.width = '0';
  $('#start-page').classList.toggle('hidden', !isBlank(active) || !!active.err);
  $('#err-page').classList.toggle('hidden', !active.err);
  if (active.err) $('#err-text').textContent = active.err;
  renderFoundBadge();
}

function wire(t: Tab): void {
  const wv = t.el;
  const sync = (): void => { if (!t.ready) return; try { t.canBack = wv.canGoBack(); t.canFwd = wv.canGoForward(); } catch { /* not attached yet */ } };
  const touch = (): void => { if (t === active) chrome(); };
  wv.addEventListener('did-attach', () => { try { t.wcId = wv.getWebContentsId(); } catch { /* ignore */ } });
  wv.addEventListener('dom-ready', () => { t.ready = true; try { t.wcId = wv.getWebContentsId(); } catch { /* ignore */ } sync(); touch(); });
  wv.addEventListener('did-start-loading', () => { t.loading = true; touch(); });
  wv.addEventListener('did-stop-loading', () => { t.loading = false; sync(); touch(); setTimeout(() => void scanTab(t), 700); });
  wv.addEventListener('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isInPlace) { t.found.clear(); t.err = null; if (t === active) renderFound(); }
  });
  const onNav = (e: { url: string; isMainFrame?: boolean }): void => { if (e.isMainFrame === false) return; t.url = e.url; sync(); touch(); };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', onNav);
  wv.addEventListener('page-title-updated', (e) => { t.title = e.title || t.url || 'New tab'; touch(); });
  wv.addEventListener('page-favicon-updated', (e) => { t.favicon = e.favicons[0] ?? null; touch(); });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = superseded by a newer navigation
    t.loading = false;
    t.url = e.validatedURL || t.url;
    t.err = `${e.errorDescription || 'Load failed'} (${e.errorCode}) — ${e.validatedURL || ''}`;
    touch();
  });
  wv.addEventListener('render-process-gone', () => { t.err = 'The page crashed.'; t.loading = false; touch(); });
}

/* ---------- detected media ---------- */
function addFound(t: Tab, item: Omit<Found, 'title'>): void {
  const cur = t.found.get(item.url);
  if (cur) { cur.size ??= item.size; return; }
  t.found.set(item.url, { title: t.title, ...item });
  if (t === active) renderFound();
}

// Runs inside the guest page, so it must be self-contained.
function pageScanner(): { page: string; title: string; urls: string[] } {
  const out = new Set<string>();
  const abs = (u: string): string | null => { try { return new URL(u, location.href).href; } catch { return null; } };
  document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video, video source, audio source, source').forEach((el) => {
    const s = (el as HTMLMediaElement).currentSrc || (el as HTMLSourceElement).src || el.getAttribute('src');
    if (s && !s.startsWith('blob:')) { const a = abs(s); if (a) out.add(a); }
  });
  const html = document.documentElement.outerHTML.split('\\/').join('/').split('\\u002F').join('/');
  const re = /https?:\/\/[^"'\s<>\\)]+?\.(?:m3u8|mp4|webm|mkv|mov)(?:\?[^"'\s<>\\)]*)?/gi;
  for (const m of html.matchAll(re)) out.add(m[0]);
  return { page: location.href, title: document.title, urls: [...out].slice(0, 60) };
}

async function scanTab(t: Tab): Promise<void> {
  if (!t.ready || t.err || isBlank(t)) return;
  let res: ReturnType<typeof pageScanner> | undefined;
  try { res = (await t.el.executeJavaScript(`(${pageScanner.toString()})()`)) as typeof res; } catch { return; }
  if (!res?.page || res.page === 'about:blank') return;
  for (const u of res.urls) addFound(t, { url: u, kind: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'video', size: null, referer: res.page });
  for (const it of t.found.values()) if (!it.title || it.title === 'New tab') it.title = res.title;
  if (t === active) renderFound();
}

function renderFoundBadge(): void {
  const n = active?.found.size ?? 0;
  $('#media-toggle').innerHTML = `${icon('film', 16)}Videos <span class="badge" style="background:rgba(255,255,255,.25)">${n}</span>`;
  const b = $('#badge-media');
  b.textContent = String(n); b.classList.toggle('hidden', !n);
}

function renderFound(): void {
  renderFoundBadge();
  const items = active ? [...active.found.values()].reverse() : [];
  $('#media-empty').classList.toggle('hidden', items.length > 0);

  // The page itself, handed to the video engine: this is what makes YouTube-style players work.
  const slot = $('#page-extract');
  if (active && isWeb(active.url)) {
    const t = active;
    slot.innerHTML = `<div class="mcard feature"><div class="h"><span class="title">${icon('zap', 15)} Download the video on this page</span></div>
      <div class="t">Works for YouTube, Vimeo and many other sites, including players that stream in pieces.</div>
      <div class="h" style="margin:8px 0 0"><span class="t">${esc(t.title)}</span><button class="btn primary sm" data-act="page">Download</button></div></div>`;
    slot.querySelector<HTMLButtonElement>('[data-act=page]')!.onclick = async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      if (await addLink(t.url, { referer: t.url, useBrowserSession: true })) { btn.textContent = 'Added ✓'; btn.disabled = true; toast('Added to Downloads — preparing video'); }
    };
  } else slot.replaceChildren();

  $('#media-list').replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    li.className = 'mcard';
    const label = it.kind === 'hls' ? 'Stream' : (it.url.match(/\.(mp4|webm|mkv|mov)(?=\?|$)/i)?.[1] ?? 'video').toUpperCase();
    li.innerHTML = `<div class="h"><span><span class="tag">${esc(label)}</span><span class="muted small">${it.size ? fmtBytes(it.size) : ''}</span></span><button class="btn primary sm">Download</button></div>
      <div class="t" title="${esc(it.url)}">${esc(it.url)}</div>`;
    li.querySelector('button')!.onclick = async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      if (await addLink(it.url, { referer: it.referer ?? active?.url, useBrowserSession: true })) { btn.textContent = 'Added ✓'; btn.disabled = true; toast('Added to Downloads'); }
    };
    return li;
  }));
  if ((items.length || (active && isWeb(active.url))) && !panelOpen) setPanel(true);
}

function setPanel(open: boolean): void { panelOpen = open; $('#media-panel').classList.toggle('hidden', !open); }

/* ---------- init ---------- */
export function initBrowser(show: (name: string) => void): void {
  showTab = show;
  $('#btab-new').innerHTML = icon('plus', 16);
  $('#nav-back').innerHTML = icon('back', 18);
  $('#nav-fwd').innerHTML = icon('forward', 18);

  $<HTMLFormElement>('#nav-form').onsubmit = (e) => { e.preventDefault(); if (!active) return; navigate(active, $<HTMLInputElement>('#nav-url').value); $('#nav-url').blur(); };
  $('#nav-url').addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  $('#nav-url').addEventListener('blur', chrome);
  $('#nav-back').onclick = () => { if (active?.canBack) active.el.goBack(); };
  $('#nav-fwd').onclick = () => { if (active?.canFwd) active.el.goForward(); };
  $('#nav-reload').onclick = () => {
    if (!active?.ready) return;
    if (active.loading) active.el.stop();
    else if (active.err && active.url) navigate(active, active.url);
    else active.el.reload();
  };
  $('#err-retry').onclick = () => { if (active) navigate(active, active.url); };
  $('#btab-new').onclick = () => { newTab(); };
  $('#media-toggle').onclick = () => setPanel(!panelOpen);
  $('#media-rescan').onclick = () => { if (active) void scanTab(active); };
  $('#quick').replaceChildren(...HOME_LINKS.map(([n, u]) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = n;
    b.onclick = () => { if (active) navigate(active, u); };
    return b;
  }));

  // Commands from the application menu / shortcuts / context menu (main process).
  g.onCmd((cmd, arg) => {
    const browserActive = $('#tab-browser').classList.contains('active');
    const open = (): void => showTab('browser');
    if (cmd === 'newtab') { open(); newTab(arg); }
    else if (cmd === 'closetab') { if (browserActive && active) closeTab(active); }
    else if (cmd === 'focusurl') { open(); $('#nav-url').focus(); }
    else if (cmd === 'reload') { if (browserActive) $('#nav-reload').click(); }
    else if (cmd === 'back') { if (browserActive) $('#nav-back').click(); }
    else if (cmd === 'forward') { if (browserActive) $('#nav-fwd').click(); }
  });

  g.onSniff((hit: SniffHit) => {
    // Requests can arrive before a tab learns its web-contents id; fall back to the active tab then.
    const t = tabs.find((x) => x.wcId === hit.tabId) ?? (active && active.wcId === null ? active : null);
    if (t) addFound(t, { url: hit.url, kind: hit.kind, size: hit.size, referer: hit.referer ?? t.url });
  });

  newTab();
}
