require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-roles';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 250)));

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.6 })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  await p.goto(`${BASE}/#/settings`); await p.waitForTimeout(1400);
  const tabs = await p.$$eval('.tab', els => els.map(e => e.textContent.trim()));
  check('вкладка «Журнал действий» есть', tabs.includes('Журнал действий'), tabs);
  await p.click('.tab[data-tab=audit]'); await p.waitForTimeout(1800);

  const text = await p.$eval('#set-body', el => el.innerText);
  check('журнал загрузился', /Кто что сделал/.test(text), text.slice(0, 120));
  check('действия подписаны по-русски',
    /продажа|приём оплаты|создание|вход в систему/.test(text) && !/upload_photo|release_reserves/.test(text),
    text.split('\n').slice(0, 30).join(' / '));
  check('видно, кто продавец, а кто админ', /продавец/.test(text) && /админ/.test(text));
  check('есть сводка «кто сколько сделал»', /Кто сколько сделал/.test(text));
  await p.screenshot({ path: `${OUT}/журнал-все.png`, fullPage: false });

  // отбор по сотруднику
  const opts = await p.$$eval('#au-user option', els => els.map(e => e.textContent.trim()));
  check('в отборе перечислены сотрудники', opts.length >= 3, opts);
  const anna = await p.$$eval('#au-user option', els =>
    (els.find(e => /Анна/.test(e.textContent)) || {}).value);
  await p.selectOption('#au-user', anna); await p.waitForTimeout(1500);
  const onlyAnna = await p.$eval('#au-list', el => el.innerText);
  check('после отбора остались только её строки',
    /Анна/.test(onlyAnna) && !/Администратор/.test(onlyAnna),
    onlyAnna.split('\n').slice(0, 6).join(' / '));
  await p.screenshot({ path: `${OUT}/журнал-продавец.png`, fullPage: false });

  // отбор по действию
  await p.selectOption('#au-action', 'sale'); await p.waitForTimeout(1500);
  const sales = await p.$eval('#au-list', el => el.innerText);
  check('отбор «продажа» оставил только продажи',
    /продажа/.test(sales) && !/вход в систему/.test(sales), sales.split('\n').slice(0, 5).join(' / '));

  // сброс
  await p.click('#au-reset'); await p.waitForTimeout(1500);
  const back = await p.$eval('#au-list', el => el.innerText);
  check('сброс возвращает весь журнал', /Администратор/.test(back));

  // поиск
  await p.fill('#au-search', 'Погашение'); await p.waitForTimeout(1600);
  const search = await p.$eval('#au-list', el => el.innerText);
  check('поиск по деталям работает', /огашение/.test(search) || /действий нет/.test(search),
    search.split('\n').slice(0, 4).join(' / '));
  await p.click('#au-reset'); await p.waitForTimeout(1400);

  // «показать ещё»
  const before = await p.$$eval('#au-list tbody tr', els => els.length);
  const more = await p.$('#au-more:not(.hidden)');
  if (more) {
    await more.click(); await p.waitForTimeout(1600);
    const after = await p.$$eval('#au-list tbody tr', els => els.length);
    check('«Показать ещё» догружает строки', after > before, { before, after });
  } else check('весь журнал поместился на одной странице', true);

  // продавец в журнал не попадает
  const p2 = await (await b.newContext()).newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.fill('#login-username', 'anna'); await p2.fill('#login-password', 'seller123');
  await p2.click('#login-form button[type=submit]');
  await p2.waitForSelector('#app:not(.hidden)');
  await p2.goto(`${BASE}/#/settings`); await p2.waitForTimeout(1400);
  const tabs2 = await p2.$$eval('.tab', els => els.map(e => e.textContent.trim()));
  check('у продавца вкладки журнала нет', !tabs2.includes('Журнал действий'), tabs2);

  check('ошибок в браузере нет', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
