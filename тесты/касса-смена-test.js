'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Касса: «сдал владельцу», «внёс размен», «сдаю смену» и «смену принял».
 *
 *   — сданные владельцу деньги уходят из ящика, но НЕ в расходы: отчёт
 *     о прибыли не «теряет» дневную выручку;
 *   — сдачу подтверждает тот, кому отдали, — «деньги у меня» или
 *     «не получено»; продавец отметить за него не может, отметка не
 *     переделывается;
 *   — сдать больше, чем по расчёту в ящике, нельзя: это лишний ноль;
 *   — размен в ящик — плюс к ожидаемому, без подтверждения;
 *   — смену принимает другой человек, пересчитав при сдающем; свою принять
 *     нельзя, дважды — тоже; расхождение между ними записывается.
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
const МЕТКА = 'Смена' + process.pid;
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
      const data = await r.json().catch(() => ({}));
      return r.status === 200 ? data.user : null;
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
  const я = await админ.войти('admin', 'admin123');
  if (!я) { console.error('Не удалось войти'); process.exit(2); }
  const анна = сеанс();
  const аннаЯ = await анна.войти('anna', 'seller123');
  const михаил = сеанс();
  const михаилЯ = await михаил.войти('mikhail', 'seller123');
  if (!аннаЯ || !михаилЯ) { console.error('Не удалось войти продавцами'); process.exit(2); }
  const ожидается = async (кто = анна) => (await кто.зов('GET', '/api/cash/expected')).data;
  const год = new Date().getFullYear();
  const месяц = new Date().toISOString().slice(0, 7);
  const отчёт = async () => (await админ.зов('GET', `/api/finance/pnl?year=${год}`)).data.months.find(m => m.month === месяц);

  console.log('=== 1. Точка отсчёта и продажа ===');
  let r = await анна.зов('POST', '/api/cash/count', { counted: 10000 });
  check('сверка: в ящике 10 000', r.status === 200, r.data);
  const изделие = (await админ.зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Серьги для проверки смены', metal: 'Золото', retail_price: 5000, purchase_price: 2000,
  })).data;
  r = await анна.зов('POST', '/api/sales', { items: [{ product_id: изделие.id }], payment_method: 'cash' });
  check('продажа наличными на 5 000', r.status === 200, r.data);
  check('должно быть 15 000', около((await ожидается()).ожидается, 15000), (await ожидается()).ожидается);
  const доСдачи = await отчёт();

  console.log('\n=== 2. «Сдал владельцу» — не расход ===');
  check('не сказано, кому отдали — отказ',
    (await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 12000 })).status === 400);
  check('«отдала» продавцу — отказ: сдают владельцу или бухгалтеру',
    (await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 12000, other_user_id: михаилЯ.id })).status === 400);
  r = await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 120000, other_user_id: я.id });
  check('больше, чем в ящике по расчёту, — отказ (лишний ноль)', r.status === 400 && /столько сдать нельзя/.test(r.data.error), r.data);
  check('пустая сумма — отказ',
    (await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: '', other_user_id: я.id })).status === 400);
  check('отрицательная — отказ',
    (await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: -5, other_user_id: я.id })).status === 400);
  check('непонятное действие — отказ',
    (await анна.зов('POST', '/api/cash/moves', { kind: 'steal', amount: 5, other_user_id: я.id })).status === 400);
  r = await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 12000, other_user_id: я.id, note: 'выручка за день' });
  check('Анна сдала владельцу 12 000', r.status === 200 && r.data.status === 'pending', r.data);
  const сдача = r.data.id;
  let о = await ожидается();
  check('в ящике по расчёту стало 3 000', около(о.ожидается, 3000), о.ожидается);
  check('в разбивке видно «сдали владельцу»', около(о.движение.сдали, 12000), о.движение);
  const послеСдачи = await отчёт();
  check('расходы в отчёте о прибыли не выросли', около(послеСдачи.expenses, доСдачи.expenses), [доСдачи.expenses, послеСдачи.expenses]);
  check('и прибыль та же', около(послеСдачи.net_profit, доСдачи.net_profit), [доСдачи.net_profit, послеСдачи.net_profit]);

  console.log('\n=== 3. Подтверждает тот, кому отдали ===');
  let ждёт = (await админ.зов('GET', '/api/cash/pending')).data;
  check('у владельца — «подтвердите»', ждёт.сдачи.some(с => с.id === сдача && около(с.amount, 12000)), ждёт);
  check('у продавца такого списка нет', (await михаил.зов('GET', '/api/cash/pending')).data.сдачи.length === 0);
  check('Анна не может отметить «получено» за владельца',
    (await анна.зов('POST', `/api/cash/moves/${сдача}/confirm`, {})).status === 403);
  check('Анна видит свою сдачу и её отметку',
    (await анна.зов('GET', '/api/cash/moves')).data.items.some(m => m.id === сдача && m.status === 'pending'));
  check('Михаил чужих сдач не видит',
    !(await михаил.зов('GET', '/api/cash/moves')).data.items.some(m => m.id === сдача));
  r = await админ.зов('POST', `/api/cash/moves/${сдача}/confirm`, {});
  check('владелец: «деньги у меня»', r.status === 200, r.data);
  check('второй раз — «уже отмечено»', (await админ.зов('POST', `/api/cash/moves/${сдача}/confirm`, {})).status === 400);
  check('переделать в «не получено» нельзя', (await админ.зов('POST', `/api/cash/moves/${сдача}/dispute`, {})).status === 400);
  ждёт = (await админ.зов('GET', '/api/cash/pending')).data;
  check('из «подтвердите» пропало', !ждёт.сдачи.some(с => с.id === сдача));

  r = await анна.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 1000, other_user_id: я.id });
  const спорная = r.data.id;
  r = await админ.зов('POST', `/api/cash/moves/${спорная}/dispute`, { note: 'не давала' });
  check('владелец: «не получено»', r.status === 200, r.data);
  const спор = (await админ.зов('GET', '/api/cash/moves')).data.items.find(m => m.id === спорная);
  check('отметка и заметка сохранены', спор && спор.status === 'disputed' && спор.check_note === 'не давала', спор);
  check('из ящика эти деньги всё равно ушли — спор между людьми, не с ящиком',
    около((await ожидается()).ожидается, 2000), (await ожидается()).ожидается);

  console.log('\n=== 4. Размен и сдача самим владельцем ===');
  r = await анна.зов('POST', '/api/cash/moves', { kind: 'from_owner', amount: 5000, other_user_id: я.id });
  check('размен внесён — без подтверждения', r.status === 200 && r.data.status === 'confirmed', r.data);
  о = await ожидается();
  check('должно быть 7 000', около(о.ожидается, 7000), о.ожидается);
  check('в разбивке — «внесли размен»', около(о.движение.внесли, 5000), о.движение);
  r = await админ.зов('POST', '/api/cash/moves', { kind: 'to_owner', amount: 500 });
  check('владелец взял сам — подтверждать нечего', r.status === 200 && r.data.status === 'confirmed', r.data);
  check('должно быть 6 500', около((await ожидается()).ожидается, 6500));

  console.log('\n=== 5. Сдаю смену — смену принял ===');
  r = await анна.зов('POST', '/api/cash/count', { counted: 6500, kind: 'handover' });
  check('Анна сдаёт смену: 6 500, сошлось', r.status === 200 && r.data.вид === 'handover' && r.data.разница === 0, r.data);
  const уМихаила = (await михаил.зов('GET', '/api/cash/pending')).data.смена;
  check('Михаил видит: смену сдаёт Анна, 6 500', уМихаила && уМихаила.кто === 'Анна Соколова' && около(уМихаила.сдано, 6500), уМихаила);
  check('у самой Анны «принять смену» нет', (await анна.зов('GET', '/api/cash/pending')).data.смена === null);
  r = await анна.зов('POST', '/api/cash/count', { counted: 6500, accept: true });
  check('свою смену принять нельзя', r.status === 400 && /Свою смену/.test(r.data.error), r.data);
  r = await михаил.зов('POST', '/api/cash/count', { counted: 6000, accept: true });
  check('Михаил принял, насчитав 6 000', r.status === 200 && r.data.вид === 'accept', r.data);
  check('расхождение с Анной −500 записано', r.data.разница === -500 && около(r.data.сдано, 6500) && r.data.сдал === 'Анна Соколова', r.data);
  check('второй раз принять нечего', (await михаил.зов('POST', '/api/cash/count', { counted: 6000, accept: true })).status === 400);
  check('«принять смену» больше не висит', (await админ.зов('GET', '/api/cash/pending')).data.смена === null);
  const сверки = (await админ.зов('GET', '/api/cash/counts?limit=5')).data.items;
  check('в истории: приём смены у Анны, сдано 6 500', сверки[0].kind === 'accept'
    && сверки[0].handover_user_name === 'Анна Соколова' && около(сверки[0].handover_counted, 6500), сверки[0]);
  check('и у сдачи отмечено, кто принял', сверки[1].kind === 'handover' && сверки[1].accepted_name === 'Михаил Орлов', сверки[1]);

  r = await анна.зов('POST', '/api/cash/count', { counted: 6000, kind: 'handover' });
  await админ.зов('POST', '/api/cash/count', { counted: 6000 });
  check('сдачу перекрыла обычная сверка — «принять» не висит',
    (await михаил.зов('GET', '/api/cash/pending')).data.смена === null);
  const брошенная = (await админ.зов('GET', '/api/cash/counts?limit=5')).data.items.find(c => c.id === r.data.id);
  check('а в истории видно, что её никто не принял', брошенная && брошенная.kind === 'handover' && !брошенная.accepted_by, брошенная);

  const журнал = (await админ.зов('GET', '/api/audit?limit=50')).data;
  const записи = (журнал.items || []).map(x => x.action);
  check('в журнале — сдачи денег и их отметки', записи.includes('cash_move') && записи.includes('cash_move_check'), записи.slice(0, 12));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
