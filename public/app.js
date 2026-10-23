const STORES = ['woolworths', 'coles', 'aldi'];
const STORE_NAMES = { woolworths: 'Woolworths', coles: 'Coles', aldi: 'ALDI' };

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const dot = (s) => `<i class="dot ${s}"></i>`;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 50,
    background: 'var(--text)', color: 'var(--bg)', padding: '8px 14px', borderRadius: '8px', fontSize: '14px',
  });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === 'list') loadList();
  if (name === 'changes') loadChanges();
  if (name === 'data') loadStats();
  history.replaceState(null, '', `#${name}`);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) {
    e.preventDefault();
    showTab(a.dataset.goto);
  }
});

// ------------------------------------------------------------------ stats

let statsCache = null;
async function refreshStats() {
  statsCache = await api('/api/stats');
  $('#demo-banner').hidden = !statsCache.demo;
  $('#list-count').textContent = statsCache.listCount;
  return statsCache;
}

// ------------------------------------------------------------------ compare / search

let searchTimer;
let searchSeq = 0;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}
['#q', '#store-filter', '#mode-filter', '#specials'].forEach((s) => {
  $(s).addEventListener('input', scheduleSearch);
});
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

async function runSearch() {
  const seq = ++searchSeq;
  const params = new URLSearchParams({
    q: $('#q').value.trim(),
    store: $('#store-filter').value,
    mode: $('#mode-filter').value,
    specials: $('#specials').checked ? '1' : '',
  });
  const box = $('#results');
  try {
    const groups = await api(`/api/search?${params}`);
    if (seq !== searchSeq) return;
    if (!groups.length) {
      const empty = statsCache && statsCache.stores.every((s) => !s.products);
      box.innerHTML = `<div class="empty">${empty
        ? 'No products yet. Go to <a href="#" data-goto="data">Data</a> to fetch prices (or run <code>npm run seed:demo</code> to try it out).'
        : 'No matching products.'}</div>`;
      return;
    }
    box.innerHTML = `<div class="row head"><span></span><span>Product</span>${STORES.map((s) => `<span>${dot(s)} ${STORE_NAMES[s]}</span>`).join('')}<span></span></div>`
      + groups.map(renderGroup).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`;
  }
}

function thumb(p) {
  return p.image_url
    ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="thumb none">no image</div>';
}

function priceCell(store, match, cheapest, anchor) {
  if (!match) return `<div class="cell none"><span class="store-label">${dot(store)}${STORE_NAMES[store]}</span>—</div>`;
  const p = match.product;
  const alt = p.id !== anchor.id && p.name !== anchor.name ? `<span class="alt" title="${esc(p.name)}">${esc(p.name)}</span>` : '';
  return `<div class="cell ${store === cheapest ? 'cheapest' : ''}">
    <span class="store-label">${dot(store)}${STORE_NAMES[store]}</span>
    <span><span class="price">${money(p.price)}</span>${p.was_price ? `<span class="was">${money(p.was_price)}</span>` : ''}
    <span class="unit">${store === cheapest ? '<span class="badge cheap">✓ Cheapest</span>' : ''}${p.on_special ? '<span class="badge special">Special</span>' : ''}${esc(p.unit_price_text || '')}</span>${alt}</span>
  </div>`;
}

function renderGroup(g) {
  const a = g.anchor;
  const n = g.members.length;
  return `<div class="row">
    ${thumb(a)}
    <div class="title" data-product="${a.id}">
      <strong>${esc(a.name)}</strong>
      <span class="meta">${esc(a.size_text || '')} · ${n > 1 ? `${n} equivalent products` : 'no equivalents found'}</span>
    </div>
    ${STORES.map((s) => priceCell(s, g.best[s], g.cheapest, a)).join('')}
    <button class="add small" data-add="${a.id}">+ List</button>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    await api('/api/list', { method: 'POST', body: { productId: Number(add.dataset.add) } });
    toast('Added to shopping list');
    refreshStats();
    return;
  }
  const prod = e.target.closest('[data-product]');
  if (prod) {
    e.preventDefault();
    openProduct(Number(prod.dataset.product));
  }
});

// ------------------------------------------------------------------ product detail + price history chart

