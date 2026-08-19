'use strict';
/*
 * Вход только с разрешённых устройств.
 *
 * Это защита от того, чего не ловит ни один самый строгий пароль: пароль
 * УТЁК. Записан на бумажке у кассы, подсмотрен через плечо, тот же самый,
 * что от почты, сказан по телефону «мошеннику из банка». После переезда
 * в интернет страницу входа видит весь мир — и знающий пароль заходит
 * откуда угодно.
 *
 * Проверяем главное: знание пароля само по себе больше НЕ пускает в систему.
 * И вторую половину — что своим при этом работать не мешают.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const РАБОТА = path.join(__dirname, '.вывод', 'устройства');
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
  ASHER_DB: path.join(РАБОТА, 'asher.db'),
  ASHER_DATA: РАБОТА,
  PORT: String(ПОРТ),
  NO_OPEN: '1',
  NO_PROXY: '*', no_proxy: '*',
};

let сервер = null;
const живПорт = () => new Promise(res => {
  const s = net.connect(ПОРТ, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 300);
});

/*
 * Свой запрос вместо общего помощника: здесь отметка устройства — предмет
 * проверки, и подставлять её автоматически было бы всё равно что проверять
 * замок, заранее вставив в него ключ.
 */
async function зов(метод, путь, { тело, устройство, cookie } = {}) {
  const headers = {};
  if (устройство !== undefined) headers['X-Asher-Device'] = устройство;
  if (cookie) headers.Cookie = cookie;
  if (тело !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + путь, {
    method: метод, headers, body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

const вход = (логин, пароль, устройство) =>
  зов('POST', '/api/login', { тело: { username: логин, password: пароль }, устройство });

async function main() {
  fs.rmSync(РАБОТА, { recursive: true, force: true });
  fs.mkdirSync(РАБОТА, { recursive: true });
  const seed = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'],
    { cwd: ROOT, env: окружение, encoding: 'utf8' });
  if (seed.status !== 0) { console.error(seed.stderr || seed.stdout); process.exit(2); }

  сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружение, stdio: 'ignore' });
  for (let i = 0; i < 100 && !await живПорт(); i++) await new Promise(r => setTimeout(r, 200));

  console.log('=== 1. Свои входят как обычно ===');
  const владелец = await вход('admin', 'admin123', 'laptop-owner');
  check('владелец вошёл с первого устройства', владелец.status === 200, владелец.data);

  const продавец = await вход('anna', 'seller123', 'phone-anna');
  check('продавец вошёл со своего телефона', продавец.status === 200, продавец.data);

  console.log('\n=== 2. Украденный пароль НЕ пускает ===');
  /*
   * Тот самый случай, ради которого всё это сделано. Пароль у вора верный —
   * ровно тот, которым только что вошла Анна. Устройство чужое.
   */
  const вор = await вход('anna', 'seller123', 'thief-pc');
  check('вора с верным паролем не пустили', вор.status !== 200, вор.status);
  check('и сказали, что дело в устройстве, а не в пароле',
    вор.data && вор.data.pending_device === true, вор.data);
  check('вору показан код, а не доступ', Boolean(вор.data && вор.data.code), вор.data);
  check('вход не выдан: cookie нет', !вор.cookie, вор.cookie);

  console.log('\n=== 3. Заголовок нельзя просто убрать ===');
  const безОтметки = await вход('anna', 'seller123', undefined);
  check('вход без отметки устройства тоже закрыт', безОтметки.status !== 200, безОтметки.status);
  const пустая = await вход('anna', 'seller123', '');
  check('и с пустой отметкой закрыт', пустая.status !== 200, пустая.status);

  console.log('\n=== 4. Владелец видит попытку ===');
  const список = await зов('GET', '/api/devices', { устройство: 'laptop-owner', cookie: владелец.cookie });
  const ждут = (список.data && список.data.pending) || [];
  const чужое = ждут.find(d => d.code === (вор.data && вор.data.code));
  check('чужое устройство висит в ожидающих', Boolean(чужое), ждут);
  check('видно, под чьим логином стучались', чужое && чужое.username === 'anna', чужое);

  const журнал = await зов('GET', '/api/audit?action=device_new&limit=5',
    { устройство: 'laptop-owner', cookie: владелец.cookie });
  check('попытка записана в журнал действий',
    ((журнал.data && журнал.data.items) || []).length > 0, журнал.data);

  console.log('\n=== 5. Пока не разрешили — вход закрыт ===');
  const ещёРаз = await вход('anna', 'seller123', 'thief-pc');
  check('повторные попытки с того же устройства так же закрыты', ещёРаз.status !== 200, ещёРаз.status);
  const статус = await зов('GET', '/api/login/device-status?username=anna', { устройство: 'thief-pc' });
  check('устройство знает, что ещё ждёт', статус.data && статус.data.state === 'ждёт', статус.data);

  console.log('\n=== 6. Продавец с новым телефоном: разрешили — вошёл ===');
  const новыйТелефон = await вход('anna', 'seller123', 'phone-anna-2');
  const код = новыйТелефон.data && новыйТелефон.data.code;
  check('новый телефон ждёт разрешения', новыйТелефон.status !== 200 && Boolean(код), новыйТелефон.data);

  const свежий = await зов('GET', '/api/devices', { устройство: 'laptop-owner', cookie: владелец.cookie });
  const мой = ((свежий.data && свежий.data.pending) || []).find(d => d.code === код);
  const разрешение = await зов('POST', `/api/devices/${мой.id}/approve`,
    { устройство: 'laptop-owner', cookie: владелец.cookie });
  check('владелец разрешил устройство', разрешение.status === 200, разрешение.data);

  const теперь = await вход('anna', 'seller123', 'phone-anna-2');
  check('после разрешения тем же паролем входит', теперь.status === 200, теперь.data);
  check('а вор всё так же не входит',
    (await вход('anna', 'seller123', 'thief-pc')).status !== 200);

  console.log('\n=== 7. Продавец не может разрешать устройства сам ===');
  /*
   * Иначе защита ничего не стоила бы: получив доступ по украденному паролю
   * один раз, дальше можно было бы разрешить себе что угодно.
   */
  const самому = await зов('GET', '/api/devices', { устройство: 'phone-anna', cookie: продавец.cookie });
  check('продавцу список устройств закрыт', самому.status === 403, самому.status);
  const попытка = await зов('POST', `/api/devices/${мой.id}/approve`,
    { устройство: 'phone-anna', cookie: продавец.cookie });
  check('продавец не может разрешить устройство', попытка.status === 403, попытка.status);

  console.log('\n=== 8. Отклонение выбрасывает из системы ===');
  const всё = await зов('GET', '/api/devices', { устройство: 'laptop-owner', cookie: владелец.cookie });
  const телефонАнны = ((всё.data && всё.data.approved) || []).find(d => d.username === 'anna');
  check('телефон продавца числится разрешённым', Boolean(телефонАнны), всё.data);

  const работал = await зов('GET', '/api/products?limit=1', { устройство: 'phone-anna', cookie: продавец.cookie });
  check('до отклонения продавец работал', работал.status === 200, работал.status);

  const отказ = await зов('POST', `/api/devices/${телефонАнны.id}/deny`,
    { устройство: 'laptop-owner', cookie: владелец.cookie });
  check('владелец отклонил устройство', отказ.status === 200, отказ.data);

  const после = await зов('GET', '/api/products?limit=1', { устройство: 'phone-anna', cookie: продавец.cookie });
  check('вход с отклонённого устройства прекращён сразу', после.status === 401, после.status);

  console.log('\n=== 9. Восстановление доступа с сервера ===');
  /*
   * Владелец потерял телефон: войти не может, а разрешить новое устройство
   * некому. Единственный путь назад — команда на самом сервере. Из интернета
   * такого пути нет, и это правильно.
   */
  const сброс = spawnSync(process.execPath, [path.join('src', 'пароль.js'), 'admin'],
    { cwd: ROOT, env: окружение, encoding: 'utf8' });
  const новыйПароль = (сброс.stdout || '').trim().split('\n').pop();
  check('команда на сервере выдала новый пароль', /^[\w-]{10,}$/.test(новыйПароль), новыйПароль);
  check('и сказала, что устройства забыты', /устройств забыто/.test(сброс.stderr || ''), сброс.stderr);

  const сНуля = await вход('admin', новыйПароль, 'brand-new-laptop');
  check('владелец снова входит с любого устройства', сНуля.status === 200, сНуля.data);
  check('но старый пароль больше не работает',
    (await вход('admin', 'admin123', 'brand-new-laptop')).status !== 200);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  try { сервер.kill(); } catch { /* уже мёртв */ }
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  try { сервер && сервер.kill(); } catch { /* уже мёртв */ }
  process.exit(2);
});
