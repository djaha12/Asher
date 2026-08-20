'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Сквозной сценарий «рабочий день» — всё через настоящий браузер, как живой
 * пользователь: мышью и клавиатурой, без прямых вызовов API.
 *
 * Администратор: добавляет изделие, продаёт его в рассрочку через кассу,
 * принимает оплату долга, начинает инвентаризацию и сканирует изделие.
 * Продавец: входит, видит каталог, не видит закупочных цен и финансов.
 */
const { chromium } = require('./браузер');
// сумма так же, как её печатает интерфейс: «30 440 сом»
const ui_money = n => new Intl.NumberFormat('ru-RU').format(n).replace(/\u00a0/g, ' ') + ' сом';
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-workday';
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('  FAIL ' + name, extra !== undefined ? String(extra).slice(0, 120) : ''); }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  const sku = 'DAY-' + Date.now();

  console.log('\n=== Вход администратора ===');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)');
  check('вход выполнен', true);

  console.log('\n=== Добавление изделия через форму ===');
  await page.goto(BASE + '/#/products');
  await page.waitForTimeout(800);
  await page.click('#pf-add');
  await page.waitForSelector('#prod-form');
  await page.fill('[name=sku]', sku);
  await page.fill('[name=name]', 'Кольцо сквозного теста');
  await page.fill('[name=metal]', 'Золото 585');
  await page.fill('[name=weight]', '4.2');
  await page.fill('[name=purchase_price]', '30000');
  await page.fill('[name=retail_price]', '52000');
  await page.click('[data-act=save]');
  await page.waitForTimeout(900);
  // После сохранения открывается карточка с предложением добавить фото
  const detailOpened = await page.$('.gallery');
  check('изделие сохранилось и открылась карточка с галереей', Boolean(detailOpened));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== Печать бирки из карточки ===');
  await page.fill('#pf-search', sku);
  await page.waitForTimeout(800);
  const card = await page.$('.pcard');
  check('изделие находится поиском', Boolean(card));
  await card.click();
  await page.waitForTimeout(700);
  await page.click('[data-act=label]');
  await page.waitForTimeout(500);
  check('бирка со штрихкодом построена', Boolean(await page.$('#one-preview svg')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== Продажа в рассрочку через кассу ===');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-search');
  await page.fill('#pos-search', sku);
  await page.waitForTimeout(700);
  const sr = await page.$('.search-results .sr-item[data-i]');
  check('изделие найдено в кассе', Boolean(sr));
  await sr.dispatchEvent('mousedown');
  await page.waitForTimeout(400);

  // клиент
  await page.fill('#pos-customer', 'ова');
  await page.waitForTimeout(700);
  const custHit = await page.$('.search-results .sr-item[data-i]');
  check('клиент найден поиском', Boolean(custHit));
  // Запоминаем имя: на странице долгов строка показывает ОБЩИЙ долг клиента,
  // и если у него уже были документы, суммы 32 000 там не будет.
  const custName = (await custHit.textContent()).trim().split('\n')[0].trim();
  await custHit.dispatchEvent('mousedown');
  await page.waitForTimeout(400);

  // рассрочка: вносит 20 000 из 52 000
  await page.check('#pos-partial');
  await page.fill('#pos-paid', '20000');
  await page.fill('#pos-due', '2030-06-01');
  await page.waitForTimeout(500);
  const summary = await page.textContent('#pos-summary');
  // Точную сумму не зашиваем: у клиента может быть личная скидка, и «к оплате»
  // меняется. Проверяем то, что должно сходиться всегда: долг = к оплате − взнос.
  const money = txt => { const m = summary.match(new RegExp(txt + '\\s*([\\d\\s\u00a0\u202f]+)')); 
    return m ? Number(m[1].replace(/[^\d]/g, '')) : NaN; };
  const toPay = money('К оплате'), left = money('Останется долг');
  check('касса считает остаток долга: к оплате − взнос',
    Number.isFinite(toPay) && Number.isFinite(left) && left === toPay - 20000,
    summary.replace(/\s+/g, ' '));
  await page.click('[data-act=submit]');
  await page.waitForTimeout(1200);
  // отказ от печати чека
  const printDlg = await page.$('.modal-overlay [data-act=cancel]');
  if (printDlg) { await printDlg.click(); await page.waitForTimeout(300); }
  const toast = await page.textContent('#toast-root').catch(() => '');
  check('продажа оформлена с долгом', /долг|Долг/i.test(toast), toast);

  console.log('\n=== Долг виден и оплачивается ===');
  await page.goto(BASE + '/#/debts');
  await page.waitForTimeout(1000);
  const debtList = await page.textContent('#d-list');
  check('должник в списке', /ова|ов /.test(debtList));
  // открываем карточку должника с нашим долгом
  const rows = await page.$$('#d-list .debt-row');
  let opened = false;
  const key = custName.split(' ')[0];
  for (const row of rows) {
    const txt = await row.textContent();
    if (txt.includes(key)) { await row.click(); opened = true; break; }
  }
  check('карточка должника открыта', opened);
  await page.waitForTimeout(900);
  // оплата конкретного документа
  const payBtn = await page.$('[data-pay-id]');
  check('кнопка оплаты по документу есть', Boolean(payBtn));
  await payBtn.click();
  await page.waitForTimeout(600);
  // Сумму не вписываем свою: в поле уже стоит весь остаток долга по документу,
  // а больше него касса и не примет.
  const owed = Number(await page.inputValue('[name=amount]'));
  check('в оплате подставлен весь остаток долга', owed > 0, owed);

  /*
   * Общий долг ДО оплаты. Раньше здесь искали сумму платежа в тексте страницы
   * и считали, что её отсутствие означает «долг закрыт». На демо-данных
   * с дюжиной должников та же сумма попадалась у кого-нибудь ещё, и проверка
   * падала не по делу. Смотрим на цифру, которая обязана измениться ровно
   * на внесённое.
   */
  const общийДолг = async () => {
    const t = (await page.textContent('#d-body')).replace(/\s+/g, ' ');
    const m = /Всего должны нам\s*([\d\s\u00a0\u202f]+)/.exec(t);
    return m ? Number(m[1].replace(/[^\d]/g, '')) : NaN;
  };
  const долгДо = await общийДолг();
  await page.click('[data-act=ok]');
  await page.waitForTimeout(1200);
  check('диалог оплаты закрылся', !(await page.$('.modal-overlay [name=amount]')));
  await page.goto(BASE + '/#/debts');
  await page.waitForTimeout(1200);
  const долгПосле = await общийДолг();
  check('долг уменьшился ровно на внесённое',
    Number.isFinite(долгДо) && Number.isFinite(долгПосле)
      && Math.abs((долгДо - долгПосле) - owed) <= 1,
    `было ${долгДо}, стало ${долгПосле}, внесли ${owed}`);

  console.log('\n=== Обмен проданного изделия ===');
  await page.goto(BASE + '/#/sales');
  await page.waitForTimeout(900);
  // наш чек — первый в списке
  await (await page.$('#sales-list tbody tr')).click();
  await page.waitForTimeout(800);
  const chk = await page.$('.ret-chk');
  check('позиция чека доступна для возврата/обмена', Boolean(chk));
  await chk.check();
  await page.click('[data-act=exchange]');
  await page.waitForTimeout(600);
  check('диалог обмена открылся', Boolean(await page.$('#ex-search')));
  await page.fill('#ex-search', 'Кольцо');
  await page.waitForTimeout(800);
  /*
   * Берём не первое попавшееся, а первое СВОБОДНОЕ изделие: демо-данные
   * раскладывают резервы случайно, и первым в выдаче регулярно оказывалось
   * кольцо, отложенное за другим клиентом. Система такой обмен справедливо
   * не проводит, а набор падал так, будто сломался обмен.
   */
  const exHits = await page.$$('.search-results .sr-item[data-i]');
  let exHit = null;
  for (const h of exHits) {
    const t = await h.textContent();
    if (!/резерв/i.test(t)) { exHit = h; break; }
  }
  check('замена найдена', Boolean(exHit), `вариантов ${exHits.length}, все в резерве`);
  await exHit.dispatchEvent('mousedown');
  await page.waitForTimeout(500);
  const exSummary = (await page.textContent('#ex-summary')).replace(/\s+/g, ' ');
  check('итог обмена посчитан (есть зачёт)', /Зачёт/.test(exSummary), exSummary.slice(0, 100));
  await page.click('.modal-foot [data-act=ok]');
  await page.waitForTimeout(1200);
  const printDlg2 = await page.$('.modal-overlay [data-act=cancel]');
  if (printDlg2) { await printDlg2.click(); await page.waitForTimeout(300); }
  const toast2 = await page.textContent('#toast-root').catch(() => '');
  check('обмен оформлен', /Обмен оформлен/.test(toast2), toast2);
  await page.screenshot({ path: OUT + '/workday-after-exchange.png' });

  console.log('\n=== Инвентаризация со сканированием ===');
  await page.goto(BASE + '/#/inventory');
  await page.waitForTimeout(900);
  // продолжить, если сессия уже висит, иначе начать новую
  const cont = await page.$('[data-continue]');
  if (cont) await cont.click();
  else await page.click('#inv-start');
  await page.waitForSelector('#scan-code', { timeout: 5000 });
  check('сессия пересчёта открыта, поле сканера в фокусе', true);
  // "сканируем" изделие с витрины: берём артикул из списка ненайденного
  const missSku = await page.$eval('#page .card .tbl tbody tr .mono', el => el.textContent.trim())
    .catch(() => null);
  if (missSku) {
    await page.fill('#scan-code', missSku);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const fb = await page.textContent('#scan-msg');
    check('сканирование засчитано', /✓|уже/.test(fb), fb);
  } else {
    check('есть что сканировать', false, 'список пуст');
  }
  await page.screenshot({ path: OUT + '/workday-inventory.png' });

  console.log('\n=== Продавец: ограничения ролей в интерфейсе ===');
  // Отдельный контекст: у продавца свои cookie, сессия администратора не мешает.
  const sellerCtx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const seller = await sellerCtx.newPage();
  seller.on('pageerror', e => jsErrors.push('продавец: ' + e.message));
  await seller.goto(BASE, { waitUntil: 'networkidle' });
  await seller.fill('#login-username', 'anna');
  await seller.fill('#login-password', 'seller123');
  await seller.click('#login-form button[type=submit]');
  await seller.waitForSelector('#app:not(.hidden)');
  const nav = await seller.textContent('#nav');
  check('продавец не видит Финансы и Аналитику', !/Финансы|Аналитика|Импорт/.test(nav), nav.replace(/\s+/g, ' '));
  await seller.goto(BASE + '/#/products');
  await seller.waitForTimeout(900);
  const th = await seller.$$eval('#prod-list th', els => els.map(e => e.textContent).join('|')).catch(() => '');
  // плиточный вид — проверяем карточку изделия
  const pcard = await seller.$('.pcard');
  if (pcard) {
    await pcard.click();
    await seller.waitForTimeout(800);
    const kv = await seller.textContent('.modal');
    check('продавцу не видна закупочная цена', !/Закупочная/.test(kv));
    await seller.keyboard.press('Escape');
  } else check('каталог у продавца открылся', false, th);

  await browser.close();
  if (jsErrors.length) {
    console.log('\nОшибки JS в браузере:');
    [...new Set(jsErrors)].forEach(e => console.log('   ' + e));
    failures += jsErrors.length;
  }
  console.log(failures === 0 ? '\n✅ Сквозной сценарий пройден' : `\n❌ Провалено: ${failures}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Сбой:', e.message); process.exit(2); });
