import crypto from 'node:crypto';
import { Conflict, NotFound } from '../errors.js';
import { allowedNext } from '../status.js';
import { BadRequest } from '../errors.js';

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const mkUser = (id, login, pw, rid, role) => { const salt = crypto.randomBytes(8).toString('hex'); return { id, login, role, rid, salt, hash: hash(pw, salt) }; };

/**
 * In-memory upstream for development & tests ONLY (refused when NODE_ENV=production).
 * Every method is scoped by restaurantId — cross-restaurant access looks like "not found".
 */
export class MockUpstream {
  constructor() {
    this.restaurants = new Map([
      ['r1', { id: 'r1', name: 'Shirin Taom', cuisine: 'Milliy taomlar va fast-fud' }],
      ['r2', { id: 'r2', name: 'Boshqa Restoran', cuisine: 'Pizza' }],
    ]);
    this.users = [mkUser('u1', 'admin', 'admin123', 'r1', 'admin'), mkUser('u2', 'operator', 'operator123', 'r1', 'operator'), mkUser('u3', 'other', 'other123', 'r2', 'admin')];
    this.orders = new Map();
    this.seq = 120;
  }

  async authenticate(login, password) {
    const u = this.users.find((x) => x.login === login);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash(password, u.salt)), Buffer.from(u.hash));
    return ok ? { user: { id: u.id, login: u.login, role: u.role }, restaurant: this.restaurants.get(u.rid) } : null;
  }

  createOrder(restaurantId, partial = {}) {
    const n = ++this.seq;
    const items = partial.items ?? [
      { name: 'Burger Classic', quantity: 1, price: 45000 }, { name: 'Pizza Margarita', quantity: 1, price: 50000 }, { name: 'Coca-Cola 0.5', quantity: 2, price: 8000 },
    ];
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const deliveryFee = partial.deliveryFee ?? 20000;
    const o = {
      id: `o${n}`, number: String(n), restaurantId, status: 'pending', createdAt: Date.now(), fulfillment: 'delivery', paymentMethod: 'card',
      customerName: 'Azizbek', customerPhone: '+998 90 123 45 67', address: 'Toshkent, Yangiobod tumani, Navro\'z ko\'chasi 12-uy', lat: 41.3, lng: 69.27,
      ...partial, items, itemsCount: items.length, subtotal, deliveryFee, total: subtotal + deliveryFee,
    };
    this.orders.set(o.id, o);
    return this.#public(o);
  }

  #public(o) { const { restaurantId, ...rest } = o; return { ...rest }; }
  #own(rid, id) { const o = this.orders.get(id); if (!o || o.restaurantId !== rid) throw NotFound(); return o; }

  async listOrders(rid, { status, limit = 50 } = {}) {
    return [...this.orders.values()].filter((o) => o.restaurantId === rid && (!status || o.status === status))
      .sort((a, b) => a.createdAt - b.createdAt).slice(-limit).map((o) => this.#public(o));
  }
  async getOrder(rid, id) { return this.#public(this.#own(rid, id)); }

  /** Compare-and-set: synchronous, so two concurrent accepts cannot both win. */
  async accept(rid, id) {
    const o = this.#own(rid, id);
    if (o.status !== 'pending') throw Conflict();
    o.status = 'accepted';
    return this.#public(o);
  }

  async setStatus(rid, id, status) {
    const o = this.#own(rid, id);
    if (!allowedNext(o).includes(status)) throw o.status === status ? Conflict('Holat allaqachon o\'rnatilgan') : BadRequest(`"${o.status}" dan "${status}" ga o'tib bo'lmaydi`);
    o.status = status;
    return this.#public(o);
  }

  async stats(rid) {
    const list = [...this.orders.values()].filter((o) => o.restaurantId === rid && o.status !== 'cancelled');
    const hourly = Array(24).fill(0); let cash = 0, card = 0, cashN = 0, cardN = 0;
    for (const o of list) { hourly[new Date(o.createdAt).getHours()] += o.total; if (o.paymentMethod === 'card') { card += o.total; cardN++; } else { cash += o.total; cashN++; } }
    return { ordersCount: list.length, ordersDelta: 0, revenue: cash + card, revenueDeltaPct: 0, waiting: list.filter((o) => o.status === 'pending').length, cashCount: cashN, cardCount: cardN, cashRevenue: cash, cardRevenue: card, hourly };
  }
}
