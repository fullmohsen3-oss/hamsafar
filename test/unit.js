'use strict';
/** تست‌های واحد — دامنه، ابزارها، امنیت. اجرا: node test/unit.js */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`❌ ${name} — ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'برابر نیست'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'باید truthy باشد'); }
function notOk(v, msg) { if (v) throw new Error(msg || 'باید falsy باشد'); }

/* ─── ابزارها ─── */
const U = require('../src/util');

t('normalizeMobile: فرمت‌های مختلف', () => {
  eq(U.normalizeMobile('09121234567'), '09121234567');
  eq(U.normalizeMobile('+989121234567'), '09121234567');
  eq(U.normalizeMobile('00989121234567'), '09121234567');
  eq(U.normalizeMobile('9121234567'), '09121234567');
  eq(U.normalizeMobile('0912123456'), null, 'کوتاه');
  eq(U.normalizeMobile('۰۹۱۲۱۲۳۴۵۶۷'), '09121234567', 'ارقام فارسی');
});

t('normalizeEmail: اعتبارسنجی', () => {
  ok(U.normalizeEmail('Ali.Example@Domain.COM'), 'ایمیل معتبر');
  eq(U.normalizeEmail('Ali@Domain.COM'), 'ali@domain.com', 'کوچک‌سازی');
  notOk(U.normalizeEmail('بدون-atsign'), 'بدون @');
  notOk(U.normalizeEmail('a@b'), 'بدون دامنه');
});

t('faDigitsToEn', () => {
  eq(U.faDigitsToEn('۱۲۳۴۵'), '12345');
  eq(U.faDigitsToEn('٤٥٦'), '456', 'ارقام عربی');
});

t('isValidNationalId: کد ملی', () => {
  ok(U.isValidNationalId('0076409627'), 'کد معتبر');
  notOk(U.isValidNationalId('1234567890'), 'کد نامعتبر');
  notOk(U.isValidNationalId('1111111111'), 'تکراری');
  notOk(U.isValidNationalId('12345'), 'کوتاه');
  ok(U.isValidNationalId('۰۰۷۶۴۰۹۶۲۷'), 'با ارقام فارسی');
});

t('toAmount: مبالغ', () => {
  eq(U.toAmount('1,250,000'), 1250000, 'با کاما');
  eq(U.toAmount(1500), 1500);
  eq(U.toAmount('-5'), null, 'منفی');
  eq(U.toAmount('12.5'), null, 'اعشاری در ریال مجاز نیست');
  eq(U.toAmount(''), null);
});

t('normDate / isDate', () => {
  eq(U.normDate('2026-3-5'), '2026-03-05', 'پر کردن صفر');
  eq(U.normDate('1400/02/03'), null, 'شمسی پذیرفته نمی‌شود');
  ok(U.isDate('2026-02-28'));
  notOk(U.isDate('2026-02-30'), '۳۰ فوریه وجود ندارد');
  notOk(U.isDate('2026-13-01'));
});

t('refCode: ساخت کد پیگیری', () => {
  const r = U.refCode('HS');
  ok(/^HS-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(r), `فرمت: ${r}`);
});

t('hashPassword / verifyPassword', () => {
  const h = U.hashPassword('secret123');
  ok(h.startsWith('scrypt$'), 'فرم هش');
  ok(U.verifyPassword('secret123', h));
  notOk(U.verifyPassword('wrong', h));
  notOk(U.verifyPassword('secret123', 'garbage'));
});

t('esc: HTML escape', () => {
  eq(U.esc('<script>"x"&\'y\'</script>'), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});

t('slugify', () => {
  eq(U.slugify('تور ۳ شب کیش!'), 'تور-۳-شب-کیش');
  eq(U.slugify('Hello  World---'), 'hello-world');
});

/* ─── دامنه: دیتابیس در حافظه ─── */
process.env.HAMSAFAR_DB = ':memory:';
const config = require('../src/config');
config.db.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-unit-')), 'u.sqlite');
const { init } = require('../src/db');
const D = require('../src/domain');
const { SERVICE_TYPES } = require('../src/service-types');
const db = init(config);
{
  const ins = db.prepare('INSERT OR IGNORE INTO service_types (id, key, title, emoji, unit) VALUES (?,?,?,?,?)');
  for (const x of SERVICE_TYPES) ins.run(x.id, x.key, x.title, x.emoji, x.unit);
}

// کاربران آزمون
const now = U.isoNow();
function mkUser(id, role, extra = {}) {
  db.prepare(`INSERT INTO users (id,role,status,full_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, role, 'active', extra.name || id, (extra.email || id + '@x.ir'), now, now);
}
mkUser('U1', 'supplier', { name: 'تامین' });
mkUser('U2', 'agent', { name: 'واسطه' });
mkUser('U3', 'packager', { name: 'پکیج‌ساز' });

// خدمت و آفر آزمون
db.prepare(`INSERT INTO inventory_items (id,type_id,owner_user_id,title,unit_label,base_price,capacity_total,status,created_at,updated_at)
  VALUES ('I1',2,'U1','اتوبوس تست','صندلی',500000,10,'active',?,?)`).run(now, now);
