// Sharing the work between this server and helpers (collectors on other
// connections): Coles page by page under one combined limit, and each other
// shop's daily refresh going to whichever connection can do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-share-')), 'test.db');
process.env.COLES_PAGES_PER_HOUR = '30';
process.env.COLES_FULL_EVERY_DAYS = '2';
process.env.ADMIN_ALERTS = 'false';
process.env.SCRAPE_CRON = '15 4 * * *';
process.env.TZ = 'Australia/Sydney';
process.env.ONE_CONNECTION_SHOPS = ''; // the general tests share every shop; the one-connection rule has its own test

const { getDb } = await import('../src/db.js');
const live = await import('../src/coles-live.js');
const helpers = await import('../src/helpers.js');
const { colesPages } = await import('../src/scrapers/coles-pages.js');

let now = Date.parse('2026-10-20T00:30:00Z'); // 11:30 in Sydney
live.setClock(() => now);
const minutes = (n) => { now += n * 60 * 1000; };

// A stand-in Coles: 3 departments of 2 pages, 2 pages of specials. `blockedFor` holds connections it's blocking.
const blockedFor = new Set();
let deptProducts = 96; // 2 pages a department
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
    if (dept) return page([`${dept}${n}`], deptProducts);
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

test('Coles: no connection goes over its cap, the server included; spare goes to the others', async () => {
  process.env.COLES_PAGES_PER_HOUR = '60';
  deptProducts = 48 * 100; // plenty to do
  minutes(24 * 60);
  live.reset();
  live.restartPass();
  await live.pump();
  const lastHour = () => live.status().workers.reduce((o, w) => ({ ...o, [w.id]: w.lastHour }), {});

  // On its own, the server is capped at 40 an hour, though the limit is 60.
  for (let i = 0; i < 180; i++) { minutes(0.5); await live.pump(); } // every 30s, like the server
  assert.equal(live.capFor('server'), 40);
  assert.ok(lastHour().server <= 40 && lastHour().server >= 38, `server: ${lastHour().server}`);

  // Sam is capped lower, at 10: Sam gets 10 an hour, the server keeps its 40.
  helpers.setColesMax(sam.id, 10);
  for (let i = 0; i < 120; i++) {
    minutes(1);
    await samTurn();
    await live.pump();
  }
  const h = lastHour();
  assert.ok(h[samWorker.id] <= 10 && h[samWorker.id] >= 9, `Sam: ${h[samWorker.id]}`);
  assert.ok(h.server <= 40, `server: ${h.server}`);
  assert.ok(live.status().lastHour <= 60);
  assert.equal(live.status().workers.find((w) => w.id === samWorker.id).cap, 10);

  // A helper's own figure can only be lower than the site's.
  helpers.setColesMax(sam.id, 500);
  assert.equal(live.capFor(samWorker.id), 40);
  helpers.setColesMax(sam.id, null);
  process.env.COLES_PAGES_PER_HOUR = '30';
  deptProducts = 96;
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
  // Alex is blocked by Woolworths: pantry goes back, and Alex is paused for Woolworths (not other shops).
  sharing.done(alexWorker, 'woolworths', 'pantry', { blocked: 'Access denied' });
  const failed = sharing.status().woolworths.stuck.find((f) => f.part === 'pantry');
  assert.deepEqual([failed.by, failed.why], ['Alex’s laptop', 'Access denied'], 'the admin page can say why');
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
  assert.deepEqual([st.done, st.of, st.finished, st.paused.map((p) => p.worker)], [3, 3, true, ['Alex’s laptop']]);
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

test('other shops: a one-connection shop (Woolworths) stays with one connection; others only step in for what it can’t do', async () => {
  const settings = await import('../src/settings.js');
  settings.setSetting('SERVER_SCRAPE_STORES', 'aldi,coles,iga');
  sharing.ONE_CONNECTION.add('aldi');
  const sam = samWorker.id;
  const alex = `h${helpers.list().find((x) => x.name === 'Alex’s laptop').id}`;
  now = Date.parse('2026-11-03T17:20:00Z'); // a new day, 04:20 in Sydney
  process.env.SCRAPE_CRON = '15 4 * * *';

  // This server crawls ALDI, so it's the server's: helpers wait.
  assert.equal(sharing.take(sam, ['aldi']), null);
  assert.equal(sharing.take('server', []).part.kind, 'index');
  sharing.done('server', 'aldi', 'index', { cats: ['d1', 'd2', 'd3'].map((k) => ({ key: k, label: k, dept: { slug: k } })) });
  const [a, b] = [sharing.take('server', []), sharing.take('server', [])];
  assert.deepEqual([a.part.key, b?.part.key], ['d1', undefined], 'the server at its usual pace (one at a time for ALDI)');
  assert.equal(sharing.take(sam, ['aldi']), null, 'still the server’s');
  // A part the server fails is fair game for a helper…
  sharing.done('server', 'aldi', 'd1', { error: 'HTTP 500' });
  assert.equal(sharing.take(sam, ['aldi']).part.key, 'd1');
  sharing.done(sam, 'aldi', 'd1', {});
  // …and if the shop blocks the server, so is the rest.
  const c = sharing.take('server', []);
  sharing.done('server', 'aldi', c.part.key, { blocked: 'Access denied' });
  assert.equal(sharing.take(alex, ['aldi']).part.key, c.part.key);
  sharing.ONE_CONNECTION.delete('aldi');
  settings.setSetting('SERVER_SCRAPE_STORES', null);
});

test('other shops: a connection blocked by one shop moves on to another, and tries the first again after a pause', async () => {
  const sam = samWorker.id;
  now = Date.parse('2026-11-04T17:20:00Z'); // a new day, 04:20 in Sydney
  const first = sharing.take(sam, ['danmurphys', 'bws']);
  assert.equal(first.store, 'danmurphys');
  sharing.done(sam, 'danmurphys', 'index', { blocked: 'Dan Murphy’s is showing a bot check' });
  assert.equal(sharing.take(sam, ['danmurphys', 'bws']).store, 'bws', 'straight on to the next shop');
  assert.deepEqual(sharing.status().danmurphys.paused.map((p) => p.worker), ['Sam’s PC']);
  sharing.done(sam, 'bws', 'index', { cats: [{ key: 'beer', label: 'Beer', dept: { slug: 'beer' } }] });
  sharing.take(sam, ['bws']);
  sharing.done(sam, 'bws', 'beer', {});
  assert.equal(sharing.take(sam, ['danmurphys']), null, 'paused for Dan Murphy’s for an hour');
  minutes(61);
  assert.equal(sharing.take(sam, ['danmurphys']).part.kind, 'index', 'then tries again, the same part included');
  sharing.done(sam, 'danmurphys', 'index', { blocked: 'again' });
  minutes(61);
  assert.equal(sharing.take(sam, ['danmurphys']), null, 'a second block pauses it for longer (2 hours)');
  minutes(60);
  assert.ok(sharing.take(sam, ['danmurphys']));
});

test('a shop refusing a part (403, 429 or a bot check page) counts as blocked', async () => {
  const { fetchPart } = await import('../src/scrapers/parts.js');
  const failing = (e) => ({ async *scrape() { throw e; } });
  const run = async (e) => {
    try {
      for await (const _ of fetchPart(failing(e), { kind: 'whole' }, { log: () => {} }));
    } catch (err) {
      return !!err.blocked;
    }
  };
  assert.equal(await run(Object.assign(new Error('HTTP 403 for https://x'), { status: 403 })), true);
  assert.equal(await run(Object.assign(new Error('HTTP 429 for https://x'), { status: 429 })), true);
  assert.equal(await run(new Error('Expected JSON from https://x but got an HTML page (likely a bot check)')), true);
  assert.equal(await run(Object.assign(new Error('HTTP 500 for https://x'), { status: 500 })), false);
});

test('a shop kept with a connection, or with the store a shop gives by location', async () => {
  const settings = await import('../src/settings.js');
  const sam = samWorker.id;
  const alex = `h${helpers.list().find((x) => x.name === 'Alex’s laptop').id}`;
  const fresh = helpers.add('Jo’s PC');
  const jo = `h${fresh.id}`;
  now = Date.parse('2026-11-05T17:20:00Z'); // a new day, 04:20 in Sydney

  // Kept with Alex: Sam waits while Alex is at work.
  settings.setSetting('PREFERRED_CONNECTIONS', `bws=${alex}`);
  assert.equal(sharing.take(sam, ['bws']), null);
  assert.equal(sharing.take(alex, ['bws']).part.kind, 'index');
  sharing.done(alex, 'bws', 'index', { cats: ['beer', 'wine'].map((k) => ({ key: k, label: k, dept: { slug: k } })) });
  assert.equal(sharing.take(sam, ['bws']), null, 'still Alex’s');
  assert.equal(sharing.status().bws.preferred, 'Alex’s laptop');
  // Alex goes quiet: after 10 minutes the others step in.
  minutes(11);
  assert.equal(sharing.take(sam, ['bws']).part.key, 'beer');

  // Kept with a store: connections report the store Woolworths gives them, and only those given it fetch.
  sharing.noteAreas(sam, { woolworths: '1101' });
  sharing.noteAreas(alex, { woolworths: '1200' });
  sharing.noteAreas(jo, { woolworths: '1200' });
  sharing.noteAreas(jo, { woolworths: '<script>' }); // nonsense is ignored
  assert.deepEqual(sharing.connectionsByArea().woolworths.map((g) => [g.area, g.workers.map((x) => x.name)]), [['1101', ['Sam’s PC']], ['1200', ['Alex’s laptop', 'Jo’s PC']]]);
  settings.setSetting('PREFERRED_CONNECTIONS', 'woolworths=@1200');
  settings.setSetting('SERVER_SCRAPE_STORES', 'coles,iga');
  assert.equal(sharing.take(alex, ['woolworths']).part.kind, 'index');
  sharing.done(alex, 'woolworths', 'index', { cats: ['d1', 'd2', 'd3'].map((k) => ({ key: k, label: k, dept: { slug: k } })) });
  assert.equal(sharing.take(alex, ['woolworths']).part.key, 'd1');
  assert.equal(sharing.take(sam, ['woolworths']), null, 'room for another, but Sam is given another store');
  assert.equal(sharing.take(jo, ['woolworths']).part.key, 'd2', 'both connections given store 1200 share it');
  // Both of them blocked: Sam steps in rather than leave it undone.
  sharing.done(alex, 'woolworths', 'd1', { blocked: 'bot check' });
  sharing.done(jo, 'woolworths', 'd2', { blocked: 'bot check' });
  assert.ok(sharing.take(sam, ['woolworths']));
  assert.throws(() => settings.setSetting('PREFERRED_CONNECTIONS', 'woolworths=everyone'), /Choose a connection or a store/);
  settings.setSetting('PREFERRED_CONNECTIONS', null);
  settings.setSetting('SERVER_SCRAPE_STORES', null);
});
