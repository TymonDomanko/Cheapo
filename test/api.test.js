// End-to-end API tests against a temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.DISABLE_BACKGROUND_SCRAPES = 'true';
process.env.MAIL_CAPTURE = 'true';
process.env.AUTH_RATE_LIMIT = '1000';

const { upsertProducts } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

let server;
let base;

before(async () => {
  // Same milk at three stores, plus eggs only at Coles.
  upsertProducts('woolworths', [{ store_product_id: 'w1', name: 'Woolworths Full Cream Milk 2L', brand: 'Woolworths', size_text: '2L', price: 3.4 }]);
  upsertProducts('coles', [
    { store_product_id: 'c1', name: 'Coles Full Cream Milk', brand: 'Coles', size_text: '2L', price: 3.1 },
    { store_product_id: 'c2', name: 'Coles Free Range Eggs 12 Pack', brand: 'Coles', size_text: '700g', price: 6.9 },
  ]);
  upsertProducts('aldi', [{ store_product_id: 'a1', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale', size_text: '2L', price: 2.99 }]);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Tiny client that keeps a session cookie. */
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

const productId = async (api, q, store) => (await api('GET', `/api/search?q=${q}&store=${store}`)).body[0].anchor.id;

test('anyone can search; lists and admin need a login', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/search?q=milk')).status, 200);
  assert.equal((await anon('GET', '/api/lists')).status, 401);
  assert.equal((await anon('POST', '/api/admin/scrape', {})).status, 401);
});

test('signup, login, wrong password', async () => {
  const api = client();
  const r = await api('POST', '/api/auth/signup', { email: 'sam@example.com', name: 'Sam', password: 'correct horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.isAdmin, false);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'SAM@example.com', password: 'whatever12' })).status, 409);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'sam@example.com', password: 'nope nope' })).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'sam@example.com', password: 'correct horse' })).status, 200);
  const lists = await api('GET', '/api/lists');
  assert.equal(lists.body.length, 1, 'new accounts get a list');
});

test('non-admins cannot refresh prices; admins can see the admin overview', async () => {
  const user = client();
  await user('POST', '/api/auth/signup', { email: 'pat@example.com', password: 'password123' });
  assert.equal((await user('POST', '/api/admin/scrape', {})).status, 403);
  const admin = client();
  const r = await admin('POST', '/api/auth/signup', { email: 'admin@example.com', password: 'password123' });
  assert.equal(r.body.user.isAdmin, true);
  assert.equal((await admin('GET', '/api/admin/overview')).status, 200);
});

test('shared list: invite, both edit, outsiders locked out', async () => {
  const alex = client();
  const jo = client();
  const eve = client();
  await alex('POST', '/api/auth/signup', { email: 'alex@example.com', password: 'password123' });
  await jo('POST', '/api/auth/signup', { email: 'jo@example.com', password: 'password123' });
  await eve('POST', '/api/auth/signup', { email: 'eve@example.com', password: 'password123' });
  const list = (await alex('POST', '/api/lists', { name: 'Household' })).body;

  const inv = (await alex('POST', `/api/lists/${list.id}/invites`)).body;
  assert.match(inv.url, /\/join\//);
  assert.equal((await jo('POST', `/api/invites/${inv.token}/accept`)).status, 200);

  const milk = await productId(jo, 'milk', 'woolworths');
  assert.equal((await jo('POST', `/api/lists/${list.id}/items`, { productId: milk })).status, 200);
  const view = (await alex('GET', `/api/lists/${list.id}`)).body;
  assert.equal(view.items.length, 1);
  assert.equal(view.members.length, 2);

  assert.equal((await eve('GET', `/api/lists/${list.id}`)).status, 404);
  assert.equal((await eve('PATCH', `/api/items/${view.items[0].id}`, { quantity: 5 })).status, 404);
  assert.equal((await jo('DELETE', `/api/lists/${list.id}`)).status, 403, 'only the owner deletes');
});

test('store exclusion shows what each store saves or costs', async () => {
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'kim@example.com', password: 'password123' });
  const list = (await api('GET', '/api/lists')).body[0];
  await api('POST', `/api/lists/${list.id}/items`, { productId: await productId(api, 'milk', 'woolworths'), quantity: 2 });
  await api('POST', `/api/lists/${list.id}/items`, { productId: await productId(api, 'eggs', 'coles') });

  let v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.plan.total, 12.88);
  assert.equal(v.impact.aldi.costIfExcluded, 0.22, 'without ALDI the milk comes from Coles: 2 × $0.11');
  assert.equal(v.impact.coles.itemsLostIfExcluded, 1, 'eggs are only at Coles');

  await api('PATCH', `/api/lists/${list.id}`, { excludedStores: ['aldi'] });
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.plan.total, 13.1);
  assert.deepEqual(v.impact.aldi, { included: false, savingIfIncluded: 0.22, itemsGainedIfIncluded: 0 });
});

test('cross-site writes are rejected', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('signup page shop choice and settings: preferred shops filter search and new lists', async () => {
  const api = client();
  const r = await api('POST', '/api/auth/signup', { email: 'lee@example.com', password: 'password123', preferredStores: ['coles', 'aldi'] });
  assert.deepEqual(r.body.user.preferredStores, ['coles', 'aldi']);
  const groups = (await api('GET', '/api/search?q=milk')).body;
  const stores = new Set(groups.flatMap((g) => g.members.map((m) => m.store)));
  assert.ok(!stores.has('woolworths'), 'Woolworths hidden from search');
  const list = (await api('GET', '/api/lists')).body[0];
  assert.deepEqual((await api('GET', `/api/lists/${list.id}`)).body.included, ['coles', 'aldi']);

  // Change settings and apply to existing lists
  await api('PATCH', '/api/me', { preferredStores: ['woolworths', 'coles'], applyToLists: true });
  assert.deepEqual((await api('GET', `/api/lists/${list.id}`)).body.included, ['woolworths', 'coles']);
  assert.equal((await api('PATCH', '/api/me', { preferredStores: [] })).status, 400);
});

test('change password signs out other sessions; delete account', async () => {
  const a = client();
  const b = client();
  await a('POST', '/api/auth/signup', { email: 'max@example.com', password: 'password123' });
  await b('POST', '/api/auth/login', { email: 'max@example.com', password: 'password123' });
  assert.equal((await a('POST', '/api/me/password', { currentPassword: 'wrong', newPassword: 'newpassword1' })).status, 400);
  assert.equal((await a('POST', '/api/me/password', { currentPassword: 'password123', newPassword: 'newpassword1' })).status, 200);
  assert.equal((await a('GET', '/api/lists')).status, 200, 'this session stays signed in');
  assert.equal((await b('GET', '/api/lists')).status, 401, 'other sessions are signed out');
  assert.equal((await a('DELETE', '/api/me', { password: 'newpassword1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'max@example.com', password: 'newpassword1' })).status, 401);
});

test('IGA: pick a store, prices follow the store, lists can use another store', async () => {
  const { saveDirectory } = await import('../src/iga.js');
  saveDirectory([
    { retailerStoreId: '32600', name: 'IGA Erskine Park', city: 'Erskine Park', countyProvinceState: 'NSW', postCode: '2759', location: { latitude: -33.80, longitude: 150.80 } },
    { retailerStoreId: '4647', name: 'IGA Waterloo', city: 'Waterloo', countyProvinceState: 'NSW', postCode: '2017', location: { latitude: -33.90, longitude: 151.20 } },
    { retailerStoreId: '999', name: 'IGA Perth', city: 'Perth', countyProvinceState: 'WA', postCode: '6000', location: { latitude: -31.95, longitude: 115.86 } },
  ]);
  // Same product, different price at two IGA stores.
  upsertProducts('iga', [{ store_product_id: 'x1', name: 'Community Co Full Cream Milk', brand: 'Community Co', size_text: '2L', price: 3.5 }], undefined, '32600');
  upsertProducts('iga', [{ store_product_id: 'x1', name: 'Community Co Full Cream Milk', brand: 'Community Co', size_text: '2L', price: 2.5 }], undefined, '4647');

  const anon = client();
  // Find stores by suburb, postcode and location
  assert.equal((await anon('GET', '/api/iga/stores?q=waterloo')).body[0].id, '4647');
  assert.equal((await anon('GET', '/api/iga/stores?q=2017')).body[0].id, '4647');
  const near = (await anon('GET', '/api/iga/stores?lat=-31.9&lng=115.9')).body;
  assert.equal(near[0].id, '999');
  assert.ok(near[0].distanceKm < 10);

  // Visitors see the default IGA store's prices unless they pass ?iga=
  const igaPrice = (groups) => groups.find((g) => g.best.iga)?.best.iga.product.price;
  assert.equal(igaPrice((await anon('GET', '/api/search?q=milk')).body), 3.5);
  assert.equal(igaPrice((await anon('GET', '/api/search?q=milk&iga=4647')).body), 2.5);

  // A user picks Waterloo: search and their new lists use it
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'ira@example.com', password: 'password123', igaStore: '4647' });
  assert.equal((await api('GET', '/api/config')).body.igaStore.id, '4647');
  assert.equal(igaPrice((await api('GET', '/api/search?q=milk')).body), 2.5);
  const list = (await api('GET', '/api/lists')).body[0];
  const milk = (await api('GET', '/api/search?q=milk&store=iga')).body[0].anchor.id;
  await api('POST', `/api/lists/${list.id}/items`, { productId: milk, matchMode: 'this' });
  let v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.igaStore.id, '4647');
  assert.equal(v.items[0].perStore.iga.product.price, 2.5);

  // The household list switches to Erskine Park: the exact product follows the store
  assert.equal((await api('PATCH', `/api/lists/${list.id}`, { igaStore: '32600' })).status, 200);
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.items[0].perStore.iga.product.price, 3.5);

  assert.equal((await api('PATCH', `/api/lists/${list.id}`, { igaStore: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/iga/stores/123456/use')).status, 400);
});

test('IGA shares one catalogue row per product; prices and history are per store', async () => {
  const { getDb } = await import('../src/db.js');
  const d = getDb();
  upsertProducts('iga', [{ store_product_id: 'x9', name: 'Community Co Rolled Oats', brand: 'Community Co', size_text: '1kg', price: 3 }], '2026-01-01T00:00:00.000Z', '32600');
  upsertProducts('iga', [{ store_product_id: 'x9', name: 'Community Co Rolled Oats', brand: 'Community Co', size_text: '1kg', price: 2 }], '2026-01-01T00:00:00.000Z', '4647');
  upsertProducts('iga', [{ store_product_id: 'x9', name: 'Community Co Rolled Oats', brand: 'Community Co', size_text: '1kg', price: 2.5 }], '2026-01-02T00:00:00.000Z', '4647');
  const rows = d.prepare("SELECT id, price, location_priced FROM products WHERE store = 'iga' AND store_product_id = 'x9'").all();
  assert.equal(rows.length, 1, 'one catalogue row');
  assert.equal(rows[0].price, null, 'catalogue row has no price of its own');
  const prices = d.prepare('SELECT location, price FROM store_prices WHERE product_id = ? ORDER BY location').all(rows[0].id);
  assert.deepEqual(prices, [{ location: '32600', price: 3 }, { location: '4647', price: 2.5 }]);

  const anon = client();
  const detail = (await anon('GET', `/api/products/${rows[0].id}?iga=4647`)).body;
  assert.equal(detail.product.price, 2.5);
  assert.deepEqual(detail.history.filter((h) => h.product_id === rows[0].id).map((h) => h.price), [2, 2.5]);
  const other = (await anon('GET', `/api/products/${rows[0].id}?iga=32600`)).body;
  assert.deepEqual(other.history.filter((h) => h.product_id === rows[0].id).map((h) => h.price), [3]);
});

test('IGA stores whose catalogue is empty online are hidden from the picker', async () => {
  const { markScraped } = await import('../src/iga.js');
  const anon = client();
  assert.equal((await anon('GET', '/api/iga/stores?q=perth')).body.length, 1);
  markScraped('999', 0); // fetched: no products online
  assert.equal((await anon('GET', '/api/iga/stores?q=perth')).body.length, 0);
  const r = await anon('POST', '/api/iga/stores/999/use');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /doesn’t publish its prices online/);
  assert.equal((await anon('GET', '/api/config')).body.igaOnlineStores, 2);
});

test('daily IGA check: hides stores that stop publishing prices, re-lists ones that start', async () => {
  const iga = await import('../src/iga.js');
  const { getDb } = await import('../src/db.js');
  const directory = [
    { retailerStoreId: '32600', name: 'IGA Erskine Park', city: 'Erskine Park', countyProvinceState: 'NSW', postCode: '2759', location: { latitude: -33.80, longitude: 150.80 } },
    { retailerStoreId: '4647', name: 'IGA Waterloo', city: 'Waterloo', countyProvinceState: 'NSW', postCode: '2017', location: { latitude: -33.90, longitude: 151.20 } },
    { retailerStoreId: '999', name: 'IGA Perth', city: 'Perth', countyProvinceState: 'WA', postCode: '6000', location: { latitude: -31.95, longitude: 115.86 } },
  ];
  let catalogue = { 32600: 500, 4647: 0, 999: 300 }; // Waterloo has gone dark; Perth is back
  const run = () => iga.checkOnlineStores({
    log() {},
    loadDirectory: async () => iga.saveDirectory(directory, { complete: true }),
    probe: async (client, id) => catalogue[id],
  });

  let r = await run();
  assert.equal(r.withPrices, 2);
  const names = async (q) => (await client()('GET', `/api/iga/stores?q=${q}`)).body.map((s) => s.id);
  assert.deepEqual(await names('waterloo'), []);
  assert.deepEqual(await names('perth'), ['999'], 'Perth is offered again now it has prices');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM iga_tracked WHERE store_id = '4647'").get().n, 0, 'stopped following Waterloo');
  assert.equal(iga.getStore('4647').online, false, 'people who chose Waterloo can be told');

  // Waterloo publishes prices again; Perth drops out of IGA's directory entirely.
  catalogue = { 32600: 500, 4647: 800 };
  directory.pop();
  r = await run();
  assert.equal(r.cameOnline, 1);
  assert.deepEqual(await names('waterloo'), ['4647']);
  assert.deepEqual(await names('perth'), []);
  assert.equal(iga.lastCheck().with_prices, 2);
  assert.equal(iga.checkIsDue(), false);
});

test('forgot password: email with a one-time link; verify email', async () => {
  const { capturedMail } = await import('../src/mailer.js');
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'forgetful@example.com', name: 'Fay', password: 'password123' });
  const verifyMail = capturedMail.find((m) => m.to === 'forgetful@example.com' && m.kind === 'verify');
  assert.ok(verifyMail, 'verification email sent at sign-up');
  const vtoken = verifyMail.text.match(/token=([\w-]+)/)[1];
  assert.equal((await client()('POST', '/api/auth/verify', { token: vtoken })).status, 200);
  assert.equal((await api('GET', '/api/config')).body.user.emailVerified, true);

  const before = capturedMail.length;
  // Unknown emails get the same answer and no email.
  assert.equal((await client()('POST', '/api/auth/forgot', { email: 'nobody@example.com' })).status, 200);
  assert.equal(capturedMail.length, before);
  await client()('POST', '/api/auth/forgot', { email: 'forgetful@example.com' });
  const mail = capturedMail.at(-1);
  assert.equal(mail.kind, 'reset');
  const token = mail.text.match(/token=([\w-]+)/)[1];

  const other = client();
  const r = await other('POST', '/api/auth/reset', { token, password: 'brand new pass' });
  assert.equal(r.status, 200, 'reset logs you in');
  assert.equal((await api('GET', '/api/lists')).status, 401, 'old sessions are signed out');
  assert.equal((await other('POST', '/api/auth/reset', { token, password: 'again again' })).status, 400, 'links work once');
  assert.equal((await client()('POST', '/api/auth/login', { email: 'forgetful@example.com', password: 'brand new pass' })).status, 200);
});

test('export my data', async () => {
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'exporter@example.com', password: 'password123' });
  const r = await api('GET', '/api/me/export');
  assert.equal(r.status, 200);
  assert.equal(r.body.account.email, 'exporter@example.com');
  assert.ok(Array.isArray(r.body.lists));
});

test('admin backups: snapshot, list, download; non-admins refused', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  const made = await admin('POST', '/api/admin/backups');
  assert.equal(made.status, 200);
  assert.ok(made.body.bytes > 0);
  const list = (await admin('GET', '/api/admin/backups')).body.snapshots;
  assert.ok(list.some((b) => b.name === made.body.name));
  const user = client();
  await user('POST', '/api/auth/login', { email: 'pat@example.com', password: 'password123' });
  assert.equal((await user('GET', '/api/admin/backups')).status, 403);
  assert.equal((await admin('GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
});

test('home collector: token-protected ingest with complete runs', async () => {
  process.env.COLLECTOR_TOKEN = 'collector-secret-123';
  const post = (path, body, token = 'collector-secret-123') => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.equal((await post('/api/ingest/runs', { store: 'aldi' }, 'wrong-token-xxxxxxx')).status, 401);
  const run = (await post('/api/ingest/runs', { store: 'aldi' })).body;
  assert.ok(run.runId);
  const r = await post(`/api/ingest/runs/${run.runId}/items`, { items: [
    { store_product_id: 'a1', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale', size_text: '2L', price: 2.89 },
  ] });
  assert.equal(r.status, 200);
  const done = await post(`/api/ingest/runs/${run.runId}/finish`, { complete: true });
  assert.equal(done.body.status, 'ok');
  assert.equal(done.body.priceChanges, 1, 'ALDI milk 2.99 → 2.89 recorded');
  assert.equal((await post(`/api/ingest/runs/${run.runId}/items`, { items: [] })).status, 409, 'finished runs take no more data');
});

test('multi-buys and member prices change what a list costs', async () => {
  // Woolworths: $2.90 each, or 5 for $9. Coles: $1.95 each.
  upsertProducts('woolworths', [{ store_product_id: 'y1', name: 'Farmers Union Greek Yoghurt Pouch Vanilla 130g', brand: 'Farmers Union',
    size_text: '130g', price: 2.9, multi_qty: 5, multi_price: 9, promo_text: '5 for $9.00', barcode: '9300658408045' }]);
  upsertProducts('coles', [{ store_product_id: 'y1', name: 'Farmers Union Greek Yoghurt Pouch Vanilla', brand: 'Farmers Union',
    size_text: '130g', price: 1.95 }]);
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'yog@example.com', password: 'password123', preferredStores: ['woolworths', 'coles'] });
  const list = (await api('GET', '/api/lists')).body[0];
  const ww = (await api('GET', '/api/search?q=farmers+union+pouch&store=woolworths')).body[0].anchor.id;
  await api('POST', `/api/lists/${list.id}/items`, { productId: ww, quantity: 4 });
  let v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.items[0].cheapest, 'coles', '4 × $1.95 = $7.80 beats 4 × $2.90');
  const item = v.items[0].id;
  await api('PATCH', `/api/items/${item}`, { quantity: 5 });
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.items[0].cheapest, 'woolworths', '5 for $9 beats 5 × $1.95 = $9.75');
  assert.equal(v.plan.total, 9);
  assert.equal(v.plan.byStore.woolworths.items[0].dealSaving, 5.5);
});

test('member prices only count for members', async () => {
  upsertProducts('woolworths', [{ store_product_id: 'm1', name: 'Arnotts Tim Tam Original 200g', brand: 'Arnotts', size_text: '200g', price: 5, member_price: 3.5 }]);
  upsertProducts('coles', [{ store_product_id: 'm1', name: 'Arnotts Tim Tam Original', brand: 'Arnotts', size_text: '200g', price: 4 }]);
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'member@example.com', password: 'password123', preferredStores: ['woolworths', 'coles'] });
  const cheapestFor = async () => (await api('GET', '/api/search?q=tim+tam')).body.find((g) => g.best.coles)?.cheapest;
  assert.equal(await cheapestFor(), 'coles');
  await api('PATCH', '/api/me', { memberships: ['woolworths'] });
  assert.equal(await cheapestFor(), 'woolworths');
});

