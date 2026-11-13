'use strict';
/** روت‌های مشترک پنل — داشبورد نقش‌محور، جزئیات رزرو، تایید/لغو */

const U = require('../util');
const D = require('../domain');
const { html, json, redirect, HttpError, issueCsrf } = require('./core');
const { renderPanel, statCards, bookingsTable, bookingStatusBadge, csrfInput } = require('./panel-ui');

function registerPanelCommonRoutes(router, { db, cfg }) {

  /* داشبورد عمومی پنل — بر اساس نقش هدایت یا رندر */
  router.get('/panel', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login?next=/panel');
    const r = ctx.user.role;
    if (r === 'admin' || r === 'employee') return redirect(ctx, '/panel/admin');
    if (r === 'supplier') return redirect(ctx, '/panel/supplier/inventory');
    if (r === 'packager') return redirect(ctx, '/panel/packager/packages');
    if (r === 'agent') return redirect(ctx, '/panel/agent/market');
    // مشتری: سفارش‌های من
    const rows = db.prepare(`SELECT b.*, i.title AS offer_title, p.title AS pkg_title
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      WHERE b.buyer_mobile=? OR b.customer_user_id=?
      ORDER BY b.created_at DESC LIMIT 50`).all(ctx.user.mobile, ctx.user.id);
    const content = `
<div class="panel-head"><h1>🧾 سفارش‌های من</h1></div>
${rows.length ? bookingsTable(rows, { showBuyer: false }) : `
<div class="empty">هنوز سفارشی ندارید.</div>
<p class="center"><a class="btn" href="/tours">مشاهده تورها</a> <a class="btn secondary" href="/services">خدمات تک</a></p>`}`;
    renderPanel(ctx, cfg, { title: 'سفارش‌های من', active: '/panel', content });
  });

  /* رزروهای کارمند */
  router.get('/panel/bookings', (ctx) => {
    if (!ctx.user || !['admin', 'employee'].includes(ctx.user.role)) throw new HttpError(403, 'دسترسی ندارید.');
    redirect(ctx, '/panel/admin/bookings');
  });
  router.get('/panel/customers', (ctx) => {
    if (!ctx.user || !['admin', 'employee'].includes(ctx.user.role)) throw new HttpError(403, 'دسترسی ندارید.');
    redirect(ctx, '/panel/admin/users?role=customer');
  });
  router.get('/panel/messages', (ctx) => {
    if (!ctx.user || !['admin', 'employee'].includes(ctx.user.role)) throw new HttpError(403, 'دسترسی ندارید.');
    redirect(ctx, '/panel/admin/messages');
  });

  /* پروفایل مشتری */
  router.get('/panel/profile', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    const content = `
<div class="panel-head"><h1>👤 مشخصات من</h1></div>
<form class="card" method="post" action="/panel/profile">
  ${csrfInput(ctx)}
  <div class="form-grid">
    <div class="field"><label>نام و نام خانوادگی</label><input name="full_name" value="${U.esc(ctx.user.full_name)}" maxlength="120"></div>
    <div class="field"><label>موبایل</label><input value="${U.esc(ctx.user.mobile || '')}" disabled></div>
    <div class="field"><label>ایمیل</label><input name="email" type="email" value="${U.esc(ctx.user.email || '')}"></div>
  </div>
  <button class="btn">ذخیره</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'مشخصات', active: '/panel/profile', content });
  });

  router.post('/panel/profile', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    const name = U.isName(ctx.body.full_name) || ctx.user.full_name;
    const email = U.normalizeEmail(ctx.body.email) || null;
    db.prepare('UPDATE users SET full_name=?, email=?, updated_at=? WHERE id=?')
      .run(name, email, U.isoNow(), ctx.user.id);
    redirect(ctx, '/panel/profile?ok=1');
  });

  /* ─── جزئیات رزرو (مشترک همه نقش‌ها با کنترل دسترسی) ─── */
  router.get('/panel/booking/:id', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    const b = db.prepare(`SELECT b.*, i.title AS offer_title, i.origin, i.destination, i.depart_at, i.hotel_name,
        p.title AS pkg_title, p.slug AS pkg_slug, d.start_date,
        st.title AS type_title, st.emoji,
        seller.full_name AS seller_name, supplier.full_name AS supplier_name,
        peer.name AS peer_name
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN service_types st ON st.id=i.type_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      LEFT JOIN users seller ON seller.id=b.seller_user_id
      LEFT JOIN users supplier ON supplier.id=b.supplier_user_id
      LEFT JOIN fed_peers peer ON peer.id=b.fed_peer_id
      WHERE b.id=? OR b.ref_code=?`).get(ctx.params.id, ctx.params.id);
    if (!b) throw new HttpError(404, 'رزرو یافت نشد.');
    // دسترسی: مدیر/کارمند، فروشنده، تامین‌کننده، یا مشتریِ خودش
    const isStaff = ['admin', 'employee'].includes(ctx.user.role);
    const allowed = isStaff || b.seller_user_id === ctx.user.id || b.supplier_user_id === ctx.user.id
      || (b.customer_user_id === ctx.user.id) || (ctx.user.mobile && b.buyer_mobile === ctx.user.mobile);
    if (!allowed) throw new HttpError(403, 'به این رزرو دسترسی ندارید.');
    const travelers = db.prepare('SELECT * FROM booking_travelers WHERE booking_id=? ORDER BY position').all(b.id);
    const title = b.kind === 'package' ? b.pkg_title : b.offer_title;
    const content = `
<div class="panel-head"><h1>🧾 رزرو ${U.esc(b.ref_code)}</h1>
  <div>
    ${b.status === 'pending' ? `<form method="post" action="/panel/booking/${b.id}/confirm" style="display:inline">${csrfInput(ctx)}<button class="btn">✅ تایید پرداخت</button></form>` : ''}
    ${['pending', 'confirmed'].includes(b.status) ? `<form method="post" action="/panel/booking/${b.id}/cancel" style="display:inline">${csrfInput(ctx)}<button class="btn danger">لغو رزرو</button></form>` : ''}
    <a class="btn secondary" href="/voucher/${U.esc(b.ref_code)}">مشاهده واچر</a>
  </div>
</div>
${b.fed_peer_id ? `<div class="alert info">🌐 <strong>رزرو فدرال</strong> — شرکت همکار: ${U.esc(b.peer_name || '')} ${b.fed_booking_id ? '— کد رزرو در آن‌سو: <code dir="ltr">' + U.esc(b.fed_booking_id) + '</code>' : ''}</div>` : ''}
<div class="grid cols-2">
  <div class="card">
    <h2>مشخصات رزرو</h2>
    <div class="kv">
      <span class="k">خدمت</span><span>${b.emoji || '🎫'} ${U.esc(title || '—')}</span>
      ${b.origin && b.destination ? `<span class="k">مسیر</span><span>${U.esc(b.origin)} ← ${U.esc(b.destination)}</span>` : ''}
      ${b.depart_at ? `<span class="k">تاریخ سفر</span><span>${U.faDateTime(b.depart_at)}</span>` : ''}
      ${b.start_date ? `<span class="k">تاریخ حرکت</span><span>${U.faDate(b.start_date)}</span>` : ''}
      <span class="k">سرپرست</span><span>${U.esc(b.buyer_name)} — ${U.esc(b.buyer_mobile)}</span>
      <span class="k">تعداد</span><span>${U.fmtNum(b.traveler_count)} نفر</span>
      <span class="k">قیمت واحد</span><span>${U.money(b.unit_price)}</span>
      <span class="k">مبلغ کل</span><span><strong>${U.money(b.total_price)}</strong></span>
      ${b.commission ? `<span class="k">کمیسیون فروشنده</span><span>${U.money(b.commission)}</span>` : ''}
      <span class="k">فروشنده</span><span>${U.esc(b.seller_name || '—')}</span>
      ${b.supplier_name ? `<span class="k">تامین‌کننده</span><span>${U.esc(b.supplier_name)}</span>` : ''}
      <span class="k">وضعیت</span><span>${bookingStatusBadge(b)}</span>
      <span class="k">ثبت</span><span>${U.faDateTime(b.created_at)}</span>
    </div>
    ${b.note ? `<p class="small muted">یادداشت: ${U.esc(b.note)}</p>` : ''}
  </div>
  <div class="card">
    <h2>مسافران</h2>
    ${travelers.length ? `<div class="table-wrap"><table class="data">
      <tr><th>#</th><th>نام</th><th>کد ملی</th></tr>
      ${travelers.map((t, i) => `<tr><td>${U.fmtNum(i + 1)}</td><td>${U.esc(t.full_name)}</td><td dir="ltr">${U.esc(t.national_id || '—')}</td></tr>`).join('')}
    </table></div>` : '<div class="empty">مسافری ثبت نشده.</div>'}
  </div>
</div>`;
    renderPanel(ctx, cfg, { title: `رزرو ${b.ref_code}`, active: '', content });
  });

  /* تایید پرداخت */
  router.post('/panel/booking/:id/confirm', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    const b = db.prepare('SELECT * FROM bookings WHERE id=? OR ref_code=?').get(ctx.params.id, ctx.params.id);
    if (!b) throw new HttpError(404, 'رزرو یافت نشد.');
    const isStaff = ['admin', 'employee'].includes(ctx.user.role);
    const allowed = isStaff || b.seller_user_id === ctx.user.id || b.supplier_user_id === ctx.user.id;
    if (!allowed) throw new HttpError(403, 'دسترسی ندارید.');
    D.confirmBooking(db, b.id, ctx.user, 'manual:' + ctx.user.id);
    redirect(ctx, '/panel/booking/' + b.id);
  });

  /* لغو */
  router.post('/panel/booking/:id/cancel', (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    const b = db.prepare('SELECT * FROM bookings WHERE id=? OR ref_code=?').get(ctx.params.id, ctx.params.id);
    if (!b) throw new HttpError(404, 'رزرو یافت نشد.');
    const isStaff = ['admin', 'employee'].includes(ctx.user.role);
    const allowed = isStaff || b.seller_user_id === ctx.user.id || b.supplier_user_id === ctx.user.id;
    if (!allowed) throw new HttpError(403, 'دسترسی ندارید.');
    D.cancelBooking(db, b.id, ctx.user, ctx.body.reason || 'لغو توسط کاربر پنل');
    // اگر فدرال بود: اطلاع به همتا
    if (b.fed_peer_id && b.fed_booking_id) {
      const F = require('./federation');
      const peer = db.prepare('SELECT * FROM fed_peers WHERE id=?').get(b.fed_peer_id);
      if (peer) {
        F.clientForPeer(peer, cfg).cancel(b.fed_booking_id, { reason: 'لغو توسط فروشنده' }, U.randomId(20))
          .catch((e) => require('../logger').warn('fed cancel failed', { err: e.message, ref: b.ref_code }));
      }
    }
    redirect(ctx, '/panel/booking/' + b.id);
  });

  /* نقشه سایت پنل (نه) — به‌جای آن: API وضعیت سلامت */
  router.get('/api/health', (ctx) => {
    json(ctx, {
      ok: true, product: 'HamSafar', company: cfg.companyName,
      time: U.isoNow(), users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    });
  });
}

module.exports = { registerPanelCommonRoutes };
