'use strict';
/*
 * Демонстрационные данные: npm run seed
 * Полный сброс базы и новое наполнение: npm run reset
 */
const path = require('node:path');
const fs = require('node:fs');

if (process.argv.includes('--reset')) {
  const dbPath = process.env.ASHER_DB || path.join(__dirname, '..', 'data', 'asher.db');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* нет файла — ок */ }
  }
  console.log('База очищена.');
}

const { db, nowIso, round2, hashPassword, makeSalt, setSetting } = require('./db');

const hasData = db.prepare('SELECT COUNT(*) AS c FROM products').get().c > 0;
if (hasData && !process.argv.includes('--force') && !process.argv.includes('--reset')) {
  console.log('В базе уже есть данные. Запустите `npm run reset` для полного сброса с демо-данными.');
  process.exit(0);
}

const rnd = (min, max) => min + Math.random() * (max - min);
const ri = (min, max) => Math.round(rnd(min, max));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const chance = p => Math.random() < p;

const NOW = Date.now();
const DAY = 86400000;
function isoDaysAgo(days, hourFrom = 10, hourTo = 20) {
  const d = new Date(NOW - days * DAY);
  d.setHours(ri(hourFrom, hourTo), ri(0, 59), ri(0, 59), 0);
  return d.toISOString();
}

console.log('Наполняю базу демо-данными…');

// ---------- Сотрудники ----------
function addUser(username, name, role, password) {
  const salt = makeSalt();
  db.prepare('INSERT OR IGNORE INTO users (username, name, role, password_hash, salt, active, created_at) VALUES (?,?,?,?,?,1,?)')
    .run(username, name, role, hashPassword(password, salt), salt, isoDaysAgo(300));
}
addUser('anna', 'Анна Соколова', 'seller', 'seller123');
addUser('mikhail', 'Михаил Орлов', 'seller', 'seller123');
const userIds = db.prepare('SELECT id FROM users').all().map(r => r.id);

// ---------- Настройки ----------
setSetting('store_name', 'Asher Diamonds');
setSetting('store_address', 'Бишкек, ул. Киевская, 95');
setSetting('store_phone', '+996 312 66-12-34');

// ---------- Поставщики ----------
const supplierNames = [
  ['Алтын Групп', 'Отдел опта', '+996 312 88-11-22'],
  ['Кыргыз Алтын', 'Айгуль Асанова', '+996 555 234-56-78'],
  ['Diamond District (импорт)', 'Давид Аронов', '+996 770 111-22-33'],
  ['Эстет', 'Менеджер Ольга', '+996 312 45-67-89'],
];
const insSup = db.prepare('INSERT INTO suppliers (name, contact, phone, notes) VALUES (?,?,?,?)');
for (const [n, c, p] of supplierNames) insSup.run(n, c, p, '');
const supplierIds = db.prepare('SELECT id FROM suppliers').all().map(r => r.id);

// ---------- Клиенты ----------
const MOBILE_PREFIX = ['500', '550', '555', '700', '705', '755', '770', '772', '990', '995'];
const FIRST_F = ['Анна', 'Мария', 'Елена', 'Айгуль', 'Наталья', 'Жылдыз', 'Светлана', 'Айпери',
  'Виктория', 'Гульнара', 'Алина', 'Бермет', 'Асель', 'Нургуль', 'Дарья', 'Чолпон'];
const LAST_F = ['Иванова', 'Асанова', 'Кузнецова', 'Жумабаева', 'Соколова', 'Токтогулова',
  'Бекова', 'Новикова', 'Садыкова', 'Осмонова', 'Мамытова', 'Абдырахманова'];
const FIRST_M = ['Александр', 'Азамат', 'Сергей', 'Нурлан', 'Алексей', 'Тилек', 'Владимир',
  'Эрлан', 'Николай', 'Тимур', 'Бакыт', 'Улан', 'Дмитрий', 'Мирлан'];
const LAST_M = ['Иванов', 'Асанов', 'Сидоров', 'Жумабаев', 'Соколов', 'Токтогулов',
  'Беков', 'Осмонов', 'Садыков', 'Мамытов', 'Абдырахманов', 'Волков'];
