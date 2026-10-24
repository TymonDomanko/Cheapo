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
//     a part isn't given it again, and one that's blocked by a shop isn't given
//     any more of that shop that day;
//   - parts still missing when the next refresh is due are reported as a failed
//     refresh (and products aren't marked gone).
// Coles is shared page by page instead (src/coles-live.js), and IGA (one
// refresh per store) stays on this server.

import { getDb } from './db.js';
import { SCRAPERS, startRun, getRun, recordBatch, finishRun, serverStores } from './scrapers/index.js';
import { index as indexParts, fetchPart } from './scrapers/parts.js';
import { nextRun } from './mini-cron.js';
import * as helpers from './helpers.js';

const SERVER = helpers.SERVER.id;
const IDLE_MS = 10 * 60 * 1000; // a part nothing has been sent for in this long is handed on
const PAGE_BLOCK = 3; // pages in a block, for shops without departments
const MAX_ITEMS = 2000;

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
  return { since, runId, startedAt, parts: firstParts(store)?.map(newPart) ?? null, indexWorker: null, indexAt: null, indexFailedBy: [], barred: [], finished: false };
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
const busy = (pass) => (pass.indexWorker && !idle(pass.indexAt) ? 1 : 0) + (pass.parts || []).filter((p) => !p.done && p.worker && !idle(p.touchedAt)).length;

// ---------------------------------------------------------------- handing out parts

/**
 * The next part for worker `w`, out of the shops it can do, or null.
 * Returns { store, runId, part }.
 */
export function take(w, canDo = []) {
  const stores = SHARED.filter((s) => (w === SERVER ? serverStores().includes(s) : !canDo.length || canDo.includes(s)));
  for (const store of stores) {
    const pass = current(store);
    if (!pass || pass.finished || pass.barred.includes(w)) continue;
    if ((pass.parts || []).some((p) => p.worker === w && !p.done && !idle(p.touchedAt)) || (pass.indexWorker === w && !idle(pass.indexAt))) continue; // one at a time each
    if (busy(pass) >= atOnce(store)) continue;
    if (!pass.parts) {
      if (pass.indexWorker && !idle(pass.indexAt)) continue;
      if (pass.indexFailedBy.includes(w)) continue;
      Object.assign(pass, { indexWorker: w, indexAt: iso() });
      save(store, pass);
      return { store, runId: pass.runId, part: { key: 'index', kind: 'index', label: 'departments' } };
    }
    const part = pass.parts.find((p) => !p.done && (!p.worker || idle(p.touchedAt)) && !p.failedBy.includes(w));
    if (!part) continue;
    Object.assign(part, { worker: w, touchedAt: iso() });
    save(store, pass);
    const { done, worker, touchedAt, failedBy, ...send } = part;
    return { store, runId: pass.runId, part: send };
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
    if (partKey === 'index') Object.assign(pass, { indexWorker: null, indexAt: null, indexFailedBy: [...pass.indexFailedBy, w] });
    else Object.assign(part, { worker: null, touchedAt: null, failedBy: [...part.failedBy, w] });
    if (body.blocked && !pass.barred.includes(w)) pass.barred.push(w); // blocked by the shop: none of it for this connection today
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

const running = new Set(); // shops this server is fetching a part of

/** Take and fetch a part of each shop this server crawls, if there's one going (one part per shop at a time). */
export function pump({ log = () => {} } = {}) {
  for (let i = 0; i < SHARED.length; i++) {
    const job = take(SERVER, []); // skips shops it's already doing a part of
    if (!job || running.has(job.store)) return;
    running.add(job.store);
    runLocal(job, log).finally(() => running.delete(job.store));
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
  timer = setInterval(() => pump(), 30 * 1000);
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
      barred: pass.barred.map(helpers.nameOf),
      stuck: parts.filter((p) => !p.done && p.failedBy.length).map((p) => p.label),
    };
  }
  return out;
}

/** Tests: forget what this server is doing. */
export function reset() {
  running.clear();
}
