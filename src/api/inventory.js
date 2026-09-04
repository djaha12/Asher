'use strict';
/*
 * Инвентаризация: пересчёт витрины сканированием.
 *
 * Продавец открывает сессию по точке и сканирует изделия камерой телефона или
 * сканером штрихкодов. Система в реальном времени показывает три списка:
 *   найдено   — числится на точке и отсканировано;
 *   не найдено — числится, но не отсканировано (пропажа или лежит не там);
 *   лишнее    — отсканировано, но числится за другой точкой либо уже продано.
 */
const { db, nowIso, round2, audit, transaction, видитВсё } = require('../db');
const { ApiError } = require('./util');

const COUNTABLE = `('in_stock','reserved')`;

function requireSession(id) {
  const s = db.prepare(
    `SELECT i.*, st.name AS store_name, u.name AS user_name
     FROM inventory_sessions i
     LEFT JOIN stores st ON st.id = i.store_id
     LEFT JOIN users u ON u.id = i.user_id
     WHERE i.id = ?`
  ).get(id);
  if (!s) throw new ApiError(404, 'Инвентаризация не найдена');
  return s;
}

function sessionResult(session, role = 'owner') {
  const id = session.id;
  const scanned = db.prepare(
    `SELECT p.id, p.sku, p.name, p.metal, p.weight, p.retail_price, p.purchase_price, p.status,
            p.store_id, s.scanned_at, st.name AS store_name,
            (SELECT pi.thumb FROM product_images pi WHERE pi.product_id = p.id
              ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1) AS thumb
     FROM inventory_scans s
     JOIN products p ON p.id = s.product_id
     LEFT JOIN stores st ON st.id = p.store_id
     WHERE s.session_id = ? ORDER BY s.scanned_at DESC`
  ).all(id);

  const missing = db.prepare(
    `SELECT p.id, p.sku, p.name, p.metal, p.weight, p.retail_price, p.purchase_price, p.status, p.location,
            (SELECT pi.thumb FROM product_images pi WHERE pi.product_id = p.id
              ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1) AS thumb
     FROM products p
     WHERE p.store_id IS ? AND p.status IN ${COUNTABLE}
       AND NOT EXISTS (SELECT 1 FROM inventory_scans s WHERE s.session_id = ? AND s.product_id = p.id)
     ORDER BY p.sku`
  ).all(session.store_id, id);

  const found = scanned.filter(p => p.store_id === session.store_id && ['in_stock', 'reserved'].includes(p.status));
  const extra = scanned.filter(p => !(p.store_id === session.store_id && ['in_stock', 'reserved'].includes(p.status)));
  const expected = found.length + missing.length;

  const sum = (rows, field) => round2(rows.reduce((s, r) => s + (Number(r[field]) || 0), 0));
  const result = {
    session,
    found, missing, extra,
    counts: { expected, found: found.length, missing: missing.length, extra: extra.length },
    values: {
      missing_retail: sum(missing, 'retail_price'),
      missing_cost: sum(missing, 'purchase_price'),
      missing_weight: round2(missing.reduce((s, r) => s + (Number(r.weight) || 0), 0)),
      found_retail: sum(found, 'retail_price'),
    },
    progress: expected ? Math.round(found.length / expected * 100) : 100,
  };
  if (!видитВсё(role)) {
    delete result.values.missing_cost;
    [...found, ...missing, ...extra].forEach(p => delete p.purchase_price);
  }
  return result;
}

