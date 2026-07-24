'use strict';
const os = require('node:os');
const { db, nowIso, audit, getSetting, setSetting, hashPassword, makeSalt } = require('../db');
const { ApiError } = require('./util');
const { changePassword } = require('../auth');
const { PRESETS, LOCALE_KEYS, presetFor } = require('../locale');

const SETTING_KEYS = ['store_name', 'store_address', 'store_phone', 'bonus_percent', 'vip_threshold',
  ...LOCALE_KEYS];

const routes = [
  // --- Общие настройки ---
  {
    method: 'GET', path: '/api/settings',
    handler: () => {
      const out = {};
      for (const k of SETTING_KEYS) out[k] = getSetting(k);
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
      for (const k of SETTING_KEYS) {
        if (body[k] !== undefined) setSetting(k, String(body[k]));
      }
      audit(session.userId, 'update', 'settings', null, 'Изменены настройки магазина');
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
      const port = Number(process.env.ASHER_PORT || process.env.PORT || 3000);
      const addresses = [];
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          addresses.push(`http://${iface.address}:${port}`);
        }
      }
      return { addresses, port, hostname: os.hostname() };
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
      items: db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all(),
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
      if (password.length < 6) throw new ApiError(400, 'Пароль минимум 6 символов');
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
        if (String(body.password).length < 6) throw new ApiError(400, 'Пароль минимум 6 символов');
        changePassword(id, String(body.password));
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
      if (pwd.length < 6) throw new ApiError(400, 'Пароль минимум 6 символов');
      changePassword(session.userId, pwd);
      audit(session.userId, 'password', 'user', session.userId, 'Смена пароля');
      return { ok: true };
    },
  },

  // --- Журнал операций ---
  {
    method: 'GET', path: '/api/audit', admin: true,
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.entity) { cond.push('a.entity = ?'); args.push(query.entity); }
      if (query.user_id) { cond.push('a.user_id = ?'); args.push(Number(query.user_id)); }
      if (query.from) { cond.push('a.created_at >= ?'); args.push(query.from); }
      if (query.to) { cond.push('a.created_at <= ?'); args.push(query.to); }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${where} ORDER BY a.created_at DESC LIMIT 500`
      ).all(...args);
      return { items: rows };
    },
  },
];

module.exports = { routes };
