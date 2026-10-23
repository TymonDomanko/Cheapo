const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const dot = (s) => `<i class="dot" style="background:var(--store-${esc(s)})"></i>`;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const state = {
  config: null, // { user, stores, allowSignups, trolleyFill }
  stores: [], // ids in display order
  names: {},
  lists: [],
  listId: null,
  list: null,
};
const user = () => state.config?.user;
const storeName = (s) => state.names[s] || s;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}

// ================================================================== boot & config

async function loadConfig() {
  state.config = await api('/api/config');
  state.stores = state.config.stores.map((s) => s.id);
  state.names = Object.fromEntries(state.config.stores.map((s) => [s.id, s.name]));
  $('#store-names').textContent = state.config.stores.map((s) => s.name).join(' · ');
  $('#store-filter').innerHTML = '<option value="">All stores</option>'
    + state.config.stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  renderAccount();
}

function renderAccount() {
  const u = user();
  $('#admin-tab').hidden = !u?.isAdmin;
  $('#account').innerHTML = u
    ? `<span class="who">${esc(u.name)}</span> <button class="small ghost" id="logout">Log out</button>`
    : '<button class="small" id="login-btn">Log in</button>'
      + (state.config.allowSignups ? ' <button class="small primary" id="signup-btn">Sign up</button>' : '');
  $('#logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });
  $('#login-btn')?.addEventListener('click', () => openAuth('login'));
  $('#signup-btn')?.addEventListener('click', () => openAuth('signup'));
}

// ================================================================== tabs

function showTab(name) {
  if (name === 'admin' && !user()?.isAdmin) name = 'compare';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  if (name === 'list') loadList();
  if (name === 'changes') loadChanges();
  if (name === 'admin') loadAdmin();
  if (location.pathname === '/') history.replaceState(null, '', `#${name}`);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) {
    e.preventDefault();
    showTab(a.dataset.goto);
  }
});
const currentTab = () => $('.tabs [aria-selected="true"]')?.dataset.tab;

// ================================================================== auth dialog

let authMode = 'login';
let afterAuth = null;

function openAuth(mode = 'login', reason = '', then = null) {
  setAuthMode(state.config.allowSignups ? mode : 'login');
  $('.auth-switch [data-auth="signup"]').hidden = !state.config.allowSignups;
  $('#auth-reason').textContent = reason;
  $('#auth-error').hidden = true;
  afterAuth = then;
  $('#auth-dialog').showModal();
}

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.auth === mode)));
  $$('[data-signup-only]').forEach((el) => (el.hidden = mode !== 'signup'));
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  $('#auth-form [name=password]').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
}
$$('.auth-switch button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { email: f.get('email'), password: f.get('password'), name: f.get('name') };
  try {
    await api(`/api/auth/${authMode}`, { method: 'POST', body });
    $('#auth-dialog').close();
    e.target.reset();
    await loadConfig();
    state.lists = [];
    state.listId = null;
    if (afterAuth) await afterAuth();
    else toast(`Welcome, ${user().name}`);
    if (currentTab() === 'list') loadList();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').hidden = false;
  }
});

function requireLogin(reason, then) {
  if (user()) return true;
  openAuth('signup', reason, then);
  return false;
}

// ================================================================== compare / search

let searchTimer;
let searchSeq = 0;
['#q', '#store-filter', '#mode-filter', '#specials'].forEach((s) => $(s).addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}));
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
      box.innerHTML = '<div class="empty">No matching products.</div>';
      return;
    }
    box.style.setProperty('--store-cols', state.stores.length);
    box.innerHTML = `<div class="row head"><span></span><span>Product</span>${state.stores.map((s) => `<span>${dot(s)} ${esc(storeName(s))}</span>`).join('')}<span></span></div>`
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
  const label = `<span class="store-label">${dot(store)}${esc(storeName(store))}</span>`;
  if (!match) return `<div class="cell none">${label}—</div>`;
  const p = match.product;
  const alt = p.id !== anchor.id && p.name !== anchor.name ? `<span class="alt" title="${esc(p.name)}">${esc(p.name)}</span>` : '';
  return `<div class="cell ${store === cheapest ? 'cheapest' : ''}">${label}
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
    ${state.stores.map((s) => priceCell(s, g.best[s], g.cheapest, a)).join('')}
    <button class="add small" data-add="${a.id}">+ List</button>
  </div>`;
}

