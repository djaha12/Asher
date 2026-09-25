'use strict';
/*
 * Сверка кассы: сколько денег должно быть в ящике и сколько там на самом деле.
 *
 * Зачем. Шесть продавцов принимают наличные, а сверить ящик с системой в конце
 * дня было нечем. Расхождение владелец заметил бы, только когда оно накопится
 * за недели, — и уже не понял бы, откуда оно взялось. Дыра эта чаще не про
 * воровство, а про обычные ошибки со сдачей: но и в том, и в другом случае
 * узнавать о ней надо в тот же вечер, пока все помнят день.
 *
 * Как считаем «должно быть». Каждая сверка становится точкой отсчёта для
 * следующей: в ящике осталось столько-то, дальше складываем движение денег.
 * Живые деньги — это две вещи, и только они:
 *
 *   1) платежи клиентов НАЛИЧНЫМИ (payments, method='cash'). Здесь и продажи,
 *      и погашение долгов, и возвраты — возврат лежит той же строкой с минусом.
 *      Оплата картой в ящик не попадает, поэтому берём только наличные.
 *
 *   2) ручные операции из раздела «Финансы», не связанные с чеком: приход
 *      «нашли деньги», расход «купили воду», инкассация. Именно они и есть
 *      касса магазина.
 *
 * Почему не берём finance_ops целиком: продажа пишется И туда, И в payments.
 * Сложив всё подряд, мы посчитали бы каждый чек дважды.
 */
const { db, nowIso, round2, audit, money, transaction, видитВсё } = require('../db');
const { ApiError } = require('./util');

// Последняя сверка — от неё считается движение денег.
function последняя() {
  return db.prepare('SELECT * FROM cash_counts ORDER BY id DESC LIMIT 1').get() || null;
}

/*
 * Движение наличных с момента `с` до сейчас.
 * Возвращает и итог, и разбивку — владельцу мало числа, ему нужно понять,
 * из чего оно сложилось.
 */
function движение(с) {
  const от = с || '0000';

  /*
   * in_till = 1 — «эта запись двигала деньги в ящике». Способа оплаты мало:
   * при обмене клиент рассчитывается старым изделием, строка в платежах
   * законная, а живых денег не приходило. Без этого условия каждый обмен
   * вечером превращался в недостачу на цену зачтённого изделия.
   */
  const отКлиентов = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM payments
      WHERE method = 'cash' AND in_till = 1 AND created_at > ?`
  ).get(от).s;

  const продажи = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM payments
      WHERE method = 'cash' AND in_till = 1 AND amount > 0 AND created_at > ?`
  ).get(от).s;

  const возвраты = db.prepare(
    `SELECT COALESCE(SUM(-amount), 0) AS s FROM payments
      WHERE method = 'cash' AND in_till = 1 AND amount < 0 AND created_at > ?`
  ).get(от).s;

  // Ручная касса: только то, что не привязано ни к чеку, ни к заказу.
  const приход = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM finance_ops
      WHERE type = 'income' AND cash = 1 AND sale_id IS NULL AND order_id IS NULL AND created_at > ?`
  ).get(от).s;

  const расход = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM finance_ops
      WHERE type = 'expense' AND cash = 1 AND sale_id IS NULL AND order_id IS NULL AND created_at > ?`
  ).get(от).s;

  /*
   * Сдали владельцу и внесли размен. Деньги ящика, но не доход и не расход:
   * раньше выемку записывали расходом, и каждый вечер отчёт о прибыли
   * «терял» дневную выручку. Сдачу считаем, даже если владелец её ещё
   * не подтвердил или сказал «не получал»: деньги из ящика ушли, спор —
   * между продавцом и владельцем, а не между ящиком и системой.
   */
  const сдали = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM cash_moves WHERE kind = 'to_owner' AND created_at > ?`
  ).get(от).s;
  const внесли = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM cash_moves WHERE kind = 'from_owner' AND created_at > ?`
  ).get(от).s;

  return {
    от_клиентов: round2(отКлиентов),
    продажи: round2(продажи),
    возвраты: round2(возвраты),
    приход: round2(приход),
    расход: round2(расход),
    сдали: round2(сдали),
    внесли: round2(внесли),
    итого: round2(отКлиентов + приход - расход + внесли - сдали),
  };
}

const имя = id => (id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || '' : '');

// Сданная смена, которую ещё никто не принял, — если она последняя сверка.
function ждётПриёма() {
  const пред = последняя();
  if (!пред || пред.kind !== 'handover' || пред.accepted_at) return null;
  return { id: пред.id, user_id: пред.user_id, кто: имя(пред.user_id), когда: пред.created_at, сдано: round2(пред.counted) };
}

