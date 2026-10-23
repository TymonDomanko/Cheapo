// The Express app: public price comparison, per-user (and shared) shopping
// lists behind a login, and admin-only data management.

import express from 'express';
import path from 'node:path';
import { getDb } from './db.js';
import { STORES, STORE_INFO } from './stores.js';
import { compareSearch, productDetail } from './compare.js';
import {
  createUser, checkLogin, startSession, endSession, loadUser, requireUser, requireAdmin,
  sameOriginOnly, rateLimit, updateProfile, changePassword, deleteAccount, sessionToken,
  requestPasswordReset, resetPassword, sendVerification, verifyEmail, MEMBERSHIPS,
} from './auth.js';
import * as lists from './lists.js';
import * as iga from './iga.js';
import { siteUrl, mailConfigured, siteName } from './mailer.js';
import * as backup from './backup.js';
import * as alerts from './alerts.js';
import * as matchfix from './matchfix.js';
import { backfillColesBarcodes, barcodeStatus, colesBarcodeProgress } from './barcodes.js';
import { scrapeAll, scrapeStatus, serverStores, startRun, getRun, recordBatch, finishRun } from './scrapers/index.js';
import crypto from 'node:crypto';
import { startOrder, orderStatus } from './order/index.js';

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

export function createApp() {
  const app = express();
  // Number of reverse proxies in front of the app (e.g. 1), so req.ip / HTTPS detection are right.
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? 1 : tp);
  app.disable('x-powered-by');

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
  app.use(express.static(path.resolve('public')));
  app.use('/vendor/chart.js', express.static(path.resolve('node_modules/chart.js/dist')));
  // Pages handled by the single-page app.
  const spa = (req, res) => res.sendFile(path.resolve('public/index.html'));
  app.get(['/login', '/signup', '/settings', '/join/:token', '/forgot-password', '/reset-password', '/verify-email', '/privacy'], spa);
  // For load balancers / platform health checks.
  app.get('/healthz', (req, res) => {
    getDb().prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.use('/api', loadUser, sameOriginOnly, rateLimit({ windowMs: 60000, max: 300 }));

  // ------------------------------------------------------------ public

  app.get('/api/config', h(async (req) => {
    await iga.ensureDirectory().catch(() => {}); // store names; harmless if IGA is unreachable
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
      contact: process.env.CONTACT_EMAIL || null,
      operator: process.env.SITE_OPERATOR || null,
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

  const searchLimit = rateLimit({ windowMs: 60000, max: 90 });
  app.get('/api/search', searchLimit, h((req) => {
    const { q = '', store, specials, mode } = req.query;
    return compareSearch(String(q).slice(0, 100), {
      store,
      stores: req.user?.preferredStores,
      igaStore: igaFor(req),
      memberships: req.user?.memberships || [],
      specialsOnly: specials === '1',
      mode: mode === 'exact' ? 'exact' : 'similar',
      limit: Math.min(Number(req.query.limit) || 30, 60),
      offset: Math.max(0, Number(req.query.offset) || 0),
    });
  }));

  app.get('/api/products/:id', h((req) => {
    const out = productDetail(id(req.params.id), req.user?.preferredStores, igaFor(req));
    if (!out) throw bad('Not found', 404);
    return out;
  }));

  // Biggest recent price moves.
  app.get('/api/changes', h((req) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    const dir = req.query.direction === 'up' ? 'AND h.price > old_price' : req.query.direction === 'down' ? 'AND h.price < old_price' : '';
    return getDb().prepare(`
      SELECT p.id, p.store, p.name, p.size_text, p.image_url, h.price AS new_price, h.recorded_at,
        (SELECT price FROM price_history e WHERE e.product_id = h.product_id AND e.location IS h.location AND e.id < h.id
          ORDER BY e.id DESC LIMIT 1) AS old_price
      FROM price_history h JOIN products p ON p.id = h.product_id
      WHERE h.recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND old_price IS NOT NULL
        AND (h.location IS NULL OR h.location = ?) AND (p.location_priced = 1 OR p.available = 1) ${dir}
      ORDER BY ABS(h.price - old_price) / old_price DESC LIMIT 100`).all(`-${days} days`, igaFor(req));
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
    const { name, preferredStores, applyToLists, alertsWeekly, alertsPrice, memberships } = req.body || {};
    const user = updateProfile(req.user.id, { name, preferredStores, alertsWeekly, alertsPrice, memberships });
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
      alerts_price, memberships FROM users WHERE id = ?`).get(req.user.id);
    const myLists = lists.listsForUser(req.user.id).map((l) => ({
      ...l,
      items: d.prepare(`SELECT p.store, p.name, p.size_text, i.quantity, i.match_mode, i.added_at FROM list_items i
        JOIN products p ON p.id = i.product_id WHERE i.list_id = ?`).all(l.id),
    }));
    const watches = d.prepare(`SELECT p.store, p.name, p.size_text, w.target_price, w.created_at FROM watches w
      JOIN products p ON p.id = w.product_id WHERE w.user_id = ?`).all(req.user.id);
    res.set('Content-Disposition', 'attachment; filename="my-grocery-data.json"');
    return { exportedAt: new Date().toISOString(), account: u, lists: myLists, watches };
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
    const { productId, quantity = 1, matchMode = 'similar' } = req.body || {};
    return { id: lists.addItem(id(req.params.id), req.user.id, id(productId), quantity, matchMode) };
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

  app.put('/api/items/:id/checked', requireUser, h((req) => lists.setChecked(id(req.params.id), req.user.id, !!req.body?.checked)));
  app.post('/api/lists/:id/finish', requireUser, h((req) => lists.finishShop(id(req.params.id), req.user.id)));
  app.get('/api/lists/:id/snapshots', requireUser, h((req) => lists.listSnapshots(id(req.params.id), req.user.id)));
  app.post('/api/lists/:id/snapshots', requireUser, h((req) => lists.saveRegularShop(id(req.params.id), req.user.id, req.body?.name)));
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
    const want = process.env.COLLECTOR_TOKEN;
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) return res.status(401).json({ error: want ? 'Bad collector token' : 'This server isn’t accepting collectors (set COLLECTOR_TOKEN)' });
    next();
  }
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
      collectorEnabled: !!process.env.COLLECTOR_TOKEN,
      barcodes: { ...colesBarcodeProgress(), status: barcodeStatus },
      openMatchReports: getDb().prepare("SELECT COUNT(*) n FROM match_reports WHERE status = 'open'").get().n,
    };
  }));

  app.post('/api/admin/scrape', requireAdmin, h((req) => {
    const wanted = Array.isArray(req.body?.stores) ? req.body.stores.filter((s) => serverStores().includes(s)) : serverStores();
    const stores = wanted.filter((s) => !scrapeStatus[s].running);
    scrapeAll(stores).catch(() => {});
    return { started: stores };
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