async function addToList(productId) {
  if (!requireLogin('Sign up or log in to keep a shopping list.', () => addToList(productId))) return;
  await ensureLists();
  const list = state.lists.find((l) => l.id === state.listId);
  await api(`/api/lists/${state.listId}/items`, { method: 'POST', body: { productId } });
  toast(`Added to ${list?.name || 'your list'}`);
  refreshListCount();
}

document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    try {
      await addToList(Number(add.dataset.add));
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const prod = e.target.closest('[data-product]');
  if (prod) {
    e.preventDefault();
    openProduct(Number(prod.dataset.product));
  }
});

// ================================================================== product detail + history chart

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
        <div class="hint">${dot(p.store)} ${esc(storeName(p.store))} · ${esc(p.size_text || '')} · ${esc(p.category || '')}</div>
        <div><strong>${money(p.price)}</strong> ${p.was_price ? `<span class="hint"><s>${money(p.was_price)}</s></span>` : ''}
          ${s ? `<span class="hint">· lowest ${money(s.min)}, highest ${money(s.max)}, ${plural(s.changes, 'change')} since ${fmtDate(s.since)}</span>` : ''}</div>
        <p>
          <button class="small" data-add="${p.id}">+ Add to list</button>
          ${p.product_url ? `<a href="${esc(p.product_url)}" target="_blank" rel="noopener">View on ${esc(storeName(p.store))} ↗</a>` : ''}
        </p>
      </div>
    </div>
    <h3>Price history</h3>
    <div class="legend">${d.charted.map((c) => `<span>${dot(c.store)} ${esc(c.name)} (${esc(storeName(c.store))})</span>`).join('')}</div>
    <div class="chart-wrap"><canvas id="history-chart" aria-label="Price history chart"></canvas></div>
    <details><summary>Price history table</summary><div class="table-scroll">${historyTable(d)}</div></details>
    <h3>Equivalent products</h3>
    <div class="table-scroll"><table class="data">
      <thead><tr><th>Store</th><th>Product</th><th class="num">Price</th><th class="num">Unit price</th><th class="num">Match</th><th></th></tr></thead>
      <tbody>${d.equivalents.sort((a, b) => a.price - b.price).map((x) => `<tr>
        <td>${dot(x.store)} ${esc(storeName(x.store))}</td>
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
  return `<table class="data"><thead><tr><th>Date</th><th>Store</th><th>Product</th><th class="num">Price</th></tr></thead><tbody>
    ${[...d.history].reverse().map((h) => {
      const c = byId[h.product_id];
      return `<tr><td>${fmtDate(h.recorded_at)}</td><td>${dot(c.store)} ${esc(storeName(c.store))}</td>
      <td>${esc(c.name)}</td><td class="num">${money(h.price)}${h.on_special ? ' <span class="tag-special">SPECIAL</span>' : ''}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

function drawHistory(d) {
  if (chart) chart.destroy();
  const now = Date.now();
  const datasets = d.charted.map((c) => {
    const pts = d.history.filter((h) => h.product_id === c.id).map((h) => ({ x: Date.parse(h.recorded_at), y: h.price, special: !!h.on_special }));
    // Prices hold until they change, so carry the latest price through to today.
    if (pts.length && c.price != null) pts.push({ x: now, y: c.price, special: !!c.on_special });
    const color = cssVar(`--store-${c.store}`);
    return {
      label: `${c.name} (${storeName(c.store)})`,
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
  const xs = datasets.flatMap((ds) => ds.data.map((pt) => pt.x));
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
            label: (it) => ` ${storeName(d.charted[it.datasetIndex].store)}: ${money(it.parsed.y)}${it.raw.special ? ' (special)' : ''}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: xs.length ? Math.min(...xs) : undefined,
          max: now,
          ticks: { color: ink, maxTicksLimit: 6, callback: (v) => fmtDate(v) },
          grid: { display: false },
        },
        y: {
          ticks: { color: ink, callback: (v) => `$${Number(v).toFixed(2)}` },
          grid: { color: cssVar('--border') },
        },
      },
    },
  });
}

