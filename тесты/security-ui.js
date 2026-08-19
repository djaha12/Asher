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
  // 400 здесь ожидаем сами: нарочно вводим слабый пароль и ждём отказа.
  p.on('console', m => { if (m.type() === 'error' && !/status of 40[013]/.test(m.text())) errs.push(m.text()); });

  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.fill('#login-username', 'admin'); await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)');

  console.log('=== Страница «Безопасность» ===');
  await p.goto(`${BASE}/#/settings`); await p.waitForTimeout(1300);
  const tabs = await p.$$eval('.tab', els => els.map(e => e.textContent.trim()));
  check('вкладка «Безопасность» есть', tabs.includes('Безопасность'), tabs);
  await p.click('.tab[data-tab=security]'); await p.waitForTimeout(1500);
  const text = await p.$eval('#set-body', el => el.innerText);
  check('видно состояние пароля администратора', /Пароль администратора/.test(text));
  check('честно сказано про стандартный пароль',
    /admin123/.test(text) || /Стандартный пароль сменён/.test(text), text.slice(0, 200));
  check('объяснено про https', /https/.test(text));
  check('рассказано про защиту от подбора', /подбор/i.test(text) && /минут/.test(text));
  check('видно число устройств в системе', /устройств/i.test(text));
  check('есть кнопка резервной копии', Boolean(await p.$('a[href="/api/backup/download"]')));
  await p.screenshot({ path: `${OUT}/безопасность.png` });

  console.log('\n=== Копия действительно скачивается ===');
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    p.click('a[href="/api/backup/download"]'),
  ]);
  check('файл копии получен архивом', /\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  console.log('\n=== Сотрудники: устройства и завершение входов ===');
  await p.click('.tab[data-tab=users]'); await p.waitForTimeout(1500);
  const heads = await p.$$eval('#set-body th', els => els.map(e => e.textContent.trim()));
  check('в таблице есть столбец «Устройства»', heads.includes('Устройства'), heads);
  check('кнопка завершения входов появляется у вошедших',
    (await p.$$('[data-user-logout]')).length >= 1);

  console.log('\n=== Слабый пароль не пройдёт ===');
  await p.click('#user-add'); await p.waitForTimeout(800);
  const login = 'weak' + String(Date.now()).slice(-6);
  await p.fill('[name=username]', login);
  await p.fill('[name=name]', 'Проверка пароля');
  await p.fill('[name=password]', 'admin123');
  await p.click('.modal-foot [data-act=ok]'); await p.waitForTimeout(1200);
  const toast = await p.textContent('#toast-root').catch(() => '');
  check('система отказала и объяснила почему',
    /подбирают|8 знаков/i.test(toast) || Boolean(await p.$('.modal-body')), toast);
  await p.fill('[name=password]', 'vitrina-2026');
  await p.click('.modal-foot [data-act=ok]'); await p.waitForTimeout(1500);
  check('нормальный пароль принят', Boolean(await p.$('#phone-card')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);

  console.log('\n=== Журнал: неудачные попытки по-русски ===');
  await p.click('.tab[data-tab=audit]'); await p.waitForTimeout(1600);
  await p.selectOption('#au-action', 'login_failed'); await p.waitForTimeout(1600);
  const journal = await p.$eval('#au-list', el => el.innerText);
  check('в отборе есть «неудачный вход»',
    /неудачный вход/.test(journal) || /действий нет/.test(journal), journal.slice(0, 150));
  check('попытки подписаны по-русски, без английских слов',
    !/login_failed/.test(journal), journal.slice(0, 150));
  await p.screenshot({ path: `${OUT}/журнал-попытки.png` });

  console.log('\n=== Продавцу «Безопасность» не показывается ===');
  const p2 = await (await b.newContext()).newPage();
  await p2.goto(BASE, { waitUntil: 'networkidle' });
  await p2.fill('#login-username', login); await p2.fill('#login-password', 'vitrina-2026');
  await p2.click('#login-form button[type=submit]');
  await p2.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await p2.goto(`${BASE}/#/settings`); await p2.waitForTimeout(1400);
  const tabs2 = await p2.$$eval('.tab', els => els.map(e => e.textContent.trim()));
  check('у продавца только «Мой пароль»', tabs2.length === 1 && tabs2[0] === 'Мой пароль', tabs2);
  const pwdText = await p2.$eval('#set-body', el => el.innerText);
  check('продавцу тоже сказано про 8 знаков', /8 знаков/.test(pwdText), pwdText.slice(0, 120));

  check('ошибок в браузере нет', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
