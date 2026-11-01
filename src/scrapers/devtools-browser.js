// A shop that blocks programs (Imperva, on Coles and Liquorland) rarely
// blocks a real browser. A collector on a computer with Chrome, Edge or
// Chromium installed (every Windows PC has Edge) runs it, out of sight and
// with a profile of its own, and makes those shops' requests from inside a
// tab on the shop's own site, as the site's pages do.
//
// It talks to the browser over the DevTools protocol, which needs nothing but
// Node itself (a WebSocket), so the single-program collector can use it.
//   BROWSER_SHOPS=coles,liquorland   which shops (the collector sets this when it finds a browser)
//   BROWSER_PATH=…                   use this browser
//   BROWSER_HEADLESS=false           show the window (for watching what happens)
//   BROWSER_ARGS=…                   more command-line switches for it

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SHOP_HOSTS = { coles: 'www.coles.com.au', liquorland: 'www.liquorland.com.au' };
const LOAD_TIMEOUT_MS = 45000;

/** The hosts whose requests go through the browser. */
export function browserHosts() {
  return String(process.env.BROWSER_SHOPS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => SHOP_HOSTS[s] || s);
}

/** An installed Chrome, Edge or Chromium, or null. */
export function findBrowser() {
  if (process.env.BROWSER_PATH) return fs.existsSync(process.env.BROWSER_PATH) ? process.env.BROWSER_PATH : null;
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
    candidates.push('/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome');
  }
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// ---------------------------------------------------------------- the browser (one, shared)

let shared = null; // the running browser
let starting = null;

function profileDir() {
  const base = process.env.GROCERY_COLLECTOR_HOME
    || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'GroceryCollector')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'grocery-collector'));
  return path.join(base, 'browser-profile');
}

async function launch() {
  const exe = findBrowser();
  if (!exe) throw new Error('No Chrome, Edge or Chromium found for the shops that block programs');
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true });
  const args = [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=1280,900', '--disable-background-networking',
    ...(process.env.BROWSER_HEADLESS === 'false' ? [] : ['--headless=new']),
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), // Linux as root (some servers, containers)
    ...(process.env.HTTPS_PROXY || process.env.https_proxy ? [`--proxy-server=${process.env.HTTPS_PROXY || process.env.https_proxy}`] : []),
    ...String(process.env.BROWSER_ARGS || '').split(' ').filter(Boolean),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  // The browser writes the port it chose to DevToolsActivePort.
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    if (proc.exitCode != null) throw new Error(`The browser closed straight away (${path.basename(exe)})`);
    try {
      port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!port) {
    proc.kill();
    throw new Error('The browser didn’t start its remote control');
  }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Couldn’t connect to the browser'));
  });
  const b = { proc, ws, nextId: 1, pending: new Map(), listeners: new Set(), tabs: 0, name: path.basename(exe) };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && b.pending.has(msg.id)) {
      const { resolve, reject } = b.pending.get(msg.id);
      b.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) for (const l of b.listeners) l(msg);
  };
  const gone = () => {
    for (const { reject } of b.pending.values()) reject(new Error('The browser closed'));
    b.pending.clear();
    if (shared === b) shared = null;
  };
  ws.onclose = gone;
  proc.on('exit', gone);
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.once(sig, () => proc.kill());
  console.log(`Using ${b.name} for the shops that block programs`);
  return b;
}

async function browser() {
  if (shared) return shared;
  starting ||= launch().then((b) => (shared = b)).finally(() => {
    starting = null;
  });
  return starting;
}

function send(b, method, params = {}, sessionId) {
  const id = b.nextId++;
  b.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => {
    b.pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (b.pending.delete(id)) reject(new Error(`The browser didn’t answer ${method}`));
    }, 90000);
  });
}

/** Wait for an event in a tab (or time out). */
function waitFor(b, sessionId, method, ms) {
  return new Promise((resolve) => {
    const done = (v) => {
      b.listeners.delete(listen);
      clearTimeout(timer);
      resolve(v);
    };
    const listen = (msg) => msg.sessionId === sessionId && msg.method === method && done(true);
    const timer = setTimeout(() => done(false), ms);
    b.listeners.add(listen);
  });
}

// ---------------------------------------------------------------- one tab per client

/** A client like FetchClient's, making its requests from a tab on the shop's site. */
export class DevtoolsClient {
  /** @param {{HttpError: Function, requestJson: Function, sleep: Function}} helpers (from http.js) */
  constructor(origin, delayMs, extraHeaders, helpers) {
    Object.assign(this, { origin, delayMs, extraHeaders, helpers, needsInit: true, pinned: new Map() });
  }

  async init() {
    const b = await browser();
    this.b = b;
    if (!this.sessionId) {
      const { targetId } = await send(b, 'Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send(b, 'Target.attachToTarget', { targetId, flatten: true });
      Object.assign(this, { targetId, sessionId });
      await send(b, 'Page.enable', {}, sessionId);
    }
    for (const [name, value] of this.pinned) await send(b, 'Network.setCookie', { name, value, url: this.origin }, this.sessionId).catch(() => {});
    await this.open();
  }

  /** Load the shop's home page, giving its bot check time to finish. */
  async open() {
    const loaded = waitFor(this.b, this.sessionId, 'Page.loadEventFired', LOAD_TIMEOUT_MS);
    await send(this.b, 'Page.navigate', { url: `${this.origin}/` }, this.sessionId);
    await loaded;
    for (let i = 0; i < 20; i++) {
      const title = await this.evaluate('document.title').catch(() => '');
      if (!/pardon our interruption|incapsula|just a moment|access denied/i.test(String(title))) break;
      await this.helpers.sleep(1500); // a challenge page reloads itself once it's satisfied
    }
    await this.helpers.sleep(1000);
  }

  async evaluate(expression) {
    const r = await send(this.b, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Script failed in the browser');
    return r.result.value;
  }

  /** A cookie every request carries, e.g. the store whose prices to get. */
  pinCookie(name, value) {
    this.pinned.set(name, value);
    if (this.sessionId) send(this.b, 'Network.setCookie', { name, value, url: this.origin }, this.sessionId).catch(() => {});
  }

  async renew() {
    if (!this.sessionId) return this.init();
    return this.open();
  }

  async request(url, { method = 'GET', body, accept = 'application/json', headers = {} } = {}) {
    if (!this.sessionId) await this.init();
    const init = {
      method,
      headers: { Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}), ...this.extraHeaders, ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    };
    const res = await this.evaluate(`(async () => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(${JSON.stringify(url)}, { ...${JSON.stringify(init)}, signal: ctl.signal });
      return { status: r.status, text: await r.text() };
    })()`);
    if (res.status >= 400) throw Object.assign(new this.helpers.HttpError(res.status, url, res.text), res.status !== 429 && res.status < 500 ? { fatal: true } : {});
    return res.text;
  }

  async getText(url) {
    const t = await this.request(url, { accept: 'text/html' });
    await this.helpers.sleep(this.delayMs);
    return t;
  }

  getJson(url, headers) {
    return this.helpers.requestJson(this, url, { headers });
  }

  postJson(url, body, headers) {
    return this.helpers.requestJson(this, url, { method: 'POST', body, headers });
  }

  async close() {
    if (this.b && this.targetId) await send(this.b, 'Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.sessionId = null;
    this.targetId = null;
  }
}

/** Tests: close the browser. */
export async function closeBrowser() {
  const b = shared || (starting && (await starting.catch(() => null)));
  shared = null;
  if (b) {
    b.ws.close();
    b.proc.kill();
  }
}
