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
  event: z.enum(['created', 'updated', 'cancelled']),
  restaurantId: z.string().min(1),
  orderId: z.string().min(1),
});

/** @param hub { emit(restaurantId, event, payload) } — Socket.IO fan-out (wired after the HTTP server exists) */
export function createApp({ config, upstream, devices, push, hub, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'true' ? true : Number(config.trustProxy) || false);
  app.use(helmet());
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '64kb' }));

  const health = (_req, res) => res.json({ ok: true, push: push.enabled, upstream: config.upstreamMode });
  app.get('/health', health);

  /** Tell every phone of the restaurant over both channels; a failing channel never breaks the other. */
  async function broadcast(restaurantId, event, order) {
    hub.emit(restaurantId, event === 'created' ? 'order:new' : 'order:updated', order);
    try {
      if (event === 'created') await push.orderNew(restaurantId, order);
      else await push.orderChanged(restaurantId, order, event === 'cancelled' ? 'order_cancelled' : 'order_updated');
    } catch (e) { log.error('[push] yuborilmadi:', e.message); }
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
    const order = await upstream.getOrder(restaurantId, orderId); // source of truth is the upstream, not the webhook body
    await broadcast(restaurantId, event, order);
    res.status(202).json({ ok: true });
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

  api.post('/auth/login',
    rateLimit({ windowMs: 15 * 60_000, limit: config.env === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
      message: { error: 'Juda ko\'p urinish. Keyinroq qayta urining', code: 'rate_limited' } }),
    wrap(async (req, res) => {
      const { login, password } = parse(Login, req.body);
      const r = await upstream.authenticate(login, password);
      if (!r) throw Unauthorized();
      const token = signToken(config, { userId: String(r.user.id), restaurantId: String(r.restaurant.id) });
      res.json({ token, user: r.user, restaurant: r.restaurant });
    }));

  const secured = express.Router();
  secured.use(requireAuth(config));
  const rid = (req) => req.auth.restaurantId; // ALWAYS from the verified token

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
    await broadcast(rid(req), 'updated', order);
    res.json(order);
  }));

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
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON noto\'g\'ri', code: 'bad_request' });
    log.error('[error]', err);
    res.status(500).json({ error: 'Ichki xatolik', code: 'internal' });
  });
  return app;
}
