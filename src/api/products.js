'use strict';
const { db, nowIso, round2, audit } = require('../db');
const { ApiError } = require('./util');

const PRODUCT_FIELDS = ['sku', 'barcode', 'name', 'category_id', 'metal', 'weight', 'size', 'gems',
  'gem_summary', 'purchase_price', 'retail_price', 'supplier_id', 'status', 'reserved_for',
  'location', 'description'];

function rowToProduct(r) {
  if (!r) return null;
  let gems = [];
  try { gems = JSON.parse(r.gems || '[]'); } catch { gems = []; }
  return { ...r, gems };
}

function validateProduct(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.sku !== undefined) {
    out.sku = String(body.sku || '').trim();
    if (!out.sku) throw new ApiError(400, 'Артикул обязателен');
  }
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || '').trim();
    if (!out.name) throw new ApiError(400, 'Наименование обязательно');
  }
  const toId = (v, label) => {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Некорректное значение поля «${label}»`);
    return n;
  };
  if (body.barcode !== undefined) out.barcode = String(body.barcode || '').trim();
  if (body.category_id !== undefined) out.category_id = toId(body.category_id, 'категория');
  if (body.supplier_id !== undefined) out.supplier_id = toId(body.supplier_id, 'поставщик');
  if (body.metal !== undefined) out.metal = String(body.metal || '').trim();
  if (body.size !== undefined) out.size = String(body.size || '').trim();
  if (body.location !== undefined) out.location = String(body.location || '').trim();
  if (body.description !== undefined) out.description = String(body.description || '').trim();
  if (body.gem_summary !== undefined) out.gem_summary = String(body.gem_summary || '').trim();
  if (body.weight !== undefined) {
    out.weight = Number(body.weight) || 0;
    if (out.weight < 0) throw new ApiError(400, 'Вес не может быть отрицательным');
  }
  for (const f of ['purchase_price', 'retail_price']) {
    if (body[f] !== undefined) {
      out[f] = round2(body[f]);
      if (out[f] < 0) throw new ApiError(400, 'Цена не может быть отрицательной');
    }
  }
  if (body.status !== undefined) {
    if (!['in_stock', 'reserved', 'sold', 'written_off'].includes(body.status)) {
      throw new ApiError(400, 'Недопустимый статус');
    }
    out.status = body.status;
  }
  if (body.reserved_for !== undefined) {
    out.reserved_for = toId(body.reserved_for, 'клиент резерва');
    if (out.reserved_for && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(out.reserved_for)) {
      throw new ApiError(400, 'Клиент для резерва не найден');
    }
  }
  if (body.gems !== undefined) {
    if (!Array.isArray(body.gems)) throw new ApiError(400, 'Вставки должны быть списком');
    out.gems = JSON.stringify(body.gems.map(g => ({
      type: String(g.type || '').trim(),
      carat: Number(g.carat) || 0,
      color: String(g.color || '').trim(),
      clarity: String(g.clarity || '').trim(),
      cut: String(g.cut || '').trim(),
      count: Number(g.count) || 1,
    })));
  }
  return out;
}

const routes = [
  {
    method: 'GET', path: '/api/products',
    handler: ({ query, session }) => {
      const cond = [];
      const args = [];
      if (query.search) {
        cond.push(`(nlower(p.name) LIKE ? OR nlower(p.sku) LIKE ? OR p.barcode LIKE ? OR nlower(p.gem_summary) LIKE ?)`);
        const s = `%${String(query.search).toLowerCase()}%`;
        args.push(s, s, s, s);
      }
      if (query.status) { cond.push('p.status = ?'); args.push(query.status); }
      if (query.category_id) { cond.push('p.category_id = ?'); args.push(Number(query.category_id)); }
      if (query.metal) { cond.push('p.metal = ?'); args.push(query.metal); }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const limit = Math.min(Number(query.limit) || 500, 2000);
      const offset = Number(query.offset) || 0;
      const rows = db.prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name, cu.name AS reserved_for_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN customers cu ON cu.id = p.reserved_for
         ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`
      ).all(...args, limit, offset);
      const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM products p ${where}`).get(...args);
      const items = rows.map(rowToProduct);
      // закупочные цены — только администратору
      if (session.role !== 'admin') items.forEach(p => delete p.purchase_price);
      return { items, total: Number(totalRow.c) };
    },
  },
  {
    method: 'GET', path: '/api/products/meta',
    handler: () => {
      const metals = db.prepare(`SELECT DISTINCT metal FROM products WHERE metal != '' ORDER BY metal`).all();
      const counts = db.prepare(`SELECT status, COUNT(*) AS c FROM products GROUP BY status`).all();
      return { metals: metals.map(m => m.metal), status_counts: counts };
    },
  },
  {
    method: 'GET', path: '/api/products/:id',
    handler: ({ params, session }) => {
      const p = db.prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name, cu.name AS reserved_for_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN customers cu ON cu.id = p.reserved_for
         WHERE p.id = ?`
      ).get(Number(params.id));
      if (!p) throw new ApiError(404, 'Изделие не найдено');
      const history = db.prepare(
        `SELECT si.*, s.number AS sale_number, s.created_at AS sale_date, cu.name AS customer_name
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         LEFT JOIN customers cu ON cu.id = s.customer_id
         WHERE si.product_id = ? ORDER BY s.created_at DESC`
      ).all(Number(params.id));
      const product = { ...rowToProduct(p), history };
      if (session.role !== 'admin') {
        delete product.purchase_price;
        history.forEach(h => delete h.cost);
      }
      return product;
    },
  },
  {
    method: 'POST', path: '/api/products',
    handler: ({ body, session }) => {
      const data = validateProduct(body);
      const dup = db.prepare('SELECT id FROM products WHERE sku = ?').get(data.sku);
      if (dup) throw new ApiError(400, `Артикул «${data.sku}» уже существует`);
      const fields = PRODUCT_FIELDS.filter(f => data[f] !== undefined);
      const sql = `INSERT INTO products (${fields.join(',')}, created_at) VALUES (${fields.map(() => '?').join(',')}, ?)`;
      const info = db.prepare(sql).run(...fields.map(f => data[f]), nowIso());
      audit(session.userId, 'create', 'product', Number(info.lastInsertRowid), `${data.sku} ${data.name}`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/products/:id',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Изделие не найдено');
      const data = validateProduct(body, { partial: true });
      if (data.sku && data.sku !== existing.sku) {
        const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(data.sku, id);
        if (dup) throw new ApiError(400, `Артикул «${data.sku}» уже существует`);
      }
      // статусы «продано» ставит только продажа, снимает — только возврат по чеку
      if (data.status !== undefined && data.status !== existing.status) {
        if (existing.status === 'sold') {
          throw new ApiError(400, 'Изделие продано — вернуть его на витрину можно только возвратом по чеку.');
        }
        if (data.status === 'sold') {
          throw new ApiError(400, 'Статус «Продано» ставится только оформлением продажи.');
        }
      }
      const fields = PRODUCT_FIELDS.filter(f => data[f] !== undefined);
      if (!fields.length) return { ok: true };
      const sql = `UPDATE products SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...fields.map(f => data[f]), id);
      if (data.status && data.status !== 'reserved') {
        db.prepare('UPDATE products SET reserved_for = NULL WHERE id = ? AND status != ?').run(id, 'reserved');
      }
      audit(session.userId, 'update', 'product', id, existing.sku);
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/api/products/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Изделие не найдено');
      const usedInSale = db.prepare('SELECT 1 FROM sale_items WHERE product_id = ? LIMIT 1').get(id);
      if (usedInSale) {
        throw new ApiError(400, 'Изделие участвует в продажах — удалить нельзя. Используйте статус «Списано».');
      }
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'product', id, `${existing.sku} ${existing.name}`);
      return { ok: true };
    },
  },
];

module.exports = { routes };