test('barcodes match products the names miss; same brand + different barcode does not match', async () => {
  upsertProducts('woolworths', [{ store_product_id: 'b1', name: 'Pauls Plus+ Protein Flavoured Milk Chocolate 400mL', brand: 'Pauls', size_text: '400mL', price: 4, barcode: '9300601999991' },
    { store_product_id: 'b2', name: 'Pauls Plus+ Protein Milk Chocolate Smooth 400mL', brand: 'Pauls', size_text: '400mL', price: 4, barcode: '9300601999992' }]);
  upsertProducts('coles', [{ store_product_id: 'b1', name: 'Pauls Plus+ Protein Chocolate Low Fat Nas Milk', brand: 'Pauls', size_text: '400mL', price: 3.6, barcode: '9300601999991' }]);
  const anon = client();
  const g = (await anon('GET', '/api/search?q=protein+chocolate+low+fat+nas')).body[0];
  assert.equal(g.best.woolworths?.product.store_product_id, 'b1', 'matched by barcode');
  assert.ok(!g.members.some((m) => m.store_product_id === 'b2'), 'different barcode, same brand: not the same');
});

test('wrong-match reports: admin accepts, rule applies to everyone', async () => {
  const user = client();
  await user('POST', '/api/auth/login', { email: 'pat@example.com', password: 'password123' });
  const g = (await user('GET', '/api/search?q=milk&store=woolworths')).body[0];
  const other = g.members.find((m) => m.store === 'aldi');
  assert.ok(other, 'ALDI milk is matched to begin with');
  const r = await user('POST', '/api/match-reports', { anchorId: g.anchor.id, productId: other.id, kind: 'not_same', note: 'different milk' });
  assert.equal(r.body.status, 'open');
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  const queue = (await admin('GET', '/api/admin/match-reports')).body.open;
  assert.equal(queue.length, 1);
  await admin('POST', `/api/admin/match-reports/${queue[0].id}`, { decision: 'accept' });
  const after = (await client()('GET', '/api/search?q=milk&store=woolworths')).body[0];
  assert.ok(!after.members.some((m) => m.id === other.id), 'no longer matched for anyone');
  await admin('DELETE', `/api/admin/match-rules/${Math.min(g.anchor.id, other.id)}/${Math.max(g.anchor.id, other.id)}`);
});

