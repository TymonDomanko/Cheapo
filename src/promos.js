// Multi-buy and member pricing, and what a quantity actually costs.

/** "5 for $9.00", "Pick any 2 for $5", "2 for $7" → { qty: 5, total: 9 } */
export function parseMultiBuy(text) {
  const m = String(text || '').match(/(\d+)\s*for\s*\$\s*(\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const qty = Number(m[1]);
  const total = Number(m[2]);
  return qty >= 2 && total > 0 ? { qty, total } : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Shelf price, or the member price if the shopper belongs to that store's loyalty scheme. */
export function unitPriceFor(p, memberships = []) {
  if (p?.price == null) return null;
  if (p.member_price != null && memberships.includes(p.store) && p.member_price < p.price) return p.member_price;
  return p.price;
}

/** Cost of `qty` of a product, using a multi-buy deal when it's cheaper. */
export function lineCost(p, qty, memberships = []) {
  const unit = unitPriceFor(p, memberships);
  if (unit == null) return null;
  let cost = unit * qty;
  if (p.multi_qty >= 2 && p.multi_price > 0 && qty >= p.multi_qty) {
    const deals = Math.floor(qty / p.multi_qty);
    cost = Math.min(cost, deals * p.multi_price + (qty - deals * p.multi_qty) * unit);
  }
  return round2(cost);
}
