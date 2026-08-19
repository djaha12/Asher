'use strict';
const { db, nowIso, round2, audit, transaction } = require('../db');
const { ApiError } = require('./util');

// ---------- Разбор CSV ----------

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.indexOf('\n') > -1 ? text.indexOf('\n') : text.length);
  const counts = [[';', 0], [',', 0], ['\t', 0]].map(([d]) => {
    let n = 0, inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) n++;
    }
    return [d, n];
  });
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some(f => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

/*
 * Разбор числа из выгрузки: «12 345,67», «12,345.67», «45 000 сом», «3,15».
 *
 * Формат зависит и от страны, и от того, чем сделан файл: 1С отдаёт русский
 * формат с запятой, Excel в английской локали — с точкой. Поэтому не полагаемся
 * на один вариант, а определяем разделитель дробной части по самой строке:
 * им считается последний из встретившихся знаков, если после него не ровно три
 * цифры. Три цифры — это разряды тысяч: «1,500» — это полторы тысячи, а не 1,5.
 */
function parseNumber(s) {
  if (s === undefined || s === null || s === '') return 0;
  // Убираем всё, что не цифра и не разделитель: подпись валюты отбрасывается,
  // какой бы она ни была — «сом», «₸», «₽», «$».
  let t = String(s).replace(/[^\d.,]/g, '');
  if (!t) return 0;

  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let sep = '';
  if (lastComma > -1 && lastDot > -1) {
    sep = lastComma > lastDot ? ',' : '.';   // что стоит позже, то и дробная часть
  } else if (lastComma > -1) {
    sep = /,\d{3}$/.test(t) ? '' : ',';
  } else if (lastDot > -1) {
    sep = /\.\d{3}$/.test(t) ? '' : '.';
  }

  if (sep) {
    const i = t.lastIndexOf(sep);
    t = t.slice(0, i).replace(/[.,]/g, '') + '.' + t.slice(i + 1).replace(/[.,]/g, '');
  } else {
    t = t.replace(/[.,]/g, '');
  }
  const v = Number(t);
  // Цены и веса не бывают отрицательными.
  return Number.isFinite(v) ? Math.max(v, 0) : 0;
}

// "31.12.1985" / "1985-12-31" → "1985-12-31"
function parseDate(s) {
  const t = String(s || '').trim();
  let iso = '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) iso = t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!iso) return '';
  // несуществующие даты («1985-99-99») отбрасываем
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const ok = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return ok ? iso : '';
}

// ---------- Автоматический маппинг колонок (типичные заголовки 1С) ----------

const PRODUCT_MAP_HINTS = {
  sku: ['артикул', 'арт', 'код товара', 'код'],
  name: ['наименование', 'номенклатура', 'название', 'товар'],
  barcode: ['штрихкод', 'штрих-код', 'шк'],
  category: ['категория', 'группа', 'вид номенклатуры', 'группа номенклатуры', 'тип'],
  metal: ['металл', 'сплав', 'цвет металла'],
  // Проба идёт отдельной колонкой: «Белое золото» + «750».
  fineness: ['проба', 'проба металла'],
  weight: ['вес', 'вес, г', 'масса'],
  size: ['размер', 'длина'],
  // Главный бриллиант: караты, цвет, чистота — по ним ищут и оценивают.
  carat: ['караты', 'карат', 'каратность', 'вес камня', 'ct'],
  color: ['цвет', 'цвет камня', 'цвет бриллианта'],
  clarity: ['чистота', 'чистота камня', 'качество'],
  gem_summary: ['вставка', 'вставки', 'камень', 'камни'],
  purchase_price: ['закупочная цена', 'цена закупки', 'закупка', 'себестоимость', 'цена поступления'],
  retail_price: ['розничная цена', 'цена продажи', 'цена', 'розница', 'стоимость'],
  description: ['описание', 'комментарий', 'примечание'],
};

const CUSTOMER_MAP_HINTS = {
  name: ['наименование', 'фио', 'ф.и.о', 'имя', 'клиент', 'контрагент', 'полное наименование'],
  phone: ['телефон', 'тел', 'номер телефона', 'моб'],
  email: ['e-mail', 'email', 'почта', 'эл. почта', 'электронная почта'],
  birthday: ['дата рождения', 'день рождения', 'др'],
  discount: ['скидка', 'скидка %', 'процент скидки'],
  notes: ['комментарий', 'примечание', 'заметки', 'описание'],
};

function suggestMapping(headers, hints) {
  const mapping = {};
  const lower = headers.map(h => String(h || '').trim().toLowerCase());
  for (const [field, variants] of Object.entries(hints)) {
    let found = -1;
    for (const v of variants) {
      found = lower.findIndex((h, i) => h === v && !Object.values(mapping).includes(i));
      if (found === -1) found = lower.findIndex((h, i) => h.includes(v) && !Object.values(mapping).includes(i));
      if (found !== -1) break;
    }
    if (found !== -1) mapping[field] = found;
  }
  return mapping;
}

function pick(row, mapping, field) {
  const idx = mapping[field];
  if (idx === undefined || idx === null || idx === '') return undefined;
  return String(row[Number(idx)] ?? '').trim();
}

// ---------- CSV-экспорт ----------

function toCsv(headers, rows) {
  const esc = v => {
    let s = String(v ?? '');
    /*
     * Excel считает формулой всё, что начинается с «=», «+», «−» или «@».
     * Название изделия приходит от людей и из 1С, поэтому в выгрузке такая
     * строка выполнилась бы у того, кто её открыл. Ставим апостроф — Excel
     * показывает текст как есть и ничего не вычисляет.
     */
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(';')];
  for (const r of rows) lines.push(r.map(esc).join(';'));
  return '﻿' + lines.join('\r\n'); // BOM + ; — чтобы Excel открывал сразу корректно
}

function csvResponse(res, filename, content) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(content);
}