test('watch a price; alert email once per drop; one-click unsubscribe', async () => {
  const { capturedMail } = await import('../src/mailer.js');
  const { sendPriceAlerts } = await import('../src/alerts.js');
  const { getDb } = await import('../src/db.js');
  const api = client();
  const u = (await api('POST', '/api/auth/signup', { email: 'watcher@example.com', password: 'password123' })).body.user;
  getDb().prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  upsertProducts('coles', [{ store_product_id: 'w1', name: 'Coles Rolled Oats', brand: 'Coles', size_text: '750g', price: 3 }]);
  const pid = (await api('GET', '/api/search?q=rolled+oats&store=coles')).body[0].anchor.id;
  await api('PUT', `/api/watches/${pid}`, { targetPrice: 2.5 });
  await sendPriceAlerts({ baseUrl: base });
  assert.ok(!capturedMail.some((m) => m.to === 'watcher@example.com' && m.kind === 'price-alert'), 'no alert above target');
  upsertProducts('coles', [{ store_product_id: 'w1', name: 'Coles Rolled Oats', brand: 'Coles', size_text: '750g', price: 2.4 }]);
  await sendPriceAlerts({ baseUrl: base });
  await sendPriceAlerts({ baseUrl: base });
  const sent = capturedMail.filter((m) => m.to === 'watcher@example.com' && m.kind === 'price-alert');
  assert.equal(sent.length, 1, 'one email per drop');
  const link = sent[0].text.match(/(\/api\/unsubscribe\?[^\s]+)/)[1];
  assert.equal((await fetch(base + link)).status, 200);
  assert.equal((await api('GET', '/api/config')).body.user.alertsPrice, false);
  assert.equal((await fetch(base + link.replace(/s=[^&]+/, 's=forged'))).status, 400);
});

