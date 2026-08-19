'use strict';
/*
 * Резерв со сроком.
 *
 * Изделие держится за клиентом до указанной даты. Когда дата прошла,
 * резерв снимается сам и изделие возвращается на витрину — иначе через
 * месяц половина склада числится «отложенной» за людьми, которые уже
 * давно не придут.
 *
 * Пустой срок означает бессрочный резерв: так вели себя все резервы до
 * появления этой возможности, и старые записи ломать нельзя.
 */
const { db, audit, transaction } = require('./db');

const CHECK_EVERY_MS = 3600 * 1000; // раз в час хватает: срок задаётся днями

function today() {
  return new Date().toISOString().slice(0, 10);
}

/*
 * Снять резервы, у которых вышел срок. День окончания включительный:
 * «резерв до 8 августа» держится весь день 8-го и снимается 9-го.
 */
function releaseExpired() {
  return transaction(() => {
    const expired = db.prepare(
      `SELECT id, sku, name, reserved_until FROM products
        WHERE status = 'reserved' AND reserved_until != '' AND reserved_until < ?`
    ).all(today());
    if (!expired.length) return 0;

    /*
     * Условие по сроку в UPDATE — защита от гонки: если ровно в этот момент
     * продавец продлил резерв, строка уже не совпадёт и снятие не произойдёт.
     * Иначе фоновая задача молча отменила бы только что данное клиенту слово.
     */
    const release = db.prepare(
      `UPDATE products SET status = 'in_stock', reserved_for = NULL, reserved_until = ''
        WHERE id = ? AND status = 'reserved' AND reserved_until = ?`
    );
    let released = 0;
    for (const p of expired) {
      const info = release.run(p.id, p.reserved_until);
      if (!info.changes) continue;
      released++;
      audit(null, 'reserve_expired', 'product', p.id,
        `${p.sku} — срок резерва истёк ${p.reserved_until}, изделие вернулось на витрину`);
    }
    return released;
  });
}

// Изделия, у которых резерв заканчивается в ближайшие дни — для подсказок в интерфейсе.
function expiringSoon(days = 2) {
  const limit = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT p.id, p.sku, p.name, p.reserved_until, c.name AS reserved_for_name
       FROM products p LEFT JOIN customers c ON c.id = p.reserved_for
      WHERE p.status = 'reserved' AND p.reserved_until != '' AND p.reserved_until <= ?
      ORDER BY p.reserved_until`
  ).all(limit);
}

function start() {
  // Сразу при запуске: программа могла быть выключена несколько дней,
  // и за это время сроки прошли без нас.
  const n = releaseExpired();
  if (n) console.log(`  Снято просроченных резервов: ${n}`);
  setInterval(releaseExpired, CHECK_EVERY_MS).unref();
}

module.exports = { start, releaseExpired, expiringSoon };
