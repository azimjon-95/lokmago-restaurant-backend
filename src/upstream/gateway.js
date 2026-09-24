import { HttpError, Conflict, NotFound, Unauthorized } from '../errors.js';

/**
 * Adapter to the EXISTING LokmaGo backend (lakmago-server) through the API gateway.
 * >>> All assumed paths / field names live in this file only. After auditing lakmago-server,
 * >>> adjust ROUTES and mapOrder() — nothing else in this service needs to change.
 */
const ROUTES = {
  login: () => '/auth/restaurant/login',
  list: (rid, q) => `/restaurants/${rid}/orders?${q}`,
  get: (rid, id) => `/restaurants/${rid}/orders/${id}`,
  accept: (rid, id) => `/restaurants/${rid}/orders/${id}/accept`,
  status: (rid, id) => `/restaurants/${rid}/orders/${id}/status`,
  stats: (rid) => `/restaurants/${rid}/stats/today`,
};

/** Map an upstream order to the mobile contract (see Android OrderDto). */
export function mapOrder(r) {
  return {
    id: String(r.id ?? r._id), number: String(r.number ?? r.orderNumber ?? r.id), status: r.status,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.parse(r.createdAt),
    fulfillment: r.fulfillment ?? r.deliveryType ?? 'delivery', paymentMethod: r.paymentMethod ?? 'cash',
    itemsCount: r.itemsCount ?? r.items?.length ?? 0, subtotal: r.subtotal ?? 0, deliveryFee: r.deliveryFee ?? 0, total: r.total ?? 0,
    customerName: r.customer?.name ?? r.customerName, customerPhone: r.customer?.phone ?? r.customerPhone,
    address: r.address?.text ?? r.address, lat: r.address?.lat ?? r.lat, lng: r.address?.lng ?? r.lng,
    items: (r.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity ?? i.qty, price: i.price, imageUrl: i.imageUrl ?? i.image })),
  };
}

export class GatewayUpstream {
  constructor(cfg) { this.cfg = cfg; }

  async #req(method, path, body) {
    let res;
    try {
      res = await fetch(this.cfg.url + path, {
        method, signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', accept: 'application/json', [this.cfg.header]: this.cfg.password },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new HttpError(502, 'Asosiy server bilan aloqa yo\'q', 'upstream_unreachable'); }
    if (res.status === 401 || res.status === 403) throw Unauthorized();
    if (res.status === 404) throw NotFound();
    if (res.status === 409) throw Conflict();
    if (!res.ok) throw new HttpError(502, `Asosiy server xatosi (${res.status})`, 'upstream_error');
    return res.status === 204 ? null : res.json();
  }

  async authenticate(login, password) {
    try { const r = await this.#req('POST', ROUTES.login(), { login, password }); return { user: r.user, restaurant: r.restaurant }; }
    catch (e) { if (e.status === 401 || e.status === 404) return null; throw e; }
  }
  async listOrders(rid, { status, limit = 50 } = {}) {
    const q = new URLSearchParams({ limit: String(limit), ...(status ? { status } : {}) }).toString();
    return (await this.#req('GET', ROUTES.list(rid, q))).map(mapOrder);
  }
  async getOrder(rid, id) { return mapOrder(await this.#req('GET', ROUTES.get(rid, id))); }
  // Race safety lives in the upstream: it must answer 409 if the order is no longer pending.
  async accept(rid, id) { return mapOrder(await this.#req('POST', ROUTES.accept(rid, id))); }
  async setStatus(rid, id, status) { return mapOrder(await this.#req('POST', ROUTES.status(rid, id), { status })); }
  async stats(rid) { return this.#req('GET', ROUTES.stats(rid)); }
}
