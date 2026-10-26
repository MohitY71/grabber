import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePlaylist } from './hls-parse.ts';
import { sleep, isAbort, isFatal, FatalError, scopeHeaders } from './util.ts';
import type { Throttle } from './throttle.ts';
import type { Headers, HlsKey, HlsVariant, MediaPlaylist, PlanItem, Quality } from './types.ts';

async function fetchText(url: string, headers: Headers, signal: AbortSignal | undefined, origin: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url, { headers: scopeHeaders(headers, url, origin), redirect: 'follow', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return { text: await res.text(), url: res.url || url };
}

export interface LoadedHls {
  variants: HlsVariant[];
  variant?: HlsVariant;
  media: MediaPlaylist;
  mediaUrl: string;
  audio: { media: MediaPlaylist; name: string | undefined } | null;
}

/** Variants are sorted best-first. A numeric quality means "the best one not taller than N". */
export function pickVariant(variants: HlsVariant[], quality: Quality): HlsVariant | undefined {
  if (quality === 'worst') return variants.at(-1);
  const cap = Number(quality);
  if (Number.isFinite(cap) && cap > 0) {
    return variants.find((v) => v.height !== null && v.height <= cap) ?? variants.at(-1);
  }
  return variants[0];
}

/** Resolve a URL to a media playlist, picking a variant when it is a master playlist. */
export async function loadHls(url: string, headers: Headers, signal: AbortSignal | undefined, quality: Quality = 'best'): Promise<LoadedHls> {
  const first = await fetchText(url, headers, signal, url);
  const pl = parsePlaylist(first.text, first.url);
  if (pl.type === 'media') return { variants: [], media: pl, mediaUrl: first.url, audio: null };

  const variant = pickVariant(pl.variants, quality);
  if (!variant) throw new Error('Master playlist has no variants');
  const second = await fetchText(variant.url, headers, signal, url);
  const media = parsePlaylist(second.text, second.url);
  if (media.type !== 'media') throw new Error('Nested master playlists are not supported');

  // Demuxed audio rendition (video-only variant + separate audio playlist).
  let audio: LoadedHls['audio'] = null;
  const group = pl.media.filter((m) => m.type === 'AUDIO' && m.groupId === variant.audioGroup && m.url);
  const chosen = group.find((m) => m.default) ?? group[0];
  if (chosen?.url) {
    const a = await fetchText(chosen.url, headers, signal, url);
    const ap = parsePlaylist(a.text, a.url);
    if (ap.type === 'media') audio = { media: ap, name: chosen.name };
  }
  return { variants: pl.variants, variant, media, mediaUrl: second.url, audio };
}

/** Flat list of byte sources (init maps + segments) with a stable file name each. */
export function buildPlan(media: MediaPlaylist, prefix: string): PlanItem[] {
  const items: PlanItem[] = [];
  let lastMap: string | null = null;
  for (const s of media.segments) {
    if (s.map) {
      const sig = s.map.url + (s.map.byteRange || '');
      if (sig !== lastMap) {
        lastMap = sig;
        let range: PlanItem['range'] = null;
        if (s.map.byteRange) {
          const [len, off] = s.map.byteRange.split('@');
          range = { start: Number(off || 0), end: Number(off || 0) + Number(len) - 1 };
        }
        items.push({ id: `${prefix}init${items.length}`, url: s.map.url, range, key: null, init: true });
      }
    }
    items.push({ id: `${prefix}${String(s.index).padStart(6, '0')}`, url: s.url, range: s.range, key: s.key, seq: s.seq });
  }
  return items;
}

async function readThrottled(res: Response, throttle: Throttle, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await throttle.take(value.length, signal);
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function getKey(uri: string, headers: Headers, origin: string | undefined, signal?: AbortSignal): Promise<CryptoKey> {
  let p = keyCache.get(uri);
  if (!p) {
    p = fetch(uri, { headers: scopeHeaders(headers, uri, origin), redirect: 'follow', signal }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching key`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length !== 16) throw new FatalError('Unexpected AES key length');
      return crypto.subtle.importKey('raw', buf, 'AES-CBC', false, ['decrypt']);
    });
    p.catch(() => keyCache.delete(uri));
    keyCache.set(uri, p);
  }
  return p;
}

function ivFor(key: HlsKey, seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
  }
  return iv;
}

async function fetchItem(item: PlanItem, headers: Headers, origin: string | undefined, signal?: AbortSignal, throttle?: Throttle): Promise<Uint8Array> {
  const h: Headers = { ...scopeHeaders(headers, item.url, origin) };
  if (item.range) h.range = `bytes=${item.range.start}-${item.range.end}`;
  const res = await fetch(item.url, { headers: h, redirect: 'follow', signal });
  if (!res.ok) {
    const msg = `HTTP ${res.status}`;
    throw [404, 403, 410].includes(res.status) ? new FatalError(msg) : new Error(msg);
  }
  let data: Uint8Array = throttle?.limit ? await readThrottled(res, throttle, signal) : new Uint8Array(await res.arrayBuffer());
  const k = item.key;
  if (k) {
    if (k.method !== 'AES-128' || !k.uri) throw new FatalError(`Unsupported encryption ${k.method} (DRM-protected streams cannot be downloaded)`);
    const ck = await getKey(k.uri, headers, origin, signal);
    data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(k, item.seq ?? 0) as BufferSource }, ck, data as BufferSource));
  }
  return data;
}

export interface DownloadItemsArgs {
  items: PlanItem[];
  headers: Headers;
  /** The URL the user asked for; credentials are only sent to this site. */
  origin?: string;
  dir: string;
  /** Mutated so callers can persist resume state. */
  done: Set<string>;
  concurrency?: number;
  signal?: AbortSignal;
  onBytes?: (n: number) => void;
  onItem?: (item: PlanItem) => void;
  throttle?: Throttle;
  retries?: number;
}

/**
 * Download every plan item into `dir`. Each file is written to *.tmp then renamed,
 * so a partial file is never mistaken for a finished one.
 */
export async function downloadItems(a: DownloadItemsArgs): Promise<void> {
  await fs.mkdir(a.dir, { recursive: true });
  const queue = a.items.filter((i) => !a.done.has(i.id));
  const retries = a.retries ?? 5;
  let cursor = 0;
  let failed: unknown = null;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const item = queue[cursor++];
      if (!item) return;
      let attempt = 0;
      for (;;) {
        try {
          const data = await fetchItem(item, a.headers, a.origin, a.signal, a.throttle);
          const file = path.join(a.dir, item.id);
          await fs.writeFile(`${file}.tmp`, data);
          await fs.rename(`${file}.tmp`, file);
          a.done.add(item.id);
          a.onBytes?.(data.length);
          a.onItem?.(item);
          break;
        } catch (e) {
          if (isAbort(e) || a.signal?.aborted) throw e;
          if (isFatal(e) || ++attempt > retries) { failed = e; throw e; }
          await sleep(Math.min(8000, 500 * 2 ** attempt), a.signal);
        }
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(a.concurrency ?? 8, queue.length) }, worker));
  const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad) throw bad.reason;
}
