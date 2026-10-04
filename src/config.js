import 'dotenv/config';

const env = (k, d = '') => (process.env[k] ?? d).trim();
export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '8080')),
  jwtSecret: env('JWT_SECRET'),
  jwtTtl: env('JWT_TTL', '30d'),
  upstreamMode: env('UPSTREAM_MODE', 'mock'),
  // pin = restaurantId + PIN via the server's PIN route (works today); credentials = the restaurant's own login + password
  // via POST /app/service/auth/login (needs the main-server endpoint, see README).
  authMode: env('AUTH_MODE', 'pin'),
  gateway: {
    url: env('API_GATEWAY_URL').replace(/\/+$/, ''),
    password: env('API_GATEWAY_PASSWORD'),
    header: env('API_GATEWAY_HEADER', 'x-gateway-key'), // OUTBOUND: service key sent to lakmago-server /app/service/...
  },
  inboundPassword: env('GATEWAY_INBOUND_PASSWORD'),
  inboundHeader: env('GATEWAY_INBOUND_HEADER', 'x-gateway-password'), // INBOUND: what the Android app sends
  trustProxy: env('TRUST_PROXY', '1'),
  webhookSecret: env('INTERNAL_WEBHOOK_SECRET'),
  firebase: { file: env('FIREBASE_SERVICE_ACCOUNT_FILE'), base64: env('FIREBASE_SERVICE_ACCOUNT_BASE64') },
  corsOrigins: env('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),
  deviceStoreFile: env('DEVICE_STORE_FILE'),
  reminderStoreFile: env('REMINDER_STORE_FILE'),
  reminder: {
    delayMinutes: Number(env('REMINDER_DELAY_MINUTES', '30')),
    repeatMinutes: Number(env('REMINDER_REPEAT_MINUTES', '30')),
    maxCount: Number(env('REMINDER_MAX_COUNT', '3')),
    tickSeconds: Number(env('REMINDER_TICK_SECONDS', '30')),
  },
  android: {
    minimumVersion: env('ANDROID_MIN_VERSION', '1.0.0'),
    latestVersion: env('ANDROID_LATEST_VERSION', '1.0.0'),
    forceUpdate: env('ANDROID_FORCE_UPDATE', 'false') === 'true',
  },
};

/** Fail fast on unsafe production config. */
export function assertConfig(c = config) {
  const errors = [];
  if (!c.jwtSecret || c.jwtSecret.length < 16) errors.push('JWT_SECRET kamida 16 belgi bo\'lishi kerak');
  if (c.env === 'production') {
    if (c.upstreamMode === 'mock') errors.push('production\'da UPSTREAM_MODE=mock ruxsat etilmaydi');
    if (!c.webhookSecret) errors.push('INTERNAL_WEBHOOK_SECRET majburiy');
  }
  if (c.upstreamMode === 'gateway') {
    if (!c.gateway.url) errors.push('API_GATEWAY_URL majburiy (UPSTREAM_MODE=gateway)');
    if (c.env === 'production' && !c.gateway.url.startsWith('https://')) errors.push('API_GATEWAY_URL production\'da https bo\'lishi shart');
    // lakmago-server refuses the service route unless the key is >= 24 chars (fail-closed), so fail here first.
    if (c.env === 'production' && (c.gateway.password || '').length < 24) errors.push('API_GATEWAY_PASSWORD (servis kaliti, GATEWAY_SERVICE_KEY) kamida 24 belgi bo\'lishi kerak');
  }
  if (!['pin', 'credentials'].includes(c.authMode)) errors.push('AUTH_MODE: pin yoki credentials bo\'lishi kerak');
  const { delayMinutes, repeatMinutes, maxCount, tickSeconds } = c.reminder;
  if (![delayMinutes, repeatMinutes, maxCount, tickSeconds].every((n) => Number.isFinite(n) && n > 0)) {
    errors.push('REMINDER_* qiymatlari musbat son bo\'lishi kerak');
  }
  if (errors.length) throw new Error('Config xatosi:\n - ' + errors.join('\n - '));
}
