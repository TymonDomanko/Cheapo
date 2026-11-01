// Product photos served from this site (src/images.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-img-')), 'test.db');
process.env.IMAGES_ALLOW_HTTP = 'true'; // the stand-in shop below isn't https
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];

const { getDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { pruneImages } = await import('../src/images.js');

let served = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const shop = http.createServer((req, res) => {
  if (req.url === '/milk.png') {
    served++;
    return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
  }
  if (req.url === '/page.html') return void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>not a photo</p>');
  res.writeHead(404).end();
});
await new Promise((r) => shop.listen(0, '127.0.0.1', r));
const app = createApp().listen(0);
await new Promise((r) => app.once('listening', r));
const base = `http://127.0.0.1:${app.address().port}`;
const shopUrl = `http://127.0.0.1:${shop.address().port}`;
after(() => {
  shop.close();
  app.close();
});

const add = (id, image) => getDb().prepare(`INSERT INTO products (store, store_product_id, name, image_url, first_seen, last_seen)
  VALUES ('coles', ?, ?, ?, '2026-10-01', '2026-10-01')`).run(id, `Product ${id}`, image).lastInsertRowid;

test('a product photo is fetched once, kept, and served from this site', async () => {
  const id = add('img1', `${shopUrl}/milk.png`);
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/img/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control'), /max-age/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  }
  assert.equal(served, 1, 'fetched from the shop once');
});

test('missing or not-a-photo gives 404, and only products’ own photos can be fetched', async () => {
  assert.equal((await fetch(`${base}/img/${add('img2', `${shopUrl}/gone.png`)}`)).status, 404);
  assert.equal((await fetch(`${base}/img/${add('img3', `${shopUrl}/page.html`)}`)).status, 404, 'a web page isn’t a photo');
  assert.equal((await fetch(`${base}/img/${add('img4', null)}`)).status, 404);
  assert.equal((await fetch(`${base}/img/999999`)).status, 404);
  assert.equal((await fetch(`${base}/img/..%2F..%2Fetc%2Fpasswd`)).status, 404);
});

test('photos not wanted for a while are forgotten', () => {
  const dir = path.join(path.dirname(process.env.DB_PATH), 'images');
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(pruneImages(), 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});
