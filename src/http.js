// Mini-framework HTTP sobre node:http (roteamento, JSON, estáticos, cabeçalhos de segurança).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { HttpError } from './util.js';

const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
};

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, path, handler) {
    const re = new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    this.routes.push({ method, re, handler });
  }
  get = (p, h) => this.add('GET', p, h);
  post = (p, h) => this.add('POST', p, h);
  put = (p, h) => this.add('PUT', p, h);
  patch = (p, h) => this.add('PATCH', p, h);
  delete = (p, h) => this.add('DELETE', p, h);

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
    }
    return { pathMatched };
  }
}

/** Resposta crua (HTML, CSV, download…) devolvida por um handler. */
export const raw = (status, contentType, body, headers = {}) => ({ __raw: true, status, contentType, body, headers });

export async function readJsonBody(req) {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Corpo da requisição muito grande');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Corpo da requisição muito grande');
    chunks.push(c);
  }
  if (size === 0) return {};
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Use Content-Type: application/json');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendRaw(res, r) {
  const body = typeof r.body === 'string' ? Buffer.from(r.body, 'utf8') : r.body;
  res.writeHead(r.status, {
    ...SECURITY_HEADERS,
    // relatórios são páginas estáticas: sem scripts, estilos inline permitidos
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
    'content-type': r.contentType,
    'cache-control': 'no-store',
    'content-length': body.length,
    ...r.headers,
  });
  res.end(body);
}

export async function serveStatic(req, res, publicDir, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) return false;
  const full = normalize(join(publicDir, decoded));
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return false; // path traversal
  try {
    const st = await stat(full);
    if (!st.isFile()) return false;
    const type = MIME[extname(full).toLowerCase()];
    if (!type) return false;
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end(), true;
    createReadStream(full).pipe(res);
    return true;
  } catch {
    return false;
  }
}
