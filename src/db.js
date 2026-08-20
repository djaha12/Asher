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
// Фотографии изделий лежат рядом с базой — так резервная копия это одна папка.
const MEDIA_DIR = process.env.ASHER_MEDIA || path.join(path.dirname(DB_PATH), 'images');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
/*
 * Если по базе кто-то пишет прямо сейчас, ждём его, а не падаем с ошибкой.
 * Так бывает при наполнении демо-данными во время работы системы или если
 * случайно запущены две копии: пять секунд ожидания вместо «Внутренняя ошибка».
 */
db.exec('PRAGMA busy_timeout = 5000');

// Регистронезависимый поиск для кириллицы: встроенный LIKE в SQLite
// понижает регистр только у латиницы, поэтому регистрируем свою функцию.
db.function('nlower', { deterministic: true }, s => (s === null || s === undefined) ? null : String(s).toLowerCase());

/*
 * Только цифры номера. Телефон записывают как придётся: «+996 700 495-25-73»,
 * «0700 4952573», «(0700) 495253». Чтобы поиск находил номер в любом виде,
 * сравниваем голые цифры с обеих сторон.
 */
db.function('digits', { deterministic: true },
  s => (s === null || s === undefined) ? '' : String(s).replace(/\D/g, ''));

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

/*
 * Устройства, с которых сотруднику разрешено входить.
 *
 * Пароль защищает от того, кто его не знает. Но пароль может утечь: записан
 * на бумажке у кассы, подсмотрен через плечо, тот же самый, что от почты.
 * После переезда в интернет страницу входа видит весь мир, и знающий пароль
 * заходит откуда угодно — ни одна проверка сложности пароля этого не ловит.
 *
 * Поэтому вход разрешён только с известных устройств. Незнакомое устройство
 * получает не отказ, а ожидание: владелец видит его у себя и разрешает одним
 * нажатием. Укравший пароль не проходит дальше этого экрана, потому что
 * разрешить может только владелец, уже находящийся внутри.
 *
 * approved = 0 — ждёт разрешения, 1 — разрешено.
 * code — короткий номер, который видят и продавец, и владелец: по нему
 * владелец понимает, что разрешает именно тот телефон, о котором его просят,
 * а не чужой, подвернувшийся в списке в ту же минуту.
 */
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT '',
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_seen TEXT NOT NULL DEFAULT '',
  last_ip TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, device_key)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, approved);

/*
 * Сверка кассы.
 *
 * Шесть продавцов принимают наличные, а сверить деньги в ящике с тем, что
 * в системе, до сих пор было нечем. Расхождение владелец заметил бы, только
 * когда оно накопится, — и уже не понял бы, откуда оно взялось. Это самая
 * частая дыра в рознице, и она чаще не про воровство, а про обычные ошибки
 * со сдачей.
 *
 * Каждая сверка — это точка отсчёта для следующей: «в ящике было столько-то»,
 * дальше считаем движение денег от неё. Поэтому храним и пересчитанное, и
 * ожидавшееся: разницу нельзя вычислить задним числом, если не помнить обе
 * цифры на тот момент.
 */
CREATE TABLE IF NOT EXISTS cash_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opening REAL NOT NULL DEFAULT 0,      -- сколько было в ящике на прошлой сверке
  movement REAL NOT NULL DEFAULT 0,     -- пришло минус ушло с тех пор
  expected REAL NOT NULL DEFAULT 0,     -- сколько должно быть
  counted REAL NOT NULL DEFAULT 0,      -- сколько пересчитали руками
  difference REAL NOT NULL DEFAULT 0,   -- counted - expected
  since_at TEXT NOT NULL DEFAULT '',    -- с какого момента считали движение
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_counts_created ON cash_counts(created_at);

/*
 * Постоянные расходы: аренда, зарплата, коммунальные, охрана.
 *
 * Они одинаковые из месяца в месяц, и именно поэтому про них забывают: сумма
 * известна, дата известна, никто не напоминает. А забытый расход — это не
 * «потом впишем»: он молча завышает прибыль в отчёте, и владелец весь месяц
 * думает, что заработал больше, чем на самом деле.
 *
 * Система их НЕ создаёт сама. Сумма почти всегда чуть другая — премия,
 * неполный месяц, выросла аренда, — и записывать за владельца деньги, которых
 * он не подтверждал, нельзя: в отчёте появятся операции, которых не было.
 * Поэтому система только напоминает и подставляет сумму, а решает человек.
 */
