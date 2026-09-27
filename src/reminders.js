import fs from 'node:fs';
import path from 'node:path';

/**
 * "Buyurtmani yakunlashni nazorat qilish" — delivery reminder engine.
 *
 * This is NOT a new order-completion system. It only tracks, per order, when the next
 * reminder is due and how many have been sent. The actual "Yetkazildi" action still goes
 * through the existing upstream.setStatus(rid, id, 'delivered') — the one and only
 * completion entry point (see app.js). Nothing here touches finance/payment/payout.
 *
 * Persisted to a JSON file (same pattern as DeviceStore) so a restart never loses a
 * pending reminder — the TZ explicitly forbids scheduling this with an in-request
 * setTimeout(), which would vanish on redeploy/crash.
 *
 * NOTE on recipients (TZ §5): the current Order model has no courierId/telegramChatId —
 * this BFF is restaurant-staff facing only, and the courier/Telegram-bot side lives in the
 * existing lakmago-server, outside these two repos. So reminders here always target the
 * restaurant's registered devices (Socket.IO room + FCM tokens), exactly like the existing
 * order:new / order:updated broadcast. If/when lakmago-server exposes a courier or staff
 * assignment on the order, route the reminder to that recipient instead of the whole
 * restaurant — nothing else in this file would need to change.
 */
export class ReminderStore {
  constructor(file, { delayMinutes, repeatMinutes, maxCount } = {}) {
    this.file = file || '';
    this.delayMs = Math.max(1, delayMinutes ?? 30) * 60_000;
    this.repeatMs = Math.max(1, repeatMinutes ?? 30) * 60_000;
    this.maxCount = Math.max(1, maxCount ?? 3);
    this.map = new Map();
    if (this.file && fs.existsSync(this.file)) {
      try { for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(id, v); }
      catch { /* start empty */ }
    }
  }

  #save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)));
  }

  /** Called right after an order enters 'delivering' (handed to courier). Idempotent: a
   *  second call for the same order is a no-op — "bir order uchun ikkita bir xil reminder
   *  job yaratilmasin" (TZ §16). */
  scheduleIfNeeded(restaurantId, orderId, now = Date.now()) {
    if (this.map.has(orderId)) return false;
    this.map.set(orderId, { restaurantId, reminderCount: 0, lastSentAt: null, nextReminderAt: now + this.delayMs, stalled: false });
    this.#save();
    return true;
  }

  /** "Jarayonda" — order stays open, just push the next reminder out. Does not bump the count. */
  ack(orderId, now = Date.now()) {
    const e = this.map.get(orderId);
    if (!e) return false;
    e.nextReminderAt = now + this.repeatMs;
    this.#save();
    return true;
  }

  /** Order reached a terminal state (via the existing completion flow, or out-of-band on the
   *  upstream) — stop reminding about it. */
  clear(orderId) {
    if (!this.map.delete(orderId)) return false;
    this.#save();
    return true;
  }

  due(now = Date.now()) {
    return [...this.map.entries()]
      .filter(([, e]) => !e.stalled && e.nextReminderAt <= now)
      .map(([orderId, e]) => ({ orderId, ...e }));
  }

  /** The scheduler calls this once it has actually sent a reminder (socket + push attempted).
   *  Past REMINDER_MAX_COUNT the order is marked "stalled": no further reminders are sent and
   *  it is NOT auto-completed — it just becomes visible to admin monitoring (TZ §10, §11, §30). */
  recordSent(orderId, now = Date.now()) {
    const e = this.map.get(orderId);
    if (!e) return null;
    e.reminderCount += 1;
    e.lastSentAt = now;
    e.stalled = e.reminderCount >= this.maxCount;
    e.nextReminderAt = e.stalled ? Infinity : now + this.repeatMs;
    this.#save();
    return { ...e };
  }

  get(orderId) { const e = this.map.get(orderId); return e ? { orderId, ...e } : null; }

  stalledFor(restaurantId) {
    return [...this.map.entries()].filter(([, e]) => e.stalled && e.restaurantId === restaurantId)
      .map(([orderId, e]) => ({ orderId, ...e }));
  }
}
