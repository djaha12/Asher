'use strict';
// Проверка настроек локали: смена страны переключает валюту, формат и телефоны.
const BASE = process.env.BASE || 'http://127.0.0.1:3122';
let cookie = '', failures = 0;
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}
const check = (n, c, x) => { if (c) console.log('  ok  ' + n); else { failures++; console.log('  FAIL ' + n, JSON.stringify(x)); } };

(async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'admin123' });

  console.log('\n=== Умолчания для Кыргызстана ===');
  let r = await call('GET', '/api/me');
  check('страна KG', r.body.locale.country === 'KG', r.body.locale);
  check('валюта — сом', r.body.locale.currency === 'сом', r.body.locale.currency);
  check('суммы без копеек', r.body.locale.money_decimals === 0, r.body.locale.money_decimals);
  check('код страны 996', r.body.locale.phone_code === '996', r.body.locale.phone_code);
  check('местная приставка 0', r.body.locale.phone_trunk === '0', r.body.locale.phone_trunk);
  check('пробы, а не караты', r.body.locale.fineness === 'proba', r.body.locale.fineness);

  console.log('\n=== Список стран ===');
  r = await call('GET', '/api/settings/countries');
  check('страны отдаются списком', r.body.items.length >= 8, r.body.items.length);
  check('Кыргызстан в списке', r.body.items.some(c => c.code === 'KG'), '');
  check('есть страна с каратами', r.body.items.some(c => c.fineness === 'karat'), '');

  console.log('\n=== Смена страны на Казахстан ===');
  r = await call('PUT', '/api/settings', { country: 'KZ' });
  check('смена принята', r.status === 200, r.body);
  r = await call('GET', '/api/me');
  check('валюта стала тенге', r.body.locale.currency === '₸', r.body.locale.currency);
  check('код страны стал 7', r.body.locale.phone_code === '7', r.body.locale.phone_code);
  check('приставка стала 8', r.body.locale.phone_trunk === '8', r.body.locale.phone_trunk);

  console.log('\n=== Своя подпись валюты поверх набора ===');
  r = await call('PUT', '/api/settings', { country: 'KG', currency: 'с.' });
  r = await call('GET', '/api/me');
  check('страна KG', r.body.locale.country === 'KG', r.body.locale.country);
  check('валюта осталась своей', r.body.locale.currency === 'с.', r.body.locale.currency);
  check('остальное подставилось из набора', r.body.locale.phone_code === '996', r.body.locale.phone_code);

  console.log('\n=== Возврат к сому ===');
  await call('PUT', '/api/settings', { country: 'KG', currency: 'сом' });
  r = await call('GET', '/api/me');
  check('валюта сом', r.body.locale.currency === 'сом', r.body.locale.currency);

  console.log('\n=== Адрес для телефона ===');
  r = await call('GET', '/api/settings/network');
  check('адрес в локальной сети отдаётся', Array.isArray(r.body.addresses), r.body);
  check('адрес похож на ссылку', !r.body.addresses.length || /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(r.body.addresses[0]), r.body.addresses);

  console.log('\n=== Продавцу расчёты с поставщиками закрыты ===');
  const admin = cookie;
  await call('POST', '/api/login', { username: 'anna', password: 'seller123' });
  r = await call('GET', '/api/settings/network');
  check('продавец не видит сетевой адрес', r.status === 403, r.status);
  r = await call('GET', '/api/me');
  check('но локаль продавцу приходит', r.body.locale.currency === 'сом', r.body.locale);
  cookie = admin;

  console.log(failures === 0 ? '\n✅ Локаль работает\n' : `\n❌ Провалено: ${failures}\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
