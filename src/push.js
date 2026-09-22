'use strict';
/*
 * Уведомления на телефон — через сервер уведомлений Apple (APNs).
 *
 * Кому и о чём. Уведомления получают те, кто за систему отвечает: основатель
 * и бухгалтер. Повода три, и все они о том, что владелец иначе узнал бы
 * слишком поздно:
 *
 *   • кто-то просится войти с нового телефона — если пароль утёк, узнать
 *     об этом надо сейчас, а не когда-нибудь в журнале;
 *   • резервная копия не сделалась — копии ломаются тихо;
 *   • подошёл срок аренды или зарплаты, а расхода нет — прибыль в отчёте
 *     завышена ровно на его сумму.
 *
 * Как. Apple принимает уведомления по HTTP/2 и требует подписанный ключом
 * магазина пропуск (JWT, алгоритм ES256). И то и другое есть в самом Node —
 * ни одной библиотеки. Пропуск живёт час; берём новый раз в 50 минут: Apple
 * отвергает и слишком старые пропуска, и слишком частую их смену.
 *
 * Без ключа (переменные ASHER_APNS_*) уведомления просто выключены: система
 * работает как раньше, а страница «Безопасность» честно пишет, что они не
 * подключены.
 */
const http2 = require('node:http2');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { db, nowIso, getSetting } = require('./db');

const АДРЕС = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

let настройкиКэш;           // undefined — ещё не читали; null — не настроено
let пропуск = null;         // { token, iat }
const соединения = new Map();

function настройки() {
  if (настройкиКэш !== undefined) return настройкиКэш;
  const файл = process.env.ASHER_APNS_KEY_FILE;
  const keyId = process.env.ASHER_APNS_KEY_ID;
  const teamId = process.env.ASHER_APNS_TEAM_ID;
  if (!файл || !keyId || !teamId) { настройкиКэш = null; return null; }
  try {
    настройкиКэш = {
      key: crypto.createPrivateKey(fs.readFileSync(файл)),
      keyId, teamId,
      topic: process.env.ASHER_APNS_TOPIC || 'kg.diamonds.crm',
    };
  } catch (e) {
    console.error('Ключ уведомлений не читается:', e.message);
    настройкиКэш = null;
  }
  return настройкиКэш;
}

const включено = () => настройки() !== null;

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function выписатьПропуск(н) {
  const сейчас = Math.floor(Date.now() / 1000);
  if (пропуск && сейчас - пропуск.iat < 50 * 60) return пропуск.token;
  const голова = b64url(JSON.stringify({ alg: 'ES256', kid: н.keyId }));
  const тело = b64url(JSON.stringify({ iss: н.teamId, iat: сейчас }));
  // ieee-p1363 — подпись как два числа подряд, как требует JWT; по умолчанию
  // Node отдаёт её в формате DER, и Apple такую не принимает.
  const подпись = crypto.sign('sha256', Buffer.from(голова + '.' + тело),
    { key: н.key, dsaEncoding: 'ieee-p1363' });
  пропуск = { token: `${голова}.${тело}.${b64url(подпись)}`, iat: сейчас };
  return пропуск.token;
}

function соединение(env) {
  const адрес = process.env.ASHER_APNS_HOST || АДРЕС[env] || АДРЕС.production;
  const есть = соединения.get(адрес);
  if (есть && !есть.closed && !есть.destroyed) return есть;
  const с = http2.connect(адрес);
  const забыть = () => { if (соединения.get(адрес) === с) соединения.delete(адрес); };
  с.on('error', забыть);
  с.on('close', забыть);
  с.on('goaway', забыть);
  /*
   * Соединение держим, пока идут уведомления, и закрываем через пять минут
   * тишины: Apple просит не открывать новое на каждое уведомление, но и
   * висеть сутками незачем. Не «отпускаем» его (unref) — иначе короткий
   * процесс, отправивший уведомление, завершался бы, не дождавшись ответа
   * Apple, и уведомление терялось бы молча.
   */
  с.setTimeout(5 * 60 * 1000, () => с.close());
  соединения.set(адрес, с);
  return с;
}

/*
 * Одно уведомление на один телефон. Ответ Apple: 200 — принято; 410 или
 * «BadDeviceToken» — такого телефона для нас больше нет (приложение удалили),
 * и адрес надо забыть, иначе будем стучаться в пустоту вечно.
 */
function отправитьОдно(н, token, env, payload) {
  return new Promise(resolve => {
    let готово = false;
    const закончить = r => { if (!готово) { готово = true; resolve(r); } };
    let запрос;
    try {
      запрос = соединение(env).request({
        ':method': 'POST',
        ':path': '/3/device/' + token,
        authorization: 'bearer ' + выписатьПропуск(н),
        'apns-topic': н.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        // Не доставили за сутки — уже неактуально: «просится войти» через
        // три дня только пугает.
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
        'content-type': 'application/json',
      });
    } catch (e) {
      закончить({ status: 0, reason: e.message });
      return;
    }
    let статус = 0;
    let ответ = '';
    запрос.setEncoding('utf8');
    запрос.on('response', h => { статус = Number(h[':status']) || 0; });
    запрос.on('data', ч => { ответ += ч; });
    запрос.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(ответ || '{}').reason || ''; } catch { /* пусто */ }
      закончить({ status: статус, reason });
    });
    запрос.on('error', e => закончить({ status: 0, reason: e.message }));
    запрос.setTimeout(10000, () => { запрос.close(); закончить({ status: 0, reason: 'timeout' }); });
    запрос.end(JSON.stringify(payload));
  });
}

