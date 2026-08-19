'use strict';
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Как система поведёт себя на хостинге.
 *
 * Там перед ней стоит обратный прокси: наружу — https, внутрь — обычный http.
 * Значит, о защищённости и о настоящем адресе посетителя система узнаёт из
 * заголовков прокси. Верить им можно только когда прокси действительно есть
 * (ASHER_TRUST_PROXY=1) — иначе любой подделает и заголовок, и адрес.
 *
 * Запускаем вторую копию системы с включённым доверием прокси и притворяемся
 * этим прокси.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const SC = ВЫВОД;
const PORT = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 42;
const BASE = `http://127.0.0.1:${PORT}`;

let ok = 0, fail = 0;
const failures = [];
const check = (n, c, e) => {
  if (c) { ok++; console.log('  ok  ' + n); }
  else { fail++; failures.push(n); console.log('  FAIL ' + n, e === undefined ? '' : JSON.stringify(e).slice(0, 200)); }
};

const asProxy = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '95.85.120.7' };

async function main() {
  const srv = spawn(process.execPath, [require('node:path').resolve(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      // База — та же, что у общего прогона (в ней есть демо-данные и продавцы).
      // Своя пустая база означала бы, что половина проверок молча проходит
      // мимо: некому войти, нечего показать.
      ASHER_DB: process.env.ASHER_DB || SC + '/data/test.db',
      ASHER_DATA: process.env.ASHER_DATA || SC + '/data',
      PORT: String(PORT),
      NO_OPEN: '1',
      ASHER_TRUST_PROXY: '1',
    },
    stdio: 'ignore',
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    try { await fetch(BASE + '/api/ping'); break; } catch { await wait(300); }
  }

  try {
    console.log('=== Система знает, что снаружи https ===');
    const page = await fetch(BASE + '/', { headers: asProxy });
    check('включается строгий https (HSTS)',
      /max-age=\d+/.test(page.headers.get('strict-transport-security') || ''),
      page.headers.get('strict-transport-security'));
    check('политика безопасности на месте',
      (page.headers.get('content-security-policy') || '').includes("default-src 'self'"));

    const login = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asProxy },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const sc = login.headers.get('set-cookie') || '';
    check('вход проходит', login.status === 200, login.status);
    check('cookie помечена Secure — по обычному http её уже не отдадут',
      /;\s*Secure/i.test(sc), sc);
    check('и остаётся недоступной скриптам', /HttpOnly/i.test(sc), sc);

    console.log('\n=== Без прокси заголовкам не верят ===');
    const plain = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const sc2 = plain.headers.get('set-cookie') || '';
    check('без заголовка прокси Secure не ставится', !/;\s*Secure/i.test(sc2), sc2);

    console.log('\n=== Настоящий адрес посетителя ===');
    // Заходим «из интернета» — в журнале должен остаться адрес, а не адрес прокси.
    const cookie = sc.split(';')[0];
    const audit = await fetch(BASE + '/api/audit?action=login&limit=5', { headers: { Cookie: cookie } });
    const rows = (await audit.json()).items || [];
    check('в журнале записан адрес, с которого зашли',
      rows.some(r => String(r.details).includes('95.85.120.7')),
      rows.map(r => r.details).slice(0, 3));

    console.log('\n=== Из интернета система молчит о стандартном пароле ===');
    // В магазинной сети подсказка «admin/admin123» помогает. На публичном
    // адресе она была бы объявлением «сюда можно зайти вот так».
    const hintOut = await (await fetch(BASE + '/api/login-hint', { headers: asProxy })).json();
    check('снаружи подсказка не выдаётся', hintOut.default_admin === false, hintOut);
    // Но владельцу, после входа, знать об этом надо.
    const st = await (await fetch(BASE + '/api/security/status', {
      headers: { Cookie: cookie, ...asProxy },
    })).json();
    check('владельцу после входа система говорит правду',
      st.default_admin === true, st);
    check('и подтверждает, что соединение защищено', st.secure === true, st);
    const stSeller = await fetch(BASE + '/api/security/status', { headers: asProxy });
    check('состояние безопасности закрыто без входа', stSeller.status === 401, stSeller.status);

    console.log('\n=== Перебор с разных адресов виден по логину ===');
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': `77.88.99.${i}`,   // каждый раз «новый» злоумышленник
        },
        body: JSON.stringify({ username: 'anna', password: 'подбор' + i }),
      });
      if (r.status === 429) { blocked = true; break; }
    }
    check('смена адреса не помогает — считаем по логину', blocked);

    console.log(`\nИтого: ${ok} ok, ${fail} fail`);
    if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  } finally {
    srv.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
