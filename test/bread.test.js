// Bread sorted the way people shop for it: by type (loaves, rolls, wraps…)
// and what it's made from (white, wholemeal…), in the cheapest panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cheapo-bread-')), 'test.db');

const { breadType, breadGrain, breadQuery } = await import('../src/bread.js');
const { recordBatch, startRun, finishRun, getRun } = await import('../src/scrapers/index.js');
const { bestPrices } = await import('../src/bestprice.js');

test('what a bread is, and what it is made from', () => {
  const cases = [
    ['Woolworths White Sandwich Bread Loaf 650g', 'loaf', 'white'],
    ['Wonder White Wholemeal Bread', 'loaf', 'wholemeal'],
    ['Burgen Soy Linseed 700g', 'loaf', 'grain'],
    ['Helga\'s Sourdough Bread', 'loaf', 'sourdough'],
    ['Tip Top Bread Raisin Toast', 'loaf', 'fruit'],
    ['Woolworths Mini Soft Hot Dog Rolls 12 pack', 'roll', 'white'],
    ['Coles Bakery Wholemeal Rolls', 'roll', 'wholemeal'],
    ['Toscano Brioche Burger Buns Sesame Seeds', 'bun', 'white'], // a sesame topping isn't wholegrain
    ['Mission Wraps Original 8 pack', 'wrap', 'white'],
    ['Maharaja Naan Bread Garlic & Coriander', 'wrap', 'white'], // garlic naan is bread; garlic bread isn't
    ['Mission Gluten Free White Corn Tortillas 312g 12 pack', 'wrap', 'glutenfree'],
    ['Jesse\'s Mixed Seeds Bagels 550g', 'bagel', 'grain'],
    ['Tip Top English Muffins Original', 'muffin', 'white'],
    ['Golden Crumpets Round Wholemeal 6 pack', 'crumpet', 'wholemeal'],
    ['Coles Bakery White Vienna', 'crusty', 'white'],
  ];
  for (const [name, type, grain] of cases) assert.deepEqual([breadType(name), breadGrain(name)], [type, grain], name);
  for (const name of ['Black & Gold Garlic Bread Twin Pack', 'Harris Farm Banana Bread Half Loaf', 'Laucke Crusty White Bread Mix 500g',
    'Herbert Adams Sausage Roll Beef', 'Arnott\'s Vita-weat Multigrain Crackers', 'Golden Pikelets', 'Coles Bakery Hawaiian Pizza Roll']) {
    assert.equal(breadType(name), null, `${name} isn't bread`);
  }
  assert.equal(breadType('Helga\'s Sweet Potato', 'Wrap and Flatbread'), 'wrap', 'no type word: the shop\'s aisle says');
});

test('what a search asks for', () => {
  assert.deepEqual(breadQuery('bread'), { type: null, grain: null, rest: [] });
  assert.deepEqual(breadQuery('white bread'), { type: null, grain: 'white', rest: [] });
  assert.deepEqual(breadQuery('wholemeal rolls'), { type: 'roll', grain: 'wholemeal', rest: [] });
  assert.deepEqual(breadQuery('gluten free wraps'), { type: 'wrap', grain: 'glutenfree', rest: [] });
  assert.deepEqual(breadQuery('english muffins'), { type: 'muffin', grain: null, rest: [] });
  assert.deepEqual(breadQuery('burger buns'), { type: 'bun', grain: null, rest: ['burger'] });
  assert.equal(breadQuery('sourdough').grain, 'sourdough');
  assert.equal(breadQuery('milk'), null);
  assert.equal(breadQuery('white rice'), null);
});

test('the cheapest of each type, loaves first, by price per kg; narrowing by grain and type', () => {
  const add = (store, items) => {
    const { runId } = startRun(store);
    recordBatch(getRun(runId), items.map(([id, name, size_text, price, category = 'Bread']) => ({ store_product_id: id, name, size_text, price, category })));
    finishRun(getRun(runId), { complete: false });
  };
  add('woolworths', [
    ['w1', 'Woolworths White Sandwich Bread Loaf 650g', '650g', 2.5],
    ['w2', 'Woolworths Wholemeal Soft Sandwich Bread 650g', '650g', 2.6],
    ['w3', 'Helgas Mini White 400g', '400g', 2.0], // cheaper, but dearer per kg
    ['w4', 'Woolworths Wholemeal Rolls 6 pack', '6 pack', 3.0],
    ['w5', 'Woolworths White Rolls 6 pack', '6 pack', 2.8],
    ['w6', 'Mission Wraps Original 8 pack', '8 pack', 3.5, 'Wraps'],
    ['w7', 'Black & Gold Garlic Bread Twin Pack', '2 pack', 2.0],
  ]);
  add('coles', [
    ['c1', 'Coles Simply White Sandwich Loaf 650g', '650g', 2.4],
    ['c2', 'Coles Bakery Wholemeal Rolls 6 pack', '6 pack', 2.9],
    ['c3', 'Coles Hot Dog Rolls 6 pack', '6 pack', 2.7],
  ]);

  const b = bestPrices('bread');
  assert.equal(b.kinds.by, 'type');
  assert.deepEqual(b.groups.map((g) => g.label), ['Loaves', 'Rolls', 'Wraps & flatbread'], 'garlic bread left out; loaves first');
  const loaves = b.groups[0];
  assert.equal(loaves.products[0].name, 'Coles Simply White Sandwich Loaf 650g');
  assert.ok(loaves.products.findIndex((p) => p.name.startsWith('Helgas Mini')) !== 0, 'cheapest per kg, not the smallest');
  assert.equal(loaves.count, 4);
  assert.deepEqual(Object.keys(loaves.cheapestPerStore).sort(), ['coles', 'woolworths']);
  assert.equal(b.groups[1].search, 'rolls', 'each type can be opened on its own');
  assert.deepEqual(b.variants.map((v) => v.label), ['Wholemeal', 'White'], 'chips for what it\'s made from');

  const rolls = bestPrices('rolls');
  assert.equal(rolls.kinds.by, 'kind');
  assert.deepEqual(rolls.groups.map((g) => [g.label, g.count]), [['Wholemeal', 2], ['White', 2]]);

  const wm = bestPrices('wholemeal rolls');
  assert.ok(wm.ranked);
  assert.deepEqual(wm.groups[0].products.map((p) => p.name), ['Coles Bakery Wholemeal Rolls 6 pack', 'Woolworths Wholemeal Rolls 6 pack']);

  assert.deepEqual(bestPrices('hot dog rolls').groups[0].products.map((p) => p.name), ['Coles Hot Dog Rolls 6 pack'], 'other words have to be in the name');
  assert.equal(bestPrices('white bread').groups[0].products.every((p) => !/wholemeal/i.test(p.name)), true);
});