test('tick off in the shop, finish, repeat a past shop', async () => {
  const api = client();
  await api('POST', '/api/auth/signup', { email: 'shopper@example.com', password: 'password123' });
  const list = (await api('GET', '/api/lists')).body[0];
  const milk = (await api('GET', '/api/search?q=milk&store=coles')).body[0].anchor.id;
  const oats = (await api('GET', '/api/search?q=rolled+oats&store=coles')).body[0].anchor.id;
  await api('POST', `/api/lists/${list.id}/items`, { productId: milk, quantity: 2 });
  await api('POST', `/api/lists/${list.id}/items`, { productId: oats });
  await api('POST', `/api/lists/${list.id}/snapshots`, { name: 'Weekly basics' });
  let v = (await api('GET', `/api/lists/${list.id}`)).body;
  await api('PUT', `/api/items/${v.items[0].id}/checked`, { checked: true });
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.ok(v.items[0].checkedAt);
  const done = (await api('POST', `/api/lists/${list.id}/finish`)).body;
  assert.equal(done.items, 1);
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.items.length, 1, 'bought item removed');
  const snaps = (await api('GET', `/api/lists/${list.id}/snapshots`)).body;
  assert.deepEqual(snaps.map((x) => x.kind).sort(), ['history', 'saved']);
  const added = (await api('POST', `/api/lists/${list.id}/snapshots/${snaps.find((x) => x.kind === 'saved').id}/add`)).body;
  assert.equal(added.added, 1, 'adds back what is missing, skips what is already there');
  v = (await api('GET', `/api/lists/${list.id}`)).body;
  assert.equal(v.items.find((i) => i.anchor.id === milk).quantity, 2);
});

