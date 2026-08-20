'use strict';
const os = require('node:os');
const { db, nowIso, audit, getSetting, setSetting, hashPassword, makeSalt } = require('../db');
const { ApiError } = require('./util');
const { changePassword, passwordProblem, destroyUserSessions, countUserSessions } = require('../auth');
const { PRESETS, LOCALE_KEYS, presetFor } = require('../locale');

/*
 * usd_rate — курс доллара для закупки: поставщики часто считают в валюте,
 * а учёт и продажа идут в валюте магазина.
 *
 * gram_price и work_price — для тех, кто считает розницу от грамма:
 * «вес × цена грамма + работа». Это подсказка калькулятора в карточке
 * изделия, а не способ хранения цены: в изделии всегда лежит готовая
 * розничная цена, поэтому смена цены грамма не переписывает задним числом
 * ни ценники, ни прошлые чеки.
 *
 * max_discount_percent — потолок скидки для продавца. Отдаётся и продавцу
 * тоже: касса должна показать предел ещё до того, как он упрётся в отказ.
 */
const SETTING_KEYS = ['store_name', 'store_address', 'store_phone', 'usd_rate',
  'gram_price', 'work_price', 'max_discount_percent', ...LOCALE_KEYS];

/*
 * Состояние резервных копий — то, что владелец должен узнать САМ, не заходя
 * специально проверять.
 *
 * Копии — единственное, что стоит между магазином и потерей всего. При этом
 * ломаются они тихо: закончилось место, сменились права на папку, отвалился
 * диск. Раньше о сбое знала только строка в чёрном окне, куда никто не смотрит.
 * Теперь состояние считается здесь и показывается и на «Безопасности»,
 * и на Главной.
 */
function состояниеКопий() {
  const когда = getSetting('last_backup') || '';
  const ошибка = getSetting('backup_error') || '';
  const мс = Date.parse(когда) || 0;
  const часовНазад = мс ? Math.floor((Date.now() - мс) / 3600000) : null;
  /*
   * Копия делается раз в сутки. Тревожимся после 30 часов, а не после 24:
   * запас нужен на то, что система ночью не работала, а проверка идёт раз в час.
   * Иначе владелец каждое утро видел бы ложную тревогу и перестал бы её замечать.
   */
  const устарела = мс === 0 || часовНазад >= 30;

  let свободноМб = null;
  try { свободноМб = require('../sync').свободноМб(); } catch { /* не смогли — не беда */ }
  const малоМеста = свободноМб !== null && свободноМб < 500;

  return {
    last_backup: когда,
    backup_hours_ago: часовНазад,
    backup_stale: устарела,
    backup_error: ошибка,
    backup_error_at: getSetting('backup_error_at') || '',
    disk_free_mb: свободноМб,
    disk_low: малоМеста,
  };
}

