'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Металл и проба: белое золото 750 стоит само, опечатки не расползаются.
 *
 * На Главной в «Складе по металлам» одно и то же золото шло тремя строками:
 * «Белое золото 750», «Без металла» и «Белое золоти 750». В форме «Белое
 * золото» и «750» были серыми подсказками — поле выглядело заполненным,
 * а сохранялось пустым. Теперь:
 *   — металл и проба по умолчанию — настройка (не задана — белое золото 750);
 *   — «Белое золоти», «белое золото», «Желтое золото» при сохранении
 *     становятся привычным написанием; «750 пробы» — просто «750»;
 *   — Главная показывает владельцу кнопку для изделий без металла и с
 *     опечаткой, и сервер сам считает, что станет;
 *   — продавцу эта кнопка недоступна.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const металл = require('../src/металл');

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else {
    fail++; провалы.push(имя);
    const текст = доп !== null && typeof доп === 'object' ? JSON.stringify(доп) : String(доп);
    console.log('  FAIL ' + имя, доп === undefined ? '' : текст.slice(0, 300));
  }
};

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      return r.status === 200;
    },
    async зов(метод, путь, тело) {
      const opts = { method: метод, headers: { Cookie: cookie } };
      if (тело !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(тело); }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

async function main() {
  console.log('=== 1. Правила написания (без сервера) ===');
  const бз = [металл.ПО_УМОЛЧАНИЮ.default_metal];
  const пары = [
    ['Белое золоти', 'Белое золото'], ['белое золото', 'Белое золото'], ['Белое  золото ', 'Белое золото'],
    ['Белое злото', 'Белое золото'], ['Белое золтоо', 'Белое золото'], ['Желтое золото', 'Жёлтое золото'],
    ['Платины', 'Платина'],
    // не угадываем: другое слово, проба в металле, короткое
    ['Золото', 'Золото'], ['Белое золото 585', 'Белое золото 585'], ['Розовое', 'Розовое'], ['', ''],
  ];
  for (const [было, станет] of пары) {
    const вышло = металл.правильноеНаписание(было, бз);
    check(`«${было}» → «${станет}»`, вышло === станет, вышло);
  }
  for (const [было, станет] of [['750 пробы', '750'], ['750-я проба', '750'], ['750 пр.', '750'], ['585', '585'], ['', '']]) {
    check(`проба «${было}» → «${станет}»`, металл.праваяПроба(было) === станет, металл.праваяПроба(было));
  }
  const у = { metal: 'Белое золото', fineness: '750' };
  const исп = (м, п) => JSON.stringify(металл.исправление(м, п, у));
  check('без металла → белое золото 750', исп('', '') === JSON.stringify(у), исп('', ''));
  check('опечатка → привычное, проба та же', исп('Белое золоти', '750') === JSON.stringify(у), исп('Белое золоти', '750'));
  check('белое золото без пробы → проба 750', исп('Белое золото', '') === JSON.stringify(у));
  check('жёлтому золоту пробу не придумываем', исп('Жёлтое золото', '') === 'null');
  check('правильное — исправлять нечего', исп('Белое золото', '750') === 'null');
  check('не задан металл по умолчанию — «без металла» не трогаем',
    JSON.stringify(металл.исправление('', '', { metal: '', fineness: '750' })) === 'null');

  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const анна = сеанс();
  await анна.войти('anna', 'seller123');
  const МЕТКА = 'МТЛ' + process.pid;

  console.log('\n=== 2. Настройка: по умолчанию — белое золото 750 ===');
  let s = (await админ.зов('GET', '/api/settings')).data;
  const былиНастройки = { default_metal: s.default_metal, default_fineness: s.default_fineness };
  check('металл по умолчанию — «Белое золото»', s.default_metal === 'Белое золото', s.default_metal);
  check('проба по умолчанию — «750»', s.default_fineness === '750', s.default_fineness);
  check('продавцу настройка тоже видна — форма у него та же',
    (await анна.зов('GET', '/api/settings')).data.default_metal === s.default_metal);

  console.log('\n=== 3. Опечатки при сохранении исправляются ===');
  let r = await админ.зов('POST', '/api/products', { sku: МЕТКА + '-1', metal: 'Белое золоти', fineness: '750 пробы' });
  let и = (await админ.зов('GET', '/api/products/' + r.data.id)).data;
  check('«Белое золоти», «750 пробы» → «Белое золото», «750»', и.metal === 'Белое золото' && и.fineness === '750', [и.metal, и.fineness]);
  await анна.зов('PUT', '/api/products/' + r.data.id, { metal: 'желтое золото' });
  и = (await админ.зов('GET', '/api/products/' + r.data.id)).data;
  check('и у продавца при правке: «желтое золото» → «Жёлтое золото»', и.metal === 'Жёлтое золото', и.metal);
  r = await админ.зов('POST', '/api/products', { sku: МЕТКА + '-2', metal: 'Серебро с позолотой' });
  и = (await админ.зов('GET', '/api/products/' + r.data.id)).data;
  check('своё написание, не похожее на опечатку, остаётся', и.metal === 'Серебро с позолотой', и.metal);

  const поставщик = (await админ.зов('POST', '/api/suppliers', { name: 'Поставщик металла ' + process.pid })).data.id;
  r = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик, items: [{ sku: МЕТКА + '-п', metal: 'Белое залото', fineness: '750 пр.', purchase_price: 100 }],
  });
  и = (await админ.зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-п'))).data.items[0];
  check('в приёмке — так же', r.status === 200 && и && и.metal === 'Белое золото' && и.fineness === '750', и && [и.metal, и.fineness]);

  console.log('\n=== 4. Главная: «Без металла» — одной кнопкой ===');
  const безМеталла = [];
  for (const n of [1, 2, 3]) {
    r = await админ.зов('POST', '/api/products', { sku: `${МЕТКА}-б${n}`, weight: 2, retail_price: 1000 });
    безМеталла.push(r.data.id);
  }
  const проданное = (await админ.зов('POST', '/api/products', { sku: МЕТКА + '-пр', weight: 1, retail_price: 500 })).data.id;
  await админ.зов('POST', '/api/sales', { items: [{ product_id: проданное }], payment_method: 'cash' });
  const строки = async (кто = админ) => (await кто.зов('GET', '/api/dashboard?tz=0')).data.stock.by_metal;
  let группа = (await строки()).find(m => m.metal_raw === '' && m.fineness_raw === '');
  check('на Главной есть «Без металла» и в ней наши', группа && группа.metal === 'Без металла' && группа.cnt >= 3, группа);
  check('сервер подсказывает, что станет: белое золото 750',
    группа && группа.fix && группа.fix.metal === 'Белое золото' && группа.fix.fineness === '750', группа && группа.fix);
  r = await анна.зов('POST', '/api/products/fix-metal', { metal: '', fineness: '' });
  check('продавцу исправить разом нельзя', r.status === 403, r);
  r = await админ.зов('POST', '/api/products/fix-metal', { metal: '', fineness: '' });
  check('владелец исправил', r.status === 200 && r.data.updated >= 4 && r.data.metal === 'Белое золото', r.data);
  const после = await Promise.all([...безМеталла, проданное].map(id => админ.зов('GET', '/api/products/' + id)));
  check('все наши без металла стали «Белое золото 750» — и проданное тоже',
    после.every(x => x.data.metal === 'Белое золото' && x.data.fineness === '750'), после.map(x => x.data.metal + ' ' + x.data.fineness));
  check('строки «Без металла» на Главной больше нет', !(await строки()).some(m => m.metal_raw === ''));
  r = await админ.зов('POST', '/api/products/fix-metal', { metal: 'Белое золото', fineness: '750' });
  check('правильное «исправить» нельзя — понятный отказ', r.status === 400 && /нечего/.test(r.data.error), r.data);
  const журнал = (await админ.зов('GET', '/api/audit?limit=20')).data;
  const записи = (журнал && (журнал.items || журнал)) || [];
  check('в журнале — что и у скольких изделий',
    Array.isArray(записи) && записи.some(з => /Металл «без металла» → «Белое золото 750»/.test(з.details || з.text || '')),
    Array.isArray(записи) ? записи.slice(0, 3).map(з => з.details || з.text) : журнал);

  console.log('\n=== 5. Белое золото без пробы — проставить пробу ===');
  r = await админ.зов('POST', '/api/products', { sku: МЕТКА + '-бп', metal: 'Белое золото', weight: 1 });
  группа = (await строки()).find(m => m.metal_raw === 'Белое золото' && m.fineness_raw === '');
  check('группа «Белое золото» без пробы видна с подсказкой «750»', группа && группа.fix && группа.fix.fineness === '750', группа);
  r = await админ.зов('POST', '/api/products/fix-metal', { metal: 'Белое золото', fineness: '' });
  check('проба проставлена', r.status === 200
    && (await админ.зов('GET', '/api/products?search=' + encodeURIComponent(МЕТКА + '-бп'))).data.items[0].fineness === '750');

  console.log('\n=== 6. Стёрли в настройках — ничего не подставляем ===');
  r = await админ.зов('PUT', '/api/settings', { default_metal: '', default_fineness: '' });
  s = (await админ.зов('GET', '/api/settings')).data;
  check('пустые значения сохраняются пустыми, а не возвращаются к белому золоту',
    r.status === 200 && s.default_metal === '' && s.default_fineness === '', [s.default_metal, s.default_fineness]);
  await админ.зов('POST', '/api/products', { sku: МЕТКА + '-пусто', weight: 1 });
  группа = (await строки()).find(m => m.metal_raw === '' && m.fineness_raw === '');
  check('«Без металла» есть, но кнопки нет — не во что исправлять', группа && группа.fix === null, группа);
  r = await админ.зов('PUT', '/api/settings', { default_metal: 'желтое золото', default_fineness: '585 пробы' });
  s = (await админ.зов('GET', '/api/settings')).data;
  check('настройку тоже пишем привычно: «Жёлтое золото», «585»',
    s.default_metal === 'Жёлтое золото' && s.default_fineness === '585', [s.default_metal, s.default_fineness]);
  await админ.зов('PUT', '/api/settings', былиНастройки);
  s = (await админ.зов('GET', '/api/settings')).data;
  check('вернули как было', s.default_metal === былиНастройки.default_metal && s.default_fineness === былиНастройки.default_fineness);
  await админ.зов('POST', '/api/products/fix-metal', { metal: '', fineness: '' });   // прибрали за собой

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
