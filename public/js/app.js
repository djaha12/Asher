'use strict';
// Оболочка приложения: вход, навигация, маршрутизация
window.App = (() => {
  const Pages = window.Pages;

  const NAV = [
    { section: 'Обзор' },
    { key: 'dashboard', title: 'Главная', ico: '◆' },
    { section: 'Торговля' },
    { key: 'sales', title: 'Продажи', ico: '₽' },
    { key: 'products', title: 'Каталог изделий', ico: '💍' },
    { key: 'customers', title: 'Клиенты', ico: '👤' },
    { key: 'orders', title: 'Заказы и ремонт', ico: '🛠' },
    { section: 'Управление', admin: true },
    { key: 'finance', title: 'Финансы', ico: '📒', admin: true },
    { key: 'analytics', title: 'Аналитика', ico: '📈', admin: true },
    { key: 'import', title: 'Импорт из 1С', ico: '⇄', admin: true },
    { key: 'settings', title: 'Настройки', ico: '⚙' },
  ];

  const App = {
    user: null,
    currency: '₽',
    storeName: 'Asher',

    showLogin() {
      document.getElementById('app').classList.add('hidden');
      document.getElementById('login-screen').classList.remove('hidden');
      setTimeout(() => document.getElementById('login-username').focus(), 50);
    },

    showApp() {
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('brand-name').textContent = App.storeName;
      document.getElementById('login-title').textContent = App.storeName;
      document.getElementById('user-name').textContent = App.user.name;
      document.getElementById('user-role').textContent = App.user.role === 'admin' ? 'Администратор' : 'Продавец';
      document.getElementById('user-avatar').textContent = (App.user.name || '?')[0].toUpperCase();
      renderNav();
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
        : `<div class="nav-item" data-key="${item.key}"><span class="ico">${item.ico}</span>${item.title}</div>`
      ).join('');
    nav.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => App.go('#/' + el.dataset.key));
    });
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

    document.querySelectorAll('.nav-item').forEach(el =>
      el.classList.toggle('active', el.dataset.key === (Pages[key] ? key : 'dashboard')));
    document.getElementById('page-title').textContent = page.title;
    const el = document.getElementById('page');
    el.innerHTML = '<div class="empty"><p>Загрузка…</p></div>';
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
      const me = await api.get('/api/me');
      App.currency = me.currency || '₽';
      document.getElementById('login-password').value = '';
      App.showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    try { await api.post('/api/logout'); } catch { /* не критично */ }
    App.user = null;
    App.showLogin();
  });

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
      App.currency = me.currency || '₽';
      App.showApp();
    } catch {
      App.showLogin();
    }
  })();

  return App;
})();
