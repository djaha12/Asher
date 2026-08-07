'use strict';
/*
 * Долги.
 *
 * Три разных вида, которые ведутся отдельно:
 *   1. Клиенты должны нам — продажа в рассрочку: оплатили часть, остаток висит.
 *   2. Мы должны поставщикам — книга операций supplier_ops (поставки минус оплаты).
 *   3. Товар на реализации — как только чужое изделие продано, мы автоматически
 *      становимся должны его владельцу закупочную стоимость.
 *
 * Долг по чеку считается на лету: сумма невозвращённых позиций минус оплачено.
 * Так возврат товара сам уменьшает долг — отдельного пересчёта не нужно.
 */
const { db, nowIso, round2, money, audit, transaction } = require('../db');
const { ApiError } = require('./util');

const PAYMENT_METHODS = ['cash', 'card', 'transfer'];

// Действующая сумма чека: возвращённые позиции в долг не входят.
const EFFECTIVE_TOTAL = `(SELECT COALESCE(SUM(si.final_price), 0) FROM sale_items si
   WHERE si.sale_id = s.id AND si.returned = 0)`;

function saleBalance(saleId) {
  const row = db.prepare(
    `SELECT s.id, s.number, s.paid, s.due_date, s.customer_id, ${EFFECTIVE_TOTAL} AS effective
     FROM sales s WHERE s.id = ?`
  ).get(saleId);
  if (!row) throw new ApiError(404, 'Продажа не найдена');
  return { ...row, debt: round2(row.effective - row.paid) };
}

function orderBalance(orderId) {
  const o = db.prepare('SELECT * FROM service_orders WHERE id = ?').get(orderId);
  if (!o) throw new ApiError(404, 'Заказ не найден');
  const due = round2(o.final_price > 0 ? o.final_price : o.estimate);
  return { ...o, due, debt: round2(due - o.paid) };
}

// ---------- Долги клиентов ----------

function customerDebtRows(customerId = null) {
  const args = [];
  let where = `WHERE ${EFFECTIVE_TOTAL} - s.paid > 0.009 AND s.customer_id IS NOT NULL`;
  if (customerId) { where += ' AND s.customer_id = ?'; args.push(customerId); }
  return db.prepare(
    `SELECT s.id, s.number, s.created_at, s.due_date, s.paid, s.customer_id,
            ${EFFECTIVE_TOTAL} AS total, round(${EFFECTIVE_TOTAL} - s.paid, 2) AS debt,
            c.name AS customer_name, c.phone AS customer_phone
     FROM sales s JOIN customers c ON c.id = s.customer_id
     ${where} ORDER BY s.due_date = '' , s.due_date, s.created_at`
  ).all(...args);
}

function orderDebtRows(customerId = null) {
  const args = [];
  let where = `WHERE o.status = 'delivered' AND o.customer_id IS NOT NULL
               AND round((CASE WHEN o.final_price > 0 THEN o.final_price ELSE o.estimate END) - o.paid, 2) > 0.009`;
  if (customerId) { where += ' AND o.customer_id = ?'; args.push(customerId); }
  return db.prepare(
    `SELECT o.id, o.number, o.accepted_at AS created_at, o.due_date, o.paid, o.customer_id,
            (CASE WHEN o.final_price > 0 THEN o.final_price ELSE o.estimate END) AS total,
            round((CASE WHEN o.final_price > 0 THEN o.final_price ELSE o.estimate END) - o.paid, 2) AS debt,
            c.name AS customer_name, c.phone AS customer_phone
     FROM service_orders o JOIN customers c ON c.id = o.customer_id
     ${where} ORDER BY o.due_date = '', o.due_date, o.accepted_at`
  ).all(...args);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function markOverdue(rows) {
  const now = today();
  return rows.map(r => ({
    ...r,
    overdue: Boolean(r.due_date && r.due_date < now),
    days_overdue: r.due_date && r.due_date < now
      ? Math.floor((Date.parse(now) - Date.parse(r.due_date)) / 86400000)
      : 0,
  }));
}

// ---------- Долги поставщикам ----------

// Долг растёт от поставок, продаж чужого товара и корректировок, гасится оплатами.
const SUPPLIER_BALANCE = `COALESCE(SUM(CASE
    WHEN o.type = 'payment' THEN -o.amount
    ELSE o.amount END), 0)`;

function supplierBalances() {
  return db.prepare(
    `SELECT s.id, s.name, s.phone, s.contact,
            round(${SUPPLIER_BALANCE}, 2) AS balance,
            COALESCE(SUM(CASE WHEN o.type = 'payment' THEN o.amount ELSE 0 END), 0) AS paid_total,
            MIN(CASE WHEN o.type = 'invoice' AND o.due_date != '' THEN o.due_date END) AS nearest_due
     FROM suppliers s LEFT JOIN supplier_ops o ON o.supplier_id = s.id
     GROUP BY s.id ORDER BY balance DESC, s.name`
  ).all();
}

function requireSupplier(id) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!s) throw new ApiError(404, 'Поставщик не найден');
  return s;
}