// ================================================================== lists

async function ensureLists() {
  if (!state.lists.length) state.lists = await api('/api/lists');
  if (!state.lists.length) state.lists = [await api('/api/lists', { method: 'POST', body: { name: 'My list' } })];
  const saved = Number(localStorage.getItem('listId'));
  if (!state.lists.some((l) => l.id === state.listId)) {
    state.listId = state.lists.some((l) => l.id === saved) ? saved : state.lists[0].id;
  }
}

function selectList(id) {
  state.listId = id;
  try {
    localStorage.setItem('listId', String(id));
  } catch {
    /* private mode */
  }
}

async function refreshListCount() {
  if (!user()) return;
  state.lists = await api('/api/lists');
  await ensureLists();
  const l = state.lists.find((x) => x.id === state.listId);
  $('#list-count').hidden = !l;
  if (l) $('#list-count').textContent = l.item_count;
}

async function loadList() {
  const root = $('#list-root');
  if (!user()) {
    root.innerHTML = `<div class="empty">
      <p>Log in to build shopping lists. You can share a list with your household so everyone can add to it.</p>
      <p><button class="primary" id="list-login">Sign up or log in</button></p></div>`;
    $('#list-login').addEventListener('click', () => openAuth('signup', '', loadList));
    return;
  }
  state.lists = await api('/api/lists');
  await ensureLists();
  selectList(state.listId);
  try {
    state.list = await api(`/api/lists/${state.listId}`);
  } catch (e) {
    if (e.status === 404) {
      state.lists = [];
      state.listId = null;
      return loadList();
    }
    throw e;
  }
  renderList();
  refreshListCount();
}

function renderList() {
  const L = state.list;
  const isOwner = L.role === 'owner';
  const others = L.members.filter((m) => m.id !== user().id);
  $('#list-root').innerHTML = `
    <div class="list-head">
      <div class="list-picker">
        <select id="list-select" aria-label="Shopping list">
          ${state.lists.map((l) => `<option value="${l.id}" ${l.id === L.id ? 'selected' : ''}>${esc(l.name)}${l.member_count > 1 ? ' (shared)' : ''}</option>`).join('')}
        </select>
        <button class="small ghost" id="new-list">+ New list</button>
        <button class="small ghost" id="rename-list">Rename</button>
        ${isOwner ? '<button class="small ghost" id="delete-list">Delete</button>' : '<button class="small ghost" id="leave-list">Leave</button>'}
      </div>
      <div class="actions">
        <button class="small" id="share-list">Share${others.length ? ` · ${others.length + 1} people` : ''}</button>
        <button class="small ghost" id="clear-list" ${L.items.length ? '' : 'disabled'}>Clear</button>
        <button class="primary" id="order-btn" ${L.items.length ? '' : 'disabled'}>Order cheapest</button>
      </div>
    </div>
    ${others.length ? `<p class="hint">Shared with ${others.map((m) => esc(m.name)).join(', ')}. Changes anyone makes show up for everyone.</p>` : ''}
    ${renderStorePanel(L)}
    <div id="items">${L.items.length ? L.items.map(renderItem).join('') : '<div class="empty">This list is empty. Search on the <a href="#" data-goto="compare">Compare</a> tab and press “+ List”.</div>'}</div>
    ${L.items.length ? renderSummary(L) : ''}`;
}

