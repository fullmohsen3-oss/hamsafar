'use strict';
/** پنل واسطه — بازار خدمات (داخلی + فدرال)، رزرو، کمیسیون */

const U = require('../../../util');
const D = require('../../../domain');
const { html, json, redirect, HttpError, issueCsrf } = require('../../core');
const { renderPanel, statCards, bookingsTable, csrfInput } = require('../../panel-ui');

function requireAgent(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ورود لازم است.');
  if (!['agent', 'packager', 'admin'].includes(ctx.user.role)) throw new HttpError(403, 'این بخش مخصوص واسطه‌ها است.');
}

/** آفرهای بازار داخلی قابل خرید توسط این کاربر */
function marketOffers(db, userId, { q, typeKey } = {}) {
  const params = [];
  let where = `o.status='open' AND o.kind='market' AND o.visible_to_agents=1 AND i.status='active'
    AND o.seller_user_id != ?
    AND (i.depart_at IS NULL OR i.depart_at >= ?)`;
  params.push(userId, U.isoNow());
  if (q) {
    where += ` AND (i.title LIKE ? OR i.destination LIKE ? OR i.origin LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (typeKey) { where += ` AND st.key=?`; params.push(typeKey); }
  return db.prepare(`SELECT o.*, i.title, i.origin, i.destination, i.depart_at, i.unit_label, i.hotel_name, i.class_text,
      st.title AS type_title, st.key AS type_key, st.emoji, u.full_name AS seller_name, u.company_title AS seller_company,
      (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
    FROM inventory_offers o
    JOIN inventory_items i ON i.id=o.item_id
    JOIN service_types st ON st.id=i.type_id
    JOIN users u ON u.id=o.seller_user_id
    WHERE ${where}
    ORDER BY i.depart_at ASC LIMIT 100`).all(...params);
}

function registerAgentRoutes(router, { db, cfg }) {

  /* ─── بازار داخلی ─── */
  router.get('/panel/agent/market', (ctx) => {
    requireAgent(ctx);
    const q = U.cleanText(ctx.query.q || '', 60);
    const type = U.cleanText(ctx.query.type || '', 20);
    const rows = marketOffers(db, ctx.user.id, { q, typeKey: type || null });
    const types = db.prepare('SELECT key, title, emoji FROM service_types').all();
    const content = `
<div class="panel-head"><h1>🛒 بازار خدمات (داخلی)</h1></div>
<form method="get" action="/panel/agent/market" class="card" style="display:flex;gap:.6rem;flex-wrap:wrap">
  <input type="search" name="q" value="${U.esc(q)}" placeholder="جستجو..." style="flex:1;min-width:160px">
  <select name="type"><option value="">همه انواع</option>
    ${types.map((t) => `<option value="${t.key}" ${type === t.key ? 'selected' : ''}>${t.emoji} ${t.title}</option>`).join('')}
  </select>
  <button class="btn">فیلتر</button>
</form>
${rows.length ? `<div class="grid cols-3">${rows.map((o) => `
  <article class="card offer-card">
    <div class="type">${o.emoji} ${U.esc(o.type_title)} ${o.class_text ? '— ' + U.esc(o.class_text) : ''}</div>
    <div class="title">${U.esc(o.title)}</div>
    <div class="route">${o.origin && o.destination ? `${U.esc(o.origin)} ← ${U.esc(o.destination)}` : U.esc(o.hotel_name || '')}</div>
    ${o.depart_at ? `<div class="route">🗓 ${U.faDateShort(o.depart_at)}</div>` : ''}
    <div class="route small muted">فروشنده: ${U.esc(o.seller_company || o.seller_name)}</div>
    <div class="price-row">
      <div>
        <div class="price">${U.money(o.public_price != null ? o.public_price : o.unit_price)} <span class="unit">تومان؟</span></div>
        <div class="small muted">بهای همکار: ${U.money(o.unit_price)}</div>
      </div>
      ${Math.max(0, o.qty - o.used) > 0
        ? `<a class="btn small" href="/panel/agent/market/${o.id}">رزرو</a>`
        : '<span class="badge red">تکمیل</span>'}
    </div>
  </article>`).join('')}</div>` : '<div class="empty">آفری در بازار نیست یا همه بسته‌اند.</div>'}`;
    renderPanel(ctx, cfg, { title: 'بازار خدمات', active: '/panel/agent/market', content });
  });

  /* فرم رزرو از بازار */
  router.get('/panel/agent/market/:id', (ctx) => {
    requireAgent(ctx);
    const o = db.prepare(`SELECT o.*, i.title, i.origin, i.destination, i.depart_at, i.unit_label, i.class_text,
        st.title AS type_title, st.emoji, u.full_name AS seller_name,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o
      JOIN inventory_items i ON i.id=o.item_id
      JOIN service_types st ON st.id=i.type_id
      JOIN users u ON u.id=o.seller_user_id
      WHERE o.id=? AND o.status='open' AND o.kind='market' AND o.visible_to_agents=1`).get(ctx.params.id);
    if (!o) throw new HttpError(404, 'آفر یافت نشد یا بسته است.');
    const avail = Math.max(0, o.qty - o.used);
    const margin = (o.public_price != null ? o.public_price : o.unit_price) - o.unit_price;
    const content = `
<div class="panel-head"><h1>رزرو برای مشتری</h1></div>
<form class="card" method="post" action="/panel/agent/market/${o.id}">
  ${csrfInput(ctx)}
  <h2>${o.emoji} ${U.esc(o.title)}</h2>
  <p class="muted">${o.origin && o.destination ? `${U.esc(o.origin)} ← ${U.esc(o.destination)} — ` : ''}${o.depart_at ? U.faDate(o.depart_at) : ''} — فروشنده: ${U.esc(o.seller_name)}</p>
  <div class="alert info">
    بهای همکار: <strong>${U.money(o.unit_price)}</strong> ·
    قیمت فروش شما به مشتری: <strong>${U.money(o.public_price != null ? o.public_price : o.unit_price)}</strong> ·
    کمیسیون شما: <strong style="color:var(--ok)">${U.money(margin)}</strong> به‌ازای هر ${U.esc(o.unit_label)}.
    ${avail} ظرفیت باقی‌مانده.
  </div>
  <div class="form-grid">
    <div class="field"><label>نام سرپرست (مشتری شما) *</label><input required name="buyer_name" maxlength="120"></div>
    <div class="field"><label>موبایل مشتری *</label><input required name="buyer_mobile" inputmode="tel"></div>
    <div class="field"><label>تعداد *</label><input required type="number" name="count" min="1" max="${Math.max(1, avail)}" value="1"></div>
  </div>
  <div class="field"><label>یادداشت</label><input name="note" maxlength="300"></div>
  <button class="btn" ${avail > 0 ? '' : 'disabled'}>ثبت رزرو</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'رزرو از بازار', active: '/panel/agent/market', content });
  });

  router.post('/panel/agent/market/:id', (ctx) => {
    requireAgent(ctx);
    const o = db.prepare(`SELECT o.*, i.title FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
      WHERE o.id=? AND o.status='open' AND o.kind='market' AND o.visible_to_agents=1`).get(ctx.params.id);
    if (!o) throw new HttpError(404, 'آفر یافت نشد یا بسته است.');
    const b = ctx.body;
    const buyerName = U.isName(b.buyer_name);
    const buyerMobile = U.normalizeMobile(b.buyer_mobile);
    if (!buyerName || !buyerMobile) throw new HttpError(400, 'نام و موبایل مشتری را درست وارد کنید.');
    const count = U.toInt(b.count, 0);
    if (!count || count < 1) throw new HttpError(400, 'تعداد معتبر نیست.');
    const result = D.bookOffer(db, {
      offer: o, sellerId: ctx.user.id, buyerName, buyerMobile,
      travelers: Array.from({ length: count }, () => ({ full_name: 'مسافر (ثبت‌شده توسط واسطه)' })),
      note: U.cleanText(b.note, 300) || `فروش واسطه‌ای`, source: 'panel',
    });
    redirect(ctx, `/panel/booking/${result.ref_code ? '' : ''}${result.id}`);
  });

  /* ─── بازار فدرال ─── */
  router.get('/panel/agent/fed-market', async (ctx) => {
    requireAgent(ctx);
    const peers = db.prepare(`SELECT * FROM fed_peers WHERE status='active' ORDER BY name`).all();
    const q = U.cleanText(ctx.query.q || '', 60);
    const refresh = ctx.query.refresh === '1';
    if (refresh && peers.length) {
      const F = require('../../federation');
      for (const p of peers) {
        try { await F.refreshPeerCatalog(db, cfg, p.id); } catch (e) { /* ثبت خطا در همتا */ }
      }
      return redirect(ctx, '/panel/agent/fed-market');
    }
    let where = '1=1';
    const params = [];
    if (q) { where = '(r.title LIKE ? OR r.destination LIKE ? OR r.origin LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const items = db.prepare(`SELECT r.*, p.name AS peer_name FROM fed_remote_items r
      JOIN fed_peers p ON p.id=r.peer_id WHERE p.status='active' AND ${where} ORDER BY r.depart_at LIMIT 120`).all(...params);
    const content = `
<div class="panel-head"><h1>🌐 بازار فدراسیون — شرکت‌های همکار</h1>
  <a class="btn secondary" href="/panel/agent/fed-market?refresh=1">🔄 همگام‌سازی کاتالوگ</a></div>
<div class="alert info">این خدمات توسط شرکت‌های دیگری که هم‌سفر را مستقل اجرا می‌کنند عرضه شده و از طریق API فدراسیون بلادرنگ رزرو می‌شوند. رزرو شما به‌صورت اتمیک روی سرور شرکت عرضه‌کننده ثبت می‌شود.</div>
${peers.length === 0 ? '<div class="empty">هنوز همکار فدرالی اضافه نشده است. مدیر سیستم از پنل ادمین ← فدراسیون همتا اضافه می‌کند.</div>' : `
<form method="get" action="/panel/agent/fed-market" class="card" style="display:flex;gap:.6rem">
  <input type="search" name="q" value="${U.esc(q)}" placeholder="جستجو در کاتالوگ همکاران..." style="flex:1">
  <button class="btn">جستجو</button>
</form>
${items.length ? `<div class="grid cols-3">${items.map((r) => `
  <article class="card offer-card">
    <div class="type">🌐 ${U.esc(r.peer_name)}</div>
    <div class="title">${U.esc(r.title)}</div>
    ${r.origin && r.destination ? `<div class="route">${U.esc(r.origin)} ← ${U.esc(r.destination)}</div>` : ''}
    ${r.depart_at ? `<div class="route">🗓 ${U.faDateShort(r.depart_at)}</div>` : ''}
    <div class="route small muted">موجودی گزارش‌شده: ${U.fmtNum(r.qty_available)}</div>
    <div class="price-row">
      <div class="price">${U.money(r.unit_price)}</div>
      <a class="btn small" href="/panel/agent/fed-market/${U.esc(r.id)}">رزرو فدرال</a>
    </div>
  </article>`).join('')}</div>` : '<div class="empty">کاتالوگ همکاران خالی است؛ دکمه همگام‌سازی را بزنید.</div>'}`}`;
    renderPanel(ctx, cfg, { title: 'بازار فدراسیون', active: '/panel/agent/fed-market', content });
  });

  /* فرم رزرو فدرال */
  router.get('/panel/agent/fed-market/:id', (ctx) => {
    requireAgent(ctx);
    const r = db.prepare(`SELECT r.*, p.name AS peer_name, p.base_url, p.id AS peer_id FROM fed_remote_items r
      JOIN fed_peers p ON p.id=r.peer_id WHERE r.id=?`).get(ctx.params.id);
    if (!r) throw new HttpError(404, 'آیتم فدرال یافت نشد.');
    const content = `
<div class="panel-head"><h1>🌐 رزرو فدرال از ${U.esc(r.peer_name)}</h1></div>
<form class="card" method="post" action="/panel/agent/fed-market/${U.esc(r.id)}">
  ${csrfInput(ctx)}
  <h2>${U.esc(r.title)}</h2>
  <p class="muted">${r.origin && r.destination ? `${U.esc(r.origin)} ← ${U.esc(r.destination)} — ` : ''}${r.depart_at ? U.faDate(r.depart_at) : ''}</p>
  <div class="alert info">قیمت همکار: <strong>${U.money(r.unit_price)}</strong> — پس از ثبت، درخواست رزرو بلادرنگ به ${U.esc(r.peer_name)} ارسال می‌شود و کد پیگیری دوگانه (این‌سو و آن‌سو) صادر می‌گردد. قیمت فروش به مشتری را در فیلد پایین تعیین می‌کنید؛ مابه‌التفاوت کمیسیون شماست.</div>
  <div class="form-grid">
    <div class="field"><label>قیمت فروش به مشتری (ریال) *</label><input required type="number" name="sell_price" min="${r.unit_price}" step="1000" value="${r.unit_price + Math.round(r.unit_price * 0.08)}"></div>
    <div class="field"><label>تعداد *</label><input required type="number" name="count" min="1" max="20" value="1"></div>
    <div class="field"><label>نام سرپرست *</label><input required name="buyer_name" maxlength="120"></div>
    <div class="field"><label>موبایل سرپرست *</label><input required name="buyer_mobile" inputmode="tel"></div>
  </div>
  <button class="btn">ارسال درخواست رزرو فدرال</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'رزرو فدرال', active: '/panel/agent/fed-market', content });
  });

  /* ثبت رزرو فدرال */
  router.post('/panel/agent/fed-market/:id', async (ctx) => {
    requireAgent(ctx);
    const r = db.prepare(`SELECT r.*, p.name AS peer_name, p.id AS peer_id, p.base_url FROM fed_remote_items r
      JOIN fed_peers p ON p.id=r.peer_id WHERE r.id=? AND p.status='active'`).get(ctx.params.id);
    if (!r) throw new HttpError(404, 'آیتم فدرال یافت نشد.');
    const b = ctx.body;
    const buyerName = U.isName(b.buyer_name);
    const buyerMobile = U.normalizeMobile(b.buyer_mobile);
    if (!buyerName || !buyerMobile) throw new HttpError(400, 'نام و موبایل سرپرست را درست وارد کنید.');
    const count = U.toInt(b.count, 0);
    const sellPrice = U.toAmount(b.sell_price);
    if (!count || count < 1 || count > 20) throw new HttpError(400, 'تعداد بین ۱ تا ۲۰.');
    if (sellPrice === null || sellPrice < r.unit_price) throw new HttpError(400, 'قیمت فروش نمی‌تواند کمتر از بهای همکار باشد.');
    const F = require('../../federation');
    const peer = db.prepare('SELECT * FROM fed_peers WHERE id=?').get(r.peer_id);
    const client = F.clientForPeer(peer, cfg);
    const idemKey = U.randomId(20);
    // تماس بلادرنگ با همتا
    const resp = await client.reserve(r.remote_offer_id, {
      travelers: count,
      contact_name: buyerName,
      contact_mobile: buyerMobile,
      booking_ref: null,
      note: `رزرو از ${cfg.companyName}`,
    }, idemKey);
    if (!resp.ok) throw new HttpError(502, 'همتا رزرو را نپذیرفت.');
    // ثبت محلی: رزرو فدرال (بدون آفر محلی)
    const ref = U.refCode('HF');
    const t = U.isoNow();
    const commission = (sellPrice - r.unit_price) * count;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO bookings (id,ref_code,kind,seller_user_id,buyer_name,buyer_mobile,traveler_count,
        unit_price,total_price,commission,status,source,pay_status,fed_peer_id,fed_booking_id,note,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(U.randomId(), ref, 'offer', ctx.user.id, buyerName, buyerMobile, count,
          sellPrice, sellPrice * count, commission, 'pending', 'federation', 'unpaid',
          r.peer_id, resp.booking_ref, `فدرال: ${r.title} از ${r.peer_name}`, t, t);
      const bookingId = db.prepare('SELECT id FROM bookings WHERE ref_code=?').get(ref).id;
      D.postLedger(db, { userId: ctx.user.id, bookingId, kind: 'fed_purchase', amount: -(r.unit_price * count), note: `خرید فدرال ${ref} از ${r.peer_name}` });
      D.postLedger(db, { userId: ctx.user.id, bookingId, kind: 'commission', amount: commission, note: `کمیسیون فروش فدرال ${ref}` });
      db.prepare('UPDATE fed_peers SET our_balance = our_balance + ?, updated_at=? WHERE id=?').run(r.unit_price * count, t, r.peer_id);
      db.exec('COMMIT');
      D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'fed.reserve_out', entity: 'booking', entityId: bookingId, detail: { peer: r.peer_name, remote: r.remote_offer_id, count } });
      redirect(ctx, `/panel/booking/${bookingId}`);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });

  /* ─── تورهای قابل فروش ─── */
  router.get('/panel/agent/packages', (ctx) => {
    requireAgent(ctx);
    const rows = db.prepare(`SELECT p.*, d.price_per_person, d.start_date, d.id AS dep_id,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.package_departure_id=d.id AND b.status IN ('pending','confirmed')) AS used,
        d.capacity_total, u.full_name AS creator
      FROM packages p
      JOIN package_departures d ON d.package_id=p.id
      JOIN users u ON u.id=p.creator_user_id
      WHERE p.status='published' AND d.status='open' AND d.start_date >= ? AND p.creator_user_id != ?
      ORDER BY d.start_date LIMIT 60`).all(U.todayLocal(), ctx.user.id);
    const content = `
<div class="panel-head"><h1>🎒 تورهای قابل فروش</h1></div>
<p class="muted">تورهای ساخته‌شده توسط پکیج‌سازان این شرکت؛ با کمیسیون ۸٪ بفروشید.</p>
${rows.length ? `<div class="grid cols-3">${rows.map((p) => `
  <article class="card offer-card">
    <div class="type">${U.esc(p.cover_emoji || '🎒')} ${p.nights ? U.fmtNum(p.nights) + ' شب' : ''} — سازنده: ${U.esc(p.creator)}</div>
    <div class="title">${U.esc(p.title)}</div>
    <div class="route">🗓 ${U.faDate(p.start_date)} — ${U.esc(p.destination || '')}</div>
    <div class="price-row">
      <div>
        <div class="price">${U.money(p.price_per_person)}</div>
        <div class="small muted">کمیسیون شما: ${U.money(Math.round(p.price_per_person * 0.08))} / نفر</div>
      </div>
      ${p.capacity_total - p.used > 0 ? `<a class="btn small" href="/panel/agent/packages/${p.dep_id}">فروش</a>` : '<span class="badge red">تکمیل</span>'}
    </div>
  </article>`).join('')}</div>` : '<div class="empty">تور فعالی برای فروش نیست.</div>'}`;
    renderPanel(ctx, cfg, { title: 'تورهای قابل فروش', active: '/panel/agent/packages', content });
  });

  router.get('/panel/agent/packages/:depId', (ctx) => {
    requireAgent(ctx);
    const d = db.prepare(`SELECT d.*, p.title, p.destination, p.creator_user_id FROM package_departures d
      JOIN packages p ON p.id=d.package_id WHERE d.id=? AND d.status='open'`).get(ctx.params.depId);
    if (!d) throw new HttpError(404, 'تاریخ اعزام یافت نشد.');
    const { avail } = D.departureAvailableQty(db, d.id);
    const content = `
<div class="panel-head"><h1>فروش تور برای مشتری</h1></div>
<form class="card" method="post" action="/panel/agent/packages/${d.id}">
  ${csrfInput(ctx)}
  <h2>${U.esc(d.title)}</h2>
  <p class="muted">حرکت ${U.faDate(d.start_date)} — قیمت پایه ${U.money(d.price_per_person)} — کمیسیون شما ۸٪</p>
  <div class="form-grid">
    <div class="field"><label>نام سرپرست *</label><input required name="buyer_name" maxlength="120"></div>
    <div class="field"><label>موبایل *</label><input required name="buyer_mobile" inputmode="tel"></div>
    <div class="field"><label>تعداد *</label><input required type="number" name="count" min="1" max="${Math.max(1, avail)}" value="1"></div>
  </div>
  <button class="btn" ${avail > 0 ? '' : 'disabled'}>ثبت فروش</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'فروش تور', active: '/panel/agent/packages', content });
  });

  router.post('/panel/agent/packages/:depId', (ctx) => {
    requireAgent(ctx);
    const d = db.prepare(`SELECT d.*, p.creator_user_id FROM package_departures d
      JOIN packages p ON p.id=d.package_id WHERE d.id=? AND d.status='open'`).get(ctx.params.depId);
    if (!d) throw new HttpError(404, 'تاریخ اعزام یافت نشد.');
    const b = ctx.body;
    const buyerName = U.isName(b.buyer_name);
    const buyerMobile = U.normalizeMobile(b.buyer_mobile);
    if (!buyerName || !buyerMobile) throw new HttpError(400, 'نام و موبایل مشتری را درست وارد کنید.');
    const count = U.toInt(b.count, 0);
    if (!count || count < 1) throw new HttpError(400, 'تعداد معتبر نیست.');
    const result = D.bookPackage(db, {
      departure: d, sellerId: ctx.user.id, buyerName, buyerMobile,
      travelers: Array.from({ length: count }, () => ({ full_name: 'مسافر (ثبت واسطه)' })),
      note: 'فروش واسطه‌ای تور', source: 'panel', commissionRate: 0.08,
    });
    redirect(ctx, `/panel/booking/${result.id}`);
  });

  /* ─── رزروهای من و مالی (مشترک بین agent/packager) ─── */
  router.get(['/panel/agent/bookings', '/panel/packager/bookings'], (ctx) => {
    requireAgent(ctx);
    const rows = db.prepare(`SELECT b.*, i.title AS offer_title, p.title AS pkg_title
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      WHERE b.seller_user_id=? ORDER BY b.created_at DESC LIMIT 100`).all(ctx.user.id);
    const commissionSum = rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.commission, 0);
    const content = `
<div class="panel-head"><h1>🧾 رزروهای من</h1></div>
${statCards([
      [U.fmtNum(rows.length), 'کل فروش'],
      [U.fmtNum(rows.filter((r) => r.status === 'pending').length), 'در انتظار'],
      [U.money(commissionSum), 'کمیسیون جمع'],
    ])}
${bookingsTable(rows, { actions: (b) => b.status === 'pending'
      ? `<form method="post" action="/panel/booking/${b.id}/confirm" style="display:inline">${csrfInput(ctx)}<button class="btn small">تایید پرداخت</button></form>`
      : '' })}`;
    renderPanel(ctx, cfg, { title: 'رزروهای من', active: ctx.pathname.includes('packager') ? '/panel/packager/bookings' : '/panel/agent/bookings', content });
  });

  router.get(['/panel/agent/finance', '/panel/packager/finance'], (ctx) => {
    requireAgent(ctx);
    const entries = db.prepare(`SELECT * FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 60`).all(ctx.user.id);
    const balance = D.userBalance(db, ctx.user.id);
    const KIND_TITLE = {
      sale: 'فروش', commission: 'کمیسیون', purchase: 'خرید', payout: 'تسویه',
      deposit: 'شارژ', refund: 'برگشت', fed_sale: 'فروش فدرال', fed_purchase: 'خرید فدرال', adjustment: 'تعدیل',
    };
    const content = `
<div class="panel-head"><h1>💰 کمیسیون‌ها و تسویه</h1></div>
${statCards([
      [balance >= 0 ? U.money(balance) : `<span style="color:var(--danger)">${U.money(balance)}</span>`, balance >= 0 ? 'طلب از شرکت' : 'بدهی به شرکت'],
      [U.money(entries.filter((e) => e.kind === 'commission').reduce((s, e) => s + e.amount, 0)), 'جمع کمیسیون'],
    ])}
<div class="card"><h2>تراکنش‌ها</h2>
<div class="table-wrap"><table class="data">
  <tr><th>تاریخ</th><th>نوع</th><th>مبلغ</th><th>مانده</th><th>شرح</th></tr>
  ${entries.map((e) => `<tr>
    <td class="small">${U.faDateShort(e.at)}</td>
    <td><span class="badge ${e.amount >= 0 ? 'green' : 'red'}">${KIND_TITLE[e.kind] || e.kind}</span></td>
    <td style="color:${e.amount >= 0 ? 'var(--ok)' : 'var(--danger)'}">${e.amount >= 0 ? '+' : ''}${U.money(e.amount)}</td>
    <td>${U.money(e.balance_after)}</td>
    <td class="small">${U.esc(e.note || '')}</td>
  </tr>`).join('')}
</table></div></div>`;
    renderPanel(ctx, cfg, { title: 'مالی', active: ctx.pathname.includes('packager') ? '/panel/packager/finance' : '/panel/agent/finance', content });
  });
}

module.exports = { registerAgentRoutes, marketOffers };
