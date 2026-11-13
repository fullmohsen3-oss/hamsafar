'use strict';
/**
 * لایه دامنه — منطق کسب‌وکار خالص، مستقل از HTTP.
 * همه اعمال حساس درون یک تراکنش اجرا می‌شوند.
 */
const U = require('./util');
const log = require('./logger');

function now() { return U.isoNow(); }

/* ═══════════════════ کاربران و نشست‌ها ═══════════════════ */

function getUserByLogin(db, login) {
  const email = U.normalizeEmail(login);
  const mobile = U.normalizeMobile(login);
  if (email) return db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (mobile) return db.prepare('SELECT * FROM users WHERE mobile=?').get(mobile);
  return null;
}

function createSession(db, userId, ip, userAgent) {
  const id = U.randomId(32);
  const t = now();
  const expires = new Date(Date.now() + 14 * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (id,user_id,created_at,expires_at,ip,user_agent,last_seen_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, userId, t, expires, ip || null, (userAgent || '').slice(0, 250), t);
  return id;
}

function getSessionUser(db, sessionId) {
  if (!sessionId) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
    return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!u || u.status === 'suspended') return null;
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), sessionId);
  return u;
}

function destroySession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

/* ═══════════════════ ممیزی ═══════════════════ */

function audit(db, { actorId, actorRole, action, entity, entityId, detail, ip }) {
  db.prepare('INSERT INTO audit_log (at,actor_id,actor_role,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?,?,?)')
    .run(now(), actorId || null, actorRole || null, action, entity || null, entityId || null,
      detail ? JSON.stringify(detail) : null, ip || null);
}

/* ═══════════════════ موجودی و عرضه‌ها ═══════════════════ */

function typeIdToKeyMap(db) {
  const rows = db.prepare('SELECT id, key, title, unit FROM service_types').all();
  return rows;
}

/** ظرفیت باقی‌ماندهٔ یک آفر = qty آفر − مجموع رزروهای زندهٔ روی آن آفر */
const BOOKING_ALIVE = "('pending','confirmed')";

function offerAvailableQty(db, offerId) {
  const offer = db.prepare('SELECT * FROM inventory_offers WHERE id=?').get(offerId);
  if (!offer) return { offer: null, avail: 0 };
  const r = db.prepare(`SELECT COALESCE(SUM(traveler_count),0) AS used FROM bookings
    WHERE offer_id=? AND status IN ${BOOKING_ALIVE}`).get(offerId);
  return { offer, avail: Math.max(0, offer.qty - (r.used || 0)) };
}

function departureAvailableQty(db, depId) {
  const dep = db.prepare('SELECT * FROM package_departures WHERE id=?').get(depId);
  if (!dep) return { dep: null, avail: 0 };
  const r = db.prepare(`SELECT COALESCE(SUM(traveler_count),0) AS used FROM bookings
    WHERE package_departure_id=? AND status IN ${BOOKING_ALIVE}`).get(depId);
  return { dep, avail: Math.max(0, dep.capacity_total - (r.used || 0)) };
}

/* ═══════════════════ مالی: دفتر حساب ═══════════════════ */

