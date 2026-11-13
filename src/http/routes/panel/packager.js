'use strict';
/** پنل پکیج‌ساز — ساخت تور از اجزای خدمت، تاریخ‌های اعزام، انتشار */

const U = require('../../../util');
const D = require('../../../domain');
const { html, json, redirect, HttpError } = require('../../core');
const { renderPanel, statCards, csrfInput } = require('../../panel-ui');
const { marketOffers } = require('./agent');

function requirePackager(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ورود لازم است.');
  if (!['packager', 'admin'].includes(ctx.user.role)) throw new HttpError(403, 'این بخش مخصوص پکیج‌سازان است.');
}

function registerPackagerRoutes(router, { db, cfg }) {

  router.get('/panel/packager', (ctx) => {
    requirePackager(ctx);
    redirect(ctx, '/panel/packager/packages');
  });

  /* لیست پکیج‌ها */
  router.get('/panel/packager/packages', (ctx) => {
    requirePackager(ctx);
    const rows = db.prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM package_departures d WHERE d.package_id=p.id AND d.status='open' AND d.start_date >= ?) AS open_deps,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b JOIN package_departures d2 ON d2.id=b.package_departure_id
          WHERE d2.package_id=p.id AND b.status IN ('pending','confirmed')) AS sold
      FROM packages p WHERE p.creator_user_id=? ORDER BY p.created_at DESC`).all(U.todayLocal(), ctx.user.id);
    const content = `
<div class="panel-head"><h1>🎒 پکیج‌های من</h1><a class="btn" href="/panel/packager/packages/new">+ پکیج جدید</a></div>
${rows.length ? `<div class="table-wrap"><table class="data">
  <tr><th>عنوان</th><th>مقصد</th><th>مدت</th><th>قیمت پایه</th><th>تاریخ باز</th><th>فروخته‌شده</th><th>انتشار</th><th></th></tr>
  ${rows.map((p) => `<tr>
    <td><a href="/panel/packager/packages/${p.id}"><strong>${U.esc(p.title)}</strong></a></td>
    <td>${U.esc(p.destination || '—')}</td>
    <td>${p.nights ? U.fmtNum(p.nights) + ' شب' : '—'}</td>
    <td>${U.money(p.base_price)}</td>
    <td>${p.open_deps ? `<span class="badge green">${U.fmtNum(p.open_deps)}</span>` : '—'}</td>
    <td>${U.fmtNum(p.sold)}</td>
    <td>${p.public_published && p.status === 'published' ? '<span class="badge green">در سایت</span>' : p.status === 'draft' ? '<span class="badge gray">پیش‌نویس</span>' : '<span class="badge red">بایگانی</span>'}</td>
    <td><a class="btn small secondary" href="/panel/packager/packages/${p.id}">مدیریت</a></td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">هنوز پکیجی نساخته‌اید.</div>'}`;
    renderPanel(ctx, cfg, { title: 'پکیج‌های من', active: '/panel/packager/packages', content });
  });

  /* پکیج جدید */
  router.get('/panel/packager/packages/new', (ctx) => {
    requirePackager(ctx);
    const content = `
<div class="panel-head"><h1>➕ پکیج (تور) جدید</h1></div>
<form class="card" method="post" action="/panel/packager/packages/new">
  ${csrfInput(ctx)}
  <div class="form-grid">
    <div class="field"><label>عنوان تور *</label><input required name="title" maxlength="160" placeholder="تور ۳ روزه کیش با پرواز"></div>
    <div class="field"><label>مبدأ *</label><input required name="origin" maxlength="60" placeholder="تهران"></div>
    <div class="field"><label>مقصد *</label><input required name="destination" maxlength="60" placeholder="کیش"></div>
    <div class="field"><label>مدت (شب) *</label><input required type="number" name="nights" min="1" max="30" value="2"></div>
    <div class="field"><label>قیمت پایه هر نفر (ریال) *</label><input required type="number" name="base_price" min="0" step="100000" placeholder="3200000"></div>
    <div class="field"><label>ایموجی جلد</label><input name="cover_emoji" maxlength="8" value="🎒"></div>
  </div>
  <div class="field"><label>خلاصه (نمایش در کارت‌ها) *</label><input required name="summary" maxlength="200"></div>
  <div class="field"><label>شرح کامل</label><textarea name="description" rows="5" maxlength="4000" placeholder="برنامه روزبه‌روز، خدمات شامل و..."></textarea></div>
  <button class="btn">ساخت پکیج</button>
  <p class="small muted">پس از ساخت، اجزا و تاریخ‌های اعزام را اضافه می‌کنید.</p>
</form>`;
    renderPanel(ctx, cfg, { title: 'پکیج جدید', active: '/panel/packager/packages', content });
  });

  router.post('/panel/packager/packages/new', (ctx) => {
    requirePackager(ctx);
    const b = ctx.body;
    const title = U.isName(b.title);
    if (!title) throw new HttpError(400, 'عنوان تور را وارد کنید.');
    const basePrice = U.toAmount(b.base_price);
    if (basePrice === null) throw new HttpError(400, 'قیمت پایه معتبر وارد کنید.');
    const nights = U.toInt(b.nights, 1);
    let slug = U.slugify(title);
    if (db.prepare('SELECT 1 FROM packages WHERE slug=?').get(slug)) slug = slug + '-' + U.randomId(4).toLowerCase();
    const id = U.randomId();
    const t = U.isoNow();
    db.prepare(`INSERT INTO packages (id,creator_user_id,title,slug,summary,description,origin,destination,days,nights,base_price,public_published,status,cover_emoji,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ctx.user.id, title, slug, U.cleanText(b.summary, 200) || title, U.cleanText(b.description, 4000) || null,
        U.cleanText(b.origin, 60), U.cleanText(b.destination, 60), nights + 1, nights, basePrice, 0, 'draft',
        U.cleanText(b.cover_emoji, 8) || '🎒', t, t);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'package.create', entity: 'package', entityId: id });
    redirect(ctx, `/panel/packager/packages/${id}`);
  });

  /* مدیریت پکیج */
  router.get('/panel/packager/packages/:id', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    const comps = db.prepare(`SELECT pc.*, i.title, i.origin, i.destination, st.emoji, st.title AS type_title, io.unit_price AS offer_price
      FROM package_components pc
      LEFT JOIN inventory_items i ON i.id=pc.item_id
      LEFT JOIN service_types st ON st.id=i.type_id
      LEFT JOIN inventory_offers io ON io.id=pc.offer_id
      WHERE pc.package_id=? ORDER BY pc.position`).all(p.id);
    const deps = db.prepare(`SELECT d.*,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.package_departure_id=d.id AND b.status IN ('pending','confirmed')) AS used
      FROM package_departures d WHERE d.package_id=? ORDER BY d.start_date`).all(p.id);
    // اجزای موجود: آفرهای بازار + آیتم‌های مستقیم خودم
    const myItems = db.prepare(`SELECT i.id, i.title, i.emoji FROM inventory_items i WHERE i.owner_user_id=? AND i.status='active'`).all(ctx.user.id);
    const market = marketOffers(db, ctx.user.id, {});
    const content = `
<div class="panel-head"><h1>${U.esc(p.cover_emoji)} ${U.esc(p.title)}</h1>
  <div>
    ${p.status !== 'published'
      ? `<form method="post" action="/panel/packager/packages/${p.id}/publish" style="display:inline">${csrfInput(ctx)}<button class="btn">انتشار</button></form>`
      : `<form method="post" action="/panel/packager/packages/${p.id}/unpublish" style="display:inline">${csrfInput(ctx)}<button class="btn secondary">توقف انتشار</button></form>`}
  </div>
</div>
<div class="card">
  <div class="kv">
    <span class="k">وضعیت</span><span>${p.public_published && p.status === 'published' ? '<span class="badge green">منتشرشده در سایت عمومی</span>' : '<span class="badge gray">پیش‌نویس</span>'}</span>
    <span class="k">مسیر</span><span>${U.esc(p.origin || '')} ← ${U.esc(p.destination || '')}</span>
    <span class="k">مدت</span><span>${U.fmtNum(p.nights)} شب / ${U.fmtNum(p.days)} روز</span>
    <span class="k">قیمت پایه</span><span>${U.money(p.base_price)}</span>
  </div>
</div>

<h2>🧩 اجزای تور</h2>
<div class="card">
${comps.length ? `<div class="table-wrap"><table class="data">
  <tr><th>#</th><th>جزء</th><th>نوع</th><th>منبع</th><th>مقدار/نفر</th><th></th></tr>
  ${comps.map((c, idx) => `<tr>
    <td>${U.fmtNum(idx + 1)}</td>
    <td>${U.esc(c.title || '—')}</td>
    <td>${c.emoji || ''} ${U.esc(c.type_title || '—')}</td>
    <td>${c.offer_id ? '<span class="badge blue">بازار</span>' : '<span class="badge gray">موجودی خودم</span>'}</td>
    <td>${c.qty_per_person ? U.fmtNum(c.qty_per_person) : '—'}</td>
    <td><form method="post" action="/panel/packager/packages/${p.id}/components/${c.id}/delete">${csrfInput(ctx)}<button class="btn small danger">حذف</button></form></td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">هنوز جزئی اضافه نشده؛ از پایین اضافه کنید.</div>'}
</div>
<details class="box"><summary>➕ افزودن جزء از بازار خدمات</summary>
  <form method="post" action="/panel/packager/packages/${p.id}/components" style="margin-top:.8rem">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <div class="field"><label>آفر بازار</label>
        <select name="offer_id">${market.map((m) => `<option value="${m.id}">${m.emoji || ''} ${U.esc(m.title)} — ${U.money(m.unit_price)} (${U.esc(m.seller_company || m.seller_name)})</option>`).join('')}</select></div>
      <div class="field"><label>مقدار به‌ازای هر نفر</label><input type="number" name="qty_per_person" min="1" value="1" max="4"></div>
    </div>
    <div class="field"><label>یادداشت</label><input name="notes" maxlength="200" placeholder="مثلاً: پرواز رفت، اتاق دو تخته"></div>
    <button class="btn">افزودن از بازار</button>
  </form>
</details>
<details class="box"><summary>➕ افزودن جزء از موجودی خودم</summary>
  <form method="post" action="/panel/packager/packages/${p.id}/components" style="margin-top:.8rem">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <div class="field"><label>خدمت من</label>
        <select name="item_id">${myItems.map((m) => `<option value="${m.id}">${m.emoji || ''} ${U.esc(m.title)}</option>`).join('') || '<option value="">موجودی ندارید</option>'}</select></div>
      <div class="field"><label>مقدار به‌ازای هر نفر</label><input type="number" name="qty_per_person" min="1" value="1" max="4"></div>
    </div>
    <div class="field"><label>یادداشت</label><input name="notes" maxlength="200"></div>
    <button class="btn">افزودن از موجودی</button>
  </form>
</details>

<h2 style="margin-top:1.6rem">🗓 تاریخ‌های اعزام</h2>
<div class="card">
${deps.length ? `<div class="table-wrap"><table class="data">
  <tr><th>تاریخ</th><th>ظرفیت</th><th>فروخته</th><th>باقی</th><th>قیمت هر نفر</th><th>وضعیت</th><th></th></tr>
  ${deps.map((d) => `<tr>
    <td>${U.faDate(d.start_date)}</td>
    <td>${U.fmtNum(d.capacity_total)}</td>
    <td>${U.fmtNum(d.used)}</td>
    <td>${U.fmtNum(Math.max(0, d.capacity_total - d.used))}</td>
    <td>${U.money(d.price_per_person)}</td>
    <td>${d.status === 'open' ? '<span class="badge green">باز</span>' : '<span class="badge gray">' + d.status + '</span>'}</td>
    <td>${d.status === 'open' ? `<form method="post" action="/panel/packager/packages/${p.id}/departures/${d.id}/close">${csrfInput(ctx)}<button class="btn small secondary">بستن</button></form>` : ''}</td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">تاریخ اعزامی ثبت نشده؛ بدون تاریخ، تور قابل رزرو نیست.</div>'}
</div>
<details class="box"><summary>➕ افزودن تاریخ اعزام</summary>
  <form method="post" action="/panel/packager/packages/${p.id}/departures" style="margin-top:.8rem">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <div class="field"><label>تاریخ شروع *</label><input required type="date" name="start_date"></div>
      <div class="field"><label>ظرفیت *</label><input required type="number" name="capacity_total" min="1" value="20"></div>
      <div class="field"><label>قیمت هر نفر (ریال) *</label><input required type="number" name="price_per_person" min="0" step="100000" value="${p.base_price}"></div>
      <div class="field"><label>مهلت رزرو (تاریخ)</label><input type="date" name="book_until"></div>
    </div>
    <button class="btn">افزودن تاریخ</button>
  </form>
</details>`;
    renderPanel(ctx, cfg, { title: p.title, active: '/panel/packager/packages', content });
  });

  /* افزودن جزء */
  router.post('/panel/packager/packages/:id/components', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    const b = ctx.body;
    let itemId = null, offerId = null;
    if (b.offer_id) {
      const offer = db.prepare(`SELECT o.*, i.status AS item_status FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
        WHERE o.id=? AND o.status='open' AND o.kind='market' AND o.visible_to_agents=1`).get(b.offer_id);
      if (!offer) throw new HttpError(400, 'آفر بازار معتبر نیست.');
      offerId = offer.id; itemId = offer.item_id;
    } else if (b.item_id) {
      const item = db.prepare(`SELECT * FROM inventory_items WHERE id=? AND owner_user_id=?`).get(b.item_id, ctx.user.id);
      if (!item) throw new HttpError(400, 'خدمت انتخابی متعلق به شما نیست.');
      itemId = item.id;
    } else throw new HttpError(400, 'جزء انتخاب نشده است.');
    const pos = (db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM package_components WHERE package_id=?').get(p.id)).p;
    db.prepare(`INSERT INTO package_components (id,package_id,offer_id,item_id,qty_per_person,notes,position)
      VALUES (?,?,?,?,?,?,?)`)
      .run(U.randomId(), p.id, offerId, itemId, U.toInt(b.qty_per_person) || 1, U.cleanText(b.notes, 200) || null, pos);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'package.component.add', entity: 'package', entityId: p.id, detail: { offerId, itemId } });
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  router.post('/panel/packager/packages/:id/components/:cid/delete', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    db.prepare('DELETE FROM package_components WHERE id=? AND package_id=?').run(ctx.params.cid, p.id);
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  /* افزودن تاریخ اعزام */
  router.post('/panel/packager/packages/:id/departures', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    const b = ctx.body;
    const start = U.normDate(b.start_date);
    if (!start || !U.isDate(start)) throw new HttpError(400, 'تاریخ شروع معتبر نیست.');
    if (start < U.todayLocal()) throw new HttpError(400, 'تاریخ شروع نمی‌تواند در گذشته باشد.');
    const cap = U.toInt(b.capacity_total);
    const price = U.toAmount(b.price_per_person);
    if (!cap || cap < 1) throw new HttpError(400, 'ظرفیت معتبر نیست.');
    if (price === null) throw new HttpError(400, 'قیمت معتبر نیست.');
    const bookUntil = U.normDate(b.book_until);
    db.prepare(`INSERT INTO package_departures (id,package_id,start_date,capacity_total,price_per_person,status,book_until,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(U.randomId(), p.id, start, cap, price, 'open', bookUntil, U.isoNow());
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'package.departure.add', entity: 'package', entityId: p.id, detail: { start, cap, price } });
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  router.post('/panel/packager/packages/:id/departures/:did/close', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    db.prepare(`UPDATE package_departures SET status='closed' WHERE id=? AND package_id=?`).run(ctx.params.did, p.id);
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  /* انتشار / توقف */
  router.post('/panel/packager/packages/:id/publish', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    const deps = db.prepare(`SELECT COUNT(*) AS c FROM package_departures WHERE package_id=? AND status='open' AND start_date >= ?`).get(p.id, U.todayLocal());
    if (!deps.c) throw new HttpError(400, 'برای انتشار حداقل یک تاریخ اعزام باز لازم است.');
    db.prepare(`UPDATE packages SET status='published', public_published=1, updated_at=? WHERE id=?`).run(U.isoNow(), p.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'package.publish', entity: 'package', entityId: p.id });
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  router.post('/panel/packager/packages/:id/unpublish', (ctx) => {
    requirePackager(ctx);
    const p = db.prepare('SELECT * FROM packages WHERE id=? AND creator_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!p) throw new HttpError(404, 'پکیج یافت نشد.');
    db.prepare(`UPDATE packages SET public_published=0, updated_at=? WHERE id=?`).run(U.isoNow(), p.id);
    redirect(ctx, `/panel/packager/packages/${p.id}`);
  });

  /* بازار برای پکیج‌ساز (همان بازار واسطه) */
  router.get('/panel/packager/market', (ctx) => {
    requirePackager(ctx);
    // همان بازار داخلی؛ برای سادگی به صفحه agent/market هدایت می‌شویم (دسترسی packager مجاز است)
    redirect(ctx, '/panel/agent/market');
  });
  router.get('/panel/packager/fed-market', (ctx) => {
    requirePackager(ctx);
    redirect(ctx, '/panel/agent/fed-market');
  });
}

module.exports = { registerPackagerRoutes };
