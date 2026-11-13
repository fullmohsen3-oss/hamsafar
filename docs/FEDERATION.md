# پروتکل فدراسیون هم‌سفر (v1)

ارتباط بلادرنگ میان شرکت‌هایی که هم‌سفر را مستقل اجرا می‌کنند.

## اصول

- **حفاظت**: هر جفت شرکت دو کلید مستقل دارد: `api_key` (کلید همتا که ما با آن تماس می‌گیریم) و `our_key_for_them` (کلید ما که همتا با آن ما را صدا می‌زند).
- **امضا**: همه درخواست‌ها با HMAC-SHA256 امضا می‌شوند؛ بدون TLS هم در برابر دستکاری مقاوم است اما TLS توصیه می‌شود.
- **اتمیک بودن**: رزرو روی سرور عرضه‌کننده در یک تراکنش SQLite ثبت و ظرفیت همان لحظه کسر می‌شود.
- **Idempotency**: عملیات رزرو/لغو با هدر `X-Idempotency-Key` دقیقاً یک‌بار اثر می‌گذارد؛ تکرار همان پاسخ را برمی‌گرداند.

## امضا

```
material = "1\n" + METHOD + "\n" + path+query + "\n" + api_key + "\n" + body
signature = HMAC-SHA256(api_key, material)
```

هدرها:

| هدر | مقدار |
|---|---|
| `X-HamSafar-Key` | کلید شما نزد همتا |
| `X-HamSafar-Signature` | امضای hex |
| `X-HamSafar-Version` | `1` |
| `X-Idempotency-Key` | (اختیاری، برای POST) |

## اندپوینت‌ها

### `GET /fed/v1/ping`
سلامت و معرفی. پاسخ: `{ok, product, api, company, time}`

### `GET /fed/v1/catalog?limit=50&offset=0`
کاتالوگ آفرهای فدرال همتا (آفرهای بازارِ باز به واسطه‌ها):
```json
{"ok":true,"version":"...","count":2,"items":[
  {"id":"O1","kind":"offer","title":"اتوبوس VIP تهران-مشهد","type_key":"bus",
   "origin":"تهران","destination":"مشهد","depart_at":"...","unit_price":850000,
   "currency":"IRR","qty_available":44,"unit_label":"صندلی"}
]}
```

### `GET /fed/v1/catalog/:offerId`
جزئیات یک آفر.

### `POST /fed/v1/catalog/:offerId/reserve`
بدنه: `{travelers: 3, contact_name: "...", contact_mobile: "09...", booking_ref: "HF-..."}`
پاسخ: `{ok, booking_ref: "HS-...", status: "pending", total_price, unit_price, currency, expires_at}`
خطاها: `404` آفر نیست · `409` ظرفیت کافی نیست · `400` ورودی نامعتبر.

### `POST /fed/v1/bookings/:ref/cancel`
بدنه: `{reason: "..."}`
فقط رزروهای همان همتا قابل لغو هستند (`fed_peer_id` چک می‌شود).

### `GET /fed/v1/bookings/:ref`
وضعیت رزرو فدرال.

### `GET /fed/v1/balance`
تراز مالی دو شرکت: `{peer_owes_us, we_owe_peer, currency}`

## نمونه پیاده‌سازی کلاینت (Node بدون وابستگی)

```js
const crypto = require('node:crypto');
function sign(key, method, path, body) {
  return crypto.createHmac('sha256', key)
    .update(['1', method, path, key, body || ''].join('\n')).digest('hex');
}
// fetch با هدرهای X-HamSafar-Key / X-HamSafar-Signature / X-HamSafar-Version
```

ماژول آماده: `src/http/federation.js` → `FederationClient`.

## چرخه عمر و تسویه

1. رزرو فدرال با `status=pending` و مهلت پرداخت ثبت می‌شود.
2. اگر در مهلت تایید نشود، کارخانه انقضا (قابل اتصال cron) آن را `expired` می‌کند و ظرفیت برمی‌گردد.
3. تراز `fed_peers.our_balance` پس از هر رزرو/لغو به‌روز می‌شود؛ تسویه دورهای بین شرکت‌ها بیرون از پروتکل است (صورتحساب).
