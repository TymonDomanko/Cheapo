// Coles, a little at a time.
//
// Coles blocks connections that ask for a lot at once (a "Pardon Our
// Interruption" bot check). So rather than crawl the whole shop in one go
// every night, this asks for one page every couple of minutes (COLES_PAGES_PER_HOUR,
// default 30), all day, in this order:
//   1. searches: when someone searches and the Coles results are over a day
//      old, Coles' own search for those words (one page, up to 48 products)
//      is fetched straight away;
//   2. the Coles products on people's lists and watches, once a day;
//   3. everything on special, once a day;
//   4. the whole shop, every COLES_FULL_EVERY_DAYS (default 2), carrying on
//      where it left off;
//   5. barcodes for matching, with whatever time is left.
// A bot check stops everything for a while (2 hours, doubling up to a day).
// Set COLES_PAGES_PER_HOUR=0 to go back to the nightly full crawl.

import { getDb, upsertProducts, markUnseenUnavailable, nowIso } from './db.js';
import { createClient, isBotCheck, BlockedError } from './scrapers/http.js';
import { mapProduct, SKIP } from './scrapers/coles.js';
import { startRun, getRun, finishRun, serverStores } from './scrapers/index.js';
import { checkRun } from './admin-alerts.js';
import { barcodeTodo, saveBarcode } from './barcodes.js';

const ORIGIN = 'https://www.coles.com.au';
const KEY = 'coles-live';
const STALE_MS = 24 * 3600 * 1000;
const QUERY_AGAIN_MS = 6 * 3600 * 1000; // the same search isn't fetched again for this long
const QUERY_GAP_MS = 3000; // searches go straight away, but not back to back
const MAX_QUEUE = 20;
const LIST_REFRESH_MS = 20 * 3600 * 1000;
const LIST_LIMIT = 40;

export const rate = () => Number(process.env.COLES_PAGES_PER_HOUR ?? 30);
const fullEveryMs = () => Number(process.env.COLES_FULL_EVERY_DAYS ?? 2) * 86400000;
/** Steady mode is on (and this server crawls Coles itself). */
export const enabled = () => rate() > 0 && serverStores().includes('coles') && process.env.DISABLE_BACKGROUND_SCRAPES !== 'true';

let clock = () => Date.now();
/** Tests: pretend it's a different time. */
export function setClock(fn) {
  clock = fn;
}
const iso = () => new Date(clock()).toISOString();
const today = () => new Date(clock()).toLocaleDateString('en-CA', { timeZone: process.env.TZ || undefined });

// ---------------------------------------------------------------- state

function load() {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY);
  return { specials: null, pass: null, lastPassAt: null, listsDay: null, listQueue: [], blockedUntil: null, backoffHours: 0, ...(row ? JSON.parse(row.value) : {}) };
}
function save(st) {
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(st));
}

// Requests made in the last hour (in memory: a restart just starts counting again).
const recent = [];
function usedLastHour() {
  while (recent.length && recent[0] < clock() - 3600 * 1000) recent.shift();
  return recent.length;
}
let lastRequestAt = 0;

const queries = []; // searches waiting: { q }
const queried = new Map(); // search → when it was last fetched

// ---------------------------------------------------------------- talking to Coles

let session = null; // { client, buildId, cats }
let makeClient = () => createClient({ origin: ORIGIN, delayMs: 0, softBlockWaits: [] });
/** Tests: a stand-in for the website. */
export function setClientFactory(fn) {
  makeClient = fn;
  session = null;
}

function count() {
  recent.push(clock());
  lastRequestAt = clock();
}

async function getSession() {
  if (session) return session;
  const client = makeClient();
  if (client.constructor.name === 'BrowserClient') await client.init(); // SCRAPE_MODE=browser
  count();
  const html = await client.request(`${ORIGIN}/`, { accept: 'text/html' });
  const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
  if (!buildId) throw new BlockedError(isBotCheck(html) ? 'Coles is showing a bot check' : 'Coles: could not find the site version');
  session = { client, buildId, cats: null };
  return session;
}

/** One of Coles' data pages (one request). */
async function data(path) {
  const s = await getSession();
  count();
  let text;
  try {
    text = await s.client.request(`${ORIGIN}/_next/data/${s.buildId}/en/${path}`);
  } catch (e) {
    // A new version of the site moves the data pages: start a new session next time.
    if (e.status === 404) session = null;
    if (e.status === 403) throw new BlockedError('Coles refused the request (HTTP 403)');
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw isBotCheck(text) ? new BlockedError('Coles is showing a bot check') : new Error(`Coles sent something unexpected for ${path}`);
  }
}

