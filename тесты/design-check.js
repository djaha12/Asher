const ВЫВОД = require('node:path').join(__dirname, '.вывод');
require('node:fs').mkdirSync(ВЫВОД + '/снимки', { recursive: true });
const { chromium } = require('./браузер');
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // Экран входа
  await p.goto('http://127.0.0.1:3122', { waitUntil: 'networkidle' });
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
  await p.goto('http://127.0.0.1:3122/#/products');
  await p.waitForTimeout(1000);
  await (await p.$('.pcard')).click();
  await p.waitForTimeout(800);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-product.png' });
  await p.keyboard.press('Escape');

  // Долги
  await p.goto('http://127.0.0.1:3122/#/debts');
  await p.waitForTimeout(900);
  await p.screenshot({ path: ВЫВОД + '/снимки/rd-debts.png' });

  await b.close();
  console.log(errs.length ? 'ОШИБКИ: ' + errs.join('; ') : 'Ошибок нет');
})();
