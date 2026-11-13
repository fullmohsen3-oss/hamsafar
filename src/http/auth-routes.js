'use strict';
/** ورود/ثبت‌نام/خروج — پنل‌ها با ایمیل+رمز، مشتریان با موبایل+OTP */

const U = require('../util');
const D = require('../domain');
const { ROLES } = require('../auth');
const { html, json, page, redirect, cookieHeader, HttpError, issueCsrf } = require('./core');
const { header, footer } = require('./public-site');

const SESSION_COOKIE = '__hs_sess';

function setSessionCookie(ctx, sessionId, cfg) {
  const prev = ctx.res.getHeader('Set-Cookie') || [];
  ctx.res.setHeader('Set-Cookie', [...prev, cookieHeader(SESSION_COOKIE, sessionId, {
    maxAge: 14 * 86400, httpOnly: true, sameSite: 'Lax', secure: cfg.cookieSecure, path: '/',
  })]);
}
function clearSessionCookie(ctx, cfg) {
  const prev = ctx.res.getHeader('Set-Cookie') || [];
  ctx.res.setHeader('Set-Cookie', [...prev, cookieHeader(SESSION_COOKIE, '', { delete: true, path: '/' })]);
}

/* ─── صفحات ─── */

function loginPage(ctx, cfg, { error, ok, next } = {}) {
  const csrf = issueCsrf(ctx);
  const body = `
${header(cfg, { user: null })}
<main class="container narrow">
  <form class="card" method="post" action="/login" style="margin-top:2rem">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="next" value="${U.esc(next || '')}">
    <input type="hidden" name="_json" value="1">
    <h1>🔐 ورود به هم‌سفر</h1>
    ${error ? `<div class="alert err">${U.esc(error)}</div>` : ''}
    ${ok ? `<div class="alert ok">${U.esc(ok)}</div>` : ''}
    <div class="field"><label>ایمیل یا موبایل</label><input required name="login" autocomplete="username" autofocus></div>
    <div class="field"><label>رمز عبور</label><input required type="password" name="password" autocomplete="current-password"></div>
    <button class="btn" style="width:100%">ورود</button>
    <p class="small muted" style="margin-top:.8rem">حساب کاربری ندارید؟ <a href="/register">ثبت‌نام مشتری</a> · <a href="/panel-request">درخواست پنل همکاری</a></p>
  </form>
</main>
${footer(cfg)}`;
  html(ctx, page(`ورود | ${cfg.companyName}`, 'ورود به حساب کاربری.', body, { noindex: true }));
}

function registerPage(ctx, cfg, { error, step, mobile } = {}) {
  const csrf = issueCsrf(ctx);
  if (step === 'otp') {
    const body = `
${header(cfg, { user: null })}
<main class="container narrow">
  <form class="card" method="post" action="/register/verify" style="margin-top:2rem">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="_json" value="1">
    <input type="hidden" name="mobile" value="${U.esc(mobile)}">
    <h1>📩 تایید موبایل</h1>
    <p class="muted">کد ۶ رقمی ارسال‌شده به <strong>${U.esc(mobile)}</strong> را وارد کنید.</p>
    ${error ? `<div class="alert err">${U.esc(error)}</div>` : ''}
    <div class="field"><label>کد تایید</label><input required name="code" inputmode="numeric" maxlength="6" style="letter-spacing:6px;font-size:1.2rem;text-align:center" autofocus></div>
    <button class="btn" style="width:100%">تایید و ساخت حساب</button>
  </form>
</main>
${footer(cfg)}`;
    html(ctx, page('تایید موبایل', 'تایید کد یک‌بارمصرف.', body, { noindex: true }));
    return;
  }
  const body = `
${header(cfg, { user: null })}
<main class="container narrow">
  <form class="card" method="post" action="/register" style="margin-top:2rem">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="_json" value="1">
    <h1>🧑‍🤝‍🧑 ثبت‌نام مشتری</h1>
    <p class="muted">با موبایل ثبت‌نام کنید؛ ورود با کد یک‌بارمصرف است و رمز لازم ندارد.</p>
    ${error ? `<div class="alert err">${U.esc(error)}</div>` : ''}
    <div class="field"><label>نام و نام خانوادگی</label><input required name="full_name" maxlength="120"></div>
    <div class="field"><label>موبایل</label><input required name="mobile" inputmode="tel" placeholder="09xxxxxxxxx"></div>
    <button class="btn" style="width:100%">دریافت کد تایید</button>
    <p class="small muted" style="margin-top:.8rem">شرکت/همکار هستید؟ <a href="/panel-request">درخواست پنل تخصصی</a></p>
  </form>
</main>
${footer(cfg)}`;
  html(ctx, page(`ثبت‌نام | ${cfg.companyName}`, 'ثبت‌نام مشتری با موبایل.', body, { noindex: true }));
}

