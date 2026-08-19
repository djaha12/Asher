require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
require('node:fs').mkdirSync(ВЫВОД + '/снимки', { recursive: true });
const { chromium } = require('./браузер');
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:3122');
  await p.fill('#login-username', 'admin');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  // Открываем чек со свежей продажей и жмём «Обмен»
  await p.goto('http://127.0.0.1:3122/#/sales');
  await p.waitForTimeout(900);
  const row = await p.$('#sales-list tbody tr');
  await row.click();
  await p.waitForTimeout(700);
  const chk = await p.$('.ret-chk');
  if (!chk) { console.log('В первом чеке нечего возвращать (возврат) — беру второй'); await p.keyboard.press('Escape'); }
  else {
    await chk.check();
    const exBtn = await p.$('[data-act=exchange]');
    console.log('Кнопка обмена активна:', exBtn && !(await exBtn.isDisabled()) ? 'да' : 'НЕТ');
    await exBtn.click();
    await p.waitForTimeout(600);
    console.log('Диалог обмена открылся:', await p.$('#ex-search') ? 'да' : 'НЕТ');
    await p.fill('#ex-search', 'Кольцо');
    await p.waitForTimeout(700);
    const sr = await p.$('.search-results .sr-item[data-i]');
    if (sr) {
      await sr.dispatchEvent('mousedown');
      await p.waitForTimeout(400);
      const summary = await p.textContent('#ex-summary');
      console.log('Итог обмена посчитан:', /Зачёт/.test(summary) ? 'да' : 'НЕТ', '·', summary.replace(/\s+/g, ' ').slice(0, 120));
      await p.screenshot({ path: ВЫВОД + '/снимки/exchange-dialog.png' });
    } else console.log('Поиск изделий не дал результатов');
    await p.keyboard.press('Escape'); // закрыть диалог обмена
    await p.keyboard.press('Escape'); // и карточку чека, если осталась
    await p.waitForTimeout(300);
  }

  // Клиенты: не должно быть колонок сегментов и бонусов
  await p.goto('http://127.0.0.1:3122/#/customers');
  await p.waitForTimeout(900);
  const heads = await p.$$eval('#cust-list th', els => els.map(e => e.textContent));
  console.log('Колонки клиентов:', heads.join(' | '));
  console.log('Бонусов и сегментов нет:', !heads.some(h => /Бонус|Сегмент/.test(h)) ? 'да' : 'НЕТ');
  await p.screenshot({ path: ВЫВОД + '/снимки/customers-clean.png' });

  // POS: нет поля бонусов
  await p.click('#btn-quick-sale');
  await p.waitForTimeout(500);
  console.log('Поле бонусов в кассе:', await p.$('#pos-bonus') ? 'ОСТАЛОСЬ' : 'убрано');
  await p.keyboard.press('Escape');

  await b.close();
  console.log(errs.length ? 'ОШИБКИ JS: ' + errs.join('; ') : 'Ошибок JS нет');
})();
