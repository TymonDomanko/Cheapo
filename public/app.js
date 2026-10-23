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
  try {
    localStorage.setItem('lastConfig', JSON.stringify(state.config));
  } catch {
    /* storage blocked */
  }
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
  $('#verify-banner').hidden = !u || u.emailVerified;
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
const PAGES = ['login', 'signup', 'settings', 'forgot-password', 'reset-password', 'verify-email', 'privacy'];
const GUEST_ONLY = ['login', 'signup', 'forgot-password'];

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
    if (GUEST_ONLY.includes(page) && user()) return navigate('/');
    if (page === 'signup' && !state.config.allowSignups) return navigate('/login');
    show(page);
    if (page === 'settings') fillSettings();
    else if (page === 'privacy') renderPrivacy();
    else if (page === 'verify-email') confirmEmail();
    else if (page === 'reset-password' || page === 'forgot-password') {
      $$(`#tab-${page} form`).forEach((f) => formError(f, null));
      $(`#tab-${page} input`).focus();
    } else {
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
  const af = $('#alerts-form');
  af.alertsWeekly.checked = u.alertsWeekly;
  af.alertsPrice.checked = u.alertsPrice;
  $('#email-status').innerHTML = u.emailVerified
    ? `Emails go to <strong>${esc(u.email)}</strong>.`
    : `<span class="warn">Confirm your email first</span> — we only email confirmed addresses. <button type="button" class="linkish" data-resend-verify>Send the link again</button>`;
  $('#membership-boxes').innerHTML = Object.entries(state.config.memberships || {}).map(([store, scheme]) => `<label class="check">
    <input type="checkbox" name="memberships" value="${esc(store)}" ${u.memberships.includes(store) ? 'checked' : ''}> ${dot(store)} ${esc(scheme)} (${esc(storeName(store))})</label>`).join('');
  loadWatches();
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

$('#alerts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/me', {
      method: 'PATCH',
      body: { alertsWeekly: f.alertsWeekly.checked, alertsPrice: f.alertsPrice.checked, memberships: new FormData(f).getAll('memberships') },
    });
    await loadConfig();
    formError(f, null);
    toast('Saved');
    runSearch();
  } catch (err) {
    formError(f, err);
  }
});

async function loadWatches() {
  const list = await api('/api/watches').catch(() => []);
  $('#watch-list').innerHTML = list.length
    ? list.map((w) => `<li><a href="#" data-product="${w.productId}">${esc(w.product?.name || 'Product')}</a>
        <span class="hint">${w.product ? `${esc(storeName(w.product.store))} · now ${money(w.price)}` : 'no longer sold'}
        · ${w.targetPrice != null ? `alert at ${money(w.targetPrice)}` : 'any drop'}</span>
        <button type="button" class="small ghost" data-unwatch="${w.productId}">Stop</button></li>`).join('')
    : '<li class="hint">Nothing yet.</li>';
}
$('#watch-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-unwatch]');
  if (!b) return;
  await api(`/api/watches/${b.dataset.unwatch}`, { method: 'DELETE' });
  loadWatches();
});

// Email confirmation & password reset
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#resend-verify, [data-resend-verify]')) return;
  try {
    await api('/api/me/verify-email', { method: 'POST' });
    toast('Sent — check your inbox');
  } catch (err) {
    toast(err.message);
  }
});

async function confirmEmail() {
  const token = new URLSearchParams(location.search).get('token');
  $('#verify-title').textContent = 'Confirming your email…';
  $('#verify-msg').textContent = '';
  try {
    await api('/api/auth/verify', { method: 'POST', body: { token } });
    $('#verify-title').textContent = 'Email confirmed';
    $('#verify-msg').textContent = 'Thanks! You can now get price alerts and password resets.';
    await loadConfig();
  } catch (err) {
    $('#verify-title').textContent = 'That link didn’t work';
    $('#verify-msg').textContent = `${err.message} You can send a new one from Settings.`;
  }
}

$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/forgot', { method: 'POST', body: { email: new FormData(e.target).get('email') } });
    formError(e.target, null);
    e.target.hidden = true;
    $('#forgot-done').hidden = false;
  } catch (err) {
    formError(e.target, err);
  }
});

$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/reset', {
      method: 'POST',
      body: { token: new URLSearchParams(location.search).get('token'), password: new FormData(e.target).get('password') },
    });
    e.target.reset();
    await loadConfig();
    toast('Password changed — you’re logged in');
    history.pushState(null, '', '/');
    showTab('compare');
  } catch (err) {
    formError(e.target, err);
  }
});

// ================================================================== privacy

function renderPrivacy() {
  const site = state.config.site;
  const contact = site.contact
    ? `email <a href="mailto:${esc(site.contact)}">${esc(site.contact)}</a>`
    : 'contact the person who runs this site';
  $('#privacy-body').innerHTML = `
    <h2>Privacy</h2>
    <p>${esc(site.name)}${site.operator ? ` is run by ${esc(site.operator)}` : ''}. It compares supermarket prices and keeps shopping lists. Here’s exactly what it stores and why.</p>
    <h3>If you just browse</h3>
    <p>Nothing about you is stored on the server. Your browser keeps your chosen IGA store and last-opened list (in its own storage) so the site remembers them. There are no ads, no trackers, and no analytics.</p>
    <h3>If you create an account</h3>
    <ul>
      <li><strong>Your name and email</strong> — to log you in, and to email you only what you ask for: confirming your address, password resets, and the alerts you turn on.</li>
      <li><strong>Your password</strong> — stored only as a one-way scrypt hash; nobody can read it.</li>
      <li><strong>Your lists, settings and price watches</strong> — to provide the service. Shared lists are visible to everyone you invite.</li>
      <li><strong>A login cookie</strong> — a random token so you stay logged in (30 days). It’s the only cookie we set.</li>
    </ul>
    <h3>Emails</h3>
    <p>We send only: a link to confirm your email, password resets you ask for, and the weekly specials or price alerts you’ve turned on. Every alert email has a one-click unsubscribe link, and you can turn them off in Settings.</p>
    <h3>Who else sees it</h3>
    <p>Nobody. We don’t sell or share your data. Emails are sent through an email delivery service, which handles your address only to deliver the email. Prices are fetched from the supermarkets’ public websites; your details are never sent to them.</p>
    <h3>Your choices</h3>
    <ul>
      <li><strong>Download your data</strong> from Settings at any time.</li>
      <li><strong>Delete your account</strong> from Settings: your details, lists you don’t share and your price watches are removed straight away. Lists you share pass to another member. Daily backups are kept for up to 7 days and then deleted.</li>
    </ul>
    <h3>Questions</h3>
    <p>To ask about your data or have it corrected, ${contact}.</p>`;
}

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

