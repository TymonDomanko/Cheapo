// Price alerts ("tell me when this is cheaper") and the weekly "on special
// this week" email. Only sent to confirmed email addresses, and every email
// has a one-click unsubscribe link.

import { getDb, nowIso } from './db.js';
import { getProduct } from './compare.js';
import { getUser } from './auth.js';
import * as lists from './lists.js';
import { unitPriceFor } from './promos.js';
import { storeName } from './stores.js';
import { sendMail, emailHtml, siteUrl, siteName, escapeHtml as esc } from './mailer.js';
import { sign, verifySignature } from './secret.js';

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const money = (n) => `$${Number(n).toFixed(2)}`;

// ---------------------------------------------------------------- watches

export function setWatch(userId, productId, targetPrice = null) {
  const user = getUser(userId);
  const p = getProduct(productId, user.igaStoreId);
  if (!p) throw httpError(404, 'Unknown product');
  const target = targetPrice == null || targetPrice === '' ? null : Number(targetPrice);
  if (target != null && !(target > 0 && target < 10000)) throw httpError(400, 'Enter a price, like 3.50');
  getDb().prepare(`INSERT INTO watches (user_id, product_id, target_price, created_at, baseline_price)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, product_id) DO UPDATE SET target_price = excluded.target_price,
      baseline_price = excluded.baseline_price, last_notified_price = NULL, last_notified_at = NULL`)
    .run(userId, productId, target, nowIso(), unitPriceFor(p, user.memberships));
}

export function removeWatch(userId, productId) {
  getDb().prepare('DELETE FROM watches WHERE user_id = ? AND product_id = ?').run(userId, productId);
}

export function listWatches(userId) {
  const user = getUser(userId);
  return getDb().prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC').all(userId).map((w) => {
    const p = getProduct(w.product_id, user.igaStoreId);
    return { productId: w.product_id, targetPrice: w.target_price, baselinePrice: w.baseline_price, createdAt: w.created_at,
      product: p, price: p ? unitPriceFor(p, user.memberships) : null };
  });
}

// ---------------------------------------------------------------- unsubscribe links

export function unsubscribeUrl(base, userId, kind) {
  const value = `unsub:${userId}:${kind}`;
  return `${base}/api/unsubscribe?u=${userId}&k=${kind}&s=${sign(value)}`;
}

export function unsubscribe(userId, kind, signature) {
  if (!['weekly', 'price'].includes(kind) || !verifySignature(`unsub:${userId}:${kind}`, signature)) {
    throw httpError(400, 'This unsubscribe link isn’t valid');
  }
  const col = kind === 'weekly' ? 'alerts_weekly' : 'alerts_price';
  getDb().prepare(`UPDATE users SET ${col} = 0 WHERE id = ?`).run(Number(userId));
}

function footerHtml(base, userId, kind) {
  const what = kind === 'weekly' ? 'the weekly specials email' : 'price alerts';
  return `You’re getting this because you turned on ${what}. `
    + `<a href="${esc(unsubscribeUrl(base, userId, kind))}">Unsubscribe</a> · <a href="${esc(base)}/settings">Settings</a>`;
}

