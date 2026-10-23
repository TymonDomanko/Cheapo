// Coles listings don't include barcodes, but each product page does (as
// "gtin"). This fills them in gradually — a daily budget of page fetches,
// products on people's lists first — so Coles products can be matched to
// Woolworths ones by barcode. Barcodes don't change, so each product is
// fetched once (re-checked after 90 days if none was found).

import { getDb, nowIso } from './db.js';
import { createClient } from './scrapers/http.js';

const ORIGIN = 'https://www.coles.com.au';
const RECHECK_DAYS = 90;
export const barcodeStatus = { running: false, done: 0, total: 0, found: 0 };

export function colesBarcodeProgress() {
  return getDb().prepare(`SELECT COUNT(*) total, SUM(barcode IS NOT NULL) with_barcode, SUM(barcode_checked_at IS NOT NULL) checked
    FROM products WHERE store = 'coles' AND available = 1`).get();
}

export async function backfillColesBarcodes({ budget = Number(process.env.COLES_BARCODE_BUDGET) || 1500, log = console.log } = {}) {
  if (barcodeStatus.running) return { skipped: true };
  const d = getDb();
  const due = new Date(Date.now() - RECHECK_DAYS * 86400000).toISOString();
  const todo = d.prepare(`
    SELECT p.id, p.product_url FROM products p
    WHERE p.store = 'coles' AND p.available = 1 AND p.barcode IS NULL
      AND (p.barcode_checked_at IS NULL OR p.barcode_checked_at < ?)
    ORDER BY EXISTS (SELECT 1 FROM list_items i WHERE i.product_id = p.id) DESC,
             EXISTS (SELECT 1 FROM watches w WHERE w.product_id = p.id) DESC,
             p.last_seen DESC
    LIMIT ?`).all(due, budget);
  if (!todo.length) return { done: 0, found: 0 };

  Object.assign(barcodeStatus, { running: true, done: 0, total: todo.length, found: 0 });
  const client = createClient({ origin: ORIGIN, delayMs: Number(process.env.COLES_DELAY_MS ?? 1000) });
  const save = d.prepare('UPDATE products SET barcode = COALESCE(?, barcode), product_url = COALESCE(?, product_url), barcode_checked_at = ? WHERE id = ?');
  let failures = 0;
  try {
    await client.init();
    const html = await client.getText(`${ORIGIN}/`);
    const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
    if (!buildId) throw new Error('Coles: could not find Next.js buildId');
    for (const p of todo) {
      const path = new URL(p.product_url).pathname; // /product/<slug>-<id>
      try {
        let json = await client.getText(`${ORIGIN}/_next/data/${buildId}/en${path}.json`);
        let canonical = null;
        // Our slug may differ from Coles' own; follow their redirect once (and keep the right link).
        const redirect = json.match(/"__N_REDIRECT":"(\/product\/[^"]+)"/)?.[1];
        if (redirect) {
          canonical = ORIGIN + redirect;
          json = await client.getText(`${ORIGIN}/_next/data/${buildId}/en${redirect}.json`);
        }
        const gtin = json.match(/"gtin":"(\d{8,14})"/)?.[1] || null;
        save.run(gtin, canonical, nowIso(), p.id);
        if (gtin) barcodeStatus.found++;
      } catch (e) {
        failures++;
        if (failures > 20 && failures > barcodeStatus.done / 2) throw new Error(`stopping: ${e.message}`);
      }
      barcodeStatus.done++;
    }
    log(`coles barcodes: ${barcodeStatus.found} found in ${barcodeStatus.done} product pages`);
    return { done: barcodeStatus.done, found: barcodeStatus.found };
  } finally {
    barcodeStatus.running = false;
    await client.close();
  }
}
