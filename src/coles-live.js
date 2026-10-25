// Coles, a little at a time.
//
// Coles blocks connections that ask for a lot at once (a "Pardon Our
// Interruption" bot check). So rather than crawl the whole shop in one go
// every night, Coles is asked for one page at a time, all day, at most
// COLES_PAGES_PER_HOUR pages an hour (default 30; also on the Admin page) in
// this order:
//   1. searches: when someone searches and the Coles results are over a day
//      old, Coles' own search for those words (one page, up to 48 products)
//      is fetched straight away;
//   2. the Coles products on people's lists and watches, once a day;
//   3. everything on special, once a day (skipped when the whole shop is
//      done daily anyway);
//   4. the whole shop, every COLES_FULL_EVERY_DAYS (default 2), carrying on
//      where it left off. The days count from when the last pass started;
//   5. barcodes for matching, with whatever time is left.
//
// The work can be shared. This server and any helpers (approved collectors on
// other connections, see src/helpers.js) each take a department (or the
// specials) at a time and fetch its pages. The page limit is for all of them
// together: with two connections each goes half as fast, so more helpers make
// it more reliable, not heavier on Coles. Searches, lists and barcodes stay on
// this server. A bot check pauses just the connection that got it (2 hours,
// doubling up to a day), and its department goes back for someone else.
// Set COLES_PAGES_PER_HOUR=0 to go back to the nightly full crawl.

import { getDb, upsertProducts, markUnseenUnavailable } from './db.js';
import { colesPages } from './scrapers/coles-pages.js';
import { SKIP } from './scrapers/coles.js';
import { startRun, getRun, finishRun, serverStores } from './scrapers/index.js';
import { checkRun } from './admin-alerts.js';
import { barcodeTodo, saveBarcode } from './barcodes.js';
import { getSetting } from './settings.js';
import * as helpers from './helpers.js';

const KEY = 'coles-live';
const SERVER = helpers.SERVER.id;
const STALE_MS = 24 * 3600 * 1000;
const QUERY_AGAIN_MS = 6 * 3600 * 1000; // the same search isn't fetched again for this long
const QUERY_GAP_MS = 3000; // searches go straight away, but not back to back
const MAX_QUEUE = 20;
const LIST_REFRESH_MS = 20 * 3600 * 1000;
const LIST_LIMIT = 40;
const GRACE_MS = 3 * 60 * 1000; // a helper this late for its next turn is counted out, and its work handed on
const LEASE_MAX_MS = 30 * 60 * 1000; // work nobody has touched in this long is handed on, whoever has it
const MAX_ITEMS = 200; // products in one page's result

export const rate = () => {
  const n = Number(getSetting('COLES_PAGES_PER_HOUR') ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const fullEveryMs = () => Number(process.env.COLES_FULL_EVERY_DAYS ?? 2) * 86400000;
/** Steady mode is on: Coles is refreshed a page at a time (by this server, helpers or both). */
export const enabled = () => rate() > 0 && process.env.DISABLE_BACKGROUND_SCRAPES !== 'true';
/** This server fetches Coles pages itself (and so can refresh searches). */
const serverWorks = () => enabled() && serverStores().includes('coles');

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
  const st = { specials: null, pass: null, lastPassAt: null, listsDay: null, listQueue: [], workers: {}, ...(row ? JSON.parse(row.value) : {}) };
  // Saved by an older version: one connection's pause, and a pass without a department list.
  if ('blockedUntil' in st) {
    st.workers[SERVER] = { blockedUntil: st.blockedUntil, backoffHours: st.backoffHours || 0, blockReported: !!st.blockReported };
    delete st.blockedUntil;
    delete st.backoffHours;
    delete st.blockReported;
  }
  if (st.pass && !('depts' in st.pass)) {
    st.pass = { startedAt: st.pass.startedAt, depts: null, done: st.pass.done || [], resume: st.pass.cat ? { dept: st.pass.cat, page: st.pass.page } : null };
  }
  return st;
}
function save(st) {
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(st));
}
const workerState = (st, w) => (st.workers[w] ||= { blockedUntil: null, backoffHours: 0, blockReported: false });
const isBlocked = (st, w) => {
  const until = st.workers[w]?.blockedUntil;
  return !!until && clock() < Date.parse(until);
};

