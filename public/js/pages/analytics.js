'use strict';
window.Pages = window.Pages || {};

window.Pages.analytics = (() => {
  let period = '90';

  function range() {
    if (!period) return { from: '', to: '' };
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(period) - 1));
    return { from: d.toISOString(), to: new Date().toISOString() };
  }

  async function load(el) {
    const { from, to } = range();
    const q = new URLSearchParams({ tz: api.tz() });
    if (from) { q.set('from', from); q.set('to', to); }
    const group = !period || Number(period) > 120 ? 'month' : 'day';
    const [summary, revenue, byCat, byMetal, topProducts, topCustomers, bySeller, byPayment, stock] = await Promise.all([
      api.get('/api/analytics/summary?' + q),
      api.get('/api/analytics/revenue?' + q + '&group=' + group),
      api.get('/api/analytics/by-category?' + q),
      api.get('/api/analytics/by-metal?' + q),
      api.get('/api/analytics/top-products?' + q + '&limit=10'),
      api.get('/api/analytics/top-customers?' + q + '&limit=10'),
      api.get('/api/analytics/by-seller?' + q),
      api.get('/api/analytics/by-payment?' + q),
      api.get('/api/analytics/stock'),
    ]);

    const body = el.querySelector('#an-body');
    body.innerHTML = `
      <div class="grid grid-4">
        <div class="stat-tile"><div class="stat-label">Выручка</div>
          <div class="stat-value">${ui.money(summary.revenue)}</div>
          <div class="stat-sub">${summary.sales_count} продаж · ${summary.items_sold} изделий</div></div>
        <div class="stat-tile"><div class="stat-label">Валовая прибыль</div>
          <div class="stat-value" style="color:var(--good)">${ui.money(summary.profit)}</div>
          <div class="stat-sub">${summary.revenue ? 'маржа ' + ui.num(summary.profit / summary.revenue * 100) + '%' : '—'}</div></div>
        <div class="stat-tile"><div class="stat-label">Средний чек</div>
          <div class="stat-value">${ui.money(summary.avg_check)}</div>
          <div class="stat-sub">скидок на ${ui.money(summary.discounts)}</div></div>
        <div class="stat-tile"><div class="stat-label">Возвраты</div>
          <div class="stat-value" style="color:${summary.returns ? 'var(--crit)' : 'var(--ink)'}">${ui.money(summary.returns)}</div>
          <div class="stat-sub">за выбранный период</div></div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3 class="card-title">Выручка и прибыль ${group === 'month' ? 'по месяцам' : 'по дням'}</h3>
        <div id="an-revenue"></div>
      </div>

      <div class="grid grid-2">
        <div class="card mb0"><h3 class="card-title">Выручка по категориям</h3><div id="an-cat"></div></div>
        <div class="card mb0"><h3 class="card-title">Выручка по металлу</h3><div id="an-metal"></div></div>
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card mb0">
          <h3 class="card-title">Топ продаж</h3>
          ${ui.table([
            { title: 'Изделие', render: r => `${ui.esc(r.name)}<div class="dim" style="font-size:11px">${ui.esc(r.sku)}</div>` },
            { title: 'Продано', render: r => `<span class="dim">${ui.dateOnly(r.sold_at)}</span>` },
            { title: 'Цена', cls: 'num strong', render: r => ui.money(r.price) },
            { title: 'Прибыль', cls: 'num', render: r => ui.money(r.profit) },
          ], topProducts.items, { empty: 'Нет продаж за период' })}
        </div>
        <div class="card mb0">
          <h3 class="card-title">Лучшие клиенты</h3>
          ${ui.table([
            { title: 'Клиент', render: r => `${ui.esc(r.name)} ${ui.badge('segment', r.segment)}` },
            { title: 'Покупок', cls: 'num', render: r => r.purchases },
            { title: 'Сумма', cls: 'num strong', render: r => ui.money(r.spent) },
          ], topCustomers.items, { empty: 'Нет продаж с клиентами за период' })}
        </div>
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card mb0"><h3 class="card-title">Продавцы</h3><div id="an-sellers"></div></div>
        <div class="card mb0"><h3 class="card-title">Способы оплаты</h3><div id="an-payment"></div></div>
      </div>

      <h2 class="section-title">Склад</h2>
      <div class="grid grid-2">
        <div class="card mb0">
          <h3 class="card-title">Остатки по категориям</h3>
          ${ui.table([
            { title: 'Категория', render: r => ui.esc(r.name) },
            { title: 'Шт', cls: 'num', render: r => r.cnt },
            { title: 'Себестоимость', cls: 'num dim', render: r => ui.money(r.cost) },
            { title: 'В рознице', cls: 'num strong', render: r => ui.money(r.retail) },
          ], stock.by_category, { empty: 'Склад пуст' })}
        </div>
        <div class="card mb0">
          <h3 class="card-title">Металл на складе</h3>
          ${ui.table([
            { title: 'Металл', render: r => ui.esc(r.name) },
            { title: 'Шт', cls: 'num', render: r => r.cnt },
            { title: 'Вес', cls: 'num', render: r => ui.num(r.weight) + ' г' },
            { title: 'В рознице', cls: 'num strong', render: r => ui.money(r.retail) },
          ], stock.by_metal, { empty: 'Склад пуст' })}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 class="card-title">Дольше всего на витрине</h3>
        ${ui.table([
          { title: 'Артикул', render: r => `<span class="mono">${ui.esc(r.sku)}</span>` },
          { title: 'Изделие', render: r => ui.esc(r.name) },
          { title: 'Металл', render: r => `<span class="dim">${ui.esc(r.metal || '—')}</span>` },
          { title: 'Поступило', render: r => `<span class="dim">${ui.dateOnly(r.created_at)}</span>` },
          { title: 'Дней на витрине', cls: 'num', render: r => Math.floor((Date.now() - new Date(r.created_at)) / 86400000) },
          { title: 'Цена', cls: 'num strong', render: r => ui.money(r.retail_price) },
        ], stock.stale_items, { empty: 'Склад пуст' })}
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">Подсказка: залежавшиеся изделия — кандидаты на акцию или переоценку.</p>
      </div>`;

    charts.lineChart(body.querySelector('#an-revenue'), {
      labels: revenue.items.map(r => r.period),
      series: [
        { name: 'Выручка', color: '#2a78d6', values: revenue.items.map(r => r.revenue) },
        { name: 'Прибыль', color: '#1baf7a', values: revenue.items.map(r => r.profit) },
      ],
      height: 260,
      labelFmt: group === 'month' ? (l => l.slice(5, 7) + '.' + l.slice(2, 4)) : undefined,
      tipTitle: group === 'month' ? (l => ui.monthName(l)) : undefined,
    });
    if (!revenue.items.length) {
      body.querySelector('#an-revenue').innerHTML = '<div class="empty"><p>Нет данных за период</p></div>';
    }
    charts.barList(body.querySelector('#an-cat'),
      byCat.items.map(r => ({ name: r.name, value: r.revenue, sub: r.items_sold + ' шт' })));
    charts.barList(body.querySelector('#an-metal'),
      byMetal.items.map(r => ({ name: r.name, value: r.revenue, sub: r.items_sold + ' шт' })));
    charts.barList(body.querySelector('#an-sellers'),
      bySeller.items.map(r => ({ name: r.name, value: r.revenue, sub: r.sales_count + ' прод.' })));
    charts.barList(body.querySelector('#an-payment'),
      byPayment.items.map(r => ({ name: ui.L.payment[r.name] || r.name, value: r.revenue, sub: r.sales_count + ' прод.' })));
  }

  return {
    title: 'Аналитика',
    async render(el) {
      el.innerHTML = `
        <div class="toolbar">
          <div class="chip-row" id="an-period">
            <button class="chip" data-p="30">30 дней</button>
            <button class="chip active" data-p="90">90 дней</button>
            <button class="chip" data-p="365">Год</button>
            <button class="chip" data-p="">Всё время</button>
          </div>
        </div>
        <div id="an-body"><div class="empty"><p>Загрузка…</p></div></div>`;
      period = '90';
      el.querySelector('#an-period').addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        el.querySelectorAll('#an-period .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        period = chip.dataset.p;
        load(el).catch(ui.toastErr);
      });
      await load(el);
    },
  };
})();