let chart;
async function openProduct(id) {
  const dlg = $('#product-dialog');
  const box = $('#product-detail');
  box.innerHTML = '<p class="hint">Loading…</p>';
  if (!dlg.open) dlg.showModal();
  const d = await api(`/api/products/${id}`);
  const p = d.product;
  const s = d.stats;
  box.innerHTML = `
    <div class="detail-head">
      ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div>
        <h2>${esc(p.name)}</h2>
        <div class="hint">${dot(p.store)} ${STORE_NAMES[p.store]} · ${esc(p.size_text || '')} · ${esc(p.category || '')}</div>
        <div><strong>${money(p.price)}</strong> ${p.was_price ? `<span class="hint"><s>${money(p.was_price)}</s></span>` : ''}
          ${s ? `<span class="hint">· lowest ${money(s.min)}, highest ${money(s.max)}, ${s.changes} change${s.changes === 1 ? '' : 's'} since ${fmtDate(s.since)}</span>` : ''}</div>
        <p>
          <button class="small" data-add="${p.id}">+ Add to list</button>
          ${p.product_url ? `<a href="${esc(p.product_url)}" target="_blank" rel="noopener">View on ${STORE_NAMES[p.store]} ↗</a>` : ''}
        </p>
      </div>
    </div>
    <h3>Price history</h3>
    <div class="legend">${d.charted.map((c) => `<span>${dot(c.store)} ${esc(c.name)} (${STORE_NAMES[c.store]})</span>`).join('')}</div>
    <div class="chart-wrap"><canvas id="history-chart" aria-label="Price history chart"></canvas></div>
    <details><summary>Price history table</summary>${historyTable(d)}</details>
    <h3>Equivalent products</h3>
    <div class="table-scroll"><table class="data">
      <thead><tr><th>Store</th><th>Product</th><th class="num">Price</th><th class="num">Unit price</th><th class="num">Match</th><th></th></tr></thead>
      <tbody>${d.equivalents.sort((a, b) => a.price - b.price).map((x) => `<tr>
        <td>${dot(x.store)} ${STORE_NAMES[x.store]}</td>
        <td><a href="#" data-product="${x.id}">${esc(x.name)}</a> ${x.on_special ? '<span class="tag-special">SPECIAL</span>' : ''}</td>
        <td class="num">${money(x.price)}</td>
        <td class="num">${esc(x.unit_price_text || '')}</td>
        <td class="num">${Math.round(x.score * 100)}%</td>
        <td><button class="small" data-add="${x.id}">+ List</button></td></tr>`).join('')}</tbody>
    </table></div>`;
  drawHistory(d);
}

function historyTable(d) {
  const byId = Object.fromEntries(d.charted.map((c) => [c.id, c]));
  const rows = [...d.history].reverse();
  return `<table class="data"><thead><tr><th>Date</th><th>Store</th><th>Product</th><th class="num">Price</th></tr></thead><tbody>
    ${rows.map((h) => `<tr><td>${fmtDate(h.recorded_at)}</td><td>${dot(byId[h.product_id].store)} ${STORE_NAMES[byId[h.product_id].store]}</td>
      <td>${esc(byId[h.product_id].name)}</td><td class="num">${money(h.price)}${h.on_special ? ' <span class="tag-special">SPECIAL</span>' : ''}</td></tr>`).join('')}
  </tbody></table>`;
}