/** Store on/off toggles, each saying what including or excluding it is worth. */
function renderStorePanel(L) {
  if (!L.items.length) {
    return `<div class="store-panel"><h2>Where you shop</h2><div class="store-cards">
      ${state.stores.map((s) => storeToggle(s, L.included.includes(s), '')).join('')}</div></div>`;
  }
  return `<div class="store-panel"><h2>Where you shop</h2>
    <p class="hint">Untick a shop to stop buying from it. Each card shows what that shop is worth for this list.</p>
    <div class="store-cards">${state.stores.map((s) => {
      const im = L.impact[s];
      let note;
      if (im.included) {
        const parts = [];
        if (im.costIfExcluded > 0.004) parts.push(`<span class="saving">Saving you ${money(im.costIfExcluded)}</span>`);
        if (im.itemsLostIfExcluded) parts.push(`<span class="warn">only shop with ${plural(im.itemsLostIfExcluded, 'item')}</span>`);
        note = parts.length ? parts.join(' · ') : '<span class="muted">Not needed — dropping it costs nothing</span>';
        if (im.itemsHere) note += `<br><span class="muted">${plural(im.itemsHere, 'item')} from here</span>`;
      } else {
        const parts = [];
        if (im.savingIfIncluded > 0.004) parts.push(`<span class="cost">Costing you ${money(im.savingIfIncluded)}</span>`);
        if (im.itemsGainedIfIncluded) parts.push(`<span class="warn">has ${plural(im.itemsGainedIfIncluded, 'item')} you can’t get elsewhere</span>`);
        note = parts.length ? parts.join(' · ') : '<span class="muted">Wouldn’t save you anything</span>';
      }
      return storeToggle(s, im.included, note);
    }).join('')}</div></div>`;
}

function storeToggle(s, on, note) {
  return `<label class="store-card ${on ? 'on' : 'off'}">
    <span class="store-card-head"><input type="checkbox" data-store-toggle="${s}" ${on ? 'checked' : ''}> ${dot(s)} <strong>${esc(storeName(s))}</strong></span>
    ${note ? `<span class="store-note">${note}</span>` : ''}
  </label>`;
}

function renderItem(it) {
  const a = it.anchor;
  const L = state.list;
  return `<div class="item" data-item="${it.id}">
    <div class="item-top">
      <div class="name" data-product="${a.id}"><strong>${esc(a.name)}</strong>
        <div class="meta">${esc(a.size_text || '')}${!a.available ? ' · <span class="warn">no longer available</span>' : ''}${it.addedBy && L.members.length > 1 ? ` · added by ${esc(it.addedBy)}` : ''}</div></div>
      <label class="check">Qty <input class="qty" type="number" min="1" max="99" value="${it.quantity}" data-qty></label>
      <select data-mode aria-label="Matching">
        <option value="similar" ${it.matchMode === 'similar' ? 'selected' : ''}>Any brand, same size</option>
        <option value="exact" ${it.matchMode === 'exact' ? 'selected' : ''}>Same brand only</option>
        <option value="this" ${it.matchMode === 'this' ? 'selected' : ''}>This exact product</option>
      </select>
      <button class="small ghost" data-remove>Remove</button>
    </div>
    <div class="store-picks">${state.stores.map((s) => renderPick(it, s, L.included.includes(s))).join('')}</div>
  </div>`;
}

