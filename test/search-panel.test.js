// The "cheapest of it, any brand" panel on everyday searches: what counts as
// the thing searched for, and how it's compared (src/bestprice.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-panel-')), 'test.db');

const { recordBatch, startRun, finishRun, getRun } = await import('../src/scrapers/index.js');
const { bestPrices } = await import('../src/bestprice.js');
const { aisleFor } = await import('../src/aisles.js');

const add = (store, items) => {
  const { runId } = startRun(store);
  recordBatch(getRun(runId), items.map(([id, name, size_text, price, category]) => ({ store_product_id: id, name, size_text, price, category })));
  finishRun(getRun(runId), { complete: false });
};
add('woolworths', [
  ['t1', 'Woolworths Tomato Sauce 500mL', '500mL', 2.5, 'Sauces'],
  ['t2', 'Corale Spaghetti in Tomato Sauce 420g', '420g', 0.9, 'Canned Food'],
  ['t3', 'Remano Tomato Pasta Sauce 500g', '500g', 1.6, 'Pasta Sauce'],
  ['t4', 'Fountain Tomato Sauce 500mL', '500mL', 2.2, 'Sauces'],
  ['o1', 'Woolworths Vegetable Oil 2L', '2L', 5.5, 'Oils'],
  ['o2', 'Coles Salmon In Vegetable Oil 95g', '95g', 1.6, 'Canned Seafood'],
  ['c1', 'Woolworths Cream Cheese 250g', '250g', 2.6, 'Cream Cheese'],
  ['c2', 'Adelaide Hills Triple Cream Brie Cheese 180g', '180g', 4.0, 'Cheese'],
  ['c3', 'Philadelphia Cream Cheese Block 250g', '250g', 4.5, 'Cream Cheese'],
  ['c4', 'Moondarra Honey & Pistachio Cream Cheese 120g', '120g', 2.0, 'Cream Cheese'],
  ['ct1', 'Woolworths Italian Peeled Tomatoes 400g', '400g', 1.1, 'Canned Tomatoes'],
  ['ct2', 'Leggos Diced Tomatoes 400g', '400g', 1.6, 'Canned Tomatoes'],
  ['ct3', 'Truss Tomatoes', 'per kg', 4.9, 'Fruit & Veg'],
  ['m1', 'Woolworths Chicken Thigh Fillets 550g', '550g', 9.7, 'Poultry'],
  ['m2', 'Woolworths Chicken Thigh Fillets 1kg', '1kg', 13, 'Poultry'],
  ['m3', 'Lilydale Chicken Thigh Fillets 480g', '480g', 13.5, 'Poultry'],
  ['m4', 'Woolworths Chicken Thigh Kyiv 400g', '400g', 6, 'Poultry'],
  ['g1', 'Woolworths Minced Garlic 500g', '500g', 2.3, 'Fruit & Veg'],
  ['g2', 'Garlic 3 Pack', '3 pack', 2.99, 'Fruit & Veg'],
  ['g3', 'Garlic Bulb each', 'each', 1.2, 'Fruit & Veg'],
  ['w1', 'Cut Watermelon per kg', 'per kg', 3.5, 'Fruit & Veg'],
  ['w2', 'Whole Watermelon each', 'each', 9, 'Fruit & Veg'],
  ['w3', 'H2juice Watermelon 1.25L', '1.25L', 3.95, 'Juice'],
  ['w4', 'H2Melon Watermelon Water 500mL', '500mL', 2.5, 'Juice'],
  ['w5', 'Ziip Energy Watermelon 500mL', '500mL', 3, 'Energy Drinks'],
]);
add('coles', [
  ['t5', 'Coles Tomato Sauce 500mL', '500mL', 1.75, 'Sauces & Condiments'],
  ['ct4', 'Coles Crushed Tomatoes 400g', '400g', 1.0, 'Canned Tomatoes'],
  ['c5', 'Coles Cream Cheese 250g', '250g', 2.5, 'Cream Cheese'],
  ['m5', 'Coles Chicken Thigh Fillets 700g', '700g', 12.6, 'Poultry'],
]);

test('"X in Y" isn\'t Y: spaghetti in tomato sauce isn\'t tomato sauce, salmon in vegetable oil isn\'t oil', () => {
  const names = (q) => bestPrices(q).groups.flatMap((g) => g.products.map((p) => p.name));
  assert.ok(!names('tomato sauce').some((n) => /spaghetti|pasta sauce/i.test(n)), 'nor tomato pasta sauce: the words have to be together');
  assert.ok(names('tomato sauce').includes('Coles Tomato Sauce 500mL'));
  assert.deepEqual(names('vegetable oil'), ['Woolworths Vegetable Oil 2L']);
});

test('two words together: cream cheese isn\'t triple cream brie; a flavour pair isn\'t plain', () => {
  const names = bestPrices('cream cheese').groups.flatMap((g) => g.products.map((p) => p.name));
  assert.ok(!names.some((n) => /brie/i.test(n)));
  assert.ok(!names.some((n) => /pistachio/i.test(n)));
  assert.ok(names.includes('Woolworths Cream Cheese 250g'));
});

test('"canned tomatoes" finds the cans, whatever their names say', () => {
  const b = bestPrices('canned tomatoes');
  assert.equal(b.aisle, 'pantry');
  assert.equal(b.groups[0].products[0].name, 'Coles Crushed Tomatoes 400g');
});

test('meat is compared per kg, not by pack size, and processed versions are left out', () => {
  const b = bestPrices('chicken thighs');
  assert.ok(b.byUnit);
  assert.deepEqual(b.groups[0].products.map((p) => p.name).slice(0, 2), ['Woolworths Chicken Thigh Fillets 1kg', 'Woolworths Chicken Thigh Fillets 550g']);
  assert.ok(!b.groups[0].products.some((p) => /kyiv/i.test(p.name)));
});

test('fresh fruit and veg: jars of minced garlic aren\'t fresh, and watermelon means the fruit', () => {
  assert.ok(!bestPrices('garlic').groups.flatMap((g) => g.products).some((p) => /minced/i.test(p.name)));
  const w = bestPrices('watermelon');
  assert.ok(w.produce, 'the fruit, not watermelon drinks');
  assert.equal(aisleFor({ name: 'Three Threes Pickled Onions', category: 'Pickled Vegetables' }), 'pantry', 'pickled veg are pantry');
});
