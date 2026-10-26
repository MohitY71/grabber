import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DownloadManager, explainError, parseChecksum, categoryOf, Throttle, type ManagerOptions, type JobView } from '../src/index.ts';
import { makeFixtures, serve, waitFor, slowServer, type TestServer } from './helpers.ts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-feat-'));
const fixtures = path.join(work, 'fx');
let srv: TestServer;
const sha = (f: string, algo = 'sha256'): string => crypto.createHash(algo).update(fs.readFileSync(f)).digest('hex');
const mgr = (name: string, o: Partial<ManagerOptions> = {}): Promise<DownloadManager> =>
  new DownloadManager({ dataDir: path.join(work, name, 'data'), downloadDir: path.join(work, name, 'out'), retryDelays: [0.05], ...o }).init();
const finished = (j: JobView): boolean => ['done', 'error', 'cancelled', 'conflict'].includes(j.status);
const outDir = (name: string): string => path.join(work, name, 'out');

before(async () => {
  makeFixtures(fixtures);
  fs.writeFileSync(path.join(fixtures, 'doc.pdf'), crypto.randomBytes(300_000));
  fs.writeFileSync(path.join(fixtures, 'two.bin'), crypto.randomBytes(2_000_000));
  srv = await serve(fixtures);
});
after(() => { srv.server.close(); fs.rmSync(work, { recursive: true, force: true }); });

/* #2 choose location + filename */
test('per-download folder and file name', async () => {
  const m = await mgr('loc');
  const dir = path.join(work, 'loc', 'custom', 'nested');
  const j = await waitFor(m, m.add(`${srv.base}/two.bin`, { saveDir: dir, filename: 'renamed:file?.dat' }), finished);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(j.output, path.join(dir, 'renamed_file_.dat'), 'unsafe characters are replaced');
  assert.equal(sha(j.output!), sha(path.join(fixtures, 'two.bin')));
});

/* #11 duplicates */
test('existing file: ask, then replace / keep both / cancel', async () => {
  const m = await mgr('dup');
  const out = outDir('dup'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'two.bin'), 'OLD');
  const a = await waitFor(m, m.add(`${srv.base}/two.bin`), finished);
  assert.equal(a.status, 'conflict');
  assert.equal(a.conflictPath, path.join(out, 'two.bin'));
  assert.equal(fs.readFileSync(path.join(out, 'two.bin'), 'utf8'), 'OLD', 'nothing is touched while waiting');
  m.resolveConflict(a.id, 'rename');
  const r = await waitFor(m, a.id, (x) => x.status === 'done');
  assert.equal(path.basename(r.output!), 'two (1).bin');
  assert.equal(fs.readFileSync(path.join(out, 'two.bin'), 'utf8'), 'OLD');

  const b = await waitFor(m, m.add(`${srv.base}/two.bin`), (x) => x.status === 'conflict');
  m.resolveConflict(b.id, 'replace');
  const r2 = await waitFor(m, b.id, (x) => x.status === 'done');
  assert.equal(r2.output, path.join(out, 'two.bin'));
  assert.equal(sha(path.join(out, 'two.bin')), sha(path.join(fixtures, 'two.bin')), 'old file replaced');

  const c = await waitFor(m, m.add(`${srv.base}/two.bin`), (x) => x.status === 'conflict');
  await m.cancel(c.id);
  assert.equal(m.list().find((x) => x.id === c.id)!.status, 'cancelled');
});

test('existing file: policy rename / replace never asks', async () => {
  for (const policy of ['rename', 'replace'] as const) {
    const m = await mgr(`dup-${policy}`, { onExists: policy });
    const out = outDir(`dup-${policy}`); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'two.bin'), 'OLD');
    const j = await waitFor(m, m.add(`${srv.base}/two.bin`), finished);
    assert.equal(j.status, 'done', j.error ?? '');
    assert.equal(path.basename(j.output!), policy === 'rename' ? 'two (1).bin' : 'two.bin');
  }
});

