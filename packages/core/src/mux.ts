import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import muxjs from 'mux.js';

/** Concatenate files, in order, into `out` without loading them all in memory. */
export async function concatFiles(files: string[], out: string): Promise<void> {
  const ws = fs.createWriteStream(out);
  try {
    for (const f of files) {
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
  } finally {
    await new Promise<void>((r) => ws.end(() => r()));
  }
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-6).join('\n')}`))));
  });
}

export interface MuxInput { path: string; isTs: boolean }

/** Turn joined stream file(s) into a faststart MP4 by stream copy (no re-encode). Two inputs = video + audio. */
export async function remuxWithFfmpeg(ffmpeg: string, inputs: MuxInput[], out: string, signal?: AbortSignal): Promise<void> {
  const args = ['-y', '-v', 'error', '-fflags', '+genpts'];
  for (const i of inputs) args.push('-i', i.path);
  if (inputs.length > 1) args.push('-map', '0:v:0?', '-map', '1:a:0?');
  args.push('-c', 'copy');
  if (inputs.some((i) => i.isTs)) args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-movflags', '+faststart', out);
  await run(ffmpeg, args, signal);
}

/** Pure-JS fallback (no ffmpeg): MPEG-TS -> fragmented MP4 via mux.js. Single muxed input only. */
export async function remuxTsWithMuxjs(tsPath: string, out: string): Promise<void> {
  const tm = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
  const ws = fs.createWriteStream(out);
  let first = true;
  tm.on('data', (seg) => {
    if (first) { ws.write(Buffer.from(seg.initSegment)); first = false; }
    ws.write(Buffer.from(seg.data));
  });
  for await (const chunk of fs.createReadStream(tsPath, { highWaterMark: 4 * 1024 * 1024 })) {
    const b = chunk as Buffer;
    tm.push(new Uint8Array(b.buffer, b.byteOffset, b.length));
  }
  tm.flush();
  await new Promise<void>((r) => ws.end(() => r()));
  if (first) throw new Error('No playable audio/video found in stream');
}

export async function ffmpegAvailable(ffmpeg: string): Promise<boolean> {
  try { await run(ffmpeg, ['-version']); return true; } catch { return false; }
}

export const rmrf = (p: string): Promise<void> => fsp.rm(p, { recursive: true, force: true });