db.prepare(`INSERT INTO inventory_offers (id,item_id,seller_user_id,kind,qty,unit_price,visible_to_agents,visible_to_public,public_price,status,created_at,updated_at)
  VALUES ('O1','I1','U1','market',10,500000,1,1,650000,'open',?,?)`).run(now, now);

t('offerAvailableQty: ظرفیت اولیه', () => {
  const { avail, offer } = D.offerAvailableQty(db, 'O1');
  eq(avail, 10);
  ok(offer);
});

t('bookOffer: رزرو مستقیم (تامین‌کننده خودش می‌فروشد)', () => {
  const { offer } = D.offerAvailableQty(db, 'O1');
  const r = D.bookOffer(db, {
    offer, sellerId: 'U1', buyerName: 'خریدار تست', buyerMobile: '09121110000',
    travelers: [{ full_name: 'خریدار تست' }], source: 'web',
  });
  ok(r.ref_code.startsWith('HS-'));
  eq(r.total, 650000, 'قیمت عمومی ملاک است');
  const { avail } = D.offerAvailableQty(db, 'O1');
  eq(avail, 9, 'ظرفیت کاهش یافت');
});

t('bookOffer: رزرو واسطه با کمیسیون', () => {
  const { offer } = D.offerAvailableQty(db, 'O1');
  const r = D.bookOffer(db, {
    offer, sellerId: 'U2', buyerName: 'مشتری واسطه', buyerMobile: '09121112222',
    travelers: [{ full_name: 'م' }, { full_name: 'ن' }], source: 'panel',
  });
  eq(r.total, 1300000, '۲ نفر × ۶۵۰ هزار');
  eq(r.commission, 300000, 'کمیسیون = (۶۵۰-۵۰۰)×۲');
  const bal = D.userBalance(db, 'U2');
  eq(bal, 300000 - 1000000, 'بدهی خرید + طلب کمیسیون = -700000');
});

t('bookOffer: ظرفیت ناکافی خطا می‌دهد', () => {
  const { offer } = D.offerAvailableQty(db, 'O1');
  let threw = null;
  try {
    D.bookOffer(db, {
      offer, sellerId: 'U1', buyerName: 'زیاد', buyerMobile: '09121113333',
      travelers: Array.from({ length: 20 }, (_, i) => ({ full_name: 'm' + i })), source: 'web',
    });
  } catch (e) { threw = e; }
  ok(threw && threw.status === 409, `باید 409 باشد: ${threw && threw.status}`);
});

t('bookOffer: صندلی آخر دقیقاً قابل رزرو است', () => {
  // ظرفیت باقی: 10-1-2=7 → رزرو ۷ نفر باید موفق شود
  const { offer } = D.offerAvailableQty(db, 'O1');
  const r = D.bookOffer(db, {
    offer, sellerId: 'U1', buyerName: 'آخر', buyerMobile: '09121114444',
    travelers: Array.from({ length: 7 }, (_, i) => ({ full_name: 'k' + i })), source: 'web',
  });
  eq(r.total, 650000 * 7);
  const { avail } = D.offerAvailableQty(db, 'O1');
  eq(avail, 0, 'ظرفیت صفر شد');
  // حالا حتی ۱ نفر ممکن نیست
  let threw = null;
  try {
    D.bookOffer(db, { offer, sellerId: 'U1', buyerName: 'x', buyerMobile: '09121115555', travelers: [{ full_name: 'x' }], source: 'web' });
  } catch (e) { threw = e; }
  ok(threw && threw.status === 409);
});

t('cancelBooking: لغو، ظرفیت برمی‌گردد و مالی معکوس می‌شود', () => {
  const balBefore = D.userBalance(db, 'U2');
  const bk = db.prepare(`SELECT * FROM bookings WHERE seller_user_id='U2' AND status != 'cancelled' AND kind='offer'`).get();
  ok(bk, 'رزرو واسطه موجود است');
  D.cancelBooking(db, bk.id, { id: 'U2', role: 'agent' }, 'تست');
  const b2 = db.prepare('SELECT * FROM bookings WHERE id=?').get(bk.id);
  eq(b2.status, 'cancelled');
  const balAfter = D.userBalance(db, 'U2');
  // تراکنش‌های این رزرو: purchase -1,000,000 و commission +300,000 → لغو یعنی +700,000 برگشت
  eq(balAfter, balBefore + 700000, 'برگشت کامل اثر مالی');
  // ظرفیت برگشت؟ (رزرو لغو‌شده حساب نمی‌شود)
  const { avail } = D.offerAvailableQty(db, 'O1');
  eq(avail, 2, 'ظرفیت ۲ نفره برگشت (لغو رزرو ۲ نفره واسطه)');
});

/* پکیج */
db.prepare(`INSERT INTO packages (id,creator_user_id,title,slug,summary,origin,destination,days,nights,base_price,public_published,status,created_at,updated_at)
  VALUES ('P1','U3','تور تست','tour-test','خلاصه','تهران','کیش',3,2,9000000,1,'published',?,?)`).run(now, now);
