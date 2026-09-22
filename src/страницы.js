'use strict';
/*
 * Две открытые страницы: политика конфиденциальности и поддержка.
 *
 * Их требует App Store: без адреса политики заявку не принимают, без адреса
 * поддержки — тоже. Но они нужны и сами по себе: сотрудник и покупатель
 * вправе знать, что о них хранится и к кому идти с вопросом.
 *
 * Открыты без входа — их читает проверяющий Apple и любой, у кого есть
 * ссылка. Контакты подставляются из настроек магазина (Настройки → Магазин),
 * а не пишутся здесь: сменится телефон — сменится и на странице, без правки
 * кода. Если контактов нет, страница так и говорит, а не выдумывает.
 */
const { getSetting } = require('./db');

const ИЗМЕНЕНА = '22 сентября 2026 г.';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function контакты() {
  return {
    магазин: getSetting('store_name') || 'Магазин',
    адрес: getSetting('store_address') || '',
    телефон: getSetting('store_phone') || '',
    почта: getSetting('store_email') || '',
  };
}

function строкиКонтактов(к, язык = 'ru') {
  const строки = [];
  if (к.телефон) строки.push(`${язык === 'ru' ? 'Телефон' : 'Phone'}: <a href="tel:${esc(к.телефон.replace(/[^\d+]/g, ''))}">${esc(к.телефон)}</a>`);
  if (к.почта) строки.push(`${язык === 'ru' ? 'Почта' : 'Email'}: <a href="mailto:${esc(к.почта)}">${esc(к.почта)}</a>`);
  if (к.адрес) строки.push(`${язык === 'ru' ? 'Адрес' : 'Address'}: ${esc(к.адрес)}`);
  if (!строки.length) {
    строки.push(язык === 'ru'
      ? 'Обратитесь к владельцу магазина лично — контакты ещё не указаны в настройках.'
      : 'Please contact the store owner in person — contact details have not been set yet.');
  }
  return строки.map(s => `<li>${s}</li>`).join('');
}

