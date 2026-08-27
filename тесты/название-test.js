'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
/*
 * Название магазина слушается настройка — везде, а не в шапке.
 *
 * Название всегда было настройкой, но подчинялись ей только шапка и экран
 * приложения. Вкладка браузера, имя значка на телефоне и экран входа были
 * написаны жёстко. Получалось хуже, чем «не переименовалось»: магазин
 * «Diamonds» видел на вкладке и на значке телефона чужое имя, а на экране
 * входа — то есть в первом, что вообще показывает система, — тоже чужое.
 *
 * Отдельно проверяется экранирование. Название вводит владелец, и кавычка
 * в нём (Ювелирный «Алмаз» латинскими кавычками) разорвала бы content="…"
 * в meta-теге, а угловая скобка — заголовок страницы.
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

const страница = async путь => (await fetch(BASE + путь)).text();

async function main() {
  const админ = сеанс();
  if (!await админ.войти('admin', 'admin123')) { console.error('Не удалось войти'); process.exit(2); }

  const было = (await админ.зов('GET', '/api/settings')).data.store_name;
  const подписьБыла = (await админ.зов('GET', '/api/settings')).data.site_note || '';
  const вернуть = async () => админ.зов('PUT', '/api/settings',
    { store_name: было, site_note: подписьБыла });

  try {
    console.log('=== 1. Простое название доезжает до вкладки и экрана входа ===');
    await админ.зов('PUT', '/api/settings', { store_name: 'Diamonds' });
    let html = await страница('/');
    check('в заголовке вкладки новое название', /<title>Diamonds — CRM<\/title>/.test(html),
      (html.match(/<title>[^<]*<\/title>/) || [''])[0]);
    check('на экране входа новое название', /<h1 id="login-title">Diamonds<\/h1>/.test(html));
    check('имя значка на телефоне (iPhone) сменилось',
      /apple-mobile-web-app-title" content="Diamonds"/.test(html));
    check('имя значка на телефоне (общее) сменилось',
      /application-name" content="Diamonds"/.test(html));
    /*
     * Комментарии из разметки выкидываем: человек их не видит, а пояснение
     * рядом с подстановкой вполне может называть прежнее имя — и проверка
     * падала бы на объяснении самой себя.
     */
    const видимое = html.replace(/<!--[\s\S]*?-->/g, '');
    check('старого названия на странице не осталось', !/Asher/.test(видимое),
      (видимое.match(/.{0,40}Asher.{0,40}/) || [''])[0]);
    check('неподставленных мест не осталось', !html.includes('{{'),
      (html.match(/\{\{[^}]*\}\}/) || [''])[0]);

    console.log('\n=== 2. Одно слово — без подстрочника, два — с ним ===');
    check('подстрочник пуст при одном слове',
      /<p class="login-sub" id="login-sub"><\/p>/.test(html), 'подстрочник не пуст');
    await админ.зов('PUT', '/api/settings', { store_name: 'Asher Diamonds' });
    html = await страница('/');
    check('крупно — первое слово', /<h1 id="login-title">Asher<\/h1>/.test(html));
    check('подстрочником — остальное',
      /<p class="login-sub" id="login-sub">Diamonds<\/p>/.test(html));
    check('на вкладке — название целиком', /<title>Asher Diamonds — CRM<\/title>/.test(html));

    console.log('\n=== 3. Манифест — его читает сам телефон, не наша страница ===');
    const манифестТекст = await страница('/manifest.webmanifest');
    check('неподставленных мест нет', !манифестТекст.includes('{{'), манифестТекст.slice(0, 120));
    let манифест = null;
    try { манифест = JSON.parse(манифестТекст); } catch { /* ниже */ }
    check('манифест остался правильным JSON', манифест !== null, манифестТекст.slice(0, 120));
    check('полное название в манифесте', манифест && манифест.name === 'Asher Diamonds — учёт',
      манифест && манифест.name);
    check('короткое название в манифесте', манифест && манифест.short_name === 'Asher',
      манифест && манифест.short_name);

    console.log('\n=== 4. Кавычка и угловая скобка в названии не ломают страницу ===');
    /*
     * Название вводит владелец, и кавычка в нём — не выдумка: «Ювелирный
     * "Алмаз"» набирают именно так. Без экранирования она закрыла бы
     * content="…" в meta-теге, и остаток названия телефон прочитал бы как
     * новые атрибуты. Угловая скобка тем же способом рвёт заголовок вкладки.
     */
    await админ.зов('PUT', '/api/settings', { store_name: 'Ювелирный "Алмаз" <b>' });
    html = await страница('/');
    const тегЗначка = (html.match(/<meta name="apple-mobile-web-app-title"[^>]*>/) || [''])[0];
    check('атрибут значка не разорван кавычкой',
      тегЗначка === '<meta name="apple-mobile-web-app-title" content="Ювелирный">', тегЗначка);
    const заголовок = (html.match(/<title>[^<]*<\/title>/) || [''])[0];
    check('в заголовке вкладки кавычка и скобка обезврежены',
      заголовок === '<title>Ювелирный &quot;Алмаз&quot; &lt;b&gt; — CRM</title>', заголовок);
    check('название не превратилось в разметку', !/<b>/.test(html.split('</head>')[0]),
      'угловая скобка доехала до страницы как разметка');
    const мЭкран = await страница('/manifest.webmanifest');
    let мЭ = null;
    try { мЭ = JSON.parse(мЭкран); } catch { /* ниже */ }
    check('манифест с кавычкой остался правильным JSON', мЭ !== null, мЭкран.slice(0, 140));

    console.log('\n=== 5. Подпись для тех, кто ещё не вошёл ===');
    /*
     * Отдельная настройка, а не второе слово названия. Название печатается
     * на чеках и стоит в шапке у продавцов: дописать в него «в разработке» —
     * значит написать это и покупателю на чеке. А сказать заглянувшему, что
     * система ещё не открыта, иногда нужно.
     */
    await админ.зов('PUT', '/api/settings', { store_name: 'Diamonds', site_note: 'в разработке' });
    html = await страница('/');
    check('подпись видна под названием на входе',
      /<p class="login-sub" id="login-sub">в разработке<\/p>/.test(html),
      (html.match(/id="login-sub">[^<]*/) || [''])[0]);
    check('название при этом не изменилось',
      /<h1 id="login-title">Diamonds<\/h1>/.test(html));
    check('подпись попала в описание страницы',
      /<meta name="description" content="Diamonds — в разработке">/.test(html),
      (html.match(/<meta name="description"[^>]*>/) || [''])[0]);
    check('и в описание для мессенджеров',
      /<meta property="og:description" content="Diamonds — в разработке">/.test(html));
    const мПодпись = JSON.parse(await страница('/manifest.webmanifest'));
    check('и в описание приложения на телефоне',
      мПодпись.description === 'Diamonds — в разработке', мПодпись.description);
    check('название магазина в настройках осталось чистым',
      (await админ.зов('GET', '/api/settings')).data.store_name === 'Diamonds');

    console.log('\n=== 6. Без подписи всё как было ===');
    await админ.зов('PUT', '/api/settings', { store_name: 'Asher Diamonds', site_note: '' });
    html = await страница('/');
    check('под названием снова второе слово',
      /<p class="login-sub" id="login-sub">Diamonds<\/p>/.test(html),
      (html.match(/id="login-sub">[^<]*/) || [''])[0]);
    check('описание общее, без подписи',
      /content="Asher Diamonds — учётная система ювелирного магазина"/.test(html),
      (html.match(/<meta name="description"[^>]*>/) || [''])[0]);

    console.log('\n=== 7. Подстановка работает и на внутренних адресах ===');
    /*
     * Любой адрес отдаёт index.html — это одностраничное приложение.
     * Подстановка живёт в двух местах кода (обычная выдача и запасная),
     * и забыть её во втором было бы легко: вкладка называлась бы правильно
     * при заходе на «/» и «{{НАЗВАНИЕ}}» — при заходе по прямой ссылке.
     */
    await админ.зов('PUT', '/api/settings', { store_name: 'Diamonds' });
    const внутренняя = await страница('/products/12345');
    check('на внутреннем адресе подстановка тоже прошла',
      !внутренняя.includes('{{') && /<title>Diamonds — CRM<\/title>/.test(внутренняя),
      (внутренняя.match(/\{\{[^}]*\}\}|<title>[^<]*<\/title>/) || [''])[0]);
  } finally {
    await вернуть();
  }

  const назад = (await админ.зов('GET', '/api/settings')).data.store_name;
  check('название вернули как было', назад === было, `${назад} вместо ${было}`);

  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
