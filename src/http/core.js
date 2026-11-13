'use strict';
/**
 * هسته HTTP — روتر مینیمال، پارس بدنه، کوکی‌ها، امنیت پایه.
 * بدون وابستگی خارجی (http + crypto فقط).
 */
const http = require('node:http');
const U = require('../util');
const log = require('../logger');

/* ─── خطاها ─── */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ─── کوکی‌ها ─── */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function cookieHeader(name, value, { maxAge, httpOnly = true, path = '/', secure, sameSite = 'Lax', delete: del } = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${path}`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  s += `; SameSite=${sameSite}`;
  if (del) s = `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=${sameSite}`;
  return s;
}

/* ─── بدنه ─── */
function readBody(req, maxBytes = 512 * 1024) {
  return readBodyWithRaw(req, maxBytes).then((r) => r.body);
}
/** پارس JSON یا فرم HTML + نگه‌داشتن بدنه خام برای امضای فدراسیون */
function readBodyWithRaw(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'بدنه درخواست بزرگ است.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({ body: {}, raw: '' });
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/x-www-form-urlencoded')) {
        const body = {};
        for (const [k, v] of new URLSearchParams(raw)) body[k] = v;
        return resolve({ body, raw });
      }
      try { resolve({ body: JSON.parse(raw), raw }); }
      catch { reject(new HttpError(400, 'بدنه JSON نامعتبر است.')); }
    });
    req.on('error', reject);
  });
}

/* ─── URL ─── */
function parseUrl(req) {
  const u = new URL(req.url, 'http://internal');
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  return { pathname: decodeURIComponent(u.pathname), search: u.search, query: q };
}

/* ─── روتر ─── */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    // الگو: /panel/offers/:id  → پارامترها در ctx.params؛ /assets/* → wildcard
    const keys = [];
    const escaped = pattern.split('/').map((seg) => {
      if (seg === '*') { keys.push('wildcard'); return '(?:.*)'; }
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    const rx = new RegExp('^' + escaped + '/?$');
    this.routes.push({ method, pattern, rx, keys, handler, opts });
  }
  get(p, h, o) { (Array.isArray(p) ? p : [p]).forEach((x) => this.add('GET', x, h, o)); }
  post(p, h, o) { (Array.isArray(p) ? p : [p]).forEach((x) => this.add('POST', x, h, o)); }
  put(p, h, o) { (Array.isArray(p) ? p : [p]).forEach((x) => this.add('PUT', x, h, o)); }
  patch(p, h, o) { (Array.isArray(p) ? p : [p]).forEach((x) => this.add('PATCH', x, h, o)); }
  delete(p, h, o) { (Array.isArray(p) ? p : [p]).forEach((x) => this.add('DELETE', x, h, o)); }

  find(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

/* ─── پاسخ‌ها ─── */
function html(ctx, body, status = 200, headers = {}) {
  ctx.res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
}
function json(ctx, obj, status = 200, headers = {}) {
  const body = JSON.stringify(obj);
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
}
function redirect(ctx, location, status = 302) {
  ctx.res.writeHead(status, { Location: location });
  ctx.res.end();
}

/* ─── ابزارهای HTML ─── */
function page(title, metaDesc, bodyHtml, { canonical, noindex, jsonLd = [], extraHead = '' } = {}) {
  const jsonLdTags = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean)
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${U.esc(title)}</title>
${metaDesc ? `<meta name="description" content="${U.esc(metaDesc)}">` : ''}
${canonical ? `<link rel="canonical" href="${U.esc(canonical)}">` : ''}
${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="هم‌سفر">
<meta property="og:title" content="${U.esc(title)}">
${metaDesc ? `<meta property="og:description" content="${U.esc(metaDesc)}">` : ''}
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
${jsonLdTags}
${extraHead}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/* ─── سرور ─── */
function createServer({ router, panelRouter, onError, resolveUser }) {
  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const { pathname, search, query } = parseUrl(req);
    const cookies = parseCookies(req.headers.cookie);
    const ctx = { req, res, pathname, search, query, cookies, params: {}, body: {}, ip: clientIp(req), userAgent: req.headers['user-agent'] || '', user: null };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    try {
      if (resolveUser) {
        try { ctx.user = resolveUser(cookies, req) || null; }
        catch (e) { log.warn('resolveUser failed', { err: e.message }); ctx.user = null; }
      }
      if (pathname.startsWith('/assets/')) {
        await serveAsset(ctx);
        return;
      }
      // روتینگ: عمومی/فدراسیون → پنل/API
      const matched =
        router.find(req.method, pathname) ||
        (panelRouter && panelRouter.find(req.method, pathname)) ||
        null;
      if (!matched) throw new HttpError(404, 'صفحه‌ای که می‌خواستید یافت نشد.');
      const { route, params } = matched;
      ctx.params = params;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const { body, raw } = await readBodyWithRaw(req, route.opts.maxBytes);
        ctx.body = body;
        ctx.bodyRaw = raw;
      }
      if (route.opts.csrf !== false && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !route.opts.federated) {
        assertCsrf(ctx);
      }
      await route.handler(ctx);
      log.info('http', { method: req.method, path: pathname, status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 | 0, uid: ctx.user ? ctx.user.id : undefined, role: ctx.user ? ctx.user.role : undefined });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e.status || 500);
      if (status >= 500) log.error('request error', { path: pathname, err: e.message, stack: e.stack });
      if (!res.headersSent) {
        if (pathname.startsWith('/api/') || pathname.startsWith('/fed/') || isJsonRequest(req)) {
          json(ctx, { ok: false, error: e.message }, status);
        } else {
          onError && onError(ctx, e);
        }
      } else {
        res.end();
      }
    }
  });
  return server;
}

function isJsonRequest(req) {
  const accept = req.headers.accept || '';
  return req.headers['content-type']?.includes('application/json') || accept.includes('application/json');
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace('::ffff:', '') || null;
}

/* ─── CSRF ─── */
function assertCsrf(ctx) {
  const cookieToken = ctx.cookies.__hs_csrf;
  const field = (ctx.body && ctx.body._csrf) || (ctx.query && ctx.query._csrf) || ctx.req.headers['x-csrf-token'];
  if (!cookieToken || !field || cookieToken !== field) {
    throw new HttpError(403, 'توکن CSRF نامعتبر است. صفحه را رفرش کنید.');
  }
}
function issueCsrf(ctx) {
  if (!ctx.cookies.__hs_csrf) {
    const token = U.randomId(24);
    ctx.res.setHeader('Set-Cookie', [cookieHeader('__hs_csrf', token, { sameSite: 'Strict' })].concat(ctx.res.getHeader('Set-Cookie') || []));
    ctx.csrfToken = token;
  } else {
    ctx.csrfToken = ctx.cookies.__hs_csrf;
  }
  return ctx.csrfToken;
}

/* ─── فایل‌های استاتیک (assets) ─── */
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
let assetRoot = null;
function setAssetRoot(root) { assetRoot = root; }
async function serveAsset(ctx) {
  if (!assetRoot) throw new HttpError(404, 'not found');
  const rel = path.normalize(ctx.pathname.replace(/^\/assets\//, '')).replace(/^(\.\.[\/\\])+/, '');
  if (rel.includes('..')) throw new HttpError(404, 'not found');
  const file = path.join(assetRoot, rel);
  if (!file.startsWith(assetRoot)) throw new HttpError(404, 'not found');
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    ctx.res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' || ext === '.css' ? 'public, max-age=86400' : 'public, max-age=3600',
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : data);
  } catch {
    throw new HttpError(404, 'فایل یافت نشد.');
  }
}

module.exports = {
  HttpError, Router, createServer, html, json, redirect, page,
  parseCookies, cookieHeader, issueCsrf, assertCsrf, clientIp, setAssetRoot, readBody,
};
