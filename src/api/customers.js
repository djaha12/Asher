'use strict';
const { db, nowIso, round2, audit, getSetting, видитВсё } = require('../db');
const { ApiError } = require('./util');
const { SOURCES } = require('../customer-sources');
const { normalizePhone } = require('../locale');

/*
 * Один и тот же телефон записывают по-разному: «0555 12-34-56»,
 * «+996 555 123456», «555123456». Сравниваем номера в одном виде —
 * с кодом страны, как их понимает WhatsApp.
 */
function телефон(raw) {
  return normalizePhone(raw, {
    phone_code: getSetting('phone_code'),
    phone_trunk: getSetting('phone_trunk'),
    phone_length: getSetting('phone_length'),
  });
}

/*
 * Клиент с тем же номером. Дубли — не мелочь: у двух записей одного
 * человека история покупок, личная скидка и долг расходятся по двум
 * карточкам, и продавец видит только половину.
 */
function найтиДубль(phone, кромеId = 0) {
  const н = телефон(phone);
  if (!н) return null;
  const хвост = н.slice(-7);
  const кандидаты = db.prepare(
    `SELECT id, name, phone FROM customers WHERE id != ? AND digits(phone) LIKE ?`
  ).all(кромеId, `%${хвост}`);
  return кандидаты.find(r => телефон(r.phone) === н) || null;
}

function отказЗаДубль(дубль) {
  throw new ApiError(409, `Этот номер уже записан у клиента «${дубль.name}»`,
    { existing: { id: дубль.id, name: дубль.name, phone: дубль.phone } });
}

const FIELDS = ['name', 'phone', 'email', 'birthday', 'anniversary', 'discount',
  'ring_size', 'preferences', 'notes', 'source'];

// «2020-13-45» не пройдёт: проверяем, что дата существует в календаре
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/*
 * Личная скидка клиента поднимает предел скидки в кассе — иначе продавцу
 * пришлось бы звать владельца при каждой продаже постоянному покупателю.
 * Отсюда следует обратное: сам продавец не может назначить личную скидку
 * выше общего предела. Иначе потолок в кассе обходился бы за десять секунд —
 * завести клиента «Иван» со скидкой 90% и продать ему.
 */
function validateCustomer(body, { partial = false, role = 'owner' } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || '').trim();
    if (!out.name) throw new ApiError(400, 'Имя клиента обязательно');
  }
  for (const f of ['phone', 'email', 'birthday', 'anniversary', 'ring_size', 'preferences', 'notes']) {
    if (body[f] !== undefined) out[f] = String(body[f] || '').trim();
  }
  for (const f of ['birthday', 'anniversary']) {
    if (out[f] && !isValidDate(out[f])) {
      throw new ApiError(400, 'Дата должна быть реальной датой в формате ГГГГ-ММ-ДД');
    }
  }
  // Только из списка: слово, набранное как попало, рассыпало бы аналитику
  // на «инста», «Инстаграм» и «Instagram». Пусто — значит «не отмечено».
  if (body.source !== undefined) {
    out.source = String(body.source || '').trim();
    if (out.source && !Object.hasOwn(SOURCES, out.source)) {
      throw new ApiError(400, 'Неизвестно, откуда пришёл клиент: выберите из списка');
    }
  }
  if (body.discount !== undefined) {
    out.discount = round2(body.discount);
    if (out.discount < 0 || out.discount > 100) throw new ApiError(400, 'Скидка должна быть от 0 до 100%');
    if (!видитВсё(role)) {
      const предел = Number(getSetting('max_discount_percent'));
      const потолок = Number.isFinite(предел) && предел >= 0 && предел <= 100 ? предел : 15;
      if (out.discount > потолок) {
        throw new ApiError(400,
          `Личную скидку больше ${потолок}% назначает владелец.`);
      }
    }
  }
  return out;
}

// статистика по фактически оплаченным позициям (возвраты не считаются)
const STATS_SQL = `
  SELECT COUNT(DISTINCT s.id) AS purchases, COALESCE(SUM(si.final_price), 0) AS total_spent,
         MAX(s.created_at) AS last_purchase
  FROM sales s JOIN sale_items si ON si.sale_id = s.id
  WHERE s.customer_id = ? AND si.returned = 0`;

