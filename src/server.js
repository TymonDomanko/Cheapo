import express from 'express';
import path from 'node:path';
import cron from 'node-cron';
import { getDb, STORES } from './db.js';
import {
  compareSearch, productDetail, resolveList, orderPlan, addToList, updateListItem,
  removeListItem, clearList, setOverride, getProduct,
} from './compare.js';
import { scrapeAll, scrapeStatus } from './scrapers/index.js';
import { startOrder, orderStatus, isOnlineStore } from './order/index.js';

const PORT = Number(process.env.PORT || 3000);
const SCRAPE_CRON = process.env.SCRAPE_CRON ?? '15 4 * * *'; // daily at 04:15 local time

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public')));
app.use('/vendor/chart.js', express.static(path.resolve('node_modules/chart.js/dist')));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** ?stores=coles,aldi → ['coles','aldi'] (defaults to all) */
function storesParam(v) {
  const list = String(v || '').split(',').filter((s) => STORES.includes(s));
  return list.length ? list : STORES;
}

app.get('/api/stats', wrap(() => {
  const d = getDb();
  return {
    stores: STORES.map((s) => ({
      store: s,
      products: d.prepare('SELECT COUNT(*) n FROM products WHERE store = ? AND available = 1').get(s).n,
      lastRun: d.prepare('SELECT * FROM scrape_runs WHERE store = ? ORDER BY id DESC LIMIT 1').get(s) || null,
      status: scrapeStatus[s],
    })),
    priceChanges7d: d.prepare(
      "SELECT COUNT(*) n FROM price_history h WHERE recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') AND EXISTS (SELECT 1 FROM price_history e WHERE e.product_id = h.product_id AND e.id < h.id)",
    ).get().n,
    listCount: d.prepare('SELECT COUNT(*) n FROM shopping_list').get().n,
    demo: !!d.prepare("SELECT 1 FROM products WHERE store_product_id LIKE 'demo-%' LIMIT 1").get(),
    scrapeCron: SCRAPE_CRON || null,
  };
}));

app.get('/api/search', wrap((req) => {
  const { q = '', store, specials, mode } = req.query;
  return compareSearch(q, {
    store,
    specialsOnly: specials === '1',
    mode: mode === 'exact' ? 'exact' : 'similar',
    limit: Math.min(Number(req.query.limit) || 30, 60),
    offset: Number(req.query.offset) || 0,
  });
}));

app.get('/api/products/:id', wrap((req) => {
  const out = productDetail(Number(req.params.id));
  if (!out) throw Object.assign(new Error('Not found'), { status: 404 });
  return out;
}));

// Biggest recent price moves, for the "price changes" view.
app.get('/api/changes', wrap((req) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const dir = req.query.direction === 'up' ? 'AND h.price > old_price' : req.query.direction === 'down' ? 'AND h.price < old_price' : '';
  return getDb().prepare(`
    SELECT p.id, p.store, p.name, p.size_text, p.image_url, p.price, h.price AS new_price, h.recorded_at,
      (SELECT price FROM price_history e WHERE e.product_id = h.product_id AND e.id < h.id ORDER BY e.id DESC LIMIT 1) AS old_price
    FROM price_history h JOIN products p ON p.id = h.product_id
    WHERE h.recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND old_price IS NOT NULL AND p.available = 1 ${dir}
    ORDER BY ABS(h.price - old_price) / old_price DESC LIMIT 100`).all(`-${days} days`);
}));

app.get('/api/list', wrap((req) => resolveList(storesParam(req.query.stores))));

app.post('/api/list', wrap((req) => {
  const { productId, quantity = 1, matchMode = 'similar' } = req.body || {};
  if (!getProduct(Number(productId))) throw bad('Unknown product');
  if (!['similar', 'exact', 'this'].includes(matchMode)) throw bad('Bad matchMode');
  return { id: addToList(Number(productId), Math.max(1, quantity | 0), matchMode) };
}));

app.patch('/api/list/:id', wrap((req) => {
  const { quantity, matchMode } = req.body || {};
  if (matchMode && !['similar', 'exact', 'this'].includes(matchMode)) throw bad('Bad matchMode');
  updateListItem(Number(req.params.id), { quantity, matchMode });
  return { ok: true };
}));

// body: { productId: number } to pin a product, null to exclude the store, 'auto' to reset
app.put('/api/list/:id/stores/:store', wrap((req) => {
  if (!STORES.includes(req.params.store)) throw bad('Unknown store');
  const v = req.body?.productId;
  if (v !== null && v !== 'auto') {
    const p = getProduct(Number(v));
    if (!p || p.store !== req.params.store) throw bad('Product is not from that store');
  }
  setOverride(Number(req.params.id), req.params.store, v === null || v === 'auto' ? v : Number(v));
  return { ok: true };
}));

app.delete('/api/list/:id', wrap((req) => {
  removeListItem(Number(req.params.id));
  return { ok: true };
}));

app.delete('/api/list', wrap(() => {
  clearList();
  return { ok: true };
}));

app.get('/api/order/plan', wrap((req) => {
  const plan = orderPlan(storesParam(req.query.stores));
  plan.online = Object.fromEntries(plan.stores.map((s) => [s, isOnlineStore(s)]));
  return plan;
}));

app.post('/api/order', wrap((req) => {
  const plan = orderPlan(storesParam(req.body?.stores));
  if (!Object.values(plan.byStore).some((s) => s.items.length)) throw bad('Nothing to order');
  return { orderId: startOrder(plan), plan };
}));

app.get('/api/order/status', wrap(() => orderStatus));

app.post('/api/scrape', wrap((req) => {
  const stores = storesParam(req.body?.stores).filter((s) => !scrapeStatus[s].running);
  scrapeAll(stores).catch(() => {});
  return { started: stores };
}));

if (SCRAPE_CRON) {
  cron.schedule(SCRAPE_CRON, () => {
    console.log('Scheduled scrape starting');
    scrapeAll(STORES.filter((s) => !scrapeStatus[s].running)).catch(() => {});
  });
}

getDb();
app.listen(PORT, () => {
  console.log(`Supermarket tools running at http://localhost:${PORT}`);
  if (SCRAPE_CRON) console.log(`Prices refresh on schedule "${SCRAPE_CRON}" (set SCRAPE_CRON= to disable)`);
});
