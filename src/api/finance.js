'use strict';
const { db, nowIso, round2, audit } = require('../db');
const { ApiError } = require('./util');

const DEFAULT_EXPENSE_CATS = ['Закупка товара', 'Аренда', 'Зарплата', 'Налоги', 'Коммунальные услуги',
  'Реклама', 'Охрана', 'Банковские услуги', 'Прочие расходы'];
const DEFAULT_INCOME_CATS = ['Продажа', 'Оплата заказа', 'Прочие доходы'];

const routes = [
  {
    method: 'GET', path: '/api/finance', admin: true,
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.from) { cond.push('f.created_at >= ?'); args.push(query.from); }
      if (query.to) { cond.push('f.created_at <= ?'); args.push(query.to); }
      if (query.type) { cond.push('f.type = ?'); args.push(query.type); }
      if (query.category) { cond.push('f.category = ?'); args.push(query.category); }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT f.*, u.name AS user_name, s.number AS sale_number, o.number AS order_number
         FROM finance_ops f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN sales s ON s.id = f.sale_id
         LEFT JOIN service_orders o ON o.id = f.order_id
         ${where} ORDER BY f.created_at DESC LIMIT 1000`
      ).all(...args);
      const totals = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
         FROM finance_ops f ${where}`
      ).get(...args);
      return { items: rows, totals: { ...totals, profit: round2(totals.income - totals.expense) } };
    },
  },
  {
    method: 'GET', path: '/api/finance/categories', admin: true,
    handler: () => {
      const used = db.prepare('SELECT DISTINCT type, category FROM finance_ops').all();
      const expense = new Set(DEFAULT_EXPENSE_CATS);
      const income = new Set(DEFAULT_INCOME_CATS);
      for (const u of used) (u.type === 'expense' ? expense : income).add(u.category);
      return { expense: [...expense], income: [...income] };
    },
  },
  {
    method: 'POST', path: '/api/finance', admin: true,
    handler: ({ body, session }) => {
      const type = body.type === 'expense' ? 'expense' : 'income';
      const category = String(body.category || '').trim();
      if (!category) throw new ApiError(400, 'Укажите категорию');
      const amount = round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма должна быть больше нуля');
      const info = db.prepare(
        `INSERT INTO finance_ops (type, category, amount, note, user_id, created_at) VALUES (?,?,?,?,?,?)`
      ).run(type, category, amount, String(body.note || ''), session.userId, nowIso());
      audit(session.userId, 'create', 'finance', Number(info.lastInsertRowid),
        `${type === 'income' ? 'Приход' : 'Расход'} ${category}: ${amount}`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'DELETE', path: '/api/finance/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const op = db.prepare('SELECT * FROM finance_ops WHERE id = ?').get(id);
      if (!op) throw new ApiError(404, 'Операция не найдена');
      if (op.sale_id || op.order_id) {
        throw new ApiError(400, 'Операция создана продажей или заказом — удалить можно только через возврат.');
      }
      db.prepare('DELETE FROM finance_ops WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'finance', id, `${op.category}: ${op.amount}`);
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/api/finance/pnl', admin: true,
    handler: ({ query }) => {
      // P&L по месяцам за год: выручка, себестоимость, валовая прибыль, расходы, чистая прибыль
      const year = String(Number(query.year) || new Date().getFullYear());
      const tz = String(Number(query.tz) || 0); // смещение локального времени в минутах
      const mod = `${tz >= 0 ? '+' : ''}${tz} minutes`;
      const months = {};
      for (let m = 1; m <= 12; m++) {
        months[`${year}-${String(m).padStart(2, '0')}`] =
          { revenue: 0, returns: 0, cogs: 0, expenses: 0, other_income: 0 };
      }
      const saleRows = db.prepare(
        `SELECT strftime('%Y-%m', si.rowid_ts) AS ym,
                SUM(CASE WHEN si.kind = 'sale' THEN si.amount ELSE 0 END) AS revenue,
                SUM(CASE WHEN si.kind = 'sale' THEN si.cost ELSE 0 END) AS cogs,
                SUM(CASE WHEN si.kind = 'return' THEN si.amount ELSE 0 END) AS returns,
                SUM(CASE WHEN si.kind = 'return' THEN si.cost ELSE 0 END) AS cogs_back
         FROM (
           SELECT datetime(s.created_at, '${mod}') AS rowid_ts, si.final_price AS amount, si.cost AS cost, 'sale' AS kind
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           UNION ALL
           SELECT datetime(si.returned_at, '${mod}'), si.final_price, si.cost, 'return'
           FROM sale_items si WHERE si.returned = 1 AND si.returned_at IS NOT NULL
         ) si
         WHERE strftime('%Y', si.rowid_ts) = ? GROUP BY ym`
      ).all(year);
      for (const r of saleRows) {
        if (!months[r.ym]) continue;
        months[r.ym].revenue = round2(r.revenue || 0);
        months[r.ym].returns = round2(r.returns || 0);
        months[r.ym].cogs = round2((r.cogs || 0) - (r.cogs_back || 0));
      }
      const opRows = db.prepare(
        `SELECT strftime('%Y-%m', datetime(created_at, '${mod}')) AS ym, type, category, SUM(amount) AS sum
         FROM finance_ops
         WHERE strftime('%Y', datetime(created_at, '${mod}')) = ?
         GROUP BY ym, type, category`
      ).all(year);
      const expenseByCat = {};
      // «Возврат покупателю» уже учтён в returns, «Закупка товара» — в себестоимости
      // проданного (COGS): включать их в расходы значило бы посчитать дважды.
      const EXCLUDED_EXPENSES = ['Возврат покупателю', 'Закупка товара'];
      for (const r of opRows) {
        if (!months[r.ym]) continue;
        if (r.type === 'expense' && !EXCLUDED_EXPENSES.includes(r.category)) {
          months[r.ym].expenses = round2(months[r.ym].expenses + r.sum);
          expenseByCat[r.category] = round2((expenseByCat[r.category] || 0) + r.sum);
        }
        if (r.type === 'income' && r.category !== 'Продажа') {
          months[r.ym].other_income = round2(months[r.ym].other_income + r.sum);
        }
      }
      const result = Object.entries(months).map(([ym, m]) => {
        const netRevenue = round2(m.revenue - m.returns);
        const gross = round2(netRevenue - m.cogs);
        return { month: ym, revenue: netRevenue, cogs: m.cogs, gross_profit: gross,
          other_income: m.other_income, expenses: m.expenses,
          net_profit: round2(gross + m.other_income - m.expenses) };
      });
      return { year: Number(year), months: result, expense_by_category: expenseByCat };
    },
  },
];

module.exports = { routes };
