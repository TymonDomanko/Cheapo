import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, parseSizeFrom, altSize, sameSize, formatSize } from '../src/units.js';

test('parses simple weights and volumes', () => {
  assert.deepEqual(parseSize('3L'), { qty: 3000, unit: 'ml', perWeight: false });
  assert.deepEqual(parseSize('675g'), { qty: 675, unit: 'g', perWeight: false });
  assert.deepEqual(parseSize('1.2kg'), { qty: 1200, unit: 'g', perWeight: false });
  assert.deepEqual(parseSize('500 mL'), { qty: 500, unit: 'ml', perWeight: false });
  assert.deepEqual(parseSize('1Kg'), { qty: 1000, unit: 'g', perWeight: false });
  assert.deepEqual(parseSize('approx. 130g'), { qty: 130, unit: 'g', perWeight: false });
});

test('parses multipacks', () => {
  assert.deepEqual(parseSize('10 x 375mL'), { qty: 3750, unit: 'ml', perWeight: false });
  assert.deepEqual(parseSize('6 X 375ML'), { qty: 2250, unit: 'ml', perWeight: false });
  assert.deepEqual(parseSize('375mL x 24'), { qty: 9000, unit: 'ml', perWeight: false });
});

test('parses counts and per-kg', () => {
  assert.deepEqual(parseSize('12 Pack'), { qty: 12, unit: 'ea', perWeight: false });
  assert.deepEqual(parseSize('1 Each'), { qty: 1, unit: 'ea', perWeight: false });
  assert.deepEqual(parseSize('each'), { qty: 1, unit: 'ea', perWeight: false });
  assert.deepEqual(parseSize('Per Kg'), { qty: 1000, unit: 'g', perWeight: true });
  assert.deepEqual(parseSize('1 Bunch'), { qty: 1, unit: 'ea', perWeight: false });
});

test('falls back to the product name', () => {
  assert.deepEqual(parseSizeFrom(null, 'Farmdale Full Cream Milk 2L'), { qty: 2000, unit: 'ml', perWeight: false });
  assert.equal(parseSize('mystery'), null);
});

test('sameSize tolerates rounding but not different packs', () => {
  assert.ok(sameSize({ qty: 1000, unit: 'ml' }, { qty: 1000, unit: 'ml' }));
  assert.ok(sameSize({ qty: 1000, unit: 'ml' }, { qty: 995, unit: 'ml' }));
  assert.ok(!sameSize({ qty: 1000, unit: 'ml' }, { qty: 2000, unit: 'ml' }));
  assert.ok(!sameSize({ qty: 1000, unit: 'ml' }, { qty: 1000, unit: 'g' }));
});

test('formats sizes', () => {
  assert.equal(formatSize(2000, 'ml'), '2L');
  assert.equal(formatSize(375, 'ml'), '375mL');
  assert.equal(formatSize(1200, 'g'), '1.2kg');
});

test('finds a second measure in a different unit', () => {
  const primary = parseSize('700g');
  assert.deepEqual(altSize('700g', 'Coles Free Range Eggs 12 Pack', primary), { qty: 12, unit: 'ea', perWeight: false });
  assert.equal(altSize('3L', 'Coles Full Cream Milk', parseSize('3L')), null);
});
