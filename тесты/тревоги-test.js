'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Тревоги: узнает ли владелец, что копии перестали делаться.
 *
 * Резервные копии — единственное, что стоит между магазином и потерей всего.
 * При этом ломаются они тихо: кончилось место, сменились права на папку,
 * отвалился диск. Раньше о сбое знала одна строка в чёрном окне, куда никто
 * не смотрит, — а на сервере она вообще уходит в системный журнал. Копии могли
 * не делаться месяцами, и выяснилось бы это в тот единственный день, когда
 * копия понадобилась.
 *
 * Здесь проверяется, что сбой доходит до человека: на Главную, куда владелец
 * заходит каждое утро, и на страницу «Безопасность», где написано подробно.
 * И отдельно — что продавца этим не пугают: сделать он с этим ничего не может.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'тревоги');
const БАЗА = path.join(РАБОТА, 'asher.db');
const КОПИИ = path.join(РАБОТА, 'копии');
// Сломанный путь: «папка» внутри обычного файла. Создать её нельзя ни при каких
// правах, в том числе от root, — то есть копия падает по-настоящему, а не
// потому, что мы подделали запись в базе.
const ЗАГЛУШКА = path.join(РАБОТА, 'диск-отвалился');
const КОПИИ_СЛОМАНЫ = path.join(ЗАГЛУШКА, 'копии');
const ПОРТ = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 45;
const BASE = `http://127.0.0.1:${ПОРТ}`;

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};