const MID_F = ['Сергеевна', 'Александровна', 'Владимировна', 'Андреевна', 'Игоревна'];
const MID_M = ['Сергеевич', 'Александрович', 'Владимирович', 'Андреевич', 'Игоревич'];
const PREFS = ['Белое золото, бриллианты', 'Классика, жемчуг', 'Розовое золото, минимализм', 'Крупные камни, статусные вещи',
  'Крупные караты', 'Чистота от VS1', 'Классические огранки', 'Винтажный стиль', ''];

const insCust = db.prepare(
  `INSERT INTO customers (name, phone, email, birthday, anniversary, discount, ring_size, preferences, notes, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
const customers = [];
for (let i = 0; i < 26; i++) {
  const female = chance(0.6);
  const name = female
    ? `${pick(LAST_F)} ${pick(FIRST_F)} ${pick(MID_F)}`
    : `${pick(LAST_M)} ${pick(FIRST_M)} ${pick(MID_M)}`;
  const phone = `+996 ${pick(MOBILE_PREFIX)} ${ri(100, 999)}-${String(ri(0, 99)).padStart(2, '0')}-${String(ri(0, 99)).padStart(2, '0')}`;
  const birthday = chance(0.8) ? `${ri(1965, 2000)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}` : '';
  const anniversary = chance(0.3) ? `${ri(2005, 2022)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}` : '';
  const info = insCust.run(name, phone,
    chance(0.5) ? `client${i + 1}@${pick(['mail.ru', 'gmail.com'])}` : '',
    birthday, anniversary, chance(0.3) ? pick([3, 5, 7, 10]) : 0,
    female && chance(0.7) ? pick(['15,5', '16', '16,5', '17', '17,5', '18']) : '',
    pick(PREFS), '', isoDaysAgo(ri(30, 400)));
  customers.push(Number(info.lastInsertRowid));
}

// ---------- Изделия ----------
const cats = Object.fromEntries(db.prepare('SELECT id, name FROM categories').all().map(c => [c.name, c.id]));
// Дом работает только с золотом 750-й пробы, преимущественно белым.
const METALS = ['Белое золото', 'Белое золото', 'Белое золото', 'Жёлтое золото', 'Красное золото'];
const FINENESS = '750';
const NAMES_POOL = ['Аврора', 'Сияние', 'Венеция', 'Ночь', 'Каприз', 'Мираж', 'Элегия', 'Луна', 'Классика', 'Гармония',
  'Афина', 'Софи', 'Империал', 'Флоренция', 'Россыпь', 'Нежность', 'Вдохновение', 'Монако', 'Селена', 'Ривьера'];
const COLORS = ['D', 'E', 'F', 'G', 'H', 'I'];
const CLARITY = ['IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1'];

const CATEGORY_SPECS = {
  'Кольца': { count: 40, w: [1.8, 6.5], price: [45000, 780000], sizes: ['15,5', '16', '16,5', '17', '17,5', '18', '18,5'] },
  'Серьги': { count: 30, w: [2.2, 8], price: [38000, 620000], sizes: [''] },
  'Подвески': { count: 20, w: [1.2, 4.5], price: [22000, 350000], sizes: [''] },
  'Браслеты': { count: 15, w: [5, 18], price: [40000, 450000], sizes: ['17', '18', '19', '20'] },
  'Цепи': { count: 17, w: [4, 25], price: [30000, 280000], sizes: ['45', '50', '55', '60'] },
  'Колье': { count: 10, w: [8, 25], price: [120000, 1500000], sizes: ['42', '45'] },
  'Броши': { count: 6, w: [4, 10], price: [35000, 240000], sizes: [''] },
  'Часы': { count: 6, w: [40, 90], price: [180000, 950000], sizes: [''] },
  'Комплекты': { count: 8, w: [6, 16], price: [150000, 1200000], sizes: [''] },
};
const PREFIX = { 'Кольца': 'Кольцо', 'Серьги': 'Серьги', 'Подвески': 'Подвеска', 'Браслеты': 'Браслет',
  'Цепи': 'Цепь', 'Колье': 'Колье', 'Броши': 'Брошь', 'Часы': 'Часы', 'Комплекты': 'Комплект' };

function gemsFor(withDiamond, price) {
  if (!withDiamond) return [];
  // Только бриллианты: другие камни дом не продаёт.
  const carat = price > 400000 ? rnd(0.7, 2.5) : rnd(0.1, 0.7);
  const gems = [{
    type: 'Бриллиант', carat: Math.round(carat * 100) / 100,
    color: pick(COLORS), clarity: pick(CLARITY), cut: 'Кр-57',
    count: chance(0.3) ? ri(2, 12) : 1,
  }];
  if (chance(0.35)) {
    gems.push({ type: 'Бриллиант', carat: Math.round(rnd(0.01, 0.05) * 100) / 100,
      color: pick(COLORS), clarity: pick(CLARITY), cut: 'Кр-57', count: ri(6, 24) });
  }
  return gems;
}
function gemSummary(gems) {
  return gems.map(g => [g.count > 1 ? g.count + '×' : '', g.type, g.carat ? g.carat + ' ct' : '',
    [g.color, g.clarity].filter(Boolean).join('/')].filter(Boolean).join(' ')).join('; ');
}

const insProd = db.prepare(
  `INSERT INTO products (sku, barcode, name, category_id, metal, fineness, weight, size,
     carat, color, clarity, gems, gem_summary,
     purchase_price, retail_price, supplier_id, status, location, description, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in_stock',?,?,?)`
);
const products = [];
let skuN = 1;
for (const [catName, spec] of Object.entries(CATEGORY_SPECS)) {
  for (let i = 0; i < spec.count; i++) {
    const retail = Math.round(rnd(spec.price[0], spec.price[1]) / 500) * 500;
    const purchase = Math.round(retail / rnd(1.7, 2.2) / 100) * 100;
    const withGems = catName !== 'Цепи' || chance(0.2);
    const gems = gemsFor(withGems, retail);
    const metal = pick(METALS);
    const name = `${PREFIX[catName]} ${gems.length ? 'с бриллиантом' : ''} «${pick(NAMES_POOL)}»`.replace('  ', ' ');
    const sku = `AS-${String(skuN).padStart(5, '0')}`;
    const barcode = `2000000${String(skuN).padStart(6, '0')}`;
    skuN++;
    const createdDays = ri(5, 300);
    // Главный камень выносим в поля изделия — по ним ищут и сравнивают.
    const main = gems[0] || {};
    const info = insProd.run(sku, barcode, name, cats[catName], metal, FINENESS,
      Math.round(rnd(spec.w[0], spec.w[1]) * 100) / 100, pick(spec.sizes),
      main.carat || 0, main.color || '', main.clarity || '',
      JSON.stringify(gems), gemSummary(gems), purchase, retail,
      pick(supplierIds), pick(['Витрина 1', 'Витрина 2', 'Витрина 3', 'Сейф']),
      '', isoDaysAgo(createdDays));
    products.push({ id: Number(info.lastInsertRowid), retail, purchase, createdDays });
  }
}

// ---------- Продажи за последние ~8 месяцев ----------
const available = [...products];
const salesPlan = [];
for (let day = 240; day >= 0; day--) {
  const weekend = new Date(NOW - day * DAY).getDay() % 6 === 0;
  const n = chance(weekend ? 0.45 : 0.22) ? (chance(0.25) ? 2 : 1) : 0;
  for (let k = 0; k < n; k++) salesPlan.push(day);
}
// гарантируем свежие продажи, чтобы дашборд был живым
salesPlan.push(0, 0, 1, 2, 3, 5, 6, 8, 9, 11);
salesPlan.sort((a, b) => b - a);

const insSale = db.prepare(
  `INSERT INTO sales (number, customer_id, user_id, subtotal, discount_total, total, cost_total,
     bonus_earned, bonus_spent, payment_method, status, paid, due_date, store_id, note, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,'',?)`
);
const insPayment = db.prepare(
  `INSERT INTO payments (customer_id, sale_id, amount, method, note, user_id, created_at)
   VALUES (?,?,?,?,?,?,?)`
);
const demoStoreId = (db.prepare('SELECT id FROM stores ORDER BY is_default DESC, id LIMIT 1').get() || {}).id || null;
const insItem = db.prepare(
  'INSERT INTO sale_items (sale_id, product_id, price, discount, final_price, cost) VALUES (?,?,?,?,?,?)'
);
const markSold = db.prepare(`UPDATE products SET status='sold', sold_at=? WHERE id = ?`);
const insFin = db.prepare(
  `INSERT INTO finance_ops (type, category, amount, note, sale_id, order_id, user_id, created_at)
   VALUES (?,?,?,?,?,?,?,?)`
);

let saleN = 0;
const saleIds = [];
for (const day of salesPlan) {
  // продаём только то, что уже поступило к этой дате
  const candidates = available.filter(p => p.createdDays > day);
  if (!candidates.length) continue;
  const itemsCount = chance(0.15) ? 2 : 1;
  const chosen = [];
  for (let i = 0; i < itemsCount && candidates.length; i++) {
    const idx = Math.floor(Math.random() * candidates.length);
    chosen.push(candidates[idx]);
    candidates.splice(idx, 1);
    available.splice(available.findIndex(p => p.id === chosen[i].id), 1);
  }
  if (!chosen.length) continue;

  const customerId = chance(0.72) ? pick(customers) : null;
  const ts = isoDaysAgo(day);
  saleN++;
  const number = `П-${String(saleN).padStart(6, '0')}`;
  let subtotal = 0, discount = 0, cost = 0;
  const prepared = chosen.map(p => {
    const d = chance(0.35) ? Math.round(p.retail * pick([0.03, 0.05, 0.07, 0.1]) / 100) * 100 : 0;
    subtotal += p.retail; discount += d; cost += p.purchase;
    return { p, d, final: p.retail - d };
  });
  const total = round2(subtotal - discount);

  // Примерно каждая восьмая покупка с клиентом — в рассрочку: так в демо-данных
  // видно, как работает раздел долгов. Остальные оплачены полностью.
  const inDebt = customerId && chance(0.12);
  const paid = inDebt ? Math.round(total * pick([0.2, 0.3, 0.5]) / 100) * 100 : total;
  // Часть долгов делаем просроченными, часть — со сроком в будущем.
  const dueDate = inDebt
    ? new Date(new Date(ts).getTime() + pick([-20, -5, 14, 40]) * DAY).toISOString().slice(0, 10)
    : '';
  const method = inDebt ? 'installment' : pick(['cash', 'card', 'card', 'card', 'transfer']);

  const info = insSale.run(number, customerId, pick(userIds), subtotal, discount, total, cost,
    0, 0, method, paid, dueDate, demoStoreId, ts);
  const saleId = Number(info.lastInsertRowid);
  saleIds.push({ saleId, number, total, customerId, ts });
  for (const pr of prepared) {
    insItem.run(saleId, pr.p.id, pr.p.retail, pr.d, pr.final, pr.p.purchase);
    markSold.run(ts, pr.p.id);
  }
  // В кассу попадает только фактически полученное — как и в рабочем режиме.
  if (paid > 0) {
    insFin.run('income', 'Продажа', paid, `Чек ${number}`, saleId, null, userIds[0], ts);
    insPayment.run(customerId, saleId, paid, method === 'installment' ? 'cash' : method,
      inDebt ? 'Первый взнос' : 'Оплата чека', userIds[0], ts);
  }
}

// один возврат для реалистичности
if (saleIds.length > 10) {
  const target = saleIds[ri(2, 8)];
  const item = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? LIMIT 1').get(target.saleId);
  const retTs = new Date(new Date(target.ts).getTime() + 3 * DAY).toISOString();
  db.prepare('UPDATE sale_items SET returned = 1, returned_at = ? WHERE id = ?').run(retTs, item.id);
  db.prepare(`UPDATE products SET status='in_stock', sold_at=NULL WHERE id = ?`).run(item.product_id);
  const left = db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ? AND returned = 0').get(target.saleId).c;
  db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(Number(left) ? 'partial_return' : 'returned', target.saleId);
  // Возвращаем деньгами только полученное: если чек был в рассрочку, часть суммы гасит долг.
  const sale = db.prepare('SELECT paid FROM sales WHERE id = ?').get(target.saleId);
  const newEffective = round2(db.prepare(
    'SELECT COALESCE(SUM(final_price),0) AS s FROM sale_items WHERE sale_id = ? AND returned = 0'
  ).get(target.saleId).s);
  const cashRefund = round2(Math.max(0, sale.paid - newEffective));
  if (cashRefund > 0) {
    db.prepare('UPDATE sales SET paid = ? WHERE id = ?').run(newEffective, target.saleId);
    insFin.run('expense', 'Возврат покупателю', cashRefund, `Возврат по чеку ${target.number}`, target.saleId, null, userIds[0], retTs);
  }
  const av = products.find(p => p.id === item.product_id);
  if (av) available.push(av);
}

// пара резервов
const inStock = db.prepare(`SELECT id FROM products WHERE status = 'in_stock' ORDER BY RANDOM() LIMIT 2`).all();
for (const p of inStock) {
  db.prepare(`UPDATE products SET status = 'reserved', reserved_for = ? WHERE id = ?`).run(pick(customers), p.id);
}

// ---------- Заказы и ремонт ----------
const ORDERS = [
  ['repair', 'Заменить замок на цепи, проверить звенья', 'delivered', 3500, 40],
  ['resize', 'Уменьшить кольцо с 17,5 до 16,5 размера', 'delivered', 2800, 25],
  ['engraving', 'Гравировка на внутренней стороне кольца: «Навсегда. 14.02»', 'ready', 1800, 6],
  ['custom', 'Изготовить серьги по эскизу клиента: белое золото, сапфиры 2×0.5 ct', 'in_progress', 145000, 12],
  ['repair', 'Восстановить родирование кольца, полировка', 'in_progress', 4500, 4],
  ['cleaning', 'Ультразвуковая чистка комплекта (кольцо + серьги)', 'accepted', 1500, 1],
  ['appraisal', 'Оценка бабушкиной броши с камнями для страховки', 'accepted', 3000, 2],
  ['custom', 'Обручальные кольца парные, золото 585, гравировка', 'delivered', 96000, 60],
  ['repair', 'Спаять порванную цепочку', 'delivered', 1200, 15],
  ['resize', 'Увеличить кольцо с 16 до 17 размера', 'ready', 3200, 5],
];
const insOrder = db.prepare(
  `INSERT INTO service_orders (number, type, customer_id, user_id, description, status,
     estimate, prepayment, final_price, paid, due_date, accepted_at, delivered_at, note)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'')`
);
ORDERS.forEach(([type, desc, status, price, daysAgo], i) => {
  const number = `З-${String(i + 1).padStart(6, '0')}`;
  const acceptedAt = isoDaysAgo(daysAgo);
  const cid = pick(customers);
  const prepay = status === 'accepted' ? 0 : Math.round(price * 0.5 / 100) * 100;
  const delivered = status === 'delivered';
  const paid = delivered ? price : prepay;
  const due = new Date(new Date(acceptedAt).getTime() + ri(5, 14) * DAY).toISOString().slice(0, 10);
  const info = insOrder.run(number, type, cid, pick(userIds), desc, status,
    price, prepay, delivered ? price : 0, paid, due, acceptedAt,
    delivered ? new Date(new Date(acceptedAt).getTime() + ri(4, 10) * DAY).toISOString() : null);
  const orderId = Number(info.lastInsertRowid);
  if (prepay > 0) insFin.run('income', 'Оплата заказа', prepay, `Предоплата по заказу ${number}`, null, orderId, userIds[0], acceptedAt);
  if (delivered && price - prepay > 0) {
    insFin.run('income', 'Оплата заказа', price - prepay, `Оплата по заказу ${number}`, null, orderId, userIds[0],
      new Date(new Date(acceptedAt).getTime() + ri(4, 10) * DAY).toISOString());
  }
});

// ---------- Расходы по месяцам ----------
const EXPENSES = [
  ['Аренда', 145000, 1], ['Зарплата', 210000, 5], ['Коммунальные услуги', 14000, 8],
  ['Охрана', 18000, 3], ['Реклама', 0, 12], ['Банковские услуги', 7500, 15],
];
for (let m = 0; m < 8; m++) {
  for (const [cat, base, dayOfMonth] of EXPENSES) {
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - m);
    d.setDate(dayOfMonth);
    d.setHours(11, 0, 0, 0);
    if (d.getTime() > NOW) continue;
    const amount = cat === 'Реклама' ? ri(15, 45) * 1000 : Math.round(base * rnd(0.95, 1.08) / 100) * 100;
    insFin.run('expense', cat, amount, '', null, null, userIds[0], d.toISOString());
  }
  // закупка товара — раз в месяц-полтора
  if (chance(0.7)) {
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - m);
    d.setDate(ri(10, 25));
    d.setHours(13, 0, 0, 0);
    if (d.getTime() <= NOW) {
      insFin.run('expense', 'Закупка товара', ri(300, 900) * 1000, 'Пополнение коллекции', null, null, userIds[0], d.toISOString());
    }
  }
}
// налоги ~ последние месяцы
for (let m = 1; m <= 7; m++) {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - m + 1);
  d.setDate(28);
  d.setHours(12, 0, 0, 0);
  if (d.getTime() > NOW) continue;
  insFin.run('expense', 'Налоги', ri(40, 90) * 1000, '', null, null, userIds[0], d.toISOString());
}

