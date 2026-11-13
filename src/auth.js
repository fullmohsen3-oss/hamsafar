'use strict';
/** RBAC — نقش‌ها و صلاحیت‌های هم‌سفر */

const ROLES = {
  admin: {
    title: 'مدیر سیستم',
    panel: '/panel/admin',
    can: ['*'],
  },
  employee: {
    title: 'کارمند',
    panel: '/panel',
    can: [
      'bookings.view', 'bookings.confirm', 'bookings.cancel',
      'inventory.view', 'market.view', 'packages.view',
      'customers.view', 'reports.view', 'contact.view',
    ],
  },
  supplier: {
    title: 'تامین‌کننده / چارتر',
    panel: '/panel/supplier',
    can: [
      'inventory.view', 'inventory.manage',
      'offers.manage', 'offers.view',
      'bookings.view', 'bookings.confirm', 'bookings.cancel',
      'transfers.manage',
      'market.view',
      'finance.view.own',
    ],
  },
  packager: {
    title: 'پکیج‌ساز (تورساز)',
    panel: '/panel/packager',
    can: [
      'inventory.view', 'offers.view', 'market.view', 'market.buy',
      'packages.view', 'packages.manage',
      'bookings.view', 'bookings.confirm', 'bookings.cancel',
      'finance.view.own',
    ],
  },
  agent: {
    title: 'واسطه (ماندگار)',
    panel: '/panel/agent',
    can: [
      'inventory.view', 'offers.view', 'market.view', 'market.buy',
      'packages.view',
      'bookings.view', 'bookings.confirm', 'bookings.cancel',
      'finance.view.own',
    ],
  },
  customer: {
    title: 'مشتری',
    panel: '/panel/customer',
    can: ['bookings.view.own', 'profile.manage'],
  },
};

function can(role, perm) {
  const r = ROLES[role];
  if (!r) return false;
  if (r.can.includes('*')) return true;
  if (r.can.includes(perm)) return true;
  // سلسله‌مراتب: bookings.view.own ⊂ bookings.view
  if (perm.endsWith('.own')) return can(role, perm.slice(0, -4));
  return false;
}

/** میانه‌افزار احراز هویت پنل */
function requireRole(...roles) {
  return (ctx) => {
    const user = ctx.user;
    if (!user) {
      const { redirect } = require('./core');
      if (isAjax(ctx)) {
        throw new (require('./core').HttpError)(401, 'ابتدا وارد شوید.');
      }
      redirect(ctx, `/login?next=${encodeURIComponent(ctx.pathname)}`);
      return false;
    }
    if (roles.length && !roles.includes(user.role)) {
      throw new (require('./core').HttpError)(403, 'به این بخش دسترسی ندارید.');
    }
    return true;
  };
}

function isAjax(ctx) {
  return ctx.pathname.startsWith('/api/') || (ctx.req.headers['x-requested-with'] === 'fetch')
    || String(ctx.req.headers.accept || '').includes('application/json');
}

module.exports = { ROLES, can, requireRole, isAjax };
