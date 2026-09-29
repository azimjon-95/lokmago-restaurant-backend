import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { assertConfig } from '../src/config.js';
import { baseConfig } from './helpers.js';

test('gateway password is enforced on REST and socket when configured', async () => {
  const t = await boot({ inboundPassword: 'gw-secret' });
  try {
    const body = { login: 'admin', password: 'admin123' };
    assert.equal((await t.api('POST', '/restaurant/v1/auth/login', { body })).status, 401);
    assert.equal((await t.api('POST', '/restaurant/v1/auth/login', { body, headers: { 'x-gateway-password': 'wrong' } })).status, 401);
    const ok = await t.api('POST', '/restaurant/v1/auth/login', { body, headers: { 'x-gateway-password': 'gw-secret' } });
    assert.equal(ok.status, 200);
    await assert.rejects(t.socket(ok.body.token));
    const sk = await t.socket(ok.body.token, { extraHeaders: { 'x-gateway-password': 'gw-secret' } });
    sk.close();
  } finally { await t.close(); }
});

test('production refuses mock upstream and weak secrets', () => {
  assert.throws(() => assertConfig(baseConfig({ env: 'production' })), /mock/);
  assert.throws(() => assertConfig(baseConfig({ jwtSecret: 'short' })), /JWT_SECRET/);
  assert.doesNotThrow(() => assertConfig(baseConfig({ env: 'production', upstreamMode: 'gateway', gateway: { url: 'https://g', password: 'k'.repeat(24), header: 'h' } })));
  assert.throws(() => assertConfig(baseConfig({ env: 'production', upstreamMode: 'gateway', gateway: { url: 'https://g', password: 'short', header: 'h' } })), /API_GATEWAY_PASSWORD/);
  assert.throws(() => assertConfig(baseConfig({ env: 'production', upstreamMode: 'gateway', gateway: { url: 'http://g', password: 'k'.repeat(24), header: 'h' } })), /https/);
});

test('dev helper endpoint does not exist in production', async () => {
  const t = await boot({ env: 'production', upstreamMode: 'mock' }).catch((e) => e);
  assert.ok(t instanceof Error && /mock/.test(t.message));
});
