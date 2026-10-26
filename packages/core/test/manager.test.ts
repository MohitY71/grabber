import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DownloadManager, type ManagerOptions } from '../src/index.ts';
import { makeFixtures, serve, waitFor, probeStreams, writeStubYtdlp, slowServer, type TestServer } from './helpers.ts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-test-'));
const fixtures = path.join(work, 'fx');
let srv: TestServer;
let big: string;
const sha = (f: string): string => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const newMgr = (name: string, o: Partial<ManagerOptions> = {}): Promise<DownloadManager> =>
  new DownloadManager({ dataDir: path.join(work, name, 'data'), downloadDir: path.join(work, name, 'out'), ...o }).init();
const finished = (j: { status: string }): boolean => j.status === 'done' || j.status === 'error';

before(async () => {
  makeFixtures(fixtures);
  big = path.join(fixtures, 'big.bin');
  fs.writeFileSync(big, crypto.randomBytes(12 * 1024 * 1024));
  srv = await serve(fixtures);
});
after(() => { srv.server.close(); fs.rmSync(work, { recursive: true, force: true }); });

test('multipart download is byte-identical and uses parallel ranges', async () => {
  const m = await newMgr('t1');
  srv.hits.length = 0;
  const id = m.add(`${srv.base}/big.bin`, { threads: 6 });
  const j = await waitFor(m, id, finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), sha(big));
  assert.equal(srv.hits.filter((h) => h.path === '/big.bin' && h.range && h.range !== 'bytes=0-0').length, 6);
});

test('server without range support falls back to a single stream', async () => {
  const plain = await serve(fixtures, { ranges: false });
  const m = await newMgr('t2');
  const j = await waitFor(m, m.add(`${plain.base}/big.bin`), finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), sha(big));
  plain.server.close();
});

test('pause then resume continues from saved parts and stays correct', async () => {
  const data = fs.readFileSync(big);
  const starts: number[] = [];
  const slow = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0; const end = m?.[2] ? Number(m[2]) : data.length - 1;
    starts.push(start);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1, 'content-type': 'application/octet-stream' });
    let pos = start;
    const tick = (): void => { if (pos > end || res.destroyed) return void res.end(); const n = Math.min(16 * 1024, end + 1 - pos); res.write(data.subarray(pos, pos + n)); pos += n; setTimeout(tick, 10); };
    tick();
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  const port = (slow.address() as { port: number }).port;
  const m = await newMgr('t3');
  const id = m.add(`http://127.0.0.1:${port}/f.bin`, { threads: 4, filename: 'f.bin' });
  await waitFor(m, id, (x) => x.status === 'downloading' && x.downloaded > 1_000_000);
  m.pause(id);
  const paused = await waitFor(m, id, (x) => x.status === 'paused');
  assert.ok(paused.downloaded > 0 && paused.downloaded < data.length);
  starts.length = 0;
  m.resume(id);
  const j = await waitFor(m, id, finished, 60000);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), sha(big));
  assert.ok(starts.every((s) => s > 0), 'resume must not restart parts from byte 0');
  slow.close();
});

test('resume survives a manager restart (persisted state)', async () => {
  const m1 = await newMgr('t4', { resumeOnStart: false });
  const a = m1.add(`${srv.base}/big.bin`, { threads: 3 });
  await waitFor(m1, a, (x) => x.downloaded > 0 || x.status === 'done');
  m1.pause(a);
  await waitFor(m1, a, (x) => x.status === 'paused' || x.status === 'done');
  await m1.shutdown();
  const m2 = await newMgr('t4', { resumeOnStart: false });
  const j0 = m2.list()[0]!;
  if (j0.status !== 'done') { assert.equal(j0.status, 'paused'); m2.resume(j0.id); }
  const j = await waitFor(m2, j0.id, finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), sha(big));
});

