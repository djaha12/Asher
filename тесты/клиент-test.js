'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Карточка клиента: найти по номеру, не завести дважды, записать желание,
 * не забыть написать.
 *
 *   — номер ищут как набрали: «0555123456» находит «+996 555 12-34-56»;
 *   — второй клиент с тем же номером не заводится молча: сервер говорит,
 *     у кого номер, а «всё равно завести» — осознанный выбор;
 *   — «хочет серьги с сапфиром» записывается в карточку;
 *   — поводы связаться: праздник, «спасибо» через пару дней после покупки,
 *     «пора почистить» через полгода; кому написали — пропадает у всех.
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
const МЕТКА = 'Клиент' + process.pid;
// Уникальный номер на прогон: 0555 + шесть цифр процесса.
const хвост = String(process.pid).padStart(6, '0').slice(-6);
const НОМЕР = `+996 555 ${хвост.slice(0, 2)}-${хвост.slice(2, 4)}-${хвост.slice(4)}`;
const ДЕНЬ = 86400000;

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
  const продавец = сеанс();
  if (!await продавец.войти('anna', 'seller123')) { console.error('Не удалось войти продавцом'); process.exit(2); }
  const найти = async q => (await админ.зов('GET', '/api/customers?search=' + encodeURIComponent(q))).data.items;

  console.log('=== 1. Номер находится, как его ни набери ===');
  const гуля = (await админ.зов('POST', '/api/customers', { name: `Гульнара ${МЕТКА}`, phone: НОМЕР })).data.id;
  const цифры = НОМЕР.replace(/\D/g, '');            // 996555……
  for (const как of ['0' + цифры.slice(3), цифры.slice(3), '+' + цифры, `${цифры.slice(3, 6)} ${цифры.slice(6, 9)}`]) {
    check(`«${как}» находит клиентку`, (await найти(как)).some(c => c.id === гуля), как);
  }
  check('по имени по-прежнему ищется', (await найти(`гульнара ${МЕТКА.toLowerCase()}`)).some(c => c.id === гуля));

  console.log('\n=== 2. Тот же номер второй раз — не молча ===');
  let r = await продавец.зов('POST', '/api/customers', { name: 'Гуля', phone: '0' + цифры.slice(3) });
  check('тот же номер в другом написании — отказ', r.status === 409, r.data);
  check('и сказано, у кого он', r.data && r.data.existing && r.data.existing.id === гуля
    && /Гульнара/.test(r.data.error || ''), r.data);
  check('вторая карточка не заведена', (await найти('Гуля')).every(c => c.name !== 'Гуля'));
  r = await продавец.зов('POST', '/api/customers', { name: 'Гуля', phone: '0' + цифры.slice(3), allow_duplicate: true });
  check('«всё равно завести» — заводится', r.status === 200, r.data);
  const гуля2 = r.data.id;

  const айпери = (await админ.зов('POST', '/api/customers', { name: `Айпери ${МЕТКА}` })).data.id;
  r = await админ.зов('PUT', '/api/customers/' + айпери, { phone: НОМЕР });
  check('правка чужим номером — тоже вопрос', r.status === 409, r.data);
  r = await админ.зов('PUT', '/api/customers/' + гуля, { phone: НОМЕР, notes: 'любит белое золото' });
  check('правка своей карточки со своим номером — без вопросов', r.status === 200, r.data);
  r = await админ.зов('PUT', '/api/customers/' + гуля2, { notes: 'это сестра Гульнары' });
  check('правка без смены номера — без вопросов даже у дубля', r.status === 200, r.data);

  console.log('\n=== 3. Желания ===');
  r = await продавец.зов('POST', `/api/customers/${гуля}/wishes`, { text: 'Серьги с сапфиром до 60 000' });
  check('продавец записывает желание', r.status === 200, r.data);
  const виш = r.data.id;
  let карточка = (await админ.зов('GET', '/api/customers/' + гуля)).data;
  check('оно в карточке', карточка.wishes.some(w => w.id === виш && /сапфиром/.test(w.text)), карточка.wishes);
  check('пустое желание — отказ', (await продавец.зов('POST', `/api/customers/${гуля}/wishes`, { text: '  ' })).status === 400);
  check('чужой клиент — не найдено', (await продавец.зов('DELETE', `/api/customers/${айпери}/wishes/${виш}`)).status === 404);
  check('снять желание', (await продавец.зов('DELETE', `/api/customers/${гуля}/wishes/${виш}`)).status === 200);
  карточка = (await админ.зов('GET', '/api/customers/' + гуля)).data;
  check('и его больше нет', !карточка.wishes.some(w => w.id === виш));

  console.log('\n=== 4. Поводы связаться ===');
  const сегодня = new Date().toISOString().slice(0, 10);
  const деньСдвиг = n => new Date(Date.now() + n * ДЕНЬ).toISOString().slice(0, 10);
  const поводы = async (today) => (await продавец.зов('GET', '/api/customers/occasions?days=14&today=' + today)).data.items;
  const именинница = (await админ.зов('POST', '/api/customers', {
    name: `Именинница ${МЕТКА}`, birthday: `1990-${сегодня.slice(5)}`,
  })).data.id;
  let список = await поводы(сегодня);
  const др = список.find(x => x.id === именинница && x.kind === 'birthday');
  check('день рождения сегодня — в поводах', др && др.in_days === 0, список.slice(0, 3));
  const где = список.findIndex(x => x.id === именинница);
  check('сегодняшний праздник — первым делом', где >= 0 && список.slice(0, где).every(x => x.in_days === 0),
    список.map(x => x.kind + ':' + x.in_days));
  check('продавец отмечает «написали»', (await продавец.зов('POST', `/api/customers/${именинница}/contacted`,
    { kind: 'birthday', ref: др ? др.ref : '' })).status === 200);
  check('и повод пропадает у всех', !(await поводы(сегодня)).some(x => x.id === именинница && x.kind === 'birthday'));
  check('чужой повод не принимается', (await продавец.зов('POST', `/api/customers/${именинница}/contacted`,
    { kind: 'spam', ref: '1' })).status === 400);

  // Покупка сегодня — через два дня она станет поводом сказать спасибо.
  const изделие = (await админ.зов('POST', '/api/products', {
    sku: `${МЕТКА}-1`, name: 'Кольцо для проверки поводов', metal: 'Золото', retail_price: 30000, purchase_price: 10000,
  })).data;
  const продажа = await продавец.зов('POST', '/api/sales', {
    items: [{ product_id: изделие.id }], payment_method: 'cash', customer_id: гуля,
  });
  check('продажа Гульнаре прошла', продажа.status === 200, продажа.data);
  check('в день покупки «спасибо» ещё рано', !(await поводы(сегодня)).some(x => x.id === гуля && x.kind === 'thanks'));
  список = await поводы(деньСдвиг(2));
  const спасибо = список.find(x => x.id === гуля && x.kind === 'thanks');
  check('через два дня — «сказать спасибо» с номером чека', спасибо && спасибо.ref === продажа.data.number, список.filter(x => x.id === гуля));
  check('через неделю — уже нет', !(await поводы(деньСдвиг(7))).some(x => x.id === гуля && x.kind === 'thanks'));
  check('через полгода — «пригласить почистить»',
    (await поводы(деньСдвиг(185))).some(x => x.id === гуля && x.kind === 'cleaning' && x.ref === продажа.data.number));
  await продавец.зов('POST', `/api/customers/${гуля}/contacted`, { kind: 'thanks', ref: продажа.data.number });
  check('«спасибо» сказали — пропало', !(await поводы(деньСдвиг(2))).some(x => x.id === гуля && x.kind === 'thanks'));
  check('а приглашение почистить осталось — это другой повод',
    (await поводы(деньСдвиг(185))).some(x => x.id === гуля && x.kind === 'cleaning'));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
