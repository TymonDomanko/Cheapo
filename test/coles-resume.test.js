// A Coles crawl that gets blocked part-way stops, and the next one carries on
// from the same page. Coles' website is stood in for by a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smt-coles-')), 'test.db');
process.env.COLES_DELAY_MS = '0';
process.env.COLES_BLOCK_WAIT_MS = '0';
process.env.BLOCKED_RETRY_HOURS = '0';
process.env.ADMIN_ALERTS = 'false';

const { getDb, upsertProducts } = await import('../src/db.js');
const { scrapeStore, crawlProgress } = await import('../src/scrapers/index.js');

const BOT_CHECK = '<!DOCTYPE html><html><head><title>Pardon Our Interruption</title></head></html>';
const CATS = [{ seoToken: 'dairy', name: 'Dairy' }, { seoToken: 'pantry', name: 'Pantry' }];
const PAGES = { dairy: 2, pantry: 3 };
let blockAt = null; // e.g. 'pantry:2' — answer that page (and everything after) with the bot check
const asked = [];

const product = (cat, page) => ({ _type: 'PRODUCT', id: `${cat}-${page}`, brand: 'Test', name: `${cat} item ${page}`, size: '1kg', pricing: { now: 2 } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const reply = (body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': type } });
  if (blockAt === 'home') return reply(BOT_CHECK, 'text/html');
  if (u.pathname === '/') return reply('<script>{"buildId":"b1"}</script>', 'text/html');
  if (u.pathname.endsWith('/browse.json')) {
    return reply({ pageProps: { allProductCategories: { catalogGroupView: CATS.map((c) => ({ ...c, level: 1, type: 'CATALOG', productCount: 48 })) } } });
  }
  const cat = u.pathname.match(/browse\/([a-z]+)\.json/)[1];
  const page = Number(u.searchParams.get('page'));
  asked.push(`${cat}:${page}`);
  if (blockAt && (cat === 'pantry' && blockAt.startsWith('pantry') ? page >= Number(blockAt.split(':')[1]) : false)) return reply(BOT_CHECK, 'text/html');
  return reply({ pageProps: { searchResults: { noOfResults: PAGES[cat] * 48, pageSize: 48, results: [product(cat, page)] } } });
};

test('a blocked Coles crawl stops, then carries on where it left off', async () => {
  // A product from an earlier crawl that Coles no longer sells.
  upsertProducts('coles', [{ store_product_id: 'gone', name: 'Discontinued Thing', size_text: '1kg', price: 1 }], '2020-01-01T00:00:00.000Z');

  blockAt = 'pantry:2';
  await assert.rejects(scrapeStore('coles'), (e) => e.blocked && /bot check/.test(e.message) && /Pantry, page 2/.test(e.message));
  // The blocked page: a fresh session, then (after a wait) another, then it stops — no more categories.
  assert.deepEqual(asked, ['dairy:1', 'dairy:2', 'pantry:1', 'pantry:2', 'pantry:2', 'pantry:2', 'pantry:2']);
  const state = crawlProgress('coles').load();
  assert.deepEqual([state.done, state.cat, state.page], [['dairy'], 'pantry', 2]);
  const gone = () => getDb().prepare("SELECT available FROM products WHERE store_product_id = 'gone'").get().available;
  assert.equal(gone(), 1, 'nothing is marked gone until the whole shop has been seen');

  asked.length = 0;
  blockAt = null;
  await scrapeStore('coles');
  assert.deepEqual(asked, ['pantry:2', 'pantry:3'], 'carried on from the page it stopped at');
  assert.equal(crawlProgress('coles').load(), null, 'finished');
  assert.equal(gone(), 0, 'now the whole shop has been seen, missing products are marked unavailable');
  const unavailable = getDb().prepare("SELECT COUNT(*) n FROM products WHERE store = 'coles' AND available = 0").get().n;
  assert.equal(unavailable, 1, 'what the first run found is still available');
  const run = getDb().prepare("SELECT status, products FROM scrape_runs WHERE store = 'coles' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(run, { status: 'ok', products: 5 }, 'the finishing run counts the whole crawl');
});

test('a bot check on the home page says the connection is blocked', async () => {
  blockAt = 'home';
  await assert.rejects(scrapeStore('coles'), (e) => e.blocked && /blocked for now/.test(e.message));
  blockAt = null;
  globalThis.fetch = realFetch;
});