/** Is this shopper a member of the store's loyalty scheme (so member prices apply)? */
const isMember = (store) => !!user()?.memberships?.includes(store);
const shownPrice = (p) => (p.member_price != null && isMember(p.store) && p.member_price < p.price ? p.member_price : p.price);

/** Small labels for multi-buys and member prices. */
function dealBadges(p) {
  const out = [];
  if (p.multi_qty) out.push(`<span class="badge deal" title="Multi-buy">${esc(p.promo_text || `${p.multi_qty} for ${money(p.multi_price)}`)}</span>`);
  if (p.member_price != null && p.member_price < p.price) {
    out.push(`<span class="badge member" title="${isMember(p.store) ? 'Your member price' : 'Member price — tick your membership in Settings to use it'}">Member ${money(p.member_price)}</span>`);
  }
  return out.join('');
}

function priceCell(store, match, cheapest, anchor) {
  const label = `<span class="store-label">${dot(store)}${esc(storeName(store))}</span>`;
  if (!match) return `<div class="cell none">${label}—</div>`;
  const p = match.product;
  const alt = p.id !== anchor.id && p.name !== anchor.name ? `<span class="alt" title="${esc(p.name)}">${esc(p.name)}</span>` : '';
  const price = shownPrice(p);
  return `<div class="cell ${store === cheapest ? 'cheapest' : ''}">${label}
    <span><span class="price">${money(price)}</span>${p.was_price ? `<span class="was">${money(p.was_price)}</span>` : price < p.price ? `<span class="was">${money(p.price)}</span>` : ''}
    <span class="unit">${store === cheapest ? '<span class="badge cheap">✓ Cheapest</span>' : ''}${p.on_special ? '<span class="badge special">Special</span>' : ''}${esc(p.unit_price_text || '')}</span>
    ${dealBadges(p)}${alt}</span>
  </div>`;
}

/** "3L is 18% cheaper per litre" line. */
function valueHint(bv) {
  if (!bv) return '';
  const p = bv.product;
  return `<div class="value-hint">💡 Better value: <a href="#" data-product="${p.id}">${esc(p.name)}${p.size_text && !p.name.includes(p.size_text) ? ` ${esc(p.size_text)}` : ''}</a>
    at ${esc(storeName(p.store))} is <strong>${bv.savingPct}% cheaper per ${esc(bv.unit)}</strong> (${money(bv.perUnit)} vs ${money(bv.basePerUnit)}).</div>`;
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
    ${valueHint(g.betterValue)}
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
        <div><strong>${money(shownPrice(p))}</strong> ${p.was_price ? `<span class="hint"><s>${money(p.was_price)}</s></span>` : ''} ${dealBadges(p)}
          ${s ? `<span class="hint">· lowest ${money(s.min)}, highest ${money(s.max)}, ${plural(s.changes, 'change')} since ${fmtDate(s.since)}</span>` : ''}</div>
        <p>
          <button class="small" data-add="${p.id}">+ Add to list</button>
          ${watchControl(p, d.watch)}
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
        <td><a href="#" data-product="${x.id}">${esc(x.name)}</a> ${x.on_special ? '<span class="tag-special">SPECIAL</span>' : ''} ${dealBadges(x)}</td>
        <td class="num">${money(shownPrice(x))}</td>
        <td class="num">${esc(x.unit_price_text || '')}</td>
        <td class="num">${x.via === 'barcode' ? '<span title="Same barcode">barcode</span>' : x.via === 'confirmed' ? 'confirmed' : `${Math.round(x.score * 100)}%`}</td>
        <td class="row-actions"><button class="small" data-add="${x.id}">+ List</button>
          ${x.id !== p.id ? `<button class="small ghost" data-report="${x.id}" data-anchor="${p.id}" title="These aren’t the same product">Wrong match?</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">Products are matched by barcode where the stores publish one, otherwise by size and name. Spotted a wrong match? Use “Wrong match?” and an admin will fix it for everyone.</p>`;
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

// ================================================================== price watches & wrong-match reports

function watchControl(p, watch) {
  if (!user()) return '<button class="small ghost" data-watch-login>🔔 Watch price</button>';
  return watch
    ? `<span class="watching">🔔 Watching${watch.target_price != null ? ` for ${money(watch.target_price)} or less` : ' for any drop'}
       <button class="linkish" data-unwatch-product="${p.id}">stop</button></span>`
    : `<button class="small ghost" data-watch="${p.id}" data-price="${shownPrice(p)}">🔔 Watch price</button>`;
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.closest('[data-watch-login]')) {
      $('#product-dialog').close();
      return goToAuth('signup', 'Create an account to get price alerts.');
    }
    const w = t.closest('[data-watch]');
    if (w) {
      const answer = prompt(`Email me when this costs this much or less (leave empty for any drop from ${money(Number(w.dataset.price))}):`, '');
      if (answer === null) return;
      await api(`/api/watches/${w.dataset.watch}`, { method: 'PUT', body: { targetPrice: answer.trim() ? Number(answer.replace(/[^\d.]/g, '')) : null } });
      toast(user().emailVerified ? 'We’ll email you when it’s cheaper' : 'Watching — confirm your email to get the alert');
      return openProduct(Number(w.dataset.watch));
    }
    const u = t.closest('[data-unwatch-product]');
    if (u) {
      await api(`/api/watches/${u.dataset.unwatchProduct}`, { method: 'DELETE' });
      return openProduct(Number(u.dataset.unwatchProduct));
    }
    const r = t.closest('[data-report]');
    if (r) {
      if (!requireLogin('Create an account (or log in) to report a wrong match.')) return;
      openReport(Number(r.dataset.anchor), Number(r.dataset.report), r.closest('tr, .pick')?.querySelector('a, .pname')?.textContent?.trim());
    }
  } catch (err) {
    toast(err.message);
  }
});

