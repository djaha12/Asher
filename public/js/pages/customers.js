'use strict';
window.Pages = window.Pages || {};

window.Pages.customers = (() => {
  let filters = { search: '', source: '' };
  const sourceName = key => ui.L.source[key] || key;

  let refreshSeq = 0;
  async function refresh(el) {
    const my = ++refreshSeq;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    const { items } = await api.get('/api/customers?' + q.toString());
    if (my !== refreshSeq || !el.isConnected) return;
    const listEl = el.querySelector('#cust-list');
    listEl.innerHTML = ui.table([
      { title: 'Клиент', render: r => `<span class="strong">${ui.esc(r.name)}</span>` },
      { title: 'Телефон', render: r => `<span class="mono">${ui.esc(r.phone || '—')}</span>` },
      { title: 'Откуда', render: r => r.source ? ui.esc(sourceName(r.source)) : '<span class="dim">—</span>' },
      { title: 'Скидка', cls: 'num', render: r => r.discount ? r.discount + '%' : '—' },
      { title: 'Покупок', cls: 'num', render: r => r.purchases || 0 },
      { title: 'Сумма покупок', cls: 'num strong', render: r => ui.money(r.total_spent) },
    ], items, { empty: 'Клиентов не найдено. Добавьте первого!' });
    ui.bindRows(listEl, items, r => openDetail(r.id, () => refresh(el)));
  }

  /*
   * Связаться — из самой карточки: WhatsApp с готовым приветствием и звонок.
   * Раньше номер был просто текстом: его переписывали в телефон руками.
   */
  function связь(c) {
    if (!c.phone) return '';
    const wa = ui.whatsappLink(c.phone, 'Здравствуйте! Пишем вам из ' + (App.storeName || 'магазина') + '.');
    const тел = String(c.phone).replace(/[^\d+]/g, '');
    return `<span class="row-tight" style="gap:6px;margin-left:6px">
      ${wa ? `<a class="btn btn-sm" href="${ui.esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      <a class="btn btn-sm" href="tel:${ui.esc(тел)}">Позвонить</a></span>`;
  }

  function openDetail(id, onChange) {
    // Долг — отдельным запросом: он считается по документам, а не хранится в клиенте.
    Promise.all([
      api.get('/api/customers/' + id),
      api.get('/api/debts/customers/' + id).catch(() => null),
    ]).then(([c, долг]) => {
      const долгСумма = долг ? Number(долг.total_debt) || 0 : 0;
      const просрочено = долг ? долг.documents.filter(d => d.overdue).reduce((s, d) => s + d.debt, 0) : 0;
      const nextDates = [c.birthday && `ДР: ${ui.dateOnly(c.birthday)}`, c.anniversary && `Годовщина: ${ui.dateOnly(c.anniversary)}`]
        .filter(Boolean).join(' · ');
      const m = ui.modal({
        title: c.name,
        size: 'lg',
        body: `
          <div class="grid grid-2">
            <dl class="kv">
              <dt>Телефон</dt><dd><span class="mono">${ui.esc(c.phone || '—')}</span>${связь(c)}</dd>
              <dt>E-mail</dt><dd>${ui.esc(c.email || '—')}</dd>
              <dt>Откуда пришёл</dt><dd>${c.source ? ui.esc(sourceName(c.source)) : '—'}</dd>
              <dt>Памятные даты</dt><dd>${nextDates || '—'}</dd>
              <dt>Размер кольца</dt><dd>${ui.esc(c.ring_size || '—')}</dd>
            </dl>
            <dl class="kv">
              <dt>Покупок</dt><dd>${c.stats.purchases} на <b>${ui.money(c.stats.total_spent)}</b></dd>
              <dt>Последняя</dt><dd>${c.stats.last_purchase ? ui.dt(c.stats.last_purchase) : '—'}</dd>
              <dt>Личная скидка</dt><dd>${c.discount ? c.discount + '%' : '—'}</dd>
              <dt>С нами с</dt><dd>${ui.dateOnly(c.created_at)}</dd>
            </dl>
          </div>
          ${долгСумма > 0 ? `<div class="hint-box" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <span>Долг: <b>${ui.money(долгСумма)}</b>${просрочено > 0 ? ` · <span class="crit">просрочено ${ui.money(просрочено)}</span>` : ''}</span>
              <button class="btn btn-sm btn-primary" data-act="pay">Принять оплату</button></div>` : ''}
          ${c.preferences ? `<p><b>Предпочтения:</b> ${ui.esc(c.preferences)}</p>` : ''}
          ${c.notes ? `<p class="muted">${ui.esc(c.notes)}</p>` : ''}
          <h4 style="margin:14px 0 8px">Хочет</h4>
          <div id="cust-wishes">${(c.wishes || []).map(w => `
            <div class="row" style="justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">
              <span>${ui.esc(w.text)} <span class="dim" style="font-size:12px">· ${ui.dateOnly(w.created_at)}</span></span>
              <button class="btn btn-sm" data-wish-del="${w.id}" title="Уже не актуально">×</button></div>`).join('')
            || '<p class="muted" style="margin:0 0 6px;font-size:13px">Пока ничего. Спросила про серьги с сапфиром, а их нет? Запишите — позвоните, когда появятся.</p>'}</div>
          <div class="row" style="gap:8px;margin-top:8px">
            <input class="input grow" id="wish-text" maxlength="300" placeholder="Например: серьги с сапфиром до 60 000">
            <button class="btn" data-act="wish-add">Записать</button>
          </div>
          ${c.reserved.length ? `<div class="row" style="justify-content:space-between;align-items:center;margin:14px 0 8px">
              <h4 style="margin:0">В резерве</h4>
              <button class="btn btn-sm btn-primary" data-act="sell-reserved">Продать отложенное</button></div>
            ${c.reserved.map(p => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
              <span>${ui.esc(p.name)} <span class="dim">${ui.esc(p.sku)}</span></span><b>${ui.money(p.retail_price)}</b></div>`).join('')}` : ''}
          ${c.items.length ? `<h4 style="margin:16px 0 8px">Купленные изделия</h4>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Изделие</th><th>Металл</th><th class="num">Цена</th><th></th></tr></thead>
            <tbody>${c.items.slice(0, 20).map(i => `<tr>
              <td class="dim">${ui.dateOnly(i.created_at)}</td>
              <td>${ui.esc(i.name)}${i.gem_summary ? `<div class="dim" style="font-size:11px">${ui.esc(i.gem_summary)}</div>` : ''}</td>
              <td class="dim">${ui.esc(i.metal || '—')}</td>
              <td class="num">${ui.money(i.final_price)}</td>
              <td>${i.returned ? '<span class="badge badge-crit">возврат</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${c.orders.length ? `<h4 style="margin:16px 0 8px">Заказы и ремонт</h4>
            ${c.orders.slice(0, 10).map(o => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">
              <span>${ui.esc(o.number)} · ${ui.L.orderType[o.type] || o.type}</span>
              <span>${ui.badge('orderStatus', o.status)} <b>${ui.money(o.final_price || o.estimate)}</b></span></div>`).join('')}` : ''}
        `,
        footer: `
          <button class="btn" data-act="edit">Редактировать</button>
          <button class="btn btn-primary" data-act="sale">Оформить продажу</button>`,
      });
      m.foot.querySelector('[data-act=edit]').onclick = () => { m.close(); openEditor(c, onChange); };
      // Перечитать карточку после изменений — без потери места в списке.
      const заново = () => { m.close(); openDetail(id, onChange); onChange && onChange(); };
      const кнопкаОплаты = m.body.querySelector('[data-act=pay]');
      if (кнопкаОплаты) кнопкаОплаты.onclick = () => {
        m.close();
        Pages.debts.payDialog({ customer: { id: c.id, name: c.name }, maxAmount: долгСумма,
          onDone: () => { openDetail(id, onChange); onChange && onChange(); } });
      };
      m.body.querySelector('[data-act=wish-add]').onclick = async () => {
        const поле = m.body.querySelector('#wish-text');
        if (!поле.value.trim()) { поле.focus(); return; }
        try {
          await api.post(`/api/customers/${c.id}/wishes`, { text: поле.value.trim() });
          ui.toast('Записано');
          заново();
        } catch (e) { ui.toastErr(e); }
      };
      m.body.querySelectorAll('[data-wish-del]').forEach(b => b.addEventListener('click', async () => {
        try { await api.del(`/api/customers/${c.id}/wishes/${b.dataset.wishDel}`); заново(); }
        catch (e) { ui.toastErr(e); }
      }));
      m.foot.querySelector('[data-act=sale]').onclick = () => { m.close(); Pages.sales.newSale(null, c); };
      /*
       * Клиентка пришла за отложенным — все её изделия сразу в чеке, и она
       * уже выбрана. Раньше это были поиск каждого изделия в кассе и ошибка
       * «в резерве за другим клиентом», если клиента не выбрали первым.
       */
      const продатьОтложенное = m.body.querySelector('[data-act=sell-reserved]');
      if (продатьОтложенное) продатьОтложенное.onclick = async () => {
        try {
          const изделия = await Promise.all(c.reserved.map(r => api.get('/api/products/' + r.id)));
          m.close();
          Pages.sales.newSale(изделия, { id: c.id, name: c.name, phone: c.phone, discount: c.discount });
        } catch (e) { ui.toastErr(e); }
      };
    }).catch(ui.toastErr);
  }

  function openEditor(c, onChange) {
    const isNew = !c || !c.id;
    c = c || {};
    const m = ui.modal({
      title: isNew ? 'Новый клиент' : 'Клиент: ' + c.name,
      body: `<form id="cust-form">
        <label class="field"><span>Имя (ФИО) *</span><input name="name" required value="${ui.esc(c.name || '')}" placeholder="Иванова Анна Сергеевна"></label>
        <div class="form-grid">
          <label class="field"><span>Телефон</span><input name="phone" value="${ui.esc(c.phone || '')}" placeholder="0555 12-34-56"></label>
          <label class="field"><span>E-mail</span><input name="email" type="email" value="${ui.esc(c.email || '')}"></label>
        </div>
        ${ui.sourcePicker(c.source || '')}
        <div class="form-grid">
          <label class="field"><span>День рождения</span><input name="birthday" type="date" value="${ui.esc(c.birthday || '')}"></label>
          <label class="field"><span>Годовщина (свадьба и т.п.)</span><input name="anniversary" type="date" value="${ui.esc(c.anniversary || '')}"></label>
        </div>
        <div class="form-grid">
          <label class="field"><span>Личная скидка, %</span><input name="discount" type="number" min="0" max="100" step="0.5" value="${c.discount || ''}"></label>
          <label class="field"><span>Размер кольца</span><input name="ring_size" value="${ui.esc(c.ring_size || '')}" placeholder="16,5"></label>
        </div>
        <label class="field"><span>Предпочтения</span><input name="preferences" value="${ui.esc(c.preferences || '')}" placeholder="Белое золото, сапфиры, классика"></label>
        <label class="field"><span>Заметки</span><textarea name="notes">${ui.esc(c.notes || '')}</textarea></label>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="save">${isNew ? 'Добавить клиента' : 'Сохранить'}</button>`,
    });
    const form = m.body.querySelector('#cust-form');
    ui.bindSourcePicker(form);
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=save]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const сохранить = данные => isNew ? api.post('/api/customers', данные) : api.put('/api/customers/' + c.id, данные);
      try {
        try {
          await сохранить(v);
        } catch (e) {
          if (e.status !== 409 || !e.data || !e.data.existing) throw e;
          const выбор = await ui.выборПриДубле(e.data.existing, { взять: 'Открыть его карточку' });
          if (!выбор) return;
          if (выбор === 'existing') { m.close(); openDetail(e.data.existing.id, onChange); return; }
          await сохранить({ ...v, allow_duplicate: true });
        }
        ui.toast(isNew ? 'Клиент добавлен' : 'Сохранено');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  return {
    title: 'Клиенты',
    openEditor: (c) => openEditor(c, () => { if (Pages._custRefresh) Pages._custRefresh(); }),
    openDetail,
    async render(el, param) {
      el.innerHTML = `
        <div class="toolbar">
          <input type="text" class="input search" id="cf-search" placeholder="Поиск: имя, телефон, e-mail…" autocomplete="off">
          <select class="input" id="cf-source" aria-label="Откуда пришёл">
            <option value="">Откуда: все</option>
            ${Object.entries(ui.L.source).map(([k, v]) => `<option value="${k}">${ui.esc(v)}</option>`).join('')}
            <option value="none">Не отмечено</option>
          </select>
          <div class="spacer"></div>
          ${App.isAdmin() ? '<a class="btn" href="/api/export/customers" download>Экспорт CSV</a>' : ''}
          <button class="btn btn-primary" id="cf-add">${ui.icon('plus')} Новый клиент</button>
        </div>
        <div id="cust-list"></div>`;

      filters = { search: '', source: '' };
      const doRefresh = () => { if (el.isConnected) refresh(el).catch(ui.toastErr); };
      Pages._custRefresh = doRefresh;
      App.обновлятьТак(el, () => refresh(el));
      el.querySelector('#cf-search').addEventListener('input', ui.debounce(e => { filters.search = e.target.value.trim(); doRefresh(); }));
      el.querySelector('#cf-source').addEventListener('change', e => { filters.source = e.target.value; doRefresh(); });
      el.querySelector('#cf-add').addEventListener('click', () => openEditor(null, doRefresh));
      await refresh(el);
      if (param) openDetail(Number(param), doRefresh);
    },
  };
})();
