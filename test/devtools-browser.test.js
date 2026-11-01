// Shops that block programs go through a real browser, when there is one
// (src/scrapers/devtools-browser.js). Skipped where no browser is installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

if (!process.env.BROWSER_PATH && fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')) process.env.BROWSER_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
process.env.GROCERY_COLLECTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-browser-'));
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];

const { findBrowser, closeBrowser } = await import('../src/scrapers/devtools-browser.js');
const browserPath = findBrowser();

// A shop with a bot check: its page sets a cookie with JavaScript and reloads;
// its data needs that cookie (and the store cookie, when one's pinned).
const shop = http.createServer((req, res) => {
  const cookies = req.headers.cookie || '';
  const passed = /passed=yes/.test(cookies);
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(passed ? '<title>Shop</title><p>Welcome</p>'
      : '<title>Pardon Our Interruption</title><script>document.cookie="passed=yes; path=/"; setTimeout(() => location.reload(), 200)</script>');
  }
  if (req.url.startsWith('/api/')) {
    if (!passed) return void res.writeHead(403).end('blocked');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, store: /fulfillmentStoreId=(\d+)/.exec(cookies)?.[1] || null, method: req.method }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => shop.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${shop.address().port}`;
after(async () => {
  await closeBrowser();
  shop.close();
});

test('a shop that blocks programs is reached through the browser', { skip: !browserPath && 'no browser installed' }, async () => {
  process.env.BROWSER_SHOPS = '127.0.0.1';
  const { createClient } = await import('../src/scrapers/http.js');
  const plain = createClient({ origin: origin.replace('127.0.0.1', 'localhost'), delayMs: 0 }); // not a browser shop
  await assert.rejects(plain.getJson(`${origin.replace('127.0.0.1', 'localhost')}/api/products`), (e) => e.status === 403, 'a program is refused');

  const c = createClient({ origin, delayMs: 0 });
  assert.equal(c.constructor.name, 'DevtoolsClient');
  c.pinCookie('fulfillmentStoreId', '0381');
  await c.init();
  assert.deepEqual(await c.getJson(`${origin}/api/products`), { ok: true, store: '0381', method: 'GET' }, 'past the bot check, with the store cookie');
  assert.equal((await c.postJson(`${origin}/api/browse`, { page: 1 })).method, 'POST');
  await assert.rejects(c.getJson(`${origin}/nope`), (e) => e.status === 404);
  await c.close();
});