/*
 * Что система ожидает увидеть в ящике прямо сейчас.
 *
 * Если сверок ещё не было, точки отсчёта нет: считаем движение за всё время
 * и честно говорим об этом. Первая сверка заодно и назначает начало отсчёта —
 * дальше цифры станут осмысленными.
 */
function ожидание() {
  const пред = последняя();
  /*
   * Пока сверок не было, точки отсчёта нет — и выдумывать её нельзя.
   *
   * Сначала здесь считалось движение «за всю историю», и это была ошибка:
   * система не знает, сколько денег лежало в ящике в день, когда её поставили,
   * не знает про выемки до неё и про размен из кармана владельца. На живой базе
   * такой расчёт легко уходит в минус — и первая же сверка встречает продавца
   * бессмысленной цифрой, после которой он перестаёт ей верить.
   *
   * Поэтому первая сверка ничего не сравнивает: она просто записывает,
   * сколько денег в ящике сейчас, и становится началом отсчёта.
   */
  const с = пред ? пред.created_at : '';
  const дв = пред ? движение(с)
    : { от_клиентов: 0, продажи: 0, возвраты: 0, приход: 0, расход: 0, сдали: 0, внесли: 0, итого: 0 };
  const остаток = пред ? Number(пред.counted) : 0;
  return {
    первая: !пред,
    с,
    прошлая: пред ? {
      когда: пред.created_at,
      было: round2(пред.counted),
      расхождение: round2(пред.difference),
    } : null,
    остаток: round2(остаток),
    движение: дв,
    ожидается: round2(остаток + дв.итого),
    смена: ждётПриёма(),
  };
}

