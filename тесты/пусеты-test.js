'use strict';
/*
 * Категория «Пусеты» появляется при обновлении — один раз и на месте.
 *
 * Владелец: «добавь в категорию пусеты». Пусеты — серьги-гвоздики, их место
 * сразу после «Серёг». В базе магазина категории уже есть, поэтому новую
 * добавляет обновление: ровно одну, не сбивая порядок остальных. Удалил её
 * владелец — не возвращаем; завёл он свою («серьги-пусеты») — не дублируем.
 * Новой базе она достаётся вместе со стандартными категориями.
 *
 * Своя база в тесты/.вывод/пусеты: общий сервер здесь не нужен.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'пусеты');
const БАЗА = path.join(РАБОТА, 'asher.db');
const ПУСЕТЫ = 'Пусеты';

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
const сколько = db => db.prepare('SELECT COUNT(*) AS c FROM categories WHERE name = ?').get(ПУСЕТЫ).c;
const после = (список, кого) => список[список.indexOf(кого) + 1];

fs.rmSync(РАБОТА, { recursive: true, force: true });
fs.mkdirSync(РАБОТА, { recursive: true });

console.log('=== 1. Новая база: стандартные категории и пусеты сразу после серёг ===');
let r = запустить();
check('система запустилась', r.status === 0, r.stderr);
let db = new DatabaseSync(БАЗА);
const новая = порядок(db);
check('стандартные категории на месте', ['Кольца', 'Серьги', 'Подвески', 'Браслеты', 'Цепи'].every(к => новая.includes(к)), новая.join(', '));
check('«Пусеты» — сразу после «Серёг»', после(новая, 'Серьги') === ПУСЕТЫ, новая.join(', '));
check('«Буквенные подвески» — по-прежнему сразу после «Подвесок»', после(новая, 'Подвески') === 'Буквенные подвески', новая.join(', '));
db.close();

console.log('\n=== 2. База магазина до обновления: категории свои, пусет нет ===');
db = new DatabaseSync(БАЗА);
db.prepare('DELETE FROM categories WHERE name = ?').run(ПУСЕТЫ);
db.prepare(`DELETE FROM settings WHERE key = 'added_studs_category'`).run();
// Порядок, как у магазина: свои номера, «Серьги» не вторые, и своя категория в конце.
const было = ['Кольца', 'Подвески', 'Буквенные подвески', 'Серьги', 'Браслеты', 'Цепи', 'Колье', 'Броши', 'Часы', 'Комплекты', 'Пирсинг'];
db.prepare(`INSERT OR IGNORE INTO categories (name, sort) VALUES ('Пирсинг', 0)`).run();
было.forEach((к, i) => db.prepare('UPDATE categories SET sort = ? WHERE name = ?').run(i * 10, к));
db.close();
r = запустить();
check('обновление прошло', r.status === 0, r.stderr);
db = new DatabaseSync(БАЗА);
const стало = порядок(db);
check('«Пусеты» — сразу после «Серёг»', после(стало, 'Серьги') === ПУСЕТЫ, стало.join(', '));
check('порядок остальных не сбит', JSON.stringify(стало.filter(к => к !== ПУСЕТЫ)) === JSON.stringify(было), стало.join(', '));
check('ровно одна', сколько(db) === 1);
db.close();

console.log('\n=== 3. Второй запуск и удалённая владельцем — не возвращаем ===');
r = запустить();
db = new DatabaseSync(БАЗА);
check('второй запуск не дублирует', r.status === 0 && сколько(db) === 1);
db.prepare('DELETE FROM categories WHERE name = ?').run(ПУСЕТЫ);
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('удалил владелец — не вернулась', r.status === 0 && сколько(db) === 0, сколько(db));
db.close();

console.log('\n=== 4. Своя категория пусет уже есть — не дублируем ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'added_studs_category'`).run();
db.prepare(`INSERT INTO categories (name, sort) VALUES ('серьги-ПУСЕТЫ', 99)`).run();
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('«серьги-ПУСЕТЫ» есть (другими буквами) — «Пусеты» не заводим', r.status === 0 && сколько(db) === 0, порядок(db).join(', '));
db.close();

console.log('\n=== 5. Без «Серёг» — в конец списка ===');
db = new DatabaseSync(БАЗА);
db.prepare(`DELETE FROM settings WHERE key = 'added_studs_category'`).run();
db.prepare(`DELETE FROM categories WHERE name IN ('серьги-ПУСЕТЫ', 'Серьги')`).run();
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
const безСерёг = порядок(db);
check('встала последней', r.status === 0 && безСерёг[безСерёг.length - 1] === ПУСЕТЫ, безСерёг.join(', '));
db.close();

console.log(`\nИтого: ${ok} ok, ${fail} fail`);
if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
process.exit(fail ? 1 : 0);
