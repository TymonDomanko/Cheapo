// Sharing the work between this server and helpers (collectors on other
// connections): Coles page by page under one combined limit, and each other
// shop's daily refresh going to whichever connection can do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smt-share-')), 'test.db');
process.env.COLES_PAGES_PER_HOUR = '30';
process.env.COLES_FULL_EVERY_DAYS = '2';
process.env.ADMIN_ALERTS = 'false';
process.env.SCRAPE_CRON = '15 4 * * *';
process.env.TZ = 'Australia/Sydney';

const { getDb } = await import('../src/db.js');
const live = await import('../src/coles-live.js');
const claims = await import('../src/claims.js');
const helpers = await import('../src/helpers.js');
const { colesPages } = await import('../src/scrapers/coles-pages.js');

let now = Date.parse('2026-10-20T00:30:00Z'); // 11:30 in Sydney
live.setClock(() => now);
claims.setClock(() => now);
const minutes = (n) => { now += n * 60 * 1000; };

// A stand-in Coles: 3 departments of 2 pages, 2 pages of specials. `blockedFor` holds connections it's blocking.
const blockedFor = new Set();
const asked = []; // [connection, page]
const product = (id) => ({ _type: 'PRODUCT', id, brand: 'Test', name: `Shared ${id}`, size: '1L', pricing: { now: 2 } });
const page = (ids, total) => JSON.stringify({ pageProps: { searchResults: { noOfResults: total, pageSize: 48, results: ids.map(product) } } });
const fakeColes = (who) => () => ({
  async request(url) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/_next\/data\/b1\/en\//, '');
    if (blockedFor.has(who)) return '<html><title>Pardon Our Interruption</title></html>';
    if (u.pathname === '/') return '<script>{"buildId":"b1"}</script>';
    asked.push([who, `${p}${u.search}`]);
    const n = Number(u.searchParams.get('page') || 1);
    if (p === 'on-special.json') return page([`sp${n}`], 96);
    if (p === 'browse.json') {
      return JSON.stringify({ pageProps: { allProductCategories: { catalogGroupView: ['dairy', 'pantry', 'frozen']
        .map((t) => ({ seoToken: t, name: t[0].toUpperCase() + t.slice(1), level: 1, type: 'CATALOG', productCount: 96 })) } } });
    }
    if (p.startsWith('product/')) return JSON.stringify({ pageProps: {} });
    const dept = p.match(/^browse\/(\w+)\.json/)?.[1];
    if (dept) return page([`${dept}${n}`], 96);
    throw Object.assign(new Error(`unexpected ${url}`), { status: 404 });
  },
});
live.setClientFactory(fakeColes('server'));

const sam = helpers.add('Sam’s PC');
const samWorker = { id: `h${sam.id}`, name: sam.name, helperId: sam.id };
const samColes = colesPages(fakeColes('sam'));
/** What Sam's collector does when it checks in: ask, fetch, send back. Returns the job or null. */
async function samTurn() {
  const r = live.helperNext(samWorker);
  if (!r.job) return null;
  let body;
  try {
    body = { job: r.job, ...(await samColes.run(r.job)) };
  } catch (e) {
    body = { job: r.job, blocked: e.message, requests: e.requests };
  }
  live.helperResult(samWorker, body);
  return r.job;
}

test('helpers sign in with their own token, which can be replaced or turned off', () => {
  assert.equal(helpers.identify(sam.token).id, samWorker.id);
  assert.equal(helpers.identify('not-a-token'), null);
  const fresh = helpers.newToken(sam.id);
  assert.equal(helpers.identify(sam.token), null, 'the old token stops working');
  helpers.setDisabled(sam.id, true);
  assert.equal(helpers.identify(fresh), null, 'turned off');
  helpers.setDisabled(sam.id, false);
  assert.equal(helpers.identify(fresh).name, 'Sam’s PC');
});