// Requests made in the last hour, by whom (in memory: a restart just starts counting again).
const recent = []; // { at, worker }
const lastAt = new Map(); // worker → when it last started a page
const dueAt = new Map(); // helper → when it's due to ask again (told in each answer)
function prune() {
  while (recent.length && recent[0].at < clock() - 3600 * 1000) recent.shift();
}
function usedLastHour(worker = null) {
  prune();
  return worker ? recent.filter((r) => r.worker === worker).length : recent.length;
}
function count(worker, n) {
  for (let i = 0; i < Math.max(1, n || 0); i++) recent.push({ at: clock(), worker });
}

/** A helper that's late for its turn (or never told when to come back): it's stopped or lost. */
const overdue = (w) => !dueAt.has(w) || clock() > dueAt.get(w) + GRACE_MS;
const holds = (st, w) => st.specials?.worker === w || st.pass?.indexWorker === w || !!st.pass?.depts?.some((d) => d.worker === w && !d.done);
/**
 * Connections sharing the pages now: this server (unless paused) and helpers
 * that are part-way through something and on time. A helper that stops
 * answering drops out as soon as it misses its turn, so the rest speed back up.
 */
function activeWorkers(st) {
  const ids = [...dueAt.keys()].filter((w) => !overdue(w) && holds(st, w));
  if (serverWorks()) ids.unshift(SERVER);
  return [...new Set(ids)].filter((w) => !isBlocked(st, w));
}
/** The most Coles pages an hour one connection may fetch (this server included). */
export function capFor(w) {
  const site = Number(getSetting('COLES_MAX_PER_CONNECTION') ?? 40) || 40;
  const own = w === SERVER ? null : helpers.colesMax(w);
  return Math.max(1, Math.min(own ?? site, site));
}

/**
 * Pages an hour for each connection sharing the work (plus `w`): the limit
 * split evenly, but none above its own cap; what a capped one can't use goes
 * to the others. Together they never exceed the limit.
 */
function shares(st, w) {
  let open = [...new Set([...activeWorkers(st), w])].map((id) => ({ id, cap: capFor(id) }));
  let left = rate();
  const out = {};
  while (open.length) {
    const even = left / open.length;
    const capped = open.filter((o) => o.cap <= even);
    if (!capped.length) {
      for (const o of open) out[o.id] = even;
      break;
    }
    for (const o of capped) {
      out[o.id] = o.cap;
      left -= o.cap;
    }
    open = open.filter((o) => o.cap > even);
  }
  return out;
}
/** How long connection `w` waits between pages. */
function gapMs(st, w) {
  return (3600 * 1000) / Math.max(0.01, shares(st, w)[w]);
}
/** Until when `w` is at its cap for the last hour (0 if it isn't). */
function capWait(w) {
  if (usedLastHour(w) < capFor(w)) return 0;
  const mine = recent.filter((r) => r.worker === w);
  return Math.max(1000, mine[mine.length - capFor(w)].at + 3600 * 1000 - clock());
}
const leaseFree = (st, holder, touchedAt) => !holder || (holder !== SERVER && overdue(holder)) || clock() - Date.parse(touchedAt || 0) > LEASE_MAX_MS;

const queries = []; // searches waiting: { q }
const queried = new Map(); // search → when it was last fetched

let local = null;
let makeClient = null;
const localPages = () => (local ||= colesPages(makeClient || undefined));
/** Tests: a stand-in for the website (for this server's own requests). */
export function setClientFactory(fn) {
  makeClient = fn;
  local = null;
}

// ---------------------------------------------------------------- handing out work

const specialsDue = (st) => fullEveryMs() > 86400000 // a daily whole-shop pass sees every special anyway
  && !(st.specials?.day === today() && st.specials.page > st.specials.pages);

/** Is a whole-shop pass running or due? Counted from when the last one started. */
function passDue(st) {
  const lastStart = st.lastPassStartedAt || st.lastPassAt;
  return !!st.pass || !lastStart || clock() - Date.parse(lastStart) >= fullEveryMs();
}

/**
 * The next page for worker `w`, or null. Takes (leases) a department or the
 * specials for it if it hasn't one. Doesn't check the pace; see nextFor.
 */
