import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probe, buildHeaders } from './probe.ts';
import { downloadHttp } from './http-download.ts';
import { loadHls, buildPlan, downloadItems } from './hls-download.ts';
import { concatFiles, remuxWithFfmpeg, remuxTsWithMuxjs, ffmpegAvailable, rmrf, type MuxInput } from './mux.ts';
import { fetchInfo, hasYtdlp, installYtdlp, updateYtdlp, ytdlpBinaryPath, ytdlpDownload, ytdlpVersion } from './ytdlp.ts';
import { isAbort, sanitizeFilename, uniquePath } from './util.ts';
import { explainError } from './errors.ts';
import { Throttle } from './throttle.ts';
import { categoryOf, CATEGORY_FOLDER } from './category.ts';
import { parseChecksum, verifyFile } from './checksum.ts';
import type { AddOptions, Category, ExistsPolicy, Job, JobView, ManagerOptions, Priority } from './types.ts';

export interface Meter { add(n: number): void; stop(): void }

/** Thrown to park a job that is waiting for the user to choose what to do about an existing file. */
class ConflictWait extends Error {}

const DEFAULT_RETRY_DELAYS_S = [5, 15, 45, 120, 300];
const IN_FLIGHT = new Set(['probing', 'downloading', 'merging']);

export class DownloadManager extends EventEmitter {
  dataDir: string;
  downloadDir: string;
  ffmpegPath: string;
  toolsDir: string;
  maxConcurrent: number;
  threads: number;
  onExists: ExistsPolicy;
  categoryFolders: boolean;
  autoRetry: number;
  resumeOnStart: boolean;
  retryDelays: number[];
  readonly throttle = new Throttle(0);
  private jobs = new Map<string, Job>();
  private running = new Map<string, AbortController>();
  private saveTimer: NodeJS.Timeout | null = null;
  private clock: NodeJS.Timeout | null = null;
  private engineInstall: Promise<string> | null = null;
  private closing = false;

  constructor(opts: ManagerOptions) {
    super();
    this.dataDir = opts.dataDir;
    this.downloadDir = opts.downloadDir;
    this.ffmpegPath = opts.ffmpegPath || 'ffmpeg';
    this.toolsDir = opts.toolsDir ?? path.join(opts.dataDir, 'tools');
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.threads = opts.threads ?? 8;
    this.onExists = opts.onExists ?? 'ask';
    this.categoryFolders = opts.categoryFolders ?? false;
    this.autoRetry = opts.autoRetry ?? 3;
    this.resumeOnStart = opts.resumeOnStart ?? true;
    this.retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS_S;
    this.throttle.setLimit(opts.speedLimit ?? 0);
  }

  private get dbFile(): string { return path.join(this.dataDir, 'jobs.json'); }
  private get tmpRoot(): string { return path.join(this.dataDir, 'tmp'); }

