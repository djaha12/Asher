'use strict';
/*
 * Автообмен с 1С и автоматические резервные копии.
 *
 * Автообмен: рядом с программой лежит папка «1С-ОБМЕН». Кладёте в неё
 * CSV-выгрузку из 1С — система сама распознаёт колонки, обновляет цены,
 * добавляет новые позиции и переносит файл в подпапку «обработано»
 * (или «ошибки») вместе с текстовым отчётом. Ничего нажимать не нужно.
 *
 * Резервные копии: раз в сутки снимок базы кладётся в «РЕЗЕРВНЫЕ-КОПИИ».
 * Снимок делается через VACUUM INTO — это целостная копия, даже если
 * в этот момент идут продажи. Хранятся последние 14 копий.
 */
const fs = require('node:fs');
const path = require('node:path');

const { db, nowIso, getSetting, setSetting, audit } = require('./db');
const { importCsv, parseCsv, detectDelimiter, suggestMapping, PRODUCT_MAP_HINTS } = require('./api/importexport');

const ROOT = path.join(__dirname, '..');
const SYNC_DIR = process.env.ASHER_SYNC_DIR || path.join(ROOT, '1С-ОБМЕН');
const DONE_DIR = path.join(SYNC_DIR, 'обработано');
const FAIL_DIR = path.join(SYNC_DIR, 'ошибки');
const BACKUP_DIR = process.env.ASHER_BACKUP_DIR || path.join(ROOT, 'РЕЗЕРВНЫЕ-КОПИИ');

const POLL_MS = Number(process.env.ASHER_SYNC_INTERVAL) || 15000;
const BACKUP_EVERY_MS = 20 * 3600 * 1000; // «раз в сутки» с запасом на разное время запуска
const BACKUPS_KEEP = 14;

db.exec(`CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  message TEXT DEFAULT '',
  created_at TEXT NOT NULL
)`);

// Кодировку выгрузки определяем по содержимому: 1С часто отдаёт Windows-1251.
function decodeSmart(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

function safeMove(from, toDir, name) {
  fs.mkdirSync(toDir, { recursive: true });
  let target = path.join(toDir, name);
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    target = path.join(toDir, `${stamp}_${name}`);
  }
  fs.renameSync(from, target);
  return target;
}

function writeReport(nearFile, lines) {
  try {
    fs.writeFileSync(nearFile.replace(/\.csv$/i, '') + '.отчёт.txt', lines.join('\r\n'), 'utf8');
  } catch { /* отчёт — не повод ронять обмен */ }
}