const routes = [
  {
    method: 'GET', path: '/api/customers',
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.search) {
        /*
         * Номер ищут как набрали: «0555123456» должен находить «0555 12-34-56»
         * и «+996 555 123456». Сравниваем голые цифры и заодно вариант без
         * местной приставки — «0555…» и «996555…» это один телефон.
         */
        const s = `%${String(query.search).toLowerCase()}%`;
        const цифры = String(query.search).replace(/\D/g, '');
        const безПриставки = цифры.length > 3 && цифры.startsWith('0') ? цифры.slice(1) : цифры;
        cond.push(`(nlower(c.name) LIKE ? OR nlower(c.email) LIKE ?
          OR (LENGTH(?) >= 3 AND (digits(c.phone) LIKE ? OR digits(c.phone) LIKE ?)))`);
        args.push(s, s, цифры, `%${цифры}%`, `%${безПриставки}%`);
      }
      // «none» — клиенты, у которых источник не отмечен
      if (query.source === 'none') cond.push(`c.source = ''`);
      else if (Object.hasOwn(SOURCES, query.source || '')) {
        cond.push('c.source = ?');
        args.push(query.source);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT c.*,
           (SELECT COUNT(DISTINCT s.id) FROM sales s JOIN sale_items si ON si.sale_id = s.id
             WHERE s.customer_id = c.id AND si.returned = 0) AS purchases,
           (SELECT COALESCE(SUM(si.final_price), 0) FROM sales s JOIN sale_items si ON si.sale_id = s.id
             WHERE s.customer_id = c.id AND si.returned = 0) AS total_spent
         FROM customers c ${where} ORDER BY total_spent DESC, c.name LIMIT 1000`
      ).all(...args);
      return { items: rows };
    },
  },
  {
    method: 'GET', path: '/api/customers/birthdays',
    handler: ({ query }) => {
      // ближайшие дни рождения и годовщины в окне N дней (по локальной дате клиента)
      const days = Math.min(Number(query.days) || 30, 366);
      const today = query.today && /^\d{4}-\d{2}-\d{2}$/.test(query.today)
        ? query.today : new Date().toISOString().slice(0, 10);
      const rows = db.prepare(
        `SELECT id, name, phone, birthday, anniversary FROM customers
         WHERE birthday != '' OR anniversary != ''`
      ).all();
      const base = new Date(today + 'T00:00:00Z');
      const upcoming = [];
      for (const r of rows) {
        for (const [kind, dateStr] of [['birthday', r.birthday], ['anniversary', r.anniversary]]) {
          if (!dateStr) continue;
          const [, m, d] = dateStr.split('-').map(Number);
          let next = new Date(Date.UTC(base.getUTCFullYear(), m - 1, d));
          if (next < base) next = new Date(Date.UTC(base.getUTCFullYear() + 1, m - 1, d));
          const diff = Math.round((next - base) / 86400000);
          if (diff <= days) {
            upcoming.push({ id: r.id, name: r.name, phone: r.phone,
              kind, date: next.toISOString().slice(0, 10), in_days: diff });
          }
        }
      }
      upcoming.sort((a, b) => a.in_days - b.in_days);
      return { items: upcoming };
    },
  },
  {
    /*
     * Поводы связаться — не только дни рождения. После покупки через пару
     * дней — «спасибо, если что — пишите»; через полгода — пригласить
     * почистить изделие и проверить закрепку камней. Так покупатель
     * возвращается, а продавцу не надо помнить, кто и когда покупал.
     *
     * Кому уже написали (любой продавец, с любого телефона) — из списка
     * пропадает: иначе одно «спасибо» уходило бы дважды.
     */
    method: 'GET', path: '/api/customers/occasions',
    handler: ({ query }) => {
      const days = Math.min(Number(query.days) || 14, 60);
      const today = query.today && /^\d{4}-\d{2}-\d{2}$/.test(query.today)
        ? query.today : new Date().toISOString().slice(0, 10);
      const base = new Date(today + 'T00:00:00Z');
      const деньНазад = n => new Date(base.getTime() - n * 86400000).toISOString().slice(0, 10);
      const написали = db.prepare(
        'SELECT 1 FROM customer_contacts WHERE customer_id = ? AND kind = ? AND ref = ?');
      const items = [];

      for (const r of db.prepare(
        `SELECT id, name, phone, birthday, anniversary FROM customers WHERE birthday != '' OR anniversary != ''`
      ).all()) {
        for (const [kind, dateStr] of [['birthday', r.birthday], ['anniversary', r.anniversary]]) {
          if (!dateStr) continue;
          const [, m, d] = dateStr.split('-').map(Number);
          let next = new Date(Date.UTC(base.getUTCFullYear(), m - 1, d));
          if (next < base) next = new Date(Date.UTC(base.getUTCFullYear() + 1, m - 1, d));
          const inDays = Math.round((next - base) / 86400000);
          const date = next.toISOString().slice(0, 10);
          if (inDays > days || написали.get(r.id, kind, date)) continue;
          items.push({ id: r.id, name: r.name, phone: r.phone, kind, date, ref: date, in_days: inDays });
        }
      }

      // Последняя покупка клиента в окне — одна строка на человека.
      const покупки = (от, до) => db.prepare(
        `SELECT c.id, c.name, c.phone, s.number, substr(s.created_at, 1, 10) AS date
         FROM sales s JOIN customers c ON c.id = s.customer_id
         WHERE s.status != 'returned' AND substr(s.created_at, 1, 10) BETWEEN ? AND ?
           AND s.created_at = (SELECT MAX(s2.created_at) FROM sales s2
                               WHERE s2.customer_id = c.id AND s2.status != 'returned')
         ORDER BY s.created_at DESC`
      ).all(от, до);
      for (const r of покупки(деньНазад(5), деньНазад(1))) {
        if (!написали.get(r.id, 'thanks', r.number)) {
          items.push({ id: r.id, name: r.name, phone: r.phone, kind: 'thanks', date: r.date, ref: r.number, sale_number: r.number });
        }
      }
      for (const r of покупки(деньНазад(194), деньНазад(180))) {
        if (!написали.get(r.id, 'cleaning', r.number)) {
          items.push({ id: r.id, name: r.name, phone: r.phone, kind: 'cleaning', date: r.date, ref: r.number, sale_number: r.number });
        }
      }

      // Сегодняшние праздники — первыми, потом «спасибо» и «чистка», потом
      // ближайшие праздники: сегодняшнее упустить нельзя, будущее подождёт.
      const порядок = x => (x.in_days === 0 ? 0 : x.kind === 'thanks' ? 1 : x.kind === 'cleaning' ? 2 : 3);
      items.sort((a, b) => порядок(a) - порядок(b) || (a.in_days || 0) - (b.in_days || 0));
      return { items };
    },
  },
  {
    method: 'POST', path: '/api/customers/:id/contacted',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new ApiError(404, 'Клиент не найден');
      const kind = String(body.kind || '');
      if (!['birthday', 'anniversary', 'thanks', 'cleaning'].includes(kind)) throw new ApiError(400, 'Неизвестный повод');
      const ref = String(body.ref || '').slice(0, 40);
      if (!db.prepare('SELECT 1 FROM customer_contacts WHERE customer_id = ? AND kind = ? AND ref = ?').get(id, kind, ref)) {
        db.prepare(`INSERT INTO customer_contacts (customer_id, kind, ref, user_id, created_at) VALUES (?,?,?,?,?)`)
          .run(id, kind, ref, session.userId, nowIso());
      }
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/api/customers/:id/wishes',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(id);
      if (!c) throw new ApiError(404, 'Клиент не найден');
      const text = String(body.text || '').trim();
      if (!text) throw new ApiError(400, 'Напишите, чего хочет клиент');
      if (text.length > 300) throw new ApiError(400, 'Слишком длинно — хватит пары строк');
      const info = db.prepare(
        'INSERT INTO customer_wishes (customer_id, text, user_id, created_at) VALUES (?,?,?,?)'
      ).run(id, text, session.userId, nowIso());
      audit(session.userId, 'update', 'customer', id, `${c.name}: хочет «${text}»`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'DELETE', path: '/api/customers/:id/wishes/:wid',
    handler: ({ params, session }) => {
      const w = db.prepare('SELECT * FROM customer_wishes WHERE id = ? AND customer_id = ?')
        .get(Number(params.wid), Number(params.id));
      if (!w) throw new ApiError(404, 'Такого желания нет');
      db.prepare('DELETE FROM customer_wishes WHERE id = ?').run(w.id);
      audit(session.userId, 'update', 'customer', w.customer_id, `желание снято: «${w.text}»`);
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/api/customers/:id',
    handler: ({ params }) => {
      const id = Number(params.id);
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!c) throw new ApiError(404, 'Клиент не найден');
      const stats = db.prepare(STATS_SQL).get(id);
      const sales = db.prepare(
        `SELECT s.id, s.number, s.total, s.status, s.payment_method, s.created_at, u.name AS seller_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count
         FROM sales s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 200`
      ).all(id);
      const items = db.prepare(
        `SELECT si.final_price, si.returned, s.created_at, p.name, p.sku, p.metal, p.gem_summary
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 200`
      ).all(id);
      const orders = db.prepare(
        `SELECT id, number, type, status, final_price, estimate, accepted_at FROM service_orders
         WHERE customer_id = ? ORDER BY accepted_at DESC LIMIT 100`
      ).all(id);
      const reserved = db.prepare(
        `SELECT id, sku, name, retail_price FROM products WHERE reserved_for = ? AND status = 'reserved'`
      ).all(id);
      const wishes = db.prepare(
        `SELECT w.id, w.text, w.created_at, u.name AS user_name FROM customer_wishes w
         LEFT JOIN users u ON u.id = w.user_id WHERE w.customer_id = ? ORDER BY w.id DESC`
      ).all(id);
      return { ...c, stats, sales, items, orders, reserved, wishes };
    },
  },
  {
    method: 'POST', path: '/api/customers',
    handler: ({ body, session }) => {
      const data = validateCustomer(body, { role: session.role });
      // «Всё равно завести» — осознанный выбор: бывают общий номер семьи
      // или рабочий телефон секретаря.
      if (data.phone && body.allow_duplicate !== true) {
        const дубль = найтиДубль(data.phone);
        if (дубль) отказЗаДубль(дубль);
      }
      const fields = FIELDS.filter(f => data[f] !== undefined);
      const info = db.prepare(
        `INSERT INTO customers (${fields.join(',')}, created_at) VALUES (${fields.map(() => '?').join(',')}, ?)`
      ).run(...fields.map(f => data[f]), nowIso());
      audit(session.userId, 'create', 'customer', Number(info.lastInsertRowid), data.name);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/customers/:id',
    handler: ({ params, body, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Клиент не найден');
      const data = validateCustomer(body, { partial: true, role: session.role });
      if (data.phone && телефон(data.phone) !== телефон(existing.phone) && body.allow_duplicate !== true) {
        const дубль = найтиДубль(data.phone, id);
        if (дубль) отказЗаДубль(дубль);
      }
      const fields = FIELDS.filter(f => data[f] !== undefined);
      if (!fields.length) return { ok: true };
      db.prepare(`UPDATE customers SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...fields.map(f => data[f]), id);
      audit(session.userId, 'update', 'customer', id, existing.name);
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/api/customers/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!existing) throw new ApiError(404, 'Клиент не найден');
      const hasSales = db.prepare('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(id);
      if (hasSales) throw new ApiError(400, 'У клиента есть история покупок — удалить нельзя.');
      const hasOrders = db.prepare('SELECT 1 FROM service_orders WHERE customer_id = ? LIMIT 1').get(id);
      if (hasOrders) throw new ApiError(400, 'У клиента есть заказы или ремонт — удалить нельзя.');
      // резервы за клиентом освобождаем, чтобы изделия не зависли
      db.prepare(`UPDATE products SET status = 'in_stock', reserved_for = NULL, reserved_until = ''
                  WHERE reserved_for = ? AND status = 'reserved'`).run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'customer', id, existing.name);
      return { ok: true };
    },
  },
];

module.exports = { routes };
