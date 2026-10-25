const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const dot = (s) => `<i class="dot" style="background:var(--store-${esc(s)})"></i>`;
/** A shop's name on a badge in its brand colour. */
const chip = (s, name = storeName(s)) => `<span class="store-chip" style="--chip:var(--brand-${esc(s)}, var(--store-${esc(s)}))">${esc(name)}</span>`;
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
  state.allStores = shopsShown(!!state.config.user?.showAlcohol).map((s) => s.id);
  // Where the prices are for (Admin → Prices for), on every page.
  const area = state.config.site?.priceArea;
  $('#footer-prices').textContent = area
    ? `Prices are for ${area}, from the supermarkets’ own websites. Your local shop’s can differ, especially fruit and veg.`
    : 'Prices come from the supermarkets’ own websites and can differ in store.';
  const pref = state.config.user?.preferredStores;
  state.stores = pref?.length ? state.allStores.filter((s) => pref.includes(s)) : state.allStores;
  state.names = Object.fromEntries(state.config.stores.map((s) => [s.id, s.name]));
  $('#store-filter').innerHTML = `<option value="">${state.stores.length < state.allStores.length ? 'All my shops' : 'All shops'}</option>`
    + state.stores.map((s) => `<option value="${s}">${esc(storeName(s))}</option>`).join('');
  $$('[data-shop-boxes]').forEach(renderShopBoxes);
  renderAccount();
}

/** Banners someone has closed stay closed on this device. */
function hiddenBanner(key) {
  try {
    return localStorage.getItem(`banner:${key}`) === 'hidden';
  } catch {
    return false;
  }
}
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close-banner]');
  if (!close) return;
  const key = close.dataset.closeBanner.replace('{user}', user()?.id ?? '');
  try {
    localStorage.setItem(`banner:${key}`, 'hidden');
  } catch {
    /* storage blocked: hide it for now */
  }
  close.closest('.banner').hidden = true;
});