function logSync(file, status, res, message) {
  db.prepare(
    `INSERT INTO sync_log (file, status, created, updated, unchanged, skipped, message, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(file, status, res.created || 0, res.updated || 0, res.unchanged || 0, res.skipped || 0,
    String(message || ''), nowIso());
  db.prepare(`DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 200)`).run();
}

/*
 * Обработка одного файла выгрузки. Колонки распознаются автоматически;
 * обязательны «Артикул» и «Наименование» — по артикулу обновляются цены
 * существующих изделий, новые добавляются. Названия и категории не трогаем:
 * их в системе часто правят руками под витрину.
 */
function processFile(fullPath) {
  const name = path.basename(fullPath);
  let csv;
  try {
    csv = decodeSmart(fs.readFileSync(fullPath));
  } catch (e) {
    const moved = safeMove(fullPath, FAIL_DIR, name);
    writeReport(moved, ['Файл не удалось прочитать: ' + e.message]);
    logSync(name, 'error', {}, 'Файл не читается');
    return;
  }

  const delimiter = detectDelimiter(csv);
  const rows = parseCsv(csv, delimiter);
  const headers = (rows[0] || []).map(h => String(h).trim());
  const mapping = suggestMapping(headers, PRODUCT_MAP_HINTS);

  /*
   * Годятся два вида файлов:
   *   — полная выгрузка: артикул + наименование (заводит новые изделия);
   *   — прайс-лист: артикул + цена, без наименований (только переоценка).
   * Артикул обязателен всегда: без него изделие не с чем сопоставить.
   */
  const hasPrice = mapping.retail_price !== undefined || mapping.purchase_price !== undefined;
  const priceOnly = mapping.name === undefined;
  if (rows.length < 2 || mapping.sku === undefined || (priceOnly && !hasPrice)) {
    const moved = safeMove(fullPath, FAIL_DIR, name);
    writeReport(moved, [
      'Автообмен не смог обработать файл.',
      '',
      rows.length < 2 ? 'В файле нет данных.' : '',
      mapping.sku === undefined ? 'Не найдена колонка «Артикул» — без неё нельзя сопоставить изделия.' : '',
      priceOnly && !hasPrice ? 'Нет ни наименований, ни цен — обновлять нечего.' : '',
      '',
      'Найденные колонки: ' + headers.join(' | '),
      'Нужен либо артикул с наименованием (полная выгрузка),',
      'либо артикул с ценой (прайс-лист для переоценки).',
      'Обработайте файл вручную: раздел «Импорт из 1С» в системе.',
    ].filter(Boolean));
    logSync(name, 'error', {}, 'Не распознаны колонки (нужен артикул и наименование либо цена)');
    return;
  }

  try {
    const res = importCsv({
      csv,
      entity: 'products',
      mapping,
      delimiter,
      update_existing: true,
      update_fields: ['retail_price', 'purchase_price'],
    }, null);

    const moved = safeMove(fullPath, DONE_DIR, name);
    writeReport(moved, [
      `Автообмен с 1С — ${new Date().toLocaleString('ru-RU')}`,
      `Файл: ${name}`,
      priceOnly ? 'Вид файла: прайс-лист (только артикулы и цены)' : 'Вид файла: выгрузка номенклатуры',
      '',
      `Добавлено новых изделий: ${res.created}`,
      `Обновлены цены:          ${res.updated}`,
      `Без изменений:           ${res.unchanged}`,
      `Пропущено:               ${res.skipped}`,
      '',
      ...(res.errors.length ? ['Замечания:', ...res.errors.map(e => '  - ' + e)] : ['Замечаний нет.']),
    ]);
    logSync(name, 'ok', res, '');
    audit(null, 'sync', 'products', null,
      `Автообмен ${name}: +${res.created}, обновлено ${res.updated}`);
  } catch (e) {
    const moved = safeMove(fullPath, FAIL_DIR, name);
    writeReport(moved, ['Ошибка при импорте: ' + e.message]);
    logSync(name, 'error', {}, e.message);
  }
}

/*
 * Папку опрашиваем раз в POLL_MS и берём файл в работу только когда его
 * размер перестал меняться: 1С может писать выгрузку несколько секунд,
 * и хвататься за недописанный файл нельзя.
 */
const pendingSizes = new Map();
let busy = false;

function tick() {
  if (busy) return;
  busy = true;
  try {
    let names;
    try { names = fs.readdirSync(SYNC_DIR); } catch { return; }
    for (const name of names) {
      if (!/\.csv$/i.test(name)) continue;
      const full = path.join(SYNC_DIR, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      const prev = pendingSizes.get(name);
      if (prev === stat.size) {
        pendingSizes.delete(name);
        processFile(full);
      } else {
        pendingSizes.set(name, stat.size);
      }
    }
    // подчистка записей об исчезнувших файлах
    for (const key of pendingSizes.keys()) {
      if (!names.includes(key)) pendingSizes.delete(key);
    }
  } finally {
    busy = false;
  }
}

// ---------- Резервные копии ----------

/*
 * Сколько свободного места на диске, в мегабайтах. null — узнать не удалось.
 *
 * Нужно до того, как копия не сделается: закончившееся место — самая частая
 * причина, по которой копии тихо прекращаются, и единственная, которую видно
 * заранее.
 */
function свободноМб() {
  try {
    const s = fs.statfsSync(BACKUP_DIR);
    return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch { return null; }
}

/*
 * Сбой копии обязан быть заметен.
 *
 * Раньше здесь была одна строка в чёрное окно — то есть в никуда: владелец
 * туда не смотрит, а на сервере это вообще уходит в системный журнал. Копии
 * могли не делаться месяцами, и выяснилось бы это в тот единственный день,
 * когда копия понадобилась.
 *
 * Теперь сбой запоминается в базе (её видит страница «Безопасность» и Главная)
 * и попадает в журнал действий. В журнал — только при СМЕНЕ состояния, иначе
 * ежечасная проверка забила бы его тысячами одинаковых строк и спрятала за
 * собой работу продавцов.
 */
function отметитьСбойКопии(причина) {
  const было = getSetting('backup_error') || '';
  setSetting('backup_error', причина);
  setSetting('backup_error_at', nowIso());
  if (было !== причина) {
    audit(null, 'backup_failed', 'settings', null, `Резервная копия не создана: ${причина}`);
  }
  console.error('Резервная копия не создана:', причина);
}

function отметитьУспехКопии() {
  setSetting('last_backup', nowIso());
  if (getSetting('backup_error')) {
    audit(null, 'backup', 'settings', null, 'Резервные копии снова делаются');
    setSetting('backup_error', '');
    setSetting('backup_error_at', '');
  }
}

function maybeBackup() {
  const last = Date.parse(getSetting('last_backup') || '') || 0;
  if (Date.now() - last < BACKUP_EVERY_MS) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    /*
     * Проверяем место ДО снимка. Иначе VACUUM INTO начнёт писать, упрётся
     * в конец диска и оставит обрезанный файл, который выглядит как копия,
     * но копией не является, — а это хуже, чем честное отсутствие копии.
     */
    const свободно = свободноМб();
    const нужно = Math.ceil(размерБазыМб() * 1.3) + 50;
    if (свободно !== null && свободно < нужно) {
      отметитьСбойКопии(`на диске свободно ${свободно} МБ, а нужно около ${нужно} МБ`);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const target = path.join(BACKUP_DIR, `asher-${stamp}.db`);
    if (!fs.existsSync(target)) {
      // VACUUM INTO даёт целостный снимок даже во время работы.
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    }
    отметитьУспехКопии();

    const old = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^asher-.*\.db$/.test(f))
      .sort()
      .slice(0, -BACKUPS_KEEP);
    for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  } catch (e) {
    отметитьСбойКопии(e.message);
  }
}

function размерБазыМб() {
  try {
    const p = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main');
    if (!p || !p.file) return 0;
    return fs.statSync(p.file).size / (1024 * 1024);
  } catch { return 0; }
}

/*
 * Копия «здесь и сейчас» — для кнопки «Скачать резервную копию».
 *
 * Копии, которые система делает сама, лежат рядом с базой: сгорел компьютер —
 * сгорели и они. Настоящая защита — копия в другом месте, поэтому владелец
 * должен уметь забрать свежий снимок одним нажатием и положить его туда,
 * где его точно не потеряют.
 */
function makeBackupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  let target = path.join(BACKUP_DIR, `asher-${stamp}.db`);
  // Две копии в одну секунду — VACUUM INTO на существующий файл падает.
  let n = 1;
  while (fs.existsSync(target)) target = path.join(BACKUP_DIR, `asher-${stamp}-${n++}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  /*
   * Чистим старые тут же. Иначе частые нажатия «Скачать копию» тихо забьют
   * диск: каждая копия — это вся база целиком.
   */
  const old = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^asher-.*\.db$/.test(f))
    .sort()
    .slice(0, -BACKUPS_KEEP);
  for (const f of old) {
    if (path.join(BACKUP_DIR, f) !== target) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
  return target;
}

