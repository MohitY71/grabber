import type { ExistsPolicy, JobView, Priority } from '@grabber/core';

export const DEVELOPER = { name: 'Mohit Yadav', email: 'mohit@heygeeks.in' } as const;
export const APP_NAME = 'Grabber';

export interface Settings {
  threads: number;
  maxConcurrent: number;
  /** 'best' | 'worst' | 'audio' | a maximum height such as '1080' */
  quality: string;
  downloadDir: string;
  onExists: ExistsPolicy;
  categoryFolders: boolean;
  /** KB/s across all downloads, 0 = unlimited */
  speedLimitKB: number;
  autoRetry: number;
  resumeOnStart: boolean;
  notifications: boolean;
  /** Closing the window keeps downloads running in the tray / menu bar. */
  runInBackground: boolean;
  keepAwake: boolean;
  adblock: boolean;
  /** Sites where the ad blocker is switched off. */
  adblockAllow: string[];
  apiEnabled: boolean;
  apiPort: number;
  apiToken: string;
}

export interface AddRequest {
  referer?: string;
  /** Reuse the in-app browser's cookies and user agent (needed for pages you are signed in to). */
  useBrowserSession?: boolean;
  filename?: string;
  quality?: string;
  saveDir?: string;
  priority?: Priority;
  startAt?: number;
  checksum?: string;
  onExists?: ExistsPolicy;
}

export type MediaKind = 'hls' | 'video' | 'dash';

export interface SniffHit {
  url: string;
  kind: MediaKind;
  size: number | null;
  type: string;
  tabId: number;
  referer: string | null;
}

export interface FrameScan { items: Array<{ url: string; kind: MediaKind; referer: string }>; title: string }
export interface HlsQuality { label: string; height: number | null; bandwidth: number }

export type BrowserCmd = 'newtab' | 'closetab' | 'focusurl' | 'reload' | 'back' | 'forward' | 'toast' | 'showdownloads';

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  platform: string;
  developer: typeof DEVELOPER;
}

export interface EngineStatus { installed: boolean; version: string | null }

export interface AdblockStatus {
  enabled: boolean;
  /** Filter lists are loaded and blocking is active. */
  ready: boolean;
  loading: boolean;
  rules: number;
  updatedAt: number | null;
  blockedTotal: number;
  error: string | null;
}

export interface ApiInfo { enabled: boolean; running: boolean; port: number; token: string; extensionDir: string | null }

export interface GrabberApi {
  platform: string;
  list(): Promise<JobView[]>;
  add(url: string, opts?: AddRequest): Promise<string>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  remove(id: string, deleteFiles?: boolean): Promise<void>;
  resolveConflict(id: string, choice: 'replace' | 'rename'): Promise<void>;
  setPriority(id: string, p: Priority): Promise<void>;
  schedule(id: string, startAt: number | null): Promise<void>;
  verify(id: string, checksum: string): Promise<JobView>;
  reveal(id: string): Promise<void>;
  open(id: string): Promise<void>;
  readClipboard(): Promise<string>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickDir(): Promise<string | null>;
  appInfo(): Promise<AppInfo>;
  engineStatus(): Promise<EngineStatus>;
  updateEngine(): Promise<string>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  scanFrames(webContentsId: number): Promise<FrameScan>;
  hlsQualities(url: string, referer?: string): Promise<HlsQuality[]>;
  adblockStatus(): Promise<AdblockStatus>;
  adblockUpdate(): Promise<AdblockStatus>;
  adblockToggleSite(host: string): Promise<boolean>;
  apiInfo(): Promise<ApiInfo>;
  revealExtension(): Promise<void>;
  onUpdate(cb: (j: JobView) => void): () => void;
  onRemoved(cb: (id: string) => void): () => void;
  onSniff(cb: (hit: SniffHit) => void): () => void;
  onCmd(cb: (cmd: BrowserCmd, arg?: string) => void): () => void;
  onAdblockCount(cb: (e: { tabId: number; count: number }) => void): () => void;
  onAdblockStatus(cb: (s: AdblockStatus) => void): () => void;
}
