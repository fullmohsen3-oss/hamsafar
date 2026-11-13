'use strict';
/** پنل تامین‌کننده/چارتر — موجودی، آفرها، انتقال مالکیت تضمینی، رزروها، مالی */

const U = require('../../../util');
const D = require('../../../domain');
const { html, json, redirect, HttpError, issueCsrf } = require('../../core');
const { renderPanel, statCards, bookingsTable, csrfInput } = require('../../panel-ui');
const { SERVICE_TYPES } = require('../../../service-types');

function requireSupplier(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ورود لازم است.');
  if (ctx.user.role !== 'supplier' && ctx.user.role !== 'admin') throw new HttpError(403, 'این بخش مخصوص تامین‌کنندگان است.');
}

function registerSupplierRoutes(router, { db, cfg }) {

  /* ─── داشبورد ─── */
  router.get('/panel/supplier', (ctx) => {
    requireSupplier(ctx);
    redirect(ctx, '/panel/supplier/inventory');
  });

  /* ─── موجودی ─── */
  router.get('/panel/supplier/inventory', (ctx) => {
    requireSupplier(ctx);
    const items = db.prepare(`SELECT i.*, st.title AS type_title, st.emoji,
        (SELECT COUNT(*) FROM inventory_offers o WHERE o.item_id=i.id AND o.status='open') AS open_offers
      FROM inventory_items i JOIN service_types st ON st.id=i.type_id
      WHERE i.owner_user_id=? ORDER BY i.created_at DESC LIMIT 100`).all(ctx.user.id);
    const content = `
<div class="panel-head"><h1>🧳 خدمات و موجودی من</h1><a class="btn" href="/panel/supplier/inventory/new">+ خدمت جدید</a></div>
${items.length ? `<div class="table-wrap"><table class="data">
  <tr><th>خدمت</th><th>نوع</th><th>مسیر/محل</th><th>تاریخ</th><th>ظرفیت کل</th><th>آفر فعال</th><th>وضعیت</th><th></th></tr>
  ${items.map((i) => `<tr>
    <td><strong>${U.esc(i.title)}</strong></td>
    <td>${i.emoji || ''} ${U.esc(i.type_title)}</td>
    <td>${i.origin && i.destination ? `${U.esc(i.origin)} ← ${U.esc(i.destination)}` : U.esc(i.hotel_name || i.route_text || '—')}</td>
    <td class="small">${i.depart_at ? U.faDateShort(i.depart_at) : (i.checkin_date ? 'ورود ' + U.faDateShort(i.checkin_date) : '—')}</td>
    <td>${U.fmtNum(i.capacity_total)} ${U.esc(i.unit_label)}</td>
    <td>${i.open_offers ? `<span class="badge green">${U.fmtNum(i.open_offers)}</span>` : '—'}</td>
    <td>${i.status === 'active' ? '<span class="badge green">فعال</span>' : i.status === 'draft' ? '<span class="badge gray">پیش‌نویس</span>' : '<span class="badge red">بایگانی</span>'}</td>
    <td>
      <a class="btn small secondary" href="/panel/supplier/inventory/${i.id}">آفرها</a>
      <a class="btn small secondary" href="/panel/supplier/inventory/${i.id}/offer/new">+ آفر</a>
    </td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">هنوز خدمتی ثبت نکرده‌اید. اولین خدمت خود را بسازید.</div>'}`;
    renderPanel(ctx, cfg, { title: 'موجودی من', active: '/panel/supplier/inventory', content });
  });

  /* فرم خدمت جدید */
  router.get('/panel/supplier/inventory/new', (ctx) => {
    requireSupplier(ctx);
    const content = `
<div class="panel-head"><h1>➕ ثبت خدمت جدید</h1></div>
<form class="card" method="post" action="/panel/supplier/inventory/new">
  ${csrfInput(ctx)}
  <div class="form-grid">
    <div class="field"><label>عنوان خدمت *</label><input required name="title" maxlength="160" placeholder="مثلاً: اتوبوس ویژه تهران-مشهد / هتل شاه‌عباس"></div>
    <div class="field"><label>نوع خدمت *</label><select required name="type_id" id="typeSel">
      ${SERVICE_TYPES.map((t) => `<option value="${t.id}" data-unit="${U.esc(t.unit)}">${t.emoji} ${t.title}</option>`).join('')}
    </select></div>
    <div class="field"><label>مبدأ (حمل‌ونقل)</label><input name="origin" maxlength="60" placeholder="تهران"></div>
    <div class="field"><label>مقصد</label><input name="destination" maxlength="60" placeholder="مشهد"></div>
    <div class="field"><label>تاریخ و ساعت حرکت</label><input type="datetime-local" name="depart_at"></div>
    <div class="field"><label>زمان رسیدن (اختیاری)</label><input type="datetime-local" name="arrive_at"></div>
    <div class="field"><label>نام هتل (اقامت)</label><input name="hotel_name" maxlength="120"></div>
    <div class="field"><label>نوع اتاق</label><input name="room_type" maxlength="60" placeholder="دو تخته / سوییت"></div>
    <div class="field"><label>تاریخ ورود (اقامت)</label><input type="date" name="checkin_date"></div>
    <div class="field"><label>تعداد شب</label><input type="number" name="nights" min="1" max="30"></div>
    <div class="field"><label>کلاس/درجه</label><input name="class_text" maxlength="60" placeholder="VIP / ۵ ستاره / درجه ۱"></div>
    <div class="field"><label>برچسب واحد *</label><input required name="unit_label" id="unitLabel" value="صندلی" maxlength="30"></div>
    <div class="field"><label>قیمت پایه هر واحد (ریال) *</label><input required type="number" name="base_price" min="0" step="1000" placeholder="450000"></div>
    <div class="field"><label>ظرفیت کل *</label><input required type="number" name="capacity_total" min="1" placeholder="44"></div>
  </div>
  <div class="field"><label>توضیحات</label><textarea name="description" rows="3" maxlength="1000"></textarea></div>
  <button class="btn">ثبت خدمت</button>
</form>
<script>
document.getElementById('typeSel').addEventListener('change', function(){
  var opt = this.selectedOptions[0];
  document.getElementById('unitLabel').value = opt.dataset.unit || 'واحد';
});
</script>`;
    renderPanel(ctx, cfg, { title: 'خدمت جدید', active: '/panel/supplier/inventory', content });
  });

  router.post('/panel/supplier/inventory/new', (ctx) => {
    requireSupplier(ctx);
    const b = ctx.body;
    const title = U.isName(b.title);
    if (!title) throw new HttpError(400, 'عنوان خدمت را وارد کنید.');
    const typeId = U.toInt(b.type_id);
    const st = SERVICE_TYPES.find((t) => t.id === typeId);
    if (!st) throw new HttpError(400, 'نوع خدمت نامعتبر است.');
    const basePrice = U.toAmount(b.base_price);
    const capacity = U.toInt(b.capacity_total);
    if (basePrice === null || basePrice < 0) throw new HttpError(400, 'قیمت پایه معتبر وارد کنید.');
    if (!capacity || capacity < 1) throw new HttpError(400, 'ظرفیت باید حداقل ۱ باشد.');
    const departAt = b.depart_at ? new Date(b.depart_at).toISOString() : null;
    const arriveAt = b.arrive_at ? new Date(b.arrive_at).toISOString() : null;
    if (b.depart_at && Number.isNaN(Date.parse(b.depart_at))) throw new HttpError(400, 'تاریخ حرکت نامعتبر است.');
    const id = U.randomId();
    const t = U.isoNow();
    db.prepare(`INSERT INTO inventory_items (id,type_id,owner_user_id,title,origin,destination,depart_at,arrive_at,
      checkin_date,nights,hotel_name,room_type,class_text,unit_label,base_price,capacity_total,description,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, typeId, ctx.user.id, title, U.cleanText(b.origin, 60) || null, U.cleanText(b.destination, 60) || null,
        departAt, arriveAt, U.normDate(b.checkin_date) || null, U.toInt(b.nights) || null,
        U.cleanText(b.hotel_name, 120) || null, U.cleanText(b.room_type, 60) || null, U.cleanText(b.class_text, 60) || null,
        U.cleanText(b.unit_label, 30) || st.unit, basePrice, capacity, U.cleanText(b.description, 1000) || null,
        'active', t, t);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'inventory.create', entity: 'inventory_item', entityId: id, detail: { title } });
    redirect(ctx, `/panel/supplier/inventory/${id}/offer/new`);
  });

  /* جزئیات خدمت + آفرها */
  router.get('/panel/supplier/inventory/:id', (ctx) => {
    requireSupplier(ctx);
    const item = db.prepare(`SELECT i.*, st.title AS type_title, st.emoji FROM inventory_items i
      JOIN service_types st ON st.id=i.type_id WHERE i.id=?`).get(ctx.params.id);
    if (!item) throw new HttpError(404, 'خدمت یافت نشد.');
    const offers = db.prepare(`SELECT o.*,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o WHERE o.item_id=? ORDER BY o.created_at DESC`).all(item.id);
    const content = `
<div class="panel-head"><h1>${item.emoji} ${U.esc(item.title)}</h1>
  <a class="btn" href="/panel/supplier/inventory/${item.id}/offer/new">+ آفر جدید</a></div>
<div class="card">
  <div class="kv">
    <span class="k">نوع</span><span>${U.esc(item.type_title)}</span>
    <span class="k">مسیر</span><span>${item.origin && item.destination ? `${U.esc(item.origin)} ← ${U.esc(item.destination)}` : '—'}</span>
    <span class="k">تاریخ حرکت</span><span>${item.depart_at ? U.faDateTime(item.depart_at) : '—'}</span>
    ${item.hotel_name ? `<span class="k">هتل</span><span>${U.esc(item.hotel_name)} ${item.room_type ? '— ' + U.esc(item.room_type) : ''}</span>` : ''}
    <span class="k">قیمت پایه</span><span>${U.money(item.base_price)}</span>
    <span class="k">ظرفیت کل</span><span>${U.fmtNum(item.capacity_total)} ${U.esc(item.unit_label)}</span>
  </div>
  ${item.description ? `<p class="muted small">${U.esc(item.description)}</p>` : ''}
</div>
<h2>آفرهای این خدمت</h2>
${offers.length ? `<div class="table-wrap"><table class="data">
  <tr><th>نوع</th><th>تعداد</th><th>قیمت واحد</th><th>قیمت عمومی</th><th>بازار</th><th>سایت</th><th>فروخته‌شده</th><th>باقی</th><th>وضعیت</th><th></th></tr>
  ${offers.map((o) => `<tr>
    <td>${o.kind === 'market' ? '<span class="badge blue">بازار</span>' : '<span class="badge orange">همکار مشخص</span>'}</td>
    <td>${U.fmtNum(o.qty)}</td>
    <td>${U.money(o.unit_price)}</td>
    <td>${o.public_price != null ? U.money(o.public_price) : '—'}</td>
    <td>${o.visible_to_agents ? '✅' : '—'}</td>
    <td>${o.visible_to_public ? '✅' : '—'}</td>
    <td>${U.fmtNum(o.used)}</td>
    <td>${U.fmtNum(Math.max(0, o.qty - o.used))}</td>
    <td>${o.status === 'open' ? '<span class="badge green">باز</span>' : '<span class="badge gray">' + o.status + '</span>'}</td>
    <td>
      ${o.status === 'open' ? `<form method="post" action="/panel/supplier/offers/${o.id}/close" style="display:inline">${csrfInput(ctx)}<button class="btn small secondary">بستن</button></form>` : ''}
    </td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">برای این خدمت آفری ثبت نشده است.</div>'}`;
    renderPanel(ctx, cfg, { title: item.title, active: '/panel/supplier/inventory', content });
  });

  /* فرم آفر جدید */
  router.get('/panel/supplier/inventory/:id/offer/new', (ctx) => {
    requireSupplier(ctx);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id=? AND owner_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!item) throw new HttpError(404, 'خدمت یافت نشد.');
    const users = db.prepare(`SELECT id, full_name, role, company_title FROM users WHERE role IN ('supplier','packager','agent') AND status='active' AND id != ?`).all(ctx.user.id);
    const content = `
<div class="panel-head"><h1>🏷️ آفر جدید برای «${U.esc(item.title)}»</h1></div>
<form class="card" method="post" action="/panel/supplier/inventory/${item.id}/offer/new">
  ${csrfInput(ctx)}
  <div class="alert info">ظرفیت آفر از ظرفیت کل خدمت کمتر یا مساوی است. آفر «بازار» به همه واسطه‌ها/پکیج‌سازان این شرکت و (در صورت فعال‌سازی) به فدراسیون نمایش داده می‌شود.</div>
  <div class="form-grid">
    <div class="field"><label>نوع آفر *</label>
      <select name="kind" id="kindSel">
        <option value="market">بازار (نمایش به همه همکاران + فدراسیون)</option>
        <option value="wholesale">فروش تضمینی به همکار مشخص (انتقال مالکیت)</option>
      </select></div>
    <div class="field" id="buyerField" style="display:none"><label>خریدار تضمینی *</label>
      <select name="buyer_user_id">${users.map((u) => `<option value="${u.id}">${U.esc(u.full_name)} (${U.esc(u.company_title || u.role)})</option>`).join('')}</select></div>
    <div class="field"><label>تعداد (ظرفیت آفر) *</label><input required type="number" name="qty" min="1" max="${item.capacity_total}"></div>
    <div class="field"><label>قیمت هر واحد برای همکار (ریال) *</label><input required type="number" name="unit_price" min="0" step="1000" value="${item.base_price}"></div>
    <div class="field"><label>نمایش به واسطه‌ها</label><select name="visible_to_agents"><option value="1">بله</option><option value="0">خیر</option></select></div>
    <div class="field"><label>نمایش در سایت عمومی</label><select name="visible_to_public"><option value="0">خیر</option><option value="1">بله</option></select></div>
    <div class="field"><label>قیمت فروش عمومی (ریال) — اگر سایت عمومی فعال شد</label><input type="number" name="public_price" min="0" step="1000" placeholder="بیشتر از قیمت همکار"></div>
    <div class="field"><label>نمایش در فدراسیون (شرکت‌های همکار دیگر)</label><select name="fed_visible"><option value="1">بله</option><option value="0">خیر</option></select></div>
  </div>
  <div class="field"><label>یادداشت</label><input name="note" maxlength="300"></div>
  <button class="btn">ثبت آفر</button>
</form>
<script>
document.getElementById('kindSel').addEventListener('change', function(){
  document.getElementById('buyerField').style.display = this.value === 'wholesale' ? '' : 'none';
});
</script>`;
    renderPanel(ctx, cfg, { title: 'آفر جدید', active: '/panel/supplier/inventory', content });
  });

  router.post('/panel/supplier/inventory/:id/offer/new', (ctx) => {
    requireSupplier(ctx);
    const item = db.prepare('SELECT * FROM inventory_items WHERE id=? AND owner_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!item) throw new HttpError(404, 'خدمت یافت نشد.');
    const b = ctx.body;
    const kind = b.kind === 'wholesale' ? 'wholesale' : 'market';
    const qty = U.toInt(b.qty);
    const unitPrice = U.toAmount(b.unit_price);
    if (!qty || qty < 1 || qty > item.capacity_total) throw new HttpError(400, `تعداد باید بین ۱ و ${item.capacity_total} باشد.`);
    if (unitPrice === null) throw new HttpError(400, 'قیمت واحد معتبر وارد کنید.');
    let buyerId = null;
    if (kind === 'wholesale') {
      buyerId = U.cleanText(b.buyer_user_id, 20);
      const buyer = db.prepare(`SELECT * FROM users WHERE id=? AND role IN ('supplier','packager','agent')`).get(buyerId);
      if (!buyer) throw new HttpError(400, 'خریدار تضمینی معتبر انتخاب نشده است.');
    }
    const publicPrice = U.toAmount(b.public_price);
    if (b.visible_to_public === '1' && publicPrice === null) throw new HttpError(400, 'برای نمایش عمومی، قیمت فروش عمومی لازم است.');
    if (publicPrice !== null && kind === 'market' && publicPrice < unitPrice) throw new HttpError(400, 'قیمت عمومی نمی‌تواند کمتر از قیمت همکار باشد.');
    const id = U.randomId();
    const t = U.isoNow();
    db.prepare(`INSERT INTO inventory_offers (id,item_id,seller_user_id,kind,buyer_user_id,qty,unit_price,
      visible_to_agents,visible_to_public,public_price,status,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, item.id, ctx.user.id, kind, buyerId, qty, unitPrice,
        b.visible_to_agents === '0' ? 0 : 1, b.visible_to_public === '1' ? 1 : 0, publicPrice,
        'open', U.cleanText(b.note, 300) || null, t, t);
    // فروش تضمینی: انتقال مالکیت ظرفیت به خریدار
    if (kind === 'wholesale') {
      db.prepare('UPDATE inventory_items SET owner_user_id=?, updated_at=? WHERE id=?').run(buyerId, t, item.id);
      D.postLedger(db, { userId: ctx.user.id, kind: 'sale', amount: qty * unitPrice, note: `فروش تضمینی ${U.fmtNum(qty)} واحد به خریدار همکار` });
      D.postLedger(db, { userId: buyerId, kind: 'purchase', amount: -(qty * unitPrice), note: `خرید تضمینی ظرفیت ${item.title}` });
      D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'offer.wholesale', entity: 'inventory_item', entityId: item.id, detail: { buyer: buyerId, qty, unitPrice } });
    } else {
      D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'offer.create', entity: 'inventory_offer', entityId: id, detail: { qty, unitPrice, fed: b.fed_visible !== '0' } });
    }
    redirect(ctx, `/panel/supplier/inventory/${item.id}`);
  });

  /* بستن آفر */
  router.post('/panel/supplier/offers/:id/close', (ctx) => {
    requireSupplier(ctx);
    const offer = db.prepare('SELECT * FROM inventory_offers WHERE id=? AND seller_user_id=?').get(ctx.params.id, ctx.user.id);
    if (!offer) throw new HttpError(404, 'آفر یافت نشد.');
    db.prepare(`UPDATE inventory_offers SET status='closed', updated_at=? WHERE id=?`).run(U.isoNow(), offer.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'offer.close', entity: 'inventory_offer', entityId: offer.id });
    redirect(ctx, `/panel/supplier/inventory/${offer.item_id}`);
  });

  /* ─── لیست همه آفرها ─── */
  router.get('/panel/supplier/offers', (ctx) => {
    requireSupplier(ctx);
    const offers = db.prepare(`SELECT o.*, i.title AS item_title, st.emoji, st.title AS type_title,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
      JOIN service_types st ON st.id=i.type_id
      WHERE o.seller_user_id=? ORDER BY o.created_at DESC LIMIT 200`).all(ctx.user.id);
    const content = `
<div class="panel-head"><h1>🏷️ عرضه‌های من</h1></div>
${offers.length ? `<div class="table-wrap"><table class="data">
  <tr><th>خدمت</th><th>نوع</th><th>تعداد</th><th>قیمت همکار</th><th>قیمت عمومی</th><th>فروش</th><th>وضعیت</th></tr>
  ${offers.map((o) => `<tr>
    <td><a href="/panel/supplier/inventory/${o.item_id}">${o.emoji || ''} ${U.esc(o.item_title)}</a></td>
    <td>${o.kind === 'market' ? 'بازار' : 'تضمینی'}</td>
    <td>${U.fmtNum(o.qty)}</td>
    <td>${U.money(o.unit_price)}</td>
    <td>${o.public_price != null ? U.money(o.public_price) : '—'}</td>
    <td>${U.fmtNum(o.used)}</td>
    <td>${o.status === 'open' ? '<span class="badge green">باز</span>' : '<span class="badge gray">بسته</span>'}</td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">آفری ندارید.</div>'}`;
    renderPanel(ctx, cfg, { title: 'عرضه‌ها', active: '/panel/supplier/offers', content });
  });

  /* ─── انتقال مالکیت: پیشنهاد انتقال ظرفیت باقی‌مانده ─── */
  router.get('/panel/supplier/transfers', (ctx) => {
    requireSupplier(ctx);
    const offers = db.prepare(`SELECT o.*, i.title AS item_title, i.unit_label,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
      WHERE o.seller_user_id=? AND o.status='open' AND o.kind='market' ORDER BY i.depart_at ASC`).all(ctx.user.id);
    const colleagues = db.prepare(`SELECT id, full_name, company_title, role FROM users WHERE role IN ('supplier','packager','agent') AND status='active' AND id != ?`).all(ctx.user.id);
    const content = `
<div class="panel-head"><h1>🔄 انتقال مالکیت تضمینی</h1></div>
<div class="alert info">فروش تضمینی یعنی مالکیت ظرفیت باقی‌ماندهٔ آفر را یک‌جا به همکار می‌دهید؛ از آن لحظه ریسک فروش و مالکیت با اوست. معامله ثبت مالی می‌شود.</div>
${offers.length ? offers.map((o) => `
<details class="box">
  <summary>${U.esc(o.item_title)} — ${U.fmtNum(Math.max(0, o.qty - o.used))} ${U.esc(o.unit_label)} باقی‌مانده — قیمت همکار ${U.money(o.unit_price)}</summary>
  <form method="post" action="/panel/supplier/transfers" style="margin-top:.8rem">
    ${csrfInput(ctx)}
    <input type="hidden" name="offer_id" value="${o.id}">
    <div class="form-grid">
      <div class="field"><label>انتقال به همکار *</label>
        <select required name="buyer_user_id">${colleagues.map((c) => `<option value="${c.id}">${U.esc(c.full_name)} — ${U.esc(c.company_title || '')} (${c.role === 'supplier' ? 'تامین‌کننده' : c.role === 'packager' ? 'پکیج‌ساز' : 'واسطه'})</option>`).join('')}</select></div>
      <div class="field"><label>تعداد برای انتقال *</label><input required type="number" name="qty" min="1" max="${Math.max(1, o.qty - o.used)}"></div>
      <div class="field"><label>قیمت توافقی هر واحد (ریال) *</label><input required type="number" name="unit_price" min="0" step="1000" value="${o.unit_price}"></div>
    </div>
    <button class="btn">انتقال مالکیت و ثبت معامله</button>
  </form>
</details>`).join('') : '<div class="empty">آفر بازی برای انتقال ندارید.</div>'}`;
    renderPanel(ctx, cfg, { title: 'انتقال مالکیت', active: '/panel/supplier/transfers', content });
  });

  router.post('/panel/supplier/transfers', (ctx) => {
    requireSupplier(ctx);
    const b = ctx.body;
    const offer = db.prepare('SELECT * FROM inventory_offers WHERE id=? AND seller_user_id=?').get(b.offer_id, ctx.user.id);
    if (!offer) throw new HttpError(404, 'آفر یافت نشد.');
    const { avail } = D.offerAvailableQty(db, offer.id);
    const qty = U.toInt(b.qty);
    if (!qty || qty < 1 || qty > avail) throw new HttpError(400, `تعداد باید بین ۱ و ${avail} باشد.`);
    const price = U.toAmount(b.unit_price);
    if (price === null) throw new HttpError(400, 'قیمت معتبر وارد کنید.');
    const buyer = db.prepare(`SELECT * FROM users WHERE id=? AND role IN ('supplier','packager','agent') AND status='active'`).get(b.buyer_user_id);
    if (!buyer) throw new HttpError(400, 'همکار مقصد معتبر نیست.');
    // آفر تضمینی جدید برای خریدار + بستن بخشی از آفر اصلی
    db.exec('BEGIN IMMEDIATE');
    try {
      const t = U.isoNow();
      if (qty === offer.qty) {
        // انتقال کل: مالکیت آفر جابه‌جا می‌شود
        db.prepare(`UPDATE inventory_offers SET seller_user_id=?, kind='wholesale', buyer_user_id=?, unit_price=?, updated_at=? WHERE id=?`)
          .run(buyer.id, buyer.id, price, t, offer.id);
        db.prepare('UPDATE inventory_items SET owner_user_id=?, updated_at=? WHERE id=?').run(buyer.id, t, offer.item_id);
      } else {
        // انتقال بخشی: آفر جدید برای خریدار، آفر اصلی کاهش می‌یابد
        const newId = U.randomId();
        db.prepare(`INSERT INTO inventory_offers (id,item_id,seller_user_id,kind,buyer_user_id,qty,unit_price,visible_to_agents,visible_to_public,public_price,status,note,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(newId, offer.item_id, buyer.id, 'wholesale', buyer.id, qty, price, 0, 0, null, 'open', 'دریافتی از انتقال مالکیت', t, t);
        db.prepare('UPDATE inventory_offers SET qty=qty-?, updated_at=? WHERE id=?').run(qty, t, offer.id);
      }
      D.postLedger(db, { userId: ctx.user.id, kind: 'sale', amount: qty * price, note: `انتقال مالکیت ${U.fmtNum(qty)} واحد` });
      D.postLedger(db, { userId: buyer.id, kind: 'purchase', amount: -(qty * price), note: `دریافت مالکیت ${U.fmtNum(qty)} واحد` });
      D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'transfer.ownership', entity: 'inventory_offer', entityId: offer.id, detail: { buyer: buyer.id, qty, price } });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    redirect(ctx, '/panel/supplier/transfers?ok=1');
  });

  /* ─── رزروهای دریافتی ─── */
  router.get('/panel/supplier/bookings', (ctx) => {
    requireSupplier(ctx);
    const rows = db.prepare(`SELECT b.*, i.title AS offer_title, p.title AS pkg_title
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      WHERE b.supplier_user_id=? OR b.seller_user_id=?
      ORDER BY b.created_at DESC LIMIT 100`).all(ctx.user.id, ctx.user.id);
    const pending = rows.filter((r) => r.status === 'pending').length;
    const content = `
<div class="panel-head"><h1>🧾 رزروهای دریافتی</h1></div>
${statCards([
      [U.fmtNum(rows.length), 'کل رزروها'],
      [U.fmtNum(pending), 'در انتظار اقدام'],
      [U.money(rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.total_price, 0)), 'فروش تاییدشده'],
    ])}
${bookingsTable(rows, { actions: (b) => b.status === 'pending'
      ? `<form method="post" action="/panel/booking/${b.id}/confirm" style="display:inline">${csrfInput(ctx)}<button class="btn small">تایید</button></form>
         <form method="post" action="/panel/booking/${b.id}/cancel" style="display:inline">${csrfInput(ctx)}<button class="btn small danger">لغو</button></form>`
      : '' })}`;
    renderPanel(ctx, cfg, { title: 'رزروهای دریافتی', active: '/panel/supplier/bookings', content });
  });

  /* ─── مالی ─── */
  router.get('/panel/supplier/finance', (ctx) => {
    requireSupplier(ctx);
    const entries = db.prepare(`SELECT * FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 60`).all(ctx.user.id);
    const balance = D.userBalance(db, ctx.user.id);
    const KIND_TITLE = {
      sale: 'فروش', commission: 'کمیسیون', purchase: 'خرید', payout: 'تسویه',
      deposit: 'شارژ', refund: 'برگشت', fed_sale: 'فروش فدرال', fed_purchase: 'خرید فدرال', adjustment: 'تعدیل',
    };
    const content = `
<div class="panel-head"><h1>💰 مالی و تسویه</h1></div>
${statCards([
      [balance >= 0 ? U.money(balance) : `<span style="color:var(--danger)">${U.money(balance)}</span>`, balance >= 0 ? 'طلب از شرکت' : 'بدهی به شرکت'],
      [U.money(entries.filter((e) => e.kind === 'sale' || e.kind === 'fed_sale').reduce((s, e) => s + e.amount, 0)), 'جمع فروش'],
      [U.fmtNum(entries.filter((e) => e.kind === 'payout').length), 'تسویه‌های انجام‌شده'],
    ])}
<div class="card"><h2>آخرین تراکنش‌ها</h2>
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
    renderPanel(ctx, cfg, { title: 'مالی', active: '/panel/supplier/finance', content });
  });
}

module.exports = { registerSupplierRoutes };