/* #3/#6/#9 cancel keeps history, discards partial data; can be restarted */
test('cancel discards partial data, stays in history, and can be restarted', async () => {
  const data = crypto.randomBytes(4_000_000);
  const s = await slowServer(data, { chunk: 32 * 1024, delay: 10 });
  const m = await mgr('cancel');
  const id = m.add(`${s.base}/f.bin`, { filename: 'f.bin', threads: 2 });
  await waitFor(m, id, (x) => x.status === 'downloading' && x.downloaded > 300_000);
  await m.cancel(id);
  const c = await waitFor(m, id, (x) => x.status === 'cancelled');
  assert.equal(c.progress, 0);
  assert.ok(m.list().some((x) => x.id === id), 'cancelled download stays in the list');
  const incomplete = path.join(outDir('cancel'), '.grabber-incomplete');
  assert.deepEqual(fs.existsSync(incomplete) ? fs.readdirSync(incomplete) : [], [], 'partial file removed');
  assert.ok(!fs.existsSync(path.join(outDir('cancel'), 'f.bin')));
  m.resume(id);
  const j = await waitFor(m, id, (x) => x.status === 'done' || x.status === 'error', 60000);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), crypto.createHash('sha256').update(data).digest('hex'));
  s.server.close();
});

/* #14 incomplete files are kept separate */
test('incomplete data lives in a hidden folder until the download is finished', async () => {
  const data = crypto.randomBytes(3_000_000);
  const s = await slowServer(data, { chunk: 32 * 1024, delay: 10 });
  const m = await mgr('safe');
  const id = m.add(`${s.base}/movie.bin`, { filename: 'movie.bin', threads: 2 });
  await waitFor(m, id, (x) => x.status === 'downloading' && x.downloaded > 200_000);
  const out = outDir('safe');
  const visible = fs.readdirSync(out).filter((f) => !f.startsWith('.'));
  assert.deepEqual(visible, [], 'no half-written file in the download folder');
  assert.equal(fs.readdirSync(path.join(out, '.grabber-incomplete')).length, 1);
  const j = await waitFor(m, id, finished, 60000);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.deepEqual(fs.readdirSync(path.join(out, '.grabber-incomplete')), []);
  s.server.close();
});

/* #7 automatic retry */
test('temporary network failure is retried automatically and then succeeds', async () => {
  const data = crypto.randomBytes(1_000_000);
  const s = await slowServer(data, { chunk: 64 * 1024, delay: 1, failFirst: 3 });
  const m = await mgr('retry');
  const seen = new Set<string>();
  m.on('update', (j: JobView) => seen.add(j.status));
  const id = m.add(`${s.base}/f.bin`, { filename: 'f.bin', threads: 1 });
  const j = await waitFor(m, id, (x) => x.status === 'done' || x.status === 'error', 30000);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), crypto.createHash('sha256').update(data).digest('hex'));
  s.server.close();
});

test('server errors: retried then reported clearly; 404/403 are not retried', async () => {
  const flaky = await slowServer(Buffer.alloc(10), { failFirst: 100, failStatus: 503 });
  const m = await mgr('retry2', { autoRetry: 2 });
  const j = await waitFor(m, m.add(`${flaky.base}/f.bin`), (x) => x.status === 'error' || x.status === 'done', 30000);
  assert.equal(j.status, 'error');
  assert.match(j.error!, /server had a problem \(HTTP 503\)/);
  assert.ok(flaky.requests.length >= 3, `retried (${flaky.requests.length} requests)`);
  flaky.server.close();

  srv.hits.length = 0;
  const nf = await waitFor(m, m.add(`${srv.base}/nope.bin`), (x) => x.status === 'error');
  assert.match(nf.error!, /File not found \(HTTP 404\)/);
  assert.equal(srv.hits.filter((h) => h.path === '/nope.bin').length, 1, 'permanent errors are not retried');
});

