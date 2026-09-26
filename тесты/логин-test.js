'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Логин сотрудника: заглавные буквы не мешают ни завести, ни войти.
 *
 * Телефон сам делает первую букву заглавной. Владелец набирал логин «Cum»,
 * а форма отвечала «Следуйте заданному формату» и сотрудника не заводила.
 * Сервер и раньше записывал логин строчными, но вход сверял его с учётом
 * регистра: «Anna» с верным паролем получала «неверный логин или пароль».
 * Теперь:
 *   — логин записывается строчными, как бы его ни набрали;
 *   — войти можно в любом регистре;
 *   — «Anna» и «anna» — один и тот же логин: второй раз его не завести;
 *   — кириллица и пробелы — отказ со словами, что именно не так.
 * Подбор пароля это не облегчает: счётчик неудачных попыток (guard.js) и
 * раньше считал логин без регистра. Здесь его не долбим — замок закрыл бы
 * вход наборам, идущим следом.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else {
    fail++; провалы.push(имя);
    const текст = доп !== null && typeof доп === 'object' ? JSON.stringify(доп) : String(доп);
    console.log('  FAIL ' + имя, доп === undefined ? '' : текст.slice(0, 300));
  }
};

async function войти(логин, пароль) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: логин, password: пароль }),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const админ = await войти('admin', 'admin123');
  if (админ.status !== 200) { console.error('Не удалось войти владельцем'); process.exit(2); }
  const зов = async (метод, путь, тело) => {
    const opts = { method: метод, headers: { Cookie: админ.cookie } };
    if (тело !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(тело); }
    const r = await fetch(BASE + путь, opts);
    let data = null;
    try { data = await r.json(); } catch { /* пусто */ }
    return { status: r.status, data };
  };
  // Логин только из латиницы: цифры номера процесса — буквами.
  const хвост = String(process.pid).replace(/\d/g, ц => 'abcdefghij'[ц]);
  const набрали = 'Aigerim.' + хвост.toUpperCase();
  const логин = набрали.toLowerCase();
  const пароль = 'Proverka-2026';

  console.log('=== 1. Завели с заглавными — записан строчными ===');
  let r = await зов('POST', '/api/users', { username: набрали, name: 'Айгерим', role: 'seller', password: пароль });
  check('сотрудник заведён', r.status === 200 && r.data.id, r.data);
  const записан = ((await зов('GET', '/api/users')).data.items || []).find(u => u.id === (r.data && r.data.id));
  check(`логин записан строчными: «${логин}»`, записан && записан.username === логин, записан && записан.username);

  console.log('\n=== 2. Войти можно в любом регистре ===');
  for (const как of [набрали, логин, логин.toUpperCase(), '  ' + набрали + ' ']) {
    const вход = await войти(как, пароль);
    check(`вход как «${как.trim()}»`, вход.status === 200, вход.data);
  }
  const чужой = await войти(набрали, 'неверный-пароль');
  check('с неверным паролем — по-прежнему отказ', чужой.status === 401, чужой.data);

  console.log('\n=== 3. «Aigerim» и «aigerim» — один логин ===');
  r = await зов('POST', '/api/users', { username: логин.toUpperCase(), name: 'Двойник', role: 'seller', password: пароль });
  check('второй раз в другом регистре не завести', r.status === 400 && /занят/.test(r.data.error), r.data);

  console.log('\n=== 4. Непонятный логин — отказ словами ===');
  r = await зов('POST', '/api/users', { username: 'анна' + хвост, name: 'Анна', role: 'seller', password: пароль });
  check('кириллица — отказ, и сказано про латиницу', r.status === 400 && /латиниц/.test(r.data.error), r.data);
  r = await зов('POST', '/api/users', { username: 'ai', name: 'Коротко', role: 'seller', password: пароль });
  check('короче 3 знаков — отказ', r.status === 400, r.data);

  console.log('\n=== 5. Экран «ждём разрешения» узнаёт логин в любом регистре ===');
  const состояние = await (await fetch(BASE + '/api/login/device-status?username=' + encodeURIComponent(набрали))).json();
  check('устройство сотрудника видно и по «' + набрали + '»', состояние.state === 'разрешено', состояние);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
