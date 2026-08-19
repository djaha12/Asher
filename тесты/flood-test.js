'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Поток запросов на страницу входа.
 *
 * Проверка пароля намеренно медленная, поэтому поток попыток — самый дешёвый
 * способ занять сервер целиком. Смотрим, что система отбивается быстро и что
 * уже вошедшие продолжают работать.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : JSON.stringify(e).slice(0, 200)));

async function main() {
  // Работающая смена: продавец уже вошёл с телефона.
  let cookie = '';
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('смена открыта до потока', login.status === 200, login.status);

  /*
   * Сначала — обратная сторона той же защиты, и она не менее важна.
   *
   * Всплеск входов у своих состоит из ВЕРНЫХ паролей: шесть телефонов разом
   * переустановили приложение, раздали новые карточки, сменили пароль. Если бы
   * общий потолок считал одно лишь количество, магазин запирал бы сам себя —
   * то есть делал за нападающего его работу, бесплатно и без нападающего.
   *
   * Проверяем это ДО потока: после него адрес честно под замком по числу
   * неудач, и мы мерили бы совсем не то.
   */
  console.log('\n=== Всплеск СВОИХ вход не закрывает ===');
  const свои = await Promise.all(Array.from({ length: 150 }, () =>
    fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    }).then(r => r.status).catch(() => 0)));
  const пустили = свои.filter(s => s === 200).length;
  const заперли = свои.filter(s => s === 429).length;
  console.log(`     из 150 входов верным паролем: пустили ${пустили}, заперли ${заперли}`);
  check('150 входов верным паролем — никого не заперли', заперли === 0, заперли);
  check('и все прошли', пустили === 150, пустили);

  console.log('\n=== 300 попыток входа подряд ===');
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 300 }, (_, i) =>
    fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'kto-to-' + i, password: 'perebor' + i }),
    }).then(r => r.status).catch(() => 0)));
  const took = Date.now() - t0;
  const refused = results.filter(s => s === 429).length;
  console.log(`     отбито сразу: ${refused} из 300, всего ${took} мс`);
  check('большая часть потока отбита без проверки пароля', refused > 200, refused);
  check('поток не занял сервер надолго', took < 15000, took);

  console.log('\n=== Магазин продолжает работать ===');
  const work = await fetch(BASE + '/api/products?limit=5', { headers: { Cookie: cookie } });
  check('уже открытая смена работает во время потока', work.status === 200, work.status);
  const t1 = Date.now();
  const page = await fetch(BASE + '/api/dashboard?tz=360', { headers: { Cookie: cookie } });
  check('и отвечает быстро', page.status === 200 && Date.now() - t1 < 3000, Date.now() - t1);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
