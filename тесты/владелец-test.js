'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Владельцу: скидка по разрешению, новое устройство одним нажатием, сводка.
 *
 *   — продавец просит скидку сверх предела, владелец разрешает или отказывает;
 *     разрешение — только этому продавцу, только на эти изделия, не больше
 *     разрешённого и один раз; снятый запрос не разрешить;
 *   — просьба войти с нового устройства приходит на Главную поимённо и с
 *     кодом, и Главная владельца узнаёт о ней сама;
 *   — сводка за день сходится с тем, что за день случилось; продавцу её не видно.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

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
const МЕТКА = 'Влад' + process.pid;
const около = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

function сеанс(устройство) {
  let cookie = '';
  return {
    async войти(логин, пароль) {
      const headers = { 'Content-Type': 'application/json' };
      if (устройство) headers['X-Asher-Device'] = устройство;
      const r = await fetch(BASE + '/api/login', {
        method: 'POST', headers, body: JSON.stringify({ username: логин, password: пароль }),
      });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    },
    async зов(метод, путь, тело) {
      const opts = { method: метод, headers: { Cookie: cookie } };
      if (устройство) opts.headers['X-Asher-Device'] = устройство;
      if (тело !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(тело); }
      const r = await fetch(BASE + путь, opts);
      let data = null;
      try { data = await r.json(); } catch { /* пусто */ }
      return { status: r.status, data };
    },
  };
}

