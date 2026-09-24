import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { safeEqual } from './auth.js';

export const room = (rid) => `restaurant:${rid}`;

/**
 * Socket.IO: JWT in the handshake, room derived from the TOKEN (never from client-supplied ids).
 * Events out:  order:new  |  order:updated
 */
export function createRealtime(httpServer, { jwtSecret, corsOrigins, gatewayPassword = '', gatewayHeader = 'x-gateway-password' }) {
  const io = new Server(httpServer, { cors: corsOrigins.length ? { origin: corsOrigins } : undefined, pingInterval: 15_000, pingTimeout: 10_000 });
  io.use((socket, next) => {
    if (gatewayPassword) {
      const got = socket.handshake.headers[gatewayHeader.toLowerCase()];
      if (typeof got !== 'string' || !safeEqual(got, gatewayPassword)) return next(new Error('unauthorized'));
    }
    try {
      const p = jwt.verify(String(socket.handshake.auth?.token ?? ''), jwtSecret);
      socket.data.auth = { userId: p.sub, restaurantId: p.rid };
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (socket) => { socket.join(room(socket.data.auth.restaurantId)); });
  return { io, emit: (rid, event, payload) => io.to(room(rid)).emit(event, payload) };
}
