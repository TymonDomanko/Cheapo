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
const helpers = await import('../src/helpers.js');
const { colesPages } = await import('../src/scrapers/coles-pages.js');

let now = Date.parse('2026-10-20T00:30:00Z'); // 11:30 in Sydney
live.setClock(() => now);
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

test('Coles: a helper that stops answering is counted out at once, and its department handed on', async () => {
  minutes(10);
  live.restartPass();
  await live.pump(); // the server reads the department list
  minutes(5);
  const job = (await samTurn()); // Sam takes a department and fetches its first page
  assert.equal(job.kind, 'browse');
  minutes(4); await live.pump(); // the server's turn: two connections, 4 minutes apart
  const before = asked.length;
  minutes(2); await live.pump();
  assert.equal(asked.length, before, 'still sharing: the server waits its 4 minutes');
  // Sam goes silent. Three minutes after its turn was due, it no longer counts…
  minutes(5); await live.pump();
  const st = live.status();
  assert.ok(!st.workers.some((w) => w.id === samWorker.id), 'Sam is no longer counted');
  // …so the server is back to every 2 minutes, and picks up Sam's department where it got to.
  const n = asked.length;
  minutes(2); await live.pump();
  assert.equal(asked.length, n + 1, 'every 2 minutes again');
  for (let i = 0; i < 6; i++) { minutes(2); await live.pump(); }
  assert.ok(asked.some(([w, p]) => w === 'server' && p === `browse/${job.dept}.json?slug=${job.dept}&page=2`), 'Sam’s department, from page 2');
});

// ---------------------------------------------------------------- other shops, a part at a time

const sharing = await import('../src/sharing.js');
sharing.setClock(() => now);
const share = (store) => JSON.parse(getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(`share:${store}`).value);
const products = (store) => getDb().prepare('SELECT store_product_id id, available FROM products WHERE store = ? ORDER BY 1').all(store);

test('other shops: departments are shared out, at most as many at once as one connection would fetch', async () => {
  now = Date.parse('2026-10-25T17:20:00Z'); // 04:20 in Sydney, just after the scheduled time
  const alex = helpers.add('Alex’s laptop');
  const alexWorker = `h${alex.id}`;
  const sam = samWorker.id;
  getDb().prepare("INSERT INTO products (store, store_product_id, name, price, first_seen, last_seen) VALUES ('woolworths', 'old', 'No Longer Sold', 1, '2026-10-01', '2026-10-01')").run();
  const settings = await import('../src/settings.js');
  settings.setSetting('SERVER_SCRAPE_STORES', 'woolworths,coles,iga'); // so the server's only other choice here is Woolworths

  // Whoever asks first reads the department list; nobody else gets Woolworths until it's in.
  const first = sharing.take(sam, ['woolworths']);
  assert.equal(first.part.kind, 'index');
  assert.equal(sharing.take(alexWorker, ['woolworths']), null);
  sharing.done(sam, 'woolworths', 'index', { cats: ['dairy', 'pantry', 'frozen'].map((k) => ({ key: k, label: k, dept: { slug: k, name: k, id: k } })) });

  // Two departments at once (Woolworths' usual two), one each.
  const a = sharing.take(sam, ['woolworths']);
  const b = sharing.take(alexWorker, ['woolworths']);
  assert.deepEqual([a.part.key, b.part.key], ['dairy', 'pantry']);
  assert.equal(a.runId, b.runId, 'all one refresh');
  assert.equal(sharing.take('server', []), null, 'two on the go already');
  assert.equal(sharing.take(sam, ['woolworths']), null, 'one at a time each');

  sharing.items(sam, 'woolworths', 'dairy', [{ store_product_id: 'milk', name: 'Milk', size_text: '1L', price: 2 }]);
  assert.throws(() => sharing.items(alexWorker, 'woolworths', 'dairy', []), /handed on/, 'only the holder sends for a part');
  sharing.done(sam, 'woolworths', 'dairy', {});
  // Alex is blocked by Woolworths: pantry goes back, and Alex gets no more Woolworths today.
  sharing.done(alexWorker, 'woolworths', 'pantry', { blocked: 'Access denied' });
  assert.equal(sharing.take(alexWorker, ['woolworths']), null);
  const c = sharing.take('server', []);
  assert.equal(c.store, 'woolworths');
  assert.equal(c.part.key, 'pantry');
  sharing.items('server', 'woolworths', 'pantry', [{ store_product_id: 'rice', name: 'Rice', size_text: '1kg', price: 3 }]);
  sharing.done('server', 'woolworths', 'pantry', {});
  const d = sharing.take(sam, ['woolworths']);
  sharing.items(sam, 'woolworths', 'frozen', [{ store_product_id: 'peas', name: 'Peas', size_text: '1kg', price: 4 }]);
  sharing.done(sam, 'woolworths', d.part.key, {});

  // The last part in finishes the one refresh: everything counts, and what nobody saw is gone.
  const run = getDb().prepare('SELECT status, products, source FROM scrape_runs WHERE id = ?').get(a.runId);
  assert.deepEqual([run.status, run.products, run.source], ['ok', 3, 'shared']);
  assert.deepEqual(products('woolworths').map((p) => `${p.id}:${p.available}`), ['milk:1', 'old:0', 'peas:1', 'rice:1']);
  assert.equal(sharing.take(sam, ['woolworths']), null, 'done for today');
  const st = sharing.status().woolworths;
  assert.deepEqual([st.done, st.of, st.finished, st.barred], [3, 3, true, ['Alex’s laptop']]);
  settings.setSetting('SERVER_SCRAPE_STORES', null);
});

