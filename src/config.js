'use strict';
/**
 * هم‌سفر — بارگذاری پیکربندی
 * فایل .env را می‌خواند، مقدارهای پیش‌فرض منطقی اعمال می‌کند و آن‌ها را اعتبارسنجی می‌کند.
 * بدون وابستگی خارجی.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = { ...parseDotEnv(path.join(ROOT, '.env')), ...process.env };
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

const config = {
  root: ROOT,
  companyName: env.COMPANY_NAME || 'شرکت گردشگری نمونه',
  companySlug: env.COMPANY_SLUG || 'demo-travel',
  companyTagline: env.COMPANY_TAGLINE || 'سفرهای خاطره‌انگیز',
  companyPhone: env.COMPANY_PHONE || '',
  companyEmail: env.COMPANY_EMAIL || '',
  companyAddress: env.COMPANY_ADDRESS || '',
  currency: env.CURRENCY || 'IRR',
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  fedBaseUrl: (env.FED_BASE_URL || env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  proxyTrusted: env.PROXY_TRUSTED || '',
  cookieSecure: bool(env.COOKIE_SECURE, false),
  fedReqTimeoutMs: num(env.FED_REQ_TIMEOUT_MS, 5000),
  fedInsecure: bool(env.FED_INSECURE, false),
  sessionSecret: env.SESSION_SECRET || 'hamsafar-dev-secret',
  schemaVersion: num(env.SCHEMA_VERSION, 1),
  dev: process.argv.includes('--dev'),
  db: {
    file: process.env.HAMSAFAR_DB || path.join(ROOT, 'data', 'hamsafar.sqlite'),
  },
};

if (!/^[a-z0-9][a-z0-9-]*$/.test(config.companySlug)) {
  throw new Error('COMPANY_SLUG باید فقط شامل حروف کوچک لاتین، رقم و خط تیره باشد.');
}

module.exports = config;
