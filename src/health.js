// Data health for the admin page: is each shop's data complete and fresh,
// how much of it can be compared with other shops, and which products don't
// sort into a shop section. Some of this is slow on a big catalogue, so it's
// cached for a while.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { aisleFor } from './aisles.js';
import { findEquivalents } from './compare.js';
import { openAlerts } from './admin-alerts.js';

const CACHE_MS = 15 * 60 * 1000;
const MATCH_SAMPLE = 150;
const STALE_DAYS = 3;
let cache = null;

function aisleCoverage(store) {
  const d = getDb();
  // Sort each category once; only products in unsortable categories are checked by name.
  const cats = d.prepare('SELECT category, COUNT(*) n FROM products WHERE store = ? AND available = 1 GROUP BY category').all(store);
  let other = 0;
  let total = 0;
  const unsorted = [];
  const byName = d.prepare('SELECT name FROM products WHERE store = ? AND available = 1 AND category IS ?');
  for (const c of cats) {
    total += c.n;
    if (c.category && aisleFor({ category: c.category }) !== 'other') continue;
    const names = byName.all(store, c.category);
    const left = names.filter((p) => aisleFor({ name: p.name }) === 'other').length;
    other += left;
    if (left) unsorted.push({ category: c.category || '(none)', products: left });
  }
  unsorted.sort((a, b) => b.products - a.products);
  return { otherPct: total ? Math.round((other / total) * 1000) / 10 : 0, unsorted: unsorted.slice(0, 8) };
}

/** Of a random sample of products, how many have a match at another shop. */
function matchCoverage(store) {
  const sample = getDb().prepare(`SELECT p.* FROM products p WHERE store = ? AND available = 1
    ORDER BY random() LIMIT ?`).all(store, MATCH_SAMPLE);
  if (!sample.length) return null;
  let matched = 0;
  const examples = [];
  for (const p of sample) {
    const others = findEquivalents(p, 'similar').filter((m) => m.product.store !== store);
    if (others.length) {
      matched++;
      if (examples.length < 3) examples.push({ id: p.id, name: p.name, matches: others.slice(0, 2).map((m) => ({ store: m.product.store, name: m.product.name, score: Math.round(m.score * 100) })) });
    }
  }
  return { sampled: sample.length, matchedPct: Math.round((matched / sample.length) * 100), examples };
}

export function dataHealth({ refresh = false } = {}) {
  if (cache && !refresh && Date.now() - cache.at < CACHE_MS) return cache.value;
  const d = getDb();
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  const stores = STORES.map((store) => {
    const counts = d.prepare(`SELECT COUNT(*) total, SUM(available) available,
        SUM(CASE WHEN available = 1 AND (category IS NULL OR category = '') THEN 1 ELSE 0 END) noCategory,
        SUM(CASE WHEN available = 1 AND barcode IS NOT NULL THEN 1 ELSE 0 END) withBarcode,
        SUM(CASE WHEN available = 1 AND last_seen < ? THEN 1 ELSE 0 END) stale,
        SUM(CASE WHEN available = 1 AND on_special = 1 THEN 1 ELSE 0 END) onSpecial
      FROM products WHERE store = ?`).get(staleBefore, store);
    const lastOk = d.prepare("SELECT finished_at, products, source FROM scrape_runs WHERE store = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(store);
    const stuck = d.prepare("SELECT COUNT(*) n FROM scrape_runs WHERE store = ? AND status = 'running' AND started_at < ?")
      .get(store, new Date(Date.now() - 6 * 3600000).toISOString()).n;
    const available = counts.available || 0;
    const pct = (n) => (available ? Math.round(((n || 0) / available) * 1000) / 10 : 0);
    return {
      store,
      available,
      lastOk: lastOk || null,
      stuckRuns: stuck,
      noCategoryPct: pct(counts.noCategory),
      barcodePct: pct(counts.withBarcode),
      stale: counts.stale || 0,
      onSpecialPct: pct(counts.onSpecial),
      aisles: available ? aisleCoverage(store) : null,
      matching: available ? matchCoverage(store) : null,
    };
  });
  const value = { at: new Date().toISOString(), stores, alerts: openAlerts() };
  cache = { at: Date.now(), value };
  return value;
}