function drawHistory(d) {
  if (chart) chart.destroy();
  const now = Date.now();
  const datasets = d.charted.map((c) => {
    const pts = d.history.filter((h) => h.product_id === c.id).map((h) => ({ x: Date.parse(h.recorded_at), y: h.price, special: !!h.on_special }));
    // Prices hold until they change, so carry the latest price through to today.
    if (pts.length && c.price != null) pts.push({ x: now, y: c.price, special: !!c.on_special });
    const color = cssVar(`--${c.store}`);
    return {
      label: `${c.name} (${STORE_NAMES[c.store]})`,
      data: pts,
      stepped: 'before',
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHitRadius: 10,
    };
  });
  const grid = cssVar('--border');
  const ink = cssVar('--text-2');
  chart = new Chart($('#history-chart'), {
    type: 'line',
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false }, // HTML legend above the chart
        tooltip: {
          callbacks: {
            title: (items) => fmtDate(items[0].parsed.x),
            label: (it) => ` ${STORE_NAMES[d.charted[it.datasetIndex].store]}: ${money(it.parsed.y)}${it.raw.special ? ' (special)' : ''}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: datasets.some((ds) => ds.data.length) ? Math.min(...datasets.flatMap((ds) => ds.data.map((pt) => pt.x))) : undefined,
          max: now,
          ticks: { color: ink, maxTicksLimit: 6, callback: (v) => fmtDate(v) },
          grid: { display: false },
        },
        y: {
          ticks: { color: ink, callback: (v) => `$${Number(v).toFixed(2)}` },
          grid: { color: grid },
          beginAtZero: false,
        },
      },
    },
  });
}

// ------------------------------------------------------------------ shopping list

function listStores() {
  return $$('#list-stores input:checked').map((i) => i.value);
}
$$('#list-stores input').forEach((i) => i.addEventListener('change', loadList));

async function loadList() {
  const stores = listStores();
  const [items, plan] = await Promise.all([
    api(`/api/list?stores=${stores.join(',')}`),
    api(`/api/order/plan?stores=${stores.join(',')}`),
  ]);
  $('#list-count').textContent = items.length;
  const box = $('#list');
  if (!items.length) {
    box.innerHTML = '<div class="empty">Your list is empty. Search on the <a href="#" data-goto="compare">Compare</a> tab and press “+ List”.</div>';
    $('#list-summary').innerHTML = '';
    $('#order-btn').disabled = true;
    return;
  }
  $('#order-btn').disabled = false;
  box.innerHTML = items.map((it) => renderItem(it, stores)).join('');
  $('#list-summary').innerHTML = renderSummary(plan);
}

function renderItem(it, stores) {
  const a = it.anchor;
  return `<div class="item" data-item="${it.id}">
    <div class="item-top">
      <div class="name" data-product="${a.id}"><strong>${esc(a.name)}</strong>
        <div class="meta">${esc(a.size_text || '')}${!a.available ? ' · <span class="warn">no longer available</span>' : ''}</div></div>
      <label class="check">Qty <input class="qty" type="number" min="1" value="${it.quantity}" data-qty></label>
      <select data-mode aria-label="Matching">
        <option value="similar" ${it.matchMode === 'similar' ? 'selected' : ''}>Any brand, same size</option>
        <option value="exact" ${it.matchMode === 'exact' ? 'selected' : ''}>Same brand only</option>
        <option value="this" ${it.matchMode === 'this' ? 'selected' : ''}>This exact product</option>
      </select>
      <button class="small ghost" data-remove>Remove</button>
    </div>
    <div class="store-picks">${STORES.map((s) => renderPick(it, s, stores.includes(s))).join('')}</div>
  </div>`;
}

function renderPick(it, store, enabled) {
  const ps = it.perStore[store] || {};
  const win = it.cheapest === store;
  const p = ps.product;
  const opts = [
    `<option value="auto" ${!ps.manual && !ps.excluded ? 'selected' : ''}>Auto: cheapest match</option>`,
    ...ps.candidates.map((c) => `<option value="${c.id}" ${ps.manual && p?.id === c.id ? 'selected' : ''}>${esc(c.name)} — ${money(c.price)}</option>`),
    // A manually picked product that isn't among the automatic matches.
    ...(ps.manual && p && !ps.candidates.some((c) => c.id === p.id) ? [`<option value="${p.id}" selected>${esc(p.name)} — ${money(p.price)}</option>`] : []),
    `<option value="exclude" ${ps.excluded ? 'selected' : ''}>Don't buy here</option>`,
  ];
  return `<div class="pick ${win ? 'win' : ''} ${ps.excluded || !enabled ? 'excluded' : ''}">
    <div class="ph"><span class="store">${dot(store)}${STORE_NAMES[store]}</span>
      <span class="price">${p && !ps.excluded ? money(p.price * it.quantity) : '—'}</span></div>
    <span class="pname" title="${esc(p?.name || '')}">${ps.excluded ? 'Excluded' : p ? `${esc(p.name)}${win ? ' · <strong class="saving">cheapest</strong>' : ''}` : 'No match found'}</span>
    <select data-pick="${store}" aria-label="${STORE_NAMES[store]} product">${opts.join('')}</select>
  </div>`;
}

function renderSummary(plan) {
  const tiles = plan.stores.filter((s) => plan.byStore[s].items.length).map((s) => `
    <div class="tile"><div class="label">${dot(s)} ${STORE_NAMES[s]}${plan.online[s] ? '' : ' (in-store)'}</div>
      <div class="value">${money(plan.byStore[s].total)}</div>
      <div class="note">${plan.byStore[s].items.length} item${plan.byStore[s].items.length === 1 ? '' : 's'}</div></div>`);
  const singles = plan.stores.map((s) => {
    const x = plan.singleStore[s];
    const saving = x.total - plan.total;
    return `<div class="tile"><div class="label">Everything at ${STORE_NAMES[s]}</div>
      <div class="value">${money(x.total)}</div>
      <div class="note">${x.missing ? `<span class="warn">${x.missing} item${x.missing === 1 ? '' : 's'} not available</span>` : saving > 0.005 ? `Split saves <span class="saving">${money(saving)}</span>` : 'Same as split'}</div></div>`;
  });
  return `<h2>Total</h2>
    <div class="totals">
      <div class="tile hero"><div class="label">Cheapest split</div><div class="value">${money(plan.total)}</div>
        <div class="note">${plan.itemCount} item${plan.itemCount === 1 ? '' : 's'}${plan.unavailable.length ? ` · <span class="warn">${plan.unavailable.length} unavailable</span>` : ''}</div></div>
      ${tiles.join('')}
    </div>
    <h2 style="margin-top:16px">Compared with one shop</h2>
    <div class="totals">${singles.join('')}</div>`;
}

$('#list').addEventListener('change', async (e) => {
  const item = e.target.closest('[data-item]');
  if (!item) return;
  const id = item.dataset.item;
  if (e.target.matches('[data-qty]')) {
    await api(`/api/list/${id}`, { method: 'PATCH', body: { quantity: Number(e.target.value) } });
  } else if (e.target.matches('[data-mode]')) {
    await api(`/api/list/${id}`, { method: 'PATCH', body: { matchMode: e.target.value } });
  } else if (e.target.matches('[data-pick]')) {
    const v = e.target.value;
    await api(`/api/list/${id}/stores/${e.target.dataset.pick}`, {
      method: 'PUT',
      body: { productId: v === 'exclude' ? null : v === 'auto' ? 'auto' : Number(v) },
    });
  }
  loadList();
});
$('#list').addEventListener('click', async (e) => {
  if (!e.target.matches('[data-remove]')) return;
  await api(`/api/list/${e.target.closest('[data-item]').dataset.item}`, { method: 'DELETE' });
  loadList();
});
$('#clear-list').addEventListener('click', async () => {
  if (!confirm('Remove everything from your shopping list?')) return;
  await api('/api/list', { method: 'DELETE' });
  loadList();
});

// ------------------------------------------------------------------ ordering

$('#order-btn').addEventListener('click', async () => {
  const stores = listStores();
  const plan = await api(`/api/order/plan?stores=${stores.join(',')}`);
  const box = $('#order-detail');
  const sections = plan.stores.filter((s) => plan.byStore[s].items.length).map((s) => `
    <h3>${dot(s)} ${STORE_NAMES[s]} — ${money(plan.byStore[s].total)} ${plan.online[s] ? '' : '<span class="hint">(no online ordering — printable in-store list)</span>'}</h3>
    <table class="data"><thead><tr><th>Qty</th><th>Product</th><th class="num">Each</th><th class="num">Total</th></tr></thead><tbody>
    ${plan.byStore[s].items.map((i) => `<tr><td>${i.quantity}</td><td>${i.product.product_url ? `<a href="${esc(i.product.product_url)}" target="_blank" rel="noopener">${esc(i.product.name)}</a>` : esc(i.product.name)}</td>
      <td class="num">${money(i.product.price)}</td><td class="num">${money(i.lineTotal)}</td></tr>`).join('')}
    </tbody></table>`);
  const online = plan.stores.filter((s) => plan.online[s] && plan.byStore[s].items.length);
  box.innerHTML = `<h2>Order the cheapest — ${money(plan.total)}</h2>
    ${plan.unavailable.length ? `<p class="warn">Not available anywhere: ${plan.unavailable.map((u) => esc(u.name)).join(', ')}</p>` : ''}
    ${sections.join('')}
    <p class="hint">${online.length
      ? `Pressing the button opens a browser window and adds these items to your ${online.map((s) => STORE_NAMES[s]).join(' and ')} trolley${online.length > 1 ? 's' : ''}. Log in there if asked. It stops at the trolley so you can choose delivery and pay. Nothing is bought automatically.`
      : 'Nothing here can be ordered online.'}</p>
    <p>
      ${online.length ? '<button id="place-order" class="primary">Fill my trolleys</button>' : ''}
      <button onclick="window.print()">Print list</button>
    </p>
    <div id="order-progress"></div>`;
  $('#order-dialog').showModal();
  $('#place-order')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/order', { method: 'POST', body: { stores } });
      pollOrder();
    } catch (err) {
      $('#order-progress').innerHTML = `<p class="warn">${esc(err.message)}</p>`;
      e.target.disabled = false;
    }
  });
});

