import { io as connect } from 'socket.io-client';
import { start } from '../src/server.js';

export const baseConfig = (over = {}) => ({
  env: 'test', port: 0, jwtSecret: 'test-secret-test-secret', jwtTtl: '1h', upstreamMode: 'mock',
  gateway: { url: '', password: '', header: 'x-gateway-password' }, inboundPassword: '', trustProxy: '0',
  webhookSecret: 'hook-secret', firebase: {}, corsOrigins: [], deviceStoreFile: '',
  android: { minimumVersion: '1.0.0', latestVersion: '1.0.1', forceUpdate: false }, ...over,
});

export class FakePush {
  enabled = true; sent = [];
  async orderNew(rid, order) { this.sent.push({ rid, type: 'order_new', id: order.id }); }
  async orderChanged(rid, order, type = 'order_updated') { this.sent.push({ rid, type, id: order.id }); }
}

const silent = { log() {}, warn() {}, error() {} };

export async function boot(over = {}) {
  const push = new FakePush();
  const s = await start({ config: baseConfig(over), push, log: silent });
  const url = `http://127.0.0.1:${s.port}`;
  const api = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(url + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (l, p) => (await api('POST', '/restaurant/v1/auth/login', { body: { login: l, password: p } })).body.token;
  const spawn = (id, count = 1) => api('POST', '/internal/dev/orders', { headers: { 'x-webhook-secret': 'hook-secret' }, body: { restaurantId: id, count } });
  const socket = (token, opts = {}) => new Promise((resolve, reject) => {
    const sk = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, ...opts });
    sk.on('connect', () => resolve(sk)); sk.on('connect_error', reject);
  });
  return { ...s, url, api, login, spawn, socket, fakePush: push };
}

export const once = (sk, ev, ms = 2000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  sk.once(ev, (p) => { clearTimeout(t); res(p); });
});
