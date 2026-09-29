import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Unauthorized } from './errors.js';

export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** restaurantId ("rid") is written into the token by the server at login — never taken from the client. */
export const signToken = (cfg, { userId, restaurantId }) =>
  jwt.sign({ sub: userId, rid: restaurantId }, cfg.jwtSecret, { expiresIn: cfg.jwtTtl, algorithm: 'HS256' });

export function requireAuth(cfg) {
  return (req, _res, next) => {
    const h = req.headers.authorization ?? '';
    try {
      const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', cfg.jwtSecret, { algorithms: ['HS256'] });
      if (!p.rid || !p.sub) throw new Error('bad claims');
      req.auth = { userId: p.sub, restaurantId: p.rid };
      next();
    } catch { next(Unauthorized('Sessiya tugagan, qayta kiring')); }
  };
}

/** Optional shared password checked at the API gateway boundary (REST + socket handshake). */
export function gatewayGuard(cfg) {
  return (req, _res, next) => {
    if (!cfg.inboundPassword) return next();
    const got = req.headers[cfg.inboundHeader.toLowerCase()];
    return typeof got === 'string' && safeEqual(got, cfg.inboundPassword) ? next() : next(Unauthorized('Gateway paroli noto\'g\'ri'));
  };
}