async function pollOrder() {
  const st = await api('/api/order/status');
  const failed = Object.entries(st.results).flatMap(([s, r]) => (r.failed || []).map((f) => ({ ...f, store: s })));
  $('#order-progress').innerHTML = `<div class="order-log">${st.log.map((l) => esc(l.msg)).join('\n')}</div>
    ${failed.length ? `<p class="warn">Add these yourself:</p><ul>${failed.map((f) => `<li>${STORE_NAMES[f.store]}: <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a> × ${f.quantity}</li>`).join('')}</ul>` : ''}`;
  if (st.running) setTimeout(pollOrder, 1500);
}

// ------------------------------------------------------------------ price changes

$('#changes-days').addEventListener('change', loadChanges);
$('#changes-dir').addEventListener('change', loadChanges);
async function loadChanges() {
  const rows = await api(`/api/changes?days=${$('#changes-days').value}&direction=${$('#changes-dir').value}`);
  $('#changes').innerHTML = rows.length
    ? rows.map((r) => {
      const pct = ((r.new_price - r.old_price) / r.old_price) * 100;
      const up = pct > 0;
      return `<div class="change" data-product="${r.id}">
        <div><strong>${esc(r.name)}</strong><div class="meta">${dot(r.store)} ${STORE_NAMES[r.store]} · ${esc(r.size_text || '')} · ${fmtDate(r.recorded_at)}</div></div>
        <div class="hint">${money(r.old_price)} → <strong>${money(r.new_price)}</strong></div>
        <div class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</div>
      </div>`;
    }).join('')
    : '<div class="empty">No price changes in this period yet. Changes appear after prices are refreshed more than once.</div>';
}

