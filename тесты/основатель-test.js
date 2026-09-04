'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Три роли: основатель, бухгалтер, продавцы.
 *
 * Разница между основателем и бухгалтером ровно одна: основатель видит, что
 * делают остальные — панель основателя и журнал действий. Всё прочее у них
 * общее: закупочные, прибыль, финансы, сотрудники. И эта одна разница
 * держится только на том, что бухгалтер не может дотянуться до учётной
 * записи основателя: сменить пароль, отключить, назначить основателем себя.
 * Иначе «кроме панели» было бы пожеланием, а не правилом.
 *
 * Поэтому здесь проверяется не «работает ли панель», а именно граница:
 * что бухгалтеру открыто всё, что основателю, что закрыто ровно панель
 * и журнал, и что учётная запись основателя ему не подвластна ни с какой
 * стороны. И отдельно — переезд старой базы с двумя ролями на три: это
 * единственный кусок, который выполняется на живой базе магазина один раз
 * и без права на ошибку.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const ROOT = path.join(__dirname, '..');
const РОЛИ = ['owner', 'accountant', 'seller'];

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : JSON.stringify(доп).slice(0, 300)); }
};

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async зов(метод, путь, тело) {
      const opts = { method: метод, headers: { Cookie: cookie } };
      if (тело !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(тело);
      }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

/*
 * Переезд старой базы.
 *
 * До этого обновления роль ограничивалась двумя словами, и ограничение
 * записано в самой таблице. Сменить его нельзя — таблицу нужно пересобрать,
 * а на неё ссылаются сеансы, устройства, журнал, чеки. Здесь воспроизводим
 * базу старого образца и запускаем систему поверх: администратор должен
 * стать основателем, продавец остаться продавцом, а всё, что на них
 * ссылалось, — остаться на месте.
 */
function миграция() {
  const dir = path.join(__dirname, '.вывод', 'миграция-ролей');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'старая.db');
  const env = { ...process.env, ASHER_DB: file, ASHER_MEDIA: path.join(dir, 'images') };
  const запуск = () => spawnSync(process.execPath, ['-e', "require('./src/db')"],
    { cwd: ROOT, env, encoding: 'utf8' });

  let r = запуск();
  check('свежая база создаётся', r.status === 0, r.stderr.slice(-300));

  // Откатываем users к двум ролям — ровно так, как таблица выглядела раньше.
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE users_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('admin','seller')),
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    INSERT INTO users_old (id, username, name, role, password_hash, salt, active, created_at)
      SELECT id, username, name, 'admin', password_hash, salt, active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_old RENAME TO users;
    INSERT INTO users (username, name, role, password_hash, salt, active, created_at)
      VALUES ('anna-old', 'Анна', 'seller', 'x', 'y', 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions (token, user_id, created_at, expires_at)
      VALUES ('tok', 2, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    INSERT INTO devices (user_id, device_key, code, name, approved, created_at, last_seen, last_ip)
      VALUES (1, 'k', 'ABCD', 'телефон', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '');
    INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at)
      VALUES (1, 'login', 'user', 1, 'admin', '2026-01-01T00:00:00.000Z');
    COMMIT;
  `);
  const схемаДо = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get().sql;
  db.close();
  check('база старого образца воспроизведена', /'admin','seller'/.test(схемаДо), схемаДо);

  r = запуск();
  check('система поднимается на старой базе', r.status === 0, r.stderr.slice(-400));

  const db2 = new DatabaseSync(file);
  const схема = db2.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get().sql;
  check('в таблице теперь три роли', /'owner','accountant','seller'/.test(схема), схема);
  const роли = db2.prepare('SELECT username, role FROM users ORDER BY id').all();
  check('администратор стал основателем', роли[0] && роли[0].role === 'owner', роли);
  check('продавец остался продавцом', роли[1] && роли[1].role === 'seller', роли);
  const счёт = т => Number(db2.prepare(`SELECT COUNT(*) AS c FROM ${т}`).get().c);
  check('сеанс, устройство и журнал остались привязаны',
    счёт('sessions') === 1 && счёт('devices') === 1 && счёт('audit_log') === 1,
    { sessions: счёт('sessions'), devices: счёт('devices'), audit: счёт('audit_log') });
  check('внешние ключи сходятся', db2.prepare('PRAGMA foreign_key_check').all().length === 0);
  // Нумерация не откатилась: следующий сотрудник получит номер больше прежних.
  const seq = db2.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get();
  check('счётчик номеров сохранён', seq && Number(seq.seq) >= 2, seq);
  db2.close();

  r = запуск();
  check('повторный запуск ничего не перестраивает и не падает', r.status === 0, r.stderr.slice(-300));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  console.log('=== 0. Старая база с двумя ролями переезжает на три ===');
  миграция();

  const основатель = сеанс();
  const бухгалтер = сеанс();
  const продавец = сеанс();
  if (!await основатель.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }

  console.log('\n=== 1. Прежний администратор — основатель ===');
  const me = await основатель.зов('GET', '/api/me');
  check('роль основателя', me.data.user.role === 'owner', me.data.user);
  const ownerId = me.data.user.id;
  const все = await основатель.зов('GET', '/api/users');
  check('роли «admin» в системе больше нет',
    все.data.items.every(u => РОЛИ.includes(u.role)), все.data.items.map(u => u.role));

  console.log('\n=== 2. Основатель заводит бухгалтера ===');
  const stamp = Date.now().toString(36);
  const логинБ = `buh${stamp}`;
  const созд = await основатель.зов('POST', '/api/users',
    { username: логинБ, name: 'Бухгалтер Тест', role: 'accountant', password: 'Schet-2026-ok' });
  check('бухгалтер создан', созд.status === 200, созд.data);
  check('бухгалтер вошёл', await бухгалтер.войти(логинБ, 'Schet-2026-ok'));
  const meБ = await бухгалтер.зов('GET', '/api/me');
  check('роль — бухгалтер', meБ.data.user.role === 'accountant', meБ.data.user);

  console.log('\n=== 3. Бухгалтеру открыто всё, что основателю ===');
  const открыто = [
    ['/api/finance', 'финансы'], ['/api/finance/pnl', 'прибыль'],
    ['/api/analytics/summary', 'аналитика'], ['/api/users', 'сотрудники'],
    ['/api/security/status', 'безопасность'], ['/api/devices', 'устройства'],
    ['/api/debts/suppliers', 'расчёты с поставщиками'], ['/api/receipts', 'приёмки'],
    ['/api/cash/counts', 'сверки кассы'], ['/api/sync/status', 'обмен с 1С'],
  ];
  for (const [p, что] of открыто) {
    const r = await бухгалтер.зов('GET', p);
    check(`${что}: открыто`, r.status === 200, r.status);
  }
  const товары = await бухгалтер.зов('GET', '/api/products?limit=5');
  check('закупочные цены видны',
    товары.data.items.length > 0 && товары.data.items.every(p => 'purchase_price' in p),
    товары.data.items[0]);
  const настройки = await бухгалтер.зов('GET', '/api/settings');
  check('курс закупки виден', 'usd_rate' in настройки.data, Object.keys(настройки.data));
  const правка = await бухгалтер.зов('PUT', '/api/settings', { store_phone: настройки.data.store_phone || '' });
  check('настройки магазина правит', правка.status === 200, правка.data);

  console.log('\n=== 4. …кроме панели основателя и журнала ===');
  const панельБ = await бухгалтер.зов('GET', '/api/team');
  check('панель закрыта', панельБ.status === 403, панельБ.status);
  check('и отказ объясняет, кому она открыта', /основател/i.test(панельБ.data && панельБ.data.error), панельБ.data);
  check('журнал закрыт', (await бухгалтер.зов('GET', '/api/audit')).status === 403);

  console.log('\n=== 5. Учётная запись основателя бухгалтеру не подвластна ===');
  const нельзя = async (что, ответ) => check(что, ответ.status === 403, ответ);
  await нельзя('сменить основателю имя', await бухгалтер.зов('PUT', `/api/users/${ownerId}`, { name: 'Чужое имя' }));
  await нельзя('сменить основателю пароль', await бухгалтер.зов('PUT', `/api/users/${ownerId}`, { password: 'Novyi-parol-99' }));
  await нельзя('отключить основателя', await бухгалтер.зов('PUT', `/api/users/${ownerId}`, { active: false }));
  await нельзя('завершить сеансы основателя', await бухгалтер.зов('POST', `/api/users/${ownerId}/logout-all`));
  await нельзя('завести второго основателя', await бухгалтер.зов('POST', '/api/users',
    { username: `own${stamp}`, name: 'Самозванец', role: 'owner', password: 'Samozvanec-1' }));
  await нельзя('назначить основателем себя', await бухгалтер.зов('PUT', `/api/users/${meБ.data.user.id}`, { role: 'owner' }));
  const снова = await основатель.зов('GET', '/api/me');
  check('основатель по-прежнему в системе и по-прежнему основатель',
    снова.status === 200 && снова.data.user.role === 'owner', снова);
  const имя = (await основатель.зов('GET', '/api/users')).data.items.find(u => u.id === ownerId).name;
  check('имя основателя не тронуто', имя !== 'Чужое имя', имя);
  check('бухгалтер всё ещё бухгалтер',
    (await бухгалтер.зов('GET', '/api/me')).data.user.role === 'accountant');

  console.log('\n=== 6. Продавцов бухгалтер заводит и правит свободно ===');
  const логинП = `prod${stamp}`;
  const созд2 = await бухгалтер.зов('POST', '/api/users',
    { username: логинП, name: 'Продавец Тест', role: 'seller', password: 'Prilavok-2026' });
  check('продавец создан бухгалтером', созд2.status === 200, созд2.data);
  check('бухгалтер меняет продавцу пароль',
    (await бухгалтер.зов('PUT', `/api/users/${созд2.data.id}`, { password: 'Prilavok-2027' })).status === 200);
  check('продавец вошёл новым паролем', await продавец.войти(логинП, 'Prilavok-2027'));
  check('продавцу панель закрыта', (await продавец.зов('GET', '/api/team')).status === 403);
  check('продавцу список сотрудников закрыт', (await продавец.зов('GET', '/api/users')).status === 403);
  check('продавцу финансы закрыты', (await продавец.зов('GET', '/api/finance')).status === 403);
  check('продавец не назначит себя бухгалтером',
    (await продавец.зов('PUT', `/api/users/${созд2.data.id}`, { role: 'accountant' })).status === 403);

  console.log('\n=== 7. Панель основателя видит, кто что сделал ===');
  const свободные = await продавец.зов('GET', '/api/products?status=in_stock&limit=100');
  const изделие = (свободные.data.items || []).find(p => p.retail_price > 0 && !p.set_id);
  check('нашлось изделие для продажи', Boolean(изделие), свободные.data && свободные.data.total);
  if (изделие) {
    const продажа = await продавец.зов('POST', '/api/sales',
      { items: [{ product_id: изделие.id }], payment_method: 'cash' });
    check('продавец продал', продажа.status === 200, продажа.data);
  }
  const панель = await основатель.зов('GET', '/api/team?days=1&tz=360');
  check('панель отвечает основателю', панель.status === 200, панель.data);
  const люди = панель.data.people || [];
  const б = люди.find(p => p.username === логинБ);
  const п = люди.find(p => p.username === логинП);
  check('бухгалтер в списке с ролью', б && б.role === 'accountant', б);
  check('продавец в списке с ролью', п && п.role === 'seller', п);
  check('у бухгалтера отмечен вход', б && б.last_login !== '' && б.period.logins >= 1, б && б.period);
  check('продажа посчитана продавцу, с суммой',
    изделие && п && п.period.sales >= 1 && п.period.revenue >= изделие.retail_price - 1, п && п.period);
  check('у бухгалтера продаж нет', б && б.period.sales === 0, б && б.period);
  check('в ленте видно, кто продал',
    (панель.data.feed || []).some(з => з.action === 'sale' && з.user_name === 'Продавец Тест'),
    (панель.data.feed || []).slice(0, 3));
  check('лента подписывает роли',
    панель.data.feed.every(з => !з.user_id || РОЛИ.includes(з.user_role)));
  check('итоги сходятся с людьми',
    панель.data.totals.sales === люди.reduce((s, p) => s + p.period.sales, 0), панель.data.totals);
  check('счёт по ролям', панель.data.roles.owner >= 1 && панель.data.roles.accountant >= 1
    && панель.data.roles.seller >= 1, панель.data.roles);
  check('период 30 дней отвечает', (await основатель.зов('GET', '/api/team?days=30')).status === 200);
  check('выдуманный период не ломает панель',
    (await основатель.зов('GET', '/api/team?days=999')).data.days === 1);

  console.log('\n=== 8. Незнакомый телефон продавца виден основателю сразу ===');
  /*
   * Это главное, ради чего панель: если пароль продавца узнал посторонний,
   * первое, что случится, — вход с незнакомого устройства. Он должен
   * оказаться в тревогах, а не в глубине журнала.
   */
  const чужой = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Asher-Device': 'chuzhoi-' + stamp },
    body: JSON.stringify({ username: логинП, password: 'Prilavok-2027' }),
  });
  const чужойОтвет = await чужой.json().catch(() => ({}));
  check('незнакомый телефон поставлен ждать', чужой.status !== 200 && чужойОтвет.pending_device === true, чужойОтвет);
  const панель2 = await основатель.зов('GET', '/api/team?days=1');
  const ждёт = (панель2.data.alerts.pending_devices || []).find(d => d.username === логинП);
  check('панель показывает его в тревогах', Boolean(ждёт), панель2.data.alerts);
  const п2 = панель2.data.people.find(p => p.username === логинП);
  check('и у самого продавца это отмечено', п2 && п2.pending_devices >= 1, п2);
  check('в ленте есть запись о незнакомом устройстве',
    панель2.data.feed.some(з => з.action === 'device_new' && з.user_name === 'Продавец Тест'));
  check('бухгалтер отклоняет чужое устройство продавца',
    ждёт && (await бухгалтер.зов('POST', `/api/devices/${ждёт.id}/deny`)).status === 200);

  console.log('\n=== 9. Устройства основателя — только руками основателя ===');
  const чужойОсн = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Asher-Device': 'chuzhoi-osn-' + stamp },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  check('незнакомое устройство под логином основателя ждёт', чужойОсн.status !== 200);
  const устройства = await бухгалтер.зов('GET', '/api/devices');
  const егоУстройство = (устройства.data.pending || []).find(d => d.username === 'admin');
  check('бухгалтер его видит', Boolean(егоУстройство), устройства.data.pending);
  check('но разрешить не может',
    егоУстройство && (await бухгалтер.зов('POST', `/api/devices/${егоУстройство.id}/approve`)).status === 403);
  check('и отклонить не может',
    егоУстройство && (await бухгалтер.зов('POST', `/api/devices/${егоУстройство.id}/deny`)).status === 403);
  check('основатель отклоняет сам',
    егоУстройство && (await основатель.зов('POST', `/api/devices/${егоУстройство.id}/deny`)).status === 200);

  console.log('\n=== 10. Последний основатель неприкосновенен ===');
  check('нельзя разжаловать себя, если ты единственный',
    (await основатель.зов('PUT', `/api/users/${ownerId}`, { role: 'accountant' })).status === 400);
  check('нельзя отключить себя, если ты единственный',
    (await основатель.зов('PUT', `/api/users/${ownerId}`, { active: false })).status === 400);
  check('основатель всё ещё основатель',
    (await основатель.зов('GET', '/api/me')).data.user.role === 'owner');

  console.log('\n=== 11. Второй основатель — только руками основателя ===');
  const второй = await основатель.зов('POST', '/api/users',
    { username: `own${stamp}`, name: 'Второй основатель', role: 'owner', password: 'Vtoroi-2026-x' });
  check('основатель заводит второго основателя', второй.status === 200, второй.data);
  check('бухгалтер и второго не трогает',
    (await бухгалтер.зов('PUT', `/api/users/${второй.data.id}`, { active: false })).status === 403);
  check('основатель отключает второго',
    (await основатель.зов('PUT', `/api/users/${второй.data.id}`, { active: false })).status === 200);

  // Уборка: заведённых отключаем, а не удаляем — как и в жизни.
  await основатель.зов('PUT', `/api/users/${созд.data.id}`, { active: false });
  await основатель.зов('PUT', `/api/users/${созд2.data.id}`, { active: false });
  check('отключённый бухгалтер в систему больше не попадает',
    (await бухгалтер.зов('GET', '/api/me')).status === 401);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