function mailHeaders(base, userId, kind) {
  // One-click unsubscribe (RFC 8058) for mail apps that show an Unsubscribe button.
  return { 'List-Unsubscribe': `<${unsubscribeUrl(base, userId, kind)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

const recipients = (col) => getDb().prepare(`SELECT id FROM users WHERE email_verified_at IS NOT NULL AND ${col} = 1`).all().map((r) => r.id);

// ---------------------------------------------------------------- price alerts (daily, after prices refresh)

/**
 * Email people whose watched products got cheaper: below their target price,
 * or (with no target) below the price when they started watching. Each drop is
 * reported once; if the price goes back up, a later drop is reported again.
 */
export async function sendPriceAlerts({ baseUrl = siteUrl() } = {}) {
  const d = getDb();
  const mark = d.prepare('UPDATE watches SET last_notified_price = ?, last_notified_at = ? WHERE user_id = ? AND product_id = ?');
  const rearm = d.prepare('UPDATE watches SET last_notified_price = NULL WHERE user_id = ? AND product_id = ?');
  let emails = 0;
  for (const userId of recipients('alerts_price')) {
    const user = getUser(userId);
    const hits = [];
    for (const w of d.prepare('SELECT * FROM watches WHERE user_id = ?').all(userId)) {
      const p = getProduct(w.product_id, user.igaStoreId);
      const price = p?.available ? unitPriceFor(p, user.memberships) : null;
      if (price == null) continue;
      const threshold = w.target_price ?? w.baseline_price;
      if (threshold == null) continue;
      const hit = w.target_price != null ? price <= threshold : price < threshold;
      if (!hit) {
        if (w.last_notified_price != null) rearm.run(userId, w.product_id);
        continue;
      }
      if (w.last_notified_price != null && price >= w.last_notified_price) continue; // already told them
      hits.push({ w, p, price });
    }
    if (!hits.length) continue;
    const lines = hits.map(({ w, p, price }) => `${p.name} (${storeName(p.store)}) — now ${money(price)}`
      + (w.target_price != null ? `, your target was ${money(w.target_price)}` : `, was ${money(w.baseline_price)}`));
    await sendMail({
      to: user.email,
      kind: 'price-alert',
      subject: hits.length === 1 ? `Price drop: ${hits[0].p.name}` : `${hits.length} things you’re watching are cheaper`,
      text: `Hi ${user.name},\n\n${lines.join('\n')}\n\n${baseUrl}\n\nUnsubscribe from price alerts: ${unsubscribeUrl(baseUrl, userId, 'price')}`,
      html: emailHtml({
        heading: hits.length === 1 ? 'A price you’re watching dropped' : `${hits.length} prices you’re watching dropped`,
        paragraphs: [`Hi ${user.name},`],
        extraHtml: `<ul style="padding-left:18px;font-size:15px;line-height:1.6">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
        button: { url: baseUrl, label: `Open ${siteName()}` },
        footer: footerHtml(baseUrl, userId, 'price'),
      }),
      headers: mailHeaders(baseUrl, userId, 'price'),
    });
    for (const { w, price } of hits) mark.run(price, nowIso(), userId, w.product_id);
    emails++;
  }
  return { emails };
}

// ---------------------------------------------------------------- weekly specials digest

/** Things on your lists (at the shop you'd buy them from) that are on special or multi-buy right now. */
export function weeklyDeals(userId) {
  const user = getUser(userId);
  const deals = [];
  const seen = new Set();
  for (const l of lists.listsForUser(userId)) {
    const view = lists.listView(l.id, userId);
    for (const it of view.items) {
      const p = it.cheapest ? it.perStore[it.cheapest].product : null;
      if (!p || seen.has(p.id) || !(p.on_special || p.multi_qty || (p.member_price && user.memberships.includes(p.store)))) continue;
      seen.add(p.id);
      deals.push({ list: l.name, product: p, price: unitPriceFor(p, user.memberships) });
    }
  }
  return deals;
}

export async function sendWeeklyDigests({ baseUrl = siteUrl() } = {}) {
  let emails = 0;
  for (const userId of recipients('alerts_weekly')) {
    const user = getUser(userId);
    const deals = weeklyDeals(userId);
    if (!deals.length) continue;
    const line = ({ product: p, price }) => `${p.name} — ${money(price)} at ${storeName(p.store)}`
      + (p.was_price ? ` (was ${money(p.was_price)})` : '') + (p.promo_text ? ` · ${p.promo_text}` : '');
    await sendMail({
      to: user.email,
      kind: 'weekly',
      subject: `${deals.length} thing${deals.length === 1 ? '' : 's'} on your list${deals.length === 1 ? ' is' : 's are'} on special this week`,
      text: `Hi ${user.name},\n\nOn special this week:\n${deals.map(line).join('\n')}\n\n${baseUrl}/#list\n\nUnsubscribe: ${unsubscribeUrl(baseUrl, userId, 'weekly')}`,
      html: emailHtml({
        heading: 'On special this week',
        paragraphs: [`Hi ${user.name}, these are on your shopping lists and cheaper than usual right now:`],
        extraHtml: `<ul style="padding-left:18px;font-size:15px;line-height:1.6">${deals.map((x) => `<li>${esc(line(x))}</li>`).join('')}</ul>`,
        button: { url: `${baseUrl}/#list`, label: 'Open my list' },
        footer: footerHtml(baseUrl, userId, 'weekly'),
      }),
      headers: mailHeaders(baseUrl, userId, 'weekly'),
    });
    emails++;
  }
  return { emails };
}
