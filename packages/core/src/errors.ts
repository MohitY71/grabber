export interface Explained { message: string; /** worth retrying automatically */ transient: boolean }

const CODE_MESSAGES: Record<string, [string, boolean]> = {
  ENOTFOUND: ["Can't reach the server. Check the web address and your internet connection.", true],
  EAI_AGAIN: ["Can't look up the server's address. Check your internet connection.", true],
  ECONNREFUSED: ['The server refused the connection.', true],
  ECONNRESET: ['The connection was interrupted.', true],
  EPIPE: ['The connection was interrupted.', true],
  ETIMEDOUT: ['The server took too long to respond.', true],
  ENETUNREACH: ['No network connection.', true],
  EHOSTUNREACH: ['The server is unreachable.', true],
  UND_ERR_SOCKET: ['The connection was interrupted.', true],
  UND_ERR_CONNECT_TIMEOUT: ['The server took too long to respond.', true],
  UND_ERR_HEADERS_TIMEOUT: ['The server took too long to respond.', true],
  UND_ERR_BODY_TIMEOUT: ['The download stalled.', true],
  CERT_HAS_EXPIRED: ["The site's security certificate has expired.", false],
  DEPTH_ZERO_SELF_SIGNED_CERT: ["The site's security certificate is not trusted.", false],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ["The site's security certificate is not trusted.", false],
  ERR_TLS_CERT_ALTNAME_INVALID: ["The site's security certificate doesn't match its address.", false],
  ENOSPC: ['Not enough free disk space to save this file. Free some space and try again.', false],
  EACCES: ["Can't write to the download folder (permission denied). Choose another folder in Settings.", false],
  EPERM: ["Can't write to the download folder (permission denied). Choose another folder in Settings.", false],
  EROFS: ['The download folder is read-only. Choose another folder in Settings.', false],
  ENOENT: ['The download folder was not found. Choose another folder in Settings.', false],
  ENAMETOOLONG: ['The file name is too long for this disk.', false],
  EMFILE: ['Too many files are open. Lower the connections per download in Settings.', true],
};

const HTTP_MESSAGES: Array<[(n: number) => boolean, (n: number) => [string, boolean]]> = [
  [(n) => n === 401, (n) => [`Access denied (HTTP ${n}): this link needs you to sign in. Add it from the Browser tab while signed in.`, false]],
  [(n) => n === 403, (n) => [`Access denied by the server (HTTP ${n}). The link may have expired, or it needs you to be signed in. Try adding it from the Browser tab.`, false]],
  [(n) => n === 404, (n) => [`File not found (HTTP ${n}). The link may be wrong or no longer available.`, false]],
  [(n) => n === 410, (n) => [`This link has expired (HTTP ${n}).`, false]],
  [(n) => n === 416, (n) => [`The server rejected the resume request (HTTP ${n}). Remove the download and add it again.`, false]],
  [(n) => n === 408 || n === 429, (n) => [`The server is busy or limiting requests (HTTP ${n}). Retrying shortly.`, true]],
  [(n) => n >= 500, (n) => [`The server had a problem (HTTP ${n}).`, true]],
  [(n) => n >= 400, (n) => [`The server refused the request (HTTP ${n}).`, false]],
];

/** Turn any thrown value into one sentence a person can act on, and say whether a retry may help. */
export function explainError(e: unknown): Explained {
  const err = e as { code?: string; cause?: { code?: string; message?: string }; message?: string } | null;
  const code = err?.code ?? err?.cause?.code;
  if (code && CODE_MESSAGES[code]) { const [message, transient] = CODE_MESSAGES[code]; return { message, transient }; }

  const text = err?.message ?? String(e);
  const http = /\bHTTP (\d{3})\b/.exec(text);
  if (http) {
    const n = Number(http[1]);
    for (const [test, make] of HTTP_MESSAGES) if (test(n)) { const [message, transient] = make(n); return { message, transient }; }
  }
  if (/connection closed early|terminated|socket hang up|network (error|changed)|fetch failed|other side closed/i.test(text)) {
    return { message: 'The connection was interrupted.', transient: true };
  }
  // Anything else is either worded for people already (our own errors) or unknown: don't retry blindly.
  return { message: text, transient: false };
}