test('Coles: the server and a helper take different parts, and together keep to the one limit', async () => {
  // Sam checks in first: the specials are the first thing due, so Sam gets those.
  assert.equal((await samTurn()).kind, 'specials');
  await live.pump(); // the server takes the next free thing: the department list
  assert.deepEqual(asked.map(([who, p]) => `${who} ${p}`), ['sam on-special.json?page=1', 'server browse.json']);
  // Two connections at 30 pages an hour between them: each waits 4 minutes, not 2.
  assert.equal(live.helperNext(samWorker).job, null, 'too soon for Sam');
  assert.ok(live.helperNext(samWorker).wait >= 230);
  minutes(2); await live.pump();
  assert.equal(asked.length, 2, 'too soon for the server too');
  // Over the next two hours they share it out, never more than 30 an hour in total.
  for (let i = 0; i < 60; i++) {
    minutes(2);
    await samTurn();
    await live.pump();
  }
  const s = live.status();
  assert.ok(s.lastHour <= 30, `${s.lastHour} requests in the last hour`);
  const who = new Set(asked.filter(([, p]) => p.startsWith('browse/')).map(([w]) => w));
  assert.deepEqual([...who].sort(), ['sam', 'server'], 'both fetched departments');
  assert.ok(s.lastPassAt, 'the whole shop got done');
  for (const id of ['dairy1', 'dairy2', 'pantry1', 'pantry2', 'frozen1', 'frozen2', 'sp1', 'sp2']) {
    assert.ok(getDb().prepare("SELECT 1 FROM products WHERE store = 'coles' AND store_product_id = ?").get(id), id);
  }
  // Each department's pages came from one connection (it kept its lease).
  for (const dept of ['dairy', 'pantry', 'frozen']) {
    assert.equal(new Set(asked.filter(([, p]) => p.startsWith(`browse/${dept}`)).map(([w]) => w)).size, 1, dept);
  }
});

test('Coles: a block pauses only that connection, and its department goes to the other', async () => {
  live.restartPass();
  await live.pump(); // the server reads the department list
  asked.length = 0;
  // Sam takes a department, fetches its first page, then gets blocked on the second.
  minutes(10); await samTurn();
  const samDept = asked.filter(([w]) => w === 'sam').at(-1)[1].match(/^browse\/(\w+)/)[1];
  blockedFor.add('sam');
  minutes(5); await samTurn();
  const st = live.status();
  assert.ok(st.workers.find((w) => w.id === samWorker.id).blockedUntil, 'Sam is paused');
  assert.equal(st.blockedUntil, null, 'the server is not');
  const err = getDb().prepare("SELECT error, worker FROM scrape_runs WHERE store = 'coles' AND status = 'error' ORDER BY id DESC LIMIT 1").get();
  assert.match(err.error, /bot check \(Sam’s PC\)\. Trying again in 2 hours/);
  assert.equal(err.worker, samWorker.id);
  assert.equal(live.helperNext(samWorker).job, null, 'nothing for Sam while paused');
  // The server carries on, including Sam's department from the page it got to.
  for (let i = 0; i < 12; i++) { minutes(2); await live.pump(); }
  assert.ok(asked.some(([w, p]) => w === 'server' && p === `browse/${samDept}.json?slug=${samDept}&page=2`), `server picked up ${samDept} at page 2`);
  assert.ok(live.status().lastPassAt);
  blockedFor.delete('sam');
});

test('Coles: an answer for a page that has since gone to someone else is ignored', async () => {
  live.restartPass();
  await live.pump(); // the server reads the department list
  minutes(200); // Sam's pause is over
  const first = live.helperNext(samWorker).job; // Sam takes a department…
  assert.deepEqual(first, { kind: 'browse', dept: 'dairy', name: 'Dairy', page: 1 });
  minutes(60); // …and goes quiet, so it's handed on
  await live.pump();
  assert.equal(asked.at(-1).join(' '), 'server browse/dairy.json?slug=dairy&page=1');
  live.helperResult(samWorker, { job: first, items: [{ store_product_id: 'late1', name: 'Late Answer', size_text: '1L', price: 9 }], pages: 2, requests: 1 });
  assert.equal(getDb().prepare("SELECT 1 FROM products WHERE store_product_id = 'late1'").get(), undefined, 'Sam’s late answer wasn’t saved');
  const dairy = JSON.parse(getDb().prepare("SELECT value FROM app_settings WHERE key = 'coles-live'").get().value).pass.depts.find((d) => d.dept === 'dairy');
  assert.deepEqual([dairy.page, dairy.worker], [2, 'server'], 'and the department carries on with the server');
});