CREATE TABLE IF NOT EXISTS regular_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  -- Для зарплаты: кому именно. Одна строка «Зарплата 210 000» не отвечает
  -- на вопрос «а Анне заплатили?», а он возникает каждый месяц.
  employee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cash INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
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
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  -- own          — изделие куплено, лежит на нашем балансе
  -- consignment  — товар поставщика на реализации: платим владельцу только после продажи
  ownership TEXT NOT NULL DEFAULT 'own' CHECK (ownership IN ('own','consignment')),
  created_at TEXT NOT NULL,
  sold_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file TEXT NOT NULL,               -- имя файла полноразмерного изображения в data/images
  thumb TEXT NOT NULL,              -- имя файла миниатюры
  is_main INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

-- Сертификаты на камни (GIA, IGI, HRD): отдельно от фотографий изделия.
-- Отдельная таблица, а не признак в product_images, потому что иначе скан
-- сертификата становился бы обложкой изделия в каталоге и в инвентаризации,
-- попадал в счётчик фотографий и ломал фильтр «Без фото».
-- thumb пустой у PDF: миниатюру из него не сделать.
CREATE TABLE IF NOT EXISTS product_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lab TEXT DEFAULT '',
  number TEXT DEFAULT '',
  file TEXT NOT NULL,
  thumb TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certs_product ON product_certificates(product_id);

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
  paid REAL NOT NULL DEFAULT 0,     -- сколько денег фактически получено по чеку
  due_date TEXT DEFAULT '',         -- когда клиент обещал погасить остаток
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
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
  -- Наличными или нет. Нужно для сверки кассы: аренда, уплаченная переводом,
  -- денег из ящика не забирает, и вычитать её оттуда — значит каждый месяц
  -- показывать недостачу, которой не было.
  cash INTEGER NOT NULL DEFAULT 1,
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

-- Платежи клиентов: и первый взнос при продаже, и последующие погашения долга.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES service_orders(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','transfer')),
  note TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);

-- Расчёты с поставщиками — единая книга операций.
--   invoice          — поставка товара (мы стали должны)
--   consignment_sale — продали чужое изделие (стали должны владельцу)
--   payment          — заплатили поставщику (долг уменьшился)
--   adjust           — ручная корректировка (со знаком)
CREATE TABLE IF NOT EXISTS supplier_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('invoice','consignment_sale','payment','adjust')),
  amount REAL NOT NULL,
  doc_number TEXT DEFAULT '',
  doc_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  note TEXT DEFAULT '',
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  method TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supops_supplier ON supplier_ops(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supops_sale ON supplier_ops(sale_id);

-- Инвентаризация: сессия пересчёта по точке и отсканированные изделия.
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','finished')),
  note TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  UNIQUE (session_id, product_id)
);

-- Перемещение изделий между точками.
CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  from_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  to_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  note TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_product ON stock_transfers(product_id);

-- Комплекты (гарнитуры): кольцо + серьги + подвеска одной позицией.
-- Сам комплект НЕ изделие и на складе не лежит — это только объединение
-- существующих изделий, иначе остатки и граммы посчитались бы дважды.
CREATE TABLE IF NOT EXISTS product_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,    -- цена комплекта; 0 — сумма цен изделий
  note TEXT DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
