const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-jewelry';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 200)));
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 2 })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error' && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username','admin'); await p.fill('#login-password','admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

  await p.goto(`${BASE}/#/products`); await p.waitForTimeout(2200);
  check('фильтр по цвету на месте', await p.isVisible('#pf-color'));
  check('фильтр по чистоте на месте', await p.isVisible('#pf-clarity'));
  const stone = await p.$('.pcard-stone');
  check('характеристика бриллианта на плитке', Boolean(stone));
  if (stone) console.log('     пример:', (await stone.textContent()).trim());
  await p.screenshot({ path: `${OUT}/14-каталог-бриллианты.png` });

  // карточка изделия: открываем демо-изделие, а не то, что осталось от других тестов
  await p.fill('#pf-search', 'AS-'); await p.waitForTimeout(1600);
  const card = await p.$('.pcard');
  await card.click(); await p.waitForTimeout(1400);
  const body = await p.$eval('.modal-body', el => el.innerText);
  check('в карточке строка «Бриллиант»', /Бриллиант/.test(body));
  check('металл показан с пробой', /750/.test(body), body.slice(0,200));
  await p.screenshot({ path: `${OUT}/15-карточка-бриллиант.png`, fullPage: true });
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);

  // форма
  await p.click('#pf-add'); await p.waitForTimeout(900);
  for (const [name, label] of [['fineness','Проба'],['carat','Каратность'],['color','Цвет'],['clarity','Чистота']]) {
    check(`поле «${label}» в форме`, await p.isVisible(`[name=${name}]`));
  }
  const metals = await p.$$eval('#metal-list option', els => els.map(e => e.value || e.textContent));
  // Подсказка = наши три золота + то, что реально лежит в каталоге (из 1С может
  // приехать что угодно). Проверяем именно предложенное по умолчанию.
  check('подсказка металла начинается с золота 750',
    metals.slice(0, 3).every(m => /золото/i.test(m)), metals.slice(0, 6));
  const gems = await p.$$eval('#gem-types option', els => els.map(e => e.value || e.textContent));
  check('в списке камней только бриллиант', gems.length === 1 && /Бриллиант/.test(gems[0]), gems);
  await p.screenshot({ path: `${OUT}/16-форма-бриллиант.png`, fullPage: true });
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);

  // бирка: берём именно то изделие, у которого караты заполнены
  await p.goto(`${BASE}/#/labels`); await p.waitForTimeout(1800);
  await p.fill('#lb-search', 'BR-'); await p.waitForTimeout(1500);
  const row = await p.$('tbody tr');
  check('изделие с бриллиантом найдено для бирки', Boolean(row));
  if (row) { await row.click(); await p.waitForTimeout(900); }
  const label = await p.$('.jl-stone');
  check('на бирке печатается камень', Boolean(label),
    await p.$eval('#lb-preview', el => el.innerText).catch(() => ''));
  await p.screenshot({ path: `${OUT}/17-бирка-бриллиант.png` });

  await b.close();
  if (errs.length) { console.log('Ошибки JS:'); [...new Set(errs)].forEach(e=>console.log('  '+e)); }
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
