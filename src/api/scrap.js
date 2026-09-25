'use strict';
/*
 * Старое золото в зачёт покупки.
 *
 * Клиентка приносит старое кольцо и хочет новое. Раньше это считали на
 * калькуляторе, скидку ставили «на глаз», а в системе не оставалось ни веса,
 * ни пробы, ни того, сколько золота лежит в сейфе. Теперь:
 *
 *   — оценка по весу и пробе: вес × цена грамма этой пробы. Цену грамма
 *     585-й пробы задаёт владелец в Настройках, остальные пробы — пропорционально
 *     содержанию золота (750-я дороже 585-й ровно в 750/585 раза);
 *   — сумма идёт в зачёт покупки. Живых денег в ящик не приходит, поэтому
 *     сверка кассы её не ждёт — как при обмене изделия;
 *   — зачёт не больше покупки: разницу деньгами на руки система не выдаёт;
 *   — продавец цену грамма не меняет: иначе оценку можно было бы подогнать;
 *   — на каждый приём — акт с весом, пробой и подписями, а в разделе «Лом» —
 *     сколько граммов какой пробы накоплено.
 */
const { db, round2, getSetting, nextNumber, nowIso, audit, money, видитВсё } = require('../db');
const { ApiError } = require('./util');

const ПРОБЫ = [375, 500, 583, 585, 750, 875, 916, 958, 999];

function цена585() {
  const ц = Number(String(getSetting('scrap_price_585') || '').replace(',', '.'));
  return Number.isFinite(ц) && ц > 0 ? ц : 0;
}

// Цена грамма пробы — от цены 585-й, по содержанию золота. Целые сомы.
function ценаГрамма(проба) {
  return Math.round(цена585() * проба / 585);
}

const веса = x => Math.round(Number(x) * 1000) / 1000;

/*
 * Проверить и оценить принесённое. Возвращает строки с суммами и итоги.
 * Сервер считает сам: цену и сумму, присланные продавцом, не берём на веру.
 */
function оценить(позиции, session) {
  if (!Array.isArray(позиции) || !позиции.length) return null;
  if (позиции.length > 20) throw new ApiError(400, 'Слишком много строк лома в одном акте');
  if (!цена585()) {
    throw new ApiError(400, 'Цена грамма лома не задана — владелец задаёт её в Настройках');
  }
  const можноСвоюЦену = видитВсё(session.role);
  const строки = позиции.map((п, i) => {
    const описание = String(п.description || '').trim().slice(0, 100) || 'Лом золота';
    const проба = Number(п.fineness);
    if (!Number.isInteger(проба) || проба < 300 || проба > 999) {
      throw new ApiError(400, `Строка ${i + 1}: проба — число от 300 до 999, например 585`);
    }
    const сырой = String(п.weight ?? '').trim().replace(',', '.');
    const вес = веса(сырой);
    if (сырой === '' || !Number.isFinite(вес) || вес <= 0 || вес > 1000) {
      throw new ApiError(400, `Строка ${i + 1}: вес в граммах, больше нуля`);
    }
    /*
     * Своя цена грамма — только у владельца и бухгалтера (например, за
     * сплав с припоем подешевле). Продавцу всегда цена из Настроек.
     */
    let цена = ценаГрамма(проба);
    if (можноСвоюЦену && п.price !== undefined && п.price !== null && п.price !== '') {
      const своя = Number(String(п.price).replace(',', '.'));
      if (!Number.isFinite(своя) || своя <= 0 || своя > 1e6) throw new ApiError(400, `Строка ${i + 1}: цена грамма`);
      цена = Math.round(своя * 100) / 100;
    }
    return { description: описание, fineness: проба, weight: вес, price: цена, amount: Math.round(вес * цена) };
  });
  return {
    строки,
    вес: веса(строки.reduce((s, r) => s + r.weight, 0)),
    чистого: веса(строки.reduce((s, r) => s + r.weight * r.fineness / 1000, 0)),
    сумма: round2(строки.reduce((s, r) => s + r.amount, 0)),
  };
}

// Записать акт — внутри транзакции продажи.
function записатьАкт(номер, оценка, { customerId, saleId, saleNumber, session }) {
  const info = db.prepare(
    `INSERT INTO scrap_intakes (number, customer_id, user_id, sale_id, items, weight, pure_weight, amount, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(номер, customerId, session.userId, saleId, JSON.stringify(оценка.строки),
    оценка.вес, оценка.чистого, оценка.сумма, nowIso());
  audit(session.userId, 'scrap', 'sale', saleId,
    `${номер}: принято старое золото ${оценка.строки.map(r => `${r.weight} г ${r.fineness}`).join(', ')} ` +
    `на ${money(оценка.сумма)} в зачёт чека ${saleNumber}`);
  return Number(info.lastInsertRowid);
}

function акт(row) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
  return { ...row, items };
}

function актПоЧеку(saleId) {
  return акт(db.prepare(
    `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS user_name, s.number AS sale_number
       FROM scrap_intakes a LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN sales s ON s.id = a.sale_id
      WHERE a.sale_id = ?`
  ).get(saleId));
}

const routes = [
  {
    // Цены грамма по пробам — для кассы: оценку продавец видит ещё до продажи.
    method: 'GET', path: '/api/scrap/prices',
    handler: () => ({
      price_585: цена585(),
      prices: Object.fromEntries(ПРОБЫ.map(п => [п, ценаГрамма(п)])),
    }),
  },
  {
    /*
     * Раздел «Лом»: сколько граммов какой пробы накоплено и все акты.
     * Сколько за него зачтено — видят все: это то, что магазин отдал
     * клиентам, а не закупочная.
     */
    method: 'GET', path: '/api/scrap',
    handler: ({ query }) => {
      const акты = db.prepare(
        `SELECT a.*, c.name AS customer_name, u.name AS user_name, s.number AS sale_number
           FROM scrap_intakes a LEFT JOIN customers c ON c.id = a.customer_id
           LEFT JOIN users u ON u.id = a.user_id LEFT JOIN sales s ON s.id = a.sale_id
          ORDER BY a.id DESC LIMIT ?`
      ).all(Math.min(Number(query.limit) || 200, 1000)).map(акт);
      const поПробам = new Map();
      for (const а of db.prepare('SELECT items FROM scrap_intakes').all().map(акт)) {
        for (const r of а.items) {
          const п = поПробам.get(r.fineness) || { fineness: r.fineness, weight: 0, pure_weight: 0, amount: 0 };
          п.weight += Number(r.weight) || 0;
          п.pure_weight += (Number(r.weight) || 0) * r.fineness / 1000;
          п.amount += Number(r.amount) || 0;
          поПробам.set(r.fineness, п);
        }
      }
      const склад = [...поПробам.values()].sort((a, b) => b.fineness - a.fineness)
        .map(п => ({ ...п, weight: веса(п.weight), pure_weight: веса(п.pure_weight), amount: round2(п.amount) }));
      return { stock: склад, items: акты };
    },
  },
  {
    method: 'GET', path: '/api/scrap/:id',
    handler: ({ params }) => {
      const а = акт(db.prepare(
        `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS user_name, s.number AS sale_number
           FROM scrap_intakes a LEFT JOIN customers c ON c.id = a.customer_id
           LEFT JOIN users u ON u.id = a.user_id LEFT JOIN sales s ON s.id = a.sale_id
          WHERE a.id = ?`
      ).get(Number(params.id)));
      if (!а) throw new ApiError(404, 'Акт не найден');
      return а;
    },
  },
];

module.exports = { routes, оценить, записатьАкт, актПоЧеку, ценаГрамма, ПРОБЫ, nextNumber };
