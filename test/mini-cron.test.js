import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun } from '../src/mini-cron.js';

test('parses cron fields', () => {
  const [min, hour, , , dow] = parseCron('*/15 4,16 * * 1-5');
  assert.deepEqual([...min], [0, 15, 30, 45]);
  assert.deepEqual([...hour], [4, 16]);
  assert.deepEqual([...dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * 7')[4]], [0]);
  assert.throws(() => nextRun('0 0 30 2 *', new Date('2026-01-01')), /never fires/, 'February 30th');
  assert.throws(() => parseCron('0 4 * *'));
  assert.throws(() => parseCron('61 4 * * *'));
});

test('next run respects the time zone', () => {
  const from = new Date('2026-10-23T00:00:00Z'); // 11am in Sydney (AEDT, +11)
  assert.equal(nextRun('0 4 * * *', from, 'Australia/Sydney').toISOString(), '2026-10-23T17:00:00.000Z');
  assert.equal(nextRun('0 4 * * *', from, 'UTC').toISOString(), '2026-10-23T04:00:00.000Z');
  // Sunday as 0 or 7.
  assert.equal(nextRun('30 8 * * 0', from, 'UTC').toISOString(), '2026-10-25T08:30:00.000Z');
  assert.equal(nextRun('30 8 * * 7', from, 'UTC').toISOString(), '2026-10-25T08:30:00.000Z');
});
