'use strict';
/*
 * Защита входа от подбора пароля.
 *
 * Пока система стояла в магазинном Wi-Fi, до страницы входа дотягивался только
 * тот, кто стоит внутри. В интернете постучаться может кто угодно и сколько
 * угодно, поэтому счёт неудачам ведём по двум ключам сразу — но по-разному.
 *
 * По ЛОГИНУ — строго. Подбирают всегда конкретную учётную запись, и пять
 * промахов подряд по одному логину — это уже не «рука соскользнула».
 *
 * По АДРЕСУ — мягко, и вот почему. Когда система переедет в интернет, все
 * телефоны магазина будут приходить с одного внешнего адреса. Считай мы по
 * адресу так же строго, один продавец, забывший пароль, запирал бы весь
 * магазин — и это была бы не защита, а способ сорвать рабочий день. Поэтому
 * порог по адресу высокий: столько промахов за смену живой магазин не сделает,
 * а перебор словаря упирается в него сразу.
 *
 * Блокировка «мягкая»: учётная запись не отключается, иначе достаточно было бы
 * стучаться в чужой логин, чтобы не пустить человека на работу. Прошла пауза —
 * вход снова открыт. Удачный вход обнуляет оба счётчика.
 */
const { audit } = require('./db');

// после скольких неудач по ОДНОМУ ЛОГИНУ какая пауза (в минутах)
const USER_STEPS = [
  { fails: 40, minutes: 120 },
  { fails: 20, minutes: 30 },
  { fails: 10, minutes: 5 },
  { fails: 5, minutes: 1 },
];
// то же по АДРЕСУ: за ним может стоять весь магазин, поэтому пороги выше
const IP_STEPS = [
  { fails: 200, minutes: 60 },
  { fails: 100, minutes: 15 },
  { fails: 40, minutes: 2 },
];
// Через сколько бездействия счётчик обнуляется сам.
const FORGET_MS = 6 * 3600 * 1000;
// Потолок на число ключей: иначе перебор с тысяч адресов раздувает память.
const MAX_KEYS = 5000;

const fails = new Map();   // ключ → { count, last, notified }

const stepsFor = key => (key.startsWith('user:') ? USER_STEPS : IP_STEPS);

function penaltyMs(key, count) {
  for (const s of stepsFor(key)) if (count >= s.fails) return s.minutes * 60000;
  return 0;
}

// Раз в час выкидываем всё, чего давно не трогали, — карта не должна расти вечно.
function prune(now) {
  for (const [key, rec] of fails) {
    if (now - rec.last > FORGET_MS) fails.delete(key);
  }
  if (fails.size <= MAX_KEYS) return;
  // Всё ещё много — оставляем самые свежие: старые попытки уже неопасны.
  const byAge = [...fails.entries()].sort((a, b) => b[1].last - a[1].last);
  fails.clear();
  for (const [key, rec] of byAge.slice(0, MAX_KEYS)) fails.set(key, rec);
}

let lastPrune = 0;

function keysFor(ip, username) {
  const login = String(username || '').trim().toLowerCase();
  return ['ip:' + ip, ...(login ? ['user:' + login] : [])];
}

/*
 * Можно ли пробовать. Возвращает 0, если вход открыт, иначе — сколько секунд
 * ещё ждать (по самому строгому из ключей).
 */
