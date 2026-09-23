'use strict';
const crypto = require('node:crypto');
const { db, nowIso, hashPassword, makeSalt, audit } = require('./db');

const SESSION_DAYS = 30;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    token, userId, nowIso(), expires
  );
  return { token, expires };
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.username, u.name, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (!row.active || row.expires_at < nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { token: row.token, userId: row.user_id, username: row.username, name: row.name, role: row.role };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/*
 * Завершить все сеансы сотрудника. Нужно в трёх случаях: телефон потеряли,
 * сотрудник уволился, пароль сменили. Без этого вход на потерянном телефоне
 * жил бы ещё месяц — ровно столько держится сохранённый сеанс.
 */
function destroyUserSessions(userId, { keepToken = '' } = {}) {
  const info = keepToken
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken)
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(info.changes || 0);
}

function countUserSessions(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at >= ?')
    .get(userId, nowIso()).c;
}

/*
 * Соль-пустышка для несуществующих логинов.
 *
 * Если на «такого логина нет» отвечать сразу, а на «пароль не тот» — после
 * подсчёта свёртки, разница во времени ответа выдаёт, какие логины в системе
 * есть. Дальше подбирают уже прицельно. Поэтому считаем свёртку всегда,
 * даже когда считать не с чем.
 */
const DUMMY_SALT = makeSalt();

/*
 * ---------- Разрешённые устройства ----------
 *
 * Пароль отвечает на вопрос «знает ли он пароль». Устройство отвечает на
 * второй, не менее важный: «он ли это». Одного первого мало: пароль может
 * утечь, и тогда единственное, что стоит между вором и кассой магазина, —
 * то, что войти он пытается с незнакомого телефона.
 */

// Короткий номер для сверки голосом: «владелец, разрешите телефон 4821».
// Без похожих знаков — его будут диктовать и переписывать с экрана.
function makeDeviceCode() {
  const знаки = '23456789ACDEFHJKLMNPQRTUVWXYZ';
  let out = '';
  for (const b of crypto.randomBytes(4)) out += знаки[b % знаки.length];
  return out;
}

function countApprovedDevices(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM devices WHERE user_id = ? AND approved = 1').get(userId).c;
}

/*
 * Что делать с устройством, с которого пришёл вход.
 * Возвращает 'ok' — пускать, либо запись ожидающего устройства.
 *
 * Первое устройство сотрудника доверяется само, и это не послабление,
 * а необходимость: иначе владелец не смог бы войти в только что поставленную
 * систему, а каждый новый продавец не смог бы войти ни разу — разрешать его
 * телефон было бы некому и неоткуда. Момент первого входа при этом
 * контролируемый: владелец сам заводит сотрудника и сам выдаёт ему карточку
 * подключения, стоя рядом. Все последующие устройства — только с разрешения.
 */
function checkDevice(user, ключ, { ip = '', name = '' } = {}) {
  const key = String(ключ || '').slice(0, 100);
  if (!key) {
    /*
     * Устройство не назвалось. Раньше это означало бы «пускать» — и тогда
     * защита обходилась бы одним удалённым заголовком, то есть не защищала бы
     * вовсе. Считаем такой вход попыткой с неизвестного устройства.
     */
    return { state: 'нет-ключа' };
  }

  const есть = db.prepare('SELECT * FROM devices WHERE user_id = ? AND device_key = ?').get(user.id, key);
  if (есть && есть.approved) {
    db.prepare('UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?').run(nowIso(), ip, есть.id);
    return { state: 'ok', device: есть };
  }

  // Первое устройство — доверяем сразу (см. пояснение выше).
  if (!есть && countApprovedDevices(user.id) === 0) {
    const info = db.prepare(
      `INSERT INTO devices (user_id, device_key, code, name, approved, created_at, approved_at, last_seen, last_ip)
       VALUES (?,?,?,?,1,?,?,?,?)`
    ).run(user.id, key, makeDeviceCode(), String(name || '').slice(0, 80), nowIso(), nowIso(), nowIso(), ip);
    audit(user.id, 'device_first', 'user', user.id,
      `Первое устройство «${user.username}» доверено при первом входе${ip ? ` (${ip})` : ''}`);
    return { state: 'ok', device: { id: Number(info.lastInsertRowid) } };
  }

  if (есть) {
    // Уже ждёт — обновляем отметки, но нового ожидания не заводим.
    db.prepare('UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?').run(nowIso(), ip, есть.id);
    return { state: 'ждёт', device: есть };
  }

  const code = makeDeviceCode();
  const info = db.prepare(
    `INSERT INTO devices (user_id, device_key, code, name, approved, created_at, last_seen, last_ip)
     VALUES (?,?,?,?,0,?,?,?)`
  ).run(user.id, key, code, String(name || '').slice(0, 80), nowIso(), nowIso(), ip);
  /*
   * Это самая важная строка журнала во всей системе. Если пароль утёк,
   * именно здесь владелец увидит попытку: «вход с незнакомого устройства».
   */
  audit(user.id, 'device_new', 'user', user.id,
    `Вход с незнакомого устройства (код ${code})${ip ? `, адрес ${ip}` : ''} — ждёт разрешения`);
  return { state: 'ждёт', device: db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid) };
}

function pendingDevices() {
  return db.prepare(
    `SELECT d.id, d.code, d.name, d.created_at, d.last_ip, d.last_seen,
            u.id AS user_id, u.username, u.name AS user_name, u.role
     FROM devices d JOIN users u ON u.id = d.user_id
     WHERE d.approved = 0 AND u.active = 1
     ORDER BY d.created_at DESC`
  ).all();
}

