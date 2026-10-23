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
  allStores: [], // every shop id, in display order
  signupIga: null, // IGA store picked on the sign-up page, before the account exists
  stores: [], // the shops this user compares (their settings), in display order
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
  state.config = await api(withIga('/api/config'));
  state.allStores = state.config.stores.map((s) => s.id);
  const pref = state.config.user?.preferredStores;
  state.stores = pref?.length ? state.allStores.filter((s) => pref.includes(s)) : state.allStores;
  state.names = Object.fromEntries(state.config.stores.map((s) => [s.id, s.name]));
  $('#store-names').textContent = state.config.stores.map((s) => s.name).join(' · ');
  $('#store-filter').innerHTML = `<option value="">${state.stores.length < state.allStores.length ? 'All my shops' : 'All shops'}</option>`
    + state.stores.map((s) => `<option value="${s}">${esc(storeName(s))}</option>`).join('');
  $$('[data-shop-boxes]').forEach(renderShopBoxes);
  renderAccount();
}

function renderAccount() {
  const u = user();
  $('#admin-tab').hidden = !u?.isAdmin;
  $('#account').innerHTML = u
    ? `<a href="/settings" data-link class="who" title="Settings">${esc(u.name)}</a>
       <a href="/settings" data-link class="button small ghost">Settings</a>
       <button class="small ghost" id="logout">Log out</button>`
    : '<a href="/login" data-link class="button small">Log in</a>'
      + (state.config.allowSignups ? ' <a href="/signup" data-link class="button small primary">Sign up</a>' : '');
  $('#logout')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });
}

// ================================================================== pages & routing
// Tabs live at /#compare, /#list…; full pages at /login, /signup, /settings, /join/<token>.

const TABS = ['compare', 'list', 'changes', 'admin'];
const PAGES = ['login', 'signup', 'settings'];

function showTab(name) {
  if (name === 'admin' && !user()?.isAdmin) name = 'compare';
  if (location.pathname !== '/') history.pushState(null, '', '/');
  history.replaceState(null, '', `/#${name}`);
  show(name);
  if (name === 'list') loadList();
  if (name === 'changes') loadChanges();
  if (name === 'admin') loadAdmin();
}

function show(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  window.scrollTo(0, 0);
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

/** Show whatever the current URL points at. */
async function route() {
  const path = location.pathname;
  const join = path.match(/^\/join\/([\w-]+)$/);
  if (join) return handleJoin(join[1]);
  const page = path.slice(1);
  if (PAGES.includes(page)) {
    if (page === 'settings' && !user()) return goToAuth('login', 'Log in to change your settings.', { type: 'goto', path: '/settings' });
    if (page !== 'settings' && user()) return navigate('/');
    if (page === 'signup' && !state.config.allowSignups) return navigate('/login');
    show(page);
    if (page === 'settings') fillSettings();
    else {
      $(`#tab-${page} [data-auth-reason]`).textContent = sessionStorage.getItem('authReason') || '';
      $('[data-signup-link]').hidden = !state.config.allowSignups;
      $(`#tab-${page} input[name=${page === 'signup' ? 'name' : 'email'}]`).focus();
    }
    return;
  }
  const tab = location.hash.slice(1);
  showTab(TABS.includes(tab) ? tab : 'compare');
}

window.addEventListener('popstate', route);
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) {
    e.preventDefault();
    showTab(a.dataset.goto);
    return;
  }
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(link.getAttribute('href'));
  }
});
const currentTab = () => $('.tabs [aria-selected="true"]')?.dataset.tab;

// ================================================================== sign up / log in

/**
 * Send someone to the sign-up (or log-in) page, remembering what they were
 * trying to do so it happens straight after (add an item, join a list…).
 */
function goToAuth(mode, reason, after) {
  try {
    sessionStorage.setItem('authReason', reason || '');
    if (after) sessionStorage.setItem('afterAuth', JSON.stringify(after));
  } catch {
    /* storage blocked: they'll just land on the home page afterwards */
  }
  navigate(mode === 'signup' && state.config.allowSignups ? '/signup' : '/login');
}

function requireLogin(reason, after) {
  if (user()) return true;
  goToAuth('signup', reason, after);
  return false;
}

