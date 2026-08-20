'use strict';
const { db, nowIso, round2, audit } = require('../db');
const { ApiError } = require('./util');

const DEFAULT_EXPENSE_CATS = ['Закупка товара', 'Оплата поставщику', 'Аренда', 'Зарплата', 'Налоги',
  'Коммунальные услуги', 'Реклама', 'Охрана', 'Банковские услуги', 'Прочие расходы'];
const DEFAULT_INCOME_CATS = ['Продажа', 'Погашение долга', 'Оплата заказа', 'Прочие доходы'];


/*
 * ---------- Постоянные расходы ----------
 *
 * Аренда и зарплата — главные расходы магазина, и они одинаковые из месяца
 * в месяц. Именно поэтому про них забывают: сумма известна, срок известен,
 * а напомнить некому. Забытый расход не безобиден — он завышает прибыль
 * в отчёте, и владелец весь месяц считает, что заработал больше.
 *
 * Система их НЕ создаёт сама, и это решение осознанное. Сумма почти всегда
 * чуть другая: премия, неполный месяц, выросла аренда. Записать за владельца
 * деньги, которых он не подтверждал, значит положить в отчёт операцию,
 * которой не было. Поэтому система напоминает и подставляет сумму,
 * а нажимает человек.
 */

// Суммы расходов этой категории (и этого сотрудника) за месяц.
function платежиЗаМесяц(правило, месяц) {
  return db.prepare(
    `SELECT amount FROM finance_ops
      WHERE type = 'expense' AND category = ?
        AND strftime('%Y-%m', created_at) = ?
        AND (? IS NULL OR employee_id = ?)
      ORDER BY created_at`
  ).all(правило.category, месяц, правило.employee_id, правило.employee_id)
    .map(с => round2(с.amount));
}

/*
 * Какие из правил одной категории уже оплачены.
 *
 * Считать «есть хоть один расход такой категории — значит записано» нельзя,
 * и это выяснилось на живом примере: аренда двух точек, 12 000 и 8 000.
 * Заплатили за первую — напоминание про вторую исчезало навсегда, а восемь
 * тысяч расхода тихо оставались неучтёнными и завышали прибыль. Ровно то,
 * ради чего раздел и делался.
 *
 * Поэтому сопоставляем платежи с правилами поштучно. Сначала по сумме:
 * платёж 12 000 закрывает правило на 12 000, а не то, что стояло первым
 * в списке. Что не совпало по сумме — гасит оставшиеся правила по порядку:
 * сумма почти всегда чуть другая, и требовать точного совпадения значило бы
 * напоминать про уже оплаченное.
 */
function закрытыеПравила(правила, месяц) {
  const закрыто = new Set();
  const свободные = платежиЗаМесяц(правила[0], месяц);
  const ждут = [...правила];

  // Первый проход — точные совпадения по сумме.
  for (const п of правила) {
    const i = свободные.findIndex(с => Math.abs(с - round2(п.amount)) < 0.011);
    if (i >= 0) {
      свободные.splice(i, 1);
      закрыто.add(п.id);
      ждут.splice(ждут.indexOf(п), 1);
    }
  }
  // Второй — всё остальное, по порядку.
  for (const п of ждут) {
    if (!свободные.length) break;
    свободные.shift();
    закрыто.add(п.id);
  }
  return закрыто;
}

/*
 * Что из постоянного ещё не записано в этом месяце.
 *
 * Напоминаем только когда срок ПОДОШЁЛ: аренда первого числа не должна
 * гореть красным двадцать девять дней до него. Иначе напоминание примелькается
 * и перестанет работать — а это единственное, ради чего оно есть.
 */
