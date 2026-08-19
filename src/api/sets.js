'use strict';
/*
 * Комплекты (гарнитуры): кольцо + серьги + подвеска одной позицией.
 *
 * Главное правило: комплект — НЕ изделие. Это только объединение уже
 * существующих изделий, у каждого из которых свой артикул, вес и цена.
 * Если бы комплект был отдельной позицией склада, остатки и граммы
 * посчитались бы дважды — и в аналитике, и в инвентаризации.
 *
 * Продажа комплекта — обычный чек со всеми его изделиями. Если у комплекта
 * своя цена, разница со суммой изделий раскладывается по позициям обычной
 * скидкой: касса, возвраты, обмен и себестоимость работают без изменений.
 */
const { db, nowIso, round2, audit, transaction } = require('../db');
const { ApiError } = require('./util');

const SET_THUMB = `(SELECT pi.thumb FROM product_images pi
   WHERE pi.product_id = p.id ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1)`;

function membersOf(setId) {
  return db.prepare(
    `SELECT p.id, p.sku, p.name, p.metal, p.weight, p.size, p.retail_price, p.status,
            p.reserved_for, ${SET_THUMB} AS thumb
       FROM products p WHERE p.set_id = ? ORDER BY p.retail_price DESC, p.id`
  ).all(setId);
}

/*
 * Раскладка цены комплекта по изделиям.
 *
 * Скидка распределяется пропорционально цене изделия, а остаток от округления
 * добирает последняя позиция — так сумма чека до копейки равна цене комплекта.
 * Цену выше суммы изделий не назначаем: продавать дороже, чем показано на
 * ценниках, система не должна. В этом случае скидки просто нет.
 */
function withSaleDiscounts(items, setPrice) {
  const itemsTotal = round2(items.reduce((s, i) => s + i.retail_price, 0));
  const price = setPrice > 0 ? round2(setPrice) : itemsTotal;
  const priceAboveItems = price > itemsTotal;
  const effective = priceAboveItems ? itemsTotal : price;

  let left = round2(itemsTotal - effective);
  const out = items.map((it, idx) => {
    let discount = 0;
    if (left > 0 && itemsTotal > 0) {
      discount = idx === items.length - 1
        ? left
        : Math.min(left, round2(round2(itemsTotal - effective) * it.retail_price / itemsTotal));
      left = round2(left - discount);
    }
    return { ...it, sale_discount: round2(discount), sale_price: round2(it.retail_price - discount) };
  });
  return { items: out, items_total: itemsTotal, price: effective, price_above_items: priceAboveItems };
}

function setPayload(row) {
  const items = membersOf(row.id);
  const calc = withSaleDiscounts(items, row.price);
  const sold = items.filter(i => i.status === 'sold').length;
  const written = items.filter(i => i.status === 'written_off').length;
  return {
    ...row,
    ...calc,
    count: items.length,
    weight_total: round2(items.reduce((s, i) => s + (i.weight || 0), 0)),
    sold_count: sold,
    // Комплект целый, только если все изделия на месте и хотя бы одно есть.
    complete: items.length > 0 && sold === 0 && written === 0,
  };
}

