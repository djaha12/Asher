'use strict';
/*
 * База данных Asher CRM.
 * Использует встроенный node:sqlite (Node.js >= 22.5), внешние зависимости не нужны.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.ASHER_DB || path.join(DATA_DIR, 'asher.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Регистронезависимый поиск для кириллицы: встроенный LIKE в SQLite
// понижает регистр только у латиницы, поэтому регистрируем свою функцию.
db.function('nlower', { deterministic: true }, s => (s === null || s === undefined) ? null : String(s).toLowerCase());

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('admin','seller')),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT DEFAULT '',
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  metal TEXT DEFAULT '',            -- например "Золото 585", "Платина 950"
  weight REAL DEFAULT 0,            -- вес изделия, граммы
  size TEXT DEFAULT '',             -- размер кольца / длина цепи
  gems TEXT DEFAULT '[]',           -- JSON: [{type, carat, color, clarity, cut, count}]
  gem_summary TEXT DEFAULT '',      -- краткое описание вставок для списка
  purchase_price REAL NOT NULL DEFAULT 0,
  retail_price REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','reserved','sold','written_off')),
  reserved_for INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  location TEXT DEFAULT '',         -- витрина / сейф / на реализации
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  sold_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  birthday TEXT DEFAULT '',         -- ISO дата или ''
  anniversary TEXT DEFAULT '',      -- памятная дата (годовщина)
  segment TEXT NOT NULL DEFAULT 'new' CHECK (segment IN ('new','regular','vip')),
  discount REAL NOT NULL DEFAULT 0, -- персональная скидка, %
  bonus_points REAL NOT NULL DEFAULT 0,
  ring_size TEXT DEFAULT '',
  preferences TEXT DEFAULT '',      -- предпочтения: металл, камни, стиль
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,      -- номер чека, например "П-000123"
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subtotal REAL NOT NULL DEFAULT 0,   -- сумма по ценам до скидок
  discount_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,      -- итог к оплате
  cost_total REAL NOT NULL DEFAULT 0, -- себестоимость (для маржи)
  bonus_earned REAL NOT NULL DEFAULT 0,
  bonus_spent REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card','transfer','installment')),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','partial_return','returned')),
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  price REAL NOT NULL,              -- розничная цена на момент продажи
  discount REAL NOT NULL DEFAULT 0, -- скидка на позицию, руб.
  final_price REAL NOT NULL,        -- price - discount
  cost REAL NOT NULL DEFAULT 0,     -- закупочная цена на момент продажи
  returned INTEGER NOT NULL DEFAULT 0,
  returned_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS service_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,      -- "З-000045"
  type TEXT NOT NULL DEFAULT 'repair' CHECK (type IN ('repair','custom','engraving','resize','cleaning','appraisal')),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','in_progress','ready','delivered','cancelled')),
  estimate REAL NOT NULL DEFAULT 0,    -- предварительная стоимость
  prepayment REAL NOT NULL DEFAULT 0,  -- внесённая предоплата
  final_price REAL NOT NULL DEFAULT 0, -- итоговая стоимость
  paid REAL NOT NULL DEFAULT 0,        -- всего оплачено
  due_date TEXT DEFAULT '',
  accepted_at TEXT NOT NULL,
  delivered_at TEXT,
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON service_orders(status);

CREATE TABLE IF NOT EXISTS finance_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT DEFAULT '',
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES service_orders(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_created ON finance_ops(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

db.exec(SCHEMA);

// ---------- Утилиты ----------

function nowIso() {
  return new Date().toISOString();
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Номера документов: П-000001 (продажи), З-000001 (заказы)
function nextNumber(prefix, table) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
  let n = Number(row.c) + 1;
  // защита от коллизий после удалений/импорта
  for (;;) {
    const num = `${prefix}-${String(n).padStart(6, '0')}`;
    const exists = db.prepare(`SELECT 1 FROM ${table} WHERE number = ?`).get(num);
    if (!exists) return num;
    n++;
  }
}

function audit(userId, action, entity, entityId, details = '') {
  db.prepare(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (?,?,?,?,?,?)'
  ).run(userId ?? null, action, entity, entityId ?? null, String(details), nowIso());
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Первичная инициализация ----------

function ensureDefaults() {
  const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  if (!hasUsers) {
    const salt = makeSalt();
    db.prepare(
      'INSERT INTO users (username, name, role, password_hash, salt, active, created_at) VALUES (?,?,?,?,?,1,?)'
    ).run('admin', 'Администратор', 'admin', hashPassword('admin123', salt), salt, nowIso());
  }
  const hasCategories = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c > 0;
  if (!hasCategories) {
    const cats = ['Кольца', 'Серьги', 'Подвески', 'Браслеты', 'Цепи', 'Колье', 'Броши', 'Часы', 'Комплекты'];
    const ins = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
    cats.forEach((c, i) => ins.run(c, i));
  }
  if (!getSetting('store_name')) setSetting('store_name', 'Asher Jewelry');
  if (!getSetting('bonus_percent')) setSetting('bonus_percent', '3');
  if (!getSetting('currency')) setSetting('currency', '₽');
}

ensureDefaults();

module.exports = {
  db,
  DB_PATH,
  nowIso,
  round2,
  hashPassword,
  makeSalt,
  getSetting,
  setSetting,
  nextNumber,
  audit,
  transaction,
};