function неЗаписаны(сегодня = new Date()) {
  const месяц = сегодня.toISOString().slice(0, 7);
  const день = сегодня.getDate();
  const правила = db.prepare(
    `SELECT r.*, u.name AS employee_name FROM regular_expenses r
      LEFT JOIN users u ON u.id = r.employee_id
      WHERE r.active = 1 ORDER BY r.day_of_month, r.category`
  ).all();
  /*
   * Правила одной категории (и одного сотрудника) разбираем вместе: платежи
   * этой категории надо разложить по ним, а не проверять каждое поодиночке.
   */
  const группы = new Map();
  for (const п of правила.filter(п => день >= п.day_of_month)) {
    const ключ = п.category + '|' + (п.employee_id ?? '');
    if (!группы.has(ключ)) группы.set(ключ, []);
    группы.get(ключ).push(п);
  }
  const закрыто = new Set();
  for (const группа of группы.values()) {
    for (const id of закрытыеПравила(группа, месяц)) закрыто.add(id);
  }

  return правила
    .filter(п => день >= п.day_of_month)
    .filter(п => !закрыто.has(п.id))
    .map(п => ({
      id: п.id,
      category: п.category,
      amount: round2(п.amount),
      day_of_month: п.day_of_month,
      employee_id: п.employee_id,
      employee_name: п.employee_name,
      cash: п.cash,
      note: п.note,
      подпись: п.employee_name ? `${п.category} — ${п.employee_name}` : п.category,
    }));
}

