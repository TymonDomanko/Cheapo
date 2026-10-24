import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseSizeFrom, altSize, unitPrice, formatSize } from './units.js';

export { STORES } from './stores.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'supermarket.db');
export const DB_FILE = DB_PATH;

let db;

// A list item is a product, or a free-text note ("birthday card") with no product.
const LIST_ITEMS_COLUMNS = `
      id INTEGER PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      note TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      match_mode TEXT NOT NULL DEFAULT 'similar', -- similar | exact | this
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT NOT NULL,
      checked_at TEXT,
      checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      CHECK (product_id IS NOT NULL OR note IS NOT NULL)`;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      store_product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      size_text TEXT,
      size_qty REAL,
      size_unit TEXT,
      alt_size_qty REAL,
      alt_size_unit TEXT,
      per_weight INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      image_url TEXT,
      product_url TEXT,
      price REAL,
      was_price REAL,
      unit_price REAL,
      unit_price_text TEXT,
      on_special INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      UNIQUE (store, store_product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_products_size ON products (size_unit, size_qty);
    CREATE INDEX IF NOT EXISTS idx_products_alt_size ON products (alt_size_unit, alt_size_qty);
    CREATE INDEX IF NOT EXISTS idx_products_store ON products (store, last_seen);

    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5 (
      name, brand, category, content='products', content_rowid='id',
      tokenize = 'porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
      INSERT INTO products_fts (rowid, name, brand, category) VALUES (new.id, new.name, new.brand, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
      INSERT INTO products_fts (products_fts, rowid, name, brand, category) VALUES ('delete', old.id, old.name, old.brand, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE OF name, brand, category ON products BEGIN
      INSERT INTO products_fts (products_fts, rowid, name, brand, category) VALUES ('delete', old.id, old.name, old.brand, old.category);
      INSERT INTO products_fts (rowid, name, brand, category) VALUES (new.id, new.name, new.brand, new.category);
    END;

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      was_price REAL,
      on_special INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Only a hash of the session token is stored, so a leaked database can't be used to log in.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      excluded_stores TEXT NOT NULL DEFAULT '[]', -- JSON array of store ids not to shop at
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_members (
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', -- owner | member
      joined_at TEXT NOT NULL,
      PRIMARY KEY (list_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS list_invites (
      token TEXT PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_items (${LIST_ITEMS_COLUMNS});
    CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items (list_id);

    -- Per-store manual choice for a list item. product_id NULL = never buy this item at that store.
    CREATE TABLE IF NOT EXISTS list_item_overrides (
      item_id INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
      store TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, store)
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY,
      store TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      products INTEGER NOT NULL DEFAULT 0,
      price_changes INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      log_json TEXT
    );
  `);
  // Columns added after the first release.
  const userCols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('preferred_stores')) {
    d.exec('ALTER TABLE users ADD COLUMN preferred_stores TEXT'); // JSON array; NULL = all stores
  }
  if (!userCols.includes('iga_store')) d.exec('ALTER TABLE users ADD COLUMN iga_store TEXT');
  const listCols = d.prepare('PRAGMA table_info(lists)').all().map((c) => c.name);
  if (!listCols.includes('iga_store')) d.exec('ALTER TABLE lists ADD COLUMN iga_store TEXT');
  const runCols = d.prepare('PRAGMA table_info(scrape_runs)').all().map((c) => c.name);
  if (!runCols.includes('location')) d.exec('ALTER TABLE scrape_runs ADD COLUMN location TEXT');

  migratePerStorePrices(d);
  migrateAccountsAndShopping(d);
  migrateNoteItems(d);
  // An item can be pinned to one shop ("always get this at Coles") instead of the cheapest.
  if (!d.prepare('PRAGMA table_info(list_items)').all().some((c) => c.name === 'pinned_store')) {
    d.exec('ALTER TABLE list_items ADD COLUMN pinned_store TEXT');
  }
  // A one-time link can carry a value: the new address for an email change.
  if (!d.prepare('PRAGMA table_info(auth_tokens)').all().some((c) => c.name === 'data')) {
    d.exec('ALTER TABLE auth_tokens ADD COLUMN data TEXT');
  }
  // "The cheapest 1L milk, any brand": the search an item keeps re-running (match_mode 'cheapest').
  if (!d.prepare('PRAGMA table_info(list_items)').all().some((c) => c.name === 'query')) {
    d.exec('ALTER TABLE list_items ADD COLUMN query TEXT');
  }
  // Products named "… Each" with no size (Harris Farm fruit) are sold by the item. Refreshes now
  // record that; this fills it in for ones already saved.
  d.exec(`UPDATE products SET size_qty = 1, size_unit = 'ea' WHERE size_unit IS NULL AND lower(name) LIKE '% each'`);
  // The order a shopper ticks things off at each shop, to learn its layout.
  d.exec(`CREATE TABLE IF NOT EXISTS tick_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      store TEXT NOT NULL,
      aisle TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tick_log ON tick_log (user_id, store, at);`);
  // Helpers: collectors an admin has approved, each with its own token (only its hash is kept).
  d.exec(`CREATE TABLE IF NOT EXISTS collectors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      version TEXT,
      mode TEXT
    );`);
  // Which connection did a refresh: 'server', 'home' (the site's collector token) or 'h<id>' (a helper).
  if (!d.prepare('PRAGMA table_info(scrape_runs)').all().some((c) => c.name === 'worker')) {
    d.exec('ALTER TABLE scrape_runs ADD COLUMN worker TEXT');
  }
  // What a finished shop cost (estimated from the prices at the time).
  for (const [col, def] of [['spent', 'REAL'], ['spent_json', 'TEXT']]) {
    if (!d.prepare('PRAGMA table_info(list_snapshots)').all().some((c) => c.name === col)) d.exec(`ALTER TABLE list_snapshots ADD COLUMN ${col} ${def}`);
  }

  d.exec(`
    -- IGA's store directory (refreshed weekly from igashop.com.au).
    CREATE TABLE IF NOT EXISTS iga_stores (
      id TEXT PRIMARY KEY,           -- IGA's retailerStoreId, used in their API
      name TEXT NOT NULL,
      address TEXT,
      suburb TEXT,
      state TEXT,
      postcode TEXT,
      lat REAL,
      lng REAL,
      no_prices INTEGER NOT NULL DEFAULT 0, -- latest check found no products online
      listed INTEGER NOT NULL DEFAULT 1,    -- still in IGA's online store directory
      checked_at TEXT,                      -- when we last checked it has prices online
      online_products INTEGER,              -- rough catalogue size seen at that check
      updated_at TEXT NOT NULL
    );
    -- Daily "which IGAs have prices online" checks, for the admin page.
    CREATE TABLE IF NOT EXISTS iga_checks (
      id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      listed INTEGER,
      with_prices INTEGER,
      came_online INTEGER,
      went_offline INTEGER,
      error TEXT
    );
    -- IGA stores whose prices we collect (because someone picked them).
    CREATE TABLE IF NOT EXISTS iga_tracked (
      store_id TEXT PRIMARY KEY,
      added_at TEXT NOT NULL,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      last_scraped_at TEXT
    );
  `);
}

/**
 * Chains whose stores each set their own prices (IGA) share one catalogue row
 * per product in `products` (name, size, image… with location_priced = 1 and
 * no price), and keep each store's price in `store_prices`. Price history rows
 * carry the store too. National chains keep their price on the product row.
 */
function migratePerStorePrices(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS store_prices (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      location TEXT NOT NULL,          -- e.g. IGA's store id
      price REAL,
      was_price REAL,
      unit_price REAL,
      unit_price_text TEXT,
      on_special INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (product_id, location)
    );
  `);
  // Not worth its space: the only query by location is a once-per-fetch scan.
  d.exec('DROP INDEX IF EXISTS idx_store_prices_location');
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('products').includes('location_priced')) {
    d.exec('ALTER TABLE products ADD COLUMN location_priced INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols('price_history').includes('location')) d.exec('ALTER TABLE price_history ADD COLUMN location TEXT');
  d.exec(`CREATE INDEX IF NOT EXISTS idx_history_location ON price_history (product_id, location, recorded_at);
    DROP INDEX IF EXISTS idx_history_product;`); // superseded by idx_history_location
  const storeCols = cols('iga_stores');
  if (storeCols.length && !storeCols.includes('no_prices')) {
    d.exec('ALTER TABLE iga_stores ADD COLUMN no_prices INTEGER NOT NULL DEFAULT 0');
  }
  if (storeCols.length && !storeCols.includes('listed')) {
    d.exec(`ALTER TABLE iga_stores ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE iga_stores ADD COLUMN checked_at TEXT;
      ALTER TABLE iga_stores ADD COLUMN online_products INTEGER;`);
  }

  const legacyStore = process.env.IGA_STORE_ID || '32600';
  d.transaction(() => {
    // Interim layout: one products row per IGA store, store_product_id "<store>:<id>".
    if (cols('products').includes('location')) {
      d.exec(`
        INSERT OR IGNORE INTO products (store, store_product_id, name, brand, size_text, size_qty, size_unit,
          alt_size_qty, alt_size_unit, per_weight, category, image_url, product_url, available, first_seen, last_seen,
          location_priced)
        SELECT store, substr(store_product_id, instr(store_product_id, ':') + 1), name, brand, size_text, size_qty, size_unit,
          alt_size_qty, alt_size_unit, per_weight, category, image_url, product_url, 1, first_seen, last_seen, 1
        FROM products WHERE store = 'iga' AND location IS NOT NULL ORDER BY last_seen DESC;

        CREATE TEMP TABLE iga_move AS
        SELECT o.id AS old_id, n.id AS new_id, o.location
        FROM products o JOIN products n ON n.store = 'iga' AND n.location IS NULL
          AND n.store_product_id = substr(o.store_product_id, instr(o.store_product_id, ':') + 1)
        WHERE o.store = 'iga' AND o.location IS NOT NULL;

        INSERT OR REPLACE INTO store_prices (product_id, location, price, was_price, unit_price, unit_price_text,
          on_special, available, first_seen, last_seen)
        SELECT m.new_id, m.location, o.price, o.was_price, o.unit_price, o.unit_price_text, o.on_special, o.available,
          o.first_seen, o.last_seen
        FROM iga_move m JOIN products o ON o.id = m.old_id;

        UPDATE price_history SET location = (SELECT location FROM iga_move WHERE old_id = product_id),
          product_id = (SELECT new_id FROM iga_move WHERE old_id = product_id)
        WHERE product_id IN (SELECT old_id FROM iga_move);
        UPDATE list_items SET product_id = (SELECT new_id FROM iga_move WHERE old_id = product_id)
          WHERE product_id IN (SELECT old_id FROM iga_move);
        UPDATE list_item_overrides SET product_id = (SELECT new_id FROM iga_move WHERE old_id = product_id)
          WHERE product_id IN (SELECT old_id FROM iga_move);
        DELETE FROM products WHERE id IN (SELECT old_id FROM iga_move);
        DROP TABLE iga_move;

        DROP INDEX IF EXISTS idx_products_location;
        ALTER TABLE products DROP COLUMN location;
      `);
    }
    // Original layout: a single IGA store's prices on the product rows themselves.
    const old = d.prepare("SELECT id FROM products WHERE store = 'iga' AND location_priced = 0 LIMIT 1").get();
    if (old) {
      d.prepare(`INSERT OR REPLACE INTO store_prices (product_id, location, price, was_price, unit_price, unit_price_text,
          on_special, available, first_seen, last_seen)
        SELECT id, ?, price, was_price, unit_price, unit_price_text, on_special, available, first_seen, last_seen
        FROM products WHERE store = 'iga' AND location_priced = 0`).run(legacyStore);
      d.prepare(`UPDATE price_history SET location = ? WHERE location IS NULL
        AND product_id IN (SELECT id FROM products WHERE store = 'iga' AND location_priced = 0)`).run(legacyStore);
      d.exec(`UPDATE products SET location_priced = 1, available = 1, price = NULL, was_price = NULL, unit_price = NULL,
        unit_price_text = NULL, on_special = 0 WHERE store = 'iga' AND location_priced = 0`);
    }
  })();
}

/** Email, alerts, barcodes, promotions, match fixes, in-store ticking, saved shops. */
/** Older databases required a product on every list item; rebuild the table to allow notes. */
function migrateNoteItems(d) {
  if (d.prepare('PRAGMA table_info(list_items)').all().some((c) => c.name === 'note')) return;
  const cols = 'id, list_id, product_id, quantity, match_mode, added_by, added_at, checked_at, checked_by';
  d.pragma('foreign_keys = OFF');
  try {
    d.transaction(() => {
      d.exec(`CREATE TABLE list_items_new (${LIST_ITEMS_COLUMNS});
        INSERT INTO list_items_new (${cols}) SELECT ${cols} FROM list_items;
        DROP TABLE list_items;
        ALTER TABLE list_items_new RENAME TO list_items;
        CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items (list_id);`);
    })();
  } finally {
    d.pragma('foreign_keys = ON');
  }
}

function migrateAccountsAndShopping(d) {
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (table, col, def) => {
    if (!cols(table).includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add('users', 'email_verified_at', 'TEXT');
  add('users', 'alerts_weekly', 'INTEGER NOT NULL DEFAULT 1');
  add('users', 'alerts_price', 'INTEGER NOT NULL DEFAULT 1');
  add('users', 'memberships', "TEXT NOT NULL DEFAULT '[]'"); // loyalty schemes for member prices
  add('users', 'show_alcohol', 'INTEGER NOT NULL DEFAULT 0'); // alcohol is left out of search and deals unless turned on
  add('products', 'barcode', 'TEXT');
  add('products', 'barcode_checked_at', 'TEXT'); // Coles: barcode comes from the product page
  for (const t of ['products', 'store_prices']) {
    add(t, 'promo_text', 'TEXT'); // e.g. "5 for $9.00"
    add(t, 'multi_qty', 'INTEGER'); // multi-buy: buy multi_qty for multi_price in total
    add(t, 'multi_price', 'REAL');
    add(t, 'member_price', 'REAL'); // price for loyalty members (Everyday Rewards)
  }
  add('list_items', 'checked_at', 'TEXT');
  add('list_items', 'checked_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  add('scrape_runs', 'source', "TEXT NOT NULL DEFAULT 'server'");
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode) WHERE barcode IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- One-time links: password reset and email verification. Only hashes are stored.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,             -- reset | verify | email-change
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      error TEXT,
      body TEXT                          -- kept only when no mail server is configured (dev outbox)
    );

    -- Admin-confirmed matching fixes. a_id < b_id. never = not the same item; always = same item.
    CREATE TABLE IF NOT EXISTS match_rules (
      a_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (a_id, b_id)
    );

    CREATE TABLE IF NOT EXISTS match_reports (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      anchor_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                -- not_same | same
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open', -- open | accepted | dismissed
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    -- "Tell me when this is cheaper" (target_price NULL = any drop or special).
    CREATE TABLE IF NOT EXISTS watches (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      target_price REAL,
      created_at TEXT NOT NULL,
      baseline_price REAL,               -- price when the watch was set (for "any drop")
      last_notified_price REAL,
      last_notified_at TEXT,
      PRIMARY KEY (user_id, product_id)
    );

    -- Saved regular shops and finished-shop history, to add again later.
    CREATE TABLE IF NOT EXISTS list_snapshots (
      id INTEGER PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,                -- saved | history
      items_json TEXT NOT NULL,          -- [{productId, quantity, matchMode}]
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
  `);
}

const nowIso = () => new Date().toISOString();

/**
 * Insert or update a batch of scraped products and append a price_history row
 * whenever the price (or special status) differs from the last recorded one.
 * @param location  for chains whose stores set their own prices (IGA): which
 *   store these prices are from. The product details go into the shared
 *   catalogue row; the price goes into store_prices for that store.
 * @returns {{upserted:number, priceChanges:number}}
 */
// Bumped whenever products change, so in-memory indexes know to rebuild.
let version = 0;
export const catalogueVersion = () => version;
export const catalogueChanged = () => version++;

export function upsertProducts(store, items, seenAt = nowIso(), location = null) {
  catalogueChanged();
  const d = getDb();
  const perStore = location != null;
  const getExisting = d.prepare('SELECT id FROM products WHERE store = ? AND store_product_id = ?');
  const insert = d.prepare(`
    INSERT INTO products (store, store_product_id, name, brand, size_text, size_qty, size_unit, alt_size_qty, alt_size_unit, per_weight,
      category, image_url, product_url, price, was_price, unit_price, unit_price_text, on_special, available,
      promo_text, multi_qty, multi_price, member_price, barcode, location_priced, first_seen, last_seen)
    VALUES (@store, @store_product_id, @name, @brand, @size_text, @size_qty, @size_unit, @alt_size_qty, @alt_size_unit, @per_weight,
      @category, @image_url, @product_url, @price, @was_price, @unit_price, @unit_price_text, @on_special, @available,
      @promo_text, @multi_qty, @multi_price, @member_price, @barcode, @location_priced, @seen, @seen)`);
  const update = d.prepare(`
    UPDATE products SET name=@name, brand=@brand, size_text=@size_text, size_qty=@size_qty, size_unit=@size_unit,
      alt_size_qty=@alt_size_qty, alt_size_unit=@alt_size_unit, per_weight=@per_weight, category=COALESCE(@category, category), image_url=COALESCE(@image_url, image_url),
      product_url=COALESCE(@product_url, product_url), price=@price, was_price=@was_price, unit_price=@unit_price,
      unit_price_text=@unit_price_text, on_special=@on_special, available=@available, location_priced=@location_priced,
      promo_text=@promo_text, multi_qty=@multi_qty, multi_price=@multi_price, member_price=@member_price,
      barcode=COALESCE(@barcode, barcode), last_seen=@seen
    WHERE id=@id`);
  const upsertStorePrice = d.prepare(`
    INSERT INTO store_prices (product_id, location, price, was_price, unit_price, unit_price_text, on_special, available,
      promo_text, multi_qty, multi_price, member_price, first_seen, last_seen)
    VALUES (@id, @location, @price, @was_price, @unit_price, @unit_price_text, @on_special, @available,
      @promo_text, @multi_qty, @multi_price, @member_price, @seen, @seen)
    ON CONFLICT (product_id, location) DO UPDATE SET price=excluded.price, was_price=excluded.was_price,
      unit_price=excluded.unit_price, unit_price_text=excluded.unit_price_text, on_special=excluded.on_special,
      available=excluded.available, promo_text=excluded.promo_text, multi_qty=excluded.multi_qty,
      multi_price=excluded.multi_price, member_price=excluded.member_price, last_seen=excluded.last_seen`);
  const lastPrice = d.prepare(`SELECT price, on_special FROM price_history WHERE product_id = ? AND location IS ?
    ORDER BY recorded_at DESC, id DESC LIMIT 1`);
  const addHistory = d.prepare(
    'INSERT INTO price_history (product_id, location, price, was_price, on_special, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');

  let upserted = 0;
  let priceChanges = 0;
  const run = d.transaction((rows) => {
    for (const raw of rows) {
      if (!raw || !raw.store_product_id || !raw.name) continue;
      const size = parseSizeFrom(raw.size_text, raw.name);
      const alt = altSize(raw.size_text, raw.name, size);
      const price = {
        price: num(raw.price),
        was_price: num(raw.was_price) || null,
        unit_price: num(raw.unit_price) ?? (size ? unitPrice(num(raw.price), size.qty, size.unit) : null),
        unit_price_text: raw.unit_price_text || null,
        on_special: raw.on_special ? 1 : 0,
        available: raw.available === false || num(raw.price) == null ? 0 : 1,
        promo_text: raw.promo_text ? String(raw.promo_text).slice(0, 120) : null,
        multi_qty: Number(raw.multi_qty) >= 2 && num(raw.multi_price) > 0 ? Math.round(Number(raw.multi_qty)) : null,
        multi_price: Number(raw.multi_qty) >= 2 && num(raw.multi_price) > 0 ? num(raw.multi_price) : null,
        member_price: num(raw.member_price) > 0 ? num(raw.member_price) : null,
      };
      const row = {
        store,
        store_product_id: String(raw.store_product_id),
        name: raw.name.trim(),
        brand: raw.brand || null,
        // Some shops only give the size in the name ("Nutcracker 200g"); show it either way.
        size_text: raw.size_text || (size && !size.perWeight ? formatSize(size.qty, size.unit) : size?.perWeight ? 'per kg' : null),
        size_qty: size?.qty ?? null,
        size_unit: size?.unit ?? null,
        alt_size_qty: alt?.qty ?? null,
        alt_size_unit: alt?.unit ?? null,
        per_weight: size?.perWeight ? 1 : 0,
        category: raw.category || null,
        image_url: raw.image_url || null,
        product_url: raw.product_url || null,
        // Catalogue rows of per-store chains carry no price of their own.
        ...(perStore
          ? { price: null, was_price: null, unit_price: null, unit_price_text: null, on_special: 0, available: 1,
            promo_text: null, multi_qty: null, multi_price: null, member_price: null }
          : price),
        barcode: /^\d{8,14}$/.test(String(raw.barcode || '')) ? String(raw.barcode) : null,
        location_priced: perStore ? 1 : 0,
        seen: seenAt,
      };
      const existing = getExisting.get(store, row.store_product_id);
      let id;
      if (existing) {
        id = existing.id;
        update.run({ ...row, id });
      } else {
        id = insert.run(row).lastInsertRowid;
      }
      if (perStore) upsertStorePrice.run({ id, location, ...price, seen: seenAt });
      upserted++;
      if (price.price != null) {
        const last = lastPrice.get(id, location);
        if (!last || last.price !== price.price || last.on_special !== price.on_special) {
          addHistory.run(id, location, price.price, price.was_price, price.on_special, seenAt);
          if (last) priceChanges++;
        }
      }
    }
  });
  run(items);
  return { upserted, priceChanges };
}

/** After a complete crawl, anything not seen in it is no longer sold (at that store, for per-store chains). */
export function markUnseenUnavailable(store, since, location = null) {
  catalogueChanged();
  const d = getDb();
  if (location != null) {
    return d.prepare(`UPDATE store_prices SET available = 0 WHERE location = ? AND last_seen < ?
      AND product_id IN (SELECT id FROM products WHERE store = ?)`).run(location, since, store).changes;
  }
  return d.prepare('UPDATE products SET available = 0 WHERE store = ? AND last_seen < ?').run(store, since).changes;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export { nowIso };
