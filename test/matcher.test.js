import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSizeFrom, altSize } from '../src/units.js';
import { nameTokens, matchScore, rankMatches, MATCH_THRESHOLD } from '../src/matcher.js';

let nextId = 1;
function product(store, name, brand, size, price = 1) {
  const s = parseSizeFrom(size, name);
  const alt = altSize(size, name, s);
  return { id: nextId++, store, name, brand, size_text: size, size_qty: s?.qty, size_unit: s?.unit,
    alt_size_qty: alt?.qty, alt_size_unit: alt?.unit, price, available: 1 };
}

test('strips brand, store words and sizes from names', () => {
  assert.deepEqual([...nameTokens('Coles Full Cream Milk 3L', 'Coles')].sort(), ['fullcream', 'milk']);
  assert.deepEqual([...nameTokens('Farmdale Full Cream Milk | 3L', 'Farmdale')].sort(), ['fullcream', 'milk']);
  assert.deepEqual([...nameTokens('Woolworths Whole Milk 3L', 'Woolworths')].sort(), ['fullcream', 'milk']);
  assert.deepEqual([...nameTokens('Woolworths Free Range Eggs 12 Pack', 'Woolworths')].sort(), ['egg', 'freerange']);
});

test('store-brand equivalents of the same size match', () => {
  const ww = product('woolworths', 'Woolworths Full Cream Milk 3L', 'Woolworths', '3L');
  const coles = product('coles', 'Coles Full Cream Milk', 'Coles', '3L');
  const aldi = product('aldi', 'Farmdale Full Cream Milk', 'Farmdale', '3 L');
  assert.ok(matchScore(ww, coles) >= MATCH_THRESHOLD);
  assert.ok(matchScore(ww, aldi) >= MATCH_THRESHOLD);
});

test('different sizes never match', () => {
  const a = product('coles', 'Coles Full Cream Milk', 'Coles', '3L');
  const b = product('woolworths', 'Woolworths Full Cream Milk 2L', 'Woolworths', '2L');
  assert.equal(matchScore(a, b), 0);
});

test('different products of the same size do not match', () => {
  const spaghetti = product('woolworths', 'Woolworths Spaghetti Pasta', 'Woolworths', '500g');
  const penne = product('woolworths', 'Woolworths Penne Pasta', 'Woolworths', '500g');
  const lite = product('coles', 'Coles Lite Milk', 'Coles', '2L');
  const full = product('coles', 'Coles Full Cream Milk', 'Coles', '2L');
  assert.ok(matchScore(spaghetti, penne) < MATCH_THRESHOLD);
  assert.ok(matchScore(lite, full) < MATCH_THRESHOLD);
});

test('variant words (lactose free, light, slices, flavours) block a match', () => {
  const milk = product('coles', 'Coles Full Cream Milk', 'Coles', '2L');
  const lf = product('coles', 'Coles Lactose Free Full Cream Milk', 'Coles', '2L');
  const block = product('coles', 'Mainland Tasty Cheese Block', 'Mainland', '500g');
  const bega = product('woolworths', 'Bega Cheese Tasty Block 500g', 'Bega', '500g');
  const slices = product('coles', 'Coles Cheese Slices Tasty', 'Coles', '500g');
  const orig = product('coles', "Smith's Crinkle Cut Chips Original", "Smith's", '170g');
  const sv = product('woolworths', "Smith's Crinkle Cut Chips Salt & Vinegar 170g", "Smith's", '170g');
  assert.equal(matchScore(milk, lf), 0);
  const organic = product('coles', 'Coles Organic Full Cream Milk', 'Coles Organic', '2L');
  assert.equal(matchScore(milk, organic), 0);
  assert.ok(matchScore(block, bega) >= MATCH_THRESHOLD);
  assert.equal(matchScore(block, slices), 0);
  assert.equal(matchScore(orig, sv), 0);
});

test('exact mode requires the same brand', () => {
  const a = product('woolworths', "Arnott's Tim Tam Original 200g", "Arnott's", '200g');
  const b = product('coles', "Arnott's Tim Tam Original", "Arnott's", '200g');
  const c = product('aldi', 'Belmont Biscuit Co Tim Tam Original', 'Belmont Biscuit Co', '200g');
  assert.ok(matchScore(a, b, 'exact') >= MATCH_THRESHOLD);
  assert.equal(matchScore(a, c, 'exact'), 0);
});

test('rankMatches orders by score then price', () => {
  const anchor = product('coles', 'Coles Full Cream Milk', 'Coles', '2L', 3.1);
  const cands = [
    product('aldi', 'Farmdale Full Cream Milk', 'Farmdale', '2L', 3.0),
    product('woolworths', 'Woolworths Full Cream Milk 2L', 'Woolworths', '2L', 3.2),
    product('woolworths', 'Woolworths Lite Milk 2L', 'Woolworths', '2L', 2.9),
  ];
  const ranked = rankMatches(anchor, cands);
  assert.deepEqual(ranked.map((r) => r.product.store), ['aldi', 'woolworths']);
});

test('packs measured differently still match (eggs by count vs weight)', () => {
  const coles = product('coles', 'Coles Free Range Eggs 12 Pack', 'Coles', '700g');
  const ww = product('woolworths', 'Woolworths 12 Free Range Eggs', 'Woolworths', '12 Pack');
  assert.ok(matchScore(coles, ww) >= MATCH_THRESHOLD);
});

test('long life milk is not fresh milk', () => {
  const fresh = product('coles', 'Coles Lactose Free Lite Milk', 'Coles', '1L');
  const uht = product('aldi', 'Farmdale Lactose Free Light Long Life Milk 1L', 'Farmdale', '1L');
  assert.equal(matchScore(fresh, uht), 0);
});
