'use strict';
/**
 * داده دمو — با --reset دیتابیس را از نو می‌سازد.
 * اجرا: node scripts/seed.js --reset
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const HAMSAFAR_DB = process.env.HAMSAFAR_DB || path.join(ROOT, 'data', 'hamsafar.sqlite');
process.env.HAMSAFAR_DB = HAMSAFAR_DB;

if (process.argv.includes('--reset')) {
  for (const f of [HAMSAFAR_DB, HAMSAFAR_DB + '-wal', HAMSAFAR_DB + '-shm']) {
    try { fs.rmSync(f); } catch { /* نبود مهم نیست */ }
  }
}

const config = require('../src/config');
config.db.file = HAMSAFAR_DB;
const { init } = require('../src/db');
const U = require('../src/util');
const D = require('../src/domain');
const { SERVICE_TYPES } = require('../src/service-types');

const db = init(config);
{
  const ins = db.prepare('INSERT OR IGNORE INTO service_types (id, key, title, emoji, unit) VALUES (?,?,?,?,?)');
  for (const t of SERVICE_TYPES) ins.run(t.id, t.key, t.title, t.emoji, t.unit);
}

const t0 = U.isoNow();
const DAY = 86400000;
const future = (days, hour = 8) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour - 3.5 > 0 ? hour - 3 : hour, 30, 0, 0);
  return d.toISOString();
};
const futureDate = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

console.log('پاک‌سازی جداول...');
for (const tbl of ['booking_travelers', 'bookings', 'ledger_entries', 'package_components', 'package_departures',
  'packages', 'inventory_offers', 'inventory_items', 'reviews', 'contact_messages', 'otp_codes', 'sessions',
  'audit_log', 'fed_inbox', 'fed_idempotency', 'fed_remote_items', 'fed_sync_state', 'fed_peers', 'seo_destinations', 'settings', 'users']) {
  db.exec(`DELETE FROM ${tbl}`);
}
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('audit_log','ledger_entries','reviews','contact_messages','seo_destinations')");

