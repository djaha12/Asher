'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Экран входа не уводит курсор из поля, где уже печатают.
 *
 * Экран входа через 50 мс после показа ставил курсор в поле логина. Если
 * пароль к этому моменту уже начали вводить — подставило автозаполнение
 * телефона или человек очень быстр, — курсор перескакивал, и пароль
 * дописывался в логин: «adminadmin123» в логине, пустой пароль, вход не идёт.
 * В проверках это выглядело как редкий необъяснимый сбой входа (1 из 30).
 */
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 200)); }
};

(async () => {
  const browser = await chromium.launch();
  const ошибки = [];

  for (const [что, адрес, куда] of [
    ['обычный вход', BASE, 'login-password'],
    // Карточка подключения по QR: логин подставлен, курсор сам встаёт в пароль.
    ['вход по QR-карточке', BASE + '/#login=anna', 'login-username'],
  ]) {
    console.log(`=== ${что}: печатают сразу, как экран показался ===`);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ошибки.push(e.message));
    await page.goto(адрес, { waitUntil: 'domcontentloaded' });
    /*
     * Как только экран входа показался — сразу в поле (раньше, чем через
     * 50 мс сработает автоматический курсор), и смотрим, где курсор потом.
     * MutationObserver срабатывает в ту же секунду, когда экран открылся.
     */
    const где = await page.evaluate(id => new Promise(resolve => {
      const экран = document.getElementById('login-screen');
      const занять = () => {
        document.getElementById(id).focus();
        setTimeout(() => resolve(document.activeElement && document.activeElement.id), 300);
      };
      if (!экран.classList.contains('hidden')) { занять(); return; }
      const наблюдатель = new MutationObserver(() => {
        if (экран.classList.contains('hidden')) return;
        наблюдатель.disconnect();
        занять();
      });
      наблюдатель.observe(экран, { attributes: true, attributeFilter: ['class'] });
    }), куда);
    check('курсор остался там, где печатают', где === куда, где);
    await ctx.close();
  }

  // И обычный вход по-прежнему ставит курсор в логин сам.
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen:not(.hidden)');
  await page.waitForTimeout(300);
  check('без касаний курсор сам встаёт в логин', await page.evaluate(() => document.activeElement.id) === 'login-username');
  const поQR = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const стр = await поQR.newPage();
  await стр.goto(BASE + '/#login=anna', { waitUntil: 'domcontentloaded' });
  await стр.waitForSelector('#login-screen:not(.hidden)');
  await стр.waitForTimeout(300);
  check('по QR-карточке логин подставлен, курсор — в пароле',
    await стр.inputValue('#login-username') === 'anna' && await стр.evaluate(() => document.activeElement.id) === 'login-password');

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