function renderPick(it, store, enabled) {
  const ps = it.perStore[store] || { candidates: [] };
  const win = it.cheapest === store;
  const p = ps.product;
  const opts = [
    `<option value="auto" ${!ps.manual && !ps.excluded ? 'selected' : ''}>Auto: cheapest match</option>`,
    ...ps.candidates.map((c) => `<option value="${c.id}" ${ps.manual && p?.id === c.id ? 'selected' : ''}>${esc(c.name)} — ${money(c.price)}</option>`),
    ...(ps.manual && p && !ps.candidates.some((c) => c.id === p.id) ? [`<option value="${p.id}" selected>${esc(p.name)} — ${money(p.price)}</option>`] : []),
    `<option value="exclude" ${ps.excluded ? 'selected' : ''}>Don't buy here</option>`,
  ];
  return `<div class="pick ${win ? 'win' : ''} ${ps.excluded || !enabled ? 'excluded' : ''}">
    <div class="ph"><span class="store">${dot(store)}${esc(storeName(store))}</span>
      <span class="price">${p && !ps.excluded ? money(p.price * it.quantity) : '—'}</span></div>
    <span class="pname" title="${esc(p?.name || '')}">${!enabled ? 'Shop excluded' : ps.excluded ? 'Excluded' : p ? `${esc(p.name)}${win ? ' · <strong class="saving">cheapest</strong>' : ''}` : 'No match found'}</span>
    <select data-pick="${store}" aria-label="${esc(storeName(store))} product">${opts.join('')}</select>
  </div>`;
}

function renderSummary(L) {
  const stores = state.stores.filter((s) => L.plan.byStore[s]?.items.length);
  const singles = state.stores.map((s) => {
    const x = L.singleStore[s];
    const diff = x.total - L.plan.total;
    return `<div class="tile"><div class="label">${dot(s)} Everything at ${esc(storeName(s))}</div>
      <div class="value">${money(x.total)}</div>
      <div class="note">${x.missing ? `<span class="warn">${plural(x.missing, 'item')} not available</span>` : diff > 0.004 ? `Your split saves <span class="saving">${money(diff)}</span>` : 'Same as your split'}</div></div>`;
  });
  return `<h2 class="section">Total</h2>
    <div class="totals">
      <div class="tile hero"><div class="label">Cheapest split</div><div class="value">${money(L.plan.total)}</div>
        <div class="note">${plural(L.items.length, 'item')}${L.plan.unavailable.length ? ` · <span class="warn">${L.plan.unavailable.length} unavailable</span>` : ''}</div></div>
      ${stores.map((s) => `<div class="tile"><div class="label">${dot(s)} ${esc(storeName(s))}</div>
        <div class="value">${money(L.plan.byStore[s].total)}</div><div class="note">${plural(L.plan.byStore[s].items.length, 'item')}</div></div>`).join('')}
    </div>
    <h2 class="section">Compared with one shop</h2>
    <div class="totals">${singles.join('')}</div>`;
}

// List events (delegated, since the list re-renders)
$('#list-root').addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'list-select') {
      selectList(Number(t.value));
      return loadList();
    }
    if (t.matches('[data-store-toggle]')) {
      const excluded = $$('[data-store-toggle]').filter((c) => !c.checked).map((c) => c.dataset.storeToggle);
      if (excluded.length === state.stores.length) {
        t.checked = true;
        return toast('Keep at least one shop');
      }
      await api(`/api/lists/${state.listId}`, { method: 'PATCH', body: { excludedStores: excluded } });
      return loadList();
    }
    const item = t.closest('[data-item]');
    if (!item) return;
    const id = item.dataset.item;
    if (t.matches('[data-qty]')) await api(`/api/items/${id}`, { method: 'PATCH', body: { quantity: Number(t.value) } });
    else if (t.matches('[data-mode]')) await api(`/api/items/${id}`, { method: 'PATCH', body: { matchMode: t.value } });
    else if (t.matches('[data-pick]')) {
      const v = t.value;
      await api(`/api/items/${id}/stores/${t.dataset.pick}`, {
        method: 'PUT',
        body: { productId: v === 'exclude' ? null : v === 'auto' ? 'auto' : Number(v) },
      });
    }
    loadList();
  } catch (err) {
    toast(err.message);
  }
});

