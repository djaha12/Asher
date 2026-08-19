require('./устройство');   // проверки называют себя устройством, как настоящее приложение
const ВЫВОД = require('node:path').join(__dirname, '.вывод');
const { chromium } = require('./браузер');
const BASE = process.env.BASE || 'http://127.0.0.1:3122'; const OUT=ВЫВОД+'/shots-roles';
let ok=0,fail=0;
const check=(n,c,e)=>c?(ok++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n,e===undefined?'':String(e).slice(0,220)));
(async()=>{
  const b=await chromium.launch();
  const p=await (await b.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1.6})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error'&&!/status of 40[013]/.test(m.text()))errs.push(m.text());});
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.fill('#login-username','admin'); await p.fill('#login-password','admin123');
  await p.click('#login-form button[type=submit]'); await p.waitForSelector('#app:not(.hidden)');

  console.log('=== Поле поиска в шапке ===');
  check('поле есть на всех страницах', await p.isVisible('#gs-input'));
  await p.fill('#gs-input','AS-000'); await p.waitForTimeout(900);
  check('список открылся', await p.isVisible('#gs-results'));
  const txt = await p.$eval('#gs-results', e=>e.innerText);
  console.log('     разделы:', [...txt.matchAll(/^(ИЗДЕЛИЯ|КЛИЕНТЫ|ЧЕКИ|ЗАКАЗЫ И РЕМОНТ|КОМПЛЕКТЫ)$/gim)].map(m=>m[0]).join(', '));
  check('находки сгруппированы по разделам', /ИЗДЕЛИЯ/i.test(txt), txt.slice(0,120));
  await p.screenshot({path:`${OUT}/поиск-общий.png`});

  console.log('\n=== Enter открывает найденное ===');
  await p.keyboard.press('Enter'); await p.waitForTimeout(2200);
  check('перешли в карточку изделия', /#\/products\//.test(await p.evaluate(()=>location.hash)), await p.evaluate(()=>location.hash));
  check('карточка открыта', Boolean(await p.$('.modal-body')));
  check('поле очистилось', (await p.inputValue('#gs-input'))==='');
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);

  console.log('\n=== Поиск клиента по телефону ===');
  // Телефон берём из самой базы, а не вписываем в тест: демо-данные каждый раз
  // новые, и жёстко вписанный номер проверял бы не поиск, а везение.
  const кто = await p.evaluate(async () => {
    const r = await fetch('/api/customers?limit=50', { credentials: 'include' });
    const j = await r.json();
    const c = (j.items || j).find(x => (x.phone || '').replace(/\D/g, '').length >= 7);
    return c ? { phone: c.phone, name: c.name } : null;
  });
  check('в базе есть клиент с телефоном', Boolean(кто), кто);
  if (кто) {
    // Ищем кусок номера, разбитый пробелом: так его и набирают руками.
    const цифры = кто.phone.replace(/\D/g, '').slice(-7);
    const сПробелом = цифры.slice(0, 4) + ' ' + цифры.slice(4);
    await p.fill('#gs-input', сПробелом); await p.waitForTimeout(1200);
    const t2 = await p.$eval('#gs-results', e=>e.innerText);
    check('клиент найден по телефону с пробелами', /КЛИЕНТЫ/i.test(t2),
      `искали «${сПробелом}» (${кто.name}, ${кто.phone}) — ` + t2.slice(0,120));
  }

  console.log('\n=== Стрелки и Escape ===');
  await p.fill('#gs-input','кольцо'); await p.waitForTimeout(900);
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
  check('стрелками выбирается строка', Boolean(await p.$('.gs-item.active')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  check('Escape закрывает список', !(await p.isVisible('#gs-results')));

  console.log('\n=== Ничего не найдено ===');
  await p.fill('#gs-input','щщщщ-нет-такого'); await p.waitForTimeout(900);
  check('система честно говорит, что не нашла',
    /Ничего не нашлось/.test(await p.$eval('#gs-results',e=>e.innerText)));

  console.log('\n=== Продавцу поиск тоже доступен ===');
  const p2=await (await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
  await p2.goto(BASE,{waitUntil:'networkidle'});
  await p2.fill('#login-username','anna'); await p2.fill('#login-password','seller123');
  await p2.click('#login-form button[type=submit]'); await p2.waitForSelector('#app:not(.hidden)');
  check('на телефоне есть кнопка поиска', await p2.isVisible('#btn-search-mobile'));
  await p2.click('#btn-search-mobile'); await p2.waitForTimeout(500);
  check('поиск раскрылся на весь экран', await p2.isVisible('#gs-input'));
  await p2.fill('#gs-input','AS-000'); await p2.waitForTimeout(1200);
  const t3=await p2.$eval('#gs-results',e=>e.innerText);
  check('продавец находит изделия', /ИЗДЕЛИЯ/i.test(t3), t3.slice(0,120));
  check('но закупочных цен в находках нет', !/Закупочн/i.test(t3));
  await p2.screenshot({path:`${OUT}/поиск-телефон.png`});

  check('ошибок в браузере нет', errs.length===0, errs.slice(0,3).join(' | '));
  console.log(`\nИтого: ${ok} ok, ${fail} fail`);
  await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