const routes = [
  {
    method: 'GET', path: '/api/finance', admin: true,
    handler: ({ query }) => {
      const cond = [];
      const args = [];
      if (query.from) { cond.push('f.created_at >= ?'); args.push(query.from); }
      if (query.to) { cond.push('f.created_at <= ?'); args.push(query.to); }
      if (query.type) { cond.push('f.type = ?'); args.push(query.type); }
      if (query.category) { cond.push('f.category = ?'); args.push(query.category); }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT f.*, u.name AS user_name, e.name AS employee_name,
                s.number AS sale_number, o.number AS order_number
         FROM finance_ops f
         LEFT JOIN users u ON u.id = f.user_id
         LEFT JOIN users e ON e.id = f.employee_id
         LEFT JOIN sales s ON s.id = f.sale_id
         LEFT JOIN service_orders o ON o.id = f.order_id
         ${where} ORDER BY f.created_at DESC LIMIT 1000`
      ).all(...args);
      const totals = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
         FROM finance_ops f ${where}`
      ).get(...args);
      return { items: rows, totals: { ...totals, profit: round2(totals.income - totals.expense) } };
    },
  },
  {
    method: 'GET', path: '/api/finance/categories', admin: true,
    handler: () => {
      const used = db.prepare('SELECT DISTINCT type, category FROM finance_ops').all();
      const expense = new Set(DEFAULT_EXPENSE_CATS);
      const income = new Set(DEFAULT_INCOME_CATS);
      for (const u of used) (u.type === 'expense' ? expense : income).add(u.category);
      return { expense: [...expense], income: [...income] };
    },
  },
  {
    method: 'POST', path: '/api/finance', admin: true,
    handler: ({ body, session }) => {
      const type = body.type === 'expense' ? 'expense' : 'income';
      const category = String(body.category || '').trim();
      if (!category) throw new ApiError(400, 'Укажите категорию');
      const amount = round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма должна быть больше нуля');
      /*
       * Наличными или нет. По умолчанию да — большинство расходов магазина
       * оплачивается из ящика. Но аренда или зарплата переводом денег оттуда
       * не забирают, и если считать их наличными, сверка кассы каждый месяц
       * показывала бы недостачу, которой не было.
       */
      const наличными = body.cash === undefined ? 1 : (body.cash ? 1 : 0);
      // Кому платили — для зарплаты. Иначе строка «Зарплата 210 000» не отвечает
      // на вопрос «а Анне заплатили?», который возникает каждый месяц.
      const сотрудник = body.employee_id ? Number(body.employee_id) : null;
      const info = db.prepare(
        `INSERT INTO finance_ops (type, category, amount, note, cash, employee_id, user_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(type, category, amount, String(body.note || ''), наличными, сотрудник,
        session.userId, nowIso());
      audit(session.userId, 'create', 'finance', Number(info.lastInsertRowid),
        `${type === 'income' ? 'Приход' : 'Расход'} ${category}: ${amount}`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'DELETE', path: '/api/finance/:id', admin: true,
    handler: ({ params, session }) => {
      const id = Number(params.id);
      const op = db.prepare('SELECT * FROM finance_ops WHERE id = ?').get(id);
      if (!op) throw new ApiError(404, 'Операция не найдена');
      if (op.sale_id || op.order_id) {
        throw new ApiError(400, 'Операция создана продажей или заказом — удалить можно только через возврат.');
      }
      db.prepare('DELETE FROM finance_ops WHERE id = ?').run(id);
      audit(session.userId, 'delete', 'finance', id, `${op.category}: ${op.amount}`);
      return { ok: true };
    },
  },
  {
    /*
     * Постоянные расходы: список правил и то, что из них ещё не оплачено.
     * Отдаём вместе — на экране это один раздел, и два запроса тут ни к чему.
     */
    method: 'GET', path: '/api/finance/regular', admin: true,
    handler: () => {
      const items = db.prepare(
        `SELECT r.*, u.name AS employee_name FROM regular_expenses r
          LEFT JOIN users u ON u.id = r.employee_id
          ORDER BY r.active DESC, r.day_of_month, r.category`
      ).all();
      return { items, ждут: неЗаписаны() };
    },
  },
  {
    method: 'POST', path: '/api/finance/regular', admin: true,
    handler: ({ body, session }) => {
      const category = String(body.category || '').trim();
      if (!category) throw new ApiError(400, 'Укажите, за что расход');
      const amount = round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма должна быть больше нуля');
      const день = Math.min(Math.max(Number(body.day_of_month) || 1, 1), 28);
      const info = db.prepare(
        `INSERT INTO regular_expenses
           (category, amount, day_of_month, employee_id, cash, note, active, created_at)
         VALUES (?,?,?,?,?,?,1,?)`
      ).run(category, amount, день,
        body.employee_id ? Number(body.employee_id) : null,
        body.cash === undefined ? 1 : (body.cash ? 1 : 0),
        String(body.note || ''), nowIso());
      audit(session.userId, 'create', 'finance', Number(info.lastInsertRowid),
        `Постоянный расход: ${category}, ${amount}, ${день}-го числа`);
      return { id: Number(info.lastInsertRowid) };
    },
  },
  {
    method: 'PUT', path: '/api/finance/regular/:id', admin: true,
    handler: ({ params, body, session }) => {
      const п = db.prepare('SELECT * FROM regular_expenses WHERE id = ?').get(Number(params.id));
      if (!п) throw new ApiError(404, 'Не найдено');
      const amount = body.amount === undefined ? п.amount : round2(body.amount);
      if (!(amount > 0)) throw new ApiError(400, 'Сумма должна быть больше нуля');
      const день = body.day_of_month === undefined ? п.day_of_month
        : Math.min(Math.max(Number(body.day_of_month) || 1, 1), 28);
      const активен = body.active === undefined ? п.active : (body.active ? 1 : 0);
      db.prepare(
        `UPDATE regular_expenses SET category = ?, amount = ?, day_of_month = ?,
           employee_id = ?, cash = ?, note = ?, active = ? WHERE id = ?`
      ).run(String(body.category ?? п.category).trim() || п.category, amount, день,
        body.employee_id === undefined ? п.employee_id
          : (body.employee_id ? Number(body.employee_id) : null),
        body.cash === undefined ? п.cash : (body.cash ? 1 : 0),
        body.note === undefined ? п.note : String(body.note), активен, п.id);
      audit(session.userId, 'update', 'finance', п.id, `Постоянный расход: ${п.category}`);
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/api/finance/regular/:id', admin: true,
    handler: ({ params, session }) => {
      const п = db.prepare('SELECT * FROM regular_expenses WHERE id = ?').get(Number(params.id));
      if (!п) throw new ApiError(404, 'Не найдено');
      /*
       * Удаляем само правило, но НЕ трогаем уже записанные расходы: они —
       * история денег магазина, и переписывать её из-за того, что перестали
       * снимать помещение, нельзя.
       */
      db.prepare('DELETE FROM regular_expenses WHERE id = ?').run(п.id);
      audit(session.userId, 'delete', 'finance', п.id, `Убран постоянный расход: ${п.category}`);
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/api/finance/pnl', admin: true,
    handler: ({ query }) => {
      // P&L по месяцам за год: выручка, себестоимость, валовая прибыль, расходы, чистая прибыль
      const year = String(Number(query.year) || new Date().getFullYear());
      const tz = String(Number(query.tz) || 0); // смещение локального времени в минутах
      const mod = `${tz >= 0 ? '+' : ''}${tz} minutes`;
      const months = {};
      for (let m = 1; m <= 12; m++) {
        months[`${year}-${String(m).padStart(2, '0')}`] =
          { revenue: 0, returns: 0, cogs: 0, expenses: 0, other_income: 0 };
      }
      const saleRows = db.prepare(
        `SELECT strftime('%Y-%m', si.rowid_ts) AS ym,
                SUM(CASE WHEN si.kind = 'sale' THEN si.amount ELSE 0 END) AS revenue,
                SUM(CASE WHEN si.kind = 'sale' THEN si.cost ELSE 0 END) AS cogs,
                SUM(CASE WHEN si.kind = 'return' THEN si.amount ELSE 0 END) AS returns,
                SUM(CASE WHEN si.kind = 'return' THEN si.cost ELSE 0 END) AS cogs_back
         FROM (
           SELECT datetime(s.created_at, '${mod}') AS rowid_ts, si.final_price AS amount, si.cost AS cost, 'sale' AS kind
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           UNION ALL
           SELECT datetime(si.returned_at, '${mod}'), si.final_price, si.cost, 'return'
           FROM sale_items si WHERE si.returned = 1 AND si.returned_at IS NOT NULL
         ) si
         WHERE strftime('%Y', si.rowid_ts) = ? GROUP BY ym`
      ).all(year);
      for (const r of saleRows) {
        if (!months[r.ym]) continue;
        months[r.ym].revenue = round2(r.revenue || 0);
        months[r.ym].returns = round2(r.returns || 0);
        months[r.ym].cogs = round2((r.cogs || 0) - (r.cogs_back || 0));
      }
      const opRows = db.prepare(
        `SELECT strftime('%Y-%m', datetime(created_at, '${mod}')) AS ym, type, category, SUM(amount) AS sum
         FROM finance_ops
         WHERE strftime('%Y', datetime(created_at, '${mod}')) = ?
         GROUP BY ym, type, category`
      ).all(year);
      const expenseByCat = {};
      // «Возврат покупателю» уже учтён в returns, «Закупка товара» и «Оплата
      // поставщику» — в себестоимости проданного (COGS): включать их в расходы
      // значило бы посчитать дважды.
      const EXCLUDED_EXPENSES = ['Возврат покупателю', 'Закупка товара', 'Оплата поставщику'];
      // Выручка берётся из позиций чеков в момент продажи, поэтому приход денег
      // по продаже и позднее погашение долга по ней доходом уже не считаются.
      const EXCLUDED_INCOMES = ['Продажа', 'Погашение долга'];
      for (const r of opRows) {
        if (!months[r.ym]) continue;
        if (r.type === 'expense' && !EXCLUDED_EXPENSES.includes(r.category)) {
          months[r.ym].expenses = round2(months[r.ym].expenses + r.sum);
          expenseByCat[r.category] = round2((expenseByCat[r.category] || 0) + r.sum);
        }
        if (r.type === 'income' && !EXCLUDED_INCOMES.includes(r.category)) {
          months[r.ym].other_income = round2(months[r.ym].other_income + r.sum);
        }
      }
      const result = Object.entries(months).map(([ym, m]) => {
        const netRevenue = round2(m.revenue - m.returns);
        const gross = round2(netRevenue - m.cogs);
        return { month: ym, revenue: netRevenue, cogs: m.cogs, gross_profit: gross,
          other_income: m.other_income, expenses: m.expenses,
          net_profit: round2(gross + m.other_income - m.expenses) };
      });
      return { year: Number(year), months: result, expense_by_category: expenseByCat };
    },
  },
];

module.exports = { routes, неЗаписаны };
