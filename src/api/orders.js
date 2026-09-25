'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, nowIso, round2, audit, nextNumber, transaction, MEDIA_DIR } = require('../db');
const { ApiError } = require('./util');
const { decodeDataUrl, removeFiles } = require('./images');

// Фотографий при приёме хватает трёх-четырёх; двенадцать — с запасом на
// «до» и «после», но не бесконечно: место на сервере не резиновое.
const MAX_PHOTOS = 12;

/*
 * Что принесли: изделие, вес, камни, состояние. Общая проверка для приёма
 * и правки. Вес — в граммах, как на весах: «4,52» с запятой тоже понимаем.
 */
function поляПриёма(body, upd) {
  for (const [поле, предел, имя] of [['item', 200, 'Изделие'], ['stones', 300, 'Камни'], ['defects', 300, 'Состояние']]) {
    if (body[поле] === undefined) continue;
    const v = String(body[поле] ?? '').trim();
    if (v.length > предел) throw new ApiError(400, `${имя}: слишком длинно — хватит пары строк`);
    upd[поле] = v;
  }
  if (body.weight !== undefined) {
    const сырой = String(body.weight ?? '').trim().replace(',', '.');
    const w = сырой === '' ? 0 : Number(сырой);
    if (!Number.isFinite(w) || w < 0 || w > 5000) throw new ApiError(400, 'Проверьте вес: граммы, от 0 до 5000');
    upd.weight = Math.round(w * 1000) / 1000;
  }
  return upd;
}

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
  const images = db.prepare(
    'SELECT id, file, thumb, created_at FROM order_images WHERE order_id = ? ORDER BY id'
  ).all(id);
  return { ...o, payments, images };
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
        cond.push('(nlower(o.number) LIKE ? OR nlower(o.description) LIKE ? OR nlower(o.item) LIKE ? OR nlower(c.name) LIKE ?)');
        const s = `%${String(query.search).toLowerCase()}%`;
        args.push(s, s, s, s);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
                (SELECT COUNT(*) FROM order_images oi WHERE oi.order_id = o.id) AS photo_count
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
      const п = поляПриёма(body, { item: '', weight: 0, stones: '', defects: '' });

      return transaction(() => {
        const number = nextNumber('З', 'service_orders');
        const info = db.prepare(
          `INSERT INTO service_orders (number, type, customer_id, user_id, description, status,
             estimate, prepayment, paid, due_date, accepted_at, note, item, weight, stones, defects)
           VALUES (?,?,?,?,?, 'accepted', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
        ).run(number, type, customerId, session.userId, description, estimate, prepayment,
          String(body.due_date || ''), nowIso(), String(body.note || ''),
          п.item, п.weight, п.stones, п.defects);
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
      поляПриёма(body, upd);
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
         * «Готов» — из любого незакрытого статуса, одним нажатием: мастер
         * отдал изделие, и промежуточное «в работе» никому не нужно.
         * Время готовности помним: сколько заказ ждёт клиента. Вернули
         * в работу — прежнее «готово» и «клиенту написали» больше не правда.
         */
        if (status === 'ready' && o.status !== 'ready') {
          db.prepare('UPDATE service_orders SET ready_at = ?, notified_at = NULL WHERE id = ?').run(nowIso(), id);
        } else if (status === 'accepted' || status === 'in_progress') {
          db.prepare('UPDATE service_orders SET ready_at = NULL, notified_at = NULL WHERE id = ?').run(id);
        }
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
  {
    /*
     * Клиенту написали «заказ готов». Отметка общая: второй продавец видит,
     * что писать уже не надо, а владелец — какие готовые заказы лежат,
     * а клиент о них не знает.
     */
    method: 'POST', path: '/api/orders/:id/notified',
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const o = db.prepare('SELECT number, status FROM service_orders WHERE id = ?').get(id);
      if (!o) throw new ApiError(404, 'Заказ не найден');
      if (o.status !== 'ready') throw new ApiError(400, 'Заказ ещё не готов');
      db.prepare('UPDATE service_orders SET notified_at = ? WHERE id = ?').run(nowIso(), id);
      audit(session.userId, 'notify', 'order', id, `${o.number}: клиенту написали, что готово`);
      return { ok: true };
    },
  },
  {
    // Фото при приёме: в каком виде принесли. Сжимает браузер, как у изделий.
    method: 'POST', path: '/api/orders/:id/images',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const o = db.prepare('SELECT number FROM service_orders WHERE id = ?').get(id);
      if (!o) throw new ApiError(404, 'Заказ не найден');
      const count = db.prepare('SELECT COUNT(*) AS c FROM order_images WHERE order_id = ?').get(id).c;
      if (count >= MAX_PHOTOS) throw new ApiError(400, `У заказа уже ${MAX_PHOTOS} фотографий`);
      const full = decodeDataUrl(body.data, 'основное');
      const thumb = body.thumb ? decodeDataUrl(body.thumb, 'миниатюра') : full;
      const папка = path.posix.join('orders', String(id));
      fs.mkdirSync(path.join(MEDIA_DIR, папка), { recursive: true });
      const base = crypto.randomUUID();
      const fileRel = path.posix.join(папка, `${base}.${full.fmt.ext}`);
      const thumbRel = path.posix.join(папка, `${base}_t.${thumb.fmt.ext}`);
      fs.writeFileSync(path.join(MEDIA_DIR, fileRel), full.buf);
      fs.writeFileSync(path.join(MEDIA_DIR, thumbRel), thumb.buf);
      const info = db.prepare(
        'INSERT INTO order_images (order_id, file, thumb, user_id, created_at) VALUES (?,?,?,?,?)'
      ).run(id, fileRel, thumbRel, session.userId, nowIso());
      audit(session.userId, 'upload_photo', 'order', id, o.number);
      return { id: Number(info.lastInsertRowid), file: fileRel, thumb: thumbRel };
    },
  },
  {
    /*
     * Удаляет только администратор. Фото при приёме — доказательство того,
     * в каком виде изделие принесли; если продавец может его стереть, в споре
     * о пропавшем камне оно ничего не стоит.
     */
    method: 'DELETE', path: '/api/orders/:id/images/:imageId', admin: true,
    handler: ({ params, session }) => {
      const img = db.prepare('SELECT * FROM order_images WHERE id = ? AND order_id = ?')
        .get(Number(params.imageId), Number(params.id));
      if (!img) throw new ApiError(404, 'Фотография не найдена');
      db.prepare('DELETE FROM order_images WHERE id = ?').run(img.id);
      removeFiles([img]);
      audit(session.userId, 'delete_photo', 'order', img.order_id, '');
      return { ok: true };
    },
  },
];

module.exports = { routes };
