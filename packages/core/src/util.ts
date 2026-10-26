import path from 'node:path';
import type fsPromises from 'node:fs/promises';

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export const isAbort = (e: unknown): boolean => {
  const err = e as { name?: string; code?: string } | null;
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
};

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** An Error that must not be retried (404, 403, unsupported encryption, ...). */
export class FatalError extends Error {
  readonly fatal = true;
}
export const isFatal = (e: unknown): boolean => (e as { fatal?: boolean } | null)?.fatal === true;

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'download').slice(0, 180);
}

export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(path.posix.basename(u.pathname));
    return sanitizeFilename(base || u.hostname);
  } catch {
    return 'download';
  }
}

export function filenameFromDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(cd);
  if (star?.[1]) { try { return sanitizeFilename(decodeURIComponent(star[1])); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain?.[1] ? sanitizeFilename(plain[1]) : null;
}

/** Pick a path that does not exist yet: name.ext, name (1).ext ... */
export async function uniquePath(fs: Pick<typeof fsPromises, 'access'>, dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
}

export function mimeToExt(type: string): string {
  const t = (type || '').split(';')[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'application/pdf': '.pdf',
    'application/zip': '.zip', 'image/jpeg': '.jpg', 'image/png': '.png',
  };
  return map[t] ?? '';
}

/** Registrable-ish domain (last two labels) - good enough to keep credentials on the site they belong to. */
const baseDomain = (host: string): string => host.split('.').slice(-2).join('.');

/** Drop credentials from headers when a request goes to a different site than the one they were issued for. */
export function scopeHeaders<T extends Record<string, string>>(headers: T, targetUrl: string, originUrl: string | undefined): T {
  if (!originUrl || (!headers.cookie && !headers.authorization)) return headers;
  try {
    if (baseDomain(new URL(targetUrl).hostname) === baseDomain(new URL(originUrl).hostname)) return headers;
  } catch { /* fall through and strip */ }
  const { cookie: _c, authorization: _a, ...rest } = headers;
  return rest as T;
}
