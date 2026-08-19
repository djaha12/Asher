const ВЫВОД = require('node:path').join(__dirname, '.вывод');
require('node:fs').mkdirSync(ВЫВОД + '/shots-jewelry', { recursive: true });
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let ok = 0, fail = 0;
const check = (n, c, e) => c ? (ok++, console.log('  ok  ' + n))
  : (fail++, console.log('  FAIL ' + n, e === undefined ? '' : String(e).slice(0, 200)));
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });

  // Метки, по которым телефон понимает, что это приложение
  check('манифест подключён', await p.$('link[rel=manifest]') !== null);
  check('значок для iPhone подключён', await p.$('link[rel=apple-touch-icon]') !== null);
  check('iPhone откроет на весь экран',
    await p.$('meta[name="apple-mobile-web-app-capable"][content=yes]') !== null);
  check('имя приложения задано', await p.$('meta[name="apple-mobile-web-app-title"]') !== null);

  const man = await p.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  check('манифест читается как JSON', Boolean(man && man.name), man && man.name);
  check('режим — отдельное окно', man.display === 'standalone', man.display);
  check('значки в манифесте', (man.icons || []).length >= 2, (man.icons || []).length);
  check('есть значок 512 для Android', (man.icons || []).some(i => i.sizes === '512x512'));
  check('есть maskable-значок (круглая иконка Android)',
    (man.icons || []).some(i => (i.purpose || '').includes('maskable')));
  const iconOk = await p.evaluate(async () => {
    const r = await fetch('/icons/icon-512.png');
    return r.ok && (await r.blob()).size > 1000;
  });
  check('значок 512 скачивается и не пустой', iconOk);

  // QR для подключения телефона в настройках
  await p.fill('#login-username', 'admin');
  await p.fill('#login-password', 'admin123');
  await p.click('#login-form button[type=submit]');
  await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  await p.goto(`${BASE}/#/settings`);
  await p.waitForTimeout(1800);
  const qr = await p.$('.phone-qr svg');
  check('QR для телефона нарисован', Boolean(qr));
  const box = qr ? await qr.boundingBox() : null;
  check('QR достаточно крупный, чтобы навести камеру', box && box.width > 150, box && box.width);
  const txt = await p.textContent('#page');
  check('объяснено, как поставить значок на телефон', /На экран|Установить приложение/.test(txt));
  await p.screenshot({ path: ВЫВОД + '/shots-jewelry/13-телефон-qr.png', fullPage: true });

  await b.close();
  if (errors.length) { console.log('Ошибки JS:'); [...new Set(errors)].forEach(e => console.log('  ' + e)); }
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
