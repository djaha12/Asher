'use strict';
/*
 * Категории магазина — шесть: Кольца, Серьги, Подвески, Браслеты, Колье, Часы.
 *
 * Владелец: «пусеты переименовать в серьги — все пусеты перенести в серьги;
 * категории пусеты и буквенные подвески удалить, буквенные подвески — в
 * подвески; должно быть: серьги, кольца, колье, браслеты, часы» (и подвески).
 * Базу магазина к этому приводит обновление — один раз:
 *   — изделия из «Пусет» — в «Серьги», из «Буквенных подвесок» — в «Подвески»;
 *     название, поставленное по категории, идёт за ними, своё — остаётся;
 *   — лишние категории удаляются, только если пустые: изделие без категории
 *     потерялось бы, а куда его — решать владельцу;
 *   — всё сделанное записано в журнал действий.
 * Новая база сразу получает эти шесть категорий.
 *
 * Своя база в тесты/.вывод/категории: общий сервер здесь не нужен.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'категории');
const БАЗА = path.join(РАБОТА, 'asher.db');
const ШЕСТЬ = ['Кольца', 'Серьги', 'Подвески', 'Браслеты', 'Колье', 'Часы'];

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};

const окружение = { ...process.env, ASHER_DB: БАЗА, ASHER_DATA: РАБОТА, NO_OPEN: '1' };
// Запуск системы = открыть базу: при этом один раз выполняются переделки старых баз.
const запустить = () => spawnSync(process.execPath, ['-e', "require('./src/db')"], { cwd: ROOT, env: окружение, encoding: 'utf8' });
const порядок = db => db.prepare('SELECT name FROM categories ORDER BY sort, id').all().map(c => c.name);
const изделие = (db, sku) => db.prepare(`SELECT p.name, p.retail_price, c.name AS кат FROM products p
  LEFT JOIN categories c ON c.id = p.category_id WHERE p.sku = ?`).get(sku);

fs.rmSync(РАБОТА, { recursive: true, force: true });
fs.mkdirSync(РАБОТА, { recursive: true });

console.log('=== 1. Новая база — сразу шесть категорий ===');
let r = запустить();
check('система запустилась', r.status === 0, r.stderr);
let db = new DatabaseSync(БАЗА);
check('Кольца, Серьги, Подвески, Браслеты, Колье, Часы — и больше ничего', JSON.stringify(порядок(db)) === JSON.stringify(ШЕСТЬ), порядок(db).join(', '));
check('в журнале пусто — переносить было нечего', !db.prepare(`SELECT 1 FROM audit_log WHERE entity = 'category'`).get());
db.close();

console.log('\n=== 2. База магазина, как сейчас: пусеты, буквенные подвески, цепи… ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'categories_trimmed'`).run();
db.prepare('DELETE FROM categories').run();
const было = ['Кольца', 'Серьги', 'Пусеты', 'Подвески', 'Буквенные подвески', 'Браслеты', 'Цепи', 'Колье', 'Броши', 'Часы',
  'Комплекты', 'Пирсинг', 'Эксклюзив'];
const id = {};
было.forEach((к, i) => { id[к] = Number(db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(к, i).lastInsertRowid); });
const завести = (sku, name, кат, цена = 50000) => db.prepare(
  `INSERT INTO products (sku, name, category_id, retail_price, weight, created_at) VALUES (?, ?, ?, ?, 2.5, '2026-09-28T10:00:00Z')`
).run(sku, name, id[кат], цена);
завести('П-1', 'Пусеты', 'Пусеты', 61000);          // название по категории
завести('П-2', 'Пусеты «Капля»', 'Пусеты');           // своё название
завести('Б-1', 'Буквенная подвеска', 'Буквенные подвески', 27000);
завести('Б-2', 'Буквенные подвески', 'Буквенные подвески');
завести('Ц-1', 'Цепь «Якорная»', 'Цепи');             // в лишней категории есть изделие
завести('Э-1', 'Кольцо «Эксклюзив»', 'Эксклюзив');
завести('К-1', 'Кольцо', 'Кольца');
db.close();
r = запустить();
check('обновление прошло', r.status === 0, r.stderr);
db = new DatabaseSync(БАЗА);
const стало = порядок(db);
check('пусеты — в «Серьгах», название по категории стало «Серьги»', JSON.stringify(изделие(db, 'П-1'))
  === JSON.stringify({ name: 'Серьги', retail_price: 61000, кат: 'Серьги' }), JSON.stringify(изделие(db, 'П-1')));
check('своё название («Пусеты «Капля»») не тронуто', изделие(db, 'П-2').name === 'Пусеты «Капля»' && изделие(db, 'П-2').кат === 'Серьги',
  JSON.stringify(изделие(db, 'П-2')));
check('буквенные подвески — в «Подвесках», названия «Подвеска»',
  ['Б-1', 'Б-2'].every(s => изделие(db, s).кат === 'Подвески' && изделие(db, s).name === 'Подвеска')
  && изделие(db, 'Б-1').retail_price === 27000, JSON.stringify(['Б-1', 'Б-2'].map(s => изделие(db, s))));
check('«Пусеты» и «Буквенные подвески» удалены', !стало.includes('Пусеты') && !стало.includes('Буквенные подвески'), стало.join(', '));
check('пустые лишние («Броши», «Комплекты», «Пирсинг») удалены',
  !['Броши', 'Комплекты', 'Пирсинг'].some(к => стало.includes(к)), стало.join(', '));
check('лишние с изделиями («Цепи», «Эксклюзив») оставлены — изделия не потерялись',
  изделие(db, 'Ц-1').кат === 'Цепи' && изделие(db, 'Э-1').кат === 'Эксклюзив', стало.join(', '));
check('шесть категорий магазина на месте и в прежнем порядке',
  JSON.stringify(стало.filter(к => ШЕСТЬ.includes(к))) === JSON.stringify(ШЕСТЬ), стало.join(', '));
check('кольцо не тронуто', JSON.stringify(изделие(db, 'К-1')) === JSON.stringify({ name: 'Кольцо', retail_price: 50000, кат: 'Кольца' }));
check('ни одно изделие не осталось без категории', !db.prepare('SELECT 1 FROM products WHERE category_id IS NULL').get());
const запись = (db.prepare(`SELECT details FROM audit_log WHERE entity = 'category' ORDER BY id DESC`).get() || {}).details || '';
check('в журнале — что куда переехало и что удалено', /«Пусеты» → «Серьги» \(изделий: 2\)/.test(запись)
  && /«Буквенные подвески» → «Подвески» \(изделий: 2\)/.test(запись) && /«Броши» удалена/.test(запись)
  && /«Цепи» оставлена: в ней изделий 1/.test(запись), запись);
db.close();

console.log('\n=== 3. Второй запуск ничего не трогает ===');
db = new DatabaseSync(БАЗА);
// Владелец потом сам завёл категорию — при следующем запуске она на месте.
db.prepare(`INSERT INTO categories (name, sort) VALUES ('Броши', 50)`).run();
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('заведённая потом владельцем категория не удалена', r.status === 0 && порядок(db).includes('Броши'), порядок(db).join(', '));
db.close();

console.log('\n=== 4. «Серьги» удалены раньше — заводим, пусеты переезжают в них ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'categories_trimmed'`).run();
db.prepare(`UPDATE products SET category_id = NULL WHERE category_id = (SELECT id FROM categories WHERE name = 'Серьги')`).run();
db.prepare(`DELETE FROM categories WHERE name = 'Серьги'`).run();
const пусеты = Number(db.prepare(`INSERT INTO categories (name, sort) VALUES ('Пусеты', 1)`).run().lastInsertRowid);
db.prepare(`INSERT INTO products (sku, name, category_id, created_at) VALUES ('П-3', 'Пусеты', ?, '2026-09-28T10:00:00Z')`).run(пусеты);
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('«Серьги» снова есть, пусеты в них', r.status === 0 && изделие(db, 'П-3').кат === 'Серьги' && !порядок(db).includes('Пусеты'),
  JSON.stringify(изделие(db, 'П-3')) + ' | ' + порядок(db).join(', '));
db.close();

console.log(`\nИтого: ${ok} ok, ${fail} fail`);
if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
process.exit(fail ? 1 : 0);
