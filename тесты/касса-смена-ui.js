'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Касса глазами трёх людей.
 *
 * Анна вечером сдаёт выручку владельцу прямо из окна сверки и сдаёт смену.
 * Михаил на своём входе видит «смену сдаёт Анна», пересчитывает и принимает.
 * Владелец видит «Анна сдаёт вам …» и отмечает «деньги у меня».
 * Кнопки «Отмена» и «Понятно» в окнах сверки закрывают окна.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-смена';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const ВЕРХ = '#modal-root > .modal-overlay:last-child';
const текст = async (page, sel) => (await page.innerText(sel).catch(() => '')).replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

let cookie = '';
async function зов(метод, путь, тело) {
  const r = await fetch(BASE + путь, {
    method: метод, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: тело === undefined ? undefined : JSON.stringify(тело),
  });
  let data = null;
  try { data = await r.json(); } catch { /* пусто */ }
  return { status: r.status, data };
}

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  await page.waitForSelector('#qa-cash', { timeout: 15000 });
}

async function окноСверки(page) {
  await page.click('#qa-cash');
  await page.waitForSelector('#cc-counted');
  await page.waitForTimeout(200);
}

(async () => {
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (вход.headers.get('set-cookie') || '').split(';')[0];

  const browser = await chromium.launch();
  const ошибки = [];
  const окно = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => ошибки.push(e.message));
    return page;
  };

  console.log('=== 1. Анна: точка отсчёта, «Отмена» работает ===');
  const анна = await окно();
  await войти(анна, 'anna', 'seller123');
  await окноСверки(анна);
  await анна.click(`${ВЕРХ} [data-act=cancel]`);
  await анна.waitForTimeout(300);
  check('«Отмена» закрывает окно сверки', !(await анна.$('#cc-counted')));
  await окноСверки(анна);
  await анна.fill('#cc-counted', '10000');
  await анна.click('#cc-save');
  await анна.waitForSelector(`${ВЕРХ} [data-act=cancel]`);
  await анна.click(`${ВЕРХ} [data-act=cancel]`);   // «Понятно»
  await анна.waitForTimeout(300);
  check('«Понятно» закрывает итог', !(await анна.$('#modal-root .modal-overlay')));

  console.log('\n=== 2. Анна сдаёт владельцу 4 000 из окна сверки ===');
  await окноСверки(анна);
  await анна.click(`${ВЕРХ} [data-act=to-owner]`);
  await анна.waitForSelector('#cm-form');
  const кому = await анна.$eval('#cm-form [name=other_user_id]', s => s.options[s.selectedIndex].text);
  check('по умолчанию — основателю', /основатель/.test(кому), кому);
  await анна.fill('#cm-form [name=amount]', '4000');
  await снимок(анна, { path: `${OUT}/сдать.png` });
  await анна.click(`${ВЕРХ} [data-act=ok]`);
  await анна.waitForSelector('#cc-counted');   // окно сверки открылось заново
  await анна.waitForTimeout(300);
  const разбивка = await текст(анна, `${ВЕРХ} .modal-body`);
  check('в сверке — «Сдали владельцу −4 000»', /Сдали владельцу\s*−4 000/.test(разбивка), разбивка.slice(0, 300));
  check('должно быть 6 000', /Должно быть в ящике\s*6 000/.test(разбивка), разбивка.slice(0, 300));

  await анна.check('#cc-handover');
  await анна.fill('#cc-counted', '6000');
  await анна.click('#cc-save');
  await анна.waitForSelector(`${ВЕРХ} .modal-head h2`);
  await анна.waitForTimeout(300);
  check('смена сдана', /Смена сдана/.test(await текст(анна, `${ВЕРХ} .modal-head h2`)), await текст(анна, `${ВЕРХ}`));
  await снимок(анна, { path: `${OUT}/смена-сдана.png` });
  await анна.click(`${ВЕРХ} [data-act=cancel]`);
  await анна.waitForTimeout(600);
  check('у самой Анны «принять смену» не появилось', !(await анна.$('#qa-accept')));

  console.log('\n=== 3. Михаил принимает смену ===');
  const михаил = await окно();
  await войти(михаил, 'mikhail', 'seller123');
  await михаил.waitForSelector('#dash-shift', { timeout: 8000 }).catch(() => {});
  const баннер = await текст(михаил, '#dash-shift');
  check('на Главной: смену сдаёт Анна, в ящике 6 000', /Смену сдаёт Анна Соколова: в ящике 6 000/.test(баннер), баннер);
  await снимок(михаил, { path: `${OUT}/принять.png` });
  await михаил.click('#qa-accept');
  await михаил.waitForSelector('#cc-counted');
  check('в окне — сколько было при сдаче', /при сдаче в ящике было 6 000/.test(await текст(михаил, `${ВЕРХ} .modal-body`)));
  check('в окне приёма нет «Сдаю смену»', !(await михаил.$('#cc-handover')));
  await михаил.fill('#cc-counted', '6000');
  await михаил.click('#cc-save');
  await михаил.waitForSelector(`${ВЕРХ} .modal-head h2`);
  await михаил.waitForTimeout(300);
  check('смена принята — сошлось', /Смена принята/.test(await текст(михаил, `${ВЕРХ} .modal-head h2`))
    && /Всё сошлось/.test(await текст(михаил, ВЕРХ)), await текст(михаил, ВЕРХ));
  await михаил.click(`${ВЕРХ} [data-act=cancel]`);
  await михаил.waitForTimeout(1200);
  check('после приёма баннер пропал', !(await михаил.$('#dash-shift')));

  console.log('\n=== 4. Владелец: «деньги у меня» ===');
  const владелец = await окно();
  await войти(владелец, 'admin', 'admin123');
  const строка = владелец.locator('[data-move]', { hasText: 'Анна Соколова' });
  check('на Главной: Анна сдаёт вам 4 000', /Анна Соколова сдаёт из кассы вам 4 000/.test(
    (await строка.innerText().catch(() => '')).replace(/[  ]/g, ' ')), await строка.innerText().catch(() => ''));
  await снимок(владелец, { path: `${OUT}/владелец.png` });
  await строка.locator('[data-move-ok]').click();
  await владелец.waitForTimeout(800);
  check('строка ушла', (await строка.count()) === 0);
  const сдачи = (await зов('GET', '/api/cash/moves')).data.items;
  check('на сервере: получено', сдачи.some(m => m.amount === 4000 && m.status === 'confirmed'), JSON.stringify(сдачи.slice(0, 2)));

  await владелец.goto(BASE + '/#/finance');
  await владелец.waitForSelector('[data-tab=cash]');
  await владелец.click('[data-tab=cash]');
  await владелец.waitForSelector('#cash-moves');
  await владелец.waitForTimeout(500);
  const финансы = await текст(владелец, '#fin-body');
  check('в Финансах: сдача смены и кто принял', /Сдача смены принял\(а\) Михаил Орлов/.test(финансы), финансы.slice(0, 400));
  check('в Финансах: приём смены у Анны', /Приём смены у Анна Соколова, сдано 6 000/.test(финансы));
  check('в Финансах: сдано из кассы, получено', /Сдано из кассы/.test(финансы) && /получено/.test(финансы));
  await снимок(владелец, { path: `${OUT}/финансы.png`, fullPage: true });

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