const routes = [
  {
    /*
     * Что должно быть в ящике. Доступно и продавцу: считает деньги вечером
     * именно он, и цифру «должно быть» он обязан видеть до того, как назовёт
     * свою, — иначе это не сверка, а угадывание.
     */
    method: 'GET', path: '/api/cash/expected',
    handler: () => ожидание(),
  },
  {
    /*
     * Записать пересчёт.
     *
     * Правки задним числом не предусмотрены намеренно: сверка — это отметка
     * «на этот момент в ящике было столько». Позволить её исправить значит
     * позволить подогнать расхождение под ноль, и весь смысл пропадает.
     * Ошиблись при вводе — делайте ещё одну сверку, обе останутся в истории.
     */
    method: 'POST', path: '/api/cash/count',
    handler: ({ body, session }) => {
      /*
       * Проверяем СЫРОЕ значение, а не округлённое.
       *
       * round2 устроен так, что превращает и пустоту, и текст в ноль
       * (Number('') || 0). Если округлить сначала, пустое поле станет честным
       * нулём и запишется как «в ящике 0» — то есть недостача на всю выручку
       * дня, которой не было. Такая запись потом никогда не удалится
       * из истории, потому что сверки намеренно не правятся.
       */
      const сырое = body.counted;
      if (сырое === '' || сырое === null || сырое === undefined || !Number.isFinite(Number(сырое))) {
        throw new ApiError(400, 'Укажите, сколько денег в ящике');
      }
      const пересчитано = round2(сырое);
      if (пересчитано < 0) throw new ApiError(400, 'Денег в ящике не может быть меньше нуля');
      /*
       * Вид сверки: просто пересчёт, «сдаю смену» или «принимаю смену».
       * Принять можно только последнюю сданную и только чужую: принять свою
       * смену самому себе — значит снова поверить себе на слово.
       */
      let вид = body.kind === 'handover' ? 'handover' : 'count';
      let сданная = null;
      if (body.accept === true) {
        сданная = ждётПриёма();
        if (!сданная) throw new ApiError(400, 'Принимать нечего: смену никто не сдавал или её уже приняли');
        if (сданная.user_id === session.userId) {
          throw new ApiError(400, 'Свою смену принять нельзя — её принимает следующий продавец');
        }
        вид = 'accept';
      }
      const о = ожидание();
      /*
       * Первая сверка расхождения не имеет: сравнивать не с чем. Она задаёт
       * начало отсчёта, и «недостача» тут была бы выдумкой.
       */
      const разница = о.первая ? 0 : round2(пересчитано - о.ожидается);
      const ожидалось = о.первая ? пересчитано : о.ожидается;
      const ts = nowIso();

      const info = transaction(() => {
        const r = db.prepare(
          `INSERT INTO cash_counts
             (store_id, user_id, opening, movement, expected, counted, difference, since_at, note, created_at,
              kind, handover_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(body.store_id ? Number(body.store_id) : null, session.userId,
          о.остаток, о.движение.итого, ожидалось, пересчитано, разница,
          о.с || '', String(body.note || ''), ts, вид, сданная ? сданная.id : null);
        if (сданная) {
          db.prepare('UPDATE cash_counts SET accepted_by = ?, accepted_at = ? WHERE id = ?')
            .run(session.userId, ts, сданная.id);
        }
        return r;
      });

      /*
       * В журнал попадает всегда, и с обеими цифрами. Владелец должен видеть
       * не только «не сошлось на 300», но и от чего считали: без этого запись
       * через месяц ничего не объясняет.
       */
      const словами = о.первая ? 'начало отсчёта'
        : разница === 0 ? 'сошлось'
          : разница > 0 ? `излишек ${money(разница)}`
            : `недостача ${money(-разница)}`;
      const заголовок = вид === 'handover' ? 'Смена сдана'
        : вид === 'accept' ? `Смена принята у ${сданная.кто} (сдано ${money(сданная.сдано)})` : 'Сверка кассы';
      audit(session.userId, 'cash_count', 'finance', Number(info.lastInsertRowid),
        о.первая
          ? `${заголовок}: начало отсчёта, в ящике ${money(пересчитано)}`
          : `${заголовок}: в ящике ${money(пересчитано)}, ожидалось ${money(ожидалось)} — ${словами}`);

      return {
        id: Number(info.lastInsertRowid),
        вид,
        первая: о.первая,
        ожидалось,
        пересчитано,
        разница,
        словами,
        ...(сданная ? { сдал: сданная.кто, сдано: сданная.сдано } : {}),
      };
    },
  },
  {
    /*
     * История сверок — владельцу. Продавцу она не нужна и не полезна:
     * чужие расхождения не его дело, а своё он только что увидел.
     */
    method: 'GET', path: '/api/cash/counts', admin: true,
    handler: ({ query }) => {
      const limit = Math.min(Number(query.limit) || 50, 200);
      const items = db.prepare(
        `SELECT c.*, u.name AS user_name, s.name AS store_name, a.name AS accepted_name,
                h.counted AS handover_counted, hu.name AS handover_user_name
           FROM cash_counts c
           LEFT JOIN users u ON u.id = c.user_id
           LEFT JOIN stores s ON s.id = c.store_id
           LEFT JOIN users a ON a.id = c.accepted_by
           LEFT JOIN cash_counts h ON h.id = c.handover_id
           LEFT JOIN users hu ON hu.id = h.user_id
          ORDER BY c.id DESC LIMIT ?`
      ).all(limit);
      return { items };
    },
  },

  // ---------- Сдали владельцу / внесли размен ----------
  {
    /*
     * Кому можно сдать деньги: владельцу и бухгалтеру. Список нужен
     * продавцу, чтобы выбрать, кому отдал, — не больше: только имена.
     */
    method: 'GET', path: '/api/cash/receivers',
    handler: () => ({
      items: db.prepare(
        `SELECT id, name, role FROM users WHERE active = 1 AND role IN ('owner','accountant')
          ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name`
      ).all(),
    }),
  },
  {
    method: 'POST', path: '/api/cash/moves',
    handler: ({ body, session }) => {
      const вид = body.kind;
      if (!['to_owner', 'from_owner'].includes(вид)) {
        throw new ApiError(400, 'Непонятно, что с деньгами: сдали владельцу или внесли размен');
      }
      // Сырое значение проверяем до округления: пустое поле не должно стать нулём.
      const сырое = body.amount;
      if (сырое === '' || сырое === null || сырое === undefined || !Number.isFinite(Number(сырое))) {
        throw new ApiError(400, 'Укажите сумму');
      }
      const сумма = round2(сырое);
      if (!(сумма > 0)) throw new ApiError(400, 'Сумма должна быть больше нуля');
      if (сумма > 1e9) throw new ApiError(400, 'Проверьте сумму — слишком много нулей');

      // Вторая сторона — владелец или бухгалтер. Сами они могут не выбирать: это они.
      let другой = body.other_user_id ? Number(body.other_user_id) : null;
      if (другой) {
        const u = db.prepare('SELECT role, active FROM users WHERE id = ?').get(другой);
        if (!u || !u.active || !видитВсё(u.role)) throw new ApiError(400, 'Деньги сдают владельцу или бухгалтеру');
      } else if (видитВсё(session.role)) {
        другой = session.userId;
      } else {
        throw new ApiError(400, вид === 'to_owner' ? 'Выберите, кому отдали деньги' : 'Выберите, кто внёс размен');
      }

      /*
       * Больше, чем по расчёту лежит в ящике, сдать нельзя: чаще всего это
       * лишний ноль. Если денег правда больше — значит, что-то не пробили,
       * и сначала нужна сверка: она покажет излишек и запишет его.
       */
      if (вид === 'to_owner') {
        const о = ожидание();
        if (!о.первая && сумма > о.ожидается + 0.009) {
          throw new ApiError(400, `По расчёту в ящике ${money(о.ожидается)} — столько сдать нельзя. ` +
            'Если денег больше, сначала сверьте кассу');
        }
      }

      /*
       * Подтверждать нечего, если деньги взял тот, кто записывает, — владелец
       * сам. Размен тоже без подтверждения: завышать его продавцу невыгодно,
       * это его же недостача вечером.
       */
      const сразу = вид === 'from_owner' || другой === session.userId;
      const ts = nowIso();
      const info = db.prepare(
        `INSERT INTO cash_moves (kind, amount, user_id, other_user_id, status, checked_by, checked_at, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(вид, сумма, session.userId, другой, сразу ? 'confirmed' : 'pending',
        сразу ? session.userId : null, сразу ? ts : null, String(body.note || '').slice(0, 300), ts);
      // Кому — должностью: основателю или бухгалтеру. Имя — в Финансах, в списке сдач.
      const роль = (db.prepare('SELECT role FROM users WHERE id = ?').get(другой) || {}).role;
      const кому = другой === session.userId ? 'себе' : роль === 'owner' ? 'основателю' : 'бухгалтеру';
      const отКого = роль === 'owner' ? 'основателя' : 'бухгалтера';
      audit(session.userId, 'cash_move', 'finance', Number(info.lastInsertRowid),
        вид === 'to_owner' ? `Сдано из кассы ${money(сумма)} ${кому}${сразу ? '' : ' (ждёт подтверждения)'}`
          : `Внесён размен в кассу ${money(сумма)} от ${отКого}`);
      return { id: Number(info.lastInsertRowid), status: сразу ? 'confirmed' : 'pending' };
    },
  },
  {
    // Продавцу — только свои записи: чужие сдачи не его дело.
    method: 'GET', path: '/api/cash/moves',
    handler: ({ query, session }) => {
      const cond = [];
      const args = [];
      if (!видитВсё(session.role)) { cond.push('m.user_id = ?'); args.push(session.userId); }
      if (query.status) { cond.push('m.status = ?'); args.push(String(query.status)); }
      const limit = Math.min(Number(query.limit) || 50, 200);
      const items = db.prepare(
        `SELECT m.*, u.name AS user_name, o.name AS other_name, k.name AS checked_name
           FROM cash_moves m
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN users o ON o.id = m.other_user_id
           LEFT JOIN users k ON k.id = m.checked_by
          ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
          ORDER BY m.id DESC LIMIT ?`
      ).all(...args, limit);
      return { items };
    },
  },
  ...['confirm', 'dispute'].map(действие => ({
    /*
     * «Получил» или «не получал». Отмечает тот, кому отдали, — он один знает,
     * дошли ли деньги. Владелец может отметить за бухгалтера: он главный.
     * Отмеченное не переотмечается: иначе «не получал» можно было бы тихо
     * переделать в «получил», и спор исчез бы из истории.
     */
    method: 'POST', path: `/api/cash/moves/:id/${действие}`, admin: true,
    handler: ({ params, body, session }) => {
      const m = db.prepare('SELECT * FROM cash_moves WHERE id = ?').get(Number(params.id));
      if (!m) throw new ApiError(404, 'Запись не найдена');
      if (m.status !== 'pending') throw new ApiError(400, 'Уже отмечено');
      if (m.other_user_id !== session.userId && session.role !== 'owner') {
        throw new ApiError(403, 'Отмечает тот, кому отдали деньги');
      }
      const заметка = String(body.note || '').slice(0, 300);
      db.prepare('UPDATE cash_moves SET status = ?, checked_by = ?, checked_at = ?, check_note = ? WHERE id = ?')
        .run(действие === 'confirm' ? 'confirmed' : 'disputed', session.userId, nowIso(), заметка, m.id);
      audit(session.userId, 'cash_move_check', 'finance', m.id, действие === 'confirm'
        ? `Получено от ${имя(m.user_id)}: ${money(m.amount)}`
        : `НЕ получено от ${имя(m.user_id)}: ${money(m.amount)}${заметка ? ' — ' + заметка : ''}`);
      return { ok: true };
    },
  })),
  {
    /*
     * Что ждёт человека прямо сейчас: сданная смена, которую надо принять,
     * и — владельцу — сдачи денег, которые надо подтвердить. Главная
     * показывает это первым делом, пока люди ещё рядом.
     */
    method: 'GET', path: '/api/cash/pending',
    handler: ({ session }) => {
      const смена = ждётПриёма();
      const сдачи = !видитВсё(session.role) ? [] : db.prepare(
        `SELECT m.id, m.amount, m.created_at, m.note, m.other_user_id, u.name AS user_name, o.name AS other_name
           FROM cash_moves m
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN users o ON o.id = m.other_user_id
          WHERE m.status = 'pending' AND (m.other_user_id = ? OR ? = 'owner')
          ORDER BY m.id`
      ).all(session.userId, session.role);
      return { смена: смена && смена.user_id !== session.userId ? смена : null, сдачи };
    },
  },
];

module.exports = { routes, ожидание, движение, последняя };
