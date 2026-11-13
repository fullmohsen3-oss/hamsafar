# معماری هم‌سفر

## لایه‌ها

```
HTTP (core.js: روتر، کوکی، CSRF، بدنه JSON/Form)
 ├── سایت عمومی (public-site.js) — SSR خالص، سئو
 ├── احراز (auth-routes.js) — نشست کوکی‌ای، OTP مشتری
 ├── پنل‌ها (panel-common + routes/panel/*) — RBAC
 └── API فدراسیون (fed-api-routes + federation.js) — HMAC
دامنه (domain.js) — منطق خالص کسب‌وکار، تراکنش‌های اتمیک
داده (db.js) — node:sqlite، WAL، مهاجرت نسخه‌دار
```

## مدل داده (جدول‌های اصلی)

- `users` — ۶ نقش: admin/employee/supplier/packager/agent/customer
- `inventory_items` — ظرفیت پایه (اتوبوس/پرواز/هتل...) با مالک
- `inventory_offers` — عرضه از یک item: بازار یا تضمینی(wholesale)، قیمت همکار/عمومی، دید عمومی/فدرال
- `packages` + `package_components` + `package_departures` — تور، اجزا (به آفر/آیتم)، تاریخ‌ها
- `bookings` + `booking_travelers` — رزرو offer یا package، کمیسیون، منشأ (web/panel/federation)
- `ledger_entries` — دفتر حساب هر کاربر (فروش/خرید/کمیسیون/تسویه/فدرال) با `balance_after`
- `fed_peers` / `fed_remote_items` / `fed_inbox` / `fed_idempotency` — فدراسیون
- `audit_log` — ممیزی همه اعمال حساس

## قواعد ظرفیت

ظرفیت آزاد آفر = `qty` آفر − Σ رزرو‌های `pending|confirmed` روی آن آفر. همین قاعده برای `package_departures.capacity_total`. رزرو در `BEGIN IMMEDIATE` انجام می‌شود؛ رقابت همزمان → یکی برنده، بقیه `409`.

## جریان مالی (IRR)

- فروش مستقیم: `sale +total` برای تامین‌کننده/سازنده.
- فروش واسطه: `purchase −بهای همکار` و `commission +حاشیه` برای واسطه (حاشیه = قیمت عمومی − قیمت همکار، × تعداد؛ برای تور ۸٪ قابل تنظیم).
- فدراسیون ورودی: `fed_sale` برای تامین‌کننده + افزایش `fed_peers.our_balance`.
- لغو: معکوس تمام اقلام (`refund`).
- تسویه مدیر: `payout` کاهش طلب.

## امنیت

- رمز: scrypt (N=16384) با نمک تصادفی؛ مقایسه timing-safe.
- نشست: کوکی HttpOnly + SameSite=Lax، انقضا ۱۴ روز، ROLLBACK در تعلیق کاربر.
- CSRF: توکن در کوکی Strict + فیلد `_csrf` در همه فرم‌های HTML و JSON.
- فدراسیون: HMAC-SHA256 روی (نسخه، متد، مسیر، کلید، بدنه) + کلیدهای مستقل هر جهت + idempotency.
- هدرها: nosniff، DENY، Referrer-Policy.
- RBAC در `auth.js`؛ چک دسترسی مالکیتی در رزروها (فروشنده/تامین‌کننده/مشتری خودش).

## سئو

- همه صفحات عمومی SSR با متا/کانونیکال؛ noindex فقط برای صفحات تراکنشی (رزرو/واچر/پنل).
- JSON-LD: TravelAgency (خانه)، TouristTrip + Offer (تور)، مقصدها.
- `sitemap.xml` داینامیک (صفحات + تورها + مقصدها) و `robots.txt` با Disallow پنل/رزرو.
- URLهای فارسی-خودآیند با slug؛ نرخ فارسی-محور برای CTR.

## محدودهای آگاهانه

پرداخت آنلاین، پیامک واقعی، چند-ارزی و صف کارها عمداً خارج از نسخه ۱ هستند؛ نقاط اتصال در `confirmBooking`، `register` و `ledger` مستند و آماده‌اند.
