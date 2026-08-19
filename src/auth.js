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

function login(username, password, { ip = '' } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user) {
    hashPassword(String(password || ''), DUMMY_SALT);
    return null;
  }
  const hash = hashPassword(String(password || ''), user.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
  if (!ok) return null;
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
  cleanupSessions, defaultAdminActive };
