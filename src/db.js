'use strict';
/**
 * لایه دسترسی داده — node:sqlite (همان موتور SQLite داخلی Node، بدون وابستگی)
 * WAL + FOREIGN KEYS + busy_timeout؛ مهاجرت‌های نسخه‌دار.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const log = require('./logger');

const MIGRATIONS = [
  {
    version: 1,
    name: 'core',
    sql: `
-- ─────────────── شرکت، کاربران، نشست‌ها ───────────────
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- شناسه کوتاه
  role TEXT NOT NULL CHECK (role IN ('admin','employee','supplier','packager','agent','customer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending')),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,                  -- برای پنل‌ها
  mobile TEXT UNIQUE,                 -- برای مشتریان سایت عمومی
  password_hash TEXT,                 -- پنل‌ها + مشتریانی که رمز ساختند
  company_title TEXT,                 -- عنوان کسب‌وکار تامین‌کننده/واسطه/پکیج‌ساز
  national_id TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,-- مدیر مالک (اولین ادمین)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_role ON users(role, status);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT,
  last_seen_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  mobile TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);
CREATE INDEX idx_otp_mobile ON otp_codes(mobile, purpose);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT, actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT, entity_id TEXT,
  detail TEXT,                        -- JSON
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

-- ─────────────── خدمات و عرضه‌ها (موجودی) ───────────────
CREATE TABLE service_types (
  id INTEGER PRIMARY KEY,             -- 1=flight 2=bus 3=train 4=hotel 5=transfer ...
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT,
  unit TEXT
);

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES service_types(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),   -- تامین‌کننده مالک فعلی
  title TEXT NOT NULL,
  origin TEXT, destination TEXT,      -- برای حمل‌ونقل
  route_text TEXT,                    -- متن مسیر آزاد
  depart_at TEXT,                     -- ISO datetime (مبدا UTC)
  arrive_at TEXT,
  checkin_date TEXT, checkin_until TEXT,  -- هتل
  nights INTEGER,
  hotel_name TEXT, room_type TEXT, meal_plan TEXT,
  class_text TEXT,                    -- کلاس اتوبوس/قطار/پرواز
  unit_label TEXT NOT NULL DEFAULT 'صندلی', -- صندلی / اتاق / بلیط
  base_price INTEGER NOT NULL CHECK (base_price >= 0),
  capacity_total INTEGER NOT NULL CHECK (capacity_total > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_inv_owner ON inventory_items(owner_user_id, status);
CREATE INDEX idx_inv_type_date ON inventory_items(type_id, depart_at);
CREATE INDEX idx_inv_dest ON inventory_items(destination);

-- اصناف عرضه: هر ردیف یک معاملهٔ انتقال مالکیت/فروش تضمینی یا عرضه در بازار
CREATE TABLE inventory_offers (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('market','wholesale')),  -- بازار عمومی/فروش تضمینی به همکار
  buyer_user_id TEXT REFERENCES users(id),                    -- در wholesale مقصد مشخص
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  visible_to_agents INTEGER NOT NULL DEFAULT 1,   -- نمایش در بازار واسطه‌ها
  visible_to_public INTEGER NOT NULL DEFAULT 0,   -- نمایش در سایت عمومی
  public_price INTEGER,                            -- قیمت فروش عمومی (≥ unit_price)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','sold_out')),
  note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_offers_item ON inventory_offers(item_id);
CREATE INDEX idx_offers_seller ON inventory_offers(seller_user_id, status);
CREATE INDEX idx_offers_market ON inventory_offers(kind, status, visible_to_agents);

-- ─────────────── پکیج‌ها (تورها) ───────────────
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  summary TEXT,
  description TEXT,
  origin TEXT, destination TEXT,
  days INTEGER, nights INTEGER,
  base_price INTEGER NOT NULL CHECK (base_price >= 0),  -- قیمت هر نفر
  public_published INTEGER NOT NULL DEFAULT 0,          -- انتشار در سایت عمومی
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  cover_emoji TEXT DEFAULT '🎒',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_packages_pub ON packages(public_published, status);

-- اجزای یک پکیج: به عرضه‌های موجودی یا به ایتم مستقیم وصل می‌شود
CREATE TABLE package_components (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  offer_id TEXT REFERENCES inventory_offers(id),        -- از بازار
  item_id TEXT REFERENCES inventory_items(id),          -- مستقیم از موجودی خودی
  qty_per_person INTEGER,      -- برای اقامت
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pkgcomp_pkg ON package_components(package_id);

--Departures/departure dates یک پکیج
CREATE TABLE package_departures (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,              -- yyyy-mm-dd
  capacity_total INTEGER NOT NULL CHECK (capacity_total > 0),
  price_per_person INTEGER NOT NULL CHECK (price_per_person >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','departed','cancelled')),
  book_until TEXT,                       -- آخرین مهلت رزرو
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pkgdep_pkg ON package_departures(package_id, start_date);

-- ─────────────── رزروها ───────────────
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  ref_code TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('offer','package')),
  offer_id TEXT REFERENCES inventory_offers(id),
  package_departure_id TEXT REFERENCES package_departures(id),
  customer_user_id TEXT REFERENCES users(id),   -- اگر عضو بود
  seller_user_id TEXT NOT NULL REFERENCES users(id),  -- فروشنده در این شرکت (واسطه/پکیج‌ساز/تامین‌کننده)
  supplier_user_id TEXT REFERENCES users(id),   -- مالک نهایی موجودی (برای بدهی/طلب مالی)
  buyer_name TEXT NOT NULL,
  buyer_mobile TEXT NOT NULL,
  traveler_count INTEGER NOT NULL CHECK (traveler_count > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  total_price INTEGER NOT NULL CHECK (total_price >= 0),
  commission INTEGER NOT NULL DEFAULT 0 CHECK (commission >= 0),  -- کمیسیون فروشنده داخلی
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','confirmed','cancelled','expired','used')),
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','panel','federation','pos')),
  pay_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (pay_status IN ('unpaid','paid','refunded')),
  fed_peer_id TEXT,                       -- اگر از شرکت فدراسیون‌شده آمده
  fed_booking_id TEXT,                    -- شناسه رزرو در شرکت مبدأ
  note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_bookings_seller ON bookings(seller_user_id, created_at DESC);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_offer ON bookings(offer_id);
CREATE INDEX idx_bookings_pkgdep ON bookings(package_departure_id);
CREATE INDEX idx_bookings_customer ON bookings(customer_user_id);

CREATE TABLE booking_travelers (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  national_id TEXT,
  mobile TEXT, birth_year INTEGER,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_btrav_booking ON booking_travelers(booking_id);

-- ─────────────── فدراسیون بین‌شرکتی ───────────────
CREATE TABLE fed_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                       -- نام شرکت مقابل
  base_url TEXT NOT NULL,                  -- ریشه API فدراسیون طرف مقابل
  api_key TEXT NOT NULL,                   -- کلید ما برای تماس با آن‌ها
  our_key_for_them TEXT NOT NULL,          -- کلیدی که به آن‌ها داده‌ایم تا ما را صدا بزنند
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  our_balance INTEGER NOT NULL DEFAULT 0,  -- بدهی ما به آن‌ها (ریال، مثبت=بدهکار)
  trust_level TEXT NOT NULL DEFAULT 'standard' CHECK (trust_level IN ('standard','verified')),
  note TEXT,
  last_sync_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE fed_sync_state (
  peer_id TEXT NOT NULL REFERENCES fed_peers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- catalog / offers
  cursor TEXT,                              -- آخرین تغییری که دیدیم (ISO یا نسخه)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (peer_id, kind)
);

-- کش کاتالوگ نمایشی از همتاها (بازتابی از آفرهای فدرال)
CREATE TABLE fed_remote_items (
  id TEXT PRIMARY KEY,             -- peer_id + ':' + remote_offer_id
  peer_id TEXT NOT NULL REFERENCES fed_peers(id) ON DELETE CASCADE,
  remote_offer_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- offer / package
  title TEXT NOT NULL,
  type_key TEXT,
  origin TEXT, destination TEXT,
  depart_at TEXT,
  unit_price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'IRR',
  qty_available INTEGER,
  summary TEXT,
  raw_meta TEXT,                   -- JSON کامل برای بازتاب
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_fedremote_peer ON fed_remote_items(peer_id);

CREATE TABLE fed_inbox (
  id TEXT PRIMARY KEY,             -- شناسه پیام از طرف مقابل
  peer_id TEXT NOT NULL REFERENCES fed_peers(id) ON DELETE CASCADE,
  action TEXT NOT NULL,            -- reserve / cancel / ping ...
  payload TEXT NOT NULL,           -- JSON
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','rejected','error')),
  result TEXT,                     -- JSON نتیجه پردازش
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX idx_fedinbox_peer ON fed_inbox(peer_id, received_at DESC);

-- شناسه‌های idempotency درخواست‌های خروجی و ورودی
CREATE TABLE fed_idempotency (
  key TEXT PRIMARY KEY,            -- peer_id + ':' + idempotency_key
  direction TEXT NOT NULL,        -- 'in' (ما مبدأ پاسخ) / 'out' (ما فرستنده بودیم)
  response TEXT,                   -- JSON پاسخ ذخیره‌شده
  created_at TEXT NOT NULL
);

-- ─────────────── مالی ───────────────
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),   -- طرف حساب (تامین‌کننده/واسطه/پکیج‌ساز)
  booking_id TEXT REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('sale','commission','purchase','payout','deposit','refund','fed_sale','fed_purchase','adjustment')),
  amount INTEGER NOT NULL,            -- مثبت=طلبکار ما از user / منفی=بدهکار
  note TEXT,
  balance_after INTEGER NOT NULL
);
CREATE INDEX idx_ledger_user ON ledger_entries(user_id, at);
CREATE INDEX idx_ledger_booking ON ledger_entries(booking_id);

-- ─────────────── گزارش‌های سایت عمومی و بازخورد ───────────────
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT UNIQUE REFERENCES bookings(id),
  package_id TEXT REFERENCES packages(id),
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_pkg ON reviews(package_id, approved);

CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, mobile TEXT, email TEXT,
  subject TEXT, body TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- مقصدهای پربازدید برای صفحات سئو
CREATE TABLE seo_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  emoji TEXT
);
`,
  },
];

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/** اجرای مهاجرت‌ها در تراکنش */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      run.run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      log.info('migration applied', { version: m.version, name: m.name });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function init(config) {
  const db = openDatabase(config.db.file);
  migrate(db);
  return db;
}

module.exports = { init, openDatabase, migrate };
