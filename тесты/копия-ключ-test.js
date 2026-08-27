'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Ключ для ежедневных копий.
 *
 * Копия, лежащая на том же диске, что и база, не спасает ни от сбоя диска,
 * ни от пропавшего сервера, ни от забытой оплаты хостинга — а именно так
 * магазины и теряют учёт. Спасает копия в другом месте, и забирать её должен
 * компьютер по расписанию: человек забудет, и это свойство людей.
 *
 * Отсюда ключ — и отсюда же осторожность. Это единственный адрес, на который
 * система отвечает без пароля, а отдаёт он всё: изделия, продажи, клиентов,
 * долги, журнал и фотографии. Поэтому здесь проверяется не «работает ли»,
 * а «не работает ли лишнего»: без ключа, с чужим ключом, после отзыва,
 * из-под продавца, и не утекает ли сам ключ в ответы страницы.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 260)); }
};

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

// Скачивание идёт БЕЗ печенья сессии — так его и делает задача Windows.
async function скачать(ключ) {
  const r = await fetch(`${BASE}/api/backup/download?key=${encodeURIComponent(ключ)}`);
  if (r.status !== 200) return { status: r.status, зип: false, размер: 0 };
  const buf = Buffer.from(await r.arrayBuffer());
  // PK — первые два байта любого zip-архива.
  return { status: 200, зип: buf[0] === 0x50 && buf[1] === 0x4B, размер: buf.length };
}

async function main() {
  const админ = сеанс();
  const продавец = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }
  if (!await продавец.войти('anna', 'seller123')) { console.error('Продавец не вошёл'); process.exit(2); }

  console.log('=== 1. Пока ключ не выдан, адрес закрыт ===');
  await админ.зов('DELETE', '/api/backup/key');          // на случай, если остался от прошлого прогона
  const без = await скачать('');
  check('без ключа не пускает', без.status === 401, без.status);
  const слюбым = await скачать('какой-нибудь-ключ');
  check('с выдуманным ключом не пускает', слюбым.status === 401, слюбым.status);
  const состояние0 = await админ.зов('GET', '/api/security/status');
  check('система знает, что ключа нет', состояние0.data.backup_key_set === false,
    состояние0.data.backup_key_set);

  console.log('\n=== 2. Ключ выдаёт только владелец ===');
  const чужой = await продавец.зов('POST', '/api/backup/key');
  check('продавцу ключ не выдаётся', чужой.status === 403, чужой.status);
  const выдан = await админ.зов('POST', '/api/backup/key');
  check('владельцу выдаётся', выдан.status === 200, выдан.data);
  const ключ = выдан.data && выдан.data.key;
  /*
   * Из алфавита выброшены ровно два знака: «l» (путают с единицей) и «o»
   * (путают с нулём). Единица и ноль выброшены тоже — они и есть вторая
   * половина этих пар. Всё остальное разрешено, включая «i».
   */
  check('ключ длинный и без похожих знаков',
    typeof ключ === 'string' && ключ.length === 32 && /^[a-km-np-z2-9]+$/.test(ключ), ключ);

  console.log('\n=== 3. По ключу скачивается настоящий архив ===');
  const копия = await скачать(ключ);
  check('скачивание прошло', копия.status === 200, копия.status);
  check('это архив, а не страница с ошибкой', копия.зип, 'первые байты не PK');
  check('архив не пустой', копия.размер > 1000, копия.размер);

  console.log('\n=== 4. Один знак мимо — и не пускает ===');
  /*
   * Проверка не про «а вдруг сравнение сломано», а про то, что сравнение
   * посимвольное и полное. Ключ сравнивается за постоянное время именно
   * поэтому: обычное сравнение по времени ответа выдаёт, сколько знаков
   * совпало, и ключ подбирается знак за знаком вместо полного перебора.
   */
  const почти = ключ.slice(0, -1) + (ключ.slice(-1) === 'a' ? 'b' : 'a');
  const мимо = await скачать(почти);
  check('ключ с одной изменённой буквой не подходит', мимо.status === 401, мимо.status);
  const короче = await скачать(ключ.slice(0, -1));
  check('укороченный ключ не подходит', короче.status === 401, короче.status);

  console.log('\n=== 5. Ключ не утекает обратно в систему ===');
  /*
   * Он показывается один раз, при выдаче. Если бы он возвращался в состоянии
   * безопасности или в настройках, он оседал бы в журналах прокси и в истории
   * браузера у каждого, кто открывал эти страницы.
   */
  const состояние = await админ.зов('GET', '/api/security/status');
  check('состояние говорит, что ключ есть', состояние.data.backup_key_set === true);
  check('но самого ключа в ответе нет',
    !JSON.stringify(состояние.data).includes(ключ), 'ключ вернулся в состоянии');
  const настройки = await админ.зов('GET', '/api/settings');
  check('и в настройках его тоже нет',
    !JSON.stringify(настройки.data).includes(ключ), 'ключ вернулся в настройках');

  console.log('\n=== 6. Скачивание видно в журнале действий ===');
  /*
   * Копия — это все данные магазина. Если её однажды заберут не те, владелец
   * должен увидеть в журнале хотя бы то, что её забирали.
   */
  const журнал = await админ.зов('GET', '/api/audit?action=backup&limit=10');
  const записи = ((журнал.data || {}).items || []);
  check('запись о скачивании есть', записи.some(з => /резервная копия/i.test(з.details || '')),
    записи.map(з => з.details).slice(0, 3));
  check('видно, что копию забрали по ключу, а не руками',
    записи.some(з => /по ключу/i.test(з.details || '')),
    записи.map(з => з.details).slice(0, 3));

  console.log('\n=== 7. Новый ключ отменяет прежний ===');
  const второй = await админ.зов('POST', '/api/backup/key');
  const ключ2 = второй.data && второй.data.key;
  check('второй ключ отличается от первого', ключ2 && ключ2 !== ключ);
  const староеСкачивание = await скачать(ключ);
  check('прежний ключ перестал работать', староеСкачивание.status === 401, староеСкачивание.status);
  const новоеСкачивание = await скачать(ключ2);
  check('новый ключ работает', новоеСкачивание.status === 200 && новоеСкачивание.зип,
    новоеСкачивание.status);

  console.log('\n=== 8. Отзыв закрывает дверь совсем ===');
  const отзыв = await продавец.зов('DELETE', '/api/backup/key');
  check('продавец отозвать не может', отзыв.status === 403, отзыв.status);
  check('владелец отзывает', (await админ.зов('DELETE', '/api/backup/key')).status === 200);
  const послеОтзыва = await скачать(ключ2);
  check('после отзыва ключ не работает', послеОтзыва.status === 401, послеОтзыва.status);
  check('повторный отзыв объясняется, а не молчит',
    (await админ.зов('DELETE', '/api/backup/key')).status === 400);
  const состояние2 = await админ.зов('GET', '/api/security/status');
  check('система снова знает, что ключа нет', состояние2.data.backup_key_set === false);

  console.log('\n=== 9. Кнопка владельца работает как работала ===');
  /*
   * Ключ добавлялся к существующей кнопке, а не вместо неё. Проверяем, что
   * обычное скачивание из-под владельца не сломалось общим переносом кода.
   */
  const вход = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const печенье = (вход.headers.get('set-cookie') || '').split(';')[0];
  const кнопкой = await fetch(BASE + '/api/backup/download', { headers: { Cookie: печенье } });
  const байты = Buffer.from(await кнопкой.arrayBuffer());
  check('владелец скачивает копию кнопкой',
    кнопкой.status === 200 && байты[0] === 0x50 && байты[1] === 0x4B, кнопкой.status);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
