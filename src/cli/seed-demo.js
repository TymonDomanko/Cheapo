#!/usr/bin/env node
// Fills the database with clearly-labelled DEMO products and 90 days of
// synthetic price history, so you can try the UI before running a real scrape.
//   npm run seed:demo            add demo data
//   npm run seed:demo -- --clear remove demo data (real scraped data is untouched)

import { getDb, upsertProducts } from '../db.js';

const db = getDb();
if (process.argv.includes('--clear')) {
  const n = db.prepare("DELETE FROM products WHERE store_product_id LIKE 'demo-%'").run().changes;
  console.log(`Removed ${n} demo products`);
  process.exit(0);
}

// [generic name, size, category, base price, {store: brand}] — store brand names
// are prefixed onto the generic name the way each store displays them.
const ITEMS = [
  ['Full Cream Milk', '3L', 'Milk', 4.95, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Farmdale' }],
  ['Lite Milk', '2L', 'Milk', 3.3, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Farmdale' }],
  ['Full Cream Milk', '2L', 'Milk', 4.6, { woolworths: 'Pauls', coles: 'Pauls' }],
  ['Free Range Eggs', '12 Pack', 'Eggs', 6.6, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Lodge Farms' }],
  ['Salted Butter', '250g', 'Butter', 4.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Westacre' }],
  ['Tasty Cheese Block', '500g', 'Cheese', 6.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Westacre' }],
  ['Greek Style Yoghurt', '1kg', 'Yoghurt', 5.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Brooklea' }],
  ['White Sandwich Bread', '700g', 'Bread', 2.7, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Bakers Life' }],
  ['Wholemeal Bread', '700g', 'Bread', 2.9, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Bakers Life' }],
  ['Spaghetti Pasta', '500g', 'Pasta', 1.3, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Remano' }],
  ['Penne Pasta', '500g', 'Pasta', 1.3, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Remano' }],
  ['Pasta Sauce Tomato & Basil', '500g', 'Pasta Sauce', 2.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Remano' }],
  ['Diced Tomatoes', '400g', 'Canned Food', 0.9, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Remano' }],
  ['Long Grain White Rice', '2kg', 'Rice', 4.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Pantry Lane' }],
  ['Basmati Rice', '1kg', 'Rice', 3.5, { woolworths: 'Sunrice', coles: 'Sunrice' }],
  ['Rolled Oats', '1kg', 'Breakfast', 2.6, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Harvest Morn' }],
  ['Corn Flakes', '725g', 'Breakfast', 6.5, { woolworths: "Kellogg's", coles: "Kellogg's" }],
  ['Weet-Bix', '1.2kg', 'Breakfast', 7.0, { woolworths: 'Sanitarium', coles: 'Sanitarium', aldi: 'Sanitarium' }],
  ['Vegemite', '380g', 'Spreads', 7.5, { woolworths: 'Bega', coles: 'Bega', aldi: 'Bega' }],
  ['Smooth Peanut Butter', '375g', 'Spreads', 3.2, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Bramwells' }],
  ['Strawberry Jam', '500g', 'Spreads', 3.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Bramwells' }],
  ['Tim Tam Original', '200g', 'Biscuits', 4.5, { woolworths: "Arnott's", coles: "Arnott's" }],
  ['Dairy Milk Chocolate Block', '180g', 'Chocolate', 6.0, { woolworths: 'Cadbury', coles: 'Cadbury', aldi: 'Cadbury' }],
  ['Original Potato Chips', '175g', 'Chips', 4.9, { woolworths: "Smith's", coles: "Smith's" }],
  ['Cola Soft Drink', '10 x 375mL', 'Soft Drinks', 13.5, { woolworths: 'Coca-Cola', coles: 'Coca-Cola', aldi: 'Coca-Cola' }],
  ['Sparkling Mineral Water', '1.25L', 'Water', 1.6, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Aqua Spring' }],
  ['Orange Juice No Added Sugar', '2L', 'Juice', 5.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Del Rivo' }],
  ['Instant Coffee', '200g', 'Coffee', 14.0, { woolworths: 'Nescafe Blend 43', coles: 'Nescafe Blend 43' }],
  ['Black Tea Bags', '100 Pack', 'Tea', 4.0, { woolworths: 'Lipton', coles: 'Lipton' }],
  ['Chicken Breast Fillets', '1kg', 'Poultry', 12.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Willow Farm' }],
  ['Beef Mince 3 Star', '500g', 'Beef', 6.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Highland Park' }],
  ['Pork Sausages', '500g', 'Sausages', 6.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Highland Park' }],
  ['Bananas', 'Per Kg', 'Fruit', 3.9, { woolworths: '', coles: '', aldi: '' }],
  ['Royal Gala Apples', '1kg', 'Fruit', 4.9, { woolworths: 'Woolworths', coles: 'Coles', aldi: '' }],
  ['Brushed Potatoes', '2kg', 'Vegetables', 4.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: '' }],
  ['Brown Onions', '1kg', 'Vegetables', 3.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: '' }],
  ['Baby Spinach', '120g', 'Salad', 3.3, { woolworths: 'Woolworths', coles: 'Coles', aldi: '' }],
  ['Carrots', '1kg', 'Vegetables', 2.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: '' }],
  ['Frozen Mixed Vegetables', '1kg', 'Frozen Vegetables', 3.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Market Fare' }],
  ['Frozen Peas', '1kg', 'Frozen Vegetables', 2.8, { woolworths: 'Birds Eye', coles: 'Birds Eye' }],
  ['Vanilla Ice Cream', '2L', 'Ice Cream', 5.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Sorbello' }],
  ['Toilet Paper 3 Ply', '24 Pack', 'Toilet Paper', 13.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Confidence' }],
  ['Paper Towel', '4 Pack', 'Paper Towel', 5.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Confidence' }],
  ['Laundry Liquid Front & Top Loader', '2L', 'Laundry', 9.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Trident' }],
  ['Dishwashing Liquid Lemon', '1L', 'Dishwashing', 3.5, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Tandil' }],
  ['Dishwasher Tablets', '60 Pack', 'Dishwashing', 22.0, { woolworths: 'Finish Quantum', coles: 'Finish Quantum' }],
  ['Extra Virgin Olive Oil', '1L', 'Oils', 12.0, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Remano' }],
  ['Plain Flour', '2kg', 'Baking', 2.8, { woolworths: 'Woolworths', coles: 'Coles', aldi: 'Baker\'s Corner' }],
  ['White Sugar', '2kg', 'Baking', 3.4, { woolworths: 'CSR', coles: 'CSR', aldi: 'Baker\'s Corner' }],
  ['Tuna in Springwater', '95g', 'Canned Food', 1.6, { woolworths: 'John West', coles: 'John West' }],
];

const STORE_FACTOR = { woolworths: 1.0, coles: 1.0, aldi: 0.86 };
const SEARCH = {
  woolworths: (q) => `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(q)}`,
  coles: (q) => `https://www.coles.com.au/search/products?q=${encodeURIComponent(q)}`,
  aldi: (q) => `https://www.aldi.com.au/results?q=${encodeURIComponent(q)}`,
};

// Deterministic PRNG so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const money = (n) => Math.max(0.5, Math.round(n * 20) / 20);

const DAYS = 90;
const products = [];
ITEMS.forEach(([name, size, category, base, brands], i) => {
  for (const [store, brand] of Object.entries(brands)) {
    const factor = STORE_FACTOR[store] * (0.95 + rand() * 0.1);
    products.push({
      store,
      id: `demo-${store}-${i}`,
      name: brand ? `${brand} ${name}` : name,
      brand: brand || null,
      size,
      category,
      price: money(base * factor),
      specialEvery: 14 + Math.floor(rand() * 30),
      specialOffset: Math.floor(rand() * 30),
      rises: rand() < 0.35,
    });
  }
});

let changes = 0;
for (let day = DAYS; day >= 0; day--) {
  const at = new Date(Date.now() - day * 86400000);
  at.setUTCHours(18, 15, 0, 0);
  for (const store of Object.keys(STORE_FACTOR)) {
    const batch = products.filter((p) => p.store === store).map((p) => {
      let price = p.price;
      if (p.rises && day < DAYS / 2) price = money(price * 1.08); // inflation step mid-way through
      // ALDI rarely runs specials; the others run half-price/discount cycles.
      const onSpecial = store !== 'aldi' && (DAYS - day + p.specialOffset) % p.specialEvery < 7;
      const now = onSpecial ? money(price * (rand() < 0.3 ? 0.5 : 0.8)) : price;
      return {
        store_product_id: p.id,
        name: p.name,
        brand: p.brand,
        size_text: p.size,
        category: p.category,
        product_url: SEARCH[store](p.name),
        price: now,
        was_price: onSpecial ? price : null,
        on_special: onSpecial,
      };
    });
    changes += upsertProducts(store, batch, at.toISOString()).priceChanges;
  }
}
console.log(`Seeded ${products.length} DEMO products with ${DAYS} days of synthetic history (${changes} price changes).`);
console.log('These are not real prices. Remove them any time with: npm run seed:demo -- --clear');
