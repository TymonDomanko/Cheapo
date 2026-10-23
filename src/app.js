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
} from './auth.js';
import * as lists from './lists.js';
import * as iga from './iga.js';
import { scrapeAll, scrapeStatus } from './scrapers/index.js';
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
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.resolve('public')));
  app.use('/vendor/chart.js', express.static(path.resolve('node_modules/chart.js/dist')));
  // Pages handled by the single-page app.
  const spa = (req, res) => res.sendFile(path.resolve('public/index.html'));
  app.get(['/login', '/signup', '/settings', '/join/:token'], spa);
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

  const authLimit = rateLimit({ windowMs: 15 * 60000, max: 20 });

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

  // ------------------------------------------------------------ your account

  app.patch('/api/me', requireUser, h((req) => {
    const { name, preferredStores, applyToLists } = req.body || {};
    const user = updateProfile(req.user.id, { name, preferredStores });
    if (preferredStores != null && applyToLists) lists.applyPreferredToOwnedLists(req.user.id, user.preferredStores);
    return { user };
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

  // ------------------------------------------------------------ admin

  app.get('/api/admin/overview', requireAdmin, h(() => {
    const d = getDb();
    return {
      stores: STORES.map((s) => ({
        store: s,
        products: d.prepare('SELECT COUNT(*) n FROM products WHERE store = ? AND available = 1').get(s).n,
        status: scrapeStatus[s],
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
    };
  }));

  app.post('/api/admin/scrape', requireAdmin, h((req) => {
    const wanted = Array.isArray(req.body?.stores) ? req.body.stores.filter((s) => STORES.includes(s)) : STORES;
    const stores = wanted.filter((s) => !scrapeStatus[s].running);
    scrapeAll(stores).catch(() => {});
    return { started: stores };
  }));

  app.delete('/api/admin/iga/:storeId', requireAdmin, h((req) => iga.untrack(req.params.storeId)));
  app.post('/api/admin/iga/check', requireAdmin, h(() => {
    iga.checkOnlineStores().catch(() => {});
    return { started: true };
  }));

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