for (const kind of ['plain', 'enc', 'fmp4']) {
  test(`HLS ${kind} -> playable mp4 (ffmpeg)`, async () => {
    const m = await newMgr(`hls-${kind}`);
    const id = m.add(`${srv.base}/${kind}/index.m3u8`, { referer: 'https://example.test/page', userAgent: 'GrabberTest/1' });
    const j = await waitFor(m, id, finished);
    assert.equal(j.status, 'done', j.error ?? '');
    assert.match(j.output!, /\.mp4$/);
    const info = probeStreams(j.output!);
    assert.deepEqual(info.codecs.sort(), ['audio', 'video']);
    assert.ok(Math.abs(info.duration - 8) < 1, `duration ${info.duration}`);
    assert.ok(srv.hits.some((h) => h.ua === 'GrabberTest/1' && h.referer === 'https://example.test/page'));
  });
}

test('HLS TS -> mp4 without ffmpeg (mux.js fallback)', async () => {
  const m = await newMgr('hls-nofx', { ffmpegPath: '/nonexistent/ffmpeg' });
  const j = await waitFor(m, m.add(`${srv.base}/plain/index.m3u8`), finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.deepEqual(probeStreams(j.output!).codecs.sort(), ['audio', 'video']);
});

test('master playlist: merges demuxed audio and honours the quality cap', async () => {
  const d = path.join(fixtures, 'master'); fs.mkdirSync(d, { recursive: true });
  const src = path.join(fixtures, 'src.mp4');
  for (const [n, args] of [['v', ['-an']], ['a', ['-vn']]] as const) {
    fs.mkdirSync(path.join(d, n), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c', 'copy', ...args, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(d, n, 'i.m3u8')]);
  }
  fs.mkdirSync(path.join(d, 'low'), { recursive: true });
  fs.copyFileSync(path.join(d, 'v', 'i.m3u8'), path.join(d, 'low', 'i.m3u8'));
  for (const f of fs.readdirSync(path.join(d, 'v'))) if (f.endsWith('.ts')) fs.copyFileSync(path.join(d, 'v', f), path.join(d, 'low', f));
  fs.writeFileSync(path.join(d, 'master.m3u8'), `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="a/i.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="aud"
v/i.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO="aud"
low/i.m3u8
`);
  srv.hits.length = 0;
  const m = await newMgr('hls-master');
  const best = await waitFor(m, m.add(`${srv.base}/master/master.m3u8`), finished);
  assert.equal(best.status, 'done', best.error ?? '');
  assert.deepEqual(probeStreams(best.output!).codecs.sort(), ['audio', 'video']);
  assert.ok(srv.hits.some((h) => h.path.startsWith('/master/v/')) && !srv.hits.some((h) => h.path.startsWith('/master/low/') && h.path.endsWith('.ts')));
  srv.hits.length = 0;
  const capped = await waitFor(m, m.add(`${srv.base}/master/master.m3u8`, { quality: '480', onExists: 'rename' }), finished);
  assert.equal(capped.status, 'done', capped.error ?? '');
  assert.ok(srv.hits.some((h) => h.path.startsWith('/master/low/') && h.path.endsWith('.ts')), '480p cap must pick the 360p variant');
});

test('redirects, bad urls and 404s are handled', async () => {
  const m = await newMgr('t5');
  assert.throws(() => m.add('ftp://nope'), /http/);
  assert.equal((await waitFor(m, m.add(`${srv.base}/missing.mp4`), (x) => x.status === 'error')).status, 'error');
  assert.equal((await waitFor(m, m.add(`${srv.base}/redirect`), finished)).status, 'done');
});

/* ---- video-site extractor path (stubbed yt-dlp binary) ---- */
test('web page -> extractor: progress, merge, final file and arguments', async () => {
  const tools = path.join(work, 'x1', 'tools');
  writeStubYtdlp(path.join(tools, 'yt-dlp'), path.join(fixtures, 'src.mp4'), srv.base);
  const argsFile = path.join(work, 'x1', 'args.json');
  process.env.STUB_ARGS_FILE = argsFile;
  const m = await newMgr('x1', { toolsDir: tools });
  const seen = new Set<string>();
  m.on('update', (j) => seen.add(j.status));
  const id = m.add(`${srv.base}/page-watch`, { quality: '720', referer: 'https://site.test/', cookiesFile: '/tmp/c.txt' });
  const j = await waitFor(m, id, finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.ok(seen.has('merging'), 'goes through the merging phase');
  assert.match(path.basename(j.output!), /^Stub_ Video_Title_\.mp4$/);
  assert.deepEqual(probeStreams(j.output!).codecs.sort(), ['audio', 'video']);
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
  assert.ok(args.join(' ').includes('res:720,vcodec:h264,acodec:aac'), 'quality cap becomes a yt-dlp sort');
  assert.ok(args.includes('--referer') && args.includes('--cookies') && args.includes('/tmp/c.txt'));
  assert.ok(!args.some((a) => a.startsWith('Cookie:')), 'never send a raw Cookie header to every host');
  assert.ok(args.includes('--no-playlist'));
});

test('extractor: audio-only, DRM, private and unsupported pages give clear errors', async () => {
  const tools = path.join(work, 'x2', 'tools');
  writeStubYtdlp(path.join(tools, 'yt-dlp'), path.join(fixtures, 'src.mp4'), srv.base);
  const m = await newMgr('x2', { toolsDir: tools });
  const audio = await waitFor(m, m.add(`${srv.base}/page-audio`, { quality: 'audio' }), finished);
  assert.equal(audio.status, 'done', audio.error ?? '');
  assert.match(audio.output!, /\.mp3$/);
  const drm = await waitFor(m, m.add(`${srv.base}/page-drm`), finished);
  assert.equal(drm.status, 'error'); assert.match(drm.error!, /DRM-protected/);
  const priv = await waitFor(m, m.add(`${srv.base}/page-private`), finished);
  assert.match(priv.error!, /signed in/);
  const uns = await waitFor(m, m.add(`${srv.base}/page-unsupported`), finished);
  assert.match(uns.error!, /No downloadable video/);
});

test('extractor: playlist page fans out into one job per video', async () => {
  const tools = path.join(work, 'x3', 'tools');
  writeStubYtdlp(path.join(tools, 'yt-dlp'), path.join(fixtures, 'src.mp4'), srv.base);
  const m = await newMgr('x3', { toolsDir: tools });
  const id = m.add(`${srv.base}/page-playlist`);
  const parent = await waitFor(m, id, finished);
  assert.equal(parent.status, 'done', parent.error ?? '');
  assert.match(parent.note ?? '', /Added 2 videos/);
  await new Promise((r) => setTimeout(r, 300));
  const kids = m.list().filter((j) => j.id !== id);
  assert.equal(kids.length, 2);
  for (const k of kids) assert.equal((await waitFor(m, k.id, finished)).status, 'done');
});

test('extractor: pause kills the engine and resume finishes the download', async () => {
  const tools = path.join(work, 'x4', 'tools');
  writeStubYtdlp(path.join(tools, 'yt-dlp'), path.join(fixtures, 'src.mp4'), srv.base);
  const m = await newMgr('x4', { toolsDir: tools });
  const id = m.add(`${srv.base}/page-slow`);
  await waitFor(m, id, (x) => x.status === 'downloading' && x.progress > 0.05);
  m.pause(id);
  assert.equal((await waitFor(m, id, (x) => x.status === 'paused')).status, 'paused');
  m.resume(id);
  const j = await waitFor(m, id, finished, 60000);
  assert.equal(j.status, 'done', j.error ?? '');
});

test('cookie header is not sent to a different site than the one requested (HLS)', async () => {
  const other = await serve(fixtures);
  // A master playlist on 127.0.0.1 whose media playlist lives on "localhost" (a different host name).
  const d = path.join(fixtures, 'xsite'); fs.mkdirSync(d, { recursive: true });
  const otherBase = other.base.replace('127.0.0.1', 'localhost');
  fs.writeFileSync(path.join(d, 'master.m3u8'), `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${otherBase}/plain/index.m3u8\n`);
  const seenCookie: Array<string | undefined> = [];
  other.server.on('request', (req) => seenCookie.push(req.headers.cookie));
  const m = await newMgr('xsite');
  const j = await waitFor(m, m.add(`${srv.base}/xsite/master.m3u8`, { cookies: 'session=secret' }), finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.ok(seenCookie.length > 0 && seenCookie.every((c) => c === undefined), 'cookie must not leak cross-site');
  other.server.close();
});