test('admin settings: saved in the database, .env wins, secrets never shown', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  const user = client();
  await user('POST', '/api/auth/login', { email: 'pat@example.com', password: 'password123' });
  assert.equal((await user('GET', '/api/admin/settings')).status, 403);

  // Email: fields in, URL stored, password never returned.
  let r = await admin('PUT', '/api/admin/settings', {
    smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'me@example.com', password: 's3cr3t pass' },
    MAIL_FROM: 'Groceries <alerts@example.com>',
    SITE_URL: 'https://groceries.example.com/some/path',
    CONTACT_EMAIL: 'privacy@example.com',
  });
  assert.equal(r.status, 200);
  const s = r.body.settings;
  assert.deepEqual(s.SMTP_URL.parts, { host: 'smtp.example.com', port: 465, secure: true, user: 'me@example.com', passwordSet: true });
  assert.equal(s.SMTP_URL.value, null, 'secret not sent back');
  assert.ok(!JSON.stringify(r.body).includes('s3cr3t'));
  assert.equal(s.SITE_URL.value, 'https://groceries.example.com', 'trimmed to the site’s origin');
  assert.equal((await client()('GET', '/api/config')).body.site.contact, 'privacy@example.com', 'privacy page uses it');
  assert.equal((await client()('GET', '/api/config')).body.site.emailEnabled, true);

  // Changing the port with a blank password keeps the saved password.
  r = await admin('PUT', '/api/admin/settings', { smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'me@example.com', password: '' } });
  assert.equal(r.body.settings.SMTP_URL.parts.passwordSet, true);
  const { getSetting } = await import('../src/settings.js');
  assert.equal(getSetting('SMTP_URL'), 'smtp://me%40example.com:s3cr3t%20pass@smtp.example.com:587');

  // Bad values are refused and nothing is saved.
  r = await admin('PUT', '/api/admin/settings', { CONTACT_EMAIL: 'nope', MAIL_FROM: 'Groceries <ok@example.com>' });
  assert.equal(r.status, 400);
  assert.equal(getSetting('CONTACT_EMAIL'), 'privacy@example.com');

  // Test email goes to the admin.
  const { capturedMail } = await import('../src/mailer.js');
  r = await admin('POST', '/api/admin/settings/test-email');
  assert.equal(r.body.to, 'admin@example.com');
  assert.equal(capturedMail.at(-1).kind, 'test');

  // .env wins and locks the setting.
  process.env.SITE_OPERATOR = 'From env';
  r = await admin('GET', '/api/admin/settings');
  assert.equal(r.body.settings.SITE_OPERATOR.source, 'env');
  assert.equal((await admin('PUT', '/api/admin/settings', { SITE_OPERATOR: 'Me' })).status, 409);
  delete process.env.SITE_OPERATOR;

  // Clearing email turns sending off again.
  await admin('PUT', '/api/admin/settings', { smtp: null });
  assert.equal((await client()('GET', '/api/config')).body.site.emailEnabled, false);
});

