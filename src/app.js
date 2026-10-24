// The Express app: public price comparison, per-user (and shared) shopping
// lists behind a login, and admin-only data management.

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from './db.js';
import { STORES, STORE_INFO } from './stores.js';
import { compareSearch, productDetail, lookupBarcode, alcoholCategories, NO_ALCOHOL_SQL } from './compare.js';
import {
  createUser, checkLogin, startSession, endSession, loadUser, requireUser, requireAdmin,
  sameOriginOnly, rateLimit, updateProfile, changePassword, deleteAccount, sessionToken,
  requestPasswordReset, resetPassword, sendVerification, verifyEmail, MEMBERSHIPS,
} from './auth.js';
import * as lists from './lists.js';
import * as iga from './iga.js';
import { siteUrl, mailConfigured, siteName, sendMail, emailHtml, escapeHtml } from './mailer.js';
import * as backup from './backup.js';
import * as settings from './settings.js';
import { getSetting } from './settings.js';
import * as collectorBundle from './collector-bundle.js';
import * as collectorExe from './collector-exe.js';
import * as colesLive from './coles-live.js';
import { previewPaste } from './paste.js';
import { productInsight } from './insights.js';
import { logTick, resetLayout } from './layouts.js';
import { dataHealth } from './health.js';
import { unusualDeals, regularsOnSale } from './deals.js';
import { bestPrices } from './bestprice.js';
import { COLLECTOR_CODE } from './collector-files.js';
import * as alerts from './alerts.js';
import * as matchfix from './matchfix.js';
import { backfillColesBarcodes, barcodeStatus, colesBarcodeProgress } from './barcodes.js';
import { scrapeAll, scrapeStatus, serverStores, startRun, getRun, recordBatch, finishRun } from './scrapers/index.js';
import crypto from 'node:crypto';
import { startOrder, orderStatus } from './order/index.js';

// Which build this is (set when the Docker image is built), so you can tell an update arrived.
const APP_VERSION = process.env.APP_VERSION || 'dev';

// Alcohol is left out of search, deals and price changes unless you've turned it on in Settings.
const wantsAlcohol = (req) => !!req.user?.showAlcohol;

const ALLOW_SIGNUPS = process.env.ALLOW_SIGNUPS !== 'false';
// Filling trolleys drives a browser on the *server* machine, so it only makes
// sense when you run the app on your own computer.
const TROLLEY_FILL = process.env.ENABLE_TROLLEY_FILL === 'true';

/** The IGA store to price things at: the user's choice, else ?iga= (visitors), else the site default. */
function igaFor(req) {
  if (req.user?.igaStoreId) return req.user.igaStoreId;
  const q = String(req.query.iga || '');
  return /^\d{1,10}$/.test(q) ? q : iga.defaultStoreId();
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Bad id');
  return n;
};

/** Wrap a (possibly async) handler: return value → JSON, thrown error → status + message. */
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : e.message });
  }
};

/** index.html with its script and stylesheet addresses tagged by their contents. */
function versionedIndex() {
  const pub = path.resolve('public');
  const tag = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(pub, file))).digest('hex').slice(0, 10);
  const name = escapeHtml(siteName());
  return fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
    .replace('<title>Cheapo</title>', `<title>${name}</title>`) // SITE_NAME
    .replace('<span class="brand-text">Cheapo</span>', `<span class="brand-text${name === 'Cheapo' ? ' bang' : ''}">${name}</span>`)
    .replace('src="/app.js"', `src="/app.js?v=${tag('app.js')}"`)
    .replace('href="/styles.css"', `href="/styles.css?v=${tag('styles.css')}"`);
}

