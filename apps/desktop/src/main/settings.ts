import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Settings } from '../shared/api.ts';

export const DEFAULTS: Settings = {
  threads: 8, maxConcurrent: 3, quality: 'best', downloadDir: '',
  onExists: 'ask', categoryFolders: false, speedLimitKB: 0, autoRetry: 3, resumeOnStart: true,
  notifications: true, runInBackground: true, keepAwake: true,
  adblock: true, adblockAllow: [],
  apiEnabled: true, apiPort: 17653, apiToken: '',
};

export function loadSettings(file: string): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>; } catch { /* first run */ }
  const s: Settings = { ...DEFAULTS, ...saved };
  if (!s.apiToken) s.apiToken = randomBytes(24).toString('hex'); // pairing secret for browser extensions
  return s;
}

export function saveSettings(file: string, s: Settings): void {
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}
