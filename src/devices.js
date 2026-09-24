import fs from 'node:fs';
import path from 'node:path';

/** restaurantId -> deviceId -> { token, userId }. Tokens are bound to user + restaurant and removed on logout. */
export class DeviceStore {
  constructor(file) {
    this.file = file || '';
    this.map = new Map();
    if (this.file && fs.existsSync(this.file)) {
      try { for (const [r, d] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(r, new Map(Object.entries(d))); } catch { /* start empty */ }
    }
  }
  #save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const o = {}; for (const [r, d] of this.map) o[r] = Object.fromEntries(d);
    fs.writeFileSync(this.file, JSON.stringify(o));
  }
  register(restaurantId, userId, deviceId, token) {
    // a token can belong to only one restaurant/device at a time (phone re-logged into another restaurant)
    this.removeToken(token);
    if (!this.map.has(restaurantId)) this.map.set(restaurantId, new Map());
    this.map.get(restaurantId).set(deviceId, { token, userId });
    this.#save();
  }
  unregister(restaurantId, deviceId, token) {
    const d = this.map.get(restaurantId);
    if (d?.get(deviceId)?.token === token) { d.delete(deviceId); this.#save(); }
  }
  removeToken(token) {
    for (const d of this.map.values()) for (const [id, v] of d) if (v.token === token) d.delete(id);
    this.#save();
  }
  tokensFor(restaurantId) { return [...(this.map.get(restaurantId)?.values() ?? [])].map((v) => v.token); }
}