function renderAccount() {
  const u = user();
  $('#admin-tab').hidden = !u?.isAdmin;
  $('#verify-banner').hidden = !u || u.emailVerified || hiddenBanner(`verify:${u.id}`);
  // Wide screens: name, Settings and Log out. Phones: one account button with a menu.
  $('#account').innerHTML = u
    ? `<span class="account-wide"><a href="/settings" data-link class="who" title="Settings">${esc(u.name)}</a>
       <a href="/settings" data-link class="button small ghost">Settings</a>
       <button class="small ghost" data-logout>Log out</button></span>
       <details class="account-menu"><summary aria-label="Account">${esc(u.name.charAt(0).toUpperCase())}</summary>
         <div class="menu"><div class="hint">${esc(u.name)}</div>
           <a href="/settings" data-link class="button small ghost">Settings</a>
           <button class="small ghost" data-logout>Log out</button></div></details>`
    : '<a href="/login" data-link class="button small">Log in</a>'
      + (state.config.allowSignups ? ' <a href="/signup" data-link class="button small primary">Sign up</a>' : '');
  $$('#account [data-logout]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  }));
  $$('#account .menu a').forEach((a) => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));
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

/** The shops someone sees: liquor shops only with Show alcohol on. */
function shopsShown(alcohol) {
  return state.config.stores.filter((s) => alcohol || !s.liquor);
}

/** Tick boxes for each shop, pre-ticked with the user's choice (or all). */
function renderShopBoxes(el) {
  // Keep any ticks the person has already changed; otherwise start from their saved choice.
  const existing = $$('input[name=shops]', el);
  const chosen = existing.length ? existing.filter((c) => c.checked).map((c) => c.value) : user()?.preferredStores || state.allStores;
  const signup = !!el.closest('#signup-form');
  // On the sign-up page nothing is saved yet; elsewhere it's the store in use.
  const igaStore = signup ? state.signupIga : state.config.igaStore;
  // Liquor shops appear once Show alcohol is ticked (in Settings; never at sign-up, where it's off).
  const alcohol = !signup && !!($('[name=showAlcohol]')?.checked ?? user()?.showAlcohol);
  el.innerHTML = shopsShown(alcohol).map((s) => `<label class="check shop-box">
    <input type="checkbox" name="shops" value="${s.id}" ${chosen.includes(s.id) ? 'checked' : ''}>
    <span>${chip(s.id, s.name)} <span class="hint">${esc(s.note || '')}</span></span></label>
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
  af.showAlcohol.checked = !!u.showAlcohol;
  $('#email-status').innerHTML = u.emailVerified
    ? `Emails go to <strong>${esc(u.email)}</strong>.`
    : `<span class="warn">Confirm your email first</span> — we only email confirmed addresses. <button type="button" class="linkish" data-resend-verify>Send the link again</button>`;
  $('#membership-boxes').innerHTML = Object.entries(state.config.memberships || {}).map(([store, scheme]) => `<label class="check">
    <input type="checkbox" name="memberships" value="${esc(store)}" ${u.memberships.includes(store) ? 'checked' : ''}> ${esc(scheme)} ${chip(store)}</label>`).join('');
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
      body: {
        alertsWeekly: f.alertsWeekly.checked, alertsPrice: f.alertsPrice.checked, memberships: new FormData(f).getAll('memberships'),
        showAlcohol: f.showAlcohol.checked,
      },
    });
    await loadConfig();
    // Liquor shops come and go from "Shops I use" with Show alcohol: redraw it from the saved choice.
    const boxes = $('#shops-form [data-shop-boxes]');
    boxes.innerHTML = '';
    renderShopBoxes(boxes);
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
  const change = new URLSearchParams(location.search).get('change');
  if (change) {
    // A link from "Change email".
    $('#verify-title').textContent = 'Changing your email…';
    $('#verify-msg').textContent = '';
    try {
      const { user: u } = await api('/api/auth/confirm-email-change', { method: 'POST', body: { token: change } });
      $('#verify-title').textContent = 'Email changed';
      $('#verify-msg').textContent = `Your account now uses ${u.email}. Log in with it from now on.`;
      await loadConfig();
    } catch (err) {
      $('#verify-title').textContent = 'That link didn’t work';
      $('#verify-msg').textContent = `${err.message} You can ask for a new one in Settings.`;
    }
    return;
  }
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

$('#email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const done = f.querySelector('[data-form-done]');
  done.hidden = true;
  try {
    const email = f.email.value.trim();
    await api('/api/me/email', { method: 'POST', body: { email, password: f.password.value } });
    formError(f, null);
    f.reset();
    done.textContent = `Check ${email} for a link to confirm it. (We’ve also told your current address.)`;
    done.hidden = false;
  } catch (err) {
    formError(f, err);
  }
});

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
    <p>Nothing about you is stored on the server. Your browser keeps your chosen IGA store and last-opened list (in its own storage) so the site remembers them. There are no ads, no trackers, and no analytics. If you scan a barcode, the camera picture stays on your phone; only the barcode number is sent, to look up the product.</p>
    <h3>If you create an account</h3>
    <ul>
      <li><strong>Your name and email</strong> — to log you in, and to email you only what you ask for: confirming your address, password resets, and the alerts you turn on.</li>
      <li><strong>Your password</strong> — stored only as a one-way scrypt hash; nobody can read it.</li>
      <li><strong>Your lists, settings and price watches</strong> — to provide the service. Shared lists are visible to everyone you invite.</li>
      <li><strong>Your finished shops</strong> — what you bought and what it cost, for your saved shops and spending page. Everyone on a shared list sees its shops.</li>
      <li><strong>The order you tick things off in each shop</strong> (which shop, which section, when — not where you are) — only to sort your checklist the way you walk that shop. Kept for 6 months; you can reset it from the checklist.</li>
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

// Coles prices that were over a day old are being fetched: ask again once, a few seconds later.
let refreshTimer = null;

async function runSearch({ again = false } = {}) {
  clearTimeout(refreshTimer);
  const seq = ++searchSeq;
  const params = new URLSearchParams({
    q: $('#q').value.trim(),
    store: $('#store-filter').value,
    mode: $('#mode-filter').value,
    specials: $('#specials').checked ? '1' : '',
  });
  const box = $('#results');
  // Nothing searched or filtered: the home page.
  if (!params.get('q') && !params.get('store') && !params.get('specials')) return renderHome(seq);
  // Grey outlines while the first results load (later searches keep the old results until the new ones arrive).
  setTimeout(() => {
    if (seq === searchSeq && !box.querySelector('.row, .best-price')) box.innerHTML = skeleton(4);
  }, 200);
  try {
    // The cheapest of it, any brand (only for a plain search across all shops).
    const wantBest = params.get('q') && !params.get('store') && !params.get('specials');
    const [groups, best] = await Promise.all([
      api(withIga(`/api/search?${params}`)),
      wantBest ? api(withIga(`/api/best-price?${new URLSearchParams({ q: params.get('q') })}`)).catch(() => null) : null,
    ]);
    if (seq !== searchSeq) return;
    if (best?.refreshing && !again) {
      refreshTimer = setTimeout(() => {
        if (seq === searchSeq) runSearch({ again: true });
      }, 6000);
    }
    const bestHtml = renderBestPrice(best);
    if (!groups.length) {
      box.innerHTML = bestHtml || '<div class="empty">No matching products.</div>';
      return;
    }
    box.style.setProperty('--store-cols', state.stores.length);
    box.innerHTML = `${bestHtml}${bestHtml ? '<h2 class="section">All products</h2>' : ''}<div class="row head"><span></span><span>Product</span>${state.stores.map((s) => `<span>${chip(s)}${s === 'iga' ? `<button type="button" class="linkish col-sub" data-change-iga>${esc(igaShortName(state.config.igaStore))} ▾</button>` : ''}</span>`).join('')}<span></span></div>`
      + groups.map(renderGroup).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ home page
// Before you search: your regulars that are on sale, and specials that are
// out of the ordinary (not the usual every-few-weeks cycle).

async function renderHome(seq) {
  const box = $('#results');
  let h;
  try {
    h = await api(withIga('/api/home'));
  } catch (e) {
    box.innerHTML = `<div class="empty">Couldn’t load deals: ${esc(e.message)}</div>`;
    return;
  }
  if (seq !== searchSeq) return;
  const regulars = h.regulars == null
    ? `<p class="hint"><a href="/login">Log in</a> to see the things you buy often whenever they’re on sale.</p>`
    : h.regulars.length ? `<div class="deal-grid">${h.regulars.map(regularCard).join('')}</div>`
      : '<p class="hint">Nothing you buy often is on sale at your shops right now. This fills in as you use your lists and finish shops.</p>';
  const unusual = h.unusual.length ? `<div class="deal-grid">${h.unusual.map(unusualCard).join('')}</div>`
    : '<p class="hint">Nothing out of the ordinary today. Deals show up here when something is cheaper than its specials usually get, or on special for the first time in months.</p>';
  const sections = [
    `<section class="home-section"><h2>Your regulars on sale</h2>${regulars}</section>`,
    `<section class="home-section"><h2>Unusual deals <span class="hint">specials that don’t come round often</span></h2>${unusual}</section>`,
  ];
  // Put whichever has something to show first.
  if (!h.regulars?.length) sections.reverse();
  box.innerHTML = `${sections.join('')}
    <p><button type="button" class="small" id="browse-specials">Browse all specials</button></p>`;
}

function dealCardShell(p, inner) {
  return `<article class="deal-card">
    ${thumb(p)}
    <div class="deal-body">${inner}</div>
    <button class="add small" data-add="${p.id}">+ List</button>
  </article>`;
}

function unusualCard({ product: p, deal }) {
  return dealCardShell(p, `
    <div class="deal-tag-row"><span class="badge special">−${deal.pctOff}%</span> <span class="deal-why">${esc(deal.headline)}</span></div>
    <a href="#" class="deal-name" data-product="${p.id}">${esc(p.name)}</a>
    <div class="hint">${chip(p.store)}${p.size_text ? ` · ${esc(p.size_text)}` : ''}</div>
    <div><span class="price">${money(p.price)}</span> <span class="was">usually ${money(deal.usual)}</span></div>`);
}

function regularCard({ anchor, times, product: p, deal }) {
  const same = p.id === anchor.id || p.name === anchor.name;
  return dealCardShell(p, `
    <div class="deal-tag-row"><span class="badge special">−${deal.pctOff}%</span> <span class="deal-why">${esc(deal.text)}</span></div>
    <a href="#" class="deal-name" data-product="${p.id}">${esc(p.name)}</a>
    <div class="hint">${chip(p.store)}${p.size_text ? ` · ${esc(p.size_text)}` : ''}${same ? '' : ` · instead of your ${esc(anchor.name)}`}</div>
    <div><span class="price">${money(deal.unit)}</span>${deal.kind === 'multi' ? ' each' : ''} <span class="was">usually ${money(deal.regular)}</span></div>
    <div class="hint">${times >= 3 ? 'You buy this often' : 'On your lists'}</div>`);
}

$('#results').addEventListener('click', (e) => {
  if (e.target.id !== 'browse-specials') return;
  $('#specials').checked = true;
  runSearch();
});

// ------------------------------------------------------------------ cheapest of what you searched for
// "1l milk": the cheapest 1L milk, any brand. "milk": the cheapest of each
// common size, with the best value per litre / kg / item highlighted.

const perUnitText = (p) => (p.perUnit != null ? `${money(p.perUnit)}/${esc(p.unitWord)}` : '');

/**
 * Price per kg, L or item, worked out the same way for every shop (their own
 * texts differ: "$0.81 / 1EA", "$4.90/ 1kg"…). Falls back to the shop's text.
 */
function unitText(p) {
  const price = shownPrice(p);
  if (price == null) return '';
  if (p.per_weight) return p.size_unit === 'ea' ? '' : `${money(price)}/kg`;
  if (p.size_qty > 0 && p.size_unit === 'g') return `${money((price / p.size_qty) * 1000)}/kg`;
  if (p.size_qty > 0 && p.size_unit === 'ml') return `${money((price / p.size_qty) * 1000)}/L`;
  if (p.size_qty > 1 && p.size_unit === 'ea') return `${money(price / p.size_qty)}/item`;
  return p.size_qty ? '' : esc(p.unit_price_text || '');
}

// Short enough for five across a phone screen.
const SHORT_STORE = { woolworths: 'Woolies', harrisfarm: 'Harris F.', danmurphys: 'Dan’s', liquorland: 'Liquorl.' };

function renderBestPrice(b) {
  if (!b || !b.groups?.length) return '';
  const what = esc(b.query.replace(/\s+/g, ' '));
  // The first few type chips, then "+N" for the rest.
  const CHIPS = 4;
  const chips = b.variants?.length
    ? `<div class="variant-chips">${b.mixed ? '<span class="hint">All types shown. Just:</span>' : ''}
        ${b.variants.map((v, i) => `<button type="button" class="chip" data-narrow="${esc(v.word)}" ${i >= CHIPS ? 'hidden data-more' : ''}>${esc(v.label)}</button>`).join('')}
        ${b.variants.length > CHIPS ? `<button type="button" class="chip ghost" data-show-more>+${b.variants.length - CHIPS}</button>` : ''}</div>`
    : '';
  if (b.size) {
    const g = b.groups[0];
    const [top, ...rest] = g.products;
    const stores = state.allStores.filter((s) => g.cheapestPerStore?.[s]);
    const low = Math.min(...stores.map((s) => g.cheapestPerStore[s].price));
    const SHOWN = 4;
    const noun = esc(b.query.replace(/\b\d\S*\s*(ml|l|g|kg|pack)?\b/gi, '').trim());
    return `<section class="best-price">
      <h2>Cheapest ${esc(niceQuery(b.query.replace(/\s+/g, ' ')))}</h2>
      <div class="hint bp-sub">${plural(g.count, 'product')} compared, any brand${b.mixed ? '' : ` · regular ${noun}`}${b.refreshing ? ' · <span class="state pending">checking Coles for today’s prices…</span>' : ''}</div>
      ${chips}
      <div class="bp-top">
        ${thumb(top)}
        <div class="bp-name"><a href="#" class="plain-link" data-product="${top.id}">${esc(top.name)}</a>
          <div class="hint">${chip(top.store)}</div></div>
        <div class="bp-price"><span class="price big">${money(top.price)}</span><span class="hint">${perUnitText(top)}</span>${dealBadges(top)}</div>
      </div>
      <div class="bp-add"><button class="add primary" data-add-cheapest="${esc(b.query)}" title="Keeps picking whichever ${what} is cheapest as prices change">+ Add cheapest</button>
        <button class="add" data-add="${top.id}">+ This one</button></div>
      ${stores.length > 1 ? `<div class="bp-shops">${stores.map((s) => `<div class="${g.cheapestPerStore[s].price <= low + 0.004 ? 'win' : ''}">
        <span>${esc(SHORT_STORE[s] || storeName(s))}</span><b>${money(g.cheapestPerStore[s].price)}</b></div>`).join('')}</div>` : ''}
      ${rest.length ? `<ol class="bp-rank">${rest.map((p, i) => `<li ${i >= SHOWN ? 'hidden data-more' : ''}>
        <span class="bp-n">${i + 2}</span>
        <div class="bp-row-name" data-product="${p.id}"><div>${esc(p.name)}</div><small>${chip(p.store)}</small></div>
        <div class="bp-row-price">${money(p.price)}<small>${perUnitText(p)}</small></div>
        <button class="add round" data-add="${p.id}" aria-label="Add ${esc(p.name)} to the list">+</button></li>`).join('')}</ol>
        ${rest.length > SHOWN ? `<button type="button" class="linkish bp-more" data-show-more>Show ${rest.length - SHOWN} more ▾</button>` : ''}` : ''}
    </section>`;
  }
  return `<section class="best-price">
    <h2>Cheapest ${what} ${b.produce ? '<span class="hint">by the kilo, and each</span>' : 'by size <span class="hint">any brand</span>'}</h2>
    ${b.refreshing ? '<div class="hint"><span class="state pending">Checking Coles for today’s prices…</span></div>' : ''}
    ${chips}
    <div class="size-cards">${b.groups.map((g) => {
      const p = g.products[0];
      return `<div class="size-card ${g.bestValue ? 'best' : ''}">
        <div class="size-label">${esc(g.label)}${g.bestValue ? ` <span class="badge cheap">★ Best value per ${esc(p.unitWord)}</span>` : ''}</div>
        <a href="#" class="deal-name" data-product="${p.id}">${esc(p.name)}</a>
        <div class="hint">${chip(p.store)}</div>
        <div><span class="price">${money(p.price)}</span> <span class="hint">${perUnitText(p)}</span></div>
        ${b.produce && g.cheapestPerStore ? `<div class="per-store hint">${state.allStores.filter((s) => g.cheapestPerStore[s] && s !== p.store)
          .map((s) => `${chip(s)} ${perUnitText(g.cheapestPerStore[s])}`).join(' · ')}</div>` : ''}
        <div class="actions">${g.qty ? `<button class="add small primary" data-add-cheapest="${esc(`${b.query} ${g.label}`)}" title="Keeps picking whichever is cheapest as prices change">+ Add cheapest</button>` : ''}
          <button class="add small" data-add="${p.id}">+ ${g.qty ? 'This one' : 'List'}</button>
          ${g.qty ? `<button type="button" class="small ghost" data-size-search="${esc(g.label)}">All ${esc(g.label)} (${g.count})</button>` : ''}</div>
      </div>`;
    }).join('')}</div>
  </section>`;
}

// Narrow a search: a type ("lactose free") or a size ("2L").
$('#results').addEventListener('click', (e) => {
  const more = e.target.closest('[data-show-more]');
  if (more) {
    more.parentElement.closest('section, .variant-chips').querySelectorAll(more.closest('.variant-chips') ? '.chip[data-more]' : 'li[data-more]')
      .forEach((el) => { el.hidden = false; });
    more.remove();
    return;
  }
  const narrow = e.target.closest('[data-narrow]');
  const size = e.target.closest('[data-size-search]');
  if (!narrow && !size) return;
  const q = $('#q');
  q.value = `${q.value.trim()} ${narrow ? narrow.dataset.narrow : size.dataset.sizeSearch}`;
  window.scrollTo(0, 0);
  runSearch();
});

const NO_IMAGE = '<div class="thumb none" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 8h14l-1.4 11.2a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg></div>';

function thumb(p) {
  return p.image_url
    ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : NO_IMAGE;
}

// A product photo that won't load gets the same placeholder (inline onerror isn't allowed by the page's security policy).
document.addEventListener('error', (e) => {
  if (e.target.matches?.('img.thumb')) e.target.outerHTML = NO_IMAGE;
}, true);

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
  const label = `<span class="store-label">${chip(store)}</span>`;
  if (!match) return `<div class="cell none">${label}—</div>`;
  const p = match.product;
  const alt = p.id !== anchor.id && p.name !== anchor.name ? `<span class="alt" title="${esc(p.name)}">${esc(p.name)}</span>` : '';
  const price = shownPrice(p);
  return `<div class="cell ${store === cheapest ? 'cheapest' : ''}">${label}
    <span><span class="price">${money(price)}</span>${p.was_price ? `<span class="was">${money(p.was_price)}</span>` : price < p.price ? `<span class="was">${money(p.price)}</span>` : ''}
    <span class="unit">${store === cheapest ? '<span class="badge cheap">✓ Cheapest</span>' : ''}${p.on_special ? '<span class="badge special">Special</span>' : ''}${unitText(p)}</span>
    ${dealBadges(p)}${alt}</span>
  </div>`;
}

/** "3L is 18% cheaper per litre" line. */
/** What pinning an item to one shop is doing. */
function pinNote(it) {
  const p = it.pin;
  if (!p) return '';
  const shop = esc(storeName(p.store));
  if (!p.honoured) {
    const why = p.reason === 'shop-excluded' ? `${shop} is switched off for this list` : `${shop} doesn’t have it at the moment`;
    return `<div class="pin-note warn">📌 Set to always buy at ${shop}, but ${why} — getting it at the cheapest shop instead.</div>`;
  }
  return `<div class="pin-note">📌 Always bought at ${shop}${p.extra > 0.004 ? ` — <strong>${money(p.extra)} more</strong> than at ${esc(storeName(p.cheapest))}` : p.cheapest === p.store ? ' (the cheapest anyway)' : ''}.</div>`;
}

/** "Is this a good price?" from the product's history. Nothing for ordinary prices unless `always`. */
function insightNote(ins, { always = false } = {}) {
  if (!ins || ins.verdict === 'unknown' && !always) return '';
  if (ins.verdict === 'normal' && !always) return '';
  const icon = { great: '✅', good: '👍', wait: '⏳', high: '📈', normal: '•', unknown: '•' }[ins.verdict];
  return `<div class="insight insight-${ins.verdict}">${icon} <strong>${esc(ins.headline || 'No price history yet')}</strong>${ins.detail ? ` — ${esc(ins.detail)}` : ''}</div>`;
}

/** "3L is 18% cheaper per litre". On a list item (itemId), with a button to swap to it. */
function valueHint(bv, itemId = null) {
  if (!bv) return '';
  const p = bv.product;
  const squash = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  return `<div class="value-hint">💡 Better value: <a href="#" data-product="${p.id}">${esc(p.name)}${p.size_text && !squash(p.name).includes(squash(p.size_text)) ? ` ${esc(p.size_text)}` : ''}</a>
    at ${esc(storeName(p.store))} is <strong>${bv.savingPct}% cheaper per ${esc(bv.unit)}</strong> (${money(bv.perUnit)} vs ${money(bv.basePerUnit)}).
    ${itemId ? `<button type="button" class="small" data-swap-item="${itemId}" data-swap-to="${p.id}">Swap to this</button>` : ''}</div>`;
}

function renderGroup(g) {
  const a = g.anchor;
  const n = g.memberCount ?? g.members?.length ?? 1;
  return `<div class="row">
    ${thumb(a)}
    <div class="title" data-product="${a.id}">
      <strong>${esc(a.name)}</strong>
      <span class="meta">${esc(a.size_text || '')} · ${n > 1 ? `${n} equivalent products` : 'no equivalents found'}</span>
    </div>
    ${state.stores.map((s) => priceCell(s, g.best[s], g.cheapest, a)).join('')}
    ${(() => {
      const missing = state.stores.filter((s) => !g.best[s]);
      return missing.length && missing.length < state.stores.length ? `<div class="missing-shops hint">Not at ${missing.map((s) => esc(storeName(s))).join(', ')}</div>` : '';
    })()}
    <button class="add small" data-add="${a.id}">+ List</button>
    ${valueHint(g.betterValue)}
  </div>`;
}

/** "The cheapest milk 2L, any brand": a list item that picks itself as prices change. */
async function addCheapestToList(query) {
  if (!requireLogin('Create an account (or log in) to keep a shopping list.')) return;
  await ensureLists();
  const list = state.lists.find((l) => l.id === state.listId);
  await api(`/api/lists/${state.listId}/items`, { method: 'POST', body: { cheapest: query } });
  toast(`Added the cheapest ${query} to ${list?.name || 'your list'} — it'll follow the prices`);
  refreshListCount();
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
  const cheapest = e.target.closest('[data-add-cheapest]');
  if (cheapest) {
    try {
      await addCheapestToList(cheapest.dataset.addCheapest);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
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
        <div class="hint">${chip(p.store)} · ${esc(p.size_text || '')} · ${esc(p.category || '')}</div>
        <div><strong>${money(shownPrice(p))}</strong> ${p.was_price ? `<span class="hint"><s>${money(p.was_price)}</s></span>` : ''} ${dealBadges(p)}
          ${s ? `<span class="hint">· lowest ${money(s.min)}, highest ${money(s.max)}, ${plural(s.changes, 'change')} since ${fmtDate(s.since)}</span>` : ''}</div>
        ${insightNote(d.insight, { always: true })}
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
        <td>${chip(x.store)}</td>
        <td><a href="#" data-product="${x.id}">${esc(x.name)}</a> ${x.on_special ? '<span class="tag-special">SPECIAL</span>' : ''} ${dealBadges(x)}</td>
        <td class="num">${money(shownPrice(x))}</td>
        <td class="num">${unitText(x)}</td>
        <td class="num">${x.via === 'barcode' ? '<span title="Same barcode">barcode</span>' : x.via === 'confirmed' ? 'confirmed' : `${Math.round(x.score * 100)}%`}</td>
        <td class="row-actions"><button class="small" data-add="${x.id}">+ List</button>
          ${x.id !== p.id ? `<button class="small ghost" data-report="${x.id}" data-anchor="${p.id}" title="These aren’t the same product">Wrong match?</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">Products are matched by barcode where the stores publish one, otherwise by size and name. Spotted a wrong match? Use “Wrong match?” and an admin will fix it for everyone.</p>`;
  await loadChartLibrary();
  drawHistory(d);
}

function historyTable(d) {
  const byId = Object.fromEntries(d.charted.map((c) => [c.id, c]));
  return `<table class="data"><thead><tr><th>Date</th><th>Store</th><th>Product</th><th class="num">Price</th></tr></thead><tbody>
    ${[...d.history].reverse().map((h) => {
      const c = byId[h.product_id];
      return `<tr><td>${fmtDate(h.recorded_at)}</td><td>${chip(c.store)}</td>
      <td>${esc(c.name)}</td><td class="num">${money(h.price)}${h.on_special ? ' <span class="tag-special">SPECIAL</span>' : ''}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

/** The chart library is only needed for price history and spending, so it loads on first use. */
let chartLibrary = null;
function loadChartLibrary() {
  if (window.Chart) return Promise.resolve();
  chartLibrary ||= loadScript('/vendor/chart.js/chart.umd.js').catch((e) => {
    chartLibrary = null;
    throw e;
  });
  return chartLibrary;
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

/** Grey outlines of `n` cards, shown while something loads. */
function skeleton(n = 3) {
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${'<div class="skel-card"><div class="skel w60"></div><div class="skel w40"></div><div class="skel w80"></div></div>'.repeat(n)}</div>`;
}

async function loadList() {
  const root = $('#list-root');
  if (user() && !root.children.length) root.innerHTML = skeleton(3);
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
  // Reopening the app mid-shop goes straight back to the checklist.
  if (!state.shopping && shopPref('on', false)) setShopping(true);
  if (!state.list.items.length && state.shopping) setShopping(false);
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
        <button class="small" id="shop-mode" ${L.items.length ? '' : 'disabled'}>🛒 In the shop</button>
        <details class="list-menu"><summary class="button small" aria-label="More list options">⋯</summary>
          <div class="menu">
            <button class="small ghost" id="share-list">Share${others.length ? ` · ${others.length + 1} people` : ''}</button>
            <button class="small ghost" id="snapshots-btn">Saved shops</button>
            <button class="small ghost" id="spending-btn">Spending</button>
            <button class="small ghost" id="new-list">+ New list</button>
            <button class="small ghost" id="rename-list">Rename</button>
            ${isOwner ? '<button class="small ghost" id="delete-list">Delete list</button>' : '<button class="small ghost" id="leave-list">Leave list</button>'}
            <button class="small ghost" id="clear-list" ${L.items.length ? '' : 'disabled'}>Clear all items</button>
          </div></details>
      </div>
    </div>
    ${others.length ? `<p class="hint">Shared with ${others.map((m) => esc(m.name)).join(', ')}. Changes anyone makes show up for everyone.</p>` : ''}
    <form id="quick-add" class="quick-add">
      <input name="note" maxlength="120" placeholder="Add something — e.g. milk 2L, or birthday card" aria-label="Add to the list" autocomplete="off">
      <button class="small" type="submit">Add</button>
      <button class="small ghost" type="button" id="quick-note" title="Add exactly what you typed, without looking for a product">Add as note</button>
      <button class="small ghost" type="button" id="paste-list">Paste a list</button>
    </form>
    <div id="items">${L.items.length ? L.items.map(renderItem).join('') : '<div class="empty">This list is empty. Search on the <a href="#" data-goto="compare">Compare</a> tab and press “+ List”, or add a <button type="button" class="linkish" id="snapshots-empty">saved shop</button>.</div>'}</div>
    ${L.items.length ? totalBar(L) : ''}
    ${renderStorePanel(L)}
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

// ------------------------------------------------------------------ barcode scanning
// In the shop: scan something to tick it off, or to see what it costs at the
// other shops. Uses the phone's built-in barcode reader where there is one
// (Android Chrome), otherwise a JavaScript reader loaded on first use.

const scanner = { stream: null, timer: null, busy: false, last: '' };
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Couldn’t load the barcode reader'));
    document.head.append(el);
  });
}

/** A function that reads a barcode from the video, or null if there isn't one in view. */
async function makeDecoder(video) {
  if ('BarcodeDetector' in window) {
    const supported = await BarcodeDetector.getSupportedFormats?.().catch(() => []) || [];
    const formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
    if (formats.length) {
      const detector = new BarcodeDetector({ formats });
      return async () => (await detector.detect(video))[0]?.rawValue || null;
    }
  }
  if (!window.ZXing) await loadScript('/vendor/zxing/index.min.js');
  const Z = window.ZXing;
  const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]], [Z.DecodeHintType.TRY_HARDER, true]]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement('canvas');
  return async () => {
    if (!video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
    try {
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decode(bitmap).getText();
    } catch {
      return null; // nothing readable in this frame
    }
  };
}

function stopScanner() {
  clearTimeout(scanner.timer);
  scanner.stream?.getTracks().forEach((t) => t.stop());
  scanner.stream = null;
}

async function openScanner() {
  const dlg = $('#scan-dialog');
  $('#scan-result').innerHTML = '';
  $('#scan-status').textContent = 'Point the camera at a barcode.';
  scanner.last = '';
  dlg.showModal();
  const video = $('#scan-video');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t use the camera here (it needs a secure https:// address). You can type the number instead.');
    scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    video.srcObject = scanner.stream;
    await video.play();
    const decode = await makeDecoder(video);
    const loop = async () => {
      if (!scanner.stream) return;
      if (!scanner.busy) {
        const code = await decode().catch(() => null);
        if (code && code !== scanner.last) {
          scanner.last = code;
          navigator.vibrate?.(60);
          await handleBarcode(code);
        }
      }
      scanner.timer = setTimeout(loop, 250);
    };
    loop();
  } catch (err) {
    $('#scan-status').textContent = err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser settings, or type the number below.' : err.message;
  }
}
$('#scan-dialog').addEventListener('close', stopScanner);
$('#compare-scan').addEventListener('click', () => openScanner());
$('#scan-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = e.target.code.value.trim();
  if (code) handleBarcode(code);
});

/** Find a scanned product on the list (any shop's version of it) and tick it, or show its prices. */
async function handleBarcode(code) {
  scanner.busy = true;
  const strip = (c) => String(c || '').replace(/^0+/, '');
  const box = $('#scan-result');
  try {
    $('#scan-status').textContent = `Scanned ${code}`;
    const L = state.list;
    const found = await api(withIga(`/api/barcode/${encodeURIComponent(code)}`));
    const ids = new Set(found.found ? [...found.sameBarcode, ...Object.values(found.best).map((b) => b.product.id)] : []);
    // Which list item is it? Match the barcode itself, or any product the item would buy.
    const onList = L && state.shopping && L.items.find((it) => it.note == null && (
      strip(it.anchor.barcode) === strip(code) || ids.has(it.anchor.id)
      || Object.values(it.perStore).some((ps) => ps.product && (ids.has(ps.product.id) || strip(ps.product.barcode) === strip(code)))));
    if (onList) {
      const store = onList.cheapest;
      const x = store && L.plan.byStore[store]?.items.find((i) => i.itemId === onList.id);
      const already = isTicked(onList);
      if (!already) await tick(onList.id, true, { store, aisle: x?.aisle || onList.aisle });
      box.innerHTML = `<p class="scan-hit">✓ ${already ? 'Already ticked' : 'Ticked off'}: <strong>${esc(onList.anchor.name)}</strong></p>`;
      return;
    }
    if (!found.found) {
      box.innerHTML = '<p>We don’t know that barcode yet. Barcodes come from Woolworths and Coles, so some products (like ALDI’s own brands) can’t be scanned.</p>';
      return;
    }
    const stores = state.allStores.filter((s) => found.best[s]);
    box.innerHTML = `<div class="scan-product"><strong>${esc(found.anchor.name)}</strong> <span class="hint">${esc(found.anchor.size_text || '')}</span>
      <ul class="scan-prices">${stores.map((s) => `<li class="${s === found.cheapest ? 'win' : ''}">${chip(s)}
        <span>${money(shownPrice(found.best[s].product))}${s === found.cheapest ? ' · <strong class="saving">cheapest</strong>' : ''}</span></li>`).join('')}</ul>
      ${state.shopping ? '<p class="hint">Not on your list.</p>' : ''}
      <div class="actions"><button class="small primary" data-scan-add="${found.anchor.id}">+ Add to list</button>
        <button class="small" data-product="${found.anchor.id}">Price history</button></div></div>`;
  } catch (err) {
    box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
  } finally {
    scanner.busy = false;
  }
}

$('#scan-result').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-scan-add]');
  const product = e.target.closest('[data-product]');
  if (product) {
    $('#scan-dialog').close();
    return openProduct(Number(product.dataset.product));
  }
  if (!add) return;
  if (!requireLogin('Log in to keep a shopping list.')) return;
  try {
    await ensureLists();
    await api(`/api/lists/${state.listId}/items`, { method: 'POST', body: { productId: Number(add.dataset.scanAdd) } });
    add.disabled = true;
    add.textContent = '✓ Added';
    if (currentTab() === 'list') loadList();
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ spending

let spendingChart = null;

async function openSpending() {
  const box = $('#spending-detail');
  box.innerHTML = '<p class="hint">Loading…</p>';
  $('#spending-dialog').showModal();
  const sp = await api(`/api/lists/${state.listId}/spending`);
  if (!sp.shops.length) {
    box.innerHTML = `<h2>Spending</h2><p>No finished shops yet.</p>
      <p class="hint">When you’re done shopping, press <strong>Finish shop</strong> in “🛒 In the shop”. What you ticked off is recorded here with what it cost.</p>`;
    return;
  }
  const label = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
  box.innerHTML = `<h2>Spending on “${esc(state.list.name)}”</h2>
    <div class="totals spend-tiles">
      <div class="tile"><div class="label">Last 30 days</div><div class="value">${money(sp.last30)}</div></div>
      <div class="tile"><div class="label">Average shop</div><div class="value">${money(sp.average)}</div><div class="note">${plural(sp.shops.length, 'shop')}</div></div>
      <div class="tile"><div class="label">Saved by splitting shops</div><div class="value saving">${money(sp.saved)}</div>
        <div class="note">vs buying it all at one shop</div></div>
    </div>
    ${sp.months.length > 1 ? '<h3>By month</h3><div class="chart-wrap short"><canvas id="spending-chart" aria-label="Spending by month"></canvas></div>' : ''}
    <h3>Shops</h3>
    <div class="table-scroll"><table class="data">
      <thead><tr><th>Date</th><th>Where</th><th class="num">Items</th><th class="num">Cost</th><th class="num">Saved</th></tr></thead>
      <tbody>${sp.shops.map((x) => `<tr><td class="nowrap">${fmtDate(x.at)}</td>
        <td>${Object.keys(x.byStore).map((st) => `${chip(st)}`).join(' ')}</td>
        <td class="num">${x.items}</td><td class="num">${money(x.spent)}</td>
        <td class="num">${x.oneShop ? `<span class="saving" title="${esc(`All at ${storeName(x.oneShop.store)}: ${money(x.oneShop.total)}`)}">${money(x.saved)}</span>` : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">Costs are worked out from the online prices when each shop was finished, assuming you bought each item at the shop it was planned for. Notes aren’t counted.</p>`;
  if (sp.months.length > 1) await loadChartLibrary().catch(() => {});
  if (sp.months.length > 1 && window.Chart) {
    spendingChart?.destroy();
    spendingChart = new Chart($('#spending-chart'), {
      type: 'bar',
      data: { labels: sp.months.map((m) => label(m.month)), datasets: [{ data: sp.months.map((m) => m.total), backgroundColor: cssVar('--accent'), borderRadius: 4 }] },
      options: {
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => ` ${money(it.parsed.y)}` } } },
        scales: {
          x: { ticks: { color: cssVar('--text-2') }, grid: { display: false } },
          y: { ticks: { color: cssVar('--text-2'), callback: (v) => `$${v}` }, grid: { color: cssVar('--border') } },
        },
      },
    });
  }
}

// ------------------------------------------------------------------ notes & pasting a list

/**
 * Match typed lines to products and let the shopper confirm. With `noteItem`,
 * it's finding a product for one note already on the list.
 */
async function openPaste(text = '', noteItem = null, direct = false) {
  const box = $('#paste-detail');
  const step1 = () => {
    box.innerHTML = `<h2>Paste a list</h2>
      <p class="hint">One item per line, or separated by commas. Quantities like “2 x chips” or “chips x2” work.</p>
      <form id="paste-form" class="stack">
        <textarea name="text" rows="8" placeholder="milk&#10;bread&#10;2 x chips&#10;birthday card" required>${esc(text)}</textarea>
        <button class="primary" type="submit">Find products</button>
      </form>`;
    $('#paste-form').addEventListener('submit', (e) => {
      e.preventDefault();
      step2(e.target.text.value);
    });
  };
  const step2 = async (t) => {
    box.innerHTML = '<p class="hint">Finding products…</p>';
    let rows;
    try {
      rows = await api(`/api/lists/${state.listId}/paste-preview`, { method: 'POST', body: { text: t } });
    } catch (err) {
      box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
      return;
    }
    if (!rows.length) return step1();
    // Typed into the list's Add box (direct): pick a product, the first match by default.
    const pickFirst = (r) => r.options.length && (r.confident || noteItem || direct);
    box.innerHTML = `<h2>${noteItem ? `Find “${esc(noteItem.note)}”` : direct ? 'Add to the list' : 'Check the matches'}</h2>
      <p class="hint">${noteItem ? 'Pick the product to compare prices for.' : 'Pick the product, or keep what you typed as a note.'}</p>
      <form id="paste-confirm" class="stack">
        <ul class="paste-rows">${rows.map((r, i) => `<li>
          <div class="paste-line"><span>${esc(r.line)}</span>${r.confident || noteItem ? '' : ' <span class="hint">· not sure</span>'}</div>
          <div class="paste-pick">
            ${noteItem ? '' : `<input class="qty" type="number" min="1" max="99" name="qty${i}" value="${r.quantity}" aria-label="Quantity">`}
            <select name="pick${i}" aria-label="Product for ${esc(r.line)}">
               ${r.options.map((o, j) => `<option value="${o.cheapest && o.query ? `cheapest:${esc(o.query)}` : o.productId}" ${j === 0 && pickFirst(r) ? 'selected' : ''}>${o.bestValue ? `★ Best value per ${esc(o.unitWord)}${o.query ? ', updates itself' : ''}: ` : o.cheapest ? (o.query ? '★ Cheapest, updates itself: ' : '★ Cheapest: ') : ''}${esc(o.name)}${o.size && !o.name.toLowerCase().replace(/\s+/g, '').includes(o.size.toLowerCase().replace(/\s+/g, '')) ? ` (${esc(o.size)})` : ''}${o.price != null ? ` — ${o.cheapest ? '' : 'from '}${money(o.price)}${o.perUnit != null ? ` (${money(o.perUnit)}/${esc(o.unitWord)})` : ''} at ${esc(storeName(o.store))}` : ''}</option>`).join('')}
              ${noteItem ? '' : `<option value="note" ${pickFirst(r) ? '' : 'selected'}>Keep as a note: “${esc(r.query)}”</option>`}
            </select>
          </div></li>`).join('')}</ul>
        ${noteItem && !rows[0].options.length ? '<p class="warn">No products found. Try different words.</p>' : ''}
        <div class="actions">
          <button type="button" class="ghost" id="paste-back">Back</button>
          <button class="primary" type="submit" ${noteItem && !rows[0].options.length ? 'disabled' : ''}>${noteItem ? 'Use this product' : `Add ${plural(rows.length, 'item')}`}</button>
        </div>
      </form>`;
    $('#paste-back').addEventListener('click', () => (noteItem || direct ? $('#paste-dialog').close() : step1()));
    $('#paste-confirm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        if (noteItem) {
          await api(`/api/items/${noteItem.id}`, { method: 'PATCH', body: { productId: Number(f.pick0.value) } });
          toast('Now comparing prices for it');
        } else {
          const lines = rows.map((r, i) => {
            const pick = f[`pick${i}`].value;
            const quantity = Number(f[`qty${i}`].value) || 1;
            if (pick === 'note') return { note: r.query, quantity };
            if (pick.startsWith('cheapest:')) return { cheapest: pick.slice(9), quantity };
            return { productId: Number(pick), quantity };
          });
          const res = await api(`/api/lists/${state.listId}/paste`, { method: 'POST', body: { lines } });
          toast(`Added ${plural(res.added, 'item')}`);
        }
        $('#paste-dialog').close();
        loadList();
      } catch (err) {
        toast(err.message);
      }
    });
  };
  if (noteItem) step2(noteItem.note);
  else if (direct) step2(text);
  else step1();
  $('#paste-dialog').showModal();
}

// ------------------------------------------------------------------ in the shop
// Shopping in person: the list split into one checklist per shop, each sorted
// by product type in the order you walk a supermarket. Ticking crosses an item
// out. Ticks sync to everyone on the list; offline, they're kept on the phone
// and sent later. Which shop you're looking at and "hide ticked" are
// remembered on this device.

state.shopping = false;

const shopPref = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(`shop:${key}:${state.listId}`)) ?? fallback;
  } catch {
    return fallback;
  }
};
const setShopPref = (key, value) => {
  try {
    localStorage.setItem(`shop:${key}:${state.listId}`, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
};

// Keep the phone's screen on while shopping, where the browser allows it.
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* not allowed (battery saver etc.) */
  }
}
document.addEventListener('visibilitychange', () => state.shopping && keepScreenOn(true));

