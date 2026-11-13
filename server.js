'use strict';
/**
 * هم‌سفر — نقطه ورود
 * اجرا: node server.js   (یا npm start) — بدون هیچ وابستگی خارجی، فقط Node.js ≥ 22.5
 */
const path = require('node:path');
const config = require('./src/config');
const { init } = require('./src/db');
const { SERVICE_TYPES } = require('./src/service-types');
const U = require('./src/util');
const log = require('./src/logger');
const D = require('./src/domain');

const { Router, createServer, setAssetRoot } = require('./src/http/core');
const { registerPublicRoutes } = require('./src/http/public-site');
const { registerAuthRoutes } = require('./src/http/auth-routes');
const { registerPanelCommonRoutes } = require('./src/http/panel-common');
const { registerSupplierRoutes } = require('./src/http/routes/panel/supplier');
const { registerAgentRoutes } = require('./src/http/routes/panel/agent');
const { registerPackagerRoutes } = require('./src/http/routes/panel/packager');
const { registerAdminRoutes } = require('./src/http/routes/panel/admin');
const { registerFederationApiRoutes } = require('./src/http/fed-api-routes');

/* ─── دیتابیس ─── */
const db = init(config);

// انواع خدمت (idempotent)
{
  const ins = db.prepare('INSERT OR IGNORE INTO service_types (id, key, title, emoji, unit) VALUES (?,?,?,?,?)');
  for (const t of SERVICE_TYPES) ins.run(t.id, t.key, t.title, t.emoji, t.unit);
}

// نصب اولیه: ساخت مدیر مالک اگر هیچ کاربری نبود
function ensureOwner() {
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (hasUsers > 0) return null;
  const id = U.randomId();
  const t = U.isoNow();
  const email = 'admin@' + (config.companySlug || 'localhost') + '.ir';
  db.prepare(`INSERT INTO users (id,role,status,full_name,email,password_hash,is_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,?,?)`)
    .run(id, 'admin', 'active', 'مدیر سیستم', email, U.hashPassword('admin1234'), t, t);
  log.warn('اولین اجرا: حساب مدیر پیش‌فرض ساخته شد', { email, note: 'رمز admin1234 فقط برای اولین ورود؛ بلافاصله از پنل تغییر دهید (بازنشانی رمز از کاربران).' });
  return { id, email };
}
ensureOwner();

/* ─── روترها ─── */
const publicRouter = new Router();   // سایت عمومی + احراز + API فدراسیون
const panelRouter = new Router();    // پنل‌ها

const ctx0 = { db, cfg: config };
registerPublicRoutes(publicRouter, ctx0);
registerAuthRoutes(publicRouter, ctx0);
registerFederationApiRoutes(publicRouter, ctx0);

registerPanelCommonRoutes(panelRouter, ctx0);
registerSupplierRoutes(panelRouter, ctx0);
registerAgentRoutes(panelRouter, ctx0);
registerPackagerRoutes(panelRouter, ctx0);
registerAdminRoutes(panelRouter, ctx0);

/* ─── سرور ─── */
const server = createServer({
  router: publicRouter,
  panelRouter,
  resolveUser: (cookies) => {
    const sid = cookies.__hs_sess;
    return sid ? D.getSessionUser(db, sid) : null;
  },
  onError: (ctx, e) => {
    const { HttpError, html, page } = require('./src/http/core');
    const { header, footer } = require('./src/http/public-site');
    const status = e instanceof HttpError ? e.status : 500;
    const is404 = status === 404;
    html(ctx, page(
      is404 ? `صفحه یافت نشد | ${config.companyName}` : `خطا | ${config.companyName}`,
      '',
      `${header(config, { user: ctx.user })}
<main class="container narrow center" style="padding:3rem 1rem">
  <div style="font-size:3.5rem">${is404 ? '🧭' : '⚠️'}</div>
  <h1>${is404 ? 'صفحه‌ای که می‌خواستید یافت نشد' : 'خطایی رخ داد'}</h1>
  <p class="muted">${U.esc(e.message)}</p>
  <p><a class="btn" href="/">بازگشت به صفحه اصلی</a></p>
</main>
${footer(config)}`
    ), status);
  },
});

setAssetRoot(path.join(config.root, 'public', 'assets'));

server.listen(config.port, config.host, () => {
  log.info('HamSafar started', {
    company: config.companyName,
    url: `http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}`,
    publicBase: config.publicBaseUrl,
    fedBase: `${config.fedBaseUrl}/fed/v1`,
    db: config.db.file,
  });
});

/* خاموشی تمیز */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('shutting down', { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
