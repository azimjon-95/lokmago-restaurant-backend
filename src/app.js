import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError, BadRequest, Unauthorized, NotFound } from './errors.js';
import { STATUS } from './status.js';
import { gatewayGuard, requireAuth, safeEqual, signToken } from './auth.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw BadRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};

const Login = z.object({ login: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) });
const StatusBody = z.object({ status: z.enum(STATUS) });
const Device = z.object({ token: z.string().min(10).max(4096), deviceId: z.string().min(4).max(128), platform: z.string().default('android') });
const Listing = z.object({ status: z.enum(STATUS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const OrderEvent = z.object({
  event: z.string().trim().min(1).max(40), // created | updated | cancelled | delivered ... anything else is treated as "updated"
  restaurantId: z.string().min(1),
  orderId: z.string().min(1),
});
const ReminderAck = z.object({ action: z.enum(['delivered', 'in_progress']) });
const TelegramReminderCallback = z.object({
  restaurantId: z.string().min(1), orderId: z.string().min(1), action: z.enum(['delivered', 'in_progress']),
});

/**
 * @param hub { emit(restaurantId, event, payload) } — Socket.IO fan-out (wired after the HTTP server exists)
 * @param reminders ReminderStore — delivery-completion reminders (see src/reminders.js)
 */
export function createApp({ config, upstream, devices, push, hub, reminders, log = console }) {
  reminders ??= { scheduleIfNeeded() {}, clear() {}, ack() { return false; }, stalledFor() { return []; } };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'true' ? true : Number(config.trustProxy) || false);
  app.use(helmet());
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '64kb' }));

  const health = (_req, res) => res.json({ ok: true, push: push.enabled, upstream: config.upstreamMode });
  app.get('/health', health);

  /** Tell every phone of the restaurant over both channels; a failing channel never breaks the other. */
  const lastSig = new Map();   // orderId -> { status, at }: lets us drop the server's echo of OUR OWN change
  const seenEvents = new Set(); // x-event-id: the server delivers at-least-once
  const remember = (set, key, max = 2000) => { set.add(key); if (set.size > max) set.delete(set.values().next().value); };

  /** A delivery order is "handed over" while status=delivering, whoever moved it there (our route, courier link, bot). */
  function syncReminder(restaurantId, order) {
    if (order.status === 'delivering' && order.fulfillment === 'delivery') reminders.scheduleIfNeeded(restaurantId, order.id);
    else reminders.clear(order.id);
  }

  async function broadcast(restaurantId, event, order) {
    lastSig.set(order.id, { status: order.status, at: Date.now() });
    if (lastSig.size > 2000) lastSig.delete(lastSig.keys().next().value);
    hub.emit(restaurantId, event === 'created' ? 'order:new' : 'order:updated', order);
    try {
      if (event === 'created') await push.orderNew(restaurantId, order);
      else await push.orderChanged(restaurantId, order, event === 'cancelled' ? 'order_cancelled' : 'order_updated');
    } catch (e) { log.error('[push] yuborilmadi:', e.message); }
  }

  /**
   * Single entry point for "Yetkazildi" / "Jarayonda", used by the phone route AND the
   * Telegram-callback webhook below — exactly one place that can complete a delivery, per
   * TZ §7/§8/§20/§21 ("existing order action/completion service", no parallel logic here).
   * "delivered" delegates to the SAME upstream.setStatus already used by the regular
   * /orders/:id/status route — no new finance/payment/payout path is introduced.
   */
  async function reminderAck(restaurantId, orderId, action) {
    if (action === 'in_progress') {
      const order = await upstream.getOrder(restaurantId, orderId); // ownership check: 404 if not this restaurant's order
      if (order.status !== 'delivering') throw BadRequest('Bu buyurtma hozir kuryerda emas');
      reminders.ack(orderId); // just push nextReminderAt forward — does not touch order status
      return order;
    }
    // "delivered": if setStatus rejects because it's already delivered/cancelled, that IS the
    // idempotency guarantee (409 already_handled) — finance/payment/payout run at most once.
    const order = await upstream.setStatus(restaurantId, orderId, 'delivered');
    reminders.clear(orderId);
    await broadcast(restaurantId, 'updated', order);
    return order;
  }

  // ---------- internal: called by lakmago-server (not by phones) ----------
  const internal = express.Router();
  const hookAuth = (req) => {
    if (!config.webhookSecret) throw new HttpError(503, 'Webhook o\'chiq', 'webhook_disabled');
    if (!safeEqual(req.headers['x-webhook-secret'] ?? '', config.webhookSecret)) throw Unauthorized('Webhook sir noto\'g\'ri');
  };
  internal.post('/orders/events', wrap(async (req, res) => {
    hookAuth(req);
    const { event, restaurantId, orderId } = parse(OrderEvent, req.body);
    const eventId = String(req.headers['x-event-id'] ?? '');
    if (eventId && seenEvents.has(eventId)) return res.status(202).json({ ok: true, duplicate: true });
    let order;
    try { order = await upstream.getOrder(restaurantId, orderId); } // source of truth is the upstream, not the webhook body
    catch (e) {
      if (e instanceof HttpError && e.status === 404) { reminders.clear(orderId); return res.status(202).json({ ok: true, ignored: true }); } // hidden/unknown order: do not make the server retry
      throw e; // upstream trouble -> non-2xx -> the server retries (12 attempts)
    }
    syncReminder(restaurantId, order);
    const kind = event === 'created' ? 'created' : event === 'cancelled' ? 'cancelled' : 'updated';
    const prev = lastSig.get(order.id);
    const echo = kind === 'updated' && prev && prev.status === order.status && Date.now() - prev.at < 60_000;
    if (!echo) await broadcast(restaurantId, kind, order);
    if (eventId) remember(seenEvents, eventId);
    res.status(202).json({ ok: true, ...(echo ? { echo: true } : {}) });
  }));
  /**
   * Contract for the EXISTING Telegram bot (it lives in lakmago-server, not in this repo —
   * per TZ §6/§36 we do not stand up a parallel bot here). The bot's inline-button callback
   * should call this once it has resolved which order/restaurant it's for; this endpoint does
   * not trust that resolution — order ownership is re-checked against `restaurantId` here
   * (TZ §27) via the same upstream lookup every other route uses.
   */
  internal.post('/telegram/reminder-callback', wrap(async (req, res) => {
    hookAuth(req);
    const { restaurantId, orderId, action } = parse(TelegramReminderCallback, req.body);
    const order = await reminderAck(restaurantId, orderId, action);
    res.json({ ok: true, order });
  }));
  if (config.env !== 'production' && upstream.createOrder) {
    // dev helper: spawn several simultaneous orders to try the queue
    internal.post('/dev/orders', wrap(async (req, res) => {
      hookAuth(req);
      const { restaurantId = 'r1', count = 1, ...partial } = req.body ?? {};
      const created = [];
      for (let i = 0; i < Math.min(Number(count) || 1, 20); i++) {
        const o = upstream.createOrder(restaurantId, partial);
        created.push(o.id);
        await broadcast(restaurantId, 'created', o);
      }
      res.status(201).json({ created });
    }));
  }
  app.use('/internal', internal);

  // ---------- mobile API ----------
  const api = express.Router();
  api.use(gatewayGuard(config));
  api.get('/health', health);
  api.get('/app/version', (_req, res) => res.json({ android: config.android }));

  // The main server's own IP limiter is 10 failures / 15 min for the WHOLE BFF (we are one IP), so stay below it.
  // Only FAILED attempts count: a restaurant that logs in successfully must never lock the others out.
  api.post('/auth/login',
    rateLimit({ windowMs: 15 * 60_000, limit: config.env === 'test' ? 1000 : 5, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
      message: { error: 'Juda ko\'p urinish. Keyinroq qayta urining', code: 'rate_limited' } }),
    wrap(async (req, res) => {
      const { login, password } = parse(Login, req.body);
      const r = await upstream.authenticate(login, password);
      if (!r) throw Unauthorized();
      const token = signToken(config, { userId: String(r.user.id), restaurantId: String(r.restaurant.id) });
      // The app requires user.login; never rely on the upstream to provide it.
      res.json({ token, user: { ...r.user, login: r.user.login ?? login }, restaurant: r.restaurant });
    }));

  const secured = express.Router();
  secured.use(requireAuth(config));
  const rid = (req) => req.auth.restaurantId; // ALWAYS from the verified token

  // Sliding session: the app calls this on start (at most once a day). A restaurant that uses the app keeps its
  // session alive; one that is gone for JWT_TTL has to log in again. restaurantId is copied from the VERIFIED token.
  secured.post('/auth/refresh', (req, res) => res.json({ token: signToken(config, { userId: req.auth.userId, restaurantId: rid(req) }) }));

  secured.get('/orders/pending', wrap(async (req, res) => res.json(await upstream.listOrders(rid(req), { status: 'pending', limit: 200 }))));
  secured.get('/orders', wrap(async (req, res) => res.json(await upstream.listOrders(rid(req), parse(Listing, req.query)))));
  secured.get('/orders/:id', wrap(async (req, res) => res.json(await upstream.getOrder(rid(req), req.params.id))));

  secured.post('/orders/:id/accept', wrap(async (req, res) => {
    const order = await upstream.accept(rid(req), req.params.id); // atomic upstream: the loser of a race gets 409
    await broadcast(rid(req), 'updated', order);
    res.json(order);
  }));
  secured.post('/orders/:id/status', wrap(async (req, res) => {
    const { status } = parse(StatusBody, req.body);
    if (status === 'pending') throw BadRequest('Noto\'g\'ri holat');
    const order = status === 'accepted' ? await upstream.accept(rid(req), req.params.id) : await upstream.setStatus(rid(req), req.params.id, status);
    // Reminder scheduling rides along with the EXISTING status transition — no new status,
    // no new completion path. "delivering" = handed to courier (TZ §4); leaving it (delivered,
    // or anything else) clears the timer.
    syncReminder(rid(req), order);
    await broadcast(rid(req), 'updated', order);
    res.json(order);
  }));

  // "Yetkazildi" / "Jarayonda" from a reminder notification (FCM/Socket.IO tap or Telegram-style
  // in-app button). Delegates entirely to reminderAck() above — same completion path as /status.
  secured.post('/orders/:id/reminder/ack', wrap(async (req, res) => {
    const { action } = parse(ReminderAck, req.body);
    res.json(await reminderAck(rid(req), req.params.id, action));
  }));
  secured.get('/reminders/stalled', wrap(async (req, res) => res.json(reminders.stalledFor(rid(req)))));

  secured.get('/stats/today', wrap(async (req, res) => res.json(await upstream.stats(rid(req)))));

  secured.post('/devices/fcm', wrap(async (req, res) => {
    const d = parse(Device, req.body);
    devices.register(rid(req), req.auth.userId, d.deviceId, d.token);
    res.status(204).end();
  }));
  secured.delete('/devices/fcm', wrap(async (req, res) => {
    const d = parse(Device, req.body);
    devices.unregister(rid(req), d.deviceId, d.token); // scoped to the caller's restaurant
    res.status(204).end();
  }));

  api.use(secured);
  app.use('/restaurant/v1', api);

  app.use((_req, _res, next) => next(NotFound('Topilmadi')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON noto\'g\'ri', code: 'bad_request' });
    log.error('[error]', err);
    res.status(500).json({ error: 'Ichki xatolik', code: 'internal' });
  });
  return app;
}
