import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config as envConfig, assertConfig } from './config.js';
import { DeviceStore } from './devices.js';
import { Push } from './push.js';
import { MockUpstream } from './upstream/mock.js';
import { GatewayUpstream } from './upstream/gateway.js';
import { createApp } from './app.js';
import { createRealtime } from './realtime.js';

/**
 * Boots HTTP + Socket.IO. Everything is injectable so tests can pass their own config / push double.
 * Rejects BEFORE listening on unsafe config (mock upstream or weak secrets in production).
 */
export async function start({ config = envConfig, push, log = console, upstream, devices } = {}) {
  assertConfig(config);
  upstream ??= config.upstreamMode === 'mock' ? new MockUpstream() : new GatewayUpstream(config.gateway);
  devices ??= new DeviceStore(config.deviceStoreFile);
  push ??= new Push(config.firebase, devices, log);

  let realtime;
  const hub = { emit: (rid, event, payload) => realtime.emit(rid, event, payload) }; // bound once the HTTP server exists
  const app = createApp({ config, upstream, devices, push, hub, log });
  const server = http.createServer(app);
  realtime = createRealtime(server, {
    jwtSecret: config.jwtSecret, corsOrigins: config.corsOrigins,
    gatewayPassword: config.inboundPassword, gatewayHeader: config.gateway.header,
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, resolve); });
  const close = async () => { realtime.io.close(); if (server.listening) await new Promise((r) => server.close(r)); };
  return { port: server.address().port, close, upstream, devices, push, realtime, server };
}

// Run as a service: `node src/server.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await start();
  if (envConfig.upstreamMode === 'mock') {
    console.warn('[server] UPSTREAM_MODE=mock — faqat development uchun. Test loginlar: admin/admin123');
    s.upstream.createOrder('r1');
  }
  console.log(`[server] :${s.port} (${envConfig.env}, upstream=${envConfig.upstreamMode}, push=${s.push.enabled})`);
  const stop = () => { console.log('[server] to\'xtatilmoqda…'); s.close().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