// ------------------------------------------------------------------ data / scraping

let statsTimer;
async function loadStats() {
  const st = await refreshStats();
  $('#store-stats').innerHTML = st.stores.map((s) => {
    const r = s.lastRun;
    const status = s.status.running
      ? `Running… ${s.status.products} products<br><span class="hint">${esc(s.status.message)}</span>`
      : r ? `Last refresh ${fmtDate(r.started_at)}: <strong>${r.status}</strong>${r.error ? `<br><span class="warn">${esc(r.error)}</span>` : ` · ${r.price_changes} price changes`}` : 'Never refreshed';
    return `<div class="tile"><div class="label">${dot(s.store)} ${STORE_NAMES[s.store]}</div>
      <div class="value">${s.products.toLocaleString()}</div><div class="note">products · ${status}</div></div>`;
  }).join('');
  $('#cron-hint').textContent = st.scrapeCron ? `Also refreshes automatically (cron "${st.scrapeCron}").` : '';
  const running = st.stores.some((s) => s.status.running);
  $('#scrape-btn').disabled = running;
  clearTimeout(statsTimer);
  if (running && !$('#tab-data').hidden) statsTimer = setTimeout(loadStats, 3000);
}
$('#scrape-btn').addEventListener('click', async () => {
  await api('/api/scrape', { method: 'POST', body: {} });
  setTimeout(loadStats, 500);
});

// ------------------------------------------------------------------ boot

await refreshStats().catch(() => {});
const initial = location.hash.slice(1);
showTab(['compare', 'list', 'changes', 'data'].includes(initial) ? initial : 'compare');
runSearch();
