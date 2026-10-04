import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/server.js';
import { GatewayUpstream } from '../src/upstream/gateway.js';
import { baseConfig, FakePush, once } from './helpers.js';
import { startFakeServer, KEY, RID, OTHER_RID } from './fake-lokma-server.js';
import { io as connect } from 'socket.io-client';

const V = '/restaurant/v1', id = (n) => String(n).padStart(24, '0');
let fake, bff, url, token, push;
const api = async (method, path, { body, headers } = {}) => {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token && !headers?.noauth ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
};
const hook = (body, extra = {}) => api('POST', '/internal/orders/events', { body, headers: { 'x-webhook-secret': 'hook-secret', noauth: 1, ...extra } });

before(async () => {
  fake = await startFakeServer();
  push = new FakePush();
  const config = baseConfig({ upstreamMode: 'gateway', gateway: { url: fake.url, password: KEY, header: 'x-gateway-key' } });
  bff = await start({ config, push, log: { log() {}, warn() {}, error() {} }, upstream: new GatewayUpstream({ ...config.gateway, authMode: 'credentials' }) });
  url = `http://127.0.0.1:${bff.port}`;
  token = (await api('POST', `${V}/auth/login`, { body: { login: 'totli', password: 'parol123' }, headers: { noauth: 1 } })).body.token;
});
after(async () => { await bff.close(); await fake.close(); });

