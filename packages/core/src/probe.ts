import path from 'node:path';
import { filenameFromDisposition, filenameFromUrl, mimeToExt } from './util.ts';
import type { Headers, ProbeResult } from './types.ts';

const HLS_TYPES = /mpegurl/i;
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function buildHeaders(extra: Headers = {}, ctx: { referer?: string; userAgent?: string; cookies?: string } = {}): Headers {
  const lower = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v]));
  const h: Headers = { 'user-agent': ctx.userAgent || DEFAULT_UA, accept: '*/*', ...lower };
  if (ctx.referer && !h.referer) h.referer = ctx.referer;
  if (ctx.cookies && !h.cookie) h.cookie = ctx.cookies;
  return h;
}

/**
 * Work out what a URL is: a plain file (with/without range support), an HLS playlist, or a web page.
 * A 1-byte ranged GET proves range support (206) and reveals the total size.
 */
export async function probe(url: string, headers: Headers = {}, signal?: AbortSignal): Promise<ProbeResult> {
  const res = await fetch(url, { headers: { ...headers, range: 'bytes=0-0' }, redirect: 'follow', signal });
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.url || url;
  const disposition = res.headers.get('content-disposition');
  const etag = res.headers.get('etag') || res.headers.get('last-modified') || null;
  let size: number | null = null;
  let acceptRanges = false;

  if (res.status === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (m) { size = Number(m[1]); acceptRanges = true; }
  } else {
    const len = Number(res.headers.get('content-length'));
    size = Number.isFinite(len) && len > 0 ? len : null;
  }
  await res.body?.cancel().catch(() => {});

  let isHls = HLS_TYPES.test(contentType) || /\.m3u8(\?|#|$)/i.test(finalUrl);
  // HTML pages and DASH manifests are not files to save: the video engine resolves the media inside them.
  const isHtml = (/text\/html|application\/xhtml/i.test(contentType) && !disposition) || /dash\+xml/i.test(contentType) || /\.mpd(\?|#|$)/i.test(finalUrl);
  const smallOrUnknown = size === null || size <= 2_000_000;
  // Servers often serve playlists as text/plain or octet-stream; peek at the first bytes.
  if (!isHls && !isHtml && smallOrUnknown && !/^(video|audio|image)\//i.test(contentType)) {
    const head = await fetch(finalUrl, { headers, redirect: 'follow', signal });
    isHls = /^\s*#EXTM3U/.test(await readUpTo(head, 512));
  }

  let filename = filenameFromDisposition(disposition) || filenameFromUrl(finalUrl);
  if (isHls) filename = filename.replace(/\.m3u8?$/i, '') || 'video';
  else if (!path.extname(filename)) filename += mimeToExt(contentType);

  const kind = isHls ? 'hls' : isHtml ? 'page' : 'http';
  return { url, finalUrl, kind, size, acceptRanges, contentType, etag, filename };
}

async function readUpTo(res: Response, n: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (out.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return out;
}
