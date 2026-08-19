'use strict';
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Проверка «система уже на домене».
 *
 * Поднимаем вторую копию с доверием прокси, притворяемся Caddy (снаружи https,
 * домен diamonds.kg) и смотрим главное: что система отдаёт телефонам правильный
 * адрес. Если карточка подключения продолжит печатать «192.168…», после
 * переезда шесть продавцов останутся с нерабочими кодами.
 */
const { spawn } = require('node:child_process');
const { chromium } = require('./браузер');

const SC = ВЫВОД;
// Свой порт, заведомо в стороне от того, на котором работает общий прогон:
// раньше здесь стояло 3124 — ровно то, что берёт ПРОВЕРИТЬ.js, и вторая
// копия молча не поднималась, а тест проверял чужой сервер.
const PORT = Number(process.env.ASHER_TEST_PORT)
  || Number((process.env.BASE || '').match(/:(\d+)/)?.[1] || 3122) + 41;
const BASE = `http://127.0.0.1:${PORT}`;
require('node:fs').mkdirSync(SC + '/shots-roles', { recursive: true });
const DOMAIN = 'diamonds.kg';

let ok = 0, fail = 0;
const failures = [];
const check = (n, c, e) => {
  if (c) { ok++; console.log('  ok  ' + n); }
  else { fail++; failures.push(n); console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 220)); }
};

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

  /*
   * Чтобы браузер по-настоящему считал, что он на diamonds.kg, направляем это
   * имя на нашу копию системы прямо в браузере. Так проверяется именно то, что
   * система решает по адресу в строке, а не по подменённым запросам.
   */
  const b = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1`],
  });
  try {
    /*
     * В браузере проверяем то, что зависит от ДОМЕНА в адресной строке.
     * Заголовок «снаружи https» здесь намеренно не шлём: система в ответ
     * пометила бы cookie как «только для https», а браузер по http такую
     * cookie выбрасывает — и вход бы не сохранился. Это правильное поведение
     * системы, а не помеха; всё, что касается https, проверяется отдельно
     * запросами ниже и целиком в https-test.
     */
    const ctx = await b.newContext({
      viewport: { width: 1500, height: 1000 },
      deviceScaleFactor: 1.6,
      extraHTTPHeaders: { 'X-Forwarded-For': '95.85.120.7' },
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/status of 40[013]/.test(m.text())) errs.push(m.text()); });

    console.log('=== Система открывается по домену ===');
    await p.goto(`http://${DOMAIN}:${PORT}/`, { waitUntil: 'networkidle' });
    check('страница входа открылась по домену',
      await p.isVisible('#login-form'), await p.title());
    check('в адресной строке домен', (await p.evaluate(() => location.hostname)) === DOMAIN);
    check('подсказка про стандартный пароль снаружи не показывается',
      await p.evaluate(() => document.getElementById('login-hint').classList.contains('hidden')));

    await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
    await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    check('вход по домену проходит', true);

    console.log('\n=== Адрес для телефонов — домен, а не 192.168 ===');
    await p.goto(`http://${DOMAIN}:${PORT}/#/settings`); await p.waitForTimeout(1600);
    const storeText = await p.$eval('#set-body', el => el.innerText);
    check('в «Открыть на телефоне» показан домен', storeText.includes(DOMAIN),
      storeText.split('\n').filter(l => /http|diamonds/.test(l)).slice(0, 3).join(' / '));
    check('адресов вида 192.168 больше не предлагается',
      !/192\.168\.|10\.\d+\.\d+\.\d+/.test(storeText),
      storeText.split('\n').filter(l => /192\.168|10\./.test(l)).slice(0, 2).join(' / '));
    check('сказано, что теперь работает откуда угодно',
      /откуда угодно/.test(storeText));
    await p.screenshot({ path: SC + '/shots-roles/домен-настройки.png' });

    console.log('\n=== Карточка подключения сотрудника ===');
    await p.click('.tab[data-tab=users]'); await p.waitForTimeout(1500);
    await (await p.$('[data-user-phone]')).click(); await p.waitForTimeout(1400);
    const card = await p.$eval('#phone-card', el => el.innerText);
    check('в карточке домен', card.includes(DOMAIN), card.slice(0, 160));
    check('в карточке нет адреса из чужой сети', !/192\.168\.|127\.0\.0\.1/.test(card), card.slice(0, 160));
    check('в карточке не написано про магазинный Wi-Fi',
      /откуда угодно/.test(card) && !/том же Wi-Fi/.test(card),
      card.split('\n').filter(l => /Wi-Fi|откуда/.test(l)).join(' / '));
    await p.screenshot({ path: SC + '/shots-roles/домен-карточка.png' });

    console.log('\n=== Продавец заходит по коду с карточки ===');
    // Отдельное окно: в общем с владельцем вход уже выполнен, и страницы
    // входа продавец бы не увидел.
    const sellerCtx = await b.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      extraHTTPHeaders: { 'X-Forwarded-For': '95.85.120.9' },
    });
    const seller = await sellerCtx.newPage();
    await seller.goto(`http://${DOMAIN}:${PORT}/#login=anna`, { waitUntil: 'networkidle' });
    await seller.waitForTimeout(1000);
    check('логин подставлен из ссылки', (await seller.inputValue('#login-username')) === 'anna');
    await seller.fill('#login-password', 'seller123');
    await seller.click('#login-form button[type=submit]');
    await seller.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    check('продавец вошёл по домену', true);
    await seller.goto(`http://${DOMAIN}:${PORT}/#/products`); await seller.waitForTimeout(2000);
    const cat = await seller.$eval('#page', el => el.innerText);
    check('каталог работает', cat.length > 40);
    check('закупочных цен по-прежнему нет', !/Закупочн|Наценка/i.test(cat));

    console.log('\n=== Защита на публичном адресе ===');
    const head = await fetch(BASE + '/', {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '95.85.120.7' },
    });
    check('включён строгий https (HSTS)',
      /max-age/.test(head.headers.get('strict-transport-security') || ''));
    const hint = await (await fetch(BASE + '/api/login-hint', {
      headers: { 'X-Forwarded-For': '95.85.120.7' },
    })).json();
    check('о стандартном пароле снаружи система молчит', hint.default_admin === false, hint);

    console.log('\n=== Приложение на телефон ===');
    const man = await fetch(BASE + '/manifest.webmanifest');
    const manifest = await man.json();
    check('манифест отдаётся', man.status === 200);
    check('адреса в манифесте относительные — переживают смену домена',
      !/https?:\/\//.test(JSON.stringify({ s: manifest.start_url, i: manifest.icons })),
      { start_url: manifest.start_url });

    check('ошибок в браузере нет', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await b.close();
    srv.kill();
  }
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
