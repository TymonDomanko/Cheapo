import cron from 'node-cron';
import { getDb } from './db.js';
import { STORES } from './stores.js';
import { createApp } from './app.js';
import { scrapeAll, scrapeStatus } from './scrapers/index.js';
import { purgeExpiredSessions } from './auth.js';

const PORT = Number(process.env.PORT || 3000);
const SCRAPE_CRON = process.env.SCRAPE_CRON ?? '15 4 * * *'; // daily at 04:15 server time

getDb();
const app = createApp();

if (SCRAPE_CRON) {
  cron.schedule(SCRAPE_CRON, () => {
    console.log('Scheduled scrape starting');
    scrapeAll(STORES.filter((s) => !scrapeStatus[s].running)).catch(() => {});
  }, { timezone: process.env.TZ || undefined });
}
cron.schedule('0 3 * * *', purgeExpiredSessions);

app.listen(PORT, () => {
  console.log(`Supermarket tools running at http://localhost:${PORT}`);
  if (SCRAPE_CRON) console.log(`Prices refresh on schedule "${SCRAPE_CRON}" (set SCRAPE_CRON= to disable)`);
});
