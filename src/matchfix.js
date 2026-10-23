// "Wrong match?" reports from shoppers, and the admin-confirmed fixes they
// turn into. A fix is a rule between two products: never (not the same item)
// or always (the same item). Rules apply to everyone's comparisons.

import { getDb, nowIso } from './db.js';
import { getProduct } from './compare.js';

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const pair = (a, b) => (a < b ? [a, b] : [b, a]);

export function setRule(aId, bId, kind, userId) {
  if (aId === bId) throw httpError(400, 'That’s the same product');
  if (!['never', 'always'].includes(kind)) throw httpError(400, 'Bad rule');
  const [a, b] = pair(aId, bId);
  getDb().prepare(`INSERT INTO match_rules (a_id, b_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (a_id, b_id) DO UPDATE SET kind = excluded.kind, created_by = excluded.created_by, created_at = excluded.created_at`)
    .run(a, b, kind, userId, nowIso());
}

export function removeRule(aId, bId) {
  const [a, b] = pair(aId, bId);
  getDb().prepare('DELETE FROM match_rules WHERE a_id = ? AND b_id = ?').run(a, b);
}

/**
 * A shopper says two products are (not) the same item. Admins' reports
 * take effect straight away; everyone else's wait for an admin.
 */
export function report({ userId, isAdmin, anchorId, productId, kind = 'not_same', note }) {
  if (!getProduct(anchorId) || !getProduct(productId)) throw httpError(400, 'Unknown product');
  if (!['not_same', 'same'].includes(kind)) throw httpError(400, 'Bad report');
  const d = getDb();
  const open = d.prepare(`SELECT id FROM match_reports WHERE status = 'open' AND kind = ?
    AND ((anchor_id = ? AND product_id = ?) OR (anchor_id = ? AND product_id = ?))`).get(kind, anchorId, productId, productId, anchorId);
  if (open && !isAdmin) return { id: open.id, status: 'open' };
  const id = d.prepare(`INSERT INTO match_reports (user_id, anchor_id, product_id, kind, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, anchorId, productId, kind, note ? String(note).slice(0, 300) : null, nowIso()).lastInsertRowid;
  if (isAdmin) return resolve(id, 'accept', userId);
  return { id, status: 'open' };
}

export function resolve(reportId, decision, adminId) {
  const d = getDb();
  const r = d.prepare('SELECT * FROM match_reports WHERE id = ?').get(reportId);
  if (!r) throw httpError(404, 'Report not found');
  if (decision === 'accept') setRule(r.anchor_id, r.product_id, r.kind === 'same' ? 'always' : 'never', adminId);
  const status = decision === 'accept' ? 'accepted' : 'dismissed';
  // Close every open report about the same pair.
  d.prepare(`UPDATE match_reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE status = 'open' AND kind = ?
    AND ((anchor_id = ? AND product_id = ?) OR (anchor_id = ? AND product_id = ?))`)
    .run(status, nowIso(), adminId, r.kind, r.anchor_id, r.product_id, r.product_id, r.anchor_id);
  d.prepare('UPDATE match_reports SET status = ?, resolved_at = COALESCE(resolved_at, ?), resolved_by = ? WHERE id = ?')
    .run(status, nowIso(), adminId, reportId);
  return { id: reportId, status };
}

/** Open reports for the admin queue, grouped by product pair with a count. */
export function openReports() {
  const rows = getDb().prepare(`SELECT r.id, r.anchor_id, r.product_id, r.kind, r.note, r.created_at, u.name AS reporter
    FROM match_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'open' ORDER BY r.created_at`).all();
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.kind}:${pair(r.anchor_id, r.product_id).join('-')}`;
    if (!groups.has(key)) groups.set(key, { ...r, count: 0, notes: [], a: getProduct(r.anchor_id), b: getProduct(r.product_id) });
    const g = groups.get(key);
    g.count++;
    if (r.note) g.notes.push(r.note);
  }
  return [...groups.values()];
}

export function listRules(limit = 200) {
  return getDb().prepare(`SELECT m.a_id, m.b_id, m.kind, m.created_at, pa.name AS a_name, pa.store AS a_store,
      pb.name AS b_name, pb.store AS b_store
    FROM match_rules m JOIN products pa ON pa.id = m.a_id JOIN products pb ON pb.id = m.b_id
    ORDER BY m.created_at DESC LIMIT ?`).all(limit);
}
