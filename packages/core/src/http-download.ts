import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { sleep, isAbort, isFatal, FatalError } from './util.ts';
import type { Throttle } from './throttle.ts';
import type { Headers, Part, ResumeState } from './types.ts';

const MIN_PART = 512 * 1024;

export function planParts(size: number, threads: number): Part[] {
  const n = Math.max(1, Math.min(threads, Math.floor(size / MIN_PART) || 1));
  const base = Math.floor(size / n);
  const parts: Part[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * base;
    const end = i === n - 1 ? size - 1 : start + base - 1;
    parts.push({ start, end, done: 0 });
  }
  return parts;
}

export interface HttpDownloadArgs {
  url: string;
  headers: Headers;
  target: string;
  size: number | null;
  acceptRanges: boolean;
  etag?: string | null;
  threads?: number;
  /** Mutated in place so callers can persist it. Pause = abort the signal; resume = call again with the same state. */
  state: ResumeState;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  throttle?: Throttle;
  retries?: number;
}

/** Multipart ranged download into `target` (a preallocated file). */
export async function downloadHttp(a: HttpDownloadArgs): Promise<void> {
  const exists = await fs.access(a.target).then(() => true, () => false);
  const handle = await fs.open(a.target, exists ? 'r+' : 'w+');
  try {
    if (!a.acceptRanges || !a.size) {
      await singleStream(a, handle);
      return;
    }
    if (!a.state.parts?.length) a.state.parts = planParts(a.size, a.threads ?? 8);
    await handle.truncate(a.size);
    const results = await Promise.allSettled(a.state.parts.map((p) => runPart(a, handle, p)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    await handle.close();
  }
}

async function runPart(a: HttpDownloadArgs, handle: FileHandle, part: Part): Promise<void> {
  const retries = a.retries ?? 5;
  let attempt = 0;
  while (part.start + part.done <= part.end) {
    try {
      const from = part.start + part.done;
      const h: Headers = { ...a.headers, range: `bytes=${from}-${part.end}` };
      if (a.etag) h['if-range'] = a.etag;
      const res = await fetch(a.url, { headers: h, redirect: 'follow', signal: a.signal });
      if (res.status !== 206 || !res.body) {
        await res.body?.cancel().catch(() => {});
        const msg = `Server ignored range request (HTTP ${res.status})`;
        throw res.status === 200 || res.status === 416 ? new FatalError(msg) : new Error(msg);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await a.throttle?.take(value.length, a.signal);
        const room = part.end - (part.start + part.done) + 1;
        const chunk = value.length > room ? value.subarray(0, room) : value;
        await handle.write(chunk, 0, chunk.length, part.start + part.done);
        part.done += chunk.length;
        attempt = 0;
        a.onProgress?.(chunk.length);
        if (chunk !== value) break;
      }
      if (part.start + part.done <= part.end) throw new Error('Connection closed early');
    } catch (e) {
      if (isAbort(e) || a.signal?.aborted) throw e;
      if (isFatal(e) || ++attempt > retries) throw e;
      await sleep(Math.min(8000, 500 * 2 ** attempt), a.signal);
    }
  }
}

/** Fallback for servers without range support or unknown size: one stream, no resume. */
async function singleStream(a: HttpDownloadArgs, handle: FileHandle): Promise<void> {
  const retries = a.retries ?? 5;
  a.state.parts = [];
  let attempt = 0;
  let counted = 0;
  for (;;) {
    try {
      await handle.truncate(0);
      const res = await fetch(a.url, { headers: a.headers, redirect: 'follow', signal: a.signal });
      if (!res.ok || !res.body) throw res.status < 500 ? new FatalError(`HTTP ${res.status}`) : new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      let pos = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        await a.throttle?.take(value.length, a.signal);
        await handle.write(value, 0, value.length, pos);
        pos += value.length;
        counted += value.length;
        a.onProgress?.(value.length);
      }
    } catch (e) {
      if (isAbort(e) || a.signal?.aborted) throw e;
      if (isFatal(e) || ++attempt > retries) throw e;
      a.onProgress?.(-counted); // the retry restarts from byte 0
      counted = 0;
      await sleep(Math.min(8000, 500 * 2 ** attempt), a.signal);
    }
  }
}
