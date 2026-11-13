# استقرار هم‌سفر

## پیش‌نیاز

- Node.js ≥ 22.5 (تست‌شده روی 24.x)
- هیچ وابستگی npm ندارد؛ `npm install` لازم نیست.

## راه‌اندازی روی سرور لینوکس

```bash
# ۱) کد را بگیرید
git clone <repo> hamsafar && cd hamsafar

# ۲) پیکربندی
cp .env.example .env
nano .env   # COMPANY_NAME، COMPANY_SLUG، PUBLIC_BASE_URL، SESSION_SECRET!

# ۳) اجرا (اولین اجرا مدیر می‌سازد)
node server.js
```

### اجرای دائمی با systemd

```ini
# /etc/systemd/system/hamsafar.service
[Unit]
Description=HamSafar Travel Platform
After=network.target

[Service]
WorkingDirectory=/opt/hamsafar
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Restart=always
User=www-data
# پیکربندی را امن نگه دارید:
EnvironmentFile=/opt/hamsafar/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hamsafar
```

### پشت Nginx (پیشنهادی)

```nginx
server {
  server_name travel.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

سپس در `.env`: `HOST=127.0.0.1`، `COOKIE_SECURE=true` (بعد از فعال‌سازی HTTPS)، `PROXY_TRUSTED=127.0.0.1`.

## پشتیبان‌گیری

همه چیز در `data/hamsafar.sqlite` است:

```bash
# پشتیبان گرم (بدون توقف سرویس)
sqlite3 data/hamsafar.sqlite ".backup '/backup/hamsafar-$(date +%F).sqlite'"
```

(یا ساده: کپی سه فایل `hamsafar.sqlite*` هنگام توقف سرویس.)

## به‌روزرسانی

```bash
git pull
node scripts/seed.js   # فقط برای محیط دمو — روی پروداکشن اجرا نکنید
sudo systemctl restart hamsafar
```

مهاجرت‌های دیتابیس خودکار و نسخه‌دارند (`schema_migrations`).

## چک‌لیست پروداکشن

- [ ] `SESSION_SECRET` تصادفی بلند (مثلاً `openssl rand -hex 32`)
- [ ] HTTPS فعال و `COOKIE_SECURE=true`
- [ ] رمز مدیر اولیه بازنشانی شده
- [ ] پشتیبان‌گیری روزانه زمان‌بندی شده
- [ ] فایروال: فقط 80/443 باز؛ پورت 3000 فقط از localhost
- [ ] `data/` در git نباشد (gitignore دارد)
