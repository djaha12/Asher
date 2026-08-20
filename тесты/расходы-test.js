'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Постоянные расходы: аренда и зарплата.
 *
 * Это самые крупные расходы магазина и самые забываемые: сумма из месяца
 * в месяц одна и та же, платятся они мимо кассы, и в отчёт попадают, только
 * если кто-то вспомнил их вписать. Не вписали — прибыль в отчёте выше
 * настоящей ровно на эту сумму, и владелец весь месяц считает, что заработал
 * больше.
 *
 * Поэтому здесь проверяется не «сохраняется ли строчка в базе», а то, ради
 * чего раздел сделан: напоминание появляется в нужное число, гаснет ровно
 * тогда, когда расход записан, и не гаснет от чужой записи — зарплата Анны
 * не должна закрываться зарплатой Марата.
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

// Уникальные названия: набор гоняется по той же базе, что и остальные,
// и «Аренда» из демо-данных не должна путаться с «Арендой» этих проверок.
const МЕТКА = 'ПР-' + process.pid;
const АРЕНДА = МЕТКА + ' аренда';
const ЗАРПЛАТА = МЕТКА + ' зарплата';

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }

  const сегодня = new Date().getDate();
  const ждётЛи = (список, имя, кому) => список.some(
    ж => ж.category === имя && (кому === undefined || ж.employee_id === кому));

  console.log('=== 1. Правило заводится и попадает в список ===');
  const созд = await админ.зов('POST', '/api/finance/regular',
    { category: АРЕНДА, amount: 145000, day_of_month: 1, cash: false, note: 'ТЦ, 2 этаж' });
  check('постоянный расход создан', созд.status === 200 && созд.data.id, созд.data);
  const idАренды = созд.data && созд.data.id;

  const список1 = (await админ.зов('GET', '/api/finance/regular')).data;
  const аренда = (список1.items || []).find(и => и.id === idАренды);
  check('правило видно в списке', Boolean(аренда), (список1.items || []).length);
  check('сумма сохранилась', аренда && около(аренда.amount, 145000), аренда && аренда.amount);
  check('число месяца сохранилось', аренда && аренда.day_of_month === 1, аренда && аренда.day_of_month);
  check('аренда не считается наличной', аренда && !аренда.cash, аренда && аренда.cash);
  check('правило сразу активно', аренда && аренда.active === 1, аренда && аренда.active);

  console.log('\n=== 2. Срок подошёл — расход ждёт записи ===');
  check('аренда с 1-го числа ждёт записи', ждётЛи(список1['ждут'], АРЕНДА), список1['ждут']);

  console.log('\n=== 3. Пока срок не подошёл, система молчит ===');
  /*
   * Напоминание, которое горит все тридцать дней, примелькается и перестанет
   * работать — а это единственное, ради чего оно существует.
   */
  const позднее = Math.min(28, сегодня + 1);
  const позжеСозд = await админ.зов('POST', '/api/finance/regular',
    { category: МЕТКА + ' охрана', amount: 8000, day_of_month: позднее });
  check('правило на будущее число создано', позжеСозд.status === 200, позжеСозд.data);
  const списокП = (await админ.зов('GET', '/api/finance/regular')).data;
  if (позднее > сегодня) {
    check('расход с ещё не наступившим сроком не напоминает о себе',
      !ждётЛи(списокП['ждут'], МЕТКА + ' охрана'), списокП['ждут']);
  } else {
    // Конец месяца: 28-е уже наступило, и напоминать — правильно.
    check('в конце месяца расход 28-го числа уже ждёт',
      ждётЛи(списокП['ждут'], МЕТКА + ' охрана'), списокП['ждут']);
  }
  await админ.зов('DELETE', '/api/finance/regular/' + позжеСозд.data.id);

  console.log('\n=== 4. Записали расход — напоминание гаснет ===');
  const записьАренды = await админ.зов('POST', '/api/finance',
    { type: 'expense', category: АРЕНДА, amount: 150000, cash: false, note: 'подняли на 5 тысяч' });
  check('расход записан', записьАренды.status === 200, записьАренды.data);
  const список2 = (await админ.зов('GET', '/api/finance/regular')).data;
  check('аренда больше не в списке ожидающих',
    !ждётЛи(список2['ждут'], АРЕНДА), список2['ждут']);

  console.log('\n=== 5. Сумму можно записать не ту, что в правиле ===');
  /*
   * Система подставляет обычную сумму, но не настаивает: аренда выросла,
   * у продавца был неполный месяц, кому-то дали премию. Записывать за
   * владельца неподтверждённые деньги система не должна вовсе — и не должна
   * ругаться, когда он вписал другое число.
   */
  const операции = (await админ.зов('GET', '/api/finance?type=expense')).data;
  const строкаАренды = (операции.items || []).find(о => о.category === АРЕНДА);
  check('записалась именно введённая сумма, а не подставленная',
    строкаАренды && около(строкаАренды.amount, 150000), строкаАренды && строкаАренды.amount);
  check('правило при этом не изменилось',
    около(((await админ.зов('GET', '/api/finance/regular')).data.items
      .find(и => и.id === idАренды) || {}).amount, 145000));

  console.log('\n=== 6. Зарплата: у каждого сотрудника своё напоминание ===');
  /*
   * Самое опасное место. Если считать зарплату одной строкой, первая же
   * выплата закрывает напоминания по всем: заплатили Анне — система решит,
   * что и Марат получил.
   */
  const люди = (await админ.зов('GET', '/api/users')).data.items.filter(u => u.active);
  check('в системе есть хотя бы двое сотрудников', люди.length >= 2, люди.length);
  const [а, б] = люди;

  const зпА = await админ.зов('POST', '/api/finance/regular',
    { category: ЗАРПЛАТА, amount: 30000, day_of_month: 1, employee_id: а.id, cash: true });
  const зпБ = await админ.зов('POST', '/api/finance/regular',
    { category: ЗАРПЛАТА, amount: 25000, day_of_month: 1, employee_id: б.id, cash: true });
  check('оба правила зарплаты созданы',
    зпА.status === 200 && зпБ.status === 200, [зпА.data, зпБ.data]);

  const зпСписок = (await админ.зов('GET', '/api/finance/regular')).data;
  check('ждут зарплаты обоих',
    ждётЛи(зпСписок['ждут'], ЗАРПЛАТА, а.id) && ждётЛи(зпСписок['ждут'], ЗАРПЛАТА, б.id),
    зпСписок['ждут']);
  const подпись = (зпСписок['ждут'].find(ж => ж.employee_id === а.id) || {}).подпись;
  check('в напоминании видно имя сотрудника',
    typeof подпись === 'string' && подпись.includes(а.name), подпись);

  const выплата = await админ.зов('POST', '/api/finance',
    { type: 'expense', category: ЗАРПЛАТА, amount: 30000, employee_id: а.id, cash: true });
  check('зарплата первому выплачена', выплата.status === 200, выплата.data);

  const послеВыплаты = (await админ.зов('GET', '/api/finance/regular')).data;
  check('напоминание по первому погасло',
    !ждётЛи(послеВыплаты['ждут'], ЗАРПЛАТА, а.id), послеВыплаты['ждут']);
  check('напоминание по второму осталось — ему не платили',
    ждётЛи(послеВыплаты['ждут'], ЗАРПЛАТА, б.id), послеВыплаты['ждут']);

  console.log('\n=== 7. Видно, кому платили ===');
  const зпОперации = (await админ.зов('GET', '/api/finance?type=expense')).data;
  const строкаЗП = (зпОперации.items || []).find(
    о => о.category === ЗАРПЛАТА && о.employee_id === а.id);
  check('в операции сохранился сотрудник', Boolean(строкаЗП), 'не найдена');
  check('и его имя видно в списке',
    строкаЗП && строкаЗП.employee_name === а.name, строкаЗП && строкаЗП.employee_name);

  console.log('\n=== 8. Тревога на Главной ===');
  /*
   * Владелец не заходит в «Финансы» каждый день, а Главную видит всегда.
   * Если напоминание живёт только внутри раздела, оно не работает.
   */
  const главная = (await админ.зов('GET', '/api/dashboard')).data;
  const тревоги = главная['тревоги'] || [];
  const проЗП = тревоги.find(т => String(т.что).includes(ЗАРПЛАТА));
  check('незаписанная зарплата видна на Главной', Boolean(проЗП), тревоги.map(т => т.что));
  check('сказано, чем это грозит',
    проЗП && String(проЗП.почему).includes('прибыль'), проЗП && проЗП.почему);
  check('сказано, куда идти',
    проЗП && String(проЗП.делать).includes('Финансы'), проЗП && проЗП.делать);

  console.log('\n=== 9. Приостановленное правило не напоминает ===');
  const пауза = await админ.зов('PUT', '/api/finance/regular/' + зпБ.data.id, { active: false });
  check('правило приостановлено', пауза.status === 200, пауза.data);
  const наПаузе = (await админ.зов('GET', '/api/finance/regular')).data;
  check('приостановленное не ждёт записи',
    !ждётЛи(наПаузе['ждут'], ЗАРПЛАТА, б.id), наПаузе['ждут']);
  check('но из списка не исчезло — его можно вернуть',
    (наПаузе.items || []).some(и => и.id === зпБ.data.id), (наПаузе.items || []).length);
  await админ.зов('PUT', '/api/finance/regular/' + зпБ.data.id, { active: true });

  console.log('\n=== 10. Удаление правила не переписывает историю денег ===');
  /*
   * Перестали снимать помещение — напоминание убирается, но расходы,
   * которые магазин действительно понёс, остаются: это его история.
   */
  const былоРасходов = ((await админ.зов('GET', '/api/finance?type=expense')).data.items || [])
    .filter(о => о.category === АРЕНДА).length;
  check('удаление правила прошло',
    (await админ.зов('DELETE', '/api/finance/regular/' + idАренды)).status === 200);
  const сталоРасходов = ((await админ.зов('GET', '/api/finance?type=expense')).data.items || [])
    .filter(о => о.category === АРЕНДА).length;
  check('записанные расходы остались на месте',
    сталоРасходов === былоРасходов, `${сталоРасходов} вместо ${былоРасходов}`);
  check('а само правило исчезло',
    !((await админ.зов('GET', '/api/finance/regular')).data.items || []).some(и => и.id === idАренды));

  console.log('\n=== 11. Расход попадает в отчёт о прибыли ===');
  const год = new Date().getFullYear();
  const месяц = new Date().toISOString().slice(0, 7);
  const pnl = (await админ.зов('GET', `/api/finance/pnl?year=${год}&tz=0`)).data;
  const строкаМесяца = (pnl.months || []).find(м => м.month === месяц);
  check('месяц есть в отчёте', Boolean(строкаМесяца), (pnl.months || []).map(м => м.month));
  check('аренда учтена в расходах по категориям',
    около((pnl.expense_by_category || {})[АРЕНДА] || 0, 150000),
    (pnl.expense_by_category || {})[АРЕНДА]);
  check('зарплата учтена отдельной категорией',
    около((pnl.expense_by_category || {})[ЗАРПЛАТА] || 0, 30000),
    (pnl.expense_by_category || {})[ЗАРПЛАТА]);

  console.log('\n=== 12. Безналичный расход не трогает кассу ===');
  /*
   * Аренда переводом деньги из ящика не забирает. Если считать её наличной,
   * сверка кассы каждый месяц показывала бы недостачу, которой не было —
   * и продавцы перестали бы верить сверке вовсе.
   */
  /*
   * Сначала сверка — точка отсчёта. Без неё системе не с чем сравнивать:
   * она не знает, сколько денег лежало в ящике до её появления, и честно
   * показывает ноль. Мерить движение от такого нуля бессмысленно.
   */
  await админ.зов('POST', '/api/cash/count', { counted: 10000, note: 'точка отсчёта для проверки расходов' });
  const доПеревода = (await админ.зов('GET', '/api/cash/expected')).data['ожидается'];
  await админ.зов('POST', '/api/finance',
    { type: 'expense', category: МЕТКА + ' интернет', amount: 3000, cash: false });
  const послеПеревода = (await админ.зов('GET', '/api/cash/expected')).data['ожидается'];
  check('ожидаемое в ящике не изменилось', около(послеПеревода, доПеревода),
    `${послеПеревода} вместо ${доПеревода}`);

  await админ.зов('POST', '/api/finance',
    { type: 'expense', category: МЕТКА + ' вода', amount: 500, cash: true });
  const послеНаличных = (await админ.зов('GET', '/api/cash/expected')).data['ожидается'];
  check('а наличный расход уменьшил ящик ровно на свою сумму',
    около(послеНаличных, доПеревода - 500), `${послеНаличных} вместо ${доПеревода - 500}`);

  console.log('\n=== 13. Мусор не принимается ===');
  check('без категории — отказ',
    (await админ.зов('POST', '/api/finance/regular', { amount: 100, day_of_month: 1 })).status === 400);
  check('нулевая сумма — отказ',
    (await админ.зов('POST', '/api/finance/regular',
      { category: МЕТКА + ' ноль', amount: 0, day_of_month: 1 })).status === 400);
  check('текст вместо суммы — отказ',
    (await админ.зов('POST', '/api/finance/regular',
      { category: МЕТКА + ' текст', amount: 'много', day_of_month: 1 })).status === 400);

  // 31-е число в феврале не наступает никогда — правило с ним не напомнило бы
  // ни разу и молча превратилось бы в мёртвую строчку.
  const крайнее = await админ.зов('POST', '/api/finance/regular',
    { category: МЕТКА + ' край', amount: 100, day_of_month: 31 });
  check('31-е число прижимается к 28-му',
    ((await админ.зов('GET', '/api/finance/regular')).data.items
      .find(и => и.id === крайнее.data.id) || {}).day_of_month === 28);
  check('нулевое число тоже поправлено',
    (await админ.зов('PUT', '/api/finance/regular/' + крайнее.data.id, { day_of_month: 0 })).status === 200
    && ((await админ.зов('GET', '/api/finance/regular')).data.items
      .find(и => и.id === крайнее.data.id) || {}).day_of_month === 1);
  await админ.зов('DELETE', '/api/finance/regular/' + крайнее.data.id);
  check('несуществующее правило — 404',
    (await админ.зов('PUT', '/api/finance/regular/999999', { amount: 5 })).status === 404);

  console.log('\n=== 14. Продавцу деньги магазина не показываются ===');
  const продавец = сеанс();
  check('продавец вошёл', await продавец.войти('anna', 'seller123'));
  check('список постоянных расходов ему закрыт',
    (await продавец.зов('GET', '/api/finance/regular')).status === 403);
  check('и завести правило он не может',
    (await продавец.зов('POST', '/api/finance/regular',
      { category: 'своя зарплата', amount: 1, day_of_month: 1 })).status === 403);
  check('и записать расход тоже',
    (await продавец.зов('POST', '/api/finance',
      { type: 'expense', category: 'что-то', amount: 1 })).status === 403);
  const главнаяП = (await продавец.зов('GET', '/api/dashboard')).data;
  check('на его Главной тревог владельца нет', !главнаяП['тревоги'], главнаяП['тревоги']);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
