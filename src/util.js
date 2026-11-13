'use strict';
/** ابزارهای عمومی هم‌سفر — بدون وابستگی خارجی */

/** شناسه‌های کوتاه امن (nanoid-مانند، الفبای بدون ابهام) */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randomId(len = 12) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const crypto = require('node:crypto');

/** عدد صحیح امن در بازه [min,max] */
function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

/** شناسه مرجع قابل خواندن توسط انسان، مثل HS-8F3K-2P9Q */
function refCode(prefix = 'HS') {
  return `${prefix}-${randomId(4)}-${randomId(4)}`;
}

/** هش رمز عبور scrypt با نمک — فرم: scrypt$N$salt$hash */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const N = 16384;
  const hash = crypto.scryptSync(String(password), salt, 32, { N }).toString('hex');
  return `scrypt$${N}$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const N = Number(nStr);
    const check = crypto.scryptSync(String(password), salt, 32, { N });
    return crypto.timingSafeEqual(check, Buffer.from(hash, 'hex'));
  } catch { return false; }
}

/** رمز یک‌بارمصرف عددی ۶ رقمی */
function randomOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/* ─── زمان ─── */
/** تاریخ ISO بدون میلی‌ثانیه (برای مقایسه‌های پایدار) */
function isoNow() { return new Date().toISOString().slice(0, 19) + 'Z'; }
/** yyyy-mm-dd امروز به وقت محلی سرور */
function todayLocal() {
  const d = new Date(Date.now() - TZ_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}
const TZ_OFFSET_MS = 3.5 * 3600 * 1000; // ایران +03:30
/** تبدیل تاریخ ISO به «yyyymmddT...» بشرطی — در واقع yyyy-mm-dd نرمال‌شده */
function normDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    // سال میلادی معقول؛ در غیر این صورت (مثل سال شمسی ۱۴۰۰) قبول نمی‌شود
    return y >= 1990 && y <= 2200 ? s : null;
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    if (y < 1990 || y > 2200) return null;
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return null;
}
/** اعتبارسنجی yyyy-mm-dd واقعی */
function isDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
  const dt = new Date(d + 'T12:00:00Z');
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}
/** فاصله روز بین دو تاریخ yyyy-mm-dd (b-a) */
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/* ─── اعداد و پول ─── */
function toInt(v, dflt = null) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : dflt;
}
function toAmount(v, dflt = null) {
  // مبالغ ریالی: عدد صحیح ≥ 0
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(String(v).replace(/[,،\s]/g, ''));
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : dflt;
}
/** تبدیل ارقام فارسی/عربی به لاتین */
function faDigitsToEn(s) {
  const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
  return String(s).replace(/[۰-۹٠-٩]/g, (ch) => {
    const i = fa.indexOf(ch); if (i >= 0) return String(i);
    return String(ar.indexOf(ch));
  });
}
/** قالب‌بندی مبلغ: 1,250,000 ریال */
const fmtMoney = new Intl.NumberFormat('fa-IR');
function money(n) { return fmtMoney.format(Number(n) || 0) + ' ریال'; }
/** قالب‌بندی عدد فارسی */
function fmtNum(n) { return fmtMoney.format(Number(n) || 0); }

/* ─── رشته‌ها و اعتبارسنجی ─── */
const RE_MOBILE = /^09\d{9}$/;
function normalizeMobile(m) {
  const s = faDigitsToEn(String(m || '')).replace(/[\s-]/g, '');
  if (/^(\+98|0098|98)9\d{9}$/.test(s)) return '0' + s.slice(-10);
  if (/^9\d{9}$/.test(s)) return '0' + s;
  return RE_MOBILE.test(s) ? s : null;
}
function normalizeEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
function isName(s) {
  s = String(s || '').trim();
  return s.length >= 2 && s.length <= 120 ? s : null;
}
/** slug لاتین برای URL */
function slugify(s) {
  return String(s || '')
    .trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u0600-\u06FF-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'item';
}
/** escape HTML */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** حذف کاراکترهای کنترلی و نرمال‌سازی ورودی متنی */
function cleanText(s, maxLen = 500) {
  return String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}
/** اعتبارسنجی کد ملی ایران (برای مدارک مسافران) */
function isValidNationalId(code) {
  code = faDigitsToEn(String(code || '')).replace(/\D/g, '');
  if (!/^\d{10}$/.test(code)) return false;
  if (/^(\d)\1{9}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(code[i]) * (10 - i);
  const r = sum % 11;
  return (r < 2 ? r : 11 - r) === Number(code[9]);
}

/* ─── رندر تاریخ شمسی برای UI ─── */
const jalaliFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' });
const jalaliShortFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' });
function faDate(isoOrDate) {
  try { return jalaliFmt.format(new Date(isoOrDate)); } catch { return ''; }
}
function faDateShort(isoOrDate) {
  try { return jalaliShortFmt.format(new Date(isoOrDate)).replace(/[٬،]/g, '/'); } catch { return ''; }
}
function faDateTime(isoOrDate) {
  try {
    const d = new Date(isoOrDate);
    return `${jalaliFmt.format(d)} — ${String((d.getUTCHours() + 3) % 24).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

module.exports = {
  randomId, randomInt, refCode, hashPassword, verifyPassword, randomOtp,
  isoNow, todayLocal, normDate, isDate, daysBetween,
  toInt, toAmount, faDigitsToEn, money, fmtNum,
  RE_MOBILE, normalizeMobile, normalizeEmail, isName, slugify, esc, cleanText, isValidNationalId,
  faDate, faDateShort, faDateTime,
};
