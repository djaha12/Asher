'use strict';
/*
 * Скидка сверх предела — по разрешению владельца на этот чек.
 *
 * Раньше у продавца было два пути, и оба плохие: сказать клиенту «нельзя»
 * или звонить владельцу, чтобы тот приехал и провёл продажу сам. Клиентка
 * с гарнитуром за полмиллиона ждать не будет.
 *
 * Теперь продавец просит прямо из кассы: какие изделия, какую скидку и почему.
 * Владелец видит запрос у себя на Главной и отвечает «разрешить» или
 * «отказать». Разрешение узкое намеренно:
 *   — только этому продавцу;
 *   — только на эти изделия и не больше разрешённой скидки на каждое;
 *   — один раз: после продажи оно израсходовано;
 *   — недолго: через 30 минут после ответа его уже не применить.
 * Иначе однажды выпрошенное «да» можно было бы носить в кармане.
 */
const { db, nowIso, round2, audit, money, видитВсё } = require('../db');
const { ApiError } = require('./util');

const ЖИВЁТ_МИНУТ = 30;

function пределСкидки() {
  return require('./sales').пределСкидки();
}

// Позиции запроса с названиями и ценами — для экрана владельца.
function позиции(запрос) {
  let items = [];
  try { items = JSON.parse(запрос.items || '[]'); } catch { items = []; }
  return items.map(it => {
    const p = db.prepare('SELECT id, sku, name, retail_price FROM products WHERE id = ?').get(it.product_id) || {};
    const цена = round2(p.retail_price || 0);
    return {
      product_id: it.product_id, sku: p.sku || '', name: p.name || '—', price: цена,
      discount: round2(it.discount), percent: цена > 0 ? round2(it.discount * 100 / цена) : 0,
    };
  });
}

function подробно(запрос) {
  const имя = id => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || '' : '');
  const клиент = запрос.customer_id
    ? db.prepare('SELECT name, discount FROM customers WHERE id = ?').get(запрос.customer_id) : null;
  const items = позиции(запрос);
  return {
    id: запрос.id, status: запрос.status, note: запрос.note || '',
    user_id: запрос.user_id, user_name: имя(запрос.user_id),
    customer_id: запрос.customer_id, customer_name: клиент ? клиент.name : '',
    decided_by_name: имя(запрос.decided_by), decided_at: запрос.decided_at,
    created_at: запрос.created_at, sale_id: запрос.sale_id,
    items,
    total_discount: round2(items.reduce((s, i) => s + i.discount, 0)),
    total_price: round2(items.reduce((s, i) => s + i.price, 0)),
  };
}

function устарело(когда) {
  return !когда || Date.now() - new Date(когда).getTime() > ЖИВЁТ_МИНУТ * 60000;
}

/*
 * Разрешение для продажи: проверяется в кассе при оформлении чека.
 * Возвращает Map product_id → разрешённая скидка, или бросает понятный отказ.
 */
function разрешениеДляПродажи(id, session) {
  if (!id) return null;
  const з = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(Number(id));
  if (!з || з.user_id !== session.userId) throw new ApiError(400, 'Разрешение на скидку не найдено — попросите заново');
  if (з.status === 'used') throw new ApiError(400, 'Это разрешение на скидку уже использовано — на новый чек попросите заново');
  if (з.status !== 'approved') throw new ApiError(400, 'Владелец эту скидку не разрешил');
  if (устарело(з.decided_at)) {
    throw new ApiError(400, `Разрешение действует ${ЖИВЁТ_МИНУТ} минут и уже истекло — попросите заново`);
  }
  const скидки = new Map();
  for (const it of JSON.parse(з.items || '[]')) скидки.set(Number(it.product_id), round2(it.discount));
  return { id: з.id, decided_by: з.decided_by, скидки };
}

function израсходовать(id, saleId) {
  db.prepare(`UPDATE discount_requests SET status = 'used', sale_id = ? WHERE id = ? AND status = 'approved'`)
    .run(saleId, id);
}

