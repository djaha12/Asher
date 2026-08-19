'use strict';
/*
 * Общий поиск по всей системе.
 *
 * До этого поисков было восемь: свой в каталоге, свой в клиентах, свой в
 * долгах, свой в чеках. Продавцу приходилось сначала вспомнить, в каком
 * разделе искать, и только потом искать. Здесь одно поле: вбил что угодно —
 * артикул, имя, телефон, номер чека, номер сертификата — и видишь всё сразу,
 * с подписью, что это и где лежит.
 *
 * Ищем по каждому разделу отдельным запросом с маленьким пределом: так поиск
 * остаётся быстрым даже на складе в пятнадцать тысяч изделий, а человеку
 * больше пяти строк на раздел и не нужно — он всё равно уточнит запрос.
 */
const { db } = require('../db');

const PER_GROUP = 5;

// Телефон ищут как придётся: «0555 12-34-56», «+996 555 123456», «123456».
const digitsOnly = s => String(s || '').replace(/\D/g, '');

function searchProducts(like, role) {
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name, p.status, p.retail_price, p.metal, p.fineness,
            p.carat, p.color, p.clarity, p.barcode,
            (SELECT pi.thumb FROM product_images pi WHERE pi.product_id = p.id
              ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1) AS thumb
     FROM products p
     WHERE nlower(p.name) LIKE ? OR nlower(p.sku) LIKE ? OR p.barcode LIKE ?
        OR nlower(p.gem_summary) LIKE ? OR nlower(p.cert_index) LIKE ?
     ORDER BY
       CASE WHEN nlower(p.sku) = ? THEN 0 WHEN nlower(p.sku) LIKE ? THEN 1 ELSE 2 END,
       p.status = 'sold', p.id DESC
     LIMIT ?`
  ).all(like.any, like.any, like.any, like.any, like.any, like.exact, like.starts, PER_GROUP + 1);
  return rows;
}

function searchCustomers(like) {
  /*
   * Номер ищут как удобно: «0700 495», «+996700495», «4952573». Сравниваем
   * голые цифры и заодно пробуем вариант без местной приставки — «0700…»
   * и «996700…» это один и тот же телефон, записанный по-разному.
   */
  const phone = digitsOnly(like.exact);
  const noTrunk = phone.length > 3 && phone.startsWith('0') ? phone.slice(1) : phone;
  return db.prepare(
    `SELECT c.id, c.name, c.phone, c.discount,
            (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id) AS purchases
     FROM customers c
     WHERE nlower(c.name) LIKE ?
        OR (LENGTH(?) >= 3 AND digits(c.phone) LIKE ?)
        OR (LENGTH(?) >= 3 AND digits(c.phone) LIKE ?)
     ORDER BY nlower(c.name) = ? DESC, c.name
     LIMIT ?`
  ).all(like.any, phone, `%${phone}%`, noTrunk, `%${noTrunk}%`, like.exact, PER_GROUP + 1);
}

function searchSales(like) {
  return db.prepare(
    `SELECT s.id, s.number, s.total, s.paid, s.created_at, s.status,
            c.name AS customer_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE nlower(s.number) LIKE ?
        OR EXISTS (SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id
                   WHERE si.sale_id = s.id AND (nlower(p.sku) LIKE ? OR nlower(p.name) LIKE ?))
     ORDER BY s.created_at DESC
     LIMIT ?`
  ).all(like.any, like.any, like.any, PER_GROUP + 1);
}

function searchOrders(like) {
  return db.prepare(
    `SELECT o.id, o.number, o.type, o.status, o.estimate, o.final_price, o.due_date,
            c.name AS customer_name
     FROM service_orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE nlower(o.number) LIKE ? OR nlower(o.description) LIKE ?
        OR nlower(COALESCE(c.name, '')) LIKE ?
     ORDER BY o.accepted_at DESC
     LIMIT ?`
  ).all(like.any, like.any, like.any, PER_GROUP + 1);
}

function searchSets(like) {
  return db.prepare(
    `SELECT ps.id, ps.sku, ps.name, ps.price,
            (SELECT COUNT(*) FROM products p WHERE p.set_id = ps.id) AS items_count
     FROM product_sets ps
     WHERE nlower(ps.name) LIKE ? OR nlower(ps.sku) LIKE ?
     ORDER BY ps.name LIMIT ?`
  ).all(like.any, like.any, PER_GROUP + 1);
}

const routes = [
  {
    method: 'GET', path: '/api/search',
    handler: ({ query, session }) => {
      const q = String(query.q || '').trim();
      // Одна буква даёт пол-каталога — ждём, пока наберут хотя бы две.
      if (q.length < 2) return { query: q, groups: [] };
      const lower = q.toLowerCase();
      const like = { any: `%${lower}%`, starts: `${lower}%`, exact: lower };

      const cut = rows => ({ items: rows.slice(0, PER_GROUP), more: rows.length > PER_GROUP });

      const products = cut(searchProducts(like, session.role));
      const customers = cut(searchCustomers(like));
      const sales = cut(searchSales(like));
      const orders = cut(searchOrders(like));
      const sets = cut(searchSets(like));

      const groups = [
        { key: 'products', title: 'Изделия', ...products },
        { key: 'customers', title: 'Клиенты', ...customers },
        { key: 'sales', title: 'Чеки', ...sales },
        { key: 'orders', title: 'Заказы и ремонт', ...orders },
        { key: 'sets', title: 'Комплекты', ...sets },
      ].filter(g => g.items.length);

      return {
        query: q,
        total: groups.reduce((n, g) => n + g.items.length, 0),
        groups,
      };
    },
  },
];

module.exports = { routes };
