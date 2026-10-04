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
| `POST auth/login` | `{login, password}` → `{token,user,restaurant}`. Nimani anglatishi `AUTH_MODE`ga bog'liq (pastga qarang) |
| `POST auth/refresh` | Joriy token yaroqli bo'lsa yangisini beradi (sliding sessiya, ilova kuniga ko'pi bilan 1 marta chaqiradi). Parol telefonda saqlanmaydi |
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

### Login rejimlari (`AUTH_MODE`)

| Rejim | `login` | `password` | Server tomonda nima kerak |
|---|---|---|---|
| `pin` (hozirgi default) | Restoran ID | PIN | mavjud `GET /app/{pin}/{restaurantId}/` — tayyor |
| `credentials` | restoranning o'z logini | restoranning o'z paroli | **yangi** `POST /app/service/auth/login` (pastda) |

**`credentials` uchun main server shartnomasi** (servis kaliti sarlavhasi bilan, IP ro'yxatidan o'tgan):
```
POST /app/service/auth/login        { "login": "...", "password": "..." }
200  { "restaurantId": "<24 hex>", "name": "TOTLI" }      // boshqa hech narsa: hash, payout, telefon YO'Q
401  { "code": "INVALID_CREDENTIALS" }
429  { "code": "LOGIN_BLOCKED", "retryAfter": 30 }       // blok LOGIN bo'yicha, IP bo'yicha emas (BFF bitta IP)
```
Serverning kalit/IP xatosi (`401/404` kodsiz) BFF'da `502` bo'lib ko'rinadi — hech qachon "parol noto'g'ri" emas.
Sessiya: JWT (`JWT_TTL`, default 30 kun) + `auth/refresh`. Restoran paroli serverda o'zgarsa, eski token muddati tugaguncha amal qiladi.

### lakmago-server bilan ulanish (`src/upstream/gateway.js`)

Shartnoma: `lakmago-server` → `deploy/GATEWAY-BFF.md` (commit `2948fb1`). Adapter faqat shu faylda:

| BFF | lakmago-server |
|---|---|
| `auth/login` (restoranId + PIN) | `GET /app/{pin}/{restaurantId}/` — PIN faqat login paytida URL'da, saqlanmaydi va logga chiqmaydi |
| `orders`, `orders/pending`, `orders/:id` | `GET /app/service/{rid}/orders[?status=]`, `/orders/:id` (header `x-gateway-key`) |
| `orders/:id/accept`, `status` | `PATCH .../orders/:id/status`. Ketma-ket takror `200 changed:false`; haqiqiy poyga `409 RACE_LOST` → `409 already_handled` |
| delivery buyurtmada `delivered` | `POST .../orders/:id/confirm-delivered` (botdagi «Yakunlandi» bilan bir xil funksiya, komissiya bir marta). Erta bo'lsa `409 confirm_too_early` + `eligibleAt` |

Xavfsizlik qarorlari:
* `mapOrder()` — **ruxsat ro'yxati**: xom hujjatdagi `finance`, mijoz hamyoni/kartalari, soxta `courierName`, `telegramId`, payout telefonga chiqmaydi.
* Serverning **bizning kalitni** rad etishi (`401/403`) ilovaga `502 upstream_auth` bo'lib boradi, hech qachon `401` emas (aks holda hamma telefon logout bo'lib ketadi).
* Login limiti `5/15 daqiqa` — serverning IP limiti (10 xato/15 daqiqa) butun BFF uchun bitta ekanini hisobga olib.
* Webhook: `x-event-id` bo'yicha takrorlar tashlanadi (server at-least-once), o'z o'zgarishimizning aks-sadosi (echo) qayta yuborilmaydi, ko'rinmas (zal/to'lanmagan) buyurtma `202 ignored` bilan tasdiqlanadi (server qayta urinmasligi uchun). Buyurtma BFF'dan tashqarida (kuryer havolasi, bot) `delivering` bo'lsa ham eslatma kuzatuvi boshlanadi.
* **Statistika hali ulanmagan** (`501 not_implemented`): serverning `/stats` va `/orders/history` JSON shakli hali bizda yo'q. Jimgina 0 ko'rsatmaslik uchun ataylab shunday.

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