function status() {
  const backups = (() => {
    try {
      return fs.readdirSync(BACKUP_DIR).filter(f => /^asher-.*\.db$/.test(f)).sort().reverse();
    } catch { return []; }
  })();
  return {
    sync_dir: SYNC_DIR,
    backup_dir: BACKUP_DIR,
    last_backup: getSetting('last_backup') || '',
    backups_count: backups.length,
    latest_backup: backups[0] || '',
    log: db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 20').all(),
  };
}

/*
 * Подсобные папки создаём «мягко»: не смогли — работаем дальше.
 *
 * Раньше это была обычная строка без всякой защиты, и от неё зависел запуск
 * всей системы. Стоило диску отвалиться или папке стать недоступной — сервер
 * падал на старте, и магазин не мог не то что снять копию, а вообще торговать.
 * Это ровно наоборот тому, что нужно: обмен с 1С и резервные копии важны,
 * но касса важнее. Пусть отвалится вспомогательное, а торговля продолжится —
 * о беде владелец узнает из тревоги на Главной.
 */
function завестиПапку(куда, зачем) {
  try {
    fs.mkdirSync(куда, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Не удалось создать папку (${зачем}): ${куда} — ${e.message}`);
    if (зачем === 'резервные копии') отметитьСбойКопии(`папка для копий недоступна: ${e.message}`);
    return false;
  }
}

function start() {
  const естьОбмен = завестиПапку(SYNC_DIR, 'обмен с 1С');
  завестиПапку(BACKUP_DIR, 'резервные копии');
  // Памятка прямо в папке — чтобы через полгода не вспоминать, зачем она.
  const readme = path.join(SYNC_DIR, 'ПРОЧТИ-МЕНЯ.txt');
  if (естьОбмен && !fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      'Папка автообмена с 1С.',
      '',
      'Положите сюда CSV-выгрузку номенклатуры из 1С — система сама:',
      '  1) обновит закупочные и розничные цены по артикулу;',
      '  2) добавит новые позиции;',
      '  3) перенесёт файл в папку «обработано» и положит рядом отчёт.',
      '',
      'Названия и категории изделий при этом не трогаются.',
      'Файлы с нераспознанными колонками попадают в папку «ошибки».',
      'Проданные и списанные изделия не изменяются никогда.',
    ].join('\r\n'), 'utf8');
  }
  /*
   * Ни одна фоновая работа не должна ронять систему. Обмен с 1С читает чужие
   * файлы, копии пишут на диск — и то, и другое ломается по причинам, к самой
   * торговле отношения не имеющим.
   */
  const безопасно = (что, имя) => () => {
    try { что(); } catch (e) { console.error(`Фоновая работа «${имя}» сорвалась:`, e.message); }
  };
  безопасно(maybeBackup, 'резервная копия')();
  setInterval(безопасно(tick, 'обмен с 1С'), POLL_MS).unref();
  setInterval(безопасно(maybeBackup, 'резервная копия'), 3600 * 1000).unref();
}

module.exports = { start, status, makeBackupNow, свободноМб, SYNC_DIR, BACKUP_DIR };
