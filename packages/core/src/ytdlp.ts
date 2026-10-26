import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FatalError, isAbort } from './util.ts';
import type { Headers, Quality } from './types.ts';

/**
 * Video-site support (YouTube, Vimeo, ...) via the open-source yt-dlp extractor.
 * Sites like these hand the player short-lived, chunked or separate audio/video streams, so there is
 * no single file URL to fetch; yt-dlp knows how to resolve them. Streams that are DRM-protected
 * (Widevine/FairPlay) are refused by yt-dlp and are reported as such - they cannot be downloaded.
 */

export interface YtInfo {
  _type?: string;
  id?: string;
  title?: string;
  duration?: number;
  ext?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  requested_formats?: unknown[];
  entries?: Array<{ url?: string; webpage_url?: string; id?: string } | null>;
}

export function ytdlpAsset(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export const ytdlpBinaryPath = (toolsDir: string): string =>
  path.join(toolsDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

export const hasYtdlp = (toolsDir: string): boolean => fs.existsSync(ytdlpBinaryPath(toolsDir));

/** Download the standalone yt-dlp build for this OS into `toolsDir` (first use only). */
export async function installYtdlp(toolsDir: string, onProgress?: (done: number, total: number | null) => void, signal?: AbortSignal): Promise<string> {
  const bin = ytdlpBinaryPath(toolsDir);
  await fsp.mkdir(toolsDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset()}`;
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Could not download the video engine (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || null;
  const tmp = `${bin}.download`;
  const ws = fs.createWriteStream(tmp);
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', () => r()));
      done += value.length;
      onProgress?.(done, total);
    }
    await new Promise<void>((r) => ws.end(() => r()));
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, bin);
  } catch (e) {
    ws.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return bin;
}

/** Runs to completion and returns stdout/stderr. */
function capture(bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d; });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d).slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function ytdlpVersion(bin: string): Promise<string | null> {
  try { const r = await capture(bin, ['--version']); return r.code === 0 ? r.stdout.trim() : null; } catch { return null; }
}

/** yt-dlp updates itself in place; sites change often so this keeps extractors working. */
export async function updateYtdlp(bin: string): Promise<string> {
  const r = await capture(bin, ['-U']);
  if (r.code !== 0) throw new Error(friendlyYtdlpError(r.stderr) || 'Update failed');
  return (await ytdlpVersion(bin)) ?? 'unknown';
}

/** Format selection, expressed with yt-dlp's -S sorter so a cap falls back gracefully. */
export function formatArgs(quality: Quality): string[] {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  if (quality === 'worst') return ['-f', 'wv*+wa/w', '--merge-output-format', 'mp4'];
  const cap = Number(quality);
  const res = Number.isFinite(cap) && cap > 0 ? `res:${cap}` : 'res';
  return ['-S', `${res},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4'];
}

export interface YtContext {
  bin: string;
  ffmpeg?: string;
  quality: Quality;
  headers: Headers;
  threads: number;
  cookiesFile?: string;
  /** bytes/second, 0 = unlimited */
  rateLimit?: number;
  overwrite?: boolean;
}

function commonArgs(c: YtContext): string[] {
  const a = ['--no-playlist', '--no-colors', '--no-mtime', '--retries', '10', '--fragment-retries', '10',
    '--concurrent-fragments', String(Math.max(1, Math.min(c.threads, 16)))];
  if (c.ffmpeg && c.ffmpeg !== 'ffmpeg') a.push('--ffmpeg-location', c.ffmpeg);
  if (c.rateLimit && c.rateLimit > 0) a.push('--limit-rate', String(Math.floor(c.rateLimit)));
  if (c.overwrite) a.push('--force-overwrites');
  const h = c.headers;
  if (h['user-agent']) a.push('--user-agent', h['user-agent']);
  if (h.referer) a.push('--referer', h.referer);
  // Cookies go through a cookie file, which yt-dlp scopes per domain; a raw Cookie header would reach every host it talks to.
  if (c.cookiesFile) a.push('--cookies', c.cookiesFile);
  return a;
}

export async function fetchInfo(c: YtContext, url: string, signal?: AbortSignal): Promise<YtInfo> {
  const r = await capture(c.bin, ['-J', '--no-warnings', ...commonArgs(c), ...formatArgs(c.quality), url], signal);
  if (r.code !== 0) throw new FatalError(friendlyYtdlpError(r.stderr));
  try { return JSON.parse(r.stdout) as YtInfo; } catch { throw new FatalError('The video engine returned an unexpected response'); }
}

export interface YtProgress {
  downloaded: number;
  total: number | null;
  speed: number;
  eta: number | null;
}

const num = (s: string | undefined): number | null => {
  const n = Number(s);
  return s && s !== 'NA' && s !== 'None' && Number.isFinite(n) ? n : null;
};

/** `GRB|downloaded|total|total_estimate|speed|eta` as emitted by our --progress-template. */
export function parseProgressLine(line: string): YtProgress | null {
  if (!line.startsWith('GRB|')) return null;
  const f = line.split('|');
  const downloaded = num(f[1]);
  if (downloaded === null) return null;
  return { downloaded, total: num(f[2]) ?? num(f[3]), speed: num(f[4]) ?? 0, eta: num(f[5]) };
}

export interface YtDownloadArgs {
  ctx: YtContext;
  url: string;
  /** Output path template without extension, e.g. /dl/My Video (yt-dlp appends .%(ext)s). */
  outStem: string;
  signal?: AbortSignal;
  onProgress: (p: YtProgress, streamIndex: number) => void;
  onPhase: (phase: 'merging') => void;
}

/** Runs the download; resolves with the final file path. Re-running resumes the .part files. */
export function ytdlpDownload(a: YtDownloadArgs): Promise<string> {
  const args = [
    '--newline', '--progress',
    '--progress-template', 'download:GRB|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:GRBFILE|%(filepath)s',
    ...commonArgs(a.ctx), ...formatArgs(a.ctx.quality),
    '-o', `${a.outStem}.%(ext)s`, a.url,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(a.ctx.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: a.signal, windowsHide: true });
    let stream = -1;
    let lastDownloaded = Infinity;
    let file = '';
    let stderr = '';
    let buf = '';
    const onLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('GRBFILE|')) { file = line.slice(8); return; }
      if (line.startsWith('[download] Destination:')) { stream++; lastDownloaded = Infinity; return; }
      if (/^\[(Merger|ExtractAudio|VideoRemuxer|FixupM3u8|Fixup)/.test(line)) { a.onPhase('merging'); return; }
      const pr = parseProgressLine(line);
      if (pr) {
        // HLS/DASH reuse one "Destination"; a drop in bytes means a new stream started.
        if (pr.downloaded < lastDownloaded * 0.5 && lastDownloaded !== Infinity && stream >= 0) stream++;
        lastDownloaded = pr.downloaded;
        a.onProgress(pr, Math.max(0, stream));
      }
    };
    p.stdout.on('data', (d: Buffer) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d).slice(-20000); });
    p.on('error', (e) => reject(isAbort(e) ? e : new Error(`Could not start the video engine: ${e.message}`)));
    p.on('close', (code, sig) => {
      if (buf) onLine(buf);
      if (a.signal?.aborted || sig) { const e = new Error('aborted'); e.name = 'AbortError'; return reject(e); }
      if (code === 0 && file) return resolve(file);
      if (code === 0) return reject(new Error('Download finished but the output file was not reported'));
      reject(new FatalError(friendlyYtdlpError(stderr)));
    });
  });
}

/** Turn yt-dlp's stderr into one line a person can act on. */
export function friendlyYtdlpError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR:')) ?? lines.at(-1) ?? 'Unknown error';
  const msg = err.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '');
  if (/drm/i.test(err)) return 'This video is DRM-protected and cannot be downloaded.';
  if (/unsupported url/i.test(err)) return 'No downloadable video was found on this page. Open it in the Browser tab and press play so the stream can be detected.';
  if (/sign in|login|private video|members-only|age/i.test(err)) return `This video needs you to be signed in (${msg}). Open it in the Browser tab, sign in, then download from there.`;
  if (/video unavailable|not available|removed|geo/i.test(err)) return `This video is not available (${msg}).`;
  if (/confirm you.re not a bot|HTTP Error 429|too many requests/i.test(err)) return 'The site is rate-limiting or asking for verification. Open it in the Browser tab, then try again.';
  return msg.slice(0, 300);
}
