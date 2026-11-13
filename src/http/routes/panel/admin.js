'use strict';
/** پنل ادمین و کارمند — کاربران، رزروها، مالی، فدراسیون، گزارش، ممیزی، تنظیمات */

const U = require('../../../util');
const D = require('../../../domain');
const { html, json, redirect, HttpError, issueCsrf } = require('../../core');
const { renderPanel, statCards, bookingsTable, csrfInput, bookingStatusBadge } = require('../../panel-ui');
const { ROLES } = require('../../../auth');
const F = require('../../federation');

function requireStaff(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ورود لازم است.');
  if (!['admin', 'employee'].includes(ctx.user.role)) throw new HttpError(403, 'دسترسی ندارید.');
}
function requireAdmin(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ورود لازم است.');
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'فقط مدیر سیستم.');
}

function registerAdminRoutes(router, { db, cfg }) {

  /* ─── داشبورد ─── */
  router.get('/panel/admin', (ctx) => {
    requireStaff(ctx);
    const today = U.todayLocal();
    const stats = {
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      suppliers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role='supplier'`).get().c,
      activeOffers: db.prepare(`SELECT COUNT(*) c FROM inventory_offers WHERE status='open'`).get().c,
      packages: db.prepare(`SELECT COUNT(*) c FROM packages WHERE status='published'`).get().c,
      bookings: db.prepare('SELECT COUNT(*) c FROM bookings').get().c,
      pending: db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status='pending'`).get().c,
      fedPeers: db.prepare(`SELECT COUNT(*) c FROM fed_peers WHERE status='active'`).get().c,
      revenue: db.prepare(`SELECT COALESCE(SUM(total_price),0) s FROM bookings WHERE status IN ('confirmed','used')`).get().s,
    };
    const recent = db.prepare(`SELECT b.*, i.title AS offer_title, p.title AS pkg_title
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      ORDER BY b.created_at DESC LIMIT 8`).all();
    const content = `
<div class="panel-head"><h1>📊 داشبورد مدیریت</h1><span class="muted small">${U.faDate(new Date())}</span></div>
${statCards([
      [U.fmtNum(stats.users), 'کاربران'],
      [U.fmtNum(stats.activeOffers), 'آفر باز'],
      [U.fmtNum(stats.bookings), 'رزرو'],
      [U.money(stats.revenue), 'درآمد تاییدشده'],
    ])}
<div class="grid cols-2">
  <div class="card">
    <h2>آخرین رزروها</h2>
    ${bookingsTable(recent, { showBuyer: true })}
  </div>
  <div>
    <div class="card">
      <h2>وضعیت همکاری‌ها</h2>
      <div class="kv">
        <span class="k">تامین‌کنندگان</span><span>${U.fmtNum(stats.suppliers)}</span>
        <span class="k">تورهای منتشرشده</span><span>${U.fmtNum(stats.packages)}</span>
        <span class="k">همکاران فدرال فعال</span><span>${U.fmtNum(stats.fedPeers)}</span>
        <span class="k">رزرو در انتظار</span><span>${stats.pending ? `<span class="badge orange">${U.fmtNum(stats.pending)}</span>` : '۰'}</span>
      </div>
      <p style="margin-top:.8rem"><a class="btn small secondary" href="/panel/admin/bookings">همه رزروها</a>
      <a class="btn small secondary" href="/panel/admin/users">کاربران</a></p>
    </div>
    <div class="card">
      <h2>پیام‌های اخیر</h2>
      ${(() => {
        const msgs = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 4').all();
        return msgs.length ? msgs.map((m) => `<div style="border-bottom:1px solid var(--line);padding:.5rem 0">
          <strong>${U.esc(m.name)}</strong> ${m.subject ? '<span class="badge gray">' + U.esc(m.subject.slice(0, 30)) + '</span>' : ''}
          <div class="small muted">${U.esc((m.body || '').slice(0, 80))}…</div></div>`).join('')
          + '<a class="btn small secondary" href="/panel/admin/messages">همه پیام‌ها</a>'
          : '<div class="empty">پیامی نیست.</div>';
      })()}
    </div>
  </div>
</div>`;
    renderPanel(ctx, cfg, { title: 'داشبورد', active: '/panel/admin', content });
  });

  /* ─── کاربران ─── */
  router.get('/panel/admin/users', (ctx) => {
    requireStaff(ctx);
    const role = U.cleanText(ctx.query.role || '', 20);
    const q = U.cleanText(ctx.query.q || '', 60);
    let where = '1=1'; const params = [];
    if (role) { where += ' AND role=?'; params.push(role); }
    if (q) { where += ' AND (full_name LIKE ? OR email LIKE ? OR mobile LIKE ? OR company_title LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const users = db.prepare(`SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT 100`).all(...params);
    const content = `
<div class="panel-head"><h1>👥 کاربران و نقش‌ها</h1>
  <a class="btn" href="/panel/admin/users/new">+ کاربر پنل جدید</a></div>
<form method="get" action="/panel/admin/users" class="card" style="display:flex;gap:.6rem;flex-wrap:wrap">
  <input name="q" value="${U.esc(q)}" placeholder="جستجو نام/ایمیل/موبایل..." style="flex:1;min-width:160px">
  <select name="role">
    <option value="">همه نقش‌ها</option>
    ${Object.entries(ROLES).filter(([k]) => k !== 'customer').map(([k, v]) => `<option value="${k}" ${role === k ? 'selected' : ''}>${v.title}</option>`).join('')}
    <option value="customer" ${role === 'customer' ? 'selected' : ''}>مشتری</option>
  </select>
  <button class="btn">فیلتر</button>
</form>
<div class="table-wrap"><table class="data">
  <tr><th>نام</th><th>نقش</th><th>تماس</th><th>کسب‌وکار</th><th>وضعیت</th><th>مانده حساب</th><th></th></tr>
  ${users.map((u) => `<tr>
    <td><strong>${U.esc(u.full_name)}</strong></td>
    <td><span class="badge ${u.role === 'admin' ? 'red' : u.role === 'employee' ? 'blue' : 'gray'}">${ROLES[u.role] ? ROLES[u.role].title : u.role}</span></td>
    <td class="small">${U.esc(u.email || '')}<br>${U.esc(u.mobile || '')}</td>
    <td class="small">${U.esc(u.company_title || '—')}</td>
    <td>${u.status === 'active' ? '<span class="badge green">فعال</span>' : '<span class="badge red">غیرفعال</span>'}</td>
    <td>${(() => { const b = D.userBalance(db, u.id); return b === 0 ? '—' : `<span style="color:${b > 0 ? 'var(--ok)' : 'var(--danger)'}">${U.money(b)}</span>`; })()}</td>
    <td class="small">
      ${u.role !== 'customer' ? `<a class="btn small secondary" href="/panel/admin/users/${u.id}">مدیریت</a>` : ''}
      ${u.status === 'active' && !u.is_owner
        ? `<form method="post" action="/panel/admin/users/${u.id}/suspend" style="display:inline">${csrfInput(ctx)}<button class="btn small secondary">غیرفعال</button></form>` : ''}
      ${u.status === 'suspended'
        ? `<form method="post" action="/panel/admin/users/${u.id}/activate" style="display:inline">${csrfInput(ctx)}<button class="btn small">فعال‌سازی</button></form>` : ''}
    </td>
  </tr>`).join('')}
</table></div>`;
    renderPanel(ctx, cfg, { title: 'کاربران', active: '/panel/admin/users', content });
  });

  /* کاربر جدید (پنل‌ها) */
  router.get('/panel/admin/users/new', (ctx) => {
    requireAdmin(ctx);
    const content = `
<div class="panel-head"><h1>➕ کاربر پنل جدید</h1></div>
<form class="card" method="post" action="/panel/admin/users/new">
  ${csrfInput(ctx)}
  <div class="alert info">برای همکاران (تامین‌کننده/پکیج‌ساز/واسطه) و کارمندان اینجا حساب بسازید؛ رمز عبور به آن‌ها بدهید یا با دکمه «بازنشانی» رمز جدید بسازید.</div>
  <div class="form-grid">
    <div class="field"><label>نام و نام خانوادگی *</label><input required name="full_name" maxlength="120"></div>
    <div class="field"><label>نقش *</label><select required name="role">
      ${Object.entries(ROLES).filter(([k]) => !['admin', 'customer'].includes(k)).map(([k, v]) => `<option value="${k}">${v.title}</option>`).join('')}
      <option value="employee">کارمند</option>
      <option value="admin">مدیر سیستم</option>
    </select></div>
    <div class="field"><label>ایمیل (برای ورود) *</label><input required name="email" type="email"></div>
    <div class="field"><label>موبایل</label><input name="mobile" inputmode="tel"></div>
    <div class="field"><label>عنوان کسب‌وکار</label><input name="company_title" maxlength="120" placeholder="مثلاً: چارترکاری الماس سفر"></div>
    <div class="field"><label>رمز عبور اولیه *</label><input required name="password" type="password" minlength="8"></div>
  </div>
  <button class="btn">ساخت حساب</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'کاربر جدید', active: '/panel/admin/users', content });
  });

  router.post('/panel/admin/users/new', (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const name = U.isName(b.full_name);
    const email = U.normalizeEmail(b.email);
    if (!name || !email) throw new HttpError(400, 'نام و ایمیل معتبر لازم است.');
    if (!ROLES[b.role]) throw new HttpError(400, 'نقش نامعتبر است.');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'این ایمیل قبلاً ثبت شده است.');
    if (!b.password || String(b.password).length < 8) throw new HttpError(400, 'رمز عبور حداقل ۸ نویسه باشد.');
    const id = U.randomId();
    const t = U.isoNow();
    db.prepare(`INSERT INTO users (id,role,status,full_name,email,mobile,password_hash,company_title,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, b.role, 'active', name, email, U.normalizeMobile(b.mobile) || null,
        U.hashPassword(b.password), U.cleanText(b.company_title, 120) || null, t, t);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.create', entity: 'user', entityId: id, detail: { role: b.role } });
    redirect(ctx, `/panel/admin/users/${id}?created=1`);
  });

  /* جزئیات کاربر: پروفایل + رمز + تسویه */
  router.get('/panel/admin/users/:id', (ctx) => {
    requireStaff(ctx);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, 'کاربر یافت نشد.');
    const bookingsCount = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE seller_user_id=? OR supplier_user_id=?`).get(u.id, u.id).c;
    const balance = D.userBalance(db, u.id);
    const content = `
<div class="panel-head"><h1>👤 ${U.esc(u.full_name)}</h1>
  <span class="badge gray">${ROLES[u.role] ? ROLES[u.role].title : u.role}</span></div>
${ctx.query.created === '1' ? '<div class="alert ok">حساب ساخته شد؛ رمز عبور را به کاربر اعلام کنید.</div>' : ''}
${ctx.query.reset === '1' ? `<div class="alert ok">رمز جدید: <strong>${U.esc(ctx.query.pwd || '')}</strong> — همین حالا به کاربر بدهید.</div>` : ''}
<div class="grid cols-2">
  <div class="card">
    <h2>مشخصات</h2>
    <div class="kv">
      <span class="k">ایمیل</span><span>${U.esc(u.email || '—')}</span>
      <span class="k">موبایل</span><span>${U.esc(u.mobile || '—')}</span>
      <span class="k">کسب‌وکار</span><span>${U.esc(u.company_title || '—')}</span>
      <span class="k">تعداد رزرو</span><span>${U.fmtNum(bookingsCount)}</span>
      <span class="k">مانده حساب</span><span style="color:${balance >= 0 ? 'var(--ok)' : 'var(--danger)'}">${U.money(balance)}</span>
      <span class="k">عضویت</span><span>${U.faDate(u.created_at)}</span>
    </div>
    <form method="post" action="/panel/admin/users/${u.id}/reset-password" style="margin-top:1rem">
      ${csrfInput(ctx)}<button class="btn secondary">🔑 بازنشانی رمز عبور</button>
    </form>
  </div>
  <div class="card">
    <h2>ثبت تراکنش دستی / تسویه</h2>
    <p class="small muted">مانده مثبت یعنی شرکت به این کاربر بدهکار است (طلبکار). با «پرداخت» مانده تسویه می‌شود.</p>
    <form method="post" action="/panel/admin/users/${u.id}/ledger">
      ${csrfInput(ctx)}
      <div class="form-grid">
        <div class="field"><label>نوع *</label><select name="kind">
          <option value="payout">پرداخت به کاربر (تسویه)</option>
          <option value="deposit">دریافت از کاربر (شارژ)</option>
          <option value="adjustment">تعدیل (افزایش طلب)</option>
        </select></div>
        <div class="field"><label>مبلغ (ریال) *</label><input required type="number" name="amount" min="1000" step="10000"></div>
      </div>
      <div class="field"><label>شرح</label><input name="note" maxlength="200" placeholder="مثلاً: تسویه کمیسیون آبان"></div>
      <button class="btn">ثبت</button>
    </form>
  </div>
</div>`;
    renderPanel(ctx, cfg, { title: u.full_name, active: '/panel/admin/users', content });
  });

  router.post('/panel/admin/users/:id/reset-password', (ctx) => {
    requireAdmin(ctx);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, 'کاربر یافت نشد.');
    const pwd = U.randomId(10);
    db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(U.hashPassword(pwd), U.isoNow(), u.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.reset_password', entity: 'user', entityId: u.id });
    redirect(ctx, `/panel/admin/users/${u.id}?reset=1&pwd=${pwd}`);
  });

  router.post('/panel/admin/users/:id/ledger', (ctx) => {
    requireAdmin(ctx);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, 'کاربر یافت نشد.');
    const b = ctx.body;
    const amount = U.toAmount(b.amount);
    if (!amount || amount < 1000) throw new HttpError(400, 'مبلغ معتبر وارد کنید.');
    // payout = بدهکاری شرکت → کاهش طلب کاربر (منفی)؛ deposit = افزایش بدهی کاربر (منفی هم؟ نه)
    const signed = b.kind === 'payout' ? -amount : (b.kind === 'deposit' ? -amount : amount);
    D.postLedger(db, { userId: u.id, kind: b.kind, amount: signed, note: U.cleanText(b.note, 200) || 'ثبت دستی توسط مدیر' });
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'ledger.manual', entity: 'user', entityId: u.id, detail: { kind: b.kind, amount } });
    redirect(ctx, `/panel/admin/users/${u.id}`);
  });

  router.post('/panel/admin/users/:id/suspend', (ctx) => {
    requireAdmin(ctx);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, 'کاربر یافت نشد.');
    if (u.is_owner) throw new HttpError(400, 'مدیر مالک را نمی‌توان غیرفعال کرد.');
    db.prepare(`UPDATE users SET status='suspended', updated_at=? WHERE id=?`).run(U.isoNow(), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.suspend', entity: 'user', entityId: u.id });
    redirect(ctx, '/panel/admin/users');
  });

  router.post('/panel/admin/users/:id/activate', (ctx) => {
    requireAdmin(ctx);
    db.prepare(`UPDATE users SET status='active', updated_at=? WHERE id=?`).run(U.isoNow(), ctx.params.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.activate', entity: 'user', entityId: ctx.params.id });
    redirect(ctx, '/panel/admin/users');
  });

  /* ─── همه رزروها ─── */
  router.get('/panel/admin/bookings', (ctx) => {
    requireStaff(ctx);
    const status = U.cleanText(ctx.query.status || '', 20);
    let where = '1=1'; const params = [];
    if (status) { where = 'b.status=?'; params.push(status); }
    const rows = db.prepare(`SELECT b.*, i.title AS offer_title, p.title AS pkg_title
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT 200`).all(...params);
    const content = `
<div class="panel-head"><h1>🧾 همه رزروها</h1></div>
<div class="tabs">
  ${[['', 'همه'], ['pending', 'در انتظار'], ['confirmed', 'تاییدشده'], ['cancelled', 'لغو‌شده']].map(([s, t]) =>
        `<a href="/panel/admin/bookings${s ? '?status=' + s : ''}" class="${status === s ? 'active' : ''}">${t}</a>`).join('')}
</div>
${bookingsTable(rows, { actions: (b) => (b.status === 'pending'
      ? `<form method="post" action="/panel/booking/${b.id}/confirm" style="display:inline">${csrfInput(ctx)}<button class="btn small">تایید</button></form>`
      : '') + (b.status !== 'cancelled' && b.status !== 'used'
        ? ` <form method="post" action="/panel/booking/${b.id}/cancel" style="display:inline">${csrfInput(ctx)}<button class="btn small danger">لغو</button></form>` : '') })}`;
    renderPanel(ctx, cfg, { title: 'همه رزروها', active: '/panel/admin/bookings', content });
  });

  /* ─── مالی ─── */
  router.get('/panel/admin/finance', (ctx) => {
    requireAdmin(ctx);
    const balances = db.prepare(`SELECT u.id, u.full_name, u.role, u.company_title,
      (SELECT balance_after FROM ledger_entries WHERE user_id=u.id ORDER BY id DESC LIMIT 1) AS balance
      FROM users u WHERE u.role IN ('supplier','packager','agent') ORDER BY balance DESC LIMIT 50`).all();
    const totals = db.prepare(`SELECT kind, SUM(amount) s, COUNT(*) c FROM ledger_entries GROUP BY kind`).all();
    const KIND_TITLE = { sale: 'فروش', commission: 'کمیسیون', purchase: 'خرید', payout: 'تسویه', deposit: 'شارژ', refund: 'برگشت', fed_sale: 'فروش فدرال', fed_purchase: 'خرید فدرال', adjustment: 'تعدیل' };
    const content = `
<div class="panel-head"><h1>💰 مالی</h1></div>
${statCards([
      [U.money(db.prepare(`SELECT COALESCE(SUM(total_price),0) s FROM bookings WHERE status IN ('confirmed','used')`).get().s), 'فروش تاییدشده'],
      [U.money(totals.filter((t) => t.kind === 'commission').reduce((s, t) => s + t.s, 0)), 'کمیسیون‌های پرداختی'],
      [U.money(totals.filter((t) => t.kind === 'payout').reduce((s, t) => s + t.s, 0)), 'تسویه‌های خروجی'],
    ])}
<div class="card"><h2>تراز همکاران</h2>
<div class="table-wrap"><table class="data">
  <tr><th>همکار</th><th>نقش</th><th>مانده (طلب+/بدهی−)</th></tr>
  ${balances.map((b) => `<tr>
    <td>${U.esc(b.full_name)} ${b.company_title ? '<span class="small muted">' + U.esc(b.company_title) + '</span>' : ''}</td>
    <td>${ROLES[b.role] ? ROLES[b.role].title : b.role}</td>
    <td style="color:${(b.balance || 0) >= 0 ? 'var(--ok)' : 'var(--danger)'}">${U.money(b.balance || 0)}</td>
  </tr>`).join('')}
</table></div></div>
<div class="card"><h2>انواع تراکنش</h2>
<div class="table-wrap"><table class="data">
  <tr><th>نوع</th><th>تعداد</th><th>جمع</th></tr>
  ${totals.map((t) => `<tr><td>${KIND_TITLE[t.kind] || t.kind}</td><td>${U.fmtNum(t.c)}</td><td>${U.money(t.s)}</td></tr>`).join('')}
</table></div></div>`;
    renderPanel(ctx, cfg, { title: 'مالی', active: '/panel/admin/finance', content });
  });

  /* ─── فدراسیون ─── */
  router.get('/panel/admin/federation', async (ctx) => {
    requireAdmin(ctx);
    const peers = db.prepare('SELECT * FROM fed_peers ORDER BY created_at DESC').all();
    let syncMsg = '';
    if (ctx.query.sync) {
      const p = db.prepare('SELECT * FROM fed_peers WHERE id=?').get(ctx.query.sync);
      if (p) {
        try {
          const r = await F.refreshPeerCatalog(db, cfg, p.id);
          syncMsg = `کاتالوگ ${U.esc(p.name)} همگام شد (${U.fmtNum(r.fetched)} آیتم).`;
        } catch (e) {
          syncMsg = `خطا در همگام‌سازی با ${U.esc(p.name)}: ${U.esc(e.message)}`;
        }
      }
    }
    const content = `
<div class="panel-head"><h1>🌐 فدراسیون — شرکت‌های همکار</h1>
  <a class="btn" href="/panel/admin/federation/new">+ همکار جدید</a></div>
${syncMsg ? `<div class="alert ${syncMsg.includes('خطا') ? 'err' : 'ok'}">${syncMsg}</div>` : ''}
<div class="alert info">همتا شرکتی است که هم‌سفر را مستقل اجرا می‌کند. کلیدها را از دو مسیر رد و بدل کنید: «کلید ما نزد آن‌ها» را در سرور خودشان در پنل فدراسیون‌شان وارد می‌کنند و «کلید آن‌ها نزد ما» را که به شما داده‌اند اینجا ثبت می‌کنید.</div>
${peers.length ? `<div class="table-wrap"><table class="data">
  <tr><th>شرکت</th><th>آدرس API</th><th>وضعیت</th><th>تراز (طلب ما +)</th><th>آخرین همگام‌سازی</th><th></th></tr>
  ${peers.map((p) => `<tr>
    <td><strong>${U.esc(p.name)}</strong><br><span class="small muted">${p.trust_level === 'verified' ? '✅ تاییدشده' : 'استاندارد'}</span></td>
    <td class="small">${U.esc(p.base_url)}</td>
    <td>${p.status === 'active' ? '<span class="badge green">فعال</span>' : p.status === 'paused' ? '<span class="badge orange">مکث</span>' : '<span class="badge red">لغو</span>'}</td>
    <td style="color:${p.our_balance >= 0 ? 'var(--ok)' : 'var(--danger)'}">${U.money(p.our_balance)}</td>
    <td class="small">${p.last_sync_at ? U.faDateShort(p.last_sync_at) : '—'}</td>
    <td class="small">
      <a class="btn small secondary" href="/panel/admin/federation?sync=${p.id}">🔄 همگام‌سازی</a>
      <a class="btn small secondary" href="/panel/admin/federation/${p.id}">مدیریت</a>
    </td>
  </tr>`).join('')}
</table></div>` : '<div class="empty">هنوز همکاری اضافه نشده است.</div>'}`;
    renderPanel(ctx, cfg, { title: 'فدراسیون', active: '/panel/admin/federation', content });
  });

  router.get('/panel/admin/federation/new', (ctx) => {
    requireAdmin(ctx);
    const content = `
<div class="panel-head"><h1>➕ همکار فدرال جدید</h1></div>
<form class="card" method="post" action="/panel/admin/federation/new">
  ${csrfInput(ctx)}
  <div class="form-grid">
    <div class="field"><label>نام شرکت همکار *</label><input required name="name" maxlength="120"></div>
    <div class="field"><label>آدرس پایه API آن‌ها *</label><input required name="base_url" placeholder="https://travel2.example.com" dir="ltr"></div>
    <div class="field"><label>کلید API که به ما داده‌اند (برای تماس ما با آن‌ها) *</label><input required name="api_key" dir="ltr" maxlength="80"></div>
    <div class="field"><label>کلید ما برای آن‌ها (که در سرور خودشان ثبت می‌کنند) *</label><input required name="our_key_for_them" value="${U.randomId(32)}" dir="ltr" maxlength="80"></div>
  </div>
  <div class="field"><label>یادداشت</label><input name="note" maxlength="300"></div>
  <button class="btn">افزودن همکار</button>
</form>`;
    renderPanel(ctx, cfg, { title: 'همکار جدید', active: '/panel/admin/federation', content });
  });

  router.post('/panel/admin/federation/new', (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const name = U.isName(b.name);
    if (!name) throw new HttpError(400, 'نام شرکت را وارد کنید.');
    let baseUrl = U.cleanText(b.base_url, 200);
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'آدرس API باید با http:// یا https:// شروع شود.');
    baseUrl = baseUrl.replace(/\/+$/, '');
    const apiKey = U.cleanText(b.api_key, 80);
    const ourKey = U.cleanText(b.our_key_for_them, 80) || U.randomId(32);
    if (!apiKey || apiKey.length < 16) throw new HttpError(400, 'کلید API همکار معتبر نیست (حداقل ۱۶ نویسه).');
    const id = U.randomId();
    const t = U.isoNow();
    db.prepare(`INSERT INTO fed_peers (id,name,base_url,api_key,our_key_for_them,status,trust_level,note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, baseUrl, apiKey, ourKey, 'active', 'standard', U.cleanText(b.note, 300) || null, t, t);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'fed.peer.add', entity: 'fed_peer', entityId: id, detail: { name, baseUrl } });
    redirect(ctx, '/panel/admin/federation');
  });

  router.get('/panel/admin/federation/:id', (ctx) => {
    requireAdmin(ctx);
    const p = db.prepare('SELECT * FROM fed_peers WHERE id=?').get(ctx.params.id);
    if (!p) throw new HttpError(404, 'همتا یافت نشد.');
    const inbox = db.prepare(`SELECT * FROM fed_inbox WHERE peer_id=? ORDER BY received_at DESC LIMIT 30`).all(p.id);
    const remoteCount = db.prepare('SELECT COUNT(*) c FROM fed_remote_items WHERE peer_id=?').get(p.id).c;
    const content = `
<div class="panel-head"><h1>🌐 ${U.esc(p.name)}</h1></div>
<div class="grid cols-2">
  <div class="card">
    <h2>مشخصات اتصال</h2>
    <div class="kv">
      <span class="k">آدرس API</span><span dir="ltr">${U.esc(p.base_url)}</span>
      <span class="k">کلید ما برای آن‌ها</span><span dir="ltr"><code>${U.esc(p.our_key_for_them)}</code></span>
      <span class="k">تراز ما</span><span style="color:${p.our_balance >= 0 ? 'var(--ok)' : 'var(--danger)'}">${U.money(p.our_balance)}</span>
      <span class="k">آیتم کاتالوگ</span><span>${U.fmtNum(remoteCount)}</span>
    </div>
    <form method="post" action="/panel/admin/federation/${p.id}/status" style="margin-top:1rem;display:flex;gap:.6rem">
      ${csrfInput(ctx)}
      <select name="status">
        <option value="active" ${p.status === 'active' ? 'selected' : ''}>فعال</option>
        <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>مکث</option>
        <option value="revoked" ${p.status === 'revoked' ? 'selected' : ''}>لغو کلید</option>
      </select>
      <button class="btn">اعمال</button>
    </form>
    ${p.last_error ? `<div class="alert err small">آخرین خطا: ${U.esc(p.last_error)}</div>` : ''}
  </div>
  <div class="card">
    <h2>آخرین پیام‌های دریافتی از این همتا</h2>
    ${inbox.length ? inbox.map((m) => `<details class="box">
      <summary>${U.esc(m.action)} — <span class="small muted">${U.faDateTime(m.received_at)}</span> <span class="badge ${m.status === 'processed' ? 'green' : m.status === 'rejected' ? 'red' : 'gray'}">${m.status}</span></summary>
      <pre class="small" style="white-space:pre-wrap">${U.esc(JSON.stringify(JSON.parse(m.payload || '{}'), null, 1).slice(0, 800))}</pre>
    </details>`).join('') : '<div class="empty">پیامی نبوده است.</div>'}
  </div>
</div>`;
    renderPanel(ctx, cfg, { title: p.name, active: '/panel/admin/federation', content });
  });

  router.post('/panel/admin/federation/:id/status', (ctx) => {
    requireAdmin(ctx);
    const p = db.prepare('SELECT * FROM fed_peers WHERE id=?').get(ctx.params.id);
    if (!p) throw new HttpError(404, 'همتا یافت نشد.');
    const status = ['active', 'paused', 'revoked'].includes(ctx.body.status) ? ctx.body.status : 'active';
    db.prepare('UPDATE fed_peers SET status=?, updated_at=? WHERE id=?').run(status, U.isoNow(), p.id);
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'fed.peer.status', entity: 'fed_peer', entityId: p.id, detail: { status } });
    redirect(ctx, `/panel/admin/federation/${p.id}`);
  });

  /* ─── پیام‌ها ─── */
  router.get('/panel/admin/messages', (ctx) => {
    requireStaff(ctx);
    const msgs = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100').all();
    const content = `
<div class="panel-head"><h1>✉️ پیام‌ها و درخواست‌های پنل</h1></div>
${msgs.length ? msgs.map((m) => `
<details class="box" ${m.handled ? '' : 'style="border-color:var(--accent)"'}>
  <summary>
    <strong>${U.esc(m.name)}</strong>
    ${m.subject ? `<span class="badge blue">${U.esc(m.subject)}</span>` : ''}
    ${m.handled ? '<span class="badge gray">پاسخ داده شد</span>' : '<span class="badge orange">جدید</span>'}
    <span class="small muted">${U.faDateTime(m.created_at)}</span>
  </summary>
  <div class="small muted">${U.esc(m.mobile || '')} ${m.email ? '· ' + U.esc(m.email) : ''}</div>
  <p style="white-space:pre-wrap">${U.esc(m.body)}</p>
  ${!m.handled ? `<form method="post" action="/panel/admin/messages/${m.id}/handled">${csrfInput(ctx)}<button class="btn small">علامت‌گذاری به‌عنوان پاسخ‌داده</button></form>` : ''}
</details>`).join('') : '<div class="empty">پیامی نیست.</div>'}`;
    renderPanel(ctx, cfg, { title: 'پیام‌ها', active: '/panel/admin/messages', content });
  });

  router.post('/panel/admin/messages/:id/handled', (ctx) => {
    requireStaff(ctx);
    db.prepare('UPDATE contact_messages SET handled=1 WHERE id=?').run(ctx.params.id);
    redirect(ctx, '/panel/admin/messages');
  });

  /* ─── گزارش‌ها ─── */
  router.get('/panel/admin/reports', (ctx) => {
    requireStaff(ctx);
    const byDay = db.prepare(`SELECT substr(created_at,1,10) d, COUNT(*) c, SUM(total_price) s FROM bookings
      WHERE created_at >= ? GROUP BY d ORDER BY d DESC LIMIT 14`).all(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
    const byType = db.prepare(`SELECT st.title, COUNT(b.id) c, COALESCE(SUM(b.total_price),0) s
      FROM bookings b JOIN inventory_offers o ON o.id=b.offer_id JOIN inventory_items i ON i.id=o.item_id
      JOIN service_types st ON st.id=i.type_id GROUP BY st.id`).all();
    const bySource = db.prepare(`SELECT source, COUNT(*) c, COALESCE(SUM(total_price),0) s FROM bookings GROUP BY source`).all();
    const SRC_TITLE = { web: 'سایت عمومی', panel: 'پنل', federation: 'فدراسیون', pos: 'حضوری' };
    const max = Math.max(1, ...byDay.map((r) => Number(r.s)));
    const content = `
<div class="panel-head"><h1>📈 گزارش‌ها</h1></div>
<div class="card"><h2>فروش ۱۴ روز اخیر</h2>
  ${byDay.length ? `<div class="table-wrap"><table class="data">
    <tr><th>روز</th><th>رزرو</th><th>مبلغ</th><th>سهم</th></tr>
    ${byDay.map((r) => `<tr>
      <td>${U.faDateShort(r.d)}</td><td>${U.fmtNum(r.c)}</td><td>${U.money(r.s)}</td>
      <td><div style="background:var(--primary-light);border-radius:6px;height:12px;width:${Math.round(Number(r.s) / max * 100)}%"></div></td>
    </tr>`).join('')}
  </table></div>` : '<div class="empty">داده‌ای نیست.</div>'}
</div>
<div class="grid cols-2">
  <div class="card"><h2>فروش بر اساس نوع خدمت</h2>
    ${byType.length ? `<table class="data">${byType.map((t) => `<tr><td>${U.esc(t.title)}</td><td>${U.fmtNum(t.c)}</td><td>${U.money(t.s)}</td></tr>`).join('')}</table>` : '<div class="empty">—</div>'}
  </div>
  <div class="card"><h2>فروش بر اساس کانال</h2>
    ${bySource.length ? `<table class="data">${bySource.map((t) => `<tr><td>${SRC_TITLE[t.source] || t.source}</td><td>${U.fmtNum(t.c)}</td><td>${U.money(t.s)}</td></tr>`).join('')}</table>` : '<div class="empty">—</div>'}
  </div>
</div>`;
    renderPanel(ctx, cfg, { title: 'گزارش‌ها', active: '/panel/admin/reports', content });
  });

  /* ─── لاگ ممیزی ─── */
  router.get('/panel/admin/audit', (ctx) => {
    requireAdmin(ctx);
    const q = U.cleanText(ctx.query.q || '', 60);
    let where = '1=1'; const params = [];
    if (q) { where = '(action LIKE ? OR entity LIKE ? OR entity_id LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = db.prepare(`SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
      WHERE ${where} ORDER BY a.id DESC LIMIT 150`).all(...params);
    const content = `
<div class="panel-head"><h1>📜 لاگ ممیزی</h1></div>
<form method="get" action="/panel/admin/audit" class="card" style="display:flex;gap:.6rem">
  <input name="q" value="${U.esc(q)}" placeholder="جستجو عملیات/موجودیت..." style="flex:1">
  <button class="btn">جستجو</button>
</form>
<div class="table-wrap"><table class="data">
  <tr><th>زمان</th><th>عامل</th><th>عملیات</th><th>موجودیت</th><th>جزئیات</th></tr>
  ${rows.map((r) => `<tr>
    <td class="small">${U.faDateTime(r.at)}</td>
    <td>${U.esc(r.full_name || r.actor_role || 'سیستم')}</td>
    <td><code>${U.esc(r.action)}</code></td>
    <td class="small">${U.esc(r.entity || '')} ${r.entity_id ? '#' + U.esc(String(r.entity_id).slice(0, 8)) : ''}</td>
    <td class="small muted">${U.esc((r.detail || '').slice(0, 100))}</td>
  </tr>`).join('')}
</table></div>`;
    renderPanel(ctx, cfg, { title: 'لاگ ممیزی', active: '/panel/admin/audit', content });
  });

  /* ─── تنظیمات ─── */
  router.get('/panel/admin/settings', (ctx) => {
    requireAdmin(ctx);
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const content = `
<div class="panel-head"><h1>⚙️ تنظیمات شرکت</h1></div>
<form class="card" method="post" action="/panel/admin/settings">
  ${csrfInput(ctx)}
  <div class="alert info">تنظیمات هویتی (نام، تلفن و...) در فایل <code dir="ltr">.env</code> سرور است و برای تغییر باید آن را ویرایش و سرویس را ری‌استارت کرد. اینجا تنظیمات عملیاتی ذخیره می‌شود.</div>
  <div class="form-grid">
    <div class="field"><label>درصد کمیسیون پیش‌فرض واسطه‌ها (٪)</label><input type="number" name="default_commission_pct" min="0" max="50" value="${U.esc(map.default_commission_pct || '8')}"></div>
    <div class="field"><label>مهلت پرداخت رزرو (دقیقه)</label><input type="number" name="payment_deadline_min" min="5" max="1440" value="${U.esc(map.payment_deadline_min || '60')}"></div>
    <div class="field"><label>تلفن پشتیبانی نمایش‌داده‌شده در واچر</label><input name="voucher_support_phone" value="${U.esc(map.voucher_support_phone || cfg.companyPhone || '')}"></div>
    <div class="field"><label>آستانه هشدار ظرفیت (٪)</label><input type="number" name="low_capacity_pct" min="0" max="100" value="${U.esc(map.low_capacity_pct || '20')}"></div>
  </div>
  <button class="btn">ذخیره تنظیمات</button>
</form>
<div class="card"><h2>اطلاعات فدراسیون این شرکت</h2>
  <div class="kv">
    <span class="k">آدرس API فدراسیون ما</span><span dir="ltr"><code>${U.esc(cfg.fedBaseUrl)}/fed/v1</code></span>
    <span class="k">نسخه API</span><span dir="ltr">1</span>
  </div>
  <p class="small muted">این آدرس را به شرکت‌های همکار بدهید تا در پنل فدراسیون خودشان ثبت کنند.</p>
</div>`;
    renderPanel(ctx, cfg, { title: 'تنظیمات', active: '/panel/admin/settings', content });
  });

  router.post('/panel/admin/settings', (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const allowed = ['default_commission_pct', 'payment_deadline_min', 'voucher_support_phone', 'low_capacity_pct'];
    for (const k of allowed) {
      if (b[k] !== undefined) {
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(k, U.cleanText(b[k], 60));
      }
    }
    D.audit(db, { actorId: ctx.user.id, actorRole: ctx.user.role, action: 'settings.update' });
    redirect(ctx, '/panel/admin/settings?ok=1');
  });
}

module.exports = { registerAdminRoutes };
