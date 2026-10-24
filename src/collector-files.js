// What the home collector is made of. The server packages exactly these files
// for download, and both sides fingerprint them the same way, so the server
// can tell whether a collector is up to date and send it the new version.

import crypto from 'node:crypto';

export const COLLECTOR_CODE = [
  'src/collector-files.js',
  'src/cli/collect.js',
  'src/mini-cron.js',
  'src/promos.js',
  'src/scrapers/registry.js',
  'src/scrapers/http.js',
  'src/scrapers/woolworths.js',
  'src/scrapers/coles.js',
  'src/scrapers/coles-pages.js',
  'src/scrapers/aldi.js',
  'src/scrapers/iga.js',
  'src/scrapers/harrisfarm.js',
];

// The collector needs no npm packages (so it can run as a single executable).
// undici is only used to go through an HTTPS_PROXY, if one is set.
export const COLLECTOR_DEPS = { undici: '^6.19.8' };

/** A short fingerprint of the collector's code. @param read (path) => file text */
export function collectorVersion(read) {
  const h = crypto.createHash('sha256');
  for (const p of [...COLLECTOR_CODE].sort()) {
    h.update(p).update('\0').update(String(read(p)).replace(/\r\n/g, '\n')).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}
