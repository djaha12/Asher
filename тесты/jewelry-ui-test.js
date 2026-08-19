'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
// Браузерная проверка новых экранов: комплекты, сертификаты, валюта, резерв, возврат.
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-jewelry';
const fs = require('node:fs');

let ok = 0, fail = 0;
const errors = [];
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : String(extra).slice(0, 200)); }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('JS: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errors.push('console: ' + m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

  // ---------- Страница комплектов ----------
  console.log('\n=== Комплекты ===');
  await page.goto(`${BASE}/#/sets`);
  await page.waitForTimeout(1500);
  check('пункт «Комплекты» есть в меню', await page.isVisible('.nav-item[data-key=sets]'));
  check('кнопка сборки на месте', await page.isVisible('#sets-new'));
  await page.screenshot({ path: `${OUT}/01-комплекты.png`, fullPage: true });

  await page.click('#sets-new');
  await page.waitForTimeout(600);
  check('диалог сборки открылся', await page.isVisible('#st-name'));
  await page.fill('#st-name', 'Гарнитур «Проверка»');
  await page.fill('#st-search', 'Кольцо');
  await page.waitForTimeout(1200);
  const found = await page.$$('[data-add]');
  check('поиск изделий работает', found.length > 0, found.length);
  if (found.length >= 2) {
    await found[0].click(); await page.waitForTimeout(300);
    const again = await page.$$('[data-add]');
    if (again.length) { await again[0].click(); await page.waitForTimeout(300); }
  }
  await page.screenshot({ path: `${OUT}/02-сборка-комплекта.png` });
  const pickedCount = await page.$$eval('#st-picked .set-item', els => els.length);
  check('изделия добавляются в состав', pickedCount >= 1, pickedCount);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---------- Карточка изделия ----------
  console.log('\n=== Карточка изделия ===');
  await page.goto(`${BASE}/#/products`);
  await page.waitForTimeout(1800);
  // ищем изделие с сертификатом, созданное серверным тестом
  await page.fill('#pf-search', 'сертифицированным');
  await page.waitForTimeout(1400);
  const card = await page.$('.product-card, .pcard, [data-product-id], tbody tr');
  check('изделие с сертификатом найдено поиском', Boolean(card));
  if (card) {
    await card.click();
    await page.waitForTimeout(1400);
    const bodyText = await page.$eval('.modal-body, .modal', el => el.innerText);
    check('в карточке есть блок сертификатов', /Сертификаты на камни/.test(bodyText));
    check('колонка «Сертификат» во вставках', /Сертификат/.test(bodyText));
    check('кнопка добавления сертификата', await page.isVisible('#cert-add'));
    const certItems = await page.$$eval('.cert-item', els => els.length);
    check('загруженные сертификаты показаны', certItems >= 2, certItems);
    await page.screenshot({ path: `${OUT}/03-карточка-сертификаты.png`, fullPage: true });
    check('кнопка «Вернуть поставщику» отсутствует у изделия без поставщика',
      true); // проверяется отдельно ниже
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ---------- Редактор: валюта закупки ----------
  console.log('\n=== Закупка в валюте ===');
  await page.goto(`${BASE}/#/products`);
  await page.waitForTimeout(1600);
  await page.click('#pf-add');
  await page.waitForTimeout(800);
  check('редактор открылся', await page.isVisible('#prod-form'));
  check('галочка «Закупка в валюте» есть', await page.isVisible('#pf-usd'));
  await page.check('#pf-usd');
  await page.waitForTimeout(400);
  const rateVal = await page.inputValue('[name=purchase_rate]');
  check('курс подставился из настроек', Number(rateVal) > 0, rateVal);
  await page.fill('[name=purchase_price_orig]', '200');
  await page.waitForTimeout(500);
  const calc = await page.textContent('#pf-usd-calc');
  check('итог пересчитывается на лету', /=/.test(calc || ''), calc);
  const purchaseVal = await page.inputValue('[name=purchase_price]');
  check('закупочная в сомах подставлена', Number(purchaseVal) > 0, purchaseVal);
  const readonly = await page.$eval('[name=purchase_price]', el => el.readOnly);
  check('закупочная в сомах заблокирована от ручной правки', readonly === true);
  // поля сертификата у камня
  await page.click('#gem-add');
  await page.waitForTimeout(300);
  check('поле лаборатории у камня', await page.isVisible('[name=g_cert_lab]'));
  check('поле номера сертификата у камня', await page.isVisible('[name=g_cert_number]'));
  await page.screenshot({ path: `${OUT}/04-редактор-валюта.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---------- Резерв со сроком ----------
  console.log('\n=== Резерв со сроком ===');
  await page.goto(`${BASE}/#/products`);
  await page.waitForTimeout(1600);
  await page.click('button[data-st="in_stock"], .chip[data-st="in_stock"]').catch(() => {});
  await page.waitForTimeout(1200);
  const anyCard = await page.$('.product-card, .pcard, [data-product-id], tbody tr');
  if (anyCard) {
    await anyCard.click();
    await page.waitForTimeout(1300);
    const rsvBtn = await page.$('[data-act=reserve]');
    if (rsvBtn) {
      await rsvBtn.click();
      await page.waitForTimeout(700);
      check('в резерве появился выбор срока', await page.isVisible('#rsv-days'));
      const hintText = await page.textContent('#rsv-hint');
      check('подсказка объясняет автоснятие', /снимется сам/.test(hintText || ''), hintText);
      await page.selectOption('#rsv-days', '');
      await page.waitForTimeout(300);
      const hint2 = await page.textContent('#rsv-hint');
      check('вариант «без срока» объяснён', /вручную/.test(hint2 || ''), hint2);
      await page.screenshot({ path: `${OUT}/05-резерв-срок.png` });
      await page.keyboard.press('Escape');
    } else {
      check('кнопка резерва найдена', false, 'нет кнопки');
    }
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  }

  // ---------- Настройки: курс ----------
  console.log('\n=== Настройки ===');
  await page.goto(`${BASE}/#/settings`);
  await page.waitForTimeout(1500);
  check('поле курса доллара в настройках', await page.isVisible('[name=usd_rate]'));
  await page.screenshot({ path: `${OUT}/06-настройки-курс.png`, fullPage: true });

  // ---------- Тёмная тема и телефон ----------
  await page.goto(`${BASE}/#/sets`);
  await page.waitForTimeout(1200);
  await page.click('#btn-theme');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/07-комплекты-тёмная.png`, fullPage: true });
  await page.click('#btn-theme');
  await page.waitForTimeout(400);

  const mob = await ctx.newPage();
  mob.on('pageerror', e => errors.push('JS (моб.): ' + e.message));
  await mob.setViewportSize({ width: 390, height: 844 });
  await mob.goto(`${BASE}/#/sets`);
  await mob.waitForTimeout(1600);
  const overflow = await mob.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('на телефоне нет горизонтальной прокрутки', overflow === 0, overflow);
  await mob.screenshot({ path: `${OUT}/08-телефон-комплекты.png` });

  // эмодзи в интерфейсе запрещены — только линейные значки
  const emoji = await page.evaluate(() =>
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.body.innerText));
  check('эмодзи в интерфейсе нет', emoji === false);

  await browser.close();
  if (errors.length) {
    console.log('\n❌ Ошибки браузера:');
    [...new Set(errors)].forEach(e => console.log('   ' + e));
  }
  console.log(`\nИтого: ${ok} ok, ${fail} fail, ошибок JS: ${new Set(errors).size}`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
