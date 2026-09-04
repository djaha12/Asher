'use strict';
const { db, nowIso, round2 } = require('../db');
const auth = require('../auth');

/*
 * Панель основателя: кто что делает.
 *
 * Журнал действий отвечает на вопрос «что сделал этот человек в тот день» —
 * и для этого его надо открыть, выбрать сотрудника, выставить даты. Панель
 * отвечает на другой вопрос, тот, с которого основатель начинает утро:
 * «всё ли в порядке у людей». Кто вошёл и когда, кто продавал и на сколько,
 * кто давал скидки, кто что удалял, кто просится с нового телефона, — одним
 * экраном, без отбора.
 *
 * Только основателю. Бухгалтер имеет тот же доступ, что основатель, кроме
 * ровно этого: он один из тех, за кем здесь смотрят.
 *
 * Цифры считаются по журналу действий и по чекам за период. Период — сегодня,
 * неделя или месяц, считая по часам магазина, а не сервера: «сегодня» для
 * магазина в Бишкеке начинается в полночь по Бишкеку.
 */

const ПЕРИОДЫ = [1, 7, 30];

function начало(query) {
  const days = ПЕРИОДЫ.includes(Number(query.days)) ? Number(query.days) : 1;
  const tz = Number(query.tz) || 0;
  const local = new Date(Date.now() + tz * 60000);
  const localDate = local.toISOString().slice(0, 10);
  const началоДня = new Date(localDate + 'T00:00:00Z').getTime() - tz * 60000;
  return { days, since: new Date(началоДня - (days - 1) * 86400000).toISOString() };
}

// Сколько раз у человека встречается действие за период — по видам.
function счётчикиДействий(since) {
  const rows = db.prepare(
    `SELECT user_id, action, COUNT(*) AS c FROM audit_log
     WHERE created_at >= ? AND user_id IS NOT NULL GROUP BY user_id, action`
  ).all(since);
  const поЛюдям = new Map();
  for (const r of rows) {
    if (!поЛюдям.has(r.user_id)) поЛюдям.set(r.user_id, {});
    поЛюдям.get(r.user_id)[r.action] = Number(r.c);
  }
  return поЛюдям;
}

// Деньги — не по журналу, а по чекам: журнал знает, что продажа была,
// чек знает, на сколько и с какой скидкой.
function продажиПоЛюдям(since) {
  const rows = db.prepare(
    `SELECT user_id, COUNT(*) AS cnt, COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(discount_total), 0) AS discount,
            SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END) AS returned
     FROM sales WHERE created_at >= ? GROUP BY user_id`
  ).all(since);
  return new Map(rows.map(r => [r.user_id, r]));
}

function сумма(obj, ...ключи) {
  return ключи.reduce((s, k) => s + (obj[k] || 0), 0);
}

const routes = [
  {
    method: 'GET', path: '/api/team', admin: true, owner: true,
    handler: ({ query }) => {
      const { days, since } = начало(query);
      const now = nowIso();

      const люди = db.prepare(
        `SELECT u.id, u.username, u.name, u.role, u.created_at,
                (SELECT MAX(created_at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'login') AS last_login,
                (SELECT MAX(created_at) FROM audit_log a WHERE a.user_id = u.id) AS last_action,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at >= ?) AS sessions,
                (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.approved = 0) AS pending_devices
         FROM users u WHERE u.active = 1
         ORDER BY CASE u.role WHEN 'accountant' THEN 0 WHEN 'seller' THEN 1 ELSE 2 END, u.name`
      ).all(now);

      const действия = счётчикиДействий(since);
      const продажи = продажиПоЛюдям(since);

      const people = люди.map(u => {
        const д = действия.get(u.id) || {};
        const п = продажи.get(u.id) || { cnt: 0, revenue: 0, discount: 0, returned: 0 };
        return {
          id: u.id, username: u.username, name: u.name, role: u.role,
          last_login: u.last_login || '',
          last_action: u.last_action || '',
          sessions: Number(u.sessions),
          pending_devices: Number(u.pending_devices),
          period: {
            actions: Object.values(д).reduce((s, c) => s + c, 0),
            logins: д.login || 0,
            sales: Number(п.cnt),
            revenue: round2(п.revenue),
            discount: round2(п.discount),
            // Возвраты и обмены — по журналу: чек со статусом «возврат» не
            // говорит, кто именно возврат оформил.
            returns: сумма(д, 'return', 'exchange'),
            payments: д.payment || 0,
            created: д.create || 0,
            edits: д.update || 0,
            deletes: сумма(д, 'delete', 'delete_photo', 'delete_certificate'),
            over_discounts: д.discount || 0,
          },
        };
      });

      /*
       * Лента — последние действия всех, как есть. Это то же, что журнал,
       * но без отбора и без страниц: основатель пробегает её глазами.
       */
      const feed = db.prepare(
        `SELECT a.id, a.user_id, a.action, a.entity, a.entity_id, a.details, a.created_at,
                u.name AS user_name, u.role AS user_role
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC, a.id DESC LIMIT 40`
      ).all();

      const число = (action) => Number(db.prepare(
        'SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND created_at >= ?'
      ).get(action, since).c);

      /*
       * На что смотреть в первую очередь. Незнакомое устройство под чужим
       * логином и серия неудачных входов — признаки того, что пароль знает
       * посторонний. Скидки сверх предела и удаления — то, что владелец
       * обычно хочет объяснить себе по каждому случаю.
       */
      const alerts = {
        pending_devices: auth.pendingDevices(),
        failed_logins: число('login_failed'),
        over_discounts: число('discount'),
        deletes: число('delete'),
      };

      const roles = { owner: 0, accountant: 0, seller: 0 };
      for (const p of people) roles[p.role] = (roles[p.role] || 0) + 1;

      const totals = {
        sales: people.reduce((s, p) => s + p.period.sales, 0),
        revenue: round2(people.reduce((s, p) => s + p.period.revenue, 0)),
        actions: people.reduce((s, p) => s + p.period.actions, 0),
        online: people.filter(p => p.sessions > 0).length,
        // Работал — оставил след в журнале или продал. Второе отдельно: чеки,
        // перенесённые из другой системы, в журнале не отмечены.
        worked: people.filter(p => p.period.actions > 0 || p.period.sales > 0).length,
      };

      return { days, since, people, feed, alerts, roles, totals };
    },
  },
];

module.exports = { routes };
