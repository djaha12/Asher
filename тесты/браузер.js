'use strict';
/*
 * Один вход для всех проверок, которым нужен настоящий браузер.
 *
 * Playwright может быть установлен по-разному: локально в node_modules проекта
 * или глобально (npm i -g). Раньше путь был вписан прямо в каждый набор, и на
 * чужой машине все браузерные проверки разом переставали запускаться. Здесь
 * ищем его во всех обычных местах и один раз.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function найти() {
  // Обычный путь: локальный node_modules, затем NODE_PATH.
  try { return require('playwright'); } catch { /* ищем дальше */ }
  // Глобальная установка — спрашиваем у самого npm, где она лежит.
  try {
    const корень = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return require(path.join(корень, 'playwright'));
  } catch { /* нет и там */ }
  return null;
}

const pw = найти();

if (!pw) {
  console.error('\nДля этой проверки нужен Playwright — она открывает настоящий браузер.');
  console.error('Установить:  npm i -D playwright && npx playwright install chromium\n');
  process.exit(3);
}

/*
 * Где лежит сам Chromium. Обычно Playwright знает это сам — тогда ничего
 * подставлять не надо. Но в некоторых окружениях браузеры распакованы отдельно
 * от библиотеки; на такой случай путь берётся из ASHER_CHROME или из
 * PLAYWRIGHT_BROWSERS_PATH. Раньше он был вписан в каждый набор жёстко, и на
 * любой другой машине все браузерные проверки падали на первой же строке.
 */
function путьКБраузеру() {
  if (process.env.ASHER_CHROME) return process.env.ASHER_CHROME;
  const база = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!база || база === '0') return undefined;
  const fs = require('node:fs');
  const варианты = [];
  try {
    for (const d of fs.readdirSync(база)) {
      if (!/^chromium/.test(d)) continue;
      варианты.push(path.join(база, d, 'chrome-linux', 'chrome'), path.join(база, d));
    }
  } catch { /* папки нет — пусть решает Playwright */ }
  варианты.push(path.join(база, 'chromium'));
  return варианты.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

const CHROME = путьКБраузеру();

/*
 * launch() с уже подставленным браузером — наборам остаётся передать свои
 * настройки, не думая о том, где что установлено.
 */
/*
 * Каждое окно браузера тоже должно называть себя устройством.
 *
 * Система пускает только с известных устройств, а приложение берёт отметку
 * из памяти браузера. Свежее окно в проверках — всегда «первый раз», и без
 * этой подстановки каждое из них просилось бы на разрешение к владельцу.
 * Подставляем ту же отметку, что у остальных проверок: она уже разрешена.
 *
 * Набору, которому нужны РАЗНЫЕ устройства (проверка живого обновления),
 * достаточно передать своё значение в newContext({ устройство: '...' }).
 */
const { КЛЮЧ } = require('./устройство');

function обернутьБраузер(b) {
  const настоящий = b.newContext.bind(b);
  b.newContext = async (opts = {}) => {
    const { устройство, ...остальное } = opts;
    const ctx = await настоящий(остальное);
    await ctx.addInitScript(ключ => {
      try { localStorage.setItem('asher-устройство', ключ); } catch { /* нет памяти — ну и ладно */ }
    }, устройство || КЛЮЧ);
    return ctx;
  };
  return b;
}

const chromium = {
  ...pw.chromium,
  launch: async (opts = {}) =>
    обернутьБраузер(await pw.chromium.launch(CHROME ? { executablePath: CHROME, ...opts } : opts)),
};

module.exports = { ...pw, chromium, CHROME, КЛЮЧ };
