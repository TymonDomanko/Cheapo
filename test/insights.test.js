import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceInsight } from '../src/insights.js';

const now = Date.parse('2026-10-23T00:00:00Z');
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

// $6 normally, half price ($3) for a week every 6 weeks, for 6 months.
function cycling(lastSpecialDaysAgo) {
  const rows = [{ price: 6, recorded_at: daysAgo(200) }];
  for (let d = lastSpecialDaysAgo + 42 * 4; d >= lastSpecialDaysAgo; d -= 42) {
    rows.push({ price: 3, on_special: 1, was_price: 6, recorded_at: daysAgo(d) });
    if (d - 7 > 0) rows.push({ price: 6, recorded_at: daysAgo(d - 7) });
  }
  return rows;
}

test('too little history says so', () => {
  assert.equal(priceInsight([{ price: 5, recorded_at: daysAgo(10) }], 5, now).verdict, 'unknown');
});

test('spots a half-price cycle and when the next special is due', () => {
  const i = priceInsight(cycling(14), 6, now);
  assert.equal(i.verdict, 'wait');
  assert.equal(i.usual, 6);
  assert.equal(i.cycleDays, 42);
  assert.equal(i.nextDueDays, 28);
  assert.match(i.headline, /every 6 weeks/);
  assert.match(i.detail, /\$3\.00 — next one likely in ~4 weeks/);
});

test('on special at its lowest is a great time to buy', () => {
  const rows = cycling(2);
  const i = priceInsight(rows, 3, now);
  assert.equal(i.verdict, 'great');
  assert.match(i.headline, /Lowest price in 6 months/);
  assert.match(i.detail, /50% below its usual \$6\.00/);
});

test('steady prices are just the usual price; rises are flagged', () => {
  const steady = [{ price: 4, recorded_at: daysAgo(150) }];
  assert.equal(priceInsight(steady, 4, now).verdict, 'normal');
  const rose = [{ price: 4, recorded_at: daysAgo(150) }, { price: 4.6, recorded_at: daysAgo(3) }];
  const i = priceInsight(rose, 4.6, now);
  assert.equal(i.verdict, 'high');
  assert.match(i.detail, /usually \$4\.00/);
});
