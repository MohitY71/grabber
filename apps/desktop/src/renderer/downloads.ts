import type { JobView } from '@grabber/core';
import { $, esc, fmtBytes, fmtEta, isUrl, store, toast } from './dom.ts';
import { icon } from './icons.ts';
import type { AddRequest } from '../shared/api.ts';

const g = window.grabber;
const jobs = new Map<string, JobView>();
const rows = new Map<string, HTMLLIElement>();
type Filter = 'all' | 'active' | 'done' | 'failed';
const filterStore = store<Filter>('grabber.filter', 'all');
let filter: Filter = filterStore.get();

const ACTIVE = new Set(['downloading', 'probing', 'queued', 'merging']);
const STATUS_LABEL: Record<string, string> = {
  downloading: 'Downloading', probing: 'Preparing', queued: 'Waiting', merging: 'Converting', paused: 'Paused', done: 'Completed', error: 'Failed',
};
const matches = (j: JobView, f: Filter): boolean =>
  f === 'all' || (f === 'active' && (ACTIVE.has(j.status) || j.status === 'paused')) || (f === 'done' && j.status === 'done') || (f === 'failed' && j.status === 'error');

function tileIcon(j: JobView): string {
  if (j.kind === 'hls') return icon('stream', 22);
  if (j.kind === 'extract') return icon('film', 22);
  if (/\.(mp3|m4a|aac|flac|wav|ogg)$/i.test(j.name)) return icon('music', 22);
  if (/\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(j.name)) return icon('film', 22);
  return icon('file', 22);
}