const routes = [
  {
    method: 'GET', path: '/api/inventory',
    handler: () => ({
      items: db.prepare(
        `SELECT i.*, st.name AS store_name, u.name AS user_name,
                (SELECT COUNT(*) FROM inventory_scans s WHERE s.session_id = i.id) AS scans
         FROM inventory_sessions i
         LEFT JOIN stores st ON st.id = i.store_id
         LEFT JOIN users u ON u.id = i.user_id
         ORDER BY i.started_at DESC LIMIT 100`
      ).all(),
    }),
  },

  {
    method: 'POST', path: '/api/inventory',
    handler: ({ body, session }) => {
      const storeId = body.store_id ? Number(body.store_id) : null;
      if (!storeId || !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) {
        throw new ApiError(400, 'Выберите точку, которую пересчитываем');
      }
      const open = db.prepare(
        `SELECT id FROM inventory_sessions WHERE store_id = ? AND status = 'open'`
      ).get(storeId);
      if (open) throw new ApiError(400, 'По этой точке уже идёт инвентаризация — продолжите её');
      const info = db.prepare(
        `INSERT INTO inventory_sessions (store_id, status, note, user_id, started_at)
         VALUES (?, 'open', ?, ?, ?)`
      ).run(storeId, String(body.note || '').trim(), session.userId, nowIso());
      const id = Number(info.lastInsertRowid);
      audit(session.userId, 'create', 'inventory', id, 'Начата инвентаризация');
      return sessionResult(requireSession(id), session.role);
    },
  },

  {
    method: 'GET', path: '/api/inventory/:id',
    handler: ({ params, session }) => sessionResult(requireSession(Number(params.id)), session.role),
  },

  {
    // Сканирование: принимаем и артикул, и штрихкод — что бы ни прочитала камера.
    method: 'POST', path: '/api/inventory/:id/scan',
    handler: ({ params, body, session }) => {
      const inv = requireSession(Number(params.id));
      if (inv.status !== 'open') throw new ApiError(400, 'Инвентаризация уже завершена');
      const code = String(body.code || '').trim();
      if (!code) throw new ApiError(400, 'Пустой код');

      const product = db.prepare(
        `SELECT * FROM products WHERE nlower(sku) = nlower(?) OR barcode = ? LIMIT 1`
      ).get(code, code);
      if (!product) throw new ApiError(404, `Изделие с кодом «${code}» не найдено в базе`);

      const already = db.prepare(
        'SELECT 1 FROM inventory_scans WHERE session_id = ? AND product_id = ?'
      ).get(inv.id, product.id);
      if (!already) {
        db.prepare(
          'INSERT INTO inventory_scans (session_id, product_id, user_id, scanned_at) VALUES (?,?,?,?)'
        ).run(inv.id, product.id, session.userId, nowIso());
      }

      let warning = '';
      if (product.status === 'sold') warning = 'Изделие числится проданным';
      else if (product.status === 'written_off') warning = 'Изделие числится списанным';
      else if (product.store_id !== inv.store_id) warning = 'Изделие числится за другой точкой';

      return {
        product: {
          id: product.id, sku: product.sku, name: product.name, metal: product.metal,
          weight: product.weight, retail_price: product.retail_price, status: product.status,
        },
        duplicate: Boolean(already),
        warning,
      };
    },
  },

  {
    method: 'DELETE', path: '/api/inventory/:id/scan/:productId',
    handler: ({ params }) => {
      const inv = requireSession(Number(params.id));
      if (inv.status !== 'open') throw new ApiError(400, 'Инвентаризация уже завершена');
      db.prepare('DELETE FROM inventory_scans WHERE session_id = ? AND product_id = ?')
        .run(inv.id, Number(params.productId));
      return { ok: true };
    },
  },

  {
    // Завершение. Ненайденное можно списать одной кнопкой — но только
    // администратор: это признание убытка.
    method: 'POST', path: '/api/inventory/:id/finish',
    handler: ({ params, body, session }) => {
      const inv = requireSession(Number(params.id));
      if (inv.status !== 'open') throw new ApiError(400, 'Инвентаризация уже завершена');
      const writeOff = Boolean(body.write_off_missing);
      if (writeOff && !видитВсё(session.role)) {
        throw new ApiError(403, 'Списывать недостачу может только основатель или бухгалтер');
      }

      return transaction(() => {
        const before = sessionResult(inv, 'owner');
        if (writeOff) {
          // Причину пишем сразу: иначе недостача, ручное списание и возврат
          // поставщику выглядят в карточке одинаково и разобрать их потом нельзя.
          const mark = db.prepare(
            `UPDATE products SET status = 'written_off', reserved_for = NULL, reserved_until = '',
                                 write_off_reason = ? WHERE id = ?`
          );
          for (const p of before.missing) mark.run(`Недостача при инвентаризации №${inv.id}`, p.id);
          if (before.missing.length) {
            db.prepare(
              `INSERT INTO finance_ops (type, category, amount, note, user_id, created_at)
               VALUES ('expense', 'Недостача', ?, ?, ?, ?)`
            ).run(before.values.missing_cost, `Инвентаризация №${inv.id}: списано изделий ${before.missing.length}`,
              session.userId, nowIso());
          }
        }
        db.prepare(`UPDATE inventory_sessions SET status = 'finished', finished_at = ? WHERE id = ?`)
          .run(nowIso(), inv.id);
        audit(session.userId, 'finish', 'inventory', inv.id,
          `Найдено ${before.counts.found}, недостача ${before.counts.missing}${writeOff ? ' (списана)' : ''}`);
        return sessionResult(requireSession(inv.id), session.role);
      });
    },
  },

  {
    method: 'DELETE', path: '/api/inventory/:id', admin: true,
    handler: ({ params, session }) => {
      const inv = requireSession(Number(params.id));
      db.prepare('DELETE FROM inventory_sessions WHERE id = ?').run(inv.id);
      audit(session.userId, 'delete', 'inventory', inv.id, 'Инвентаризация удалена');
      return { ok: true };
    },
  },
];

module.exports = { routes };
