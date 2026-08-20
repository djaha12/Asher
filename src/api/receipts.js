'use strict';
/*
 * ---------- Приёмка товара от поставщика ----------
 *
 * До этого приёмки как операции не существовало. Товар приходил накладной
 * на два десятка изделий, а в системе это выглядело так: завести двадцать
 * карточек по одной, а потом отдельно, руками, вписать долг перед поставщиком
 * на общую сумму. Два разных действия, между которыми нет никакой связи.
 *
 * Отсюда три беды, и все три — про деньги:
 *   1. Сумма долга держится на том, что кто-то правильно сложил двадцать
 *      закупочных цен в уме. Ошибка на одну цифру всплывает через месяц,
 *      когда поставщик приносит свою сверку.
 *   2. Долг вписать забывают вовсе — тогда система считает, что магазин
 *      никому не должен, и владелец видит прибыль, которой нет.
 *   3. На вопрос «что было в накладной от 3 марта» ответить нечем: изделия
 *      с накладной ничем не связаны.
 *
 * Здесь всё это — одна операция в одной транзакции: изделия встают на склад,
 * долг перед поставщиком появляется сам и ровно на сумму принятого, а каждое
 * изделие помнит, из какой поставки оно пришло.
 *
 * Товар на реализации принимается так же, но долга не создаёт: чужое изделие
 * мы оплачиваем только после того, как продадим, и этот долг система запишет
 * сама в момент продажи.
 */
const { db, nowIso, round2, money, audit, transaction, getSetting } = require('../db');
const { ApiError } = require('./util');

const today = () => new Date().toISOString().slice(0, 10);