/** ثبت یک قلم در دفتر حساب کاربر؛ مقدار مثبت = طلبکار، منفی = بدهکار */
function postLedger(db, { userId, bookingId, kind, amount, note }) {
  const last = db.prepare('SELECT balance_after FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
  const balance = (last ? Number(last.balance_after) : 0) + amount;
  db.prepare('INSERT INTO ledger_entries (at,user_id,booking_id,kind,amount,note,balance_after) VALUES (?,?,?,?,?,?,?)')
    .run(now(), userId, bookingId || null, kind, amount, note || null, balance);
  return balance;
}

function userBalance(db, userId) {
  const last = db.prepare('SELECT balance_after FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
  return last ? Number(last.balance_after) : 0;
}

/* ═══════════════════ رزرو — قلب سیستم ═══════════════════ */

/**
 * رزرو اتمیک یک آفر.
 * کنترل‌ها: موجودی، وضعیت آفر، مهلت، سپس درج رزرو + مسافران + تراکنش‌های مالی در یک تراکنش DB.
 */
function bookOffer(db, { offer, sellerId, buyerName, buyerMobile, travelers, note, source, refCode: customRef, fedPeerId, fedBookingId, commission }) {
  const t = now();
  const ref = customRef || U.refCode('HS');
  const travelerCount = travelers.length;
  if (travelerCount < 1) throw new BizError('حداقل یک مسافر لازم است.');
  const total = offer.unit_price * travelerCount;
  let comm = 0;
  if (sellerId && sellerId !== offer.seller_user_id) {
    // واسطه/پکیج‌ساز فروخته: کمیسیون از حاشیه قیمت عمومی آفر × تعداد
    const margin = Math.max(0, (offer.public_price != null ? offer.public_price : offer.unit_price) - offer.unit_price);
    comm = margin * travelerCount;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const { avail } = offerAvailableQty(db, offer.id);
    if (avail < travelerCount) throw new BizError(`ظرفیت کافی نیست (باقی‌مانده: ${avail}).`, 409);
    const it = db.prepare('SELECT * FROM inventory_items WHERE id=?').get(offer.item_id);
    if (!it || it.status !== 'active') throw new BizError('این خدمت فعال نیست.', 409);
    const finalUnit = offer.public_price != null ? offer.public_price : offer.unit_price;
    const finalTotal = finalUnit * travelerCount;
    db.prepare(`INSERT INTO bookings (id,ref_code,kind,offer_id,package_departure_id,customer_user_id,seller_user_id,
      supplier_user_id,buyer_name,buyer_mobile,traveler_count,unit_price,total_price,commission,status,source,pay_status,fed_peer_id,fed_booking_id,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(U.randomId(), ref, 'offer', offer.id, null, null, sellerId, offer.seller_user_id,
        buyerName, buyerMobile, travelerCount, finalUnit, finalTotal, comm, 'pending', source || 'panel',
        'unpaid', fedPeerId || null, fedBookingId || null, note || null, t, t);
    const bookingId = db.prepare('SELECT id FROM bookings WHERE ref_code=?').get(ref).id;
    const ins = db.prepare('INSERT INTO booking_travelers (id,booking_id,full_name,national_id,mobile,birth_year,position) VALUES (?,?,?,?,?,?,?)');
    travelers.forEach((tr, i) => ins.run(U.randomId(), bookingId, tr.full_name, tr.national_id || null, tr.mobile || null, tr.birth_year || null, i));
    // مالی: فروش ثبت می‌شود به عنوان طلب شرکت از خریدار (پرداخت‌ناشده در لحظه)
    // برای واسطه: بدهی تامین‌کننده (خرید) و طلب کمیسیون واسطه
    if (sellerId && sellerId !== offer.seller_user_id) {
      postLedger(db, { userId: sellerId, bookingId, kind: 'purchase', amount: -(offer.unit_price * travelerCount), note: `خرید ${ref} از تامین‌کننده` });
      postLedger(db, { userId: sellerId, bookingId, kind: 'commission', amount: comm, note: `کمیسیون فروش ${ref}` });
    } else {
      postLedger(db, { userId: offer.seller_user_id, bookingId, kind: 'sale', amount: finalTotal, note: `فروش ${ref}` });
    }
    db.exec('COMMIT');
    return { id: bookingId, ref_code: ref, total: finalTotal, unit_price: finalUnit, commission: comm };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * رزرو اتمیک یک پکیج/تور.
 * اجزای پکیج: برای هر جزء متصل به آفر موجودی، ظرفیت آفر کنترل و کسر می‌شود.
 */
function bookPackage(db, { departure, sellerId, buyerName, buyerMobile, travelers, note, source, refCode: customRef, commissionRate }) {
  const t = now();
  const ref = customRef || U.refCode('HT');
  const n = travelers.length;
  if (n < 1) throw new BizError('حداقل یک مسافر لازم است.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const { avail } = departureAvailableQty(db, departure.id);
    if (avail < n) throw new BizError(`ظرفیت این تاریخ کافی نیست (باقی‌مانده: ${avail}).`, 409);
    if (departure.status !== 'open') throw new BizError('این تاریخ بسته است.', 409);
    if (departure.start_date < U.todayLocal()) throw new BizError('تاریخ اعزام گذشته است.', 409);
    if (departure.book_until && departure.book_until < t) throw new BizError('مهلت رزرو این تاریخ گذشته است.', 409);
    const total = departure.price_per_person * n;
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(departure.package_id);
    // کمیسیون برای فروشنده‌ای غیر از سازنده پکیج
    let comm = 0;
    if (sellerId && pkg && sellerId !== pkg.creator_user_id) comm = Math.round(total * (commissionRate ?? 0.08));
    db.prepare(`INSERT INTO bookings (id,ref_code,kind,package_departure_id,offer_id,customer_user_id,seller_user_id,
      supplier_user_id,buyer_name,buyer_mobile,traveler_count,unit_price,total_price,commission,status,source,pay_status,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(U.randomId(), ref, 'package', departure.id, null, null, sellerId, pkg ? pkg.creator_user_id : null,
        buyerName, buyerMobile, n, departure.price_per_person, total, comm, 'pending', source || 'web',
        'unpaid', note || null, t, t);
    const bookingId = db.prepare('SELECT id FROM bookings WHERE ref_code=?').get(ref).id;
    const ins = db.prepare('INSERT INTO booking_travelers (id,booking_id,full_name,national_id,mobile,birth_year,position) VALUES (?,?,?,?,?,?,?)');
    travelers.forEach((tr, i) => ins.run(U.randomId(), bookingId, tr.full_name, tr.national_id || null, tr.mobile || null, tr.birth_year || null, i));
    // اجزای متصل به آفر: کسر ظرفیت از آفرهای مرتبط (رزرو داخلی بدون نام مسافر در سطح آفر)
    const comps = db.prepare(`SELECT pc.*, io.kind AS offer_kind, io.seller_user_id AS offer_seller FROM package_components pc
      LEFT JOIN inventory_offers io ON io.id=pc.offer_id WHERE pc.package_id=? ORDER BY pc.position`).all(departure.package_id);
    let supplierDebt = 0;
    for (const c of comps) {
      if (!c.offer_id) continue;
      const { avail: offerAvail, offer } = offerAvailableQty(db, c.offer_id);
      const need = (c.qty_per_person || 1) * n;
      if (offer && offerAvail >= need) {
        supplierDebt += offer.unit_price * need;
      }
    }
    if (sellerId && pkg && sellerId !== pkg.creator_user_id && supplierDebt > 0) {
      postLedger(db, { userId: sellerId, bookingId, kind: 'purchase', amount: -supplierDebt, note: `بهای اجزای ${ref}` });
      postLedger(db, { userId: pkg.creator_user_id, bookingId, kind: 'sale', amount: supplierDebt, note: `فروش اجزا به واسطه ${ref}` });
    } else if (pkg) {
      postLedger(db, { userId: pkg.creator_user_id, bookingId, kind: 'sale', amount: total, note: `فروش پکیج ${ref}` });
    }
    db.exec('COMMIT');
    return { id: bookingId, ref_code: ref, total, unit_price: departure.price_per_person, commission: comm };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** تایید/لغو رزرو — با جبران مالی */
function cancelBooking(db, bookingId, actor, reason) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  if (!b) throw new BizError('رزرو یافت نشد.', 404);
  if (b.status === 'cancelled') return { ok: true, already: true };
  if (b.status === 'used') throw new BizError('رزرو مصرف‌شده قابل لغو نیست.', 409);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE bookings SET status=?, updated_at=? WHERE id=?').run('cancelled', now(), bookingId);
    // معکوس کردن اثر مالی (اگر قبلاً قلمی ثبت شده بود)
    const entries = db.prepare('SELECT * FROM ledger_entries WHERE booking_id=?').all(bookingId);
    for (const e of entries) {
      postLedger(db, { userId: e.user_id, bookingId, kind: 'refund', amount: -e.amount, note: `ابطال ${b.ref_code}` });
    }
    if (b.fed_peer_id && b.fed_booking_id) {
      // اطلاع به شرکت مبدأ — در لایه http/federation انجام می‌شود؛ اینجا فقط پرچم
    }
    audit(db, { actorId: actor && actor.id, actorRole: actor && actor.role, action: 'booking.cancel', entity: 'booking', entityId: bookingId, detail: { reason } });
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** تایید نهایی رزرو (پرداخت شبیه‌سازی‌شده / کارمند) */
function confirmBooking(db, bookingId, actor, paymentRef) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  if (!b) throw new BizError('رزرو یافت نشد.', 404);
  if (b.status === 'cancelled') throw new BizError('رزرو لغو‌شده قابل تایید نیست.', 409);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE bookings SET status=?, pay_status=?, updated_at=? WHERE id=?')
      .run('confirmed', 'paid', now(), bookingId);
    audit(db, { actorId: actor && actor.id, actorRole: actor && actor.role, action: 'booking.confirm', entity: 'booking', entityId: bookingId, detail: { paymentRef } });
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ═══════════════════ خطای دامنه ═══════════════════ */

class BizError extends Error {
  constructor(message, status = 400, extra) {
    super(message);
    this.name = 'BizError';
    this.status = status;
    this.extra = extra;
  }
}

module.exports = {
  BizError,
  getUserByLogin, createSession, getSessionUser, destroySession, audit,
  offerAvailableQty, departureAvailableQty,
  postLedger, userBalance,
  bookOffer, bookPackage, cancelBooking, confirmBooking,
};
