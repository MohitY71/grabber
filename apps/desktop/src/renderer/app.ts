import { $, isUrl, toast } from './dom.ts';
import { icon } from './icons.ts';
import { addLink, initDownloads } from './downloads.ts';
import { initBrowser } from './browser.ts';
import { initSettings } from './settings.ts';

const g = window.grabber;
if (g.platform === 'darwin') document.body.classList.add('mac');

/* ---------- static icons / labels ---------- */
$('#nav-dl').innerHTML = `${icon('download', 17)}Downloads <span id="badge-dl" class="badge hidden"></span>`;
$('#nav-br').innerHTML = `${icon('globe', 17)}Browser <span id="badge-media" class="badge hidden"></span>`;
$('#nav-st').innerHTML = `${icon('sliders', 17)}Settings`;
$('#add-lead').innerHTML = icon('link', 20);
$('#btn-paste').innerHTML = `${icon('clipboard', 16)}Paste`;
$('#btn-add').innerHTML = `${icon('download', 16)}Download`;
$('#clip-ico').innerHTML = icon('clipboard', 18);
$('#clip-x').innerHTML = icon('x', 15);
$('#btn-pause-all').innerHTML = `${icon('pause', 14)}Pause all`;
$('#btn-resume-all').innerHTML = `${icon('play', 14)}Resume all`;
$('#btn-clear-done').innerHTML = `${icon('trash', 14)}Clear completed`;
$('#empty-art').innerHTML = icon('download', 40);
$('#start-art').innerHTML = icon('film', 40);
$('#empty-browser').innerHTML = `${icon('globe', 16)}Open browser`;
$('#empty-paste').innerHTML = `${icon('clipboard', 16)}Paste a link`;

/* ---------- tabs ---------- */
export function showTab(name: string): void {
  document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'downloads') $<HTMLInputElement>('#add-url').focus();
}
document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab!); });
$('#empty-browser').onclick = () => showTab('browser');

/* ---------- drag a link onto the window ---------- */
let dragDepth = 0;
const dropText = (e: DragEvent): string => (e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '').split('\n')[0]!.trim();
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.add('hidden');
  const t = dropText(e);
  if (isUrl(t)) void addLink(t).then((ok) => { if (ok) { showTab('downloads'); toast('Added to Downloads'); } });
  else toast('Drop a link (http/https) to download it');
});

/* ---------- paste anywhere on the Downloads page ---------- */
document.addEventListener('paste', (e) => {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
  if (!$('#tab-downloads').classList.contains('active')) return;
  const t = (e.clipboardData?.getData('text') ?? '').trim();
  if (isUrl(t)) { e.preventDefault(); void addLink(t); }
});

void (async () => {
  await initDownloads();
  await initSettings();
  initBrowser(showTab);
  $<HTMLInputElement>('#add-url').focus();
})();