test('admin settings: collector token and which stores the server crawls', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  const saved = process.env.COLLECTOR_TOKEN;
  delete process.env.COLLECTOR_TOKEN; // as if not in .env
  const { token } = (await admin('POST', '/api/admin/settings/collector-token')).body;
  assert.ok(token.length >= 24);
  const post = (t) => fetch(base + '/api/ingest/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ store: 'aldi' }),
  });
  assert.equal((await post(token)).status, 200, 'generated token works for the collector');
  const s = (await admin('GET', '/api/admin/settings')).body.settings;
  assert.equal(s.COLLECTOR_TOKEN.value, null, 'token not shown again');
  assert.equal(s.COLLECTOR_TOKEN.set, true);
  await admin('DELETE', '/api/admin/settings/collector-token');
  assert.equal((await post(token)).status, 401, 'revoked');

  await admin('PUT', '/api/admin/settings', { SERVER_SCRAPE_STORES: ['coles', 'iga', 'harrisfarm'] });
  const { serverStores } = await import('../src/scrapers/index.js');
  assert.deepEqual(serverStores(), ['coles', 'iga', 'harrisfarm']);
  const o = (await admin('GET', '/api/admin/overview')).body;
  assert.equal(o.stores.find((x) => x.store === 'woolworths').fedByCollector, true);
  await admin('PUT', '/api/admin/settings', { SERVER_SCRAPE_STORES: ['woolworths', 'coles', 'aldi', 'iga', 'harrisfarm'] });
  assert.equal(serverStores().length, 5);
  if (saved) process.env.COLLECTOR_TOKEN = saved;
});

