'use strict';
const { db, nowIso, round2, audit, nextNumber, transaction, getSetting } = require('../db');
const { ApiError } = require('./util');

function saleDetail(id, role = 'admin') {
  const s = db.prepare(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS seller_name
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(id);
  if (!s) throw new ApiError(404, 'Продажа не найдена');
  const items = db.prepare(
    `SELECT si.*, p.sku, p.name, p.metal, p.weight, p.size, p.gem_summary
     FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?`
  ).all(id);
  // себестоимость — только администратору
  if (role !== 'admin') {
    delete s.cost_total;
    for (const it of items) delete it.cost;
  }
  return { ...s, items };
}

// после продажи пересматриваем сегмент клиента (только повышение);
// считаем по фактически оплаченным (не возвращённым) позициям
function maybeUpgradeSegment(customerId) {
  if (!customerId) return;
  const vipThreshold = Number(getSetting('vip_threshold', '500000')) || 500000;
  const st = db.prepare(
    `SELECT COUNT(DISTINCT s.id) AS purchases, COALESCE(SUM(si.final_price),0) AS spent
     FROM sales s JOIN sale_items si ON si.sale_id = s.id
     WHERE s.customer_id = ? AND si.returned = 0`
  ).get(customerId);
  const cur = db.prepare('SELECT segment FROM customers WHERE id = ?').get(customerId);
  if (!cur) return;
  let target = cur.segment;
  if (st.spent >= vipThreshold) target = 'vip';
  else if (st.purchases >= 2 && cur.segment === 'new') target = 'regular';
  if (target !== cur.segment && !(cur.segment === 'vip')) {
    db.prepare('UPDATE customers SET segment = ? WHERE id = ?').run(target, customerId);
  }
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
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const limit = Math.min(Number(query.limit) || 200, 1000);
      const rows = db.prepare(
        `SELECT s.*, c.name AS customer_name, u.name AS seller_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
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
    handler: ({ body, session }) => {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) throw new ApiError(400, 'В чеке нет ни одной позиции');
      const customerId = body.customer_id ? Number(body.customer_id) : null;
      const payment = ['cash', 'card', 'transfer', 'installment'].includes(body.payment_method)
        ? body.payment_method : 'cash';
      let bonusSpent = round2(body.bonus_spent || 0);
      if (bonusSpent < 0) throw new ApiError(400, 'Списание бонусов не может быть отрицательным');

      return transaction(() => {
        let customer = null;
        if (customerId) {
          customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
          if (!customer) throw new ApiError(400, 'Клиент не найден');
        }
        if (bonusSpent > 0 && !customer) throw new ApiError(400, 'Бонусы можно списать только при выбранном клиенте');
        if (customer && bonusSpent > customer.bonus_points) {
          throw new ApiError(400, `У клиента только ${customer.bonus_points} бонусов`);
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
          prepared.push({ product: p, price, discount, final: round2(price - discount) });
        }

        const afterItems = round2(subtotal - discountItems);
        if (bonusSpent > afterItems) throw new ApiError(400, 'Списание бонусов больше суммы чека');

        // Списанные бонусы распределяем по позициям как скидку — тогда
        // final_price позиций равен фактически полученным деньгам,
        // и возвраты/касса/отчёты сходятся копейка в копейку.
        if (bonusSpent > 0) {
          let remaining = bonusSpent;
          prepared.forEach((pr, idx) => {
            const share = idx === prepared.length - 1
              ? remaining
              : Math.min(round2(bonusSpent * pr.final / (afterItems || 1)), remaining);
            pr.discount = round2(pr.discount + share);
            pr.final = round2(pr.price - pr.discount);
            remaining = round2(remaining - share);
          });
        }
        const total = round2(prepared.reduce((s, pr) => s + pr.final, 0));
        const bonusPercent = Number(getSetting('bonus_percent', '3')) || 0;
        const bonusEarned = customer ? round2(total * bonusPercent / 100) : 0;

        const number = nextNumber('П', 'sales');
        const createdAt = nowIso();
        const info = db.prepare(
          `INSERT INTO sales (number, customer_id, user_id, subtotal, discount_total, total, cost_total,
             bonus_earned, bonus_spent, payment_method, status, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?)`
        ).run(number, customerId, session.userId, subtotal, round2(discountItems + bonusSpent), total,
          costTotal, bonusEarned, bonusSpent, payment, String(body.note || ''), createdAt);
        const saleId = Number(info.lastInsertRowid);

        const insItem = db.prepare(
          'INSERT INTO sale_items (sale_id, product_id, price, discount, final_price, cost) VALUES (?,?,?,?,?,?)'
        );
        const markSold = db.prepare(
          `UPDATE products SET status = 'sold', sold_at = ?, reserved_for = NULL WHERE id = ?`
        );
        for (const pr of prepared) {
          insItem.run(saleId, pr.product.id, pr.price, pr.discount, pr.final, pr.product.purchase_price);
          markSold.run(createdAt, pr.product.id);
        }

        if (customer) {
          db.prepare('UPDATE customers SET bonus_points = round(bonus_points - ? + ?, 2) WHERE id = ?')
            .run(bonusSpent, bonusEarned, customerId);
        }

        db.prepare(
          `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
           VALUES ('income', 'Продажа', ?, ?, ?, ?, ?)`
        ).run(total, `Чек ${number}`, saleId, session.userId, createdAt);

        maybeUpgradeSegment(customerId);
        audit(session.userId, 'sale', 'sale', saleId, `${number} на ${total}`);
        return saleDetail(saleId, session.role);
      });
    },
  },
  {
    method: 'POST', path: '/api/sales/:id/return',
    handler: ({ params, body, session }) => {
      const saleId = Number(params.id);
      const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map(Number) : [];
      if (!itemIds.length) throw new ApiError(400, 'Не выбраны позиции для возврата');

      return transaction(() => {
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
        if (!sale) throw new ApiError(404, 'Продажа не найдена');
        const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
        const toReturn = items.filter(i => itemIds.includes(i.id) && !i.returned);
        if (!toReturn.length) throw new ApiError(400, 'Эти позиции уже возвращены или не найдены');

        const ts = nowIso();
        let refund = 0;
        for (const it of toReturn) {
          db.prepare('UPDATE sale_items SET returned = 1, returned_at = ? WHERE id = ?').run(ts, it.id);
          db.prepare(`UPDATE products SET status = 'in_stock', sold_at = NULL WHERE id = ?`).run(it.product_id);
          refund = round2(refund + it.final_price);
        }
        // бонусы: начисленные снимаем, списанные возвращаем — пропорционально доле возврата
        // (final_price позиций уже нетто бонусов, поэтому база у долей общая — sale.total)
        if (sale.customer_id && (sale.bonus_earned > 0 || sale.bonus_spent > 0)) {
          const share = Math.min(refund / Math.max(sale.total, 0.01), 1);
          const earnedBack = round2(sale.bonus_earned * share);
          const spentBack = round2(sale.bonus_spent * share);
          db.prepare('UPDATE customers SET bonus_points = max(0, round(bonus_points - ? + ?, 2)) WHERE id = ?')
            .run(earnedBack, spentBack, sale.customer_id);
        }
        const left = db.prepare(
          'SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ? AND returned = 0'
        ).get(saleId).c;
        const newStatus = Number(left) === 0 ? 'returned' : 'partial_return';
        db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(newStatus, saleId);

        db.prepare(
          `INSERT INTO finance_ops (type, category, amount, note, sale_id, user_id, created_at)
           VALUES ('expense', 'Возврат покупателю', ?, ?, ?, ?, ?)`
        ).run(refund, `Возврат по чеку ${sale.number}`, saleId, session.userId, ts);

        audit(session.userId, 'return', 'sale', saleId, `${sale.number}: возврат ${refund}`);
        return saleDetail(saleId, session.role);
      });
    },
  },
];

module.exports = { routes };
