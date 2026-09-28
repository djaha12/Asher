'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Дубли с прежних времён: найти, показать владельцу, дать исправить.
 *
 * Владелец: «Сейчас есть дубли?» Новых не завести — большие и маленькие
 * буквы система больше не различает. Но раньше «as-001» заводился рядом
 * с «AS-001», «азия голд» — рядом с «Азия Голд», и такие пары могли
 * остаться в базе магазина. Здесь такие пары заводятся прямо в базе, как
 * их завела бы прежняя версия, и проверяется:
 *
 *   — отчёт для обновления сервера считает их верно, пишет одни числа
 *     (журнал обновления виден всем) и базу не меняет ни на байт;
 *   — сбой проверки не роняет обновление;
 *   — владелец видит их на Главной поимённо, продавец — нет;
 *   — дубль можно править: раньше проверка повтора не давала поправить
 *     у такого поставщика даже телефон;
 *   — исправил всё — тревога уходит сама.
 *
 * Своя база и свой сервер в тесты/.вывод/дубли: чужие дубли в общей базе
 * всплыли бы на Главной в других проверках.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'дубли');
const БАЗА = path.join(РАБОТА, 'asher.db');
const ПОРТ = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 46;
const BASE = `http://127.0.0.1:${ПОРТ}`;

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};

const окружение = {
  ...process.env,
  ASHER_DB: БАЗА,
  ASHER_DATA: РАБОТА,
  ASHER_BACKUP_DIR: path.join(РАБОТА, 'копии'),
  PORT: String(ПОРТ),
  NO_OPEN: '1',
  NO_PROXY: '*', no_proxy: '*',
};

