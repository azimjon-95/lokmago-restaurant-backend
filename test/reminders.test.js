import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, once } from './helpers.js';
import { ReminderStore } from '../src/reminders.js';

let t, admin, other;
const V = '/restaurant/v1';
const MIN = 60_000;

before(async () => {
  t = await boot();
  admin = await t.login('admin', 'admin123');
  other = await t.login('other', 'other123');
});
after(() => t.close());
// Every test hands a fresh order to the courier — reset reminder tracking between tests so an
// order left scheduled/stalled by a previous test can never be the one a scheduler.tick() picks up.
beforeEach(() => t.reminders.map.clear());

/** Drives an order to 'delivering' and returns its id. */
async function handedToCourier(token = admin, restaurantId = 'r1') {
  const id = (await t.spawn(restaurantId)).body.created[0];
  const st = (status) => t.api('POST', `${V}/orders/${id}/status`, { token, body: { status } });
  await t.api('POST', `${V}/orders/${id}/accept`, { token });
  await st('preparing'); await st('ready'); await st('delivering');
  return id;
}

test('scheduling starts only once the order is handed to the courier (delivering)', async () => {
  const id = (await t.spawn('r1')).body.created[0];
  assert.equal(t.reminders.get(id), null); // still pending — nothing scheduled yet
  await t.api('POST', `${V}/orders/${id}/accept`, { token: admin });
  assert.equal(t.reminders.get(id), null); // accepted, preparing, ready — still nothing
  await t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status: 'preparing' } });
  await t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status: 'ready' } });
  assert.equal(t.reminders.get(id), null);
  await t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status: 'delivering' } });
  const e = t.reminders.get(id);
  assert.ok(e && e.reminderCount === 0 && e.nextReminderAt > Date.now());
});

test('no response: reminder fires at T+30, again at T+60, again at T+90, then stops (no auto-complete)', async () => {
  const id = await handedToCourier();
  const phone = await t.socket(admin);
  const t0 = Date.now();
  t.fakePush.sent.length = 0;

  const r1 = once(phone, 'order:delivery-reminder');
  await t.scheduler.tick(t0 + 31 * MIN);
  assert.deepEqual(await r1, { orderId: id, reminderCount: 1 });
  assert.equal(t.fakePush.sent.at(-1).type, 'order_delivery_reminder');
  assert.equal(t.fakePush.sent.at(-1).reminderCount, 1);

  // ticking again immediately (still "T+31") must NOT resend
  await t.scheduler.tick(t0 + 31 * MIN + 1000);
  assert.equal(t.fakePush.sent.length, 1);

  const r2 = once(phone, 'order:delivery-reminder');
  await t.scheduler.tick(t0 + 61 * MIN);
  assert.deepEqual(await r2, { orderId: id, reminderCount: 2 });

  const r3 = once(phone, 'order:delivery-reminder');
  await t.scheduler.tick(t0 + 91 * MIN);
  assert.deepEqual(await r3, { orderId: id, reminderCount: 3 });

  // max reached (REMINDER_MAX_COUNT=3) — further ticks send nothing more, order is NOT auto-completed
  let extra = false;
  phone.once('order:delivery-reminder', () => { extra = true; });
  await t.scheduler.tick(t0 + 500 * MIN);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(extra, false);
  assert.equal((await t.api('GET', `${V}/orders/${id}`, { token: admin })).body.status, 'delivering');
  const stalled = (await t.api('GET', `${V}/reminders/stalled`, { token: admin })).body;
  assert.ok(stalled.some((s) => s.orderId === id && s.reminderCount === 3));
  phone.close();
});

test('"Jarayonda" (in_progress) via the HTTP route: 200, order status untouched, reminder count untouched', async () => {
  const id = await handedToCourier();
  await t.scheduler.tick(Date.now() + 31 * MIN);
  assert.equal(t.reminders.get(id).reminderCount, 1);

  const ack = await t.api('POST', `${V}/orders/${id}/reminder/ack`, { token: admin, body: { action: 'in_progress' } });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, 'delivering'); // unchanged — this is not a completion action
  assert.equal(t.reminders.get(id).reminderCount, 1); // ack does not bump the count
});

