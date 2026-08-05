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

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user) return null;
  const hash = hashPassword(String(password || ''), user.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
  if (!ok) return null;
  const session = createSession(user.id);
  audit(user.id, 'login', 'user', user.id, user.username);
  return { session, user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}

function changePassword(userId, newPassword) {
  const salt = makeSalt();
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(
    hashPassword(newPassword, salt), salt, userId
  );
  // разлогинить остальные сессии этого пользователя не требуется — локальная система
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

module.exports = { createSession, getSession, destroySession, login, changePassword,
  cleanupSessions, defaultAdminActive };