let reporting = null;
function openReport(anchorId, productId, name) {
  reporting = { anchorId, productId };
  $('#report-pair').textContent = name ? `You’re saying “${name}” isn’t the same product.` : '';
  $('#report-form').reset();
  $('#report-dialog').showModal();
}
$('#report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/match-reports', { method: 'POST', body: { ...reporting, kind: 'not_same', note: new FormData(e.target).get('note') } });
    $('#report-dialog').close();
    toast(r.status === 'accepted' ? 'Fixed for everyone' : 'Thanks — an admin will check it');
    if (r.status === 'accepted') {
      if ($('#product-dialog').open) openProduct(reporting.anchorId);
      if (currentTab() === 'list') loadList();
    }
  } catch (err) {
    toast(err.message);
  }
});

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
  try {
    await flushTicks();
    state.lists = await api('/api/lists');
    await ensureLists();
    selectList(state.listId);
    state.list = await api(`/api/lists/${state.listId}`);
    try {
      localStorage.setItem('lastList', JSON.stringify({ lists: state.lists, list: state.list }));
    } catch {
      /* storage blocked */
    }
  } catch (e) {
    if (e.status === 404) {
      state.lists = [];
      state.listId = null;
      return loadList();
    }
    // Offline in the shop: show the last copy we had.
    const cached = (() => {
      try {
        return JSON.parse(localStorage.getItem('lastList') || 'null');
      } catch {
        return null;
      }
    })();
    if (!cached || e.status) throw e;
    Object.assign(state, { lists: cached.lists, list: cached.list, listId: cached.list.id });
    $('#offline-banner').hidden = false;
  }
  if (!state.list.items.length) state.shopping = false;
  if (state.shopping) renderShopping();
  else renderList();
  refreshListCount().catch(() => {});
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
        <button class="small" id="snapshots-btn">Saved shops</button>
        <button class="small ghost" id="clear-list" ${L.items.length ? '' : 'disabled'}>Clear</button>
        <button class="small" id="shop-mode" ${L.items.length ? '' : 'disabled'}>🛒 In the shop</button>
        <button class="primary" id="order-btn" ${L.items.length ? '' : 'disabled'}>Order cheapest</button>
      </div>
    </div>
    ${others.length ? `<p class="hint">Shared with ${others.map((m) => esc(m.name)).join(', ')}. Changes anyone makes show up for everyone.</p>` : ''}
    ${renderStorePanel(L)}
    <div id="items">${L.items.length ? L.items.map(renderItem).join('') : '<div class="empty">This list is empty. Search on the <a href="#" data-goto="compare">Compare</a> tab and press “+ List”, or add a <button type="button" class="linkish" id="snapshots-empty">saved shop</button>.</div>'}</div>
    ${L.items.length ? renderSummary(L) : ''}`;
}

/** What `qty` of a product costs this shopper (multi-buys and their member prices). Mirrors src/promos.js. */
function lineCost(p, qty) {
  const unit = shownPrice(p);
  let cost = unit * qty;
  if (p.multi_qty >= 2 && p.multi_price > 0 && qty >= p.multi_qty) {
    const deals = Math.floor(qty / p.multi_qty);
    cost = Math.min(cost, deals * p.multi_price + (qty - deals * p.multi_qty) * unit);
  }
  return Math.round(cost * 100) / 100;
}

// ------------------------------------------------------------------ in the shop
// A big-tick checklist grouped by shop and aisle category. Ticks sync to
// everyone on the list; offline, they're kept on the phone and sent later.

state.shopping = false;

function renderShopping() {
  const L = state.list;
  const byStore = state.allStores.filter((s) => L.plan.byStore[s]?.items.length);
  const itemById = Object.fromEntries(L.items.map((it) => [it.id, it]));
  const pending = pendingTicks();
  const isChecked = (it) => (it.id in pending ? pending[it.id] : !!it.checkedAt);
  const ticked = L.items.filter(isChecked).length;
  const section = (store) => {
    const rows = L.plan.byStore[store].items.map((x) => ({ x, it: itemById[x.itemId] }));
    const groups = new Map();
    for (const r of rows) {
      const cat = r.x.product.category || 'Other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(r);
    }
    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return `<section class="shop-section"><h2>${dot(store)} ${esc(storeName(store))} <span class="hint">${money(L.plan.byStore[store].total)}</span></h2>
      ${sorted.map(([cat, list]) => `<h3 class="aisle">${esc(cat)}</h3><ul class="checklist">${list.map(({ x, it }) => `
        <li class="${isChecked(it) ? 'done' : ''}"><label>
          <input type="checkbox" data-tick="${it.id}" ${isChecked(it) ? 'checked' : ''}>
          <span class="ck-name"><strong>${x.quantity} ×</strong> ${esc(x.product.name)}
            ${it.checkedBy && isChecked(it) && L.members.length > 1 ? `<span class="hint"> · ${esc(it.checkedBy)}</span>` : ''}</span>
          <span class="ck-price">${money(x.lineTotal)}</span></label></li>`).join('')}</ul>`).join('')}
    </section>`;
  };
  const missing = L.plan.unavailable.map((u) => itemById[u.id]).filter(Boolean);
  $('#list-root').innerHTML = `
    <div class="list-head">
      <h2>🛒 ${esc(L.name)} <span class="hint">${ticked} of ${L.items.length} ticked</span></h2>
      <div class="actions">
        <button class="small" id="shop-mode">Back to list</button>
        <button class="primary" id="finish-shop" ${ticked ? '' : 'disabled'}>Finish shop</button>
      </div>
    </div>
    <p class="hint">Grouped by shop, then by section. ${L.members.length > 1 ? 'Ticks show up for everyone on this list, so you can split up.' : ''}</p>
    ${byStore.map(section).join('')}
    ${missing.length ? `<section class="shop-section"><h2>Not available at your shops</h2><ul class="checklist">${missing.map((it) => `
      <li class="${isChecked(it) ? 'done' : ''}"><label><input type="checkbox" data-tick="${it.id}" ${isChecked(it) ? 'checked' : ''}>
        <span class="ck-name"><strong>${it.quantity} ×</strong> ${esc(it.anchor.name)}</span></label></li>`).join('')}</ul></section>` : ''}`;
}

function pendingTicks() {
  try {
    return JSON.parse(localStorage.getItem(`ticks:${state.listId}`) || '{}');
  } catch {
    return {};
  }
}
function savePendingTicks(p) {
  try {
    localStorage.setItem(`ticks:${state.listId}`, JSON.stringify(p));
  } catch {
    /* storage full or blocked */
  }
}

async function tick(itemId, checked) {
  const pending = pendingTicks();
  pending[itemId] = checked;
  savePendingTicks(pending);
  renderShopping();
  await flushTicks();
}

/** Send ticks made offline (or just now) to the server. */
async function flushTicks() {
  const pending = pendingTicks();
  for (const [itemId, checked] of Object.entries(pending)) {
    try {
      await api(`/api/items/${itemId}/checked`, { method: 'PUT', body: { checked } });
      delete pending[itemId];
    } catch (e) {
      if (e.status === 404) delete pending[itemId]; // item removed by someone else
      else break; // offline: try again later
    }
  }
  savePendingTicks(pending);
}

window.addEventListener('online', async () => {
  $('#offline-banner').hidden = true;
  await flushTicks();
  if (currentTab() === 'list' && user()) loadList();
});
window.addEventListener('offline', () => {
  $('#offline-banner').hidden = false;
});

// ------------------------------------------------------------------ saved & past shops

async function openSnapshots() {
  const snaps = await api(`/api/lists/${state.listId}/snapshots`);
  const saved = snaps.filter((x) => x.kind === 'saved');
  const past = snaps.filter((x) => x.kind === 'history');
  const row = (x) => `<li><span><strong>${esc(x.name)}</strong> <span class="hint">${plural(x.items, 'item')}${x.kind === 'history' ? '' : ` · saved ${fmtDate(x.createdAt)}`}</span></span>
    <span><button class="small" data-snap-add="${x.id}">Add to list</button>
    <button class="small ghost" data-snap-del="${x.id}" aria-label="Delete">×</button></span></li>`;
  $('#snapshots-detail').innerHTML = `<h2>Saved shops</h2>
    <p class="hint">Add a regular shop to this list in one go. Things already on the list are skipped.</p>
    ${state.list.items.length ? '<p><button class="primary" id="snap-save">Save this list as a regular shop</button></p>' : ''}
    <h3>Regular shops</h3><ul class="snap-list">${saved.map(row).join('') || '<li class="hint">None yet — fill a list and save it.</li>'}</ul>
    <h3>Past shops</h3><ul class="snap-list">${past.map(row).join('') || '<li class="hint">Finished shops appear here (use “In the shop”, tick things off, then “Finish shop”).</li>'}</ul>`;
  if (!$('#snapshots-dialog').open) $('#snapshots-dialog').showModal();
}

$('#snapshots-dialog').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'snap-save') {
      const name = prompt('Name this regular shop', 'Weekly shop');
      if (!name) return;
      await api(`/api/lists/${state.listId}/snapshots`, { method: 'POST', body: { name } });
      toast('Saved');
      return openSnapshots();
    }
    if (t.dataset.snapAdd) {
      const r = await api(`/api/lists/${state.listId}/snapshots/${t.dataset.snapAdd}/add`, { method: 'POST' });
      toast(r.added ? `Added ${plural(r.added, 'item')}` : 'Everything was already on the list');
      $('#snapshots-dialog').close();
      return loadList();
    }
    if (t.dataset.snapDel) {
      await api(`/api/lists/${state.listId}/snapshots/${t.dataset.snapDel}`, { method: 'DELETE' });
      return openSnapshots();
    }
  } catch (err) {
    toast(err.message);
  }
});

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
        <div class="meta">${esc(a.size_text || '')}${!a.available ? ' · <span class="warn">no longer available</span>' : ''}${it.addedBy && L.members.length > 1 ? ` · added by ${esc(it.addedBy)}` : ''}${it.checkedAt ? ' · <span class="saving">✓ ticked</span>' : ''}</div></div>
      <label class="check">Qty <input class="qty" type="number" min="1" max="99" value="${it.quantity}" data-qty></label>
      <select data-mode aria-label="Matching">
        <option value="similar" ${it.matchMode === 'similar' ? 'selected' : ''}>Any brand, same size</option>
        <option value="exact" ${it.matchMode === 'exact' ? 'selected' : ''}>Same brand only</option>
        <option value="this" ${it.matchMode === 'this' ? 'selected' : ''}>This exact product</option>
      </select>
      <button class="small ghost" data-remove>Remove</button>
    </div>
    <div class="store-picks">${state.allStores.map((s) => renderPick(it, s, L.included.includes(s))).join('')}</div>
    ${valueHint(it.betterValue)}
  </div>`;
}