test('Coles: helpers can’t send search, list or barcode answers', () => {
  for (const kind of ['search', 'list', 'barcode']) {
    assert.throws(() => live.helperResult(samWorker, { job: { kind, q: 'milk', id: 1 }, items: [] }), /job you were given/);
  }
});

// ---------------------------------------------------------------- other shops

const run = (store, status, worker, source, at) => getDb().prepare('INSERT INTO scrape_runs (store, started_at, finished_at, status, source, worker) VALUES (?, ?, ?, ?, ?, ?)')
  .run(store, at, at, status, source, worker);

test('other shops: the server gets first go at its own, then a helper covers what it couldn’t do', () => {
  // 2026-10-21 04:20 in Sydney: just after the scheduled time.
  now = Date.parse('2026-10-20T17:20:00Z');
  const since = claims.lastScheduled(now).toISOString();
  assert.equal(since, '2026-10-20T17:15:00.000Z');
  const alex = helpers.add('Alex’s laptop');
  const alexWorker = { id: `h${alex.id}`, name: alex.name, helperId: alex.id };

  // This server crawls everything, so for 90 minutes it's all the server's (Coles is shared page by page, IGA stays here).
  assert.deepEqual(claims.claim(samWorker, []), []);
  assert.deepEqual(claims.shareable().sort(), ['aldi', 'harrisfarm', 'woolworths']);

  // The server's Woolworths refresh is blocked: Sam can take it straight away.
  run('woolworths', 'error', null, 'server', '2026-10-20T17:16:00.000Z');
  const got = claims.claim(samWorker, []);
  assert.deepEqual(got.map((r) => r.store), ['woolworths']);
  assert.equal(claims.handledElsewhere('woolworths'), true, 'Sam is on it');
  assert.deepEqual(claims.claim(alexWorker, []), [], 'and nobody else gets it while Sam is');

  // Sam's refresh fails too: Alex gets it, Sam doesn't get it again today.
  getDb().prepare("UPDATE scrape_runs SET status = 'error' WHERE id = ?").run(got[0].runId);
  assert.deepEqual(claims.claim(samWorker, []), []);
  const alexGot = claims.claim(alexWorker, ['woolworths']);
  assert.deepEqual(alexGot.map((r) => r.store), ['woolworths']);
  getDb().prepare("UPDATE scrape_runs SET status = 'ok' WHERE id = ?").run(alexGot[0].runId);

  // After the server's 90 minutes, whatever it hasn't done is up for grabs (ALDI and Harris Farm here)…
  run('aldi', 'ok', null, 'server', '2026-10-20T17:30:00.000Z');
  minutes(95);
  assert.deepEqual(claims.claim(samWorker, []).map((r) => r.store), ['harrisfarm']);
  // …and nothing is done twice in a day.
  assert.deepEqual(claims.claim(alexWorker, []), []);
  minutes(24 * 60 - 95); // 04:20 the next day
  assert.deepEqual(claims.claim(alexWorker, ['aldi']), [], 'next day, the server gets first go again');
});

test('other shops: one this server doesn’t crawl goes to the first collector to ask, from the scheduled time', async () => {
  const settings = await import('../src/settings.js');
  settings.setSetting('SERVER_SCRAPE_STORES', 'aldi,coles,iga,harrisfarm');
  getDb().exec('DELETE FROM scrape_runs'); // runs started above are stamped with the real time
  now = Date.parse('2026-10-22T17:00:00Z'); // 04:00 in Sydney, before the scheduled time: yesterday's run still counts
  run('woolworths', 'ok', samWorker.id, 'collector', '2026-10-21T17:20:00.000Z');
  assert.deepEqual(claims.claim(samWorker, ['woolworths']), []);
  minutes(16); // 04:16
  assert.deepEqual(claims.claim(samWorker, ['woolworths']).map((r) => r.store), ['woolworths']);
  settings.setSetting('SERVER_SCRAPE_STORES', null);
});