const routes = [
  // --- Общие настройки ---
  {
    method: 'GET', path: '/api/settings',
    handler: ({ session }) => {
      const out = {};
      for (const k of SETTING_KEYS) out[k] = getSetting(k);
      /*
       * Курс закупки — часть закупочной кухни: зная его и цену в долларах,
       * закупочную считают в уме. Продавцу настройки нужны только ради валюты
       * и формата сумм, поэтому курс отсюда убираем.
       */
      if (session.role !== 'admin') delete out.usd_rate;
      return out;
    },
  },
  {
    method: 'PUT', path: '/api/settings', admin: true,
    handler: ({ body, session }) => {
      // Смена страны подставляет весь набор сразу: валюту, формат сумм, телефонный код.
      // Поля, переданные явно вместе со страной, имеют приоритет — можно взять
      // набор Кыргызстана, но оставить свою подпись валюты.
      if (body.country !== undefined && body.country !== getSetting('country')) {
        const preset = presetFor(body.country);
        for (const k of LOCALE_KEYS) {
          if (k === 'country') continue;
          if (body[k] === undefined) setSetting(k, String(preset[k]));
        }
      }
      /*
       * Потолок скидки проверяем отдельно: пустое поле или «много» превратились
       * бы в ноль, а ноль здесь означает «скидки запрещены совсем». Продавцы
       * узнали бы об этом утром у прилавка, а не в момент правки настроек.
       */
      if (body.max_discount_percent !== undefined) {
        const сырое = String(body.max_discount_percent).trim();
        const п = Number(сырое);
        // Пустое поле особо: Number('') — это ноль, а ноль здесь значит
        // «скидки запрещены совсем». Стёртое поле и запрет скидок — разные
        // намерения, и угадывать за владельца мы не будем.
        if (сырое === '' || !Number.isFinite(п) || п < 0 || п > 100) {
          throw new ApiError(400,
            'Предел скидки — число от 0 до 100. Если продавцам скидки не разрешены, поставьте 0.');
        }
        body.max_discount_percent = Math.round(п * 10) / 10;
      }
      // Курс влияет на себестоимость всего, что закупят дальше, — его смена
      // должна оставлять в журнале конкретные цифры, а не общую фразу.
      const rateBefore = getSetting('usd_rate');
      const пределБыл = getSetting('max_discount_percent');
      for (const k of SETTING_KEYS) {
        if (body[k] !== undefined) setSetting(k, String(body[k]));
      }
      const rateAfter = getSetting('usd_rate');
      const пределСтал = getSetting('max_discount_percent');
      // Поднятый потолок скидок — то, о чём владелец должен вспомнить сам
      // через полгода, глядя в журнал: цифры, а не «изменены настройки».
      const что = rateAfter !== rateBefore
        ? `Курс доллара: ${rateBefore || '—'} → ${rateAfter}`
        : (пределСтал !== пределБыл
          ? `Предел скидки продавца: ${пределБыл || '—'}% → ${пределСтал}%`
          : 'Изменены настройки магазина');
      audit(session.userId, 'update', 'settings', null, что);
      return { ok: true };
    },
  },
  {
    // Список стран для выпадающего списка в настройках.
    method: 'GET', path: '/api/settings/countries',
    handler: () => ({
      items: Object.entries(PRESETS).map(([code, p]) => ({ code, ...p })),
    }),
  },
  {
    // Адреса, по которым система открывается с телефона в той же сети Wi-Fi.
    // Владелец работает за компьютером, а смотрит каталог с телефона — без этой
    // подсказки пришлось бы искать IP-адрес в настройках операционной системы.
    method: 'GET', path: '/api/settings/network', admin: true,
    handler: ({ req }) => {
      const port = Number(process.env.ASHER_ACTUAL_PORT || process.env.ASHER_PORT || process.env.PORT || 3000);
      const addresses = [];
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          addresses.push(`http://${iface.address}:${port}`);
        }
      }
      /*
       * Адрес по имени компьютера. Числовой адрес роутер однажды выдаст другой,
       * и сохранённые на телефонах ссылки разом перестанут открываться —
       * а имя компьютера остаётся тем же. Работает не в каждой сети, поэтому
       * это дополнение к списку, а не замена ему.
       */
      const host = String(os.hostname() || '').split('.')[0];
      const hostnameUrl = host && /^[a-z0-9-]+$/i.test(host) ? `http://${host}:${port}` : '';
      return { addresses, port, hostname: os.hostname(), hostname_url: hostnameUrl };
    },
  },
  {
    /*
     * Состояние безопасности — для страницы «Безопасность».
     *
     * Отдельно от публичного /api/login-hint: тот из интернета молчит, чтобы
     * не объявлять всему свету «сюда можно как admin/admin123». Владельцу же
     * знать об этом надо в любом случае, поэтому здесь — после входа и только
     * администратору.
     */
    method: 'GET', path: '/api/security/status', admin: true,
    handler: ({ req }) => {
      const { defaultAdminActive, MIN_PASSWORD } = require('../auth');
      const proxied = process.env.ASHER_TRUST_PROXY === '1';
      return {
        default_admin: defaultAdminActive(),
        secure: proxied
          ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
          : Boolean(req.socket.encrypted),
        behind_proxy: proxied,
        min_password: MIN_PASSWORD,
        devices: db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at >= ?').get(nowIso()).c,
        last_backup: getSetting('last_backup') || '',
        pending_devices: db.prepare('SELECT COUNT(*) AS c FROM devices WHERE approved = 0').get().c,
        ...состояниеКопий(),
      };
    },
  },
  {
    /*
     * Устройства: кто откуда заходит и кто просится войти.
     *
     * Это вторая половина защиты входа. Пароль отвечает, знает ли человек
     * пароль; список устройств отвечает, он ли это. Утёкший пароль сам по себе
     * больше не пускает в систему — незнакомый телефон попадает сюда и ждёт,
     * пока владелец его разрешит.
     */
    method: 'GET', path: '/api/devices', admin: true,
    handler: () => {
      const auth = require('../auth');
      return { pending: auth.pendingDevices(), approved: auth.approvedDevices() };
    },
  },
  {
    method: 'POST', path: '/api/devices/:id/approve', admin: true,
    handler: ({ params, session }) => {
      const d = require('../auth').approveDevice(params.id, session.userId);
      if (!d) throw new ApiError(404, 'Устройство не найдено');
      return { ok: true };
    },
  },
  {
    /*
     * Отклонить — и заодно оборвать все сеансы этого сотрудника, если
     * устройство было разрешено раньше. Отклоняют в одном случае: телефон
     * чужой. Значит пароль знает посторонний, и всё открытое по этому паролю
     * надо закрыть сразу, не дожидаясь, пока владелец дойдёт до смены пароля.
     */
    method: 'POST', path: '/api/devices/:id/deny', admin: true,
    handler: ({ params, session }) => {
      const r = require('../auth').denyDevice(params.id, session.userId);
      if (!r) throw new ApiError(404, 'Устройство не найдено');
      return { ok: true, dropped: r.dropped };
    },
  },
  {
    // Состояние автообмена с 1С и резервных копий — показывается на странице импорта.
    method: 'GET', path: '/api/sync/status', admin: true,
    handler: () => require('../sync').status(),
  },
  {
    /*
     * Скачать резервную копию.
     *
     * Копии, которые система делает сама, лежат рядом с базой — от пожара,
     * кражи ноутбука и пропавшего сервера они не спасают. Эта кнопка собирает
     * свежую копию и отдаёт одним файлом: владелец кладёт его туда, где точно
     * не потеряет.
     *
     * В архив кладём И базу, И фотографии. Раньше отдавалась одна база, а
     * рядом было написано «вся система целиком» — и это была неправда:
     * фотографии изделий и сканы сертификатов лежат отдельными файлами.
     * Владелец, потерявший компьютер, восстановил бы каталог без единого фото
     * и узнал бы об этом в худший момент.
     */
    method: 'GET', path: '/api/backup/download', admin: true, raw: true,
    handler: async ({ res, session }) => {
      const { streamZip, listFiles } = require('../zip');
      const { MEDIA_DIR } = require('../db');

      const snapshot = require('../sync').makeBackupNow();
      const entries = [{ name: 'data/asher.db', file: snapshot }];
      // Фотографии кладём рядом с базой, сохраняя структуру папок: так архив
      // распаковывается прямо поверх папки системы.
      for (const f of listFiles(MEDIA_DIR)) {
        entries.push({ name: 'data/images/' + f.name, file: f.file });
      }
      // Короткая записка внутрь архива: через полгода никто не вспомнит,
      // что это за файл и что с ним делать.
      entries.push({
        name: 'КАК-ВОССТАНОВИТЬ.txt',
        data: Buffer.from(
          'Резервная копия Asher\r\n' +
          'Снята: ' + new Date().toLocaleString('ru-RU') + '\r\n\r\n' +
          'Внутри:\r\n' +
          '  data/asher.db     — вся база: изделия, продажи, клиенты, долги, журнал\r\n' +
          '  data/images/      — фотографии изделий и сканы сертификатов\r\n\r\n' +
          'Как восстановить:\r\n' +
          '  1. Закройте систему (чёрное окно).\r\n' +
          '  2. Удалите папку data целиком — вместе с файлами asher.db-wal\r\n' +
          '     и asher.db-shm, если они есть. Если оставить их рядом со старой\r\n' +
          '     базой, система возьмёт данные из них, а не из копии.\r\n' +
          '  3. Распакуйте этот архив в папку с системой — папка data появится заново.\r\n' +
          '  4. Запустите СТАРТ.\r\n', 'utf8'),
      });

      const name = 'asher-' + new Date().toISOString().slice(0, 10) + '.zip';
      audit(session.userId, 'backup', 'settings', null,
        `Скачана резервная копия (${name}, файлов: ${entries.length})`);
      /*
       * Отдаём потоком, а не собираем в памяти. Замер на 330 МБ фотографий:
       * прежняя сборка занимала в пике 733 МБ, вдвое больше самого архива,
       * и на сервере с гигабайтом памяти копия однажды просто перестала бы
       * скачиваться. Заодно магазин больше не замирает: раньше продавец ждал
       * ответа пять секунд на обычном экране, пока владелец качал копию.
       */
      await streamZip(entries, res, { filename: name });
    },
  },

  // --- Категории ---
  {
    method: 'GET', path: '/api/categories',
    handler: () => ({ items: db.prepare('SELECT * FROM categories ORDER BY sort, name').all() }),
  },
  {
    method: 'POST', path: '/api/categories', admin: true,
    handler: ({ body, session }) => {
      const name = String(body.name || '').trim();
      if (!name) throw new ApiError(400, 'Название категории обязательно');
      const dup = db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name);
      if (dup) throw new ApiError(400, 'Такая категория уже есть');
      const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM categories').get().m;
      const info = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(name, Number(max) + 1);
      audit(session.userId, 'create', 'category', Number(info.lastInsertRowid), name);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'DELETE', path: '/api/categories/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      if (!cat) throw new ApiError(404, 'Категория не найдена');
      const used = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ?').get(id).c;
      if (Number(used) > 0) throw new ApiError(400, `В категории ${used} изделий — сначала перенесите их.`);
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'category', id, cat.name);
      return { ok: true };
    },
  },

  // --- Поставщики ---
  {
    method: 'GET', path: '/api/suppliers',
    handler: () => ({
      items: db.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS products_count
         FROM suppliers s ORDER BY s.name`
      ).all(),
    }),
  },
  {
    method: 'POST', path: '/api/suppliers', admin: true,
    handler: ({ body, session }) => {
      const name = String(body.name || '').trim();
      if (!name) throw new ApiError(400, 'Название поставщика обязательно');
      const info = db.prepare('INSERT INTO suppliers (name, contact, phone, notes) VALUES (?,?,?,?)')
        .run(name, String(body.contact || ''), String(body.phone || ''), String(body.notes || ''));
      audit(session.userId, 'create', 'supplier', Number(info.lastInsertRowid), name);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/suppliers/:id', admin: true,
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
      if (!s) throw new ApiError(404, 'Поставщик не найден');
      const name = body.name !== undefined ? String(body.name).trim() : s.name;
      if (!name) throw new ApiError(400, 'Название поставщика обязательно');
      db.prepare('UPDATE suppliers SET name = ?, contact = ?, phone = ?, notes = ? WHERE id = ?')
        .run(name,
          body.contact !== undefined ? String(body.contact) : s.contact,
          body.phone !== undefined ? String(body.phone) : s.phone,
          body.notes !== undefined ? String(body.notes) : s.notes, id);
      audit(session.userId, 'update', 'supplier', id, name);
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/api/suppliers/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
      if (!s) throw new ApiError(404, 'Поставщик не найден');
      /*
       * Вместе с поставщиком каскадом стирается вся книга расчётов с ним.
       * Если там ненулевой баланс, долг исчез бы молча — а он настоящий.
       */
      const bal = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN -amount ELSE amount END), 0) AS b
           FROM supplier_ops WHERE supplier_id = ?`
      ).get(id).b;
      if (Math.abs(bal) > 0.009) {
        throw new ApiError(400,
          `С поставщиком «${s.name}» ещё не закрыты расчёты (${Math.round(bal)}). ` +
          'Сначала погасите или скорректируйте баланс в разделе «Долги».');
      }
      db.prepare('UPDATE products SET supplier_id = NULL WHERE supplier_id = ?').run(id);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'supplier', id, s.name);
      return { ok: true };
    },
  },

  // --- Сотрудники ---
  {
    method: 'GET', path: '/api/users', admin: true,
    handler: () => ({
      items: db.prepare(
        `SELECT u.id, u.username, u.name, u.role, u.active, u.created_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at >= ?) AS devices
         FROM users u ORDER BY u.id`
      ).all(nowIso()),
    }),
  },
  {
    method: 'POST', path: '/api/users', admin: true,
    handler: ({ body, session }) => {
      const username = String(body.username || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      const role = body.role === 'admin' ? 'admin' : 'seller';
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        throw new ApiError(400, 'Логин: 3–30 символов, латиница, цифры, точки и дефисы');
      }
      if (!name) throw new ApiError(400, 'Имя обязательно');
      const weak = passwordProblem(password);
      if (weak) throw new ApiError(400, weak);
      const dup = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
      if (dup) throw new ApiError(400, 'Такой логин уже занят');
      const salt = makeSalt();
      const info = db.prepare(
        'INSERT INTO users (username, name, role, password_hash, salt, active, created_at) VALUES (?,?,?,?,?,1,?)'
      ).run(username, name, role, hashPassword(password, salt), salt, nowIso());
      audit(session.userId, 'create', 'user', Number(info.lastInsertRowid), `${username} (${role})`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/users/:id', admin: true,
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new ApiError(404, 'Сотрудник не найден');
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new ApiError(400, 'Имя обязательно');
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
      }
      if (body.role !== undefined) {
        const role = body.role === 'admin' ? 'admin' : 'seller';
        if (u.role === 'admin' && role !== 'admin') {
          const admins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1`).get().c;
          if (Number(admins) <= 1) throw new ApiError(400, 'Нельзя разжаловать последнего администратора');
        }
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      }
      if (body.active !== undefined) {
        const active = body.active ? 1 : 0;
        if (!active && u.role === 'admin') {
          const admins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1`).get().c;
          if (Number(admins) <= 1) throw new ApiError(400, 'Нельзя отключить последнего администратора');
        }
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, id);
        if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (body.password) {
        const weak = passwordProblem(body.password);
        if (weak) throw new ApiError(400, weak);
        // Свой пароль меняем, не выкидывая себя же из системы.
        const keep = id === session.userId ? session.token : '';
        const dropped = changePassword(id, String(body.password), { keepToken: keep });
        audit(session.userId, 'password', 'user', id,
          `Пароль сотрудника «${u.username}» сменён` +
          (dropped ? `, завершено сеансов: ${dropped}` : ''));
      }
      audit(session.userId, 'update', 'user', id, u.username);
      return { ok: true };
    },
  },
  {
    // смена собственного пароля — доступна всем
    method: 'POST', path: '/api/me/password',
    handler: ({ body, session }) => {
      const pwd = String(body.password || '');
      const weak = passwordProblem(pwd);
      if (weak) throw new ApiError(400, weak);
      // Текущее устройство остаётся в системе, остальные — выходят.
      const dropped = changePassword(session.userId, pwd, { keepToken: session.token });
      audit(session.userId, 'password', 'user', session.userId,
        'Смена пароля' + (dropped ? `, завершено других сеансов: ${dropped}` : ''));
      return { ok: true, sessions_closed: dropped };
    },
  },
  {
    /*
     * Завершить все входы сотрудника. Телефон потеряли или сотрудник ушёл —
     * этой кнопкой его выкидывает со всех устройств немедленно, а не через
     * месяц, когда сам истечёт сохранённый сеанс.
     */
    method: 'POST', path: '/api/users/:id/logout-all', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new ApiError(404, 'Сотрудник не найден');
      const keep = id === session.userId ? session.token : '';
      const closed = destroyUserSessions(id, { keepToken: keep });
      audit(session.userId, 'logout_all', 'user', id,
        `${u.name}: завершено сеансов ${closed}`);
      return { closed };
    },
  },

  /*
   * Журнал действий. Владелец должен видеть, кто что сделал, — поэтому
   * отдаём не «последние 500», а любой отрезок с отбором по сотруднику,
   * виду действия и датам, страницами. Без этого журнал за неделю работы
   * магазина уже не показывает вчерашний день.
   */
  {
    method: 'GET', path: '/api/audit', admin: true,
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.entity) { cond.push('a.entity = ?'); args.push(query.entity); }
      if (query.action) { cond.push('a.action = ?'); args.push(query.action); }
      if (query.user_id) { cond.push('a.user_id = ?'); args.push(Number(query.user_id)); }
      if (query.from) { cond.push('a.created_at >= ?'); args.push(query.from); }
      // Дату «по» задают днём — берём его целиком, до последней секунды.
      if (query.to) { cond.push('a.created_at <= ?'); args.push(query.to.length === 10 ? query.to + 'T23:59:59.999Z' : query.to); }
      if (query.search) {
        cond.push('(a.details LIKE ? OR u.name LIKE ?)');
        const like = '%' + String(query.search).trim() + '%';
        args.push(like, like);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const offset = Math.max(Number(query.offset) || 0, 0);
      const total = db.prepare(
        `SELECT COUNT(*) AS c FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where}`
      ).get(...args).c;
      const rows = db.prepare(
        `SELECT a.*, u.name AS user_name, u.role AS user_role
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`
      ).all(...args, limit, offset);
      // Кто сколько сделал за выбранный отрезок — сводка над списком.
      const byUser = db.prepare(
        `SELECT COALESCE(u.name, 'Система') AS name, COUNT(*) AS count,
                MAX(a.created_at) AS last_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${where} GROUP BY a.user_id ORDER BY count DESC`
      ).all(...args);
      return { items: rows, total, limit, offset, by_user: byUser };
    },
  },
];

module.exports = { routes, состояниеКопий };
