'use strict';
const { db, nowIso, видитВсё } = require('../db');
const { ApiError } = require('./util');
const push = require('../push');

/*
 * Телефоны для уведомлений.
 *
 * Адрес телефона приносит сама страница, открытая в приложении, от имени
 * вошедшего человека. Так сервер знает, кому этот телефон принадлежит, и
 * никто не может подписать чужой телефон на уведомления владельца: адрес
 * привязывается только к тому, кто сейчас вошёл.
 */
const АДРЕС = /^[0-9a-f]{32,200}$/i;

const routes = [
  {
    method: 'POST', path: '/api/push/register',
    handler: ({ body, session }) => {
      const token = String(body.token || '').trim();
      if (!АДРЕС.test(token)) throw new ApiError(400, 'Неверный адрес для уведомлений');
      const env = body.env === 'sandbox' ? 'sandbox' : 'production';
      push.запомнить(session.userId, token, env);
      return { ok: true };
    },
  },
  {
    // При выходе: телефон, из которого вышли, больше не получает уведомления
    // этого человека. Иначе продавец, которому владелец дал свой телефон
    // на минуту, получал бы потом его тревоги.
    method: 'POST', path: '/api/push/unregister',
    handler: ({ body, session }) => {
      const token = String(body.token || '').trim();
      const r = db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?')
        .run(token, session.userId);
      return { removed: Number(r.changes || 0) };
    },
  },
  {
    method: 'GET', path: '/api/push/status',
    handler: ({ session }) => ({
      configured: push.включено(),
      // Уведомления приходят тем, кто отвечает за систему. Продавцу они не
      // нужны, и страница об этом знает по этому полю.
      receives: видитВсё(session.role),
      mine: db.prepare('SELECT COUNT(*) AS c FROM push_tokens WHERE user_id = ?').get(session.userId).c,
    }),
  },
  {
    // Проверочное — чтобы владелец увидел своими глазами, что уведомления
    // доходят, а не узнал это в день, когда оно было нужно.
    method: 'POST', path: '/api/push/test',
    handler: async ({ session }) => {
      if (!push.включено()) throw new ApiError(400, 'Уведомления на сервере ещё не подключены');
      const sent = await push.отправить([session.userId], {
        title: 'Уведомления работают',
        body: `Проверка ${new Date(nowIso()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC. Сюда придут вход с нового телефона, сломанная копия и неоплаченная аренда.`,
        route: '#/settings/security',
      });
      if (!sent) throw new ApiError(400, 'Ни один ваш телефон не подписан на уведомления. Откройте систему в приложении и разрешите уведомления.');
      return { sent };
    },
  },
];

module.exports = { routes };
