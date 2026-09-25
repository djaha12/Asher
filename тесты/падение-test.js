'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Сервер не падает от чужого запроса.
 *
 * Нашлось при проверке безопасности: одна строка адреса вида «/%FF» — без
 * пароля, без входа, из любой точки интернета — останавливала процесс целиком.
 * Служба поднимается сама через несколько секунд, но если слать такие запросы
 * подряд, касса лежит у всех, сколько захочет тот, кто их шлёт.
 *
 * Второй путь к тому же: загрузка резервной копии, оборванная на середине
 * (закрыли вкладку, пропала связь у компьютера, который забирает копию).
 * Ответ к этому моменту уже начат, и попытка отправить поверх него
 * «внутреннюю ошибку» роняла сервер.
 *
 * Проверяем главное: после каждой такой попытки сервер отвечает.
 */
const net = require('node:net');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const { hostname, port } = new URL(BASE);

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};

async function жив() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(3000) });
      if (r.status === 200 && /asher/.test(await r.text())) return true;
    } catch { /* ещё раз */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/*
 * Кривой адрес отправляем как есть, мимо fetch: fetch сам «чинит» адреса
 * и до сервера дошло бы уже не то, что пришлёт злоумышленник.
 */
function сыройЗапрос(путь) {
  return new Promise(resolve => {
    const s = net.connect(Number(port), hostname, () => {
      s.write(`GET ${путь} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let ответ = '';
    s.on('data', d => { ответ += d; });
    s.on('close', () => resolve(ответ.split('\r\n')[0] || '(соединение закрыто без ответа)'));
    s.on('error', () => resolve('(ошибка соединения)'));
    s.setTimeout(5000, () => { s.destroy(); });
  });
}

async function main() {
  check('сервер отвечает перед проверкой', await жив());

  console.log('=== 1. Кривой адрес ===');
  for (const путь of ['/%FF', '/api/%E0%A4%A', '/%C0%80', '/media/%ZZ']) {
    const строка = await сыройЗапрос(путь);
    check(`«${путь}» — отказ, а не падение (${строка})`, /^HTTP\/1\.1 4\d\d/.test(строка), строка);
    check(`после «${путь}» сервер жив`, await жив());
  }

  console.log('\n=== 2. Загрузку копии оборвали на середине ===');
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = (вход.headers.get('set-cookie') || '').split(';')[0];
  check('владелец вошёл', вход.status === 200);
  for (let i = 1; i <= 3; i++) {
    const стоп = new AbortController();
    try {
      const r = await fetch(BASE + '/api/backup/download', { headers: { Cookie: cookie }, signal: стоп.signal });
      const чтение = r.body.getReader();
      await чтение.read();          // первый кусок пришёл — ответ уже начат
      стоп.abort();                 // и тут человек закрыл вкладку
    } catch { /* обрыв — так и задумано */ }
    await new Promise(r => setTimeout(r, 400));
    check(`обрыв №${i}: сервер жив`, await жив());
  }

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
