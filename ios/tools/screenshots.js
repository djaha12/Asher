'use strict';
/*
 * Скриншоты для App Store — из самой системы, а не нарисованные.
 *
 *   node ios/tools/screenshots.js
 *
 * Поднимает систему с выдуманными данными (те же, что в демо-версии), открывает
 * её в браузере размером с iPhone 16 Pro Max — 440×956 точек, втрое плотнее,
 * то есть 1320×2868 пикселей, ровно как просит Apple для экрана 6,9″ — и снимает
 * главные экраны. Сверху дорисована строка с часами и батареей: на телефоне
 * её рисует iOS, а в браузере её нет, и без неё снимок выглядит обрезанным.
 *
 * Результат — ios/appstore/screenshots/*.png; робот отправки берёт их оттуда.
 * Настоящих данных магазина здесь нет и быть не может: база своя, временная.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../../тесты/браузер');

const ROOT = path.resolve(__dirname, '..', '..');
const КУДА = path.join(ROOT, 'ios', 'appstore', 'screenshots');
const РАБОТА = fs.mkdtempSync(path.join(os.tmpdir(), 'asher-скриншоты-'));
const ПОРТ = Number(process.env.PORT || 3391);
const BASE = `http://127.0.0.1:${ПОРТ}`;

// iPhone 16 Pro Max: 440×956 точек, часы сверху занимают 62, полоска снизу — 34.
const ЭКРАН = { width: 440, height: 956 };
const ЧАСЫ = 62;
const ПОЛОСКА = 34;

// Изделие в чек — так же, как это делает продавец: поиск и выбор из списка.
async function вЧек(p, запрос) {
  await p.fill('#pos-search', запрос);
  await p.waitForSelector('.search-results .sr-item[data-i]', { timeout: 5000 });
  await p.dispatchEvent('.search-results .sr-item[data-i]', 'mousedown');
  await подождать(400);
}

const ЭКРАНЫ = [
  { файл: '01-dashboard.png', адрес: '#/dashboard' },
  {
    файл: '02-sale.png', адрес: '#/sales',
    перед: async p => {
      await p.click('#sf-new');
      await p.waitForSelector('#pos-search');
      await вЧек(p, 'Кольцо');
      await вЧек(p, 'Серьги');
      await p.click('.modal-head h2');
    },
  },
  {
    // Плитками, прокрутив к изделиям: так каталог выглядит, когда его листают.
    файл: '03-products.png', адрес: '#/products', прокрутка: '#pf-chips',
  },
  { файл: '04-labels.png', адрес: '#/labels', перед: async p => { await p.click('#lb-all'); } },
  { файл: '05-debts.png', адрес: '#/debts' },
  {
    // Окно, которое приложение показывает основателю после входа: о чём будут уведомления.
    файл: '06-notifications.png', адрес: '#/dashboard',
    перед: async p => {
      await p.evaluate(() => { sessionStorage.setItem('снимок-уведомлений', '1'); localStorage.removeItem('asher-уведомления'); });
      await p.reload({ waitUntil: 'networkidle' });
      await p.waitForSelector('.modal-head h2:has-text("Уведомления на телефон")', { timeout: 10000 });
    },
  },
];

// Строка состояния iPhone: время слева, связь и батарея справа.
const СТРОКА = `
(() => {
  const строка = document.createElement('div');
  строка.id = 'ios-status';
  строка.innerHTML = '<span>9:41</span><span class="ico">'
    + '<svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>'
    + '<svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.3c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8.5.6 10.2 10.2 0 0 0 1.3 3.5l1.2 1.2c1.6-1.5 3.7-2.4 6-2.4zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.2-1.2a6.8 6.8 0 0 0-9.6 0l1.2 1.2c1-.9 2.2-1.4 3.6-1.4zm0 3.4c.5 0 1 .2 1.3.5L8.5 11 7.2 9.6c.3-.3.8-.5 1.3-.5z"/></svg>'
    + '<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" opacity=".4"/></svg>'
    + '</span>';
  const стиль = document.createElement('style');
  стиль.textContent = '#ios-status{position:fixed;left:0;right:0;top:0;height:${ЧАСЫ}px;z-index:2147483647;'
    + 'display:flex;align-items:center;justify-content:space-between;padding:4px 34px 0 52px;box-sizing:border-box;'
    + 'font:600 17px/1 -apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;letter-spacing:-.2px;'
    + 'color:var(--ios-status,#fff);pointer-events:none}'
    + '#ios-status .ico{display:flex;gap:6px;align-items:center}#ios-status svg{fill:currentColor}';
  const вставить = () => { document.head.appendChild(стиль); document.body.appendChild(строка); };
  if (document.body) вставить(); else document.addEventListener('DOMContentLoaded', вставить);
})();
`;

const живПорт = порт => new Promise(res => {
  const s = net.connect(порт, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 300);
});
const подождать = мс => new Promise(r => setTimeout(r, мс));

(async () => {
  const окружение = {
    ...process.env, NO_OPEN: '1', NO_PROXY: '*', no_proxy: '*',
    ASHER_DB: path.join(РАБОТА, 'asher.db'), ASHER_MEDIA: path.join(РАБОТА, 'images'),
    ASHER_SYNC_DIR: path.join(РАБОТА, '1c'), ASHER_BACKUP_DIR: path.join(РАБОТА, 'backups'),
    PORT: String(ПОРТ), ASHER_STRICT_PORT: '1', ASHER_DEMO: '1',
    // Ключ уведомлений только для вида: карточка уведомлений показывается,
    // когда сервер умеет их слать. Отправлять здесь ничего не будем.
    ASHER_APNS_KEY_FILE: path.join(РАБОТА, 'apns.p8'), ASHER_APNS_KEY_ID: 'SCREENSHOT', ASHER_APNS_TEAM_ID: 'SCREENSHOT',
    ASHER_APNS_HOST: 'http://127.0.0.1:9',
  };
  const { privateKey } = require('node:crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(окружение.ASHER_APNS_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const посев = spawnSync(process.execPath, [path.join('src', 'seed.js'), '--reset'], { cwd: ROOT, env: окружение, encoding: 'utf8' });
  if (посев.status !== 0) throw new Error('Демо-данные не легли: ' + (посев.stderr || посев.stdout));
  const имя = spawnSync(process.execPath, ['-e', 'require("./src/db").setSetting("store_name", "Diamonds")'],
    { cwd: ROOT, env: окружение, encoding: 'utf8' });
  if (имя.status !== 0) throw new Error(имя.stderr);

  const сервер = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: окружение, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await живПорт(ПОРТ)); i++) await подождать(200);
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: ЭКРАН, deviceScaleFactor: 3, hasTouch: true, locale: 'ru-RU' });
    // Страница должна думать, что она в приложении: так она ведёт себя на iPhone.
    const swift = fs.readFileSync(path.join(ROOT, 'ios', 'Diamonds', 'Bridge.swift'), 'utf8');
    await ctx.addInitScript({ content: 'window.webkit={messageHandlers:{asher:{postMessage:function(){}}}};' });
    await ctx.addInitScript({ content: swift.match(/"""\n([\s\S]*?)\n\s*"""/)[1] });
    // Окно про уведомления после входа — только на своём, последнем снимке.
    await ctx.addInitScript({ content: "try{if(!sessionStorage.getItem('снимок-уведомлений'))localStorage.setItem('asher-уведомления','нет')}catch(e){}" });
    await ctx.addInitScript({ content: СТРОКА });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: ЧАСЫ, bottom: ПОЛОСКА } });

    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.fill('#login-username', 'admin');
    await p.fill('#login-password', 'admin123');
    await p.click('#login-form button[type=submit]');
    await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await p.evaluate(() => window.ui && ui.applyTheme && ui.applyTheme('dark'));

    fs.mkdirSync(КУДА, { recursive: true });
    for (const f of fs.readdirSync(КУДА)) if (f.endsWith('.png')) fs.rmSync(path.join(КУДА, f));
    for (const э of ЭКРАНЫ) {
      // Каждый экран — с чистого листа: окно прошлого снимка не должно остаться поверх.
      // Смена одного адреса после «#» страницу не перезагружает — перезагружаем сами.
      await p.goto(BASE + '/' + э.адрес);
      await p.reload({ waitUntil: 'networkidle' });
      await p.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
      await подождать(1200);
      if (э.перед) { await э.перед(p); await подождать(500); }
      await p.evaluate(куда => {
        const цель = куда && document.querySelector(куда);
        const шапка = document.querySelector('.mobile-head');
        window.scrollTo(0, цель ? цель.getBoundingClientRect().top + window.scrollY - (шапка ? шапка.offsetHeight : 0) - 12 : 0);
      }, э.прокрутка || '');
      await p.screenshot({ path: path.join(КУДА, э.файл) });
      console.log('снят ' + э.файл);
    }
    await b.close();
  } finally {
    сервер.kill();
    fs.rmSync(РАБОТА, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
