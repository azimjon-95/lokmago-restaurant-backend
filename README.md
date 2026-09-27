# LokmaGo Restoran — Backend (BFF)

Restoran xodimlari Android ilovasi uchun servis: login (JWT), buyurtmalar, **Socket.IO** (`order:new`, `order:updated`),
**FCM** push va Google Play uchun versiya siyosati. Mavjud `lakmago-server` bilan **API gateway** orqali gaplashadi.

```
Android ──HTTPS──► API gateway ──► shu servis (/restaurant/v1, /socket.io)
                                        │  UPSTREAM_MODE=gateway
lakmago-server ──webhook──► shu servis  └──► API gateway ──► lakmago-server
```

## Ishga tushirish

```bash
cp .env.example .env      # qiymatlarni to'ldiring — .env GitHub'ga yuklanmaydi
npm ci
npm test
npm start
```

Lokal sinov uchun `.env` da `NODE_ENV=development`, `UPSTREAM_MODE=mock` qo'ying (test loginlar: `admin/admin123`,
`operator/operator123`; boshqa restoran: `other/other123`). **Production'da mock rad etiladi.**

## .env

| Kalit | Izoh |
|---|---|
| `JWT_SECRET` | Kamida 16 belgi. Token ichiga `rid` (restoran) server yozadi — klientga ishonilmaydi |
| `UPSTREAM_MODE` | `gateway` (haqiqiy) yoki `mock` (faqat dev) |
| `API_GATEWAY_URL` / `API_GATEWAY_PASSWORD` / `API_GATEWAY_HEADER` | lakmago-server'ga chiqish |
| `GATEWAY_INBOUND_PASSWORD` | Bo'sh bo'lmasa, ilovadan kelgan har bir so'rov (REST + Socket.IO) shu parolni `API_GATEWAY_HEADER` da yuborishi shart (Android `env.properties` dagi `API_GATEWAY_PASSWORD` bilan bir xil) |
| `INTERNAL_WEBHOOK_SECRET` | lakmago-server → shu servis webhook siri (production'da majburiy) |
| `FIREBASE_SERVICE_ACCOUNT_FILE` / `_BASE64` | FCM. Bo'sh bo'lsa push o'chiq, Socket.IO ishlayveradi |
| `ANDROID_MIN_VERSION`, `ANDROID_LATEST_VERSION`, `ANDROID_FORCE_UPDATE` | `GET /restaurant/v1/app/version` |

## API (`/restaurant/v1`, JWT: `Authorization: Bearer …`)

| | |
|---|---|
| `POST auth/login` | `{login,password}` → `{token,user,restaurant}` |
| `GET orders/pending` | Kutayotgan buyurtmalar (eskisi birinchi) — ilova ochilganda tiklash |
| `GET orders?status=&limit=` · `GET orders/:id` | Faqat o'z restoraniniki, aks holda `404` |
| `POST orders/:id/accept` | Atomik. Yutqazgan qurilma `409 already_handled` oladi |
| `POST orders/:id/status` | `{status}` — `pending→accepted→preparing→ready→(delivering)→delivered` |
| `POST orders/:id/reminder/ack` | `{action:"delivered"\|"in_progress"}` — pastga qarang |
| `GET reminders/stalled` | `REMINDER_MAX_COUNT`ga yetgan, hali yakunlanmagan buyurtmalar (admin monitoring) |
| `GET stats/today` | Kunlik statistika |
| `POST` / `DELETE devices/fcm` | FCM tokenni bog'lash / logoutda uzish |
| `GET app/version` | Google Play In-App Update siyosati (ochiq) |

## Buyurtmani yakunlashni nazorat qilish (delivery reminder)

Buyurtma `delivering` holatiga o'tgach (kuryerga/yetkazishga topshirilgach), agar u
`REMINDER_DELAY_MINUTES` ichida yakunlanmasa — eslatma yuboriladi (Socket.IO `order:delivery-reminder`
+ FCM data-xabar `order_delivery_reminder`), keyin har `REMINDER_REPEAT_MINUTES`da yana,
`REMINDER_MAX_COUNT` martagacha. Bu **yangi order-completion tizimi emas**:

* "Yetkazildi" (`reminder/ack {action:"delivered"}`) xuddi `orders/:id/status {status:"delivered"}` kabi
  **bir xil** `upstream.setStatus()` chaqiradi — finance/payment/payout logikasi umuman qayta yozilmagan.
  Ikkinchi marta bosilsa upstream uni rad etadi (`409 already_handled`) — takroriy hisob-kitob bo'lmaydi.
* "Jarayonda" (`{action:"in_progress"}`) statusni o'zgartirmaydi, faqat keyingi eslatmani suradi.
* `REMINDER_MAX_COUNT`dan keyin **avtomatik yakunlash yo'q** — buyurtma faqat `GET reminders/stalled`da
  ko'rinadi (admin monitoring uchun).
* Reminder holati diskka yoziladi (`REMINDER_STORE_FILE`, `DeviceStore` bilan bir xil naqsh) — server
  qayta ishga tushsa ham kutilayotgan eslatma yo'qolmaydi. Setliklar `setInterval` orqali (HTTP so'rov
  ichidagi `setTimeout` emas) — `REMINDER_TICK_SECONDS`.
