'use strict';
/**
 * روت‌های عمومی API فدراسیون (سمت سرور ما = عرضه‌کننده به همتایان).
 * همه زیر /fed/v1 با احراز هدر کلید+امضا.
 */

const U = require('../util');
const D = require('../domain');
const { json, HttpError } = require('./core');
const F = require('./federation');

function registerFederationApiRoutes(router, { db, cfg }) {
  const authenticate = F.peerAuthenticator(db);

  /* سلامت و معرفی */
  router.get('/fed/v1/ping', (ctx) => {
    authenticate(ctx);
    json(ctx, {
      ok: true, product: 'HamSafar', api: F.FED_API_VERSION,
      company: cfg.companyName, time: U.isoNow(),
    });
  }, { federated: true, csrf: false });

  /* کاتالوگ آفرهای فدرال ما (آفرهای بازارِ عموم‌پذیر) */
  router.get('/fed/v1/catalog', (ctx) => {
    authenticate(ctx);
    const limit = Math.min(200, Math.max(1, U.toInt(ctx.query.limit, 50)));
    const offset = Math.max(0, U.toInt(ctx.query.offset, 0));
    const rows = db.prepare(`SELECT o.id, o.qty, o.unit_price, o.public_price, o.updated_at,
        i.title, i.origin, i.destination, i.depart_at, i.nights, i.hotel_name, i.room_type, i.class_text, i.unit_label,
        st.key AS type_key, st.title AS type_title,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o
      JOIN inventory_items i ON i.id=o.item_id
      JOIN service_types st ON st.id=i.type_id
      WHERE o.status='open' AND o.kind='market' AND o.visible_to_agents=1 AND i.status='active'
        AND (i.depart_at IS NULL OR i.depart_at >= ?)
      ORDER BY i.depart_at ASC LIMIT ? OFFSET ?`).all(U.isoNow(), limit, offset);
    const items = rows.map((r) => ({
      id: r.id,
      kind: 'offer',
      title: r.title,
      type_key: r.type_key,
      type_title: r.type_title,
      origin: r.origin, destination: r.destination,
      depart_at: r.depart_at,
      nights: r.nights, hotel_name: r.hotel_name, room_type: r.room_type, class_text: r.class_text,
      unit_label: r.unit_label,
      unit_price: r.unit_price,
      currency: 'IRR',
      qty_available: Math.max(0, r.qty - r.used),
      summary: [r.origin, r.destination, r.class_text].filter(Boolean).join(' → '),
      updated_at: r.updated_at,
    }));
    json(ctx, { ok: true, version: U.isoNow(), count: items.length, items });
  }, { federated: true, csrf: false });

  /* جزئیات یک آفر */
  router.get('/fed/v1/catalog/:id', (ctx) => {
    authenticate(ctx);
    const r = db.prepare(`SELECT o.*, i.title, i.origin, i.destination, i.depart_at,
        st.key AS type_key, st.title AS type_title,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id JOIN service_types st ON st.id=i.type_id
      WHERE o.id=? AND o.status='open' AND o.kind='market' AND o.visible_to_agents=1`).get(ctx.params.id);
    if (!r) throw new HttpError(404, 'آفر یافت نشد یا برای فدراسیون باز نیست.');
    json(ctx, {
      ok: true,
      item: {
        id: r.id, kind: 'offer', title: r.title, type_key: r.type_key, type_title: r.type_title,
        origin: r.origin, destination: r.destination, depart_at: r.depart_at,
        unit_price: r.unit_price, currency: 'IRR',
        qty_available: Math.max(0, r.qty - r.used), unit_label: r.unit_label,
        updated_at: r.updated_at,
      },
    });
  }, { federated: true, csrf: false });

  /* رزرو فدرال (اتمیک) */
  router.post('/fed/v1/catalog/:id/reserve', (ctx) => {
    authenticate(ctx);
    const payload = typeof ctx.body === 'object' && ctx.body ? ctx.body : {};
    // ثبت در inbox برای ردیابی
    db.prepare(`INSERT INTO fed_inbox (id,peer_id,action,payload,status,received_at) VALUES (?,?,?,?,?,?)`)
      .run(U.randomId(), ctx.peer.id, 'reserve', JSON.stringify({ offerId: ctx.params.id, ...payload }), 'received', U.isoNow());
    const result = F.handleFederatedReserve(db, ctx, ctx.params.id, payload);
    db.prepare(`UPDATE fed_inbox SET status='processed', result=?, processed_at=? WHERE peer_id=? AND action='reserve' AND status='received'
      AND id=(SELECT id FROM fed_inbox WHERE peer_id=? AND action='reserve' ORDER BY received_at DESC LIMIT 1)`)
      .run(JSON.stringify(result), U.isoNow(), ctx.peer.id, ctx.peer.id);
    json(ctx, result, 200);
  }, { federated: true, csrf: false });

  /* لغو رزرو فدرال */
  router.post('/fed/v1/bookings/:ref/cancel', (ctx) => {
    authenticate(ctx);
    const payload = typeof ctx.body === 'object' && ctx.body ? ctx.body : {};
    db.prepare(`INSERT INTO fed_inbox (id,peer_id,action,payload,status,received_at) VALUES (?,?,?,?,?,?)`)
      .run(U.randomId(), ctx.peer.id, 'cancel', JSON.stringify({ ref: ctx.params.ref, ...payload }), 'received', U.isoNow());
    const result = F.handleFederatedCancel(db, ctx, ctx.params.ref, payload);
    json(ctx, result);
  }, { federated: true, csrf: false });

  /* وضعیت یک رزرو فدرال */
  router.get('/fed/v1/bookings/:ref', (ctx) => {
    authenticate(ctx);
    const b = db.prepare(`SELECT b.*, i.title FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id LEFT JOIN inventory_items i ON i.id=o.item_id
      WHERE b.ref_code=? AND b.fed_peer_id=?`).get(ctx.params.ref, ctx.peer.id);
    if (!b) throw new HttpError(404, 'رزرو یافت نشد.');
    json(ctx, {
      ok: true, booking_ref: b.ref_code, status: b.status, pay_status: b.pay_status,
      travelers: b.traveler_count, total_price: b.total_price, currency: 'IRR',
      title: b.title, created_at: b.created_at,
    });
  }, { federated: true, csrf: false });

  /* صورت‌حساب فدرال: چه بدهی/طلبی بین ما و این همتا هست */
  router.get('/fed/v1/balance', (ctx) => {
    authenticate(ctx);
    json(ctx, {
      ok: true,
      // از دید ما: our_balance>0 یعنی همتا به ما بدهکار است
      peer_owes_us: Math.max(0, ctx.peer.our_balance),
      we_owe_peer: Math.max(0, -ctx.peer.our_balance),
      currency: 'IRR',
      as_of: U.isoNow(),
    });
  }, { federated: true, csrf: false });
}

module.exports = { registerFederationApiRoutes };