let сервер = null;
function живПорт() {
  return new Promise(res => {
    const s = net.connect(ПОРТ, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 300);
  });
}
async function поднять() {
  сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружение, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await живПорт()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
async function убить() {
  if (!сервер) return;
  const pid = сервер.pid;
  const вышел = new Promise(r => сервер.once('exit', r));
  try { process.kill(pid, 'SIGTERM'); } catch { /* уже мёртв */ }
  await Promise.race([вышел, new Promise(r => setTimeout(r, 5000))]);
  try { process.kill(pid, 'SIGKILL'); } catch { /* уже мёртв */ }
  for (let i = 0; i < 100 && await живПорт(); i++) await new Promise(r => setTimeout(r, 100));
  сервер = null;
}

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async зов(метод, путь, тело) {
      const r = await fetch(BASE + путь, {
        method: метод, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: тело === undefined ? undefined : JSON.stringify(тело),
      });
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

const отчёт = (база = БАЗА) => spawnSync(process.execPath, [path.join('src', 'двойники.js'), база],
  { cwd: ROOT, env: окружение, encoding: 'utf8' });
const отпечаток = () => crypto.createHash('sha256').update(fs.readFileSync(БАЗА)).digest('hex');
const тревогаДублей = async с => ((await с.зов('GET', '/api/dashboard?tz=360')).data['тревоги'] || [])
  .find(т => /^Дубли в базе/.test(т['что'] || ''));

async function main() {
  fs.rmSync(РАБОТА, { recursive: true, force: true });
  fs.mkdirSync(РАБОТА, { recursive: true });
  const seed = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'], { cwd: ROOT, env: окружение, encoding: 'utf8' });
  if (seed.status !== 0) { console.error('Не удалось наполнить базу:\n' + (seed.stderr || seed.stdout)); process.exit(2); }

  console.log('=== 1. В свежей базе дублей нет ===');
  let r = отчёт();
  check('отчёт: «Двойников нет»', r.status === 0 && /Двойников нет/.test(r.stdout), r.stdout + r.stderr);

  // Изделия и комплект заводим как обычно, а дубли — прямо в базе, как их завела бы прежняя версия.
  if (!await поднять()) { console.error('Сервер не поднялся'); process.exit(2); }
  let админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const завести = async (sku, name, retail_price) => (await админ.зов('POST', '/api/products', { sku, name, retail_price })).data.id;
  const и1 = await завести('ДУБ-1', 'Кольцо', 40000);
  const и2 = await завести('ДУБ-2', 'Серьги', 30000);
  const и3 = await завести('ДУБ-3', 'Подвеска', 20000);
  const комплект = (await админ.зов('POST', '/api/sets', { name: 'Гарнитур дублей', sku: 'КМП-7', price: 45000, product_ids: [и1, и2] })).data.id;
  check('изделия и комплект заведены', и1 && и2 && и3 && комплект, [и1, и2, и3, комплект]);
  check('без дублей тревоги нет', !(await тревогаДублей(админ)));
  await убить();

  const db = new DatabaseSync(БАЗА);
  db.prepare('UPDATE products SET sku = ? WHERE id = ?').run('дуб-1', и2);       // «дуб-1» рядом с «ДУБ-1»
  db.prepare('UPDATE products SET sku = ? WHERE id = ?').run('кмп-7', и3);       // изделие с артикулом комплекта
  const поставщик = n => Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(n).lastInsertRowid);
  поставщик('Дубль Голд');
  const п2 = поставщик('дубль голд');
  const п3 = поставщик('ДУБЛЬ ГОЛД ');                                            // пробел в конце — не разница
  поставщик('Дубль Голд Плюс');                                                  // другое название — не дубль
  const к2 = Number(db.prepare('INSERT INTO categories (name, sort) VALUES (?, 90), (?, 91)')
    .run('Дубль категория', 'ДУБЛЬ  КАТЕГОРИЯ').lastInsertRowid);   // и двойной пробел
  const т2 = Number(db.prepare(`INSERT INTO stores (name, address, is_default, sort) VALUES ('Центр-дубль', '', 0, 90), ('центр-дубль', '', 0, 91)`)
    .run().lastInsertRowid);
  db.close();

  console.log('\n=== 2. Отчёт для обновления: одни числа, база не тронута ===');
  const до = отпечаток();
  r = отчёт();
  check('отчёт отработал', r.status === 0, r.stderr);
  check('артикулов — 2 (записей 4)', /артикулы:\s+2 \(записей: 4\)/.test(r.stdout), r.stdout);
  check('поставщиков — 1 (записей 3): «Плюс» не в счёт', /поставщики:\s+1 \(записей: 3\)/.test(r.stdout), r.stdout);
  check('категорий — 1', /категории:\s+1 \(записей: 2\)/.test(r.stdout), r.stdout);
  check('точек — 1', /точки продаж:\s+1 \(записей: 2\)/.test(r.stdout), r.stdout);
  check('ни артикулов, ни названий в отчёте нет', !/дуб|кмп|центр|голд|кольцо|серьги/i.test(r.stdout), r.stdout);
  check('база не изменилась ни на байт', отпечаток() === до);
  check('рядом с базой ничего не появилось', !fs.existsSync(БАЗА + '-wal') || fs.statSync(БАЗА + '-wal').size === 0);

  console.log('\n=== 3. Шаг в обновлении сервера: сбой проверки обновление не роняет ===');
  const скрипт = fs.readFileSync(path.join(ROOT, 'ОБНОВИТЬ-НА-СЕРВЕРЕ.sh'), 'utf8');
  const шаг = (скрипт.match(/\nif \[ -f "\$APP_DIR\/src\/двойники\.js" \]; then\n[\s\S]*?\nfi\n/) || [''])[0];
  check('шаг есть в скрипте обновления', Boolean(шаг));
  // sudo и say — подменой: здесь не сервер. Строгий режим — как в самом скрипте.
  const выполнить = папка => spawnSync('bash', ['-c', `set -euo pipefail
    sudo() { shift 2; "$@"; }
    say() { printf '%s\\n' "$1"; }
    APP_DIR=${JSON.stringify(папка)}; APP_USER=asher
    ${шаг}
    echo КОНЕЦ`], { encoding: 'utf8', env: окружение });
  const папка = path.join(РАБОТА, 'app');
  fs.mkdirSync(path.join(папка, 'src'), { recursive: true });
  fs.mkdirSync(path.join(папка, 'data'), { recursive: true });
  for (const ф of ['двойники.js', 'поиск.js']) fs.copyFileSync(path.join(ROOT, 'src', ф), path.join(папка, 'src', ф));
  fs.copyFileSync(БАЗА, path.join(папка, 'data', 'asher.db'));
  r = выполнить(папка);
  check('на сервере печатает числа', r.status === 0 && /поставщики:\s+1/.test(r.stdout) && /КОНЕЦ/.test(r.stdout), r.stdout + r.stderr);
  fs.rmSync(path.join(папка, 'data', 'asher.db'));
  fs.writeFileSync(path.join(папка, 'data', 'asher.db'), 'не база');
  r = выполнить(папка);
  check('база не читается — «проверить не удалось», а обновление идёт дальше',
    r.status === 0 && /проверить не удалось|Проверить не удалось/.test(r.stdout) && /КОНЕЦ/.test(r.stdout), r.stdout + r.stderr);
  fs.rmSync(path.join(папка, 'src', 'двойники.js'));
  r = выполнить(папка);
  check('старая версия без проверки — шаг молча пропущен', r.status === 0 && r.stdout.trim() === 'КОНЕЦ', r.stdout + r.stderr);

  console.log('\n=== 4. Владелец видит дубли на Главной поимённо, продавец — нет ===');
  if (!await поднять()) { console.error('Сервер не поднялся'); process.exit(2); }
  админ = сеанс();
  await админ.войти('admin', 'admin123');
  let т = await тревогаДублей(админ);
  check('тревога есть: 5 дублей', т && т['что'] === 'Дубли в базе: 5', т && т['что']);
  const почему = (т && т['почему']) || '';
  check('названы артикулы и чьи они', почему.includes('артикул «ДУБ-1» (Кольцо) и «дуб-1» (Серьги)'), почему);
  check('комплект с изделием — тоже', почему.includes('артикул «КМП-7» (комплект «Гарнитур дублей») и «кмп-7» (Подвеска)')
    || почему.includes('артикул «кмп-7» (Подвеска) и «КМП-7» (комплект «Гарнитур дублей»)'), почему);
  check('поставщик, категория, точка', почему.includes('поставщик «Дубль Голд», «дубль голд» и «ДУБЛЬ ГОЛД »')
    && почему.includes('категория «Дубль категория» и «ДУБЛЬ  КАТЕГОРИЯ»') && почему.includes('точка «Центр-дубль» и «центр-дубль»'), почему);
  check('«Дубль Голд Плюс» не назван', !почему.includes('Плюс'), почему);
  check('сказано, что делать', /удалите или переименуйте/.test(т && т['делать']), т && т['делать']);
  const продавец = сеанс();
  await продавец.войти('anna', 'seller123');
  const глП = (await продавец.зов('GET', '/api/dashboard?tz=360')).data;
  check('у продавца — ни тревоги, ни названий', !глП['тревоги'] && !JSON.stringify(глП).includes('ДУБЛЬ'), JSON.stringify(глП['тревоги'] || ''));

  console.log('\n=== 5. Дубль можно править ===');
  r = await админ.зов('PUT', '/api/suppliers/' + п2, { name: 'дубль голд', phone: '0555 123 456' });
  check('у поставщика-дубля поправили телефон', r.status === 200, JSON.stringify(r.data));
  r = await админ.зов('PUT', '/api/suppliers/' + п2, { name: 'Дубль голд' });
  check('переименовать в занятое (другими буквами) — по-прежнему нельзя', r.status === 400 && /уже есть/.test(r.data.error), JSON.stringify(r.data));
  // Окно поставщика присылает и название — как записано, с пробелом в конце.
  r = await админ.зов('PUT', '/api/suppliers/' + п3, { name: 'ДУБЛЬ ГОЛД ', phone: '0700 000 001' });
  check('у дубля с пробелом в конце — тоже', r.status === 200, JSON.stringify(r.data));
  r = await админ.зов('PUT', '/api/stores/' + т2, { name: 'центр-дубль', address: 'ул. Киевская, 1' });
  check('у точки-дубля поправили адрес', r.status === 200, JSON.stringify(r.data));
  r = await админ.зов('PUT', '/api/sets/' + комплект, { price: 44000 });
  check('у комплекта с занятым артикулом поправили цену', r.status === 200, JSON.stringify(r.data));
  r = await админ.зов('PUT', '/api/products/' + и2, { sku: 'дуб-1', weight: 3.5 });
  check('у изделия-дубля поправили вес', r.status === 200 && (await админ.зов('GET', '/api/products/' + и2)).data.weight === 3.5, JSON.stringify(r.data));

  console.log('\n=== 6. Исправили всё — тревога уходит сама ===');
  r = await админ.зов('PUT', '/api/suppliers/' + п2, { name: 'Дубль Голд (старый)' });
  const r3 = await админ.зов('PUT', '/api/suppliers/' + п3, { name: 'Дубль Голд (третий)' });
  check('поставщиков переименовали', r.status === 200 && r3.status === 200, JSON.stringify([r.data, r3.data]));
  т = await тревогаДублей(админ);
  check('дублей стало 4', т && т['что'] === 'Дубли в базе: 4', т && т['что']);
  check('поставщик из списка ушёл', т && !т['почему'].includes('поставщик'), т && т['почему']);
  const исправления = [
    ['PUT', '/api/products/' + и2, { sku: 'ДУБ-1-2' }],
    ['PUT', '/api/sets/' + комплект, { sku: 'КМП-8' }],
    ['DELETE', '/api/categories/' + к2],
    ['PUT', '/api/stores/' + т2, { name: 'Центр-дубль 2' }],
  ];
  for (const [метод, путь, тело] of исправления) {
    r = await админ.зов(метод, путь, тело);
    check(`${метод} ${путь} — прошло`, r.status === 200, JSON.stringify(r.data));
  }
  check('дублей нет — тревоги нет', !(await тревогаДублей(админ)));
  await убить();
  r = отчёт();
  check('и отчёт: «Двойников нет»', r.status === 0 && /Двойников нет/.test(r.stdout), r.stdout);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(async e => { console.error(e); await убить(); process.exit(2); });
