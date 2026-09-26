'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Логин сотрудника на iPhone — глазами владельца и нового продавца.
 *
 * Телефон делает первую букву заглавной. Владелец набирал «Cum», форма
 * отвечала «Следуйте заданному формату» и сотрудника не заводила. Теперь
 * логин строчными становится прямо при наборе, непонятный логин объясняется
 * словами, а войти можно и с заглавной буквой.
 */
const { chromium, снимок } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = ВЫВОД + '/shots-логин';
require('node:fs').mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 300)); }
};
const чисто = t => String(t || '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
const ТЕЛЕФОН = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
// Только буквы: логин должен выглядеть как настоящий.
const хвост = String(process.pid).replace(/\d/g, ц => 'abcdefghij'[ц]);
const НАБРАЛИ = 'Cum' + хвост;
const ЛОГИН = НАБРАЛИ.toLowerCase();
const ПАРОЛЬ = 'vitrina-2026';

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

(async () => {
  const browser = await chromium.launch();
  const ошибки = [];

  console.log('=== 1. Владелец заводит «Cum…» с телефона ===');
  const ctxВ = await browser.newContext(ТЕЛЕФОН);
  const владелец = await ctxВ.newPage();
  владелец.on('pageerror', e => ошибки.push(e.message));
  await войти(владелец, 'admin', 'admin123');
  await владелец.goto(BASE + '/#/settings');
  await владелец.waitForSelector('.tab[data-tab=users]');
  await владелец.click('.tab[data-tab=users]');
  await владелец.waitForSelector('#user-add');
  await владелец.click('#user-add');
  await владелец.waitForSelector('#user-form [name=username]');
  const поле = '#user-form [name=username]';
  check('телефон не будет исправлять логин как слово',
    await владелец.getAttribute(поле, 'autocorrect') === 'off' && await владелец.getAttribute(поле, 'spellcheck') === 'false');
  await владелец.type(поле, НАБРАЛИ);
  check(`набрали «${НАБРАЛИ}» — в поле «${ЛОГИН}»`, await владелец.inputValue(поле) === ЛОГИН, await владелец.inputValue(поле));
  check('под полем сказано, какой логин подходит', /Латинские буквы, цифры/.test(чисто(await владелец.textContent('#user-form'))));
  await владелец.fill('#user-form [name=name]', 'Продавец с телефона');
  await владелец.fill('#user-form [name=password]', ПАРОЛЬ);
  await снимок(владелец, { path: `${OUT}/форма.png` });
  await владелец.click('.modal-foot [data-act=ok]');
  await владелец.waitForSelector('#phone-card', { timeout: 8000 }).catch(() => {});
  check('сотрудник заведён — открылась карточка подключения', Boolean(await владелец.$('#phone-card')));
  check('на карточке логин строчными', чисто(await владелец.textContent('#phone-card').catch(() => '')).includes(ЛОГИН));
  await владелец.keyboard.press('Escape');
  await владелец.waitForTimeout(500);

  console.log('\n=== 2. Логин по-русски — объяснение, а не «заданный формат» ===');
  await владелец.click('#user-add');
  await владелец.waitForSelector(поле);
  await владелец.type(поле, 'анна');
  await владелец.fill('#user-form [name=name]', 'Анна');
  await владелец.fill('#user-form [name=password]', ПАРОЛЬ);
  await владелец.click('.modal-foot [data-act=ok]');
  await владелец.waitForTimeout(800);
  const тост = чисто(await владелец.textContent('#toast-root').catch(() => ''));
  check('сказано: латинскими буквами', /латинскими буквами/.test(тост), тост);
  check('окно не закрылось — можно поправить', Boolean(await владелец.$('#user-form')));
  await владелец.fill(поле, 'ab');
  await владелец.click('.modal-foot [data-act=ok]');
  await владелец.waitForTimeout(800);
  check('короткий логин — «не короче 3 знаков»', /не короче 3 знаков/.test(чисто(await владелец.textContent('#toast-root').catch(() => ''))));
  await владелец.keyboard.press('Escape');
  await ctxВ.close();

  console.log('\n=== 3. Продавец входит, набрав логин с заглавной ===');
  const ctxП = await browser.newContext(ТЕЛЕФОН);
  const продавец = await ctxП.newPage();
  продавец.on('pageerror', e => ошибки.push(e.message));
  check('в поле входа тоже без автоисправления', await (async () => {
    await продавец.goto(BASE, { waitUntil: 'domcontentloaded' });
    return await продавец.getAttribute('#login-username', 'autocorrect') === 'off';
  })());
  let вошёл = true;
  await войти(продавец, НАБРАЛИ, ПАРОЛЬ).catch(() => { вошёл = false; });
  check(`вход как «${НАБРАЛИ}» (с заглавной) — пустило`, вошёл,
    await продавец.textContent('#login-error, .login-error, #toast-root').catch(() => ''));
  await снимок(продавец, { path: `${OUT}/вошёл.png` });
  await ctxП.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