function requireSet(id) {
  const row = db.prepare('SELECT * FROM product_sets WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'Комплект не найден');
  return row;
}

/*
 * Артикул комплекта не должен совпадать с артикулом изделия и наоборот:
 * сканер и поиск в кассе работают с одним кодом, а UNIQUE в разных таблицах
 * друг друга не видит — совпадение дало бы непредсказуемый результат сканирования.
 */
function checkSkuFree(sku, setId) {
  const code = String(sku || '').trim();
  if (!code) return;
  const product = db.prepare('SELECT name FROM products WHERE sku = ? COLLATE NOCASE').get(code);
  if (product) throw new ApiError(400, `Артикул «${code}» занят изделием «${product.name}»`);
  const other = db.prepare(
    'SELECT name FROM product_sets WHERE sku = ? COLLATE NOCASE AND id != ?'
  ).get(code, setId || 0);
  if (other) throw new ApiError(400, `Артикул «${code}» занят комплектом «${other.name}»`);
}

// Проверка и привязка изделий к комплекту.
function attach(setId, productIds, setPrice) {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (ids.length < 2) throw new ApiError(400, 'В комплекте должно быть хотя бы два изделия');
  if (ids.length > 20) throw new ApiError(400, 'Слишком много изделий в комплекте (максимум 20)');

  let total = 0;
  const stores = new Set();
  for (const pid of ids) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
    if (!p) throw new ApiError(400, `Изделие #${pid} не найдено`);
    if (p.status === 'sold') throw new ApiError(400, `«${p.name}» уже продано — в комплект его не добавить`);
    if (p.status === 'written_off') throw new ApiError(400, `«${p.name}» списано — в комплект его не добавить`);
    if (p.set_id && p.set_id !== setId) {
      const other = db.prepare('SELECT name FROM product_sets WHERE id = ?').get(p.set_id);
      throw new ApiError(400, `«${p.name}» уже в комплекте «${other ? other.name : p.set_id}»`);
    }
    total = round2(total + p.retail_price);
    stores.add(p.store_id || 0);
  }
  // Гарнитур физически лежит в одной коробке на одной витрине.
  if (stores.size > 1) {
    throw new ApiError(400, 'Изделия комплекта лежат на разных точках — сначала соберите их на одной');
  }
  // Цена выше суммы изделий означала бы отрицательную скидку в чеке,
  // а продавать дороже, чем написано на ценниках, система не должна.
  if (setPrice > 0 && round2(setPrice) > total) {
    throw new ApiError(400,
      `Цена комплекта (${round2(setPrice)}) больше суммы цен изделий (${total}). Уменьшите цену комплекта.`);
  }
  // Сначала отвязываем всех прежних, потом привязываем новых —
  // так PUT со списком работает и на добавление, и на удаление изделий.
  db.prepare('UPDATE products SET set_id = NULL WHERE set_id = ?').run(setId);
  const link = db.prepare('UPDATE products SET set_id = ? WHERE id = ?');
  for (const pid of ids) link.run(setId, pid);
  return ids;
}

const routes = [
  {
    method: 'GET', path: '/api/sets',
    handler: () => {
      const rows = db.prepare('SELECT * FROM product_sets ORDER BY created_at DESC, id DESC').all();
      return { items: rows.map(setPayload) };
    },
  },
  {
    method: 'GET', path: '/api/sets/:id',
    handler: ({ params }) => setPayload(requireSet(Number(params.id))),
  },
  {
    method: 'POST', path: '/api/sets', admin: true,
    handler: ({ body, session }) => {
      const name = String(body.name || '').trim();
      if (!name) throw new ApiError(400, 'Название комплекта обязательно');
      const price = round2(body.price || 0);
      if (price < 0) throw new ApiError(400, 'Цена не может быть отрицательной');

      return transaction(() => {
        const sku = String(body.sku || '').trim();
        checkSkuFree(sku, null);
        const info = db.prepare(
          `INSERT INTO product_sets (name, sku, price, note, user_id, created_at) VALUES (?,?,?,?,?,?)`
        ).run(name, sku, price, String(body.note || '').trim(), session.userId, nowIso());
        const setId = Number(info.lastInsertRowid);
        const ids = attach(setId, body.product_ids, price);
        audit(session.userId, 'create', 'set', setId, `${name}: ${ids.length} изделий`);
        return setPayload(requireSet(setId));
      });
    },
  },
  {
    method: 'PUT', path: '/api/sets/:id', admin: true,
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const existing = requireSet(id);
      return transaction(() => {
        const name = body.name !== undefined ? String(body.name).trim() : existing.name;
        if (!name) throw new ApiError(400, 'Название комплекта обязательно');
        const price = body.price !== undefined ? round2(body.price) : existing.price;
        if (price < 0) throw new ApiError(400, 'Цена не может быть отрицательной');
        const sku = body.sku !== undefined ? String(body.sku).trim() : existing.sku;
        checkSkuFree(sku, id);
        db.prepare('UPDATE product_sets SET name = ?, sku = ?, price = ?, note = ? WHERE id = ?')
          .run(name, sku, price,
            body.note !== undefined ? String(body.note).trim() : existing.note,
            id);
        // Передали состав или нет — цену всё равно сверяем с суммой изделий.
        attach(id, body.product_ids !== undefined
          ? body.product_ids
          : membersOf(id).map(m => m.id), price);
        audit(session.userId, 'update', 'set', id, name);
        return setPayload(requireSet(id));
      });
    },
  },
  {
    // Разобрать комплект: изделия остаются на складе сами по себе.
    method: 'DELETE', path: '/api/sets/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const existing = requireSet(id);
      return transaction(() => {
        db.prepare('UPDATE products SET set_id = NULL WHERE set_id = ?').run(id);
        db.prepare('DELETE FROM product_sets WHERE id = ?').run(id);
        audit(session.userId, 'delete', 'set', id, `Комплект «${existing.name}» разобран`);
        return { ok: true };
      });
    },
  },
];

module.exports = { routes, setPayload, withSaleDiscounts };
