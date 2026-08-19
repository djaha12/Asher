'use strict';
// Оболочка приложения: вход, навигация, маршрутизация
window.App = (() => {
  const Pages = window.Pages;

  const NAV = [
    { section: 'Обзор' },
    { key: 'dashboard', title: 'Главная', ico: 'home' },
    { section: 'Торговля' },
    { key: 'sales', title: 'Продажи', ico: 'sale' },
    { key: 'products', title: 'Каталог изделий', ico: 'gem' },
    { key: 'customers', title: 'Клиенты', ico: 'users' },
    { key: 'debts', title: 'Долги', ico: 'clock' },
    { key: 'orders', title: 'Заказы и ремонт', ico: 'wrench' },
    { section: 'Склад' },
    { key: 'sets', title: 'Комплекты', ico: 'gift' },
    { key: 'inventory', title: 'Инвентаризация', ico: 'clipboard' },
    { key: 'labels', title: 'Ценники и бирки', ico: 'tag' },
    { section: 'Управление', admin: true },
    { key: 'finance', title: 'Финансы', ico: 'wallet', admin: true },
    { key: 'analytics', title: 'Аналитика', ico: 'chart', admin: true },
    { key: 'import', title: 'Импорт из 1С', ico: 'sync', admin: true },
    { key: 'settings', title: 'Настройки', ico: 'gear' },
  ];

  // На телефоне внизу помещается пять кнопок — самое частое в работе.
  // Остальное открывается кнопкой «☰» в шапке.
  const MOBILE_NAV = [
    { key: 'dashboard', title: 'Главная', ico: 'home' },
    { key: 'products', title: 'Каталог', ico: 'gem' },
    { key: 'sales', title: 'Продажи', ico: 'sale' },
    { key: 'debts', title: 'Долги', ico: 'clock' },
    { key: 'customers', title: 'Клиенты', ico: 'users' },
  ];

  const App = {
    user: null,
    // Локаль магазина: валюта, формат сумм, телефонный код страны.
    // Приходит с сервера при входе, задаётся в Настройках.
    locale: { currency: 'сом', money_decimals: 0, number_locale: 'ru-RU',
      phone_code: '996', phone_trunk: '0', phone_length: 12 },
    storeName: 'Asher',
    storePhone: '',

    // Совместимость: страницы обращаются к App.currency как к подписи валюты.
    get currency() { return App.locale.currency || ''; },

    showLogin() {
      document.getElementById('app').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      /*
       * Телефон подключают по QR с карточки сотрудника, а в ней зашит его логин:
       * «…/#login=aigul». Подставляем логин сам — продавцу остаётся ввести только
       * пароль. Пароль в ссылку не кладём: карточку могут сфотографировать.
       */
      const fromLink = /[#&?]login=([a-z0-9._-]{1,30})/i.exec(location.hash || '');
      const userInput = document.getElementById('login-username');
      if (fromLink) {
        userInput.value = fromLink[1].toLowerCase();
        setTimeout(() => document.getElementById('login-password').focus(), 50);
      } else {
        setTimeout(() => userInput.focus(), 50);
      }
      // Подсказка про admin/admin123 видна только пока пароль стандартный.
      const hint = document.getElementById('login-hint');
      if (hint) {
        fetch('/api/login-hint')
          .then(r => r.json())
          .then(d => hint.classList.toggle('hidden', !d.default_admin))
          .catch(() => hint.classList.add('hidden'));
      }
    },

    showApp() {
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      // «Asher Diamonds» → крупно ASHER, подстрочно DIAMONDS. Одно слово — без подстрочника.
      const words = String(App.storeName || 'Asher').trim().split(/\s+/);
      const first = words[0];
      const rest = words.slice(1).join(' ');
      document.getElementById('brand-name').textContent = first;
      document.getElementById('brand-sub').textContent = rest;
      document.getElementById('brand-name-mobile').textContent = App.storeName;
      document.getElementById('login-title').textContent = first;
      document.getElementById('login-sub').textContent = rest;
      document.getElementById('user-name').textContent = App.user.name;
      document.getElementById('user-role').textContent = App.user.role === 'admin' ? 'Администратор' : 'Продавец';
      document.getElementById('user-avatar').textContent = (App.user.name || '?')[0].toUpperCase();
      renderNav();
      renderMobileNav();
      route();
    },

    isAdmin: () => App.user && App.user.role === 'admin',

    go(hash) { location.hash = hash; },
  };

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.filter(item => !item.admin || App.isAdmin() || item.key === 'settings')
      .map(item => item.section
        ? ((!item.admin || App.isAdmin()) ? `<div class="nav-section">${item.section}</div>` : '')
        : `<div class="nav-item" data-key="${item.key}"><span class="ico">${ui.icon(item.ico)}</span>${item.title}</div>`
      ).join('');
    nav.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => App.go('#/' + el.dataset.key));
    });
  }

  function renderMobileNav() {
    const nav = document.getElementById('mobile-nav');
    nav.innerHTML = MOBILE_NAV.map(item =>
      `<button class="mn-item" data-key="${item.key}">
         <span class="ico">${ui.icon(item.ico)}</span>${item.title}
       </button>`).join('');
    nav.querySelectorAll('.mn-item').forEach(el => {
      el.addEventListener('click', () => App.go('#/' + el.dataset.key));
    });
  }

  // «☰» на телефоне — полный список разделов списком, крупными строками.
  function showAllSections() {
    const available = NAV.filter(i => i.key && (!i.admin || App.isAdmin()));
    const m = ui.modal({
      title: 'Разделы',
      size: 'sm',
      body: `<div class="chip-row" style="flex-direction:column;gap:8px">
        ${available.map(i => `
          <button class="btn btn-block" data-key="${i.key}" style="justify-content:flex-start;gap:12px">
            ${ui.icon(i.ico)}${ui.esc(i.title)}
          </button>`).join('')}
        <button class="btn btn-block btn-danger" data-key="__logout" style="justify-content:flex-start;gap:12px">
          ${ui.icon('logout')}Выйти
        </button>
      </div>`,
    });
    m.body.querySelectorAll('[data-key]').forEach(el => {
      el.addEventListener('click', async () => {
        m.close();
        if (el.dataset.key === '__logout') { await logout(); return; }
        App.go('#/' + el.dataset.key);
      });
    });
  }

  async function logout() {
    try { await api.post('/api/logout'); } catch { /* не критично */ }
    App.user = null;
    App.showLogin();
  }

  function currentRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const [key, param] = h.split('/');
    return { key: key || 'dashboard', param };
  }

  async function route() {
    if (!App.user) return;
    const { key, param } = currentRoute();
    const page = Pages[key] || Pages.dashboard;
    const navItem = NAV.find(n => n.key === key);
    if (navItem && navItem.admin && !App.isAdmin()) { App.go('#/dashboard'); return; }

    const activeKey = Pages[key] ? key : 'dashboard';
    document.querySelectorAll('.nav-item').forEach(el =>
      el.classList.toggle('active', el.dataset.key === activeKey));
    document.querySelectorAll('.mn-item').forEach(el =>
      el.classList.toggle('active', el.dataset.key === activeKey));
    document.getElementById('page-title').textContent = page.title;
    window.scrollTo(0, 0);
    // каждой навигации — свой контейнер: запоздавший рендер прошлой страницы
    // пишет в отсоединённый узел и не затирает текущую
    const host = document.getElementById('page');
    const el = document.createElement('div');
    el.innerHTML = '<div class="empty"><p>Загрузка…</p></div>';
    host.replaceChildren(el);
    try {
      await page.render(el, param);
    } catch (e) {
      el.innerHTML = `<div class="empty"><div class="empty-ico">◇</div><p>${ui.esc(e.message)}</p></div>`;
    }
  }

  // ---------- Вход ----------
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');
    try {
      const res = await api.post('/api/login', {
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      });
      App.user = res.user;
      App.storeName = res.store_name || 'Asher';
      App.storePhone = res.store_phone || '';
      if (res.locale) App.locale = res.locale;
      document.getElementById('login-password').value = '';
      // Убираем «#login=…» из ссылки, чтобы дальше работали обычные разделы.
      if (/^#login=/i.test(location.hash)) location.hash = '#/dashboard';
      App.showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-logout').innerHTML = ui.icon('logout');
  document.getElementById('btn-more').innerHTML = ui.icon('menu');
  document.getElementById('btn-quick-sale').innerHTML = ui.icon('plus') + ' Продажа';
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-more').addEventListener('click', showAllSections);
  document.getElementById('btn-theme').addEventListener('click', ui.toggleTheme);
  document.getElementById('btn-theme-mobile').addEventListener('click', ui.toggleTheme);

  document.getElementById('btn-quick-sale').addEventListener('click', () => {
    if (Pages.sales && Pages.sales.newSale) Pages.sales.newSale();
  });

  setupGlobalSearch();

  /*
   * Общий поиск.
   *
   * Раньше поиск был в каждом разделе свой, и продавцу приходилось сначала
   * вспомнить, где искать. Здесь одно поле: набрал что угодно — увидел всё,
   * что нашлось, с подписью, что это. Выбор ведёт прямо в карточку.
   */
  function setupGlobalSearch() {
    const wrap = document.getElementById('gs-wrap');
    const input = document.getElementById('gs-input');
    const box = document.getElementById('gs-results');
    const mobileBtn = document.getElementById('btn-search-mobile');
    if (!wrap || !input || !box) return;
    if (mobileBtn) mobileBtn.innerHTML = ui.icon('search');

    let items = [];      // плоский список для стрелок
    let active = -1;
    let seq = 0;

    const close = () => {
      box.classList.add('hidden');
      wrap.classList.remove('gs-mobile-open');
      active = -1;
    };

    const go = it => {
      close();
      input.value = '';
      App.go(it.href);
    };

    const money = v => ui.money(v);
    const row = (it, i) => `
      <div class="gs-item" data-i="${i}">
        ${it.thumb
          ? `<img class="gs-thumb" src="${ui.esc(ui.photoUrl(it.thumb))}" alt="" loading="lazy">`
          : `<div class="gs-thumb-empty">${ui.icon(it.icon || 'gem')}</div>`}
        <div class="gs-main">
          <div class="gs-line1">${it.line1}</div>
          <div class="gs-line2">${it.line2}</div>
        </div>
        <div class="gs-right">${it.right || ''}</div>
      </div>`;

    // Из ответа сервера делаем однородные строки: у всех разделов одна форма,
    // поэтому список читается одинаково, чем бы ни оказалась находка.
    function flatten(data) {
      const out = [];
      for (const g of data.groups || []) {
        const start = out.length;
        for (const r of g.items) {
          if (g.key === 'products') {
            const stone = [r.carat ? ui.num(r.carat) + ' ct' : '', r.color, r.clarity]
              .filter(Boolean).join(' · ');
            out.push({ group: g.title, thumb: r.thumb, icon: 'gem',
              line1: ui.esc(r.name),
              line2: `<span class="mono">${ui.esc(r.sku)}</span>` +
                (stone ? ' · ' + ui.esc(stone) : '') +
                (r.status !== 'in_stock' ? ' · ' + ui.badge('status', r.status) : ''),
              right: money(r.retail_price), href: '#/products/' + r.id });
          } else if (g.key === 'customers') {
            out.push({ group: g.title, icon: 'users',
              line1: ui.esc(r.name),
              line2: ui.esc(r.phone || 'без телефона') +
                (r.discount > 0 ? ` · скидка ${ui.num(r.discount)}%` : ''),
              right: r.purchases ? `покупок: ${r.purchases}` : '',
              href: '#/customers/' + r.id });
          } else if (g.key === 'sales') {
            const debt = Math.round((r.total - r.paid) * 100) / 100;
            out.push({ group: g.title, icon: 'sale',
              line1: `<span class="mono">${ui.esc(r.number)}</span> · ${ui.esc(r.customer_name || 'без клиента')}`,
              line2: ui.dt(r.created_at) + ` · позиций: ${r.items_count}` +
                (debt > 0.009 ? ` · <span class="crit">долг ${money(debt)}</span>` : ''),
              right: money(r.total), href: '#/sales/' + r.id });
          } else if (g.key === 'orders') {
            out.push({ group: g.title, icon: 'wrench',
              line1: `<span class="mono">${ui.esc(r.number)}</span> · ${ui.esc(r.customer_name || '—')}`,
              line2: ui.badge('order', r.status) + (r.due_date ? ' · до ' + ui.dateOnly(r.due_date) : ''),
              right: money(r.final_price > 0 ? r.final_price : r.estimate),
              href: '#/orders/' + r.id });
          } else {
            out.push({ group: g.title, icon: 'gift',
              line1: ui.esc(r.name),
              line2: `<span class="mono">${ui.esc(r.sku)}</span> · изделий: ${r.items_count}`,
              right: money(r.price), href: '#/sets/' + r.id });
          }
        }
        if (g.more) out[start].moreAfterGroup = g.title;
      }
      return out;
    }

    function draw(data) {
      items = flatten(data);
      if (!items.length) {
        box.innerHTML = `<div class="gs-empty">Ничего не нашлось по запросу «${ui.esc(data.query)}».</div>`;
        box.classList.remove('hidden');
        return;
      }
      let html = '';
      let group = '';
      items.forEach((it, i) => {
        if (it.group !== group) { group = it.group; html += `<div class="gs-group-title">${ui.esc(group)}</div>`; }
        html += row(it, i);
      });
      const more = (data.groups || []).filter(g => g.more).map(g => g.title.toLowerCase());
      if (more.length) {
        html += `<div class="gs-more">Показано по пять — уточните запрос, чтобы сузить: ${ui.esc(more.join(', '))}.</div>`;
      }
      html += '<div class="gs-hint">Стрелки — выбор, Enter — открыть, Esc — закрыть.</div>';
      box.innerHTML = html;
      box.classList.remove('hidden');
      box.querySelectorAll('.gs-item').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); go(items[Number(el.dataset.i)]); });
      });
      active = -1;
    }

    const search = ui.debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      const my = ++seq;
      try {
        const data = await api.get('/api/search?q=' + encodeURIComponent(q));
        if (my !== seq) return;     // ответ устарел — уже идёт новый запрос
        draw(data);
      } catch { close(); }
    }, 220);

    input.addEventListener('input', search);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) search(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (!items.length || box.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = e.key === 'ArrowDown'
          ? (active + 1) % items.length
          : (active - 1 + items.length) % items.length;
        box.querySelectorAll('.gs-item').forEach((el, i) => el.classList.toggle('active', i === active));
        const el = box.querySelector('.gs-item.active');
        if (el) el.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        go(items[active >= 0 ? active : 0]);
      }
    });
    /*
     * Клик мимо закрывает список, но не мешает ни выбрать строку (mousedown
     * выше), ни открыть поиск на телефоне. Проверяем именно contains: клик
     * попадает в значок внутри кнопки, а не в саму кнопку.
     */
    document.addEventListener('click', e => {
      if (wrap.contains(e.target)) return;
      if (mobileBtn && mobileBtn.contains(e.target)) return;
      close();
    });
    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => {
        wrap.classList.add('gs-mobile-open');
        input.focus();
      });
    }
    // На компьютере поиск открывается с клавиатуры — руки не уходят с клавиш.
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        wrap.classList.add('gs-mobile-open');
        input.focus();
        input.select();
      }
    });
  }

  window.addEventListener('hashchange', route);

  // ---------- Живое обновление ----------
  /*
   * Данные у всех устройств общие с самого начала — база одна. Но экран сам
   * себя не перерисовывал: пока продавец держал открытым каталог, он ещё
   * какое-то время видел проданное коллегой кольцо «в наличии». Продать его он
   * не смог бы, сервер честно отвечает «уже продано», — но выглядело это как
   * рассинхронизация и подрывало доверие к цифрам на экране.
   *
   * Теперь приложение раз в несколько секунд спрашивает у сервера, сдвинулся ли
   * счётчик изменений (ответ — несколько десятков байт), и перерисовывает
   * страницу, если да.
   */
  const ОПРОС_МС = 5000;
  let счётчик = null;      // последний известный номер изменения
  let отметкаЗапуска = ''; // чтобы заметить перезапуск сервера
  let обновитьПотом = false;

  /*
   * Перерисовка «молча»: без прыжка к началу страницы и без надписи «Загрузка…».
   * Готовим содержимое в стороне и подставляем готовым — иначе на глазах у
   * продавца страница моргала бы каждые несколько секунд.
   */
  async function тихоОбновить() {
    if (!App.user) return;
    const { key, param } = currentRoute();
    const page = Pages[key] || Pages.dashboard;
    const host = document.getElementById('page');
    if (!host) return;
    const свежий = document.createElement('div');
    try { await page.render(свежий, param); } catch { return; }  // не вышло — не трогаем экран
    const прокрутка = window.scrollY;
    host.replaceChildren(свежий);
    window.scrollTo(0, прокрутка);
  }

  /*
   * Можно ли перерисовывать прямо сейчас.
   *
   * Нельзя, если человек что-то делает: открыто окно (карточка изделия, касса,
   * приём оплаты) или он печатает в поле. Перерисовка стёрла бы наполовину
   * заполненную форму — и продавец, набивавший карточку с весом, пробой
   * и вставками, потерял бы всё без объяснений. Такое «обновление» хуже, чем
   * его отсутствие, поэтому ждём, пока освободится.
   */
  function можноОбновлять() {
    if (document.querySelector('.modal-overlay')) return false;
    const а = document.activeElement;
    if (а && /^(INPUT|TEXTAREA|SELECT)$/.test(а.tagName)) return false;
    if (window.getSelection && String(window.getSelection()).length > 20) return false;
    return true;
  }

  async function спроситьИзменения() {
    if (!App.user || document.hidden) return;
    let ответ;
    try {
      ответ = await api.get('/api/changes?since=' + (счётчик === null ? '' : счётчик));
    } catch {
      return;   // нет связи — просто попробуем в следующий раз, без ошибок на экране
    }
    const первыйРаз = счётчик === null;
    const перезапуск = отметкаЗапуска && ответ.boot !== отметкаЗапуска;
    отметкаЗапуска = ответ.boot;
    счётчик = ответ.rev;
    if (первыйРаз) return;                       // только запомнили точку отсчёта
    /*
     * Судим по списку разделов, а не по тому, что счётчик сдвинулся: сдвинуть
     * его могло наше же собственное действие, и тогда сервер вернёт пустой
     * список. Перерисовываться на свои действия не нужно — страница уже
     * обновилась сразу после них.
     */
    const естьЧто = перезапуск || ответ['всё'] || (ответ['что'] || []).length > 0;
    if (!естьЧто) return;

    /*
     * Настройки магазина живут не на странице, а в самом приложении: валюта,
     * название, формат сумм, телефонный код. Перерисовка страницы их не
     * обновит, и владелец, сменивший валюту, увидел бы новую только у себя,
     * а продавцы — старую до следующего входа. Поэтому забираем их заново.
     */
    const менялисьНастройки = ответ['всё'] || перезапуск
      || (ответ['что'] || []).some(р => р === 'settings' || р === 'me');
    if (менялисьНастройки) {
      try {
        const me = await api.get('/api/me');
        App.storeName = me.store_name || 'Asher';
        App.storePhone = me.store_phone || '';
        if (me.locale) App.locale = me.locale;
      } catch { /* не вышло — покажем прежние, страница всё равно обновится */ }
    }

    if (!можноОбновлять()) { обновитьПотом = true; return; }
    await тихоОбновить();
  }

  setInterval(спроситьИзменения, ОПРОС_МС);

  /*
   * Телефон достали из кармана — спрашиваем сразу, не дожидаясь очереди.
   * Это самый частый случай в магазине: экран был погашен, за это время
   * коллега что-то продал.
   */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) спроситьИзменения();
  });
  window.addEventListener('focus', () => спроситьИзменения());

  /*
   * Освободилось окно или поле ввода — выполняем отложенную перерисовку.
   * Проверяем раз в секунду: это дёшево и не требует ловить закрытие каждого
   * окна по отдельности.
   */
  setInterval(() => {
    if (обновитьПотом && можноОбновлять()) { обновитьПотом = false; тихоОбновить(); }
  }, 1000);

  // ---------- Загрузка ----------
  (async () => {
    try {
      const me = await api.get('/api/me');
      App.user = me.user;
      App.storeName = me.store_name || 'Asher';
      App.storePhone = me.store_phone || '';
      if (me.locale) App.locale = me.locale;
      App.showApp();
    } catch {
      App.showLogin();
    }
  })();

  return App;
})();
