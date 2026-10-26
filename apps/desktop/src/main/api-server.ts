import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * Local-only HTTP API used by the browser extension (Chrome / Edge / Firefox).
 * Safe by construction: bound to 127.0.0.1, requires a pairing token, accepts only extension origins,
 * and rejects unexpected Host headers (DNS-rebinding). A normal web page can never call it.
 */
export interface ApiAddBody {
  url: string; referer?: string; cookies?: string; userAgent?: string; filename?: string; quality?: string; startAt?: number;
}

export interface ApiHandlers {
  version: string;
  token: () => string;
  add: (body: ApiAddBody) => Promise<string>;
}

const EXT_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//i;

export function createApiServer(h: ApiHandlers): http.Server {
  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    const port = (req.socket.localPort ?? 0).toString();
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, {
        'content-type': 'application/json', 'cache-control': 'no-store',
        ...(origin && EXT_ORIGIN.test(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
      });
      res.end(JSON.stringify(body));
    };
    const hostOk = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(req.headers.host ?? '');
    if (!hostOk) return send(403, { error: 'bad host' });
    if (origin && !EXT_ORIGIN.test(origin)) return send(403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin ?? '', 'access-control-allow-headers': 'content-type, x-grabber-token',
        'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '600', vary: 'Origin',
      });
      return void res.end();
    }
    const given = Buffer.from(String(req.headers['x-grabber-token'] ?? ''));
    const want = Buffer.from(h.token());
    if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: 'invalid token' });

    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/ping') return send(200, { ok: true, app: 'Grabber', version: h.version });
    if (req.method === 'POST' && url.pathname === '/v1/add') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => {
        let body: ApiAddBody;
        try { body = JSON.parse(raw) as ApiAddBody; } catch { return send(400, { error: 'bad json' }); }
        if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) return send(400, { error: 'url must be http(s)' });
        h.add(body).then((id) => send(200, { id }), (e: Error) => send(400, { error: e.message }));
      });
      return;
    }
    send(404, { error: 'not found' });
  });
}

/** Listen on the preferred port, or the next free one (up to +10). Resolves with the port actually used. */
export async function listenOnFreePort(server: http.Server, preferred: number): Promise<number> {
  for (let p = preferred; p <= preferred + 10; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = (): void => resolve(false);
      server.once('error', onErr);
      server.listen(p, '127.0.0.1', () => { server.off('error', onErr); resolve(true); });
    });
    if (ok) return p;
  }
  throw new Error('No free port for the browser-extension API');
}
