'use strict';
/**
 * فدراسیون هم‌سفر — ارتباط بلادرنگ میان شرکت‌های مستقل.
 *
 * مدل: هر نمونه هم‌سفر یک کلید API به هر همتا می‌دهد و کلید همتا را نگه می‌دارد.
 * احراز: هدر X-HamSafar-Key + امضای HMAC (X-HamSafar-Signature) بر بدنه.
 * Idempotency: هدر X-Idempotency-Key برای عملیات رزرو/لغو.
 */

const crypto = require('node:crypto');
const U = require('../util');
const log = require('../logger');
const { HttpError } = require('./core');

const FED_API_VERSION = '1';

/* ═════════ امضای درخواست ═════════ */

function sign(apiKey, method, path, bodyStr) {
  const material = [FED_API_VERSION, method, path, apiKey, bodyStr || ''].join('\n');
  return crypto.createHmac('sha256', apiKey).update(material).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** میانه‌افزار احراز همتا: کلید + امضا را چک می‌کند */
function peerAuthenticator(db) {
  return function authenticatePeer(ctx) {
    const key = ctx.req.headers['x-hamsafar-key'];
    const sig = ctx.req.headers['x-hamsafar-signature'];
    const version = ctx.req.headers['x-hamsafar-version'];
    if (!key || !sig) throw new HttpError(401, 'هدرهای احراز فدراسیون یافت نشد.');
    if (version && version !== FED_API_VERSION) throw new HttpError(400, 'نسخه API پشتیبانی نمی‌شود.');
    const peer = db.prepare(`SELECT * FROM fed_peers WHERE our_key_for_them=? AND status='active'`).get(key);
    if (!peer) throw new HttpError(401, 'کلید فدراسیون نامعتبر است.');
    // بازسازی بدنه خام برای امضا — از ctx.bodyRaw استفاده می‌کنیم (در createServer ذخیره شده)
    const expected = sign(key, ctx.req.method, ctx.pathname + (ctx.search || ''), ctx.bodyRaw || '');
    if (!safeEqual(expected, sig)) throw new HttpError(403, 'امضای درخواست نامعتبر است.');
    ctx.peer = peer;
    return peer;
  };
}

/* ═════════ کلاینت خروجی ═════════ */

class FederationClient {
  constructor({ baseUrl, apiKey, timeoutMs = 8000, fetchImpl }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async call(method, path, body, { idempotencyKey } = {}) {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const url = new URL(this.baseUrl + path);
    const headers = {
      'X-HamSafar-Key': this.apiKey,
      'X-HamSafar-Signature': sign(this.apiKey, method, url.pathname + url.search, bodyStr),
      'X-HamSafar-Version': FED_API_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'HamSafar-Federation/1',
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyStr,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new HttpError(502, `ارتباط با همتا برقرار نشد: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* بدنه خالی */ }
    if (!res.ok) {
      const msg = (data && data.error) || `خطای همتا (HTTP ${res.status})`;
      throw new HttpError(res.status === 401 || res.status === 403 ? 502 : res.status, msg);
    }
    return data;
  }

  ping() { return this.call('GET', '/fed/v1/ping'); }
  catalog(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.call('GET', '/fed/v1/catalog' + (q ? '?' + q : ''));
  }
  offerDetail(offerId) { return this.call('GET', `/fed/v1/catalog/${encodeURIComponent(offerId)}`); }
  reserve(offerId, payload, idemKey) { return this.call('POST', `/fed/v1/catalog/${encodeURIComponent(offerId)}/reserve`, payload, { idempotencyKey: idemKey }); }
  cancel(bookingRef, payload, idemKey) { return this.call('POST', `/fed/v1/bookings/${encodeURIComponent(bookingRef)}/cancel`, payload, { idempotencyKey: idemKey }); }
  bookingStatus(bookingRef) { return this.call('GET', `/fed/v1/bookings/${encodeURIComponent(bookingRef)}`); }
}

function clientForPeer(peer, cfg) {
  return new FederationClient({
    baseUrl: peer.base_url,
    apiKey: peer.api_key,
    timeoutMs: cfg.fedReqTimeoutMs || 8000,
  });
}

/* ═════════ Idempotency ═════════ */

function idemKeyIn(db, peerId, key) {
  const row = db.prepare(`SELECT response FROM fed_idempotency WHERE key=? AND direction='in'`).get(`${peerId}:${key}`);
  return row ? JSON.parse(row.response) : null;
}
function idemKeyStore(db, peerId, key, response) {
  db.prepare(`INSERT OR IGNORE INTO fed_idempotency (key,direction,response,created_at) VALUES (?,'in',?,?)`)
    .run(`${peerId}:${key}`, JSON.stringify(response), U.isoNow());
}

/* ═════════ رزرو فدرال روی آفر محلی ═════════ */

/**
 * رزرو فدرال: شرکت مقابل روی آفر عمومی ما رزرو می‌زند.
 * مسیر: fed_inbox → اعتبارسنجی → bookOffer با source='federation' → پاسخ.
 */
function handleFederatedReserve(db, ctx, offerId, payload) {
  const peer = ctx.peer;
  const idemKey = ctx.req.headers['x-idempotency-key'];
  if (idemKey) {
    const cached = idemKeyIn(db, peer.id, idemKey);
    if (cached) return cached;
  }
  const D = require('../domain');
  const offer = db.prepare(`SELECT o.*, i.title, i.type_id, i.origin, i.destination, i.depart_at
    FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
    WHERE o.id=? AND o.kind='market' AND o.status='open'`).get(offerId);
  if (!offer) throw new HttpError(404, 'آفر فدرال یافت نشد یا بسته است.');
  const { avail } = D.offerAvailableQty(db, offerId);
  const count = U.toInt(payload.travelers, 0);
  const travelers = Array.isArray(payload.travelers_detail) ? payload.travelers_detail : null;
  if (!count || count < 1) throw new HttpError(400, 'تعداد مسافران نامعتبر است.');
  if (avail < count) throw new HttpError(409, `ظرفیت کافی نیست (موجود: ${avail}).`);

  // فروشنده از دید شرکت ما: تامین‌کنندهٔ خود آفر؛ بهای همکار ملاک تسویه است.
  const result = D.bookOffer(db, {
    offer: { ...offer, public_price: null },  // در معامله فدرال قیمت همکار ملاک است
    sellerId: offer.seller_user_id,
    buyerName: U.cleanText(payload.contact_name, 120) || peer.name,
    buyerMobile: U.normalizeMobile(payload.contact_mobile) || '0000000000',
    travelers: (travelers && travelers.length === count ? travelers : Array.from({ length: count }, (_, i) => ({ full_name: `مسافر ${i + 1}` })))
      .map((t) => ({ full_name: U.cleanText(t.full_name, 120), national_id: t.national_id || null })),
    note: `فدراسیون از ${peer.name}`,
    source: 'federation',
    fedPeerId: peer.id,
    fedBookingId: payload.booking_ref ? U.cleanText(String(payload.booking_ref), 64) : null,
  });
  // بدهی همتا به ما: قیمت خرید × تعداد (در دفترِ همتا از دید ما = طلب ما)
  D.postLedger(db, {
    userId: offer.seller_user_id,
    bookingId: result.id,
    kind: 'fed_sale',
    amount: offer.unit_price * count,
    note: `فروش فدرال ${result.ref_code} به ${peer.name}`,
  });
  // تراز همتا
  db.prepare('UPDATE fed_peers SET our_balance = our_balance + ?, updated_at=? WHERE id=?')
    .run(offer.unit_price * count, U.isoNow(), peer.id);
  D.audit(db, { actorRole: 'federation', action: 'fed.reserve', entity: 'booking', entityId: result.id, detail: { peer: peer.name, offerId, count } });

  const response = {
    ok: true,
    booking_ref: result.ref_code,
    status: 'pending',
    total_price: result.total,
    unit_price: result.unit_price,
    currency: 'IRR',
    expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
  };
  if (idemKey) idemKeyStore(db, peer.id, idemKey, response);
  return response;
}

function handleFederatedCancel(db, ctx, bookingRef, payload) {
  const peer = ctx.peer;
  const idemKey = ctx.req.headers['x-idempotency-key'];
  if (idemKey) {
    const cached = idemKeyIn(db, peer.id, idemKey);
    if (cached) return cached;
  }
  const D = require('../domain');
  const b = db.prepare('SELECT * FROM bookings WHERE ref_code=? AND fed_peer_id=?').get(bookingRef, peer.id);
  if (!b) throw new HttpError(404, 'رزرو فدرال یافت نشد.');
  D.cancelBooking(db, b.id, { id: 'federation', role: 'federation' }, payload && payload.reason);
  // برگشت تراز همتا
  db.prepare('UPDATE fed_peers SET our_balance = our_balance - ?, updated_at=? WHERE id=?')
    .run(b.total_price, U.isoNow(), peer.id);
  const response = { ok: true, booking_ref: bookingRef, status: 'cancelled' };
  if (idemKey) idemKeyStore(db, peer.id, idemKey, response);
  return response;
}

/* ═════════ کش کاتالوگ همتاها ═════════ */

async function refreshPeerCatalog(db, cfg, peerId) {
  const peer = db.prepare(`SELECT * FROM fed_peers WHERE id=?`).get(peerId);
  if (!peer) throw new HttpError(404, 'همتا یافت نشد.');
  const client = clientForPeer(peer, cfg);
  const t = U.isoNow();
  const data = await client.catalog({ limit: 200 });
  const upsert = db.prepare(`INSERT INTO fed_remote_items (id,peer_id,remote_offer_id,kind,title,type_key,origin,destination,depart_at,unit_price,currency,qty_available,summary,raw_meta,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, unit_price=excluded.unit_price, qty_available=excluded.qty_available, summary=excluded.summary, raw_meta=excluded.raw_meta, fetched_at=excluded.fetched_at`);
  const del = db.prepare('DELETE FROM fed_remote_items WHERE peer_id=? AND remote_offer_id NOT IN (SELECT json_each.value FROM json_each(?))');
  let seen = [];
  for (const it of (data.items || [])) {
    const id = `${peer.id}:${it.id}`;
    seen.push(it.id);
    upsert.run(id, peer.id, it.id, it.kind || 'offer', U.cleanText(it.title, 200), it.type_key || null,
      it.origin || null, it.destination || null, it.depart_at || null,
      U.toAmount(it.unit_price, 0), it.currency || 'IRR', U.toInt(it.qty_available, 0),
      U.cleanText(it.summary, 500) || null, JSON.stringify(it), t);
  }
  if (seen.length) db.prepare(`DELETE FROM fed_remote_items WHERE peer_id=? AND remote_offer_id NOT IN (${seen.map(() => '?').join(',')})`).run(peer.id, ...seen);
  else db.prepare('DELETE FROM fed_remote_items WHERE peer_id=?').run(peer.id);
  db.prepare(`INSERT INTO fed_sync_state (peer_id,kind,cursor,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(peer_id,kind) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`)
    .run(peer.id, 'catalog', data.version || t, t);
  db.prepare('UPDATE fed_peers SET last_sync_at=?, last_error=NULL, updated_at=? WHERE id=?').run(t, t, peer.id);
  return { fetched: seen.length };
}

module.exports = {
  FED_API_VERSION, sign, peerAuthenticator, FederationClient, clientForPeer,
  idemKeyIn, idemKeyStore, handleFederatedReserve, handleFederatedCancel, refreshPeerCatalog,
};
