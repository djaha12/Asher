'use strict';
window.Pages = window.Pages || {};

window.Pages.orders = (() => {
  const COLS = [
    { key: 'accepted', title: 'Принят' },
    { key: 'in_progress', title: 'В работе' },
    { key: 'ready', title: 'Готов к выдаче' },
    { key: 'delivered', title: 'Выдан' },
  ];
  let showArchive = false;

  async function refresh(el) {
    const { items } = await api.get('/api/orders');
    const kanbanEl = el.querySelector('#orders-kanban');
    const visible = items.filter(o => showArchive || o.status !== 'delivered' || isRecent(o.delivered_at));
    kanbanEl.innerHTML = COLS.map(col => {
      const list = visible.filter(o => o.status === col.key);
      return `<div class="kanban-col">
        <h3>${col.title} <span class="pill-num">${list.length}</span></h3>
        ${list.map(o => `
          <div class="kanban-card" data-id="${o.id}">
            <div class="kc-num">${ui.esc(o.number)} · ${ui.L.orderType[o.type] || o.type}</div>
            <div class="kc-desc">${ui.esc(o.description.slice(0, 90))}${o.description.length > 90 ? '…' : ''}</div>
            <div class="kc-foot">
              <span>${ui.esc(o.customer_name || 'Без клиента')}</span>
              <b class="money">${ui.money(o.final_price || o.estimate)}</b>
            </div>
            ${o.due_date && o.status !== 'delivered' ? `<div class="kc-foot" style="margin-top:4px"><span class="${overdue(o.due_date) ? 'badge badge-crit' : 'muted'}">срок: ${ui.dateOnly(o.due_date)}</span></div>` : ''}
          </div>`).join('') || '<div class="muted" style="padding:8px 4px;font-size:12.5px">Пусто</div>'}
      </div>`;
    }).join('');
    kanbanEl.querySelectorAll('.kanban-card').forEach(card => {
      card.addEventListener('click', () => openDetail(Number(card.dataset.id), () => refresh(el)));
    });
    const cancelled = items.filter(o => o.status === 'cancelled');
    el.querySelector('#orders-cancelled').innerHTML = cancelled.length
      ? `<p class="muted">Отменённых заказов: ${cancelled.length}</p>` : '';
  }

  function isRecent(iso) {
    return iso && (Date.now() - new Date(iso).getTime()) < 14 * 86400000;
  }
  function overdue(d) {
    return d && d < new Date().toISOString().slice(0, 10);
  }

  function openDetail(id, onChange) {
    api.get('/api/orders/' + id).then(o => {
      const rest = Math.max(0, (o.final_price || o.estimate) - o.paid);
      const m = ui.modal({
        title: `${o.number} — ${ui.L.orderType[o.type] || o.type}`,
        body: `
          <div class="grid grid-2">
            <dl class="kv">
              <dt>Статус</dt><dd>${ui.badge('orderStatus', o.status)}</dd>
              <dt>Клиент</dt><dd>${o.customer_id ? `<a href="#/customers/${o.customer_id}">${ui.esc(o.customer_name)}</a>` : '—'}</dd>
              <dt>Телефон</dt><dd class="mono">${ui.esc(o.customer_phone || '—')}</dd>
              <dt>Принят</dt><dd>${ui.dt(o.accepted_at)}</dd>
              <dt>Срок</dt><dd>${o.due_date ? ui.dateOnly(o.due_date) : '—'}</dd>
              ${o.delivered_at ? `<dt>Выдан</dt><dd>${ui.dt(o.delivered_at)}</dd>` : ''}
            </dl>
            <dl class="kv">
              <dt>Оценка</dt><dd>${ui.money(o.estimate)}</dd>
              <dt>Итоговая цена</dt><dd class="strong">${o.final_price ? ui.money(o.final_price) : '—'}</dd>
              <dt>Оплачено</dt><dd>${ui.money(o.paid)}</dd>
              <dt>Остаток</dt><dd class="${rest > 0 ? 'strong' : ''}">${ui.money(rest)}</dd>
              <dt>Принял</dt><dd>${ui.esc(o.user_name || '—')}</dd>
            </dl>
          </div>
          <p style="background:var(--surface-2);border-radius:8px;padding:10px 14px">${ui.esc(o.description)}</p>
          ${o.note ? `<p class="muted">${ui.esc(o.note)}</p>` : ''}
          ${o.payments.length ? `<h4 style="margin:12px 0 6px">Оплаты</h4>${o.payments.map(p =>
            `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)">
              <span class="dim">${ui.dt(p.created_at)}</span><b>${ui.money(p.amount)}</b></div>`).join('')}` : ''}`,
        footer: `
          ${o.status !== 'delivered' && o.status !== 'cancelled' ? `
            <button class="btn btn-danger left" data-act="cancel-order">Отменить заказ</button>
            <button class="btn" data-act="edit">Редактировать</button>
            <button class="btn" data-act="pay">+ Оплата</button>` : ''}
          ${nextStatusBtn(o)}
          <button class="btn" data-act="close">Закрыть</button>`,
      });
      m.foot.addEventListener('click', async e => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) return;
        try {
          if (act === 'close') m.close();
          if (act === 'edit') { m.close(); openEditor(o, onChange); }
          if (act === 'pay') { m.close(); paymentDialog(o, onChange); }
          if (act === 'cancel-order') {
            if (await ui.confirmDialog(`Отменить заказ ${o.number}?`, { danger: true, okLabel: 'Отменить заказ' })) {
              await api.post(`/api/orders/${o.id}/status`, { status: 'cancelled' });
              ui.toast('Заказ отменён'); m.close(); onChange && onChange();
            }
          }
          if (act === 'next-status') {
            const next = e.target.dataset.next;
            if (next === 'delivered' && !o.final_price) {
              m.close(); deliverDialog(o, onChange);
              return;
            }
            await api.post(`/api/orders/${o.id}/status`, { status: next });
            ui.toast('Статус обновлён: ' + ui.L.orderStatus[next]);
            m.close(); onChange && onChange();
          }
        } catch (err) { ui.toastErr(err); }
      });
    }).catch(ui.toastErr);
  }

  function nextStatusBtn(o) {
    const flow = { accepted: 'in_progress', in_progress: 'ready', ready: 'delivered' };
    const next = flow[o.status];
    if (!next) return '';
    const label = { in_progress: 'В работу →', ready: 'Готов →', delivered: 'Выдать клиенту ✓' }[next];
    return `<button class="btn btn-primary" data-act="next-status" data-next="${next}">${label}</button>`;
  }

  function deliverDialog(o, onChange) {
    const m = ui.modal({
      title: 'Выдача заказа ' + o.number,
      size: 'sm',
      body: `<label class="field"><span>Итоговая стоимость *</span>
          <input type="number" id="dlv-price" min="0" step="1" value="${o.estimate || ''}"></label>
        <p class="muted" style="margin-top:0">Оплачено: ${ui.money(o.paid)}. Остаток будет записан как оплата при выдаче.</p>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Выдать</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      const price = Number(m.body.querySelector('#dlv-price').value) || 0;
      try {
        await api.put('/api/orders/' + o.id, { final_price: price });
        const rest = Math.max(0, price - o.paid);
        if (rest > 0) await api.post(`/api/orders/${o.id}/payment`, { amount: rest });
        await api.post(`/api/orders/${o.id}/status`, { status: 'delivered' });
        ui.toast('Заказ выдан 🎉');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  function paymentDialog(o, onChange) {
    const m = ui.modal({
      title: 'Оплата по заказу ' + o.number,
      size: 'sm',
      body: `<label class="field"><span>Сумма *</span><input type="number" id="pay-amount" min="1" step="1"></label>
        <p class="muted" style="margin-top:0">Уже оплачено: ${ui.money(o.paid)}</p>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Принять оплату</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      try {
        await api.post(`/api/orders/${o.id}/payment`, { amount: Number(m.body.querySelector('#pay-amount').value) });
        ui.toast('Оплата принята');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  function openEditor(o, onChange) {
    const isNew = !o || !o.id;
    o = o || {};
    const m = ui.modal({
      title: isNew ? 'Новый заказ / ремонт' : 'Заказ ' + o.number,
      body: `<form id="order-form">
        <div class="form-grid">
          <label class="field"><span>Тип заказа</span>
            <select name="type">${Object.entries(ui.L.orderType).map(([k, v]) =>
              `<option value="${k}" ${o.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>Клиент</span>
            <div class="rel"><input type="text" id="ord-customer" class="input" placeholder="Поиск клиента…" autocomplete="off" value="${ui.esc(o.customer_name || '')}"></div></label>
        </div>
        <label class="field"><span>Описание работы *</span>
          <textarea name="description" required placeholder="Например: заменить замок на цепи, полировка">${ui.esc(o.description || '')}</textarea></label>
        <div class="form-grid-3">
          <label class="field"><span>Оценка стоимости</span><input name="estimate" type="number" min="0" step="1" value="${o.estimate || ''}"></label>
          ${isNew ? '<label class="field"><span>Предоплата</span><input name="prepayment" type="number" min="0" step="1"></label>' : ''}
          <label class="field"><span>Срок готовности</span><input name="due_date" type="date" value="${ui.esc(o.due_date || '')}"></label>
        </div>
        <label class="field"><span>Заметка</span><input name="note" value="${ui.esc(o.note || '')}"></label>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="save">${isNew ? 'Принять заказ' : 'Сохранить'}</button>`,
    });
    let customer = o.customer_id ? { id: o.customer_id, name: o.customer_name } : null;
    Pages.products.attachCustomerSearch(m.body.querySelector('#ord-customer'), c => { customer = c; });
    const form = m.body.querySelector('#order-form');
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=save]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const payload = {
        type: v.type, description: v.description, estimate: v.estimate,
        due_date: v.due_date, note: v.note,
        customer_id: customer ? customer.id : null,
      };
      if (isNew) payload.prepayment = v.prepayment;
      try {
        if (isNew) {
          const created = await api.post('/api/orders', payload);
          ui.toast('Заказ ' + created.number + ' принят');
        } else {
          await api.put('/api/orders/' + o.id, payload);
          ui.toast('Сохранено');
        }
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  return {
    title: 'Заказы и ремонт',
    openEditor: (o) => openEditor(o, () => {}),
    async render(el, param) {
      el.innerHTML = `
        <div class="toolbar">
          <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--ink-2)">
            <input type="checkbox" id="of-archive"> показывать давно выданные
          </label>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="of-add">+ Принять заказ</button>
        </div>
        <div class="kanban" id="orders-kanban"></div>
        <div id="orders-cancelled" style="margin-top:12px"></div>`;
      const doRefresh = () => refresh(el).catch(ui.toastErr);
      el.querySelector('#of-add').addEventListener('click', () => openEditor(null, doRefresh));
      el.querySelector('#of-archive').addEventListener('change', e => { showArchive = e.target.checked; doRefresh(); });
      await refresh(el);
      if (param) openDetail(Number(param), doRefresh);
    },
  };
})();
