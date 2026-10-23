import cron from 'node-cron';
import { getDb } from './db.js';
import { createApp } from './app.js';
import { scrapeAll, scrapeStatus, serverStores } from './scrapers/index.js';
import { purgeExpiredSessions } from './auth.js';
import { snapshot } from './backup.js';
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

if (SCRAPE_CRON) {
  cron.schedule(SCRAPE_CRON, async () => {
    console.log('Scheduled refresh starting');
    // First update which IGA stores have prices online, so today's fetch covers the right ones.
    await checkOnlineStores().catch(() => {});
    scrapeAll(serverStores().filter((s) => !scrapeStatus[s].running)).catch(() => {});
  }, { timezone: process.env.TZ || undefined });
}
cron.schedule('0 3 * * *', purgeExpiredSessions);
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
  console.log(`Supermarket tools running at http://localhost:${PORT}`);
  if (SCRAPE_CRON) console.log(`Prices refresh on schedule "${SCRAPE_CRON}" (set SCRAPE_CRON= to disable)`);
});