/** Save a page of Coles results. Returns how many products it had. */
function savePage(json, category = null) {
  const r = json?.pageProps?.searchResults;
  if (!r) return { count: 0, pages: 0 };
  const items = (r.results || []).filter((x) => x._type === 'PRODUCT').map((x) => mapProduct(x, category));
  if (items.length) upsertProducts('coles', items, iso());
  return { count: items.length, pages: Math.ceil((r.noOfResults || 0) / (r.pageSize || 48)) };
}

// ---------------------------------------------------------------- the jobs

/** What to fetch next, most important first, or null for nothing. */
function nextJob(st) {
  if (queries.length) return { kind: 'query' };
  if (st.listQueue.length) return { kind: 'list' };
  const specialsDone = st.specials?.day === today() && st.specials.page > st.specials.pages;
  if (!specialsDone) return { kind: 'specials' };
  if (st.pass || !st.lastPassAt || clock() - Date.parse(st.lastPassAt) >= fullEveryMs()) return { kind: 'pass' };
  if (barcodeTodo(1).length) return { kind: 'barcode' };
  return null;
}

async function runJob(job, st) {
  if (job.kind === 'query') {
    const { q } = queries.shift();
    queried.set(q, clock());
    savePage(await data(`search/products.json?q=${encodeURIComponent(q)}`));
  } else if (job.kind === 'list') {
    const q = st.listQueue.shift();
    savePage(await data(`search/products.json?q=${encodeURIComponent(q)}`));
  } else if (job.kind === 'specials') {
    if (st.specials?.day !== today()) st.specials = { day: today(), page: 1, pages: 1 };
    const { pages } = savePage(await data(`on-special.json?page=${st.specials.page}`));
    st.specials.pages = pages;
    st.specials.page++;
  } else if (job.kind === 'pass') {
    await passStep(st);
  } else if (job.kind === 'barcode') {
    const [p] = barcodeTodo(1);
    try {
      const path = new URL(p.product_url).pathname.replace(/^\//, ''); // product/<slug>-<id>
      let json = await data(`${path}.json`);
      let canonical = null;
      const redirect = json?.pageProps?.__N_REDIRECT;
      if (redirect) {
        canonical = ORIGIN + redirect;
        json = await data(`${redirect.replace(/^\//, '')}.json`);
      }
      saveBarcode(p.id, JSON.stringify(json).match(/"gtin":"(\d{8,14})"/)?.[1] || null, canonical);
    } catch (e) {
      if (e.blocked) throw e;
      saveBarcode(p.id, null); // no page for it (gone, or moved): checked, try again in a few months
    }
  }
}

/** One page of the whole-shop pass; the last one finishes the pass. */
async function passStep(st) {
  const s = await getSession();
  if (!s.cats) {
    const browse = await data('browse.json');
    s.cats = (browse.pageProps?.allProductCategories?.catalogGroupView || [])
      .filter((c) => c.level === 1 && c.type === 'CATALOG' && c.productCount > 0 && !SKIP.has(c.seoToken));
    return; // that was this turn's request
  }
  if (!st.pass) st.pass = { startedAt: iso(), done: [], cat: null, page: 1, total: s.cats.length };
  const cat = s.cats.find((c) => !st.pass.done.includes(c.seoToken));
  if (!cat) return finishPass(st);
  const page = st.pass.cat === cat.seoToken ? st.pass.page : 1;
  const { pages } = savePage(await data(`browse/${cat.seoToken}.json?slug=${cat.seoToken}&page=${page}`), cat.name);
  st.pass.total = s.cats.length;
  if (page >= pages) {
    st.pass.done.push(cat.seoToken);
    st.pass.cat = null;
    st.pass.page = 1;
    if (st.pass.done.length >= s.cats.length) finishPass(st);
  } else {
    st.pass.cat = cat.seoToken;
    st.pass.page = page + 1;
  }
}

/** The whole shop has been seen: what wasn't is gone, and the pass counts as a refresh. */
function finishPass(st) {
  const d = getDb();
  markUnseenUnavailable('coles', st.pass.startedAt);
  const products = d.prepare("SELECT COUNT(*) n FROM products WHERE store = 'coles' AND last_seen >= ?").get(st.pass.startedAt).n;
  const runId = d.prepare(`INSERT INTO scrape_runs (store, started_at, finished_at, status, products, source)
    VALUES ('coles', ?, ?, 'ok', ?, 'server')`).run(st.pass.startedAt, iso(), products).lastInsertRowid;
  checkRun(getRun(runId)); // and tells admins if it found far fewer than last time
  st.lastPassAt = iso();
  st.pass = null;
}

/** Coles is blocking us: stop for a while, longer each time. */
function blocked(st, message) {
  st.backoffHours = Math.min(24, (st.backoffHours || 1) * 2);
  st.blockedUntil = new Date(clock() + st.backoffHours * 3600 * 1000).toISOString();
  session = null;
  if (!st.blockReported) {
    st.blockReported = true;
    const { runId } = startRun('coles');
    finishRun(getRun(runId), { error: `${message}. Trying again ${st.backoffHours === 2 ? 'in 2 hours' : `in ${st.backoffHours} hours`}, carrying on where it stopped.` });
  }
  console.warn(`[coles] ${message} — pausing for ${st.backoffHours} hours`);
}

// ---------------------------------------------------------------- the pump

let inflight = null;

/**
 * Do whatever's next, if it's time. Searches go straight away (a few seconds
 * apart); everything else one request per 60/COLES_PAGES_PER_HOUR minutes.
 * Called while it's already working, it waits for that.
 */
export function pump() {
  if (!enabled()) return Promise.resolve();
  inflight ||= work().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function work() {
  for (;;) {
    const st = load();
    if (st.blockedUntil && clock() < Date.parse(st.blockedUntil)) return;
    if (st.listsDay !== today()) queueLists(st);
    const job = nextJob(st);
    if (!job || usedLastHour() >= rate()) return save(st);
    const urgent = job.kind === 'query';
    const wait = urgent ? QUERY_GAP_MS : (3600 * 1000) / rate();
    if (clock() - lastRequestAt < wait) return save(st);
    try {
      await runJob(job, st);
      st.backoffHours = 0;
      st.blockedUntil = null;
      st.blockReported = false;
    } catch (e) {
      if (e.blocked) blocked(st, e.message);
      else console.warn(`[coles] ${e.message}`);
      save(st);
      return;
    }
    save(st);
    if (!urgent) return; // paced jobs: one per turn
  }
}

/** Once a day: Coles products on lists and watches that haven't been refreshed lately. */
function queueLists(st) {
  st.listsDay = today();
  const since = new Date(clock() - LIST_REFRESH_MS).toISOString();
  st.listQueue = getDb().prepare(`
    SELECT DISTINCT p.name FROM products p
    WHERE p.store = 'coles' AND p.last_seen < ? AND (
      p.id IN (SELECT product_id FROM list_items WHERE product_id IS NOT NULL) OR p.id IN (SELECT product_id FROM watches))
    LIMIT ?`).all(since, LIST_LIMIT).map((p) => p.name);
}

let timer = null;
/** Start the steady refresh (the server calls this). */
export function start() {
  if (!enabled() || timer) return;
  timer = setInterval(() => pump().catch((e) => console.warn(`[coles] ${e.message}`)), 30 * 1000);
  timer.unref?.();
  pump().catch(() => {});
}

// ---------------------------------------------------------------- for the rest of the app

/**
 * Someone searched for `q` and got these products back: if the Coles ones are
 * more than a day old, fetch Coles' own results for it now. Returns whether
 * fresher prices are on the way.
 */
export function refreshForSearch(q, productIds) {
  if (!enabled() || !productIds.length) return false;
  const query = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  if (!query) return false;
  if (queries.some((x) => x.q === query)) return true;
  if (clock() - (queried.get(query) || 0) < QUERY_AGAIN_MS) return false;
  const st = load();
  if (st.blockedUntil && clock() < Date.parse(st.blockedUntil)) return false;
  const stale = getDb().prepare(`SELECT COUNT(*) n FROM products WHERE store = 'coles' AND last_seen < ?
    AND id IN (SELECT value FROM json_each(?))`).get(new Date(clock() - STALE_MS).toISOString(), JSON.stringify(productIds)).n;
  if (!stale || queries.length >= MAX_QUEUE) return false;
  queries.push({ q: query });
  pump().catch(() => {});
  return true;
}

/** Start the whole-shop pass again now (the admin page's Refresh button). */
export function restartPass() {
  const st = load();
  st.pass = null;
  st.lastPassAt = null;
  st.blockedUntil = null;
  save(st);
  pump().catch(() => {});
}

/** For the admin page. */
export function status() {
  if (!enabled()) return { enabled: false };
  const st = load();
  return {
    enabled: true,
    perHour: rate(),
    lastHour: usedLastHour(),
    blockedUntil: st.blockedUntil && clock() < Date.parse(st.blockedUntil) ? st.blockedUntil : null,
    specials: st.specials?.day === today() ? { done: Math.min(st.specials.page - 1, st.specials.pages), of: st.specials.pages } : null,
    pass: st.pass ? { startedAt: st.pass.startedAt, done: st.pass.done.length, of: st.pass.total || null } : null,
    lastPassAt: st.lastPassAt,
    waiting: queries.length + st.listQueue.length,
  };
}

/** Tests: forget the in-memory bits. */
export function reset() {
  recent.length = 0;
  queries.length = 0;
  queried.clear();
  lastRequestAt = 0;
  session = null;
}
