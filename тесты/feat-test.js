require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-roles';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 220)));

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.6 })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/status of 40[013]/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');

  console.log('=== Задаём цену грамма в настройках ===');
  await p.goto(`${BASE}/#/settings`); await p.waitForTimeout(1600);
  check('поле цены грамма есть', await p.isVisible('[name=gram_price]'));
  check('поле работы за грамм есть', await p.isVisible('[name=work_price]'));
  await p.fill('[name=gram_price]', '7000');
  await p.fill('[name=work_price]', '1500');
  await p.click('#st-save'); await p.waitForTimeout(1300);
  check('настройки сохранены', /сохранены/i.test(await p.textContent('#toast-root').catch(() => '')));

  console.log('\n=== Расчёт в форме изделия ===');
  await p.goto(`${BASE}/#/products`); await p.waitForTimeout(2400);
  await p.click('#pf-add'); await p.waitForTimeout(1100);
  check('кнопка «Посчитать от грамма» появилась', await p.isVisible('#pf-bygram'));
  await p.click('#pf-bygram'); await p.waitForTimeout(700);
  check('без веса система просит указать вес',
    /вес/i.test(await p.textContent('#toast-root').catch(() => '')));
  await p.fill('[name=weight]', '4.2');
  await p.click('#pf-bygram'); await p.waitForTimeout(800);
  const price = await p.inputValue('[name=retail_price]');
  check('цена посчитана: 4,2 × (7000 + 1500) = 35 700', price === '35700', price);
  check('показано, из чего сложилась цена',
    /×/.test(await p.textContent('#toast-root').catch(() => '')));
  check('поле цены остаётся редактируемым',
    !(await p.getAttribute('[name=retail_price]', 'readonly')));
  await p.screenshot({ path: `${OUT}/цена-от-грамма.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);

  console.log('\n=== Карточка изделия клиенту ===');
  // Берём изделие в наличии: у списанного кнопки «Клиенту» нет по замыслу,
  // а первым в каталоге легко оказывается именно списанное — его создают
  // другие наборы. Тогда тест ловил бы порядок прогонов, а не ошибку.
  await p.click('#pf-chips .chip[data-st=in_stock]'); await p.waitForTimeout(1500);
  await p.fill('#pf-search', 'AS-'); await p.waitForTimeout(2000);
  await (await p.$('.pcard')).click(); await p.waitForTimeout(1600);
  check('кнопка «Клиенту» есть в карточке', Boolean(await p.$('[data-act=share]')));
  await p.click('[data-act=share]'); await p.waitForTimeout(1300);
  const share = await p.$eval('#share-text', e => e.innerText);
  console.log('     сообщение:\n' + share.split('\n').map(l => '       ' + l).join('\n'));
  check('в сообщении есть артикул', /Артикул:/.test(share), share);
  check('есть цена', /Цена:/.test(share));
  check('закупочной цены в сообщении нет', !/[Зз]акупоч/.test(share));
  check('есть поле выбора клиента', await p.isVisible('#share-cust'));
  check('есть кнопка отправки', Boolean(await p.$('[data-act=send]')));
  check('есть кнопка «скопировать текст»', Boolean(await p.$('[data-act=copy]')));
  await p.screenshot({ path: `${OUT}/карточка-клиенту.png` });

  console.log('\n=== Выбор получателя подставляет телефон ===');
  await p.fill('#share-cust', 'ова'); await p.waitForTimeout(1400);
  const hit = await p.$('.search-results .sr-item[data-i]');
  check('клиент находится', Boolean(hit));
  if (hit) {
    await hit.dispatchEvent('mousedown'); await p.waitForTimeout(700);
    check('телефон подставился', (await p.inputValue('#share-phone')).length > 5,
      await p.inputValue('#share-phone'));
    check('подсказка говорит, с кем откроется переписка',
      /Откроется переписка|не записан телефон/.test(await p.textContent('#share-note')));
  }
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);

  console.log('\n=== Продавцу «Клиенту» тоже доступно ===');
  const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.fill('#login-username', 'anna'); await p2.fill('#login-password', 'seller123');
  await p2.click('#login-form button[type=submit]'); await p2.waitForSelector('#app:not(.hidden)');
  await p2.goto(`${BASE}/#/products`); await p2.waitForTimeout(2400);
  // Берём изделие в наличии, а не первое попавшееся: у списанного кнопки
  // «Клиенту» нет по замыслу, и тест ловил бы не ошибку, а порядок прогонов.
  await p2.click('#pf-chips .chip[data-st=in_stock]'); await p2.waitForTimeout(2000);
  await (await p2.$('.pcard')).click(); await p2.waitForTimeout(1600);
  check('продавец видит кнопку «Клиенту»', Boolean(await p2.$('[data-act=share]')));
  await p2.click('[data-act=share]'); await p2.waitForTimeout(1300);
  const share2 = await p2.$eval('#share-text', e => e.innerText);
  check('и в его сообщении нет закупочной', !/[Зз]акупоч/.test(share2));
  await p2.screenshot({ path: `${OUT}/клиенту-телефон.png` });
  // Закрываем окна по кнопке: на телефоне Escape до модалки не доходит.
  await p2.click('.modal-foot [data-act=cancel]'); await p2.waitForTimeout(500);
  const closeBtn = await p2.$('.modal-close, .modal-head [data-act=close]');
  if (closeBtn) { await closeBtn.click(); await p2.waitForTimeout(500); }

  console.log('\n=== Расчёт от грамма доступен и продавцу ===');
  // Цена грамма — это розничный ориентир, а не закупка: продавец и так
  // выставляет розничную цену руками, так что запрещать расчёт незачем.
  await p2.goto(`${BASE}/#/products`); await p2.waitForTimeout(2200);
  await p2.click('#pf-add'); await p2.waitForTimeout(1200);
  check('у продавца кнопка расчёта есть', await p2.isVisible('#pf-bygram'));
  await p2.fill('[name=weight]', '3');
  await p2.click('#pf-bygram'); await p2.waitForTimeout(700);
  check('и считает так же: 3 × 8500 = 25 500',
    (await p2.inputValue('[name=retail_price]')) === '25500',
    await p2.inputValue('[name=retail_price]'));
  check('но закупочной цены в форме по-прежнему нет',
    !(await p2.isVisible('[name=purchase_price]')));

  check('ошибок в браузере нет', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