function renderPick(it, store, enabled) {
  const ps = it.perStore[store] || { candidates: [] };
  const win = it.cheapest === store;
  const p = ps.product;
  const opts = [
    `<option value="auto" ${!ps.manual && !ps.excluded ? 'selected' : ''}>Auto: cheapest match</option>`,
    ...ps.candidates.map((c) => `<option value="${c.id}" ${ps.manual && p?.id === c.id ? 'selected' : ''}>${esc(c.name)} — ${money(shownPrice(c))}</option>`),
    ...(ps.manual && p && !ps.candidates.some((c) => c.id === p.id) ? [`<option value="${p.id}" selected>${esc(p.name)} — ${money(shownPrice(p))}</option>`] : []),
    `<option value="exclude" ${ps.excluded ? 'selected' : ''}>Don't buy here</option>`,
  ];
  return `<div class="pick ${win ? 'win' : ''} ${ps.excluded || !enabled ? 'excluded' : ''}">
    <div class="ph"><span class="store">${dot(store)}${esc(storeName(store))}</span>
      <span class="price">${p && !ps.excluded ? money(lineCost(p, it.quantity)) : '—'}</span></div>
    <span class="pname" title="${esc(p?.name || '')}">${!enabled ? 'Shop excluded' : ps.excluded ? 'Excluded' : p ? `${esc(p.name)}${win ? ' · <strong class="saving">cheapest</strong>' : ''}` : 'No match found'}</span>
    ${p && !ps.excluded ? dealBadges(p) : ''}
    ${p && !ps.excluded && !ps.manual && p.id !== it.anchor.id ? `<button type="button" class="linkish small-link" data-report="${p.id}" data-anchor="${it.anchor.id}">Wrong match?</button>` : ''}
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
        <div class="note">${plural(L.items.length, 'item')}${L.plan.unavailable.length ? ` · <span class="warn">${L.plan.unavailable.length} unavailable</span>` : ''}
          ${(() => {
            const deals = Object.values(L.plan.byStore).flatMap((b) => b.items).reduce((n, i) => n + (i.dealSaving || 0), 0);
            return deals > 0.004 ? `<br>includes <span class="saving">${money(deals)}</span> from multi-buys${L.memberships.length ? ' and member prices' : ''}` : '';
          })()}</div></div>
      ${stores.map((s) => `<div class="tile"><div class="label">${dot(s)} ${esc(storeName(s))}</div>
        <div class="value">${money(L.plan.byStore[s].total)}</div><div class="note">${plural(L.plan.byStore[s].items.length, 'item')}</div></div>`).join('')}
    </div>
    <h2 class="section">Compared with one shop</h2>
    <div class="totals">${singles.join('')}</div>`;
}