function setShopping(on) {
  state.shopping = on;
  setShopPref('on', on);
  keepScreenOn(on);
}

function renderShopping() {
  const L = state.list;
  const itemById = Object.fromEntries(L.items.map((it) => [it.id, it]));
  const pending = pendingTicks();
  const isChecked = (it) => (it.id in pending ? tickState(pending[it.id]) : !!it.checkedAt);
  // Section order: the usual supermarket order, or the one learned from how you walk this shop.
  const defaultRank = Object.fromEntries(L.aisles.map((a, i) => [a.key, i / (L.aisles.length - 1)]));
  const rankIn = (store, aisle) => L.layouts?.[store]?.ranks[aisle] ?? defaultRank[aisle] ?? 1;
  const aisleLabel = Object.fromEntries(L.aisles.map((a) => [a.key, a.label]));

  // One list per shop, plus the things none of your shops have.
  const lists = state.allStores.filter((s) => L.plan.byStore[s]?.items.length).map((store) => ({
    id: store,
    title: `${chip(store)}`,
    name: storeName(store),
    total: L.plan.byStore[store].total,
    rows: L.plan.byStore[store].items.map((x) => ({
      it: itemById[x.itemId], aisle: x.aisle, store, name: x.product.name, size: x.product.size_text,
      deal: x.product.promo_text || (x.product.multi_qty ? `${x.product.multi_qty} for ${money(x.product.multi_price)}` : ''),
      price: x.lineTotal,
    })).filter((r) => r.it),
  }));
  // Notes, and products none of your shops have: get them wherever you can.
  const missing = L.plan.unavailable.map((u) => itemById[u.id]).filter(Boolean);
  const notes = (L.plan.notes || []).map((n) => itemById[n.id]).filter(Boolean);
  if (missing.length || notes.length) {
    lists.push({
      id: 'other', title: 'Other things', name: 'other things', total: null,
      rows: [
        ...notes.map((it) => ({ it, aisle: it.aisle, name: it.note, size: '', deal: '', price: null })),
        ...missing.map((it) => ({ it, aisle: it.aisle, name: it.anchor.name, size: it.anchor.size_text, deal: '', warn: 'not at your shops', price: null })),
      ],
    });
  }
  for (const l of lists) {
    l.left = l.rows.filter((r) => !isChecked(r.it)).length;
  }
  const ticked = L.items.filter(isChecked).length;

  let current = shopPref('store', 'all');
  if (current !== 'all' && !lists.some((l) => l.id === current)) current = 'all';
  const hideTicked = shopPref('hideTicked', false);
  const showing = current === 'all' ? lists : lists.filter((l) => l.id === current);

  const row = (r) => `
    <li class="${isChecked(r.it) ? 'done' : ''}"><label>
      <input type="checkbox" data-tick="${r.it.id}" ${r.store ? `data-store="${r.store}"` : ''} data-aisle="${esc(r.aisle || '')}" ${isChecked(r.it) ? 'checked' : ''}>
      <span class="ck-name"><strong>${r.it.quantity} ×</strong> ${esc(r.name)}
        <span class="ck-meta">${[r.size && esc(r.size), r.deal && `<span class="deal-tag">${esc(r.deal)}</span>`, r.warn && `<span class="warn">${esc(r.warn)}</span>`,
          r.it.checkedBy && isChecked(r.it) && L.members.length > 1 && `✓ ${esc(r.it.checkedBy)}`].filter(Boolean).join(' · ')}</span></span>
      <span class="ck-price">${r.price != null ? money(r.price) : ''}</span></label></li>`;

  const section = (l) => {
    const groups = new Map();
    for (const r of [...l.rows].sort((a, b) => rankIn(l.id, a.aisle) - rankIn(l.id, b.aisle) || a.name.localeCompare(b.name))) {
      if (!groups.has(r.aisle)) groups.set(r.aisle, []);
      groups.get(r.aisle).push(r);
    }
    const body = [...groups.entries()].map(([aisle, rows]) => {
      const left = rows.filter((r) => !isChecked(r.it));
      const shown = hideTicked ? left : rows;
      if (!shown.length) return '';
      return `<h3 class="aisle">${esc(aisleLabel[aisle] || 'Other')} <span class="aisle-count">${rows.length - left.length}/${rows.length}</span></h3>
        <ul class="checklist">${shown.map(row).join('')}</ul>`;
    }).join('');
    return `<section class="shop-section">
      <h2>${l.title} <span class="hint">${l.left ? `${l.left} to get` : '✓ all done'}${l.total != null ? ` · ${money(l.total)}` : ''}</span></h2>
      ${L.layouts?.[l.id] ? `<p class="hint layout-note">Sorted the way you walk ${esc(l.name)}, learned from your last ${plural(L.layouts[l.id].trips, 'trip')}.
        <button type="button" class="linkish" data-reset-layout="${l.id}">Use the usual order</button></p>` : ''}
      ${body || `<p class="all-done">✓ Everything from ${esc(l.name)} is ticked off.</p>`}
    </section>`;
  };

  $('#list-root').innerHTML = `
    <div class="list-head">
      <h2>🛒 ${esc(L.name)} <span class="hint">${ticked} of ${L.items.length} ticked</span></h2>
      <div class="actions">
        <button class="small" id="shop-mode">Back to list</button>
        <button class="small" id="scan-btn">📷 Scan</button>
        <button class="primary" id="finish-shop" ${ticked ? '' : 'disabled'}>Finish shop</button>
      </div>
    </div>
    <div class="shop-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${L.items.length}" aria-valuenow="${ticked}">
      <span style="width:${L.items.length ? (ticked / L.items.length) * 100 : 0}%"></span></div>
    ${lists.length > 1 ? `<div class="shop-tabs" role="tablist" aria-label="Which shop">
      <button role="tab" data-shop-store="all" aria-selected="${current === 'all'}">All shops</button>
      ${lists.map((l) => `<button role="tab" data-shop-store="${l.id}" aria-selected="${current === l.id}">${l.title}
        <span class="tab-count">${l.left || '✓'}</span></button>`).join('')}
    </div>` : ''}
    <label class="check hide-ticked"><input type="checkbox" id="hide-ticked" ${hideTicked ? 'checked' : ''}> Hide ticked items</label>
    <p class="hint">Each shop’s list is sorted by section, in the order most supermarkets are laid out. Tap an item to cross it out.
      ${L.members.length > 1 ? 'Ticks show up for everyone on this list, so you can split up.' : ''}</p>
    ${showing.map(section).join('')}`;
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

/** A pending tick is { checked, store, aisle, at } (older versions stored just true/false). */
const tickState = (p) => (typeof p === 'object' && p ? !!p.checked : !!p);
function isTicked(it) {
  const pending = pendingTicks();
  return it.id in pending ? tickState(pending[it.id]) : !!it.checkedAt;
}

async function tick(itemId, checked, where = {}) {
  const pending = pendingTicks();
  pending[itemId] = { checked, store: where.store || null, aisle: where.aisle || null, at: new Date().toISOString() };
  savePendingTicks(pending);
  // Update our copy too: once the tick is sent, it's no longer "pending".
  const item = state.list.items.find((it) => it.id === itemId);
  if (item) {
    item.checkedAt = checked ? new Date().toISOString() : null;
    item.checkedBy = checked ? user()?.name : null;
  }
  renderShopping();
  await flushTicks();
}

/** Send ticks made offline (or just now) to the server. */
async function flushTicks() {
  const pending = pendingTicks();
  for (const [itemId, p] of Object.entries(pending)) {
    try {
      const body = typeof p === 'object' && p ? p : { checked: !!p };
      await api(`/api/items/${itemId}/checked`, { method: 'PUT', body });
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
    <span class="store-card-head"><input type="checkbox" data-store-toggle="${s}" ${on ? 'checked' : ''}> ${chip(s)}</span>
    ${s === 'iga' ? `<span class="store-note">${ig ? `${esc(ig.name)}${ig.pricesReady ? '' : ' · <span class="state pending">fetching prices…</span>'}` : 'No store chosen'}
      · <button type="button" class="linkish" data-list-iga>change</button></span>` : ''}
    ${note ? `<span class="store-note">${note}</span>` : ''}
  </label>`;
}

// ------------------------------------------------------------------ list items
// Each item is one card: what it is, the shop to buy it at and that price,
// the other shops' prices on one line, and an Options panel (opened one at a
// time) with the matching, "buy at" and per-shop choices.

state.openItem = null; // the item whose Options are open

/** "milk 2l" → "Milk 2L": a search, written as a title. */
const niceQuery = (q) => String(q).replace(/^./, (c) => c.toUpperCase())
  .replace(/(\d)\s*(ml|l|kg|g)\b/gi, (m, n, u) => n + ({ ml: 'mL', l: 'L', kg: 'kg', g: 'g' }[u.toLowerCase()]));

const MODE_NOTE = { similar: 'any brand', exact: 'same brand only', this: 'this exact product' };

function stepper(qty) {
  return `<div class="stepper" role="group" aria-label="Quantity">
    <button type="button" data-step="-1" aria-label="One less" ${qty <= 1 ? 'disabled' : ''}>−</button>
    <span>${qty}</span>
    <button type="button" data-step="1" aria-label="One more" ${qty >= 99 ? 'disabled' : ''}>+</button></div>`;
}

function itemFoot(it, left = '') {
  const open = state.openItem === it.id;
  return `<div class="item-foot"><span class="hint">${left}</span>
    <button type="button" class="linkish" data-toggle-item aria-expanded="${open}">${open ? 'Close ▴' : 'Options ▾'}</button></div>`;
}

function renderNoteItem(it) {
  const L = state.list;
  const open = state.openItem === it.id;
  return `<div class="item note-item ${open ? 'open' : ''}" data-item="${it.id}">
    <div class="item-top">
      <div class="name"><strong>${esc(it.note)}</strong>
        <div class="meta">Note${it.addedBy && L.members.length > 1 ? ` · added by ${esc(it.addedBy)}` : ''}${it.checkedAt ? ' · <span class="saving">✓ ticked</span>' : ''}</div></div>
      ${stepper(it.quantity)}
    </div>
    ${open ? `<div class="item-options"><div class="actions">
      <button class="small" data-find-note>Find a product</button>
      <button class="small ghost" data-remove>Remove</button></div></div>` : ''}
    ${itemFoot(it)}
  </div>`;
}

function renderItem(it) {
  if (it.note != null) return renderNoteItem(it);
  const a = it.anchor;
  const L = state.list;
  const open = state.openItem === it.id;
  const cheapestMode = it.matchMode === 'cheapest';
  const title = cheapestMode ? `${niceQuery(it.query)}, any brand` : a.name;
  const meta = [
    cheapestMode ? '🔄 Cheapest pick updates as prices change' : [a.size_text, MODE_NOTE[it.matchMode]].filter(Boolean).map(esc).join(' · '),
    !a.available ? '<span class="warn">no longer available</span>' : '',
    it.addedBy && L.members.length > 1 ? `added by ${esc(it.addedBy)}` : '',
    it.checkedAt ? '<span class="saving">✓ ticked</span>' : '',
  ].filter(Boolean).join(' · ');

  // Where to buy it, and what the other shops charge.
  const priced = L.included.map((s) => ({ s, ps: it.perStore[s] })).filter(({ ps }) => ps?.product && !ps.excluded);
  const win = it.cheapest && it.perStore[it.cheapest]?.product ? it.cheapest : null;
  const winP = win ? it.perStore[win].product : null;
  let tag = '';
  if (win) {
    if (it.pin?.honoured && it.pinnedStore === win) tag = '<span class="tag pin">📌 Always here</span>';
    else if (priced.length === 1) tag = '<span class="tag warn">Only here</span>';
    else tag = '<span class="tag good">Cheapest</span>';
  }
  const others = priced.filter(({ s }) => s !== win)
    .map(({ s, ps }) => ({ s, cost: lineCost(ps.product, it.quantity) }))
    .sort((x, y) => x.cost - y.cost)
    .map(({ s, cost }) => `${esc(storeName(s))} <b>${money(cost)}</b>`);
  const missing = L.included.filter((s) => !priced.some((x) => x.s === s)).map(storeName);
  const otherLine = [
    it.pin?.honoured && it.pin.extra > 0.004 ? `${money(it.pin.extra)} more than ${esc(storeName(it.pin.cheapest))}` : '',
    it.quantity > 1 && winP ? `${it.quantity} × ${money(shownPrice(winP))}` : '',
    ...others,
    missing.length ? `not at ${missing.map(esc).join(', ')}` : '',
  ].filter(Boolean).join(' · ');

  return `<div class="item ${open ? 'open' : ''}" data-item="${it.id}">
    <div class="item-top">
      <div class="name" data-product="${a.id}"><strong>${esc(title)}</strong><div class="meta">${meta}</div></div>
      ${stepper(it.quantity)}
    </div>
    ${win ? `<div class="best-line">${chip(win)}${tag}${dealBadges(winP)}
      <span class="best-amount">${money(lineCost(winP, it.quantity))}</span></div>`
    : '<div class="best-line"><span class="warn">Not found at the shops on this list</span></div>'}
    ${otherLine ? `<div class="other-prices">${otherLine}</div>` : ''}
    ${it.pin && !it.pin.honoured ? pinNote(it) : ''}
    ${insightNote(it.priceInsight)}
    ${valueHint(it.betterValue, it.id)}
    ${open ? renderOptions(it) : ''}
    ${itemFoot(it, cheapestMode && !open && winP ? esc(winP.name) : '')}
  </div>`;
}

/** The opened item: matching, "buy at", and each shop's pick. */
function renderOptions(it) {
  const L = state.list;
  const rows = state.allStores.map((s) => {
    const ps = it.perStore[s] || { candidates: [] };
    const p = ps.product;
    const enabled = L.included.includes(s);
    const win = it.cheapest === s;
    const what = !enabled ? 'Not used on this list' : ps.excluded ? 'Not buying here' : p ? esc(p.name) : 'No match found';
    const opts = [
      '<option value="" selected disabled>Change</option>',
      `<option value="auto">Auto: cheapest match${!ps.manual && !ps.excluded ? ' ✓' : ''}</option>`,
      ...ps.candidates.map((c) => `<option value="${c.id}">${esc(c.name)} — ${money(shownPrice(c))}${ps.manual && p?.id === c.id ? ' ✓' : ''}</option>`),
      ...(ps.manual && p && !ps.candidates.some((c) => c.id === p.id) ? [`<option value="${p.id}">${esc(p.name)} — ${money(shownPrice(p))} ✓</option>`] : []),
      `<option value="exclude">Don't buy here${ps.excluded ? ' ✓' : ''}</option>`,
    ];
    return `<div class="pick-row ${win ? 'win' : ''} ${!enabled || ps.excluded || !p ? 'off' : ''}">
      <span class="pick-name">${chip(s)} ${what}${ps.manual ? ' <span class="hint">(your pick)</span>' : ''}
        ${p && !ps.excluded && !ps.manual && p.id !== it.anchor.id ? `<button type="button" class="linkish small-link" data-report="${p.id}" data-anchor="${it.anchor.id}">wrong?</button>` : ''}</span>
      <span class="pick-price">${p && !ps.excluded && enabled ? money(lineCost(p, it.quantity)) : '—'}</span>
      ${enabled ? `<select class="pick-change" data-pick="${s}" aria-label="Change the ${esc(storeName(s))} product">${opts.join('')}</select>` : ''}
    </div>`;
  }).join('');
  return `<div class="item-options">
    <label>Match<select data-mode aria-label="Matching">
      ${it.matchMode === 'cheapest' ? `<option value="cheapest" selected>Cheapest ${esc(it.query)}, any brand</option>` : ''}
      <option value="similar" ${it.matchMode === 'similar' ? 'selected' : ''}>Any brand, same size</option>
      <option value="exact" ${it.matchMode === 'exact' ? 'selected' : ''}>Same brand only</option>
      <option value="this" ${it.matchMode === 'this' ? 'selected' : ''}>This exact product</option>
    </select></label>
    <label>Buy at<select data-pin aria-label="Which shop to buy it at">
      <option value="" ${!it.pinnedStore ? 'selected' : ''}>Whichever shop is cheapest</option>
      ${state.allStores.map((s) => `<option value="${s}" ${it.pinnedStore === s ? 'selected' : ''}>Always ${esc(storeName(s))}</option>`).join('')}
    </select></label>
    <div class="pick-rows">${rows}</div>
    <div class="actions"><button class="small ghost" data-product="${it.anchor.id}">Price history</button>
      <button class="small ghost" data-remove style="margin-left:auto">Remove</button></div>
  </div>`;
}

