// Drives the real UI against a local site. Run: npm run selftest -w @grabber/desktop
// (set GRABBER_SELFTEST_FIXTURES to a folder made by the core test helpers, GRABBER_SHOTS for screenshots)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { App, BrowserWindow } from 'electron';
import type { DownloadManager } from '@grabber/core';
import { writeStubYtdlp } from '../../../../packages/core/test/helpers.ts';

export async function runSelfTest(getWin: () => BrowserWindow, getManager: () => DownloadManager, app: App): Promise<void> {
  const fx = process.env.GRABBER_SELFTEST_FIXTURES!;
  const shotDir = process.env.GRABBER_SHOTS || fx;
  const log = (...a: unknown[]): void => console.log('[selftest]', ...a);
  let ok = true;
  const check = (c: boolean, m: string): void => { log(c ? 'PASS' : 'FAIL', m); if (!c) ok = false; };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (body: string): void => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
    if (u.pathname === '/page2') return html('<html><head><title>Page Two</title></head><body><h1>Two</h1><a id="home" href="/">home</a></body></html>');
    if (u.pathname === '/attach') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"' }); return void res.end(Buffer.alloc(700000, 7)); }
    if (u.pathname === '/') {
      return html(`<html><head><title>Demo page</title></head><body style="font-family:sans-serif"><h1>Demo</h1>
        <a id="l2" href="/page2">go two</a> <a id="blank" target="_blank" href="/page2?new">new tab</a> <a id="att" href="/attach">attach</a><br>
        <video controls src="/src.mp4" width="320"></video><script>fetch('/plain/index.m3u8').then(r=>r.text())</script></body></html>`);
    }
    const file = path.join(fx, decodeURIComponent(u.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return void res.end(); }
    const size = fs.statSync(file).size;
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t';
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const s = +m[1]!; const e = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start: s, end: e }).pipe(res);
    } else { res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' }); fs.createReadStream(file).pipe(res); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // A stand-in for the video engine so the "this page" path is exercised without touching the network.
  const toolsDir = path.join(app.getPath('userData'), 'tools');
  writeStubYtdlp(path.join(toolsDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), path.join(fx, 'src.mp4'), base);

  const win = getWin();
  const ex = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const shot = async (n: string): Promise<void> => { fs.writeFileSync(path.join(shotDir, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  const tabInfo = (): Promise<{ tabs: string[]; url: string; back: boolean; fwd: boolean }> => ex(`({tabs:[...document.querySelectorAll('.btab .ttl')].map(e=>e.textContent), url:document.querySelector('#nav-url').value, back:!document.querySelector('#nav-back').disabled, fwd:!document.querySelector('#nav-fwd').disabled})`);
  const wvx = (code: string): Promise<unknown> => ex(`document.querySelector('webview:not(.hidden)').executeJavaScript(${JSON.stringify(code)}, true)`);
  const submitUrl = (u: string): Promise<unknown> => ex(`(()=>{const i=document.querySelector('#nav-url'); i.focus(); i.value=${JSON.stringify(u)}; document.querySelector('#nav-form').requestSubmit();})()`);

  try {
    await sleep(1500);
    // ---- shell / branding ----
    check(await ex<boolean>(`document.querySelector('.brand img').naturalWidth > 0`), 'app icon loads in the header');
    check(await ex<number>(`document.querySelectorAll('#tabs button svg').length`) === 3, 'tab icons render');
    await shotTab('downloads-empty');
    await ex(`document.querySelector('[data-tab=settings]').click()`); await sleep(400);
    check(await ex<string>(`document.querySelector('.dev-name').textContent`) === 'Mohit Yadav', 'About shows developer name');
    check(await ex<string>(`document.querySelector('#dev-email').textContent`) === 'mohit@heygeeks.in', 'About shows developer email');
    check(/Version/.test(await ex<string>(`document.querySelector('#about-ver').textContent`)), 'About shows version');
    check(/Installed/.test(await ex<string>(`document.querySelector('#engine-status').textContent`)), 'video engine status is shown');
    await shot('settings');
    await ex(`document.querySelector('[data-tab=downloads]').click()`);

    // ---- paste-a-link flow ----
    await ex(`document.querySelector('#add-url').value='${base}/big.bin'; document.querySelector('#add-form').requestSubmit();`);

    // ---- browser: detection ----
    await ex(`document.querySelector('[data-tab=browser]').click()`);
    await submitUrl(`${base}/`); await sleep(4000);
    const n = await ex<number>(`document.querySelectorAll('#media-list li').length`);
    check(n >= 2, `browser detected ${n} media items`);
    const tags = await ex<string[]>(`[...document.querySelectorAll('#media-list .tag')].map(e=>e.textContent)`);
    check(tags.includes('Stream') && tags.includes('MP4'), `types: ${tags.join(', ')}`);
    check(await ex<boolean>(`!!document.querySelector('#page-extract [data-act=page]')`), '"download the video on this page" is offered');
    await shot('browser');

    // ---- browser: navigation ----
    let ti = await tabInfo();
    check(ti.url === `${base}/` && ti.tabs[0] === 'Demo page', `address bar + tab title: ${ti.url} / ${ti.tabs}`);
    await wvx(`document.getElementById('l2').click()`); await sleep(1500);
    ti = await tabInfo();
    check(ti.url === `${base}/page2` && ti.back && !ti.fwd && ti.tabs[0] === 'Page Two', `link click navigates, back enabled`);
    await ex(`document.querySelector('#nav-back').click()`); await sleep(1200);
    ti = await tabInfo();
    check(ti.url === `${base}/` && ti.fwd, `back works, forward enabled`);
    await ex(`document.querySelector('#nav-fwd').click()`); await sleep(1200);
    check((await tabInfo()).url === `${base}/page2`, 'forward works');
    await submitUrl(`127.0.0.1:${(server.address() as { port: number }).port}/page2?typed`); await sleep(1200);
    check((await tabInfo()).url.endsWith('/page2?typed'), 'typed address without scheme loads');
    await submitUrl(`${base}/`); await sleep(1500);
    await wvx(`document.getElementById('blank').click()`); await sleep(1800);
    ti = await tabInfo();
    check(ti.tabs.length === 2 && ti.url.includes('page2?new'), `target=_blank opens a new tab: ${JSON.stringify(ti.tabs)}`);
    await ex(`document.querySelector('.btab:not(.active)').click()`); await sleep(300);
    check((await tabInfo()).url === `${base}/`, 'tab switching restores the address');
    await wvx(`document.getElementById('att').click()`); await sleep(2500);
    check(getManager().list().some((j) => j.name === 'report.bin'), 'attachment link handed to the download manager');
    await submitUrl('http://127.0.0.1:1/'); await sleep(2500);
    check(await ex<boolean>(`!document.querySelector('#err-page').classList.contains('hidden')`), 'error page for an unreachable host');
    await ex(`document.querySelectorAll('.btab .x')[1].click()`); await sleep(300);
    check((await tabInfo()).tabs.length === 1, 'tab closes');

    // ---- downloads from the browser panel ----
    await submitUrl(`${base}/`); await sleep(3000);
    await ex(`[...document.querySelectorAll('#media-list li button')].forEach(b=>b.click())`);
    await ex(`document.querySelector('#page-extract [data-act=page]').click()`);
    await sleep(500);
    await ex(`document.querySelector('[data-tab=downloads]').click()`);
    for (let i = 0; i < 80; i++) {
      const st = getManager().list();
      if (st.length >= 5 && st.every((j) => ['done', 'error'].includes(j.status))) break;
      await sleep(500);
    }
    const jobs = getManager().list();
    for (const j of jobs) log(j.status, j.kind, j.name, j.error ?? '');
    check(jobs.length >= 5, `${jobs.length} jobs`);
    check(jobs.every((j) => j.status === 'done'), 'all jobs done');
    check(jobs.some((j) => j.kind === 'extract' && /\.mp4$/.test(j.output ?? '')), 'page extractor produced an mp4');
    check(jobs.filter((j) => j.kind === 'hls').every((j) => /\.mp4$/.test(j.output ?? '')), 'hls outputs are mp4');
    await sleep(400);
    await shot('downloads');
    check(await ex<number>(`document.querySelectorAll('#list .item').length`) >= 5, 'download rows render');
  } catch (e) { ok = false; log('ERROR', (e as Error).stack ?? e); }

  async function shotTab(n: string): Promise<void> { await shot(n); }
  log(ok ? 'ALL PASSED' : 'FAILED');
  server.close();
  app.exit(ok ? 0 : 1);
}
