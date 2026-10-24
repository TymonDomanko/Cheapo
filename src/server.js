import cron from 'node-cron';
import { getDb } from './db.js';
import { createApp } from './app.js';
import { scrapeAll, scrapeStatus, serverStores } from './scrapers/index.js';
import { purgeExpiredSessions } from './auth.js';
import { snapshot } from './backup.js';
import { backfillColesBarcodes } from './barcodes.js';
import * as colesLive from './coles-live.js';
import { sendPriceAlerts, sendWeeklyDigests } from './alerts.js';
import { checkCollector, resumeSummary } from './admin-alerts.js';
import { warmUp } from './match-index.js';
import { unusualDeals } from './deals.js';
import { ensureDefaultTracked, ensureDirectory, checkOnlineStores, checkIsDue } from './iga.js';

const PORT = Number(process.env.PORT || 3000);
const SCRAPE_CRON = process.env.SCRAPE_CRON ?? '15 4 * * *'; // daily at 04:15 server time

getDb();
ensureDefaultTracked();
if (checkIsDue() && !process.env.DISABLE_BACKGROUND_SCRAPES) {
  // Haven't checked which IGAs have online prices today (first start, or the server was off).
  checkOnlineStores().catch(() => {});
} else {
  ensureDirectory().catch((e) => console.warn(`IGA store list not loaded yet: ${e.message}`));
}
const app = createApp();
// Build the product-matching index and the home page's deals in the background, so the first visitors don't wait.
setTimeout(() => {
  try {
    warmUp();
    unusualDeals(); // and the home page's deals
  } catch (e) {
    console.warn(`Matching index not built yet: ${e.message}`);
  }
}, 1000).unref();

if (SCRAPE_CRON) {
  cron.schedule(SCRAPE_CRON, async () => {
    console.log('Scheduled refresh starting');
    // First update which IGA stores have prices online, so today's fetch covers the right ones.
    await checkOnlineStores().catch(() => {});
    // Coles refreshes steadily through the day instead (src/coles-live.js), unless that's turned off.
    const tonight = serverStores().filter((s) => !scrapeStatus[s].running && !(s === 'coles' && colesLive.enabled()));
    await scrapeAll(tonight).catch(() => {});
    // Then fill in more Coles barcodes for matching (a daily budget of product pages).
    if (serverStores().includes('coles') && !colesLive.enabled()) await backfillColesBarcodes().catch((e) => console.error(`barcodes: ${e.message}`));
    await sendPriceAlerts().catch((e) => console.error(`price alerts: ${e.message}`));
  }, { timezone: process.env.TZ || undefined });
}
cron.schedule('0 3 * * *', purgeExpiredSessions);
// Tell admins if the home collector has stopped sending prices (it collects around 4am).
cron.schedule(process.env.COLLECTOR_CHECK_CRON || '0 11 * * *', () => checkCollector({ serverStores }), { timezone: process.env.TZ || undefined });
// Weekly "on special this week" email: Wednesday morning, when the big chains' specials change.
cron.schedule(process.env.DIGEST_CRON || '0 8 * * 3', () => {
  sendWeeklyDigests().catch((e) => console.error(`weekly digest: ${e.message}`));
}, { timezone: process.env.TZ || undefined });
// Daily database snapshot (kept BACKUP_KEEP_DAYS, default 7).
cron.schedule(process.env.BACKUP_CRON || '30 2 * * *', () => {
  try {
    const b = snapshot();
    console.log(`Backup written: ${b.name} (${Math.round(b.bytes / 1e6)} MB)`);
  } catch (e) {
    console.error(`Backup failed: ${e.message}`);
  }
}, { timezone: process.env.TZ || undefined });

app.listen(PORT, () => {
  console.log(`Cheapo (version ${process.env.APP_VERSION || 'dev'}) running at http://localhost:${PORT}`);
  if (SCRAPE_CRON) console.log(`Prices refresh on schedule "${SCRAPE_CRON}" (set SCRAPE_CRON= to disable)`);
  resumeSummary(); // a refresh's admin summary that was waiting when the server stopped
  if (process.env.DISABLE_BACKGROUND_SCRAPES !== 'true') colesLive.start();
});