/** Always in view at the bottom of a list: the total and the order button. */
function totalBar(L) {
  const complete = state.allStores.map((s) => L.singleStore[s]).filter((x) => x && !x.missing);
  const best = complete.length ? Math.min(...complete.map((x) => x.total)) : null;
  const saves = best != null ? best - L.plan.total : 0;
  const shops = state.allStores.filter((s) => L.plan.byStore[s]?.items.length).length;
  return `<div class="total-bar">
    <div><div class="total-bar-total">${money(L.plan.total)}</div>
      <div class="hint">${saves > 0.004 ? `<span class="saving">Saves ${money(saves)} vs all at one shop</span>` : `${plural(L.items.length, 'item')} · ${plural(shops, 'shop')}`}</div></div>
    <button class="primary" id="order-btn">Order cheapest</button>
  </div>`;
}

function renderSummary(L) {
  const stores = state.allStores.filter((s) => L.plan.byStore[s]?.items.length);
  const priced = L.items.filter((it) => it.note == null).length;
  const singles = state.allStores.map((s) => {
    const x = L.singleStore[s];
    const diff = x.total - L.plan.total;
    // A shop with none of the items has no total to compare ($0.00 would read as free).
    if (x.missing && x.missing >= priced) {
      return `<div class="tile"><div class="label">Everything at ${chip(s)}</div><div class="value muted">—</div>
        <div class="note"><span class="warn">Doesn’t have ${priced === 1 ? 'it' : 'any of these'}</span></div></div>`;
    }
    return `<div class="tile"><div class="label">Everything at ${chip(s)}</div>
      <div class="value">${money(x.total)}</div>
      <div class="note">${x.missing ? `<span class="warn">for ${priced - x.missing} of ${plural(priced, 'item')}; ${x.missing} not available</span>` : diff > 0.004 ? `Your split saves <span class="saving">${money(diff)}</span>` : 'Same as your split'}</div></div>`;
  });
  return `<h2 class="section">Total</h2>
    <div class="totals">
      <div class="tile hero"><div class="label">Cheapest split</div><div class="value">${money(L.plan.total)}</div>
        <div class="note">${plural(L.items.length, 'item')}${L.plan.unavailable.length ? ` · <span class="warn">${L.plan.unavailable.length} unavailable</span>` : ''}
          ${(() => {
            const deals = Object.values(L.plan.byStore).flatMap((b) => b.items).reduce((n, i) => n + (i.dealSaving || 0), 0);
            return deals > 0.004 ? `<br>includes <span class="saving">${money(deals)}</span> from multi-buys${L.memberships.length ? ' and member prices' : ''}` : '';
          })()}</div></div>
      ${stores.map((s) => `<div class="tile"><div class="label">${chip(s)}</div>
        <div class="value">${money(L.plan.byStore[s].total)}</div><div class="note">${plural(L.plan.byStore[s].items.length, 'item')}</div></div>`).join('')}
    </div>
    <h2 class="section">Compared with one shop</h2>
    <div class="totals">${singles.join('')}</div>`;
}