const окружение = {
  ...process.env,
  ASHER_DB: БАЗА,
  ASHER_DATA: РАБОТА,
  ASHER_BACKUP_DIR: КОПИИ,
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

async function поднять(кудаКопии) {
  const env = { ...окружение, ASHER_BACKUP_DIR: кудаКопии || КОПИИ };
  сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await живПорт()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function убить() {
  if (!сервер) return;
  try { process.kill(сервер.pid, 'SIGKILL'); } catch { /* уже мёртв */ }
  for (let i = 0; i < 100 && await живПорт(); i++) await new Promise(r => setTimeout(r, 100));
  сервер = null;
}

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        // Отметка устройства уходит заголовком, а в заголовке допустима только
        // латиница: кириллица роняет сам запрос, ещё до отправки.
        headers: {
          'Content-Type': 'application/json',
          'X-Asher-Device': 'alerts-test-' + логин,
        },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async взять(путь) {
      const r = await fetch(BASE + путь, { headers: { Cookie: cookie } });
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

// Прямая правка настроек в базе: так же, как их испортила бы сама жизнь.
function записатьНастройку(ключ, значение) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(БАЗА);
  d.prepare(`INSERT INTO settings (key, value) VALUES (?,?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(ключ, значение);
  d.close();
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
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }

  console.log('\n=== 1. Когда всё хорошо, тревог нет ===');
  // Свежая база: копия только что не делалась, но и сбоя нет.
  const st0 = (await админ.взять('/api/security/status')).data;
  check('состояние копий отдаётся', st0 && 'backup_error' in st0, Object.keys(st0 || {}).join(','));
  check('ошибки копий нет', st0.backup_error === '', st0.backup_error);
  check('место на диске измеряется', typeof st0.disk_free_mb === 'number' || st0.disk_free_mb === null,
    st0.disk_free_mb);
  check('места хватает', st0.disk_low === false, st0.disk_free_mb);

  console.log('\n=== 2. Копии сломались — владелец узнаёт ===');
  /*
   * Ломаем по-настоящему: подсовываем системе путь для копий, который создать
   * невозможно. Так же это выглядит, когда отвалился диск или сменились права
   * на папку, — и именно этот путь в коде должен сработать, а не наша подделка.
   */
  await убить();
  fs.writeFileSync(ЗАГЛУШКА, 'это файл, а не папка');
  // Копия «была» трое суток назад: система попробует сделать свежую и не сможет.
  записатьНастройку('last_backup', new Date(Date.now() - 72 * 3600 * 1000).toISOString());
  if (!await поднять(КОПИИ_СЛОМАНЫ)) { console.error('Сервер не поднялся'); process.exit(2); }
  const админ2 = сеанс();
  await админ2.войти('admin', 'admin123');

  const st = (await админ2.взять('/api/security/status')).data;
  check('сбой копии записан', Boolean(st.backup_error), st.backup_error);
  check('и копия при этом числится устаревшей', st.backup_stale === true, st);
  check('посчитано, сколько часов назад была последняя', st.backup_hours_ago >= 71, st.backup_hours_ago);

  const гл = (await админ2.взять('/api/dashboard?tz=360')).data;
  const тревоги = гл['тревоги'] || [];
  check('на Главной появилась тревога', тревоги.length > 0, JSON.stringify(тревоги).slice(0, 150));
  const проКопии = тревоги.find(т => /копии/i.test(т['что'] || ''));
  check('тревога именно про копии', Boolean(проКопии), тревоги.map(т => т['что']));
  check('уровень «плохо», а не «внимание»', проКопии && проКопии['уровень'] === 'плохо', проКопии);
  check('сказано, что делать', содержитСлово(проКопии, 'Безопасность'), проКопии && проКопии['делать']);
  check('названа настоящая причина', /ENOTDIR|не удалось|NOTDIR|ошибк|EEXIST|not a directory/i
    .test((проКопии || {})['почему'] || ''), проКопии && проКопии['почему']);

  console.log('\n=== 3. Сбой попал в журнал действий ===');
  const журнал = (await админ2.взять('/api/audit?action=backup_failed&limit=5')).data;
  check('в журнале есть запись о сбое копии', ((журнал || {}).items || []).length > 0,
    JSON.stringify((журнал || {}).items || []).slice(0, 150));

  console.log('\n=== 4. Продавца этим не пугают ===');
  const продавец = сеанс();
  check('продавец вошёл', await продавец.войти('anna', 'seller123'));
  const глП = (await продавец.взять('/api/dashboard?tz=360')).data;
  check('у продавца тревог нет', !глП['тревоги'], JSON.stringify(глП['тревоги'] || '').slice(0, 100));
  check('и состояние безопасности ему закрыто',
    (await продавец.взять('/api/security/status')).status === 403);

  console.log('\n=== 5. Починили — тревога уходит сама ===');
  /*
   * Возвращаем рабочую папку. Система при запуске сама снимет копию: тревога
   * должна исчезнуть без единого нажатия, а в журнале — появиться отметка,
   * что копии снова делаются. Иначе владелец, починив диск, продолжал бы
   * видеть красное и перестал бы верить тревогам вообще.
   */
  await убить();
  fs.rmSync(ЗАГЛУШКА, { force: true });
  if (!await поднять(КОПИИ)) { console.error('Сервер не поднялся'); process.exit(2); }
  const админ5 = сеанс();
  await админ5.войти('admin', 'admin123');

  const st5 = (await админ5.взять('/api/security/status')).data;
  check('ошибка копии снята', st5.backup_error === '', st5.backup_error);
  check('копия снова свежая', st5.backup_stale === false, st5.backup_hours_ago);
  check('файл копии действительно появился',
    fs.existsSync(КОПИИ) && fs.readdirSync(КОПИИ).some(f => /^asher-.*\.db$/.test(f)),
    fs.existsSync(КОПИИ) ? fs.readdirSync(КОПИИ) : 'папки нет');

  const тревоги5 = ((await админ5.взять('/api/dashboard?tz=360')).data['тревоги']) || [];
  check('тревога про копии ушла',
    !тревоги5.some(т => /копи/i.test(т['что'] || '')), тревоги5.map(т => т['что']));
  const журнал5 = (await админ5.взять('/api/audit?action=backup&limit=5')).data;
  check('в журнале отмечено, что копии снова делаются',
    ((журнал5 || {}).items || []).some(з => /снова/i.test(з.details || '')),
    JSON.stringify((журнал5 || {}).items || []).slice(0, 150));

  await убить();
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

function содержитСлово(т, слово) {
  return Boolean(т) && String(т['делать'] || '').includes(слово);
}

main().catch(e => { console.error(e); убить(); process.exit(2); });