function pick(st, w) {
  if (w === SERVER && st.listQueue.length) return { kind: 'list', q: st.listQueue.shift() };
  // Carry on with what it already has.
  if (st.specials?.worker === w && st.specials.day === today() && st.specials.page <= st.specials.pages) {
    st.specials.touchedAt = iso();
    return { kind: 'specials', page: st.specials.page };
  }
  const mine = st.pass?.depts?.find((d) => !d.done && d.worker === w);
  if (mine) {
    mine.touchedAt = iso();
    return { kind: 'browse', dept: mine.dept, name: mine.name, page: mine.page };
  }
  // Something new.
  if (specialsDue(st) && (st.specials?.day !== today() || leaseFree(st, st.specials.worker, st.specials.touchedAt))) {
    if (st.specials?.day !== today()) st.specials = { day: today(), page: 1, pages: 1 };
    Object.assign(st.specials, { worker: w, touchedAt: iso() });
    return { kind: 'specials', page: st.specials.page };
  }
  if (passDue(st)) {
    st.pass ||= { startedAt: iso(), depts: null, done: [] };
    if (!st.pass.depts) {
      if (!leaseFree(st, st.pass.indexWorker, st.pass.indexAt)) return null;
      Object.assign(st.pass, { indexWorker: w, indexAt: iso() });
      return { kind: 'index' };
    }
    const free = st.pass.depts.find((d) => !d.done && leaseFree(st, d.worker, d.touchedAt));
    if (free) {
      Object.assign(free, { worker: w, touchedAt: iso() });
      return { kind: 'browse', dept: free.dept, name: free.name, page: free.page };
    }
  }
  if (w === SERVER) {
    const [p] = barcodeTodo(1);
    if (p) return { kind: 'barcode', id: p.id, url: p.product_url };
  }
  return null;
}

/**
 * What worker `w` should do now: { job } or { wait } (milliseconds until it's
 * worth asking again). Saves the lease.
 */
function nextFor(w) {
  const st = load();
  if (st.listsDay !== today()) queueLists(st);
  const ws = workerState(st, w);
  if (isBlocked(st, w)) {
    save(st);
    return { wait: Date.parse(ws.blockedUntil) - clock() };
  }
  const gap = gapMs(st, w);
  const since = clock() - (lastAt.get(w) || 0);
  if (since < gap) return { wait: gap - since };
  if (capWait(w)) return { wait: capWait(w) };
  if (usedLastHour() >= rate()) {
    prune();
    return { wait: Math.max(1000, (recent[0]?.at || clock()) + 3600 * 1000 - clock()) };
  }
  const job = pick(st, w);
  save(st);
  if (!job) return { wait: Math.min(gap, 15 * 60 * 1000) };
  lastAt.set(w, clock());
  return { job };
}

/** Save what worker `w` fetched for `job`. */
function complete(w, job, result) {
  const st = load();
  count(w, result.requests);
  Object.assign(workerState(st, w), { backoffHours: 0, blockedUntil: null, blockReported: false });
  const items = Array.isArray(result.items) ? result.items.slice(0, MAX_ITEMS) : [];
  const pages = Math.max(0, Math.min(1000, Number(result.pages) || 0));
  if (job.kind === 'search' || job.kind === 'list') {
    if (items.length) upsertProducts('coles', items, iso());
  } else if (job.kind === 'specials') {
    const s = st.specials;
    if (s?.worker === w && s.day === today() && s.page === job.page) { // still theirs
      if (items.length) upsertProducts('coles', items, iso());
      s.pages = pages;
      s.page++;
      s.touchedAt = iso();
      if (s.page > s.pages) s.worker = null;
    }
  } else if (job.kind === 'index') {
    if (st.pass && !st.pass.depts && st.pass.indexWorker === w) {
      const cats = (Array.isArray(result.cats) ? result.cats : []).filter((c) => c && typeof c.dept === 'string' && !SKIP.has(c.dept));
      const resume = st.pass.resume;
      st.pass.depts = cats.slice(0, 100).map((c) => ({
        dept: c.dept, name: String(c.name || c.dept).slice(0, 80), products: Number(c.products) || 0,
        page: resume?.dept === c.dept ? resume.page : 1, pages: null, done: st.pass.done.includes(c.dept), worker: null, touchedAt: null,
      }));
      st.pass.indexWorker = null;
      delete st.pass.resume;
      if (!st.pass.depts.length) st.pass.depts = null; // nothing came back: ask again later
    }
  } else if (job.kind === 'browse') {
    const d = st.pass?.depts?.find((x) => x.dept === job.dept);
    if (d && d.worker === w && d.page === job.page && !d.done) {
      if (items.length) upsertProducts('coles', items, iso());
      d.pages = pages;
      d.touchedAt = iso();
      if (d.page >= pages) {
        d.done = true;
        d.worker = null;
        st.pass.done.push(d.dept);
      } else d.page++;
      if (st.pass.depts.every((x) => x.done)) finishPass(st);
    }
  } else if (job.kind === 'barcode') {
    saveBarcode(job.id, result.gtin || null, result.canonical || null);
  }
  save(st);
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
  st.lastPassStartedAt = st.pass.startedAt;
  st.pass = null;
}

