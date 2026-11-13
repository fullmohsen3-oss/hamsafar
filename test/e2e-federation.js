'use strict';
/**
 * تست E2E — دو شرکت مستقل هم‌سفر روی دو پورت
 * شرکت الف (پورت 3101): تامین‌کننده اتوبوس دارد
 * شرکت ب (پورت 3102): واسطه دارد که از بازار فدرال شرکت الف رزرو می‌زند
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const results = [];
let failures = 0;

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
}

/* سرور فرزند با env مستقل */
function startServer(port, dbFile, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    HAMSAFAR_DB: dbFile,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    FED_BASE_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'test-secret-' + port,
    LOG_LEVEL: 'warn',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.logs = [];
  child.stdout.on('data', (d) => child.logs.push(d.toString()));
  child.stderr.on('data', (d) => child.logs.push(d.toString()));
  return child;
}

async function waitReady(port, child, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (child.exitCode !== null) {
      console.error('server exited early with code', child.exitCode, ':', child.logs.join('').slice(0, 2000));
      return false;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* هنوز بالا نیامده */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('server failed to start:', child.logs.join('').slice(0, 2000));
  return false;
}

/* کلاینت HTTP با کوکی‌ها */
function makeClient(base) {
  const cookies = new Map();
  async function call(method, url, body, headers = {}) {
    const cookieHeader = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim(), v = pair.slice(eq + 1).trim();
        if (v === '') cookies.delete(k); else cookies.set(k, v);
      }
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async function getCsrf() {
    // از هر صفحه‌ای که فرم دارد؛ اگر ریدایرکت شد (لاگین هستیم)، از /panel-request می‌گیریم که همیشه فرم دارد
    let r = await call('GET', '/login');
    let html = typeof r.data === 'string' ? r.data : '';
    if (!html.includes('name="_csrf"')) {
      r = await call('GET', '/panel-request');
      html = typeof r.data === 'string' ? r.data : '';
    }
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    return m ? m[1] : null;
  }
  return { call, getCsrf };
}

/* امضای فدرال */
const crypto = require('node:crypto');
function fedHeaders(key, method, pathWithQuery, bodyStr, idem) {
  const material = ['1', method, pathWithQuery, key, bodyStr || ''].join('\n');
  const sig = crypto.createHmac('sha256', key).update(material).digest('hex');
  const h = {
    'X-HamSafar-Key': key,
    'X-HamSafar-Signature': sig,
    'X-HamSafar-Version': '1',
    'Content-Type': 'application/json',
  };
  if (idem) h['X-Idempotency-Key'] = idem;
  return h;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-e2e-'));
  const dbA = path.join(tmp, 'a.sqlite');
  const dbB = path.join(tmp, 'b.sqlite');

  console.log('── راه‌اندازی شرکت الف (عرضه‌کننده) و شرکت ب (خریدار فدرال) ...');
  const serverA = startServer(3101, dbA, {
    COMPANY_NAME: 'شرکت الف چارتر', COMPANY_SLUG: 'company-a',
  });
  const serverB = startServer(3102, dbB, {
    COMPANY_NAME: 'شرکت ب سفر', COMPANY_SLUG: 'company-b',
  });
  const okA = await waitReady(3101, serverA);
  const okB = await waitReady(3102, serverB);
  check('سرور الف بالا آمد', okA);
  check('سرور ب بالا آمد', okB);
  if (!okA || !okB) { cleanup(); process.exit(1); }

  /* ── فاز ۱: در شرکت الف تامین‌کننده و آفر بساز ── */
  const A = makeClient('http://127.0.0.1:3101');
  // ورود ادمین الف
  {
    const csrf = await A.getCsrf();
    const r = await A.call('POST', '/login', { login: 'admin@company-a.ir', password: 'admin1234', _csrf: csrf, _json: '1' });
    check('ورود ادمین الف', r.status === 200 || (r.status === 302), `status=${r.status}`);
  }
  // ساخت تامین‌کننده
  let supplierEmail = 'supplier@a.com';
  {
    const csrf = await A.getCsrf();
    const r = await A.call('POST', '/panel/admin/users/new', {
      full_name: 'تامین‌کننده اتوبوس', role: 'supplier', email: supplierEmail,
      password: 'supplier1234', company_title: 'چارتر اتوبوس الف', _csrf: csrf, _json: '1',
    });
    check('ساخت تامین‌کننده در الف', r.status === 302, `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  // ورود تامین‌کننده در کلاینت جدید
  const S = makeClient('http://127.0.0.1:3101');
  {
    const csrf = await S.getCsrf();
    const r = await S.call('POST', '/login', { login: supplierEmail, password: 'supplier1234', _csrf: csrf, _json: '1' });
    check('ورود تامین‌کننده', r.status === 200 || r.status === 302, `status=${r.status} ${typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 150) : ''}`);
  }
  // ثبت خدمت (اتوبوس)
  let itemId;
  {
    const csrf = await S.getCsrf();
    const r = await S.call('POST', '/panel/supplier/inventory/new', {
      title: 'اتوبوس VIP تهران-اصفهان', type_id: '2', origin: 'تهران', destination: 'اصفهان',
      depart_at: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 16),
      unit_label: 'صندلی', base_price: '600000', capacity_total: '40', _csrf: csrf, _json: '1',
    });
    check('ثبت خدمت اتوبوس', r.status === 302, `status=${r.status}`);
    // itemId از redirect
    const loc = r.headers.get('location') || '';
    itemId = (loc.match(/inventory\/([A-Za-z0-9-]+)/) || [])[1];
    check('شناسه خدمت برگشت', !!itemId, loc);
  }
  // ثبت آفر بازار + عمومی
  let offerId;
  {
    const csrf = await S.getCsrf();
    const r = await S.call('POST', `/panel/supplier/inventory/${itemId}/offer/new`, {
      kind: 'market', qty: '40', unit_price: '600000', visible_to_agents: '1',
      visible_to_public: '1', public_price: '750000', fed_visible: '1', _csrf: csrf, _json: '1',
    });
    check('ثبت آفر بازار', r.status === 302, `status=${r.status}`);
  }
  // خواندن آفر از کاتالوگ فدرال (بدون کلید → 401)
  {
    const r = await A.call('GET', '/fed/v1/catalog');
    check('کاتالوگ فدرال بدون کلید رد می‌شود', r.status === 401, `status=${r.status}`);
  }

  /* ── فاز ۲: ادمین الف کلید فدرال بسازد (کلید ما برای ب) ── */
  // در این معماری، fed_peers لازم است حتی برای «فقط عرضه»؛ our_key_for_them را کلاینت ب می‌خواهد.
  // ادمین الف از دیتابیس مستقیم کلید می‌سازد؟ نه — از پنل: همکار جدید نیاز به api_key (کلید ب نزد الف) دارد.
  // برای تست مستقل: الف فقط عرضه می‌کند؛ کلید ورودی الف را مستقیم در دیتابیس می‌گذاریم (شبیه آنکه ب از قبل کلیدش را داده).
  const { DatabaseSync } = require('node:sqlite');
  const dbAhandle = new DatabaseSync(dbA);
  const keyForB = 'k' + crypto.randomBytes(24).toString('hex');
  dbAhandle.prepare(`INSERT INTO fed_peers (id,name,base_url,api_key,our_key_for_them,status,trust_level,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('PEER-B', 'شرکت ب سفر', 'http://127.0.0.1:3102', 'unused-key-for-outbound', keyForB, 'active', 'verified', new Date().toISOString(), new Date().toISOString());

  // حالا کاتالوگ فدرال الف با کلید ب
  let catalog;
  {
    const r = await A.call('GET', '/fed/v1/catalog?limit=50', undefined, fedHeaders(keyForB, 'GET', '/fed/v1/catalog?limit=50', ''));
    catalog = r.data;
    check('کاتالوگ فدرال الف با کلید معتبر', r.status === 200 && catalog.ok && catalog.items.length >= 1,
      `status=${r.status} items=${catalog.items ? catalog.items.length : '?'}`);
    offerId = catalog.items && catalog.items[0] ? catalog.items[0].id : null;
    check('آفر در کاتالوگ فدرال دیده می‌شود', !!offerId, JSON.stringify(catalog).slice(0, 200));
    if (offerId) check('قیمت آفر فدرال درست است', catalog.items[0].unit_price === 600000 && catalog.items[0].qty_available === 40);
  }
  // امضای غلط رد می‌شود
  {
    const r = await A.call('GET', '/fed/v1/catalog', undefined, {
      'X-HamSafar-Key': keyForB, 'X-HamSafar-Signature': 'deadbeef', 'X-HamSafar-Version': '1',
    });
    check('امضای نامعتبر رد می‌شود', r.status === 403, `status=${r.status}`);
  }

  /* ── فاز ۳: شرکت ب همتای الف را اضافه کند و از پنل واسطه رزرو فدرال بزند ── */
  const B = makeClient('http://127.0.0.1:3102');
  {
    const csrf = await B.getCsrf();
    const r = await B.call('POST', '/login', { login: 'admin@company-b.ir', password: 'admin1234', _csrf: csrf, _json: '1' });
    check('ورود ادمین ب', r.status === 200 || r.status === 302, `status=${r.status}`);
  }
  // ساخت واسطه در ب
  {
    const csrf = await B.getCsrf();
    const r = await B.call('POST', '/panel/admin/users/new', {
      full_name: 'واسطه آزمون', role: 'agent', email: 'agent@b.com',
      password: 'agent1234', company_title: 'آژانس ب', _csrf: csrf, _json: '1',
    });
    check('ساخت واسطه در ب', r.status === 302, `status=${r.status}`);
  }
  // اضافه‌کردن همتا (الف) در ب: کلید API که الف به ب داده = keyForB
  {
    const csrf = await B.getCsrf();
    const r = await B.call('POST', '/panel/admin/federation/new', {
      name: 'شرکت الف چارتر', base_url: 'http://127.0.0.1:3101',
      api_key: keyForB, our_key_for_them: 'k' + crypto.randomBytes(24).toString('hex'),
      _csrf: csrf, _json: '1',
    });
    check('افزودن همتای الف در ب', r.status === 302, `status=${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);
  }
  // ورود واسطه ب
  const AG = makeClient('http://127.0.0.1:3102');
  {
    const csrf = await AG.getCsrf();
    const r = await AG.call('POST', '/login', { login: 'agent@b.com', password: 'agent1234', _csrf: csrf, _json: '1' });
    check('ورود واسطه ب', r.status === 200 || r.status === 302, `status=${r.status}`);
  }
  // همگام‌سازی کاتالوگ فدرال از پنل واسطه
  {
    const r = await AG.call('GET', '/panel/agent/fed-market?refresh=1');
    check('همگام‌سازی کاتالوگ فدرال', r.status === 302 || r.status === 200, `status=${r.status}`);
  }
  // بررسی اینکه آیتم فدرال در دیتابیس ب هست
  let remoteItem;
  {
    const dbBhandle = new DatabaseSync(dbB);
    remoteItem = dbBhandle.prepare('SELECT * FROM fed_remote_items LIMIT 1').get();
    check('آیتم فدرال در کش ب ذخیره شد', !!remoteItem, JSON.stringify(remoteItem || {}).slice(0, 100));
  }
  // رزرو فدرال از پنل واسطه
  let fedBookingRef;
  {
    if (!remoteItem) {
      check('رزرو فدرال ثبت شد', false, 'remoteItem نیست');
    } else {
      const csrf = await AG.getCsrf();
      const r = await AG.call('POST', `/panel/agent/fed-market/${remoteItem.id}`, {
        sell_price: '800000', count: '3', buyer_name: 'مشتری تست', buyer_mobile: '09121110000', _csrf: csrf, _json: '1',
      });
      check('رزرو فدرال ثبت شد', r.status === 302, `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      const loc = r.headers.get('location') || '';
      const bid = (loc.match(/booking\/([A-Za-z0-9-]+)/) || [])[1];
      check('به صفحه رزرو هدایت شد', !!bid, loc);
      if (bid) {
        const dbBhandle = new DatabaseSync(dbB);
        const bk = dbBhandle.prepare('SELECT * FROM bookings WHERE id=?').get(bid);
        check('رزرو فدرال در دیتابیس ب ثبت شد', !!(bk && bk.source === 'federation' && bk.fed_peer_id), JSON.stringify(bk || {}).slice(0, 150));
        check('کمیسیون واسطه محاسبه شد', bk && bk.commission === (800000 - 600000) * 3, `commission=${bk && bk.commission}`);
      }
    }
  }
  // بررسی در شرکت الف: رزرو فدرال ثبت شده؟
  {
    const dbA2 = new DatabaseSync(dbA);
    const bk = dbA2.prepare(`SELECT * FROM bookings WHERE source='federation'`).get();
    check('رزرو فدرال در شرکت الف ثبت شد', !!bk, JSON.stringify(bk || {}).slice(0, 150));
    if (bk) {
      check('تعداد مسافر درست', bk.traveler_count === 3, `count=${bk.traveler_count}`);
      check('قیمت واحد درست (قیمت همکار)', bk.unit_price === 600000, `unit=${bk.unit_price}`);
      fedBookingRef = bk.ref_code;
      // موجودی کاهش یافته؟
      const offer = dbA2.prepare(`SELECT o.qty, (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used FROM inventory_offers o WHERE o.id=?`).get(offerId);
      check('ظرفیت فدرال کاهش یافت (40→37)', offer && offer.used === 3, `used=${offer && offer.used}`);
    }
  }
  // idempotency: همان کلید دوباره → همان پاسخ
  {
    const body = JSON.stringify({ travelers: 2, contact_name: 'دوباره', contact_mobile: '09121112222' });
    const idem = 'idem-test-1';
    const h1 = fedHeaders(keyForB, 'POST', `/fed/v1/catalog/${offerId}/reserve`, body, idem);
    const r1 = await A.call('POST', `/fed/v1/catalog/${offerId}/reserve`, JSON.parse(body), h1);
    const r2 = await A.call('POST', `/fed/v1/catalog/${offerId}/reserve`, JSON.parse(body), { ...fedHeaders(keyForB, 'POST', `/fed/v1/catalog/${offerId}/reserve`, body, idem), 'X-Idempotency-Key': idem });
    check('idempotency: پاسخ تکراری همان است', r1.data.booking_ref === r2.data.booking_ref, `${r1.data.booking_ref} vs ${r2.data.booking_ref}`);
  }
  // ظرفیت ناکافی → 409
  {
    const body = JSON.stringify({ travelers: 999, contact_name: 'زیاد', contact_mobile: '09121113333' });
    const h = fedHeaders(keyForB, 'POST', `/fed/v1/catalog/${offerId}/reserve`, body);
    const r = await A.call('POST', `/fed/v1/catalog/${offerId}/reserve`, JSON.parse(body), h);
    check('رزرو بیش از ظرفیت رد می‌شود (409)', r.status === 409, `status=${r.status}`);
  }

  /* ── فاز ۴: رزرو از سایت عمومی الف با CSRF واقعی ── */
  const anon = makeClient('http://127.0.0.1:3101');
  let publicRef;
  {
    const csrf = await anon.getCsrf();
    // آفر عمومی را بیاب
    const page = await anon.call('GET', '/services');
    const m = /\/book\/offer\/([A-Za-z0-9-]+)/.exec(typeof page.data === 'string' ? page.data : '');
    check('آفر عمومی در سایت دیده می‌شود', !!m);
    if (m) {
      const r = await anon.call('POST', `/book/offer/${m[1]}`, {
        _csrf: csrf, _json: '1', buyer_name: 'زهرا عمومی', buyer_mobile: '09351112233',
        count: '2', t_name_1: 'زهرا عمومی', t_name_2: 'محمود عمومی',
      });
      check('رزرو از سایت عمومی', r.status === 302, `status=${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      const loc = r.headers.get('location') || '';
      publicRef = (loc.match(/voucher\/([A-Za-z0-9-]+)/) || [])[1];
      check('واچر صادر شد', !!publicRef, loc);
    }
  }
  // بدون CSRF → 403
  {
    const page = await anon.call('GET', '/services');
    const m = /\/book\/offer\/([A-Za-z0-9-]+)/.exec(typeof page.data === 'string' ? page.data : '');
    if (m) {
      const r = await anon.call('POST', `/book/offer/${m[1]}`, { buyer_name: 'هکر', buyer_mobile: '09120000000', count: '1' });
      check('رزرو بدون CSRF رد می‌شود', r.status === 403, `status=${r.status}`);
    }
  }

  /* ── فاز ۵: تامین‌کننده در الف رزرو فدرال را ببیند و تایید کند ── */
  {
    const r = await S.call('GET', '/panel/supplier/bookings');
    const html = typeof r.data === 'string' ? r.data : '';
    check('تامین‌کننده رزروهایش را می‌بیند', r.status === 200);
    check('رزرو فدرال در پنل تامین‌کننده هست', fedBookingRef ? html.includes(fedBookingRef) : false, `fedRef=${fedBookingRef}`);
    check('رزرو عمومی در پنل تامین‌کننده هست', publicRef ? html.includes(publicRef) : false, `publicRef=${publicRef}`);
  }

  console.log('\n════════ خلاصه ════════');
  const passed = results.filter((r) => r.ok).length;
  console.log(`عبور: ${passed}/${results.length}${failures ? ' — شکست: ' + failures : ''}`);
  cleanup();
  process.exit(failures ? 1 : 0);

  function cleanup() {
    for (const s of [serverA, serverB]) {
      try { s.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 500).unref();
  }
}

main().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });
