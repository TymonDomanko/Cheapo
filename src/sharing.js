// Sharing each shop's daily refresh between this server and the collectors
// (the site's home collector and approved helpers, see src/helpers.js).
//
// After the scheduled time (SCRAPE_CRON) each shop's refresh is split into
// parts — Woolworths and ALDI by department, Harris Farm by blocks of pages —
// and every connection that can do the shop takes a part at a time:
//   - all the parts go into one refresh (one scrape run), which finishes when
//     the last part is in, so a refresh done by three connections counts like
//     one done by one;
//   - a shop has at most as many parts on the go at once as one connection
//     would fetch at once (WOOLWORTHS_CONCURRENCY, 2; others 1), so sharing
//     it out doesn't ask the shop for more at a time;
//   - a part whose connection goes quiet is handed on; a connection that fails
//     a part isn't given it again, and one that's blocked by a shop (a bot
//     check) is paused for that shop for an hour (then 2, 4, up to 8), and
//     meanwhile takes parts of other shops;
//   - parts still missing when the next refresh is due are reported as a failed
//     refresh (and products aren't marked gone).
// Coles is shared page by page instead (src/coles-live.js), and IGA (one
// refresh per store) stays on this server.

import { getDb } from './db.js';
import { getSetting } from './settings.js';
import { SCRAPERS, startRun, getRun, recordBatch, finishRun, serverStores, priceArea } from './scrapers/index.js';
import { index as indexParts, fetchPart } from './scrapers/parts.js';
import { nextRun } from './mini-cron.js';
import * as helpers from './helpers.js';

const SERVER = helpers.SERVER.id;
const IDLE_MS = 10 * 60 * 1000; // a part nothing has been sent for in this long is handed on
const PAGE_BLOCK = 3; // pages in a block, for shops without departments
const MAX_ITEMS = 2000;
const PAUSE_MS = Number(process.env.BLOCKED_PAUSE_MINUTES ?? 60) * 60 * 1000; // first pause after a bot check; doubles each time
const MAX_PAUSE_MS = 8 * 3600 * 1000;

let clock = () => Date.now();
/** Tests: pretend it's a different time. */
export function setClock(fn) {
  clock = fn;
}
const iso = () => new Date(clock()).toISOString();
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

/** When the daily refresh last fell due (the latest SCRAPE_CRON time), or null with the schedule turned off. */
export function lastScheduled(now = clock()) {
  const expr = process.env.SCRAPE_CRON ?? '15 4 * * *';
  if (!expr) return null;
  let t = nextRun(expr, new Date(now - 8 * 86400000), process.env.TZ || undefined);
  for (;;) {
    const n = nextRun(expr, t, process.env.TZ || undefined);
    if (n.getTime() > now) return t;
    t = n;
  }
}

/** Shops whose refresh is shared out. */
export const SHARED = ['woolworths', 'aldi', 'harrisfarm', 'danmurphys', 'bws', 'liquorland'].filter((s) => SCRAPERS[s]);
/** How many parts of a shop may be fetched at once, by everyone together. */
export function atOnce(store) {
  const n = Number(process.env[`${store.toUpperCase()}_CONCURRENCY`]);
  return n > 0 ? n : store === 'woolworths' ? 2 : 1;
}

// ---------------------------------------------------------------- state

const key = (store) => `share:${store}`;
function load(store) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key(store));
  return row ? JSON.parse(row.value) : null;
}
function save(store, pass) {
  getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key(store), JSON.stringify(pass));
}

function firstParts(store) {
  const scraper = SCRAPERS[store];
  if (scraper.departments) return null; // fetched by whoever takes the index
  if (scraper.PAGED) return [1, 2, 3].map((b) => pagesPart(b));
  return [{ key: 'all', kind: 'whole', label: 'Everything' }];
}
const pagesPart = (block) => {
  const from = (block - 1) * PAGE_BLOCK + 1;
  return { key: `p${from}`, kind: 'pages', from, to: from + PAGE_BLOCK - 1, label: `pages ${from}–${from + PAGE_BLOCK - 1}` };
};
const newPart = (p) => ({ ...p, done: false, worker: null, touchedAt: null, failedBy: [] });

function startPass(store, since) {
  const { runId, startedAt } = startRun(store, { source: 'shared' });
  getDb().prepare("UPDATE scrape_runs SET worker = 'shared' WHERE id = ?").run(runId);
  return { since, runId, startedAt, parts: firstParts(store)?.map(newPart) ?? null, indexWorker: null, indexAt: null, indexFailedBy: [], paused: {}, finished: false };
}

/** Finish a pass that didn't get everything (no products are marked gone). */
function abandon(pass, why) {
  const run = getRun(pass.runId);
  if (run?.status === 'running') finishRun(run, { error: why });
  pass.finished = true;
}

/**
 * Today's pass for a shop: carries on, or starts after the scheduled time
 * (reporting yesterday's if it's unfinished). With the schedule turned off,
 * only one started from the admin page.
 */
function current(store) {
  const since = lastScheduled()?.toISOString();
  let pass = load(store);
  if (!since) return pass;
  if (pass && Date.parse(since) > Date.parse(pass.since)) {
    if (!pass.finished) {
      const done = pass.parts?.filter((p) => p.done).length || 0;
      abandon(pass, pass.parts ? `Only ${done} of ${pass.parts.length} parts were fetched before the next refresh was due` : 'Its departments couldn’t be fetched');
      save(store, pass);
    }
    pass = null;
  }
  if (!pass) {
    pass = startPass(store, since);
    save(store, pass);
  }
  return pass;
}

const idle = (touchedAt) => clock() - Date.parse(touchedAt || 0) > IDLE_MS;
/** Is worker `w` paused for this shop after a bot check? (`barred`: passes saved before pauses, blocked all day.) */
const paused = (pass, w) => Date.parse(pass.paused?.[w]?.until || 0) > clock() || !!pass.barred?.includes(w);
const busy = (pass) => (pass.indexWorker && !idle(pass.indexAt) ? 1 : 0) + (pass.parts || []).filter((p) => !p.done && p.worker && !idle(p.touchedAt)).length;

// ---------------------------------------------------------------- handing out parts