function retryAfter(ip, username, now = Date.now()) {
  if (now - lastPrune > 3600000) { prune(now); lastPrune = now; }
  let wait = 0;
  for (const key of keysFor(ip, username)) {
    const rec = fails.get(key);
    if (!rec) continue;
    if (now - rec.last > FORGET_MS) { fails.delete(key); continue; }
    const left = penaltyMs(key, rec.count) - (now - rec.last);
    if (left > wait) wait = left;
  }
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

function noteFail(ip, username, now = Date.now()) {
  // Общий потолок смотрит не только на количество попыток, но и на то, сколько
  // из них мимо: поток чужих — это неудачи, всплеск своих — удачи.
  сдвинутьОкно(now);
  windowFails++;
  for (const key of keysFor(ip, username)) {
    const rec = fails.get(key) || { count: 0, last: 0, notified: 0 };
    // Долгая тишина — начинаем счёт заново.
    if (now - rec.last > FORGET_MS) { rec.count = 0; rec.notified = 0; }
    rec.count++;
    rec.last = now;
    fails.set(key, rec);

    /*
     * Владелец должен узнать, что в дверь стучались. Но писать в журнал каждую
     * неудачу нельзя: перебор забьёт журнал тысячами строк и спрячет за собой
     * работу продавцов. Поэтому отмечаем только момент, когда включилась
     * очередная пауза, — по строке на ступень.
     */
    const step = stepsFor(key).find(s => rec.count === s.fails);
    if (step && rec.notified !== rec.count) {
      rec.notified = rec.count;
      const who = key.startsWith('user:')
        ? `логин «${key.slice(5)}»`
        : `адрес ${key.slice(3)}`;
      audit(null, 'login_failed', 'user', null,
        `Неудачных попыток входа: ${rec.count} (${who}). Вход закрыт на ${step.minutes} мин.`);
    }
  }
}

/*
 * Общий поток попыток входа.
 *
 * Проверка пароля намеренно медленная — так задумано, чтобы подбор был дорогим.
 * Но это же делает страницу входа удобной мишенью: поток запросов с разных
 * адресов займёт процессор целиком, и система станет тормозить у всех, ещё
 * до того как сработают счётчики по логину и адресу.
 *
 * Поэтому есть общий потолок: сколько всего попыток система готова проверять
 * в минуту — 120. Проверка пароля стоит около 50 мс, то есть даже полный поток
 * съедает лишь десятую часть одного ядра. Сверх потолка попытки отбиваются
 * сразу, не тратя процессор.
 *
 * Здесь важен размен: во время такого потока в систему нельзя будет войти
 * заново. Зато уже открытые смены на телефонах продолжают работать, и магазин
 * торгует — это лучше, чем сервер, лежащий под нагрузкой целиком.
 *
 * Но одного счёта попыток мало, и это важно. Поток по определению состоит из
 * НЕВЕРНЫХ паролей: подбирающий не знает правильного. А всплеск у своих —
 * из верных: шесть телефонов разом переустановили приложение, новая раздача
 * карточек, сотрудники заходят после смены пароля. Если закрывать вход по
 * одному только количеству, во втором случае система запрёт своих же на
 * минуту — то есть сделает ровно то, ради чего затевается нападение,
 * и сделает это бесплатно, без единого нападающего.
 *
 * Поэтому потолок срабатывает, только когда совпало и одно, и другое: попыток
 * много И большинство из них неудачные. Под настоящим потоком это выполняется
 * всегда (там почти все попытки мимо), а у магазина — никогда.
 */
const GLOBAL_PER_MINUTE = 120;
const GLOBAL_FAILS_PER_MINUTE = 60;
let windowStart = 0;
let windowCount = 0;
let windowFails = 0;

function сдвинутьОкно(now) {
  if (now - windowStart > 60000) { windowStart = now; windowCount = 0; windowFails = 0; }
}

function globalOverload(now = Date.now()) {
  сдвинутьОкно(now);
  windowCount++;
  return windowCount > GLOBAL_PER_MINUTE && windowFails > GLOBAL_FAILS_PER_MINUTE;
}

// Вошли успешно — снимаем счётчики и по адресу, и по логину.
function noteSuccess(ip, username) {
  for (const key of keysFor(ip, username)) fails.delete(key);
}

function reset() {
  fails.clear(); lastPrune = 0;
  windowStart = 0; windowCount = 0; windowFails = 0;
}

// Для проверок: сколько ключей сейчас под наблюдением и что по конкретному.
function size() { return fails.size; }
function peek(key) { return fails.get(key) || null; }

module.exports = { retryAfter, noteFail, noteSuccess, globalOverload, reset, size, peek,
  USER_STEPS, IP_STEPS, GLOBAL_PER_MINUTE, GLOBAL_FAILS_PER_MINUTE };
