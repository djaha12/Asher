'use strict';
const { db, nowIso, round2, money, audit, nextNumber, transaction } = require('../db');
const { ApiError } = require('./util');
const { recordConsignmentSale, revokeConsignmentSale } = require('./debts');

function saleDetail(id, role = 'admin') {
  const s = db.prepare(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS seller_name,
            st.name AS store_name
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN stores st ON st.id = s.store_id
     WHERE s.id = ?`
  ).get(id);
  if (!s) throw new ApiError(404, 'Продажа не найдена');
  const items = db.prepare(
    `SELECT si.*, p.sku, p.name, p.metal, p.weight, p.size, p.gem_summary
     FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?`
  ).all(id);
  const payments = db.prepare(
    `SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.sale_id = ? ORDER BY p.created_at`
  ).all(id);
  // Долг считаем по невозвращённым позициям: вернул товар — уменьшился и долг.
  const effective = round2(items.filter(i => !i.returned).reduce((sum, i) => sum + i.final_price, 0));
  const debt = round2(effective - s.paid);
  // себестоимость — только администратору
  if (role !== 'admin') {
    delete s.cost_total;
    for (const it of items) delete it.cost;
  }
  return { ...s, items, payments, effective_total: effective, debt };
}

/*
 * Оформление продажи. Вызывается из двух мест: обычная продажа (POST /api/sales)
 * и обмен, где новый чек создаётся вместе с возвратом по старому.
 * Работает только внутри открытой транзакции.
 *
 * opts.paymentNote — подпись платежа («Оплата чека» / «Обмен: зачёт + доплата»).
 */
function createSaleTx(body, session, opts = {}) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new ApiError(400, 'В чеке нет ни одной позиции');
  const customerId = body.customer_id ? Number(body.customer_id) : null;
  const payment = ['cash', 'card', 'transfer', 'installment'].includes(body.payment_method)
    ? body.payment_method : 'cash';
  const dueDate = String(body.due_date || '').trim();
  const storeId = body.store_id ? Number(body.store_id) : null;

  let customer = null;
  if (customerId) {
    customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new ApiError(400, 'Клиент не найден');
  }

  let subtotal = 0, discountItems = 0, costTotal = 0;
  const prepared = [];
  const seen = new Set();
  for (const it of items) {
    const pid = Number(it.product_id);
    if (seen.has(pid)) throw new ApiError(400, 'Одно изделие дважды в чеке');
    seen.add(pid);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
    if (!p) throw new ApiError(400, `Изделие #${pid} не найдено`);
    if (p.status === 'sold') throw new ApiError(400, `«${p.name}» уже продано`);
    if (p.status === 'written_off') throw new ApiError(400, `«${p.name}» списано`);
    if (p.status === 'reserved' && p.reserved_for && customerId !== p.reserved_for) {
      throw new ApiError(400, `«${p.name}» в резерве за другим клиентом`);
    }
    const price = round2(p.retail_price);
    const discount = round2(it.discount || 0);
    if (discount < 0 || discount > price) throw new ApiError(400, `Недопустимая скидка на «${p.name}»`);
    subtotal = round2(subtotal + price);
    discountItems = round2(discountItems + discount);
    costTotal = round2(costTotal + p.purchase_price);
    // Комплект в чеке — только подпись позиции: цена и скидка уже разложены
    // по изделиям, поэтому на расчёты эта колонка не влияет.
    const setId = it.set_id ? Number(it.set_id) : null;
    prepared.push({ product: p, price, discount, final: round2(price - discount), setId });
  }

  const total = round2(prepared.reduce((s, pr) => s + pr.final, 0));

  // Оплачено может быть меньше суммы чека — остаток становится долгом клиента.
  // Если поле не передано, считаем чек оплаченным полностью (обычная продажа).
  const paid = body.paid === undefined || body.paid === null || body.paid === ''
    ? total : round2(body.paid);
  if (paid < 0) throw new ApiError(400, 'Оплаченная сумма не может быть отрицательной');
  if (paid > total) throw new ApiError(400, 'Оплачено больше суммы чека — проверьте сумму');
  const debt = round2(total - paid);
  if (debt > 0 && !customer) {
    throw new ApiError(400, 'Продажа в долг возможна только с указанием клиента');
  }

  const number = nextNumber('П', 'sales');
  const createdAt = nowIso();
  const info = db.prepare(
    `INSERT INTO sales (number, customer_id, user_id, subtotal, discount_total, total, cost_total,
       bonus_earned, bonus_spent, payment_method, status, paid, due_date, store_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,0,0,?,'completed',?,?,?,?,?)`
  ).run(number, customerId, session.userId, subtotal, discountItems, total,
    costTotal, payment, paid, dueDate, storeId, String(body.note || ''), createdAt);
  const saleId = Number(info.lastInsertRowid);

  const insItem = db.prepare(
    'INSERT INTO sale_items (sale_id, product_id, price, discount, final_price, cost, set_id) VALUES (?,?,?,?,?,?,?)'
  );
  const markSold = db.prepare(
    `UPDATE products SET status = 'sold', sold_at = ?, reserved_for = NULL, reserved_until = ''
      WHERE id = ?`
  );
  for (const pr of prepared) {
    insItem.run(saleId, pr.product.id, pr.price, pr.discount, pr.final, pr.product.purchase_price, pr.setId);
    markSold.run(createdAt, pr.product.id);
    // Продали чужое изделие — сразу становимся должны его владельцу.
    recordConsignmentSale(pr.product, saleId, session.userId);
  }

  // В кассу попадает только фактически полученное, остальное — долг.
  if (paid > 0) {
    db.prepare(
      `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
       VALUES ('income', 'Продажа', ?, ?, ?, ?, ?)`
    ).run(paid, `Чек ${number}`, saleId, session.userId, createdAt);
    db.prepare(
      `INSERT INTO payments (customer_id, sale_id, amount, method, note, user_id, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(customerId, saleId, paid, payment === 'installment' ? 'cash' : payment,
      opts.paymentNote || (debt > 0 ? 'Первый взнос' : 'Оплата чека'), session.userId, createdAt);
  }

  audit(session.userId, 'sale', 'sale', saleId,
    `${number} на ${money(total)}${debt > 0 ? `, в долг ${money(debt)}` : ''}`);
  return { saleId, number, total, paid, debt };
}

/*
 * Возврат позиций чека. Тоже общий для двух сценариев: обычный возврат
 * и обмен. При обмене деньги не выдаются на руки, а идут в зачёт нового
 * чека — за это отвечает holdCash: сумма к выдаче возвращается наружу,
 * но расход в кассе не записывается (его запишет вызывающая сторона
 * с правильной формулировкой).
 */
function returnItemsTx(saleId, itemIds, session, { holdCash = false } = {}) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) throw new ApiError(404, 'Продажа не найдена');
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const toReturn = items.filter(i => itemIds.includes(i.id) && !i.returned);
  if (!toReturn.length) throw new ApiError(400, 'Эти позиции уже возвращены или не найдены');

  const ts = nowIso();
  let returnedValue = 0;
  for (const it of toReturn) {
    db.prepare('UPDATE sale_items SET returned = 1, returned_at = ? WHERE id = ?').run(ts, it.id);
    db.prepare(`UPDATE products SET status = 'in_stock', sold_at = NULL, reserved_until = ''
                 WHERE id = ?`).run(it.product_id);
    // Изделие вернулось на витрину — долг перед его владельцем снимаем.
    revokeConsignmentSale(it.product_id, saleId);
    returnedValue = round2(returnedValue + it.final_price);
  }
  const left = db.prepare(
    'SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ? AND returned = 0'
  ).get(saleId).c;
  db.prepare('UPDATE sales SET status = ? WHERE id = ?')
    .run(Number(left) === 0 ? 'returned' : 'partial_return', saleId);

  // Возврат сначала гасит долг клиента и только потом возвращается деньгами:
  // если чек был не оплачен, отдавать из кассы нечего.
  const newEffective = round2(
    db.prepare('SELECT COALESCE(SUM(final_price), 0) AS s FROM sale_items WHERE sale_id = ? AND returned = 0')
      .get(saleId).s
  );
  const cashRefund = round2(Math.max(0, sale.paid - newEffective));
  const debtCut = round2(returnedValue - cashRefund);
  if (cashRefund > 0) {
    db.prepare('UPDATE sales SET paid = ? WHERE id = ?').run(newEffective, saleId);
    if (!holdCash) {
      db.prepare(
        `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
         VALUES ('expense', 'Возврат покупателю', ?, ?, ?, ?, ?)`
      ).run(cashRefund, `Возврат по чеку ${sale.number}`, saleId, session.userId, ts);
      db.prepare(
        `INSERT INTO payments (customer_id, sale_id, amount, method, note, user_id, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(sale.customer_id, saleId, -cashRefund, 'cash', `Возврат по чеку ${sale.number}`,
        session.userId, ts);
    }
  }
  return { sale, returnedValue, cashRefund, debtCut, ts };
}

const routes = [
  {
    method: 'GET', path: '/api/sales',
    handler: ({ query, session }) => {
      const cond = [];
      const args = [];
      if (query.from) { cond.push('s.created_at >= ?'); args.push(query.from); }
      if (query.to) { cond.push('s.created_at <= ?'); args.push(query.to); }
      if (query.user_id) { cond.push('s.user_id = ?'); args.push(Number(query.user_id)); }
      if (query.customer_id) { cond.push('s.customer_id = ?'); args.push(Number(query.customer_id)); }
      if (query.payment_method) { cond.push('s.payment_method = ?'); args.push(query.payment_method); }
      if (query.status) { cond.push('s.status = ?'); args.push(query.status); }
      if (query.search) {
        cond.push(`(nlower(s.number) LIKE ? OR EXISTS (
          SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = s.id AND (nlower(p.name) LIKE ? OR nlower(p.sku) LIKE ?)))`);
        const q = `%${String(query.search).toLowerCase()}%`;
        args.push(q, q, q);
      }
      if (query.store_id) { cond.push('s.store_id = ?'); args.push(Number(query.store_id)); }
      if (query.debt === '1') {
        cond.push(`(SELECT COALESCE(SUM(si.final_price),0) FROM sale_items si
                    WHERE si.sale_id = s.id AND si.returned = 0) - s.paid > 0.009`);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const limit = Math.min(Number(query.limit) || 200, 1000);
      const rows = db.prepare(
        `SELECT s.*, c.name AS customer_name, u.name AS seller_name, st.name AS store_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
           round((SELECT COALESCE(SUM(si.final_price),0) FROM sale_items si
                  WHERE si.sale_id = s.id AND si.returned = 0) - s.paid, 2) AS debt
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN stores st ON st.id = s.store_id
         ${where} ORDER BY s.created_at DESC LIMIT ?`
      ).all(...args, limit);
      const totals = db.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(s.total),0) AS sum FROM sales s ${where}`
      ).get(...args);
      if (session.role !== 'admin') rows.forEach(r => delete r.cost_total);
      return { items: rows, totals };
    },
  },
  {
    method: 'GET', path: '/api/sales/:id',
    handler: ({ params, session }) => saleDetail(Number(params.id), session.role),
  },
  {
    method: 'POST', path: '/api/sales',
    handler: ({ body, session }) => transaction(() => {
      const { saleId } = createSaleTx(body, session);
      return saleDetail(saleId, session.role);
    }),
  },
  {
    method: 'POST', path: '/api/sales/:id/return',
    handler: ({ params, body, session }) => {
      const saleId = Number(params.id);
      const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map(Number) : [];
      if (!itemIds.length) throw new ApiError(400, 'Не выбраны позиции для возврата');

      return transaction(() => {
        const { sale, returnedValue, cashRefund, debtCut } = returnItemsTx(saleId, itemIds, session);
        audit(session.userId, 'return', 'sale', saleId,
          `${sale.number}: возврат на ${money(returnedValue)}` +
          (debtCut > 0.009 ? `, списан долг ${money(debtCut)}` : '') +
          (cashRefund > 0 ? `, деньгами ${money(cashRefund)}` : ''));
        return { ...saleDetail(saleId, session.role), cash_refund: cashRefund, debt_written_off: debtCut };
      });
    },
  },
  {
    /*
     * Обмен: клиент возвращает изделия из старого чека и тут же берёт другие.
     * Одна операция вместо двух: возврат и новый чек оформляются вместе,
     * а деньги за возвращённое идут в зачёт нового — на руки выдаётся
     * или доплачивается только разница.
     *
     * Деньги в зачёте не покидают кассу, поэтому расход «возврат» и приход
     * «продажа» записываются только на фактически выданное и доплаченное.
     */
    method: 'POST', path: '/api/sales/:id/exchange',
    handler: ({ params, body, session }) => {
      const oldId = Number(params.id);
      const itemIds = Array.isArray(body.return_item_ids) ? body.return_item_ids.map(Number) : [];
      if (!itemIds.length) throw new ApiError(400, 'Не выбраны позиции для обмена');
      const newItems = Array.isArray(body.items) ? body.items : [];
      if (!newItems.length) throw new ApiError(400, 'Не выбрано, что клиент берёт взамен');

      return transaction(() => {
        // Возврат с удержанием денег: зачёт вместо выдачи на руки.
        const ret = returnItemsTx(oldId, itemIds, session, { holdCash: true });
        const credit = ret.cashRefund;

        // Считаем сумму нового чека тем же путём, что и продажа, — через
        // предварительный проход по позициям здесь не дублируем: создаём чек
        // с оплатой «зачёт + доплата», а проверку «не больше суммы» делает createSaleTx.
        const extraPaid = round2(body.extra_paid || 0);
        if (extraPaid < 0) throw new ApiError(400, 'Доплата не может быть отрицательной');

        // Сначала узнаём сумму нового чека: зачёт не может превысить её.
        let newTotal = 0;
        for (const it of newItems) {
          const p = db.prepare('SELECT retail_price FROM products WHERE id = ?').get(Number(it.product_id));
          if (!p) throw new ApiError(400, `Изделие #${it.product_id} не найдено`);
          newTotal = round2(newTotal + round2(p.retail_price) - round2(it.discount || 0));
        }
        const creditApplied = round2(Math.min(credit, newTotal));
        const cashBack = round2(credit - creditApplied);
        const paidNew = round2(Math.min(creditApplied + extraPaid, newTotal));

        const created = createSaleTx({
          customer_id: body.customer_id !== undefined ? body.customer_id : ret.sale.customer_id,
          items: newItems,
          payment_method: body.payment_method,
          paid: paidNew,
          due_date: body.due_date,
          store_id: ret.sale.store_id,
          note: String(body.note || '') || `Обмен по чеку ${ret.sale.number}`,
        }, session, {
          paymentNote: `Обмен: зачёт ${creditApplied}` + (extraPaid > 0 ? ` + доплата ${extraPaid}` : ''),
        });

        // Кассовые движения обмена — только реальные деньги.
        // Зачтённая часть кассу не трогает: расход по возврату записываем
        // лишь на сумму, выданную на руки, а приход «Продажа» уже записан
        // createSaleTx на paidNew — корректируем его до фактической доплаты.
        if (cashBack > 0) {
          db.prepare(
            `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
             VALUES ('expense', 'Возврат покупателю', ?, ?, ?, ?, ?)`
          ).run(cashBack, `Обмен по чеку ${ret.sale.number}: разница на руки`, oldId, session.userId, ret.ts);
          db.prepare(
            `INSERT INTO payments (customer_id, sale_id, amount, method, note, user_id, created_at)
             VALUES (?,?,?,?,?,?,?)`
          ).run(ret.sale.customer_id, oldId, -cashBack, 'cash',
            `Обмен: возврат разницы`, session.userId, ret.ts);
        }
        if (creditApplied > 0) {
          // Приход по новому чеку записан на «зачёт + доплата», но живых денег
          // пришло только «доплата». Компенсируем зачёт расходной записью,
          // чтобы касса за день сошлась с фактической выручкой.
          db.prepare(
            `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
             VALUES ('expense', 'Возврат покупателю', ?, ?, ?, ?, ?)`
          ).run(creditApplied, `Обмен: зачёт возврата по чеку ${ret.sale.number} в чек ${created.number}`,
            oldId, session.userId, ret.ts);
        }

        audit(session.userId, 'exchange', 'sale', oldId,
          `${ret.sale.number} → ${created.number}: зачёт ${money(creditApplied)}` +
          (extraPaid > 0 ? `, доплата ${money(extraPaid)}` : '') +
          (cashBack > 0 ? `, на руки ${money(cashBack)}` : '') +
          (created.debt > 0 ? `, долг ${money(created.debt)}` : ''));

        return {
          old: saleDetail(oldId, session.role),
          new: saleDetail(created.saleId, session.role),
          credit,
          credit_applied: creditApplied,
          extra_paid: extraPaid,
          cash_back: cashBack,
          new_debt: created.debt,
        };
      });
    },
  },
];

module.exports = { routes };
