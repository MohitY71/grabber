export type Status = 'queued' | 'scheduled' | 'probing' | 'downloading' | 'merging' | 'paused' | 'conflict' | 'done' | 'error' | 'cancelled';
export type Kind = 'http' | 'hls' | 'extract';
/** 'best' | 'worst' | 'audio' | a maximum height such as '1080'. */
export type Quality = string;
/** What to do when the target file already exists. */
export type ExistsPolicy = 'ask' | 'rename' | 'replace';
/** 1 = high, 0 = normal, -1 = low. Higher goes first in the queue. */
export type Priority = -1 | 0 | 1;
export type Category = 'video' | 'music' | 'documents' | 'images' | 'archives' | 'programs' | 'other';

export type Headers = Record<string, string>;

export interface Part { start: number; end: number; done: number }

export interface PlanItem {
  id: string;
  url: string;
  range: { start: number; end: number } | null;
  key: HlsKey | null;
  seq?: number;
  init?: boolean;
}

export interface HlsKey { method: string; uri: string | null; iv: string | null; keyFormat: string }

/** Everything needed to resume a job after a pause or an app restart. */
export interface ResumeState {
  parts?: Part[];
  plan?: PlanItem[];
  audioPlan?: PlanItem[];
  done?: string[];
  isTs?: boolean;
  /** Extractor jobs: set once video details are known; how many streams (video+audio) are fetched. */
  extracted?: boolean;
  streams?: number;
}

export type HashAlgo = 'md5' | 'sha1' | 'sha256' | 'sha512';
export interface ChecksumState {
  algo: HashAlgo;
  expected: string;
  /** 'pending' until the file is complete. */
  state: 'pending' | 'ok' | 'mismatch';
  actual?: string;
}

export interface Job {
  id: string;
  url: string;
  status: Status;
  createdAt: number;
  finishedAt?: number;
  headers: Headers;
  cookiesFile?: string;
  filename: string | null;
  quality: Quality;
  threads: number;
  kind: Kind | null;
  name?: string;
  finalUrl?: string;
  size: number | null;
  acceptRanges?: boolean;
  etag?: string | null;
  downloaded: number;
  speed: number;
  progress: number;
  error: string | null;
  note: string | null;
  output: string | null;
  partFile?: string | null;
  state: ResumeState;
  removed?: boolean;
  cancelling?: boolean;
  // --- queue control ---
  priority: Priority;
  /** Do not start before this time (scheduled downloads and retry back-off). */
  startAt: number | null;
  attempts: number;
  // --- placement ---
  saveDir?: string;
  category: Category;
  onExists?: ExistsPolicy;
  replace?: boolean;
  conflictResolved?: boolean;
  conflictPath?: string | null;
  // --- integrity ---
  checksum?: ChecksumState;
}

/** What the UI sees. */
export interface JobView {
  id: string;
  url: string;
  status: Status;
  name: string;
  kind: Kind | null;
  size: number | null;
  downloaded: number;
  speed: number;
  progress: number;
  error: string | null;
  note: string | null;
  output: string | null;
  quality: Quality;
  createdAt: number;
  finishedAt: number | null;
  priority: Priority;
  startAt: number | null;
  category: Category;
  conflictPath: string | null;
  checksum: ChecksumState | null;
}

export interface AddOptions {
  headers?: Headers;
  referer?: string;
  userAgent?: string;
  cookies?: string;
  /** Netscape-format cookie file handed to the video-site engine (keeps cookies off third-party hosts). */
  cookiesFile?: string;
  filename?: string;
  quality?: Quality;
  threads?: number;
  /** Folder for this download only; defaults to the manager's download folder. */
  saveDir?: string;
  priority?: Priority;
  /** Epoch ms; the download waits until then. */
  startAt?: number;
  /** Expected hash, e.g. "sha256:ab12…" or a bare hex digest (algorithm guessed from its length). */
  checksum?: string;
  onExists?: ExistsPolicy;
}

export interface ManagerOptions {
  dataDir: string;
  downloadDir: string;
  ffmpegPath?: string;
  /** Where the video-site extractor (yt-dlp) is stored and updated. */
  toolsDir?: string;
  maxConcurrent?: number;
  threads?: number;
  onExists?: ExistsPolicy;
  /** Put files into Video/Music/Documents/... sub-folders. */
  categoryFolders?: boolean;
  /** Bytes per second across all downloads; 0 = unlimited. */
  speedLimit?: number;
  /** Automatic retries of a whole download after a temporary network problem. */
  autoRetry?: number;
  /** Restart downloads that were running when the app closed. */
  resumeOnStart?: boolean;
  /** Back-off between automatic retries, in seconds (default 5, 15, 45, 120, 300). */
  retryDelays?: number[];
}

export interface ProbeResult {
  url: string;
  finalUrl: string;
  kind: 'http' | 'hls' | 'page';
  size: number | null;
  acceptRanges: boolean;
  contentType: string;
  etag: string | null;
  filename: string;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  codecs: string | null;
  audioGroup: string | null;
  label: string;
}
export interface HlsMediaGroup {
  type: string | undefined;
  groupId: string | undefined;
  name: string | undefined;
  language: string | undefined;
  default: boolean;
  url: string | null;
}
export interface HlsSegment {
  index: number;
  seq: number;
  url: string;
  duration: number;
  key: HlsKey | null;
  map: { url: string; byteRange: string | null } | null;
  range: { start: number; end: number } | null;
}
export type MasterPlaylist = { type: 'master'; variants: HlsVariant[]; media: HlsMediaGroup[] };
export type MediaPlaylist = { type: 'media'; segments: HlsSegment[]; endList: boolean; targetDuration: number };
export type Playlist = MasterPlaylist | MediaPlaylist;