$('#list-root').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.matches('[data-remove]')) {
      await api(`/api/items/${t.closest('[data-item]').dataset.item}`, { method: 'DELETE' });
      return loadList();
    }
    switch (t.id) {
      case 'new-list': {
        const name = prompt('Name for the new list', 'Household');
        if (!name) return;
        const l = await api('/api/lists', { method: 'POST', body: { name } });
        selectList(l.id);
        return loadList();
      }
      case 'rename-list': {
        const name = prompt('Rename list', state.list.name);
        if (!name) return;
        await api(`/api/lists/${state.listId}`, { method: 'PATCH', body: { name } });
        return loadList();
      }
      case 'delete-list':
        if (!confirm(`Delete “${state.list.name}” for everyone it’s shared with?`)) return;
        await api(`/api/lists/${state.listId}`, { method: 'DELETE' });
        state.listId = null;
        return loadList();
      case 'leave-list':
        if (!confirm(`Leave “${state.list.name}”?`)) return;
        await api(`/api/lists/${state.listId}/members/${user().id}`, { method: 'DELETE' });
        state.listId = null;
        return loadList();
      case 'clear-list':
        if (!confirm('Remove everything from this list?')) return;
        await api(`/api/lists/${state.listId}/items`, { method: 'DELETE' });
        return loadList();
      case 'share-list':
        return openShare();
      case 'order-btn':
        return openOrder();
      default:
    }
  } catch (err) {
    toast(err.message);
  }
});

// Shared lists change under you: refresh when you come back to the tab, and every 30s while viewing.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentTab() === 'list' && user()) loadList();
});
setInterval(() => {
  const busy = document.activeElement?.closest?.('#list-root') || $('dialog[open]');
  if (!document.hidden && currentTab() === 'list' && user() && !busy) loadList();
}, 30000);

// ================================================================== sharing

