/**
 * Minimal production-safe scheduler (TZ §15): a single recurring setInterval owned by the
 * server process — NOT a setTimeout created inside an HTTP request handler, which would be
 * lost on restart/redeploy. There is no Redis/BullMQ/cron in this codebase (audited in
 * src/upstream, src/devices.js, src/push.js — none exists), so this is the smallest thing
 * that satisfies "pending reminder yo'qolmasin" for a single server instance.
 *
 * Scaling note: if this service is ever run with more than one instance, ticking must move
 * behind a lock (e.g. Redis SETNX) or a distributed queue so two instances don't double-send
 * the same reminder — the existing README already flags the same limitation for Socket.IO.
 */
export function createReminderScheduler({ reminders, upstream, hub, push, log = console, tickMs = 30_000 }) {
  let timer = null;

  async function tick(now = Date.now()) {
    for (const entry of reminders.due(now)) {
      let order;
      try {
        order = await upstream.getOrder(entry.restaurantId, entry.orderId);
      } catch {
        reminders.clear(entry.orderId); // order gone / no longer ours — stop tracking it
        continue;
      }
      if (order.status !== 'delivering') {
        reminders.clear(entry.orderId); // delivered / cancelled / moved on already — nothing to remind about
        continue;
      }

      const updated = reminders.recordSent(entry.orderId, now);
      hub.emit(entry.restaurantId, 'order:delivery-reminder', { orderId: entry.orderId, reminderCount: updated.reminderCount });
      try {
        await push.deliveryReminder(entry.restaurantId, order, updated.reminderCount);
      } catch (e) {
        log.error('[reminders] push yuborilmadi:', e.message);
      }
      if (updated.stalled) {
        log.warn(`[reminders] #${order.number} (${entry.restaurantId}) uzoq vaqt yakunlanmagan — reminderCount=${updated.reminderCount}, admin monitoringga chiqarilsin`);
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log.error('[reminders] tick xatosi:', e.message)); }, tickMs);
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop };
}