db.prepare(`INSERT INTO package_departures (id,package_id,start_date,capacity_total,price_per_person,status,created_at)
  VALUES ('D1','P1','2099-05-01',5,9000000,'open',?)`).run(now);

t('bookPackage: رزرو مستقیم پکیج', () => {
  const dep = db.prepare('SELECT * FROM package_departures WHERE id=?').get('D1');
  const r = D.bookPackage(db, {
    departure: dep, sellerId: 'U3', buyerName: 'مسافر تور', buyerMobile: '09121116666',
    travelers: [{ full_name: 'الف' }, { full_name: 'ب' }], source: 'web',
  });
  ok(r.ref_code.startsWith('HT-'));
  eq(r.total, 18000000);
  const { avail } = D.departureAvailableQty(db, 'D1');
  eq(avail, 3);
});

t('bookPackage: فروش واسطه با کمیسیون ۸٪', () => {
  const dep = db.prepare('SELECT * FROM package_departures WHERE id=?').get('D1');
  const r = D.bookPackage(db, {
    departure: dep, sellerId: 'U2', buyerName: 'مشتری آژانس', buyerMobile: '09121117777',
    travelers: [{ full_name: 'ج' }], source: 'panel', commissionRate: 0.08,
  });
  eq(r.commission, 720000, '۸٪ از ۹ میلیون');
});

t('bookPackage: تاریخ گذشته رد می‌شود', () => {
  db.prepare(`INSERT INTO package_departures (id,package_id,start_date,capacity_total,price_per_person,status,created_at)
    VALUES ('DOLD','P1','2020-01-01',5,1000,'open',?)`).run(now);
  const dep = db.prepare('SELECT * FROM package_departures WHERE id=?').get('DOLD');
  let threw = null;
  try {
    D.bookPackage(db, { departure: dep, sellerId: 'U3', buyerName: 'x', buyerMobile: '09121110000', travelers: [{ full_name: 'x' }], source: 'web' });
  } catch (e) { threw = e; }
  // مهلت رزرو گذشته (book_until) یا وضعیت؛ اینجا فقط start گذشته — سیستم book_until را چک می‌کند نه start؛ وضعیت open است پس باید موفق شود؟
  // طراحی: تاریخ گذشته باید رد شود — این تست مستند رفتار فعلی است؛ اگر پاس شد یعنی نیاز به اعتبارسنجی start دارد
  if (!threw) {
    // افزودن چک start_date به bookPackage لازم است
    throw new Error('تاریخ اعزام گذشته باید رد شود (نیاز به اعتبارسنجی start_date)');
  }
});

/* مالی */
t('postLedger: تراز تجمعی', () => {
  const before = D.userBalance(db, 'U3');
  D.postLedger(db, { userId: 'U3', kind: 'deposit', amount: 1000, note: 'a' });
  D.postLedger(db, { userId: 'U3', kind: 'payout', amount: -400, note: 'b' });
  eq(D.userBalance(db, 'U3'), before + 600, 'مانده = قبل + 1000 - 400');
});

/* نشست و احراز */
t('createSession / getSessionUser / destroySession', () => {
  const sid = D.createSession(db, 'U1', '1.2.3.4', 'test-agent');
  ok(sid.length >= 32);
  const u = D.getSessionUser(db, sid);
  ok(u && u.id === 'U1');
  D.destroySession(db, sid);
  notOk(D.getSessionUser(db, sid), 'بعد از حذف نشست معتبر نیست');
});

t('getUserByLogin: با ایمیل', () => {
  ok(D.getUserByLogin(db, 'u1@x.ir'));
  notOk(D.getUserByLogin(db, 'nobody@x.ir'));
});

/* امضای فدراسیون */
const F = require('../src/http/federation');
const crypto = require('node:crypto');

t('sign: HMAC پایدار و وابسته به کلید/مسیر/بدنه', () => {
  const s1 = F.sign('key1', 'GET', '/x', '');
  const s2 = F.sign('key1', 'GET', '/x', '');
  const s3 = F.sign('key2', 'GET', '/x', '');
  const s4 = F.sign('key1', 'POST', '/x', '');
  const s5 = F.sign('key1', 'GET', '/y', '');
  eq(s1, s2, 'قطعیت');
  ok(s1 !== s3 && s1 !== s4 && s1 !== s5, 'حساس به کلید/متد/مسیر');
  eq(s1, crypto.createHmac('sha256', 'key1').update(['1', 'GET', '/x', 'key1', ''].join('\n')).digest('hex'));
});

/* RBAC */
const { can } = require('../src/auth');
t('RBAC: ماتریس دسترسی', () => {
  ok(can('admin', 'anything.at.all'));
  ok(can('supplier', 'inventory.manage'));
  notOk(can('agent', 'inventory.manage'));
  ok(can('agent', 'market.buy'));
  ok(can('customer', 'bookings.view.own'));
  notOk(can('customer', 'bookings.view'));
  notOk(can('employee', 'inventory.manage'));
});

console.log(`\n════════ تعداد: ${pass + fail} | عبور: ${pass} | شکست: ${fail} ════════`);
process.exit(fail ? 1 : 0);
