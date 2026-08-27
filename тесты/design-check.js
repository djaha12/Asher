require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
require('node:fs').mkdirSync(ВЫВОД + '/снимки', { recursive: true });
const { chromium } = require('./браузер');
/*
 * Порт берём у запускающего, а не вписываем в себя. Запускающий выбирает
 * свободный: если 3122 занят — своим же сервером разработчика или прошлым
 * прогоном, который не успел закрыться, — он поднимет систему на 3123.
 * Набор с вписанным портом в этот момент стучится в пустоту и падает
 * с «connection refused», хотя всё исправно.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // Экран входа
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-login.png' });

  await p.fill('#login-username', 'admin');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');
  await p.waitForTimeout(800);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-dashboard.png' });

  // Касса
  await p.click('#btn-quick-sale');
  await p.waitForTimeout(600);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-pos.png' });
  await p.keyboard.press('Escape');

  // Карточка изделия
  await p.goto(`${BASE}/#/products`);
  await p.waitForTimeout(1000);
  await (await p.$('.pcard')).click();
  await p.waitForTimeout(800);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-product.png' });
  await p.keyboard.press('Escape');

  // Долги
  await p.goto(`${BASE}/#/debts`);
  await p.waitForTimeout(900);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-debts.png' });

  await b.close();
  console.log(errs.length ? 'ОШИБКИ: ' + errs.join('; ') : 'Ошибок нет');
})();