const НЕТ_ТАКОГО = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/*
 * Отправить людям. Возвращает, на сколько телефонов ушло. Ошибки не
 * бросает никогда: уведомление — подсказка владельцу, и сбой у Apple не должен
 * ронять ни вход продавца, ни резервную копию, ради которых оно отправлялось.
 */
async function отправить(userIds, { title, body, route = '' }) {
  const н = настройки();
  if (!н || !userIds.length) return 0;
  const адреса = db.prepare(
    `SELECT token, env FROM push_tokens WHERE user_id IN (${userIds.map(() => '?').join(',')})`
  ).all(...userIds);
  let ушло = 0;
  for (const а of адреса) {
    const r = await отправитьОдно(н, а.token, а.env,
      { aps: { alert: { title, body }, sound: 'default' }, route });
    if (r.status === 200) ушло++;
    else if (r.status === 410 || НЕТ_ТАКОГО.has(r.reason)) {
      db.prepare('DELETE FROM push_tokens WHERE token = ?').run(а.token);
    } else {
      console.error('Уведомление не доставлено:', r.status, r.reason);
    }
  }
  return ушло;
}

// Кто отвечает за систему: основатели и бухгалтеры.
function ответственные() {
  return db.prepare(
    `SELECT id FROM users WHERE active = 1 AND role IN ('owner','accountant')`
  ).all().map(u => u.id);
}

function запомнить(userId, token, env) {
  const t = nowIso();
  db.prepare(
    `INSERT INTO push_tokens (token, user_id, env, created_at, last_seen) VALUES (?,?,?,?,?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env, last_seen = excluded.last_seen`
  ).run(token, userId, env, t, t);
}

function забыть(token) {
  return Number(db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token).changes || 0);
}

// Отправлено ли уже — и отметить. Одна строка на повод: аренда за сентябрь,
// копия за такой-то день.
function впервые(kind, key) {
  const r = db.prepare('INSERT OR IGNORE INTO push_sent (kind, key, sent_at) VALUES (?,?,?)')
    .run(kind, key, nowIso());
  return Number(r.changes || 0) > 0;
}

// ---------- Поводы ----------

function новоеУстройство(user, code) {
  return отправить(ответственные(), {
    title: 'Вход с нового устройства',
    body: `«${user.name || user.username}» просит войти, код ${code}. ` +
      'Разрешите, если это ваш сотрудник, и отклоните, если нет.',
    route: '#/settings/security',
  }).catch(() => 0);
}

function копияНеСделалась(причина) {
  // Не чаще раза в сутки: копия пробует каждый час, и двадцать четыре
  // одинаковых уведомления за день приучат их не читать.
  if (!впервые('backup', nowIso().slice(0, 10))) return Promise.resolve(0);
  return отправить(ответственные(), {
    title: 'Резервная копия не сделалась',
    body: String(причина || '').slice(0, 180) || 'Откройте «Безопасность», там причина.',
    route: '#/settings/security',
  }).catch(() => 0);
}

/*
 * Постоянные расходы, срок которых подошёл, а записи нет. Проверяется раз
 * в час, отправляется раз в месяц на каждое правило — и только днём по часам
 * магазина: напоминание об аренде в три часа ночи никому не нужно.
 */
async function проверитьРасходы(сейчас = new Date()) {
  if (!включено()) return 0;
  const смещение = Number(getSetting('store_tz'));
  const местные = new Date(сейчас.getTime() + (Number.isFinite(смещение) ? смещение : 360) * 60000);
  const час = местные.getUTCHours();
  if (час < 9 || час >= 21) return 0;
  const месяц = местные.toISOString().slice(0, 7);
  let всего = 0;
  for (const п of require('./api/finance').неЗаписаны(сейчас)) {
    if (!впервые('expense', `${п.id}|${месяц}`)) continue;
    всего += await отправить(ответственные(), {
      title: `Не записан расход: ${п.подпись}`,
      body: `Обычно ${Math.round(п.amount).toLocaleString('ru-RU')}, ${п.day_of_month}-го числа. ` +
        'Пока не записан, прибыль в отчёте завышена.',
      route: '#/finance',
    }).catch(() => 0);
  }
  return всего;
}

// Для проверок: забыть прочитанные настройки и соединения.
function сбросить() {
  настройкиКэш = undefined;
  пропуск = null;
  for (const с of соединения.values()) { try { с.close(); } catch { /* уже закрыто */ } }
  соединения.clear();
}

module.exports = {
  включено, отправить, ответственные, запомнить, забыть,
  новоеУстройство, копияНеСделалась, проверитьРасходы, сбросить,
};