export function createApp() {
  const app = express();
  // Number of reverse proxies in front of the app (e.g. 1), so req.ip / HTTPS detection are right.
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? 1 : tp);
  app.disable('x-powered-by');
  // Gzip responses: search results and lists shrink 5-10x, which matters on phones.
  app.use(compression());

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  // Home collectors send product batches, which can be large; everything else is small.
  const smallJson = express.json({ limit: '50kb' });
  const bigJson = express.json({ limit: '5mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/ingest/') ? bigJson : smallJson)(req, res, next));
  // The page asks for app.js?v=<hash of its contents> (and styles.css the same way), so after an
  // update no cache anywhere — the browser's, a proxy's or the offline copy — can hand back old code.
  const indexHtml = versionedIndex();
  const spa = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
  app.get('/', spa);
  // The installable-app details, with the site's name.
  const manifest = JSON.parse(fs.readFileSync(path.resolve('public/manifest.webmanifest'), 'utf8'));
  manifest.name = siteName();
  app.get('/manifest.webmanifest', (req, res) => res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(manifest)));
  app.use(express.static(path.resolve('public'), { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  // Libraries only change when the app is upgraded, so browsers may keep them for a day.
  const vendor = { maxAge: '1d' };
  app.use('/vendor/chart.js', express.static(path.resolve('node_modules/chart.js/dist'), vendor));
  // Barcode reading for phones without a built-in barcode reader (iPhone Safari).
  app.use('/vendor/zxing', express.static(path.resolve('node_modules/@zxing/library/umd'), vendor));
  // Pages handled by the single-page app.
  app.get(['/index.html', '/login', '/signup', '/settings', '/join/:token', '/forgot-password', '/reset-password', '/verify-email', '/privacy'], spa);
  // For load balancers / platform health checks.
  app.get('/healthz', (req, res) => {
    getDb().prepare('SELECT 1').get();
    res.json({ ok: true, version: APP_VERSION });
  });

  app.use('/api', loadUser, sameOriginOnly, rateLimit({ windowMs: 60000, max: Number(process.env.API_RATE_LIMIT) || 300 }));

  // ------------------------------------------------------------ public

  app.get('/api/config', h(async (req) => {
    // IGA store names, if the directory loads quickly; never hold the page up for it.
    await Promise.race([iga.ensureDirectory().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    return {
    user: req.user || null,
    stores: STORES.map((s) => ({ id: s, ...STORE_INFO[s] })),
    allowSignups: ALLOW_SIGNUPS,
    trolleyFill: TROLLEY_FILL && !!req.user?.isAdmin,
    igaStore: iga.getStore(igaFor(req)) || { id: igaFor(req), name: 'IGA', pricesReady: false },
    igaOnlineStores: iga.onlineStoreCount(),
    memberships: MEMBERSHIPS,
    site: {
      name: siteName(),
      contact: getSetting('CONTACT_EMAIL'),
      operator: getSetting('SITE_OPERATOR'),
      emailEnabled: mailConfigured(),
    },
    };
  }));

  app.get('/api/stats', h(() => {
    const d = getDb();
    return {
      stores: STORES.map((s) => ({
        store: s,
        products: d.prepare('SELECT COUNT(*) n FROM products WHERE store = ? AND available = 1').get(s).n,
        updatedAt: d.prepare("SELECT MAX(finished_at) t FROM scrape_runs WHERE store = ? AND status = 'ok'").get(s).t,
      })),
      demo: !!d.prepare("SELECT 1 FROM products WHERE store_product_id LIKE 'demo-%' LIMIT 1").get(),
    };
  }));

  const searchLimit = rateLimit({ windowMs: 60000, max: Number(process.env.SEARCH_RATE_LIMIT) || 90 });
  app.get('/api/search', searchLimit, h((req) => {
    const { q = '', store, specials, mode } = req.query;
    const groups = compareSearch(String(q).slice(0, 100), {
      store,
      stores: req.user?.preferredStores,
      igaStore: igaFor(req),
      memberships: req.user?.memberships || [],
      alcohol: wantsAlcohol(req),
      specialsOnly: specials === '1',
      mode: mode === 'exact' ? 'exact' : 'similar',
      limit: Math.min(Number(req.query.limit) || 30, 60),
      offset: Math.max(0, Number(req.query.offset) || 0),
    });
    // Coles prices over a day old: fetch Coles' own results for this search now.
    colesLive.refreshForSearch(q, groups.flatMap((g) => (g.members || []).map((m) => m.product?.id ?? m.id)).filter(Boolean));
    // The page shows how many equivalents there are, not each one; leave them out to keep this small.
    return groups.map(({ members, ...g }) => ({ ...g, memberCount: members.length }));
  }));

  // The cheapest of what was searched for, any brand: by size, or for the size asked for.
  app.get('/api/best-price', searchLimit, h((req) => {
    const q = String(req.query.q || '').slice(0, 100);
    const best = bestPrices(q, {
      stores: req.user?.preferredStores,
      igaStore: igaFor(req),
      memberships: req.user?.memberships || [],
      alcohol: wantsAlcohol(req),
    });
    if (!best) return best;
    // Over a day old at Coles? Fresher prices are being fetched: the page asks again in a moment.
    const ids = best.groups.flatMap((g) => g.products.map((p) => p.id));
    return { ...best, refreshing: colesLive.refreshForSearch(q, ids) };
  }));

  // The home page: unusual deals for everyone, and your regulars that are on sale.
  app.get('/api/home', searchLimit, h((req) => {
    const stores = req.user?.preferredStores;
    return {
      unusual: unusualDeals({ stores, alcohol: wantsAlcohol(req) }),
      regulars: req.user ? regularsOnSale(req.user.id, { stores, igaStore: igaFor(req), memberships: req.user.memberships || [], alcohol: wantsAlcohol(req) }) : null,
    };
  }));

  // A barcode scanned in the shop.
  app.get('/api/barcode/:code', searchLimit, h((req) => {
    const out = lookupBarcode(req.params.code, { stores: req.user?.preferredStores, igaStore: igaFor(req), memberships: req.user?.memberships || [] });
    if (!out) throw bad('That doesn’t look like a product barcode');
    return out;
  }));

  app.get('/api/products/:id', h((req) => {
    const out = productDetail(id(req.params.id), req.user?.preferredStores, igaFor(req));
    if (!out) throw bad('Not found', 404);
    out.insight = productInsight(out.product, igaFor(req));
    if (req.user) {
      out.watch = getDb().prepare('SELECT target_price, baseline_price FROM watches WHERE user_id = ? AND product_id = ?')
        .get(req.user.id, out.product.id) || null;
    }
    return out;
  }));

  // Biggest recent price moves.
  app.get('/api/changes', h((req) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const dir = req.query.direction === 'up' ? 'AND h.price > old_price' : req.query.direction === 'down' ? 'AND h.price < old_price' : '';
    const drinks = wantsAlcohol(req) ? '' : `AND ${NO_ALCOHOL_SQL}`;
    return getDb().prepare(`
      SELECT p.id, p.store, p.name, p.size_text, p.image_url, h.price AS new_price, h.recorded_at,
        (SELECT price FROM price_history e WHERE e.product_id = h.product_id AND e.location IS h.location AND e.id < h.id
          ORDER BY e.id DESC LIMIT 1) AS old_price
      FROM price_history h JOIN products p ON p.id = h.product_id
      WHERE h.recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND old_price IS NOT NULL
        AND (h.location IS NULL OR h.location = ?) AND (p.location_priced = 1 OR p.available = 1) ${dir} ${drinks}
      ORDER BY ABS(h.price - old_price) / old_price DESC LIMIT 100`).all(`-${days} days`, igaFor(req), ...(drinks ? [alcoholCategories()] : []));
  }));

  // ------------------------------------------------------------ IGA store picker

  const igaLimit = rateLimit({ windowMs: 60000, max: 60 });
  app.get('/api/iga/stores', igaLimit, h(async (req) => iga.searchStores({
    q: String(req.query.q || '').slice(0, 60),
    lat: req.query.lat != null ? Number(req.query.lat) : undefined,
    lng: req.query.lng != null ? Number(req.query.lng) : undefined,
  })));

  app.get('/api/iga/stores/:storeId', h((req) => {
    const store = iga.getStore(req.params.storeId);
    if (!store) throw bad('Unknown IGA store', 404);
    return store;
  }));

  // Choose an IGA store: starts collecting its prices if nobody has picked it before.
  // Logged-in users have it saved (optionally to their own lists too); visitors keep it in their browser.
  app.post('/api/iga/stores/:storeId/use', igaLimit, h(async (req) => {
    const store = await iga.useStore(req.params.storeId, req.user?.id);
    if (req.user) {
      updateProfile(req.user.id, { igaStore: store.id });
      if (req.body?.applyToLists) lists.applyPreferredToOwnedLists(req.user.id, null, store.id);
    }
    return store;
  }));

  // ------------------------------------------------------------ accounts

  // Sign-up / log-in / reset attempts per IP per 15 minutes.
  const authLimit = rateLimit({ windowMs: 15 * 60000, max: Number(process.env.AUTH_RATE_LIMIT) || 20 });

  app.post('/api/auth/signup', authLimit, h(async (req, res) => {
    if (!ALLOW_SIGNUPS) throw bad('Sign-ups are closed', 403);
    const { email, name, password, preferredStores, igaStore } = req.body || {};
    // Check the IGA choice before creating anything.
    if (igaStore) await iga.useStore(igaStore);
    let user = await createUser({ email, name, password });
    if (Array.isArray(preferredStores) && preferredStores.length) user = updateProfile(user.id, { preferredStores });
    if (igaStore) user = updateProfile(user.id, { igaStore });
    lists.createList(user.id, 'My list', user.preferredStores, user.igaStoreId);
    startSession(res, user.id);
    sendVerification(user.id, siteUrl(req)).catch((e) => console.error(`verification email: ${e.message}`));
    return { user };
  }));

  app.post('/api/auth/login', authLimit, h(async (req, res) => {
    const user = await checkLogin(req.body?.email, req.body?.password);
    startSession(res, user.id);
    return { user };
  }));

  app.post('/api/auth/logout', h((req, res) => {
    endSession(req, res);
  }));

  // Forgotten password: always answers the same, whether or not the account exists.
  app.post('/api/auth/forgot', authLimit, h(async (req) => {
    await requestPasswordReset(req.body?.email, siteUrl(req)).catch((e) => console.error(`reset email: ${e.message}`));
    return { ok: true };
  }));

  app.post('/api/auth/reset', authLimit, h(async (req, res) => {
    const user = await resetPassword(req.body?.token, req.body?.password);
    startSession(res, user.id);
    return { user };
  }));

  app.post('/api/auth/verify', authLimit, h((req) => {
    verifyEmail(req.body?.token);
  }));

  // ------------------------------------------------------------ your account

  app.patch('/api/me', requireUser, h((req) => {
    const { name, preferredStores, applyToLists, alertsWeekly, alertsPrice, memberships, showAlcohol } = req.body || {};
    const user = updateProfile(req.user.id, { name, preferredStores, alertsWeekly, alertsPrice, memberships, showAlcohol });
    if (preferredStores != null && applyToLists) lists.applyPreferredToOwnedLists(req.user.id, user.preferredStores);
    return { user };
  }));

  app.post('/api/me/verify-email', requireUser, authLimit, h(async (req) => {
    await sendVerification(req.user.id, siteUrl(req));
  }));

  // Everything we hold about you, as a JSON file (see the privacy page).
  app.get('/api/me/export', requireUser, h((req, res) => {
    const d = getDb();
    const u = d.prepare(`SELECT id, email, name, created_at, email_verified_at, preferred_stores, iga_store, alerts_weekly,
      alerts_price, memberships, show_alcohol FROM users WHERE id = ?`).get(req.user.id);
    const myLists = lists.listsForUser(req.user.id).map((l) => ({
      ...l,
      items: d.prepare(`SELECT p.store, p.name, p.size_text, i.note, i.quantity, i.match_mode, i.added_at FROM list_items i
        LEFT JOIN products p ON p.id = i.product_id WHERE i.list_id = ?`).all(l.id),
      shops: d.prepare(`SELECT name, kind, items_json, spent, spent_json, created_at FROM list_snapshots WHERE list_id = ?`).all(l.id)
        .map((x) => ({ ...x, items: JSON.parse(x.items_json), spentDetail: x.spent_json ? JSON.parse(x.spent_json) : null, items_json: undefined, spent_json: undefined })),
    }));
    const watches = d.prepare(`SELECT p.store, p.name, p.size_text, w.target_price, w.created_at FROM watches w
      JOIN products p ON p.id = w.product_id WHERE w.user_id = ?`).all(req.user.id);
    res.set('Content-Disposition', 'attachment; filename="my-grocery-data.json"');
    const ticks = d.prepare('SELECT store, aisle, at FROM tick_log WHERE user_id = ? ORDER BY at').all(req.user.id);
    return { exportedAt: new Date().toISOString(), account: u, lists: myLists, watches, shopTicks: ticks };
  }));

  app.post('/api/me/password', requireUser, authLimit, h(async (req) => {
    await changePassword(req.user.id, req.body?.currentPassword, req.body?.newPassword, sessionToken(req));
  }));

  app.delete('/api/me', requireUser, authLimit, h(async (req, res) => {
    await deleteAccount(req.user.id, req.body?.password);
    endSession(req, res);
  }));

  // ------------------------------------------------------------ lists (logged in)

  app.get('/api/lists', requireUser, h((req) => lists.listsForUser(req.user.id)));
  app.post('/api/lists', requireUser, h((req) => lists.createList(req.user.id, req.body?.name, req.user.preferredStores, req.user.igaStoreId)));
  app.get('/api/lists/:id', requireUser, h((req) => lists.listView(id(req.params.id), req.user.id)));

  app.patch('/api/lists/:id', requireUser, h(async (req) => {
    const listId = id(req.params.id);
    const { name, excludedStores, igaStore } = req.body || {};
    if (igaStore != null) {
      lists.requireMember(listId, req.user.id);
      await iga.useStore(igaStore, req.user.id);
      lists.setListIgaStore(listId, req.user.id, igaStore);
    }
    if (name != null) lists.renameList(listId, req.user.id, name);
    if (excludedStores != null) lists.setExcludedStores(listId, req.user.id, excludedStores);
  }));

  app.delete('/api/lists/:id', requireUser, h((req) => lists.deleteList(id(req.params.id), req.user.id)));

  app.post('/api/lists/:id/items', requireUser, h((req) => {
    const { productId, note, cheapest, quantity = 1, matchMode = 'similar' } = req.body || {};
    if (cheapest != null) {
      return { id: lists.addCheapest(id(req.params.id), req.user.id, cheapest, quantity, { igaStore: igaFor(req), memberships: req.user.memberships || [] }) };
    }
    if (productId == null && note != null) return { id: lists.addNote(id(req.params.id), req.user.id, note, quantity) };
    return { id: lists.addItem(id(req.params.id), req.user.id, id(productId), quantity, matchMode) };
  }));

  // Paste a typed list: first see what each line matches, then add the chosen ones.
  app.post('/api/lists/:id/paste-preview', requireUser, searchLimit, h((req) => {
    const listId = id(req.params.id);
    const list = lists.getListSummary(listId, req.user.id);
    const text = String(req.body?.text || '').slice(0, 5000);
    return previewPaste(text, {
      stores: STORES.filter((s) => !list.excludedStores.includes(s)),
      igaStore: list.igaStoreId,
      memberships: req.user.memberships || [],
      alcohol: wantsAlcohol(req),
    });
  }));
  app.post('/api/lists/:id/paste', requireUser, h((req) => {
    const listId = id(req.params.id);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 60) : [];
    let added = 0;
    for (const l of lines) {
      if (l.cheapest != null) lists.addCheapest(listId, req.user.id, l.cheapest, l.quantity, { igaStore: igaFor(req), memberships: req.user.memberships || [] });
      else if (l.productId != null) lists.addItem(listId, req.user.id, id(l.productId), l.quantity);
      else lists.addNote(listId, req.user.id, l.note, l.quantity);
      added++;
    }
    return { added };
  }));
  app.delete('/api/lists/:id/items', requireUser, h((req) => lists.clearItems(id(req.params.id), req.user.id)));

  app.patch('/api/items/:id', requireUser, h((req) => lists.updateItem(id(req.params.id), req.user.id, req.body || {})));
  app.delete('/api/items/:id', requireUser, h((req) => lists.removeItem(id(req.params.id), req.user.id)));
  // body.productId: a product id to pin, null = don't buy at this store, 'auto' = cheapest match
  app.put('/api/items/:id/stores/:store', requireUser, h((req) => {
    lists.setItemStore(id(req.params.id), req.user.id, req.params.store, req.body?.productId);
  }));

  // Sharing
  app.post('/api/lists/:id/invites', requireUser, h((req) => {
    const inv = lists.createInvite(id(req.params.id), req.user.id);
    return { ...inv, url: `${req.protocol}://${req.get('host')}/join/${inv.token}` };
  }));
  app.get('/api/invites/:token', h((req) => lists.describeInvite(req.params.token)));
  app.post('/api/invites/:token/accept', requireUser, h((req) => ({ listId: lists.acceptInvite(req.params.token, req.user.id) })));
  app.delete('/api/lists/:id/members/:userId', requireUser, h((req) => {
    lists.removeMember(id(req.params.id), req.user.id, id(req.params.userId));
  }));

  // ------------------------------------------------------------ in the shop & saved shops

  app.put('/api/items/:id/checked', requireUser, h((req) => {
    const { checked, store, aisle, at } = req.body || {};
    lists.setChecked(id(req.params.id), req.user.id, !!checked);
    // Ticks made in the shop teach us its layout.
    if (checked && store && aisle) logTick(req.user.id, { store, aisle, at });
  }));
  app.delete('/api/me/shop-layouts/:store', requireUser, h((req) => resetLayout(req.user.id, req.params.store)));
  app.post('/api/lists/:id/finish', requireUser, h((req) => lists.finishShop(id(req.params.id), req.user.id)));
  app.get('/api/lists/:id/snapshots', requireUser, h((req) => lists.listSnapshots(id(req.params.id), req.user.id)));
  app.post('/api/lists/:id/snapshots', requireUser, h((req) => lists.saveRegularShop(id(req.params.id), req.user.id, req.body?.name)));
  app.get('/api/lists/:id/spending', requireUser, h((req) => lists.spending(id(req.params.id), req.user.id)));
  app.post('/api/lists/:id/snapshots/:sid/add', requireUser, h((req) => lists.addSnapshot(id(req.params.id), req.user.id, id(req.params.sid))));
  app.delete('/api/lists/:id/snapshots/:sid', requireUser, h((req) => lists.deleteSnapshot(id(req.params.id), req.user.id, id(req.params.sid))));

  // ------------------------------------------------------------ price alerts

  app.get('/api/watches', requireUser, h((req) => alerts.listWatches(req.user.id)));
  app.put('/api/watches/:productId', requireUser, h((req) => alerts.setWatch(req.user.id, id(req.params.productId), req.body?.targetPrice ?? null)));
  app.delete('/api/watches/:productId', requireUser, h((req) => alerts.removeWatch(req.user.id, id(req.params.productId))));

  // One-click unsubscribe from email links (GET from a browser, POST from mail apps).
  const unsubscribe = (req, res) => {
    const q = { ...req.query, ...(req.body || {}) };
    try {
      alerts.unsubscribe(Number(q.u), String(q.k), String(q.s));
      res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
        <body style="font-family:system-ui;max-width:480px;margin:60px auto;padding:0 16px"><h1>You’re unsubscribed</h1>
        <p>You won’t get ${q.k === 'weekly' ? 'the weekly specials email' : 'price alert emails'} any more. You can turn ${q.k === 'weekly' ? 'it' : 'them'} back on in <a href="/settings">Settings</a>.</p></body>`);
    } catch (e) {
      res.status(400).type('text').send(e.message);
    }
  };
  app.get('/api/unsubscribe', unsubscribe);
  app.post('/api/unsubscribe', express.urlencoded({ extended: false }), unsubscribe);

  // ------------------------------------------------------------ wrong matches

  app.post('/api/match-reports', requireUser, h((req) => {
    const { anchorId, productId, kind, note } = req.body || {};
    return matchfix.report({ userId: req.user.id, isAdmin: req.user.isAdmin, anchorId: id(anchorId), productId: id(productId), kind, note });
  }));
  app.get('/api/admin/match-reports', requireAdmin, h(() => ({ open: matchfix.openReports(), rules: matchfix.listRules() })));
  app.post('/api/admin/match-reports/:id', requireAdmin, h((req) => {
    const decision = req.body?.decision;
    if (!['accept', 'dismiss'].includes(decision)) throw bad('decision must be accept or dismiss');
    return matchfix.resolve(id(req.params.id), decision, req.user.id);
  }));
  app.delete('/api/admin/match-rules/:a/:b', requireAdmin, h((req) => matchfix.removeRule(id(req.params.a), id(req.params.b))));

  // ------------------------------------------------------------ home collector
  // Stores that block cloud servers (Woolworths, ALDI) can be crawled from a
  // home connection by `npm run collect`, which sends the products here.

  function requireCollector(req, res, next) {
    const want = getSetting('COLLECTOR_TOKEN');
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) return res.status(401).json({ error: want ? 'Bad collector token' : 'This server isn’t accepting collectors (set COLLECTOR_TOKEN)' });
    collectorBundle.recordCollector({ version: req.get('X-Collector-Version'), mode: req.get('X-Collector-Mode') });
    next();
  }

  // Collectors ask before each run whether there's a newer version, and fetch it if so.
  app.get('/api/collector/latest', requireCollector, h(() => ({ version: collectorBundle.latestCollectorVersion() })));
  app.get('/api/collector/bundle', requireCollector, h((req) => ({
    version: collectorBundle.latestCollectorVersion(),
    code: COLLECTOR_CODE,
    files: collectorBundle.bundleFiles(siteUrl(req)),
  })));
  const collectorRun = (req) => {
    const run = getRun(id(req.params.runId));
    if (!run || run.source !== 'collector') throw bad('Unknown run', 404);
    return run;
  };

  app.post('/api/ingest/runs', requireCollector, h((req) => {
    const { store, location } = req.body || {};
    if (!STORES.includes(store)) throw bad('Unknown store');
    return startRun(store, { location: location ? String(location) : null, source: 'collector' });
  }));
  app.post('/api/ingest/runs/:runId/items', requireCollector, h((req) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 2000) throw bad('Send { items: [...] } (up to 2000 per batch)');
    return recordBatch(collectorRun(req), items);
  }));
  app.post('/api/ingest/runs/:runId/finish', requireCollector, h((req) => {
    const run = finishRun(collectorRun(req), { complete: !!req.body?.complete, error: req.body?.error || null });
    return { status: run.status, products: run.products, priceChanges: run.price_changes };
  }));

  // ------------------------------------------------------------ admin

  app.get('/api/admin/overview', requireAdmin, h(() => {
    const d = getDb();
    return {
      version: APP_VERSION,
      colesLive: colesLive.status(),
      stores: STORES.map((s) => ({
        store: s,
        products: d.prepare('SELECT COUNT(*) n FROM products WHERE store = ? AND available = 1').get(s).n,
        status: scrapeStatus[s],
        fedByCollector: !serverStores().includes(s),
        runs: d.prepare('SELECT * FROM scrape_runs WHERE store = ? ORDER BY id DESC LIMIT 5').all(s),
      })),
      iga: {
        tracked: iga.trackedStores(),
        queue: iga.queueStatus(),
        defaultStoreId: iga.defaultStoreId(),
        maxStores: Number(process.env.IGA_MAX_STORES) > 0 ? Number(process.env.IGA_MAX_STORES) : null,
        onlineStores: iga.onlineStoreCount(),
        lastCheck: iga.lastCheck(),
        check: iga.checkStatus,
      },
      users: d.prepare('SELECT COUNT(*) n FROM users').get().n,
      lists: d.prepare('SELECT COUNT(*) n FROM lists').get().n,
      scrapeCron: process.env.SCRAPE_CRON ?? '15 4 * * *',
      collectorEnabled: !!getSetting('COLLECTOR_TOKEN'),
      barcodes: { ...colesBarcodeProgress(), status: barcodeStatus },
      openMatchReports: getDb().prepare("SELECT COUNT(*) n FROM match_reports WHERE status = 'open'").get().n,
    };
  }));

  app.get('/api/admin/health', requireAdmin, h((req) => dataHealth({ refresh: req.query.refresh === '1' })));

  app.post('/api/admin/scrape', requireAdmin, h((req) => {
    const wanted = Array.isArray(req.body?.stores) ? req.body.stores.filter((s) => serverStores().includes(s)) : serverStores();
    // Coles in steady mode: start its whole-shop pass again rather than crawl it all at once.
    const steady = colesLive.enabled() && wanted.includes('coles');
    if (steady) colesLive.restartPass();
    const stores = wanted.filter((s) => !scrapeStatus[s].running && !(steady && s === 'coles'));
    scrapeAll(stores).catch(() => {});
    return { started: stores, colesSteady: steady };
  }));

  // Site settings (email, site details, home collector). .env values win and can't be changed here.
  app.get('/api/admin/settings', requireAdmin, h((req) => ({
    settings: settings.describeSettings(),
    stores: STORES,
    currentAddress: `${req.protocol}://${req.get('host')}`,
    litestream: backup.litestreamInfo(),
    collector: { ...collectorBundle.collectorStatus(), programs: collectorExe.exeStatuses() },
  })));

  app.put('/api/admin/settings', requireAdmin, h((req) => {
    const body = req.body || {};
    // Apply everything or nothing: check each value first.
    const updates = [];
    if (body.smtp !== undefined) updates.push(['SMTP_URL', body.smtp === null ? null : settings.smtpUrlFrom(body.smtp)]);
    for (const key of ['MAIL_FROM', 'SITE_URL', 'CONTACT_EMAIL', 'SITE_OPERATOR']) {
      if (body[key] !== undefined) updates.push([key, body[key]]);
    }
    if (body.SERVER_SCRAPE_STORES !== undefined) {
      const list = Array.isArray(body.SERVER_SCRAPE_STORES) ? body.SERVER_SCRAPE_STORES : null;
      // Every store ticked = the default (crawl everything), so store nothing.
      updates.push(['SERVER_SCRAPE_STORES', !list || list.length === STORES.length ? null : list.join(',')]);
    }
    for (const [key] of updates) {
      if (settings.settingSource(key) === 'env') throw bad(`${key} is set in the server’s .env file — change it there`, 409);
    }
    for (const [key, value] of updates) settings.setSetting(key, value);
    return { settings: settings.describeSettings() };
  }));

  // A new collector token, shown in full once so it can be copied to the home collector.
  app.post('/api/admin/settings/collector-token', requireAdmin, h(() => {
    const token = settings.newCollectorToken();
    settings.setSetting('COLLECTOR_TOKEN', token);
    return { token };
  }));
  // What a downloaded collector is set up with: this site, its token (made now
  // if there isn't one) and the stores this server doesn't crawl itself (if it
  // crawls everything, the usual two).
  function collectorSetup(req) {
    let token = getSetting('COLLECTOR_TOKEN');
    if (!token) {
      token = settings.newCollectorToken();
      settings.setSetting('COLLECTOR_TOKEN', token);
    }
    const notCrawled = STORES.filter((x) => !serverStores().includes(x));
    return { serverUrl: siteUrl(req), token, stores: notCrawled.length ? notCrawled : ['woolworths', 'aldi'], cron: '0 4 * * *' };
  }

  // The home collector as a zip, ready to run: code, start scripts and a filled-in .env.
  app.get('/api/admin/collector/download', requireAdmin, (req, res) => {
    const setup = collectorSetup(req);
    const files = {
      ...collectorBundle.bundleFiles(setup.serverUrl),
      '.env': collectorBundle.envFile(setup),
    };
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="grocery-home-collector.zip"',
      'Cache-Control': 'no-store',
    });
    res.send(collectorBundle.zip(files, 'grocery-home-collector'));
  });

  // The home collector as a single program per platform. Built in the
  // background the first time (it takes a minute), then served from a cache.
  app.get('/api/admin/collector/programs', requireAdmin, h(() => ({ programs: collectorExe.exeStatuses() })));
  app.post('/api/admin/collector/programs/:target/build', requireAdmin, h((req) => {
    collectorExe.buildExe(req.params.target);
    return collectorExe.exeStatus(req.params.target);
  }));
  app.get('/api/admin/collector/programs/:target', requireAdmin, (req, res) => {
    const { target } = req.params;
    if (!collectorExe.TARGETS[target]) return res.status(404).json({ error: 'Unknown platform' });
    if (!collectorExe.exeStatus(target).ready) return res.status(409).json({ error: 'Not built yet — start the build first' });
    const setup = collectorSetup(req);
    collectorExe.sendExe(res, target, {
      COLLECTOR_SERVER: setup.serverUrl,
      COLLECTOR_TOKEN: setup.token,
      COLLECT_STORES: setup.stores.join(','),
      COLLECT_CRON: setup.cron,
      TZ: 'Australia/Sydney',
      COLLECT_ON_START: 'true',
      AUTO_UPDATE: 'true',
    });
  });

  app.delete('/api/admin/settings/collector-token', requireAdmin, h(() => settings.setSetting('COLLECTOR_TOKEN', null)));

  app.post('/api/admin/settings/test-email', requireAdmin, h(async (req) => {
    if (!mailConfigured()) throw bad('Set up a mail server first');
    const to = req.user.email;
    try {
      await sendMail({
        to,
        kind: 'test',
        subject: `Test email from ${siteName()}`,
        text: `It works! ${siteName()} can send email.\n\nLinks in emails will point to ${siteUrl(req)}.`,
        html: emailHtml({ heading: 'It works!', paragraphs: [`${siteName()} can send email.`, `Links in emails will point to ${siteUrl(req)}.`] }),
      });
    } catch (e) {
      // Turn the usual connection problems into something actionable.
      const hint = {
        ENOTFOUND: 'Couldn’t find that mail server — check the host name.',
        EAUTH: 'The mail server rejected the username or password.',
        ECONNREFUSED: 'The mail server refused the connection — check the port.',
        ETIMEDOUT: 'The mail server didn’t answer — check the port and the secure setting (465 = secure, 587 = not).',
        ESOCKET: 'Couldn’t talk to the mail server — usually the secure setting doesn’t match the port (465 = secure, 587 = not).',
      }[e.code] || '';
      throw bad(`${hint} The mail server said: ${e.message}`.trim(), 422);
    }
    return { to };
  }));

  app.post('/api/admin/barcodes', requireAdmin, h(() => {
    backfillColesBarcodes().catch((e) => console.error(`barcodes: ${e.message}`));
    return { started: true };
  }));
  app.post('/api/admin/send-alerts', requireAdmin, h(async (req) => ({
    priceAlerts: await alerts.sendPriceAlerts({ baseUrl: siteUrl(req) }),
    weekly: req.body?.weekly ? await alerts.sendWeeklyDigests({ baseUrl: siteUrl(req) }) : null,
  })));

  app.delete('/api/admin/iga/:storeId', requireAdmin, h((req) => iga.untrack(req.params.storeId)));
  app.post('/api/admin/iga/check', requireAdmin, h(() => {
    iga.checkOnlineStores().catch(() => {});
    return { started: true };
  }));

  // Without a mail server, emails land here so an admin can pass on a reset link by hand.
  app.get('/api/admin/emails', requireAdmin, h(() => ({
    mailConfigured: mailConfigured(),
    emails: getDb().prepare('SELECT id, to_email, subject, kind, sent_at, error, body FROM email_log ORDER BY id DESC LIMIT 50').all(),
  })));

  app.get('/api/admin/backups', requireAdmin, h(() => ({
    snapshots: backup.listBackups(),
    keepDays: Number(process.env.BACKUP_KEEP_DAYS) || 7,
    litestream: backup.litestreamEnabled(),
  })));
  app.post('/api/admin/backups', requireAdmin, h(() => backup.snapshot()));
  app.get('/api/admin/backups/:name', requireAdmin, (req, res) => {
    const file = backup.backupPath(req.params.name);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.download(file);
  });

  app.get('/api/admin/users', requireAdmin, h(() => getDb().prepare(`
    SELECT u.id, u.email, u.name, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM list_members m WHERE m.user_id = u.id) AS lists
    FROM users u ORDER BY u.created_at DESC LIMIT 500`).all()));

  app.patch('/api/admin/users/:id', requireAdmin, h((req) => {
    const userId = id(req.params.id);
    if (userId === req.user.id) throw bad('You can’t change your own admin access');
    getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body?.isAdmin ? 1 : 0, userId);
  }));

  // Trolley automation (self-hosted only)
  app.post('/api/lists/:id/fill-trolleys', requireAdmin, h((req) => {
    if (!TROLLEY_FILL) throw bad('Trolley filling is turned off on this server', 403);
    const view = lists.listView(id(req.params.id), req.user.id);
    if (!Object.values(view.plan.byStore).some((s) => s.items.length)) throw bad('Nothing to order');
    return { orderId: startOrder(view.plan) };
  }));
  app.get('/api/order/status', requireAdmin, h(() => orderStatus));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

