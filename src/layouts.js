// Learns the order you walk each shop. While shopping, every tick records
// which section the item was in; a trip's order of sections (first tick in
// each) is averaged over recent trips, and the in-the-shop checklist sorts by
// it. Until there are a couple of trips, the usual supermarket order is used.

import { getDb } from './db.js';
import { STORES } from './stores.js';
import { AISLES } from './aisles.js';

const TRIP_GAP_MS = 3 * 3600 * 1000; // ticks further apart than this are different trips
const KEEP_DAYS = 180;
const MIN_TRIPS = 2;
const RECENT_TRIPS = 12;
const AISLE_KEYS = new Set(AISLES.map((a) => a.key));

/** Remember a tick. `at` is when it happened on the phone (ticks made offline arrive later). */
export function logTick(userId, { store, aisle, at }) {
  if (!STORES.includes(store) || !AISLE_KEYS.has(aisle)) return;
  const t = Date.parse(at);
  const when = Number.isFinite(t) && t <= Date.now() + 60000 && t > Date.now() - 2 * 86400000 ? new Date(t) : new Date();
  const d = getDb();
  d.prepare('INSERT INTO tick_log (user_id, store, aisle, at) VALUES (?, ?, ?, ?)').run(userId, store, aisle, when.toISOString());
  d.prepare('DELETE FROM tick_log WHERE user_id = ? AND at < ?').run(userId, new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
}

/**
 * Learned section order for one shop: { trips, ranks: { aisle: 0..1 } }, or
 * null if there isn't enough to go on yet.
 */
export function layoutFor(userId, store) {
  const ticks = getDb().prepare('SELECT aisle, at FROM tick_log WHERE user_id = ? AND store = ? ORDER BY at').all(userId, store);
  const trips = [];
  let last = 0;
  for (const t of ticks) {
    const at = Date.parse(t.at);
    if (!trips.length || at - last > TRIP_GAP_MS) trips.push([]);
    const trip = trips.at(-1);
    if (!trip.includes(t.aisle)) trip.push(t.aisle);
    last = at;
  }
  const useful = trips.filter((t) => t.length >= 3).slice(-RECENT_TRIPS);
  if (useful.length < MIN_TRIPS) return null;
  const sum = {};
  const n = {};
  for (const trip of useful) {
    trip.forEach((aisle, i) => {
      sum[aisle] = (sum[aisle] || 0) + i / (trip.length - 1);
      n[aisle] = (n[aisle] || 0) + 1;
    });
  }
  return { trips: useful.length, ranks: Object.fromEntries(Object.keys(sum).map((a) => [a, Math.round((sum[a] / n[a]) * 1000) / 1000])) };
}

export function layoutsFor(userId, stores = STORES) {
  return Object.fromEntries(stores.map((s) => [s, layoutFor(userId, s)]).filter(([, l]) => l));
}

/** Forget what's been learned about a shop. */
export function resetLayout(userId, store) {
  getDb().prepare('DELETE FROM tick_log WHERE user_id = ? AND store = ?').run(userId, store);
}
