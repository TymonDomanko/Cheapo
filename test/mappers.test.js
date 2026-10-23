import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProduct as iga } from '../src/scrapers/iga.js';

test('IGA: counted items keep their pack size', () => {
  const base = { productId: '1', name: 'Libra Pads Extra Wings Regular', brand: 'Libra', priceNumeric: 5.7, sellBy: 'Each' };
  assert.equal(iga({ ...base, unitOfSize: { abbreviation: '', label: 'Each', size: 14, type: 'each' } }).size_text, '14 pack');
  assert.equal(iga({ ...base, unitOfSize: { abbreviation: '', label: 'Each', size: 1, type: 'each' } }).size_text, 'each');
  assert.equal(iga({ ...base, unitOfSize: { abbreviation: 'g', size: 500, type: 'weight' } }).size_text, '500g');
  assert.equal(iga({ ...base, unitOfSize: { abbreviation: 'l', size: 2, type: 'volume' } }).size_text, '2L');
  assert.equal(iga({ ...base, sellBy: 'Weight', unitOfSize: { abbreviation: 'kg', size: 1 } }).size_text, 'per kg');
});

test('Harris Farm: fees and gift cards aren’t products', async () => {
  const { mapProduct: hf } = await import('../src/scrapers/harrisfarm.js');
  const v = [{ id: 1, price: '25.00', available: true }];
  assert.deepEqual(hf({ id: 1, title: 'Delivery Fee 25', product_type: 'Z-Delivery', variants: v }), []);
  assert.deepEqual(hf({ id: 2, title: 'Harris Farm Digital Gift Card $150', product_type: 'Gift', variants: v }), []);
  assert.deepEqual(hf({ id: 3, title: 'Service Fee', product_type: 'Fees', variants: v }), []);
  assert.equal(hf({ id: 4, title: 'Pudding Lane Classic Christmas Pudding 500g', product_type: 'Z-Bakery', variants: v }).length, 1);
});

test('a category that keeps failing is skipped, not the whole shop', async () => {
  const { eachCategory } = await import('../src/scrapers/http.js');
  const logs = [];
  const run = async (failing) => {
    const got = [];
    try {
      for await (const b of eachCategory('coles', ['a', 'b', 'c', 'd'].map((slug) => ({ slug })), (m) => logs.push(m), async function* (cat) {
        if (failing.includes(cat.slug)) throw new Error('bot check');
        yield [cat.slug];
      })) got.push(...b);
      return { got };
    } catch (e) {
      return { got, error: e.message };
    }
  };
  let r = await run(['b']);
  assert.deepEqual(r.got, ['a', 'c', 'd'], 'the rest is still saved');
  assert.match(r.error, /couldn't fetch 1 of 4 categories \(b\)/);
  assert.match(logs.join('\n'), /skipped b — bot check/);
  r = await run(['a', 'b', 'c']);
  assert.match(r.error, /stopped after 3 categories in a row failed/);
  assert.deepEqual(r.got, []);
  assert.deepEqual((await run([])).got, ['a', 'b', 'c', 'd']);
});
