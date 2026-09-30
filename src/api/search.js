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
const { свернуть, сжать, запасныеХоды } = require('../поиск');
const { ВИД_РАБОТ } = require('./orders');

const PER_GROUP = 5;

/*
 * Слова и телефон ищем по правилам всей системы — функция nmatch (src/поиск.js):
 * регистр, «ё», слова в любом порядке, номер в любом виде. Второй довод —
 * со скольких цифр искать по телефону: в клиентах хватает трёх, а в чеках
 * и заказах «123» скорее номер документа, чем кусок чьего-то телефона.
 */

function searchProducts(q) {
  // Точное совпадение артикула или штрихкода — первым, потом начало артикула.
  const точно = свернуть(q).trim();
  const безЧёрточек = сжать(точно);
  return db.prepare(
    `SELECT p.id, p.sku, p.name, p.status, p.retail_price, p.metal, p.fineness,
            p.carat, p.color, p.clarity, p.barcode,
            (SELECT pi.thumb FROM product_images pi WHERE pi.product_id = p.id
              ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1) AS thumb
     FROM products p
     WHERE nmatch(?, 0, NULL, p.name, p.sku, p.barcode, p.gem_summary, p.cert_index, p.metal, p.fineness,
                  (SELECT cg.name FROM categories cg WHERE cg.id = p.category_id))
     ORDER BY
       CASE WHEN nlower(p.sku) = ? OR nlower(p.barcode) = ?
                 OR replace(replace(replace(replace(nlower(p.sku), '-', ''), ' ', ''), '.', ''), '_', '') = ? THEN 0
            WHEN substr(nlower(p.sku), 1, length(?)) = ? THEN 1 ELSE 2 END,
       p.status = 'sold', p.id DESC
     LIMIT ?`
  ).all(q, точно, точно, безЧёрточек, точно, точно, PER_GROUP + 1);
}

function searchCustomers(q) {
  /*
   * Номер ищут как удобно: «0700 495», «+996700495», «4952573» — сравниваем
   * голые цифры без кода страны и местного нуля. Полное совпадение имени —
   * первым: «Анна» должна быть над «Анной Сергеевной».
   */
  return db.prepare(
    `SELECT c.id, c.name, c.phone, c.discount,
            (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id) AS purchases
     FROM customers c
     WHERE nmatch(?, 3, c.phone, c.name, c.email)
     ORDER BY nlower(c.name) = ? DESC, c.name
     LIMIT ?`
  ).all(q, свернуть(q).trim(), PER_GROUP + 1);
}

// Чек — по номеру, клиенту, его телефону, изделию или акту старого золота.
function searchSales(q) {
  return db.prepare(
    `SELECT s.id, s.number, s.total, s.paid, s.created_at, s.status,
            c.name AS customer_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE nmatch(?, 6, c.phone, s.number, c.name,
             (SELECT group_concat(p.name || ' ' || p.sku, char(10)) FROM sale_items si
               JOIN products p ON p.id = si.product_id WHERE si.sale_id = s.id),
             (SELECT group_concat(a.number, ' ') FROM scrap_intakes a WHERE a.sale_id = s.id))
     ORDER BY s.created_at DESC
     LIMIT ?`
  ).all(q, PER_GROUP + 1);
}

function searchOrders(q) {
  return db.prepare(
    `SELECT o.id, o.number, o.type, o.status, o.estimate, o.final_price, o.due_date,
            c.name AS customer_name
     FROM service_orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE nmatch(?, 6, c.phone, o.number, o.item, o.description, c.name, ${ВИД_РАБОТ})
     ORDER BY o.accepted_at DESC
     LIMIT ?`
  ).all(q, PER_GROUP + 1);
}

// Акты приёма старого золота: «Л-000012», клиент, что принесли.
function searchScrap(q) {
  return db.prepare(
    `SELECT a.id, a.number, a.weight, a.amount, a.created_at, a.sale_id, a.items,
            c.name AS customer_name, s.number AS sale_number
     FROM scrap_intakes a LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN sales s ON s.id = a.sale_id
     WHERE nmatch(?, 6, c.phone, a.number, c.name,
             (SELECT group_concat(json_extract(j.value, '$.description'), char(10)) FROM json_each(a.items) j))
     ORDER BY a.id DESC LIMIT ?`
  ).all(q, PER_GROUP + 1).map(({ items, ...акт }) => {
    let строки = [];
    try { строки = JSON.parse(items || '[]'); } catch { строки = []; }
    return { ...акт, what: строки.map(x => `${x.description || 'лом'} ${x.fineness}`).join(', ') };
  });
}

function найти(q) {
  const cut = rows => ({ items: rows.slice(0, PER_GROUP), more: rows.length > PER_GROUP });
  return [
    { key: 'products', title: 'Изделия', ...cut(searchProducts(q)) },
    { key: 'customers', title: 'Клиенты', ...cut(searchCustomers(q)) },
    { key: 'sales', title: 'Чеки', ...cut(searchSales(q)) },
    { key: 'orders', title: 'Заказы и ремонт', ...cut(searchOrders(q)) },
    { key: 'scrap', title: 'Старое золото', ...cut(searchScrap(q)) },
  ].filter(g => g.items.length);
}

const routes = [
  {
    method: 'GET', path: '/api/search',
    handler: ({ query }) => {
      const q = String(query.q || '').trim().slice(0, 200);
      // Одна буква даёт пол-каталога — ждём, пока наберут хотя бы две.
      if (q.length < 2) return { query: q, groups: [] };

      let groups = найти(q);
      /*
       * Пусто — запасные ходы, как во всей системе: без окончаний («цепь» —
       * «цепочка»), потом в другой раскладке («rjkmwj» — «кольцо»).
       */
      let раскладка = '';
      for (const ход of groups.length ? [] : запасныеХоды(q)) {
        const ещё = найти(ход.search);
        if (ещё.length) { groups = ещё; раскладка = ход.раскладка; break; }
      }

      return {
        query: q,
        ...(раскладка ? { раскладка } : {}),
        total: groups.reduce((n, g) => n + g.items.length, 0),
        groups,
      };
    },
  },
];

module.exports = { routes };
