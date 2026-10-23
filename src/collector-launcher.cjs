// The home collector as a single program (Windows .exe or Linux binary).
//
// The server builds it from an official Node.js binary with this file inside
// (Node's "single executable application" feature), and appends the site's
// address and collector token to the end of each download — so there's nothing
// to install or set up: run it and it starts collecting.
//
// The collector's code isn't baked in. On each start this fetches the latest
// code from the site (checking it arrived whole), keeps a copy in the user's
// app-data folder for when the site can't be reached, and runs it. So the
// program never needs downloading again to stay up to date.
//
// Options: --autostart / --no-autostart  start (or stop starting) with the computer
//          plus anything src/cli/collect.js accepts (store names, --cron=…).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const RESTART = 75;
const CHILD = process.env.GROCERY_COLLECTOR_CHILD === '1';
const args = process.argv.slice(2);
const DATA = dataDir();
const isWindows = process.platform === 'win32';

function dataDir() {
  if (process.env.GROCERY_COLLECTOR_HOME) return process.env.GROCERY_COLLECTOR_HOME;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GroceryCollector');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'GroceryCollector');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'grocery-collector');
}

// ---------------------------------------------------------------- settings baked into the download

const MARK = '\n#GROCERY-COLLECTOR-CONFIG#';
const END = '#END#\n';

/** The settings the site appended to this program when it was downloaded. */
function embeddedConfig() {
  try {
    const fd = fs.openSync(process.execPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const text = buf.toString('latin1');
    const start = text.lastIndexOf(MARK);
    const end = text.lastIndexOf(END);
    if (start < 0 || end < start) return {};
    return JSON.parse(Buffer.from(text.slice(start + MARK.length, end), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- supervisor (the process you started)

function pauseThenExit(code) {
  // A double-clicked Windows program closes its window on exit; keep errors readable.
  if (!isWindows || !process.stdin.isTTY) process.exit(code);
  process.stdout.write('\nPress Enter to close this window.');
  process.stdin.once('data', () => process.exit(code));
}

function supervise() {
  if (args.includes('--autostart') || args.includes('--no-autostart')) {
    const on = args.includes('--autostart');
    try {
      console.log(setAutostart(on));
      return pauseThenExit(0);
    } catch (e) {
      console.error(`Couldn't change start-up setting: ${e.message}`);
      return pauseThenExit(1);
    }
  }
  const env = { ...process.env, GROCERY_COLLECTOR_CHILD: '1' };
  for (const [key, value] of Object.entries(embeddedConfig())) {
    if (env[key] === undefined && /^[A-Z0-9_]+$/.test(key)) env[key] = String(value);
  }
  // Go through a proxy if the computer is set up with one (the program has no undici package).
  if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY === undefined) env.NODE_USE_ENV_PROXY = '1';
  // Run the collector in a child process so it can be restarted after an update.
  const start = () => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env });
    const forward = (sig) => child.kill(sig);
    process.on('SIGINT', forward).on('SIGTERM', forward);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward).off('SIGTERM', forward);
      if (code === RESTART) return start();
      if (signal) process.exit(1);
      pauseThenExit(code ?? 1);
    });
  };
  start();
}

/** Start with the computer: a shortcut script in the Windows Startup folder, or a Linux desktop autostart entry. */
function setAutostart(on) {
  const exe = process.execPath;
  if (isWindows) {
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const file = path.join(dir, 'Grocery home collector.cmd');
    if (!on) {
      fs.rmSync(file, { force: true });
      return 'It will no longer start with Windows.';
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `@echo off\r\nstart "Grocery home collector" /min "${exe}"\r\n`);
    return `It will now start (minimised) when you sign in to Windows.\n(${file})`;
  }
  if (process.platform === 'linux') {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
    const file = path.join(dir, 'grocery-collector.desktop');
    if (!on) {
      fs.rmSync(file, { force: true });
      return 'It will no longer start when you log in.';
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Grocery home collector\nExec="${exe}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    return `It will now start when you log in to the desktop.\n(${file})\nOn a server with no desktop, use a systemd service instead (see DEPLOY.md).`;
  }
  throw new Error('Only supported on Windows and Linux');
}

// ---------------------------------------------------------------- collector (the child process)

const codeDir = (version) => path.join(DATA, 'code', version);

/** Same fingerprint as src/collector-files.js. */
function fingerprint(paths, read) {
  const h = crypto.createHash('sha256');
  for (const p of [...paths].sort()) h.update(p).update('\0').update(String(read(p)).replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex').slice(0, 12);
}

/** Download the site's current collector code into the cache. Returns its folder. */
async function fetchCode(server, token) {
  const res = await fetch(`${server}/api/collector/bundle`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Collector-Mode': 'exe' },
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  const paths = body.code;
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof body.files?.[p] !== 'string')
    || fingerprint(paths, (p) => body.files[p]) !== body.version) {
    throw new Error('the download looked incomplete');
  }
  const dir = codeDir(body.version);
  if (fs.existsSync(path.join(dir, 'src', 'cli', 'collect.js'))) {
    fs.utimesSync(dir, new Date(), new Date()); // mark it as the newest
    return dir;
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  for (const rel of paths) {
    const dest = path.resolve(tmp, rel);
    if (!dest.startsWith(tmp + path.sep)) throw new Error(`unexpected file ${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body.files[rel]);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }\n');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  prune(body.version);
  return dir;
}

/** Keep the current and the previous version only. */
function prune(keep) {
  const versions = cachedVersions();
  for (const v of versions.filter((v) => v !== keep).slice(1)) fs.rmSync(codeDir(v), { recursive: true, force: true });
}

/** Cached versions, newest first. */
function cachedVersions() {
  const root = path.join(DATA, 'code');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((v) => /^[0-9a-f]{12}$/.test(v) && fs.existsSync(path.join(root, v, 'src', 'cli', 'collect.js')))
    .sort((a, b) => fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs);
}

async function runCollector() {
  const server = (process.env.COLLECTOR_SERVER || '').replace(/\/$/, '');
  const token = process.env.COLLECTOR_TOKEN;
  if (!server || !token) {
    console.error('This copy has no site address or token. Download the collector again from your site’s Admin page.');
    process.exit(1);
  }
  let dir;
  for (let attempt = 0; !dir; attempt++) {
    try {
      dir = await fetchCode(server, token);
    } catch (e) {
      if (e.status === 401) {
        console.error(`${server} refused this collector (${e.message}). Download it again from the Admin page — the token may have been changed.`);
        process.exit(1);
      }
      const cached = cachedVersions()[0];
      if (cached) {
        console.warn(`Couldn’t get the latest collector from ${server} (${e.message}); using the saved copy.`);
        dir = codeDir(cached);
      } else if (attempt < 5) {
        console.warn(`Couldn’t reach ${server} (${e.message}); trying again in a minute…`);
        await new Promise((r) => setTimeout(r, 60000));
      } else {
        console.error(`Couldn’t reach ${server}. Check the internet connection and try again.`);
        process.exit(1);
      }
    }
  }
  process.env.COLLECTOR_MODE = 'exe';
  await import(pathToFileURL(path.join(dir, 'src', 'cli', 'collect.js')).href);
}

if (CHILD) {
  runCollector().catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
} else {
  supervise();
}
