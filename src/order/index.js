// "Order the cheapest" — fills the real Woolworths and Coles trolleys with the
// items the plan assigned to each store, using a visible Chromium window with a
// persistent profile (so you stay logged in between runs).
//
// It deliberately stops at the trolley: you review it, choose a delivery or
// pick-up slot and pay yourself. ALDI Australia has no online grocery
// ordering, so ALDI items become an in-store shopping list instead.

import path from 'node:path';
import { getDb, nowIso } from '../db.js';
import * as woolworths from './woolworths.js';
import * as coles from './coles.js';

const ONLINE = { woolworths, coles };
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || path.resolve(process.env.DATA_DIR || 'data', 'browser-profile');

export const orderStatus = { running: false, orderId: null, log: [], results: {} };

// The browser stays open after an order so you can check out; reuse it next time.
let browserContext = null;

async function getBrowser() {
  if (browserContext) return browserContext;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Ordering needs Playwright: run `npm install playwright && npx playwright install chromium`');
  }
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    locale: 'en-AU',
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  browserContext.on('close', () => {
    browserContext = null;
  });
  return browserContext;
}

export function isOnlineStore(store) {
  return store in ONLINE;
}

/**
 * @param plan  result of orderPlan()
 * @returns order id; progress is reported via orderStatus
 */
export function startOrder(plan) {
  if (orderStatus.running) throw new Error('An order is already in progress');
  const d = getDb();
  const orderId = d.prepare("INSERT INTO orders (created_at, status, plan_json) VALUES (?, 'running', ?)")
    .run(nowIso(), JSON.stringify(plan)).lastInsertRowid;
  Object.assign(orderStatus, { running: true, orderId, log: [], results: {} });
  run(plan, orderId).catch((e) => log(`Order failed: ${e.message}`));
  return orderId;
}

function log(msg) {
  orderStatus.log.push({ at: nowIso(), msg });
  console.log(`[order] ${msg}`);
}

async function run(plan, orderId) {
  try {
    const stores = Object.entries(plan.byStore).filter(([, s]) => s.items.length);
    const online = stores.filter(([s]) => isOnlineStore(s));
    for (const [s, data] of stores.filter(([s]) => !isOnlineStore(s))) {
      orderStatus.results[s] = { mode: 'in-store', items: data.items.length, total: data.total };
      log(`${s}: ${data.items.length} items on your in-store list ($${data.total.toFixed(2)})`);
    }
    if (online.length) {
      const context = await getBrowser();
      for (const [s, data] of online) {
        log(`${s}: adding ${data.items.length} items to your trolley…`);
        const page = await context.newPage();
        const res = await ONLINE[s].fillTrolley(page, data.items, (m) => log(`${s}: ${m}`));
        orderStatus.results[s] = { mode: 'online', ...res, total: data.total };
        log(`${s}: ${res.added.length} added, ${res.failed.length} need attention — review the trolley tab and check out`);
      }
    }
    const status = Object.values(orderStatus.results).some((r) => r.failed?.length) ? 'needs_attention' : 'ready_for_checkout';
    getDb().prepare('UPDATE orders SET status = ?, log_json = ? WHERE id = ?')
      .run(status, JSON.stringify({ log: orderStatus.log, results: orderStatus.results }), orderId);
    log('Done. Browser left open so you can review and pay. Nothing has been purchased yet.');
  } catch (e) {
    getDb().prepare("UPDATE orders SET status = 'error', log_json = ? WHERE id = ?")
      .run(JSON.stringify({ log: orderStatus.log, error: e.message }), orderId);
    throw e;
  } finally {
    orderStatus.running = false;
  }
}