test('home collector download, version check and self-update bundle', async () => {
  const zlib = await import('node:zlib');
  const fs = await import('node:fs');
  const { collectorVersion } = await import('../src/collector-files.js');
  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  const cookie = await (async () => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }) });
    return r.headers.get('set-cookie').split(';')[0];
  })();
  assert.equal((await fetch(base + '/api/admin/collector/download')).status, 401, 'admins only');
  const saved = process.env.COLLECTOR_TOKEN;
  delete process.env.COLLECTOR_TOKEN;
  const res = await fetch(base + '/api/admin/collector/download', { headers: { Cookie: cookie } });
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await res.arrayBuffer());

  // Unpack the zip by hand and check every file.
  const files = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString();
    const data = zlib.inflateRawSync(buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size));
    assert.equal(zlib.crc32(data), buf.readUInt32LE(at + 14), `crc ok for ${name}`);
    files[name.replace('grocery-home-collector/', '')] = data.toString();
    at += 30 + nameLen + size;
  }
  for (const f of ['src/cli/collect.js', 'src/scrapers/registry.js', 'package.json', 'start.sh', 'start.bat', 'README.txt', '.env']) assert.ok(files[f], f);
  // Points at the site's public address (SITE_URL) when one is set, else the address used.
  const site = (await admin('GET', '/api/admin/settings')).body.settings.SITE_URL.value || base;
  assert.ok(files['.env'].includes(`COLLECTOR_SERVER=${site}\n`), 'collector points at this site');
  const token = files['.env'].match(/COLLECTOR_TOKEN=(\S+)/)[1];
  assert.ok(token.length >= 24, 'a token was created for the download');
  assert.ok(!Object.keys(files).some((f) => f.includes('db.js') || f.includes('auth.js')), 'only collector code, no server code');
  const zipVersion = collectorVersion((p) => files[p]);

  // The collector asks for the latest version and gets the matching code.
  const call = (p) => fetch(base + p, { headers: { Authorization: `Bearer ${token}`, 'X-Collector-Version': 'old123', 'X-Collector-Mode': 'bundle' } }).then((r) => r.json());
  assert.equal((await call('/api/collector/latest')).version, zipVersion);
  const bundle = await call('/api/collector/bundle');
  assert.equal(collectorVersion((p) => bundle.files[p]), bundle.version);
  assert.ok(!('.env' in bundle.files), 'updates never touch the collector’s settings');
  assert.equal((await fetch(base + '/api/collector/latest')).status, 401, 'needs the token');

  // The admin page sees which version last connected.
  const st = (await admin('GET', '/api/admin/settings')).body.collector;
  assert.equal(st.last.version, 'old123');
  assert.equal(st.last.upToDate, false);
  assert.equal(st.latest, zipVersion);
  // Repo files and served files fingerprint the same.
  assert.equal(collectorVersion((p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')), zipVersion);
  await admin('DELETE', '/api/admin/settings/collector-token');
  if (saved) process.env.COLLECTOR_TOKEN = saved;
});

test('home collector as a single program: download with settings appended, and the launcher fetching its code', async () => {
  const zlib = await import('node:zlib');
  const { spawn } = await import('node:child_process');
  const { programName } = await import('../src/collector-exe-targets.js');
  const { CONFIG_MARK, CONFIG_END } = await import('../src/collector-exe.js');
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(base + p, { headers: { Cookie: cookie } });

  // A stand-in "prebuilt" program, as the Docker image would have.
  const pre = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-exe-'));
  process.env.COLLECTOR_EXE_PREBUILT = pre;
  const fake = Buffer.from('pretend program '.repeat(1000));
  fs.writeFileSync(path.join(pre, programName('linux-x64', true)), zlib.gzipSync(fake));

  const { programs } = await (await get('/api/admin/collector/programs')).json();
  assert.deepEqual(programs.map((p) => [p.id, p.ready]), [['windows-x64', false], ['linux-x64', true], ['linux-arm64', false]]);
  assert.equal(programs[1].bytes, fake.length);
  assert.equal((await get('/api/admin/collector/programs/windows-x64')).status, 409, 'not built yet');
  assert.equal((await fetch(base + '/api/admin/collector/programs/linux-x64')).status, 401, 'admins only');

  const saved = process.env.COLLECTOR_TOKEN;
  delete process.env.COLLECTOR_TOKEN;
  const res = await get('/api/admin/collector/programs/linux-x64');
  assert.match(res.headers.get('content-disposition'), /filename="grocery-collector"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), body.length);
  assert.ok(body.subarray(0, fake.length).equals(fake), 'the program, unchanged');
  const tail = body.subarray(fake.length).toString('latin1');
  assert.ok(tail.startsWith(CONFIG_MARK) && tail.endsWith(CONFIG_END));
  const config = JSON.parse(Buffer.from(tail.slice(CONFIG_MARK.length, -CONFIG_END.length), 'base64').toString());
  assert.ok(config.COLLECTOR_TOKEN.length >= 24, 'a token was made for the download');
  assert.equal(config.AUTO_UPDATE, 'true');
  assert.ok(config.COLLECTOR_SERVER.startsWith('http'));

  // The launcher (run here by plain Node) downloads the code, checks it, caches it and starts the collector.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'smt-home-'));
  const child = spawn(process.execPath, [new URL('../src/collector-launcher.cjs', import.meta.url).pathname, 'aldi'], {
    env: {
      ...process.env, GROCERY_COLLECTOR_CHILD: '1', GROCERY_COLLECTOR_HOME: home,
      COLLECTOR_SERVER: base, COLLECTOR_TOKEN: config.COLLECTOR_TOKEN, COLLECT_CRON: '0 4 * * *', COLLECT_ON_START: 'false', AUTO_UPDATE: 'true',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const latest = (await (await fetch(base + '/api/collector/latest', { headers: { Authorization: `Bearer ${config.COLLECTOR_TOKEN}` } })).json()).version;
  for (let i = 0; i < 100 && !out.includes('Collecting on schedule'); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  assert.match(out, new RegExp(`Home collector ${latest} \\(exe\\)`), out);
  assert.ok(fs.existsSync(path.join(home, 'code', latest, 'src', 'scrapers', 'aldi.js')), 'code cached for offline starts');

  fs.rmSync(pre, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.COLLECTOR_EXE_PREBUILT;
  if (saved) process.env.COLLECTOR_TOKEN = saved;
  else delete process.env.COLLECTOR_TOKEN;
});

test('home collector code needs no npm packages (so it can run as a single program)', async () => {
  const { COLLECTOR_CODE } = await import('../src/collector-files.js');
  for (const p of COLLECTOR_CODE) {
    const text = fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    for (const [, spec] of text.matchAll(/^import .* from '([^']+)'/gm)) {
      assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `${p} imports ${spec}`);
    }
  }
});