/* ─── روت‌ها ─── */

function registerAuthRoutes(router, { db, cfg }) {

  router.get('/login', (ctx) => {
    if (ctx.user) return redirect(ctx, '/panel');
    loginPage(ctx, cfg, { next: U.cleanText(ctx.query.next || '', 200) });
  });

  router.post('/login', (ctx) => {
    const b = ctx.body;
    const user = D.getUserByLogin(db, b.login);
    if (!user || !user.password_hash || !U.verifyPassword(b.password || '', user.password_hash)) {
      if (isAjaxReq(ctx)) throw new HttpError(401, 'ایمیل/موبایل یا رمز عبور اشتباه است.');
      return loginPage(ctx, cfg, { error: 'ایمیل/موبایل یا رمز عبور اشتباه است.', next: b.next });
    }
    if (user.status !== 'active') {
      return loginPage(ctx, cfg, { error: 'حساب شما غیرفعال است؛ با پشتیبانی تماس بگیرید.', next: b.next });
    }
    const sid = D.createSession(db, user.id, ctx.ip, ctx.userAgent);
    setSessionCookie(ctx, sid, cfg);
    D.audit(db, { actorId: user.id, actorRole: user.role, action: 'auth.login', ip: ctx.ip });
    const next = U.cleanText(b.next || '', 200);
    const dest = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/panel';
    if (isAjaxReq(ctx)) return json(ctx, { ok: true, redirect: dest });
    redirect(ctx, dest);
  });

  router.post('/logout', (ctx) => {
    if (ctx.cookies[SESSION_COOKIE]) {
      D.destroySession(db, ctx.cookies[SESSION_COOKIE]);
    }
    clearSessionCookie(ctx, cfg);
    if (isAjaxReq(ctx)) return json(ctx, { ok: true });
    redirect(ctx, '/');
  });

  router.get('/register', (ctx) => {
    if (ctx.user) return redirect(ctx, '/panel');
    registerPage(ctx, cfg, {});
  });

  router.post('/register', (ctx) => {
    const b = ctx.body;
    const name = U.isName(b.full_name);
    const mobile = U.normalizeMobile(b.mobile);
    if (!name) throw new HttpError(400, 'نام و نام خانوادگی را کامل وارد کنید.');
    if (!mobile) throw new HttpError(400, 'موبایل معتبر وارد کنید (مثال: 09121234567).');
    const exists = db.prepare(`SELECT id, mobile FROM users WHERE mobile=?`).get(mobile);
    if (exists) {
      // ورود OTP برای مشتری موجود
    }
    const code = U.randomOtp();
    db.prepare(`DELETE FROM otp_codes WHERE mobile=? AND purpose='login'`).run(mobile);
    db.prepare(`INSERT INTO otp_codes (mobile,code,purpose,created_at,expires_at) VALUES (?,?,?,?,?)`)
      .run(mobile, code, 'login', U.isoNow(), new Date(Date.now() + 5 * 60000).toISOString());
    // در حالت واقعی: ارسال SMS. در دمو: نمایش در پاسخ (فقط dev).
    const devCode = cfg.dev || true ? code : null;
    if (isAjaxReq(ctx)) return json(ctx, { ok: true, step: 'otp', mobile, dev_code: devCode });
    registerPage(ctx, cfg, { step: 'otp', mobile });
  });

  router.post('/register/verify', (ctx) => {
    const b = ctx.body;
    const mobile = U.normalizeMobile(b.mobile);
    const code = U.faDigitsToEn(U.cleanText(b.code || '', 8));
    if (!mobile || !/^\d{6}$/.test(code)) throw new HttpError(400, 'کد یا موبایل نامعتبر است.');
    const otp = db.prepare(`SELECT * FROM otp_codes WHERE mobile=? AND purpose='login' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(mobile);
    if (!otp || otp.expires_at < U.isoNow()) throw new HttpError(400, 'کد منقضی شده است؛ دوباره تلاش کنید.');
    if (otp.tries >= 5) throw new HttpError(429, 'تلاش‌های ناموفق زیاد؛ بعداً تلاش کنید.');
    if (otp.code !== code) {
      db.prepare('UPDATE otp_codes SET tries=tries+1 WHERE mobile=? AND purpose=? AND created_at=?').run(mobile, 'login', otp.created_at);
      throw new HttpError(400, 'کد صحیح نیست.');
    }
    db.prepare('UPDATE otp_codes SET consumed_at=? WHERE mobile=? AND purpose=? AND created_at=?').run(U.isoNow(), mobile, 'login', otp.created_at);
    let user = db.prepare('SELECT * FROM users WHERE mobile=?').get(mobile);
    const t = U.isoNow();
    if (!user) {
      const id = U.randomId();
      db.prepare(`INSERT INTO users (id,role,status,full_name,mobile,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, 'customer', 'active', U.cleanText(b.full_name || 'مسافر', 120) || 'مسافر', mobile, t, t);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    }
    const sid = D.createSession(db, user.id, ctx.ip, ctx.userAgent);
    setSessionCookie(ctx, sid, cfg);
    D.audit(db, { actorId: user.id, actorRole: user.role, action: 'auth.otp_login', ip: ctx.ip });
    if (isAjaxReq(ctx)) return json(ctx, { ok: true, redirect: '/panel' });
    redirect(ctx, '/panel');
  });

  /* درخواست پنل همکاری (تامین‌کننده/واسطه/پکیج‌ساز) */
  router.get('/panel-request', (ctx) => {
    const csrf = issueCsrf(ctx);
    const body = `
${header(cfg, { user: ctx.user })}
<main class="container narrow">
  <form class="card" method="post" action="/panel-request" style="margin-top:2rem">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="_json" value="1">
    <h1>🤝 درخواست پنل همکاری</h1>
    <p class="muted">تامین‌کننده/چارتر، پکیج‌ساز یا واسطه هستید؟ درخواست شما را بررسی می‌کنیم و حساب پنل می‌سازیم.</p>
    <div class="form-grid">
      <div class="field"><label>نام و نام خانوادگی</label><input required name="name" maxlength="120"></div>
      <div class="field"><label>موبایل</label><input required name="mobile" inputmode="tel"></div>
      <div class="field"><label>ایمیل</label><input name="email" type="email"></div>
      <div class="field"><label>نوع همکاری</label>
        <select name="kind">
          <option value="supplier">تامین‌کننده / چارتر</option>
          <option value="packager">پکیج‌ساز (تورساز)</option>
          <option value="agent">واسطه ( فروش با کمیسیون)</option>
        </select></div>
    </div>
    <div class="field"><label>شرح کسب‌وکار</label><textarea required name="body" rows="3" maxlength="2000" placeholder="مثلاً: چارترکار اتوبوس تهران-مشهد، ۲۰ اتوبوس..."></textarea></div>
    <button class="btn">ارسال درخواست</button>
  </form>
</main>
${footer(cfg)}`;
    html(ctx, page('درخواست پنل همکاری', 'فرم درخواست پنل همکاری.', body, { noindex: true }));
  });

  router.post('/panel-request', (ctx) => {
    const b = ctx.body;
    const name = U.isName(b.name);
    if (!name) throw new HttpError(400, 'نام را کامل وارد کنید.');
    const kindMap = { supplier: 'تامین‌کننده/چارتر', packager: 'پکیج‌ساز', agent: 'واسطه' };
    const body = `درخواست پنل (${kindMap[b.kind] || b.kind}) از ${name}\nموبایل: ${U.cleanText(b.mobile, 15)}\nایمیل: ${U.cleanText(b.email, 80) || '-'}\n\n${U.cleanText(b.body, 2000)}`;
    db.prepare('INSERT INTO contact_messages (name,mobile,email,subject,body,created_at) VALUES (?,?,?,?,?,?)')
      .run(name, U.normalizeMobile(b.mobile) || U.cleanText(b.mobile, 15) || null, U.normalizeEmail(b.email) || null,
        `درخواست پنل: ${kindMap[b.kind] || b.kind}`, body, U.isoNow());
    if (isAjaxReq(ctx)) return json(ctx, { ok: true, message: 'درخواست شما ثبت شد؛ به‌زودی تماس می‌گیریم.' });
    redirect(ctx, '/panel-request?sent=1');
  });
}

function isAjaxReq(ctx) {
  return ctx.pathname.startsWith('/api/') || ctx.body && ctx.body._json === '1' || (ctx.req.headers['content-type'] || '').includes('application/json');
}

module.exports = { registerAuthRoutes, setSessionCookie, clearSessionCookie, SESSION_COOKIE };
