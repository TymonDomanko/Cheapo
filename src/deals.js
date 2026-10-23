// The home page's deals:
//  - unusualDeals: specials that break a product's usual pattern (first in
//    months, deeper than usual, or rare), across everything we track;
//  - regularsOnSale: things this shopper buys often that are on special, a
//    multi-buy or a member price at one of their shops.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { getProduct, findEquivalents } from './compare.js';
import { dealQuality } from './insights.js';

const CACHE_MS = 60 * 60 * 1000;
const WEIGHT = { rare: 3, deeper: 2, uncommon: 1 };
let unusualCache = null;

/** Every unusual special (IGA aside: its prices differ per store), best first. Cached for an hour. */
function allUnusual() {
  if (unusualCache && Date.now() - unusualCache.at < CACHE_MS) return unusualCache.list;
  const d = getDb();
  const since = new Date(Date.now() - 35 * 86400000).toISOString();
  // On special now, or its price changed lately (some shops don't flag specials).
  const ids = d.prepare(`SELECT id FROM products WHERE available = 1 AND location_priced = 0 AND price IS NOT NULL AND on_special = 1
    UNION SELECT h.product_id FROM price_history h JOIN products p ON p.id = h.product_id
      WHERE h.recorded_at > ? AND h.location IS NULL AND p.available = 1 AND p.location_priced = 0`).all(since).map((r) => r.id);
  const found = [];
  const history = d.prepare(`SELECT product_id, price, on_special, recorded_at FROM price_history
    WHERE product_id IN (SELECT value FROM json_each(?)) AND location IS NULL ORDER BY product_id, recorded_at, id`);
  const price = d.prepare('SELECT price FROM products WHERE id = ?');
  for (let i = 0; i < ids.length; i += 500) {
    const byProduct = new Map();
    for (const r of history.all(JSON.stringify(ids.slice(i, i + 500)))) {
      if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
      byProduct.get(r.product_id).push(r);
    }
    for (const [id, rows] of byProduct) {
      const q = dealQuality(rows, price.get(id).price);
      if (q && q.pctOff >= 15) found.push({ id, ...q, score: WEIGHT[q.kind] * q.pctOff });
    }
  }
  found.sort((a, b) => b.score - a.score || b.saving - a.saving);
  unusualCache = { at: Date.now(), list: found.slice(0, 300) };
  return unusualCache.list;
}

export function unusualDeals({ stores = STORES, limit = 12 } = {}) {
  const allowed = stores?.length ? stores : STORES;
  const out = [];
  for (const deal of allUnusual()) {
    const product = getProduct(deal.id);
    if (!product?.available || !allowed.includes(product.store)) continue;
    out.push({ product, deal });
    if (out.length >= limit) break;
  }
  return out;
}

/** Forget cached deals (after prices are refreshed). */
export function clearDealsCache() {
  unusualCache = null;
}

/** The best price today for one of a product's equivalents, if it's a deal. */
function dealOn(p, memberships) {
  const options = [{ price: p.price, kind: p.on_special ? 'special' : null }];
  if (p.member_price != null && memberships.includes(p.store)) options.push({ price: p.member_price, kind: 'member' });
  if (p.multi_qty >= 2 && p.multi_price > 0) options.push({ price: p.multi_price / p.multi_qty, kind: 'multi' });
  const best = options.sort((a, b) => a.price - b.price)[0];
  const regular = p.was_price && p.was_price > p.price ? p.was_price : p.price;
  if (!best.kind || best.price >= regular - 0.004) return null;
  return {
    kind: best.kind,
    unit: Math.round(best.price * 100) / 100,
    regular,
    pctOff: Math.round((1 - best.price / regular) * 100),
    text: best.kind === 'multi' ? p.promo_text || `${p.multi_qty} for $${p.multi_price.toFixed(2)}` : best.kind === 'member' ? 'Member price' : 'On special',
  };
}

/** How often this shopper has bought (or listed) each product, most first. */
function regulars(userId) {
  const d = getDb();
  const counts = new Map();
  const add = (id, n) => id && counts.set(id, (counts.get(id) || 0) + n);
  const lists = d.prepare('SELECT list_id FROM list_members WHERE user_id = ?').all(userId).map((r) => r.list_id);
  if (!lists.length) return [];
  const json = JSON.stringify(lists);
  const since = new Date(Date.now() - 182 * 86400000).toISOString();
  for (const s of d.prepare(`SELECT kind, items_json FROM list_snapshots WHERE list_id IN (SELECT value FROM json_each(?))
    AND (kind = 'saved' OR created_at > ?)`).all(json, since)) {
    for (const it of JSON.parse(s.items_json)) add(it.productId, s.kind === 'history' ? 2 : 1);
  }
  for (const r of d.prepare('SELECT product_id FROM list_items WHERE list_id IN (SELECT value FROM json_each(?)) AND product_id IS NOT NULL').all(json)) {
    add(r.product_id, 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }));
}

export function regularsOnSale(userId, { stores = STORES, igaStore = null, memberships = [], limit = 12 } = {}) {
  const allowed = stores?.length ? stores : STORES;
  const out = [];
  const seen = new Set();
  for (const { id, n } of regulars(userId).slice(0, 60)) {
    if (seen.has(id)) continue;
    const anchor = getProduct(id, igaStore);
    if (!anchor) continue;
    const eq = findEquivalents(anchor, 'similar', igaStore).filter((m) => allowed.includes(m.product.store) && m.product.available && m.product.price != null);
    for (const m of eq) seen.add(m.product.id);
    let best = null;
    for (const m of eq) {
      const deal = dealOn(m.product, memberships);
      if (deal && deal.pctOff >= 5 && (!best || deal.unit < best.deal.unit)) best = { product: m.product, deal };
    }
    if (best) out.push({ anchor, times: n, ...best });
    if (out.length >= limit) break;
  }
  return out;
}
