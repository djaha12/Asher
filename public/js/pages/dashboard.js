'use strict';
window.Pages = window.Pages || {};

window.Pages.dashboard = {
  title: 'Главная',
  async render(el) {
    const [d, bd] = await Promise.all([
      api.get('/api/dashboard?tz=' + api.tz()),
      api.get('/api/customers/birthdays?days=14'),
    ]);
    const admin = App.isAdmin();

    el.innerHTML = `
      <div class="grid grid-4">
        <div class="stat-tile">
          <div class="stat-label">Выручка сегодня</div>
          <div class="stat-value">${ui.money(d.today.revenue)}</div>
          <div class="stat-sub">${d.today.sales_count ? `${d.today.sales_count} прод., средний чек ${ui.money(d.today.avg_check)}` : 'Продаж пока не было'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Выручка за месяц</div>
          <div class="stat-value">${ui.money(d.month.revenue)}</div>
          <div class="stat-sub">${admin ? `Прибыль <span class="up">${ui.money(d.month.profit)}</span> · ` : ''}${d.month.sales_count} продаж</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Изделий в наличии</div>
          <div class="stat-value">${ui.num(d.stock.count)}</div>
          <div class="stat-sub">${admin ? `На витрине на ${ui.money(d.stock.retail_value)}` : (d.reserved ? `${d.reserved} в резерве` : 'Резервов нет')}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Заказы в работе</div>
          <div class="stat-value">${ui.num(d.orders.active)}</div>
          <div class="stat-sub">${d.orders.ready ? `<span class="up">${d.orders.ready} готово к выдаче</span>` : 'Все выданы'}</div>
        </div>
      </div>

      <div class="two-col" style="margin-top:18px">
        <div>
          <div class="card">
            <h3 class="card-title">Выручка за 14 дней</h3>
            <div id="dash-chart"></div>
          </div>
          <div class="card">
            <h3 class="card-title">Последние продажи</h3>
            <div id="dash-recent"></div>
          </div>
        </div>
        <div>
          <div class="card">
            <h3 class="card-title">Поводы связаться 🎁</h3>
            <div id="dash-bd"></div>
          </div>
          <div class="card">
            <h3 class="card-title">Быстрые действия</h3>
            <div style="display:flex;flex-direction:column;gap:9px">
              <button class="btn" id="qa-sale">₽ &nbsp;Оформить продажу</button>
              <button class="btn" id="qa-product">💍 &nbsp;Добавить изделие</button>
              <button class="btn" id="qa-customer">👤 &nbsp;Новый клиент</button>
              <button class="btn" id="qa-order">🛠 &nbsp;Принять заказ / ремонт</button>
            </div>
          </div>
        </div>
      </div>`;

    charts.lineChart(document.getElementById('dash-chart'), {
      labels: d.revenue_14d.map(r => r.date),
      series: [{ name: 'Выручка', color: '#2a78d6', values: d.revenue_14d.map(r => r.revenue) }],
      height: 230,
    });

    const recent = document.getElementById('dash-recent');
    recent.innerHTML = ui.table([
      { title: 'Чек', render: r => `<span class="strong">${ui.esc(r.number)}</span>` },
      { title: 'Когда', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
      { title: 'Клиент', render: r => ui.esc(r.customer_name || '—') },
      { title: 'Продавец', render: r => `<span class="dim">${ui.esc(r.seller_name || '—')}</span>` },
      { title: 'Сумма', cls: 'num strong', render: r => ui.money(r.total) },
    ], d.recent_sales, { empty: 'Продаж пока нет — самое время оформить первую!', onRow: r => App.go('#/sales/' + r.id) });
    ui.bindRows(recent, d.recent_sales, r => App.go('#/sales/' + r.id));

    const bdEl = document.getElementById('dash-bd');
    if (!bd.items.length) {
      bdEl.innerHTML = '<p class="muted" style="margin:4px 0">В ближайшие 2 недели дней рождения и годовщин у клиентов нет.</p>';
    } else {
      bdEl.innerHTML = bd.items.slice(0, 8).map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
          <div>
            <a href="#/customers/${b.id}">${ui.esc(b.name)}</a>
            <div class="muted" style="font-size:12px">${b.kind === 'birthday' ? 'День рождения' : 'Годовщина'} · ${ui.esc(b.phone || 'без телефона')}</div>
          </div>
          <span class="badge ${b.in_days <= 3 ? 'badge-gold' : 'badge-gray'}">${b.in_days === 0 ? 'сегодня!' : 'через ' + b.in_days + ' дн.'}</span>
        </div>`).join('');
    }

    document.getElementById('qa-sale').onclick = () => Pages.sales.newSale();
    document.getElementById('qa-product').onclick = () => { App.go('#/products'); setTimeout(() => Pages.products.openEditor(), 100); };
    document.getElementById('qa-customer').onclick = () => { App.go('#/customers'); setTimeout(() => Pages.customers.openEditor(), 100); };
    document.getElementById('qa-order').onclick = () => { App.go('#/orders'); setTimeout(() => Pages.orders.openEditor(), 100); };
  },
};
