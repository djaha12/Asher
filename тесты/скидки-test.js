'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Потолок скидки.
 *
 * До этого скидка ограничивалась только ценой изделия: продавец мог поставить
 * скидку ровно в цену и отдать кольцо за ноль — система бы не возразила.
 * Это не только про нечестность: точно так же выглядит опечатка, когда вместо
 * 5 000 набирают 50 000 на изделии за 52 000.
 *
 * Здесь проверяется, что дыра закрыта и закрыта целиком — вместе с обходными
 * путями. Их три, и каждый обходной путь тише прямого: завести клиенту личную
 * скидку 90%, прислать номер комплекта к обычному изделию, поставить скидку
 * не на позицию, а на весь чек.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};
const около = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

function сеанс() {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const r = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  const продавец = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  if (!await продавец.войти('anna', 'seller123')) { console.error('Продавец не вошёл'); process.exit(2); }

  /*
   * Свободные изделия берём по мере надобности: их разбирают и другие наборы.
   * Все с одной точки продаж — иначе комплект из них не собрать: система
   * справедливо не даёт объединить в гарнитур кольцо из одного магазина
   * и серьги из другого. Изделия, уже занятые чужим комплектом, тоже мимо:
   * в общем прогоне гарнитуры собирают и другие наборы.
   */
  const склад = [];
  const взято = new Set();
  let точка = null;
  async function изделие() {
    while (!склад.length) {
      const r = await админ.зов('GET', '/api/products?status=in_stock&limit=100');
      const все = ((r.data || {}).items || [])
        .filter(p => p.status === 'in_stock' && p.retail_price > 1000
          && !p.set_id && !взято.has(p.id));
      /*
       * Точку выбираем не первую попавшуюся, а самую полную. Демо-данные
       * раскладывают товар по точкам случайно, и на первой могло оказаться
       * три изделия — набор падал бы через раз не по делу.
       */
      if (точка === null && все.length) {
        const поТочкам = new Map();
        for (const p of все) поТочкам.set(p.store_id, (поТочкам.get(p.store_id) || 0) + 1);
        точка = [...поТочкам.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      const свежие = все.filter(p => p.store_id === точка);
      if (!свежие.length) throw new Error('на складе не осталось изделий для проверки');
      склад.push(...свежие);
    }
    const p = склад.shift();
    взято.add(p.id);
    return p;
  }

  const предел = async () => Number((await админ.зов('GET', '/api/settings')).data.max_discount_percent);
  const поставитьПредел = п => админ.зов('PUT', '/api/settings', { max_discount_percent: п });

  console.log('=== 1. Предел есть с самого начала ===');
  /*
   * Настройку нельзя вводить «выключенной по умолчанию»: дыру закрывает
   * не наличие поля, а значение в нём. База, которая работала до появления
   * потолка, должна получить его при первом же запуске.
   */
  check('предел скидки задан', (await предел()) > 0, await предел());
  const базовыйПредел = await предел();

  const наПродавца = (await продавец.зов('GET', '/api/settings')).data;
  check('продавец тоже видит предел',
    Number(наПродавца.max_discount_percent) === базовыйПредел, наПродавца.max_discount_percent);
  check('но закупочную кухню — по-прежнему нет',
    наПродавца.usd_rate === undefined, Object.keys(наПродавца).join(','));

  console.log('\n=== 2. Продажа за ноль — то, ради чего всё это ===');
  const бесплатно = await изделие();
  const попытка = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: бесплатно.id, discount: бесплатно.retail_price }],
    payment_method: 'cash',
  });
  check('продавец не может отдать изделие даром', попытка.status === 400, попытка.data);
  check('и ему объяснили, почему и что делать',
    попытка.status === 400 && /владелец/i.test(попытка.data.error || ''), попытка.data);
  const наМесте = (await админ.зов('GET', '/api/products/' + бесплатно.id)).data;
  check('изделие осталось на складе', наМесте.status === 'in_stock', наМесте.status);

  console.log('\n=== 3. Обычная скидка проходит ===');
  const обычное = await изделие();
  const скидкаВПределе = Math.floor(обычное.retail_price * (базовыйПредел - 1) / 100);
  const норма = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: обычное.id, discount: скидкаВПределе }],
    payment_method: 'cash',
  });
  check('скидка внутри предела оформляется', норма.status === 200, норма.data);
  check('сумма чека посчитана со скидкой',
    норма.status === 200 && около(норма.data.total, обычное.retail_price - скидкаВПределе),
    норма.data && норма.data.total);

  console.log('\n=== 4. Ровно на пределе — можно, на копейку больше — нет ===');
  /*
   * Граница проверяется отдельно, потому что ошибаются именно на ней: строгое
   * сравнение вместо нестрогого превращает «до 15%» в «до 14,99%», и продавец
   * упирается в отказ там, где всё по правилам.
   */
  const ровно = await изделие();
  const наПределе = Math.round(ровно.retail_price * базовыйПредел) / 100;
  const край = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: ровно.id, discount: наПределе }], payment_method: 'cash',
  });
  check('скидка ровно в предел проходит', край.status === 200, край.data);

  const чутьБольше = await изделие();
  const перебор = Math.round(чутьБольше.retail_price * (базовыйПредел + 0.5)) / 100;
  const отказ = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: чутьБольше.id, discount: перебор }], payment_method: 'cash',
  });
  check('на полпроцента больше — отказ', отказ.status === 400, отказ.data);

  console.log('\n=== 5. Владелец не ограничен, но остаётся след ===');
  /*
   * Владелец — хозяин денег, запрещать ему нечего. Но через полгода, разбирая
   * «почему в марте просела прибыль», он должен увидеть, что скидку дали
   * тогда-то и вот такую, а не гадать.
   */
  const хозяйское = await изделие();
  const большая = Math.round(хозяйское.retail_price * 0.6);
  const хозяин = await админ.зов('POST', '/api/sales', {
    items: [{ product_id: хозяйское.id, discount: большая }], payment_method: 'cash',
  });
  check('владелец проводит скидку 60%', хозяин.status === 200, хозяин.data);

  const журнал = (await админ.зов('GET', '/api/audit?action=discount&limit=20')).data;
  const след = ((журнал || {}).items || []).find(з => String(з.details).includes(хозяин.data.number));
  check('в журнале есть отдельная строка про такую скидку', Boolean(след),
    ((журнал || {}).items || []).map(з => з.details).slice(0, 3));
  check('в ней видно, на что и сколько',
    след && след.details.includes(хозяйское.name), след && след.details);
  check('обычная продажа в этот список не попадает',
    !((журнал || {}).items || []).some(з => String(з.details).includes(норма.data.number)));

  console.log('\n=== 6. Личная скидка клиента поднимает предел ===');
  /*
   * Постоянному покупателю владелец назначает личную скидку. Если бы касса
   * упиралась в общий предел, продавец звал бы владельца при каждой такой
   * продаже — и потолок сняли бы в первую же неделю.
   */
  const выше = Math.min(базовыйПредел + 10, 60);
  const клиент = await админ.зов('POST', '/api/customers',
    { name: 'Постоянный покупатель (проверка)', discount: выше });
  check('владелец завёл клиента с личной скидкой', клиент.status === 200, клиент.data);

  const личное = await изделие();
  const поЛичной = Math.round(личное.retail_price * выше) / 100;
  const сЛичной = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: личное.id, discount: поЛичной }],
    customer_id: клиент.data.id, payment_method: 'cash',
  });
  check('продавец проводит личную скидку клиента', сЛичной.status === 200, сЛичной.data);

  const чужое = await изделие();
  const безКлиента = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: чужое.id, discount: Math.round(чужое.retail_price * выше) / 100 }],
    payment_method: 'cash',
  });
  check('без этого клиента такая же скидка уже не проходит', безКлиента.status === 400, безКлиента.data);

  console.log('\n=== 7. Обход через личную скидку закрыт ===');
  /*
   * Иначе потолок обходился бы за десять секунд: завести клиента «Иван»
   * со скидкой 90% и продать ему.
   */
  const самому = await продавец.зов('POST', '/api/customers',
    { name: 'Свой человек (проверка)', discount: 90 });
  check('продавец не может завести клиенту скидку 90%', самому.status === 400, самому.data);
  check('и объяснение понятное',
    самому.status === 400 && /владелец/i.test(самому.data.error || ''), самому.data);

  const правка = await продавец.зов('PUT', '/api/customers/' + клиент.data.id, { discount: 95 });
  check('и поднять её у существующего клиента тоже не может', правка.status === 400, правка.data);
  check('скидка клиента не изменилась',
    около((await админ.зов('GET', '/api/customers/' + клиент.data.id)).data.discount, выше));

  const скромно = await продавец.зов('POST', '/api/customers',
    { name: 'Обычный клиент (проверка)', discount: Math.min(базовыйПредел, 100) });
  check('но скидку в пределах разрешённого — может', скромно.status === 200, скромно.data);

  console.log('\n=== 8. Комплект продаётся по цене владельца ===');
  /*
   * Комплект — это цена, которую назначил владелец, и она может быть заметно
   * ниже суммы ценников. Продавец обязан суметь его продать, не зовя хозяина.
   */
  const а1 = await изделие();
  const а2 = await изделие();
  const суммаЦенников = а1.retail_price + а2.retail_price;
  const комплект = await админ.зов('POST', '/api/sets', {
    name: 'Гарнитур (проверка скидок)',
    product_ids: [а1.id, а2.id],
    price: Math.round(суммаЦенников * 0.6),          // скидка 40% — глубже предела
  });
  check('комплект создан', комплект.status === 200, JSON.stringify(комплект.data));
  const позиции = (комплект.data || {}).items || [];
  check('система разложила скидку по изделиям',
    позиции.some(п => п.sale_discount > 0), позиции.map(п => п.sale_discount));

  const продажаКомплекта = await продавец.зов('POST', '/api/sales', {
    items: позиции.map(п => ({ product_id: п.id, discount: п.sale_discount, set_id: комплект.data.id })),
    payment_method: 'cash',
  });
  check('продавец продаёт комплект по цене владельца',
    продажаКомплекта.status === 200, продажаКомплекта.data);
  check('сумма чека равна цене комплекта',
    продажаКомплекта.status === 200 && около(продажаКомплекта.data.total, комплект.data.price),
    продажаКомплекта.data && продажаКомплекта.data.total);

  console.log('\n=== 9. Обход через номер комплекта закрыт ===');
  /*
   * Самый тихий обходной путь: к обычному изделию приложить номер настоящего
   * комплекта и любую скидку. Поэтому раскладку комплекта сервер пересчитывает
   * заново и сверяет с присланной, а не верит на слово.
   */
  const б1 = await изделие();
  const б2 = await изделие();
  const комплект2 = await админ.зов('POST', '/api/sets', {
    name: 'Гарнитур (проверка обхода)',
    product_ids: [б1.id, б2.id],
    price: Math.round((б1.retail_price + б2.retail_price) * 0.7),
  });
  check('второй комплект создан', комплект2.status === 200, JSON.stringify(комплект2.data));

  const постороннее = await изделие();
  const подлог = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: постороннее.id,
      discount: постороннее.retail_price, set_id: комплект2.data.id }],
    payment_method: 'cash',
  });
  check('чужое изделие с номером комплекта не проходит', подлог.status === 400, подлог.data);

  const свои = (комплект2.data || {}).items || [];
  check('состав второго комплекта известен', свои.length >= 2, свои.length);
  const жадно = await продавец.зов('POST', '/api/sales', {
    items: свои.map(п => ({
      product_id: п.id,
      discount: Math.min(п.retail_price, п.sale_discount + Math.round(п.retail_price * 0.3)),
      set_id: комплект2.data.id,
    })),
    payment_method: 'cash',
  });
  check('скидка глубже цены комплекта не проходит', жадно.status === 400, жадно.data);
  check('изделия комплекта остались на складе',
    (await админ.зов('GET', '/api/products/' + б1.id)).data.status === 'in_stock');

  console.log('\n=== 10. Обмен считается по тем же правилам ===');
  /*
   * Обмен создаёт обычный чек, только оплаченный зачётом. Если бы проверка
   * стояла в обработчике продажи, а не в общем месте, через обмен прошло бы
   * что угодно.
   */
  const дляОбмена = await изделие();
  const чекОбмена = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: дляОбмена.id, discount: 0 }], payment_method: 'cash',
  });
  check('исходный чек оформлен', чекОбмена.status === 200, чекОбмена.data);
  const взамен = await изделие();
  const обмен = await продавец.зов('POST', `/api/sales/${чекОбмена.data.id}/exchange`, {
    return_item_ids: [чекОбмена.data.items[0].id],
    items: [{ product_id: взамен.id, discount: взамен.retail_price }],
  });
  check('при обмене отдать даром тоже нельзя', обмен.status === 400, обмен.data);
  check('старое изделие не ушло в возврат',
    (await админ.зов('GET', '/api/products/' + дляОбмена.id)).data.status === 'sold');

  console.log('\n=== 11. Владелец меняет предел, и он действует сразу ===');
  check('предел поднят до 40%', (await поставитьПредел(40)).status === 200);
  const послеПодъёма = await изделие();
  const щедро = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: послеПодъёма.id, discount: Math.round(послеПодъёма.retail_price * 0.35) }],
    payment_method: 'cash',
  });
  check('теперь 35% продавцу можно', щедро.status === 200, щедро.data);

  check('предел опущен до нуля', (await поставитьПредел(0)).status === 200);
  const безСкидок = await изделие();
  const любая = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: безСкидок.id, discount: 100 }], payment_method: 'cash',
  });
  check('при нуле никакая скидка не проходит', любая.status === 400, любая.data);
  const безСкидки = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: безСкидок.id, discount: 0 }], payment_method: 'cash',
  });
  check('а продажа без скидки идёт как обычно', безСкидки.status === 200, безСкидки.data);

  console.log('\n=== 12. Смена предела видна в журнале ===');
  const журналНастроек = (await админ.зов('GET', '/api/audit?action=update&limit=40')).data;
  check('изменение предела записано цифрами',
    ((журналНастроек || {}).items || []).some(з => /Предел скидки/.test(з.details || '')),
    ((журналНастроек || {}).items || []).map(з => з.details).slice(0, 4));

  console.log('\n=== 13. Мусор в настройке не принимается ===');
  check('пустое поле — отказ',
    (await поставитьПредел('')).status === 400);
  check('текст — отказ', (await поставитьПредел('много')).status === 400);
  check('отрицательное — отказ', (await поставитьПредел(-5)).status === 400);
  check('больше ста — отказ', (await поставитьПредел(150)).status === 400);
  check('предел от мусора не пострадал', (await предел()) === 0, await предел());

  console.log('\n=== 14. Обход через ценник закрыт ===');
  /*
   * Самая дорогая находка за всю работу над потолком, и найдена она была
   * уже ПОСЛЕ того, как потолок объявили готовым.
   *
   * Потолок считает процент от цены по ценнику. Пока продавец мог сам
   * поставить этому ценнику любое число, весь потолок обходился одним
   * запросом: открыть карточку кольца за 214 500, написать цену 1 000
   * и продать без всякой скидки — ноль процентов, всё по правилам.
   *
   * Поэтому здесь проверяется не только отказ, но и то, что продавцу
   * оставили его работу: резерв, описание, размер. Запрет, из-за которого
   * нельзя работать, снимут в первую же неделю.
   */
  const сЦенником = await изделие();
  const правкаЦены = await продавец.зов('PUT', '/api/products/' + сЦенником.id,
    { retail_price: 1000 });
  check('продавец не может переписать ценник', правкаЦены.status === 403, правкаЦены.data);
  check('и ему сказано, что делать вместо этого',
    правкаЦены.status === 403 && /скидка/i.test(правкаЦены.data.error || ''), правкаЦены.data);
  check('ценник не изменился',
    около((await админ.зов('GET', '/api/products/' + сЦенником.id)).data.retail_price,
      сЦенником.retail_price));

  check('и списать изделие продавец не может',
    (await продавец.зов('PUT', '/api/products/' + сЦенником.id,
      { status: 'written_off', write_off_reason: 'разбилось' })).status === 403);
  check('изделие осталось на витрине',
    (await админ.зов('GET', '/api/products/' + сЦенником.id)).data.status === 'in_stock');

  // А это его ежедневная работа, и она обязана идти без спроса у владельца.
  const покупатель = (await админ.зов('GET', '/api/customers?limit=1')).data.items[0];
  check('резерв за клиентом продавец ставит сам',
    (await продавец.зов('PUT', '/api/products/' + сЦенником.id,
      { status: 'reserved', reserved_for: покупатель.id, reserved_until: '2030-01-01' })).status === 200);
  check('и снимает сам',
    (await продавец.зов('PUT', '/api/products/' + сЦенником.id,
      { status: 'in_stock', reserved_for: null })).status === 200);
  check('описание и размер правит сам',
    (await продавец.зов('PUT', '/api/products/' + сЦенником.id,
      { description: 'потёртость на ободке', size: '17' })).status === 200);
  /*
   * Форма изделия присылает поля целиком, включая неизменившуюся цену.
   * Если ругаться и на неё, карточка станет нередактируемой вовсе — а это
   * ровно тот случай, когда запрет отменяют, потому что мешает работать.
   */
  check('неизменившаяся цена в форме сохранить не мешает',
    (await продавец.зов('PUT', '/api/products/' + сЦенником.id,
      { retail_price: сЦенником.retail_price, description: 'ещё правка' })).status === 200);

  console.log('\n=== 15. Продавец не может поднять предел сам ===');
  check('настройки ему на запись закрыты',
    (await продавец.зов('PUT', '/api/settings', { max_discount_percent: 100 })).status === 403);
  check('предел прежний', (await предел()) === 0, await предел());

  // Возвращаем как было: набор идёт по общей базе, следующим он должен
  // достаться в обычном состоянии, а не с запретом скидок.
  await поставитьПредел(базовыйПредел);
  check('предел возвращён на место', (await предел()) === базовыйПредел, await предел());

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
