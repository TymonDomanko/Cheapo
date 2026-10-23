// Shopping lists: owned by a user, optionally shared with others (a
// household), each with its own items and choice of stores to shop at.

import crypto from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { STORES } from './stores.js';
import { getProduct, findEquivalents, bestPerStore } from './compare.js';
import { getStore, defaultStoreId } from './iga.js';
import { matchScore } from './matcher.js';

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

function clampQty(q) {
  return Math.min(99, Math.max(1, Number(q) | 0 || 1));
}

export function updateItem(itemId, userId, { quantity, matchMode }) {
  requireMember(itemListId(itemId), userId);
  const d = getDb();
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
export function resolveItems(listId, igaStore = null) {
  const d = getDb();
  const items = d.prepare(`SELECT i.*, u.name AS added_by_name FROM list_items i LEFT JOIN users u ON u.id = i.added_by
    WHERE i.list_id = ? ORDER BY i.added_at, i.id`).all(listId);
  const overrides = d.prepare(`SELECT o.* FROM list_item_overrides o JOIN list_items i ON i.id = o.item_id
    WHERE i.list_id = ?`).all(listId);
  return items.map((item) => {
    const anchor = getProduct(item.product_id, igaStore);
    const eq = findEquivalents(anchor, item.match_mode, igaStore);
    const best = bestPerStore(eq);
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
      anchor, perStore,
    };
  });
}

function buyable(ps) {
  return ps?.product && !ps.excluded && ps.product.available && ps.product.price != null;
}

function cheapestAmong(item, stores) {
  let best = null;
  for (const s of stores) {
    const ps = item.perStore[s];
    if (buyable(ps) && (!best || ps.product.price < item.perStore[best].product.price)) best = s;
  }
  return best;
}

/** Split resolved items across `stores`, each item going to its cheapest store. */
export function planFor(items, stores) {
  const byStore = Object.fromEntries(stores.map((s) => [s, { items: [], total: 0 }]));
  const unavailable = [];
  const choice = {};
  for (const it of items) {
    const s = cheapestAmong(it, stores);
    choice[it.id] = s;
    if (!s) {
      unavailable.push({ id: it.id, name: it.anchor.name });
      continue;
    }
    const p = it.perStore[s].product;
    const lineTotal = round2(p.price * it.quantity);
    byStore[s].items.push({ itemId: it.id, quantity: it.quantity, product: p, lineTotal });
    byStore[s].total = round2(byStore[s].total + lineTotal);
  }
  const total = round2(Object.values(byStore).reduce((n, s) => n + s.total, 0));
  return { stores, byStore, total, unavailable, choice };
}

/**
 * What each store is worth to this list. For a store you shop at: how much
 * more the list would cost without it. For one you've excluded: how much
 * adding it back would save. Items that can only be bought at that store are
 * counted separately rather than folded into the dollar figure.
 */
export function storeImpact(items, included) {
  const current = planFor(items, included);
  const out = {};
  for (const s of STORES) {
    const isIn = included.includes(s);
    const alt = planFor(items, isIn ? included.filter((x) => x !== s) : [...included, s]);
    let delta = 0; // alt - current, over items buyable in both scenarios
    let onlyHere = 0; // items available in one scenario but not the other
    for (const it of items) {
      const a = current.choice[it.id];
      const b = alt.choice[it.id];
      if (a && b) delta += (it.perStore[b].product.price - it.perStore[a].product.price) * it.quantity;
      else if (a || b) onlyHere++;
    }
    delta = round2(delta);
    out[s] = isIn
      ? { included: true, itemsHere: current.byStore[s]?.items.length || 0, costIfExcluded: delta, itemsLostIfExcluded: onlyHere }
      : { included: false, savingIfIncluded: round2(-delta), itemsGainedIfIncluded: onlyHere };
  }
  return out;
}

/** Everything the list page needs in one go. */
export function listView(listId, userId) {
  const summary = getListSummary(listId, userId);
  const items = resolveItems(listId, summary.igaStoreId);
  const included = STORES.filter((s) => !summary.excludedStores.includes(s));
  const plan = planFor(items, included);
  const singleStore = Object.fromEntries(STORES.map((s) => {
    const p = planFor(items, [s]);
    return [s, { total: p.total, missing: p.unavailable.length }];
  }));
  return {
    ...summary,
    igaStore: getStore(summary.igaStoreId),
    included,
    items: items.map((it) => ({ ...it, cheapest: plan.choice[it.id] })),
    plan: { byStore: plan.byStore, total: plan.total, unavailable: plan.unavailable },
    impact: storeImpact(items, included),
    singleStore,
  };
}