// ---------- Точки, товар на реализации, расчёты с поставщиками ----------

// Весь товар должен где-то лежать — иначе его не увидит инвентаризация.
if (demoStoreId) db.prepare('UPDATE products SET store_id = ? WHERE store_id IS NULL').run(demoStoreId);

// Вторая точка и несколько перемещённых на неё изделий.
const secondStore = Number(db.prepare(
  'INSERT INTO stores (name, address, phone, is_default, sort) VALUES (?,?,?,0,1)'
).run('Салон на Чуй', 'пр. Чуй, 155, Бишкек', '+996 312 90-45-67').lastInsertRowid);
const toMove = db.prepare(`SELECT id FROM products WHERE status='in_stock' ORDER BY RANDOM() LIMIT 12`).all();
for (const p of toMove) {
  db.prepare('UPDATE products SET store_id = ? WHERE id = ?').run(secondStore, p.id);
  db.prepare(
    `INSERT INTO stock_transfers (product_id, from_store_id, to_store_id, note, user_id, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(p.id, demoStoreId, secondStore, 'Пополнение витрины', userIds[0], isoDaysAgo(ri(3, 30)));
}

// Часть изделий берём на реализацию — так видно раздел «На реализации».
const consignmentSupplier = supplierIds[0];
const toConsign = db.prepare(`SELECT id FROM products WHERE status='in_stock' ORDER BY RANDOM() LIMIT 9`).all();
for (const p of toConsign) {
  db.prepare(`UPDATE products SET ownership='consignment', supplier_id=? WHERE id=?`)
    .run(consignmentSupplier, p.id);
}

// Расчёты с поставщиками: поставки и частичные оплаты.
const insSupOp = db.prepare(
  `INSERT INTO supplier_ops (supplier_id, type, amount, doc_number, doc_date, due_date, note, method, user_id, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
supplierIds.forEach((sid, i) => {
  for (let k = 0; k < 2; k++) {
    const days = ri(20, 150);
    const ts = isoDaysAgo(days);
    const amount = ri(250, 800) * 1000;
    insSupOp.run(sid, 'invoice', amount, `НК-${100 + i * 10 + k}`, ts.slice(0, 10),
      new Date(new Date(ts).getTime() + 45 * DAY).toISOString().slice(0, 10),
      'Поставка изделий', '', userIds[0], ts);
    // Большую часть поставок оплатили, одну оставляем висеть долгом.
    if (!(i === 0 && k === 0)) {
      const payTs = isoDaysAgo(Math.max(1, days - ri(5, 15)));
      insSupOp.run(sid, 'payment', amount, '', payTs.slice(0, 10), '', 'Оплата по накладной',
        'transfer', userIds[0], payTs);
      insFin.run('expense', 'Оплата поставщику', amount, `Расчёт с поставщиком`, null, null, userIds[0], payTs);
    }
  }
});

const stats = {
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  sold: db.prepare(`SELECT COUNT(*) c FROM products WHERE status='sold'`).get().c,
  consignment: db.prepare(`SELECT COUNT(*) c FROM products WHERE ownership='consignment'`).get().c,
  customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
  sales: db.prepare('SELECT COUNT(*) c FROM sales').get().c,
  debtors: db.prepare(
    `SELECT COUNT(DISTINCT customer_id) c FROM sales s
     WHERE (SELECT COALESCE(SUM(final_price),0) FROM sale_items WHERE sale_id=s.id AND returned=0) - s.paid > 0.009`
  ).get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM service_orders').get().c,
  finance: db.prepare('SELECT COUNT(*) c FROM finance_ops').get().c,
};
console.log('Готово:', JSON.stringify(stats));
console.log('\nВход: admin / admin123 (администратор), anna / seller123 (продавец)');
