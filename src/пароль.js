'use strict';
/*
 * Смена пароля из командной строки: node src/пароль.js admin «новый пароль»
 *
 * Нужна ровно для одного случая — установки на сервер. Скрипт установки
 * выставляет систему в интернет, а до этой минуты у администратора стоял
 * стандартный admin/admin123, известный любому, кто хоть раз видел эту
 * систему. Просить владельца «сменить пароль потом» — значит оставить дверь
 * открытой на всё время, пока он до неё дойдёт: между установкой и переносом
 * данных может пройти день.
 *
 * Поэтому установка сама придумывает длинный случайный пароль, ставит его
 * этой командой и печатает владельцу. Первое, что он делает, — входит
 * с ним и меняет на свой.
 *
 * Без пароля вторым доводом команда придумывает его сама и печатает.
 */
const auth = require('./auth');
const { db } = require('./db');

const [, , логин, заданный] = process.argv;

if (!логин) {
  console.error('Как пользоваться:  node src/пароль.js admin [новый пароль]');
  console.error('Без пароля он будет придуман и напечатан.');
  process.exit(1);
}

const user = db.prepare('SELECT id, name FROM users WHERE username = ?').get(логин);
if (!user) {
  console.error(`Сотрудника с логином «${логин}» нет.`);
  process.exit(1);
}

function придумать() {
  // Без похожих знаков (0/O, 1/l/I): пароль будут переписывать с экрана руками.
  const знаки = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const crypto = require('node:crypto');
  let out = '';
  for (const b of crypto.randomBytes(16)) out += знаки[b % знаки.length];
  return out.slice(0, 6) + '-' + out.slice(6, 11) + '-' + out.slice(11);
}

const пароль = заданный || придумать();

const беда = auth.passwordProblem(пароль);
if (беда) {
  console.error('Такой пароль не подходит: ' + беда);
  process.exit(1);
}

auth.changePassword(user.id, пароль);
console.log(пароль);
