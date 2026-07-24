'use strict';
const { db, round2, getSetting } = require('../db');

function tzMod(query) {
  const tz = Number(query.tz) || 0;
  return `${tz >= 0 ? '+' : ''}${tz} minutes`;
}

function rangeCond(query, col = 's.created_at') {
  const cond = [];
  const args = [];
  if (query.from) { cond.push(`${col} >= ?`); args.push(query.from); }
  if (query.to) { cond.push(`${col} <= ?`); args.push(query.to); }
  return { cond, args };
}

// продажи за период: чистая выручка (минус возвраты), себестоимость, кол-во
function periodStats(from, to) {
  const s = db.prepare(
    `SELECT COUNT(DISTINCT s.id) AS sales_count,
            COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.final_price END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.cost END), 0) AS cogs,
            COALESCE(SUM(CASE WHEN si.returned = 0 THEN 1 END), 0) AS items_sold,
            COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.discount END), 0) AS discounts,
            COALESCE(SUM(CASE WHEN si.returned = 1 THEN si.final_price END), 0) AS returns
     FROM sales s JOIN sale_items si ON si.sale_id = s.id
     WHERE s.created_at >= ? AND s.created_at <= ?`
  ).get(from, to);
  const revenue = round2(s.revenue);
  const profit = round2(revenue - s.cogs);
  const avg = s.sales_count ? round2(revenue / s.sales_count) : 0;
  return { sales_count: Number(s.sales_count), revenue, cogs: round2(s.cogs), profit,
    items_sold: Number(s.items_sold), discounts: round2(s.discounts),
    returns: round2(s.returns), avg_check: avg };
}

