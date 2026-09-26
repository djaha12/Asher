'use strict';
/*
 * Цены-заглушки стираются один раз — при обновлении.
 *
 * Пока форма требовала цену, изделия заводили с ценой 1 сом: иначе карточка
 * не сохранялась. Касса продала бы такое изделие за 1 сом, «Не заполнены» его
 * не видели, а склад на Главной показывал 64 сома за 119 изделий. Обновление
 * стирает цены меньше 100 сом у изделий на витрине и в резерве — ровно один
 * раз. Проданное не трогается, настоящие цены — тоже, и цена, вписанная после
 * обновления, остаётся как есть.
 *
 * Своя база в тесты/.вывод/заглушки: общий сервер здесь не нужен, а базу
 * других наборов трогать нельзя.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'заглушки');
const БАЗА = path.join(РАБОТА, 'asher.db');

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};

const окружение = { ...process.env, ASHER_DB: БАЗА, ASHER_DATA: РАБОТА, NO_OPEN: '1' };
// Запуск системы = открыть базу: при этом один раз выполняются переделки старых баз.
const запустить = () => spawnSync(process.execPath, ['-e', "require('./src/db')"], { cwd: ROOT, env: окружение, encoding: 'utf8' });

fs.rmSync(РАБОТА, { recursive: true, force: true });
fs.mkdirSync(РАБОТА, { recursive: true });
const посев = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'], { cwd: ROOT, env: окружение, encoding: 'utf8' });
if (посев.status !== 0) { console.error('Не удалось наполнить базу:\n' + посев.stderr); process.exit(2); }

// База «как у магазина до обновления»: заглушки уже стоят, отметки о чистке нет.
let db = new DatabaseSync(БАЗА);
const взять = (статус, n) => db.prepare(`SELECT id FROM products WHERE status = ? ORDER BY id LIMIT ?`).all(статус, n).map(r => r.id);
const [рубль, двойка, девяностоДевять, настоящая] = взять('in_stock', 4);
const цена = (id, р) => db.prepare('UPDATE products SET retail_price = ? WHERE id = ?').run(р, id);
цена(рубль, 1); цена(двойка, 2); цена(девяностоДевять, 99); цена(настоящая, 100);
const [отложено] = db.prepare(`SELECT id FROM products WHERE status = 'in_stock' ORDER BY id DESC LIMIT 1`).all().map(r => r.id);
db.prepare(`UPDATE products SET status = 'reserved', retail_price = 5 WHERE id = ?`).run(отложено);
const [продано] = взять('sold', 1);
if (продано) цена(продано, 1);
db.prepare(`DELETE FROM settings WHERE key = 'migrated_placeholder_prices'`).run();
db.close();

console.log('=== 1. Обновление стирает заглушки ===');
let r = запустить();
check('система запустилась', r.status === 0, r.stderr);
db = new DatabaseSync(БАЗА);
const сейчас = id => db.prepare('SELECT retail_price AS p FROM products WHERE id = ?').get(id).p;
check('1 сом → цена не указана', сейчас(рубль) === 0, сейчас(рубль));
check('2 сома → цена не указана', сейчас(двойка) === 0, сейчас(двойка));
check('99 сомов → цена не указана', сейчас(девяностоДевять) === 0, сейчас(девяностоДевять));
check('в резерве 5 сомов → тоже стёрто', сейчас(отложено) === 0, сейчас(отложено));
check('100 сомов — настоящая цена, осталась', сейчас(настоящая) === 100, сейчас(настоящая));
if (продано) check('проданное не тронуто — его цена уже в чеке', сейчас(продано) === 1, сейчас(продано));
const демо = db.prepare(`SELECT COUNT(*) AS c FROM products WHERE retail_price >= 100`).get().c;
check('настоящие цены демо-каталога на месте', демо > 100, демо);
const запись = db.prepare(`SELECT details FROM audit_log WHERE details LIKE 'Цены-заглушки%' ORDER BY id DESC LIMIT 1`).get();
check('в журнале — сколько стёрто', запись && /изделий: 4\b/.test(запись.details), запись && запись.details);
db.close();

console.log('\n=== 2. Только один раз ===');
db = new DatabaseSync(БАЗА);
цена(рубль, 1);   // вписали после обновления — это уже решение человека
db.close();
r = запустить();
db = new DatabaseSync(БАЗА);
check('второй запуск ничего не стирает', r.status === 0 && сейчас(рубль) === 1, сейчас(рубль));
check('и в журнал второй раз не пишет',
  db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE details LIKE 'Цены-заглушки%'`).get().c === 1);
db.close();

console.log(`\nИтого: ${ok} ok, ${fail} fail`);
if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
process.exit(fail ? 1 : 0);