`;

db.exec(SCHEMA);

// ---------- Миграции ранее созданных баз ----------
// CREATE TABLE IF NOT EXISTS не меняет уже существующие таблицы, поэтому
// новые колонки добавляем вручную. Каждая проверка идемпотентна.

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumn(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }
  return false;
}

function migrate() {
  // Наличная ли операция — для сверки кассы. У всех прежних записей ставим 1:
  // до появления сверки касса и была единственным способом платить.
  addColumn('finance_ops', 'cash', 'INTEGER NOT NULL DEFAULT 1');
  // Кому платили — для зарплаты. Без этого «Зарплата 210 000» не отвечает
  // на вопрос «а Анне заплатили?».
  addColumn('finance_ops', 'employee_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

  addColumn('products', 'store_id', 'INTEGER REFERENCES stores(id) ON DELETE SET NULL');
  addColumn('products', 'ownership', `TEXT NOT NULL DEFAULT 'own'`);
  addColumn('sales', 'paid', 'REAL NOT NULL DEFAULT 0');
  addColumn('sales', 'due_date', `TEXT DEFAULT ''`);
  addColumn('sales', 'store_id', 'INTEGER REFERENCES stores(id) ON DELETE SET NULL');

  // Срок резерва: до какой даты изделие держим за клиентом.
  addColumn('products', 'reserved_until', `TEXT DEFAULT ''`);

  // Комплект, в который входит изделие.
  addColumn('products', 'set_id', 'INTEGER REFERENCES product_sets(id) ON DELETE SET NULL');

  // Почему изделие ушло со склада: брак, возврат поставщику, утеря, переплавка.
  // Статус остаётся written_off — CHECK-ограничение в SQLite менять нельзя
  // без перестройки таблицы, а причина нужнее нового статуса.
  addColumn('products', 'write_off_reason', `TEXT DEFAULT ''`);

  // Закупка в валюте: цена и курс на момент закупки фиксируются навсегда,
  // а purchase_price всегда хранит пересчитанную сумму в валюте учёта —
  // поэтому себестоимость, маржа, P&L и аналитика работают без изменений.
  addColumn('products', 'purchase_currency', `TEXT DEFAULT ''`);
  addColumn('products', 'purchase_price_orig', 'REAL NOT NULL DEFAULT 0');
  addColumn('products', 'purchase_rate', 'REAL NOT NULL DEFAULT 0');

  // Каким комплектом продана позиция — только для вида чека и истории.
  // Денег в этой колонке нет: суммы остаются в price/discount/final_price,
  // поэтому долг, возвраты и маржа считаются ровно как раньше.
  addColumn('sale_items', 'set_id', 'INTEGER REFERENCES product_sets(id) ON DELETE SET NULL');

  /*
   * Проба и характеристики главного бриллианта — отдельными полями.
   * Раньше проба была частью строки металла («Белое золото 750»), а караты,
   * цвет и чистота лежали внутри списка вставок и в каталоге не показывались.
   * Для дома, торгующего только бриллиантами, это главные признаки товара:
   * по ним ищут, сравнивают и назначают цену.
   */
  addColumn('products', 'fineness', `TEXT DEFAULT ''`);
  addColumn('products', 'carat', 'REAL NOT NULL DEFAULT 0');
  addColumn('products', 'color', `TEXT DEFAULT ''`);
  addColumn('products', 'clarity', `TEXT DEFAULT ''`);

  // Разбираем старую строку металла на металл и пробу: «Белое золото 750»
  // превращается в «Белое золото» + «750». Данные не теряются.
  if (!getSetting('migrated_fineness')) {
    const rows = db.prepare(`SELECT id, metal FROM products WHERE metal LIKE '%_ ___'`).all();
    const upd = db.prepare('UPDATE products SET metal = ?, fineness = ? WHERE id = ?');
    for (const r of rows) {
      const m = String(r.metal || '').match(/^(.*?)\s*(\d{3})\s*$/);
      if (m && m[1]) upd.run(m[1].trim(), m[2], r.id);
    }
    setSetting('migrated_fineness', '1');
  }

  // Караты, цвет и чистоту главного камня переносим из списка вставок наверх.
  if (!getSetting('migrated_carat')) {
    const rows = db.prepare(`SELECT id, gems FROM products WHERE gems != '' AND gems != '[]'`).all();
    const upd = db.prepare('UPDATE products SET carat = ?, color = ?, clarity = ? WHERE id = ?');
    for (const r of rows) {
      let gems = [];
      try { gems = JSON.parse(r.gems || '[]'); } catch { continue; }
      // Главный камень — самый крупный по каратам.
      const main = gems.slice().sort((a, b) => (Number(b.carat) || 0) - (Number(a.carat) || 0))[0];
      if (main) upd.run(Number(main.carat) || 0, String(main.color || ''), String(main.clarity || ''), r.id);
    }
    setSetting('migrated_carat', '1');
  }

  // Номера сертификатов одной строкой — для поиска по каталогу и в кассе.
  // Собирается сервером из gems при каждом сохранении изделия.
  addColumn('products', 'cert_index', `TEXT NOT NULL DEFAULT ''`);

  // Уточнение вида операции с поставщиком: корректировка бывает разной.
  // Возврат товара пишется как adjust с отрицательной суммой и kind='return'.
  addColumn('supplier_ops', 'kind', `TEXT DEFAULT ''`);

  /*
   * Изделия без точки продаж: они числятся в общем складе, но не попадают
   * ни в остатки точки, ни в инвентаризацию — пересчёт всегда идёт по точке.
   * Раскладываем такие по основной точке. Флаг ставим только если точка
   * действительно нашлась, иначе на пустой базе задача потерялась бы.
   */
  if (!getSetting('migrated_store_id')) {
    const def = db.prepare('SELECT id FROM stores ORDER BY is_default DESC, sort, id LIMIT 1').get();
    if (def) {
      db.prepare('UPDATE products SET store_id = ? WHERE store_id IS NULL').run(def.id);
      setSetting('migrated_store_id', '1');
    }
  }

  // Продажи, оформленные до появления долгов, считаем полностью оплаченными:
  // иначе вся прошлая выручка внезапно превратится в долг клиентов.
  if (!getSetting('migrated_paid')) {
    db.exec('UPDATE sales SET paid = total WHERE paid = 0');
    setSetting('migrated_paid', '1');
  }
}

// ---------- Утилиты ----------

function nowIso() {
  return new Date().toISOString();
}

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/*
 * Сумма для журнала действий: «210 000 сом» вместо «210000». Журнал читает
 * владелец глазами, а не программа, и слипшиеся нули там не разобрать.
 */
function money(x) {
  const n = round2(x);
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + getSetting('currency', 'сом');
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
  if (!getSetting('store_name')) setSetting('store_name', 'Asher Diamonds');
  // Курс доллара для закупок — поле в настройках не должно быть пустым при
  // первом запуске. Значение ориентировочное, владелец правит его руками.
  if (!getSetting('usd_rate')) setSetting('usd_rate', '89');
  if (!getSetting('bonus_percent')) setSetting('bonus_percent', '3');

  /*
   * Потолок скидки для продавца.
   *
   * Без него продавец мог поставить скидку в размере всей цены и продать
   * кольцо за ноль — система бы не возразила. Это не выдумка про воровство:
   * так же выглядит опечатка, когда в поле скидки вместо 5 000 набирают
   * 50 000, а изделие стоит 52 000.
   *
   * Значение по умолчанию щедрое: в ювелирной рознице 15% — это много,
   * и в обычный день продавец в него не упрётся. Владелец меняет его
   * в Настройках, а сам ограничением не связан.
   */
  if (!getSetting('max_discount_percent')) setSetting('max_discount_percent', '15');

  // Локаль: при первом запуске подставляем набор страны по умолчанию.
  // Дальше владелец может сменить страну или отдельные поля в Настройках.
  const { presetFor, DEFAULT_COUNTRY, LOCALE_KEYS } = require('./locale');
  if (!getSetting('country')) {
    // Базы, созданные до появления локали, работали в рублях — не меняем им валюту молча.
    const legacyCurrency = getSetting('currency');
    const country = legacyCurrency === '₽' ? 'RU' : DEFAULT_COUNTRY;
    const preset = presetFor(country);
    setSetting('country', country);
    for (const key of LOCALE_KEYS) {
      if (key === 'country') continue;
      if (!getSetting(key)) setSetting(key, preset[key]);
    }
  }

  // Точка продаж должна быть всегда хотя бы одна — к ней привязывается весь товар.
  const hasStores = db.prepare('SELECT COUNT(*) AS c FROM stores').get().c > 0;
  if (!hasStores) {
    db.prepare('INSERT INTO stores (name, address, is_default, sort) VALUES (?,?,1,0)')
      .run(getSetting('store_name', 'Asher Jewelry'), '');
  }
  const defaultStore = db.prepare(
    'SELECT id FROM stores ORDER BY is_default DESC, sort, id LIMIT 1'
  ).get();
  if (defaultStore) {
    db.prepare('UPDATE products SET store_id = ? WHERE store_id IS NULL').run(defaultStore.id);
  }
}

migrate();
ensureDefaults();

module.exports = {
  db,
  DB_PATH,
  MEDIA_DIR,
  nowIso,
  round2,
  money,
  hashPassword,
  makeSalt,
  getSetting,
  setSetting,
  nextNumber,
  audit,
  transaction,
};
