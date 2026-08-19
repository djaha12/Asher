'use strict';
const { db, nowIso, round2, audit } = require('../db');
const { ApiError } = require('./util');

const FIELDS = ['name', 'phone', 'email', 'birthday', 'anniversary', 'discount',
  'ring_size', 'preferences', 'notes'];

// «2020-13-45» не пройдёт: проверяем, что дата существует в календаре
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validateCustomer(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || '').trim();
    if (!out.name) throw new ApiError(400, 'Имя клиента обязательно');
  }
  for (const f of ['phone', 'email', 'birthday', 'anniversary', 'ring_size', 'preferences', 'notes']) {
    if (body[f] !== undefined) out[f] = String(body[f] || '').trim();
  }
  for (const f of ['birthday', 'anniversary']) {
    if (out[f] && !isValidDate(out[f])) {
      throw new ApiError(400, 'Дата должна быть реальной датой в формате ГГГГ-ММ-ДД');
    }
  }
  if (body.discount !== undefined) {
    out.discount = round2(body.discount);
    if (out.discount < 0 || out.discount > 100) throw new ApiError(400, 'Скидка должна быть от 0 до 100%');
  }
  return out;
}

// статистика по фактически оплаченным позициям (возвраты не считаются)
const STATS_SQL = `
  SELECT COUNT(DISTINCT s.id) AS purchases, COALESCE(SUM(si.final_price), 0) AS total_spent,
         MAX(s.created_at) AS last_purchase
  FROM sales s JOIN sale_items si ON si.sale_id = s.id
  WHERE s.customer_id = ? AND si.returned = 0`;

const routes = [
  {
    method: 'GET', path: '/api/customers',
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.search) {
        cond.push('(nlower(c.name) LIKE ? OR c.phone LIKE ? OR nlower(c.email) LIKE ?)');
        const s = `%${String(query.search).toLowerCase()}%`;
        args.push(s, s, s);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT c.*,
           (SELECT COUNT(DISTINCT s.id) FROM sales s JOIN sale_items si ON si.sale_id = s.id
             WHERE s.customer_id = c.id AND si.returned = 0) AS purchases,
           (SELECT COALESCE(SUM(si.final_price), 0) FROM sales s JOIN sale_items si ON si.sale_id = s.id
             WHERE s.customer_id = c.id AND si.returned = 0) AS total_spent
         FROM customers c ${where} ORDER BY total_spent DESC, c.name LIMIT 1000`
      ).all(...args);
      return { items: rows };
    },
  },
  {
    method: 'GET', path: '/api/customers/birthdays',
    handler: ({ query }) => {
      // ближайшие дни рождения и годовщины в окне N дней (по локальной дате клиента)
      const days = Math.min(Number(query.days) || 30, 366);
      const today = query.today && /^\d{4}-\d{2}-\d{2}$/.test(query.today)
        ? query.today : new Date().toISOString().slice(0, 10);
      const rows = db.prepare(
        `SELECT id, name, phone, birthday, anniversary FROM customers
         WHERE birthday != '' OR anniversary != ''`
      ).all();
      const base = new Date(today + 'T00:00:00Z');
      const upcoming = [];
      for (const r of rows) {
        for (const [kind, dateStr] of [['birthday', r.birthday], ['anniversary', r.anniversary]]) {
          if (!dateStr) continue;
          const [, m, d] = dateStr.split('-').map(Number);
          let next = new Date(Date.UTC(base.getUTCFullYear(), m - 1, d));
          if (next < base) next = new Date(Date.UTC(base.getUTCFullYear() + 1, m - 1, d));
          const diff = Math.round((next - base) / 86400000);
          if (diff <= days) {
            upcoming.push({ id: r.id, name: r.name, phone: r.phone,
              kind, date: next.toISOString().slice(0, 10), in_days: diff });
          }
        }
      }
      upcoming.sort((a, b) => a.in_days - b.in_days);
      return { items: upcoming };
    },
  },
  {
    method: 'GET', path: '/api/customers/:id',
    handler: ({ params }) => {
      const id = Number(params.id);
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!c) throw new ApiError(404, 'Клиент не найден');
      const stats = db.prepare(STATS_SQL).get(id);
      const sales = db.prepare(
        `SELECT s.id, s.number, s.total, s.status, s.payment_method, s.created_at, u.name AS seller_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
         FROM sales s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 200`
      ).all(id);
      const items = db.prepare(
        `SELECT si.final_price, si.returned, s.created_at, p.name, p.sku, p.metal, p.gem_summary
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 200`
      ).all(id);
      const orders = db.prepare(
        `SELECT id, number, type, status, final_price, estimate, accepted_at FROM service_orders
         WHERE customer_id = ? ORDER BY accepted_at DESC LIMIT 100`
      ).all(id);
      const reserved = db.prepare(
        `SELECT id, sku, name, retail_price FROM products WHERE reserved_for = ? AND status = 'reserved'`
      ).all(id);
      return { ...c, stats, sales, items, orders, reserved };
    },
  },
  {
    method: 'POST', path: '/api/customers',
    handler: ({ body, session }) => {
      const data = validateCustomer(body);
      const fields = FIELDS.filter(f => data[f] !== undefined);
      const info = db.prepare(
        `INSERT INTO customers (${fields.join(',')}, created_at) VALUES (${fields.map(() => '?').join(',')}, ?)`
      ).run(...fields.map(f => data[f]), nowIso());
      audit(session.userId, 'create', 'customer', Number(info.lastInsertRowid), data.name);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/customers/:id',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Клиент не найден');
      const data = validateCustomer(body, { partial: true });
      const fields = FIELDS.filter(f => data[f] !== undefined);
      if (!fields.length) return { ok: true };
      db.prepare(`UPDATE customers SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...fields.map(f => data[f]), id);
      audit(session.userId, 'update', 'customer', id, existing.name);
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/api/customers/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Клиент не найден');
      const hasSales = db.prepare('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(id);
      if (hasSales) throw new ApiError(400, 'У клиента есть история покупок — удалить нельзя.');
      const hasOrders = db.prepare('SELECT 1 FROM service_orders WHERE customer_id = ? LIMIT 1').get(id);
      if (hasOrders) throw new ApiError(400, 'У клиента есть заказы или ремонт — удалить нельзя.');
      // резервы за клиентом освобождаем, чтобы изделия не зависли
      db.prepare(`UPDATE products SET status = 'in_stock', reserved_for = NULL, reserved_until = ''
                  WHERE reserved_for = ? AND status = 'reserved'`).run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'customer', id, existing.name);
      return { ok: true };
    },
  },
];

module.exports = { routes };
