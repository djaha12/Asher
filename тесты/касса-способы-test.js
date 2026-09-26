'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Оплата картой не ждётся в ящике.
 *
 * Раньше любая оплата заказа — предоплата, доплата, оплата при выдаче —
 * записывалась наличными, а первый взнос по рассрочке тоже всегда был
 * «наличными». Оплата картой или переводом уходит на счёт, а сверка кассы
 * вечером ждала эти деньги в ящике — и показывала недостачу, которой не было.
 *
 * Теперь: картой и переводом — мимо ящика, наличными — в ящик; без указания
 * способа — наличными, как раньше.
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
const МЕТКА = 'Спос' + process.pid;
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
  const ящик = async () => (await анна.зов('GET', '/api/cash/expected')).data.ожидается;
  const клиентка = (await админ.зов('POST', '/api/customers', { name: `Гульнара ${МЕТКА}` })).data.id;
  // Точка отсчёта: дальше смотрим только, на сколько изменился ящик.
  await анна.зов('POST', '/api/cash/count', { counted: await ящик() });

  console.log('=== 1. Заказ: предоплата, доплата, выдача ===');
  let было = await ящик();
  let r = await анна.зов('POST', '/api/orders', {
    description: `Ремонт ${МЕТКА}`, customer_id: клиентка, estimate: 5000, prepayment: 1000, method: 'card',
  });
  check('заказ с предоплатой картой принят', r.status === 200 && около(r.data.paid, 1000), r.data);
  const заказ = r.data.id;
  check('предоплата картой — не в ящик', около(await ящик(), было), [было, await ящик()]);
  r = await анна.зов('POST', `/api/orders/${заказ}/payment`, { amount: 2000, method: 'transfer' });
  check('доплата переводом принята', r.status === 200 && около(r.data.paid, 3000), r.data);
  check('перевод — не в ящик', около(await ящик(), было));
  r = await анна.зов('POST', `/api/orders/${заказ}/payment`, { amount: 500, method: 'cash' });
  check('наличные — в ящик: +500', около(await ящик() - было, 500), [было, await ящик()]);
  было = await ящик();
  r = await анна.зов('POST', `/api/orders/${заказ}/payment`, { amount: 300 });
  check('способ не указан — наличными, как раньше: +300', около(await ящик() - было, 300));
  check('заказ оплачен целиком: 1000 + 2000 + 500 + 300', около((await анна.зов('GET', '/api/orders/' + заказ)).data.paid, 3800));

  console.log('\n=== 2. Рассрочка: первый взнос ===');
  const изделие = async (n, цена) => (await админ.зов('POST', '/api/products', {
    sku: `${МЕТКА}-${n}`, name: `Браслет ${n} в рассрочку`, metal: 'Золото', retail_price: цена, purchase_price: цена / 3,
  })).data.id;
  было = await ящик();
  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: await изделие(1, 30000) }], payment_method: 'installment', customer_id: клиентка,
    paid: 10000, due_date: '2030-01-01', first_payment_method: 'card',
  });
  check('рассрочка оформлена, долг 20 000', r.status === 200 && около(r.data.debt, 20000), r.data);
  const взнос = (r.data.payments || []).find(p => около(p.amount, 10000));
  check('первый взнос записан картой', взнос && взнос.method === 'card' && взнос.in_till === 0, r.data.payments);
  check('взнос картой — не в ящик', около(await ящик(), было), [было, await ящик()]);

  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: await изделие(2, 30000) }], payment_method: 'installment', customer_id: клиентка,
    paid: 5000, due_date: '2030-01-01', first_payment_method: 'transfer',
  });
  check('взнос переводом — тоже мимо ящика', r.status === 200 && около(await ящик(), было)
    && (r.data.payments || []).some(p => p.method === 'transfer' && около(p.amount, 5000)), r.data.payments);

  r = await анна.зов('POST', '/api/sales', {
    items: [{ product_id: await изделие(3, 30000) }], payment_method: 'installment', customer_id: клиентка,
    paid: 7000, due_date: '2030-01-01',
  });
  check('способ взноса не указан — наличными, как раньше: +7 000', r.status === 200 && около(await ящик() - было, 7000),
    [было, await ящик()]);
  check('чужое слово вместо способа — тоже наличными', (await анна.зов('POST', '/api/sales', {
    items: [{ product_id: await изделие(4, 30000) }], payment_method: 'installment', customer_id: клиентка,
    paid: 1000, due_date: '2030-01-01', first_payment_method: 'bitcoin',
  })).data.payments.some(p => p.method === 'cash' && p.in_till === 1));

  console.log('\n=== 3. Сверка вечером сходится ===');
  const ждём = await ящик();
  r = await анна.зов('POST', '/api/cash/count', { counted: ждём });
  check('в ящике ровно столько, сколько пришло наличными — сошлось', r.status === 200 && r.data.разница === 0, r.data);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
