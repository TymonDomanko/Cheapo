// The steady Coles refresh set to go through the whole shop every day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smt-daily-')), 'test.db');
process.env.COLES_PAGES_PER_HOUR = '30';
process.env.COLES_FULL_EVERY_DAYS = '1';
process.env.ADMIN_ALERTS = 'false';

await import('../src/db.js');
const live = await import('../src/coles-live.js');

let now = Date.parse('2026-10-20T00:30:00Z');
live.setClock(() => now);
const minutes = (n) => { now += n * 60 * 1000; };

const asked = [];
const page = (id) => JSON.stringify({ pageProps: { searchResults: { noOfResults: 1, pageSize: 48, results: [
  { _type: 'PRODUCT', id, brand: 'Test', name: `Daily ${id}`, size: '1L', pricing: { now: 2 } }] } } });
live.setClientFactory(() => ({
  async request(url) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/_next\/data\/b1\/en\//, '');
    asked.push(u.pathname === '/' ? 'home' : `${p}${u.search}`);
    if (u.pathname === '/') return '<script>{"buildId":"b1"}</script>';
    if (p === 'browse.json') {
      return JSON.stringify({ pageProps: { allProductCategories: { catalogGroupView: [
        { seoToken: 'dairy', name: 'Dairy', level: 1, type: 'CATALOG', productCount: 1 },
      ] } } });
    }
    if (p.startsWith('product/')) return JSON.stringify({ pageProps: {} });
    if (p.startsWith('browse/')) return page('d1');
    throw Object.assign(new Error(`unexpected ${url}`), { status: 404 });
  },
}));

test('every day: no separate specials, and a new pass starts a day after the last one started', async () => {
  for (let i = 0; i < 3; i++) { minutes(2); await live.pump(); }
  // The whole shop straight away (no specials first), then spare time on barcodes.
  assert.deepEqual(asked.filter((a) => a !== 'home'), ['browse.json', 'browse/dairy.json?slug=dairy&page=1', 'product/test-daily-d1-1l-d1.json']);
  const started = live.status().lastPassAt;
  assert.ok(started, 'pass finished');
  // A pass in real life takes most of the day; the next one still starts 24 hours after this one started.
  asked.length = 0;
  minutes(24 * 60 - 10);
  await live.pump();
  assert.ok(!asked.some((a) => a.startsWith('browse')), 'not yet');
  minutes(10); await live.pump();
  assert.ok(asked.some((a) => a.startsWith('browse')), 'new pass (it starts by reading the department list)');
  assert.ok(!asked.some((a) => a.startsWith('on-special')), 'no separate specials');
});
