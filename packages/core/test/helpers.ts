import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DownloadManager, JobView } from '../src/index.ts';

export function makeFixtures(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'src.mp4');
  if (!fs.existsSync(src)) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  }
  const hls = (name: string, extra: string[]): void => {
    const d = path.join(dir, name);
    if (fs.existsSync(path.join(d, 'index.m3u8'))) return;
    fs.mkdirSync(d, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', ...extra, path.join(d, 'index.m3u8')]);
  };
  hls('plain', []);
  fs.writeFileSync(path.join(dir, 'enc.key'), Buffer.from('0123456789abcdef'));
  fs.writeFileSync(path.join(dir, 'enc.keyinfo'), `enc.key\n${path.join(dir, 'enc.key')}\n`);
  hls('enc', ['-hls_key_info_file', path.join(dir, 'enc.keyinfo')]);
  fs.copyFileSync(path.join(dir, 'enc.key'), path.join(dir, 'enc', 'enc.key'));
  hls('fmp4', ['-hls_segment_type', 'fmp4']);
  return src;
}

export interface TestServer { server: http.Server; hits: Array<{ path: string; range?: string; ua?: string; referer?: string }>; base: string }

/** Static file server with Range support. `ranges: false` disables it; `hits` records requests. */
export function serve(root: string, { ranges = true } = {}): Promise<TestServer> {
  const hits: TestServer['hits'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push({ path: url.pathname, range: req.headers.range, ua: req.headers['user-agent'], referer: req.headers.referer });
    if (url.pathname === '/redirect') { res.writeHead(302, { location: '/src.mp4' }); return void res.end(); }
    if (url.pathname.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end(`<html><title>${url.pathname}${url.search}</title><body>hello</body></html>`);
    }
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return void res.end(); }
    const size = fs.statSync(file).size;
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
    const m = ranges ? /bytes=(\d+)-(\d*)/.exec(req.headers.range || '') : null;
    if (m) {
      const start = Number(m[1]); const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': size, ...(ranges ? { 'accept-ranges': 'bytes' } : {}) });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    resolve({ server, hits, base: `http://127.0.0.1:${addr.port}` });
  }));
}

export function waitFor(mgr: DownloadManager, id: string, pred: (j: JobView) => boolean, timeout = 30000): Promise<JobView> {
  return new Promise((resolve, reject) => {
    const on = (j: JobView): void => { if (j.id === id && pred(j)) { clearTimeout(t); mgr.off('update', on); resolve(j); } };
    const t = setTimeout(() => { mgr.off('update', on); reject(new Error(`timeout; last=${JSON.stringify(mgr.list().find((j) => j.id === id))}`)); }, timeout);
    mgr.on('update', on);
    const cur = mgr.list().find((j) => j.id === id);
    if (cur && pred(cur)) on(cur);
  });
}

export function probeStreams(file: string): { codecs: string[]; duration: number } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-show_entries', 'format=duration', '-of', 'json', file]).toString();
  const j = JSON.parse(out) as { streams: Array<{ codec_type: string }>; format: { duration: string } };
  return { codecs: j.streams.map((s) => s.codec_type), duration: Number(j.format.duration) };
}

/**
 * A stand-in for the yt-dlp binary that speaks the same protocol the app relies on:
 * `-J` prints JSON, otherwise it prints `[download] Destination:`, our progress template lines,
 * `[Merger]`, and finally the `after_move:` print. URLs containing "drm"/"playlist"/"private" trigger those cases.
 */
export function writeStubYtdlp(file: string, sourceVideo: string, pageBase: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const url = a[a.length - 1];
const slow = url.includes('slow');
if (a.includes('--version')) { console.log('2099.01.01'); process.exit(0); }
if (url.includes('drm')) { console.error('ERROR: [stub] abc: This video is DRM protected'); process.exit(1); }
if (url.includes('private')) { console.error('ERROR: [stub] abc: Private video. Sign in if you have been granted access'); process.exit(1); }
if (url.includes('unsupported')) { console.error('ERROR: Unsupported URL: ' + url); process.exit(1); }
if (a.includes('-J')) {
  if (url.includes('playlist')) {
    console.log(JSON.stringify({ _type: 'playlist', title: 'List', entries: [1, 2].map((i) => ({ webpage_url: '${pageBase}/page-' + i })) }));
  } else {
    console.log(JSON.stringify({ id: 'abc', title: 'Stub: Video/Title?', requested_formats: [{}, {}], filesize_approx: 1000000, args: a }));
  }
  process.exit(0);
}
const out = a[a.indexOf('-o') + 1].replace('.%(ext)s', url.includes('audio') ? '.mp3' : '.mp4');
fs.writeFileSync(process.env.STUB_ARGS_FILE || '/dev/null', JSON.stringify(a));
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const s of [1, 2]) {
    console.log('[download] Destination: ' + out + '.f' + s);
    for (let i = 1; i <= 5; i++) { console.log('GRB|' + i * 100000 + '|500000|NA|123456|' + (5 - i)); await sleep(slow ? 400 : 5); }
  }
  console.log('[Merger] Merging formats into "' + out + '"');
  fs.copyFileSync(${JSON.stringify(sourceVideo)}, out);
  console.log('GRBFILE|' + out);
})();
`, { mode: 0o755 });
}

/** A server that serves `data` slowly (so tests can act mid-download) and can fail on demand. */
export function slowServer(data: Buffer, o: { chunk?: number; delay?: number; failFirst?: number; failStatus?: number } = {}): Promise<{ server: http.Server; base: string; requests: number[] }> {
  const requests: number[] = [];
  let failures = o.failFirst ?? 0;
  const server = http.createServer((req, res) => {
    requests.push(Date.now());
    if (failures > 0) {
      failures--;
      if (o.failStatus) { res.writeHead(o.failStatus); return void res.end(); }
      return void req.socket.destroy(); // abrupt connection loss
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0; const end = m?.[2] ? Number(m[2]) : data.length - 1;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1, 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' });
    let pos = start;
    const tick = (): void => { if (pos > end || res.destroyed) return void res.end(); const n = Math.min(o.chunk ?? 16 * 1024, end + 1 - pos); res.write(data.subarray(pos, pos + n)); pos += n; setTimeout(tick, o.delay ?? 10); };
    tick();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}
