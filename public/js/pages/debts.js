'use strict';
window.Pages = window.Pages || {};

/*
 * Долги — три вкладки:
 *   «Нам должны»    — клиенты, купившие в рассрочку;
 *   «Мы должны»     — расчёты с поставщиками;
 *   «На реализации» — чужой товар на витрине и уже проданный, но не оплаченный владельцу.
 */
window.Pages.debts = (() => {
  let tab = 'customers';
  let pageEl = null;   // корень страницы — чтобы перерисовать её целиком после изменений

  function reload() { if (pageEl && pageEl.isConnected) render(pageEl).catch(ui.toastErr); }

  // ---------- Нам должны ----------

  async function renderCustomers(host) {
    const [{ items, totals }, summary] = await Promise.all([
      api.get('/api/debts/customers'),
      api.get('/api/debts/summary'),
    ]);
    if (!host.isConnected) return;

    host.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:18px">
        <div class="big-stat accent-gold">
          <div class="bs-label">Всего должны нам</div>
          <div class="bs-value">${ui.money(totals.debt)}</div>
          <div class="bs-sub">человек: ${summary.debtors_count} · документов: ${summary.documents_count}</div>
        </div>
        <div class="big-stat ${totals.overdue > 0 ? 'accent-crit' : 'accent-good'}">
          <div class="bs-label">Из них просрочено</div>
          <div class="bs-value ${totals.overdue > 0 ? 'crit' : ''}">${ui.money(totals.overdue)}</div>
          <div class="bs-sub">${totals.overdue > 0 ? 'Срок оплаты уже прошёл' : 'Просроченных долгов нет'}</div>
        </div>
        <div class="big-stat">
          <div class="bs-label">Средний долг</div>
          <div class="bs-value">${ui.money(items.length ? totals.debt / items.length : 0)}</div>
          <div class="bs-sub">на одного должника</div>
        </div>
      </div>

      <div class="toolbar">
        <input type="text" class="input search" id="d-search" placeholder="Поиск по имени или телефону…" autocomplete="off">
        <button class="chip" id="d-overdue">Только просроченные</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="d-pay">₽ Принять оплату</button>
      </div>

      <div class="card"><div id="d-list"></div></div>`;

    const listEl = host.querySelector('#d-list');
    let filtered = items;

    function draw() {
      if (!filtered.length) {
        listEl.innerHTML = `<div class="empty"><div class="empty-ico">✓</div>
          <p>Долгов нет. Все рассчитались.</p></div>`;
        return;
      }
      listEl.innerHTML = filtered.map((r, i) => `
        <div class="debt-row ${r.overdue_debt > 0 ? 'overdue' : ''}" data-i="${i}">
          <div>
            <div class="dr-name">${ui.esc(r.customer_name)}</div>
            <div class="dr-sub">${ui.esc(r.customer_phone || 'телефон не указан')} ·
              документов: ${r.documents}${r.oldest_due ? ' · срок ' + ui.dateOnly(r.oldest_due) : ''}</div>
          </div>
          <div class="dr-sum">
            <div class="dr-amount">${ui.money(r.debt)}</div>
            ${r.overdue_debt > 0
              ? `<div class="dr-sub crit">просрочено ${ui.money(r.overdue_debt)}, ${r.max_days_overdue} дн.</div>`
              : '<div class="dr-sub">в срок</div>'}
          </div>
        </div>`).join('');
      listEl.querySelectorAll('.debt-row').forEach(el => {
        el.addEventListener('click', () => openCustomer(filtered[Number(el.dataset.i)].customer_id));
      });
    }

    let onlyOverdue = false;
    let search = '';
    function apply() {
      const q = search.toLowerCase();
      filtered = items.filter(r =>
        (!onlyOverdue || r.overdue_debt > 0) &&
        (!q || String(r.customer_name).toLowerCase().includes(q) || String(r.customer_phone).includes(q)));
      draw();
    }

    host.querySelector('#d-search').addEventListener('input', ui.debounce(e => {
      search = e.target.value.trim();
      apply();
    }));
    host.querySelector('#d-overdue').addEventListener('click', e => {
      onlyOverdue = e.target.classList.toggle('active');
      apply();
    });
    host.querySelector('#d-pay').addEventListener('click', () => pickCustomerAndPay());
    draw();
  }

  // Карточка должника: что именно висит и вся история платежей.
  async function openCustomer(customerId) {
    let data;
    try { data = await api.get('/api/debts/customers/' + customerId); }
    catch (e) { ui.toastErr(e); return; }

    const docs = data.documents.map(d => `
      <tr>
        <td><span class="mono strong">${ui.esc(d.number)}</span>
          <div class="dim" style="font-size:12px">${d.kind === 'sale' ? 'продажа' : 'заказ'} от ${ui.dateOnly(d.created_at)}</div></td>
        <td class="num">${ui.money(d.total)}</td>
        <td class="num dim">${ui.money(d.paid)}</td>
        <td class="num strong ${d.overdue ? 'crit' : ''}">${ui.money(d.debt)}</td>
        <td>${d.due_date
          ? (d.overdue
            ? `<span class="badge badge-crit">просрочен ${d.days_overdue} дн.</span>`
            : ui.dateOnly(d.due_date))
          : '<span class="dim">срок не задан</span>'}</td>
        <td><button class="btn btn-sm" data-pay-kind="${d.kind}" data-pay-id="${d.id}">Оплатить</button></td>
      </tr>`).join('');

    const payments = data.payments.length ? data.payments.map(p => `
      <tr>
        <td>${ui.dt(p.created_at)}</td>
        <td>${ui.esc(p.sale_number || p.order_number || '—')}</td>
        <td class="num ${p.amount < 0 ? 'crit' : 'good'}">${ui.money(p.amount)}</td>
        <td>${ui.esc(ui.L.payment[p.method] || p.method)}</td>
        <td class="dim">${ui.esc(p.note || '')}</td>
      </tr>`).join('') : '';

    const wa = ui.whatsappLink(data.customer.phone,
      `Здравствуйте, ${data.customer.name}! Напоминаем об остатке по вашей покупке: ` +
      `${data.total_debt.toLocaleString('ru-RU')} ${App.currency}. Будем рады видеть вас снова!`);

    const m = ui.modal({
      title: 'Долг: ' + data.customer.name,
      size: 'lg',
      body: `
        <div class="row" style="margin-bottom:16px">
          <div class="big-stat accent-crit grow">
            <div class="bs-label">Остаток долга</div>
            <div class="bs-value">${ui.money(data.total_debt)}</div>
            <div class="bs-sub">${ui.esc(data.customer.phone || 'телефон не указан')}</div>
          </div>
        </div>
        <h4 style="margin:0 0 8px">Незакрытые документы</h4>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Документ</th><th class="num">Сумма</th><th class="num">Оплачено</th>
            <th class="num">Долг</th><th>Срок</th><th></th></tr></thead>
          <tbody>${docs}</tbody></table></div>
        ${payments ? `<h4 style="margin:18px 0 8px">История платежей</h4>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Когда</th><th>Документ</th><th class="num">Сумма</th><th>Как</th><th>Комментарий</th></tr></thead>
            <tbody>${payments}</tbody></table></div>` : ''}`,
      footer: `
        ${wa ? `<a class="btn left" href="${ui.esc(wa)}" target="_blank" rel="noopener">💬 Написать в WhatsApp</a>` : ''}
        <button class="btn" data-act="close">Закрыть</button>
        <button class="btn btn-primary" data-act="pay">₽ Принять оплату</button>`,
    });

    m.foot.querySelector('[data-act=close]').onclick = m.close;
    m.foot.querySelector('[data-act=pay]').onclick = () => {
      m.close();
      payDialog({ customer: data.customer, maxAmount: data.total_debt });
    };
    m.body.querySelectorAll('[data-pay-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const doc = data.documents.find(d => d.id === Number(btn.dataset.payId) && d.kind === btn.dataset.payKind);
        m.close();
        payDialog({ customer: data.customer, doc, maxAmount: doc.debt });
      });
    });
  }

  // Приём денег. Сумма подставлена целиком — обычно долг гасят полностью.
  function payDialog({ customer, doc, maxAmount }) {
    const m = ui.modal({
      title: 'Приём оплаты',
      size: 'sm',
      body: `
        <div class="hint-box">
          <strong>${ui.esc(customer.name)}</strong><br>
          ${doc ? `по документу ${ui.esc(doc.number)}: ` : 'общий долг: '}
          <strong>${ui.money(maxAmount)}</strong>
          ${doc ? '' : '<br>Деньги закроют документы по очереди — начиная с самого раннего срока.'}
        </div>
        <form id="pay-form">
          <label class="field"><span>Сумма</span>
            <input name="amount" type="number" step="0.01" min="0.01" max="${maxAmount}"
              value="${maxAmount}" required autofocus></label>
          <label class="field"><span>Чем платят</span>
            <select name="method">
              <option value="cash">Наличные</option>
              <option value="card">Карта</option>
              <option value="transfer">Перевод</option>
            </select></label>
          <label class="field"><span>Комментарий</span><input name="note" placeholder="необязательно"></label>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Принять оплату</button>`,
    });
    const form = m.body.querySelector('#pay-form');
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const payload = { amount: Number(v.amount), method: v.method, note: v.note };
      if (doc) payload[doc.kind === 'sale' ? 'sale_id' : 'order_id'] = doc.id;
      else payload.customer_id = customer.id;
      try {
        const res = await api.post('/api/debts/payments', payload);
        ui.toast(`Принято ${ui.money(res.total)}. Закрыто документов: ${res.applied.length}`);
        m.close();
        reload();
      } catch (e) { ui.toastErr(e); }
    };
  }

  // Кнопка «Принять оплату» в шапке: сначала выбираем, от кого деньги.
  async function pickCustomerAndPay() {
    const { items } = await api.get('/api/debts/customers');
    if (!items.length) { ui.toast('Сейчас никто не должен'); return; }
    const m = ui.modal({
      title: 'От кого оплата?',
      size: 'sm',
      body: `<div>${items.map((r, i) => `
        <div class="debt-row" data-i="${i}">
          <div><div class="dr-name">${ui.esc(r.customer_name)}</div>
            <div class="dr-sub">${ui.esc(r.customer_phone || '')}</div></div>
          <div class="dr-sum"><div class="dr-amount">${ui.money(r.debt)}</div></div>
        </div>`).join('')}</div>`,
    });
    m.body.querySelectorAll('.debt-row').forEach(el => {
      el.addEventListener('click', () => {
        const r = items[Number(el.dataset.i)];
        m.close();
        payDialog({
          customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone },
          maxAmount: r.debt,
        });
      });
    });
  }

  // ---------- Мы должны ----------

  async function renderSuppliers(host) {
    const { items, total } = await api.get('/api/debts/suppliers');
    if (!host.isConnected) return;
    const owing = items.filter(s => Math.abs(s.balance) > 0.009);

    host.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:18px">
        <div class="big-stat accent-crit">
          <div class="bs-label">Всего должны поставщикам</div>
          <div class="bs-value">${ui.money(total)}</div>
          <div class="bs-sub">поставщиков с долгом: ${owing.filter(s => s.balance > 0).length}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Расчёты с поставщиками</div>
        <div id="s-list"></div>
      </div>`;

    const listEl = host.querySelector('#s-list');
    if (!items.length) {
      listEl.innerHTML = `<div class="empty"><div class="empty-ico">◇</div>
        <p>Поставщиков пока нет. Добавьте их в Настройках.</p></div>`;
      return;
    }
    listEl.innerHTML = items.map((s, i) => `
      <div class="debt-row ${s.balance > 0.009 ? 'overdue' : ''}" data-i="${i}">
        <div>
          <div class="dr-name">${ui.esc(s.name)}</div>
          <div class="dr-sub">${ui.esc(s.phone || s.contact || 'контакты не указаны')}
            ${s.nearest_due ? ' · ближайший срок ' + ui.dateOnly(s.nearest_due) : ''}</div>
        </div>
        <div class="dr-sum">
          <div class="dr-amount">${s.balance > 0.009 ? ui.money(s.balance) : '<span class="good">рассчитались</span>'}</div>
          <div class="dr-sub">оплачено всего ${ui.money(s.paid_total)}</div>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('.debt-row').forEach(el => {
      el.addEventListener('click', () => openSupplier(items[Number(el.dataset.i)].id));
    });
  }

  const OP_LABEL = {
    invoice: 'Поставка товара',
    consignment_sale: 'Продано с реализации',
    payment: 'Оплата поставщику',
    adjust: 'Корректировка',
  };

  async function openSupplier(supplierId) {
    let data;
    try { data = await api.get('/api/debts/suppliers/' + supplierId); }
    catch (e) { ui.toastErr(e); return; }

    const rows = data.ops.map(o => `
      <tr>
        <td>${ui.dateOnly(o.doc_date || o.created_at)}</td>
        <td>${ui.esc(OP_LABEL[o.type] || o.type)}
          ${o.doc_number ? `<div class="dim" style="font-size:12px">№ ${ui.esc(o.doc_number)}</div>` : ''}
          ${o.sku ? `<div class="dim" style="font-size:12px">${ui.esc(o.sku)} ${ui.esc(o.product_name || '')}</div>` : ''}</td>
        <td class="num ${o.type === 'payment' ? 'good' : ''}">
          ${o.type === 'payment' ? '−' : '+'}${ui.money(Math.abs(o.amount))}</td>
        <td>${o.due_date ? ui.dateOnly(o.due_date) : '<span class="dim">—</span>'}</td>
        <td class="dim">${ui.esc(o.note || '')}</td>
        <td>${o.type === 'consignment_sale' ? ''
          : `<button class="btn btn-sm btn-danger" data-del="${o.id}" title="Удалить запись">×</button>`}</td>
      </tr>`).join('');

    const m = ui.modal({
      title: 'Расчёты: ' + data.supplier.name,
      size: 'lg',
      body: `
        <div class="grid grid-2" style="margin-bottom:16px">
          <div class="big-stat ${data.balance > 0.009 ? 'accent-crit' : 'accent-good'}">
            <div class="bs-label">Текущий долг перед поставщиком</div>
            <div class="bs-value">${ui.money(Math.max(0, data.balance))}</div>
            <div class="bs-sub">${data.balance < -0.009
              ? 'Переплата ' + ui.money(-data.balance)
              : (data.balance > 0.009 ? 'к оплате' : 'рассчитались полностью')}</div>
          </div>
          <div class="big-stat">
            <div class="bs-label">Его товар на нашей витрине</div>
            <div class="bs-value">${data.consignment_on_hand.count} шт</div>
            <div class="bs-sub">будущий долг ${ui.money(data.consignment_on_hand.value)} — станет долгом после продажи</div>
          </div>
        </div>
        <div class="row" style="margin-bottom:12px">
          <button class="btn" data-act="invoice">+ Поставка</button>
          <button class="btn btn-primary" data-act="payment">₽ Оплатить</button>
          <button class="btn btn-ghost" data-act="adjust">Корректировка</button>
        </div>
        ${data.ops.length ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Дата</th><th>Операция</th><th class="num">Сумма</th><th>Срок</th>
            <th>Комментарий</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
          : `<div class="empty"><div class="empty-ico">◇</div>
             <p>Операций пока нет. Запишите поставку — и система будет вести долг.</p></div>`}`,
      footer: '<button class="btn" data-act="close">Закрыть</button>',
    });

    m.foot.querySelector('[data-act=close]').onclick = m.close;
    ['invoice', 'payment', 'adjust'].forEach(type => {
      m.body.querySelector(`[data-act=${type}]`).addEventListener('click', () => {
        m.close();
        supplierOpDialog(data.supplier, type, data.balance);
      });
    });
    m.body.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await ui.confirmDialog('Удалить эту запись из расчётов?', { danger: true, okLabel: 'Удалить' })) return;
        try {
          await api.del('/api/debts/supplier-ops/' + btn.dataset.del);
          ui.toast('Запись удалена');
          m.close();
          openSupplier(supplierId);
        } catch (e) { ui.toastErr(e); }
      });
    });
  }

  function supplierOpDialog(supplier, type, balance) {
    const titles = { invoice: 'Новая поставка', payment: 'Оплата поставщику', adjust: 'Корректировка долга' };
    const today = new Date().toISOString().slice(0, 10);
    const m = ui.modal({
      title: `${titles[type]}: ${supplier.name}`,
      size: 'sm',
      body: `
        ${type === 'payment' ? `<div class="hint-box">Текущий долг: <strong>${ui.money(Math.max(0, balance))}</strong></div>` : ''}
        ${type === 'adjust' ? `<div class="hint-box">Положительная сумма увеличивает наш долг,
          отрицательная — уменьшает. Пригодится, если что-то не сошлось.</div>` : ''}
        <form id="op-form">
          <label class="field"><span>Сумма</span>
            <input name="amount" type="number" step="0.01" required autofocus
              ${type === 'payment' && balance > 0 ? `value="${balance}"` : ''}></label>
          <div class="form-grid">
            <label class="field"><span>Дата</span><input name="doc_date" type="date" value="${today}"></label>
            ${type === 'invoice'
              ? '<label class="field"><span>Оплатить до</span><input name="due_date" type="date"></label>'
              : `<label class="field"><span>Чем платим</span><select name="method">
                   <option value="cash">Наличные</option><option value="card">Карта</option>
                   <option value="transfer">Перевод</option></select></label>`}
          </div>
          ${type === 'invoice' ? '<label class="field"><span>Номер накладной</span><input name="doc_number"></label>' : ''}
          <label class="field"><span>Комментарий</span><input name="note"></label>
        </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Записать</button>`,
    });
    const form = m.body.querySelector('#op-form');
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      try {
        await api.post(`/api/debts/suppliers/${supplier.id}/ops`, { type, ...v, amount: Number(v.amount) });
        ui.toast('Записано');
        m.close();
        reload();
      } catch (e) { ui.toastErr(e); }
    };
  }

  // ---------- На реализации ----------

  async function renderConsignment(host) {
    const data = await api.get('/api/debts/consignment');
    if (!host.isConnected) return;

    host.innerHTML = `
      <div class="hint-box">
        <strong>Товар на реализации</strong> — чужие изделия у вас на витрине. Пока изделие стоит,
        вы ничего не должны. Как только оно продано, система сама записывает долг перед владельцем
        на закупочную стоимость. Возврат покупателя этот долг снимает.
      </div>
      <div class="grid grid-2" style="margin-bottom:18px">
        <div class="big-stat accent-gold">
          <div class="bs-label">Чужого товара на витрине</div>
          <div class="bs-value">${data.on_hand.length} шт</div>
          <div class="bs-sub">на ${ui.money(data.on_hand_value)} по закупке</div>
        </div>
        <div class="big-stat accent-crit">
          <div class="bs-label">Продано с реализации</div>
          <div class="bs-value">${ui.money(data.sold_value)}</div>
          <div class="bs-sub">записей: ${data.sold.length} — гасится оплатой поставщику</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Сейчас на витрине</div>
        ${data.on_hand.length ? ui.table([
          { title: 'Артикул', render: r => `<span class="mono strong">${ui.esc(r.sku)}</span>` },
          { title: 'Наименование', render: r => ui.esc(r.name) },
          { title: 'Владелец', render: r => ui.esc(r.supplier_name || '—') },
          { title: 'Точка', render: r => `<span class="dim">${ui.esc(r.store_name || '—')}</span>` },
          { title: 'Отдать владельцу', cls: 'num', render: r => ui.money(r.purchase_price) },
          { title: 'Наша цена', cls: 'num strong', render: r => ui.money(r.retail_price) },
          { title: 'Статус', render: r => ui.badge('status', r.status) },
        ], data.on_hand, { empty: 'Чужого товара на витрине нет' })
        : `<div class="empty"><div class="empty-ico">◇</div><p>Чужого товара на витрине нет.</p>
           <p class="muted">Отметьте изделие как «на реализации» в его карточке.</p></div>`}
      </div>

      ${data.sold.length ? `<div class="card">
        <div class="card-title">Продано — ждёт расчёта с владельцем</div>
        ${ui.table([
          { title: 'Когда', render: r => ui.dateOnly(r.created_at) },
          { title: 'Изделие', render: r => `<span class="mono">${ui.esc(r.sku || '—')}</span> ${ui.esc(r.name || '')}` },
          { title: 'Чек', render: r => ui.esc(r.sale_number || '—') },
          { title: 'Владелец', render: r => ui.esc(r.supplier_name || '—') },
          { title: 'Сумма к отдаче', cls: 'num strong', render: r => ui.money(r.amount) },
        ], data.sold, { empty: '' })}
      </div>` : ''}`;
  }

  // ---------- Каркас страницы ----------

  async function render(el) {
    pageEl = el;
    const admin = App.isAdmin();
    const tabs = [
      { key: 'customers', title: 'Нам должны' },
      ...(admin ? [
        { key: 'suppliers', title: 'Мы должны' },
        { key: 'consignment', title: 'На реализации' },
      ] : []),
    ];
    if (!tabs.some(t => t.key === tab)) tab = 'customers';

    el.innerHTML = `
      <div class="tabs">${tabs.map(t =>
        `<button class="tab ${t.key === tab ? 'active' : ''}" data-tab="${t.key}">${t.title}</button>`).join('')}</div>
      <div id="d-body"><div class="empty"><p>Загрузка…</p></div></div>`;

    el.querySelectorAll('.tab').forEach(b => {
      b.addEventListener('click', () => { tab = b.dataset.tab; render(el); });
    });

    const body = el.querySelector('#d-body');
    try {
      if (tab === 'customers') await renderCustomers(body);
      else if (tab === 'suppliers') await renderSuppliers(body);
      else await renderConsignment(body);
    } catch (e) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">◇</div><p>${ui.esc(e.message)}</p></div>`;
    }
  }

  return { title: 'Долги', render, payDialog };
})();
