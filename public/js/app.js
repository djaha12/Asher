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

    // Совместимость: страницы обращаются к App.currency как к подписи валюты.
    get currency() { return App.locale.currency || ''; },

    showLogin() {
      document.getElementById('app').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      setTimeout(() => document.getElementById('login-username').focus(), 50);
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
      if (res.locale) App.locale = res.locale;
      document.getElementById('login-password').value = '';
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

  window.addEventListener('hashchange', route);

  // ---------- Загрузка ----------
  (async () => {
    try {
      const me = await api.get('/api/me');
      App.user = me.user;
      App.storeName = me.store_name || 'Asher';
      if (me.locale) App.locale = me.locale;
      App.showApp();
    } catch {
      App.showLogin();
    }
  })();

  return App;
})();