function button(ic: Parameters<typeof icon>[0], title: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn ghost ${cls}`.trim();
  b.title = title; b.setAttribute('aria-label', title);
  b.innerHTML = icon(ic, 17);
  b.onclick = fn;
  return b;
}

function metaText(j: JobView): string {
  const pct = `${Math.round((j.progress || 0) * 100)}%`;
  const eta = j.size && j.speed ? fmtEta((j.size - j.downloaded) / j.speed) : '';
  switch (j.status) {
    case 'downloading': {
      const bytes = j.kind === 'http' && j.size ? `${fmtBytes(j.downloaded)} of ${fmtBytes(j.size)}` : j.size ? `${fmtBytes(j.size)}` : '';
      return [pct, bytes, j.speed ? `${fmtBytes(j.speed)}/s` : '', eta && `${eta} left`, j.note].filter(Boolean).join(' · ');
    }
    case 'done': return [j.note?.startsWith('Added') ? j.note : 'Saved', j.size ? fmtBytes(j.size) : ''].filter(Boolean).join(' · ');
    case 'paused': return `Paused at ${pct}`;
    case 'merging': return j.note || 'Converting…';
    case 'probing': return j.note || 'Checking link…';
    case 'queued': return 'Waiting for a free slot';
    default: return '';
  }
}

function render(j: JobView): void {
  let li = rows.get(j.id);
  if (!li) {
    li = document.createElement('li');
    li.innerHTML = '<div class="tile"></div><div class="top"><span class="name ellipsis"></span><span class="chip-s"></span></div><div class="actions"></div><div class="bar"><i></i></div><div class="meta ellipsis"></div>';
    rows.set(j.id, li);
    $('#list').prepend(li);
  }
  li.className = `item ${j.status}`;
  li.hidden = !matches(j, filter);
  li.querySelector('.tile')!.innerHTML = tileIcon(j);
  const name = li.querySelector<HTMLElement>('.name')!;
  name.textContent = j.name; name.title = j.url;
  li.querySelector('.chip-s')!.textContent = STATUS_LABEL[j.status] ?? j.status;
  li.querySelector<HTMLElement>('.bar > i')!.style.width = `${Math.round((j.progress || 0) * 100)}%`;
  const meta = li.querySelector<HTMLElement>('.meta')!;
  if (j.status === 'error') meta.innerHTML = `<span class="err">${esc(j.error || 'Failed')}</span>`;
  else meta.textContent = metaText(j);
  meta.classList.toggle('ellipsis', j.status !== 'error');
  const a = li.querySelector<HTMLElement>('.actions')!;
  a.replaceChildren();
  if (['downloading', 'probing', 'queued'].includes(j.status)) a.append(button('pause', 'Pause', () => void g.pause(j.id)));
  if (j.status === 'paused') a.append(button('play', 'Resume', () => void g.resume(j.id)));
  if (j.status === 'error') a.append(button('retry', 'Try again', () => void g.resume(j.id)));
  if (j.status === 'done' && j.output) a.append(button('open', 'Open file', () => void g.open(j.id)), button('folder', 'Show in folder', () => void g.reveal(j.id)));
  a.append(button('x', ['done', 'error'].includes(j.status) ? 'Remove from list' : 'Cancel and remove', () => void g.remove(j.id, false), 'danger'));
  summarize();
}

function renderChips(): void {
  const all = [...jobs.values()];
  const count = (f: Filter): number => all.filter((j) => matches(j, f)).length;
  const defs: Array<[Filter, string]> = [['all', 'All'], ['active', 'In progress'], ['done', 'Completed'], ['failed', 'Failed']];
  $('#chips').replaceChildren(...defs.map(([f, label]) => {
    const c = document.createElement('button');
    c.className = `chip${filter === f ? ' on' : ''}`;
    c.innerHTML = `${label}<b>${count(f)}</b>`;
    c.onclick = () => { filter = f; filterStore.set(f); for (const j of jobs.values()) render(j); };
    return c;
  }));
}

function summarize(): void {
  const all = [...jobs.values()];
  const active = all.filter((j) => j.status === 'downloading' || j.status === 'merging' || j.status === 'probing');
  const speed = active.reduce((a, j) => a + j.speed, 0);
  const nActive = all.filter((j) => ACTIVE.has(j.status)).length;
  const badge = $('#badge-dl');
  badge.textContent = String(nActive); badge.classList.toggle('hidden', !nActive);
  const pill = $('#total-speed');
  pill.textContent = `↓ ${fmtBytes(speed)}/s`; pill.classList.toggle('hidden', !speed);
  $('#st-left').textContent = nActive ? `${nActive} active · ${all.filter((j) => j.status === 'done').length} completed` : all.length ? `${all.filter((j) => j.status === 'done').length} completed` : 'Ready';
  const visible = all.filter((j) => matches(j, filter)).length;
  $('#empty').classList.toggle('hidden', all.length > 0);
  $('#list').classList.toggle('hidden', visible === 0);
  $('#btn-clear-done').classList.toggle('hidden', !all.some((j) => j.status === 'done'));
  renderChips();
}

export async function addLink(url: string, opts: AddRequest = {}): Promise<boolean> {
  url = url.trim();
  if (!isUrl(url)) { toast('That does not look like an http(s) link'); return false; }
  try {
    await g.add(url, { quality: $<HTMLSelectElement>('#add-quality').value, ...opts });
    return true;
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    return false;
  }
}

export async function initDownloads(): Promise<void> {
  g.onUpdate((j) => { jobs.set(j.id, j); render(j); });
  g.onRemoved((id) => { jobs.delete(id); rows.get(id)?.remove(); rows.delete(id); summarize(); });
  const initial = await g.list();
  initial.sort((a, b) => a.createdAt - b.createdAt).forEach((j) => { jobs.set(j.id, j); render(j); });
  summarize();

  const input = $<HTMLInputElement>('#add-url');
  $<HTMLFormElement>('#add-form').onsubmit = async (e) => { e.preventDefault(); if (await addLink(input.value)) { input.value = ''; hideClip(); } };
  // Pasting a link starts the download immediately.
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData?.getData('text') ?? '').trim();
    if (isUrl(text)) { e.preventDefault(); void addLink(text).then(hideClip); }
  });
  $('#btn-paste').onclick = async () => {
    const t = (await g.readClipboard()).trim();
    if (isUrl(t)) { if (await addLink(t)) hideClip(); } else toast('No link found in the clipboard');
  };
  $('#btn-pause-all').onclick = () => void g.pauseAll();
  $('#btn-resume-all').onclick = () => void g.resumeAll();
  $('#btn-clear-done').onclick = () => { for (const j of jobs.values()) if (j.status === 'done') void g.remove(j.id, false); };
  $('#empty-paste').onclick = () => $('#btn-paste').click();

  // Offer a link that is sitting in the clipboard.
  let clipUrl = '';
  let dismissed = '';
  const hideClip = (): void => { $('#clip-banner').classList.add('hidden'); dismissed = clipUrl; };
  const checkClip = async (): Promise<void> => {
    const t = (await g.readClipboard()).trim();
    if (!isUrl(t) || t === dismissed || [...jobs.values()].some((j) => j.url === t)) { $('#clip-banner').classList.add('hidden'); return; }
    clipUrl = t;
    $('#clip-text').textContent = t;
    $('#clip-banner').classList.remove('hidden');
  };
  $('#clip-go').onclick = async () => { if (await addLink(clipUrl)) hideClip(); };
  $('#clip-x').onclick = hideClip;
  window.addEventListener('focus', () => { if ($('#tab-downloads').classList.contains('active')) void checkClip(); });
  void checkClip();

  // Quality: remember the choice as the default.
  const q = $<HTMLSelectElement>('#add-quality');
  const s = await g.getSettings();
  q.value = [...q.options].some((o) => o.value === s.quality) ? s.quality : 'best';
  q.onchange = () => { void g.setSettings({ quality: q.value }); };
  g.onCmd((cmd, arg) => { if (cmd === 'toast' && arg) toast(arg); });
}
