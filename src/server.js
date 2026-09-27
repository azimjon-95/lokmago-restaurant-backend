import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config as envConfig, assertConfig } from './config.js';
import { DeviceStore } from './devices.js';
import { Push } from './push.js';
import { MockUpstream } from './upstream/mock.js';
import { GatewayUpstream } from './upstream/gateway.js';
import { createApp } from './app.js';
import { createRealtime } from './realtime.js';
import { ReminderStore } from './reminders.js';
import { createReminderScheduler } from './scheduler.js';

/**
 * Boots HTTP + Socket.IO + the delivery-reminder scheduler. Everything is injectable so tests
 * can pass their own config / push double. Rejects BEFORE listening on unsafe config (mock
 * upstream or weak secrets in production).
 */
export async function start({ config = envConfig, push, log = console, upstream, devices, reminders } = {}) {
  assertConfig(config);
  upstream ??= config.upstreamMode === 'mock' ? new MockUpstream() : new GatewayUpstream(config.gateway);
  devices ??= new DeviceStore(config.deviceStoreFile);
  push ??= new Push(config.firebase, devices, log);
  reminders ??= new ReminderStore(config.reminderStoreFile, config.reminder);

  let realtime;
  const hub = { emit: (rid, event, payload) => realtime.emit(rid, event, payload) }; // bound once the HTTP server exists
  const app = createApp({ config, upstream, devices, push, hub, reminders, log });
  const server = http.createServer(app);
  realtime = createRealtime(server, {
    jwtSecret: config.jwtSecret, corsOrigins: config.corsOrigins,
    gatewayPassword: config.inboundPassword, gatewayHeader: config.gateway.header,
  });
  const scheduler = createReminderScheduler({ reminders, upstream, hub, push, log, tickMs: config.reminder.tickSeconds * 1000 });
  scheduler.start(); // survives server restarts because ReminderStore is persisted, not in-memory-only

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, resolve); });
  const close = async () => { scheduler.stop(); realtime.io.close(); if (server.listening) await new Promise((r) => server.close(r)); };
  return { port: server.address().port, close, upstream, devices, push, reminders, scheduler, realtime, server };
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
