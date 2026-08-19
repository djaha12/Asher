'use strict';
/*
 * Память: переживают ли данные выключение.
 *
 * Владелец спросил прямо: «а память будет сохраняться?» Ответ должен быть
 * не рассуждением, а проверкой, потому что способов выключить систему у живого
 * магазина ровно один — закрыть чёрное окно крестиком или выдернуть питание.
 * Ни в том, ни в другом случае у программы нет ни секунды на «сохранить».
 *
 * Здесь мы убиваем систему самым грубым способом (kill -9, то есть без всякого
 * предупреждения) прямо посреди работы и смотрим, что осталось:
 *   — все подтверждённые операции на месте;
 *   — ни одной полу-операции (чек без позиций, деньги без чека);
 *   — деньги сходятся до копейки;
 *   — фотографии не пропали.
 *
 * И отдельно — самое коварное: убиваем В МОМЕНТ записи, когда часть данных
 * ещё в пути.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'память');
const БАЗА = path.join(РАБОТА, 'asher.db');
const ПОРТ = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 44;
const BASE = `http://127.0.0.1:${ПОРТ}`;

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};

const окружение = {
  ...process.env,
  ASHER_DB: БАЗА,
  ASHER_DATA: РАБОТА,
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

/*
 * Именно kill -9, а не вежливая просьба завершиться. Вежливую программа могла
 * бы перехватить и аккуратно закрыть базу — но в жизни этого не происходит:
 * крестик на чёрном окне и пропавшее питание не спрашивают.
 */
async function убить() {
  if (!сервер) return;
  try { process.kill(сервер.pid, 'SIGKILL'); } catch { /* уже мёртв */ }
  for (let i = 0; i < 100 && await живПорт(); i++) await new Promise(r => setTimeout(r, 100));
  сервер = null;
}

let cookie = '';
async function вход() {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return r.status === 200;
}

