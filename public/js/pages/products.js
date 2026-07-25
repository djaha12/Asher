'use strict';
window.Pages = window.Pages || {};

window.Pages.products = (() => {
  let cats = [], suppliers = [], stores = [];
  let filters = { search: '', status: '', category_id: '', metal: '', store_id: '', has_photo: '', sort: 'new' };
  // Вид каталога запоминается: кому-то привычнее плитки с фото, кому-то таблица.
  const VIEW_KEY = 'asher_products_view';
  let view = localStorage.getItem(VIEW_KEY) || 'grid';

  async function loadRefs() {
    [cats, suppliers, stores] = await Promise.all([
      api.get('/api/categories').then(r => r.items),
      api.get('/api/suppliers').then(r => r.items),
      api.get('/api/stores').then(r => r.items).catch(() => []),
    ]);
  }

  function gemsSummary(gems) {
    return (gems || []).map(g =>
      [g.count > 1 ? g.count + '×' : '', g.type, g.carat ? g.carat + ' ct' : '',
        [g.color, g.clarity].filter(Boolean).join('/')].filter(Boolean).join(' ')
    ).join('; ');
  }

  let refreshSeq = 0;
  async function refresh(container) {
    const my = ++refreshSeq;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    const { items, total } = await api.get('/api/products?' + q.toString());
    // устаревший ответ (быстрая смена фильтров) или уже покинули страницу
    if (my !== refreshSeq || !container.isConnected) return;
    const listEl = container.querySelector('#prod-list');
    const admin = App.isAdmin();
    const shown = items.length < total ? `Показано ${items.length} из ${total}` : `Найдено: ${total}`;
    const onPick = r => openDetail(r.id, () => refresh(container));

    if (view === 'grid') {
      listEl.innerHTML = `<div class="muted" style="margin-bottom:12px">${shown}</div>` +
        (items.length ? `<div class="pgrid">${items.map((r, i) => productCard(r, i)).join('')}</div>`
          : `<div class="empty"><div class="empty-ico">◇</div>
             <p>Изделий не найдено. Добавьте первое или измените фильтры.</p></div>`);
      listEl.querySelectorAll('.pcard').forEach(card => {
        card.addEventListener('click', () => onPick(items[Number(card.dataset.i)]));
      });
      return;
    }

    const cols = [
      { title: '', cls: 'nowrap', render: r => r.thumb
        ? `<img class="thumb-sm" src="${ui.esc(ui.photoUrl(r.thumb))}" alt="" loading="lazy">`
        : `<div class="thumb-sm-empty">${ui.icon('gem')}</div>` },
      { title: 'Артикул', render: r => `<span class="mono strong">${ui.highlight(r.sku, filters.search)}</span>` },
      { title: 'Наименование', render: r => `${ui.highlight(r.name, filters.search)}${r.gem_summary ? `<div class="dim" style="font-size:12px">${ui.esc(r.gem_summary)}</div>` : ''}` },
      { title: 'Категория', render: r => `<span class="dim">${ui.esc(r.category_name || '—')}</span>` },
      { title: 'Металл', render: r => ui.esc(r.metal || '—') },
      { title: 'Вес', cls: 'num', render: r => r.weight ? ui.num(r.weight) + ' г' : '—' },
    ];
    if (stores.length > 1) cols.push({ title: 'Точка', render: r => `<span class="dim">${ui.esc(r.store_name || '—')}</span>` });
    if (admin) cols.push({ title: 'Закупка', cls: 'num dim', render: r => ui.money(r.purchase_price) });
    cols.push(
      { title: 'Цена', cls: 'num strong', render: r => ui.money(r.retail_price) },
      { title: 'Статус', render: r => ui.badge('status', r.status) +
        (r.ownership === 'consignment' ? ' <span class="badge badge-info">реализация</span>' : '') +
        (r.reserved_for_name ? `<div class="dim" style="font-size:11px">${ui.esc(r.reserved_for_name)}</div>` : '') },
    );
    listEl.innerHTML = `<div class="muted" style="margin-bottom:8px">${shown}</div>` +
      ui.table(cols, items, { empty: 'Изделий не найдено. Добавьте первое или измените фильтры.' });
    ui.bindRows(listEl, items, onPick);
  }

  // Плитка каталога: фото крупно, под ним — то, что спрашивают у прилавка.
  function productCard(r, index) {
    const badges = [];
    if (r.status !== 'in_stock') badges.push(ui.badge('status', r.status));
    if (r.ownership === 'consignment') badges.push('<span class="badge badge-info">реализация</span>');
    return `
      <div class="pcard" data-i="${index}">
        <div class="pcard-photo">
          ${r.thumb
            ? `<img src="${ui.esc(ui.photoUrl(r.thumb))}" alt="${ui.esc(r.name)}" loading="lazy">`
            : `<div class="no-photo">${ui.icon('diamond')}</div>`}
          ${badges.length ? `<div class="pcard-badges">${badges.join('')}</div>` : ''}
          ${r.photo_count > 1 ? `<div class="photo-count">${r.photo_count} фото</div>` : ''}
        </div>
        <div class="pcard-body">
          <div class="pcard-sku">${ui.highlight(r.sku, filters.search)}</div>
          <div class="pcard-name">${ui.highlight(r.name, filters.search)}</div>
          <div class="pcard-meta">${[r.metal, r.weight ? ui.num(r.weight) + ' г' : '', r.size]
            .filter(Boolean).map(ui.esc).join(' · ') || '&nbsp;'}</div>
          <div class="pcard-price">${ui.money(r.retail_price)}</div>
        </div>
      </div>`;
  }

  function openDetail(id, onChange) {
    api.get('/api/products/' + id).then(p => {
      const gems = (p.gems || []).map(g => `
        <tr><td>${ui.esc(g.type)}</td><td class="num">${g.count || 1}</td><td class="num">${g.carat || '—'}</td>
        <td>${ui.esc(g.color || '—')}</td><td>${ui.esc(g.clarity || '—')}</td><td>${ui.esc(g.cut || '—')}</td></tr>`).join('');
      const admin = App.isAdmin();
      const m = ui.modal({
        title: p.name,
        size: 'lg',
        body: `
          <div class="grid grid-2">
            <div id="prod-gallery"></div>
            <div>
              <dl class="kv">
                <dt>Артикул</dt><dd class="mono strong">${ui.esc(p.sku)}</dd>
                <dt>Штрихкод</dt><dd class="mono">${ui.esc(p.barcode || '—')}</dd>
                <dt>Категория</dt><dd>${ui.esc(p.category_name || '—')}</dd>
                <dt>Металл</dt><dd>${ui.esc(p.metal || '—')}</dd>
                <dt>Вес</dt><dd>${p.weight ? ui.num(p.weight) + ' г' : '—'}</dd>
                <dt>Размер</dt><dd>${ui.esc(p.size || '—')}</dd>
                <dt>Статус</dt><dd>${ui.badge('status', p.status)}${p.reserved_for_name ? ' за ' + ui.esc(p.reserved_for_name) : ''}</dd>
                ${admin ? `<dt>Закупочная</dt><dd>${ui.money(p.purchase_price)}</dd>` : ''}
                <dt>Розничная</dt><dd class="big-money">${ui.money(p.retail_price)}</dd>
                ${admin && p.purchase_price > 0 ? `<dt>Наценка</dt><dd>${ui.num((p.retail_price / p.purchase_price - 1) * 100)}%</dd>` : ''}
                <dt>Принадлежность</dt><dd>${p.ownership === 'consignment'
                  ? `<span class="badge badge-info">На реализации</span> ${ui.esc(p.supplier_name || '')}`
                  : 'Наш товар'}</dd>
                <dt>Поставщик</dt><dd>${ui.esc(p.supplier_name || '—')}</dd>
                <dt>Точка продаж</dt><dd>${ui.esc(p.store_name || '—')}</dd>
                <dt>Расположение</dt><dd>${ui.esc(p.location || '—')}</dd>
                <dt>Добавлено</dt><dd>${ui.dt(p.created_at)}</dd>
              </dl>
            </div>
          </div>
          ${p.description ? `<p class="muted">${ui.esc(p.description)}</p>` : ''}
          ${gems ? `<h4 style="margin:14px 0 8px">Вставки</h4>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>Камень</th><th class="num">Шт</th><th class="num">Караты</th><th>Цвет</th><th>Чистота</th><th>Огранка</th></tr></thead>
            <tbody>${gems}</tbody></table></div>` : ''}
          ${p.history && p.history.length ? `<h4 style="margin:14px 0 8px">История продаж</h4>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>Чек</th><th>Дата</th><th>Клиент</th><th class="num">Цена</th><th></th></tr></thead>
            <tbody>${p.history.map(h => `<tr><td>${ui.esc(h.sale_number)}</td><td>${ui.dt(h.sale_date)}</td>
              <td>${ui.esc(h.customer_name || '—')}</td><td class="num">${ui.money(h.final_price)}</td>
              <td>${h.returned ? '<span class="badge badge-crit">возврат</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
        `,
        footer: `
          ${admin ? `<button class="btn btn-danger left" data-act="delete">Удалить</button>` : ''}
          <button class="btn" data-act="label">${ui.icon('tag')} Бирка</button>
          ${stores.length > 1 && p.status !== 'sold'
            ? '<button class="btn" data-act="move">→ Переместить</button>' : ''}
          ${p.status === 'in_stock' ? '<button class="btn" data-act="reserve">В резерв</button>' : ''}
          ${p.status === 'reserved' ? '<button class="btn" data-act="unreserve">Снять резерв</button>' : ''}
          ${(p.status === 'in_stock' || p.status === 'reserved') && admin ? '<button class="btn" data-act="writeoff">Списать</button>' : ''}
          <button class="btn" data-act="edit">Редактировать</button>
          ${p.status === 'in_stock' || p.status === 'reserved' ? '<button class="btn btn-primary" data-act="sell">Продать</button>' : ''}
        `,
      });
      // Галерея живёт своей жизнью: загрузка и удаление фото не трогают остальную карточку.
      Photos.gallery(m.body.querySelector('#prod-gallery'), p.id, p.images || [], {
        onChange: () => { if (onChange) onChange(); },
      });

      m.foot.addEventListener('click', async e => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) return;
        try {
          if (act === 'edit') { m.close(); openEditor(p, onChange); }
          if (act === 'sell') { m.close(); Pages.sales.newSale(p); }
          if (act === 'label') Pages.labels.printOne(p);
          if (act === 'move') { m.close(); moveDialog(p, onChange); }
          if (act === 'reserve') { m.close(); reserveDialog(p, onChange); }
          if (act === 'unreserve') {
            await api.put('/api/products/' + p.id, { status: 'in_stock', reserved_for: null });
            ui.toast('Резерв снят'); m.close(); onChange && onChange();
          }
          if (act === 'writeoff') {
            if (await ui.confirmDialog(`Списать «${p.name}»?`, { danger: true, okLabel: 'Списать' })) {
              await api.put('/api/products/' + p.id, { status: 'written_off' });
              ui.toast('Изделие списано'); m.close(); onChange && onChange();
            }
          }
          if (act === 'delete') {
            if (await ui.confirmDialog(`Удалить «${p.name}» безвозвратно?`, { danger: true, okLabel: 'Удалить' })) {
              await api.del('/api/products/' + p.id);
              ui.toast('Изделие удалено'); m.close(); onChange && onChange();
            }
          }
        } catch (err) { ui.toastErr(err); }
      });
    }).catch(ui.toastErr);
  }

  // Перемещение изделия на другую точку — с записью в историю перемещений.
  function moveDialog(p, onChange) {
    const targets = stores.filter(s => s.id !== p.store_id);
    const m = ui.modal({
      title: 'Переместить: ' + p.name,
      size: 'sm',
      body: `<div class="hint-box">Сейчас числится на точке
          <strong>${ui.esc(p.store_name || 'не указана')}</strong>.</div>
        <form id="mv-form">
          <label class="field"><span>Куда переместить</span><select name="to_store_id">
            ${targets.map(s => `<option value="${s.id}">${ui.esc(s.name)}</option>`).join('')}
          </select></label>
          <label class="field"><span>Комментарий</span><input name="note" placeholder="необязательно"></label>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Переместить</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      const v = ui.formValues(m.body.querySelector('#mv-form'));
      try {
        const res = await api.post('/api/transfers', {
          product_ids: [p.id], to_store_id: Number(v.to_store_id), note: v.note,
        });
        if (res.moved) ui.toast('Изделие перемещено');
        else ui.toast(res.skipped[0] || 'Переместить не удалось', true);
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  function reserveDialog(p, onChange) {
    const m = ui.modal({
      title: 'Резерв: ' + p.name,
      size: 'sm',
      body: `<label class="field"><span>За каким клиентом (поиск по имени/телефону)</span>
        <div class="rel"><input type="text" id="rsv-search" class="input" placeholder="Начните вводить…" autocomplete="off"></div></label>
        <div id="rsv-selected" class="muted">Клиент не выбран — резерв без привязки</div>`,
      footer: '<button class="btn" data-act="cancel">Отмена</button><button class="btn btn-primary" data-act="ok">В резерв</button>',
    });
    let selected = null;
    const input = m.body.querySelector('#rsv-search');
    attachCustomerSearch(input, c => {
      selected = c;
      m.body.querySelector('#rsv-selected').textContent = 'Выбран: ' + c.name;
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      try {
        await api.put('/api/products/' + p.id, { status: 'reserved', reserved_for: selected ? selected.id : null });
        ui.toast('Изделие в резерве'); m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  // общий поисковый дропдаун клиентов (используется и в POS)
  function attachCustomerSearch(input, onPick) {
    const wrap = input.closest('.rel');
    let seq = 0;
    const clear = () => wrap.querySelectorAll('.search-results').forEach(b => b.remove());
    const search = ui.debounce(async () => {
      const my = ++seq;
      const q = input.value.trim();
      clear();
      if (q.length < 2) return;
      const { items } = await api.get('/api/customers?search=' + encodeURIComponent(q));
      if (my !== seq) return; // ответ устарел — уже идёт новый поиск
      clear();
      const box = document.createElement('div');
      box.className = 'search-results';
      box.innerHTML = items.slice(0, 8).map((c, i) => `
        <div class="sr-item" data-i="${i}">
          <span>${ui.esc(c.name)}</span><span class="sr-sub">${ui.esc(c.phone || '')}</span>
        </div>`).join('') || '<div class="sr-item muted">Не найдено</div>';
      box.querySelectorAll('.sr-item[data-i]').forEach(el => {
        el.addEventListener('mousedown', () => {
          onPick(items[Number(el.dataset.i)]);
          input.value = items[Number(el.dataset.i)].name;
          clear();
        });
      });
      wrap.appendChild(box);
    });
    input.addEventListener('input', search);
    input.addEventListener('blur', () => setTimeout(clear, 150));
  }

  function gemRow(g = {}) {
    return `<div class="form-grid-3 gem-row" style="grid-template-columns: 1.3fr .6fr .7fr .7fr .7fr .6fr 32px; display:grid; gap:0 8px; align-items:end">
      <label class="field"><span>Камень</span><input name="g_type" value="${ui.esc(g.type || '')}" placeholder="Бриллиант" list="gem-types"></label>
      <label class="field"><span>Шт</span><input name="g_count" type="number" min="1" value="${g.count || 1}"></label>
      <label class="field"><span>Караты</span><input name="g_carat" type="number" step="0.01" min="0" value="${g.carat || ''}"></label>
      <label class="field"><span>Цвет</span><input name="g_color" value="${ui.esc(g.color || '')}" placeholder="G"></label>
      <label class="field"><span>Чистота</span><input name="g_clarity" value="${ui.esc(g.clarity || '')}" placeholder="VS1"></label>
      <label class="field"><span>Огранка</span><input name="g_cut" value="${ui.esc(g.cut || '')}" placeholder="Кр-57"></label>
      <button type="button" class="btn btn-sm btn-danger gem-del" style="margin-bottom:13px">×</button>
    </div>`;
  }

  function openEditor(p, onChange) {
    const isNew = !p || !p.id;
    p = p || {};
    const catOpts = cats.map(c => `<option value="${c.id}" ${p.category_id === c.id ? 'selected' : ''}>${ui.esc(c.name)}</option>`).join('');
    const supOpts = suppliers.map(s => `<option value="${s.id}" ${p.supplier_id === s.id ? 'selected' : ''}>${ui.esc(s.name)}</option>`).join('');
    // Новое изделие по умолчанию попадает на основную точку — лишний выбор ни к чему.
    const defaultStore = p.store_id || (stores.find(s => s.is_default) || stores[0] || {}).id;
    const storeOpts = stores.map(s => `<option value="${s.id}" ${defaultStore === s.id ? 'selected' : ''}>${ui.esc(s.name)}</option>`).join('');
    const m = ui.modal({
      title: isNew ? 'Новое изделие' : 'Изделие: ' + p.name,
      size: 'lg',
      body: `<form id="prod-form">
        <datalist id="gem-types"><option>Бриллиант</option><option>Сапфир</option><option>Изумруд</option><option>Рубин</option><option>Жемчуг</option><option>Топаз</option><option>Аметист</option><option>Фианит</option></datalist>
        <datalist id="metal-list"><option>Золото 585</option><option>Золото 750</option><option>Белое золото 585</option><option>Белое золото 750</option><option>Розовое золото 585</option><option>Платина 950</option><option>Серебро 925</option></datalist>
        <div class="form-grid-3">
          <label class="field"><span>Артикул *</span><input name="sku" required value="${ui.esc(p.sku || '')}" placeholder="AS-00120"></label>
          <label class="field"><span>Штрихкод</span><input name="barcode" value="${ui.esc(p.barcode || '')}" placeholder="2000000000015"></label>
          <label class="field"><span>Категория</span><select name="category_id"><option value="">—</option>${catOpts}</select></label>
        </div>
        <label class="field"><span>Наименование *</span><input name="name" required value="${ui.esc(p.name || '')}" placeholder="Кольцо с бриллиантом «Сияние»"></label>
        <div class="form-grid-3">
          <label class="field"><span>Металл</span><input name="metal" value="${ui.esc(p.metal || '')}" list="metal-list" placeholder="Золото 585"></label>
          <label class="field"><span>Вес, г</span><input name="weight" type="number" step="0.01" min="0" value="${p.weight || ''}"></label>
          <label class="field"><span>Размер</span><input name="size" value="${ui.esc(p.size || '')}" placeholder="17,5"></label>
        </div>
        <div class="form-grid-3">
          <label class="field"><span>Закупочная цена</span><input name="purchase_price" type="number" step="0.01" min="0" value="${p.purchase_price || ''}"></label>
          <label class="field"><span>Розничная цена *</span><input name="retail_price" type="number" step="0.01" min="0" required value="${p.retail_price || ''}"></label>
          <label class="field"><span>Поставщик</span><select name="supplier_id"><option value="">—</option>${supOpts}</select></label>
        </div>
        <div class="form-grid-3">
          <label class="field"><span>Точка продаж</span><select name="store_id">${storeOpts}</select></label>
          <label class="field"><span>Чей товар</span><select name="ownership">
            <option value="own" ${p.ownership !== 'consignment' ? 'selected' : ''}>Наш (куплен)</option>
            <option value="consignment" ${p.ownership === 'consignment' ? 'selected' : ''}>На реализации (чужой)</option>
          </select></label>
          <label class="field"><span>Расположение</span><input name="location" value="${ui.esc(p.location || '')}" placeholder="Витрина 2 / Сейф"></label>
        </div>
        <p class="form-hint" id="own-hint" style="${p.ownership === 'consignment' ? '' : 'display:none'}">
          Товар на реализации: как только вы его продадите, система сама запишет долг перед
          поставщиком на закупочную стоимость. Поставщика указать обязательно.
        </p>
        <label class="field"><span>Описание</span><input name="description" value="${ui.esc(p.description || '')}"></label>
        <h4 style="margin:6px 0 10px">Вставки (камни)</h4>
        <div id="gems-wrap">${(p.gems || []).map(gemRow).join('')}</div>
        <button type="button" class="btn btn-sm" id="gem-add">+ Добавить камень</button>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="save">${isNew ? 'Добавить изделие' : 'Сохранить'}</button>`,
    });
    const form = m.body.querySelector('#prod-form');
    m.body.querySelector('#gem-add').onclick = () => {
      m.body.querySelector('#gems-wrap').insertAdjacentHTML('beforeend', gemRow());
    };
    form.querySelector('[name=ownership]').addEventListener('change', e => {
      m.body.querySelector('#own-hint').style.display = e.target.value === 'consignment' ? '' : 'none';
    });
    m.body.addEventListener('click', e => {
      if (e.target.classList.contains('gem-del')) e.target.closest('.gem-row').remove();
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=save]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const gems = [...m.body.querySelectorAll('.gem-row')].map(row => ({
        type: row.querySelector('[name=g_type]').value.trim(),
        count: Number(row.querySelector('[name=g_count]').value) || 1,
        carat: Number(row.querySelector('[name=g_carat]').value) || 0,
        color: row.querySelector('[name=g_color]').value.trim(),
        clarity: row.querySelector('[name=g_clarity]').value.trim(),
        cut: row.querySelector('[name=g_cut]').value.trim(),
      })).filter(g => g.type);
      const payload = {
        sku: v.sku, barcode: v.barcode, name: v.name,
        category_id: v.category_id || null, supplier_id: v.supplier_id || null,
        metal: v.metal, weight: v.weight, size: v.size,
        purchase_price: v.purchase_price, retail_price: v.retail_price,
        location: v.location, description: v.description,
        store_id: v.store_id || null, ownership: v.ownership,
        gems, gem_summary: gemsSummary(gems),
      };
      if (payload.ownership === 'consignment' && !payload.supplier_id) {
        ui.toast('Для товара на реализации укажите поставщика — владельца изделия', true);
        return;
      }
      try {
        if (isNew) {
          const created = await api.post('/api/products', payload);
          ui.toast('Изделие добавлено');
          m.close();
          onChange && onChange();
          // Сразу предлагаем фото: без него изделие в каталоге выглядит пустым.
          openDetail(created.id, onChange);
          return;
        }
        await api.put('/api/products/' + p.id, payload);
        ui.toast('Сохранено');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  return {
    title: 'Каталог изделий',
    // справочники нужны до открытия редактора (быстрое действие с главной)
    openEditor: async (p) => {
      await loadRefs();
      openEditor(p, () => { if (Pages._prodRefresh) Pages._prodRefresh(); });
    },
    attachCustomerSearch,
    async render(el) {
      await loadRefs();
      const meta = await api.get('/api/products/meta');
      el.innerHTML = `
        <div class="toolbar">
          <input type="text" class="input search" id="pf-search" placeholder="Поиск: название, артикул, штрихкод…" autocomplete="off">
          <select class="input" id="pf-cat"><option value="">Все категории</option>
            ${cats.map(c => `<option value="${c.id}">${ui.esc(c.name)}</option>`).join('')}</select>
          <select class="input" id="pf-metal"><option value="">Любой металл</option>
            ${meta.metals.map(mt => `<option>${ui.esc(mt)}</option>`).join('')}</select>
          ${stores.length > 1 ? `<select class="input" id="pf-store"><option value="">Все точки</option>
            ${stores.map(s => `<option value="${s.id}">${ui.esc(s.name)}</option>`).join('')}</select>` : ''}
          <select class="input" id="pf-sort">
            <option value="new">Сначала новые</option>
            <option value="name">По названию</option>
            <option value="sku">По артикулу</option>
            <option value="price_desc">Сначала дорогие</option>
            <option value="price_asc">Сначала дешёвые</option>
          </select>
          <div class="spacer"></div>
          <button class="btn" id="pf-view" title="Плитки или таблица">${view === 'grid' ? '☰ Списком' : '▦ Плитками'}</button>
          ${App.isAdmin() ? '<a class="btn" href="/api/export/products" download>Экспорт CSV</a>' : ''}
          <button class="btn btn-primary" id="pf-add">${ui.icon('plus')} Добавить изделие</button>
        </div>
        <div class="chip-row" style="margin-bottom:14px" id="pf-chips">
          <button class="chip active" data-st="">Все</button>
          <button class="chip" data-st="in_stock">В наличии</button>
          <button class="chip" data-st="reserved">Резерв</button>
          <button class="chip" data-st="sold">Проданные</button>
          <button class="chip" data-st="written_off">Списанные</button>
          <span style="width:12px"></span>
          <button class="chip" data-photo="0">Без фото</button>
          <button class="chip" data-own="consignment">На реализации</button>
        </div>
        <div id="prod-list"></div>`;

      filters = { search: '', status: '', category_id: '', metal: '', store_id: '', has_photo: '', sort: 'new', ownership: '' };
      const doRefresh = () => { if (el.isConnected) refresh(el).catch(ui.toastErr); };
      Pages._prodRefresh = doRefresh;

      el.querySelector('#pf-search').addEventListener('input', ui.debounce(e => { filters.search = e.target.value.trim(); doRefresh(); }));
      el.querySelector('#pf-cat').addEventListener('change', e => { filters.category_id = e.target.value; doRefresh(); });
      el.querySelector('#pf-metal').addEventListener('change', e => { filters.metal = e.target.value; doRefresh(); });
      el.querySelector('#pf-sort').addEventListener('change', e => { filters.sort = e.target.value; doRefresh(); });
      const storeSel = el.querySelector('#pf-store');
      if (storeSel) storeSel.addEventListener('change', e => { filters.store_id = e.target.value; doRefresh(); });

      el.querySelector('#pf-chips').addEventListener('click', e => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        // Статусы взаимоисключающие, «без фото» и «на реализации» — независимые переключатели.
        if (chip.dataset.st !== undefined) {
          el.querySelectorAll('#pf-chips .chip[data-st]').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          filters.status = chip.dataset.st;
        } else if (chip.dataset.photo !== undefined) {
          const on = chip.classList.toggle('active');
          filters.has_photo = on ? chip.dataset.photo : '';
        } else if (chip.dataset.own !== undefined) {
          const on = chip.classList.toggle('active');
          filters.ownership = on ? chip.dataset.own : '';
        }
        doRefresh();
      });
      el.querySelector('#pf-view').addEventListener('click', e => {
        view = view === 'grid' ? 'list' : 'grid';
        localStorage.setItem(VIEW_KEY, view);
        e.target.textContent = view === 'grid' ? '☰ Списком' : '▦ Плитками';
        doRefresh();
      });
      el.querySelector('#pf-add').addEventListener('click', () => openEditor(null, doRefresh));
      await refresh(el);
    },
  };
})();
