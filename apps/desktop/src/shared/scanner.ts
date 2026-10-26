/**
 * Self-contained functions that run INSIDE a web page (every frame), injected as source text.
 * They may not reference anything from the surrounding module.
 */

export interface ScanResult { page: string; title: string; urls: string[] }

/** One-shot look at the DOM for media URLs: <video>/<source>, plus media links written into the HTML/inline JSON. */
export function pageScanner(): ScanResult {
  const out = new Set<string>();
  const abs = (u: string): string | null => { try { return new URL(u, location.href).href; } catch { return null; } };
  document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video, video source, audio source, source').forEach((el) => {
    const s = (el as HTMLMediaElement).currentSrc || (el as HTMLSourceElement).src || el.getAttribute('src');
    if (s && !s.startsWith('blob:')) { const a = abs(s); if (a) out.add(a); }
  });
  const html = document.documentElement.outerHTML.split('\\/').join('/').split('\\u002F').join('/').split('&amp;').join('&');
  const re = /https?:\/\/[^"'\s<>\\)]+?\.(?:m3u8|mpd|mp4|webm|mkv|mov)(?:\?[^"'\s<>\\)]*)?/gi;
  for (const m of html.matchAll(re)) out.add(m[0]);
  return { page: location.href, title: document.title, urls: [...out].slice(0, 80) };
}

/**
 * Installed once per frame. Players usually fetch their playlist / config with fetch() or XHR after the page has
 * loaded, often from another frame or with a URL that has no ".m3u8" in it. This watches those responses
 * (without altering them) and reports media it recognises by CONTENT, via a console line the app listens for.
 */
export function pageHook(): void {
  const w = window as unknown as { __grabberHook?: boolean };
  if (w.__grabberHook) return;
  w.__grabberHook = true;
  const seen = new Set<string>();
  const report = (url: string, kind: 'hls' | 'dash' | 'video'): void => {
    try {
      const abs = new URL(url, location.href).href;
      if (abs.startsWith('blob:') || abs.startsWith('data:') || seen.has(abs)) return;
      seen.add(abs);
      console.debug('__GRABBER__' + JSON.stringify({ url: abs, kind, page: location.href }));
    } catch { /* ignore */ }
  };
  const kindOf = (u: string): 'hls' | 'dash' | 'video' => (/\.m3u8(\?|#|$)/i.test(u) ? 'hls' : /\.mpd(\?|#|$)/i.test(u) ? 'dash' : 'video');
  const MEDIA = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>\\]*)?/gi;

  const inspect = (url: string, type: string, text: string | null): void => {
    try {
      if (/mpegurl/i.test(type)) return report(url, 'hls');
      if (/dash\+xml/i.test(type)) return report(url, 'dash');
      if (/^video\//i.test(type) && !/mp2t/i.test(type)) return; // chunk fetches; handled by the network sniffer
      if (text === null) return;
      if (/^\s*#EXTM3U/.test(text)) return report(url, 'hls'); // a playlist served with a generic content type
      if (/^\s*<\?xml[^>]*>\s*<MPD\b/i.test(text) || /^\s*<MPD\b/.test(text)) return report(url, 'dash');
      if (/json|javascript|text\/plain|octet-stream|^$/i.test(type) && text.length < 3_000_000) {
        // Player configs: {"sources":[{"file":"https:\/\/cdn\/x.m3u8"}]}
        const flat = text.split('\\/').join('/').split('\\u002F').join('/').split('\\u0026').join('&');
        let n = 0;
        for (const m of flat.matchAll(MEDIA)) { report(m[0], kindOf(m[0])); if (++n >= 12) break; }
      }
    } catch { /* ignore */ }
  };

  try {
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const p = origFetch.apply(this, args);
      try {
        const a0 = args[0];
        const reqUrl = typeof a0 === 'string' ? a0 : a0 instanceof URL ? a0.href : (a0 as Request).url;
        p.then((r) => {
          const type = r.headers.get('content-type') || '';
          const len = Number(r.headers.get('content-length')) || 0;
          if (/mpegurl|dash\+xml/i.test(type) || /\.(m3u8|mpd)(\?|#|$)/i.test(reqUrl)) return inspect(r.url || reqUrl, type, null);
          if (len > 3_000_000 || /^(image|font|audio)\//i.test(type) || /^video\//i.test(type)) return;
          r.clone().text().then((t) => inspect(r.url || reqUrl, type, t), () => {});
        }, () => {});
      } catch { /* never break the page */ }
      return p;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __grbUrl?: string }, method: string, url: string | URL, ...rest: unknown[]): void {
      try {
        this.__grbUrl = String(url);
        this.addEventListener('load', () => {
          try {
            const type = this.getResponseHeader('content-type') || '';
            const u = this.responseURL || this.__grbUrl || '';
            if (this.responseType === '' || this.responseType === 'text') inspect(u, type, this.responseText);
            else if (/mpegurl|dash\+xml/i.test(type) || /\.(m3u8|mpd)(\?|#|$)/i.test(u)) inspect(u, type, null);
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
  } catch { /* ignore */ }

  // Elements whose source is set by script, and players that expose the real URL on the element.
  const sweep = (): void => {
    try {
      document.querySelectorAll<HTMLMediaElement>('video, audio').forEach((v) => {
        for (const s of [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((x) => x.src)]) {
          if (s && !s.startsWith('blob:')) report(s, kindOf(s));
        }
      });
    } catch { /* ignore */ }
  };
  setInterval(sweep, 1500);
  sweep();
}
