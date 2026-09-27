'use strict';
/*
 * Категория «Буквенные подвески» появляется при обновлении — один раз и на месте.
 *
 * Именные подвески-буквы заводят в свою категорию, сразу после «Подвесок».
 * В базе магазина категории уже есть, поэтому новую добавляет обновление:
 * ровно одну, не сбивая порядок остальных. Удалил её владелец — не
 * возвращаем; завёл он свою («Подвески-буквы») — не дублируем. Новой базе
 * достаются и стандартные категории, и эта — с ними вместе.
 *
 * Своя база в тесты/.вывод/буквы: общий сервер здесь не нужен.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'буквы');
const БАЗА = path.join(РАБОТА, 'asher.db');
const БУКВЫ = 'Буквенные подвески';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};

const окружение = { ...process.env, ASHER_DB: БАЗА, ASHER_DATA: РАБОТА, NO_OPEN: '1' };
// Запуск системы = открыть базу: при этом один раз выполняются переделки старых баз.
const запустить = () => spawnSync(process.execPath, ['-e', "require('./src/db')"], { cwd: ROOT, env: окружение, encoding: 'utf8' });
const порядок = db => db.prepare('SELECT name FROM categories ORDER BY sort, name').all().map(c => c.name);
const сколько = db => db.prepare('SELECT COUNT(*) AS c FROM categories WHERE name = ?').get(БУКВЫ).c;

fs.rmSync(РАБОТА, { recursive: true, force: true });
fs.mkdirSync(РАБОТА, { recursive: true });

console.log('=== 1. Новая база: стандартные категории и буквы сразу после подвесок ===');
let r = запустить();
check('система запустилась', r.status === 0, r.stderr);
let db = new DatabaseSync(БАЗА);
const новая = порядок(db);
check('стандартные категории на месте', ['Кольца', 'Серьги', 'Подвески', 'Браслеты', 'Цепи'].every(к => новая.includes(к)), новая.join(', '));
check('«Буквенные подвески» — сразу после «Подвесок»', новая[новая.indexOf('Подвески') + 1] === БУКВЫ, новая.join(', '));
db.close();

console.log('\n=== 2. База магазина до обновления: категории свои, букв нет ===');
db = new DatabaseSync(БАЗА);
db.prepare('DELETE FROM categories WHERE name = ?').run(БУКВЫ);
db.prepare(`DELETE FROM settings WHERE key = 'added_letter_category'`).run();
// Порядок, как у магазина: свои номера, «Подвески» не третьи, и своя категория в конце.
const было = ['Кольца', 'Подвески', 'Серьги', 'Браслеты', 'Цепи', 'Колье', 'Броши', 'Часы', 'Комплекты', 'Пирсинг'];
db.prepare(`INSERT OR IGNORE INTO categories (name, sort) VALUES ('Пирсинг', 0)`).run();
было.forEach((к, i) => db.prepare('UPDATE categories SET sort = ? WHERE name = ?').run(i * 10, к));
db.close();
r = запустить();
check('обновление прошло', r.status === 0, r.stderr);
db = new DatabaseSync(БАЗА);
const стало = порядок(db);
check('«Буквенные подвески» — сразу после «Подвесок»', стало[стало.indexOf('Подвески') + 1] === БУКВЫ, стало.join(', '));
check('порядок остальных не сбит', JSON.stringify(стало.filter(к => к !== БУКВЫ)) === JSON.stringify(было), стало.join(', '));
check('ровно одна', сколько(db) === 1);
db.close();

console.log('\n=== 3. Второй запуск и удалённая владельцем — не возвращаем ===');
r = запустить();
db = new DatabaseSync(БАЗА);
check('второй запуск не дублирует', r.status === 0 && сколько(db) === 1);
db.prepare('DELETE FROM categories WHERE name = ?').run(БУКВЫ);
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('удалил владелец — не вернулась', r.status === 0 && сколько(db) === 0, сколько(db));
db.close();

console.log('\n=== 4. Своя категория букв уже есть — не дублируем ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'added_letter_category'`).run();
db.prepare(`INSERT INTO categories (name, sort) VALUES ('Подвески-буквы', 99)`).run();
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('«Подвески-буквы» есть — «Буквенные подвески» не заводим', r.status === 0 && сколько(db) === 0, порядок(db).join(', '));
db.close();

console.log('\n=== 5. Без «Подвесок» — в конец списка ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'added_letter_category'`).run();
db.prepare(`DELETE FROM categories WHERE name IN ('Подвески-буквы', 'Подвески')`).run();
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
const безПодвесок = порядок(db);
check('встала последней', r.status === 0 && безПодвесок[безПодвесок.length - 1] === БУКВЫ, безПодвесок.join(', '));
db.close();

console.log(`\nИтого: ${ok} ok, ${fail} fail`);
if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
process.exit(fail ? 1 : 0);