// Продали изделие с реализации — сразу фиксируем долг перед его владельцем.
function recordConsignmentSale(product, saleId, userId) {
  if (product.ownership !== 'consignment' || !product.supplier_id) return;
  const amount = round2(product.purchase_price);
  if (!(amount > 0)) return;
  db.prepare(
    `INSERT INTO supplier_ops (supplier_id, type, amount, doc_date, note, product_id, sale_id, user_id, created_at)
     VALUES (?, 'consignment_sale', ?, ?, ?, ?, ?, ?, ?)`
  ).run(product.supplier_id, amount, today(),
    `Продано с реализации: ${product.sku} ${product.name}`, product.id, saleId, userId, nowIso());
}

// Изделие вернули — долг перед владельцем снимаем.
function revokeConsignmentSale(productId, saleId) {
  db.prepare(`DELETE FROM supplier_ops WHERE type = 'consignment_sale' AND product_id = ? AND sale_id = ?`)
    .run(productId, saleId);
}

const routes = [
  // ---------- Сводка ----------
  {
    method: 'GET', path: '/api/debts/summary',
    handler: ({ session }) => {
      const sales = markOverdue(customerDebtRows());
      const orders = markOverdue(orderDebtRows());
      const all = [...sales, ...orders];
      const customersOwe = round2(all.reduce((s, r) => s + r.debt, 0));
      const overdue = round2(all.filter(r => r.overdue).reduce((s, r) => s + r.debt, 0));
      const debtors = new Set(all.map(r => r.customer_id)).size;

      const out = {
        customers_owe: customersOwe,
        customers_overdue: overdue,
        debtors_count: debtors,
        documents_count: all.length,
      };
      // Расчёты с поставщиками — коммерческая тайна владельца, продавцу не показываем.
      if (session.role === 'admin') {
        const suppliers = supplierBalances().filter(s => s.balance > 0.009);
        out.we_owe = round2(suppliers.reduce((s, r) => s + r.balance, 0));
        out.suppliers_count = suppliers.length;
        out.consignment_items = db.prepare(
          `SELECT COUNT(*) AS c FROM products WHERE ownership = 'consignment' AND status IN ('in_stock','reserved')`
        ).get().c;
      }
      return out;
    },
  },

  // ---------- Кто нам должен ----------
  {
    method: 'GET', path: '/api/debts/customers',
    handler: ({ query }) => {
      const rows = markOverdue([
        ...customerDebtRows().map(r => ({ ...r, kind: 'sale' })),
        ...orderDebtRows().map(r => ({ ...r, kind: 'order' })),
      ]);
      const byCustomer = new Map();
      for (const r of rows) {
        const cur = byCustomer.get(r.customer_id) || {
          customer_id: r.customer_id, customer_name: r.customer_name, customer_phone: r.customer_phone,
          debt: 0, overdue_debt: 0, documents: 0, oldest_due: '', max_days_overdue: 0,
        };
        cur.debt = round2(cur.debt + r.debt);
        if (r.overdue) cur.overdue_debt = round2(cur.overdue_debt + r.debt);
        cur.documents++;
        if (r.due_date && (!cur.oldest_due || r.due_date < cur.oldest_due)) cur.oldest_due = r.due_date;
        cur.max_days_overdue = Math.max(cur.max_days_overdue, r.days_overdue);
        byCustomer.set(r.customer_id, cur);
      }
      let items = [...byCustomer.values()];
      if (query.overdue === '1') items = items.filter(i => i.overdue_debt > 0);
      if (query.search) {
        const q = String(query.search).toLowerCase();
        items = items.filter(i =>
          String(i.customer_name).toLowerCase().includes(q) || String(i.customer_phone).includes(q));
      }
      items.sort((a, b) => b.overdue_debt - a.overdue_debt || b.debt - a.debt);
      return {
        items,
        totals: {
          debt: round2(items.reduce((s, i) => s + i.debt, 0)),
          overdue: round2(items.reduce((s, i) => s + i.overdue_debt, 0)),
        },
      };
    },
  },

  {
    method: 'GET', path: '/api/debts/customers/:id',
    handler: ({ params }) => {
      const id = Number(params.id);
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!customer) throw new ApiError(404, 'Клиент не найден');
      const sales = markOverdue(customerDebtRows(id).map(r => ({ ...r, kind: 'sale' })));
      const orders = markOverdue(orderDebtRows(id).map(r => ({ ...r, kind: 'order' })));
      const payments = db.prepare(
        `SELECT p.*, s.number AS sale_number, o.number AS order_number, u.name AS user_name
         FROM payments p
         LEFT JOIN sales s ON s.id = p.sale_id
         LEFT JOIN service_orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = p.user_id
         WHERE p.customer_id = ? ORDER BY p.created_at DESC LIMIT 200`
      ).all(id);
      const documents = [...sales, ...orders];
      return {
        customer,
        documents,
        payments,
        total_debt: round2(documents.reduce((s, d) => s + d.debt, 0)),
      };
    },
  },

  {
    // Приём денег в счёт долга: по конкретному документу либо «сколько принёс» —
    // тогда сумма гасит документы по очереди, начиная с самого старого.
    method: 'POST', path: '/api/debts/payments',
    handler: ({ body, session }) => {
      const amount = round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма платежа должна быть больше нуля');
      const method = PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
      const note = String(body.note || '').trim();

      return transaction(() => {
        const ts = nowIso();
        const applied = [];
        let left = amount;

        const payOne = (kind, docId) => {
          if (left <= 0.009) return;
          const bal = kind === 'sale' ? saleBalance(docId) : orderBalance(docId);
          if (bal.debt <= 0.009) return;
          const part = round2(Math.min(left, bal.debt));
          if (kind === 'sale') {
            db.prepare('UPDATE sales SET paid = round(paid + ?, 2) WHERE id = ?').run(part, docId);
            db.prepare(
              `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
               VALUES ('income', 'Погашение долга', ?, ?, ?, ?, ?)`
            ).run(part, `Погашение по чеку ${bal.number}`, docId, session.userId, ts);
          } else {
            db.prepare('UPDATE service_orders SET paid = round(paid + ?, 2) WHERE id = ?').run(part, docId);
            db.prepare(
              `INSERT INTO finance_ops (type, category, amount, note, order_id, user_id, created_at)
               VALUES ('income', 'Погашение долга', ?, ?, ?, ?, ?)`
            ).run(part, `Погашение по заказу ${bal.number}`, docId, session.userId, ts);
          }
          db.prepare(
            `INSERT INTO payments (customer_id, sale_id, order_id, amount, method, note, user_id, created_at)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(bal.customer_id ?? null, kind === 'sale' ? docId : null, kind === 'order' ? docId : null,
            part, method, note, session.userId, ts);
          applied.push({ kind, id: docId, number: bal.number, amount: part,
            customer_id: bal.customer_id ?? null });
          left = round2(left - part);
        };

        if (body.sale_id) payOne('sale', Number(body.sale_id));
        else if (body.order_id) payOne('order', Number(body.order_id));
        else {
          const customerId = Number(body.customer_id);
          if (!customerId) throw new ApiError(400, 'Укажите клиента или конкретный документ');
          if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) {
            throw new ApiError(400, 'Клиент не найден');
          }
          const docs = markOverdue([
            ...customerDebtRows(customerId).map(r => ({ ...r, kind: 'sale' })),
            ...orderDebtRows(customerId).map(r => ({ ...r, kind: 'order' })),
          ]).sort((a, b) => String(a.due_date || a.created_at).localeCompare(String(b.due_date || b.created_at)));
          for (const d of docs) payOne(d.kind, d.id);
        }

        if (!applied.length) throw new ApiError(400, 'Долга по этому документу нет');
        if (left > 0.009) {
          throw new ApiError(400,
            `Платёж больше долга на ${left.toLocaleString('ru-RU')}. Долг закрыт не полностью или сумма указана с ошибкой.`);
        }
        // В журнале должно быть видно не только «сколько», но и «от кого и по чему».
        const payer = db.prepare('SELECT name FROM customers WHERE id = ?')
          .get(Number(body.customer_id) || applied[0].customer_id || 0);
        audit(session.userId, 'payment', 'debt', applied[0].id,
          `${payer ? payer.name + ': ' : ''}погашение долга ${money(amount)}` +
          ` (${applied.map(a => a.number).join(', ')})`);
        return { applied, total: amount };
      });
    },
  },

  {
    method: 'GET', path: '/api/debts/payments',
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.from) { cond.push('p.created_at >= ?'); args.push(query.from); }
      if (query.to) { cond.push('p.created_at <= ?'); args.push(query.to); }
      if (query.customer_id) { cond.push('p.customer_id = ?'); args.push(Number(query.customer_id)); }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const items = db.prepare(
        `SELECT p.*, c.name AS customer_name, s.number AS sale_number, o.number AS order_number, u.name AS user_name
         FROM payments p
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN sales s ON s.id = p.sale_id
         LEFT JOIN service_orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = p.user_id
         ${where} ORDER BY p.created_at DESC LIMIT 500`
      ).all(...args);
      return { items, total: round2(items.reduce((s, p) => s + p.amount, 0)) };
    },
  },

  // ---------- Кому должны мы ----------
  {
    method: 'GET', path: '/api/debts/suppliers', admin: true,
    handler: () => {
      const items = supplierBalances();
      return {
        items,
        total: round2(items.reduce((s, i) => s + Math.max(i.balance, 0), 0)),
      };
    },
  },

  {
    method: 'GET', path: '/api/debts/suppliers/:id', admin: true,
    handler: ({ params }) => {
      const id = Number(params.id);
      const supplier = requireSupplier(id);
      const ops = db.prepare(
        `SELECT o.*, p.sku, p.name AS product_name, s.number AS sale_number, u.name AS user_name
         FROM supplier_ops o
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN sales s ON s.id = o.sale_id
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.supplier_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 500`
      ).all(id);
      const balance = ops.reduce((s, o) => round2(s + (o.type === 'payment' ? -o.amount : o.amount)), 0);
      // Сколько ещё висит на витрине чужого товара — это будущий долг.
      const consignment = db.prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(purchase_price), 0) AS value
         FROM products WHERE supplier_id = ? AND ownership = 'consignment' AND status IN ('in_stock','reserved')`
      ).get(id);
      return { supplier, ops, balance: round2(balance), consignment_on_hand: consignment };
    },
  },

  {
    method: 'POST', path: '/api/debts/suppliers/:id/ops', admin: true,
    handler: ({ params, body, session }) => {
      const supplierId = Number(params.id);
      const supplier = requireSupplier(supplierId);
      const type = body.type;
      if (!['invoice', 'payment', 'adjust'].includes(type)) {
        throw new ApiError(400, 'Тип операции: поставка, оплата или корректировка');
      }
      const amount = round2(body.amount);
      if (type === 'adjust') {
        if (amount === 0) throw new ApiError(400, 'Сумма корректировки не может быть нулевой');
      } else if (!(amount > 0)) {
        throw new ApiError(400, 'Сумма должна быть больше нуля');
      }
      const method = type === 'payment' && PAYMENT_METHODS.includes(body.method) ? body.method : '';

      return transaction(() => {
        const ts = nowIso();
        const info = db.prepare(
          `INSERT INTO supplier_ops (supplier_id, type, amount, doc_number, doc_date, due_date, note, method, user_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(supplierId, type, amount, String(body.doc_number || '').trim(),
          String(body.doc_date || today()), String(body.due_date || ''), String(body.note || '').trim(),
          method, session.userId, ts);

        // Оплата поставщику — это движение денег, но не расход периода:
        // стоимость товара попадёт в прибыль как себестоимость при продаже.
        if (type === 'payment') {
          db.prepare(
            `INSERT INTO finance_ops (type, category, amount, note, user_id, created_at)
             VALUES ('expense', 'Оплата поставщику', ?, ?, ?, ?)`
          ).run(amount, `${supplier.name}${body.doc_number ? ` (${body.doc_number})` : ''}`, session.userId, ts);
        }
        audit(session.userId, type, 'supplier', supplierId, `${supplier.name}: ${money(amount)}`);
        return { id: Number(info.lastInsertRowid) };
      });
    },
  },

  {
    method: 'DELETE', path: '/api/debts/supplier-ops/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const op = db.prepare('SELECT * FROM supplier_ops WHERE id = ?').get(id);
      if (!op) throw new ApiError(404, 'Операция не найдена');
      if (op.type === 'consignment_sale') {
        throw new ApiError(400, 'Долг создан продажей изделия с реализации — он снимется возвратом по чеку');
      }
      if (op.kind === 'return') {
        throw new ApiError(400, 'Это возврат изделия поставщику. Удалить строку нельзя — иначе долг вернётся, а изделие останется списанным. Верните изделие на витрину в его карточке.');
      }
      db.prepare('DELETE FROM supplier_ops WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'supplier_op', id, `${op.type}: ${op.amount}`);
      return { ok: true };
    },
  },

  {
    /*
     * Возврат изделия поставщику (брак, пересорт, не продалось).
     *
     * Изделие уходит со склада, а наш долг перед поставщиком уменьшается на
     * закупочную стоимость. Записываем корректировкой с отрицательной суммой:
     * так возврат виден отдельной строкой в книге расчётов и участвует в балансе
     * ровно как надо. Товар на реализации — особый случай: долг перед владельцем
     * возникает только при продаже, поэтому денег там уменьшать нечего,
     * но след в истории нужен.
     */
    method: 'POST', path: '/api/products/:id/return-to-supplier', admin: true,
    handler: ({ params, body, session }) => {
      const productId = Number(params.id);
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!p) throw new ApiError(404, 'Изделие не найдено');
      if (p.status === 'sold') {
        throw new ApiError(400, 'Изделие продано. Сначала оформите возврат по чеку, потом возврат поставщику.');
      }
      if (p.status === 'written_off') throw new ApiError(400, 'Изделие уже списано');
      if (!p.supplier_id) throw new ApiError(400, 'У изделия не указан поставщик — некому возвращать');
      const supplier = requireSupplier(p.supplier_id);

      const REASONS = ['брак', 'пересорт', 'не продалось', 'другое'];
      const reason = REASONS.includes(String(body.reason || '').trim())
        ? String(body.reason).trim() : 'другое';
      const note = String(body.note || '').trim();

      return transaction(() => {
        const ts = nowIso();
        // Своё изделие мы у поставщика купили — возврат уменьшает наш долг.
        // Чужое (реализация) деньгами не двигаем: мы за него ещё не должны.
        const amount = p.ownership === 'consignment' ? 0 : -round2(p.purchase_price);
        const opInfo = db.prepare(
          `INSERT INTO supplier_ops (supplier_id, type, kind, amount, doc_date, note,
                                     product_id, user_id, created_at)
           VALUES (?, 'adjust', 'return', ?, ?, ?, ?, ?, ?)`
        ).run(supplier.id, amount, today(),
          `Возврат поставщику (${reason}): ${p.sku} ${p.name}${note ? ' — ' + note : ''}`,
          p.id, session.userId, ts);

        db.prepare(
          `UPDATE products SET status = 'written_off', write_off_reason = ?,
                               reserved_for = NULL, reserved_until = ''
            WHERE id = ?`
        ).run(`Возврат поставщику: ${reason}`, p.id);

        audit(session.userId, 'return_to_supplier', 'product', p.id,
          `${p.sku} → ${supplier.name} (${reason}), долг −${round2(Math.abs(amount))}`);
        return {
          ok: true,
          op_id: Number(opInfo.lastInsertRowid),
          debt_reduced: round2(Math.abs(amount)),
          supplier: supplier.name,
        };
      });
    },
  },

  {
    // Изделия на реализации: что стоит на витрине и что уже продано, но не отдано владельцу.
    method: 'GET', path: '/api/debts/consignment', admin: true,
    handler: () => {
      const onHand = db.prepare(
        `SELECT p.id, p.sku, p.name, p.purchase_price, p.retail_price, p.status,
                s.name AS supplier_name, st.name AS store_name
         FROM products p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN stores st ON st.id = p.store_id
         WHERE p.ownership = 'consignment' AND p.status IN ('in_stock','reserved')
         ORDER BY s.name, p.sku`
      ).all();
      const sold = db.prepare(
        `SELECT o.id AS op_id, o.amount, o.created_at, p.sku, p.name, s.name AS supplier_name,
                sa.number AS sale_number
         FROM supplier_ops o
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN sales sa ON sa.id = o.sale_id
         WHERE o.type = 'consignment_sale' ORDER BY o.created_at DESC LIMIT 300`
      ).all();
      return {
        on_hand: onHand,
        on_hand_value: round2(onHand.reduce((s, p) => s + p.purchase_price, 0)),
        sold,
        sold_value: round2(sold.reduce((s, o) => s + o.amount, 0)),
      };
    },
  },
];

module.exports = { routes, saleBalance, recordConsignmentSale, revokeConsignmentSale, EFFECTIVE_TOTAL };
