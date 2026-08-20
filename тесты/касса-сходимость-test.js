'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Сверка кассы: ящик обязан сходиться на КАЖДОМ виде операции.
 *
 * Набор появился после того, как сверка, объявленная готовой, начала врать
 * на самых обычных вещах — и врать в худшую сторону: она показывала недостачу
 * там, где всё сходилось. Продавца обвиняют в воровстве за честно оформленный
 * обмен; после второго такого разговора сверкой перестают пользоваться вовсе,
 * и весь смысл теряется.
 *
 * Поэтому здесь проверяется не арифметика в вакууме, а каждый путь, которым
 * деньги входят в ящик и выходят из него. Правило одно: если денег в ящике
 * не двигалось — «ожидается» не должно измениться ни на сом.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
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

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }

  const ожид = async () => (await админ.зов('GET', '/api/cash/expected')).data['ожидается'];
  // Точка отсчёта: без неё сверке не с чем сравнивать, и она честно молчит.
  await админ.зов('POST', '/api/cash/count', { counted: 500000, note: 'начало проверки' });

  const склад = [];
  const взято = new Set();
  async function изделие(дорогое) {
    if (!склад.length) {
      const r = await админ.зов('GET', '/api/products?status=in_stock&limit=100');
      склад.push(...((r.data || {}).items || [])
        .filter(p => p.status === 'in_stock' && p.retail_price > 1000 && !взято.has(p.id))
        .sort((a, b) => b.retail_price - a.retail_price));
      if (!склад.length) throw new Error('на складе не осталось изделий для проверки');
    }
    const p = дорогое ? склад.shift() : склад.pop();
    взято.add(p.id);
    return p;
  }
  const { data: клиенты } = await админ.зов('GET', '/api/customers?limit=1');
  const клиент = клиенты.items[0];

  console.log('=== 1. Обмен: в ящик попадает только доплата ===');
  /*
   * Самая дорогая ошибка из найденных. При обмене клиент рассчитывается
   * старым изделием: в платежах это законная строка, но живых денег не
   * приходило. Пока такая строка считалась наличными, каждый обмен вечером
   * давал недостачу ровно на цену зачтённого изделия.
   */
  const дорогое = await изделие(true);
  const дешёвое = await изделие(false);
  const доПродажи = await ожид();
  const чек = await админ.зов('POST', '/api/sales',
    { items: [{ product_id: дорогое.id, discount: 0 }], payment_method: 'cash' });
  check('продажа наличными оформлена', чек.status === 200, чек.data);
  const послеПродажи = await ожид();
  // Считаем от того, что было, а не от круглого числа: набор гоняется
  // и по уже пожившей базе, где до нас успели наторговать.
  check('ящик вырос ровно на сумму чека',
    около(послеПродажи - доПродажи, чек.data.total),
    `+${послеПродажи - доПродажи} вместо +${чек.data.total}`);

  const обмен = await админ.зов('POST', `/api/sales/${чек.data.id}/exchange`, {
    return_item_ids: [чек.data.items[0].id],
    items: [{ product_id: дешёвое.id, discount: 0 }], extra_paid: 0,
  });
  check('обмен оформлен', обмен.status === 200, обмен.data);
  const наРуки = дорогое.retail_price - дешёвое.retail_price;
  check('из ящика ушла только разница, выданная на руки',
    около(await ожид(), послеПродажи - наРуки),
    `${await ожид()} вместо ${послеПродажи - наРуки}`);

  console.log('\n=== 2. Обмен с доплатой: в ящик приходит только доплата ===');
  // Меняем дешёвое на дорогое: клиент доплачивает разницу, и ровно эта
  // разница — единственные живые деньги во всей операции.
  const а = await изделие(false);
  const чекА = await админ.зов('POST', '/api/sales',
    { items: [{ product_id: а.id, discount: 0 }], payment_method: 'cash' });
  const доРовного = await ожид();
  const б = await изделие(true);
  const доплата = б.retail_price - а.retail_price;
  check('на замену взято изделие дороже', доплата > 0, доплата);
  const ровный = await админ.зов('POST', `/api/sales/${чекА.data.id}/exchange`, {
    return_item_ids: [чекА.data.items[0].id],
    items: [{ product_id: б.id, discount: 0 }], extra_paid: доплата,
  });
  check('обмен с доплатой оформлен', ровный.status === 200, ровный.data);
  check('ящик вырос ровно на доплату',
    около(await ожид(), доРовного + доплата), `${await ожид()} вместо ${доРовного + доплата}`);

  console.log('\n=== 3. Карта ящика не касается — ни продажей, ни возвратом ===');
  /*
   * Возврат раньше всегда записывался наличными, независимо от того, чем
   * платили. Возврат по карточному чеку на 286 500 давал ровно такую же
   * недостачу — на всю сумму чека.
   */
  const картой = await изделие(true);
  const доКарты = await ожид();
  const чекК = await админ.зов('POST', '/api/sales',
    { items: [{ product_id: картой.id, discount: 0 }], payment_method: 'card' });
  check('продажа картой ящик не тронула', около(await ожид(), доКарты), await ожид());
  const возврат = await админ.зов('POST', `/api/sales/${чекК.data.id}/return`,
    { item_ids: [чекК.data.items[0].id] });
  check('возврат оформлен', возврат.status === 200, возврат.data);
  check('и возврат по карте ящик тоже не тронул',
    около(await ожид(), доКарты), `${await ожид()} вместо ${доКарты}`);

  console.log('\n=== 4. Возврат по наличному чеку деньги из ящика забирает ===');
  const налом = await изделие(false);
  const доНала = await ожид();
  const чекН = await админ.зов('POST', '/api/sales',
    { items: [{ product_id: налом.id, discount: 0 }], payment_method: 'cash' });
  await админ.зов('POST', `/api/sales/${чекН.data.id}/return`,
    { item_ids: [чекН.data.items[0].id] });
  check('продали и вернули наличными — ящик вернулся к прежнему',
    около(await ожид(), доНала), `${await ожид()} вместо ${доНала}`);

  console.log('\n=== 5. Заказы и ремонт ===');
  /*
   * Раньше оплата заказа писалась только в финансовые операции, а сверка
   * такие строки пропускала. Предоплата за ремонт ложилась в ящик, система
   * её не видела — и вечером получалась недостача ровно на принятую сумму.
   * При этом те же деньги, принятые через раздел «Долги», в сверку попадали:
   * одни и те же деньги были видны или нет в зависимости от нажатой кнопки.
   */
  const доЗаказа = await ожид();
  const заказ = await админ.зов('POST', '/api/orders', {
    type: 'repair', customer_id: клиент.id, description: 'проверка сверки',
    estimate: 20000, prepayment: 5000,
  });
  check('заказ принят с предоплатой', заказ.status === 200, заказ.data);
  check('предоплата наличными легла в ящик',
    около((await ожид()) - доЗаказа, 5000), (await ожид()) - доЗаказа);

  const доплатаЗаказа = await админ.зов('POST', `/api/orders/${заказ.data.id}/payment`,
    { amount: 3000 });
  check('доплата принята', доплатаЗаказа.status === 200, доплатаЗаказа.data);
  check('и она тоже в ящике', около((await ожид()) - доЗаказа, 8000), (await ожид()) - доЗаказа);

  const переводом = await админ.зов('POST', '/api/orders', {
    type: 'repair', customer_id: клиент.id, description: 'проверка перевода',
    estimate: 10000, prepayment: 4000, method: 'transfer',
  });
  check('заказ с предоплатой переводом принят', переводом.status === 200, переводом.data);
  check('перевод в ящик не попал', около((await ожид()) - доЗаказа, 8000), (await ожид()) - доЗаказа);

  console.log('\n=== 6. Отмена заказа возвращает деньги — и только один раз ===');
  const доОтмены = await ожид();
  const отмена = await админ.зов('POST', `/api/orders/${заказ.data.id}/status`,
    { status: 'cancelled' });
  check('заказ отменён', отмена.status === 200, отмена.data);
  check('8 000 вернулись клиенту из ящика',
    около((await ожид()) - доОтмены, -8000), (await ожид()) - доОтмены);
  const послеОтмены = await ожид();
  /*
   * Через интерфейс кнопка после отмены прячется, но два планшета с открытой
   * карточкой заказа — обычное дело в магазине с шестью продавцами. Раньше
   * каждое повторное нажатие записывало возврат заново.
   */
  await админ.зов('POST', `/api/orders/${заказ.data.id}/status`, { status: 'cancelled' });
  await админ.зов('POST', `/api/orders/${заказ.data.id}/status`, { status: 'cancelled' });
  check('повторная отмена денег не возвращает',
    около(await ожид(), послеОтмены), `${await ожид()} вместо ${послеОтмены}`);
  check('и за заказом больше ничего не числится',
    около((await админ.зов('GET', '/api/orders/' + заказ.data.id)).data.paid, 0),
    (await админ.зов('GET', '/api/orders/' + заказ.data.id)).data.paid);

  console.log('\n=== 7. Расчёты с поставщиком ===');
  /*
   * Оплата поставщику записывалась наличной всегда, даже переводом. Для
   * ювелирки это самая крупная регулярная сумма — сверка каждый раз
   * показывала огромный излишек в ящике, которого там не было.
   */
  const поставщик = (await админ.зов('GET', '/api/debts/suppliers')).data.items[0];
  check('поставщик для проверки есть', Boolean(поставщик), поставщик);
  const доПоставщика = await ожид();
  await админ.зов('POST', `/api/debts/suppliers/${поставщик.id}/ops`,
    { type: 'payment', amount: 120000, method: 'transfer' });
  check('перевод поставщику ящик не тронул',
    около(await ожид(), доПоставщика), `${await ожид()} вместо ${доПоставщика}`);
  await админ.зов('POST', `/api/debts/suppliers/${поставщик.id}/ops`,
    { type: 'payment', amount: 30000, method: 'cash' });
  check('а наличная оплата ящик уменьшила',
    около((await ожид()) - доПоставщика, -30000), (await ожид()) - доПоставщика);

  console.log('\n=== 8. Погашение долга клиентом ===');
  const вДолг = await изделие(false);
  const доДолга = await ожид();
  const чекД = await админ.зов('POST', '/api/sales', {
    items: [{ product_id: вДолг.id, discount: 0 }], customer_id: клиент.id,
    payment_method: 'installment', paid: 0, due_date: '2030-01-01',
  });
  check('продажа в долг оформлена', чекД.status === 200, чекД.data);
  check('в ящик при этом ничего не легло', около(await ожид(), доДолга), await ожид());
  await админ.зов('POST', '/api/debts/payments',
    { sale_id: чекД.data.id, amount: 7000, method: 'cash' });
  check('погашение наличными в ящик легло',
    около((await ожид()) - доДолга, 7000), (await ожид()) - доДолга);
  await админ.зов('POST', '/api/debts/payments',
    { sale_id: чекД.data.id, amount: 5000, method: 'card' });
  check('погашение картой — нет',
    около((await ожид()) - доДолга, 7000), (await ожид()) - доДолга);

  console.log('\n=== 9. Сверка после всего этого сходится ===');
  /*
   * Итог всей работы: продавец пересчитывает ящик, вводит ровно то, что
   * система ожидает, и видит «сошлось». Если хоть одна операция выше
   * посчитана неверно, здесь вылезет расхождение.
   */
  const ожидается = await ожид();
  const сверка = await админ.зов('POST', '/api/cash/count', { counted: ожидается });
  check('сверка записана', сверка.status === 200, сверка.data);
  check('расхождения нет', сверка.status === 200 && около(сверка.data['разница'], 0),
    сверка.data && сверка.data['разница']);
  check('и названо это «сошлось»',
    сверка.status === 200 && /сош/i.test(сверка.data['словами'] || ''),
    сверка.data && сверка.data['словами']);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
