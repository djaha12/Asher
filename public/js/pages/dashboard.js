'use strict';
window.Pages = window.Pages || {};

/*
 * Главная. Сверху — то, что владелец хочет видеть каждое утро:
 * деньги за день и месяц, кто сколько должен, склад в деньгах и граммах.
 */
window.Pages.dashboard = {
  title: 'Главная',
  async render(el) {
    const [d, bd] = await Promise.all([
      api.get('/api/dashboard?tz=' + api.tz()),
      api.get('/api/customers/birthdays?days=14'),
    ]);
    if (!el.isConnected) return;
    const admin = App.isAdmin();
    const debts = d.debts || { customers_owe: 0, overdue: 0, debtors_count: 0, top: [] };

    // Разбивка склада по металлам — показываем три самых весомых.
    const metals = (d.stock.by_metal || []).filter(m => m.weight > 0).slice(0, 3);

    el.innerHTML = `
      <div class="grid grid-4">
        <div class="big-stat accent-good">
          <div class="bs-label">Продали сегодня</div>
          <div class="bs-value">${ui.money(d.today.revenue)}</div>
          <div class="bs-sub">${d.today.sales_count
            ? `${d.today.sales_count} продаж, средний чек ${ui.money(d.today.avg_check)}`
            : 'Продаж пока не было'}</div>
        </div>
        <div class="big-stat accent-gold">
          <div class="bs-label">Продали за месяц</div>
          <div class="bs-value">${ui.money(d.month.revenue)}</div>
          <div class="bs-sub">${admin
            ? `Заработали чистыми <b class="good">${ui.money(d.month.profit)}</b>`
            : `${d.month.sales_count} продаж`}</div>
        </div>
        <div class="big-stat ${debts.overdue > 0 ? 'accent-crit' : ''}">
          <div class="bs-label">Должны нам</div>
          <div class="bs-value ${debts.overdue > 0 ? 'crit' : ''}">${ui.money(debts.customers_owe)}</div>
          <div class="bs-sub">${debts.customers_owe > 0
            ? `${debts.debtors_count} чел.` + (debts.overdue > 0
              ? ` · <b class="crit">просрочено ${ui.money(debts.overdue)}</b>` : ' · всё в срок')
            : 'Долгов нет'}</div>
        </div>
        <div class="big-stat">
          <div class="bs-label">Товара на складе</div>
          <div class="bs-value">${admin ? ui.money(d.stock.retail_value) : ui.num(d.stock.count) + ' шт'}</div>
          <div class="bs-sub">${ui.num(d.stock.count)} изделий · <b>${ui.num(d.stock.weight)} г</b>
            ${d.reserved ? ` · ${d.reserved} в резерве` : ''}</div>
        </div>
      </div>

      ${admin && debts.we_owe > 0 ? `
        <div class="card" style="margin-top:18px;border-left:4px solid var(--warn)">
          <div class="row">
            <div class="grow">
              <div class="stat-label">Мы должны поставщикам</div>
              <div class="big-money">${ui.money(debts.we_owe)}</div>
            </div>
            <button class="btn" id="qa-suppliers">Открыть расчёты</button>
          </div>
        </div>` : ''}

      <div class="two-col" style="margin-top:18px">
        <div>
          <div class="card">
            <h3 class="card-title">Выручка за 14 дней</h3>
            <div id="dash-chart"></div>
          </div>

          ${debts.top.length ? `<div class="card">
            <h3 class="card-title">Кто нам должен</h3>
            <div id="dash-debtors"></div>
            <button class="btn btn-block" id="qa-debts" style="margin-top:12px">Все долги и приём оплаты →</button>
          </div>` : ''}

          <div class="card">
            <h3 class="card-title">Последние продажи</h3>
            <div id="dash-recent"></div>
          </div>
        </div>

        <div>
          <div class="card">
            <h3 class="card-title">Быстрые действия</h3>
            <div style="display:flex;flex-direction:column;gap:9px">
              <button class="btn btn-primary" id="qa-sale">₽ &nbsp;Оформить продажу</button>
              <button class="btn" id="qa-pay">💰 &nbsp;Принять оплату долга</button>
              <button class="btn" id="qa-product">💍 &nbsp;Добавить изделие</button>
              <button class="btn" id="qa-customer">👤 &nbsp;Новый клиент</button>
              <button class="btn" id="qa-order">🛠 &nbsp;Принять заказ / ремонт</button>
            </div>
          </div>

          ${metals.length ? `<div class="card">
            <h3 class="card-title">Склад по металлам</h3>
            ${metals.map(m => `
              <div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
                <div class="grow">
                  <div style="font-weight:600">${ui.esc(m.metal)}</div>
                  <div class="muted" style="font-size:13px">${m.cnt} изделий</div>
                </div>
                <div style="text-align:right">
                  <div class="big-money">${ui.num(m.weight)} г</div>
                  ${admin ? `<div class="muted" style="font-size:13px">${ui.money(m.retail)}</div>` : ''}
                </div>
              </div>`).join('')}
          </div>` : ''}

          <div class="card">
            <h3 class="card-title">Заказы и ремонт</h3>
            <div class="row" style="padding:6px 0">
              <div class="grow">В работе</div><div class="big-money">${d.orders.active}</div>
            </div>
            <div class="row" style="padding:6px 0;border-top:1px solid var(--line)">
              <div class="grow">Готовы к выдаче</div>
              <div class="big-money ${d.orders.ready ? 'good' : ''}">${d.orders.ready}</div>
            </div>
          </div>

          <div class="card">
            <h3 class="card-title">Поводы связаться 🎁</h3>
            <div id="dash-bd"></div>
          </div>
        </div>
      </div>`;

    charts.lineChart(el.querySelector('#dash-chart'), {
      labels: d.revenue_14d.map(r => r.date),
      series: [{ name: 'Выручка', color: '#2a78d6', values: d.revenue_14d.map(r => r.revenue) }],
      height: 230,
    });

    const debtorsEl = el.querySelector('#dash-debtors');
    if (debtorsEl) {
      debtorsEl.innerHTML = debts.top.map(t => `
        <div class="debt-row ${t.overdue ? 'overdue' : ''}">
          <div>
            <div class="dr-name">${ui.esc(t.name)}</div>
            <div class="dr-sub">${ui.esc(t.phone || 'телефон не указан')}</div>
          </div>
          <div class="dr-sum">
            <div class="dr-amount">${ui.money(t.debt)}</div>
            ${t.overdue ? '<div class="dr-sub crit">просрочено</div>' : ''}
          </div>
        </div>`).join('');
      debtorsEl.querySelectorAll('.debt-row').forEach(row => {
        row.addEventListener('click', () => App.go('#/debts'));
      });
    }

    const recent = el.querySelector('#dash-recent');
    recent.innerHTML = ui.table([
      { title: 'Чек', render: r => `<span class="strong">${ui.esc(r.number)}</span>` },
      { title: 'Когда', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
      { title: 'Клиент', render: r => ui.esc(r.customer_name || '—') },
      { title: 'Сумма', cls: 'num strong', render: r => ui.money(r.total) },
    ], d.recent_sales, { empty: 'Продаж пока нет — самое время оформить первую!' });
    ui.bindRows(recent, d.recent_sales, r => App.go('#/sales/' + r.id));

    const bdEl = el.querySelector('#dash-bd');
    if (!bd.items.length) {
      bdEl.innerHTML = '<p class="muted" style="margin:4px 0">В ближайшие 2 недели дней рождения и годовщин у клиентов нет.</p>';
    } else {
      bdEl.innerHTML = bd.items.slice(0, 8).map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)">
          <div>
            <a href="#/customers/${b.id}">${ui.esc(b.name)}</a>
            <div class="muted" style="font-size:13px">${b.kind === 'birthday' ? 'День рождения' : 'Годовщина'} · ${ui.esc(b.phone || 'без телефона')}</div>
          </div>
          <span class="badge ${b.in_days <= 3 ? 'badge-gold' : 'badge-gray'}">${b.in_days === 0 ? 'сегодня!' : 'через ' + b.in_days + ' дн.'}</span>
        </div>`).join('');
    }

    const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.onclick = fn; };
    on('qa-sale', () => Pages.sales.newSale());
    on('qa-pay', () => App.go('#/debts'));
    on('qa-debts', () => App.go('#/debts'));
    on('qa-suppliers', () => App.go('#/debts'));
    on('qa-product', () => { App.go('#/products'); setTimeout(() => Pages.products.openEditor(), 100); });
    on('qa-customer', () => { App.go('#/customers'); setTimeout(() => Pages.customers.openEditor(), 100); });
    on('qa-order', () => { App.go('#/orders'); setTimeout(() => Pages.orders.openEditor(), 100); });
  },
};
