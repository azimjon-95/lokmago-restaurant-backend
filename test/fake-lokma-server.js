import http from 'node:http';

/**
 * Minimal stand-in for lakmago-server's Android Gateway, written from the contract we received
 * (deploy/GATEWAY-BFF.md / the server's own report): PIN route, service routes, error codes.
 * It is a test double — real behaviour must still be verified against the real server.
 */
export const KEY = 'k'.repeat(24), RID = 'a'.repeat(24), OTHER_RID = 'b'.repeat(24);
const iso = (ms) => new Date(ms).toISOString();

export function startFakeServer() {
  const now = Date.now();
  const mk = (n, over = {}) => ({
    _id: String(n).padStart(24, '0'), userId: { addresses: ['secret'], cards: ['4111'], bonusBalance: 99 }, restaurantId: RID,
    items: [{ dishId: 'd', name: 'Pasta', quantity: 2, unitPrice: 10000, note: 'achchiq bo\'lmasin' }],
    subtotal: 20000, deliveryFee: 21200, total: 41200,
    finance: { lokmaNetCommission: 138200, clickFeeAmount: 1, restaurantPayout: 39200 },
    status: 'pending', fulfillment: 'delivery', address: 'Uy — Sohil', addressNote: '2-qavat', addressLat: 41.28, addressLng: 69.2,
    phone: '+998901112233', paymentMethod: 'cash', courierName: 'Aziz', customer: { name: 'Azimjon', phone: '+998901112233', telegramId: '5' },
    dailyNumber: null, createdAt: iso(now - (10 - n) * 1000), ...over,
  });
  const orders = new Map([
    [1, mk(1)], [2, mk(2)], [3, mk(3, { status: 'ready', fulfillment: 'pickup' })],
    [4, mk(4, { status: 'delivering', restaurantConfirm: { eligible: false, eligibleAt: iso(now + 20 * 60_000) } })],
    [5, mk(5, { status: 'pending', restaurantId: OTHER_RID })],
  ].map(([n, o]) => [o._id, o]));
  const stats = { requests: [], raceOnce: new Set(), settled: new Map(), pinBlocked: '9999', pin: '1234' };

  const next = { pending: ['accepted', 'cancelled'], accepted: ['preparing', 'ready', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['delivering', 'delivered', 'cancelled'], delivering: [] };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['app', ...]
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      stats.requests.push({ method: req.method, path: url.pathname, key: req.headers['x-gateway-key'] });
      if (p[0] !== 'app') return send(res, 404, { error: 'Topilmadi' });

      if (p[1] !== 'service') { // PIN route: /app/{pin}/{restaurantId}
        const [, pin, rid] = p;
        if (pin === stats.pinBlocked) return send(res, 429, { error: 'Bloklandi', code: 'PIN_BLOCKED', retryAfter: 30 });
        if (rid !== RID) return send(res, 404, { error: 'Gateway topilmadi' });
        if (pin !== stats.pin) return send(res, 401, { error: 'PIN noto\'g\'ri', code: 'PIN_WRONG' });
        return send(res, 200, { _id: RID, name: 'TOTLI', payout: { card: '8600 1234 5678 9012' }, deliveryMarkupPercent: 7, pinHash: 'x' });
      }
      if (req.headers['x-gateway-key'] !== KEY) return send(res, 401, { error: 'Kalit noto\'g\'ri' });
      const rid = p[2];
      if (rid !== RID) return send(res, 404, { error: 'Gateway topilmadi' });
      const [, , , what, id, action] = p;
      if (what !== 'orders') return send(res, 404, { error: 'Topilmadi' });
      if (!id) {
        let list = [...orders.values()].filter((o) => o.restaurantId === rid);
        if (url.searchParams.get('status')) list = list.filter((o) => o.status === url.searchParams.get('status'));
        return send(res, 200, list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      }
      if (!/^[a-f0-9]{24}$/.test(id)) return send(res, 400, { error: 'Noto\'g\'ri ID', code: 'CAST' });
      const o = orders.get(id);
      if (!o || o.restaurantId !== rid) return send(res, 404, { error: 'Buyurtma topilmadi' });
      if (!action && req.method === 'GET') return send(res, 200, o);

      if (action === 'status' && req.method === 'PATCH') {
        const to = body.status;
        if (!to) return send(res, 400, { error: 'Noto\'g\'ri status', code: 'INVALID_STATUS' });
        if (stats.raceOnce.has(id)) { stats.raceOnce.delete(id); return send(res, 409, { error: 'Buyurtmani boshqa xodim allaqachon o\'zgartirdi', code: 'RACE_LOST' }); }
        if (o.status === to) return send(res, 200, { ...o, changed: false });
        if (to === 'delivered' && o.fulfillment === 'delivery') return send(res, 400, { error: 'Yetkazib berish buyurtmasini kuryer yoki mijoz yakunlaydi', code: 'WRONG_STATE' });
        if (!(next[o.status] ?? []).includes(to)) return send(res, 400, { error: `Bu buyurtma allaqachon "${o.status}" holatida`, code: 'WRONG_STATE' });
        o.status = to; return send(res, 200, { ...o, changed: true });
      }
      if (action === 'confirm-delivered' && req.method === 'POST') {
        if (o.status === 'delivered') return send(res, 200, { ...o, changed: false });
        if (o.status !== 'delivering') return send(res, 400, { error: 'Holat mos emas', code: 'WRONG_STATE' });
        if (o.restaurantConfirm && !o.restaurantConfirm.eligible) return send(res, 409, { error: 'Hali erta', code: 'CONFIRM_TOO_EARLY', eligibleAt: o.restaurantConfirm.eligibleAt });
        o.status = 'delivered'; stats.settled.set(id, (stats.settled.get(id) ?? 0) + 1); // "commission written once"
        return send(res, 200, { ...o, changed: true });
      }
      return send(res, 404, { error: 'Topilmadi' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, orders, stats, close: () => new Promise((r) => server.close(r)),
    setEligible: (id) => { orders.get(id).restaurantConfirm = { eligible: true, eligibleAt: iso(Date.now() - 1000) }; },
  })));
}
