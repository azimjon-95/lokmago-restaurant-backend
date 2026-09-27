import fs from 'node:fs';
import admin from 'firebase-admin';

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export class Push {
  constructor(cfg, devices, log = console) {
    this.devices = devices; this.log = log; this.messaging = null;
    try {
      const raw = cfg.base64 ? Buffer.from(cfg.base64, 'base64').toString('utf8') : cfg.file ? fs.readFileSync(cfg.file, 'utf8') : '';
      if (raw) {
        const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
        this.messaging = admin.messaging(app);
      } else log.warn('[push] Firebase sozlanmagan — FCM o\'chiq');
    } catch (e) { log.error('[push] Firebase init xatosi:', e.message); }
  }

  get enabled() { return !!this.messaging; }

  /** DATA-ONLY + high priority: Android calls onMessageReceived even when the app is closed. */
  async orderNew(restaurantId, order) {
    return this.#send(restaurantId, {
      type: 'order_new', orderId: order.id,
      title: '🔔 Yangi buyurtma',
      body: `#${order.number} — ${fmt(order.total)} so'm\n${order.itemsCount} ta taom • ${order.paymentMethod === 'card' ? 'Karta' : 'Naqd'}`,
    });
  }
  async orderChanged(restaurantId, order, type = 'order_updated') {
    return this.#send(restaurantId, { type, orderId: order.id });
  }
  /** Delivery-completion reminder (TZ §19, §23) — data-only, same as the other order pushes. */
  async deliveryReminder(restaurantId, order, reminderCount) {
    return this.#send(restaurantId, {
      type: 'order_delivery_reminder', orderId: order.id, reminderCount: String(reminderCount),
      title: '🚴 Buyurtma yetkazildimi?',
      body: `Buyurtma №${order.number} hali yakunlanmagan.`,
    });
  }

  async #send(restaurantId, data) {
    if (!this.messaging) return { sent: 0 };
    const tokens = this.devices.tokensFor(restaurantId);
    if (!tokens.length) return { sent: 0 };
    const res = await this.messaging.sendEachForMulticast({ tokens, data, android: { priority: 'high', ttl: 60_000 } });
    res.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') this.devices.removeToken(tokens[i]);
    });
    return { sent: res.successCount, failed: res.failureCount };
  }
}