test('login = restaurant\'s own login + password: ok -> JWT with restaurantId inside, no secrets in the response', async () => {
  const r = await api('POST', `${V}/auth/login`, { body: { login: 'totli', password: 'parol123' }, headers: { noauth: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.restaurant, { id: RID, name: 'TOTLI' });
  assert.equal(r.body.user.login, 'totli'); // the Android DTO requires user.login
  assert.ok(!/passwordHash|must-never/.test(JSON.stringify(r.body)));
  const payload = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.rid, RID); // restaurantId comes from the server's answer, never from the request
});

test('login: wrong password -> 401; blocked login -> 429 login_blocked + retryAfter; a refused service key is a 502, NOT "wrong password"', async () => {
  const login = (l, p) => api('POST', `${V}/auth/login`, { body: { login: l, password: p }, headers: { noauth: 1 } });
  assert.equal((await login('totli', 'xato')).status, 401);
  assert.equal((await login('yoq-odam', 'parol123')).status, 401);
  const blocked = await login('blocked', 'x');
  assert.equal(blocked.status, 429); assert.equal(blocked.body.code, 'login_blocked'); assert.equal(blocked.body.retryAfter, 30);
  const wrongKey = new GatewayUpstream({ url: fake.url, password: 'z'.repeat(24), header: 'x-gateway-key', authMode: 'credentials' });
  await assert.rejects(wrongKey.authenticate('totli', 'parol123'), (e) => e.status === 502 && e.code === 'upstream_auth');
});

test('AUTH_MODE=pin (restaurantId + PIN) still works: ok / wrong / unknown id / malformed id never reaches the server / blocked', async () => {
  const pin = new GatewayUpstream({ url: fake.url, password: KEY, header: 'x-gateway-key', authMode: 'pin' });
  const ok = await pin.authenticate(RID, '1234');
  assert.deepEqual(ok.restaurant, { id: RID, name: 'TOTLI' }); assert.equal(ok.user.login, RID);
  assert.ok(!/payout|8600|deliveryMarkup|pinHash/.test(JSON.stringify(ok)));
  assert.equal(await pin.authenticate(RID, '0000'), null);
  assert.equal(await pin.authenticate(OTHER_RID, '1234'), null);
  const before = fake.stats.requests.length;
  assert.equal(await pin.authenticate('../../etc', '1234'), null);
  assert.equal(fake.stats.requests.length, before);
  await assert.rejects(pin.authenticate(RID, '9999'), (e) => e.status === 429 && e.code === 'pin_blocked' && e.retryAfter === undefined && e.details.retryAfter === 30);
});

test('order mapping is an allow-list: no finance, customer wallet, courier placeholder, telegram id', async () => {
  const o = (await api('GET', `${V}/orders/${id(1)}`)).body;
  assert.equal(o.id, id(1)); assert.equal(o.number, '0001'); assert.equal(o.total, 41200); assert.equal(o.itemsCount, 2);
  assert.equal(o.address, 'Uy — Sohil — 2-qavat'); assert.equal(o.lat, 41.28); assert.equal(o.items[0].price, 10000);
  const dump = JSON.stringify(o);
  for (const bad of ['finance', 'lokmaNetCommission', 'userId', 'cards', 'bonusBalance', 'courierName', 'telegramId', 'payout']) assert.ok(!dump.includes(bad), bad);
});

test('pending list is queue-ordered (oldest first); other lists newest first; other restaurant\'s order is invisible', async () => {
  const pending = (await api('GET', `${V}/orders/pending`)).body;
  assert.deepEqual(pending.map((o) => o.id), [id(1), id(2)]);
  assert.ok(!pending.some((o) => o.id === id(5)));
  assert.equal((await api('GET', `${V}/orders/${id(5)}`)).status, 404);
  assert.equal((await api('GET', `${V}/orders/not-an-id`)).status, 404); // CAST never leaks as 400
});

test('accept: sequential duplicate is idempotent (200); a real race -> 409 already_handled', async () => {
  assert.equal((await api('POST', `${V}/orders/${id(1)}/accept`)).status, 200);
  const again = await api('POST', `${V}/orders/${id(1)}/accept`);
  assert.equal(again.status, 200); assert.equal(again.body.status, 'accepted');
  fake.stats.raceOnce.add(id(2));
  const lost = await api('POST', `${V}/orders/${id(2)}/accept`);
  assert.equal(lost.status, 409); assert.equal(lost.body.code, 'already_handled');
});

test('delivery order: "Yetkazildi" too early -> 409 confirm_too_early + eligibleAt; after eligible -> completed exactly once', async () => {
  const early = await api('POST', `${V}/orders/${id(4)}/reminder/ack`, { body: { action: 'delivered' } });
  assert.equal(early.status, 409); assert.equal(early.body.code, 'confirm_too_early'); assert.ok(early.body.eligibleAt);
  assert.equal((await api('GET', `${V}/orders/${id(4)}`)).body.status, 'delivering');

  fake.setEligible(id(4));
  const [a, b] = await Promise.all([
    api('POST', `${V}/orders/${id(4)}/status`, { body: { status: 'delivered' } }),
    api('POST', `${V}/orders/${id(4)}/reminder/ack`, { body: { action: 'delivered' } }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 409));
  assert.equal((await api('GET', `${V}/orders/${id(4)}`)).body.status, 'delivered');
  assert.equal(fake.stats.settled.get(id(4)), 1); // finance ran once
  const third = await api('POST', `${V}/orders/${id(4)}/status`, { body: { status: 'delivered' } });
  assert.equal(third.status, 200); assert.equal(fake.stats.settled.get(id(4)), 1);
});

test('pickup order is closed with the normal PATCH; wrong transition -> 400 wrong_state', async () => {
  const done = await api('POST', `${V}/orders/${id(3)}/status`, { body: { status: 'delivered' } });
  assert.equal(done.status, 200); assert.equal(done.body.status, 'delivered');
  const bad = await api('POST', `${V}/orders/${id(1)}/status`, { body: { status: 'ready' } }); // accepted->ready is allowed by the server
  assert.equal(bad.status, 200);
  const worse = await api('POST', `${V}/orders/${id(1)}/status`, { body: { status: 'accepted' } });
  assert.equal(worse.status, 400); assert.equal(worse.body.code, 'wrong_state');
});

test('OUR service key rejected by the server is a 502, never a 401 (a 401 would log every phone out)', async () => {
  const wrong = await start({
    config: baseConfig({ upstreamMode: 'gateway', gateway: { url: fake.url, password: 'z'.repeat(24), header: 'x-gateway-key' } }),
    push: new FakePush(), log: { log() {}, warn() {}, error() {} },
    upstream: new GatewayUpstream({ url: fake.url, password: 'z'.repeat(24), header: 'x-gateway-key' }),
  });
  try {
    const r = await fetch(`http://127.0.0.1:${wrong.port}${V}/orders/pending`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 502); assert.equal((await r.json()).code, 'upstream_auth');
  } finally { await wrong.close(); }
});

test('the PIN never appears in errors or in service-route requests', async () => {
  const svc = fake.stats.requests.filter((r) => r.path.includes('/service/'));
  assert.ok(svc.length > 5);
  assert.ok(svc.every((r) => !r.path.includes('1234') && !r.path.includes('parol123'))); // secrets never travel in a URL
  assert.ok(svc.filter((r) => r.key === KEY).length > 5);
});

test('webhook: created -> socket order:new (mapped, safe) + push; echo of our own change is dropped; duplicate x-event-id ignored', async () => {
  const sk = await new Promise((res, rej) => { const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
  push.sent.length = 0;
  const gotNew = once(sk, 'order:new');
  assert.equal((await hook({ event: 'created', restaurantId: RID, orderId: id(2) }, { 'x-event-id': 'e1' })).status, 202);
  const o = await gotNew;
  assert.equal(o.id, id(2)); assert.ok(!JSON.stringify(o).includes('finance'));
  assert.deepEqual(push.sent.map((p) => p.type), ['order_new']);

  assert.equal((await hook({ event: 'created', restaurantId: RID, orderId: id(2) }, { 'x-event-id': 'e1' })).body.duplicate, true);
  assert.equal(push.sent.length, 1);

  // our own accept -> the server echoes an "updated" with the same status: must not double-notify
  const mine = await api('POST', `${V}/orders/${id(2)}/accept`);
  assert.equal(mine.status, 200);
  const n = push.sent.length;
  const echo = await hook({ event: 'updated', restaurantId: RID, orderId: id(2) }, { 'x-event-id': 'e2' });
  assert.equal(echo.body.echo, true); assert.equal(push.sent.length, n);
  sk.close();
});

test('webhook: hidden/unknown order is acknowledged (no endless retries); "delivered"/unknown events are accepted', async () => {
  const hidden = await hook({ event: 'created', restaurantId: RID, orderId: id(99) });
  assert.equal(hidden.status, 202); assert.equal(hidden.body.ignored, true);
  assert.equal((await hook({ event: 'delivered', restaurantId: RID, orderId: id(3) })).status, 202);
  assert.equal((await hook({ event: '', restaurantId: RID, orderId: id(3) })).status, 400);
});

test('an order that becomes "delivering" OUTSIDE the BFF (courier link) starts reminder tracking; leaving it clears it', async () => {
  const o = fake.orders.get(id(2)); o.status = 'delivering';
  assert.equal(bff.reminders.get(id(2)), null);
  await hook({ event: 'updated', restaurantId: RID, orderId: id(2) });
  assert.ok(bff.reminders.get(id(2)));
  o.status = 'delivered';
  await hook({ event: 'delivered', restaurantId: RID, orderId: id(2) });
  assert.equal(bff.reminders.get(id(2)), null);
});

test('stats is explicitly not connected yet (501), never silent zeros', async () => {
  const r = await api('GET', `${V}/stats/today`);
  assert.equal(r.status, 501); assert.equal(r.body.code, 'not_implemented');
});