/* #13 clear errors */
test('explainError gives actionable messages', () => {
  assert.match(explainError(Object.assign(new Error('x'), { code: 'ENOSPC' })).message, /Not enough free disk space/);
  assert.match(explainError(Object.assign(new Error('x'), { code: 'EACCES' })).message, /permission denied/);
  const dns = explainError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  assert.match(dns.message, /Can't reach the server/); assert.equal(dns.transient, true);
  assert.match(explainError(new Error('HTTP 403 Forbidden')).message, /Access denied/);
  assert.match(explainError(new Error('HTTP 401 Unauthorized')).message, /sign in/);
  assert.equal(explainError(new Error('HTTP 404 x')).transient, false);
  assert.equal(explainError(new Error('HTTP 502 x')).transient, true);
  assert.equal(explainError(new Error('Connection closed early')).transient, true);
});

/* #17 bandwidth limit */
test('speed limit slows downloads and can be lifted', async () => {
  const limited = await mgr('limit', { speedLimit: 1_000_000 });
  const t0 = Date.now();
  const a = await waitFor(limited, limited.add(`${srv.base}/two.bin`, { threads: 4 }), finished, 30000);
  const slow = Date.now() - t0;
  assert.equal(a.status, 'done', a.error ?? '');
  assert.ok(slow > 1400, `2 MB at 1 MB/s should take ~2 s, took ${slow} ms`);
  limited.configure({ speedLimit: 0 });
  const t1 = Date.now();
  const b = await waitFor(limited, limited.add(`${srv.base}/two.bin`, { threads: 4, onExists: 'rename' }), finished, 30000);
  assert.equal(b.status, 'done', b.error ?? '');
  assert.ok(Date.now() - t1 < slow / 2, 'unlimited is much faster');
});

test('Throttle spaces out reads across callers', async () => {
  const t = new Throttle(1_000_000);
  const t0 = Date.now();
  await Promise.all([t.take(300_000), t.take(300_000), t.take(300_000)]);
  assert.ok(Date.now() - t0 >= 500, 'the shared budget is respected');
});

/* #18 priority */
test('queue runs high priority first', async () => {
  const data = crypto.randomBytes(300_000);
  const s = await slowServer(data, { chunk: 32 * 1024, delay: 15 });
  const m = await mgr('prio', { maxConcurrent: 1, onExists: 'rename' });
  const order: string[] = [];
  m.on('update', (j: JobView) => { if (j.status === 'probing' && !order.includes(j.name)) order.push(j.name); });
  const first = m.add(`${s.base}/first.bin`, { filename: 'first.bin', threads: 1 });
  m.add(`${s.base}/low.bin`, { filename: 'low.bin', threads: 1, priority: -1 });
  m.add(`${s.base}/normal.bin`, { filename: 'normal.bin', threads: 1 });
  const hi = m.add(`${s.base}/high.bin`, { filename: 'high.bin', threads: 1, priority: 1 });
  await waitFor(m, hi, (x) => x.status === 'done', 30000);
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(m.list().every((j) => j.status === 'done'), JSON.stringify(m.list().map((j) => [j.name, j.status])));
  void first;
  const names = m.list().sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)).map((j) => j.name);
  assert.deepEqual(names, ['first.bin', 'high.bin', 'normal.bin', 'low.bin']);
  s.server.close();
});

/* #22 scheduling */
test('scheduled download waits for its start time; "start now" skips the wait', async () => {
  const m = await mgr('sched');
  const at = Date.now() + 1800;
  const id = m.add(`${srv.base}/doc.pdf`, { startAt: at });
  assert.equal(m.list()[0]!.status, 'scheduled');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(m.list()[0]!.status, 'scheduled', 'still waiting');
  const j = await waitFor(m, id, (x) => x.status === 'done', 15000);
  assert.ok(j.finishedAt! >= at - 50, 'did not start early');

  const id2 = m.add(`${srv.base}/doc.pdf`, { startAt: Date.now() + 60_000, onExists: 'rename' });
  assert.equal(m.list().find((x) => x.id === id2)!.status, 'scheduled');
  m.schedule(id2, null);
  assert.equal((await waitFor(m, id2, (x) => x.status === 'done', 15000)).status, 'done');
});

/* #8 recovery */
test('interrupted downloads resume by themselves after a restart', async () => {
  const data = crypto.randomBytes(3_000_000);
  const s = await slowServer(data, { chunk: 16 * 1024, delay: 30 });
  const m1 = await mgr('recover');
  const id = m1.add(`${s.base}/f.bin`, { filename: 'f.bin', threads: 3 });
  await waitFor(m1, id, (x) => x.status === 'downloading' && x.downloaded > 300_000);
  await m1.shutdown();
  const m2 = await mgr('recover');
  const before = m2.list().find((x) => x.id === id)!;
  assert.ok(['queued', 'probing', 'downloading'].includes(before.status), `status after restart: ${before.status}`);
  const j = await waitFor(m2, id, (x) => x.status === 'done' || x.status === 'error', 60000);
  assert.equal(j.status, 'done', j.error ?? '');
  assert.equal(sha(j.output!), crypto.createHash('sha256').update(data).digest('hex'));
  s.server.close();
});