function обёртка(заголовок, тело) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(заголовок)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --ink:#191813; --muted:#6b6960; --line:#e4e2dc; --gold:#8b6b2c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111110; --ink:#f1efe9; --muted:#a7a499; --line:#2c2b27; --gold:#d3ac58; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto;
    padding: calc(28px + env(safe-area-inset-top, 0px)) 20px calc(48px + env(safe-area-inset-bottom, 0px)); }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 32px 0 8px; }
  p, li { color: var(--ink); }
  .muted { color: var(--muted); font-size: 14px; }
  ul { padding-left: 20px; }
  a { color: var(--gold); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
  .en h2 { font-size: 17px; }
</style>
</head>
<body><main>${тело}</main></body>
</html>`;
}

function политика() {
  const к = контакты();
  const м = esc(к.магазин);
  return обёртка(`Политика конфиденциальности — ${к.магазин}`, `
<h1>Политика конфиденциальности</h1>
<p class="muted">${м} · действует с ${ИЗМЕНЕНА}</p>

<h2>Что это за система</h2>
<p>${м} — внутренняя учётная система ювелирного магазина ${м}. Ею пользуются только
сотрудники магазина: учётную запись каждому выдаёт владелец. Зарегистрироваться
самостоятельно в ней нельзя. Приложение для iPhone открывает ту же систему, что
и браузер, и хранит данные не в телефоне, а на сервере магазина.</p>

<h2>Какие данные хранятся</h2>
<ul>
  <li><b>О сотрудниках:</b> имя, логин, роль, пароль в виде необратимой свёртки
    (сам пароль не хранится), разрешённые для входа устройства — случайная метка,
    название телефона или браузера, адрес IP при входе — и журнал действий в системе.</li>
  <li><b>О покупателях магазина:</b> то, что сотрудники вносят при продаже и
    обслуживании, — имя, телефон, дата рождения, размер кольца, пожелания,
    история покупок, долги и платежи.</li>
  <li><b>О товарах:</b> описания, цены, фотографии изделий и сертификатов.</li>
  <li><b>Для уведомлений:</b> если сотрудник разрешил уведомления в приложении —
    адрес его телефона в службе уведомлений Apple.</li>
</ul>

<h2>Зачем</h2>
<p>Только для работы магазина: продажи, склад, долги, отчёты и защита входа.
Данные не продаются, не передаются рекламным сетям и не используются для рекламы
или слежки. В приложении нет рекламы, сторонней аналитики и счётчиков.</p>

<h2>Где хранятся и кому передаются</h2>
<p>На сервере магазина. Соединение с ним шифруется (HTTPS). Резервные копии
хранит владелец магазина. Данные никому не передаются, кроме случаев, когда
этого требует закон. Чтобы доставить уведомление на телефон, его адрес и текст
уведомления проходят через службу уведомлений Apple (Apple Push Notification service).</p>

<h2>Камера и фотографии</h2>
<p>Камера включается только когда вы сами нажимаете «сканировать» или
«сфотографировать». Доступ к фотографиям нужен только чтобы прикрепить снимок,
который вы выбрали. Снимки уходят только на сервер магазина.</p>

<h2>Сколько хранятся</h2>
<p>Пока магазин ведёт учёт. Учётную запись уволившегося сотрудника владелец
отключает, и войти с ней больше нельзя. По просьбе сотрудника или покупателя
его данные удаляются, если закон не обязывает магазин хранить учётные документы.</p>

<h2>Ваши права</h2>
<p>Вы можете узнать, какие данные о вас хранятся, попросить исправить или
удалить их. Для этого обратитесь к владельцу магазина:</p>
<ul>${строкиКонтактов(к)}</ul>

<hr>
<section class="en" lang="en">
<h2>Privacy policy (English summary)</h2>
<p>${м} is the internal record-keeping system of the ${м} jewelry store. Only store
staff can use it; accounts are issued by the store owner and there is no public sign-up.
The iPhone app opens the same system as the browser and keeps data on the store's
server, not on the phone.</p>
<p><b>Data stored:</b> staff accounts (name, login, role, hashed password, approved devices,
sign-in IP addresses, activity log); customer records entered by staff (name, phone,
birthday, ring size, preferences, purchases, debts, payments); product data and photos;
and, if a staff member allows notifications, their Apple push notification token.</p>
<p><b>Use:</b> store operations and sign-in security only. No advertising, no third-party
analytics or tracking, no sale or sharing of data except where required by law. Push
notifications are delivered through Apple Push Notification service.</p>
<p><b>Camera and photos</b> are used only when the user chooses to scan a barcode or attach
a photo. <b>Retention and deletion:</b> data is kept while the store keeps its records;
you may request access, correction or deletion from the store owner:</p>
<ul>${строкиКонтактов(к, 'en')}</ul>
<p class="muted">Last updated: September 22, 2026.</p>
</section>`);
}

function поддержка() {
  const к = контакты();
  const м = esc(к.магазин);
  return обёртка(`Поддержка — ${к.магазин}`, `
<h1>Поддержка</h1>
<p class="muted">${м} — учётная система ювелирного магазина</p>

<h2>Связаться</h2>
<ul>${строкиКонтактов(к)}</ul>

<h2>Частые вопросы</h2>
<p><b>Как получить доступ?</b> Учётную запись выдаёт владелец магазина:
Настройки → Сотрудники. Самостоятельной регистрации нет.</p>
<p><b>Забыл пароль.</b> Попросите владельца или бухгалтера задать новый:
Настройки → Сотрудники → ✎.</p>
<p><b>Новый телефон просит разрешения.</b> Так и задумано: незнакомое устройство
показывает код и ждёт. Назовите код владельцу — он разрешит вход в
Настройки → Безопасность, и приложение войдёт само.</p>
<p><b>Не печатаются бирки.</b> В приложении печать идёт через AirPrint: принтер
должен быть в той же сети Wi-Fi, что и телефон.</p>
<p><b>Нет уведомлений.</b> Уведомления получают основатель и бухгалтер.
Проверьте, что они разрешены: Настройки iPhone → Diamonds → Уведомления.</p>
<p><a href="/privacy">Политика конфиденциальности</a></p>

<hr>
<section class="en" lang="en">
<h2>Support (English)</h2>
<p>${м} is the internal system of the ${м} jewelry store. Accounts are issued by the store
owner; there is no public sign-up. For help, a new password or access, contact:</p>
<ul>${строкиКонтактов(к, 'en')}</ul>
<p><a href="/privacy">Privacy policy</a></p>
</section>`);
}

module.exports = { политика, поддержка };
