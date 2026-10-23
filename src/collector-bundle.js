// Builds the downloadable home collector: its code, a package.json, start
// scripts for Windows and Mac/Linux, a README and a filled-in .env — as a zip
// for people, or as JSON for a collector updating itself.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { COLLECTOR_CODE, COLLECTOR_DEPS, collectorVersion } from './collector-files.js';
import { getDb, nowIso } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The collector version this server hands out (changes whenever its code changes). */
export function latestCollectorVersion() {
  return collectorVersion(readRepo);
}

const PACKAGE_JSON = JSON.stringify({
  name: 'grocery-home-collector',
  private: true,
  type: 'module',
  engines: { node: '>=20' },
  scripts: { start: 'node src/cli/collect.js' },
  optionalDependencies: COLLECTOR_DEPS,
}, null, 2) + '\n';

// Exit code 75 = "I've updated myself, start me again".
const START_SH = `#!/bin/sh
# Starts the home collector and keeps it running (it restarts itself after updating).
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is needed: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund || exit 1
while true; do
  node src/cli/collect.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
done
`;

const START_BAT = `@echo off\r
rem Starts the home collector and keeps it running (it restarts itself after updating).\r
cd /d "%~dp0"\r
where node >nul 2>nul || (echo Node.js 20 or newer is needed: https://nodejs.org & pause & exit /b 1)\r
if not exist node_modules call npm install --omit=dev --no-audit --no-fund\r
:loop\r
node src\\cli\\collect.js\r
if %errorlevel%==75 goto loop\r
pause\r
`;

function readme(serverUrl) {
  return `Home collector for ${serverUrl}
${'='.repeat(20 + serverUrl.length)}

Some supermarkets (Woolworths, ALDI) block cloud servers. This small program
runs on a computer at home, fetches their prices from your home connection and
sends them to your site every day.

1. Install Node.js 20 or newer: https://nodejs.org
2. Start it:
     Windows:      double-click start.bat
     Mac / Linux:  open a terminal here and run  sh start.sh
3. Leave it running (or set it to start when the computer starts). It collects
   once straight away and then every day at the time in .env (COLLECT_CRON).

It keeps itself up to date: before each collection it asks your site whether
there's a newer version, and if so downloads it and restarts. To turn that
off, set AUTO_UPDATE=false in .env.

Settings are in .env — it already contains your site's address and the
collector token, so keep that file private. The site's Admin page shows when
the collector last connected and whether it's up to date.
`;
}

/** Files in the bundle (no .env), as { path: text }. */
export function bundleFiles(serverUrl) {
  const files = Object.fromEntries(COLLECTOR_CODE.map((p) => [p, readRepo(p)]));
  files['package.json'] = PACKAGE_JSON;
  files['start.sh'] = START_SH;
  files['start.bat'] = START_BAT;
  files['README.txt'] = readme(serverUrl);
  files['.collector-bundle'] = 'This folder is a downloaded home collector; it may update itself.\n';
  return files;
}

export function envFile({ serverUrl, token, stores, cron }) {
  return [
    '# Home collector settings. Keep this file private: the token lets it send prices to your site.',
    `COLLECTOR_SERVER=${serverUrl}`,
    `COLLECTOR_TOKEN=${token}`,
    `COLLECT_STORES=${stores.join(',')}`,
    '# When to collect each day (cron: minute hour * * *), in TZ.',
    `COLLECT_CRON=${cron}`,
    'TZ=Australia/Sydney',
    '# Collect once as soon as it starts (handy to check it works).',
    'COLLECT_ON_START=true',
    '# Update itself when your site has a newer version.',
    'AUTO_UPDATE=true',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- a small zip writer

/** Zip { path: text } into a Buffer (deflate). Scripts get the executable bit. */
export function zip(files, folder) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = (() => {
    const d = new Date();
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  })();
  for (const [p, text] of Object.entries(files)) {
    const name = Buffer.from(`${folder}/${p}`);
    const data = Buffer.from(text);
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime.time, 10);
    local.writeUInt16LE(dosTime.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so permissions are kept
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime.time, 12);
    central.writeUInt16LE(dosTime.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = p.endsWith('.sh') ? 0o100755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- who's connecting

/** Remember the last collector that talked to us, for the admin page. */
export function recordCollector({ version, mode }) {
  if (!version) return;
  const status = JSON.stringify({ version: String(version).slice(0, 40), mode: String(mode || 'unknown').slice(0, 20), at: nowIso() });
  getDb().prepare("INSERT INTO app_settings (key, value) VALUES ('collector:last', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(status);
}

export function collectorStatus() {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'collector:last'").get();
  const latest = latestCollectorVersion();
  if (!row) return { latest, last: null };
  const last = JSON.parse(row.value);
  return { latest, last: { ...last, upToDate: last.version === latest } };
}