/** Hand back whatever worker `w` was doing, keeping how far it got. */
function release(st, w) {
  if (st.specials?.worker === w) st.specials.worker = null;
  for (const d of st.pass?.depts || []) if (d.worker === w) d.worker = null;
  if (st.pass?.indexWorker === w) st.pass.indexWorker = null;
}

/** Coles is blocking worker `w`: stop it for a while, longer each time; the others carry on. */
function blocked(w, job, message, requests) {
  const st = load();
  count(w, requests);
  const ws = workerState(st, w);
  ws.backoffHours = Math.min(24, (ws.backoffHours || 1) * 2);
  ws.blockedUntil = new Date(clock() + ws.backoffHours * 3600 * 1000).toISOString();
  release(st, w);
  if (job?.kind === 'list') st.listQueue.unshift(job.q);
  if (!ws.blockReported) {
    ws.blockReported = true;
    const who = w === SERVER ? '' : ` (${helpers.nameOf(w)})`;
    const { runId } = startRun('coles', { source: w === SERVER ? 'server' : 'collector' });
    getDb().prepare('UPDATE scrape_runs SET worker = ? WHERE id = ?').run(w, runId);
    finishRun(getRun(runId), { error: `${message}${who}. Trying again ${ws.backoffHours === 2 ? 'in 2 hours' : `in ${ws.backoffHours} hours`}, carrying on where it stopped.` });
  }
  console.warn(`[coles] ${helpers.nameOf(w)}: ${message} — pausing it for ${ws.backoffHours} hours`);
  save(st);
}

// ---------------------------------------------------------------- helpers' collectors

/** A helper asks for a Coles page: { job, wait } or { wait } (in seconds). */
export function helperNext(worker) {
  if (!enabled()) return { job: null, wait: 3600, off: true };
  dueAt.set(worker.id, clock()); // here now
  const r = nextFor(worker.id);
  const wait = r.job ? gapMs(load(), worker.id) : r.wait;
  dueAt.set(worker.id, clock() + wait);
  return { job: r.job || null, wait: Math.ceil(wait / 1000) };
}

/** A helper sends back a page: { job, items, pages, cats, requests } or { job, blocked: message } / { job, error }. */
export function helperResult(worker, body) {
  const job = body?.job;
  if (!job || typeof job.kind !== 'string' || ['list', 'barcode', 'search'].includes(job.kind)) {
    throw Object.assign(new Error('Send back the job you were given'), { status: 400 });
  }
  dueAt.set(worker.id, clock());
  if (body.blocked) blocked(worker.id, job, String(body.blocked).slice(0, 200), body.requests);
  else if (body.error) {
    console.warn(`[coles] ${worker.name}: ${String(body.error).slice(0, 200)}`);
    const st = load();
    count(worker.id, body.requests);
    release(st, worker.id);
    save(st);
  } else complete(worker.id, job, body);
  const wait = nextWaitMs(worker.id);
  dueAt.set(worker.id, clock() + wait);
  return { wait: Math.ceil(wait / 1000) };
}

function nextWaitMs(w) {
  const st = load();
  if (isBlocked(st, w)) return Date.parse(st.workers[w].blockedUntil) - clock();
  return Math.max(capWait(w), gapMs(st, w) - (clock() - (lastAt.get(w) || 0)));
}

// ---------------------------------------------------------------- this server

