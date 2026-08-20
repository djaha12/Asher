'use strict';
const { db, nowIso, round2, audit } = require('../db');
const { ApiError } = require('./util');
const { listImages, listCertificates, removeFiles } = require('./images');

const PRODUCT_FIELDS = ['sku', 'barcode', 'name', 'category_id', 'metal', 'weight', 'size', 'gems',
  'gem_summary', 'purchase_price', 'retail_price', 'supplier_id', 'status', 'reserved_for',
  'location', 'description', 'store_id', 'ownership', 'reserved_until', 'write_off_reason',
  'purchase_currency', 'purchase_price_orig', 'purchase_rate', 'cert_index',
  'fineness', 'carat', 'color', 'clarity'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Общепринятые шкалы бриллианта: цвет от бесцветного, чистота от безупречной.
const COLOR_SCALE = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
const CLARITY_SCALE = ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'SI3', 'I1', 'I2', 'I3'];
function byScale(scale) {
  return (a, b) => {
    const ia = scale.indexOf(a), ib = scale.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  };
}

// Номер сертификата пишут по-разному: «GIA 2141438171», «2141-438-171».
// Для поиска приводим к одному виду — буквы, цифры и дефис.
function normalizeCertNumber(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

// Миниатюра главного фото — подзапросом, чтобы список каталога грузился одним запросом.
const MAIN_THUMB = `(SELECT pi.thumb FROM product_images pi
   WHERE pi.product_id = p.id ORDER BY pi.is_main DESC, pi.sort, pi.id LIMIT 1) AS thumb`;
const PHOTO_COUNT = `(SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS photo_count`;

// Всё, что вместе складывается в закупочную цену.
const PURCHASE_FIELDS = ['purchase_price', 'purchase_price_orig', 'purchase_rate', 'purchase_currency'];

/*
 * Спрятать закупочную цену от продавца. Валютные поля прячем вместе с ней:
 * цена в долларах и курс перемножаются в ту же сумму, так что оставить их —
 * то же самое, что показать закупочную.
 */
function hidePurchase(p) {
  for (const f of PURCHASE_FIELDS) delete p[f];
  return p;
}

/*
 * И обратно: не дать продавцу записать закупочную. Дело не в запрете как
 * таковом — форма редактирования у продавца этих полей не показывает, значит
 * пришлёт пустые значения, и закупочная цена молча обнулилась бы. Поэтому на
 * сервере эти поля у продавца просто не существуют: ни прочитать, ни стереть.
 */
function stripPurchaseInput(body, role) {
  if (role === 'admin') return body;
  const out = { ...body };
  for (const f of PURCHASE_FIELDS) delete out[f];
  return out;
}

/*
 * Поля, которые продавец не правит.
 *
 * Это не про недоверие, а про то, что без такого списка все остальные
 * ограничения — пустые слова. Потолок скидки считает процент от цены
 * по ценнику; пока продавец может сам поставить этому ценнику любое число,
 * потолок обходится ОДНИМ запросом: поставить кольцу за 214 500 цену 1 000
 * и продать без всякой скидки. Ровно так же обходится и запрет списывать
 * недостачу при инвентаризации — достаточно открыть карточку и поменять
 * статус на «списано».
 *
 * Продавцу остаётся всё, что нужно у прилавка: фотографии, размер, описание,
 * заметки, расположение. Цена, списание, точка, поставщик и чьё это изделие —
 * решения владельца.
 *
 * Статуса в этом списке нет, и это не упущение: резерв за клиентом продавец
 * ставит и снимает сам, это его ежедневная работа. Для статуса правило своё —
 * ниже.
 */
const OWNER_ONLY_FIELDS = ['retail_price', 'write_off_reason',
  'store_id', 'supplier_id', 'ownership', 'sku'];

// Переходы статуса, которые продавцу разрешены: только витрина ↔ резерв.
// «Списано» и «продано» сюда не входят: первое уводит изделие со склада
// решением продавца, второе ставится и снимается только чеком.
const ПРОДАВЦУ_МОЖНО = new Set(['in_stock', 'reserved']);

function stripOwnerFields(body, role, existing) {
  if (role === 'admin') return body;
  /*
   * Правила касаются ПРАВКИ уже заведённой карточки, а не заведения новой.
   *
   * Опасно не «продавец назвал цену», а «продавец переписал цену изделия,
   * которое уже лежит на витрине»: именно так обходится потолок скидки.
   * Когда продавец принимает новый товар и заводит карточку, красть не у чего —
   * изделия до этой минуты в системе не было. Запретить и это значило бы,
   * что вечером, когда владельца нет, принятый товар просто некуда положить.
   */
  if (!existing) return body;
  const out = { ...body };

  if (out.status !== undefined && existing && out.status !== existing.status) {
    if (!ПРОДАВЦУ_МОЖНО.has(out.status) || !ПРОДАВЦУ_МОЖНО.has(existing.status)) {
      throw new ApiError(403,
        'Списание и возврат изделия на витрину оформляет владелец. ' +
        'Продавцу доступны резерв и снятие резерва.');
    }
  }

  for (const f of OWNER_ONLY_FIELDS) {
    /*
     * Молча выкидываем только то, что и так не меняется: форма продавца
     * присылает поля целиком, и ругаться на неизменившуюся цену значило бы
     * сделать карточку нередактируемой вовсе. А вот попытку изменить —
     * называем вслух, иначе продавец будет думать, что сохранил.
     */
    if (out[f] === undefined) continue;
    const было = existing ? existing[f] : undefined;
    const стало = out[f];
    const одинаково = было === стало
      || (typeof было === 'number' && Number(стало) === было)
      || (было === null && (стало === null || стало === ''));
    if (!одинаково) {
      if (f === 'retail_price') {
        throw new ApiError(403,
          'Цену изделия меняет владелец. Если нужно продать дешевле — это скидка в кассе.');
      }
      throw new ApiError(403, 'Это поле карточки изделия меняет владелец.');
    }
    delete out[f];
  }
  return out;
}

function rowToProduct(r) {
  if (!r) return null;
  let gems = [];
  try { gems = JSON.parse(r.gems || '[]'); } catch { gems = []; }
  return { ...r, gems };
}

function validateProduct(body, { partial = false, existing = null } = {}) {
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
  // Проба и характеристики главного бриллианта — отдельные поля изделия.
  if (body.fineness !== undefined) out.fineness = String(body.fineness || '').trim().slice(0, 10);
  if (body.color !== undefined) out.color = String(body.color || '').trim().toUpperCase().slice(0, 12);
  if (body.clarity !== undefined) out.clarity = String(body.clarity || '').trim().toUpperCase().slice(0, 12);
  if (body.carat !== undefined) {
    out.carat = Math.round((Number(body.carat) || 0) * 1000) / 1000;
    if (out.carat < 0) throw new ApiError(400, 'Каратность не может быть отрицательной');
  }
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
  if (body.store_id !== undefined) {
    out.store_id = toId(body.store_id, 'точка продаж');
    if (out.store_id && !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(out.store_id)) {
      throw new ApiError(400, 'Точка продаж не найдена');
    }
  }
  if (body.ownership !== undefined) {
    if (!['own', 'consignment'].includes(body.ownership)) {
      throw new ApiError(400, 'Принадлежность: «own» (наш товар) или «consignment» (на реализации)');
    }
    out.ownership = body.ownership;
    if (out.ownership === 'consignment') {
      const supplierId = body.supplier_id !== undefined ? out.supplier_id : undefined;
      if (supplierId === null) {
        throw new ApiError(400, 'Для товара на реализации нужно указать поставщика — владельца изделия');
      }
    }
  }
  if (body.reserved_for !== undefined) {
    out.reserved_for = toId(body.reserved_for, 'клиент резерва');
    if (out.reserved_for && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(out.reserved_for)) {
      throw new ApiError(400, 'Клиент для резерва не найден');
    }
  }
  // Срок резерва. Пусто — бессрочно, как вели себя все резервы раньше.
  if (body.reserved_until !== undefined) {
    const until = String(body.reserved_until || '').trim();
    if (until && !ISO_DATE.test(until)) throw new ApiError(400, 'Срок резерва: дата в виде ГГГГ-ММ-ДД');
    out.reserved_until = until;
  }
  if (body.write_off_reason !== undefined) {
    out.write_off_reason = String(body.write_off_reason || '').trim().slice(0, 200);
  }
  /*
   * Закупка в валюте. В purchase_price всегда лежит сумма в валюте учёта —
   * от неё считаются себестоимость, маржа и P&L, поэтому вся существующая
   * аналитика продолжает работать без изменений. Цена в валюте и курс
   * хранятся рядом как справка: курс фиксируется на момент закупки и
   * потом не пересчитывается, иначе прошлая прибыль менялась бы задним числом.
   */
  if (body.purchase_currency !== undefined) {
    out.purchase_currency = String(body.purchase_currency || '').trim().toUpperCase().slice(0, 8);
  }
  if (body.purchase_price_orig !== undefined) {
    out.purchase_price_orig = round2(body.purchase_price_orig);
    if (out.purchase_price_orig < 0) throw new ApiError(400, 'Цена не может быть отрицательной');
  }
  if (body.purchase_rate !== undefined) {
    out.purchase_rate = round2(body.purchase_rate);
    if (out.purchase_rate < 0) throw new ApiError(400, 'Курс не может быть отрицательным');
  }
  /*
   * Пересчёт закупочной. Считает только сервер — иначе интерфейс, импорт и
   * автообмен разойдутся в арифметике.
   *
   * Берём значения с учётом уже сохранённых: правка одного лишь курса тоже
   * обязана пересчитать сумму, иначе в карточке будет «200 $ × 91,20», а в
   * сомах — сумма по старому курсу.
   */
  const touchedCurrency = body.purchase_currency !== undefined
    || body.purchase_price_orig !== undefined || body.purchase_rate !== undefined;
  if (touchedCurrency) {
    const orig = out.purchase_price_orig !== undefined
      ? out.purchase_price_orig : round2(existing ? existing.purchase_price_orig : 0);
    const rate = out.purchase_rate !== undefined
      ? out.purchase_rate : round2(existing ? existing.purchase_rate : 0);
    if (orig > 0 && rate > 0) out.purchase_price = round2(orig * rate);
  } else if (out.purchase_price !== undefined && existing
      && existing.purchase_price_orig > 0 && existing.purchase_rate > 0) {
    // Закупочную правят руками при заполненных валютных полях: ручной ввод
    // главнее, а справку о валюте убираем — иначе карточка будет врать.
    out.purchase_currency = '';
    out.purchase_price_orig = 0;
    out.purchase_rate = 0;
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
      // Сертификат камня: лаборатория и номер. Сертификат принадлежит камню,
      // а не изделию: в кольце центральный бриллиант бывает с сертификатом,
      // а россыпь вокруг — без него.
      cert_lab: String(g.cert_lab || '').trim().toUpperCase().slice(0, 20),
      cert_number: normalizeCertNumber(g.cert_number),
      cert_date: ISO_DATE.test(String(g.cert_date || '').trim()) ? String(g.cert_date).trim() : '',
    })));
    /*
     * Строку для поиска собирает сервер, а не браузер: изделия приезжают ещё
     * и автообменом из 1С мимо интерфейса, и там индекс оказался бы пустым.
     */
    out.cert_index = JSON.parse(out.gems)
      .filter(g => g.cert_number)
      .map(g => [g.cert_lab, g.cert_number].filter(Boolean).join(' '))
      .join('; ');
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
        /*
         * Ищем и по номеру сертификата: с бумажкой в руках продавец должен
         * находить изделие. Именно по отдельной колонке cert_index, а не по
         * сырому JSON вставок — иначе «57» совпало бы с огранкой «Кр-57» и с
         * каратами, а этот же поиск обслуживает кассу и диалог обмена.
         */
        cond.push(`(nlower(p.name) LIKE ? OR nlower(p.sku) LIKE ? OR p.barcode LIKE ?
                    OR nlower(p.gem_summary) LIKE ? OR nlower(p.cert_index) LIKE ?)`);
        const s = `%${String(query.search).toLowerCase()}%`;
        args.push(s, s, s, s, s);
      }
      if (query.status) { cond.push('p.status = ?'); args.push(query.status); }
      if (query.category_id) { cond.push('p.category_id = ?'); args.push(Number(query.category_id)); }
      if (query.metal) { cond.push('p.metal = ?'); args.push(query.metal); }
      // Проба, цвет и чистота — то, по чему отбирают бриллианты.
      if (query.fineness) { cond.push('p.fineness = ?'); args.push(query.fineness); }
      if (query.color) { cond.push('p.color = ?'); args.push(query.color); }
      if (query.clarity) { cond.push('p.clarity = ?'); args.push(query.clarity); }
      if (query.carat_min) { cond.push('p.carat >= ?'); args.push(Number(query.carat_min)); }
      if (query.carat_max) { cond.push('p.carat <= ?'); args.push(Number(query.carat_max)); }
      if (query.store_id) { cond.push('p.store_id = ?'); args.push(Number(query.store_id)); }
      if (query.ownership) { cond.push('p.ownership = ?'); args.push(query.ownership); }
      if (query.has_photo === '1') cond.push('EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)');
      if (query.has_photo === '0') cond.push('NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)');
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const SORTS = {
        new: 'p.created_at DESC, p.id DESC',
        name: 'p.name COLLATE NOCASE',
        sku: 'p.sku COLLATE NOCASE',
        price_asc: 'p.retail_price',
        price_desc: 'p.retail_price DESC',
        carat_desc: 'p.carat DESC, p.retail_price DESC',
        carat_asc: 'p.carat, p.retail_price',
      };
      const order = SORTS[query.sort] || SORTS.new;
      const limit = Math.min(Number(query.limit) || 500, 2000);
      const offset = Number(query.offset) || 0;
      const rows = db.prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name, cu.name AS reserved_for_name,
                st.name AS store_name, ps.name AS set_name, ${MAIN_THUMB}, ${PHOTO_COUNT}
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN customers cu ON cu.id = p.reserved_for
         LEFT JOIN stores st ON st.id = p.store_id
         LEFT JOIN product_sets ps ON ps.id = p.set_id
         ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
      ).all(...args, limit, offset);
      const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM products p ${where}`).get(...args);
      const items = rows.map(rowToProduct);
      // Закупочные цены — только администратору. Валютные поля убираем тоже:
      // цена в долларах, умноженная на курс, и есть закупочная.
      if (session.role !== 'admin') items.forEach(hidePurchase);
      return { items, total: Number(totalRow.c) };
    },
  },
  {
    /*
     * Снять резервы с истёкшим сроком прямо сейчас. Обычно это делает сама
     * система — при запуске и раз в час, — но кнопка нужна: владелец хочет
     * видеть результат немедленно, а не гадать, дошла ли до этого очередь.
     */
    method: 'POST', path: '/api/products/release-expired-reserves', admin: true,
    handler: ({ session }) => {
      const released = require('../reserve').releaseExpired();
      if (released) audit(session.userId, 'release_reserves', 'product', null, `Снято резервов: ${released}`);
      return { released };
    },
  },
  {
    /*
     * Изделия, у которых резерв на исходе — подсказка на главной и в каталоге.
     * Заодно догоняем просроченные: ночью ноутбук магазина закрывают, часовой
     * таймер не тикает, и без этого утром половина сроков висела бы неснятой.
     */
    method: 'GET', path: '/api/products/reserves-expiring',
    handler: ({ query }) => {
      const reserve = require('../reserve');
      reserve.releaseExpired();
      return { items: reserve.expiringSoon(Math.min(Number(query.days) || 2, 30)) };
    },
  },
  {
    method: 'GET', path: '/api/products/meta',
    handler: () => {
      // Списки для фильтров собираем из того, что реально лежит на складе,
      // а не из заранее выдуманного перечня.
      const distinct = col => db.prepare(
        `SELECT DISTINCT ${col} AS v FROM products WHERE ${col} != '' ORDER BY ${col}`
      ).all().map(r => r.v);
      const counts = db.prepare(`SELECT status, COUNT(*) AS c FROM products GROUP BY status`).all();
      return {
        metals: distinct('metal'),
        fineness: distinct('fineness'),
        // Цвет и чистота бриллианта идут по своей шкале, а не по алфавиту:
        // D лучше E, IF лучше VS1 — сортируем в этом порядке.
        colors: distinct('color').sort(byScale(COLOR_SCALE)),
        clarities: distinct('clarity').sort(byScale(CLARITY_SCALE)),
        status_counts: counts,
      };
    },
  },
  {
    method: 'GET', path: '/api/products/:id',
    handler: ({ params, session }) => {
      const p = db.prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name, cu.name AS reserved_for_name,
                st.name AS store_name, ps.name AS set_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN customers cu ON cu.id = p.reserved_for
         LEFT JOIN stores st ON st.id = p.store_id
         LEFT JOIN product_sets ps ON ps.id = p.set_id
         WHERE p.id = ?`
      ).get(Number(params.id));
      if (!p) throw new ApiError(404, 'Изделие не найдено');
      const history = db.prepare(
        `SELECT si.*, s.number AS sale_number, s.created_at AS sale_date, cu.name AS customer_name
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         LEFT JOIN customers cu ON cu.id = s.customer_id
         WHERE si.product_id = ? ORDER BY s.created_at DESC`
      ).all(Number(params.id));
      const transfers = db.prepare(
        `SELECT t.*, f.name AS from_name, s.name AS to_name, u.name AS user_name
         FROM stock_transfers t
         LEFT JOIN stores f ON f.id = t.from_store_id
         LEFT JOIN stores s ON s.id = t.to_store_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.product_id = ? ORDER BY t.created_at DESC LIMIT 20`
      ).all(Number(params.id));
      /*
       * Признак «возвращено поставщику» берём из книги расчётов, а не из текста
       * причины: текст правится обычным сохранением изделия, а строка операции —
       * нет, и именно она двигала деньги.
       */
      const supplierReturn = db.prepare(
        `SELECT o.id, o.amount, o.created_at, o.note, s.name AS supplier_name
           FROM supplier_ops o LEFT JOIN suppliers s ON s.id = o.supplier_id
          WHERE o.kind = 'return' AND o.product_id = ? ORDER BY o.id DESC LIMIT 1`
      ).get(Number(params.id));
      const product = {
        ...rowToProduct(p), history, transfers,
        images: listImages(Number(params.id)),
        certificates: listCertificates(Number(params.id)),
        supplier_return: supplierReturn || null,
      };
      if (session.role !== 'admin') {
        hidePurchase(product);
        product.supplier_return = null; // сумма возврата — это закупочная цена
        history.forEach(h => delete h.cost);
      }
      return product;
    },
  },
  {
    method: 'POST', path: '/api/products',
    handler: ({ body, session }) => {
      const data = validateProduct(
        stripOwnerFields(stripPurchaseInput(body, session.role), session.role, null));
      const dup = db.prepare('SELECT id FROM products WHERE sku = ?').get(data.sku);
      if (dup) throw new ApiError(400, `Артикул «${data.sku}» уже существует`);
      // Артикул сканируется одним кодом и в кассе, и в инвентаризации,
      // поэтому не должен совпадать с артикулом комплекта.
      const dupSet = db.prepare('SELECT name FROM product_sets WHERE sku = ? COLLATE NOCASE').get(data.sku);
      if (dupSet) throw new ApiError(400, `Артикул «${data.sku}» занят комплектом «${dupSet.name}»`);
      /*
       * Изделие без точки продаж — вещь-невидимка: в общем складе оно есть,
       * а в остатках точки нет, и инвентаризация его никогда не найдёт, потому
       * что пересчёт всегда идёт по конкретной точке. Поэтому не указанную
       * точку подставляем сами — основную, как это давно делает импорт из 1С.
       */
      if (!data.store_id) {
        const def = db.prepare('SELECT id FROM stores ORDER BY is_default DESC, sort, id LIMIT 1').get();
        if (def) data.store_id = def.id;
      }
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
      const data = validateProduct(
        stripOwnerFields(stripPurchaseInput(body, session.role), session.role, existing),
        { partial: true, existing });
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
        db.prepare(`UPDATE products SET reserved_for = NULL, reserved_until = ''
                     WHERE id = ? AND status != ?`).run(id, 'reserved');
      }
      /*
       * Изделие возвращали поставщику, а теперь оно снова на витрине —
       * значит возврат не состоялся: снимаем строку из расчётов, иначе долг
       * так и остался бы уменьшенным при живом товаре на полке.
       */
      if (existing.status === 'written_off' && data.status && data.status !== 'written_off') {
        db.prepare(`DELETE FROM supplier_ops WHERE kind = 'return' AND product_id = ?`).run(id);
        db.prepare(`UPDATE products SET write_off_reason = '' WHERE id = ?`).run(id);
      }
      /*
       * В журнале «изменение изделия» ничего не говорит владельцу. Смена
       * статуса — резерв, списание, возврат на витрину — это поступок, а не
       * правка описания, поэтому пишем её отдельной строкой и с причиной.
       */
      if (data.status !== undefined && data.status !== existing.status) {
        const what = { reserved: 'резерв', in_stock: 'возврат на витрину', written_off: 'списание' };
        const who = data.reserved_for !== undefined ? data.reserved_for : existing.reserved_for;
        const forName = who
          ? (db.prepare('SELECT name FROM customers WHERE id = ?').get(who) || {}).name : '';
        const extra = [
          data.status === 'reserved' && forName ? `для ${forName}` : '',
          data.status === 'reserved' && (data.reserved_until || existing.reserved_until)
            ? `до ${data.reserved_until || existing.reserved_until}` : '',
          data.status === 'written_off' && (data.write_off_reason || existing.write_off_reason)
            ? `причина: ${data.write_off_reason || existing.write_off_reason}` : '',
        ].filter(Boolean).join(', ');
        audit(session.userId, 'status', 'product', id,
          `${existing.sku} ${existing.name} — ${what[data.status] || data.status}${extra ? ' (' + extra + ')' : ''}`);
      } else {
        audit(session.userId, 'update', 'product', id, `${existing.sku} ${existing.name}`);
      }
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
      const images = listImages(id);
      const certificates = listCertificates(id);
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      // Строки удалит каскад, а файлы — мы: и фотографии, и сканы сертификатов,
      // иначе data/images молча копит мусор от удалённых изделий.
      removeFiles([...images, ...certificates]);
      audit(session.userId, 'delete', 'product', id, `${existing.sku} ${existing.name}`);
      return { ok: true };
    },
  },
];

module.exports = { routes };