const routes = [
  {
    method: 'POST', path: '/api/discount-requests',
    handler: ({ body, session }) => {
      if (видитВсё(session.role)) throw new ApiError(400, 'Вам разрешение не нужно — скидку вы ставите сами');
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 50) throw new ApiError(400, 'В запросе нет изделий');
      const клиентId = body.customer_id ? Number(body.customer_id) : null;
      const клиент = клиентId ? db.prepare('SELECT id, discount FROM customers WHERE id = ?').get(клиентId) : null;
      if (клиентId && !клиент) throw new ApiError(400, 'Клиент не найден');
      const предел = Math.max(пределСкидки(), клиент ? round2(клиент.discount || 0) : 0);

      const чистые = [];
      const были = new Set();
      let сверх = 0;
      for (const it of items) {
        const pid = Number(it.product_id);
        if (были.has(pid)) throw new ApiError(400, 'Одно изделие дважды в запросе');
        были.add(pid);
        const p = db.prepare('SELECT id, name, retail_price, status FROM products WHERE id = ?').get(pid);
        if (!p) throw new ApiError(400, `Изделие #${pid} не найдено`);
        if (p.status === 'sold' || p.status === 'written_off') throw new ApiError(400, `«${p.name}» уже не продаётся`);
        const скидка = round2(it.discount || 0);
        if (скидка < 0 || скидка > p.retail_price) throw new ApiError(400, `Недопустимая скидка на «${p.name}»`);
        if (p.retail_price > 0 && скидка * 100 / p.retail_price > предел + 0.01) сверх++;
        чистые.push({ product_id: pid, discount: скидка });
      }
      if (!сверх) throw new ApiError(400, `Скидка в пределах ${предел}% — разрешение не нужно, оформляйте`);

      // Новый запрос заменяет прежний, ещё не отвеченный: владелец отвечает на актуальный.
      db.prepare(`UPDATE discount_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'`)
        .run(session.userId);
      const info = db.prepare(
        `INSERT INTO discount_requests (user_id, customer_id, items, note, status, created_at)
         VALUES (?,?,?,?, 'pending', ?)`
      ).run(session.userId, клиентId, JSON.stringify(чистые), String(body.note || '').trim().slice(0, 300), nowIso());
      const з = подробно(db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(info.lastInsertRowid));
      audit(session.userId, 'discount_request', 'sale', з.id,
        `Просит скидку ${money(з.total_discount)} на ${з.items.map(i => `«${i.name}» ${i.percent}%`).join(', ')}` +
        (з.note ? ` — ${з.note}` : ''));
      return з;
    },
  },
  {
    // Владельцу — запросы, ждущие ответа; продавцу — свои.
    method: 'GET', path: '/api/discount-requests',
    handler: ({ query, session }) => {
      const cond = [];
      const args = [];
      if (!видитВсё(session.role)) { cond.push('user_id = ?'); args.push(session.userId); }
      if (query.status) { cond.push('status = ?'); args.push(String(query.status)); }
      const rows = db.prepare(
        `SELECT * FROM discount_requests ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 50`
      ).all(...args);
      /*
       * Неотвеченный запрос старше получаса владельцу уже не показываем:
       * клиентка давно ушла, а «разрешить» на него всё равно не сработает.
       */
      return { items: rows.filter(r => r.status !== 'pending' || !устарело(r.created_at)).map(подробно) };
    },
  },
  {
    method: 'GET', path: '/api/discount-requests/:id',
    handler: ({ params, session }) => {
      const з = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(Number(params.id));
      if (!з || (!видитВсё(session.role) && з.user_id !== session.userId)) throw new ApiError(404, 'Запрос не найден');
      return подробно(з);
    },
  },
  {
    // Продавец передумал или клиентка ушла — снимает свой запрос.
    method: 'DELETE', path: '/api/discount-requests/:id',
    handler: ({ params, session }) => {
      const з = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(Number(params.id));
      if (!з || з.user_id !== session.userId) throw new ApiError(404, 'Запрос не найден');
      if (з.status === 'pending' || з.status === 'approved') {
        db.prepare(`UPDATE discount_requests SET status = 'cancelled' WHERE id = ?`).run(з.id);
      }
      return { ok: true };
    },
  },
  ...['approve', 'deny'].map(действие => ({
    method: 'POST', path: `/api/discount-requests/:id/${действие}`, admin: true,
    handler: ({ params, session }) => {
      const з = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(Number(params.id));
      if (!з) throw new ApiError(404, 'Запрос не найден');
      if (з.status === 'cancelled') throw new ApiError(400, 'Продавец уже снял этот запрос');
      if (з.status !== 'pending') throw new ApiError(400, 'На этот запрос уже ответили');
      if (устарело(з.created_at)) throw new ApiError(400, 'Запросу больше получаса — клиент, скорее всего, ушёл');
      const ts = nowIso();
      db.prepare('UPDATE discount_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(действие === 'approve' ? 'approved' : 'denied', session.userId, ts, з.id);
      const д = подробно(db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(з.id));
      audit(session.userId, действие === 'approve' ? 'discount_approve' : 'discount_deny', 'sale', з.id,
        `${действие === 'approve' ? 'Разрешена' : 'Не разрешена'} скидка ${money(д.total_discount)} для ${д.user_name}: ` +
        д.items.map(i => `«${i.name}» ${i.percent}%`).join(', '));
      return д;
    },
  })),
];

module.exports = { routes, разрешениеДляПродажи, израсходовать, ЖИВЁТ_МИНУТ };