function числоИлиНоль(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/*
 * Закупочная цена одной строки. Поставщики ювелирки часто считают в долларах,
 * и курс важно запомнить на момент поставки: пересчитывать задним числом
 * нельзя, иначе себестоимость и прибыль прошлых месяцев поедут при каждом
 * скачке курса.
 */
function закупочная(строка, курсПоУмолчанию) {
  const валюта = String(строка.purchase_currency || '').trim().toUpperCase();
  if (валюта === 'USD') {
    const вВалюте = round2(строка.purchase_price_orig);
    const курс = round2(строка.purchase_rate) || курсПоУмолчанию;
    if (!(вВалюте > 0)) throw new ApiError(400, 'Укажите закупочную цену в долларах');
    if (!(курс > 0)) throw new ApiError(400, 'Укажите курс доллара — без него закупочную не посчитать');
    return { сумма: round2(вВалюте * курс), валюта: 'USD', вВалюте, курс };
  }
  return { сумма: round2(строка.purchase_price), валюта: '', вВалюте: 0, курс: 0 };
}

const routes = [
  {
    /*
     * Список поставок — журнал приёмок. Владелец смотрит сюда, когда сверяется
     * с поставщиком: что и когда пришло, на сколько, сколько изделий, что уже
     * продано из этой партии.
     */
    method: 'GET', path: '/api/receipts', admin: true,
    handler: ({ query }) => {
      const cond = [`o.type = 'invoice'`];
      const args = [];
      if (query.supplier_id) { cond.push('o.supplier_id = ?'); args.push(Number(query.supplier_id)); }
      if (query.from) { cond.push('o.doc_date >= ?'); args.push(String(query.from)); }
      if (query.to) { cond.push('o.doc_date <= ?'); args.push(String(query.to)); }
      const rows = db.prepare(
        `SELECT o.*, s.name AS supplier_name, u.name AS user_name,
                (SELECT COUNT(*) FROM products p WHERE p.supplier_op_id = o.id) AS items_count,
                (SELECT COUNT(*) FROM products p WHERE p.supplier_op_id = o.id AND p.status = 'sold') AS sold_count,
                (SELECT COALESCE(SUM(p.retail_price), 0) FROM products p WHERE p.supplier_op_id = o.id) AS retail_total
           FROM supplier_ops o
           LEFT JOIN suppliers s ON s.id = o.supplier_id
           LEFT JOIN users u ON u.id = o.user_id
          WHERE ${cond.join(' AND ')}
          ORDER BY o.doc_date DESC, o.id DESC LIMIT 500`
      ).all(...args);
      return { items: rows };
    },
  },
  {
    // Что именно пришло в этой поставке.
    method: 'GET', path: '/api/receipts/:id', admin: true,
    handler: ({ params }) => {
      const id = Number(params.id);
      const поставка = db.prepare(
        `SELECT o.*, s.name AS supplier_name FROM supplier_ops o
           LEFT JOIN suppliers s ON s.id = o.supplier_id
          WHERE o.id = ? AND o.type = 'invoice'`
      ).get(id);
      if (!поставка) throw new ApiError(404, 'Поставка не найдена');
      const items = db.prepare(
        `SELECT id, sku, name, metal, fineness, weight, size, carat,
                purchase_price, purchase_currency, purchase_price_orig, purchase_rate,
                retail_price, status
           FROM products WHERE supplier_op_id = ? ORDER BY id`
      ).all(id);
      return { ...поставка, items };
    },
  },
  {
    /*
     * Сама приёмка. Всё внутри одной транзакции: либо на склад встаёт вся
     * накладная и появляется долг ровно на её сумму, либо не происходит
     * ничего. Половина принятой накладной — худшее из состояний: остаток
     * товара лежит на полке, а в системе его нет.
     */
    method: 'POST', path: '/api/receipts', admin: true,
    handler: ({ body, session }) => {
      const supplierId = Number(body.supplier_id);
      const поставщик = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
      if (!поставщик) throw new ApiError(400, 'Выберите поставщика');

      const строки = Array.isArray(body.items) ? body.items : [];
      if (!строки.length) throw new ApiError(400, 'В поставке нет ни одного изделия');
      if (строки.length > 500) throw new ApiError(400, 'За раз принимается не больше 500 изделий');

      /*
       * Реализация — товар остаётся чужим. Долга при приёмке не создаём:
       * платить владельцу мы будем только за проданное, и этот долг система
       * запишет сама в момент продажи. Записать его сейчас значило бы
       * показать владельцу магазина чужие обязательства как свои.
       */
      const реализация = body.ownership === 'consignment';
      const курсПоУмолчанию = round2(getSetting('usd_rate'));
      const точка = body.store_id ? Number(body.store_id) : null;
      const docNumber = String(body.doc_number || '').trim();
      const docDate = String(body.doc_date || today());
      const dueDate = String(body.due_date || '');

      // Считаем и проверяем ВСЁ до записи: на полпути падать нельзя.
      const готовые = [];
      const артикулы = new Set();
      for (const [i, строка] of строки.entries()) {
        const номер = i + 1;
        const sku = String(строка.sku || '').trim();
        if (!sku) throw new ApiError(400, `Строка ${номер}: артикул обязателен`);
        if (артикулы.has(sku)) throw new ApiError(400, `Артикул «${sku}» в накладной дважды`);
        артикулы.add(sku);
        const занят = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
        if (занят) throw new ApiError(400, `Артикул «${sku}» уже есть в каталоге`);

        const name = String(строка.name || '').trim();
        if (!name) throw new ApiError(400, `Строка ${номер}: укажите наименование`);

        const закуп = закупочная(строка, курсПоУмолчанию);
        if (!(закуп.сумма > 0)) {
          throw new ApiError(400, `Строка ${номер}: закупочная цена должна быть больше нуля`);
        }
        const retail = round2(строка.retail_price);
        if (!(retail > 0)) throw new ApiError(400, `Строка ${номер}: укажите цену продажи`);

        готовые.push({
          sku, name, закуп, retail,
          barcode: String(строка.barcode || '').trim(),
          category_id: строка.category_id ? Number(строка.category_id) : null,
          metal: String(строка.metal || '').trim(),
          fineness: String(строка.fineness || '').trim().slice(0, 10),
          weight: Math.max(0, числоИлиНоль(строка.weight)),
          size: String(строка.size || '').trim(),
          carat: Math.max(0, Math.round(числоИлиНоль(строка.carat) * 1000) / 1000),
          color: String(строка.color || '').trim().toUpperCase().slice(0, 12),
          clarity: String(строка.clarity || '').trim().toUpperCase().slice(0, 12),
          description: String(строка.description || '').trim(),
        });
      }

      const сумма = round2(готовые.reduce((s, г) => s + г.закуп.сумма, 0));

      return transaction(() => {
        const ts = nowIso();
        let opId = null;
        if (!реализация) {
          const info = db.prepare(
            `INSERT INTO supplier_ops
               (supplier_id, type, amount, doc_number, doc_date, due_date, note, user_id, created_at)
             VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?)`
          ).run(supplierId, сумма, docNumber, docDate, dueDate,
            String(body.note || '').trim(), session.userId, ts);
          opId = Number(info.lastInsertRowid);
        }

        const вставить = db.prepare(
          `INSERT INTO products
             (sku, barcode, name, category_id, metal, fineness, weight, size, carat, color, clarity,
              purchase_price, purchase_currency, purchase_price_orig, purchase_rate, retail_price,
              supplier_id, supplier_op_id, status, store_id, ownership, description, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'in_stock', ?,?,?,?)`
        );
        const ids = [];
        for (const г of готовые) {
          const info = вставить.run(г.sku, г.barcode, г.name, г.category_id, г.metal, г.fineness,
            г.weight, г.size, г.carat, г.color, г.clarity,
            г.закуп.сумма, г.закуп.валюта, г.закуп.вВалюте, г.закуп.курс, г.retail,
            supplierId, opId, точка, реализация ? 'consignment' : 'own', г.description, ts);
          ids.push(Number(info.lastInsertRowid));
        }

        audit(session.userId, 'invoice', 'supplier', supplierId,
          реализация
            ? `Принято на реализацию от «${поставщик.name}»: изделий ${ids.length}`
            : `Поставка от «${поставщик.name}»${docNumber ? ` (${docNumber})` : ''}: ` +
              `изделий ${ids.length} на ${money(сумма)}`);

        return {
          id: opId,
          supplier_id: supplierId,
          items_count: ids.length,
          amount: реализация ? 0 : сумма,
          consignment: реализация,
          product_ids: ids,
        };
      });
    },
  },
];

module.exports = { routes };
