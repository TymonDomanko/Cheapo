// One part of a shop's refresh, when the refresh is shared out (src/sharing.js).
// The server and collectors both use this, each on its own connection.
//
// Parts:
//   { kind: 'index' }                 the shop's departments (one request)
//   { kind: 'dept', dept }            one department (the object departments() gave)
//   { kind: 'pages', from, to }       a block of pages, for a shop with no departments
//   { kind: 'whole' }                 the whole shop

import { BlockedError } from './http.js';

/**
 * The shop refusing this connection (HTTP 403 or 429, or a bot check where data
 * should be) is reported as blocked, so the connection is paused for that shop
 * and moves on to another, rather than failing part after part.
 */
export function asBlocked(e) {
  if (e.blocked) return e;
  if (e.status === 403 || e.status === 429 || /bot check|bot protection/i.test(e.message || '')) return new BlockedError(e.message);
  return e;
}

/** The departments of a shop, as the parts to share out. */
export async function index(scraper) {
  let cats;
  try {
    cats = await scraper.departments();
  } catch (e) {
    throw asBlocked(e);
  }
  return cats.map((dept) => ({ key: String(dept.slug ?? dept.key ?? dept.id), label: String(dept.name || dept.slug || ''), dept }));
}

/**
 * Fetch a part's products, a batch at a time. `result.more`: a block of pages
 * found more after it. `part.options`: where to get prices for (the site's
 * choice, e.g. Liquorland's state), the same for every connection.
 */
export async function* fetchPart(scraper, part, { log = console.log, result = {} } = {}) {
  const opts = { ...(part.options || {}), log };
  try {
    if (part.kind === 'dept') yield* scraper.scrape({ ...opts, categories: [part.dept] });
    else if (part.kind === 'pages') yield* scraper.scrape({ ...opts, fromPage: part.from, toPage: part.to, result });
    else if (part.kind === 'whole') yield* scraper.scrape(opts);
    else throw new Error(`Unknown part: ${part.kind}`);
  } catch (e) {
    throw asBlocked(e);
  }
}
