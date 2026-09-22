'use strict';
/*
 * Ночной сброс демо-версии: утром данные как новые, а вход не слетает.
 *
 * Демо-версией пользуются все, кто знакомится с системой, — в том числе
 * проверяющий Apple. За день в ней успевают наделать продаж, удалить изделия,
 * загрузить фотографии, переименовать магазин. К утру всё должно быть как
 * новое, а даты — свежими: «продали сегодня» должно быть про сегодня.
 *
 * Но выбросить проверяющего посреди работы на экран входа — верный способ
 * получить отказ «приложение само выходит из учётной записи». Поэтому сеансы
 * входа и адреса телефонов для уведомлений сброс переживают: они переносятся
 * в новую базу по логину.
 *
 * Запускать при остановленной демо-службе — ночной таймер так и делает:
 *   ASHER_DEMO=1 ASHER_DB=/home/asher/demo/asher.db node src/демо-сброс.js
 *
 * Рабочую базу этот файл не тронет никогда: без ASHER_DEMO=1 и без явно
 * указанной отдельной базы он отказывается работать.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB = process.env.ASHER_DB ? path.resolve(process.env.ASHER_DB) : '';

function отказ(почему) {
  console.error('Сброс демо-версии отменён: ' + почему);
  process.exit(2);
}
if (process.env.ASHER_DEMO !== '1') отказ('это не демо-версия (нужен ASHER_DEMO=1).');
if (!DB) отказ('не указана база демо-версии (ASHER_DB).');
if (DB === path.resolve(ROOT, 'data', 'asher.db')) отказ('указана база рабочей системы.');

// 1. Что перенести в новую базу: кто сейчас вошёл и куда слать уведомления.
let сеансы = [];
let телефоны = [];
if (fs.existsSync(DB)) {
  const старая = new DatabaseSync(DB, { readOnly: true });
  const прочесть = sql => { try { return старая.prepare(sql).all(); } catch { return []; } };
  сеансы = прочесть(`SELECT s.token, s.created_at, s.expires_at, u.username
                      FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.active = 1`);
  телефоны = прочесть(`SELECT p.token, p.env, p.created_at, p.last_seen, u.username
                        FROM push_tokens p JOIN users u ON u.id = p.user_id WHERE u.active = 1`);
  старая.close();
}

// 2. Свежие выдуманные данные — тем же наполнением, что и всегда.
const фото = process.env.ASHER_MEDIA || path.join(path.dirname(DB), 'images');
fs.rmSync(фото, { recursive: true, force: true });
const посев = spawnSync(process.execPath, [path.join(__dirname, 'seed.js'), '--reset'],
  { cwd: ROOT, env: process.env, encoding: 'utf8' });
if (посев.status !== 0) {
  console.error(посев.stderr || посев.stdout);
  отказ('наполнение не удалось.');
}

// 3. Название магазина и перенос входов.
const { db, setSetting } = require('./db');
setSetting('store_name', 'Diamonds');
const кто = db.prepare('SELECT id FROM users WHERE username = ? AND active = 1');
let входов = 0;
for (const с of сеансы) {
  const u = кто.get(с.username);
  if (!u) continue;
  входов += Number(db.prepare('INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(с.token, u.id, с.created_at, с.expires_at).changes);
}
let адресов = 0;
for (const т of телефоны) {
  const u = кто.get(т.username);
  if (!u) continue;
  адресов += Number(db.prepare('INSERT OR IGNORE INTO push_tokens (token, user_id, env, created_at, last_seen) VALUES (?,?,?,?,?)')
    .run(т.token, u.id, т.env, т.created_at, т.last_seen).changes);
}
console.log(`Демо-версия обновлена: данные свежие, сохранено входов — ${входов}, телефонов для уведомлений — ${адресов}.`);