let inflight = null;

/**
 * Do whatever's next for this server, if it's time. Searches go straight away
 * (a few seconds apart); everything else at its share of the pace.
 * Called while it's already working, it waits for that.
 */
export function pump() {
  if (!serverWorks()) return Promise.resolve();
  inflight ||= work().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function work() {
  for (;;) {
    let job;
    if (queries.length) {
      const st = load();
      if (isBlocked(st, SERVER)) return;
      if (clock() - (lastAt.get(SERVER) || 0) < QUERY_GAP_MS || usedLastHour() >= rate() || capWait(SERVER)) return;
      const { q } = queries.shift();
      queried.set(q, clock());
      lastAt.set(SERVER, clock());
      job = { kind: 'search', q };
    } else {
      job = nextFor(SERVER).job;
      if (!job) return;
    }
    try {
      complete(SERVER, job, await localPages().run(job));
    } catch (e) {
      if (e.blocked) blocked(SERVER, job, e.message, e.requests);
      else {
        console.warn(`[coles] ${e.message}`);
        const st = load();
        count(SERVER, e.requests);
        release(st, SERVER);
        save(st);
      }
      return;
    }
    if (job.kind !== 'search') return; // paced jobs: one per turn
  }
}

/** Once a day: Coles products on lists and watches that haven't been refreshed lately. */
function queueLists(st) {
  st.listsDay = today();
  if (!serverWorks()) return;
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
  if (timer) return;
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
  if (!serverWorks() || !productIds.length) return false;
  const query = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  if (!query) return false;
  if (queries.some((x) => x.q === query)) return true;
  if (clock() - (queried.get(query) || 0) < QUERY_AGAIN_MS) return false;
  if (isBlocked(load(), SERVER)) return false;
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
  st.lastPassStartedAt = null;
  for (const ws of Object.values(st.workers)) Object.assign(ws, { blockedUntil: null, backoffHours: 0, blockReported: false });
  save(st);
  pump().catch(() => {});
}

/** For the admin page. */
export function status() {
  if (!enabled()) return { enabled: false };
  const st = load();
  const ids = new Set([...(serverWorks() ? [SERVER] : []), ...[...dueAt.keys()].filter((w) => !overdue(w)), ...Object.keys(st.workers).filter((w) => isBlocked(st, w))]);
  const doing = (w) => {
    if (st.specials?.worker === w && st.specials.day === today()) return `specials, page ${st.specials.page} of ${st.specials.pages}`;
    const d = st.pass?.depts?.find((x) => x.worker === w && !x.done);
    if (d) return `${d.name}, page ${d.page}${d.pages ? ` of ${d.pages}` : ''}`;
    return null;
  };
  const passPages = st.pass?.depts ? st.pass.depts.reduce((n, d) => n + (d.pages || Math.ceil(d.products / 48) || 1), 0) : null;
  const passDone = st.pass?.depts ? st.pass.depts.reduce((n, d) => n + (d.done ? (d.pages || 1) : d.page - 1), 0) : 0;
  return {
    enabled: true,
    perHour: rate(),
    lastHour: usedLastHour(),
    blockedUntil: isBlocked(st, SERVER) ? st.workers[SERVER].blockedUntil : null,
    perConnection: capFor(SERVER),
    workers: [...ids].map((w) => ({
      id: w,
      name: helpers.nameOf(w),
      cap: capFor(w),
      blockedUntil: isBlocked(st, w) ? st.workers[w].blockedUntil : null,
      lastHour: usedLastHour(w),
      doing: doing(w),
    })),
    specials: specialsDue(st) || st.specials?.day === today()
      ? (st.specials?.day === today() ? { done: Math.min(st.specials.page - 1, st.specials.pages), of: st.specials.pages } : { done: 0, of: null })
      : null,
    pass: st.pass ? { startedAt: st.pass.startedAt, done: st.pass.done.length, of: st.pass.depts?.length || null, pagesDone: passDone, pages: passPages } : null,
    lastPassAt: st.lastPassAt,
    waiting: queries.length + st.listQueue.length,
  };
}

/** Tests: forget the in-memory bits. */
export function reset() {
  recent.length = 0;
  queries.length = 0;
  queried.clear();
  lastAt.clear();
  dueAt.clear();
  local = null;
}