async function зов(метод, путь, тело) {
  const opts = { method: метод, headers: { Cookie: cookie } };
  if (тело !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(тело);
  }
  const r = await fetch(BASE + путь, opts);
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

// Целостность денег: то же, что владелец увидит на «Главной» и в «Долгах».
async function снимок() {
  const продажи = (await зов('GET', '/api/sales?limit=500')).data;
  const склад = (await зов('GET', '/api/products?limit=1000')).data;
  const долги = (await зов('GET', '/api/debts/summary')).data;
  const список = продажи.items || продажи;
  const изделия = склад.items || склад;
  return {
    чеков: список.length,
    выручка: Math.round(список.reduce((s, x) => s + Number(x.total || 0), 0) * 100) / 100,
    получено: Math.round(список.reduce((s, x) => s + Number(x.paid || 0), 0) * 100) / 100,
    изделий: изделия.length,
    продано: изделия.filter(p => p.status === 'sold').length,
    долгКлиентов: долги && долги.customers_owe,
  };
}

async function main() {
  fs.rmSync(РАБОТА, { recursive: true, force: true });
  fs.mkdirSync(РАБОТА, { recursive: true });

  console.log('Готовлю отдельную базу…');
  const seed = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'],
    { cwd: ROOT, env: окружение, encoding: 'utf8' });
  if (seed.status !== 0) {
    console.error('Не удалось наполнить базу:\n' + (seed.stderr || seed.stdout));
    process.exit(2);
  }

  if (!await поднять()) { console.error('Сервер не поднялся'); process.exit(2); }
  if (!await вход()) { console.error('Не удалось войти'); process.exit(2); }

  console.log('\n=== 1. Работа магазина: продажи, оплаты, фото ===');
  const склад = (await зов('GET', '/api/products?status=in_stock&limit=20')).data;
  const вналичии = (склад.items || склад).filter(p => p.status === 'in_stock');
  check('в базе есть изделия для продажи', вналичии.length >= 6, вналичии.length);

  const клиенты = (await зов('GET', '/api/customers?limit=5')).data;
  const клиент = (клиенты.items || клиенты)[0];
  check('есть клиент', Boolean(клиент));

  const чеки = [];
  for (let i = 0; i < 4; i++) {
    const p = вналичии[i];
    // Каждый второй — в долг: так проверяются сразу и касса, и долги.
    const вДолг = i % 2 === 1;
    const r = await зов('POST', '/api/sales', {
      customer_id: вДолг ? клиент.id : null,
      items: [{ product_id: p.id, discount: 0 }],
      payment_method: 'cash',
      ...(вДолг ? { paid: Math.round(p.retail_price / 2) } : {}),
    });
    if (r.status === 200) чеки.push(r.data);
  }
  check('четыре чека пробиты', чеки.length === 4, чеки.length);

  // Фотография: отдельный файл на диске, а не строка в базе.
  const однопиксельныйPNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const фото = await зов('POST', `/api/products/${вналичии[5].id}/images`, {
    name: 'проверка.png', data: 'data:image/png;base64,' + однопиксельныйPNG.toString('base64'),
  });
  check('фотография загружена', фото.status === 200, фото.data);

  const до = await снимок();
  console.log(`     чеков: ${до.чеков}, выручка: ${до.выручка}, долг клиентов: ${до.долгКлиентов}`);

  console.log('\n=== 2. Выключение крестиком (kill -9) ===');
  await убить();
  check('система остановлена без предупреждения', сервер === null);
  const остались = fs.readdirSync(РАБОТА).filter(f => /^asher\.db/.test(f));
  console.log('     файлы рядом с базой:', остались.join(', '));

  if (!await поднять()) { console.error('Сервер не поднялся после убийства'); process.exit(2); }
  if (!await вход()) { console.error('Не удалось войти после перезапуска'); process.exit(2); }

  const после = await снимок();
  check('все чеки на месте', после.чеков === до.чеков, `${после.чеков} вместо ${до.чеков}`);
  check('выручка не изменилась', после.выручка === до.выручка, `${после.выручка} вместо ${до.выручка}`);
  check('полученные деньги не изменились', после.получено === до.получено, `${после.получено} вместо ${до.получено}`);
  check('долг клиентов не изменился', после.долгКлиентов === до.долгКлиентов,
    `${после.долгКлиентов} вместо ${до.долгКлиентов}`);
  check('проданные изделия остались проданными', после.продано === до.продано,
    `${после.продано} вместо ${до.продано}`);

  const карточка = (await зов('GET', `/api/products/${вналичии[5].id}`)).data;
  check('фотография пережила выключение', (карточка.images || []).length > 0, карточка.images);
  const путьФото = (карточка.images || [])[0];
  if (путьФото) {
    const файл = path.join(РАБОТА, 'images', String(вналичии[5].id));
    check('файл фотографии лежит на диске', fs.existsSync(файл) && fs.readdirSync(файл).length > 0);
  }

  console.log('\n=== 3. Убийство ПРЯМО ВО ВРЕМЯ записи ===');
  /*
   * Самый неприятный случай: питание пропало в ту секунду, когда продавец
   * нажал «Продать». Половина операции записана, половина нет. База обязана
   * либо принять её целиком, либо не принять вовсе — но никогда не оставить
   * чек без позиций или деньги без чека.
   */
  const доГонки = await снимок();
  const свободные = (await зов('GET', '/api/products?status=in_stock&limit=40')).data;
  const кПродаже = (свободные.items || свободные).filter(p => p.status === 'in_stock').slice(0, 40);

  const запросы = кПродаже.map(p => зов('POST', '/api/sales', {
    items: [{ product_id: p.id, discount: 0 }], payment_method: 'cash',
  }).catch(() => ({ status: 0 })));

  // Убиваем сразу, не дав ответить: только так часть чеков окажется
  // недописанной. С паузой сервер успевает всё, и проверка ничего не значит.
  await убить();
  const ответы = await Promise.all(запросы);
  const успели = ответы.filter(r => r.status === 200).length;
  console.log(`     из ${кПродаже.length} чеков сервер успел подтвердить ${успели}, остальные оборвались`);
  check('убийство застало запись на полпути (часть чеков оборвана)',
    успели < кПродаже.length, `подтверждено все ${успели} — проверка ничего не значит`);

  if (!await поднять()) { console.error('Сервер не поднялся после убийства в записи'); process.exit(2); }
  if (!await вход()) { console.error('Не удалось войти'); process.exit(2); }

  const послеГонки = await снимок();
  check('подтверждённые чеки все на месте',
    послеГонки.чеков >= доГонки.чеков + успели,
    `${послеГонки.чеков}, было ${доГонки.чеков}, подтверждено ${успели}`);

  // Ни одной полу-операции: это и есть главное обещание базы.
  const всеЧеки = ((await зов('GET', '/api/sales?limit=500')).data.items || []);
  let битых = 0;
  for (const ч of всеЧеки.slice(0, 40)) {
    const д = (await зов('GET', `/api/sales/${ч.id}`)).data;
    const позиций = (д.items || []).length;
    const сумма = Math.round((д.items || []).reduce((s, x) => s + Number(x.final_price || 0), 0) * 100) / 100;
    if (позиций === 0 || Math.abs(сумма - Number(д.total || 0)) > 0.01) битых++;
  }
  check('нет чеков без позиций и с несходящейся суммой', битых === 0, битых + ' битых');

  console.log('\n=== 4. Десять выключений подряд ===');
  /*
   * Одно удачное выключение — случайность. Магазин выключают каждый вечер,
   * поэтому проверяем то же самое десять раз подряд: база не должна
   * «изнашиваться».
   */
  let сорвалось = 0;
  for (let i = 0; i < 10; i++) {
    const p = ((await зов('GET', '/api/products?status=in_stock&limit=5')).data.items || [])
      .find(x => x.status === 'in_stock');
    if (p) await зов('POST', '/api/sales', { items: [{ product_id: p.id, discount: 0 }], payment_method: 'cash' });
    const было = await снимок();
    await убить();
    if (!await поднять() || !await вход()) { сорвалось++; continue; }
    const стало = await снимок();
    if (стало.чеков !== было.чеков || стало.выручка !== было.выручка) сорвалось++;
  }
  check('десять выключений подряд — ничего не потеряно', сорвалось === 0, сорвалось + ' сорвалось');

  console.log('\n=== 5. Что видит продавец, если система выключена ===');
  await убить();
  let ошибка = '';
  try { await fetch(BASE + '/api/products?limit=1', { headers: { Cookie: cookie } }); }
  catch (e) { ошибка = e.message; }
  check('запрос к выключенной системе не проходит молча', Boolean(ошибка), ошибка);
  // Текст для человека проверяем в самом приложении, а не здесь.
  const клиентJS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
  check('приложение объясняет обрыв по-человечески',
    /Нет связи с системой/.test(клиентJS) && /СТАРТ/.test(клиентJS));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); убить(); process.exit(2); });
