'use strict';
/*
 * Безопасность перед выходом в интернет.
 *
 * Проверяем не «есть ли код», а что именно случится, если в дверь начнут
 * стучаться: подбор пароля, украденная cookie, потерянный телефон, слабый
 * пароль, чужой скрипт в названии изделия.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3122';

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  ok  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

function session() {
  let cookie = '';
  let lastSetCookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    get setCookie() { return lastSetCookie; },
    async call(method, p, body, extraHeaders) {
      const res = await fetch(BASE + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(extraHeaders || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) { lastSetCookie = sc; cookie = sc.split(';')[0]; }
      let data = null;
      try { data = await res.json(); } catch { /* не JSON */ }
      return { status: res.status, data, headers: res.headers };
    },
    get(p, h) { return this.call('GET', p, undefined, h); },
    post(p, b, h) { return this.call('POST', p, b, h); },
    put(p, b) { return this.call('PUT', p, b); },
  };
}

const admin = session();
const stamp = Date.now();

async function main() {
  check('вход владельца', (await admin.post('/api/login', { username: 'admin', password: 'admin123' })).status === 200);

  console.log('\n=== Cookie сессии ===');
  const sc = admin.setCookie;
  check('cookie недоступна скриптам (HttpOnly)', /HttpOnly/i.test(sc), sc);
  check('cookie не уходит на чужие сайты (SameSite)', /SameSite=Lax/i.test(sc), sc);
  check('по обычному http флаг Secure не ставится — иначе вход в магазине сломается',
    !/;\s*Secure/i.test(sc), sc);
  check('в cookie только токен, без имени и роли',
    !/admin|role/i.test(sc.split(';')[0]), sc.split(';')[0].slice(0, 40));

  console.log('\n=== Защитные заголовки ===');
  const page = await fetch(BASE + '/');
  const csp = page.headers.get('content-security-policy') || '';
  check('страница отдаётся с политикой безопасности', csp.includes("default-src 'self'"), csp.slice(0, 120));
  check('чужие скрипты выполнить негде', /script-src 'self'/.test(csp), csp);
  check('систему нельзя открыть в чужом окне (frame-ancestors)', /frame-ancestors 'none'/.test(csp));
  check('браузер не угадывает тип файла',
    page.headers.get('x-content-type-options') === 'nosniff');
  check('запрет на встраивание в рамку', page.headers.get('x-frame-options') === 'DENY');
  check('адрес системы не утекает на чужие сайты',
    (page.headers.get('referrer-policy') || '').includes('same-origin'));
  check('камера разрешена только самой системе',
    /camera=\(self\)/.test(page.headers.get('permissions-policy') || ''),
    page.headers.get('permissions-policy'));
  check('по http строгий https не навязывается', !page.headers.get('strict-transport-security'));

  console.log('\n=== Подбор пароля ===');
  // Ломимся в одноразовую учётную запись: настоящий продавец после подбора
  // остался бы в паузе и подвёл бы остальные проверки.
  const victim = `victim${String(stamp).slice(-6)}`;
  const victimUser = await admin.post('/api/users', {
    username: victim, name: 'Мишень для проверки', password: 'nastoyashchii-2026',
  });
  check('мишень заведена', victimUser.status === 200, victimUser.data);
  const attacker = session();
  let blockedAt = 0;
  let lastMsg = '';
  for (let i = 1; i <= 12; i++) {
    const r = await attacker.post('/api/login', { username: victim, password: 'неверный' + i });
    if (r.status === 429) { blockedAt = i; lastMsg = r.data && r.data.error; break; }
  }
  check('после нескольких неудач вход закрывается', blockedAt > 0 && blockedAt <= 7, blockedAt);
  check('система объясняет, сколько ждать', /через/i.test(String(lastMsg)), lastMsg);
  const blockedRight = await attacker.post('/api/login', { username: victim, password: 'nastoyashchii-2026' });
  check('даже верный пароль в паузу не пускает', blockedRight.status === 429, blockedRight.status);

  // Пауза считается и по логину: другой «компьютер» тем же логином тоже ждёт.
  const other = session();
  const otherTry = await other.post('/api/login', { username: victim, password: 'nastoyashchii-2026' });
  check('подбор одного логина с другого адреса тоже остановлен', otherTry.status === 429, otherTry.status);

  // Главное: один забывчивый продавец не запирает весь магазин. В интернете
  // все телефоны магазина приходят с одного внешнего адреса, и блокировка по
  // адресу сорвала бы рабочий день всем.
  const boss = session();
  const bossTry = await boss.post('/api/login', { username: 'admin', password: 'admin123' });
  check('остальные сотрудники продолжают входить с того же адреса',
    bossTry.status === 200, bossTry.status);

  console.log('\n=== Попытки видны владельцу ===');
  const journal = await admin.get(
    `/api/audit?action=login_failed&from=${encodeURIComponent(new Date(stamp - 1000).toISOString())}&limit=50`);
  const items = journal.data.items || [];
  const entry = items.find(e => e.details.includes(victim));
  check('неудачные попытки записаны в журнал', items.length > 0, journal.data.total);
  check('в записи виден логин, по которому стучались', Boolean(entry), items[0] && items[0].details);
  check('и на сколько закрыт вход',
    Boolean(entry) && /мин/.test(entry.details), entry && entry.details);
  check('журнал не забит: по строке на ступень, а не на попытку',
    items.length <= 4, items.map(i => i.details));

  console.log('\n=== Слабые пароли ===');
  const weakCases = [
    ['короткий', 'abc123'],
    ['из словаря', 'password'],
    ['подбирается первым', 'admin123'],
    ['один знак подряд', '11111111'],
  ];
  for (const [what, pwd] of weakCases) {
    const r = await admin.post('/api/users', {
      username: `w${stamp}${Math.random().toString(36).slice(2, 6)}`, name: 'Тест', password: pwd,
    });
    check(`пароль «${what}» не принимается`, r.status === 400, r.data);
  }
  const goodUser = `sec${String(stamp).slice(-6)}`;
  const made = await admin.post('/api/users', {
    username: goodUser, name: 'Сотрудник для проверки', password: 'vitrina-2026',
  });
  check('нормальный пароль принимается', made.status === 200, made.data);
  const uid = made.data.id;

  console.log('\n=== Потерянный телефон ===');
  const phoneA = session(); const phoneB = session();
  check('вход с первого телефона',
    (await phoneA.post('/api/login', { username: goodUser, password: 'vitrina-2026' })).status === 200);
  check('вход со второго телефона',
    (await phoneB.post('/api/login', { username: goodUser, password: 'vitrina-2026' })).status === 200);
  const before = (await admin.get('/api/users')).data.items.find(u => u.id === uid);
  check('владелец видит, сколько устройств в системе', before.devices >= 2, before.devices);

  const closed = await admin.post(`/api/users/${uid}/logout-all`);
  check('владелец завершает все входы', closed.status === 200 && closed.data.closed >= 2, closed.data);
  check('первый телефон выкинут', (await phoneA.get('/api/me')).status === 401);
  check('второй телефон выкинут', (await phoneB.get('/api/me')).status === 401);
  const after = (await admin.get('/api/users')).data.items.find(u => u.id === uid);
  check('счётчик устройств обнулился', !after.devices, after.devices);

  console.log('\n=== Смена пароля обрывает чужие входы ===');
  const p1 = session(); const p2 = session();
  await p1.post('/api/login', { username: goodUser, password: 'vitrina-2026' });
  await p2.post('/api/login', { username: goodUser, password: 'vitrina-2026' });
  const chg = await admin.put('/api/users/' + uid, { password: 'novyi-parol-2026' });
  check('пароль сменён', chg.status === 200, chg.data);
  check('старый вход больше не работает', (await p1.get('/api/me')).status === 401);
  check('и второй тоже', (await p2.get('/api/me')).status === 401);
  const relog = await p1.post('/api/login', { username: goodUser, password: 'novyi-parol-2026' });
  check('с новым паролем заходит', relog.status === 200, relog.status);

  console.log('\n=== Свой пароль: остальные устройства выходят, это — нет ===');
  const me = session();
  await me.post('/api/login', { username: goodUser, password: 'novyi-parol-2026' });
  const other2 = session();
  await other2.post('/api/login', { username: goodUser, password: 'novyi-parol-2026' });
  const selfChange = await me.post('/api/me/password', { password: 'tretii-parol-2026' });
  check('смена своего пароля прошла', selfChange.status === 200, selfChange.data);
  check('сказано, сколько входов завершено', selfChange.data.sessions_closed >= 1, selfChange.data);
  check('текущее устройство осталось в системе', (await me.get('/api/me')).status === 200);
  check('остальные вышли', (await other2.get('/api/me')).status === 401);

  console.log('\n=== Отключённый сотрудник ===');
  const fired = session();
  await fired.post('/api/login', { username: goodUser, password: 'tretii-parol-2026' });
  check('работает, пока активен', (await fired.get('/api/me')).status === 200);
  await admin.put('/api/users/' + uid, { active: false });
  check('после отключения вход прекращается сразу', (await fired.get('/api/me')).status === 401);
  const tryLogin = await fired.post('/api/login', { username: goodUser, password: 'tretii-parol-2026' });
  check('и войти заново нельзя', tryLogin.status === 401, tryLogin.status);

  console.log('\n=== Чужие данные и подделка ===');
  const stolen = session();
  stolen.cookie = 'asher_session=' + 'f'.repeat(64);
  check('придуманная cookie не пускает', (await stolen.get('/api/me')).status === 401);
  const noAuth = await fetch(BASE + '/api/products');
  check('без входа каталог закрыт', noAuth.status === 401, noAuth.status);
  const media = await fetch(BASE + '/media/nothing.jpg');
  check('фотографии без входа закрыты', media.status === 403, media.status);
  const escapeText = await (await fetch(BASE + '/../server.js')).text();
  check('исходники системы наружу не отдаются', !/require\(|process\.env/.test(escapeText),
    escapeText.slice(0, 80));
  // Браузер сам выпрямляет «..» в адресе, поэтому стучимся сырым запросом.
  const raw = await new Promise(resolve => {
    const net = require('node:net');
    const c = net.connect(3122, '127.0.0.1', () => {
      c.write('GET /../server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let out = '';
    c.on('data', d => { out += d; });
    c.on('end', () => resolve(out));
    c.on('error', () => resolve(''));
  });
  check('и по «сырому» запросу с ../ тоже нет', !/require\(|process\.env/.test(raw),
    raw.slice(0, 120));

  // Подделка заголовка X-Forwarded-For: без явного доверия прокси её не слушают,
  // иначе перебор обходился бы одной строкой.
  const spoof = session();
  let spoofBlocked = false;
  for (let i = 0; i < 8; i++) {
    const r = await spoof.post('/api/login',
      { username: goodUser, password: 'нет' + i },
      { 'X-Forwarded-For': `10.0.0.${i}` });
    if (r.status === 429) { spoofBlocked = true; break; }
  }
  check('подменой адреса защиту не обойти — счёт идёт по логину', spoofBlocked);

  console.log('\n=== Резервная копия ===');
  const backup = await fetch(BASE + '/api/backup/download', { headers: { Cookie: admin.cookie } });
  check('копия скачивается', backup.status === 200, backup.status);
  const disp = backup.headers.get('content-disposition') || '';
  check('файлом, а не в окне браузера', /attachment/.test(disp), disp);
  const buf = Buffer.from(await backup.arrayBuffer());
  check('это архив', buf.slice(0, 2).toString('latin1') === 'PK', buf.slice(0, 4).toString('hex'));
  check('копия не пустая', buf.length > 100000, buf.length);
  // Главное, ради чего копия вообще существует: внутри должна быть не только
  // база, но и фотографии. Раньше их там не было, а написано было обратное.
  {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asher-backup-'));
    fs.writeFileSync(path.join(dir, 'b.zip'), buf);
    let listing = '';
    try { listing = execFileSync('unzip', ['-Z1', path.join(dir, 'b.zip')], { encoding: 'utf8' }); }
    catch (e) { listing = 'не распаковалось: ' + e.message; }
    const names = listing.split('\n').filter(Boolean);
    check('архив открывается', names.length > 1, names.length + ' файлов');
    check('внутри есть база', names.includes('data/asher.db'));
    const photos = names.filter(n => n.startsWith('data/images/'));
    check('внутри есть фотографии изделий', photos.length > 0, photos.length + ' шт.');
    check('внутри есть записка о восстановлении',
      names.some(n => /ВОССТАНОВИТЬ/.test(n)), names.filter(n => !n.startsWith('data/')));
    try {
      execFileSync('unzip', ['-qo', path.join(dir, 'b.zip'), 'data/asher.db', '-d', dir]);
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(path.join(dir, 'data/asher.db'), { readOnly: true });
      const n = d.prepare('SELECT COUNT(*) c FROM products').get().c;
      d.close();
      check('база из архива открывается и в ней есть изделия', n > 0, n);
    } catch (e) {
      check('база из архива открывается и в ней есть изделия', false, e.message.slice(0, 80));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dl = await admin.get('/api/audit?action=backup&limit=3');
  check('скачивание копии отмечено в журнале', (dl.data.items || []).length > 0);

  console.log('\n=== Продавцу закрытое остаётся закрытым ===');
  // Заводим нового: и «anna», и предыдущий продавец после проверок в паузе.
  const freshUser = `sec${String(stamp).slice(-6)}b`;
  const fresh = await admin.post('/api/users', {
    username: freshUser, name: 'Продавец для проверки прав', password: 'rabochii-parol-26',
  });
  check('сотрудник заведён', fresh.status === 200, fresh.data);
  const seller = session();
  const enter = await seller.post('/api/login', { username: freshUser, password: 'rabochii-parol-26' });
  check('продавец входит', enter.status === 200, enter.data);
  check('продавец не скачает базу', (await seller.get('/api/backup/download')).status === 403);
  check('продавец не завершит чужие сеансы',
    (await seller.post(`/api/users/${uid}/logout-all`)).status === 403);
  check('продавец не поднимет себя до администратора',
    (await seller.put(`/api/users/${fresh.data.id}`, { role: 'admin' })).status === 403);
  check('продавец не создаст сотрудника',
    (await seller.post('/api/users', { username: 'x' + stamp, name: 'x', password: 'parol-12345' })).status === 403);
  check('продавец не увидит журнал', (await seller.get('/api/audit')).status === 403);
  check('но работать может', (await seller.get('/api/products?limit=1')).status === 200);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (failures.length) console.log('Провалено:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
