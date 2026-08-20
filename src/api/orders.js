'use strict';
const { db, nowIso, round2, audit, nextNumber, transaction } = require('../db');
const { ApiError } = require('./util');

const TYPES = ['repair', 'custom', 'engraving', 'resize', 'cleaning', 'appraisal'];
const STATUSES = ['accepted', 'in_progress', 'ready', 'delivered', 'cancelled'];

function orderDetail(id) {
  const o = db.prepare(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS user_name
     FROM service_orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.user_id
     WHERE o.id = ?`
  ).get(id);
  if (!o) throw new ApiError(404, 'Заказ не найден');
  const payments = db.prepare(
    `SELECT id, amount, note, created_at FROM finance_ops WHERE order_id = ? AND type = 'income' ORDER BY created_at`
  ).all(id);
  return { ...o, payments };
}

/*
 * Оплата по заказу.
 *
 * Кроме записи в финансовых операциях обязательно пишем строку в платежи.
 * Без неё сверка кассы про эти деньги не знала вовсе: предоплата за ремонт
 * ложилась в ящик, а система её не видела — и вечером получалась «недостача»
 * ровно на принятую предоплату. При этом те же деньги, принятые через раздел
 * «Долги», в сверку попадали: одни и те же деньги были видны или не видны
 * в зависимости от того, какую кнопку нажал продавец.
 */
function addPayment(orderId, amount, note, userId, method = 'cash') {
  const ts = nowIso();
  const способ = ['cash', 'card', 'transfer'].includes(method) ? method : 'cash';
  const заказ = db.prepare('SELECT customer_id FROM service_orders WHERE id = ?').get(orderId);
  db.prepare(
    `INSERT INTO finance_ops (type, category, amount, note, order_id, cash, user_id, created_at)
     VALUES ('income', 'Оплата заказа', ?, ?, ?, ?, ?, ?)`
  ).run(amount, note, orderId, способ === 'cash' ? 1 : 0, userId, ts);
  db.prepare(
    `INSERT INTO payments (customer_id, order_id, amount, method, note, in_till, user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(заказ ? заказ.customer_id : null, orderId, amount, способ, note,
    способ === 'cash' ? 1 : 0, userId, ts);
  db.prepare('UPDATE service_orders SET paid = round(paid + ?, 2) WHERE id = ?').run(amount, orderId);
}

const routes = [
  {
    method: 'GET', path: '/api/orders',
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.status) { cond.push('o.status = ?'); args.push(query.status); }
      if (query.type) { cond.push('o.type = ?'); args.push(query.type); }
      if (query.search) {
        cond.push('(nlower(o.number) LIKE ? OR nlower(o.description) LIKE ? OR nlower(c.name) LIKE ?)');
        const s = `%${String(query.search).toLowerCase()}%`;
        args.push(s, s, s);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
         FROM service_orders o LEFT JOIN customers c ON c.id = o.customer_id
         ${where} ORDER BY
           CASE o.status WHEN 'accepted' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END,
           o.accepted_at DESC LIMIT 500`
      ).all(...args);
      const counts = db.prepare('SELECT status, COUNT(*) AS c FROM service_orders GROUP BY status').all();
      return { items: rows, status_counts: counts };
    },
  },
  { method: 'GET', path: '/api/orders/:id', handler: ({ params }) => orderDetail(Number(params.id)) },
  {
    method: 'POST', path: '/api/orders',
    handler: ({ body, session }) => {
      const type = TYPES.includes(body.type) ? body.type : 'repair';
      const description = String(body.description || '').trim();
      if (!description) throw new ApiError(400, 'Опишите заказ');
      const customerId = body.customer_id ? Number(body.customer_id) : null;
      if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) {
        throw new ApiError(400, 'Клиент не найден');
      }
      const estimate = round2(body.estimate || 0);
      const prepayment = round2(body.prepayment || 0);
      if (estimate < 0 || prepayment < 0) throw new ApiError(400, 'Суммы не могут быть отрицательными');

      return transaction(() => {
        const number = nextNumber('З', 'service_orders');
        const info = db.prepare(
          `INSERT INTO service_orders (number, type, customer_id, user_id, description, status,
             estimate, prepayment, paid, due_date, accepted_at, note)
           VALUES (?,?,?,?,?, 'accepted', ?, ?, 0, ?, ?, ?)`
        ).run(number, type, customerId, session.userId, description, estimate, prepayment,
          String(body.due_date || ''), nowIso(), String(body.note || ''));
        const id = Number(info.lastInsertRowid);
        if (prepayment > 0) {
          addPayment(id, prepayment, `Предоплата по заказу ${number}`, session.userId, body.method);
        }
        audit(session.userId, 'create', 'order', id, `${number} (${type})`);
        return orderDetail(id);
      });
    },
  },
  {
    method: 'PUT', path: '/api/orders/:id',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Заказ не найден');
      const upd = {};
      if (body.description !== undefined) {
        upd.description = String(body.description || '').trim();
        if (!upd.description) throw new ApiError(400, 'Описание не может быть пустым');
      }
      if (body.type !== undefined) {
        if (!TYPES.includes(body.type)) throw new ApiError(400, 'Недопустимый тип заказа');
        upd.type = body.type;
      }
      if (body.customer_id !== undefined) {
        if (body.customer_id) {
          const cid = Number(body.customer_id);
          if (!Number.isInteger(cid) || !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid)) {
            throw new ApiError(400, 'Клиент не найден');
          }
          upd.customer_id = cid;
        } else {
          upd.customer_id = null;
        }
      }
      if (body.estimate !== undefined) {
        upd.estimate = round2(body.estimate);
        if (upd.estimate < 0) throw new ApiError(400, 'Сумма не может быть отрицательной');
      }
      if (body.final_price !== undefined) {
        upd.final_price = round2(body.final_price);
        if (upd.final_price < 0) throw new ApiError(400, 'Сумма не может быть отрицательной');
      }
      if (body.due_date !== undefined) upd.due_date = String(body.due_date || '');
      if (body.note !== undefined) upd.note = String(body.note || '');
      const fields = Object.keys(upd);
      if (!fields.length) return { ok: true };
      db.prepare(`UPDATE service_orders SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...fields.map(f => upd[f]), id);
      audit(session.userId, 'update', 'order', id, existing.number);
      return orderDetail(id);
    },
  },
  {
    method: 'POST', path: '/api/orders/:id/status',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const status = body.status;
      if (!STATUSES.includes(status)) throw new ApiError(400, 'Недопустимый статус');
      const o = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id);
      if (!o) throw new ApiError(404, 'Заказ не найден');
      if (o.status === 'delivered' && status !== 'delivered') {
        throw new ApiError(400, 'Заказ уже выдан — статус изменить нельзя');
      }
      if (o.status === 'cancelled' && status !== 'cancelled') {
        throw new ApiError(400, 'Заказ отменён — создайте новый, если работа возобновилась');
      }
      return transaction(() => {
        db.prepare('UPDATE service_orders SET status = ?, delivered_at = ? WHERE id = ?')
          .run(status, status === 'delivered' ? nowIso() : o.delivered_at, id);
        /*
         * При отмене возвращаем клиенту всё оплаченное.
         *
         * Условие «ещё не был отменён» — не перестраховка: переход
         * «отменён → отменён» верхняя проверка пропускает, а paid не обнулялся,
         * и каждое повторное нажатие записывало возврат заново. Через интерфейс
         * кнопка после отмены прячется, но два планшета с открытой карточкой
         * заказа — обычное дело в магазине с шестью продавцами.
         */
        if (status === 'cancelled' && o.status !== 'cancelled' && o.paid > 0) {
          const ts = nowIso();
          /*
           * Способ берём из того, как за заказ действительно платили: своего
           * поля у заказа нет, а вернуть на карту деньги, принятые наличными
           * (и наоборот), значит соврать сверке кассы. Если платежей почему-то
           * нет — считаем наличными, это обычный случай у прилавка.
           */
          const последний = db.prepare(
            `SELECT method FROM payments WHERE order_id = ? AND amount > 0
              ORDER BY id DESC LIMIT 1`
          ).get(id);
          const способ = последний && ['card', 'transfer'].includes(последний.method)
            ? последний.method : 'cash';
          db.prepare(
            `INSERT INTO finance_ops (type, category, amount, note, order_id, cash, user_id, created_at)
             VALUES ('expense', 'Возврат покупателю', ?, ?, ?, ?, ?, ?)`
          ).run(o.paid, `Возврат оплаты по отменённому заказу ${o.number}`, id,
            способ === 'cash' ? 1 : 0, session.userId, ts);
          // Деньги ушли из ящика — сверка кассы должна это увидеть.
          db.prepare(
            `INSERT INTO payments (customer_id, order_id, amount, method, note, in_till, user_id, created_at)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(o.customer_id, id, -o.paid, способ,
            `Возврат по отменённому заказу ${o.number}`, способ === 'cash' ? 1 : 0,
            session.userId, ts);
          // Деньги отданы — за заказом больше ничего не числится.
          db.prepare('UPDATE service_orders SET paid = 0 WHERE id = ?').run(id);
        }
        audit(session.userId, 'status', 'order', id, `${o.number}: ${o.status} → ${status}`);
        return orderDetail(id);
      });
    },
  },
  {
    method: 'POST', path: '/api/orders/:id/payment',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const amount = round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма оплаты должна быть больше нуля');
      const o = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id);
      if (!o) throw new ApiError(404, 'Заказ не найден');
      if (o.status === 'cancelled') throw new ApiError(400, 'Заказ отменён');
      return transaction(() => {
        addPayment(id, amount, `Оплата по заказу ${o.number}`, session.userId, body.method);
        audit(session.userId, 'payment', 'order', id, `${o.number}: +${amount}`);
        return orderDetail(id);
      });
    },
  },
];

module.exports = { routes };
