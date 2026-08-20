'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Приёмка товара от поставщика.
 *
 * До этого приёмки как операции не существовало. Накладная на двадцать изделий
 * превращалась в два несвязанных действия: завести двадцать карточек по одной,
 * а потом отдельно, руками, вписать долг перед поставщиком общей суммой,
 * сложенной в уме.
 *
 * Поэтому здесь проверяется не «сохранились ли карточки», а то, ради чего
 * приёмка сделана: долг появляется САМ и ровно на сумму принятого, накладная
 * помнит свой состав, и половины принятой накладной не бывает никогда.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 240)); }
};
const около = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

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
      if (тело !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(тело);
      }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

const МЕТКА = 'ПРМ' + process.pid;

async function main() {
  const админ = сеанс();
  const продавец = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  if (!await продавец.войти('anna', 'seller123')) { console.error('Продавец не вошёл'); process.exit(2); }

  const поставщик = (await админ.зов('GET', '/api/suppliers')).data.items[0];
  check('поставщик для проверки есть', Boolean(поставщик), поставщик);
  const долг = async () => {
    const r = await админ.зов('GET', '/api/debts/suppliers');
    const п = (r.data.items || []).find(x => x.id === поставщик.id);
    return п ? Number(п.balance) : 0;
  };

  console.log('=== 1. Долг появляется сам и ровно на сумму принятого ===');
  /*
   * Главное, ради чего всё это. Сумма долга больше не держится на том,
   * что кто-то правильно сложил двадцать цифр в уме.
   */
  const доПриёмки = await долг();
  const накладная = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик.id,
    doc_number: МЕТКА + '-415',
    doc_date: '2026-03-03',
    due_date: '2026-04-03',
    items: [
      { sku: МЕТКА + '-1', name: 'Кольцо приёмки', metal: 'Белое золото', fineness: '750',
        weight: 4.2, purchase_price: 100000, retail_price: 165000 },
      { sku: МЕТКА + '-2', name: 'Серьги приёмки', metal: 'Белое золото', fineness: '750',
        weight: 3.1, purchase_price: 60000, retail_price: 99000 },
      { sku: МЕТКА + '-3', name: 'Подвеска приёмки', metal: 'Золото', fineness: '585',
        weight: 2.0, purchase_price: 40000, retail_price: 68000 },
    ],
  });
  check('накладная принята', накладная.status === 200, накладная.data);
  check('изделий столько, сколько прислали', накладная.data.items_count === 3, накладная.data);
  check('сумма посчитана системой, а не человеком',
    около(накладная.data.amount, 200000), накладная.data.amount);
  check('долг перед поставщиком вырос ровно на неё',
    около(await долг(), доПриёмки + 200000), `${await долг()} вместо ${доПриёмки + 200000}`);

  console.log('\n=== 2. Товар встал на склад готовым к продаже ===');
  const первое = (await админ.зов('GET', '/api/products?search=' + МЕТКА + '-1')).data.items[0];
  check('изделие есть в каталоге', Boolean(первое), первое);
  check('оно в наличии', первое && первое.status === 'in_stock', первое && первое.status);
  check('закупочная сохранилась', первое && около(первое.purchase_price, 100000), первое && первое.purchase_price);
  check('цена продажи сохранилась', первое && около(первое.retail_price, 165000), первое && первое.retail_price);
  check('поставщик проставлен', первое && первое.supplier_id === поставщик.id, первое && первое.supplier_id);
  check('металл и проба на месте',
    первое && первое.metal === 'Белое золото' && первое.fineness === '750',
    первое && `${первое.metal} ${первое.fineness}`);

  const продажа = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: первое.id, discount: 0 }], payment_method: 'cash',
  });
  check('принятое изделие сразу продаётся', продажа.status === 200, продажа.data);

  console.log('\n=== 3. Накладная помнит свой состав ===');
  /*
   * Через месяц поставщик приносит свою сверку. Вопрос «что было в накладной
   * от 3 марта» должен иметь ответ, а не «поищите изделия с той же датой».
   */
  const карточка = await админ.зов('GET', '/api/receipts/' + накладная.data.id);
  check('накладная открывается', карточка.status === 200, карточка.data);
  check('в ней все три изделия', (карточка.data.items || []).length === 3,
    (карточка.data.items || []).length);
  check('видно поставщика', карточка.data.supplier_name === поставщик.name, карточка.data.supplier_name);
  check('видно номер накладной', карточка.data.doc_number === МЕТКА + '-415', карточка.data.doc_number);
  check('видно срок оплаты', карточка.data.due_date === '2026-04-03', карточка.data.due_date);

  const журнал = (await админ.зов('GET', '/api/receipts?supplier_id=' + поставщик.id)).data;
  const строка = (журнал.items || []).find(п => п.id === накладная.data.id);
  check('накладная видна в журнале поставок', Boolean(строка), (журнал.items || []).length);
  check('в журнале посчитано, сколько изделий', строка && строка.items_count === 3, строка && строка.items_count);
  check('и сколько из них уже продано', строка && строка.sold_count === 1, строка && строка.sold_count);

  console.log('\n=== 4. Половины накладной не бывает ===');
  /*
   * Худшее из состояний: половина товара на полке, а в системе её нет.
   * Ошибка в последней строке обязана отменить всю приёмку целиком.
   */
  const доСбоя = await долг();
  const сбой = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик.id,
    items: [
      { sku: МЕТКА + '-ok', name: 'Хорошая строка', purchase_price: 50000, retail_price: 80000 },
      { sku: МЕТКА + '-bad', name: 'Плохая строка', purchase_price: 0, retail_price: 80000 },
    ],
  });
  check('накладная с ошибкой отклонена', сбой.status === 400, сбой.data);
  check('и сказано, в какой именно строке',
    сбой.status === 400 && /Строка 2/.test(сбой.data.error || ''), сбой.data);
  check('хорошая строка тоже не прошла — целиком или никак',
    ((await админ.зов('GET', '/api/products?search=' + МЕТКА + '-ok')).data.items || []).length === 0);
  check('долг не изменился', около(await долг(), доСбоя), await долг());

  console.log('\n=== 5. Мусор не принимается ===');
  const мусор = (тело, что) => админ.зов('POST', '/api/receipts', { supplier_id: поставщик.id, ...тело })
    .then(r => check(что, r.status === 400, r.data));
  await мусор({ items: [] }, 'пустая накладная — отказ');
  await мусор({ items: [{ name: 'Без артикула', purchase_price: 1, retail_price: 2 }] },
    'изделие без артикула — отказ');
  await мусор({ items: [{ sku: МЕТКА + '-x', purchase_price: 1, retail_price: 2 }] },
    'изделие без наименования — отказ');
  await мусор({ items: [{ sku: МЕТКА + '-y', name: 'Без цены продажи', purchase_price: 1 }] },
    'изделие без цены продажи — отказ');
  await мусор({ items: [
    { sku: МЕТКА + '-z', name: 'Один', purchase_price: 1, retail_price: 2 },
    { sku: МЕТКА + '-z', name: 'Тот же артикул', purchase_price: 1, retail_price: 2 },
  ] }, 'один артикул дважды в накладной — отказ');
  await мусор({ items: [{ sku: МЕТКА + '-1', name: 'Уже есть', purchase_price: 1, retail_price: 2 }] },
    'артикул, который уже в каталоге, — отказ');
  const безПоставщика = await админ.зов('POST', '/api/receipts',
    { items: [{ sku: МЕТКА + '-q', name: 'Ничей', purchase_price: 1, retail_price: 2 }] });
  check('накладная без поставщика — отказ', безПоставщика.status === 400, безПоставщика.data);

  console.log('\n=== 6. Закупка в долларах ===');
  /*
   * Курс запоминается на момент поставки. Пересчитывать задним числом нельзя:
   * иначе себестоимость и прибыль прошлых месяцев поедут при каждом скачке.
   */
  const валютная = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик.id,
    doc_number: МЕТКА + '-USD',
    items: [{ sku: МЕТКА + '-usd', name: 'Бриллиант за доллары',
      purchase_currency: 'USD', purchase_price_orig: 1000, purchase_rate: 89,
      retail_price: 150000 }],
  });
  check('валютная накладная принята', валютная.status === 200, валютная.data);
  check('закупочная пересчитана в сомы', около(валютная.data.amount, 89000), валютная.data.amount);
  const вДолларах = (await админ.зов('GET', '/api/products?search=' + МЕТКА + '-usd')).data.items[0];
  check('курс запомнен на момент поставки',
    вДолларах && около(вДолларах.purchase_rate, 89), вДолларах && вДолларах.purchase_rate);
  check('цена в долларах тоже сохранена',
    вДолларах && около(вДолларах.purchase_price_orig, 1000), вДолларах && вДолларах.purchase_price_orig);

  console.log('\n=== 7. Реализация: долг не создаётся заранее ===');
  /*
   * Чужой товар мы оплачиваем только после продажи. Записать долг сейчас
   * значило бы показать владельцу чужие обязательства как свои.
   */
  const доРеализации = await долг();
  const чужое = await админ.зов('POST', '/api/receipts', {
    supplier_id: поставщик.id,
    ownership: 'consignment',
    items: [{ sku: МЕТКА + '-real', name: 'Чужое кольцо', purchase_price: 70000, retail_price: 120000 }],
  });
  check('товар на реализации принят', чужое.status === 200, чужое.data);
  check('долг при этом НЕ появился', около(await долг(), доРеализации),
    `${await долг()} вместо ${доРеализации}`);
  const чужоеИзделие = (await админ.зов('GET', '/api/products?search=' + МЕТКА + '-real')).data.items[0];
  check('изделие помечено как чужое',
    чужоеИзделие && чужоеИзделие.ownership === 'consignment', чужоеИзделие && чужоеИзделие.ownership);

  const продажаЧужого = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: чужоеИзделие.id, discount: 0 }], payment_method: 'cash',
  });
  check('чужое изделие продаётся', продажаЧужого.status === 200, продажаЧужого.data);
  check('и вот теперь долг появился — на закупочную',
    около(await долг(), доРеализации + 70000), `${await долг()} вместо ${доРеализации + 70000}`);

  console.log('\n=== 8. Приёмка — дело владельца ===');
  check('продавцу приёмка закрыта',
    (await продавец.зов('POST', '/api/receipts', { supplier_id: поставщик.id,
      items: [{ sku: МЕТКА + '-s', name: 'Своё', purchase_price: 1, retail_price: 2 }] })).status === 403);
  check('и журнал поставок тоже',
    (await продавец.зов('GET', '/api/receipts')).status === 403);
  check('и состав накладной',
    (await продавец.зов('GET', '/api/receipts/' + накладная.data.id)).status === 403);

  console.log('\n=== 9. В журнале действий видно, кто и что принял ===');
  const действия = (await админ.зов('GET', '/api/audit?action=invoice&limit=20')).data;
  const след = ((действия || {}).items || []).find(з => String(з.details).includes(МЕТКА + '-415'));
  check('приёмка записана в журнал', Boolean(след),
    ((действия || {}).items || []).map(з => з.details).slice(0, 3));
  check('в записи видно сумму и количество',
    след && /изделий 3/.test(след.details) && /200/.test(след.details), след && след.details);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
