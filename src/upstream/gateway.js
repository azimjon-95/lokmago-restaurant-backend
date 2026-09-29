import { HttpError, Conflict, NotFound, BadRequest } from '../errors.js';

/**
 * Adapter to the EXISTING LokmaGo server (lakmago-server) — "Android Gateway", service routes.
 * Contract: lakmago-server deploy/GATEWAY-BFF.md (commit 2948fb1). Everything that depends on the
 * server's shapes lives in THIS file; nothing else in the BFF knows them.
 *
 *   PIN check (login only) : GET  {url}/app/{pin}/{restaurantId}/
 *   service routes         : {url}/app/service/{restaurantId}/...   header  <cfg.header>: <service key>
 *       GET   /orders?status=          last 80, newest first
 *       GET   /orders/:id
 *       PATCH /orders/:id/status       {status}      -> order + { changed }
 *       POST  /orders/:id/confirm-delivered          -> restaurant closes a DELIVERY order (>= 30 min rule)
 *
 * Security notes
 *  - The PIN travels in the URL only during login and is never stored, logged or put into an error message.
 *  - Raw server documents carry internal finance, customer wallets, courier placeholders, payout data.
 *    mapOrder() is an ALLOW-list: only fields the phone needs leave this file.
 *  - restaurantId always comes from the caller's verified JWT (see app.js), never from the request.
 */
const ID = /^[a-f0-9]{24}$/i;
const enc = encodeURIComponent;

/** Server order document -> mobile contract (Android OrderDto). Allow-list only. */
export function mapOrder(r) {
  const id = String(r._id ?? r.id);
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id,
    number: String(r.dailyNumber ?? id.slice(-4)),        // server's own on-screen label is "#" + last 4 of _id
    status: r.status,
    createdAt: Date.parse(r.createdAt),
    fulfillment: r.fulfillment ?? 'delivery',
    paymentMethod: String(r.paymentMethod ?? '').toLowerCase() === 'cash' ? 'cash' : 'card',
    itemsCount: items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
    subtotal: Number(r.subtotal) || 0, deliveryFee: Number(r.deliveryFee) || 0, total: Number(r.total) || 0, // so'm
    customerName: r.customer?.name, customerPhone: r.customer?.phone ?? r.phone,
    address: [r.address, r.addressNote].filter(Boolean).join(' — ') || undefined,
    lat: r.addressLat, lng: r.addressLng,
    items: items.map((i) => ({ name: i.name, quantity: Number(i.quantity) || 0, price: Number(i.unitPrice ?? i.price) || 0 })),
    // server-computed rule for "Yetkazildi" on delivery orders — the app must not re-implement it
    restaurantConfirm: r.restaurantConfirm ? { eligible: !!r.restaurantConfirm.eligible, eligibleAt: r.restaurantConfirm.eligibleAt } : undefined,
  };
}

export class GatewayUpstream {
  /** @param cfg { url, password (service key), header } */
  constructor(cfg) { this.cfg = cfg; }

  #svc(rid) { return `/app/service/${enc(rid)}`; }