console.log('ساخت کاربران...');
function mkUser(u) {
  db.prepare(`INSERT INTO users (id,role,status,full_name,email,mobile,password_hash,company_title,is_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(u.id, u.role, u.status || 'active', u.name, u.email || null, u.mobile || null,
      u.password ? U.hashPassword(u.password) : null, u.company || null, u.owner ? 1 : 0,
      u.created || t0, t0);
  return u.id;
}
const admin = mkUser({ id: 'U-ADMIN1', role: 'admin', name: 'مدیر سیستم', email: 'admin@demo-travel.ir', password: 'admin1234', owner: true });
const employee = mkUser({ id: 'U-EMPLO1', role: 'employee', name: 'سارا رضایی', email: 'sara@demo-travel.ir', password: 'sara1234' });
const supplierBus = mkUser({ id: 'U-SUP-BUS', role: 'supplier', name: 'حاج رضا چارترکار', email: 'bus@demo-travel.ir', password: 'bus1234', company: 'چارتر اتوبوس الماس سفر' });
const supplierHotel = mkUser({ id: 'U-SUP-HOT', role: 'supplier', name: 'هتلداری آریا', email: 'hotel@demo-travel.ir', password: 'hotel1234', company: 'هتل آریا کیش' });
const supplierAir = mkUser({ id: 'U-SUP-AIR', role: 'supplier', name: 'چارتر پرواز آسیا', email: 'air@demo-travel.ir', password: 'air1234', company: 'چارتر پرواز آسیا' });
const packager = mkUser({ id: 'U-PKG-01', role: 'packager', name: 'مهدی تورساز', email: 'mahdi@demo-travel.ir', password: 'mahdi1234', company: 'تورسازی سیر و سفر' });
const agent = mkUser({ id: 'U-AGT-01', role: 'agent', name: 'مریم واسطه', email: 'maryam@demo-travel.ir', password: 'maryam1234', company: 'آژانس مسافرتی مهر' });
const customer = mkUser({ id: 'U-CUS-01', role: 'customer', name: 'علی مسافر', mobile: '09121234567' });

console.log('ساخت موجودی...');
function mkItem(i) {
  db.prepare(`INSERT INTO inventory_items (id,type_id,owner_user_id,title,origin,destination,depart_at,arrive_at,
    checkin_date,nights,hotel_name,room_type,meal_plan,class_text,unit_label,base_price,capacity_total,description,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(i.id, i.type, i.owner, i.title, i.origin || null, i.dest || null, i.depart || null, i.arrive || null,
      i.checkin || null, i.nights || null, i.hotel || null, i.room || null, i.meal || null,
      i.cls || null, i.unit || 'صندلی', i.price, i.cap, i.desc || null, 'active', t0, t0);
}
// اتوبوس‌ها
mkItem({ id: 'I-BUS-01', type: 2, owner: supplierBus, title: 'اتوبوس VIP تهران-مشهد', origin: 'تهران', dest: 'مشهد', depart: future(7, 21), arrive: future(8, 9), cls: 'VIP ۲۵۳', unit: 'صندلی', price: 850000, cap: 44, desc: 'اتوبوس VIP اسکانیا، پذیرایی رایگان، توقف در رستوران راه' });
mkItem({ id: 'I-BUS-02', type: 2, owner: supplierBus, title: 'اتوبوس تهران-کیش (ساحلی)', origin: 'تهران', dest: 'بندرعباس', depart: future(12, 20), arrive: future(13, 10), cls: 'درجه ۱', unit: 'صندلی', price: 950000, cap: 40 });
// هتل
mkItem({ id: 'I-HOT-01', type: 4, owner: supplierHotel, title: 'هتل آریا کیش — ۵ ستاره ساحلی', dest: 'کیش', checkin: future(10), nights: 3, hotel: 'هتل آریا', room: 'دو تخته', meal: 'BB (صبحانه)', cls: '۵ ستاره', unit: 'اتاق', price: 4200000, cap: 15, desc: 'ویو دریا، ۲۰۰ متر تا ساحل، صبحانه بوفه' });
mkItem({ id: 'I-HOT-02', type: 4, owner: supplierHotel, title: 'هتل آریا کیش — سوییت خانواده', dest: 'کیش', checkin: future(10), nights: 3, hotel: 'هتل آریا', room: 'سوییت ۴ تخته', meal: 'HB (نصف پانسیون)', cls: '۵ ستاره', unit: 'اتاق', price: 6800000, cap: 8 });
// پرواز
mkItem({ id: 'I-AIR-01', type: 1, owner: supplierAir, title: 'پرواز چارتری تهران-کیش', origin: 'تهران', dest: 'کیش', depart: future(10, 7), arrive: future(10, 8.5), cls: 'اقتصادی', unit: 'صندلی', price: 3100000, cap: 120, desc: 'چارتری ایران‌ایرتور، اقامت ۳ شب' });
mkItem({ id: 'I-AIR-02', type: 1, owner: supplierAir, title: 'پرواز چارتری کیش-تهران (بازگشت)', origin: 'کیش', dest: 'تهران', depart: future(13, 19), arrive: future(13, 20.5), cls: 'اقتصادی', unit: 'صندلی', price: 3300000, cap: 120 });
// قطار
mkItem({ id: 'I-TRN-01', type: 3, owner: supplierBus, title: 'قطار ۴ ستاره تهران-یزد', origin: 'تهران', dest: 'یزد', depart: future(15, 18), arrive: future(16, 6), cls: 'کوپه ۴ تخته', unit: 'کوپه/صندلی', price: 1250000, cap: 20 });

console.log('ساخت آفرها...');
function mkOffer(o) {
  db.prepare(`INSERT INTO inventory_offers (id,item_id,seller_user_id,kind,buyer_user_id,qty,unit_price,
    visible_to_agents,visible_to_public,public_price,status,note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.id, o.item, o.seller, o.kind || 'market', o.buyer || null, o.qty, o.price,
      o.agents === false ? 0 : 1, o.public ? 1 : 0, o.publicPrice || null, 'open', o.note || null, t0, t0);
}
// عرضه عمومی (سایت + بازار + فدراسیون)
mkOffer({ id: 'O-BUS-01', item: 'I-BUS-01', seller: supplierBus, qty: 44, price: 850000, public: true, publicPrice: 1050000 });
mkOffer({ id: 'O-BUS-02', item: 'I-BUS-02', seller: supplierBus, qty: 40, price: 950000, public: false, agents: true });
mkOffer({ id: 'O-HOT-01', item: 'I-HOT-01', seller: supplierHotel, qty: 15, price: 4200000, public: true, publicPrice: 4950000 });
mkOffer({ id: 'O-HOT-02', item: 'I-HOT-02', seller: supplierHotel, qty: 8, price: 6800000, public: false });
mkOffer({ id: 'O-AIR-01', item: 'I-AIR-01', seller: supplierAir, qty: 120, price: 3100000, public: true, publicPrice: 3650000 });
mkOffer({ id: 'O-AIR-02', item: 'I-AIR-02', seller: supplierAir, qty: 120, price: 3300000, public: false });
mkOffer({ id: 'O-TRN-01', item: 'I-TRN-01', seller: supplierBus, qty: 20, price: 1250000, public: true, publicPrice: 1480000 });

console.log('ساخت پکیج...');
db.prepare(`INSERT INTO packages (id,creator_user_id,title,slug,summary,description,origin,destination,days,nights,base_price,public_published,status,cover_emoji,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('P-KISH-01', packager, 'تور ۳ شب کیش با پرواز و هتل ۵ ستاره', 'torkish3',
    'پرواز چارتری رفت و برگشت + ۳ شب هتل آریا ۵ ستاره با صبحانه + ترانسفر فرودگاه',
    'برنامه سفر:\nروز ۱: پرواز ساعت ۷ صبح، ورود به هتل، بعدازظهر گشت شهر (یونسکو، کشتی یونانی، سواحل مرجانی)\nروز ۲: صبحانه بوفه، روز آزاد ساحل، شب بازار مرکزی و کشتی کروز\nروز ۳: صبحانه، غروب ساحل مرجان، خرید از بازار آزاد\nروز ۴: صبحانه، ترانسفر به فرودگاه، بازگشت\n\nشامل: بلیط پرواز چارتری رفت و برگشت، ۳ شب اقامت هتل آریا با صبحانه، ترانسفر فرودگاه-هتل-فرودگاه، بیمه مسافرتی\nغیرمحتمل: ناهار و شام، گشت‌های اختیاری',
    'تهران', 'کیش', 4, 3, 12500000, 1, 'published', '🏝️', t0, t0);
// اجزا: پرواز رفت + هتل + پرواز برگشت
for (const [offer, qty, note] of [['O-AIR-01', 1, 'پرواز رفت — هر نفر'], ['O-HOT-01', 1, 'اتاق دو تخته (۲ نفره) — به‌ازای هر ۲ نفر یک اتاق'], ['O-AIR-02', 1, 'پرواز بازگشت']]) {
  const item = db.prepare('SELECT item_id FROM inventory_offers WHERE id=?').get(offer).item_id;
  db.prepare(`INSERT INTO package_components (id,package_id,offer_id,item_id,qty_per_person,notes,position) VALUES (?,?,?,?,?,?,?)`)
    .run(U.randomId(), 'P-KISH-01', offer, item, qty, note, offer === 'O-AIR-01' ? 1 : offer === 'O-HOT-01' ? 2 : 3);
}
// تاریخ اعزام
for (const [start, cap, price] of [[futureDate(10), 20, 12500000], [futureDate(17), 15, 13100000]]) {
  db.prepare(`INSERT INTO package_departures (id,package_id,start_date,capacity_total,price_per_person,status,book_until,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(U.randomId(), 'P-KISH-01', start, cap, price, 'open', new Date(Date.now() + (start === futureDate(10) ? 5 : 12) * DAY).toISOString().slice(0, 10), t0);
}

console.log('ساخت پکیج دوم (یزد)...');
db.prepare(`INSERT INTO packages (id,creator_user_id,title,slug,summary,description,origin,destination,days,nights,base_price,public_published,status,cover_emoji,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('P-YZD-01', packager, 'تور ۲ شب یزد؛ کویر و بافت تاریخی', 'toryazd2',
    'قطار ۴ ستاره رفت و برگشت + ۲ شب اقامت خانه سنتی + گشت بافت تاریخی',
    'سفر به دل کویر: دوخت بادگیرها، باغ دولت‌آباد، مسجد جامع، سکوت کویر در پارلان.\nشامل: قطار ۴ ستانه رفت و برگشت، ۲ شب خانه سنتی با صبحانه، گشت بافت تاریخی با راهنما.',
    'تهران', 'یزد', 3, 2, 6900000, 1, 'published', '🏜️', t0, t0);
for (const [offer, qty, note] of [['O-TRN-01', 1, 'قطار رفت'], ['O-TRN-01', 1, 'قطار بازگشت (صندلی رزرو جدا)']]) {
  const item = db.prepare('SELECT item_id FROM inventory_offers WHERE id=?').get(offer).item_id;
  db.prepare(`INSERT INTO package_components (id,package_id,offer_id,item_id,qty_per_person,notes,position) VALUES (?,?,?,?,?,?,?)`)
    .run(U.randomId(), 'P-YZD-01', offer, item, qty, note, offer === 'O-TRN-01' ? 1 : 2);
}
db.prepare(`INSERT INTO package_departures (id,package_id,start_date,capacity_total,price_per_person,status,book_until,created_at)
  VALUES (?,?,?,?,?,?,?,?)`)
  .run(U.randomId(), 'P-YZD-01', futureDate(15), 16, 6900000, 'open', futureDate(11), t0);

console.log('ساخت مقصدهای سئو...');
const dests = [
  ['kish', 'کیش', 'جزیره مرجانی با سواحل فیروزه‌ای، بازار آزاد و تفریحات دریایی — مقصد محبوب تورهای سه‌شبه.', '🏝️'],
  ['mashhad', 'مشهد', 'شهر زیارت و ضریح مطهر؛ اقامتی معنوی با بهترین هتل‌های اطراف حرم.', '🕌'],
  ['yazd', 'یزد', 'نخستین شهر خشتی ثبت جهانی؛ بادگیرها، باغ دولت‌آباد و سکوت کویر.', '🏜️'],
  ['kish-hotel', 'هتل‌های کیش', 'رزرو آنلاین هتل‌های کیش از ۵ ستاره ساحلی تا آپارتمان اقتصادی.', '🏨'],
];
const insD = db.prepare('INSERT INTO seo_destinations (slug, title, description, emoji) VALUES (?,?,?,?)');
for (const d of dests) insD.run(...d);

console.log('ساخت چند رزرو و تراکنش نمونه...');
// رزرو تاییدشده از سایت عمومی
{
  const dep = db.prepare(`SELECT d.* FROM package_departures d JOIN packages p ON p.id=d.package_id WHERE p.slug='torkish3' ORDER BY d.start_date LIMIT 1`).get();
  const r = D.bookPackage(db, {
    departure: dep, sellerId: packager, buyerName: 'حسین کاظمی', buyerMobile: '09121112233',
    travelers: [{ full_name: 'حسین کاظمی', national_id: '0079845612' }, { full_name: 'نگار کاظمی', national_id: '0081234567' }],
    note: 'رزرو از سایت', source: 'web',
  });
  D.confirmBooking(db, r.id, { id: admin, role: 'admin' }, 'demo');
}
// رزرو در انتظار از واسطه
{
  const offer = db.prepare(`SELECT o.*, i.title FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id WHERE o.id='O-BUS-01'`).get();
  D.bookOffer(db, {
    offer, sellerId: agent, buyerName: 'فاطمه احمدی', buyerMobile: '09351234567',
    travelers: [{ full_name: 'فاطمه احمدی' }, { full_name: 'امیر احمدی' }],
    note: 'فروش آژانس مهر', source: 'panel',
  });
}
// رزرو مستقیم تامین‌کننده از سایت (پرواز)
{
  const offer = db.prepare(`SELECT o.*, i.title FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id WHERE o.id='O-AIR-01'`).get();
  const r = D.bookOffer(db, {
    offer, sellerId: supplierAir, buyerName: 'رضا محمدی', buyerMobile: '09129998877',
    travelers: [{ full_name: 'رضا محمدی' }, { full_name: 'سمیرا محمدی' }, { full_name: 'کیان محمدی' }],
    note: 'رزرو از سایت', source: 'web',
  });
  D.confirmBooking(db, r.id, { id: admin, role: 'admin' }, 'demo');
}

// نظر تاییدشده
db.prepare(`INSERT INTO reviews (booking_id, package_id, author_name, rating, comment, approved, created_at)
  VALUES (NULL, 'P-KISH-01', 'حسین کاظمی', 5, 'همه‌چیز دقیقاً مثل برنامه پیش رفت؛ هتل عالی و ترانسفر سر وقت. ممنون از تیم پشتیبانی.', 1, ?)`).run(t0);

// پیام تماس نمونه
db.prepare(`INSERT INTO contact_messages (name, mobile, email, subject, body, created_at) VALUES (?,?,?,?,?,?)`)
  .run('زهرا نوری', '09361112233', 'zahra@example.com', 'درخواست پنل: واسطه',
    'سلام، آژانس مسافرتی در اصفهان داریم و می‌خواهیم تورهای شما را بفروشیم. شرایط همکاری چیست؟', t0);
// تنظیمات
for (const [k, v] of Object.entries({ default_commission_pct: '8', payment_deadline_min: '60', low_capacity_pct: '20', voucher_support_phone: '021-91008080' })) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(k, v);
}

console.log('✅ داده دمو آماده شد.');
console.log('   ورود مدیر:      admin@demo-travel.ir / admin1234');
console.log('   تامین‌کننده:     bus@demo-travel.ir / bus1234  (چارتر اتوبوس)');
console.log('   پکیج‌ساز:       mahdi@demo-travel.ir / mahdi1234');
console.log('   واسطه:          maryam@demo-travel.ir / maryam1234');
console.log('   کارمند:         sara@demo-travel.ir / sara1234');