// List events (delegated, since the list re-renders)
$('#list-root').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.tick) return tick(Number(t.dataset.tick), t.checked);
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
      case 'shop-mode':
        state.shopping = !state.shopping;
        window.scrollTo(0, 0);
        return state.shopping ? renderShopping() : renderList();
      case 'finish-shop': {
        await flushTicks();
        if (!confirm('Finished? Ticked items come off the list and are saved under “Past shops” so you can repeat them.')) return;
        const r = await api(`/api/lists/${state.listId}/finish`, { method: 'POST' });
        toast(`${r.name} saved — ${plural(r.items, 'item')} done`);
        state.shopping = false;
        return loadList();
      }
      case 'snapshots-btn':
      case 'snapshots-empty':
        return openSnapshots();
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
// Every 30s while viewing a list; every 5s in the shop so ticks from others show up quickly.
let lastPoll = 0;
setInterval(() => {
  const busy = (!state.shopping && document.activeElement?.closest?.('#list-root')) || $('dialog[open]');
  const every = state.shopping ? 5000 : 30000;
  if (Date.now() - lastPoll < every || document.hidden || currentTab() !== 'list' || !user() || busy || !navigator.onLine) return;
  lastPoll = Date.now();
  loadList().catch(() => {});
}, 1000);

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
        <div class="note">products · ${status}${r?.source === 'collector' ? ' · <span class="hint">sent by home collector</span>' : ''}</div>
        <p>${s.fedByCollector ? '<span class="hint">Collected from home (not crawled by this server)</span>'
          : `<button class="small" data-scrape="${s.store}" ${s.status.running ? 'disabled' : ''}>Refresh</button>`}</p></div>`;
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
    <h2 class="section">Wrong matches ${o.openMatchReports ? `<span class="pill">${o.openMatchReports}</span>` : ''}</h2>
    <div id="admin-matches"><p class="hint">Loading…</p></div>

    <h2 class="section">Barcodes</h2>
    <p>${(o.barcodes.with_barcode || 0).toLocaleString()} of ${(o.barcodes.total || 0).toLocaleString()} Coles products have a barcode
      (${(o.barcodes.checked || 0).toLocaleString()} pages checked).
      ${o.barcodes.status.running ? `<span class="state pending">Fetching… ${o.barcodes.status.done} of ${o.barcodes.status.total}</span>`
        : '<button class="small" id="barcodes-now">Fetch more now</button>'}</p>
    <p class="hint">Coles only shows barcodes on product pages, so they’re filled in a batch at a time each day (products on lists first). Woolworths barcodes come with every refresh. Same barcode = same product.</p>

    <h2 class="section">Home collector</h2>
    <p class="hint">${o.collectorEnabled
      ? 'This server accepts prices from a home collector. Stores marked “Collected from home” above come from it.'
      : 'Not set up. If Woolworths or ALDI refreshes fail from this server, set up the home collector in <a href="#site-settings">Site settings</a> below.'}</p>

    <h2 class="section">Backups</h2>
    <div id="admin-backups"><p class="hint">Loading…</p></div>

    <h2 class="section">Emails</h2>
    <div id="admin-emails"><p class="hint">Loading…</p></div>

    <h2 class="section" id="site-settings">Site settings</h2>
    <div id="admin-settings"><p class="hint">Loading…</p></div>

    <h2 class="section">Users <span class="hint">${plural(o.users, 'account')} · ${plural(o.lists, 'list')}</span></h2>
    <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th class="num">Lists</th><th>Admin</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${fmtDate(u.created_at)}</td><td class="num">${u.lists}</td>
        <td><input type="checkbox" data-admin-user="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === user().id ? 'disabled' : ''} aria-label="Admin"></td></tr>`).join('')}
    </tbody></table></div>`;
  clearTimeout(adminTimer);
  loadAdminExtras();
  loadAdminSettings();
  const busy = o.stores.some((s) => s.status.running) || o.iga.queue.current || o.iga.check.running || o.barcodes.status.running;
  if (busy && currentTab() === 'admin') adminTimer = setTimeout(refreshAdminWhenIdle, 3000);
}

/** Live progress refresh, but never while someone is typing in a settings form. */
function refreshAdminWhenIdle() {
  const editing = document.activeElement?.closest?.('#admin-root form')
    || [...$$('#admin-root form input')].some((i) => i.type === 'password' ? i.value : false);
  if (editing) adminTimer = setTimeout(refreshAdminWhenIdle, 3000);
  else loadAdmin();
}

// ------------------------------------------------------------------ site settings
// Values in the server's .env file win; those fields are shown locked.

async function loadAdminSettings(justMadeToken = null) {
  const { settings: st, stores, currentAddress, litestream } = await api('/api/admin/settings');
  const locked = (key) => st[key].source === 'env';
  const envTag = (key) => (locked(key) ? ' <span class="env-tag" title="Set in the server’s .env file — change it there">set in .env</span>' : '');
  const dis = (key) => (locked(key) ? 'disabled' : '');
  const smtp = st.SMTP_URL.parts || { host: '', port: 465, secure: true, user: '', passwordSet: false };
  const crawled = (st.SERVER_SCRAPE_STORES.value || stores.join(',')).split(',');
  $('#admin-settings').innerHTML = `
    <div class="settings-grid">
      <form id="email-settings" class="card stack">
        <h3>Email${envTag('SMTP_URL')}</h3>
        <p class="hint">For password resets, email confirmation and alerts. Use the SMTP details from any email service (Resend, Postmark, Brevo, Mailgun, Amazon SES…).</p>
        <label>Mail server (SMTP host)<input name="host" placeholder="smtp.resend.com" value="${esc(smtp.host)}" ${dis('SMTP_URL')}></label>
        <div class="two-col">
          <label>Port<input name="port" type="number" min="1" max="65535" value="${esc(smtp.port)}" ${dis('SMTP_URL')}></label>
          <label class="check"><input type="checkbox" name="secure" ${smtp.secure ? 'checked' : ''} ${dis('SMTP_URL')}> Secure connection (SSL/TLS)</label>
        </div>
        <label>Username<input name="user" autocomplete="off" value="${esc(smtp.user)}" ${dis('SMTP_URL')}></label>
        <label>Password${smtp.passwordSet ? ' <span class="hint">saved — leave blank to keep it</span>' : ''}
          <input name="password" type="password" autocomplete="new-password" placeholder="${smtp.passwordSet ? '••••••••' : ''}" ${dis('SMTP_URL')}></label>
        <label>Send emails from${envTag('MAIL_FROM')}<input name="MAIL_FROM" placeholder="Groceries <alerts@yourdomain.com>" value="${esc(st.MAIL_FROM.value || '')}" ${dis('MAIL_FROM')}></label>
        <label>Site address for links in emails${envTag('SITE_URL')}
          <span class="copy-row"><input name="SITE_URL" placeholder="https://groceries.example.com" value="${esc(st.SITE_URL.value || '')}" ${dis('SITE_URL')}>
          ${locked('SITE_URL') ? '' : `<button type="button" class="small" data-use-address="${esc(currentAddress)}">Use this page’s</button>`}</span></label>
        <p class="hint">Saved passwords are stored in the database (and so in its backups). To keep it out, set SMTP_URL in .env instead.</p>
        <p class="warn" data-form-error hidden></p>
        <div class="actions">
          <button class="primary" type="submit">Save</button>
          <button type="button" class="small" id="test-email" ${st.SMTP_URL.set ? '' : 'disabled'}>Send test email</button>
          ${st.SMTP_URL.source === 'admin' ? '<button type="button" class="small ghost" id="remove-smtp">Remove mail server</button>' : ''}
        </div>
      </form>

      <form id="site-details" class="card stack">
        <h3>Privacy page details</h3>
        <p class="hint">Shown on the privacy page so people know who runs the site and how to ask about their data.</p>
        <label>Contact email${envTag('CONTACT_EMAIL')}<input name="CONTACT_EMAIL" type="email" value="${esc(st.CONTACT_EMAIL.value || '')}" ${dis('CONTACT_EMAIL')}></label>
        <label>Run by (your name or organisation)${envTag('SITE_OPERATOR')}<input name="SITE_OPERATOR" maxlength="120" value="${esc(st.SITE_OPERATOR.value || '')}" ${dis('SITE_OPERATOR')}></label>
        <p class="warn" data-form-error hidden></p>
        <button class="primary" type="submit">Save</button>
      </form>

      <form id="collector-settings" class="card stack">
        <h3>Home collector</h3>
        <p class="hint">For stores that block this server: a small program on a computer at home crawls them and sends the prices here (see DEPLOY.md, “Home collector”).</p>
        <p><strong>Token:</strong>${envTag('COLLECTOR_TOKEN')} ${st.COLLECTOR_TOKEN.set ? 'set' : '<span class="hint">none — the collector can’t send prices</span>'}</p>
        ${justMadeToken ? `<div class="notice">Copy this into the collector’s .env as COLLECTOR_TOKEN. It won’t be shown again.
          <div class="copy-row"><input readonly value="${esc(justMadeToken)}" id="new-token"><button type="button" class="small" id="copy-token">Copy</button></div></div>` : ''}
        ${locked('COLLECTOR_TOKEN') ? '' : `<div class="actions"><button type="button" class="small" id="make-token">${st.COLLECTOR_TOKEN.set ? 'Generate a new token' : 'Generate token'}</button>
          ${st.COLLECTOR_TOKEN.set ? '<button type="button" class="small ghost" id="revoke-token">Turn off</button>' : ''}</div>`}
        <fieldset class="shop-picker"><legend>This server crawls${envTag('SERVER_SCRAPE_STORES')}</legend>
          <p class="hint">Untick the stores the home collector sends instead.</p>
          ${stores.map((x) => `<label class="check"><input type="checkbox" name="crawl" value="${x}" ${crawled.includes(x) ? 'checked' : ''} ${dis('SERVER_SCRAPE_STORES')}> ${dot(x)} ${esc(storeName(x))}</label>`).join('')}
        </fieldset>
        <p class="warn" data-form-error hidden></p>
        ${locked('SERVER_SCRAPE_STORES') ? '' : '<button class="primary" type="submit">Save</button>'}
      </form>

      <div class="card stack">
        <h3>Off-site backup</h3>
        ${litestream.enabled
          ? `<p>✓ On — every change is copied to <strong>${esc(litestream.bucket)}/${esc(litestream.path)}</strong> at ${esc(litestream.host)}.</p>`
          : '<p><span class="warn">Off.</span> Daily snapshots stay on this server’s disk only.</p>'}
        <p class="hint">Litestream runs before the app starts (so it can restore the database onto a new server), which means its settings live in the server’s .env file — see DEPLOY.md, “Off-site backups”.</p>
      </div>
    </div>`;
}

$('#admin-root').addEventListener('submit', async (e) => {
  const f = e.target;
  if (!['email-settings', 'site-details', 'collector-settings'].includes(f.id)) return;
  e.preventDefault();
  const v = (name) => f.elements[name];
  let body = {};
  if (f.id === 'email-settings') {
    if (!v('host').disabled) {
      body.smtp = v('host').value.trim()
        ? { host: v('host').value, port: Number(v('port').value), secure: v('secure').checked, user: v('user').value, password: v('password').value }
        : null;
    }
    for (const k of ['MAIL_FROM', 'SITE_URL']) if (!v(k).disabled) body[k] = v(k).value;
  } else if (f.id === 'site-details') {
    for (const k of ['CONTACT_EMAIL', 'SITE_OPERATOR']) if (!v(k).disabled) body[k] = v(k).value;
  } else {
    body = { SERVER_SCRAPE_STORES: [...f.querySelectorAll('[name=crawl]:checked')].map((c) => c.value) };
    if (!body.SERVER_SCRAPE_STORES.length) return formError(f, new Error('Leave at least one store for this server'));
  }
  try {
    await api('/api/admin/settings', { method: 'PUT', body });
    toast('Saved');
    await loadConfig();
    loadAdmin();
  } catch (err) {
    formError(f, err);
  }
});

$('#admin-root').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.useAddress) {
      t.closest('form').elements.SITE_URL.value = t.dataset.useAddress;
    } else if (t.id === 'test-email') {
      t.disabled = true;
      const r = await api('/api/admin/settings/test-email', { method: 'POST' });
      toast(`Test email sent to ${r.to}`);
      t.disabled = false;
    } else if (t.id === 'remove-smtp') {
      if (!confirm('Stop sending email? Emails will go to the outbox on this page instead.')) return;
      await api('/api/admin/settings', { method: 'PUT', body: { smtp: null } });
      loadAdmin();
    } else if (t.id === 'make-token') {
      if (t.textContent.includes('new') && !confirm('Make a new token? The home collector stops working until you give it the new one.')) return;
      const { token } = await api('/api/admin/settings/collector-token', { method: 'POST' });
      loadAdminSettings(token);
    } else if (t.id === 'revoke-token') {
      if (!confirm('Turn off the home collector? It will be refused until you generate a new token.')) return;
      await api('/api/admin/settings/collector-token', { method: 'DELETE' });
      loadAdmin();
    } else if (t.id === 'copy-token') {
      copyText($('#new-token').value);
    }
  } catch (err) {
    if (t.id === 'test-email') t.disabled = false;
    toast(err.message);
  }
});

async function loadAdminExtras() {
  const [m, b, em] = await Promise.all([api('/api/admin/match-reports'), api('/api/admin/backups'), api('/api/admin/emails')]);
  const prod = (p) => (p ? `${dot(p.store)} <a href="#" data-product="${p.id}">${esc(p.name)}</a> <span class="hint">${esc(p.size_text || '')} · ${money(p.price)}</span>` : '<span class="hint">(gone)</span>');
  $('#admin-matches').innerHTML = (m.open.length
    ? `<ul class="report-list">${m.open.map((r) => `<li>
        <div>${prod(r.a)}<br><span class="hint">${r.kind === 'same' ? 'is the same as' : 'is NOT the same as'}</span><br>${prod(r.b)}</div>
        <div class="hint">${plural(r.count, 'report')}${r.reporter ? ` · first by ${esc(r.reporter)}` : ''}${r.notes.length ? ` · “${r.notes.map(esc).join('”, “')}”` : ''}</div>
        <div><button class="small primary" data-resolve="${r.id}" data-decision="accept">Fix it</button>
          <button class="small ghost" data-resolve="${r.id}" data-decision="dismiss">Dismiss</button></div></li>`).join('')}</ul>`
    : '<p class="hint">No reports waiting. Shoppers can press “Wrong match?” on any comparison.</p>')
    + (m.rules.length ? `<details><summary>${plural(m.rules.length, 'confirmed fix')}</summary><ul class="report-list">${m.rules.map((r) => `<li>
        <div>${dot(r.a_store)} ${esc(r.a_name)} <span class="hint">${r.kind === 'never' ? '≠' : '='}</span> ${dot(r.b_store)} ${esc(r.b_name)}</div>
        <div><button class="small ghost" data-unrule="${r.a_id}/${r.b_id}">Undo</button></div></li>`).join('')}</ul></details>` : '');
  $('#admin-backups').innerHTML = `<p>${b.litestream
    ? '✓ Continuous off-site backup with Litestream is on.'
    : '<span class="warn">No off-site backup.</span> Daily snapshots below are on the same disk as the database — set up Litestream (see DEPLOY.md) to survive losing the disk.'}</p>
    <p><button class="small" id="backup-now">Back up now</button> <span class="hint">Snapshots are taken daily and kept for ${b.keepDays} days.</span></p>
    ${b.snapshots.length ? `<table class="data"><thead><tr><th>Snapshot</th><th class="num">Size</th><th></th></tr></thead><tbody>
      ${b.snapshots.map((x) => `<tr><td>${fmtDate(x.createdAt)} <span class="hint">${esc(x.name)}</span></td><td class="num">${(x.bytes / 1e6).toFixed(1)} MB</td>
        <td><a href="/api/admin/backups/${encodeURIComponent(x.name)}" download>Download</a></td></tr>`).join('')}</tbody></table>` : ''}`;
  $('#admin-emails').innerHTML = `<p class="hint">${em.mailConfigured
    ? 'Sending through your mail server (SMTP_URL). Recent emails:'
    : '<span class="warn">No mail server set up</span>, so emails are not sent — they’re kept here instead. You can pass a reset link on to someone by hand, or set up email in <a href="#site-settings">Site settings</a>.'}</p>
    ${em.emails.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>When</th><th>To</th><th>Subject</th><th></th></tr></thead><tbody>
      ${em.emails.map((x) => `<tr><td>${fmtDate(x.sent_at)}</td><td>${esc(x.to_email)}</td><td>${esc(x.subject)}${x.error ? ` <span class="warn">failed: ${esc(x.error)}</span>` : ''}</td>
        <td>${x.body ? `<details><summary>Show</summary><pre class="order-log">${esc(x.body)}</pre></details>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">None yet.</p>'}
    <p><button class="small" id="send-alerts">Send price alerts now</button> <span class="hint">They also go out daily after prices refresh, and the specials email every Wednesday.</span></p>`;
}

$('#admin-root').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.resolve) {
      await api(`/api/admin/match-reports/${t.dataset.resolve}`, { method: 'POST', body: { decision: t.dataset.decision } });
      toast(t.dataset.decision === 'accept' ? 'Fixed for everyone' : 'Dismissed');
      return loadAdmin();
    }
    if (t.dataset.unrule) {
      await api(`/api/admin/match-rules/${t.dataset.unrule}`, { method: 'DELETE' });
      return loadAdminExtras();
    }
    if (t.id === 'backup-now') {
      const r = await api('/api/admin/backups', { method: 'POST' });
      toast(`Backed up (${(r.bytes / 1e6).toFixed(1)} MB)`);
      return loadAdminExtras();
    }
    if (t.id === 'barcodes-now') {
      await api('/api/admin/barcodes', { method: 'POST' });
      toast('Fetching Coles barcodes…');
      return setTimeout(loadAdmin, 800);
    }
    if (t.id === 'send-alerts') {
      const r = await api('/api/admin/send-alerts', { method: 'POST', body: {} });
      toast(`${plural(r.priceAlerts.emails, 'price alert email')} sent`);
      return loadAdminExtras();
    }
  } catch (err) {
    return toast(err.message);
  }
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (!navigator.onLine) $('#offline-banner').hidden = false;

try {
  await loadConfig();
} catch {
  // Offline on first load: use what we remember so the shopping list still opens.
  const cached = JSON.parse(localStorage.getItem('lastConfig') || 'null');
  if (!cached) throw new Error('offline');
  state.config = cached;
  state.allStores = cached.stores.map((x) => x.id);
  state.names = Object.fromEntries(cached.stores.map((x) => [x.id, x.name]));
  state.stores = state.allStores;
  renderAccount();
}
api('/api/stats').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const latest = s.stores.map((x) => x.updatedAt).filter(Boolean).sort().pop();
  $('#updated-hint').textContent = latest ? `Prices last updated ${fmtDate(latest)}.` : '';
}).catch(() => {});
if (user()) refreshListCount().catch(() => {});
await route();
runSearch();
watchIgaPrices();
