import type { HlsKey, HlsMediaGroup, HlsSegment, HlsVariant, MasterPlaylist, MediaPlaylist, Playlist } from './types.ts';

/** Minimal but spec-aware HLS playlist parser (master + media). */

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]!] = m[3] !== undefined ? m[3] : m[2]!;
  return out;
}

const abs = (u: string, base: string): string => new URL(u, base).href;
const after = (l: string): string => l.slice(l.indexOf(':') + 1);

export function parsePlaylist(text: string, baseUrl: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF')) ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): MasterPlaylist {
  const variants: HlsVariant[] = [];
  const media: HlsMediaGroup[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(after(l));
      const uri = lines[i + 1];
      if (!uri || uri.startsWith('#')) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: abs(uri, baseUrl),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: w || null,
        height: h || null,
        codecs: a.CODECS || null,
        audioGroup: a.AUDIO || null,
        label: h ? `${h}p` : a.BANDWIDTH ? `${Math.round(Number(a.BANDWIDTH) / 1000)} kbps` : 'default',
      });
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(after(l));
      media.push({
        type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE,
        default: a.DEFAULT === 'YES', url: a.URI ? abs(a.URI, baseUrl) : null,
      });
    }
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { type: 'master', variants, media };
}

function parseMedia(lines: string[], baseUrl: string): MediaPlaylist {
  const segments: HlsSegment[] = [];
  let seq = 0;
  let key: HlsKey | null = null;
  let map: HlsSegment['map'] = null;
  let duration = 0;
  let byteRange: string | null = null;
  const lastRangeEnd = new Map<string, number>();
  let endList = false;
  let target = 0;
  let playlistType: string | null = null;

  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = l.split(':')[1] ?? null;
    else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (l.startsWith('#EXTINF:')) duration = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) byteRange = l.slice(17);
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD ?? '', uri: a.URI ? abs(a.URI, baseUrl) : null, iv: a.IV || null, keyFormat: a.KEYFORMAT || 'identity' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = a.URI ? { url: abs(a.URI, baseUrl), byteRange: a.BYTERANGE || null } : null;
    } else if (!l.startsWith('#')) {
      const url = abs(l, baseUrl);
      let range: HlsSegment['range'] = null;
      if (byteRange) {
        const [len, off] = byteRange.split('@');
        const start = off !== undefined ? Number(off) : lastRangeEnd.get(url) ?? 0;
        range = { start, end: start + Number(len) - 1 };
        lastRangeEnd.set(url, range.end + 1);
        byteRange = null;
      }
      segments.push({ index: segments.length, seq: seq + segments.length, url, duration, key, map, range });
      duration = 0;
    }
  }
  return { type: 'media', segments, endList: endList || playlistType === 'VOD', targetDuration: target };
}
