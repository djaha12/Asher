'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Старое золото в зачёт покупки.
 *
 *   — оценка по весу и пробе: цена грамма 585-й из Настроек, остальные пробы
 *     пропорционально; вес «4,5» с запятой понимается;
 *   — зачёт идёт в оплату, но не в ящик: сверка кассы ждёт только доплату;
 *   — отчёт о прибыли не меняется от зачёта: выручка — полная цена изделия;
 *   — долг считается от доплаты: зачёт — тоже оплата;
 *   — продавец цену грамма не подгонит, владелец может;
 *   — зачёт не больше покупки, без клиента не принять, без цены в Настройках — тоже;
 *   — акт с номером, склад лома в граммах по пробам, сводка знает про зачёт.
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
const МЕТКА = 'Лом' + process.pid;
const около = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

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
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const анна = сеанс();
  await анна.войти('anna', 'seller123');
  const изделие = async (n, цена) => (await админ.зов('POST', '/api/products', {
    sku: `${МЕТКА}-${n}`, name: `Кольцо ${n} для зачёта лома`, metal: 'Золото', fineness: '585',
    retail_price: цена, purchase_price: Math.round(цена / 3),
  })).data.id;
  const клиентка = (await админ.зов('POST', '/api/customers', { name: `Айгуль ${МЕТКА}` })).data.id;
  const ящик = async () => (await анна.зов('GET', '/api/cash/expected')).data.ожидается;
  const год = new Date().getFullYear();
  const месяц = new Date().toISOString().slice(0, 7);
  const отчёт = async () => (await админ.зов('GET', `/api/finance/pnl?year=${год}`)).data.months.find(m => m.month === месяц);

  console.log('=== 1. Цена грамма ===');
  await админ.зов('PUT', '/api/settings', { scrap_price_585: '' });
  const кольцо0 = await изделие(0, 50000);
  let r = await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо0 }], payment_method: 'cash',
    customer_id: клиентка, scrap: [{ description: 'кольцо', fineness: 585, weight: 3 }] });
  check('цена лома не задана — принять нельзя', r.status === 400 && /не задана/.test(r.data.error), r.data);
  check('продавец цену лома в Настройках не меняет', (await анна.зов('PUT', '/api/settings', { scrap_price_585: 9999 })).status === 403);
  check('цена «много» не принимается', (await админ.зов('PUT', '/api/settings', { scrap_price_585: 'много' })).status === 400);
  r = await админ.зов('PUT', '/api/settings', { scrap_price_585: '4000' });
  check('владелец задал 4 000 за грамм 585-й', r.status === 200, r.data);
  const цены = (await анна.зов('GET', '/api/scrap/prices')).data;
  check('585-я — 4 000, 750-я дороже ровно в 750/585, 375-я дешевле',
    цены.prices[585] === 4000 && цены.prices[750] === Math.round(4000 * 750 / 585) && цены.prices[375] === Math.round(4000 * 375 / 585),
    цены.prices);

  console.log('\n=== 2. Зачёт в покупку: деньги сходятся ===');
  await анна.зов('POST', '/api/cash/count', { counted: await ящик() });   // точка отсчёта
  const былоВЯщике = await ящик();
  const доОтчёта = await отчёт();
  const кольцо = await изделие(1, 50000);
  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: кольцо }], payment_method: 'cash', customer_id: клиентка,
    scrap: [{ description: 'старое кольцо', fineness: 585, weight: '4,5', price: 9000 }],
  });
  check('продажа с зачётом прошла', r.status === 200, r.data);
  const чек = r.data;
  check('оценка: 4,5 г × 4 000 = 18 000 (свою цену продавец не поставит)',
    чек.scrap && чек.scrap.amount === 18000 && чек.scrap.items[0].price === 4000 && чек.scrap.items[0].weight === 4.5, чек.scrap);
  check('акт с номером «Л-…», клиентка в акте', чек.scrap && /^Л-\d{6}$/.test(чек.scrap.number)
    && чек.scrap.customer_name === `Айгуль ${МЕТКА}`, чек.scrap);
  check('чек оплачен полностью, долга нет', около(чек.paid, 50000) && около(чек.debt, 0), [чек.paid, чек.debt]);
  check('в ящик легла только доплата — 32 000', около(await ящик() - былоВЯщике, 32000), [былоВЯщике, await ящик()]);
  const зачётнаяСтрока = чек.payments.find(p => p.in_till === 0);
  check('зачёт в платежах — не наличными в ящик', зачётнаяСтрока && около(зачётнаяСтрока.amount, 18000)
    && /старого золота/.test(зачётнаяСтрока.note), чек.payments);
  const послеОтчёта = await отчёт();
  check('выручка в отчёте — полная цена, 50 000', около(послеОтчёта.revenue - доОтчёта.revenue, 50000),
    [доОтчёта.revenue, послеОтчёта.revenue]);
  check('расходы в отчёте от зачёта не выросли', около(послеОтчёта.expenses, доОтчёта.expenses), [доОтчёта.expenses, послеОтчёта.expenses]);

  console.log('\n=== 3. Доплата частями и картой ===');
  const кольцо2 = await изделие(2, 50000);
  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: кольцо2 }], payment_method: 'card', customer_id: клиентка, paid: 20000,
    due_date: '2030-01-01', scrap: [{ description: 'серьги', fineness: 585, weight: 2.5 }],
  });
  check('частично: 20 000 картой + 10 000 золотом → долг 20 000', r.status === 200 && около(r.data.paid, 30000)
    && около(r.data.debt, 20000), r.data);
  const строки = r.data.payments || [];
  check('зачёт — не «картой»: карта — только 20 000', строки.some(p => p.method === 'card' && около(p.amount, 20000))
    && !строки.some(p => p.method === 'card' && около(p.amount, 10000)), строки);

  console.log('\n=== 4. Отказы ===');
  const кольцо3 = await изделие(3, 10000);
  r = await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо3 }], payment_method: 'cash',
    customer_id: клиентка, scrap: [{ fineness: 585, weight: 5 }] });
  check('золото дороже покупки — отказ, разницу деньгами не выдаём', r.status === 400 && /больше покупки/.test(r.data.error), r.data);
  r = await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо3 }], payment_method: 'cash',
    scrap: [{ fineness: 585, weight: 1 }] });
  check('без клиента — отказ: имя нужно в акте', r.status === 400 && /клиента/.test(r.data.error), r.data);
  check('проба «12» — отказ', (await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо3 }],
    payment_method: 'cash', customer_id: клиентка, scrap: [{ fineness: 12, weight: 1 }] })).status === 400);
  check('вес ноль — отказ', (await анна.зов('POST', '/api/sales', { items: [{ product_id: кольцо3 }],
    payment_method: 'cash', customer_id: клиентка, scrap: [{ fineness: 585, weight: 0 }] })).status === 400);
  check('изделие после отказов не продано', (await админ.зов('GET', '/api/products/' + кольцо3)).data.status === 'in_stock');
  const кольцо4 = await изделие(4, 30000);
  r = await админ.зов('POST', '/api/sales', { items: [{ product_id: кольцо4 }], payment_method: 'cash',
    customer_id: клиентка, scrap: [{ description: 'цепь с припоем', fineness: 585, weight: 2, price: 3500 }] });
  check('владелец ставит свою цену грамма: 2 г × 3 500 = 7 000', r.status === 200 && r.data.scrap.amount === 7000, r.data.scrap);

  console.log('\n=== 5. Склад лома и сводка ===');
  const лом = (await анна.зов('GET', '/api/scrap')).data;
  const проба585 = лом.stock.find(s => s.fineness === 585);
  check('на складе 585-й: 4,5 + 2,5 + 2 = 9 г (и больше, если были приёмы раньше)', проба585 && проба585.weight >= 9, лом.stock);
  check('чистого золота посчитано по пробе', проба585 && около(проба585.pure_weight, Math.round(проба585.weight * 585) / 1000), проба585);
  check('акты в списке — с чеком и клиенткой', лом.items.some(a => a.number === чек.scrap.number && a.sale_number === чек.number
    && a.customer_name === `Айгуль ${МЕТКА}`));
  const акт = (await анна.зов('GET', '/api/scrap/' + чек.scrap.id)).data;
  check('акт открывается по номеру', акт.number === чек.scrap.number && акт.items.length === 1, акт);
  const сегодня = new Date().toISOString().slice(0, 10);
  const сводка = (await админ.зов('GET', `/api/summary/day?tz=0&date=${сегодня}`)).data;
  check('в сводке — старым золотом в зачёт', сводка.оплаты.старым_золотом >= 18000 + 10000 + 7000, сводка.оплаты);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