/*
 * Импорт CSV — общая функция для ручного импорта со страницы
 * и для автообмена с 1С (папка «1С-ОБМЕН»).
 */
function importCsv(body, userId) {
  const csv = String(body.csv || '');
  const entity = body.entity === 'customers' ? 'customers' : 'products';
  const mapping = body.mapping || {};
  const delimiter = body.delimiter || detectDelimiter(csv);
  const rows = parseCsv(csv, delimiter).slice(1);
  if (!rows.length) throw new ApiError(400, 'Нет строк для импорта');

  /*
   * Режим прайс-листа: в файле только артикулы и цены, наименований нет.
   * Так выглядит обычная переоценка — список «что почём» без описаний.
   * В этом режиме ничего не создаётся: цены проставляются существующим
   * изделиям по артикулу, а неизвестные артикулы попадают в отчёт.
   * Создавать изделие без названия нельзя — в каталоге останется пустая плитка.
   */
  const priceOnly = entity === 'products' && mapping.name === undefined;
  if (!priceOnly && mapping.name === undefined) {
    throw new ApiError(400, 'Не указана колонка с наименованием');
  }
  if (priceOnly) {
    if (mapping.sku === undefined) {
      throw new ApiError(400,
        'В файле нет ни наименований, ни артикулов. Нужна хотя бы колонка «Артикул» и колонка с ценой.');
    }
    if (mapping.retail_price === undefined && mapping.purchase_price === undefined) {
      throw new ApiError(400, 'Не найдена колонка с ценой — обновлять нечего.');
    }
  }

  // Режим повторной выгрузки: совпавшие по артикулу позиции не пропускаем,
  // а обновляем — цены и наименования в 1С меняются, и подгружать их
  // должно быть так же просто, как загрузить в первый раз.
  // Прайс-лист по смыслу всегда обновляет уже заведённые изделия.
  const updateExisting = priceOnly || Boolean(body.update_existing);
  // Какие поля разрешено перезаписывать. По умолчанию — только цены:
  // название и категорию в системе часто правят руками под витрину.
  const updateFields = Array.isArray(body.update_fields) && body.update_fields.length
    ? body.update_fields
    : ['purchase_price', 'retail_price'];

  const errors = [];
  let created = 0, skipped = 0, updated = 0, unchanged = 0;

  transaction(() => {
    if (entity === 'products') {
      const catCache = new Map(
        db.prepare('SELECT id, name FROM categories').all().map(c => [c.name.toLowerCase(), c.id])
      );
      const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, 999)');
      const skuExists = db.prepare('SELECT 1 FROM products WHERE sku = ?');
      const findBySku = db.prepare('SELECT * FROM products WHERE sku = ?');
      // Импортированный товар кладём на выбранную точку (по умолчанию — основную),
      // иначе он не попадёт ни в остатки точки, ни в инвентаризацию.
      const targetStore = body.store_id
        ? Number(body.store_id)
        : (db.prepare('SELECT id FROM stores ORDER BY is_default DESC, sort, id LIMIT 1').get() || {}).id || null;
      const ins = db.prepare(
        `INSERT INTO products (sku, barcode, name, category_id, metal, fineness, weight, size,
           carat, color, clarity, gem_summary,
           purchase_price, retail_price, description, store_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'in_stock', ?)`
      );
      let autoSku = Number(db.prepare('SELECT COUNT(*) AS c FROM products').get().c) + 1;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = pick(row, mapping, 'name');
        if (!priceOnly && !name) {
          errors.push(`Строка ${i + 2}: пустое наименование — пропущена`); skipped++; continue;
        }
        let sku = pick(row, mapping, 'sku') || '';
        if (!sku) {
          // В прайс-листе артикул — единственная связь со складом: без него
          // непонятно, чему ставить цену, и придумывать новый нельзя.
          if (priceOnly) {
            errors.push(`Строка ${i + 2}: пустой артикул — пропущена`); skipped++; continue;
          }
          do { sku = `IMP-${String(autoSku++).padStart(5, '0')}`; } while (skuExists.get(sku));
        }
        const existing = findBySku.get(sku);
        if (priceOnly && !existing) {
          errors.push(`Строка ${i + 2}: артикул «${sku}» не найден в каталоге — цена не проставлена`);
          skipped++;
          continue;
        }
        if (existing && !updateExisting) {
          errors.push(`Строка ${i + 2}: артикул «${sku}» уже есть — пропущена`);
          skipped++;
          continue;
        }

        let categoryId = null;
        const catName = pick(row, mapping, 'category');
        if (catName) {
          const key = catName.toLowerCase();
          if (!catCache.has(key)) {
            const info = insCat.run(catName);
            catCache.set(key, Number(info.lastInsertRowid));
          }
          categoryId = catCache.get(key);
        }

        if (existing) {
          // Проданное и списанное не трогаем: у него своя история и цена продажи.
          // Но молча пропускать нельзя — иначе в отчёте «пропущено 5» без причины.
          if (existing.status === 'sold' || existing.status === 'written_off') {
            errors.push(`Строка ${i + 2}: «${sku}» ${existing.status === 'sold' ? 'продано' : 'списано'}` +
              ' — цену не меняем, у него своя история');
            skipped++;
            continue;
          }
          const next = {};
          const candidate = {
            name,
            barcode: pick(row, mapping, 'barcode'),
            category_id: catName ? categoryId : undefined,
            metal: pick(row, mapping, 'metal'),
            fineness: pick(row, mapping, 'fineness'),
            weight: mapping.weight !== undefined ? parseNumber(pick(row, mapping, 'weight')) : undefined,
            size: pick(row, mapping, 'size'),
            carat: mapping.carat !== undefined ? parseNumber(pick(row, mapping, 'carat')) : undefined,
            color: (pick(row, mapping, 'color') || '').toUpperCase() || undefined,
            clarity: (pick(row, mapping, 'clarity') || '').toUpperCase() || undefined,
            gem_summary: pick(row, mapping, 'gem_summary'),
            purchase_price: mapping.purchase_price !== undefined
              ? round2(parseNumber(pick(row, mapping, 'purchase_price'))) : undefined,
            retail_price: mapping.retail_price !== undefined
              ? round2(parseNumber(pick(row, mapping, 'retail_price'))) : undefined,
            description: pick(row, mapping, 'description'),
          };
          for (const field of updateFields) {
            const value = candidate[field];
            if (value === undefined || value === '') continue;
            if (existing[field] === value) continue;
            next[field] = value;
          }
          const fields = Object.keys(next);
          if (!fields.length) { unchanged++; continue; }
          db.prepare(`UPDATE products SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
            .run(...fields.map(f => next[f]), existing.id);
          updated++;
          continue;
        }

        ins.run(sku, pick(row, mapping, 'barcode') || '', name, categoryId,
          pick(row, mapping, 'metal') || '', pick(row, mapping, 'fineness') || '',
          parseNumber(pick(row, mapping, 'weight')), pick(row, mapping, 'size') || '',
          parseNumber(pick(row, mapping, 'carat')),
          (pick(row, mapping, 'color') || '').toUpperCase(),
          (pick(row, mapping, 'clarity') || '').toUpperCase(),
          pick(row, mapping, 'gem_summary') || '',
          round2(parseNumber(pick(row, mapping, 'purchase_price'))),
          round2(parseNumber(pick(row, mapping, 'retail_price'))),
          pick(row, mapping, 'description') || '', targetStore, nowIso());
        created++;
      }
    } else {
      const phoneExists = db.prepare(`SELECT 1 FROM customers WHERE phone = ? AND phone != ''`);
      const ins = db.prepare(
        `INSERT INTO customers (name, phone, email, birthday, discount, notes, created_at)
         VALUES (?,?,?,?,?,?,?)`
      );
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = pick(row, mapping, 'name');
        if (!name) { errors.push(`Строка ${i + 2}: пустое имя — пропущена`); skipped++; continue; }
        const phone = pick(row, mapping, 'phone') || '';
        if (phone && phoneExists.get(phone)) {
          errors.push(`Строка ${i + 2}: клиент с телефоном ${phone} уже есть — пропущена`);
          skipped++; continue;
        }
        const discount = Math.min(Math.max(parseNumber(pick(row, mapping, 'discount')), 0), 100);
        ins.run(name, phone, pick(row, mapping, 'email') || '',
          parseDate(pick(row, mapping, 'birthday')), discount,
          pick(row, mapping, 'notes') || '', nowIso());
        created++;
      }
    }
  });

  audit(userId, 'import', String(body.entity === 'customers' ? 'customers' : 'products'), null,
    `Импорт: ${created} создано, ${updated} обновлено, ${skipped} пропущено`);
  return { created, updated, unchanged, skipped, errors: errors.slice(0, 50) };
}

// ---------- Маршруты ----------

const routes = [
  {
    method: 'POST', path: '/api/import/preview', admin: true,
    handler: ({ body }) => {
      const csv = String(body.csv || '');
      if (!csv.trim()) throw new ApiError(400, 'Файл пустой');
      const entity = body.entity === 'customers' ? 'customers' : 'products';
      const delimiter = body.delimiter || detectDelimiter(csv);
      const rows = parseCsv(csv, delimiter);
      if (rows.length < 2) throw new ApiError(400, 'В файле нет данных (нужна строка заголовков и хотя бы одна строка данных)');
      const headers = rows[0].map(h => String(h).trim());
      const hints = entity === 'customers' ? CUSTOMER_MAP_HINTS : PRODUCT_MAP_HINTS;
      return {
        headers,
        delimiter,
        total_rows: rows.length - 1,
        preview: rows.slice(1, 11),
        suggested_mapping: suggestMapping(headers, hints),
        fields: Object.keys(hints),
      };
    },
  },
  {
    method: 'POST', path: '/api/import/commit', admin: true,
    handler: ({ body, session }) => importCsv(body, session.userId),
  },

  {
    method: 'GET', path: '/api/export/products', admin: true, raw: true,
    handler: ({ res }) => {
      const rows = db.prepare(
        `SELECT p.sku, p.barcode, p.name, c.name AS category, p.metal, p.fineness, p.weight, p.size,
                p.carat, p.color, p.clarity, p.gem_summary,
                p.purchase_price, p.retail_price, p.status, p.location, p.created_at
         FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id`
      ).all();
      const statusRu = { in_stock: 'В наличии', reserved: 'Резерв', sold: 'Продано', written_off: 'Списано' };
      csvResponse(res, 'изделия.csv', toCsv(
        ['Артикул', 'Штрихкод', 'Наименование', 'Категория', 'Металл', 'Проба', 'Вес', 'Размер',
          'Караты', 'Цвет', 'Чистота', 'Вставки',
          'Закупочная цена', 'Розничная цена', 'Статус', 'Расположение', 'Дата создания'],
        rows.map(r => [r.sku, r.barcode, r.name, r.category || '', r.metal, r.fineness, r.weight, r.size,
          r.carat || '', r.color, r.clarity, r.gem_summary,
          r.purchase_price, r.retail_price, statusRu[r.status] || r.status, r.location, r.created_at])
      ));
    },
  },
  {
    method: 'GET', path: '/api/export/customers', admin: true, raw: true,
    handler: ({ res }) => {
      const rows = db.prepare(
        `SELECT c.*, (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.customer_id = c.id AND s.status != 'returned') AS total_spent
         FROM customers c ORDER BY c.id`
      ).all();
      csvResponse(res, 'клиенты.csv', toCsv(
        ['Имя', 'Телефон', 'E-mail', 'Дата рождения', 'Скидка %', 'Сумма покупок', 'Заметки'],
        rows.map(r => [r.name, r.phone, r.email, r.birthday, r.discount, r.total_spent, r.notes])
      ));
    },
  },
  {
    method: 'GET', path: '/api/export/sales', admin: true, raw: true,
    handler: ({ res }) => {
      const rows = db.prepare(
        `SELECT s.number, s.created_at, c.name AS customer, u.name AS seller, s.subtotal, s.discount_total,
                s.total, s.payment_method, s.status
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.created_at`
      ).all();
      const payRu = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', installment: 'Рассрочка' };
      const stRu = { completed: 'Завершена', partial_return: 'Частичный возврат', returned: 'Возврат' };
      csvResponse(res, 'продажи.csv', toCsv(
        ['Номер', 'Дата', 'Клиент', 'Продавец', 'Сумма', 'Скидка', 'Итого', 'Оплата', 'Статус'],
        rows.map(r => [r.number, r.created_at, r.customer || '', r.seller || '', r.subtotal,
          r.discount_total, r.total, payRu[r.payment_method] || r.payment_method, stRu[r.status] || r.status])
      ));
    },
  },
];

module.exports = { routes, importCsv, parseCsv, detectDelimiter, suggestMapping, PRODUCT_MAP_HINTS };
