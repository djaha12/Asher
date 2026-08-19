'use strict';
/*
 * Локаль: валюта, телефоны, формат сумм.
 *
 * Всё, что зависит от страны, живёт здесь и в таблице settings — в коде страниц
 * ничего не зашито. Готовые наборы (пресеты) нужны, чтобы владелец выбрал страну
 * одной строкой в настройках, а не заполнял шесть полей вручную.
 *
 * Поля набора:
 *   currency        — как подписывать суммы («сом», «₸», «₽»);
 *   money_decimals  — сколько знаков после запятой показывать в деньгах.
 *                     В сомах, тенге и сумах разменной монеты фактически нет,
 *                     поэтому 0: «45 000 сом» вместо «45 000,00 сом»;
 *   number_locale   — формат разрядов: «45 000,5» против «45,000.5»;
 *   phone_code      — код страны без плюса, для ссылок WhatsApp;
 *   phone_trunk     — местная приставка перед номером внутри страны
 *                     (в Кыргызстане и Узбекистане это «0», в России и Казахстане «8»);
 *   phone_length    — сколько всего цифр в полном номере вместе с кодом страны;
 *   phone_example   — образец в подсказках полей ввода;
 *   fineness        — как маркируют металл: proba (585, 750, 925) или karat (14K, 18K).
 */

const PRESETS = {
  KG: {
    name: 'Кыргызстан', currency: 'сом', money_decimals: 0, number_locale: 'ru-RU',
    phone_code: '996', phone_trunk: '0', phone_length: 12,
    phone_example: '0555 12-34-56', fineness: 'proba',
  },
  KZ: {
    name: 'Казахстан', currency: '₸', money_decimals: 0, number_locale: 'ru-RU',
    phone_code: '7', phone_trunk: '8', phone_length: 11,
    phone_example: '8 701 123-45-67', fineness: 'proba',
  },
  UZ: {
    name: 'Узбекистан', currency: 'сум', money_decimals: 0, number_locale: 'ru-RU',
    phone_code: '998', phone_trunk: '0', phone_length: 12,
    phone_example: '90 123-45-67', fineness: 'proba',
  },
  TJ: {
    name: 'Таджикистан', currency: 'смн', money_decimals: 2, number_locale: 'ru-RU',
    phone_code: '992', phone_trunk: '0', phone_length: 12,
    phone_example: '90 123-45-67', fineness: 'proba',
  },
  RU: {
    name: 'Россия', currency: '₽', money_decimals: 2, number_locale: 'ru-RU',
    phone_code: '7', phone_trunk: '8', phone_length: 11,
    phone_example: '8 900 123-45-67', fineness: 'proba',
  },
  BY: {
    name: 'Беларусь', currency: 'Br', money_decimals: 2, number_locale: 'ru-RU',
    phone_code: '375', phone_trunk: '8', phone_length: 12,
    phone_example: '29 123-45-67', fineness: 'proba',
  },
  AM: {
    name: 'Армения', currency: '֏', money_decimals: 0, number_locale: 'ru-RU',
    phone_code: '374', phone_trunk: '0', phone_length: 11,
    phone_example: '77 12-34-56', fineness: 'proba',
  },
  AZ: {
    name: 'Азербайджан', currency: '₼', money_decimals: 2, number_locale: 'ru-RU',
    phone_code: '994', phone_trunk: '0', phone_length: 12,
    phone_example: '50 123-45-67', fineness: 'proba',
  },
  GE: {
    name: 'Грузия', currency: '₾', money_decimals: 2, number_locale: 'ru-RU',
    phone_code: '995', phone_trunk: '', phone_length: 12,
    phone_example: '555 12-34-56', fineness: 'proba',
  },
  TR: {
    name: 'Турция', currency: '₺', money_decimals: 2, number_locale: 'tr-TR',
    phone_code: '90', phone_trunk: '0', phone_length: 12,
    phone_example: '532 123 45 67', fineness: 'karat',
  },
  AE: {
    name: 'ОАЭ', currency: 'AED', money_decimals: 2, number_locale: 'en-AE',
    phone_code: '971', phone_trunk: '0', phone_length: 12,
    phone_example: '50 123 4567', fineness: 'karat',
  },
};

const DEFAULT_COUNTRY = 'KG';

// Ключи локали в таблице settings. Владелец может править их по одному,
// а может выбрать страну — тогда подставится весь набор разом.
const LOCALE_KEYS = ['country', 'currency', 'money_decimals', 'number_locale',
  'phone_code', 'phone_trunk', 'phone_length', 'phone_example', 'fineness'];

function presetFor(country) {
  return PRESETS[String(country || '').toUpperCase()] || PRESETS[DEFAULT_COUNTRY];
}

/*
 * Приведение номера к международному виду для ссылки WhatsApp.
 *
 * Клиент может записать телефон как угодно: «0555 12-34-56», «+996 555 123456»,
 * «555123456». Все три варианта должны дать одну ссылку. Номер, не похожий на
 * местный, оставляем как есть — у клиента-иностранца свой код страны.
 */
function normalizePhone(raw, locale) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  const code = String(locale.phone_code || '');
  const trunk = String(locale.phone_trunk || '');
  const length = Number(locale.phone_length) || 0;
  if (!code) return digits;

  // Уже международный: с кодом страны и нужной длины.
  if (length && digits.length === length && digits.startsWith(code)) return digits;

  // Местный с приставкой: 0555123456 → 996555123456.
  if (trunk && digits.startsWith(trunk)) {
    const local = code + digits.slice(trunk.length);
    if (!length || local.length === length) return local;
  }

  // Местный без приставки: 555123456 → 996555123456.
  const withCode = code + digits;
  if (!length || withCode.length === length) return withCode;

  // На местный не похож — считаем, что номер уже с чужим кодом страны.
  return digits;
}

module.exports = { PRESETS, DEFAULT_COUNTRY, LOCALE_KEYS, presetFor, normalizePhone };