/** Tick boxes for each shop, pre-ticked with the user's choice (or all). */
function renderShopBoxes(el) {
  // Keep any ticks the person has already changed; otherwise start from their saved choice.
  const existing = $$('input[name=shops]', el);
  const chosen = existing.length ? existing.filter((c) => c.checked).map((c) => c.value) : user()?.preferredStores || state.allStores;
  const signup = !!el.closest('#signup-form');
  // On the sign-up page nothing is saved yet; elsewhere it's the store in use.
  const igaStore = signup ? state.signupIga : state.config.igaStore;
  el.innerHTML = state.config.stores.map((s) => `<label class="check shop-box">
    <input type="checkbox" name="shops" value="${s.id}" ${chosen.includes(s.id) ? 'checked' : ''}>
    ${dot(s.id)} <span><strong>${esc(s.name)}</strong> <span class="hint">${esc(s.note || '')}</span></span></label>
    ${s.id === 'iga' ? `<div class="iga-choice">${igaStore
      ? `Your IGA: <strong>${esc(igaStore.name)}</strong>${igaStore.suburb ? ` <span class="hint">${esc(igaStore.suburb)}</span>` : ''} ${signup ? '' : igaStatus(igaStore)}
         <button type="button" class="linkish" data-change-iga>Change</button>`
      : '<button type="button" class="small" data-change-iga>📍 Find my IGA</button> <span class="hint">or we’ll use a default store</span>'}</div>` : ''}`).join('');
}

function formError(form, err) {
  const el = $('[data-form-error]', form);
  el.textContent = err ? err.message : '';
  el.hidden = !err;
}

async function afterLogin() {
  await loadConfig();
  state.lists = [];
  state.listId = null;
  refreshListCount().catch(() => {});
  let after = null;
  try {
    after = JSON.parse(sessionStorage.getItem('afterAuth') || 'null');
    sessionStorage.removeItem('afterAuth');
    sessionStorage.removeItem('authReason');
  } catch {
    /* ignore */
  }
  if (after?.type === 'join') return navigate(`/join/${after.token}`);
  if (after?.type === 'goto') return navigate(after.path);
  history.pushState(null, '', '/');
  if (after?.type === 'add') {
    await addToList(after.productId).catch((e) => toast(e.message));
    return showTab('list');
  }
  toast(`Welcome, ${user().name}`);
  showTab('compare');
  runSearch();
}

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const preferredStores = f.getAll('shops');
  if (!preferredStores.length) return formError(e.target, new Error('Tick at least one shop'));
  try {
    await api('/api/auth/signup', {
      method: 'POST',
      body: {
        name: f.get('name'), email: f.get('email'), password: f.get('password'), preferredStores,
        igaStore: preferredStores.includes('iga') ? state.signupIga?.id : undefined,
      },
    });
    formError(e.target, null);
    e.target.reset();
    await afterLogin();
  } catch (err) {
    formError(e.target, err);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    formError(e.target, null);
    e.target.reset();
    await afterLogin();
  } catch (err) {
    formError(e.target, err);
  }
});

// ================================================================== settings

function fillSettings() {
  const u = user();
  $('#shops-form [data-shop-boxes]').innerHTML = ''; // start from the saved choice
  $('#profile-form [name=name]').value = u.name;
  $('#profile-form [name=email]').value = u.email;
  $$('#tab-settings form').forEach((f) => formError(f, null));
  renderShopBoxes($('#shops-form [data-shop-boxes]'));
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me', { method: 'PATCH', body: { name: new FormData(e.target).get('name') } });
    await loadConfig();
    formError(e.target, null);
    toast('Profile saved');
  } catch (err) {
    formError(e.target, err);
  }
});

$('#shops-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const preferredStores = f.getAll('shops');
  try {
    await api('/api/me', { method: 'PATCH', body: { preferredStores, applyToLists: f.get('applyToLists') === 'on' } });
    await loadConfig();
    formError(e.target, null);
    toast('Shops saved');
    runSearch();
  } catch (err) {
    formError(e.target, err);
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/me/password', { method: 'POST', body: { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') } });
    e.target.reset();
    formError(e.target, null);
    toast('Password changed');
  } catch (err) {
    formError(e.target, err);
  }
});

$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm('Delete your account for good?')) return;
  try {
    await api('/api/me', { method: 'DELETE', body: { password: new FormData(e.target).get('password') } });
    location.href = '/';
  } catch (err) {
    formError(e.target, err);
  }
});

// ================================================================== IGA store picker
// Every IGA prices things differently, so people pick theirs: by suburb,
// postcode or "near me". Visitors' choice lives in their browser; accounts save it.

function visitorIga() {
  try {
    return localStorage.getItem('igaStore') || '';
  } catch {
    return '';
  }
}

/** Visitors send their IGA choice with each request (accounts have it saved). */
function withIga(path) {
  const v = !user() && visitorIga();
  return v ? `${path}${path.includes('?') ? '&' : '?'}iga=${encodeURIComponent(v)}` : path;
}

