'use strict';
/** روت‌های سایت عمومی — سئو-محور: متا، canonical، JSON-LD، صفحات مقصد */

const U = require('../util');
const D = require('../domain');
const { html, json, page, HttpError, redirect } = require('./core');

/* ─── اجزای مشترک HTML ─── */

function header(cfg, { user, active = '' } = {}) {
  const links = [
    ['', '🏠 صفحه اصلی'],
    ['/tours', '🎒 تورها'],
    ['/services', '🧭 خدمات تک'],
    ['/destinations', '📍 مقصدها'],
    ['/contact', '✉️ تماس با ما'],
  ].map(([href, label]) => `<a href="${href || '/'}" class="${active === href ? 'active' : ''}">${label}</a>`).join('');
  return `
<header class="site-header">
  <div class="inner">
    <a class="brand" href="/"><img class="logo" src="/assets/logo.svg" alt="لوگو">${U.esc(cfg.companyName)}</a>
    <nav>${links}</nav>
    <div class="header-actions">
      ${user ? `<a class="btn small secondary" href="/panel">پنل من</a>`
          : `<a class="btn small secondary" href="/login">ورود</a>
             <a class="btn small" href="/register">ثبت‌نام</a>`}
    </div>
  </div>
</header>`;
}

function footer(cfg) {
  return `
<footer class="site-footer">
  <div class="inner">
    <div>
      <h3>${U.esc(cfg.companyName)}</h3>
      <p class="small">${U.esc(cfg.companyTagline || '')}</p>
      ${cfg.companyAddress ? `<p class="small">📍 ${U.esc(cfg.companyAddress)}</p>` : ''}
      ${cfg.companyPhone ? `<p class="small">☎️ ${U.esc(cfg.companyPhone)}</p>` : ''}
      ${cfg.companyEmail ? `<p class="small">✉️ ${U.esc(cfg.companyEmail)}</p>` : ''}
    </div>
    <div>
      <h3>دسترسی سریع</h3>
      <ul>
        <li><a href="/tours">تورهای گردشگری</a></li>
        <li><a href="/services">خدمات تک (بلیط و هتل)</a></li>
        <li><a href="/destinations">مقصدهای محبوب</a></li>
        <li><a href="/contact">تماس با ما</a></li>
      </ul>
    </div>
    <div>
      <h3>حساب کاربری</h3>
      <ul>
        <li><a href="/login">ورود به حساب</a></li>
        <li><a href="/register">ثبت‌نام</a></li>
        <li><a href="/panel">پیگیری سفارش</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">قدرت‌گرفته از سامانه هم‌سفر — © ${new Date().getFullYear()}</div>
</footer>`;
}

/* ─── کوئری‌های عمومی ─── */

