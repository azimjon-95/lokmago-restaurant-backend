# LokmaGo Restoran — Backend (BFF)

Restoran xodimlari Android ilovasi uchun servis: **JWT auth, buyurtmalar API, Socket.IO (foreground) va FCM (background)**.
Mavjud `lakmago-server` ning oldida turadi va u bilan **API gateway** orqali gaplashadi.

```
Android ──HTTPS/WSS──▶ shu servis ──gateway (URL+parol .env dan)──▶ lakmago-server
                          ▲
   lakmago-server ── POST /internal/orders/events ──┘   (yangi buyurtma → Socket.IO + FCM)
```

## Tez boshlash (mock rejim, tashqi serversiz)

```bash
npm install
cp .env.example .env      # JWT_SECRET ni o'zgartiring; UPSTREAM_MODE=mock; NODE_ENV=development
npm run dev
npm test
```
Mock loginlar: `admin/admin123`, `operator/operator123` (Shirin Taom), `other/other123` (boshqa restoran).
Navbatni sinash (5–6 ta bir vaqtda):
```bash
curl -XPOST localhost:8080/internal/dev/orders -H 'x-webhook-secret: <INTERNAL_WEBHOOK_SECRET>' \
  -H 'content-type: application/json' -d '{"restaurantId":"r1","count":6}'
```
Bu endpoint faqat `NODE_ENV!=production` va mock upstream bilan mavjud.

## Sozlamalar (.env) — hech narsa kodda yozilmagan

| Kalit | Ma'nosi |
|---|---|
| `JWT_SECRET` | ≥16 belgi, majburiy |
| `UPSTREAM_MODE` | `gateway` (haqiqiy) / `mock` (faqat dev; production'da rad etiladi) |
| `API_GATEWAY_URL`, `API_GATEWAY_PASSWORD`, `API_GATEWAY_HEADER` | lakmago-server'ga chiquvchi so'rovlar |
| `GATEWAY_INBOUND_PASSWORD` | Ilovadan kiruvchi umumiy parol (REST + socket handshake). Android'dagi `API_GATEWAY_PASSWORD` bilan bir xil |
| `INTERNAL_WEBHOOK_SECRET` | lakmago-server → `/internal/orders/events` uchun (`x-webhook-secret`) |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` / `_FILE` | FCM. Bo'sh bo'lsa push o'chiq, Socket.IO ishlayveradi |
| `ANDROID_MIN_VERSION`, `ANDROID_LATEST_VERSION`, `ANDROID_FORCE_UPDATE` | `GET /restaurant/v1/app/version` |

> ⚠️ Ilova ichiga joylangan gateway paroli APK'dan olinishi mumkin — u faqat qo'shimcha to'siq.
> Haqiqiy himoya: JWT + har bir amalda `restaurantId` ni **tokendan** olish.

## API (`/restaurant/v1`)

`POST /auth/login` · `GET /orders/pending` · `GET /orders?status&limit` · `GET /orders/:id` ·
`POST /orders/:id/accept` · `POST /orders/:id/status` · `GET /stats/today` ·
`POST|DELETE /devices/fcm` · `GET /app/version`

Socket.IO: handshake `auth: { token }`; server xonani tokendan aniqlaydi. Eventlar: `order:new`, `order:updated`.

## Xavfsizlik va poyga holatlari

- `restaurantId` hech qachon klientdan olinmaydi — faqat imzolangan JWT'dan. Boshqa restoran buyurtmasi = `404`.
- Bir buyurtmani ikki telefon bir vaqtda qabul qilsa: bittasi `200`, ikkinchisi `409 already_handled` (testlangan).
- Holat o'tishlari `src/status.js` da bitta joyda (olib borish/zal buyurtmalari `delivering` ni o'tkazib yuboradi).
- Webhook faqat `restaurantId`+`orderId` ni qabul qiladi; buyurtmaning o'zi upstream'dan qayta o'qiladi.
- FCM — faqat data-only, high priority; yaroqsiz tokenlar avtomatik o'chiriladi.
- Rate limit: login 15 daqiqada 20 urinish.

## Production

```bash
docker build -t lokmago-restaurant-backend .
docker run -d --env-file .env -p 8080:8080 -v lokmago-data:/app/data lokmago-restaurant-backend
```
HTTPS/WSS'ni reverse proxy (nginx/Caddy) tugatadi; WebSocket upgrade yoqilgan bo'lsin, `TRUST_PROXY=1`.
Bir nechta instansiya kerak bo'lsa: Socket.IO Redis adapter va `DeviceStore` ni umumiy bazaga o'tkazing (hozir bitta instansiya uchun, JSON fayl).

## ⚠️ Bajarilishi kerak: mavjud backend auditi (TZ 22-bo'lim)

`src/upstream/gateway.js` dagi `ROUTES` va `mapOrder()` — **taxminiy yo'llar**. `lakmago-server` endpointlari audit qilingach,
faqat shu fayl moslashtiriladi; qolgan servis o'zgarmaydi. Upstream `accept` atomik bo'lishi va tayyor bo'lmagan
buyurtmaga `409` qaytarishi shart. Yangi buyurtma yaratilganda lakmago-server `POST /internal/orders/events`
(`{"event":"created","restaurantId":"…","orderId":"…"}`) ni chaqirishi kerak.

## Ma'lum cheklovlar
- `npm audit`: `firebase-admin` orqali tranzitiv `uuid` (moderate) — `--force` yangilash buzuvchi; bu yerda ekspluatatsiya yo'li yo'q.
- `DeviceStore` — bitta instansiya uchun.