  /** One place that talks HTTP. Errors never contain the URL (it may hold a PIN). */
  async #fetch(path, { method = 'GET', body, service = true } = {}) {
    let res;
    try {
      res = await fetch(this.cfg.url + path, {
        method, signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(service ? { [this.cfg.header]: this.cfg.password } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new HttpError(502, 'Asosiy server bilan aloqa yo\'q', 'upstream_unreachable'); }
    let data = null;
    try { data = await res.json(); } catch { /* empty / non-JSON */ }
    return { res, data };
  }

  /** Translate an upstream failure into the BFF's own error vocabulary. */
  #fail({ res, data }) {
    const code = String(data?.code ?? '').toUpperCase();
    const msg = data?.error;
    switch (res.status) {
      case 400:
        if (code === 'CAST') return NotFound();
        return new HttpError(400, msg || 'Noto\'g\'ri so\'rov', (code || 'BAD_REQUEST').toLowerCase());
      case 401: case 403: // OUR service key was refused. Must NOT surface as 401: the app would log the user out.
        return new HttpError(502, 'Asosiy server bizning kalitni qabul qilmadi', 'upstream_auth');
      case 404:
        if (msg === 'Buyurtma topilmadi') return NotFound();
        if (msg === 'Gateway topilmadi') return new HttpError(404, 'Restoran topilmadi yoki gateway o\'chiq', 'gateway_not_found');
        return new HttpError(502, 'Asosiy serverda servis yo\'li yoqilmagan (kalit / IP ro\'yxati?)', 'upstream_misconfigured'); // fail-closed 404
      case 409:
        if (code === 'CONFIRM_TOO_EARLY') return new HttpError(409, 'Hali erta — kuryer yetkazishi uchun vaqt bering', 'confirm_too_early', { eligibleAt: data?.eligibleAt });
        return Conflict(code === 'RACE_LOST' ? 'Buyurtmani boshqa xodim allaqachon o\'zgartirdi' : undefined);
      case 429:
        return new HttpError(429, 'Asosiy server band, birozdan so\'ng urinib ko\'ring', 'upstream_rate_limited', { retryAfter: data?.retryAfter ?? (Number(res.headers.get('retry-after')) || undefined) });
      default:
        return new HttpError(502, `Asosiy server xatosi (${res.status})`, 'upstream_error');
    }
  }

  async #ok(path, opts) { const r = await this.#fetch(path, opts); if (!r.res.ok) throw this.#fail(r); return r.data; }

  /**
   * Login = restaurantId + PIN (the server has no user accounts). The PIN is verified by the server's
   * own PIN route (so its 3-strikes lock applies); we only learn "ok / wrong / blocked".
   * Returns null for wrong credentials. Never returns the raw profile (it contains payout details).
   */
  async authenticate(login, password) {
    const restaurantId = String(login ?? '').trim();
    const pin = String(password ?? '');
    if (!ID.test(restaurantId) || pin.length < 1 || pin.length > 32) return null;
    const { res, data } = await this.#fetch(`/app/${enc(pin)}/${restaurantId}/`, { service: false });
    if (res.ok) {
      const name = data?.name ?? data?.title ?? data?.restaurant?.name ?? 'Restoran';
      return { user: { id: restaurantId, name }, restaurant: { id: restaurantId, name } };
    }
    if (res.status === 401 && String(data?.code ?? '').toUpperCase() !== 'PIN_BLOCKED') return null;
    if (res.status === 404 && data?.error === 'Gateway topilmadi') return null; // do not reveal which ids exist
    if (res.status === 429 && String(data?.code ?? '').toUpperCase() === 'PIN_BLOCKED') {
      throw new HttpError(429, `PIN vaqtincha bloklandi. ${data?.retryAfter ?? 30} soniyadan keyin urinib ko'ring`, 'pin_blocked', { retryAfter: data?.retryAfter ?? 30 });
    }
    throw this.#fail({ res, data });
  }

  async listOrders(rid, { status, limit = 50 } = {}) {
    const data = await this.#ok(`${this.#svc(rid)}/orders${status ? `?status=${enc(status)}` : ''}`);
    const list = (Array.isArray(data) ? data : data?.orders ?? data?.items ?? []).map(mapOrder);
    // Queue order: pending oldest-first (first come, first served); every other tab newest-first.
    list.sort((a, b) => (status === 'pending' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    return list.slice(0, limit);
  }

  async getOrder(rid, id) {
    if (!ID.test(String(id))) throw NotFound();
    return mapOrder(await this.#ok(`${this.#svc(rid)}/orders/${enc(id)}`));
  }

  /** PATCH {status:'accepted'}. Sequential duplicate -> 200 changed:false (idempotent). True race -> 409 RACE_LOST. */
  async accept(rid, id) { return this.#patch(rid, id, 'accepted'); }

  async setStatus(rid, id, status) {
    if (status === 'delivered') {
      // The server forbids PATCH delivered for DELIVERY orders (courier/customer close them). The restaurant may
      // close one only through confirm-delivered — the SAME function as the bot's "Yakunlandi" button (commission once).
      const o = await this.getOrder(rid, id);
      if (o.fulfillment === 'delivery') return this.confirmDelivered(rid, id);
    }
    return this.#patch(rid, id, status);
  }

  async #patch(rid, id, status) {
    if (!ID.test(String(id))) throw NotFound();
    return mapOrder(await this.#ok(`${this.#svc(rid)}/orders/${enc(id)}/status`, { method: 'PATCH', body: { status } }));
  }

  async confirmDelivered(rid, id) {
    if (!ID.test(String(id))) throw NotFound();
    await this.#ok(`${this.#svc(rid)}/orders/${enc(id)}/confirm-delivered`, { method: 'POST', body: {} });
    return this.getOrder(rid, id); // the server is the source of truth, do not trust a body we have not seen
  }

  /** The server's /stats and /orders/history exist, but their JSON shape is not part of what we have received yet. */
  async stats() { throw new HttpError(501, 'Statistika hali ulanmagan', 'not_implemented'); }
}
