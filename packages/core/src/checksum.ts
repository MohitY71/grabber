import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { ChecksumState, HashAlgo } from './types.ts';

const BY_LENGTH: Record<number, HashAlgo> = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };

/** Accepts "sha256:abc…", "SHA-256 abc…", "abc…  filename" or a bare hex digest. */
export function parseChecksum(input: string): { algo: HashAlgo; expected: string } {
  const s = input.trim();
  const named = /^(md5|sha-?1|sha-?256|sha-?512)\s*[:=\s]\s*([0-9a-f]+)/i.exec(s);
  const hex = (named ? named[2]! : s.split(/\s+/)[0]!).toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('That does not look like a checksum (expected hexadecimal digits).');
  const algo: HashAlgo = named ? (named[1]!.toLowerCase().replace('-', '') as HashAlgo) : BY_LENGTH[hex.length]!;
  if (!algo) throw new Error(`Unrecognized checksum length (${hex.length} characters). Use MD5, SHA-1, SHA-256 or SHA-512.`);
  const want = { md5: 32, sha1: 40, sha256: 64, sha512: 128 }[algo];
  if (hex.length !== want) throw new Error(`A ${algo.toUpperCase()} checksum has ${want} characters, but this one has ${hex.length}.`);
  return { algo, expected: hex };
}

export async function hashFile(file: string, algo: HashAlgo): Promise<string> {
  const h = createHash(algo);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function verifyFile(file: string, expect: { algo: HashAlgo; expected: string }): Promise<ChecksumState> {
  const actual = await hashFile(file, expect.algo);
  return { algo: expect.algo, expected: expect.expected, actual, state: actual === expect.expected ? 'ok' : 'mismatch' };
}
