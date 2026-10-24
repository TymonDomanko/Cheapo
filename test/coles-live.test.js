// The steady Coles refresh, against a stand-in Coles website and a clock we control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smt-live-')), 'test.db');
process.env.COLES_PAGES_PER_HOUR = '30'; // one paced request every 2 minutes
process.env.COLES_FULL_EVERY_DAYS = '2';
process.env.ADMIN_ALERTS = 'false';

const { getDb, upsertProducts } = await import('../src/db.js');
const live = await import('../src/coles-live.js');

let now = Date.parse('2026-10-20T00:30:00Z');
live.setClock(() => now);
const minutes = (n) => { now += n * 60 * 1000; };

const asked = [];
let blocking = false;
let milkPrice = 2;
const product = (id, name, price) => ({ _type: 'PRODUCT', id, brand: 'Test', name, size: '1L', pricing: { now: price } });
const page = (results, total) => JSON.stringify({ pageProps: { searchResults: { noOfResults: total, pageSize: 48, results } } });
live.setClientFactory(() => ({
  async request(url) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/_next\/data\/b1\/en\//, '');
    asked.push(u.pathname === '/' ? 'home' : `${p}${u.search}`);
    if (blocking) return '<html><title>Pardon Our Interruption</title></html>';
    if (u.pathname === '/') return '<script>{"buildId":"b1"}</script>';
    if (p === 'search/products.json') return page([product('m1', 'Live Test Milk', milkPrice)], 1);
    if (p === 'on-special.json') return page([product(`sp${u.searchParams.get('page')}`, 'Live Test Special', 1)], 60); // 2 pages
    if (p === 'browse.json') {
      return JSON.stringify({ pageProps: { allProductCategories: { catalogGroupView: [
        { seoToken: 'dairy', name: 'Dairy', level: 1, type: 'CATALOG', productCount: 1 },
        { seoToken: 'pantry', name: 'Pantry', level: 1, type: 'CATALOG', productCount: 1 },
      ] } } });
    }
    if (p.startsWith('product/')) return JSON.stringify({ pageProps: { product: { gtin: '9300000000001' } } });
    const cat = p.match(/^browse\/(\w+)\.json/)?.[1];
    if (cat) return page([product(`c-${cat}`, `Live Test ${cat}`, 3)], 1);
    throw Object.assign(new Error(`unexpected ${url}`), { status: 404 });
  },
}));
const pump = async () => { await live.pump(); };
const coles = (id) => getDb().prepare("SELECT price, available, last_seen FROM products WHERE store = 'coles' AND store_product_id = ?").get(id);

test('a search with day-old Coles prices fetches Coles’ own results straight away, once', async () => {
  upsertProducts('coles', [{ store_product_id: 'm1', name: 'Test Live Test Milk', size_text: '1L', price: 2.5 }], '2026-10-18T00:00:00.000Z');
  const id = getDb().prepare("SELECT id FROM products WHERE store_product_id = 'm1'").get().id;
  assert.equal(live.refreshForSearch('Live test milk', [id]), true, 'refreshing');
  await pump();
  assert.ok(asked.includes('search/products.json?q=live%20test%20milk'), asked.join(', '));
  assert.equal(coles('m1').price, 2, 'today’s price');
  assert.equal(live.refreshForSearch('live test milk', [id]), false, 'fresh now, and not asked again');
});

test('otherwise one request every couple of minutes: specials, then the whole shop, which then counts as a refresh', async () => {
  upsertProducts('coles', [{ store_product_id: 'gone', name: 'No Longer Sold', size_text: '1L', price: 1 }], '2026-10-01T00:00:00.000Z');
  asked.length = 0;
  minutes(2); await pump(); await pump(); // a second call straight after does nothing
  assert.deepEqual(asked, ['on-special.json?page=1']);
  minutes(2); await pump();
  assert.equal(asked.at(-1), 'on-special.json?page=2');
  for (let i = 0; i < 3; i++) { minutes(2); await pump(); }
  assert.deepEqual(asked.slice(2), ['browse.json', 'browse/dairy.json?slug=dairy&page=1', 'browse/pantry.json?slug=pantry&page=1']);
  assert.equal(coles('gone').available, 0, 'not seen in a whole-shop pass: gone');
  assert.equal(coles('c-dairy').available, 1);
  const run = getDb().prepare("SELECT status, products FROM scrape_runs WHERE store = 'coles' ORDER BY id DESC LIMIT 1").get();
  assert.equal(run.status, 'ok');
  assert.ok(run.products >= 2);
  const s = live.status();
  assert.equal(s.pass, null);
  assert.ok(s.lastPassAt);
  // Spare time goes on barcodes, then there's nothing to ask until tomorrow's specials.
  for (let i = 0; i < 10; i++) { minutes(2); await pump(); }
  assert.ok(asked.some((a) => a.startsWith('product/')), 'barcodes');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM products WHERE store = 'coles' AND available = 1 AND barcode_checked_at IS NULL").get().n, 0);
  const before = asked.length;
  minutes(2); await pump();
  assert.equal(asked.length, before, 'all done for now');
});

test('a bot check pauses everything for a couple of hours, and reports it once', async () => {
  minutes(24 * 60); // the next day: specials are due again
  blocking = true;
  asked.length = 0;
  await pump();
  assert.ok(asked.length >= 1);
  assert.ok(live.status().blockedUntil, 'paused');
  const err = getDb().prepare("SELECT status, error FROM scrape_runs WHERE store = 'coles' ORDER BY id DESC LIMIT 1").get();
  assert.equal(err.status, 'error');
  assert.match(err.error, /bot check.*in 2 hours/);
  const n = asked.length;
  minutes(60); await pump();
  assert.equal(asked.length, n, 'still paused');
  assert.equal(live.refreshForSearch('anything', [1]), false, 'searches don’t poke it either');
  blocking = false;
  minutes(61); await pump();
  assert.ok(asked.length > n, 'carries on after the pause');
  assert.equal(live.status().blockedUntil, null);
});
