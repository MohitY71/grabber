import fs from 'node:fs';
import path from 'node:path';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import type { AdblockStatus } from '../shared/api.ts';

/** Public filter lists (EasyList / EasyPrivacy / uBlock Origin). Fetched once, cached on disk, refreshed every few days. */
const LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
];
const MAX_AGE_MS = 4 * 24 * 3600_000;

const TYPE_MAP: Record<string, string> = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font',
  object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other',
};

export interface BlockDetails { url: string; resourceType: string; referrer?: string; pageUrl?: string }

export class AdBlocker {
  private engine: FiltersEngine | null = null;
  private dir: string;
  private loading = false;
  private error: string | null = null;
  private updatedAt: number | null = null;
  private rules = 0;
  blockedTotal = 0;
  enabled: boolean;
  allow: Set<string>;

  constructor(dir: string, enabled: boolean, allow: string[]) {
    this.dir = dir;
    this.enabled = enabled;
    this.allow = new Set(allow);
  }

  private get cacheFile(): string { return path.join(this.dir, 'engine.bin'); }
  private get metaFile(): string { return path.join(this.dir, 'meta.json'); }

  status(): AdblockStatus {
    return { enabled: this.enabled, ready: !!this.engine, loading: this.loading, rules: this.rules, updatedAt: this.updatedAt, blockedTotal: this.blockedTotal, error: this.error };
  }

  /** Use a fixed rule text instead of the public lists (tests, or an organisation's own list). */
  useRules(text: string): void {
    this.engine = FiltersEngine.parse(text);
    this.rules = text.split('\n').filter((l) => l.trim() && !l.startsWith('!')).length;
    this.updatedAt = Date.now();
  }

  /** Load the cached engine instantly, then refresh from the network in the background when it is stale. */
  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(this.cacheFile)));
      const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as { at: number; rules: number };
      this.updatedAt = meta.at; this.rules = meta.rules;
    } catch { this.engine = null; }
    if (!this.engine || !this.updatedAt || Date.now() - this.updatedAt > MAX_AGE_MS) void this.update().catch(() => {});
  }

  async update(): Promise<AdblockStatus> {
    if (this.loading) return this.status();
    this.loading = true; this.error = null;
    try {
      const engine = await FiltersEngine.fromLists(fetch as never, LISTS, { loadCosmeticFilters: true, loadNetworkFilters: true });
      const { networkFilters, cosmeticFilters } = engine.getFilters();
      this.engine = engine;
      this.rules = networkFilters.length + cosmeticFilters.length;
      this.updatedAt = Date.now();
      fs.writeFileSync(this.cacheFile, engine.serialize());
      fs.writeFileSync(this.metaFile, JSON.stringify({ at: this.updatedAt, rules: this.rules }));
    } catch (e) {
      this.error = `Could not download filter lists (${(e as Error).message}).`;
    } finally { this.loading = false; }
    return this.status();
  }

  siteAllowed(pageUrl: string | undefined): boolean {
    try { return !!pageUrl && this.allow.has(new URL(pageUrl).hostname.replace(/^www\./, '')); } catch { return false; }
  }

  /** True when the request should be cancelled. Never blocks page navigations. */
  shouldBlock(d: BlockDetails): boolean {
    if (!this.enabled || !this.engine || d.resourceType === 'mainFrame') return false;
    if (this.siteAllowed(d.pageUrl)) return false;
    try {
      const { match } = this.engine.match(Request.fromRawDetails({ url: d.url, sourceUrl: d.pageUrl ?? d.referrer ?? '', type: (TYPE_MAP[d.resourceType] ?? 'other') as never }));
      if (match) this.blockedTotal++;
      return match;
    } catch { return false; }
  }

  /** CSS that hides ad containers left behind on a page (generic + site-specific cosmetic filters). */
  cosmeticCss(pageUrl: string): string {
    if (!this.enabled || !this.engine || this.siteAllowed(pageUrl)) return '';
    try {
      const u = new URL(pageUrl);
      return this.engine.getCosmeticsFilters({
        url: pageUrl, hostname: u.hostname, domain: u.hostname.split('.').slice(-2).join('.'),
        classes: [], hrefs: [], ids: [], getBaseRules: true, getInjectionRules: false, getExtendedRules: false, getRulesFromDOM: false, getRulesFromHostname: true,
      }).styles;
    } catch { return ''; }
  }
}