test('a manually paused download stays paused after a restart', async () => {
  const data = crypto.randomBytes(3_000_000);
  const s = await slowServer(data, { chunk: 16 * 1024, delay: 30 });
  const m1 = await mgr('recover2');
  const id = m1.add(`${s.base}/f.bin`, { filename: 'f.bin', threads: 2 });
  await waitFor(m1, id, (x) => x.status === 'downloading' && x.downloaded > 200_000);
  m1.pause(id);
  await waitFor(m1, id, (x) => x.status === 'paused');
  await m1.shutdown();
  const m2 = await mgr('recover2');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m2.list().find((x) => x.id === id)!.status, 'paused');
  s.server.close();
});

/* #21 categories */
test('files are sorted into category folders when enabled', async () => {
  assert.equal(categoryOf('a.MP4'), 'video'); assert.equal(categoryOf('a.flac'), 'music'); assert.equal(categoryOf('a.pdf'), 'documents');
  assert.equal(categoryOf('a.png'), 'images'); assert.equal(categoryOf('a.zip'), 'archives'); assert.equal(categoryOf('a.dmg'), 'programs'); assert.equal(categoryOf('a.xyz'), 'other');
  const m = await mgr('cats', { categoryFolders: true });
  const a = await waitFor(m, m.add(`${srv.base}/doc.pdf`), finished);
  const b = await waitFor(m, m.add(`${srv.base}/src.mp4`), finished);
  assert.equal(a.output, path.join(outDir('cats'), 'Documents', 'doc.pdf')); assert.equal(a.category, 'documents');
  assert.equal(b.output, path.join(outDir('cats'), 'Video', 'src.mp4')); assert.equal(b.category, 'video');
});

/* #24 checksum */
test('checksum: parse formats, verify on download, detect mismatch, verify later', async () => {
  const good = sha(path.join(fixtures, 'doc.pdf'));
  assert.deepEqual(parseChecksum(`sha256:${good.toUpperCase()}`), { algo: 'sha256', expected: good });
  assert.deepEqual(parseChecksum(`${good}  doc.pdf`), { algo: 'sha256', expected: good });
  assert.equal(parseChecksum('d41d8cd98f00b204e9800998ecf8427e').algo, 'md5');
  assert.throws(() => parseChecksum('zzzz'), /checksum/);
  assert.throws(() => parseChecksum('abcd'), /Unrecognized/);
  assert.throws(() => parseChecksum(`sha256:${good.slice(2)}`), /64 characters/);

  const m = await mgr('sum', { onExists: 'rename' });
  const ok = await waitFor(m, m.add(`${srv.base}/doc.pdf`, { checksum: `sha256:${good}` }), finished);
  assert.equal(ok.status, 'done', ok.error ?? ''); assert.equal(ok.checksum?.state, 'ok');

  const bad = await waitFor(m, m.add(`${srv.base}/doc.pdf`, { checksum: 'a'.repeat(64) }), finished);
  assert.equal(bad.status, 'error'); assert.match(bad.error!, /Checksum mismatch/); assert.equal(bad.checksum?.state, 'mismatch');
  assert.ok(fs.existsSync(bad.output!), 'the file is kept for the user to decide');

  const later = await waitFor(m, m.add(`${srv.base}/doc.pdf`), finished);
  assert.equal((await m.verify(later.id, good)).checksum?.state, 'ok');
  assert.equal((await m.verify(later.id, sha(path.join(fixtures, 'two.bin')))).checksum?.state, 'mismatch');
  assert.throws(() => m.add(`${srv.base}/doc.pdf`, { checksum: 'nothex!' }), /checksum/);
});

/* #19 pause/resume all */
test('pause all / resume all', async () => {
  const data = crypto.randomBytes(2_000_000);
  const s = await slowServer(data, { chunk: 32 * 1024, delay: 10 });
  const m = await mgr('all', { maxConcurrent: 2, onExists: 'rename' });
  const ids = [1, 2, 3].map((i) => m.add(`${s.base}/f${i}.bin`, { filename: `f${i}.bin`, threads: 1 }));
  await waitFor(m, ids[0]!, (x) => x.status === 'downloading' && x.downloaded > 100_000);
  m.pauseAll();
  await Promise.all(ids.map((id) => waitFor(m, id, (x) => x.status === 'paused')));
  m.resumeAll();
  for (const id of ids) assert.equal((await waitFor(m, id, (x) => x.status === 'done' || x.status === 'error', 60000)).status, 'done');
  s.server.close();
});
