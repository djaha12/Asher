'use strict';
/*
 * Точки продаж (магазины) и перемещение изделий между ними.
 * Точка всегда есть хотя бы одна — удалить последнюю нельзя.
 */
const { db, nowIso, audit, transaction, видитВсё } = require('../db');
const { ApiError } = require('./util');

function storeStats() {
  return db.prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.status IN ('in_stock','reserved')) AS in_stock,
       (SELECT COALESCE(SUM(p.retail_price), 0) FROM products p
          WHERE p.store_id = s.id AND p.status IN ('in_stock','reserved')) AS stock_retail,
       (SELECT COALESCE(SUM(p.purchase_price), 0) FROM products p
          WHERE p.store_id = s.id AND p.status IN ('in_stock','reserved')) AS stock_cost,
       (SELECT COALESCE(SUM(p.weight), 0) FROM products p
          WHERE p.store_id = s.id AND p.status IN ('in_stock','reserved')) AS stock_weight
     FROM stores s ORDER BY s.is_default DESC, s.sort, s.id`
  ).all();
}

function requireStore(id) {
  const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!s) throw new ApiError(404, 'Точка продаж не найдена');
  return s;
}

const routes = [
  {
    method: 'GET', path: '/api/stores',
    handler: ({ session }) => {
      const items = storeStats();
      if (!видитВсё(session.role)) items.forEach(s => delete s.stock_cost);
      return { items };
    },
  },

  {
    method: 'POST', path: '/api/stores', admin: true,
    handler: ({ body, session }) => {
      const name = String(body.name || '').trim();
      if (!name) throw new ApiError(400, 'Название точки обязательно');
      const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM stores').get().m;
      const info = db.prepare('INSERT INTO stores (name, address, phone, is_default, sort) VALUES (?,?,?,0,?)')
        .run(name, String(body.address || '').trim(), String(body.phone || '').trim(), Number(max) + 1);
      audit(session.userId, 'create', 'store', Number(info.lastInsertRowid), name);
      return { id: Number(info.lastInsertRowid) };
    },
  },

  {
    method: 'PUT', path: '/api/stores/:id', admin: true,
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const s = requireStore(id);
      const name = body.name !== undefined ? String(body.name).trim() : s.name;
      if (!name) throw new ApiError(400, 'Название точки обязательно');
      db.prepare('UPDATE stores SET name = ?, address = ?, phone = ? WHERE id = ?').run(
        name,
        body.address !== undefined ? String(body.address).trim() : s.address,
        body.phone !== undefined ? String(body.phone).trim() : s.phone,
        id
      );
      if (body.is_default) {
        db.prepare('UPDATE stores SET is_default = 0').run();
        db.prepare('UPDATE stores SET is_default = 1 WHERE id = ?').run(id);
      }
      audit(session.userId, 'update', 'store', id, name);
      return { ok: true };
    },
  },

  {
    method: 'DELETE', path: '/api/stores/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const s = requireStore(id);
      const count = db.prepare('SELECT COUNT(*) AS c FROM stores').get().c;
      if (Number(count) <= 1) throw new ApiError(400, 'Это единственная точка — удалить её нельзя');
      const products = db.prepare('SELECT COUNT(*) AS c FROM products WHERE store_id = ?').get(id).c;
      if (Number(products) > 0) {
        throw new ApiError(400, `На точке ${products} изделий — сначала переместите их в другую точку`);
      }
      db.prepare('DELETE FROM stores WHERE id = ?').run(id);
      if (s.is_default) {
        const next = db.prepare('SELECT id FROM stores ORDER BY sort, id LIMIT 1').get();
        if (next) db.prepare('UPDATE stores SET is_default = 1 WHERE id = ?').run(next.id);
      }
      audit(session.userId, 'delete', 'store', id, s.name);
      return { ok: true };
    },
  },

  {
    // Перемещение изделий между точками — сразу пачкой.
    method: 'POST', path: '/api/transfers',
    handler: ({ body, session }) => {
      const toStore = Number(body.to_store_id);
      requireStore(toStore);
      const ids = Array.isArray(body.product_ids) ? body.product_ids.map(Number).filter(Boolean) : [];
      if (!ids.length) throw new ApiError(400, 'Не выбрано ни одного изделия');
      const note = String(body.note || '').trim();

      return transaction(() => {
        const ts = nowIso();
        const getProduct = db.prepare('SELECT id, sku, name, store_id, status FROM products WHERE id = ?');
        const move = db.prepare('UPDATE products SET store_id = ? WHERE id = ?');
        const log = db.prepare(
          `INSERT INTO stock_transfers (product_id, from_store_id, to_store_id, note, user_id, created_at)
           VALUES (?,?,?,?,?,?)`
        );
        let moved = 0;
        const skipped = [];
        for (const id of ids) {
          const p = getProduct.get(id);
          if (!p) { skipped.push(`#${id} не найдено`); continue; }
          if (p.status === 'sold') { skipped.push(`${p.sku} уже продано`); continue; }
          if (p.store_id === toStore) { skipped.push(`${p.sku} уже на этой точке`); continue; }
          log.run(id, p.store_id, toStore, note, session.userId, ts);
          move.run(toStore, id);
          moved++;
        }
        audit(session.userId, 'transfer', 'store', toStore, `Перемещено изделий: ${moved}`);
        return { moved, skipped };
      });
    },
  },

  {
    method: 'GET', path: '/api/transfers',
    handler: ({ query }) => {
      const limit = Math.min(Number(query.limit) || 100, 500);
      const items = db.prepare(
        `SELECT t.*, p.sku, p.name AS product_name, f.name AS from_name, s.name AS to_name, u.name AS user_name
         FROM stock_transfers t
         LEFT JOIN products p ON p.id = t.product_id
         LEFT JOIN stores f ON f.id = t.from_store_id
         LEFT JOIN stores s ON s.id = t.to_store_id
         LEFT JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC, t.id DESC LIMIT ?`
      ).all(limit);
      return { items };
    },
  },
];

module.exports = { routes };
