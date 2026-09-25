'use strict';
require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
/*
 * Камера в кассе: одно нажатие — и бирки читаются сами.
 *
 * Раньше на каждое изделие открывалась камера телефона: снять, «использовать
 * фото», и так на каждую бирку. А на iPhone не читалось вообще ничего: там
 * система распознаёт только QR, а на бирках по умолчанию был один штрихкод.
 *
 * Здесь браузеру вместо камеры подаётся видео, в кадре которого — QR бирки.
 * Распознаёт его тот же jsQR, что и на iPhone (в этом браузере встроенного
 * распознавателя штрихкодов нет), так что проверяется ровно путь iPhone.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const qrcode = require('../public/js/vendor/qrcode-generator.js');
const { chromium, снимок } = require('./браузер');

const BASE = process.env.BASE || 'http://127.0.0.1:3122';
const OUT = path.join(ВЫВОД, 'shots-камера');
fs.mkdirSync(OUT, { recursive: true });

let ok = 0, fail = 0;
const провалы = [];
const check = (имя, усл, доп) => {
  if (усл) { ok++; console.log('  ok  ' + имя); }
  else { fail++; провалы.push(имя); console.log('  FAIL ' + имя, доп === undefined ? '' : String(доп).slice(0, 220)); }
};

/*
 * Видео для «камеры»: несколько одинаковых кадров Y4M с QR посередине.
 * Y4M — самый простой формат, который Chromium принимает вместо камеры:
 * заголовок, потом кадр за кадром яркость и два поля цвета.
 */
function видеоСQR(текст, файл) {
  const qr = qrcode(0, 'M');
  qr.addData(текст);
  qr.make();
  const n = qr.getModuleCount();
  const W = 640, H = 480, клетка = 10;
  const сторона = (n + 8) * клетка;           // с белым полем в четыре клетки
  const x0 = Math.floor((W - сторона) / 2), y0 = Math.floor((H - сторона) / 2);
  const Y = Buffer.alloc(W * H, 235);          // светлый фон
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let dy = 0; dy < клетка; dy++) {
        const y = y0 + (r + 4) * клетка + dy;
        Y.fill(16, y * W + x0 + (c + 4) * клетка, y * W + x0 + (c + 5) * клетка);
      }
    }
  }
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  const кадр = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  const части = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 20; i++) части.push(кадр);
  fs.writeFileSync(файл, Buffer.concat(части));
}

async function сеанс(логин, пароль) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: логин, password: пароль }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return async (метод, путь, тело) => {
    const res = await fetch(BASE + путь, {
      method: метод,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: тело === undefined ? undefined : JSON.stringify(тело),
    });
    let data = null;
    try { data = await res.json(); } catch { /* пусто */ }
    return { status: res.status, data };
  };
}

async function войти(page, логин, пароль) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', логин);
  await page.fill('#login-password', пароль);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
}

(async () => {
  const админ = await сеанс('admin', 'admin123');
  const sku = 'CAM-' + process.pid;
  const изделие = await админ('POST', '/api/products', {
    sku, name: 'Кольцо для проверки камеры', metal: 'Золото', retail_price: 41000, purchase_price: 15000,
  });
  check('изделие для проверки заведено', изделие.status === 200, JSON.stringify(изделие.data));

  /*
   * Видео — во временную папку, а не в тесты/.вывод: путь с кириллицей
   * Chromium в этом ключе не открывает («Could not start video source»),
   * и камера молча не включается.
   */
  const видео = path.join(os.tmpdir(), `asher-qr-${process.pid}.y4m`);
  видеоСQR(sku, видео);
  process.on('exit', () => { try { fs.unlinkSync(видео); } catch { /* уже нет */ } });

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${видео}`],
  });
  const ошибки = [];

  console.log('=== 1. Касса: одно нажатие — изделие добавилось само ===');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['camera'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', e => ошибки.push(e.message));
  await войти(page, 'anna', 'seller123');
  await page.click('#btn-quick-sale');
  await page.waitForSelector('#pos-scan');
  await page.click('#pos-scan');
  let добавилось = false;
  try {
    await page.waitForFunction(s => [...document.querySelectorAll('.pos-item')].some(el => el.textContent.includes(s)),
      sku, { timeout: 15000 });
    добавилось = true;
  } catch { /* ниже провалится */ }
  check('камера прочитала QR и изделие в чеке — без фото и подтверждений', добавилось);
  check('кнопка камеры показывает, что камера включена',
    await page.locator('#pos-scan').evaluate(b => b.classList.contains('active')));
  await снимок(page, { path: `${OUT}/касса-камера.png` });

  await page.waitForTimeout(4000);   // бирка всё это время в кадре
  check('бирка, долго стоящая в кадре, добавлена один раз',
    (await page.$$eval('.pos-item', r => r.length)) === 1, await page.$$eval('.pos-item', r => r.length));

  await page.click('#pos-scan');
  await page.waitForTimeout(300);
  check('второе нажатие выключает камеру', !(await page.$('#pos-camera video'))
    && !(await page.locator('#pos-scan').evaluate(b => b.classList.contains('active'))));

  await page.click('#pos-scan');
  await page.waitForSelector('#pos-camera video', { timeout: 5000 }).catch(() => {});
  await page.click('.modal .modal-close');
  await page.waitForTimeout(300);
  check('закрыли кассу — камера телефона выключилась', !(await page.$('video')));
  await ctx.close();

  console.log('\n=== 2. QR на бирках включён по умолчанию ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => ошибки.push(e.message));
  await войти(page2, 'admin', 'admin123');
  const qrНаБирке = async () => {
    await page2.goto(BASE + '/#/labels');
    await page2.waitForSelector('#lb-search');
    await page2.fill('#lb-search', sku);
    await page2.waitForTimeout(1200);
    await page2.locator('#lb-list input[data-pick]').first().check();
    await page2.waitForTimeout(300);
    return Boolean(await page2.$('#lb-preview .jl-qr svg'));
  };
  check('на новой бирке есть QR', await qrНаБирке());

  // Устройство, где раньше сохранили настройки бирок с прежним умолчанием «без QR».
  await page2.evaluate(() => localStorage.setItem('asher_label_opts',
    JSON.stringify({ name: true, sku: true, qr: false })));
  await page2.reload();
  await page2.waitForSelector('#app:not(.hidden)');
  check('прежнее умолчание «без QR» включено один раз', await qrНаБирке());

  // А если QR выключили уже после этого — так и остаётся.
  await page2.evaluate(() => localStorage.setItem('asher_label_opts',
    JSON.stringify({ name: true, sku: true, qr: false, qr_v2: true })));
  await page2.reload();
  await page2.waitForSelector('#app:not(.hidden)');
  check('выключенный нарочно QR остаётся выключенным', !(await qrНаБирке()));
  await ctx2.close();

  check('в браузере нет ошибок', ошибки.length === 0, ошибки.slice(0, 3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  if (провалы.length) console.log('Провалено:\n  - ' + провалы.join('\n  - '));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