test('ReminderStore.ack: postpones nextReminderAt by REPEAT_MINUTES without bumping the count (store-level, single clock)', () => {
  const store = new ReminderStore('', { delayMinutes: 30, repeatMinutes: 30, maxCount: 3 });
  const t0 = Date.now();
  store.scheduleIfNeeded('r1', 'oX', t0);
  store.recordSent('oX', t0 + 31 * MIN); // 1st reminder actually sent
  const before1 = store.get('oX');
  assert.equal(before1.reminderCount, 1);

  store.ack('oX', before1.nextReminderAt - 5 * MIN); // "Jarayonda" pressed 5 min before it would've fired again
  const after1 = store.get('oX');
  assert.equal(after1.reminderCount, 1); // still not bumped
  assert.equal(after1.nextReminderAt, before1.nextReminderAt - 5 * MIN + 30 * MIN); // pushed exactly REPEAT_MINUTES further out
  assert.ok(after1.nextReminderAt > before1.nextReminderAt);
});

test('"Yetkazildi" (delivered) uses the existing completion path and clears the reminder — repeat click is a safe no-op (409)', async () => {
  const id = await handedToCourier();
  await t.scheduler.tick(Date.now() + 31 * MIN);
  assert.ok(t.reminders.get(id));

  const done = await t.api('POST', `${V}/orders/${id}/reminder/ack`, { token: admin, body: { action: 'delivered' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'delivered');
  assert.equal(t.reminders.get(id), null); // cleared

  const again = await t.api('POST', `${V}/orders/${id}/reminder/ack`, { token: admin, body: { action: 'delivered' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'already_handled'); // idempotent: no second completion, no double finance call
});

test('cancelled orders (out-of-band on the upstream) are never reminded — self-heals on next tick', async () => {
  const id = await handedToCourier();
  t.upstream.orders.get(id).status = 'cancelled'; // simulates lakmago-server cancelling it
  t.fakePush.sent.length = 0;
  await t.scheduler.tick(Date.now() + 31 * MIN);
  assert.equal(t.fakePush.sent.length, 0);
  assert.equal(t.reminders.get(id), null); // scheduler dropped it
});

test('pickup / dine-in orders never enter "delivering" so are never reminded', async () => {
  const id = (await t.api('POST', '/internal/dev/orders', { headers: { 'x-webhook-secret': 'hook-secret' }, body: { restaurantId: 'r1', fulfillment: 'pickup' } })).body.created[0];
  await t.api('POST', `${V}/orders/${id}/accept`, { token: admin });
  await t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status: 'preparing' } });
  await t.api('POST', `${V}/orders/${id}/status`, { token: admin, body: { status: 'ready' } });
  assert.equal(t.reminders.get(id), null);
});

test('duplicate job: scheduling the same order twice creates only one entry', async () => {
  const id = await handedToCourier();
  const first = t.reminders.get(id);
  const created = t.reminders.scheduleIfNeeded('r1', id);
  assert.equal(created, false);
  assert.deepEqual(t.reminders.get(id), first);
});

test('reminder-ack is restaurant-scoped: another restaurant cannot ack or read my reminder', async () => {
  const id = await handedToCourier();
  const ackOther = await t.api('POST', `${V}/orders/${id}/reminder/ack`, { token: other, body: { action: 'in_progress' } });
  assert.equal(ackOther.status, 404);
  assert.ok(t.reminders.get(id)); // untouched
});

test('Telegram callback contract: requires the webhook secret and re-checks restaurant ownership, not just the callback body', async () => {
  const id = await handedToCourier();
  const body = { restaurantId: 'r1', orderId: id, action: 'delivered' };
  const noSecret = await t.api('POST', '/internal/telegram/reminder-callback', { body });
  assert.equal(noSecret.status, 401);

  const wrongRestaurant = await t.api('POST', '/internal/telegram/reminder-callback', {
    headers: { 'x-webhook-secret': 'hook-secret' }, body: { ...body, restaurantId: 'r2' },
  });
  assert.equal(wrongRestaurant.status, 404); // r2 does not own this order

  const ok = await t.api('POST', '/internal/telegram/reminder-callback', { headers: { 'x-webhook-secret': 'hook-secret' }, body });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.status, 'delivered');
});

test('server restart safety: a persisted ReminderStore survives being re-opened from disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lokma-rem-')), 'reminders.json');
  const cfg = { delayMinutes: 30, repeatMinutes: 30, maxCount: 3 };
  const a = new ReminderStore(file, cfg);
  a.scheduleIfNeeded('r1', 'o999', Date.now());
  const restarted = new ReminderStore(file, cfg); // simulates a fresh process reading the same file
  const e = restarted.get('o999');
  assert.ok(e && e.restaurantId === 'r1' && e.reminderCount === 0);
});
