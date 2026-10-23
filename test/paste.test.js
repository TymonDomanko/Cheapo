import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines } from '../src/paste.js';

test('reads quantities out of a pasted list', () => {
  const got = parseLines('milk, bread\n2 x chips\n- bananas x3\n• eggs (2)\n2L milk\n3 avocados\n1. birthday card\n\n');
  assert.deepEqual(got.map((l) => [l.query, l.quantity]), [
    ['milk', 1], ['bread', 1], ['chips', 2], ['bananas', 3], ['eggs', 2], ['2L milk', 1], ['avocados', 3], ['birthday card', 1],
  ]);
});
