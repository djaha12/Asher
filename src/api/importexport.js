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

// "12 345,67" / "12345.67" → 12345.67
function parseNumber(s) {
  if (s === undefined || s === null) return 0;
  const cleaned = String(s).replace(/[\s ₽руб.]/gi, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  return Math.max(Number(cleaned) || 0, 0); // цены и веса не бывают отрицательными
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
  metal: ['металл', 'проба', 'сплав'],
  weight: ['вес', 'вес, г', 'масса'],
  size: ['размер', 'длина'],
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
    const s = String(v ?? '');
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
    handler: ({ body, session }) => {
      const csv = String(body.csv || '');
      const entity = body.entity === 'customers' ? 'customers' : 'products';
      const mapping = body.mapping || {};
      const delimiter = body.delimiter || detectDelimiter(csv);
      const rows = parseCsv(csv, delimiter).slice(1);
      if (!rows.length) throw new ApiError(400, 'Нет строк для импорта');
      if (mapping.name === undefined) throw new ApiError(400, 'Не указана колонка с наименованием');

      const errors = [];
      let created = 0, skipped = 0;

      transaction(() => {
        if (entity === 'products') {
          const catCache = new Map(
            db.prepare('SELECT id, name FROM categories').all().map(c => [c.name.toLowerCase(), c.id])
          );
          const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, 999)');
          const skuExists = db.prepare('SELECT 1 FROM products WHERE sku = ?');
          const ins = db.prepare(
            `INSERT INTO products (sku, barcode, name, category_id, metal, weight, size, gem_summary,
               purchase_price, retail_price, description, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?, 'in_stock', ?)`
          );
          let autoSku = Number(db.prepare('SELECT COUNT(*) AS c FROM products').get().c) + 1;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const name = pick(row, mapping, 'name');
            if (!name) { errors.push(`Строка ${i + 2}: пустое наименование — пропущена`); skipped++; continue; }
            let sku = pick(row, mapping, 'sku') || '';
            if (!sku) {
              do { sku = `IMP-${String(autoSku++).padStart(5, '0')}`; } while (skuExists.get(sku));
            }
            if (skuExists.get(sku)) { errors.push(`Строка ${i + 2}: артикул «${sku}» уже есть — пропущена`); skipped++; continue; }
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
            ins.run(sku, pick(row, mapping, 'barcode') || '', name, categoryId,
              pick(row, mapping, 'metal') || '', parseNumber(pick(row, mapping, 'weight')),
              pick(row, mapping, 'size') || '', pick(row, mapping, 'gem_summary') || '',
              round2(parseNumber(pick(row, mapping, 'purchase_price'))),
              round2(parseNumber(pick(row, mapping, 'retail_price'))),
              pick(row, mapping, 'description') || '', nowIso());
            created++;
          }
        } else {
          const phoneExists = db.prepare(`SELECT 1 FROM customers WHERE phone = ? AND phone != ''`);
          const ins = db.prepare(
            `INSERT INTO customers (name, phone, email, birthday, discount, notes, segment, created_at)
             VALUES (?,?,?,?,?,?, 'new', ?)`
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

      audit(session.userId, 'import', entity, null, `Импорт: ${created} создано, ${skipped} пропущено`);
      return { created, skipped, errors: errors.slice(0, 50) };
    },
  },

  {
    method: 'GET', path: '/api/export/products', admin: true, raw: true,
    handler: ({ res }) => {
      const rows = db.prepare(
        `SELECT p.sku, p.barcode, p.name, c.name AS category, p.metal, p.weight, p.size, p.gem_summary,
                p.purchase_price, p.retail_price, p.status, p.location, p.created_at
         FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id`
      ).all();
      const statusRu = { in_stock: 'В наличии', reserved: 'Резерв', sold: 'Продано', written_off: 'Списано' };
      csvResponse(res, 'изделия.csv', toCsv(
        ['Артикул', 'Штрихкод', 'Наименование', 'Категория', 'Металл', 'Вес', 'Размер', 'Вставки',
          'Закупочная цена', 'Розничная цена', 'Статус', 'Расположение', 'Дата создания'],
        rows.map(r => [r.sku, r.barcode, r.name, r.category || '', r.metal, r.weight, r.size, r.gem_summary,
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
      const segRu = { new: 'Новый', regular: 'Постоянный', vip: 'VIP' };
      csvResponse(res, 'клиенты.csv', toCsv(
        ['Имя', 'Телефон', 'E-mail', 'Дата рождения', 'Сегмент', 'Скидка %', 'Бонусы', 'Сумма покупок', 'Заметки'],
        rows.map(r => [r.name, r.phone, r.email, r.birthday, segRu[r.segment] || r.segment,
          r.discount, r.bonus_points, r.total_spent, r.notes])
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

module.exports = { routes };