async function openShare() {
  const L = state.list;
  const box = $('#share-detail');
  box.innerHTML = `<h2>Share “${esc(L.name)}”</h2>
    <p>Anyone with the link can join this list after logging in, and add or change items. Links expire after 7 days.</p>
    <p><button class="primary" id="make-invite">Create invite link</button></p>
    <div id="invite-out"></div>
    <h3>People on this list</h3>
    <ul class="members">${L.members.map((m) => `<li>${esc(m.name)} <span class="hint">${esc(m.email)}${m.role === 'owner' ? ' · owner' : ''}</span>
      ${L.role === 'owner' && m.id !== user().id ? `<button class="small ghost" data-remove-member="${m.id}">Remove</button>` : ''}</li>`).join('')}</ul>`;
  $('#share-dialog').showModal();
  $('#make-invite').addEventListener('click', async () => {
    const inv = await api(`/api/lists/${L.id}/invites`, { method: 'POST' });
    $('#invite-out').innerHTML = `<div class="copy-row"><input readonly value="${esc(inv.url)}" id="invite-url"><button class="small" id="copy-invite">Copy</button></div>`;
    $('#copy-invite').addEventListener('click', () => copyText(inv.url));
  });
  $$('[data-remove-member]', box).forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/lists/${L.id}/members/${b.dataset.removeMember}`, { method: 'DELETE' });
    await loadList();
    openShare();
  }));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Couldn’t copy — select the text and copy it yourself');
  }
}

/** /join/<token> → accept the invite (after logging in) and open that list. */
async function handleJoinLink() {
  const m = location.pathname.match(/^\/join\/([\w-]+)$/);
  if (!m) return false;
  const token = m[1];
  const accept = async () => {
    try {
      const { listId } = await api(`/api/invites/${token}/accept`, { method: 'POST' });
      selectList(listId);
      state.lists = [];
      history.replaceState(null, '', '/#list');
      showTab('list');
      toast('You’ve joined the list');
    } catch (e) {
      toast(e.message);
    }
  };
  try {
    const inv = await api(`/api/invites/${token}`);
    if (user()) await accept();
    else openAuth('signup', `${inv.from || 'Someone'} invited you to the list “${inv.listName}”. Sign up or log in to join.`, accept);
  } catch (e) {
    history.replaceState(null, '', '/');
    toast(e.message);
  }
  return true;
}

// ================================================================== ordering

function storeOnline(s) {
  return state.config.stores.find((x) => x.id === s)?.online;
}

function openOrder() {
  const L = state.list;
  const stores = state.stores.filter((s) => L.plan.byStore[s]?.items.length);
  const plainList = (s) => L.plan.byStore[s].items.map((i) => `${i.quantity} × ${i.product.name}`).join('\n');
  $('#order-detail').innerHTML = `<h2>Order the cheapest — ${money(L.plan.total)}</h2>
    ${L.plan.unavailable.length ? `<p class="warn">Not available at your shops: ${L.plan.unavailable.map((u) => esc(u.name)).join(', ')}</p>` : ''}
    ${stores.map((s) => `
      <div class="order-store">
        <h3>${dot(s)} ${esc(storeName(s))} — ${money(L.plan.byStore[s].total)}
          <span class="hint">${storeOnline(s) ? '' : '(in-store only)'}</span></h3>
        <table class="data"><thead><tr><th>Qty</th><th>Product</th><th class="num">Each</th><th class="num">Total</th></tr></thead><tbody>
        ${L.plan.byStore[s].items.map((i) => `<tr><td>${i.quantity}</td><td>${i.product.product_url ? `<a href="${esc(i.product.product_url)}" target="_blank" rel="noopener">${esc(i.product.name)}</a>` : esc(i.product.name)}</td>
          <td class="num">${money(i.product.price)}</td><td class="num">${money(i.lineTotal)}</td></tr>`).join('')}
        </tbody></table>
        <p><button class="small" data-copy-store="${s}">Copy ${esc(storeName(s))} list</button></p>
      </div>`).join('')}
    <p class="hint">Open each product link to add it to that shop’s online trolley, or copy the list to take to the shop.</p>
    <p>
      ${state.config.trolleyFill ? '<button id="fill-trolleys" class="primary">Fill my trolleys automatically</button>' : ''}
      <button id="print-order">Print</button>
    </p>
    <div id="order-progress"></div>`;
  $('#order-dialog').showModal();
  $$('[data-copy-store]').forEach((b) => b.addEventListener('click', () => copyText(plainList(b.dataset.copyStore))));
  $('#print-order').addEventListener('click', () => window.print());
  $('#fill-trolleys')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/lists/${state.listId}/fill-trolleys`, { method: 'POST' });
      pollOrder();
    } catch (err) {
      $('#order-progress').innerHTML = `<p class="warn">${esc(err.message)}</p>`;
      e.target.disabled = false;
    }
  });
}

async function pollOrder() {
  const st = await api('/api/order/status');
  const failed = Object.entries(st.results).flatMap(([s, r]) => (r.failed || []).map((f) => ({ ...f, store: s })));
  $('#order-progress').innerHTML = `<div class="order-log">${st.log.map((l) => esc(l.msg)).join('\n')}</div>
    ${failed.length ? `<p class="warn">Add these yourself:</p><ul>${failed.map((f) => `<li>${esc(storeName(f.store))}: <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a> × ${f.quantity}</li>`).join('')}</ul>` : ''}`;
  if (st.running) setTimeout(pollOrder, 1500);
}

// ================================================================== price changes