test('other shops: a part nothing is heard about for 10 minutes is handed on', () => {
  const alex = `h${helpers.list().find((x) => x.name === 'Alex’s laptop').id}`;
  const a = sharing.take(alex, ['aldi']); // the department list
  assert.equal(a.part.kind, 'index');
  minutes(11);
  const b = sharing.take(samWorker.id, ['aldi']);
  assert.equal(b.part.kind, 'index', 'Sam gets it instead');
  assert.throws(() => sharing.done(alex, 'aldi', 'index', { cats: [{ key: 'x' }] }), /handed on/, 'Alex’s late answer is refused');
});

test('other shops: Harris Farm goes in blocks of pages, adding more while the last block is full', () => {
  const sam = samWorker.id;
  const keys = () => share('harrisfarm').parts.map((p) => p.key);
  const first = sharing.take(sam, ['harrisfarm']);
  assert.deepEqual([first.part.kind, first.part.from, first.part.to], ['pages', 1, 3]);
  assert.deepEqual(keys(), ['p1', 'p4', 'p7']);
  sharing.done(sam, 'harrisfarm', 'p1', { more: true });
  assert.deepEqual(keys(), ['p1', 'p4', 'p7'], 'not the last block: nothing to add');
  for (const k of ['p4', 'p7']) {
    assert.equal(sharing.take(sam, ['harrisfarm']).part.key, k);
    sharing.done(sam, 'harrisfarm', k, { more: true });
  }
  assert.deepEqual(keys(), ['p1', 'p4', 'p7', 'p10'], 'pages 7–9 were all full: 10–12 next');
  assert.equal(sharing.take(sam, ['harrisfarm']).part.key, 'p10');
  sharing.done(sam, 'harrisfarm', 'p10', { more: false });
  assert.equal(share('harrisfarm').finished, true);
});

test('other shops: parts still missing when the next refresh is due make a failed refresh', () => {
  minutes(24 * 60);
  sharing.take(samWorker.id, ['aldi']); // starts today's ALDI, reporting yesterday's
  const runs = getDb().prepare("SELECT status, error FROM scrape_runs WHERE store = 'aldi' AND source = 'shared' ORDER BY id").all();
  assert.equal(runs[0].status, 'error');
  assert.match(runs[0].error, /departments couldn’t be fetched/);
  assert.equal(runs[1].status, 'running');
});

test('other shops: with the schedule turned off, only a refresh started from the admin page', () => {
  const saved = process.env.SCRAPE_CRON;
  process.env.SCRAPE_CRON = '';
  minutes(3 * 24 * 60);
  assert.equal(sharing.take(samWorker.id, ['harrisfarm']), null, 'nothing starts by itself');
  sharing.restart('harrisfarm');
  assert.equal(sharing.take(samWorker.id, ['harrisfarm']).part.key, 'p1');
  minutes(60);
  assert.equal(share('harrisfarm').finished, false, 'and it isn’t replaced by itself');
  process.env.SCRAPE_CRON = saved;
});
