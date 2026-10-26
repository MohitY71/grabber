import { $, toast } from './dom.ts';
import { icon } from './icons.ts';

const g = window.grabber;

export async function initSettings(): Promise<void> {
  const s = await g.getSettings();
  const info = await g.appInfo();

  const dir = $<HTMLInputElement>('#set-dir');
  dir.value = s.downloadDir;
  $('#set-dir-pick').onclick = async () => {
    const d = await g.pickDir();
    if (d) dir.value = (await g.setSettings({ downloadDir: d })).downloadDir;
  };

  const bindRange = (id: string, out: string, key: 'threads' | 'maxConcurrent'): void => {
    const el = $<HTMLInputElement>(id);
    el.value = String(s[key]); $(out).textContent = el.value;
    el.oninput = () => { $(out).textContent = el.value; };
    el.onchange = () => void g.setSettings({ [key]: Number(el.value) });
  };
  bindRange('#set-threads', '#out-threads', 'threads');
  bindRange('#set-conc', '#out-conc', 'maxConcurrent');

  const q = $<HTMLSelectElement>('#set-quality');
  q.value = s.quality;
  q.onchange = () => { void g.setSettings({ quality: q.value }); const add = $<HTMLSelectElement>('#add-quality'); if ([...add.options].some((o) => o.value === q.value)) add.value = q.value; };

  // Video-site engine
  const status = $('#engine-status');
  const btn = $<HTMLButtonElement>('#engine-update');
  const refresh = async (): Promise<void> => {
    const e = await g.engineStatus();
    status.textContent = e.installed ? `Installed · version ${e.version ?? 'unknown'}` : 'Not installed yet — downloaded automatically the first time you grab a video-site link';
    btn.innerHTML = `${icon('reload', 16)}${e.installed ? 'Check for update' : 'Install now'}`;
  };
  btn.onclick = async () => {
    btn.disabled = true; status.textContent = 'Working…';
    try { const v = await g.updateEngine(); toast(`Video engine is ready (${v})`); } catch (e) { toast(`Could not update: ${(e as Error).message}`); }
    btn.disabled = false; await refresh();
  };
  await refresh();

  // About
  $('#about-name').textContent = info.name;
  $('#about-ver').textContent = `Version ${info.version} · Electron ${info.electron}`;
  $('#dev-mail').innerHTML = `${icon('mail', 16)}Email developer`;
  $('#dev-email').textContent = info.developer.email;
  document.querySelector('.dev-name')!.textContent = info.developer.name;
  $('#dev-mail').onclick = () => void g.openExternal(`mailto:${info.developer.email}?subject=${encodeURIComponent(`${info.name} feedback`)}`);
  $('#dev-copy').innerHTML = icon('copy', 16);
  $('#dev-copy').onclick = () => void g.copyText(info.developer.email).then(() => toast('Email address copied'));
}