$('#changes-days').addEventListener('change', loadChanges);
$('#changes-dir').addEventListener('change', loadChanges);
async function loadChanges() {
  const rows = await api(`/api/changes?days=${$('#changes-days').value}&direction=${$('#changes-dir').value}`);
  $('#changes').innerHTML = rows.length
    ? rows.map((r) => {
      const pct = ((r.new_price - r.old_price) / r.old_price) * 100;
      const up = pct > 0;
      return `<div class="change" data-product="${r.id}">
        <div><strong>${esc(r.name)}</strong><div class="meta">${dot(r.store)} ${esc(storeName(r.store))} · ${esc(r.size_text || '')} · ${fmtDate(r.recorded_at)}</div></div>
        <div class="hint">${money(r.old_price)} → <strong>${money(r.new_price)}</strong></div>
        <div class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</div>
      </div>`;
    }).join('')
    : '<div class="empty">No price changes in this period yet.</div>';
}

// ================================================================== admin

let adminTimer;
async function loadAdmin() {
  const [o, users] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users')]);
  $('#admin-root').innerHTML = `
    <div class="list-head"><h2>Product data</h2>
      <button class="primary" id="scrape-all" ${o.stores.some((s) => s.status.running) ? 'disabled' : ''}>Refresh all prices</button></div>
    <p class="hint">Prices also refresh automatically (schedule “${esc(o.scrapeCron || 'off')}”). A full refresh takes 20–60 minutes.</p>
    <div class="stat-grid">${o.stores.map((s) => {
      const r = s.runs[0];
      const status = s.status.running
        ? `<strong>Running…</strong> ${s.status.products} products<br><span class="hint">${esc(s.status.message)}</span>`
        : r ? `Last run ${fmtDate(r.started_at)}: <strong>${esc(r.status)}</strong>${r.error ? `<br><span class="warn">${esc(r.error)}</span>` : ` · ${r.price_changes} price changes`}` : 'Never refreshed';
      return `<div class="tile"><div class="label">${dot(s.store)} ${esc(storeName(s.store))}</div>
        <div class="value">${s.products.toLocaleString()}</div>
        <div class="note">products · ${status}</div>
        <p><button class="small" data-scrape="${s.store}" ${s.status.running ? 'disabled' : ''}>Refresh</button></p></div>`;
    }).join('')}</div>
    <h2 class="section">Users <span class="hint">${o.users} accounts · ${o.lists} lists</span></h2>
    <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th class="num">Lists</th><th>Admin</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${fmtDate(u.created_at)}</td><td class="num">${u.lists}</td>
        <td><input type="checkbox" data-admin-user="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === user().id ? 'disabled' : ''} aria-label="Admin"></td></tr>`).join('')}
    </tbody></table></div>`;
  clearTimeout(adminTimer);
  if (o.stores.some((s) => s.status.running) && currentTab() === 'admin') adminTimer = setTimeout(loadAdmin, 3000);
}

$('#admin-root').addEventListener('click', async (e) => {
  const t = e.target;
  const stores = t.id === 'scrape-all' ? state.stores : t.dataset.scrape ? [t.dataset.scrape] : null;
  if (!stores) return;
  await api('/api/admin/scrape', { method: 'POST', body: { stores } });
  toast('Refresh started');
  setTimeout(loadAdmin, 500);
});
$('#admin-root').addEventListener('change', async (e) => {
  const t = e.target;
  if (!t.dataset.adminUser) return;
  try {
    await api(`/api/admin/users/${t.dataset.adminUser}`, { method: 'PATCH', body: { isAdmin: t.checked } });
    toast(t.checked ? 'Made admin' : 'Admin removed');
  } catch (err) {
    t.checked = !t.checked;
    toast(err.message);
  }
});

// ================================================================== start

await loadConfig();
api('/api/stats').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const latest = s.stores.map((x) => x.updatedAt).filter(Boolean).sort().pop();
  $('#updated-hint').textContent = latest ? `Prices last updated ${fmtDate(latest)}.` : '';
}).catch(() => {});
if (user()) refreshListCount().catch(() => {});
if (!(await handleJoinLink())) {
  const initial = location.hash.slice(1);
  showTab(['compare', 'list', 'changes', 'admin'].includes(initial) ? initial : 'compare');
}
runSearch();