function publicOffers(db, { q, typeKey, dest, limit = 30, offset = 0 } = {}) {
  const params = [];
  let where = `o.status='open' AND o.visible_to_public=1 AND i.status='active'
    AND (o.public_price IS NOT NULL OR o.unit_price > 0)
    AND (i.depart_at IS NULL OR i.depart_at >= ?)`;
  params.push(U.isoNow());
  if (q) {
    where += ` AND (i.title LIKE ? OR i.origin LIKE ? OR i.destination LIKE ? OR i.hotel_name LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (typeKey) { where += ` AND st.key=?`; params.push(typeKey); }
  if (dest) { where += ` AND i.destination=?`; params.push(dest); }
  const base = `FROM inventory_offers o
    JOIN inventory_items i ON i.id=o.item_id
    JOIN service_types st ON st.id=i.type_id
    WHERE ${where}`;
  const rows = db.prepare(`SELECT o.id, o.unit_price, o.public_price, o.qty, i.title, i.origin, i.destination,
      i.depart_at, i.arrive_at, i.nights, i.hotel_name, i.room_type, i.class_text, i.unit_label, i.type_id,
      st.key AS type_key, st.title AS type_title, st.emoji AS type_emoji,
      (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
    ${base} ORDER BY i.depart_at ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const cnt = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
  return { rows, total: cnt };
}

function offerCard(o, cfg) {
  const price = o.public_price != null ? o.public_price : o.unit_price;
  const avail = Math.max(0, o.qty - o.used);
  const route = o.origin && o.destination ? `${U.esc(o.origin)} ← ${U.esc(o.destination)}` : (o.hotel_name ? `🏨 ${U.esc(o.hotel_name)}` : '');
  const dateTxt = o.depart_at ? `🗓 ${U.faDate(o.depart_at)}` : (o.nights ? `${o.nights} شب` : '');
  return `
<article class="card offer-card">
  <div class="type">${o.type_emoji || '🎫'} ${U.esc(o.type_title)} ${o.class_text ? '— ' + U.esc(o.class_text) : ''}</div>
  <div class="title">${U.esc(o.title)}</div>
  ${route ? `<div class="route">${route}</div>` : ''}
  ${dateTxt ? `<div class="route">${dateTxt}${o.room_type ? ' — ' + U.esc(o.room_type) : ''}</div>` : ''}
  <div class="price-row">
    <div class="price">${U.money(price)} <span class="unit">/ ${U.esc(o.unit_label || 'نفر')}</span></div>
    ${avail > 0
      ? `<div><span class="seats-left">${avail} ${U.esc(o.unit_label || 'نفر')} باقی‌مانده</span><br>
         <a class="btn small" href="/book/offer/${o.id}">رزرو کنید</a></div>`
      : '<span class="badge red">تکمیل</span>'}
  </div>
</article>`;
}

/* ─── روت‌ها ─── */

function registerPublicRoutes(router, { db, cfg }) {

  /* صفحه اصلی */
  router.get('/', (ctx) => {
    issueCsrfAndRender(ctx);
    function issueCsrfAndRender(ctx2) {
      const csrf = require('./core').issueCsrf(ctx2);
      const { rows } = publicOffers(db, { limit: 6 });
      const packages = db.prepare(`SELECT p.*, d.price_per_person, d.start_date, d.capacity_total,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.package_departure_id=d.id AND b.status IN ('pending','confirmed')) AS used
        FROM packages p JOIN package_departures d ON d.package_id=p.id
        WHERE p.public_published=1 AND p.status='published' AND d.status='open' AND d.start_date >= ?
        ORDER BY d.start_date ASC LIMIT 6`).all(U.todayLocal());
      const dests = db.prepare(`SELECT * FROM seo_destinations ORDER BY id LIMIT 8`).all();
      const pkgCards = packages.map((p) => `
<article class="card offer-card">
  <div class="type">${U.esc(p.cover_emoji || '🎒')} تور ${p.nights ? p.nights + ' شب' : ''}</div>
  <div class="title">${U.esc(p.title)}</div>
  <div class="route">📍 ${U.esc(p.destination || '')} ${p.origin ? '— حرکت از ' + U.esc(p.origin) : ''}</div>
  <div class="route">🗓 ${U.faDate(p.start_date)}</div>
  <div class="price-row">
    <div class="price">${U.money(p.price_per_person)} <span class="unit">/ هر نفر</span></div>
    <a class="btn small" href="/tours/${U.esc(p.slug)}">مشاهده و رزرو</a>
  </div>
</article>`).join('');
      const body = `
${header(cfg, { user: ctx.user, active: '' })}
<section class="hero">
  <h1>سفر بعدی شما، مطمئن و آسان</h1>
  <p>${U.esc(cfg.companyTagline || 'بهترین تورها و بلیط‌ها با تضمین قیمت')} — رزرو آنی با کد پیگیری، واچر رسمی و پشتیبانی ${U.esc(cfg.companyName)}.</p>
  <form class="search-box" method="get" action="/services">
    <input type="search" name="q" placeholder="جستجو: مقصد، هتل، شهر..." aria-label="جستجو">
    <select name="type" aria-label="نوع خدمت">
      <option value="">همه خدمات</option>
      <option value="flight">✈️ پرواز</option>
      <option value="bus">🚌 اتوبوس</option>
      <option value="train">🚆 قطار</option>
      <option value="hotel">🏨 هتل</option>
    </select>
    <button class="btn" type="submit">جستجو</button>
  </form>
</section>
<main class="container">
  <section style="margin-top:2.5rem">
    <h2>🎒 تورهای پیشنهادی</h2>
    ${packages.length ? `<div class="grid cols-3">${pkgCards}</div>` : '<div class="empty">هنوز توری منتشر نشده است.</div>'}
  </section>
  <section style="margin-top:2.5rem">
    <h2>🎫 خدمات تک (بلیط، هتل و ...)</h2>
    ${rows.length ? `<div class="grid cols-3">${rows.map((o) => offerCard(o, cfg)).join('')}</div>` : '<div class="empty">فعلاً خدمتی برای فروش عمومی باز نشده است.</div>'}
  </section>
  <section style="margin-top:2.5rem">
    <h2>📍 مقصدهای محبوب</h2>
    <div class="grid cols-3">
      ${dests.map((d) => `<a class="card offer-card" href="/destinations/${U.esc(d.slug)}">
        <div class="title">${d.emoji || '📍'} ${U.esc(d.title)}</div>
        <div class="route">${U.esc((d.description || '').slice(0, 90))}${(d.description || '').length > 90 ? '…' : ''}</div>
      </a>`).join('')}
    </div>
  </section>
  <section class="card" style="margin-top:2.5rem">
    <h2>چرا ${U.esc(cfg.companyName)}؟</h2>
    <div class="grid cols-3">
      <div><strong>🔒 رزرو تضمینی</strong><p class="muted small">هر رزرو بلافاصله با کد پیگیری و واچر رسمی صادر می‌شود؛ موجودی هم‌زمان با پنل فروش به‌روز است.</p></div>
      <div><strong>⚡ پاسخ بلادرنگ</strong><p class="muted small">اتصال مستقیم به شبکه تامین‌کنندگان و همکاران ما؛ ظرفیت و قیمت بدون واسطه‌های اضافه.</p></div>
      <div><strong>🤝 پشتیبانی واقعی</strong><p class="muted small">تیم ما در تمام مراحل سفر همراه شماست؛ ${cfg.companyPhone ? 'تماس: ' + U.esc(cfg.companyPhone) : ''}</p></div>
    </div>
  </section>
</main>
${footer(cfg)}`;
      html(ctx, page(`${cfg.companyName} — ${cfg.companyTagline || 'سفرهای خاطره‌انگیز'}`,
        `رزرو آنلاین تور و خدمات گردشگری از ${cfg.companyName}: تور، پرواز، قطار، اتوبوس و هتل با بهترین قیمت و تضمین.`,
        body, {
          canonical: cfg.publicBaseUrl + '/',
          jsonLd: {
            '@context': 'https://schema.org', '@type': 'TravelAgency',
            name: cfg.companyName, url: cfg.publicBaseUrl + '/',
            telephone: cfg.companyPhone || undefined, email: cfg.companyEmail || undefined,
            address: cfg.companyAddress || undefined,
          },
        }));
    }
  });

  /* لیست خدمات تک */
  router.get('/services', (ctx) => {
    const q = U.cleanText(ctx.query.q || '', 60);
    const type = U.cleanText(ctx.query.type || '', 20);
    const page_ = Math.max(1, U.toInt(ctx.query.page, 1));
    const per = 12;
    const { rows, total } = publicOffers(db, { q, typeKey: type || null, limit: per, offset: (page_ - 1) * per });
    const pages = Math.max(1, Math.ceil(total / per));
    const qs = (p) => `/services?${new URLSearchParams({ ...(q && { q }), ...(type && { type }), page: p })}`;
    const body = `
${header(cfg, { user: ctx.user, active: '/services' })}
<main class="container">
  <h1 style="margin-top:1.6rem">خدمات تک — بلیط و رزرواسیون</h1>
  <p class="muted">${total ? `${U.fmtNum(total)} خدمت فعال` : ''} — جستجو بر اساس مقصد یا نوع خدمت${q ? `؛ نتیجه برای «${U.esc(q)}»` : ''}.</p>
  <form class="card" method="get" action="/services" style="display:flex;gap:.6rem;flex-wrap:wrap">
    <input type="search" name="q" value="${U.esc(q)}" placeholder="مقصد یا عنوان..." style="flex:1;min-width:180px">
    <select name="type">
      <option value="">همه</option>
      ${['flight', 'bus', 'train', 'hotel', 'transfer', 'tour', 'insurance'].map((k) => {
        const t = TYPE_TITLES[k]; return `<option value="${k}" ${type === k ? 'selected' : ''}>${t.emoji} ${t.title}</option>`;
      }).join('')}
    </select>
    <button class="btn">اعمال فیلتر</button>
  </form>
  ${rows.length
      ? `<div class="grid cols-3">${rows.map((o) => offerCard(o, cfg)).join('')}</div>
     ${pages > 1 ? `<nav style="margin:1.5rem 0;display:flex;gap:.4rem;justify-content:center">
       ${Array.from({ length: pages }, (_, i) => `<a class="btn small ${i + 1 === page_ ? '' : 'secondary'}" href="${qs(i + 1)}">${U.fmtNum(i + 1)}</a>`).join('')}
     </nav>` : ''}`
      : '<div class="empty">خدمتی با این مشخصات پیدا نشد.</div>'}
</main>
${footer(cfg)}`;
    html(ctx, page(`${q ? U.esc(q) + ' — ' : ''}خدمات گردشگری | ${cfg.companyName}`,
      `جستجو و رزرو خدمات گردشگری${q ? ` مربوط به ${U.esc(q)}` : ''}: بلیط هواپیما، قطار، اتوبوس و هتل.`,
      body, { canonical: cfg.publicBaseUrl + '/services' }));
  });

  /* لیست تورها */
  router.get('/tours', (ctx) => {
    const rows = db.prepare(`SELECT p.*, d.price_per_person, d.start_date, d.id AS dep_id,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.package_departure_id=d.id AND b.status IN ('pending','confirmed')) AS used,
        d.capacity_total
      FROM packages p JOIN package_departures d ON d.package_id=p.id
      WHERE p.public_published=1 AND p.status='published' AND d.status='open' AND d.start_date >= ?
      ORDER BY d.start_date ASC LIMIT 40`).all(U.todayLocal());
    const body = `
${header(cfg, { user: ctx.user, active: '/tours' })}
<main class="container">
  <h1 style="margin-top:1.6rem">تورهای گردشگری</h1>
  <p class="muted">پکیج‌های کامل شامل حمل‌ونقل و اقامت — ${rows.length ? U.fmtNum(rows.length) + ' تور فعال' : ''}</p>
  ${rows.length ? `<div class="grid cols-3">${rows.map((p) => `
    <article class="card offer-card">
      <div class="type">${U.esc(p.cover_emoji || '🎒')} ${p.nights ? U.fmtNum(p.nights) + ' شب و ' + U.fmtNum(p.days || p.nights + 1) + ' روز' : ''}</div>
      <div class="title">${U.esc(p.title)}</div>
      <div class="route">📍 ${U.esc(p.destination || '')}</div>
      <div class="route">🗓 حرکت: ${U.faDate(p.start_date)}</div>
      <div class="price-row">
        <div class="price">${U.money(p.price_per_person)} <span class="unit">/ هر نفر</span></div>
        <a class="btn small" href="/tours/${U.esc(p.slug)}">جزئیات</a>
      </div>
    </article>`).join('')}</div>` : '<div class="empty">هنوز توری منتشر نشده است.</div>'}
</main>
${footer(cfg)}`;
    html(ctx, page(`تورهای گردشگری | ${cfg.companyName}`,
      'تورهای سازمانی و تفریحی با اقامت و حمل‌ونقل؛ رزرو آنلاین با قیمت تمام‌شده.',
      body, { canonical: cfg.publicBaseUrl + '/tours' }));
  });

  /* جزئیات تور */
  router.get('/tours/:slug', (ctx) => {
    const p = db.prepare(`SELECT * FROM packages WHERE slug=? AND status='published'`).get(ctx.params.slug);
    if (!p || !p.public_published) throw new HttpError(404, 'این تور یافت نشد یا انتشار آن متوقف شده است.');
    const deps = db.prepare(`SELECT d.*,
        (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.package_departure_id=d.id AND b.status IN ('pending','confirmed')) AS used
      FROM package_departures d WHERE d.package_id=? AND d.status='open' AND d.start_date >= ? ORDER BY d.start_date`).all(p.id, U.todayLocal());
    const comps = db.prepare(`SELECT pc.*, i.title, st.title AS type_title, st.emoji, io.unit_price AS offer_price
      FROM package_components pc
      LEFT JOIN inventory_items i ON i.id=pc.item_id
      LEFT JOIN service_types st ON st.id=i.type_id
      LEFT JOIN inventory_offers io ON io.id=pc.offer_id
      WHERE pc.package_id=? ORDER BY pc.position`).all(p.id);
    const reviews = db.prepare(`SELECT * FROM reviews WHERE package_id=? AND approved=1 ORDER BY created_at DESC LIMIT 5`).all(p.id);
    const firstDep = deps[0];
    const body = `
${header(cfg, { user: ctx.user, active: '/tours' })}
<main class="container narrow">
  <nav class="small muted" style="margin:1.2rem 0"><a href="/">خانه</a> / <a href="/tours">تورها</a> / ${U.esc(p.title)}</nav>
  <article class="card">
    <h1>${U.esc(p.cover_emoji || '')} ${U.esc(p.title)}</h1>
    <p class="muted">${U.esc(p.summary || '')}</p>
    <div class="kv" style="margin:1rem 0">
      <span class="k">مقصد</span><span>${U.esc(p.destination || '—')}</span>
      <span class="k">مبدأ حرکت</span><span>${U.esc(p.origin || '—')}</span>
      <span class="k">مدت</span><span>${p.nights ? U.fmtNum(p.nights) + ' شب' : '—'}</span>
      ${firstDep ? `<span class="k">قیمت از</span><span class="price">${U.money(firstDep.price_per_person)} <span class="unit">/ هر نفر</span></span>` : ''}
    </div>
    ${p.description ? `<h2>شرح تور</h2><p>${U.esc(p.description).replace(/\n/g, '<br>')}</p>` : ''}
    ${comps.length ? `<h2>ارائه‌های تور</h2><ul>${comps.map((c) => `<li>${c.emoji || '•'} ${U.esc(c.title || 'خدمت')} ${c.notes ? '— ' + U.esc(c.notes) : ''}</li>`).join('')}</ul>` : ''}
  </article>
  <section class="card">
    <h2>تاریخ‌های اعزام و رزرو</h2>
    ${deps.length ? `<div class="table-wrap"><table class="data">
      <tr><th>تاریخ حرکت</th><th>قیمت هر نفر</th><th>ظرفیت</th><th></th></tr>
      ${deps.map((d) => `<tr>
        <td>${U.faDate(d.start_date)}</td>
        <td>${U.money(d.price_per_person)}</td>
        <td>${Math.max(0, d.capacity_total - d.used) > 0 ? `<span class="badge green">${U.fmtNum(d.capacity_total - d.used)} نفر</span>` : '<span class="badge red">تکمیل</span>'}</td>
        <td>${Math.max(0, d.capacity_total - d.used) > 0 ? `<a class="btn small" href="/book/package/${d.id}">رزرو</a>` : ''}</td>
      </tr>`).join('')}
    </table></div>` : '<div class="empty">فعلاً تاریخ اعزامی باز نیست.</div>'}
  </section>
  ${reviews.length ? `<section class="card"><h2>نظرات مسافران</h2>
    ${reviews.map((r) => `<div style="border-bottom:1px solid var(--line);padding:.6rem 0">
      <strong>${U.esc(r.author_name)}</strong> <span class="badge orange">${'★'.repeat(r.rating)}</span>
      <p class="small muted">${U.esc(r.comment || '')}</p></div>`).join('')}
  </section>` : ''}
</main>
${footer(cfg)}`;
    html(ctx, page(`${p.title} | تور ${U.esc(p.destination || '')} | ${cfg.companyName}`,
      (p.summary || p.title) + ' — رزرو آنلاین با قیمت شفاف.',
      body, {
        canonical: `${cfg.publicBaseUrl}/tours/${p.slug}`,
        jsonLd: [{
          '@context': 'https://schema.org', '@type': 'TouristTrip',
          name: p.title, description: p.summary || undefined,
          touristType: 'عمومی', itinerary: { '@type': 'Place', name: p.destination || undefined },
        }, ...(firstDep ? [{
          '@context': 'https://schema.org', '@type': 'Offer',
          name: `رزرو ${p.title}`,
          price: String(firstDep.price_per_person), priceCurrency: 'IRR',
          availability: 'https://schema.org/InStock', url: `${cfg.publicBaseUrl}/tours/${p.slug}`,
        }] : [])],
      }));
  });

  /* مقصدها */
  router.get('/destinations', (ctx) => {
    const dests = db.prepare('SELECT * FROM seo_destinations ORDER BY id').all();
    const body = `
${header(cfg, { user: ctx.user, active: '/destinations' })}
<main class="container">
  <h1 style="margin-top:1.6rem">مقصدهای محبوب</h1>
  <p class="muted">صفحه اختصاصی هر مقصد، همه تورها و خدمات فعال به آن مقصد را یک‌جا نشان می‌دهد.</p>
  <div class="grid cols-3">${dests.map((d) => `
    <a class="card offer-card" href="/destinations/${U.esc(d.slug)}">
      <div class="title">${d.emoji || '📍'} ${U.esc(d.title)}</div>
      <div class="route">${U.esc((d.description || '').slice(0, 100))}</div>
    </a>`).join('')}</div>
</main>
${footer(cfg)}`;
    html(ctx, page(`مقصدهای گردشگری | ${cfg.companyName}`, 'راهنمای مقصدهای گردشگری و خدمات فعال هر مقصد.', body, { canonical: cfg.publicBaseUrl + '/destinations' }));
  });

  router.get('/destinations/:slug', (ctx) => {
    const d = db.prepare('SELECT * FROM seo_destinations WHERE slug=?').get(ctx.params.slug);
    if (!d) throw new HttpError(404, 'مقصد یافت نشد.');
    const { rows: offers } = publicOffers(db, { dest: d.title, limit: 12 });
    const tours = db.prepare(`SELECT p.*, d2.price_per_person, d2.start_date FROM packages p
      JOIN package_departures d2 ON d2.package_id=p.id
      WHERE p.public_published=1 AND p.status='published' AND p.destination=? AND d2.start_date >= ? AND d2.status='open'
      ORDER BY d2.start_date LIMIT 6`).all(d.title, U.todayLocal());
    const body = `
${header(cfg, { user: ctx.user, active: '/destinations' })}
<main class="container">
  <nav class="small muted" style="margin:1.2rem 0"><a href="/">خانه</a> / <a href="/destinations">مقصدها</a> / ${U.esc(d.title)}</nav>
  <h1 style="margin-top:1rem">${d.emoji || '📍'} سفر به ${U.esc(d.title)}</h1>
  <p class="muted">${U.esc(d.description || '')}</p>
  ${tours.length ? `<h2>تورهای ${U.esc(d.title)}</h2><div class="grid cols-3">${tours.map((p) => `
    <article class="card offer-card">
      <div class="title">${U.esc(p.title)}</div>
      <div class="route">🗓 ${U.faDate(p.start_date)}</div>
      <div class="price-row"><div class="price">${U.money(p.price_per_person)}</div>
      <a class="btn small" href="/tours/${U.esc(p.slug)}">جزئیات</a></div>
    </article>`).join('')}</div>` : ''}
  <h2 style="margin-top:2rem">خدمات تک به ${U.esc(d.title)}</h2>
  ${offers.length ? `<div class="grid cols-3">${offers.map((o) => offerCard(o, cfg)).join('')}</div>` : '<div class="empty">فعلاً خدمتی برای این مقصد باز نشده است.</div>'}
</main>
${footer(cfg)}`;
    html(ctx, page(`سفر به ${U.esc(d.title)} | ${cfg.companyName}`,
      `رزرو تور، بلیط و هتل برای ${U.esc(d.title)} — قیمت‌های به‌روز.`,
      body, { canonical: `${cfg.publicBaseUrl}/destinations/${d.slug}` }));
  });

  /* صفحه رزرو آفر (فرم مسافران) */
  router.get('/book/offer/:id', (ctx) => {
    const o = db.prepare(`SELECT o.*, i.title, i.origin, i.destination, i.depart_at, i.unit_label, st.title AS type_title, st.emoji,
      (SELECT COALESCE(SUM(b.traveler_count),0) FROM bookings b WHERE b.offer_id=o.id AND b.status IN ('pending','confirmed')) AS used
      FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id JOIN service_types st ON st.id=i.type_id
      WHERE o.id=? AND o.status='open' AND o.visible_to_public=1`).get(ctx.params.id);
    if (!o) throw new HttpError(404, 'این خدمت برای فروش عمومی باز نیست.');
    const avail = Math.max(0, o.qty - o.used);
    const price = o.public_price != null ? o.public_price : o.unit_price;
    const csrf = require('./core').issueCsrf(ctx);
    const body = `
${header(cfg, { user: ctx.user })}
<main class="container narrow">
  <div class="steps"><div class="step on">۱. مشخصات</div><div class="step">۲. تایید و پرداخت</div><div class="step">۳. واچر</div></div>
  <form class="card" method="post" action="/book/offer/${U.esc(o.id)}">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="_json" value="1">
    <h1>${o.emoji} رزرو ${U.esc(o.title)}</h1>
    <p class="muted">${o.origin && o.destination ? `${U.esc(o.origin)} ← ${U.esc(o.destination)} — ` : ''}${o.depart_at ? U.faDate(o.depart_at) : ''}</p>
    <div class="alert info">قیمت هر ${U.esc(o.unit_label || 'نفر')}: <strong>${U.money(price)}</strong> — ${avail > 0 ? `${U.fmtNum(avail)} ظرفیت باقی‌مانده` : 'ظرفیتی نمانده'}</div>
    <div class="form-grid">
      <div class="field"><label>نام و نام خانوادگی سرپرست</label><input required name="buyer_name" maxlength="120"></div>
      <div class="field"><label>موبایل (پیگیری رزرو)</label><input required name="buyer_mobile" inputmode="tel" pattern="09[0-9]{9}" title="موبایل ۱۱ رقمی"></div>
      <div class="field"><label>تعداد مسافر</label><input required type="number" name="count" min="1" max="${avail || 1}" value="1" id="cnt"></div>
    </div>
    <div id="travelers"></div>
    <div class="field"><label>یادداشت (اختیاری)</label><textarea name="note" rows="2" maxlength="500"></textarea></div>
    <button class="btn" ${avail > 0 ? '' : 'disabled'}>ثبت رزرو و صدور کد پیگیری</button>
    <p class="small muted">پس از ثبت، کد پیگیری صادر می‌شود و کارشناسان ما برای پرداخت و صدور واچر تماس می‌گیرند.</p>
  </form>
</main>
<script>
(function(){
  var cnt = document.getElementById('cnt'), box = document.getElementById('travelers');
  function render(){
    var n = Math.max(1, Math.min(9, +cnt.value || 1));
    var h = '';
    for (var i=1;i<=n;i++){
      h += '<div class="card" style="padding:.9rem"><strong>مسافر ' + i + '</strong>'
        + '<div class="form-grid">'
        + '<div class="field"><label>نام و نام خانوادگی</label><input name="t_name_' + i + '" maxlength="120"></div>'
        + '<div class="field"><label>کد ملی (اختیاری)</label><input name="t_nid_' + i + '" inputmode="numeric" maxlength="12"></div>'
        + '</div></div>';
    }
    box.innerHTML = h;
  }
  cnt.addEventListener('input', render);
  render();
})();
</script>
${footer(cfg)}`;
    html(ctx, page(`رزرو ${U.esc(o.title)} | ${cfg.companyName}`, `فرم رزرو ${U.esc(o.title)}.`, body, { noindex: true }));
  });

  /* ثبت رزرو آفر از سایت عمومی */
  router.post('/book/offer/:id', async (ctx) => {
    const o = db.prepare(`SELECT o.*, i.title FROM inventory_offers o JOIN inventory_items i ON i.id=o.item_id
      WHERE o.id=? AND o.status='open' AND o.visible_to_public=1`).get(ctx.params.id);
    if (!o) throw new HttpError(404, 'این خدمت برای فروش عمومی باز نیست.');
    const b = ctx.body;
    const buyerName = U.isName(b.buyer_name);
    const buyerMobile = U.normalizeMobile(b.buyer_mobile);
    if (!buyerName) throw new HttpError(400, 'نام سرپرست را کامل وارد کنید.');
    if (!buyerMobile) throw new HttpError(400, 'موبایل معتبر وارد کنید (مثال: 09121234567).');
    const count = U.toInt(b.count, 0);
    const { avail } = D.offerAvailableQty(db, o.id);
    if (!count || count < 1 || count > 9) throw new HttpError(400, 'تعداد مسافر بین ۱ تا ۹.');
    if (avail < count) throw new HttpError(409, `ظرفیت کافی نیست (باقی‌مانده: ${avail}).`);
    const travelers = [];
    for (let i = 1; i <= count; i++) {
      const nm = U.cleanText(b['t_name_' + i], 120);
      if (nm) travelers.push({ full_name: nm, national_id: U.cleanText(U.faDigitsToEn(b['t_nid_' + i] || ''), 12) || null });
    }
    if (!travelers.length) travelers.push({ full_name: buyerName, national_id: null });
    const result = D.bookOffer(db, {
      offer: o, sellerId: o.seller_user_id, buyerName, buyerMobile,
      travelers, note: U.cleanText(b.note, 500) || 'رزرو از سایت عمومی', source: 'web',
    });
    redirect(ctx, `/voucher/${result.ref_code}`);
  }, { csrf: true });

  /* فرم رزرو پکیج */
  router.get('/book/package/:depId', (ctx) => {
    const d = db.prepare(`SELECT d.*, p.title, p.slug, p.destination FROM package_departures d
      JOIN packages p ON p.id=d.package_id WHERE d.id=? AND d.status='open'`).get(ctx.params.depId);
    if (!d) throw new HttpError(404, 'این تاریخ اعزام یافت نشد.');
    const { avail } = D.departureAvailableQty(db, d.id);
    const csrf = require('./core').issueCsrf(ctx);
    const body = `
${header(cfg, { user: ctx.user })}
<main class="container narrow">
  <div class="steps"><div class="step on">۱. مشخصات</div><div class="step">۲. تایید و پرداخت</div><div class="step">۳. واچر</div></div>
  <form class="card" method="post" action="/book/package/${U.esc(d.id)}">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="_json" value="1">
    <h1>🎒 رزرو ${U.esc(d.title)}</h1>
    <p class="muted">حرکت ${U.faDate(d.start_date)} — ${d.destination ? 'مقصد: ' + U.esc(d.destination) : ''}</p>
    <div class="alert info">قیمت هر نفر: <strong>${U.money(d.price_per_person)}</strong> — ${avail > 0 ? U.fmtNum(avail) + ' ظرفیت باقی‌مانده' : 'تکمیل'}</div>
    <div class="form-grid">
      <div class="field"><label>نام و نام خانوادگی سرپرست</label><input required name="buyer_name" maxlength="120"></div>
      <div class="field"><label>موبایل</label><input required name="buyer_mobile" inputmode="tel" pattern="09[0-9]{9}"></div>
      <div class="field"><label>تعداد مسافر</label><input required type="number" name="count" min="1" max="${avail || 1}" value="1" id="cnt"></div>
    </div>
    <div id="travelers"></div>
    <div class="field"><label>یادداشت (اختیاری)</label><textarea name="note" rows="2" maxlength="500"></textarea></div>
    <button class="btn" ${avail > 0 ? '' : 'disabled'}>ثبت رزرو</button>
  </form>
</main>
<script>
(function(){
  var cnt = document.getElementById('cnt'), box = document.getElementById('travelers');
  function render(){
    var n = Math.max(1, Math.min(9, +cnt.value || 1));
    var h = '';
    for (var i=1;i<=n;i++){
      h += '<div class="card" style="padding:.9rem"><strong>مسافر ' + i + '</strong>'
        + '<div class="form-grid">'
        + '<div class="field"><label>نام و نام خانوادگی</label><input name="t_name_' + i + '" maxlength="120"></div>'
        + '<div class="field"><label>کد ملی (اختیاری)</label><input name="t_nid_' + i + '" inputmode="numeric" maxlength="12"></div>'
        + '</div></div>';
    }
    box.innerHTML = h;
  }
  cnt.addEventListener('input', render); render();
})();
</script>
${footer(cfg)}`;
    html(ctx, page(`رزرو ${U.esc(d.title)} | ${cfg.companyName}`, 'فرم رزرو تور.', body, { noindex: true }));
  });

  router.post('/book/package/:depId', async (ctx) => {
    const d = db.prepare(`SELECT d.*, p.creator_user_id, p.title FROM package_departures d
      JOIN packages p ON p.id=d.package_id WHERE d.id=? AND d.status='open'`).get(ctx.params.depId);
    if (!d) throw new HttpError(404, 'این تاریخ اعزام یافت نشد.');
    const b = ctx.body;
    const buyerName = U.isName(b.buyer_name);
    const buyerMobile = U.normalizeMobile(b.buyer_mobile);
    if (!buyerName) throw new HttpError(400, 'نام سرپرست را کامل وارد کنید.');
    if (!buyerMobile) throw new HttpError(400, 'موبایل معتبر وارد کنید.');
    const count = U.toInt(b.count, 0);
    if (!count || count < 1 || count > 9) throw new HttpError(400, 'تعداد مسافر بین ۱ تا ۹.');
    const travelers = [];
    for (let i = 1; i <= count; i++) {
      const nm = U.cleanText(b['t_name_' + i], 120);
      if (nm) travelers.push({ full_name: nm, national_id: U.cleanText(U.faDigitsToEn(b['t_nid_' + i] || ''), 12) || null });
    }
    if (!travelers.length) travelers.push({ full_name: buyerName, national_id: null });
    const result = D.bookPackage(db, {
      departure: d, sellerId: d.creator_user_id, buyerName, buyerMobile, travelers,
      note: U.cleanText(b.note, 500) || 'رزرو از سایت عمومی', source: 'web',
    });
    redirect(ctx, `/voucher/${result.ref_code}`);
  });

  /* واچر */
  router.get('/voucher/:ref', (ctx) => {
    const b = db.prepare(`SELECT b.*, i.title AS offer_title, i.origin, i.destination, i.depart_at, i.hotel_name,
        p.title AS pkg_title, p.slug AS pkg_slug, st.title AS type_title, st.emoji
      FROM bookings b
      LEFT JOIN inventory_offers o ON o.id=b.offer_id
      LEFT JOIN inventory_items i ON i.id=o.item_id
      LEFT JOIN service_types st ON st.id=i.type_id
      LEFT JOIN package_departures d ON d.id=b.package_departure_id
      LEFT JOIN packages p ON p.id=d.package_id
      WHERE b.ref_code=?`).get(ctx.params.ref);
    if (!b) throw new HttpError(404, 'رزروی با این کد یافت نشد.');
    const travelers = db.prepare('SELECT * FROM booking_travelers WHERE booking_id=? ORDER BY position').all(b.id);
    const statusBadge = { pending: 'orange', confirmed: 'green', cancelled: 'red', expired: 'red', used: 'gray' }[b.status] || 'gray';
    const statusTitle = { pending: 'در انتظار پرداخت', confirmed: 'تایید شده', cancelled: 'لغو شده', expired: 'منقضی', used: 'مصرف شده' }[b.status] || b.status;
    const title = b.kind === 'package' ? b.pkg_title : b.offer_title;
    const body = `
${header(cfg, { user: ctx.user })}
<main class="container narrow">
  <div class="voucher">
    <div class="center">
      <img src="/assets/logo.svg" alt="" style="width:56px">
      <div style="font-weight:700;font-size:1.1rem">${U.esc(cfg.companyName)}</div>
      <div class="muted small">${U.esc(cfg.companyTagline || '')}</div>
    </div>
    <hr style="border:none;border-top:1px dashed var(--line);margin:1rem 0">
    <div class="center"><div class="muted small">کد پیگیری رزرو</div><div class="ref">${U.esc(b.ref_code)}</div></div>
    <table>
      <tr><td>خدمت</td><td><strong>${b.emoji || '🎫'} ${U.esc(title || '—')}</strong></td></tr>
      ${b.origin && b.destination ? `<tr><td>مسیر</td><td>${U.esc(b.origin)} ← ${U.esc(b.destination)}</td></tr>` : ''}
      ${b.depart_at ? `<tr><td>تاریخ</td><td>${U.faDate(b.depart_at)}</td></tr>` : ''}
      <tr><td>سرپرست</td><td>${U.esc(b.buyer_name)} — ${U.esc(b.buyer_mobile)}</td></tr>
      <tr><td>تعداد</td><td>${U.fmtNum(b.traveler_count)} نفر</td></tr>
      <tr><td>مبلغ کل</td><td><strong>${U.money(b.total_price)}</strong></td></tr>
      <tr><td>وضعیت</td><td><span class="badge ${statusBadge}">${statusTitle}</span> <span class="badge ${b.pay_status === 'paid' ? 'green' : 'gray'}">${b.pay_status === 'paid' ? 'پرداخت شده' : 'پرداخت نشده'}</span></td></tr>
      <tr><td>تاریخ ثبت</td><td>${U.faDateTime(b.created_at)}</td></tr>
    </table>
    ${travelers.length ? `<div class="muted small">مسافران: ${travelers.map((t) => U.esc(t.full_name)).join('، ')}</div>` : ''}
    <p class="center small muted" style="margin-top:1.2rem">این واچر معتبرِ رزرو شماست. ${cfg.companyPhone ? 'پشتیبانی: ' + U.esc(cfg.companyPhone) : ''}</p>
    <div class="center no-print"><button class="btn secondary" onclick="print()">چاپ واچر</button></div>
  </div>
  <p class="center small muted" style="margin-top:1rem">آدرس این صفحه را نگه دارید؛ با کد پیگیری می‌توانید وضعیت را دنبال کنید.</p>
</main>
${footer(cfg)}`;
    html(ctx, page(`واچر ${U.esc(b.ref_code)} | ${cfg.companyName}`, 'واچر رزرو.', body, { noindex: true }));
  });

  /* پیگیری رزرو */
  router.get('/track', (ctx) => {
    const ref = U.cleanText(ctx.query.ref || '', 20);
    let found = null, error = null;
    if (ref) {
      found = db.prepare('SELECT ref_code, status, pay_status, total_price FROM bookings WHERE ref_code=?').get(ref);
      if (!found) error = 'رزروی با این کد یافت نشد.';
    }
    const csrf = require('./core').issueCsrf(ctx);
    const body = `
${header(cfg, { user: ctx.user })}
<main class="container narrow">
  <form class="card" method="get" action="/track">
    <h1>🔎 پیگیری رزرو</h1>
    <p class="muted">کد پیگیری (مثل HS-XXXX-XXXX) را وارد کنید.</p>
    <div class="field"><input name="ref" value="${U.esc(ref)}" placeholder="HS-..." required></div>
    <button class="btn">پیگیری</button>
  </form>
  ${error ? `<div class="alert err">${error}</div>` : ''}
  ${found ? `<div class="alert ok">رزرو ${U.esc(found.ref_code)} — وضعیت: ${found.status === 'confirmed' ? 'تاییدشده' : found.status === 'pending' ? 'در انتظار پرداخت' : found.status === 'cancelled' ? 'لغو‌شده' : found.status} — مبلغ ${U.money(found.total_price)}
    <br><a href="/voucher/${U.esc(found.ref_code)}">مشاهده واچر</a></div>` : ''}
</main>
${footer(cfg)}`;
    html(ctx, page(`پیگیری رزرو | ${cfg.companyName}`, 'پیگیری وضعیت رزرو با کد پیگیری.', body, { noindex: true }));
  });

  /* تماس با ما */
  router.get('/contact', (ctx) => {
    const csrf = require('./core').issueCsrf(ctx);
    const body = `
${header(cfg, { user: ctx.user, active: '/contact' })}
<main class="container narrow">
  <h1 style="margin-top:1.6rem">✉️ تماس با ${U.esc(cfg.companyName)}</h1>
  <div class="form-grid">
    <form class="card" method="post" action="/contact">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="_json" value="1">
      <div class="field"><label>نام شما</label><input required name="name" maxlength="120"></div>
      <div class="form-grid">
        <div class="field"><label>موبایل</label><input name="mobile" inputmode="tel"></div>
        <div class="field"><label>ایمیل</label><input name="email" type="email"></div>
      </div>
      <div class="field"><label>پیام</label><textarea required name="body" rows="4" maxlength="2000"></textarea></div>
      <button class="btn">ارسال پیام</button>
    </form>
    <div class="card">
      <h2>اطلاعات تماس</h2>
      ${cfg.companyPhone ? `<p>☎️ ${U.esc(cfg.companyPhone)}</p>` : ''}
      ${cfg.companyEmail ? `<p>✉️ ${U.esc(cfg.companyEmail)}</p>` : ''}
      ${cfg.companyAddress ? `<p>📍 ${U.esc(cfg.companyAddress)}</p>` : ''}
      <p class="muted small">پاسخگویی: شنبه تا پنجشنبه، ۹ تا ۱۸</p>
    </div>
  </div>
</main>
${footer(cfg)}`;
    html(ctx, page(`تماس با ما | ${cfg.companyName}`, 'راه‌های ارتباط با ما.', body, { canonical: cfg.publicBaseUrl + '/contact' }));
  });

  router.post('/contact', (ctx) => {
    const b = ctx.body;
    const name = U.isName(b.name);
    if (!name) throw new HttpError(400, 'نام را کامل وارد کنید.');
    const body = U.cleanText(b.body, 2000);
    if (!body || body.length < 5) throw new HttpError(400, 'متن پیام کوتاه است.');
    db.prepare('INSERT INTO contact_messages (name,mobile,email,body,created_at) VALUES (?,?,?,?,?)')
      .run(name, U.normalizeMobile(b.mobile) || U.cleanText(b.mobile, 15) || null,
        U.normalizeEmail(b.email) || null, body, U.isoNow());
    redirect(ctx, '/contact?sent=1');
  });

  /* sitemap و robots */
  router.get('/sitemap.xml', (ctx) => {
    const urls = ['', '/services', '/tours', '/destinations', '/contact'];
    const tours = db.prepare(`SELECT slug, updated_at FROM packages WHERE public_published=1 AND status='published'`).all();
    const dests = db.prepare('SELECT slug FROM seo_destinations').all();
    const all = [
      ...urls.map((u) => ({ loc: cfg.publicBaseUrl + u, priority: u === '' ? '1.0' : '0.8' })),
      ...tours.map((t) => ({ loc: `${cfg.publicBaseUrl}/tours/${t.slug}`, priority: '0.9' })),
      ...dests.map((d) => ({ loc: `${cfg.publicBaseUrl}/destinations/${d.slug}`, priority: '0.7' })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map((u) => `  <url><loc>${U.esc(u.loc)}</loc><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
    ctx.res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    ctx.res.end(xml);
  });

  router.get('/robots.txt', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    ctx.res.end(`User-agent: *\nAllow: /\nDisallow: /panel\nDisallow: /book/\nDisallow: /voucher/\nSitemap: ${cfg.publicBaseUrl}/sitemap.xml\n`);
  });
}

const TYPE_TITLES = {
  flight: { title: 'پرواز', emoji: '✈️' }, bus: { title: 'اتوبوس', emoji: '🚌' },
  train: { title: 'قطار', emoji: '🚆' }, hotel: { title: 'هتل', emoji: '🏨' },
  transfer: { title: 'ترانسفر', emoji: '🚐' }, tour: { title: 'گشت', emoji: '🗺️' },
  insurance: { title: 'بیمه', emoji: '🛡️' },
};

module.exports = { registerPublicRoutes, header, footer };
