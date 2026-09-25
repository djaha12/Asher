'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Приём в ремонт.
 *
 *   — при приёме записываются изделие, вес, камни и состояние: спор «было
 *     три камня, а стало два» решает квитанция, а не слово против слова;
 *   — вес понимается и с запятой, как на весах: «4,52»;
 *   — «Готов» — из любого незакрытого статуса, одним нажатием; вернули
 *     в работу — «готово» и «клиенту написали» сбрасываются;
 *   — «клиенту написали» — общая отметка, видна всем;
 *   — фото при приёме: хранятся, видны, попадают в резервную копию;
 *     продавец их не удаляет — это доказательство.
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
const МЕТКА = 'Ремонт' + process.pid;

function сеанс() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
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

// Сервер проверяет формат по первым байтам — этого достаточно, чтобы он
// принял файл за JPEG. Картинку сжимает браузер, сервер её не рисует.
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('проверка приёма в ремонт'), Buffer.from([0xff, 0xd9]),
]).toString('base64');

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  const продавец = сеанс();
  if (!await продавец.войти('anna', 'seller123')) { console.error('Не удалось войти продавцом'); process.exit(2); }

  const клиент = (await админ.зов('POST', '/api/customers', { name: `Клиент ${МЕТКА}`, phone: '0700 '
    + String(process.pid).padStart(6, '0').slice(-6) })).data.id;

  console.log('=== 1. Что принесли — записано ===');
  let r = await продавец.зов('POST', '/api/orders', {
    type: 'repair', customer_id: клиент, description: 'Заменить замок, полировка',
    item: `Цепь ${МЕТКА}, золото 585`, weight: '4,52', stones: 'Без камней', defects: 'Царапины, замок сломан',
    estimate: 1500, prepayment: 500,
  });
  check('заказ принят', r.status === 200, r.data);
  const заказ = r.data;
  check('изделие записано', заказ.item === `Цепь ${МЕТКА}, золото 585`, заказ.item);
  check('вес с запятой понят: 4,52 → 4.52', заказ.weight === 4.52, заказ.weight);
  check('камни и состояние записаны', заказ.stones === 'Без камней' && заказ.defects === 'Царапины, замок сломан');
  check('предоплата легла как прежде', заказ.paid === 500, заказ.paid);

  check('вес «абв» — отказ', (await продавец.зов('POST', '/api/orders',
    { description: 'x', weight: 'абв' })).status === 400);
  check('отрицательный вес — отказ', (await продавец.зов('POST', '/api/orders',
    { description: 'x', weight: -1 })).status === 400);
  check('изделие на полстраницы — отказ', (await продавец.зов('POST', '/api/orders',
    { description: 'x', item: 'ц'.repeat(201) })).status === 400);
  r = await продавец.зов('POST', '/api/orders', { description: `Без веса ${МЕТКА}` });
  check('заказ без приёмки — как раньше, вес 0', r.status === 200 && r.data.weight === 0 && r.data.item === '', r.data);

  r = await продавец.зов('PUT', '/api/orders/' + заказ.id, { weight: '4.6', stones: '1 фианит' });
  check('правка веса и камней', r.status === 200 && r.data.weight === 4.6 && r.data.stones === '1 фианит', r.data);
  check('правка не трогает то, чего не касалась', r.data.item === заказ.item && r.data.defects === заказ.defects);

  console.log('\n=== 2. «Готов» одним нажатием, из любого статуса ===');
  r = await продавец.зов('POST', `/api/orders/${заказ.id}/status`, { status: 'ready' });
  check('из «Принят» сразу в «Готов»', r.status === 200 && r.data.status === 'ready', r.data);
  check('время готовности запомнено', Boolean(r.data.ready_at));
  check('клиенту ещё не писали', !r.data.notified_at);

  r = await продавец.зов('POST', `/api/orders/${заказ.id}/notified`, {});
  check('«клиенту написали» — принято', r.status === 200, r.data);
  let детали = (await админ.зов('GET', '/api/orders/' + заказ.id)).data;
  check('и видно другим', Boolean(детали.notified_at));
  const список = (await админ.зов('GET', '/api/orders')).data.items;
  check('в списке тоже', Boolean((список.find(o => o.id === заказ.id) || {}).notified_at));

  r = await продавец.зов('POST', `/api/orders/${заказ.id}/status`, { status: 'in_progress' });
  check('вернули в работу', r.status === 200 && r.data.status === 'in_progress');
  check('«готово» и «написали» сброшены — это уже неправда', !r.data.ready_at && !r.data.notified_at, r.data);
  check('написать про неготовый заказ — отказ',
    (await продавец.зов('POST', `/api/orders/${заказ.id}/notified`, {})).status === 400);
  r = await продавец.зов('POST', `/api/orders/${заказ.id}/status`, { status: 'ready' });
  check('из «В работе» — тоже в «Готов»', r.data.status === 'ready' && Boolean(r.data.ready_at));
  check('несуществующий заказ — не найден',
    (await продавец.зов('POST', '/api/orders/999999/notified', {})).status === 404);

  console.log('\n=== 3. Фото при приёме ===');
  r = await продавец.зов('POST', `/api/orders/${заказ.id}/images`, { data: JPEG, thumb: JPEG });
  check('продавец добавляет фото', r.status === 200, r.data);
  const фото = r.data;
  check('лежит в папке заказов', фото.file && фото.file.startsWith(`orders/${заказ.id}/`), фото.file);
  детали = (await админ.зов('GET', '/api/orders/' + заказ.id)).data;
  check('фото в карточке заказа', детали.images.length === 1 && детали.images[0].id === фото.id, детали.images);
  const вСписке = (await админ.зов('GET', '/api/orders')).data.items.find(o => o.id === заказ.id);
  check('в списке — счётчик фото', вСписке && вСписке.photo_count === 1, вСписке && вСписке.photo_count);
  const файл = await fetch(`${BASE}/media/${фото.file}`, { headers: { Cookie: продавец.cookie } });
  check('фото открывается', файл.status === 200 && файл.headers.get('content-type') === 'image/jpeg', файл.status);
  check('без входа — не открывается', (await fetch(`${BASE}/media/${фото.file}`)).status === 403);
  check('не картинка — отказ', (await продавец.зов('POST', `/api/orders/${заказ.id}/images`,
    { data: 'data:text/plain;base64,' + Buffer.from('<script>alert(1)</script>привет').toString('base64') })).status === 400);
  check('к несуществующему заказу — не найден', (await продавец.зов('POST', '/api/orders/999999/images',
    { data: JPEG })).status === 404);

  // Резервная копия: фото ремонта должны быть внутри, иначе после
  // восстановления доказательства пропадут.
  const копия = await fetch(BASE + '/api/backup/download', { headers: { Cookie: админ.cookie } });
  const архив = Buffer.from(await копия.arrayBuffer());
  check('фото ремонта попадает в резервную копию', копия.status === 200
    && архив.includes(Buffer.from('data/images/' + фото.file)), копия.status);

  check('продавец фото не удаляет — это доказательство',
    (await продавец.зов('DELETE', `/api/orders/${заказ.id}/images/${фото.id}`)).status === 403);
  check('чужой заказ в адресе — не найдено',
    (await админ.зов('DELETE', `/api/orders/${заказ.id + 1}/images/${фото.id}`)).status === 404);
  check('владелец удаляет', (await админ.зов('DELETE', `/api/orders/${заказ.id}/images/${фото.id}`)).status === 200);
  check('и файла больше нет', (await fetch(`${BASE}/media/${фото.file}`, { headers: { Cookie: админ.cookie } })).status === 404);

  for (let i = 0; i < 12; i++) await продавец.зов('POST', `/api/orders/${заказ.id}/images`, { data: JPEG });
  r = await продавец.зов('POST', `/api/orders/${заказ.id}/images`, { data: JPEG });
  check('больше двенадцати фото — отказ', r.status === 400, r.data);

  console.log('\n=== 4. Поиск по изделию ===');
  const поиск = (await админ.зов('GET', '/api/orders?search=' + encodeURIComponent(`цепь ${МЕТКА.toLowerCase()}`))).data.items;
  check('в разделе заказов — по названию изделия', поиск.some(o => o.id === заказ.id), поиск.length);
  const общий = (await админ.зов('GET', '/api/search?q=' + encodeURIComponent(`Цепь ${МЕТКА}`))).data;
  const группа = (общий.groups || []).find(g => g.key === 'orders');
  check('и в общем поиске', Boolean(группа) && группа.items.some(o => o.id === заказ.id), JSON.stringify(общий).slice(0, 200));

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