// List events (delegated, since the list re-renders)
$('#list-root').addEventListener('submit', async (e) => {
  if (e.target.id !== 'quick-add') return;
  e.preventDefault();
  const input = e.target.note;
  const text = input.value.trim();
  if (!text) return;
  // Look it up: pick the product (or keep it as a note) in the dialog.
  input.value = '';
  openPaste(text, null, true);
});

/** "Add as note": exactly what was typed, no product lookup. */
async function addQuickNote() {
  const input = $('#quick-add input');
  const text = input?.value.trim();
  if (!text) return input?.focus();
  try {
    await api(`/api/lists/${state.listId}/items`, { method: 'POST', body: { note: text } });
    await loadList();
    $('#quick-add input')?.focus();
  } catch (err) {
    toast(err.message);
  }
}

$('#list-root').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.tick) return tick(Number(t.dataset.tick), t.checked, { store: t.dataset.store, aisle: t.dataset.aisle });
  if (t.id === 'hide-ticked') {
    setShopPref('hideTicked', t.checked);
    return renderShopping();
  }
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
    else if (t.matches('[data-mode]')) {
      // Leaving "cheapest": keep what it picks now as the product.
      const it = state.list.items.find((x) => String(x.id) === id);
      const body = it?.matchMode === 'cheapest' ? { productId: it.anchor.id, matchMode: t.value } : { matchMode: t.value };
      await api(`/api/items/${id}`, { method: 'PATCH', body });
    }
    else if (t.matches('[data-pin]')) await api(`/api/items/${id}`, { method: 'PATCH', body: { pinnedStore: t.value || null } });
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
  if (t.closest('.list-menu .menu')) t.closest('details').removeAttribute('open');
  if (t.dataset.resetLayout) {
    if (!confirm('Go back to the usual section order for this shop? It will start learning again from your next trips.')) return;
    await api(`/api/me/shop-layouts/${t.dataset.resetLayout}`, { method: 'DELETE' });
    return loadList();
  }
  const shopTab = t.closest('[data-shop-store]');
  if (shopTab) {
    setShopPref('store', shopTab.dataset.shopStore);
    renderShopping();
    window.scrollTo(0, 0);
    return;
  }
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
  // Options: one item open at a time.
  const toggle = t.closest('[data-toggle-item]');
  if (toggle) {
    const id = Number(toggle.closest('[data-item]').dataset.item);
    state.openItem = state.openItem === id ? null : id;
    renderList();
    return;
  }
  const step = t.closest('[data-step]');
  if (step) {
    const id = Number(step.closest('[data-item]').dataset.item);
    const it = state.list.items.find((x) => x.id === id);
    const quantity = Math.min(99, Math.max(1, it.quantity + Number(step.dataset.step)));
    if (quantity === it.quantity) return;
    it.quantity = quantity;
    step.parentElement.querySelector('span').textContent = quantity; // straight away; prices follow
    try {
      await api(`/api/items/${id}`, { method: 'PATCH', body: { quantity } });
      return loadList();
    } catch (err) {
      return toast(err.message);
    }
  }
  try {
    if (t.matches('[data-remove]')) {
      const id = Number(t.closest('[data-item]').dataset.item);
      if (state.openItem === id) state.openItem = null;
      await api(`/api/items/${id}`, { method: 'DELETE' });
      return loadList();
    }
    if (t.matches('[data-swap-item]')) {
      t.disabled = true;
      await api(`/api/items/${t.dataset.swapItem}`, { method: 'PATCH', body: { productId: Number(t.dataset.swapTo) } });
      toast('Swapped to the better-value size');
      return loadList();
    }
    if (t.matches('[data-find-note]')) {
      const item = state.list.items.find((it) => it.id === Number(t.closest('[data-item]').dataset.item));
      return openPaste('', item);
    }
    switch (t.id) {
      case 'paste-list':
        return openPaste();
      case 'quick-note':
        return addQuickNote();
      case 'spending-btn':
        return openSpending();
      case 'scan-btn':
        return openScanner();
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
        setShopping(!state.shopping);
        window.scrollTo(0, 0);
        return state.shopping ? renderShopping() : renderList();
      case 'finish-shop': {
        await flushTicks();
        if (!confirm('Finished? Ticked items come off the list and are saved under “Past shops” so you can repeat them.')) return;
        const r = await api(`/api/lists/${state.listId}/finish`, { method: 'POST' });
        toast(`${r.name} saved — ${plural(r.items, 'item')} done`);
        setShopping(false);
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
        <h3>${chip(s)} — ${money(L.plan.byStore[s].total)}
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
        <div><strong>${esc(r.name)}</strong><div class="meta">${chip(r.store)} · ${esc(r.size_text || '')} · ${fmtDate(r.recorded_at)}</div></div>
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
  // Redrawing (after saving a setting, say): keep what the slower sections
  // showed until they've reloaded, so the page doesn't shrink and jump.
  const was = (id, loading) => $(`#${id}`)?.innerHTML || `<p class="hint">${loading}</p>`;
  const prev = {
    health: was('admin-health', 'Checking the data… (this can take a few seconds on a big catalogue)'),
    matches: was('admin-matches', 'Loading…'),
    backups: was('admin-backups', 'Loading…'),
    emails: was('admin-emails', 'Loading…'),
    settings: was('admin-settings', 'Loading…'),
  };
  const scroll = window.scrollY;
  $('#admin-root').innerHTML = `
    <div class="list-head"><h2>Product data</h2>
      <button class="primary" id="scrape-all" ${o.stores.some((s) => s.status.running) ? 'disabled' : ''}>Refresh all prices</button></div>
    <p class="hint">Prices also refresh automatically (schedule “${esc(o.scrapeCron || 'off')}”). A full refresh takes 20–60 minutes.</p>
    <p class="hint">Running version: <code>${esc(shortVersion(o.version))}</code></p>
    <div id="admin-live-stores">${adminStoreTiles(o)}</div>
    <h2 class="section">IGAs with prices online</h2>
    <div id="admin-live-iga-check">${adminIgaCheck(o)}</div>
    <p class="hint">Checked automatically every day before prices refresh: IGA’s store list is reloaded and each store is asked for one product.</p>
    <h2 class="section">IGA stores <span class="hint">${o.iga.tracked.length} followed${o.iga.maxStores ? ` of ${o.iga.maxStores} allowed` : ' (no limit)'} — prices are collected only for stores people have picked</span></h2>
    <div id="admin-live-iga-stores">${adminIgaStores(o)}</div>
    <h2 class="section">Data health <button class="small ghost" id="health-refresh">Check again</button></h2>
    <div id="admin-health">${prev.health}</div>

    <h2 class="section">Wrong matches ${o.openMatchReports ? `<span class="pill">${o.openMatchReports}</span>` : ''}</h2>
    <div id="admin-matches">${prev.matches}</div>

    <h2 class="section">Barcodes</h2>
    <div id="admin-live-barcodes">${adminBarcodes(o)}</div>
    <p class="hint">Coles only shows barcodes on product pages, so they’re filled in a batch at a time each day (products on lists first). Woolworths barcodes come with every refresh. Same barcode = same product.</p>

    <h2 class="section">Helpers</h2>
    <p class="hint">${o.helpers
      ? `${plural(o.helpers, 'helper')} share the refreshing with this server, and cover any shop this server is blocked by. Manage them in <a href="#site-settings">Site settings</a> below.`
      : 'None yet. If a shop blocks this server (Woolworths and ALDI can), add your own PC as a helper in <a href="#site-settings">Site settings</a> below.'}</p>

    <h2 class="section">Backups</h2>
    <div id="admin-backups">${prev.backups}</div>

    <h2 class="section">Emails</h2>
    <div id="admin-emails">${prev.emails}</div>

    <h2 class="section" id="site-settings">Site settings</h2>
    <div id="admin-settings">${prev.settings}</div>

    <h2 class="section">Users <span class="hint">${plural(o.users, 'account')} · ${plural(o.lists, 'list')}</span></h2>
    <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th class="num">Lists</th><th>Admin</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${fmtDate(u.created_at)}</td><td class="num">${u.lists}</td>
        <td><input type="checkbox" data-admin-user="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === user().id ? 'disabled' : ''} aria-label="Admin"></td></tr>`).join('')}
    </tbody></table></div>`;
  window.scrollTo(0, scroll);
  clearTimeout(adminTimer);
  loadAdminExtras();
  loadAdminSettings();
  loadHealth();
  if (adminBusy(o) && currentTab() === 'admin') adminTimer = setTimeout(refreshAdminProgress, 3000);
}

/** "main@9223972… 2026-10-24T00:14:13Z" → "9223972 · 24 Oct 26". */
function shortVersion(v = 'dev') {
  const m = /@([0-9a-f]{7})[0-9a-f]*\s*(\S+)?/.exec(v);
  if (!m) return v;
  return m[2] ? `${m[1]} · ${fmtDate(m[2])}` : m[1];
}

const adminBusy = (o) => o.stores.some((s) => s.status.running) || (o.iga.queue.fetching?.length || o.iga.queue.current)
  || o.iga.check.running || o.barcodes.status.running;

/**
 * While prices are refreshing: update just the progress (store tiles, IGA
 * status, barcodes) every few seconds, leaving the rest of the page — your
 * scroll position, open sections and anything you're typing — alone.
 */
async function refreshAdminProgress() {
  if (currentTab() !== 'admin' || !$('#admin-live-stores')) return;
  let o;
  try {
    o = await api('/api/admin/overview');
  } catch {
    adminTimer = setTimeout(refreshAdminProgress, 10000); // offline for a moment: try again later
    return;
  }
  $('#admin-live-stores').innerHTML = adminStoreTiles(o);
  $('#admin-live-iga-check').innerHTML = adminIgaCheck(o);
  $('#admin-live-iga-stores').innerHTML = adminIgaStores(o);
  $('#admin-live-barcodes').innerHTML = adminBarcodes(o);
  const all = $('#scrape-all');
  if (all) all.disabled = o.stores.some((s) => s.status.running);
  if (adminBusy(o)) adminTimer = setTimeout(refreshAdminProgress, 3000);
  else loadHealth(); // finished: the product counts and freshness have changed
}

/** Something was started: follow its progress in place (the rest of the page stays put). */
function watchAdminProgress(delay = 800) {
  clearTimeout(adminTimer);
  adminTimer = setTimeout(refreshAdminProgress, delay);
}

function adminStoreTiles(o) {
  return `<div class="stat-grid">${o.stores.map((s) => {
      const r = s.runs[0];
      const status = s.status.running
        ? `<strong>Running…</strong> ${s.status.products} products<br><span class="hint">${esc(s.status.message)}</span>`
        : r ? `Last run ${fmtDate(r.started_at)}: <strong>${esc(r.status)}</strong>${r.error ? `<br><span class="warn">${esc(r.error)}</span>` : ` · ${r.price_changes} price changes`}` : 'Never refreshed';
      const steady = s.store === 'coles' && o.colesLive?.enabled ? colesSteadyNote(o.colesLive) : o.shared?.[s.store] ? sharedNote(o.shared[s.store]) : '';
      return `<div class="tile"><div class="label">${chip(s.store)}</div>
        <div class="value">${s.products.toLocaleString()}</div>
        <div class="note">products · ${status}${r?.source === 'collector' ? ' · <span class="hint">sent by a helper</span>' : ''}${steady}</div>
        <p>${s.fedByCollector ? `<span class="hint">${s.store === 'coles' && o.colesLive?.enabled ? 'Fetched page by page by helpers (not this server)' : o.shared?.[s.store] ? 'Shared out to helpers (not crawled by this server)' : 'Collected by helpers (not crawled by this server)'}</span>`
          : `<button class="small" data-scrape="${s.store}" ${s.status.running ? 'disabled' : ''}>Refresh</button>`}</p></div>`;
    }).join('')}</div>`;
}

/** A shop shared out a part at a time: how today's refresh is going, and who's doing what. */
function sharedNote(x) {
  const what = x.of == null ? 'reading its departments' : x.finished ? `all ${x.of} parts done` : `${x.done} of ${x.of} parts done`;
  const doing = x.doing.map((d) => `<li>${esc(d.worker)}: ${esc(d.part)}</li>`).join('');
  return `<br><span class="hint">Shared refresh (started ${fmtDate(x.startedAt)}): ${what}</span>${doing ? `<ul class="worker-list hint">${doing}</ul>` : ''}`
    + (x.paused.length ? `<br><span class="warn">Paused after a bot check: ${x.paused.map((p) => `${esc(p.worker)}${p.until ? ` (until ${timeOf(p.until)})` : ' (today)'}`).join(', ')}</span>` : '')
    + (x.stuck.length && !x.finished ? `<br><span class="warn">Failed, waiting for another connection:</span><ul class="worker-list hint">${x.stuck.map((f) => `<li>${esc(f.part)}${f.why ? ` — ${esc(f.by || '')}: <span class="warn">${esc(f.why)}</span>` : ''}</li>`).join('')}</ul>` : '');
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });

/** Coles in steady mode: what it's up to, and what each connection sharing it is doing. */
function colesSteadyNote(c) {
  const parts = [`${c.lastHour} of ${c.perHour} pages in the last hour`];
  if (c.specials) parts.push(`specials ${c.specials.done}/${c.specials.of ?? '?'} pages today`);
  if (c.pass) {
    const pct = c.pass.pages ? Math.round((c.pass.pagesDone / c.pass.pages) * 100) : 0;
    parts.push(`whole shop ${pct}% (started ${fmtDate(c.pass.startedAt)})`);
  } else if (c.lastPassAt) parts.push(`whole shop last done ${fmtDate(c.lastPassAt)}`);
  if (c.waiting) parts.push(`${c.waiting} searches waiting`);
  const workers = (c.workers || []).map((w) => `<li>${esc(w.name)}: ${w.blockedUntil
    ? `<span class="warn">paused by a bot check until ${timeOf(w.blockedUntil)}</span>`
    : `${w.doing ? esc(w.doing) : 'waiting for work'} · ${w.lastHour} of at most ${w.cap} pages in the last hour`}</li>`).join('');
  return `<br><span class="hint">Steady refresh: ${parts.join(' · ')}</span>${workers ? `<ul class="worker-list hint">${workers}</ul>` : ''}`;
}

function adminIgaCheck(o) {
  return `<p>${o.iga.onlineStores.toLocaleString()} IGA stores currently publish prices online and can be picked.
      ${o.iga.check.running ? `<span class="state pending">Checking now… ${o.iga.check.done} of ${o.iga.check.total}</span>`
        : o.iga.lastCheck ? `<span class="hint">Last checked ${fmtDate(o.iga.lastCheck.started_at)}${o.iga.lastCheck.error
          ? ` — <span class="warn">failed: ${esc(o.iga.lastCheck.error)}</span>`
          : ` — ${o.iga.lastCheck.came_online} came online, ${o.iga.lastCheck.went_offline} went offline`}.</span>` : '<span class="hint">Not checked yet.</span>'}
      <button class="small" id="iga-check" ${o.iga.check.running ? 'disabled' : ''}>Check now</button></p>`;
}

function adminIgaStores(o) {
  return `<div class="table-scroll"><table class="data"><thead><tr><th>Store</th><th>Added</th><th>Prices updated</th><th></th></tr></thead><tbody>
      ${o.iga.tracked.map((t) => `<tr><td>${esc(t.name || `Store ${t.store_id}`)} <span class="hint">${esc([t.suburb, t.state].filter(Boolean).join(' '))}</span></td>
        <td>${fmtDate(t.added_at)}</td>
        <td>${(o.iga.queue.fetching || [o.iga.queue.current]).includes(t.store_id) ? '<span class="state pending">fetching now…</span>' : o.iga.queue.waiting.includes(t.store_id) ? '<span class="state pending">queued</span>' : t.last_scraped_at ? fmtDate(t.last_scraped_at) : 'not yet'}</td>
        <td>${t.store_id === o.iga.defaultStoreId ? '<span class="hint">default</span>' : `<button class="small ghost" data-untrack-iga="${esc(t.store_id)}">Stop following</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function adminBarcodes(o) {
  return `<p>${(o.barcodes.with_barcode || 0).toLocaleString()} of ${(o.barcodes.total || 0).toLocaleString()} Coles products have a barcode
      (${(o.barcodes.checked || 0).toLocaleString()} pages checked).
      ${o.barcodes.status.running ? `<span class="state pending">Fetching… ${o.barcodes.status.done} of ${o.barcodes.status.total}</span>`
        : '<button class="small" id="barcodes-now">Fetch more now</button>'}</p>`;
}

// ------------------------------------------------------------------ site settings
// Values in the server's .env file win; those fields are shown locked.

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/** Fetch a program, asking the server to prepare it first if needed. */
async function downloadProgram(btn) {
  const id = btn.dataset.program;
  const progress = $('#program-progress');
  btn.disabled = true;
  let status = await api(`/api/admin/collector/programs/${id}/build`, { method: 'POST' });
  if (status.building) {
    progress.hidden = false;
    progress.textContent = 'Preparing the program — this takes a minute the first time…';
  }
  while (status.building) {
    await new Promise((r) => setTimeout(r, 3000));
    status = (await api('/api/admin/collector/programs')).programs.find((p) => p.id === id);
  }
  btn.disabled = false;
  progress.hidden = true;
  if (!status.ready) throw new Error(`Couldn’t prepare it: ${status.error || 'unknown error'}`);
  const a = document.createElement('a');
  a.href = `/api/admin/collector/programs/${id}${btn.dataset.helper ? `?helper=${btn.dataset.helper}` : ''}`;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** "Last connected 2 hours ago · up to date · last refreshed Woolworths: ok" for a helper. */
function helperStatus(x, latest) {
  const parts = [x.last_seen_at ? `Last connected <strong>${ago(x.last_seen_at)}</strong>` : 'Hasn’t connected yet'];
  if (x.version) parts.push(x.upToDate ? '<span class="state ready">✓ up to date</span>' : '<span class="state pending">older version</span> (it updates itself)');
  for (const s of x.shops || []) parts.push(`${chip(s.store)} ${esc(s.part)}`);
  for (const b of x.blockedBy || []) parts.push(`<span class="warn">paused for ${esc(storeName(b.store))}${b.until ? ` until ${timeOf(b.until)}` : ' today'} (bot check)</span>`);
  if (x.coles?.blockedUntil) parts.push(`<span class="warn">Coles paused by a bot check until ${timeOf(x.coles.blockedUntil)}</span>`);
  else if (x.coles?.doing) parts.push(`Coles: ${esc(x.coles.doing)}`);
  return parts.join(' · ');
}

const dayMonth = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

/** A link just made for a helper: sent, or to copy. */
function inviteNotice(name, inv, token = null) {
  return `<div class="notice">${inv.emailed ? `Emailed ${esc(name)} at ${esc(inv.to)} with what it is, how to set it up and this link.` : `Send ${esc(name)} this link: it explains what the collector is and lets them download it, set up for this site.`}
    <span class="copy-row"><input readonly value="${esc(inv.link)}" data-copy-source><button type="button" class="small" data-copy-input>Copy</button></span>
    It works until ${dayMonth(inv.until)} and won’t be shown again here (you can always make a new one).
    ${token ? `<br><span class="hint">For Docker or running from the code instead, their token is <code>${esc(token)}</code>.</span>` : ''}</div>`;
}

/** Helpers: other people's collectors, sharing the work. */
function helpersCard(list, programs, justMade, canEmail, siteCap) {
  const rows = list.map((x) => `<div class="helper-row${x.disabled ? ' off' : ''}">
      <p><strong>${esc(x.name)}</strong>${x.disabled ? ' <span class="state">turned off</span>' : ''}${x.email ? ` <span class="hint">${esc(x.email)}</span>` : ''}<br><span class="hint">${helperStatus(x)}</span>
        <br><span class="hint">${x.inviteUntil ? `Invite link works until ${dayMonth(x.inviteUntil)}` : 'No invite link open'}</span></p>
      ${justMade?.id === x.id && justMade.invite ? inviteNotice(x.name, justMade.invite, justMade.token) : ''}
      <form class="copy-row helper-cap" data-helper-cap="${x.id}"><label>Coles: at most <input name="colesMax" type="number" min="1" max="600" value="${x.coles_max ?? ''}" placeholder="${esc(siteCap)}"> pages an hour</label><button class="small" type="submit">Set</button></form>
      <details class="helper-downloads"><summary>Download it</summary><div class="actions">
        ${programs.map((p) => `<button type="button" class="small" data-program="${p.id}" data-helper="${x.id}">⬇ ${esc(p.label)}</button>`).join('')}
        <a class="button small" href="/api/admin/collector/download?helper=${x.id}" data-helper-zip="${x.id}" download>⬇ Mac / zip</a>
      </div>
      <p class="hint"><strong>Windows / Linux:</strong> one program, already set up for this site: run it and leave it running (on Linux, <code>tar xzf grocery-collector-linux-*.tar.gz && ./grocery-collector</code>). Windows may warn it’s from an unknown publisher: <em>More info → Run anyway</em>. Run it once with <code>--autostart</code> to start it with the computer.
        <strong>Mac, or anywhere with <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 20+</a>:</strong> unzip and run <code>start.sh</code> (or <code>start.bat</code>). It keeps itself up to date.</p></details>
      <div class="actions">
        <button type="button" class="small" data-helper-invite="${x.id}" data-email="${esc(x.email || '')}" data-can-email="${canEmail ? '1' : ''}">${x.email && canEmail ? '✉ Email a new link' : '🔗 New invite link'}</button>
        <button type="button" class="small ghost" data-helper-toggle="${x.id}" data-off="${x.disabled ? '' : '1'}">${x.disabled ? 'Turn on' : 'Turn off'}</button>
        <button type="button" class="small ghost" data-helper-remove="${x.id}" data-name="${esc(x.name)}">Remove</button>
      </div></div>`).join('');
  return `<div class="card stack" id="helpers-card">
      <h3>Helpers</h3>
      <p class="hint">A helper is the collector program running on another internet connection: your own PC, or someone you trust. Each shop is refreshed by whichever connection isn’t blocked, and Coles pages are shared out within the limits above, so helpers make refreshes more reliable without asking the shops for more. A helper’s prices go straight into everyone’s comparisons, so only add people you trust.</p>
      ${rows || '<p class="hint">No helpers yet.</p>'}
      <form id="add-helper" class="stack">
        <h4>Add a helper</h4>
        <label>Name<input name="name" maxlength="60" placeholder="e.g. Sam’s PC" required></label>
        <label>Their email <span class="hint">(optional)</span><input name="email" type="email" maxlength="200" placeholder="sam@example.com"></label>
        ${canEmail ? '<label class="check"><input type="checkbox" name="send" checked> Email them a link to download it, with what it is and how to set it up</label>'
          : '<p class="hint">Set up email (above) to send them the link; otherwise you’ll get a link to pass on.</p>'}
        <button class="small" type="submit">Add helper</button>
      </form>
      <p class="warn" data-form-error hidden></p>
    </div>`;
}

const HELPER_NEW_KEY = 'Downloading makes this helper a new key. A copy they already have stops working until they run this one. Carry on?';

async function loadAdminSettings(justMadeHelper = null) {
  const [{ settings: st, stores, currentAddress, litestream, collector }, { helpers }] = await Promise.all([api('/api/admin/settings'), api('/api/admin/helpers')]);
  const canEmail = st.SMTP_URL.set;
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

      <form id="prices-for" class="card stack">
        <h3>Prices for</h3>
        <p class="hint">Fruit and veg, and some specials, cost different amounts in different areas. Choose the area whose prices to collect; this server and every helper use the same one.</p>
        <label>Area, as shoppers see it${envTag('PRICE_AREA')}<input name="PRICE_AREA" maxlength="60" placeholder="e.g. Bondi Junction, NSW" value="${esc(st.PRICE_AREA.value || '')}" ${dis('PRICE_AREA')}></label>
        <p class="hint">Shown at the bottom of every page: “Prices are for …”.</p>
        <label>Coles store${envTag('COLES_STORE_ID')}<input name="COLES_STORE_ID" placeholder="Store number, or its page on coles.com.au" value="${esc(st.COLES_STORE_ID.value || '')}" ${dis('COLES_STORE_ID')}></label>
        <p class="hint">Find your store at <a href="https://www.coles.com.au/find-stores" target="_blank" rel="noopener">coles.com.au/find-stores</a> and paste its page (it ends in the store number, e.g. …/bondi-junction-0381). ${st.COLES_STORE_ID.value ? `Using store ${esc(st.COLES_STORE_ID.value)}.` : '<strong>Not set:</strong> Coles’ default store is in Melbourne.'} Takes effect from the next Coles page fetched.</p>
        <label>Liquorland state${envTag('LIQUOR_STATE')}<select name="LIQUOR_STATE" ${dis('LIQUOR_STATE')}>
          ${['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'].map((x) => `<option value="${x}" ${(st.LIQUOR_STATE.value || 'nsw') === x ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}</select></label>
        <p class="hint"><strong>Woolworths</strong> picks a store from where each connection is, and can’t be set here yet, so each Woolworths refresh stays on one connection (this server, if it crawls Woolworths) and its prices don’t jump between areas. IGA is per store (shoppers pick theirs); ALDI and Harris Farm have one price.</p>
        <p class="warn" data-form-error hidden></p>
        ${['PRICE_AREA', 'COLES_STORE_ID', 'LIQUOR_STATE'].every(locked) ? '' : '<button class="primary" type="submit">Save</button>'}
      </form>

      <form id="collector-settings" class="card stack">
        <h3>Sharing the work</h3>
        <p class="hint">This server and your helpers (below) share the refreshing: each shop’s departments are handed out, and so are Coles’ pages.</p>
        <label>Coles pages an hour, all connections together${envTag('COLES_PAGES_PER_HOUR')}
          <input name="COLES_PAGES_PER_HOUR" type="number" min="0" max="600" value="${esc(st.COLES_PAGES_PER_HOUR.value ?? 30)}" ${dis('COLES_PAGES_PER_HOUR')}></label>
        <label>Most Coles pages an hour for any one connection${envTag('COLES_MAX_PER_CONNECTION')}
          <input name="COLES_MAX_PER_CONNECTION" type="number" min="1" max="600" value="${esc(st.COLES_MAX_PER_CONNECTION.value ?? 40)}" ${dis('COLES_MAX_PER_CONNECTION')}></label>
        <p class="hint">Coles is about 640 pages. At 30 an hour the whole shop takes about a day. This server and the helpers share the pages above rather than adding to them, and no one connection (this server included) fetches more than the second figure; a helper can be set lower below. More an hour means a greater chance of a bot check. 0 pages an hour goes back to one big crawl each night.</p>
        <fieldset class="shop-picker"><legend>This server crawls${envTag('SERVER_SCRAPE_STORES')}</legend>
          <p class="hint">Untick a shop to leave it to the helpers. If this server is blocked by a shop it does crawl, a helper covers it.</p>
          ${stores.map((x) => `<label class="check"><input type="checkbox" name="crawl" value="${x}" ${crawled.includes(x) ? 'checked' : ''} ${dis('SERVER_SCRAPE_STORES')}> ${chip(x)}</label>`).join('')}
        </fieldset>
        <p class="warn" data-form-error hidden></p>
        ${locked('SERVER_SCRAPE_STORES') && locked('COLES_PAGES_PER_HOUR') && locked('COLES_MAX_PER_CONNECTION') ? '' : '<button class="primary" type="submit">Save</button>'}
      </form>

      ${helpersCard(helpers, collector.programs, justMadeHelper, canEmail, st.COLES_MAX_PER_CONNECTION.value ?? 40)}

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
  if (f.dataset.helperCap) {
    e.preventDefault();
    try {
      await api(`/api/admin/helpers/${f.dataset.helperCap}`, { method: 'PATCH', body: { colesMax: f.elements.colesMax.value || null } });
      toast('Saved');
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (f.id === 'add-helper') {
    e.preventDefault();
    try {
      const made = await api('/api/admin/helpers', {
        method: 'POST', body: { name: f.elements.name.value, email: f.elements.email.value || null, send: !!f.elements.send?.checked && !!f.elements.email.value },
      });
      await loadAdminSettings(made);
    } catch (err) {
      formError(f.closest('.card'), err);
    }
    return;
  }
  if (!['email-settings', 'site-details', 'prices-for', 'collector-settings'].includes(f.id)) return;
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
  } else if (f.id === 'prices-for') {
    for (const k of ['PRICE_AREA', 'COLES_STORE_ID', 'LIQUOR_STATE']) if (!v(k).disabled) body[k] = v(k).value;
  } else {
    if (!f.querySelector('[name=crawl]').disabled) {
      body.SERVER_SCRAPE_STORES = [...f.querySelectorAll('[name=crawl]:checked')].map((c) => c.value);
      if (!body.SERVER_SCRAPE_STORES.length) return formError(f, new Error('Leave at least one store for this server'));
    }
    for (const k of ['COLES_PAGES_PER_HOUR', 'COLES_MAX_PER_CONNECTION']) if (!v(k).disabled) body[k] = v(k).value;
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
    } else if (t.dataset.copyInput !== undefined) {
      copyText(t.parentElement.querySelector('[data-copy-source]').value);
    } else if (t.dataset.helperInvite) {
      let email = t.dataset.email;
      let send = false;
      if (t.dataset.canEmail) {
        const answer = prompt('Email the new link to (leave empty to just get the link):', email);
        if (answer === null) return;
        email = answer.trim();
        send = !!email;
      }
      if (!confirm('Make a new invite link? Any older link for this helper stops working.')) return;
      const inv = await api(`/api/admin/helpers/${t.dataset.helperInvite}/invite`, { method: 'POST', body: { email: email || null, send } });
      await loadAdminSettings({ id: Number(t.dataset.helperInvite), invite: inv });
    } else if (t.dataset.program) {
      if (t.dataset.helper && !confirm(HELPER_NEW_KEY)) return;
      await downloadProgram(t);
    } else if (t.dataset.helperZip) {
      if (!confirm(HELPER_NEW_KEY)) e.preventDefault();
    } else if (t.dataset.helperToggle) {
      await api(`/api/admin/helpers/${t.dataset.helperToggle}`, { method: 'PATCH', body: { disabled: !!t.dataset.off } });
      loadAdminSettings();
    } else if (t.dataset.helperRemove) {
      if (!confirm(`Remove ${t.dataset.name}? Their collector will be refused.`)) return;
      await api(`/api/admin/helpers/${t.dataset.helperRemove}`, { method: 'DELETE' });
      loadAdminSettings();
    }
  } catch (err) {
    if (t.dataset.program) {
      t.disabled = false;
      $('#program-progress').hidden = true;
    }
    if (t.id === 'test-email') t.disabled = false;
    toast(err.message);
  }
});

/** Per-shop data checks: freshness, sorting into sections, and how much can be compared. */
let lastHealthHtml = null; // shown straight away next time, while it's re-checked

async function loadHealth(refresh = false) {
  const box = $('#admin-health');
  if (!box) return;
  if (lastHealthHtml && !box.querySelector('table')) box.innerHTML = lastHealthHtml;
  // Keep the old table (faded) while checking, so the page doesn't jump.
  const btn = $('#health-refresh');
  box.classList.add('busy');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  let hh;
  try {
    hh = await api(`/api/admin/health${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
    return;
  } finally {
    box.classList.remove('busy');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check again';
    }
  }
  const open = box.querySelector('details')?.open;
  const pctCell = (v, bad, good, invert = false) => {
    const cls = invert ? (v >= good ? 'ok' : v < bad ? 'bad' : '') : (v <= good ? 'ok' : v > bad ? 'bad' : '');
    return `<td class="num ${cls}">${v}%</td>`;
  };
  const rows = hh.stores.map((x) => {
    const age = x.lastOk ? (Date.now() - Date.parse(x.lastOk.finished_at)) / 3600000 : null;
    return `<tr><td>${chip(x.store)}</td>
      <td class="num">${x.available.toLocaleString()}</td>
      <td class="${age == null || age > 36 ? 'bad' : 'ok'}">${x.lastOk ? ago(x.lastOk.finished_at) : 'never'}${x.stuckRuns ? ' <span class="warn">· a refresh looks stuck</span>' : ''}</td>
      <td class="num ${x.stale ? 'bad' : ''}">${x.stale.toLocaleString()}</td>
      ${x.matching ? pctCell(x.matching.matchedPct, 30, 50, true) : '<td class="num">—</td>'}
      ${x.aisles ? pctCell(x.aisles.otherPct, 10, 3) : '<td class="num">—</td>'}
      <td class="num">${x.barcodePct}%</td></tr>`;
  }).join('');
  const unsorted = hh.stores.filter((x) => x.aisles?.unsorted.length);
  box.innerHTML = `${hh.alerts.length ? `<div class="notice warn-box"><strong>Open problems (admins have been emailed):</strong><ul>${hh.alerts.map((a) => `<li>${esc(a.subject)} <span class="hint">since ${fmtDate(a.since)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="table-scroll"><table class="data health">
      <thead><tr><th>Shop</th><th class="num">Products</th><th>Last refresh</th><th class="num" title="Available, but not seen by a refresh for 3+ days">Stale</th>
        <th class="num" title="Of a random sample, how many have a match at another shop">Comparable</th>
        <th class="num" title="Products the in-shop checklist can’t put in a section">Unsorted</th><th class="num">Barcodes</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">Checked ${ago(hh.at)}. “Comparable” is from a random sample of up to 150 products per shop; own-brand-heavy shops (ALDI) and fresh food naturally match less.</p>
    ${unsorted.length ? `<details><summary>Categories that don’t sort into a section</summary>
      ${unsorted.map((x) => `<p><strong>${esc(storeName(x.store))}:</strong> ${x.aisles.unsorted.map((u) => `${esc(u.category)} (${u.products})`).join(', ')}</p>`).join('')}</details>` : ''}`;
  if (open && box.querySelector('details')) box.querySelector('details').open = true;
  lastHealthHtml = box.innerHTML;
}

async function loadAdminExtras() {
  const [m, b, em] = await Promise.all([api('/api/admin/match-reports'), api('/api/admin/backups'), api('/api/admin/emails')]);
  const prod = (p) => (p ? `${chip(p.store)} <a href="#" data-product="${p.id}">${esc(p.name)}</a> <span class="hint">${esc(p.size_text || '')} · ${money(p.price)}</span>` : '<span class="hint">(gone)</span>');
  $('#admin-matches').innerHTML = (m.open.length
    ? `<ul class="report-list">${m.open.map((r) => `<li>
        <div>${prod(r.a)}<br><span class="hint">${r.kind === 'same' ? 'is the same as' : 'is NOT the same as'}</span><br>${prod(r.b)}</div>
        <div class="hint">${plural(r.count, 'report')}${r.reporter ? ` · first by ${esc(r.reporter)}` : ''}${r.notes.length ? ` · “${r.notes.map(esc).join('”, “')}”` : ''}</div>
        <div><button class="small primary" data-resolve="${r.id}" data-decision="accept">Fix it</button>
          <button class="small ghost" data-resolve="${r.id}" data-decision="dismiss">Dismiss</button></div></li>`).join('')}</ul>`
    : '<p class="hint">No reports waiting. Shoppers can press “Wrong match?” on any comparison.</p>')
    + (m.rules.length ? `<details><summary>${plural(m.rules.length, 'confirmed fix')}</summary><ul class="report-list">${m.rules.map((r) => `<li>
        <div>${chip(r.a_store)} ${esc(r.a_name)} <span class="hint">${r.kind === 'never' ? '≠' : '='}</span> ${chip(r.b_store)} ${esc(r.b_name)}</div>
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
      return loadAdminExtras();
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
    if (t.id === 'health-refresh') return loadHealth(true);
    if (t.id === 'barcodes-now') {
      await api('/api/admin/barcodes', { method: 'POST' });
      toast('Fetching Coles barcodes…');
      return watchAdminProgress();
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
    return watchAdminProgress();
  }
  if (t.dataset.untrackIga) {
    if (!confirm('Stop collecting prices for this IGA store? People who picked it will see no IGA prices until it’s picked again.')) return;
    await api(`/api/admin/iga/${encodeURIComponent(t.dataset.untrackIga)}`, { method: 'DELETE' });
    return watchAdminProgress(0);
  }
  const stores = t.id === 'scrape-all' ? state.allStores : t.dataset.scrape ? [t.dataset.scrape] : null;
  if (!stores) return;
  const res = await api('/api/admin/scrape', { method: 'POST', body: { stores } });
  toast(res.colesSteady ? (res.started.length ? 'Refresh started — Coles starts a new steady pass' : 'Coles starts a new steady pass (a page every couple of minutes)') : 'Refresh started');
  watchAdminProgress(500);
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
  state.allStores = shopsShown(!!cached.user?.showAlcohol).map((x) => x.id);
  state.names = Object.fromEntries(cached.stores.map((x) => [x.id, x.name]));
  state.stores = state.allStores;
  renderAccount();
}
api('/api/stats').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  const latest = s.stores.map((x) => x.updatedAt).filter(Boolean).sort().pop();
  const area = state.config?.site?.priceArea;
  $('#updated-hint').textContent = [latest ? `Prices last updated ${fmtDate(latest)}.` : '', area ? `Prices are for ${area}.` : ''].filter(Boolean).join(' ');
}).catch(() => {});
if (user()) refreshListCount().catch(() => {});
await route();
runSearch();
watchIgaPrices();
