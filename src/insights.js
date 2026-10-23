// "Is this a good price?" from a product's price history.
//
// Supermarkets run most specials in cycles (Woolworths and Coles often take a
// product to half price every 4–8 weeks), so the history tells us its usual
// price, how low it goes, and roughly when it's next due on special.
// price_history only records changes, so each row's price holds until the next.

import { getDb } from './db.js';

const DAY = 86400000;
const MIN_HISTORY_DAYS = 28; // too little history to say anything before this
const SPECIAL = 0.85; // at least 15% below the usual price counts as a special

const money = (n) => `$${n.toFixed(2)}`;
const weeks = (days) => Math.max(1, Math.round(days / 7));

/**
 * @param {{price:number, was_price?:number, on_special?:number, recorded_at:string}[]} rows oldest first
 * @param {number} current today's price
 */
export function priceInsight(rows, current, now = Date.now()) {
  if (!rows.length || current == null) return { verdict: 'unknown' };
  const start = Date.parse(rows[0].recorded_at);
  const historyDays = (now - start) / DAY;
  if (historyDays < MIN_HISTORY_DAYS) return { verdict: 'unknown', headline: 'Not enough price history yet', historyDays: Math.floor(historyDays) };

  // Each price and how long it held.
  const segs = rows.map((r, i) => ({
    price: r.price,
    special: !!r.on_special,
    from: Date.parse(r.recorded_at),
    to: i + 1 < rows.length ? Date.parse(rows[i + 1].recorded_at) : now,
  }));

  // The usual price: the regular (not on special) price it spent longest at in the last 6 months.
  const recent = segs.filter((s) => s.to > now - 182 * DAY);
  const byTime = (list) => {
    const t = new Map();
    for (const s of list) t.set(s.price, (t.get(s.price) || 0) + (Math.min(s.to, now) - Math.max(s.from, now - 182 * DAY)));
    return [...t.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const usual = byTime(recent.filter((s) => !s.special)) ?? byTime(recent);
  const low = Math.min(...recent.map((s) => s.price), current);

  // Specials over the last year: runs of prices well below usual.
  const starts = [];
  let inSpecial = false;
  for (const s of segs.filter((x) => x.to > now - 365 * DAY)) {
    const isSpecial = s.price <= usual * SPECIAL;
    if (isSpecial && !inSpecial) starts.push({ at: s.from, price: s.price });
    inSpecial = isSpecial;
  }
  const out = { usual, low, historyDays: Math.floor(historyDays), specialsPerYear: starts.length };
  let cycleDays = null;
  if (starts.length >= 2) {
    const gaps = starts.slice(1).map((s, i) => (s.at - starts[i].at) / DAY);
    cycleDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    out.cycleDays = Math.round(cycleDays);
    out.specialPrice = Math.min(...starts.map((s) => s.price));
  }
  const lastSpecial = starts.at(-1);

  if (current <= usual * SPECIAL) {
    const pct = Math.round((1 - current / usual) * 100);
    if (current <= low + 0.005) {
      return { ...out, verdict: 'great', headline: `Lowest price in ${historyDays >= 170 ? '6 months' : `${weeks(historyDays)} weeks`}`, detail: `${pct}% below its usual ${money(usual)}.` };
    }
    return { ...out, verdict: 'good', headline: `On special — ${pct}% off`, detail: `Usually ${money(usual)}. It’s been as low as ${money(low)}.` };
  }
  if (cycleDays && lastSpecial && cycleDays < 120) {
    const since = (now - lastSpecial.at) / DAY;
    const dueIn = cycleDays - since;
    out.nextDueDays = Math.max(0, Math.round(dueIn));
    return {
      ...out,
      verdict: 'wait',
      headline: `Goes on special about every ${weeks(cycleDays)} weeks`,
      detail: `Usually drops to about ${money(out.specialPrice)}${dueIn > 7 ? ` — next one likely in ~${weeks(dueIn)} week${weeks(dueIn) === 1 ? '' : 's'}` : ' — due any time now'}. Stock up then if you can wait.`,
    };
  }
  if (current > usual * 1.05) {
    return { ...out, verdict: 'high', headline: 'Dearer than usual', detail: `It’s usually ${money(usual)}.` };
  }
  return { ...out, verdict: 'normal', headline: 'Its usual price', detail: low < usual * SPECIAL ? `It’s been as low as ${money(low)}.` : 'It rarely goes on special.' };
}

/** Insight for a product from the database (IGA prices are per store). */
export function productInsight(product, igaStore = null) {
  if (!product || product.price == null) return { verdict: 'unknown' };
  const rows = getDb().prepare(`SELECT price, was_price, on_special, recorded_at FROM price_history
    WHERE product_id = ? AND (location IS NULL OR location = ?) ORDER BY recorded_at, id`)
    .all(product.id, product.location_priced ? igaStore : null);
  return priceInsight(rows, product.price);
}
