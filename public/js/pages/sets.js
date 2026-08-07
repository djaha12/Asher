'use strict';
window.Pages = window.Pages || {};

/*
 * Комплекты (гарнитуры).
 *
 * Комплект — это не отдельный товар на складе, а объединение уже заведённых
 * изделий: кольцо, серьги и подвеска остаются каждый со своим артикулом и
 * весом. Поэтому склад не удваивается, а комплект можно в любой момент
 * разобрать обратно.
 */
window.Pages.sets = (() => {
  let pageEl = null;
  let sets = [];

  function statusBadge(s) {
    const [tone, label] = !s.count ? ['gray', 'пустой']
      : s.sold_count === s.count ? ['gray', 'продан']
        : !s.complete ? ['warn', 'неполный']
          : ['good', 'в наличии'];
    return `<span class="badge badge-${tone}">${label}</span>`;
  }

  function setCard(s) {
    const saving = s.items_total - s.price;
    return `
      <div class="card set-card" data-set="${s.id}">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
          <div>
            <div style="font-size:17px;font-weight:650">${ui.esc(s.name)}</div>
            <div class="muted" style="font-size:12.5px">
              ${s.sku ? `<span class="mono">${ui.esc(s.sku)}</span> · ` : ''}
              ${s.count} изд. · ${ui.num(s.weight_total)} г
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:18px;font-weight:700">${ui.money(s.price)}</div>
            ${saving > 0.009 ? `<div class="good" style="font-size:12.5px">выгода ${ui.money(saving)}</div>` : ''}
          </div>
        </div>
        <div style="margin:10px 0">${statusBadge(s)}
          ${s.price_above_items ? `<span class="warn" style="font-size:12.5px;margin-left:8px">
            цена комплекта выше суммы изделий — проверьте</span>` : ''}</div>
        <div class="set-items">
          ${s.items.map(i => `
            <div class="set-item">
              ${i.thumb ? `<img src="/media/${ui.esc(i.thumb)}" alt="">`
                : `<div class="set-item-noimg">${ui.icon('gem')}</div>`}
              <div class="grow">
                <div style="font-weight:600;font-size:13.5px">${ui.esc(i.name)}</div>
                <div class="muted" style="font-size:12px">
                  <span class="mono">${ui.esc(i.sku)}</span>
                  ${i.status === 'sold' ? ' · продано' : ''}
                  ${i.status === 'written_off' ? ' · списано' : ''}
                  ${i.status === 'reserved' ? ' · в резерве' : ''}
                </div>
              </div>
              <div style="text-align:right;font-size:13px">
                <div>${ui.money(i.retail_price)}</div>
                ${i.sale_discount > 0.009
                  ? `<div class="good" style="font-size:12px">−${ui.money(i.sale_discount)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
        <div class="row" style="margin-top:12px">
          ${s.complete ? `<button class="btn btn-primary grow" data-act="sell">${ui.icon('sale')} Продать комплект</button>` : ''}
          ${App.isAdmin() ? `<button class="btn" data-act="edit">Изменить</button>
          <button class="btn btn-danger" data-act="disband">Разобрать</button>` : ''}
        </div>
      </div>`;
  }

  // ---------- Диалог сборки ----------

  function editDialog(existing, onDone) {
    const isNew = !existing;
    // Изделия комплекта держим в Map: порядок добавления и быстрый поиск.
    const picked = new Map((existing ? existing.items : []).map(i => [i.id, i]));

    const m = ui.modal({
      title: isNew ? 'Новый комплект' : 'Комплект: ' + existing.name,
      size: 'lg',
      body: `
        <div class="hint-box" style="margin-bottom:14px">
          Соберите гарнитур из изделий, которые уже есть в каталоге. Цена комплекта
          обычно ниже суммы цен — разница разложится по позициям скидкой при продаже.
          Изделия остаются на складе каждое со своим артикулом.
        </div>
        <div class="form-grid-3">
          <label class="field"><span>Название</span>
            <input class="input" id="st-name" value="${ui.esc(existing ? existing.name : '')}"
              placeholder="Гарнитур «Сияние»"></label>
          <label class="field"><span>Артикул комплекта</span>
            <input class="input mono" id="st-sku" value="${ui.esc(existing ? existing.sku : '')}"
              placeholder="SET-001"></label>
          <label class="field"><span>Цена комплекта</span>
            <input class="input" id="st-price" type="number" min="0" step="1"
              value="${existing && existing.price ? existing.price : ''}" placeholder="сумма изделий"></label>
        </div>
        <label class="field"><span>Заметка</span>
          <input class="input" id="st-note" value="${ui.esc(existing ? existing.note : '')}"></label>

        <h4 style="margin:16px 0 8px">Изделия комплекта</h4>
        <div id="st-picked"></div>
        <label class="field" style="margin-top:10px"><span>Добавить изделие (поиск по названию или артикулу)</span>
          <div class="rel"><input class="input" id="st-search" placeholder="Начните вводить…" autocomplete="off"></div>
        </label>
        <div id="st-results"></div>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="save">${isNew ? 'Собрать комплект' : 'Сохранить'}</button>`,
    });

    const pickedBox = m.body.querySelector('#st-picked');
    const priceInput = m.body.querySelector('#st-price');

    function renderPicked() {
      const list = [...picked.values()];
      const total = list.reduce((s, i) => s + i.retail_price, 0);
      pickedBox.innerHTML = list.length ? `
        ${list.map(i => `
          <div class="set-item">
            <div class="grow">
              <div style="font-weight:600;font-size:13.5px">${ui.esc(i.name)}</div>
              <div class="muted" style="font-size:12px"><span class="mono">${ui.esc(i.sku)}</span>
                ${i.metal ? ' · ' + ui.esc(i.metal) : ''}${i.weight ? ' · ' + ui.num(i.weight) + ' г' : ''}</div>
            </div>
            <div style="font-size:13px">${ui.money(i.retail_price)}</div>
            <button class="btn btn-sm btn-danger" data-rm="${i.id}">×</button>
          </div>`).join('')}
        <div class="pos-total" style="margin-top:8px">
          <span>Сумма цен изделий</span><b>${ui.money(total)}</b></div>`
        : '<div class="muted">Пока пусто — добавьте минимум два изделия.</div>';
      pickedBox.querySelectorAll('[data-rm]').forEach(b => {
        b.onclick = () => { picked.delete(Number(b.dataset.rm)); renderPicked(); };
      });
      priceInput.placeholder = total ? `сумма изделий: ${total}` : 'сумма изделий';
    }
    renderPicked();

    // Поиск изделий: в комплект годится только то, что не продано и не списано.
    const search = m.body.querySelector('#st-search');
    const results = m.body.querySelector('#st-results');
    let seq = 0;
    search.addEventListener('input', ui.debounce(async () => {
      const q = search.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      const my = ++seq;
      try {
        const { items } = await api.get('/api/products?limit=20&search=' + encodeURIComponent(q));
        if (my !== seq) return;
        const free = items.filter(p =>
          (p.status === 'in_stock' || p.status === 'reserved') && !picked.has(p.id) && !p.set_id);
        results.innerHTML = free.length
          ? free.slice(0, 8).map(p => `
              <div class="set-item pick" data-add="${p.id}" style="cursor:pointer">
                <div class="grow">
                  <div style="font-weight:600;font-size:13.5px">${ui.esc(p.name)}</div>
                  <div class="muted" style="font-size:12px"><span class="mono">${ui.esc(p.sku)}</span></div>
                </div>
                <div style="font-size:13px">${ui.money(p.retail_price)}</div>
              </div>`).join('')
          : '<div class="muted" style="padding:6px 0">Свободных изделий не найдено.</div>';
        results.querySelectorAll('[data-add]').forEach(el => {
          el.onclick = () => {
            const p = free.find(x => x.id === Number(el.dataset.add));
            picked.set(p.id, p);
            search.value = ''; results.innerHTML = '';
            renderPicked();
          };
        });
      } catch (e) { ui.toastErr(e); }
    }));

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=save]').onclick = async () => {
      const payload = {
        name: m.body.querySelector('#st-name').value.trim(),
        sku: m.body.querySelector('#st-sku').value.trim(),
        price: Number(priceInput.value) || 0,
        note: m.body.querySelector('#st-note').value.trim(),
        product_ids: [...picked.keys()],
      };
      try {
        if (isNew) await api.post('/api/sets', payload);
        else await api.put('/api/sets/' + existing.id, payload);
        ui.toast(isNew ? 'Комплект собран' : 'Комплект сохранён');
        m.close();
        onDone && onDone();
      } catch (e) { ui.toastErr(e); }
    };
  }

  // ---------- Страница ----------

  async function refresh() {
    const res = await api.get('/api/sets');
    if (!pageEl.isConnected) return;
    sets = res.items;
    const box = pageEl.querySelector('#sets-list');
    box.innerHTML = sets.length
      ? `<div class="grid grid-2">${sets.map(setCard).join('')}</div>`
      : `<div class="card empty"><p>Комплектов пока нет. Соберите первый — например,
           кольцо, серьги и подвеску одного гарнитура.</p></div>`;

    box.querySelectorAll('[data-set]').forEach(card => {
      const s = sets.find(x => x.id === Number(card.dataset.set));
      const btn = a => card.querySelector(`[data-act=${a}]`);
      if (btn('edit')) btn('edit').onclick = () => editDialog(s, refresh);
      if (btn('sell')) btn('sell').onclick = async () => {
        // Комплект уходит в кассу готовыми позициями со скидками: раскладку
        // считает сервер, чтобы сумма чека совпала с ценой комплекта до копейки.
        try {
          const fresh = await api.get('/api/sets/' + s.id);
          Pages.sales.newSale(null, null, fresh);
        } catch (e) { ui.toastErr(e); }
      };
      if (btn('disband')) btn('disband').onclick = async () => {
        const yes = await ui.confirmDialog(
          `Разобрать комплект «${s.name}»? Изделия останутся на складе каждое само ` +
          'по себе — ничего не потеряется.', { danger: true, okLabel: 'Разобрать' });
        if (!yes) return;
        try { await api.del('/api/sets/' + s.id); ui.toast('Комплект разобран'); refresh(); }
        catch (e) { ui.toastErr(e); }
      };
    });
  }

  async function render(el) {
    pageEl = el;
    el.innerHTML = `
      <div class="hint-box">
        <strong>Комплект (гарнитур)</strong> — кольцо, серьги и подвеска одной позицией.
        Продаётся одним движением по своей цене, а на складе остаётся тремя изделиями:
        остатки и граммы не задваиваются. В любой момент можно разобрать обратно.
      </div>
      <div class="toolbar">
        ${App.isAdmin()
          ? `<button class="btn btn-primary" id="sets-new">${ui.icon('plus')} Собрать комплект</button>`
          : '<div class="muted">Комплекты собирает администратор — продать готовый может любой продавец.</div>'}
      </div>
      <div id="sets-list"></div>`;
    const newBtn = el.querySelector('#sets-new');
    if (newBtn) newBtn.onclick = () => editDialog(null, refresh);
    await refresh();
  }

  return { title: 'Комплекты', render };
})();
