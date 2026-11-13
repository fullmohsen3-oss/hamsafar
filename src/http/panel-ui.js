'use strict';
/** اجزای مشترک پنل‌ها — چیدمان، ناوبری، جدول‌ها */

const U = require('../util');
const { html, page, issueCsrf } = require('./core');
const { ROLES } = require('../auth');

const NAV = {
  supplier: [
    ['', [
      ['/panel/supplier/inventory', '🧳 خدمات و موجودی من'],
      ['/panel/supplier/offers', '🏷️ عرضه‌ها (آفرها)'],
      ['/panel/supplier/transfers', '🔄 انتقال مالکیت'],
    ]],
    ['فروش', [
      ['/panel/supplier/bookings', '🧾 رزروهای دریافتی'],
      ['/panel/supplier/finance', '💰 مالی و تسویه'],
    ]],
  ],
  agent: [
    ['', [
      ['/panel/agent/market', '🛒 بازار خدمات'],
      ['/panel/agent/fed-market', '🌐 بازار فدراسیون (شرکت‌های همکار)'],
      ['/panel/agent/packages', '🎒 تورهای قابل فروش'],
    ]],
    ['فروش و مالی', [
      ['/panel/agent/bookings', '🧾 رزروهای من'],
      ['/panel/agent/finance', '💰 کمیسیون‌ها و تسویه'],
    ]],
  ],
  packager: [
    ['', [
      ['/panel/packager/packages', '🎒 پکیج‌های من'],
      ['/panel/packager/market', '🛒 بازار خدمات'],
      ['/panel/packager/fed-market', '🌐 بازار فدراسیون'],
    ]],
    ['فروش و مالی', [
      ['/panel/packager/bookings', '🧾 رزروهای دریافتی'],
      ['/panel/packager/finance', '💰 مالی و تسویه'],
    ]],
  ],
  admin: [
    ['', [
      ['/panel/admin', '📊 داشبورد'],
      ['/panel/admin/users', '👥 کاربران و نقش‌ها'],
      ['/panel/admin/bookings', '🧾 همه رزروها'],
      ['/panel/admin/finance', '💰 مالی'],
      ['/panel/admin/federation', '🌐 فدراسیون (همکاران)'],
      ['/panel/admin/messages', '✉️ پیام‌ها و درخواست‌ها'],
      ['/panel/admin/reports', '📈 گزارش‌ها'],
      ['/panel/admin/audit', '📜 لاگ ممیزی'],
      ['/panel/admin/settings', '⚙️ تنظیمات'],
    ]],
  ],
  employee: [
    ['', [
      ['/panel', '📊 داشبورد'],
      ['/panel/bookings', '🧾 رزروها'],
      ['/panel/customers', '👥 مشتریان'],
      ['/panel/messages', '✉️ پیام‌ها'],
    ]],
  ],
  customer: [
    ['', [
      ['/panel', '🧾 سفارش‌های من'],
      ['/panel/profile', '👤 مشخصات'],
    ]],
  ],
};

function panelLayout(cfg, user, activePath, contentHtml, { title } = {}) {
  const nav = NAV[user.role] || [];
  const navHtml = nav.map(([group, items]) => `
    ${group ? `<div class="group-title">${U.esc(group)}</div>` : ''}
    ${items.filter(Boolean).map(([href, label]) => `<a href="${href}" class="${activePath === href ? 'active' : ''}">${label}</a>`).join('')}
  `).join('');
  const roleTitle = ROLES[user.role] ? ROLES[user.role].title : user.role;
  return `
<div class="panel-layout">
  <aside class="panel-side">
    <div style="padding:.4rem .8rem 1rem">
      <div style="font-weight:700">${U.esc(user.full_name)}</div>
      <div class="small muted">${U.esc(roleTitle)}${user.company_title ? ' — ' + U.esc(user.company_title) : ''}</div>
    </div>
    ${navHtml}
    <div class="group-title">حساب</div>
    <a href="/">🏠 سایت عمومی</a>
    <a href="#" onclick="event.preventDefault();document.getElementById('logoutForm').submit()">🚪 خروج</a>
    <form id="logoutForm" method="post" action="/logout" style="display:none">
      <input type="hidden" name="_csrf" value="__CSRF__"><input type="hidden" name="_json" value="1">
    </form>
  </aside>
  <main class="panel-main">${contentHtml}</main>
</div>`;
}

