// Shopping lists: owned by a user, optionally shared with others (a
// household), each with its own items and choice of stores to shop at.

import crypto from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { STORES } from './stores.js';
import { getProduct, findEquivalents, betterValue } from './compare.js';
import { lineCost, unitPriceFor } from './promos.js';
import { getUser } from './auth.js';
import { getStore, defaultStoreId } from './iga.js';
import { matchScore } from './matcher.js';
import { AISLES, aisleFor } from './aisles.js';
import { productInsight } from './insights.js';
import { layoutsFor } from './layouts.js';

const INVITE_DAYS = 7;
const MATCH_MODES = ['similar', 'exact', 'this'];
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- lists & access

export function createList(userId, name = 'My list', preferredStores = STORES, igaStore = null) {
  const d = getDb();
  // New lists start with the creator's preferred shops and IGA store.
  const excluded = STORES.filter((s) => !preferredStores.includes(s));
  const id = d.transaction(() => {
    const listId = d.prepare('INSERT INTO lists (name, created_by, excluded_stores, iga_store, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cleanName(name), userId, JSON.stringify(excluded), igaStore, nowIso()).lastInsertRowid;
    d.prepare("INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .run(listId, userId, nowIso());
    return listId;
  })();
  return getListSummary(id, userId);
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw httpError(400, 'Give the list a name');
  return n;
}

/** Throws unless the user belongs to the list; returns their role. */
export function requireMember(listId, userId, role) {
  const m = getDb().prepare('SELECT role FROM list_members WHERE list_id = ? AND user_id = ?').get(listId, userId);
  if (!m) throw httpError(404, 'List not found');
  if (role === 'owner' && m.role !== 'owner') throw httpError(403, 'Only the list owner can do that');
  return m.role;
}

export function listsForUser(userId) {
  return getDb().prepare(`
    SELECT l.id, l.name, m.role,
      (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count,
      (SELECT COUNT(*) FROM list_members x WHERE x.list_id = l.id) AS member_count
    FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
    ORDER BY l.created_at, l.id`).all(userId);
}

export function getListSummary(listId, userId) {
  const d = getDb();
  const role = requireMember(listId, userId);
  const list = d.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  const members = d.prepare(`SELECT u.id, u.name, u.email, m.role FROM list_members m JOIN users u ON u.id = m.user_id
    WHERE m.list_id = ? ORDER BY m.role DESC, m.joined_at`).all(listId);
  return {
    id: list.id,
    name: list.name,
    role,
    excludedStores: parseStores(list.excluded_stores),
    igaStoreId: list.iga_store || defaultStoreId(),
    members,
  };
}

/** Which IGA store this list is priced at (shared by everyone on it). Caller validates the id. */
export function setListIgaStore(listId, userId, igaStore) {
  requireMember(listId, userId);
  getDb().prepare('UPDATE lists SET iga_store = ? WHERE id = ?').run(String(igaStore), listId);
}

function parseStores(json) {
  try {
    return JSON.parse(json).filter((s) => STORES.includes(s));
  } catch {
    return [];
  }
}

export function renameList(listId, userId, name) {
  requireMember(listId, userId);
  getDb().prepare('UPDATE lists SET name = ? WHERE id = ?').run(cleanName(name), listId);
}

export function deleteList(listId, userId) {
  requireMember(listId, userId, 'owner');
  getDb().prepare('DELETE FROM lists WHERE id = ?').run(listId);
}

/** Apply someone's preferred shops (and IGA store, if given) to every list they own. */
export function applyPreferredToOwnedLists(userId, preferredStores, igaStore = null) {
  const owned = `id IN (SELECT list_id FROM list_members WHERE user_id = ? AND role = 'owner')`;
  const d = getDb();
  if (preferredStores) {
    const excluded = JSON.stringify(STORES.filter((s) => !preferredStores.includes(s)));
    d.prepare(`UPDATE lists SET excluded_stores = ? WHERE ${owned}`).run(excluded, userId);
  }
  if (igaStore) d.prepare(`UPDATE lists SET iga_store = ? WHERE ${owned}`).run(String(igaStore), userId);
}

export function setExcludedStores(listId, userId, stores) {
  requireMember(listId, userId);
  const clean = [...new Set((stores || []).filter((s) => STORES.includes(s)))];
  getDb().prepare('UPDATE lists SET excluded_stores = ? WHERE id = ?').run(JSON.stringify(clean), listId);
}

// ---------------------------------------------------------------- sharing

export function createInvite(listId, userId) {
  requireMember(listId, userId);
  const token = crypto.randomBytes(18).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
  getDb().prepare('INSERT INTO list_invites (token, list_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, listId, userId, nowIso(), expires);
  return { token, expiresAt: expires };
}

export function describeInvite(token) {
  const inv = getDb().prepare(`SELECT i.*, l.name AS list_name, u.name AS from_name FROM list_invites i
    JOIN lists l ON l.id = i.list_id LEFT JOIN users u ON u.id = i.created_by
    WHERE i.token = ? AND i.expires_at > ?`).get(String(token), nowIso());
  if (!inv) throw httpError(404, 'This invite link is invalid or has expired');
  return { listId: inv.list_id, listName: inv.list_name, from: inv.from_name };
}

export function acceptInvite(token, userId) {
  const { listId } = describeInvite(token);
  getDb().prepare(`INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
    ON CONFLICT DO NOTHING`).run(listId, userId, nowIso());
  return listId;
}

/** Owners can remove anyone else; members can remove themselves (leave). */
export function removeMember(listId, actingUserId, memberId) {
  const role = requireMember(listId, actingUserId);
  if (memberId !== actingUserId && role !== 'owner') throw httpError(403, 'Only the list owner can remove people');
  const d = getDb();
  const target = d.prepare('SELECT role FROM list_members WHERE list_id = ? AND user_id = ?').get(listId, memberId);
  if (!target) throw httpError(404, 'Not a member');
  if (target.role === 'owner') {
    const owners = d.prepare("SELECT COUNT(*) n FROM list_members WHERE list_id = ? AND role = 'owner'").get(listId).n;
    if (owners <= 1) throw httpError(400, 'The owner can’t leave — delete the list instead');
  }
  d.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(listId, memberId);
}

// ---------------------------------------------------------------- items

function itemListId(itemId) {
  const row = getDb().prepare('SELECT list_id FROM list_items WHERE id = ?').get(itemId);
  if (!row) throw httpError(404, 'Item not found');
  return row.list_id;
}

export function addItem(listId, userId, productId, quantity = 1, matchMode = 'similar') {
  requireMember(listId, userId);
  if (!getProduct(productId)) throw httpError(400, 'Unknown product');
  if (!MATCH_MODES.includes(matchMode)) throw httpError(400, 'Bad match mode');
  const qty = clampQty(quantity);
  const d = getDb();
  const existing = d.prepare('SELECT id FROM list_items WHERE list_id = ? AND product_id = ?').get(listId, productId);
  if (existing) {
    d.prepare('UPDATE list_items SET quantity = MIN(quantity + ?, 99) WHERE id = ?').run(qty, existing.id);
    return existing.id;
  }
  return d.prepare(`INSERT INTO list_items (list_id, product_id, quantity, match_mode, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(listId, productId, qty, matchMode, userId, nowIso()).lastInsertRowid;
}

const cleanNote = (text) => {
  const note = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!note) throw httpError(400, 'Write something to add');
  return note;
};

/** Add a free-text item ("birthday card"), or bump its quantity if it's already there. */
export function addNote(listId, userId, text, quantity = 1) {
  requireMember(listId, userId);
  const note = cleanNote(text);
  const qty = clampQty(quantity);
  const d = getDb();
  const existing = d.prepare('SELECT id FROM list_items WHERE list_id = ? AND product_id IS NULL AND lower(note) = lower(?)').get(listId, note);
  if (existing) {
    d.prepare('UPDATE list_items SET quantity = MIN(quantity + ?, 99) WHERE id = ?').run(qty, existing.id);
    return existing.id;
  }
  return d.prepare(`INSERT INTO list_items (list_id, product_id, note, quantity, added_by, added_at)
    VALUES (?, NULL, ?, ?, ?, ?)`).run(listId, note, qty, userId, nowIso()).lastInsertRowid;
}

function clampQty(q) {
  return Math.min(99, Math.max(1, Number(q) | 0 || 1));
}

export function updateItem(itemId, userId, { quantity, matchMode, note, productId, pinnedStore }) {
  requireMember(itemListId(itemId), userId);
  const d = getDb();
  if (pinnedStore !== undefined) {
    if (pinnedStore !== null && !STORES.includes(pinnedStore)) throw httpError(400, 'Unknown shop');
    d.prepare('UPDATE list_items SET pinned_store = ? WHERE id = ?').run(pinnedStore, itemId);
  }
  if (note != null) d.prepare('UPDATE list_items SET note = ? WHERE id = ? AND product_id IS NULL').run(cleanNote(note), itemId);
  // Turn a note into a product once you've found the one you want.
  if (productId != null) {
    if (!getProduct(Number(productId))) throw httpError(400, 'Unknown product');
    d.prepare('UPDATE list_items SET product_id = ?, note = NULL WHERE id = ?').run(Number(productId), itemId);
    // Per-shop picks were for the old product (e.g. another pack size): start afresh.
    d.prepare('DELETE FROM list_item_overrides WHERE item_id = ?').run(itemId);
  }
  if (quantity != null) d.prepare('UPDATE list_items SET quantity = ? WHERE id = ?').run(clampQty(quantity), itemId);
  if (matchMode != null) {
    if (!MATCH_MODES.includes(matchMode)) throw httpError(400, 'Bad match mode');
    d.prepare('UPDATE list_items SET match_mode = ? WHERE id = ?').run(matchMode, itemId);
  }
}

export function removeItem(itemId, userId) {
  requireMember(itemListId(itemId), userId);
  getDb().prepare('DELETE FROM list_items WHERE id = ?').run(itemId);
}

export function clearItems(listId, userId) {
  requireMember(listId, userId);
  getDb().prepare('DELETE FROM list_items WHERE list_id = ?').run(listId);
}

/** @param {number|null|'auto'} productId  'auto' clears the override, null = don't buy at that store. */
export function setItemStore(itemId, userId, store, productId) {
  requireMember(itemListId(itemId), userId);
  if (!STORES.includes(store)) throw httpError(400, 'Unknown store');
  const d = getDb();
  if (productId === 'auto') {
    d.prepare('DELETE FROM list_item_overrides WHERE item_id = ? AND store = ?').run(itemId, store);
    return;
  }
  if (productId !== null) {
    const p = getProduct(Number(productId));
    if (!p || p.store !== store) throw httpError(400, 'Product is not from that store');
  }
  d.prepare(`INSERT INTO list_item_overrides (item_id, store, product_id) VALUES (?, ?, ?)
    ON CONFLICT (item_id, store) DO UPDATE SET product_id = excluded.product_id`)
    .run(itemId, store, productId === null ? null : Number(productId));
}

// ---------------------------------------------------------------- pricing the list

/** For each item: what it would be at every store (matches + manual choices). */
export function resolveItems(listId, igaStore = null, memberships = []) {
  const d = getDb();
  const items = d.prepare(`SELECT i.*, u.name AS added_by_name, c.name AS checked_by_name FROM list_items i
    LEFT JOIN users u ON u.id = i.added_by LEFT JOIN users c ON c.id = i.checked_by
    WHERE i.list_id = ? ORDER BY i.added_at, i.id`).all(listId);
  const overrides = d.prepare(`SELECT o.* FROM list_item_overrides o JOIN list_items i ON i.id = o.item_id
    WHERE i.list_id = ?`).all(listId);
  return items.map((item) => {
    if (item.product_id == null) {
      // A free-text note: nothing to price, but it still goes on the shopping checklist.
      return {
        id: item.id, quantity: item.quantity, note: item.note, addedBy: item.added_by_name,
        checkedAt: item.checked_at, checkedBy: item.checked_by_name, anchor: null, perStore: {},
      };
    }
    const anchor = getProduct(item.product_id, igaStore);
    const eq = findEquivalents(anchor, item.match_mode, igaStore);
    // Cheapest equivalent at each store *for this quantity* (multi-buys and member prices count).
    const best = {};
    for (const m of eq) {
      const p = m.product;
      if (!p.available || p.price == null) continue;
      const cost = lineCost(p, item.quantity, memberships);
      if (!best[p.store] || cost < best[p.store].cost) best[p.store] = { ...m, cost };
    }
    const perStore = {};
    for (const s of STORES) {
      const ov = overrides.find((o) => o.item_id === item.id && o.store === s);
      const candidates = eq.filter((m) => m.product.store === s).slice(0, 10).map((m) => ({ ...m.product, score: m.score }));
      if (ov && ov.product_id == null) {
        perStore[s] = { excluded: true, candidates };
      } else if (ov) {
        // IGA products are priced at the list's IGA store.
        const p = getProduct(ov.product_id, igaStore);
        perStore[s] = p ? { product: p, manual: true, score: matchScore(anchor, p), candidates } : { candidates };
      } else {
        perStore[s] = best[s] ? { product: best[s].product, score: best[s].score, candidates } : { candidates };
      }
    }
    return {
      id: item.id, quantity: item.quantity, matchMode: item.match_mode, addedBy: item.added_by_name,
      checkedAt: item.checked_at, checkedBy: item.checked_by_name, pinnedStore: item.pinned_store || null,
      anchor, perStore,
    };
  });
}

function buyable(ps) {
  return ps?.product && !ps.excluded && ps.product.available && ps.product.price != null;
}

const costAt = (item, s, memberships) => lineCost(item.perStore[s].product, item.quantity, memberships);

function cheapestAmong(item, stores, memberships) {
  // Pinned to a shop you're using that has it: buy it there, whatever the price.
  if (item.pinnedStore && stores.includes(item.pinnedStore) && buyable(item.perStore[item.pinnedStore])) return item.pinnedStore;
  let best = null;
  for (const s of stores) {
    if (buyable(item.perStore[s]) && (!best || costAt(item, s, memberships) < costAt(item, best, memberships))) best = s;
  }
  return best;
}

/** Split resolved items across `stores`, each item going to its cheapest store. */
export function planFor(items, stores, memberships = []) {
  const byStore = Object.fromEntries(stores.map((s) => [s, { items: [], total: 0 }]));
  const unavailable = [];
  const choice = {};
  const notes = [];
  for (const it of items) {
    if (it.note != null) {
      notes.push({ id: it.id, note: it.note, quantity: it.quantity, aisle: aisleFor({ name: it.note }) });
      continue;
    }
    const s = cheapestAmong(it, stores, memberships);
    choice[it.id] = s;
    if (!s) {
      unavailable.push({ id: it.id, name: it.anchor.name });
      continue;
    }
    const p = it.perStore[s].product;
    const lineTotal = costAt(it, s, memberships);
    const plain = round2(p.price * it.quantity);
    byStore[s].items.push({
      itemId: it.id, quantity: it.quantity, product: p, lineTotal, unitPrice: unitPriceFor(p, memberships),
      aisle: aisleFor(p), // where it is in the shop
      dealSaving: plain > lineTotal ? round2(plain - lineTotal) : 0, // from a multi-buy or member price
    });
    byStore[s].total = round2(byStore[s].total + lineTotal);
  }
  const total = round2(Object.values(byStore).reduce((n, s) => n + s.total, 0));
  return { stores, byStore, total, unavailable, notes, choice };
}

/**
 * What each store is worth to this list. For a store you shop at: how much
 * more the list would cost without it. For one you've excluded: how much
 * adding it back would save. Items that can only be bought at that store are
 * counted separately rather than folded into the dollar figure.
 */
export function storeImpact(items, included, memberships = []) {
  const current = planFor(items, included, memberships);
  const out = {};
  for (const s of STORES) {
    const isIn = included.includes(s);
    const alt = planFor(items, isIn ? included.filter((x) => x !== s) : [...included, s], memberships);
    let delta = 0; // alt - current, over items buyable in both scenarios
    let onlyHere = 0; // items available in one scenario but not the other
    for (const it of items) {
      if (it.note != null) continue;
      const a = current.choice[it.id];
      const b = alt.choice[it.id];
      if (a && b) delta += costAt(it, b, memberships) - costAt(it, a, memberships);
      else if (a || b) onlyHere++;
    }
    delta = round2(delta);
    out[s] = isIn
      ? { included: true, itemsHere: current.byStore[s]?.items.length || 0, costIfExcluded: delta, itemsLostIfExcluded: onlyHere }
      : { included: false, savingIfIncluded: round2(-delta), itemsGainedIfIncluded: onlyHere };
  }
  return out;
}

/**
 * For an item pinned to a shop: whether it's being bought there, and if so
 * what that costs compared with the cheapest shop; if not, why not.
 */
function pinInfo(it, chosen, included, memberships) {
  if (!it.pinnedStore) return null;
  const store = it.pinnedStore;
  if (chosen !== store) {
    return { store, honoured: false, reason: !included.includes(store) ? 'shop-excluded' : 'not-available' };
  }
  const free = cheapestAmong({ ...it, pinnedStore: null }, included, memberships);
  const extra = free && free !== store ? round2(costAt(it, store, memberships) - costAt(it, free, memberships)) : 0;
  return { store, honoured: true, cheapest: free, extra: Math.max(0, extra) };
}

/** Everything the list page needs in one go. */
export function listView(listId, userId) {
  const summary = getListSummary(listId, userId);
  // Member prices are personal: each person on a shared list sees their own.
  const memberships = getUser(userId)?.memberships || [];
  const items = resolveItems(listId, summary.igaStoreId, memberships);
  const included = STORES.filter((s) => !summary.excludedStores.includes(s));
  const plan = planFor(items, included, memberships);
  const singleStore = Object.fromEntries(STORES.map((s) => {
    const p = planFor(items, [s], memberships);
    return [s, { total: p.total, missing: p.unavailable.length }];
  }));
  return {
    ...summary,
    igaStore: getStore(summary.igaStoreId),
    memberships,
    included,
    items: items.map((it) => {
      if (it.note != null) return { ...it, cheapest: null, lineTotal: null, betterValue: null, aisle: aisleFor({ name: it.note }) };
      const chosen = plan.choice[it.id];
      return {
        ...it,
        cheapest: chosen,
        aisle: aisleFor(chosen ? it.perStore[chosen].product : it.anchor),
        lineTotal: chosen ? costAt(it, chosen, memberships) : null,
        // A different pack size that's cheaper per kg / L / item, if there is one.
        betterValue: chosen ? betterValue(it.perStore[chosen].product, { igaStore: summary.igaStoreId, stores: included, memberships }) : null,
        pin: pinInfo(it, chosen, included, memberships),
        // Is now a good time to buy it? (From its price history.)
        priceInsight: chosen ? productInsight(it.perStore[chosen].product, summary.igaStoreId) : null,
      };
    }),
    plan: { byStore: plan.byStore, total: plan.total, unavailable: plan.unavailable, notes: plan.notes },
    impact: storeImpact(items, included, memberships),
    singleStore,
    aisles: AISLES,
    layouts: layoutsFor(userId), // the section order this shopper walks each shop in, once learned
  };
}

// ---------------------------------------------------------------- in the shop

/** Tick an item off (or un-tick it) while shopping; everyone on the list sees it. */
export function setChecked(itemId, userId, checked) {
  requireMember(itemListId(itemId), userId);
  getDb().prepare('UPDATE list_items SET checked_at = ?, checked_by = ? WHERE id = ?')
    .run(checked ? nowIso() : null, checked ? userId : null, itemId);
}

/** Finished shopping: remember what was bought (to repeat later) and take it off the list. */
export function finishShop(listId, userId) {
  requireMember(listId, userId);
  const d = getDb();
  const ticked = d.prepare('SELECT product_id, note, quantity, match_mode, pinned_store FROM list_items WHERE list_id = ? AND checked_at IS NOT NULL').all(listId);
  if (!ticked.length) throw httpError(400, 'Tick off what you bought first');
  const name = `Shop on ${new Date().toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
  const spent = shopCost(listId, userId);
  d.transaction(() => {
    const snapId = saveSnapshot(listId, userId, name, 'history', ticked);
    d.prepare('UPDATE list_snapshots SET spent = ?, spent_json = ? WHERE id = ?').run(spent.total, JSON.stringify(spent), snapId);
    d.prepare('DELETE FROM list_items WHERE list_id = ? AND checked_at IS NOT NULL').run(listId);
    // Keep the last 12 finished shops per list.
    d.prepare(`DELETE FROM list_snapshots WHERE list_id = ? AND kind = 'history' AND id NOT IN
      (SELECT id FROM list_snapshots WHERE list_id = ? AND kind = 'history' ORDER BY id DESC LIMIT 12)`).run(listId, listId);
  })();
  return { name, items: ticked.length };
}

/**
 * What the ticked items cost, split by shop as planned, and what the same
 * items would have cost at the single cheapest shop that has them all.
 */
function shopCost(listId, userId) {
  const summary = getListSummary(listId, userId);
  const memberships = getUser(userId)?.memberships || [];
  const items = resolveItems(listId, summary.igaStoreId, memberships).filter((it) => it.checkedAt && it.note == null);
  const included = STORES.filter((s) => !summary.excludedStores.includes(s));
  const plan = planFor(items, included, memberships);
  let oneShop = null;
  for (const s of STORES) {
    const p = planFor(items, [s], memberships);
    if (!p.unavailable.length && items.length && (!oneShop || p.total < oneShop.total)) oneShop = { store: s, total: p.total };
  }
  return {
    total: plan.total,
    byStore: Object.fromEntries(Object.entries(plan.byStore).filter(([, v]) => v.items.length).map(([k, v]) => [k, v.total])),
    items: items.length,
    oneShop,
  };
}

/** Finished shops with what they cost, newest first, plus totals. */
export function spending(listId, userId) {
  requireMember(listId, userId);
  const shops = getDb().prepare(`SELECT id, name, created_at, spent, spent_json FROM list_snapshots
    WHERE list_id = ? AND kind = 'history' AND spent IS NOT NULL ORDER BY id DESC`).all(listId)
    .map((r) => {
      const x = JSON.parse(r.spent_json || '{}');
      return {
        id: r.id, name: r.name, at: r.created_at, spent: r.spent, byStore: x.byStore || {}, items: x.items || 0,
        oneShop: x.oneShop || null, saved: x.oneShop ? round2(Math.max(0, x.oneShop.total - r.spent)) : 0,
      };
    });
  const months = {};
  for (const s of shops) {
    const m = s.at.slice(0, 7);
    months[m] = round2((months[m] || 0) + s.spent);
  }
  const since = (days) => shops.filter((s) => Date.now() - Date.parse(s.at) < days * 86400000);
  const sum = (list, k) => round2(list.reduce((n, s) => n + s[k], 0));
  return {
    shops,
    months: Object.entries(months).sort().map(([month, total]) => ({ month, total })),
    last30: sum(since(30), 'spent'),
    total: sum(shops, 'spent'),
    saved: sum(shops, 'saved'),
    average: shops.length ? round2(sum(shops, 'spent') / shops.length) : 0,
  };
}

// ---------------------------------------------------------------- saved & past shops

function saveSnapshot(listId, userId, name, kind, rows) {
  const items = rows.map((r) => (r.product_id == null
    ? { note: r.note, quantity: r.quantity }
    : { productId: r.product_id, quantity: r.quantity, matchMode: r.match_mode, pinnedStore: r.pinned_store || undefined }));
  return getDb().prepare('INSERT INTO list_snapshots (list_id, name, kind, items_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(listId, name, kind, JSON.stringify(items), userId, nowIso()).lastInsertRowid;
}

/** Save what's on the list now as a "regular shop" you can add again any time. */
export function saveRegularShop(listId, userId, name) {
  requireMember(listId, userId);
  const rows = getDb().prepare('SELECT product_id, note, quantity, match_mode, pinned_store FROM list_items WHERE list_id = ?').all(listId);
  if (!rows.length) throw httpError(400, 'The list is empty');
  return { id: saveSnapshot(listId, userId, cleanName(name), 'saved', rows) };
}

export function listSnapshots(listId, userId) {
  requireMember(listId, userId);
  return getDb().prepare(`SELECT id, name, kind, items_json, created_at FROM list_snapshots WHERE list_id = ?
    ORDER BY kind = 'saved' DESC, id DESC`).all(listId)
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, items: JSON.parse(r.items_json).length }));
}

/** Add a saved or past shop's items to the list (skipping things already on it). */
export function addSnapshot(listId, userId, snapshotId) {
  requireMember(listId, userId);
  const d = getDb();
  const snap = d.prepare('SELECT * FROM list_snapshots WHERE id = ? AND list_id = ?').get(snapshotId, listId);
  if (!snap) throw httpError(404, 'Not found');
  let added = 0;
  for (const it of JSON.parse(snap.items_json)) {
    if (it.note != null) {
      if (d.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND product_id IS NULL AND lower(note) = lower(?)').get(listId, it.note)) continue;
      d.prepare('INSERT INTO list_items (list_id, note, quantity, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
        .run(listId, it.note, it.quantity, userId, nowIso());
      added++;
      continue;
    }
    if (!getProduct(it.productId)) continue;
    if (d.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND product_id = ?').get(listId, it.productId)) continue;
    d.prepare(`INSERT INTO list_items (list_id, product_id, quantity, match_mode, pinned_store, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(listId, it.productId, it.quantity, it.matchMode || 'similar', STORES.includes(it.pinnedStore) ? it.pinnedStore : null, userId, nowIso());
    added++;
  }
  return { added };
}

export function deleteSnapshot(listId, userId, snapshotId) {
  requireMember(listId, userId);
  getDb().prepare('DELETE FROM list_snapshots WHERE id = ? AND list_id = ?').run(snapshotId, listId);
}