  async init(): Promise<this> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.downloadDir, { recursive: true });
    try {
      for (const raw of JSON.parse(await fs.readFile(this.dbFile, 'utf8')) as Partial<Job>[]) {
        const j = withDefaults(raw);
        // Anything in flight when the app died is picked up again (or parked, per the setting).
        if (IN_FLIGHT.has(j.status) || j.status === 'queued') j.status = this.resumeOnStart ? 'queued' : 'paused';
        j.speed = 0;
        this.jobs.set(j.id, j);
      }
    } catch { /* first run */ }
    // Scheduled downloads and retry back-offs come due on a 1 s clock.
    this.clock = setInterval(() => this.pump(), 1000);
    this.clock.unref();
    this.pump();
    return this;
  }

  list(): JobView[] { return [...this.jobs.values()].map(view); }

  /** Change limits and behaviour at runtime. */
  configure(o: Partial<Pick<ManagerOptions, 'maxConcurrent' | 'threads' | 'onExists' | 'categoryFolders' | 'speedLimit' | 'autoRetry' | 'resumeOnStart' | 'downloadDir'>>): void {
    if (o.maxConcurrent) this.maxConcurrent = o.maxConcurrent;
    if (o.threads) this.threads = o.threads;
    if (o.onExists) this.onExists = o.onExists;
    if (o.categoryFolders !== undefined) this.categoryFolders = o.categoryFolders;
    if (o.speedLimit !== undefined) this.throttle.setLimit(o.speedLimit);
    if (o.autoRetry !== undefined) this.autoRetry = o.autoRetry;
    if (o.resumeOnStart !== undefined) this.resumeOnStart = o.resumeOnStart;
    if (o.downloadDir) this.downloadDir = o.downloadDir;
    this.pump();
  }

  /** Add a download. Returns the job id immediately; work starts when a slot is free. */
  add(url: string, o: AddOptions = {}): string {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links are supported');
    const checksum = o.checksum?.trim() ? { ...parseChecksum(o.checksum), state: 'pending' as const } : undefined;
    const scheduled = !!o.startAt && o.startAt > Date.now() + 1000;
    const job: Job = {
      id: randomUUID(), url, status: scheduled ? 'scheduled' : 'queued', createdAt: Date.now(),
      headers: buildHeaders(o.headers, { referer: o.referer, userAgent: o.userAgent, cookies: o.cookies }),
      filename: o.filename?.trim() ? sanitizeFilename(o.filename.trim()) : null,
      quality: o.quality ?? 'best', threads: o.threads ?? this.threads,
      kind: null, size: null, downloaded: 0, speed: 0, progress: 0, error: null, note: null, output: null,
      state: {}, priority: o.priority ?? 0, startAt: scheduled ? o.startAt! : null, attempts: 0, category: 'other',
      ...(o.cookiesFile ? { cookiesFile: o.cookiesFile } : {}),
      ...(o.saveDir ? { saveDir: o.saveDir } : {}),
      ...(o.onExists ? { onExists: o.onExists } : {}),
      ...(checksum ? { checksum } : {}),
    };
    if (job.filename) job.category = categoryOf(job.filename);
    this.jobs.set(job.id, job);
    this.changed(job, true);
    this.pump();
    return job.id;
  }

  /* ---------- user controls ---------- */
  pause(id: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    this.running.get(id)?.abort();
    if (['queued', 'scheduled'].includes(j.status)) { j.status = 'paused'; j.startAt = null; j.note = null; this.changed(j, true); }
  }
  resume(id: string): void {
    const j = this.jobs.get(id);
    if (!j || !['paused', 'error', 'cancelled'].includes(j.status)) return;
    j.status = 'queued'; j.error = null; j.note = null; j.attempts = 0; j.startAt = null; j.finishedAt = undefined;
    this.changed(j, true); this.pump();
  }
  pauseAll(): void { for (const j of this.jobs.values()) if (['queued', 'scheduled', 'probing', 'downloading'].includes(j.status)) this.pause(j.id); }
  resumeAll(): void { for (const j of this.jobs.values()) if (j.status === 'paused') this.resume(j.id); }

  /** Stop a download, discard what was fetched, and keep it in the history as cancelled. */
  async cancel(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j || ['done', 'cancelled'].includes(j.status)) return;
    j.cancelling = true;
    const ac = this.running.get(id);
    if (ac) { ac.abort(); return; } // run()'s handler finishes the job off
    await this.finishCancel(j);
  }

  private async finishCancel(j: Job): Promise<void> {
    await this.discardPartial(j);
    j.cancelling = false; j.status = 'cancelled'; j.speed = 0; j.progress = 0; j.downloaded = 0; j.note = null;
    j.state = {}; j.startAt = null; j.conflictPath = null; j.finishedAt = Date.now();
    this.changed(j, true); this.pump();
  }

  private async discardPartial(j: Job): Promise<void> {
    await rmrf(path.join(this.tmpRoot, j.id));
    if (j.partFile) { await fs.rm(j.partFile, { force: true }); j.partFile = null; }
  }

  /** The user's answer when the target file already exists. */
  resolveConflict(id: string, choice: 'replace' | 'rename'): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'conflict') return;
    j.conflictResolved = true; j.replace = choice === 'replace'; j.conflictPath = null;
    j.status = 'queued'; this.changed(j, true); this.pump();
  }

  setPriority(id: string, p: Priority): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.priority = p; this.changed(j, true); this.pump();
  }

  /** startAt = null starts a scheduled/paused download right away. */
  schedule(id: string, startAt: number | null): void {
    const j = this.jobs.get(id);
    if (!j || !['queued', 'scheduled', 'paused'].includes(j.status)) return;
    if (startAt && startAt > Date.now() + 1000) { j.startAt = startAt; j.status = 'scheduled'; }
    else { j.startAt = null; j.status = 'queued'; }
    j.note = null; this.changed(j, true); this.pump();
  }

  /** Check a finished file against a checksum the user supplies. */
  async verify(id: string, checksum: string): Promise<JobView> {
    const j = this.jobs.get(id);
    if (!j?.output || j.status !== 'done') throw new Error('Only completed downloads can be verified.');
    const want = parseChecksum(checksum);
    j.note = 'Verifying checksum…'; this.changed(j);
    try { j.checksum = await verifyFile(j.output, want); } finally { j.note = null; }
    this.changed(j, true);
    return view(j);
  }

  async remove(id: string, { deleteFiles = false } = {}): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) return;
    const ac = this.running.get(id);
    if (ac) { j.removed = true; ac.abort(); }
    this.jobs.delete(id);
    await this.discardPartial(j);
    if (deleteFiles && j.output) await fs.rm(j.output, { force: true });
    void this.save(); this.emit('removed', id); this.pump();
  }

  /** Version of the installed video-site engine, or null if it has not been downloaded yet. */
  async engineStatus(): Promise<{ installed: boolean; version: string | null }> {
    if (!hasYtdlp(this.toolsDir)) return { installed: false, version: null };
    return { installed: true, version: await ytdlpVersion(ytdlpBinaryPath(this.toolsDir)) };
  }
  async updateEngine(): Promise<string> {
    if (!hasYtdlp(this.toolsDir)) { await this.ensureEngine(); return (await ytdlpVersion(ytdlpBinaryPath(this.toolsDir))) ?? 'unknown'; }
    return updateYtdlp(ytdlpBinaryPath(this.toolsDir));
  }
  private ensureEngine(onProgress?: (d: number, t: number | null) => void, signal?: AbortSignal): Promise<string> {
    if (hasYtdlp(this.toolsDir)) return Promise.resolve(ytdlpBinaryPath(this.toolsDir));
    this.engineInstall ??= installYtdlp(this.toolsDir, onProgress, signal).finally(() => { this.engineInstall = null; });
    return this.engineInstall;
  }

  /* ---------- scheduling ---------- */
  private pump(): void {
    if (this.closing) return;
    const now = Date.now();
    for (const j of this.jobs.values()) {
      if (j.status === 'scheduled' && (j.startAt ?? 0) <= now) { j.startAt = null; j.status = 'queued'; this.changed(j); }
      else if (j.status === 'scheduled' && j.attempts > 0) this.changed(j); // refresh the retry countdown
    }
    let active = this.running.size;
    const queue = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && !this.running.has(j.id))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    for (const j of queue) {
      if (active >= this.maxConcurrent) break;
      active++; void this.run(j);
    }
  }

  private async run(job: Job): Promise<void> {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    const meter = makeMeter(job, () => this.changed(job));
    try {
      job.status = 'probing'; job.note = null; job.error = null; this.changed(job);
      if (!job.kind) await this.identify(job, ac.signal);
      job.status = 'downloading'; this.changed(job);
      if (job.kind === 'hls') await this.runHls(job, ac.signal, meter);
      else if (job.kind === 'extract') await this.runExtract(job, ac.signal, meter);
      else await this.runHttp(job, ac.signal, meter);
      await this.verifyDownloaded(job, ac.signal);
      job.status = 'done'; job.progress = 1; job.speed = 0; job.state = {}; job.attempts = 0; job.finishedAt = Date.now();
      if (!(job.note as string | null)?.startsWith('Added ')) job.note = null;
    } catch (e) {
      job.speed = 0;
      if (job.removed) return;
      if (e instanceof ConflictWait) { /* status already 'conflict' */ }
      else if (job.cancelling) { await this.finishCancel(job); }
      else if (isAbort(e) || ac.signal.aborted) {
        job.status = this.closing ? 'queued' : 'paused'; // closing: pick this up again next start
      } else this.failOrRetry(job, e);
    } finally {
      meter.stop();
      this.running.delete(job.id);
      if (!job.removed) this.changed(job, true);
      this.pump();
    }
  }

  private failOrRetry(job: Job, e: unknown): void {
    const ex = explainError(e);
    if (ex.transient && job.attempts < this.autoRetry) {
      const delay = this.retryDelays[Math.min(job.attempts, this.retryDelays.length - 1)]!;
      job.attempts++;
      job.status = 'scheduled'; job.startAt = Date.now() + delay * 1000; job.error = null;
      job.note = `${ex.message} Retrying (attempt ${job.attempts} of ${this.autoRetry})`;
    } else {
      job.status = 'error'; job.error = ex.message; job.note = null; job.finishedAt = Date.now();
    }
  }

  private async verifyDownloaded(job: Job, signal: AbortSignal): Promise<void> {
    if (!job.checksum || !job.output) return;
    job.status = 'merging'; job.note = 'Verifying checksum…'; job.progress = 0.99; this.changed(job);
    const r = await verifyFile(job.output, job.checksum);
    if (signal.aborted) return;
    job.checksum = r; job.note = null;
    if (r.state === 'mismatch') {
      // Keep the file (the user may still want it) but do not call it a success.
      throw new Error(`Checksum mismatch: the file may be corrupt or altered. Expected ${r.expected.slice(0, 16)}…, got ${r.actual?.slice(0, 16)}…`);
    }
  }

  /* ---------- placement ---------- */
  private targetDir(job: Job): string {
    if (job.saveDir) return job.saveDir;
    return this.categoryFolders ? path.join(this.downloadDir, CATEGORY_FOLDER[job.category]) : this.downloadDir;
  }

  /** Decide the final name/folder, and park the job if the user must choose about an existing file. */
  private async ensureTarget(job: Job, ext = ''): Promise<string> {
    const dir = this.targetDir(job);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, (job.name ?? 'download') + ext);
    if (job.conflictResolved || !(await exists(target))) return dir;
    const policy = job.onExists ?? this.onExists;
    if (policy === 'replace') { job.replace = true; return dir; }
    if (policy === 'rename') return dir;
    job.status = 'conflict'; job.conflictPath = target; job.note = null;
    throw new ConflictWait();
  }

  /** Final path for `name` inside `dir`: the exact name when replacing, otherwise a free "name (1).ext". */
  private async finalPath(job: Job, dir: string, name: string): Promise<string> {
    return job.replace ? path.join(dir, name) : uniquePath(fs, dir, name);
  }

  private async identify(job: Job, signal: AbortSignal): Promise<void> {
    const info = await probe(job.url, job.headers, signal);
    job.finalUrl = info.finalUrl;
    job.size = info.size;
    job.acceptRanges = info.acceptRanges;
    job.etag = info.etag;
    if (info.kind === 'page') {
      // A web page rather than a file: let the video-site engine find the media in it.
      job.kind = 'extract';
      job.name = job.filename || info.filename || job.url;
      job.size = null;
      job.category = job.quality === 'audio' ? 'music' : 'video';
      return;
    }
    job.kind = info.kind;
    job.name = job.filename || (info.kind === 'hls' ? `${info.filename}.mp4` : info.filename);
    job.category = categoryOf(job.name);
  }

  private async runHttp(job: Job, signal: AbortSignal, meter: Meter): Promise<void> {
    const name = job.name ?? 'download';
    const dir = await this.ensureTarget(job);
    if (!job.partFile) {
      // Incomplete files live in their own hidden folder so they are never mistaken for finished downloads.
      const partDir = path.join(dir, '.grabber-incomplete');
      await fs.mkdir(partDir, { recursive: true });
      job.partFile = path.join(partDir, `${name}.${job.id.slice(0, 8)}.part`);
    }
    job.downloaded = (job.state.parts ?? []).reduce((a, p) => a + p.done, 0);
    if (job.size) await assertDiskSpace(dir, job.size - job.downloaded);
    await downloadHttp({
      url: job.finalUrl ?? job.url, headers: job.headers, target: job.partFile, size: job.size,
      acceptRanges: !!job.acceptRanges, etag: job.etag, threads: job.threads, state: job.state, signal, throttle: this.throttle,
      onProgress: (n) => { job.downloaded = Math.max(0, job.downloaded + n); meter.add(n); if (job.size) job.progress = Math.min(1, job.downloaded / job.size); },
    });
    const out = await this.finalPath(job, dir, name);
    await fs.rename(job.partFile, out);
    job.output = out; job.partFile = null;
    if (!job.size) job.size = job.downloaded;
  }

  private async runHls(job: Job, signal: AbortSignal, meter: Meter): Promise<void> {
    const dir = path.join(this.tmpRoot, job.id);
    const outDir = await this.ensureTarget(job);
    if (!job.state.plan) {
      const hls = await loadHls(job.finalUrl ?? job.url, job.headers, signal, job.quality);
      if (!hls.media.endList) throw new Error('Live streams are not supported yet (playlist has no #EXT-X-ENDLIST)');
      job.state.plan = buildPlan(hls.media, 'v');
      job.state.audioPlan = hls.audio ? buildPlan(hls.audio.media, 'a') : [];
      job.state.done = [];
      job.state.isTs = !job.state.plan.some((i) => i.init);
      job.note = hls.variant ? hls.variant.label : null;
    }
    const plan = job.state.plan;
    const audioPlan = job.state.audioPlan ?? [];
    const items = [...plan, ...audioPlan];
    const done = new Set(job.state.done ?? []);
    // Heal state: only trust ids whose file really exists.
    for (const id of [...done]) { try { await fs.access(path.join(dir, id)); } catch { done.delete(id); } }
    job.downloaded = 0;
    const sync = (): void => { job.state.done = [...done]; job.progress = (done.size / items.length) * 0.98; };
    sync();
    await downloadItems({
      items, headers: job.headers, origin: job.finalUrl ?? job.url, dir, done, concurrency: job.threads, signal, throttle: this.throttle,
      onBytes: (n) => { job.downloaded += n; meter.add(n); },
      onItem: sync,
    });

    job.status = 'merging'; job.progress = 0.98; job.note = 'Converting to MP4'; this.changed(job);
    const out = await this.finalPath(job, outDir, job.name ?? 'video.mp4');
    await assertDiskSpace(outDir, job.downloaded * 2);
    const tmpOut = path.join(dir, 'merged.mp4');
    const vFile = path.join(dir, 'video.bin');
    await concatFiles(plan.map((i) => path.join(dir, i.id)), vFile);
    const inputs: MuxInput[] = [{ path: vFile, isTs: !!job.state.isTs }];
    if (audioPlan.length) {
      const aFile = path.join(dir, 'audio.bin');
      await concatFiles(audioPlan.map((i) => path.join(dir, i.id)), aFile);
      inputs.push({ path: aFile, isTs: !audioPlan.some((i) => i.init) });
    }
    if (await ffmpegAvailable(this.ffmpegPath)) await remuxWithFfmpeg(this.ffmpegPath, inputs, tmpOut, signal);
    else if (inputs.length === 1 && job.state.isTs) await remuxTsWithMuxjs(vFile, tmpOut);
    else if (inputs.length === 1) await fs.copyFile(vFile, tmpOut); // already fragmented MP4
    else throw new Error('ffmpeg is required to merge separate audio and video tracks');
    await moveFile(tmpOut, out);
    job.output = out;
    job.size = (await fs.stat(out)).size;
    await rmrf(dir);
  }

  /** Video-site pages (YouTube, Vimeo, ...) and generic pages that embed a player, via yt-dlp. */
  private async runExtract(job: Job, signal: AbortSignal, meter: Meter): Promise<void> {
    job.note = 'Preparing video engine';
    const bin = await this.ensureEngine((d, t) => {
      job.note = t ? `Downloading video engine ${Math.round((d / t) * 100)}%` : 'Downloading video engine';
      this.changed(job);
    }, signal);
    const ctx = {
      bin, ffmpeg: this.ffmpegPath, quality: job.quality, headers: job.headers, threads: job.threads,
      rateLimit: this.throttle.limit, ...(job.cookiesFile ? { cookiesFile: job.cookiesFile } : {}),
    };

    if (!job.state.extracted) {
      job.note = 'Reading video details';
      this.changed(job);
      const info = await fetchInfo(ctx, job.url, signal);
      const entries = (info.entries ?? []).filter((e): e is NonNullable<typeof e> => !!e);
      if (info._type === 'playlist' && entries.length) {
        // A playlist/channel URL becomes one job per video.
        let n = 0;
        for (const e of entries.slice(0, 200)) {
          const u = e.webpage_url ?? e.url;
          if (u && /^https?:\/\//i.test(u)) {
            this.add(u, { headers: job.headers, quality: job.quality, threads: job.threads, priority: job.priority, ...(job.saveDir ? { saveDir: job.saveDir } : {}), ...(job.cookiesFile ? { cookiesFile: job.cookiesFile } : {}) });
            n++;
          }
        }
        job.name = info.title || job.name;
        job.output = null;
        job.note = `Added ${n} videos from this playlist`;
        return;
      }
      job.name = sanitizeFilename(job.filename?.replace(/\.[^.]+$/, '') || info.title || info.id || 'video');
      job.size = info.filesize ?? info.filesize_approx ?? null;
      job.state.extracted = true;
      job.state.streams = info.requested_formats?.length || 1;
    }
    const ext = job.quality === 'audio' ? '.mp3' : '.mp4';
    const dir = await this.ensureTarget(job, ext);
    const streams = job.state.streams ?? 1;
    job.note = null;
    this.changed(job);
    const stem = job.replace ? path.join(dir, job.name ?? 'video') : await this.uniqueStem(dir, job.name ?? 'video', ext);
    let lastBytes = 0;
    let lastStream = 0;
    const file = await ytdlpDownload({
      ctx: { ...ctx, overwrite: !!job.replace }, url: job.url, outStem: stem, signal,
      onProgress: (p, idx) => {
        if (idx !== lastStream) { lastStream = idx; lastBytes = 0; }
        meter.add(Math.max(0, p.downloaded - lastBytes));
        lastBytes = p.downloaded;
        const frac = p.total ? Math.min(1, p.downloaded / p.total) : 0;
        job.progress = Math.min(0.98, (Math.min(idx, streams - 1) + frac) / streams);
        job.downloaded = p.downloaded;
        if (p.total && streams === 1) job.size = p.total;
      },
      onPhase: () => { job.status = 'merging'; job.note = 'Merging audio and video'; job.progress = 0.98; this.changed(job); },
    });
    job.output = file;
    try { job.size = (await fs.stat(file)).size; } catch { /* keep estimate */ }
    job.name = path.basename(file);
    job.category = categoryOf(job.name);
    job.note = null;
  }

  private async uniqueStem(dir: string, stem: string, ext: string): Promise<string> {
    for (let i = 0; ; i++) {
      const s = i === 0 ? stem : `${stem} (${i})`;
      if (!(await exists(path.join(dir, s + ext)))) return path.join(dir, s);
    }
  }

  /* ---------- persistence ---------- */
  private changed(job: Job, immediate = false): void {
    this.emit('update', view(job));
    if (immediate) void this.save(); else this.scheduleSave();
  }
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save(); }, 750);
  }
  private async save(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const tmp = `${this.dbFile}.tmp`;
    try { await fs.writeFile(tmp, JSON.stringify([...this.jobs.values()])); await fs.rename(tmp, this.dbFile); } catch { /* best effort */ }
  }

  /** Flush state and stop in-flight jobs (call on app quit). They resume on the next start. */
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.clock) clearInterval(this.clock);
    for (const ac of this.running.values()) ac.abort();
    for (let i = 0; i < 40 && this.running.size; i++) await new Promise((r) => setTimeout(r, 50));
    await this.save();
  }
}