// Shops whose online prices depend on where you connect from (Woolworths picks a
// store by location, and it can't be set yet): one refresh stays on one
// connection, so prices don't flip between connections. Others only step in
// for what it can't do.
export const ONE_CONNECTION = new Set((process.env.ONE_CONNECTION_SHOPS ?? 'woolworths').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * What the admin page keeps each shop's refresh with: { store: worker }, where
 * the worker is a connection, or '@<id>' for whichever connections the shop
 * gives that store (Woolworths picks one by location).
 */
export function preferred() {
  const ok = new Set(['server', ...helpers.list().filter((x) => !x.disabled).map((x) => `h${x.id}`)]);
  return Object.fromEntries(String(getSetting('PREFERRED_CONNECTIONS') || '').split(',').map((p) => p.split('='))
    .filter(([store, w]) => SHARED.includes(store) && (w?.startsWith('@') || (ok.has(w) && (w !== SERVER || serverStores().includes(store))))));
}

/**
 * The connection a shop's refresh belongs to: the one chosen on the admin page;
 * else for a one-connection shop this server if it crawls it, or whoever started it.
 */
function ownerOf(store, pass) {
  const chosen = preferred()[store];
  if (chosen) return chosen;
  return !ONE_CONNECTION.has(store) ? null : serverStores().includes(store) ? SERVER : pass.owner || null;
}

// The store each connection is given by a shop that picks one by location
// (Woolworths), as the connections report it: { store: { worker: { id, at } } }.
// Connections given the same store as the owner share its refresh.
const AREA_KEY = 'share:areas';
function areas() {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(AREA_KEY);
  return row ? JSON.parse(row.value) : {};
}
/** Worker `w` says which store `store` gives it ({ woolworths: { id: '1101', name: 'Eastwood, NSW' } }, or just the id). */
export function noteAreas(w, reported) {
  if (!reported || typeof reported !== 'object') return;
  const all = areas();
  let changed = false;
  for (const [store, value] of Object.entries(reported)) {
    const id = value && typeof value === 'object' ? value.id : value;
    if (!SCRAPERS[store]?.area || id == null || !/^[\w-]{1,20}$/.test(String(id))) continue;
    const name = typeof value?.name === 'string' ? value.name.replace(/[^\p{L}\p{N} ,.'’&()-]/gu, '').slice(0, 60) || null : null;
    const before = all[store]?.[w];
    (all[store] ||= {})[w] = { id: String(id), name: name || (before?.id === String(id) ? before.name : null), at: iso() };
    changed = true;
  }
  if (changed) getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(AREA_KEY, JSON.stringify(all));
}
const AREA_FRESH_MS = 2 * 86400000;

/** For the admin page: which store each connection is given, by shop: { store: [{ area, name, workers: [{ id, name }] }] }. */
export function connectionsByArea() {
  const out = {};
  for (const [store, ws] of Object.entries(areas())) {
    if (!SHARED.includes(store)) continue;
    const by = {};
    const named = {};
    for (const [w, a] of Object.entries(ws)) {
      const id = areaOf(store, w);
      if (!id || !(w === SERVER || helpers.list().some((x) => `h${x.id}` === w))) continue;
      (by[id] ||= []).push({ id: w, name: helpers.nameOf(w) });
      if (a.name) named[id] = a.name;
    }
    out[store] = Object.entries(by).map(([area, workers]) => ({ area, name: named[area] || null, workers }));
  }
  return out;
}
const areaOf = (store, w) => {
  const a = areas()[store]?.[w];
  return a && clock() - Date.parse(a.at) < AREA_FRESH_MS ? a.id : null;
};
const sameArea = (store, owner, w) => {
  const want = owner.startsWith('@') ? owner.slice(1) : areaOf(store, owner);
  return !!want && areaOf(store, w) === want;
};
/** Is `w` the shop's owner, or given the same store as it? */
const owns = (store, pass, w) => {
  const owner = ownerOf(store, pass);
  return !!owner && (owner === w || sameArea(store, owner, w));
};

/** May worker `w` take this part (null: the department list)? */
function allowed(store, pass, w, part) {
  const owner = ownerOf(store, pass);
  if (!owner || owner === w || sameArea(store, owner, w)) return true;
  // The owner can't: blocked by the shop, failed this part, or gone quiet.
  if (owner.startsWith('@')) {
    // A store: nobody given it has been at work for a while, or they've all failed this or been blocked.
    const given = Object.keys(areas()[store] || {}).filter((x) => sameArea(store, owner, x));
    const failed = part ? part.failedBy : pass.indexFailedBy;
    return idle(pass.ownerAt || pass.since) || (given.length > 0 && given.every((x) => failed.includes(x) || paused(pass, x)));
  }
  return paused(pass, owner) || (part ? part.failedBy.includes(owner) : pass.indexFailedBy.includes(owner)) || idle(pass.ownerAt || pass.since);
}

/** How many parts of a shop one connection fetches at once: this server its usual pace, helpers one. */
const ownShare = (store, w) => (w === SERVER ? atOnce(store) : 1);

/**
 * The next part for worker `w`, out of the shops it can do, or null.
 * Returns { store, runId, part }.
 */
export function take(w, canDo = []) {
  const stores = SHARED.filter((s) => (w === SERVER ? serverStores().includes(s) : !canDo.length || canDo.includes(s)));
  for (const store of stores) {
    const pass = current(store);
    if (!pass || pass.finished || paused(pass, w)) continue;
    const mine = (pass.parts || []).filter((p) => p.worker === w && !p.done && !idle(p.touchedAt)).length + (pass.indexWorker === w && !idle(pass.indexAt) ? 1 : 0);
    if (mine >= ownShare(store, w)) continue;
    if (busy(pass) >= atOnce(store)) continue;
    const claim = () => {
      if (ONE_CONNECTION.has(store) && !pass.owner) pass.owner = w;
      if (owns(store, pass, w)) pass.ownerAt = iso();
    };
    if (!pass.parts) {
      if (pass.indexWorker && !idle(pass.indexAt)) continue;
      if (pass.indexFailedBy.includes(w) || !allowed(store, pass, w, null)) continue;
      Object.assign(pass, { indexWorker: w, indexAt: iso() });
      claim();
      save(store, pass);
      return { store, runId: pass.runId, part: { key: 'index', kind: 'index', label: 'departments' } };
    }
    const part = pass.parts.find((p) => !p.done && (!p.worker || idle(p.touchedAt)) && !p.failedBy.includes(w) && allowed(store, pass, w, p));
    if (!part) continue;
    Object.assign(part, { worker: w, touchedAt: iso() });
    claim();
    save(store, pass);
    const { done, worker, touchedAt, failedBy, error, ...send } = part;
    return { store, runId: pass.runId, part: { ...send, options: priceArea(store) } };
  }
  return null;
}

function mine(store, w, partKey) {
  if (!SHARED.includes(store)) throw httpError(400, 'Unknown shop');
  const pass = load(store);
  const part = partKey === 'index' ? null : pass?.parts?.find((p) => p.key === partKey);
  const holds = pass && !pass.finished && (partKey === 'index' ? pass.indexWorker === w : part && !part.done && part.worker === w);
  if (!holds) throw httpError(409, 'That part was handed on to someone else; leave it');
  return { pass, part };
}

/** Products for a part worker `w` holds. */
export function items(w, store, partKey, list) {
  if (!Array.isArray(list) || list.length > MAX_ITEMS) throw httpError(400, `Send { items: [...] } (up to ${MAX_ITEMS} per batch)`);
  const { pass, part } = mine(store, w, partKey);
  const r = recordBatch(getRun(pass.runId), list);
  part.touchedAt = iso();
  if (owns(store, pass, w)) pass.ownerAt = part.touchedAt;
  save(store, pass);
  return r;
}

/**
 * Worker `w` has finished a part: { cats } for the index, { more } for a block
 * of pages, or { error } / { blocked } if it couldn't.
 */
export function done(w, store, partKey, body = {}) {
  const { pass, part } = mine(store, w, partKey);
  if (body.error || body.blocked) {
    const why = String(body.blocked || body.error).slice(0, 200);
    console.warn(`[${store}] ${helpers.nameOf(w)}: ${partKey} failed — ${why}`);
    // Kept so the admin page can say why.
    const error = { by: helpers.nameOf(w), why, at: iso() };
    // Blocked by the shop: pause this connection for the shop (it gets other
    // shops' parts meanwhile), and let it try this part again afterwards.
    const failedBy = (list) => (body.blocked ? list : [...list, w]);
    if (partKey === 'index') Object.assign(pass, { indexWorker: null, indexAt: null, indexFailedBy: failedBy(pass.indexFailedBy), indexError: error });
    else Object.assign(part, { worker: null, touchedAt: null, failedBy: failedBy(part.failedBy), error });
    if (body.blocked) {
      const times = (pass.paused?.[w]?.times || 0) + 1;
      const until = new Date(clock() + Math.min(MAX_PAUSE_MS, PAUSE_MS * 2 ** (times - 1))).toISOString();
      (pass.paused ||= {})[w] = { until, times };
      console.warn(`[${store}] ${helpers.nameOf(w)}: paused for ${store} until ${until}; it can do other shops meanwhile`);
    }
    save(store, pass);
    return { ok: false };
  }
  if (partKey === 'index') {
    const cats = (Array.isArray(body.cats) ? body.cats : []).filter((c) => c && typeof c.key === 'string').slice(0, 200);
    if (!cats.length) throw httpError(400, 'No departments came back');
    pass.parts = cats.map((c) => newPart({ key: c.key.slice(0, 100), kind: 'dept', label: String(c.label || c.key).slice(0, 80), dept: c.dept }));
    Object.assign(pass, { indexWorker: null, indexAt: null });
  } else {
    Object.assign(part, { done: true, worker: null });
    // A full last block of pages: there's more after it.
    if (part.kind === 'pages' && body.more && part.to === Math.max(...pass.parts.map((p) => p.to || 0)) && pass.parts.length < 200) {
      pass.parts.push(newPart(pagesPart(pass.parts.length + 1)));
    }
  }
  if (pass.parts?.every((p) => p.done)) {
    finishRun(getRun(pass.runId), { complete: true });
    pass.finished = true;
  }
  save(store, pass);
  return { ok: true };
}

/** The runs of shared refreshes still in progress. */
export function activeRunIds() {
  return SHARED.map(load).filter((p) => p && !p.finished).map((p) => p.runId);
}

/** Start a shop's refresh again now (the admin page's Refresh button). */
export function restart(store) {
  const old = load(store);
  if (old && !old.finished) {
    abandon(old, 'Started again from the admin page');
    save(store, old);
  }
  save(store, startPass(store, iso())); // counts as today's, until the next scheduled time
}

// ---------------------------------------------------------------- this server's share

const running = new Map(); // shop → parts this server is fetching
let areasCheckedAt = 0;

/** Find out which store each location-priced shop gives this server (every 6 hours). */
function checkOwnAreas() {
  if (Date.now() - areasCheckedAt < 6 * 3600 * 1000) return;
  areasCheckedAt = Date.now();
  for (const store of SHARED.filter((s) => SCRAPERS[s].area && serverStores().includes(s))) {
    SCRAPERS[store].area().then((a) => a && noteAreas(SERVER, { [store]: a }), () => {});
  }
}

/** Take and fetch parts of the shops this server crawls, if there are any going (each shop at its usual pace). */
export function pump({ log = () => {} } = {}) {
  for (let i = 0; i < SHARED.length * 2; i++) {
    const job = take(SERVER, []); // skips shops it's already doing its share of
    if (!job) return;
    running.set(job.store, (running.get(job.store) || 0) + 1);
    runLocal(job, log).finally(() => running.set(job.store, running.get(job.store) - 1));
  }
}

async function runLocal({ store, part }, log) {
  try {
    if (part.kind === 'index') {
      done(SERVER, store, 'index', { cats: await indexParts(SCRAPERS[store]) });
      return;
    }
    const result = {};
    for await (const batch of fetchPart(SCRAPERS[store], part, { log, result })) {
      if (batch.length) items(SERVER, store, part.key, batch);
    }
    done(SERVER, store, part.key, { more: result.more });
  } catch (e) {
    if (e.status === 409) return; // handed on meanwhile
    try {
      done(SERVER, store, part.key, e.blocked ? { blocked: e.message } : { error: e.message });
    } catch {
      // handed on meanwhile
    }
  }
}

let timer = null;
/** Check every 30 seconds for parts this server could do (the server calls this). */
export function start() {
  if (timer) return;
  checkOwnAreas();
  timer = setInterval(() => {
    checkOwnAreas();
    pump();
  }, 30 * 1000);
  timer.unref?.();
}

// ---------------------------------------------------------------- the admin page

export function status() {
  const out = {};
  for (const store of SHARED) {
    const pass = load(store);
    if (!pass) continue;
    const parts = pass.parts || [];
    out[store] = {
      startedAt: pass.startedAt,
      finished: pass.finished,
      done: parts.filter((p) => p.done).length,
      of: pass.parts ? parts.length : null,
      doing: [
        ...(pass.indexWorker && !idle(pass.indexAt) ? [{ id: pass.indexWorker, worker: helpers.nameOf(pass.indexWorker), part: 'the department list' }] : []),
        ...parts.filter((p) => !p.done && p.worker && !idle(p.touchedAt)).map((p) => ({ id: p.worker, worker: helpers.nameOf(p.worker), part: p.label })),
      ],
      preferred: !preferred()[store] ? null : preferred()[store].startsWith('@') ? `whichever connection gets store ${preferred()[store].slice(1)}` : helpers.nameOf(preferred()[store]),
      // The store each connection is given (shops that pick one by location).
      areas: Object.entries(areas()[store] || {}).filter(([w]) => areaOf(store, w)).map(([w, a]) => ({ id: w, worker: helpers.nameOf(w), area: a.id, name: a.name || null })),
      // Connections paused for this shop after a bot check, and until when.
      paused: [
        ...Object.entries(pass.paused || {}).filter(([w]) => paused(pass, w)).map(([w, p]) => ({ id: w, worker: helpers.nameOf(w), until: p.until })),
        ...(pass.barred || []).map((w) => ({ id: w, worker: helpers.nameOf(w), until: null })),
      ],
      // Parts that failed and haven't been done since, with the latest reason.
      stuck: [
        ...(!pass.parts && pass.indexError ? [{ part: 'the department list', ...pass.indexError }] : []),
        ...parts.filter((p) => !p.done && p.error).map((p) => ({ part: p.label, ...(p.error || {}) })),
      ],
    };
  }
  return out;
}

/** Tests: forget what this server is doing. */
export function reset() {
  running.clear();
}