function igaShortName(st) {
  if (!st) return 'Choose store';
  return st.suburb || st.name.replace(/^IGA\s+/i, '');
}

function igaStatus(st) {
  if (!st) return '';
  if (st.pricesReady) return '<span class="state ready">✓ Prices ready</span>';
  if (st.tracked) return '<span class="state pending">Fetching prices…</span>';
  return '<span class="state pending">Prices in ~2 min</span>';
}

let igaResolve = null;
let igaFound = new Map();
let igaCurrentId = null;
let igaSeq = 0;

/** Open the picker; resolves with the chosen store, or null if closed. */
function pickIgaStore({ title = 'Choose your IGA', currentId = null } = {}) {
  igaCurrentId = currentId;
  $('#iga-title').textContent = title;
  $('#iga-q').value = '';
  $('#iga-results').innerHTML = '';
  $('#iga-msg').textContent = 'Type your suburb or postcode, or tap “Near me”.';
  const n = state.config.igaOnlineStores;
  $('#iga-count').textContent = n ? ` — ${n.toLocaleString()} stores` : '';
  $('#iga-dialog').showModal();
  $('#iga-q').focus();
  return new Promise((resolve) => {
    igaResolve = resolve;
  });
}

$('#iga-dialog').addEventListener('close', () => {
  igaResolve?.(null);
  igaResolve = null;
});

async function findIga(params, waiting) {
  const seq = ++igaSeq;
  $('#iga-msg').textContent = waiting;
  try {
    const list = await api(`/api/iga/stores?${new URLSearchParams(params)}`);
    if (seq !== igaSeq) return;
    igaFound = new Map(list.map((x) => [x.id, x]));
    $('#iga-msg').textContent = list.length ? ''
      : 'No IGA with online prices found there. Try a nearby suburb or postcode, or “Near me”.';
    $('#iga-results').innerHTML = list.map((x) => `<li><button type="button" data-iga-id="${esc(x.id)}" class="${x.id === igaCurrentId ? 'current' : ''}">
      <strong>${esc(x.name)}</strong>
      ${x.distanceKm != null ? `<span class="dist">${x.distanceKm < 1 ? `${Math.round(x.distanceKm * 1000)} m` : `${x.distanceKm.toFixed(1)} km`}</span>` : '<span></span>'}
      <span class="addr">${esc([x.address, x.suburb, `${x.state || ''} ${x.postcode || ''}`.trim()].filter(Boolean).join(', '))}</span>
      ${x.id === igaCurrentId ? '<span class="state ready">Current</span>' : igaStatus(x)}
    </button></li>`).join('');
  } catch (e) {
    if (seq === igaSeq) $('#iga-msg').textContent = e.message;
  }
}

let igaTimer;
$('#iga-q').addEventListener('input', () => {
  clearTimeout(igaTimer);
  const q = $('#iga-q').value.trim();
  if (q.length < 2) return;
  igaTimer = setTimeout(() => findIga({ q }, 'Searching…'), 250);
});

$('#iga-locate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('#iga-msg').textContent = 'Your browser can’t share your location — type your suburb or postcode instead.';
    return;
  }
  $('#iga-msg').textContent = 'Finding stores near you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => findIga({ lat: pos.coords.latitude.toFixed(4), lng: pos.coords.longitude.toFixed(4) }, 'Finding stores near you…'),
    () => {
      $('#iga-msg').textContent = 'Couldn’t get your location — type your suburb or postcode instead.';
    },
    { timeout: 10000, maximumAge: 600000 },
  );
});

$('#iga-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-iga-id]');
  if (!b) return;
  const store = igaFound.get(b.dataset.igaId);
  const resolve = igaResolve;
  igaResolve = null;
  $('#iga-dialog').close();
  resolve?.(store);
});

/** Use this IGA for search (and, for accounts, their own lists). */
async function chooseIga(store, { applyToLists = true } = {}) {
  const st = await api(`/api/iga/stores/${encodeURIComponent(store.id)}/use`, { method: 'POST', body: { applyToLists } });
  if (!user()) {
    try {
      localStorage.setItem('igaStore', st.id);
    } catch {
      /* private mode: the choice lasts until the page is reloaded */
    }
  }
  await loadConfig();
  watchIgaPrices();
  runSearch();
  toast(st.pricesReady ? `Comparing prices at ${st.name}` : `Getting prices for ${st.name} — usually a couple of minutes`);
  return st;
}