function approvedDevices() {
  return db.prepare(
    `SELECT d.id, d.code, d.name, d.created_at, d.approved_at, d.last_ip, d.last_seen,
            u.id AS user_id, u.username, u.name AS user_name
     FROM devices d JOIN users u ON u.id = d.user_id
     WHERE d.approved = 1 AND u.active = 1
     ORDER BY d.last_seen DESC`
  ).all();
}

function approveDevice(deviceId, byUserId) {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(deviceId));
  if (!d) return null;
  db.prepare('UPDATE devices SET approved = 1, approved_at = ?, approved_by = ? WHERE id = ?')
    .run(nowIso(), byUserId, d.id);
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(d.user_id);
  audit(byUserId, 'device_approve', 'user', d.user_id,
    `Разрешено устройство ${d.code} для «${u ? u.username : d.user_id}»`);
  return d;
}

function denyDevice(deviceId, byUserId) {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(deviceId));
  if (!d) return null;
  db.prepare('DELETE FROM devices WHERE id = ?').run(d.id);
  /*
   * Отклонили — обрываем и сеансы этого сотрудника. Если устройство чужое,
   * значит пароль знает посторонний, и всё, что открыто по этому паролю,
   * надо закрыть немедленно, не дожидаясь смены пароля.
   */
  const оборвано = d.approved ? destroyUserSessions(d.user_id) : 0;
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(d.user_id);
  audit(byUserId, 'device_deny', 'user', d.user_id,
    `Отклонено устройство ${d.code} для «${u ? u.username : d.user_id}»` +
    (оборвано ? `, завершено входов: ${оборвано}` : ''));
  return { device: d, dropped: оборвано };
}

// Состояние ожидающего устройства — для экрана «ждём разрешения».
function deviceStateByKey(username, ключ) {
  const u = db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!u) return { state: 'нет' };
  const d = db.prepare('SELECT approved, code FROM devices WHERE user_id = ? AND device_key = ?')
    .get(u.id, String(ключ || '').slice(0, 100));
  if (!d) return { state: 'нет' };
  return { state: d.approved ? 'разрешено' : 'ждёт', code: d.code };
}

// Забыть все устройства сотрудника: следующий вход снова станет первым.
// Нужно для восстановления доступа с сервера, когда телефон владельца утерян.
function forgetDevices(userId) {
  const info = db.prepare('DELETE FROM devices WHERE user_id = ?').run(userId);
  return Number(info.changes || 0);
}

function login(username, password, { ip = '', deviceKey = '', deviceName = '' } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user) {
    hashPassword(String(password || ''), DUMMY_SALT);
    return null;
  }
  const hash = hashPassword(String(password || ''), user.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
  if (!ok) return null;

  /*
   * Пароль верный — но этого мало. Проверяем устройство. Отказ здесь
   * умышленно не похож на «неверный пароль»: подобравший пароль должен
   * понимать, что дальше его не пустят, и не тратить время на перебор,
   * а владелец — увидеть попытку в журнале.
   */
  const устройство = checkDevice(user, deviceKey, { ip, name: deviceName });
  if (устройство.state !== 'ok') {
    return { pending: true, reason: устройство.state, code: устройство.device && устройство.device.code };
  }

  const session = createSession(user.id);
  // Откуда зашли — это то, что владелец потом ищет в журнале: «а это точно она?»
  audit(user.id, 'login', 'user', user.id, ip ? `${user.username} (${ip})` : user.username);
  return { session, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}

/*
 * Требования к паролю.
 *
 * Пока система стояла в магазине, хватало шести знаков. В интернете страницу
 * входа видит весь мир, поэтому: не короче восьми и не из списка того, что
 * пробуют первым делом. Правило одно для всех — отдельные требования к
 * администратору только запутали бы владельца.
 */
const MIN_PASSWORD = 8;
const WEAK = new Set([
  '12345678', '123456789', '1234567890', 'password', 'qwerty123', 'qwertyui',
  'admin123', 'admin1234', 'asher123', 'password1', '11111111', '00000000',
  'iloveyou', 'abc12345', 'passw0rd', 'qazwsxedc', 'zxcvbnm1',
]);

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Пароль должен быть не короче ${MIN_PASSWORD} знаков`;
  if (WEAK.has(p.toLowerCase())) return 'Такой пароль подбирают первым же делом — придумайте другой';
  if (/^(.)\1+$/.test(p)) return 'Пароль из одного повторяющегося знака подбирается мгновенно';
  return '';
}

function changePassword(userId, newPassword, { keepToken = '' } = {}) {
  const salt = makeSalt();
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(
    hashPassword(newPassword, salt), salt, userId
  );
  /*
   * Смена пароля обрывает остальные сеансы. Иначе смысл смены теряется: тот,
   * кто уже вошёл со старым паролем, остался бы внутри ещё на месяц — а пароль
   * меняют как раз тогда, когда подозревают, что он у кого-то есть.
   */
  return destroyUserSessions(userId, { keepToken });
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

/*
 * Стоит ли у администратора стандартный пароль. Нужна странице входа:
 * пока пароль не сменили, она подсказывает admin/admin123 — люди путают
 * поля и вводят пароль в логин. Как только пароль сменён, подсказка
 * исчезает, чтобы не сообщать чужим, что вводить.
 */
function defaultAdminActive() {
  const user = db.prepare(`SELECT * FROM users WHERE username = 'admin' AND active = 1`).get();
  if (!user) return false;
  const hash = hashPassword('admin123', user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
}

module.exports = { createSession, getSession, destroySession, destroyUserSessions,
  countUserSessions, login, changePassword, passwordProblem, MIN_PASSWORD,
  cleanupSessions, defaultAdminActive,
  pendingDevices, approvedDevices, approveDevice, denyDevice, deviceStateByKey,
  forgetDevices, countApprovedDevices };