async function main() {
  const админ = сеанс();
  const я = (await админ.войти('admin', 'admin123')).data.user;
  const анна = сеанс();
  await анна.войти('anna', 'seller123');
  const михаил = сеанс();
  await михаил.войти('mikhail', 'seller123');
  if (!я) { console.error('Не удалось войти'); process.exit(2); }
  const предел = Number((await админ.зов('GET', '/api/settings')).data.max_discount_percent) || 15;
  const изделие = async (n, цена) => (await админ.зов('POST', '/api/products', {
    sku: `${МЕТКА}-${n}`, name: `Кольцо ${n} для проверки`, metal: 'Золото', retail_price: цена, purchase_price: цена / 3,
  })).data.id;
  const кольцо = await изделие(1, 100000);
  const серьги = await изделие(2, 50000);
  const скидка = Math.round(100000 * (предел + 15) / 100);   // заведомо сверх предела

  console.log(`=== 1. Скидка сверх предела (${предел}%) — по разрешению ===`);
  let r = await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо, discount: скидка }], payment_method: 'cash' });
  check('без разрешения — отказ, как и раньше', r.status === 400, r.data);
  check('в пределах просить незачем', (await анна.зов('POST', '/api/discount-requests',
    { items: [{ product_id: кольцо, discount: 1000 }] })).status === 400);
  check('владельцу просить не нужно', (await админ.зов('POST', '/api/discount-requests',
    { items: [{ product_id: кольцо, discount: скидка }] })).status === 400);
  r = await анна.зов('POST', '/api/discount-requests',
    { items: [{ product_id: кольцо, discount: скидка }], note: 'постоянная клиентка' });
  check('Анна просит', r.status === 200 && r.data.status === 'pending', r.data);
  const запрос = r.data.id;
  check('Михаил чужой запрос не видит', (await михаил.зов('GET', '/api/discount-requests/' + запрос)).status === 404);
  const ждут = (await админ.зов('GET', '/api/discount-requests?status=pending')).data.items;
  const уВладельца = ждут.find(з => з.id === запрос);
  check('владелец видит: кто, что, сколько процентов и почему', уВладельца && уВладельца.user_name === 'Анна Соколова'
    && уВладельца.items[0].percent === предел + 15 && уВладельца.note === 'постоянная клиентка', уВладельца);
  r = await анна.зов('POST', '/api/sales',
    { items: [{ product_id: кольцо, discount: скидка }], payment_method: 'cash', discount_request_id: запрос });
  check('пока не ответили — продать нельзя', r.status === 400, r.data);
  check('Михаил разрешить не может', (await михаил.зов('POST', `/api/discount-requests/${запрос}/approve`, {})).status === 403);
  r = await админ.зов('POST', `/api/discount-requests/${запрос}/approve`, {});
  check('владелец разрешил', r.status === 200 && r.data.status === 'approved', r.data);
  check('второй раз ответить нельзя', (await админ.зов('POST', `/api/discount-requests/${запрос}/deny`, {})).status === 400);
  check('Анна видит ответ', (await анна.зов('GET', '/api/discount-requests/' + запрос)).data.status === 'approved');

  r = await михаил.зов('POST', '/api/sales',
    { items: [{ product_id: кольцо, discount: скидка }], payment_method: 'cash', discount_request_id: запрос });
  check('чужим разрешением не воспользоваться', r.status === 400, r.data);
  r = await анна.зов('POST', '/api/sales',
    { items: [{ product_id: кольцо, discount: скидка + 1000 }], payment_method: 'cash', discount_request_id: запрос });
  check('больше разрешённого — нельзя', r.status === 400, r.data);
  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: кольцо, discount: скидка }, { product_id: серьги, discount: 25000 }],
    payment_method: 'cash', discount_request_id: запрос,
  });
  check('на изделие, о котором не просили, — нельзя', r.status === 400, r.data);
  r = await анна.зов('POST', '/api/sales',
    { items: [{ product_id: кольцо, discount: скидка }], payment_method: 'cash', discount_request_id: запрос });
  check('по разрешению — продано', r.status === 200, r.data);
  const чек = r.data;
  const использован = (await анна.зов('GET', '/api/discount-requests/' + запрос)).data;
  check('разрешение израсходовано этим чеком', использован.status === 'used' && использован.sale_id === чек.id, использован);
  r = await анна.зов('POST', '/api/sales',
    { items: [{ product_id: серьги, discount: 1000 }], payment_method: 'cash', discount_request_id: запрос });
  check('второй раз то же разрешение не работает', r.status === 400 && /использовано/.test(r.data.error), r.data);
  const журнал = (await админ.зов('GET', '/api/audit?action=discount&limit=5')).data.items;
  check('в журнале: скидка сверх предела по разрешению основателя',
    журнал.some(x => x.details.includes(чек.number) && /по разрешению основателя/.test(x.details)), журнал.slice(0, 2));
  const разрешения = (await админ.зов('GET', '/api/audit?action=discount_approve&limit=5')).data.items;
  check('а кто именно разрешил — в его строке журнала', разрешения.some(x => x.user_name === 'Администратор'
    && /для Анна Соколова/.test(x.details)), разрешения.slice(0, 2));

  const серьги2 = await изделие(3, 50000);
  r = await анна.зов('POST', '/api/discount-requests', { items: [{ product_id: серьги2, discount: 20000 }] });
  const отказной = r.data.id;
  await админ.зов('POST', `/api/discount-requests/${отказной}/deny`, {});
  r = await анна.зов('POST', '/api/sales',
    { items: [{ product_id: серьги2, discount: 20000 }], payment_method: 'cash', discount_request_id: отказной });
  check('отказали — продать с этой скидкой нельзя', r.status === 400, r.data);

  const первый = (await анна.зов('POST', '/api/discount-requests', { items: [{ product_id: серьги2, discount: 20000 }] })).data.id;
  const второй = (await анна.зов('POST', '/api/discount-requests', { items: [{ product_id: серьги2, discount: 22000 }] })).data.id;
  check('новый запрос заменяет неотвеченный', (await анна.зов('GET', '/api/discount-requests/' + первый)).data.status === 'cancelled');
  await анна.зов('DELETE', '/api/discount-requests/' + второй);
  r = await админ.зов('POST', `/api/discount-requests/${второй}/approve`, {});
  check('снятый продавцом запрос не разрешить', r.status === 400 && /снял/.test(r.data.error), r.data);

  console.log('\n=== 2. Новое устройство — на Главной, одним нажатием ===');
  const доРев = (await админ.зов('GET', '/api/changes?since=0')).data;
  const чужойТелефон = сеанс('phone-mikhail-new-' + process.pid);
  r = await чужойТелефон.войти('mikhail', 'seller123');
  check('с нового телефона Михаил ждёт разрешения', r.status !== 200 && r.data.pending_device === true, r.data);
  const код = r.data.code;
  const главная = (await админ.зов('GET', '/api/dashboard?tz=0')).data;
  const просьба = (главная.устройства || []).find(у => у.code === код);
  check('на Главной владельца — Михаил и его код', просьба && просьба.user_name === 'Михаил Орлов', главная.устройства);
  check('тревоги «устройство просится» больше нет — вместо неё строка с кнопками',
    !(главная.тревоги || []).some(т => /просится/.test(т.что)));
  const послеРев = (await админ.зов('GET', '/api/changes?since=' + (доРев.rev || 0))).data;
  check('Главная владельца узнаёт о просьбе сама', (послеРев.что || []).includes('devices'), [доРев, послеРев]);
  check('продавцу список устройств не приходит', !(await анна.зов('GET', '/api/dashboard?tz=0')).data.устройства);
  r = await админ.зов('POST', `/api/devices/${просьба.id}/approve`, {});
  check('разрешено одним нажатием', r.status === 200, r.data);
  check('и Михаил вошёл с нового телефона', (await чужойТелефон.войти('mikhail', 'seller123')).status === 200);

  console.log('\n=== 3. Сводка за день ===');
  const сегодня = new Date().toISOString().slice(0, 10);
  const сводка = async () => (await админ.зов('GET', `/api/summary/day?tz=0&date=${сегодня}`)).data;
  // Точка отсчёта кассы: первая сверка расхождения не имеет, сравнивать не с чем.
  await анна.зов('POST', '/api/cash/count', { counted: 50000 });
  const до = await сводка();
  const н1 = await изделие(4, 10000);
  const н2 = await изделие(5, 20000);
  await анна.зов('POST', '/api/sales', { items: [{ product_id: н1 }], payment_method: 'cash' });
  await михаил.зов('POST', '/api/sales', { items: [{ product_id: н2 }], payment_method: 'card' });
  await анна.зов('POST', '/api/customers', { name: `Новенькая ${МЕТКА}` });
  await анна.зов('POST', '/api/orders', { description: `Чистка ${МЕТКА}` });
  const ждём = (await анна.зов('GET', '/api/cash/expected')).data.ожидается;
  await анна.зов('POST', '/api/cash/count', { counted: Math.max(0, ждём - 100) });
  const после = await сводка();
  check('чеков +2, выручка +30 000', после.продажи.чеков - до.продажи.чеков === 2
    && около(после.продажи.выручка - до.продажи.выручка, 30000), [до.продажи, после.продажи]);
  check('наличными +10 000, картой +20 000', около(после.оплаты.наличными - до.оплаты.наличными, 10000)
    && около(после.оплаты.картой - до.оплаты.картой, 20000), [до.оплаты, после.оплаты]);
  const анна1 = до.продавцы.find(x => x.name === 'Анна Соколова') || { чеков: 0 };
  const анна2 = после.продавцы.find(x => x.name === 'Анна Соколова') || { чеков: 0 };
  check('у Анны в сводке на чек больше', анна2.чеков - анна1.чеков === 1, [анна1, анна2]);
  check('новый клиент и принятый заказ посчитаны', после.клиенты.новых - до.клиенты.новых === 1
    && после.ремонт.принято - до.ремонт.принято === 1);
  check('недостача 100 — в сводке, с именем', после.касса.сверок - до.касса.сверок === 1
    && после.касса.расхождения.some(р => р.кто === 'Анна Соколова' && около(р.разница, -100)), после.касса);
  check('скидка по разрешению посчитана', после.скидки.по_разрешению >= 1, после.скидки);
  check('продавцу сводка закрыта', (await анна.зов('GET', '/api/summary/day?tz=0')).status === 403);
  const вчера = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  check('без даты — сводка за вчера', (await админ.зов('GET', '/api/summary/day?tz=0')).data.дата === вчера);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