// While a newly chosen store's prices are being fetched, say so and check back.
let igaWatch = null;
function watchIgaPrices() {
  const st = state.config.igaStore;
  if (st && st.online === false && state.stores.includes('iga')) {
    $('#iga-notice').hidden = false;
    $('#iga-notice').innerHTML = `<strong>${esc(st.name)}</strong> no longer publishes its prices online, so IGA isn’t being compared.
      <button type="button" class="linkish" data-change-iga>Choose another IGA</button>`;
    return;
  }
  const waiting = st && !st.pricesReady && state.stores.includes('iga');
  $('#iga-notice').hidden = !waiting;
  if (!waiting) return;
  $('#iga-notice').innerHTML = `Getting prices for <strong>${esc(st.name)}</strong>. This usually takes a couple of minutes; IGA prices will appear here when they’re ready.`;
  clearTimeout(igaWatch);
  igaWatch = setTimeout(async () => {
    const now = await api(`/api/iga/stores/${encodeURIComponent(st.id)}`).catch(() => null);
    if (now?.pricesReady) {
      await loadConfig();
      $('#iga-notice').hidden = true;
      toast(`${now.name} prices are ready`);
      runSearch();
    } else {
      watchIgaPrices();
    }
  }, 15000);
}

// "Change" buttons on the compare header, sign-up and settings pages.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-change-iga]');
  if (!b) return;
  e.preventDefault();
  const signup = !!b.closest('#signup-form');
  const current = signup ? state.signupIga : state.config.igaStore;
  const store = await pickIgaStore({ currentId: current?.id });
  if (!store) return;
  try {
    if (signup) {
      state.signupIga = store;
      $('#signup-form input[value=iga]').checked = true;
      renderShopBoxes($('#signup-form [data-shop-boxes]'));
      return;
    }
    const inSettings = !!b.closest('#shops-form');
    await chooseIga(store, { applyToLists: inSettings ? $('#shops-form [name=applyToLists]').checked : true });
    if (inSettings) renderShopBoxes($('#shops-form [data-shop-boxes]'));
  } catch (err) {
    toast(err.message);
  }
});

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
    const groups = await api(withIga(`/api/search?${params}`));
    if (seq !== searchSeq) return;
    if (!groups.length) {
      box.innerHTML = '<div class="empty">No matching products.</div>';
      return;
    }
    box.style.setProperty('--store-cols', state.stores.length);
    box.innerHTML = `<div class="row head"><span></span><span>Product</span>${state.stores.map((s) => `<span>${dot(s)} ${esc(storeName(s))}${s === 'iga' ? `<button type="button" class="linkish col-sub" data-change-iga>${esc(igaShortName(state.config.igaStore))} ▾</button>` : ''}</span>`).join('')}<span></span></div>`
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
  if (!requireLogin('Create an account (or log in) to keep a shopping list.', { type: 'add', productId })) return;
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
  const d = await api(withIga(`/api/products/${id}`));
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
    $('#list-login').addEventListener('click', () => goToAuth('signup', '', { type: 'goto', path: '/#list' }));
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
      ${state.allStores.map((s) => storeToggle(s, L.included.includes(s), '')).join('')}</div></div>`;
  }
  return `<div class="store-panel"><h2>Where you shop</h2>
    <p class="hint">Untick a shop to stop buying from it. Each card shows what that shop is worth for this list.</p>
    <div class="store-cards">${state.allStores.map((s) => {
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
  const ig = s === 'iga' ? state.list?.igaStore : null;
  return `<label class="store-card ${on ? 'on' : 'off'}">
    <span class="store-card-head"><input type="checkbox" data-store-toggle="${s}" ${on ? 'checked' : ''}> ${dot(s)} <strong>${esc(storeName(s))}</strong></span>
    ${s === 'iga' ? `<span class="store-note">${ig ? `${esc(ig.name)}${ig.pricesReady ? '' : ' · <span class="state pending">fetching prices…</span>'}` : 'No store chosen'}
      · <button type="button" class="linkish" data-list-iga>change</button></span>` : ''}
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
    <div class="store-picks">${state.allStores.map((s) => renderPick(it, s, L.included.includes(s))).join('')}</div>
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
  const stores = state.allStores.filter((s) => L.plan.byStore[s]?.items.length);
  const singles = state.allStores.map((s) => {
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
      if (excluded.length === state.allStores.length) {
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
  if (t.closest('[data-list-iga]')) {
    // The button sits inside the shop's <label>; don't let it toggle the shop.
    e.preventDefault();
    const store = await pickIgaStore({ title: `IGA store for “${state.list.name}”`, currentId: state.list.igaStore?.id });
    if (!store) return;
    try {
      await api(`/api/lists/${state.listId}`, { method: 'PATCH', body: { igaStore: store.id } });
      toast(`${state.list.name} now uses ${store.name}`);
      loadList();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
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

/** /join/<token> → accept the invite (after signing up / logging in) and open that list. */
async function handleJoin(token) {
  try {
    const inv = await api(`/api/invites/${token}`);
    if (!user()) {
      return goToAuth('signup', `${inv.from || 'Someone'} invited you to the list “${inv.listName}”. Create an account or log in to join.`,
        { type: 'join', token });
    }
    const { listId } = await api(`/api/invites/${token}/accept`, { method: 'POST' });
    selectList(listId);
    state.lists = [];
    toast('You’ve joined the list');
    showTab('list');
  } catch (e) {
    toast(e.message);
    showTab('compare');
  }
}

// ================================================================== ordering

function storeOnline(s) {
  return state.config.stores.find((x) => x.id === s)?.online;
}

function openOrder() {
  const L = state.list;
  const stores = state.allStores.filter((s) => L.plan.byStore[s]?.items.length);
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
    <h2 class="section">IGAs with prices online</h2>
    <p>${o.iga.onlineStores.toLocaleString()} IGA stores currently publish prices online and can be picked.
      ${o.iga.check.running ? `<span class="state pending">Checking now… ${o.iga.check.done} of ${o.iga.check.total}</span>`
        : o.iga.lastCheck ? `<span class="hint">Last checked ${fmtDate(o.iga.lastCheck.started_at)}${o.iga.lastCheck.error
          ? ` — <span class="warn">failed: ${esc(o.iga.lastCheck.error)}</span>`
          : ` — ${o.iga.lastCheck.came_online} came online, ${o.iga.lastCheck.went_offline} went offline`}.</span>` : '<span class="hint">Not checked yet.</span>'}
      <button class="small" id="iga-check" ${o.iga.check.running ? 'disabled' : ''}>Check now</button></p>
    <p class="hint">Checked automatically every day before prices refresh: IGA’s store list is reloaded and each store is asked for one product.</p>
    <h2 class="section">IGA stores <span class="hint">${o.iga.tracked.length} followed${o.iga.maxStores ? ` of ${o.iga.maxStores} allowed` : ' (no limit)'} — prices are collected only for stores people have picked</span></h2>
    <div class="table-scroll"><table class="data"><thead><tr><th>Store</th><th>Added</th><th>Prices updated</th><th></th></tr></thead><tbody>
      ${o.iga.tracked.map((t) => `<tr><td>${esc(t.name || `Store ${t.store_id}`)} <span class="hint">${esc([t.suburb, t.state].filter(Boolean).join(' '))}</span></td>
        <td>${fmtDate(t.added_at)}</td>
        <td>${o.iga.queue.current === t.store_id ? '<span class="state pending">fetching now…</span>' : o.iga.queue.waiting.includes(t.store_id) ? '<span class="state pending">queued</span>' : t.last_scraped_at ? fmtDate(t.last_scraped_at) : 'not yet'}</td>
        <td>${t.store_id === o.iga.defaultStoreId ? '<span class="hint">default</span>' : `<button class="small ghost" data-untrack-iga="${esc(t.store_id)}">Stop following</button>`}</td></tr>`).join('')}
    </tbody></table></div>
    <h2 class="section">Users <span class="hint">${o.users} accounts · ${o.lists} lists</span></h2>
    <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th class="num">Lists</th><th>Admin</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${fmtDate(u.created_at)}</td><td class="num">${u.lists}</td>
        <td><input type="checkbox" data-admin-user="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === user().id ? 'disabled' : ''} aria-label="Admin"></td></tr>`).join('')}
    </tbody></table></div>`;
  clearTimeout(adminTimer);
  const busy = o.stores.some((s) => s.status.running) || o.iga.queue.current || o.iga.check.running;
  if (busy && currentTab() === 'admin') adminTimer = setTimeout(loadAdmin, 3000);
}

$('#admin-root').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'iga-check') {
    await api('/api/admin/iga/check', { method: 'POST', body: {} });
    toast('Checking IGA stores…');
    return setTimeout(loadAdmin, 800);
  }
  if (t.dataset.untrackIga) {
    if (!confirm('Stop collecting prices for this IGA store? People who picked it will see no IGA prices until it’s picked again.')) return;
    await api(`/api/admin/iga/${encodeURIComponent(t.dataset.untrackIga)}`, { method: 'DELETE' });
    return loadAdmin();
  }
  const stores = t.id === 'scrape-all' ? state.allStores : t.dataset.scrape ? [t.dataset.scrape] : null;
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
await route();
runSearch();
watchIgaPrices();
