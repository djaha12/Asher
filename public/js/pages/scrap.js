'use strict';
window.Pages = window.Pages || {};

/*
 * Старое золото, принятое в зачёт покупок: сколько граммов какой пробы
 * лежит в сейфе и все акты приёма. Раньше это знали только по памяти
 * и по пакетикам с бумажками.
 */
window.Pages.scrap = (() => {
  const г = w => ui.num(w, 3) + ' г';

  async function refresh(el) {
    const { stock, items } = await api.get('/api/scrap');
    if (!el.isConnected) return;
    const всегоВес = stock.reduce((s, x) => s + x.weight, 0);
    const всегоЧистого = stock.reduce((s, x) => s + x.pure_weight, 0);
    el.querySelector('#scrap-stock').innerHTML = stock.length ? `
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="big-stat accent-gold"><div class="bs-label">Всего принято</div>
          <div class="bs-value">${г(всегоВес)}</div>
          <div class="bs-sub">чистого золота ${г(всегоЧистого)}</div></div>
        ${stock.map(x => `<div class="big-stat"><div class="bs-label">${x.fineness} проба</div>
          <div class="bs-value">${г(x.weight)}</div>
          <div class="bs-sub">чистого ${г(x.pure_weight)} · зачтено ${ui.money(x.amount)}</div></div>`).join('')}
      </div>` : `<div class="card empty"><p>Старое золото ещё не принимали.</p>
        <p class="muted">В кассе — кнопка «Старое золото в зачёт»: взвесили, выбрали пробу,
        и оценка сама идёт в оплату покупки. Цену грамма задаёт владелец в Настройках.</p></div>`;
    const list = el.querySelector('#scrap-list');
    list.innerHTML = ui.table([
      { title: 'Акт', render: r => `<b>${ui.esc(r.number)}</b>` },
      { title: 'Когда', render: r => ui.dt(r.created_at) },
      { title: 'Клиент', render: r => ui.esc(r.customer_name || '—') },
      { title: 'Что', render: r => r.items.map(i => `${ui.esc(i.description || 'лом')} ${i.fineness}`).join(', ') },
      { title: 'Вес', cls: 'num', render: r => г(r.weight) },
      { title: 'В зачёт', cls: 'num strong', render: r => ui.money(r.amount) },
      { title: 'Чек', render: r => r.sale_number ? `<a href="#/sales/${r.sale_id}">${ui.esc(r.sale_number)}</a>` : '—' },
      { title: '', render: r => `<button class="btn btn-sm" data-act-print="${r.id}">${ui.icon('print')} Акт</button>` },
    ], items, { empty: 'Актов ещё нет' });
    list.querySelectorAll('[data-act-print]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const а = items.find(x => x.id === Number(b.dataset.actPrint));
      if (а) Pages.sales.печатьАкта(а);
    }));
  }

  return {
    title: 'Старое золото',
    async render(el) {
      el.innerHTML = `<div id="scrap-stock"></div>
        <div class="card"><h3 class="card-title">Акты приёма</h3><div id="scrap-list"></div></div>`;
      App.обновлятьТак(el, () => refresh(el));
      await refresh(el);
    },
  };
})();