const routes = [
  {
    method: 'GET', path: '/api/dashboard',
    handler: ({ query, session }) => {
      const now = new Date();
      const tz = Number(query.tz) || 0;
      const local = new Date(now.getTime() + tz * 60000);
      const localDate = local.toISOString().slice(0, 10);
      const dayStartUtc = new Date(new Date(localDate + 'T00:00:00Z').getTime() - tz * 60000).toISOString();
      const monthStartLocal = localDate.slice(0, 7) + '-01';
      const monthStartUtc = new Date(new Date(monthStartLocal + 'T00:00:00Z').getTime() - tz * 60000).toISOString();
      const nowIso = now.toISOString();

      const today = periodStats(dayStartUtc, nowIso);
      const month = periodStats(monthStartUtc, nowIso);

      const stock = db.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(retail_price),0) AS retail, COALESCE(SUM(purchase_price),0) AS cost,
                COALESCE(SUM(weight),0) AS weight
         FROM products WHERE status IN ('in_stock','reserved')`
      ).get();
      // Склад в граммах по металлам — для ювелира это такой же понятный
      // показатель, как деньги: сколько золота лежит в витрине.
      const stockByMetal = db.prepare(
        `SELECT CASE WHEN metal = '' THEN 'Без металла' ELSE metal END AS metal,
                COUNT(*) AS cnt, COALESCE(SUM(weight),0) AS weight, COALESCE(SUM(retail_price),0) AS retail
         FROM products WHERE status IN ('in_stock','reserved')
         GROUP BY metal ORDER BY weight DESC`
      ).all();
      const reserved = db.prepare(`SELECT COUNT(*) AS cnt FROM products WHERE status = 'reserved'`).get();
      const customers = db.prepare('SELECT COUNT(*) AS cnt FROM customers').get();
      const activeOrders = db.prepare(
        `SELECT COUNT(*) AS cnt FROM service_orders WHERE status IN ('accepted','in_progress')`
      ).get();
      const readyOrders = db.prepare(`SELECT COUNT(*) AS cnt FROM service_orders WHERE status = 'ready'`).get();

      // выручка по дням за последние 14 дней (в локальном времени)
      const mod = tzMod(query);
      const since = new Date(new Date(localDate + 'T00:00:00Z').getTime() - tz * 60000 - 13 * 86400000).toISOString();
      const seriesRows = db.prepare(
        `SELECT date(datetime(s.created_at, '${mod}')) AS d,
                COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.final_price END), 0) AS revenue
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
         WHERE s.created_at >= ? GROUP BY d ORDER BY d`
      ).all(since);
      const series = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(new Date(localDate + 'T00:00:00Z').getTime() - i * 86400000).toISOString().slice(0, 10);
        const row = seriesRows.find(r => r.d === d);
        series.push({ date: d, revenue: round2(row ? row.revenue : 0) });
      }

      const recentSales = db.prepare(
        `SELECT s.id, s.number, s.total, s.created_at, s.status, c.name AS customer_name, u.name AS seller_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.created_at DESC LIMIT 6`
      ).all();

      // Долги — на главной, чтобы владелец видел их каждое утро, не заходя в раздел.
      const debtRows = db.prepare(
        `SELECT s.customer_id, c.name AS customer_name, c.phone AS customer_phone, s.due_date,
                round((SELECT COALESCE(SUM(si.final_price),0) FROM sale_items si
                       WHERE si.sale_id = s.id AND si.returned = 0) - s.paid, 2) AS debt
         FROM sales s JOIN customers c ON c.id = s.customer_id
         WHERE (SELECT COALESCE(SUM(si.final_price),0) FROM sale_items si
                WHERE si.sale_id = s.id AND si.returned = 0) - s.paid > 0.009`
      ).all();
      const orderDebtRows = db.prepare(
        `SELECT o.customer_id, c.name AS customer_name, c.phone AS customer_phone, o.due_date,
                round((CASE WHEN o.final_price > 0 THEN o.final_price ELSE o.estimate END) - o.paid, 2) AS debt
         FROM service_orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.status = 'delivered'
           AND round((CASE WHEN o.final_price > 0 THEN o.final_price ELSE o.estimate END) - o.paid, 2) > 0.009`
      ).all();
      const allDebts = [...debtRows, ...orderDebtRows];
      const byDebtor = new Map();
      for (const r of allDebts) {
        const cur = byDebtor.get(r.customer_id) ||
          { customer_id: r.customer_id, name: r.customer_name, phone: r.customer_phone, debt: 0, overdue: false };
        cur.debt = round2(cur.debt + r.debt);
        if (r.due_date && r.due_date < localDate) cur.overdue = true;
        byDebtor.set(r.customer_id, cur);
      }
      const topDebtors = [...byDebtor.values()].sort((a, b) => b.debt - a.debt).slice(0, 6);
      const debts = {
        customers_owe: round2(allDebts.reduce((s, r) => s + r.debt, 0)),
        overdue: round2(allDebts.filter(r => r.due_date && r.due_date < localDate)
          .reduce((s, r) => s + r.debt, 0)),
        debtors_count: byDebtor.size,
        top: topDebtors,
      };

      const result = {
        today, month,
        stock: {
          count: Number(stock.cnt), retail_value: round2(stock.retail), cost_value: round2(stock.cost),
          weight: round2(stock.weight), by_metal: stockByMetal.map(m => ({
            ...m, weight: round2(m.weight), retail: round2(m.retail),
          })),
        },
        reserved: Number(reserved.cnt),
        customers: Number(customers.cnt),
        orders: { active: Number(activeOrders.cnt), ready: Number(readyOrders.cnt) },
        debts,
        revenue_14d: series,
        recent_sales: recentSales,
        store_name: getSetting('store_name'),
      };
      // прибыль, себестоимость и оценка склада — только администратору
      if (session.role !== 'admin') {
        for (const p of [result.today, result.month]) { delete p.profit; delete p.cogs; }
        delete result.stock.cost_value;
        delete result.stock.retail_value;
        result.stock.by_metal.forEach(m => delete m.retail);
      } else {
        // Сколько должны мы — цифра для владельца.
        const we = db.prepare(
          `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN -amount ELSE amount END), 0) AS balance
           FROM supplier_ops`
        ).get();
        result.debts.we_owe = round2(Math.max(0, we.balance));
      }
      return result;
    },
  },
  {
    method: 'GET', path: '/api/analytics/summary', admin: true,
    handler: ({ query }) => periodStats(query.from || '0000', query.to || '9999'),
  },
  {
    method: 'GET', path: '/api/analytics/revenue', admin: true,
    handler: ({ query }) => {
      const mod = tzMod(query);
      const fmt = query.group === 'month' ? '%Y-%m' : '%Y-%m-%d';
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT strftime('${fmt}', datetime(s.created_at, '${mod}')) AS period,
                COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.final_price END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN si.returned = 0 THEN si.final_price - si.cost END), 0) AS profit,
                COUNT(DISTINCT s.id) AS sales_count
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
         ${where} GROUP BY period ORDER BY period`
      ).all(...args);
      return { items: rows.map(r => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/by-category', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT COALESCE(c.name, 'Без категории') AS name,
                COUNT(*) AS items_sold,
                COALESCE(SUM(si.final_price), 0) AS revenue,
                COALESCE(SUM(si.final_price - si.cost), 0) AS profit
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN products p ON p.id = si.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE si.returned = 0 ${where}
         GROUP BY c.id ORDER BY revenue DESC`
      ).all(...args);
      return { items: rows.map(r => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/by-metal', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT COALESCE(NULLIF(p.metal, ''), 'Не указан') AS name,
                COUNT(*) AS items_sold,
                COALESCE(SUM(si.final_price), 0) AS revenue
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE si.returned = 0 ${where}
         GROUP BY COALESCE(NULLIF(p.metal, ''), 'Не указан') ORDER BY revenue DESC`
      ).all(...args);
      return { items: rows.map(r => ({ ...r, revenue: round2(r.revenue) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/top-products', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT p.id, p.sku, p.name, p.metal, si.final_price AS price, si.final_price - si.cost AS profit,
                s.created_at AS sold_at
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE si.returned = 0 ${where}
         ORDER BY si.final_price DESC LIMIT ?`
      ).all(...args, Math.min(Number(query.limit) || 10, 50));
      return { items: rows.map(r => ({ ...r, price: round2(r.price), profit: round2(r.profit) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/top-customers', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT c.id, c.name, c.phone, c.segment,
                COUNT(DISTINCT s.id) AS purchases,
                COALESCE(SUM(si.final_price), 0) AS spent
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN customers c ON c.id = s.customer_id
         WHERE si.returned = 0 ${where}
         GROUP BY c.id ORDER BY spent DESC LIMIT ?`
      ).all(...args, Math.min(Number(query.limit) || 10, 50));
      return { items: rows.map(r => ({ ...r, spent: round2(r.spent) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/by-seller', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT COALESCE(u.name, '—') AS name,
                COUNT(DISTINCT s.id) AS sales_count,
                COALESCE(SUM(si.final_price), 0) AS revenue,
                COALESCE(SUM(si.final_price - si.cost), 0) AS profit
         FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN users u ON u.id = s.user_id
         WHERE si.returned = 0 ${where}
         GROUP BY s.user_id ORDER BY revenue DESC`
      ).all(...args);
      return { items: rows.map(r => ({ ...r, revenue: round2(r.revenue), profit: round2(r.profit) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/by-payment', admin: true,
    handler: ({ query }) => {
      const { cond, args } = rangeCond(query);
      const where = cond.length ? 'AND ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT s.payment_method AS name, COUNT(DISTINCT s.id) AS sales_count,
                COALESCE(SUM(si.final_price), 0) AS revenue
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.returned = 0 ${where}
         GROUP BY s.payment_method ORDER BY revenue DESC`
      ).all(...args);
      return { items: rows.map(r => ({ ...r, revenue: round2(r.revenue) })) };
    },
  },
  {
    method: 'GET', path: '/api/analytics/stock', admin: true,
    handler: () => {
      const byCategory = db.prepare(
        `SELECT COALESCE(c.name, 'Без категории') AS name, COUNT(*) AS cnt,
                COALESCE(SUM(p.purchase_price), 0) AS cost, COALESCE(SUM(p.retail_price), 0) AS retail
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.status IN ('in_stock','reserved')
         GROUP BY c.id ORDER BY retail DESC`
      ).all();
      const byMetal = db.prepare(
        `SELECT COALESCE(NULLIF(metal, ''), 'Не указан') AS name, COUNT(*) AS cnt,
                COALESCE(SUM(weight), 0) AS weight, COALESCE(SUM(retail_price), 0) AS retail
         FROM products WHERE status IN ('in_stock','reserved')
         GROUP BY COALESCE(NULLIF(metal, ''), 'Не указан') ORDER BY retail DESC`
      ).all();
      const stale = db.prepare(
        `SELECT id, sku, name, metal, retail_price, created_at FROM products
         WHERE status = 'in_stock' ORDER BY created_at ASC LIMIT 10`
      ).all();
      return {
        by_category: byCategory.map(r => ({ ...r, cost: round2(r.cost), retail: round2(r.retail) })),
        by_metal: byMetal.map(r => ({ ...r, weight: round2(r.weight), retail: round2(r.retail) })),
        stale_items: stale,
      };
    },
  },
];

module.exports = { routes };