* **Telegram**: bu ikkita repo (Android + shu BFF) courier/Telegram bot'ni o'z ichiga olmaydi — u mavjud
  `lakmago-server`da. `POST /internal/telegram/reminder-callback` (`x-webhook-secret` bilan,
  `{restaurantId,orderId,action}`) — mavjud botning inline-callback'i chaqirishi kerak bo'lgan **shartnoma**;
  order egaligi bu yerda qayta tekshiriladi (callback tanasiga ishonilmaydi), yangi bot yozilmagan.
* **Recipient**: hozirgi Order modelida `courierId`/`telegramChatId` yo'q — shuning uchun eslatma
  restoranning barcha ro'yxatdan o'tgan qurilmalariga boradi (xuddi `order:new` kabi). Agar
  `lakmago-server` kuryer/xodim biriktirishni ochsa, faqat shu qism (`app.js`dagi `reminderAck`/
  broadcast qismi) moslashtiriladi.

**Socket.IO:** ulanishda `auth: { token }`. Xona tokendan aniqlanadi. Eventlar: `order:new`, `order:updated` (to'liq order).

## lakmago-server integratsiyasi

Yangi buyurtma yaratilganda / o'zgarganda (`event`: `created` | `updated` | `cancelled`):

```bash
curl -X POST $BFF/internal/orders/events \
  -H "x-webhook-secret: $INTERNAL_WEBHOOK_SECRET" -H 'content-type: application/json' \
  -d '{"event":"created","restaurantId":"…","orderId":"…"}'
```

Servis orderni upstream'dan qayta o'qiydi (webhook tanasiga ishonilmaydi), so'ng Socket.IO **va** FCM orqali yuboradi.

> ⚠️ `src/upstream/gateway.js` dagi `ROUTES` va `mapOrder()` — **taxminiy** yo'llar. TZ 22-band bo'yicha
> `lakmago-server` endpointlari audit qilingach faqat shu fayl moslanadi.

Dev'da bir necha buyurtmani birdan yaratish (navbatni sinash): `POST /internal/dev/orders {"restaurantId":"r1","count":6}`
(`x-webhook-secret` bilan; production'da mavjud emas).

## Deploy

```bash
docker build -t lokmago-restaurant-backend .
docker run -p 8080:8080 --env-file .env lokmago-restaurant-backend
```

Reverse proxy'da **WebSocket** yo'naltirilishi va HTTPS yoqilgan bo'lishi kerak. Bir nechta nusxa ishlatilsa Socket.IO uchun
Redis adapter va umumiy `DeviceStore` kerak bo'ladi (hozir bitta instansiya uchun mo'ljallangan).

## Testlar

`npm test` (26 ta) — auth, restoranlararo izolyatsiya, **bir vaqtdagi accept (bittasi yutadi, ikkinchisi 409)**,
6 ta buyurtma navbati, status oqimi (pickup `delivering` ni o'tkazadi), Socket.IO xonalari, push, webhook,
FCM token hayot sikli, gateway paroli, va **delivery reminder**: faqat `delivering`da boshlanadi, T+30/T+60/T+90da
eslatma, max'dan keyin avtomatik yakunlanmaydi, "Jarayonda" hisoblagichni oshirmaydi, "Yetkazildi" mavjud
completion orqali ishlaydi va takroriy bosish xavfsiz (409), bekor qilingan/pickup buyurtmalarga eslatma
bormaydi, bitta orderga ikkita reminder job yaratilmaydi, restoranlararo ack bloklanadi, Telegram callback
webhook sirini va restoran egaligini tekshiradi, disk-persist qilingan holat qayta process'da saqlanadi.