function renderPanel(ctx, cfg, { title, active, content, metaDesc }) {
  const csrf = issueCsrf(ctx);
  const layout = panelLayout(cfg, ctx.user, active, content, { title });
  const finalHtml = layout.replace(/__CSRF__/g, csrf);
  html(ctx, page(`${title} | پنل ${cfg.companyName}`, metaDesc || 'پنل مدیریت هم‌سفر', `
<header class="site-header">
  <div class="inner">
    <a class="brand" href="/panel"><img class="logo" src="/assets/logo.svg" alt="">پنل هم‌سفر</a>
    <div class="header-actions">
      <span class="small" style="color:#d9efe7">${U.esc(cfg.companyName)}</span>
    </div>
  </div>
</header>
${finalHtml}`, { noindex: true }));
}

/* ─── اجزای UI ─── */

function statCards(items) {
  return `<div class="stat-cards">${items.map(([num, lbl]) => `
    <div class="stat-card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join('')}</div>`;
}

function bookingStatusBadge(b) {
  const map = {
    pending: ['orange', 'در انتظار پرداخت'], confirmed: ['green', 'تایید شده'],
    cancelled: ['red', 'لغو شده'], expired: ['red', 'منقضی'], used: ['gray', 'مصرف شده'],
  };
  const [cls, txt] = map[b.status] || ['gray', b.status];
  const pay = b.pay_status === 'paid' ? ' <span class="badge green">پرداخت‌شده</span>' : ' <span class="badge gray">پرداخت‌نشده</span>';
  return `<span class="badge ${cls}">${txt}</span>${pay}`;
}

function bookingsTable(rows, { showBuyer = true, actions = null }) {
  if (!rows.length) return '<div class="empty">رزروی یافت نشد.</div>';
  return `<div class="table-wrap"><table class="data">
    <tr><th>کد</th><th>خدمت</th>${showBuyer ? '<th>خریدار</th>' : ''}<th>نفر</th><th>مبلغ</th><th>کمیسیون</th><th>منشأ</th><th>وضعیت</th><th>تاریخ</th>${actions ? '<th></th>' : ''}</tr>
    ${rows.map((b) => {
      const title = b.kind === 'package' ? (b.pkg_title || 'تور') : (b.offer_title || 'خدمت');
      return `<tr>
      <td><a href="/panel/booking/${b.id}"><strong>${U.esc(b.ref_code)}</strong></a></td>
      <td>${U.esc(String(title).slice(0, 40))}</td>
      ${showBuyer ? `<td>${U.esc(b.buyer_name)}<br><span class="small muted">${U.esc(b.buyer_mobile)}</span></td>` : ''}
      <td>${U.fmtNum(b.traveler_count)}</td>
      <td>${U.money(b.total_price)}</td>
      <td>${b.commission ? U.money(b.commission) : '—'}</td>
      <td>${b.source === 'web' ? 'سایت' : b.source === 'panel' ? 'پنل' : b.source === 'federation' ? '🌐 فدراسیون' : b.source}</td>
      <td>${bookingStatusBadge(b)}</td>
      <td class="small muted">${U.faDateShort(b.created_at)}</td>
      ${actions ? `<td>${actions(b)}</td>` : ''}
    </tr>`;
    }).join('')}
  </table></div>`;
}

function csrfInput(ctx) {
  return `<input type="hidden" name="_csrf" value="${ctx.csrfToken || issueCsrf(ctx)}">`;
}

module.exports = { panelLayout, renderPanel, statCards, bookingsTable, bookingStatusBadge, csrfInput };