/* ---------- helpers ---------- */
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** Rename, falling back to copy+delete when the temp folder is on another disk. */
async function moveFile(from: string, to: string): Promise<void> {
  try { await fs.rename(from, to); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.copyFile(from, to); await fs.rm(from, { force: true });
  }
}

async function assertDiskSpace(dir: string, needed: number): Promise<void> {
  if (needed <= 0) return;
  try {
    const s = await fs.statfs(dir);
    if (s.bavail * s.bsize < needed) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw e;
    /* statfs unsupported: let the write fail naturally */
  }
}

function withDefaults(j: Partial<Job>): Job {
  return {
    id: j.id!, url: j.url!, status: j.status ?? 'paused', createdAt: j.createdAt ?? Date.now(), headers: j.headers ?? {},
    filename: j.filename ?? null, quality: j.quality ?? 'best', threads: j.threads ?? 8, kind: j.kind ?? null,
    size: j.size ?? null, downloaded: j.downloaded ?? 0, speed: 0, progress: j.progress ?? 0, error: j.error ?? null,
    note: j.note ?? null, output: j.output ?? null, state: j.state ?? {},
    priority: j.priority ?? 0, startAt: j.startAt ?? null, attempts: j.attempts ?? 0,
    category: j.category ?? categoryOf(j.name ?? j.filename ?? ''),
    ...j,
  } as Job;
}

function makeMeter(job: Job, notify: () => void): Meter {
  let bytes = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const inst = bytes / Math.max(0.001, (now - last) / 1000);
    job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    bytes = 0; last = now; notify();
  }, 500);
  return { add: (n) => { bytes += Math.max(0, n); }, stop: () => clearInterval(timer) };
}

const view = (j: Job): JobView => ({
  id: j.id, url: j.url, status: j.status, name: j.name || j.filename || j.url, kind: j.kind,
  size: j.size, downloaded: j.downloaded, speed: Math.round(j.speed || 0), progress: j.progress,
  error: j.error, note: j.note, output: j.output, quality: j.quality, createdAt: j.createdAt,
  finishedAt: j.finishedAt ?? null, priority: j.priority, startAt: j.startAt, category: j.category,
  conflictPath: j.conflictPath ?? null, checksum: j.checksum ?? null,
});

export type { Category };
