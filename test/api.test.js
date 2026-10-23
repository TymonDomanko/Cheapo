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
