import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, once } from './helpers.js';

let t, admin, operator, other;
const V = '/restaurant/v1';

before(async () => {
  t = await boot();
  admin = await t.login('admin', 'admin123');
  operator = await t.login('operator', 'operator123');
  other = await t.login('other', 'other123');
});
after(() => t.close());

test('login: wrong password -> 401, restaurantId is in token not in request', async () => {
  const bad = await t.api('POST', `${V}/auth/login`, { body: { login: 'admin', password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await t.api('POST', `${V}/auth/login`, { body: { login: 'admin', password: 'admin123', restaurantId: 'r2' } });
  assert.equal(ok.body.restaurant.id, 'r1'); // client-supplied restaurantId ignored
});

test('protected routes require a valid JWT', async () => {
  assert.equal((await t.api('GET', `${V}/orders/pending`)).status, 401);
  assert.equal((await t.api('GET', `${V}/orders/pending`, { token: 'garbage' })).status, 401);
});

test('cross-restaurant isolation: other restaurant cannot read or accept my order', async () => {
  const { body } = await t.spawn('r1');
  const id = body.created[0];
  assert.equal((await t.api('GET', `${V}/orders/${id}`, { token: other })).status, 404);
  assert.equal((await t.api('POST', `${V}/orders/${id}/accept`, { token: other })).status, 404);
  assert.equal((await t.api('GET', `${V}/orders/${id}`, { token: admin })).status, 200);
  const pendingOther = (await t.api('GET', `${V}/orders/pending`, { token: other })).body;
  assert.ok(!pendingOther.some((o) => o.id === id));
  // untouched by the failed attempt
  assert.equal((await t.api('GET', `${V}/orders/${id}`, { token: admin })).body.status, 'pending');
});

test('concurrent accept from two phones: exactly one wins, the other gets 409', async () => {
  const id = (await t.spawn('r1')).body.created[0];
  const [a, b] = await Promise.all([
    t.api('POST', `${V}/orders/${id}/accept`, { token: admin }),
    t.api('POST', `${V}/orders/${id}/accept`, { token: operator }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.code, 'already_handled');
});

test('6 orders pile up: pending recovery returns all, oldest first; accepting one by one drains the queue', async () => {
  const before = (await t.api('GET', `${V}/orders/pending`, { token: admin })).body.length;
  const ids = (await t.spawn('r1', 6)).body.created;
  let pending = (await t.api('GET', `${V}/orders/pending`, { token: admin })).body;
  assert.equal(pending.length, before + 6);
  assert.deepEqual(pending.slice(-6).map((o) => o.id), ids); // creation order = queue order
  for (const id of ids) assert.equal((await t.api('POST', `${V}/orders/${id}/accept`, { token: admin })).status, 200);
  pending = (await t.api('GET', `${V}/orders/pending`, { token: admin })).body;
  assert.equal(pending.length, before);
});

test('status flow: delivery order goes through delivering; pickup skips it; skipping steps is rejected', async () => {
  const d = (await t.spawn('r1')).body.created[0];
  const st = (id, status) => t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status } });
  assert.equal((await st(d, 'ready')).status, 400); // pending -> ready not allowed
  await t.api('POST', `${V}/orders/${d}/accept`, { token: admin });
  for (const s of ['preparing', 'ready', 'delivering', 'delivered']) assert.equal((await st(d, s)).status, 200, s);
  assert.equal((await st(d, 'preparing')).status, 400); // can't go back
  assert.equal((await st(d, 'bogus')).status, 400);

  const pk = (await t.api('POST', '/internal/dev/orders', { headers: { 'x-webhook-secret': 'hook-secret' }, body: { restaurantId: 'r1', fulfillment: 'pickup' } })).body.created[0];
  await t.api('POST', `${V}/orders/${pk}/accept`, { token: admin });
  await st(pk, 'preparing'); await st(pk, 'ready');
  assert.equal((await st(pk, 'delivering')).status, 400);
  assert.equal((await st(pk, 'delivered')).status, 200);
});

test('order:new is delivered over socket to the right restaurant only, and by push once', async () => {
  const mine = await t.socket(admin), theirs = await t.socket(other);
  let leaked = false; theirs.on('order:new', () => { leaked = true; });
  const got = once(mine, 'order:new');
  t.fakePush.sent.length = 0;
  const id = (await t.spawn('r1')).body.created[0];
  const order = await got;
  assert.equal(order.id, id); assert.equal(order.status, 'pending'); assert.equal(order.items.length, 3);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(leaked, false);
  assert.deepEqual(t.fakePush.sent, [{ rid: 'r1', type: 'order_new', id }]);
  mine.close(); theirs.close();
});

test('second phone sees accept in realtime (order:updated)', async () => {
  const phone2 = await t.socket(operator);
  const id = (await t.spawn('r1')).body.created[0];
  const upd = once(phone2, 'order:updated');
  await t.api('POST', `${V}/orders/${id}/accept`, { token: admin });
  const o = await upd;
  assert.equal(o.id, id); assert.equal(o.status, 'accepted');
  phone2.close();
});

test('socket handshake rejects missing / forged tokens', async () => {
  await assert.rejects(t.socket(''));
  await assert.rejects(t.socket('a.b.c'));
});

test('webhook: requires secret; unknown order/restaurant pair is not broadcast', async () => {
  const body = { event: 'created', restaurantId: 'r1', orderId: 'o1' };
  assert.equal((await t.api('POST', '/internal/orders/events', { body })).status, 401);
  assert.equal((await t.api('POST', '/internal/orders/events', { body, headers: { 'x-webhook-secret': 'x' } })).status, 401);
  const id = (await t.spawn('r1')).body.created[0];
  t.fakePush.sent.length = 0;
  const r = await t.api('POST', '/internal/orders/events', { headers: { 'x-webhook-secret': 'hook-secret' }, body: { event: 'created', restaurantId: 'r2', orderId: id } });
  assert.equal(r.status, 202); // unknown/hidden pair: acknowledged (so the server stops retrying) but NOT broadcast
  assert.equal(r.body.ignored, true);
  assert.equal(t.fakePush.sent.length, 0);
});

test('device tokens: register / re-register moves token / unregister is restaurant-scoped', async () => {
  const dev = { token: 'tok-aaaaaaaaaaaa', deviceId: 'dev-1' };
  assert.equal((await t.api('POST', `${V}/devices/fcm`, { token: admin, body: dev })).status, 204);
  assert.deepEqual(t.devices.tokensFor('r1'), ['tok-aaaaaaaaaaaa']);
  // another restaurant cannot unlink it
  await t.api('DELETE', `${V}/devices/fcm`, { token: other, body: dev });
  assert.deepEqual(t.devices.tokensFor('r1'), ['tok-aaaaaaaaaaaa']);
  // phone logs into another restaurant -> token moves
  await t.api('POST', `${V}/devices/fcm`, { token: other, body: { ...dev, deviceId: 'dev-9' } });
  assert.deepEqual(t.devices.tokensFor('r1'), []);
  assert.deepEqual(t.devices.tokensFor('r2'), ['tok-aaaaaaaaaaaa']);
  await t.api('DELETE', `${V}/devices/fcm`, { token: other, body: { ...dev, deviceId: 'dev-9' } }); // logout
  assert.deepEqual(t.devices.tokensFor('r2'), []);
});

test('stats and version endpoints', async () => {
  const s = (await t.api('GET', `${V}/stats/today`, { token: admin })).body;
  assert.equal(s.hourly.length, 24);
  assert.ok(s.ordersCount > 0);
  const v = (await t.api('GET', `${V}/app/version`)).body;
  assert.equal(v.android.latestVersion, '1.0.1');
});
