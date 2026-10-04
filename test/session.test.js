import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const V = '/restaurant/v1';
let t;
before(async () => { t = await boot(); });
after(() => t.close());

test('refresh: a valid session gets a new token for the SAME restaurant; it works; garbage / missing token -> 401', async () => {
  const token = await t.login('admin', 'admin123');
  const r = await t.api('POST', `${V}/auth/refresh`, { token });
  assert.equal(r.status, 200);
  const rid = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).rid;
  assert.equal(rid(r.body.token), rid(token)); // restaurantId copied from the verified token, nothing client-supplied
  assert.equal((await t.api('GET', `${V}/orders/pending`, { token: r.body.token })).status, 200);
  assert.equal((await t.api('POST', `${V}/auth/refresh`)).status, 401);
  assert.equal((await t.api('POST', `${V}/auth/refresh`, { token: 'garbage' })).status, 401);
  assert.equal((await t.api('POST', `${V}/auth/refresh`, { token, body: { restaurantId: 'r2' } })).status, 200); // body is ignored
});

test('login response always carries user.login (the Android DTO requires it)', async () => {
  const r = await t.api('POST', `${V}/auth/login`, { body: { login: 'admin', password: 'admin123' } });
  assert.equal(r.body.user.login, 'admin');
});

test('login limiter counts FAILED attempts only: many successful logins never lock anyone out; the 6th failure does', async () => {
  const dev = await boot({ env: 'development' }); // the limiter is relaxed only in env=test
  try {
    for (let i = 0; i < 8; i++) assert.equal((await dev.api('POST', `${V}/auth/login`, { body: { login: 'admin', password: 'admin123' } })).status, 200);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await dev.api('POST', `${V}/auth/login`, { body: { login: 'admin', password: 'nope' } })).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  } finally { await dev.close(); }
});
