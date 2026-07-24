'use strict';
window.Pages = window.Pages || {};

window.Pages.sales = (() => {
  let filters = { period: '30', payment_method: '', search: '' };

  function periodFrom(days) {
    if (!days) return '';
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(days) - 1));
    return d.toISOString();
  }

  let refreshSeq = 0;
  async function refresh(el) {
    const my = ++refreshSeq;
    const q = new URLSearchParams();
    if (filters.period) q.set('from', periodFrom(filters.period));
    if (filters.payment_method) q.set('payment_method', filters.payment_method);
    if (filters.search) q.set('search', filters.search);
    const { items, totals } = await api.get('/api/sales?' + q.toString());
    if (my !== refreshSeq || !el.isConnected) return;
    const listEl = el.querySelector('#sales-list');
    listEl.innerHTML = `<div class="muted" style="margin-bottom:8px">Чеков: ${totals.cnt} на сумму <b>${ui.money(totals.sum)}</b></div>` +
      ui.table([
        { title: 'Чек', render: r => `<span class="mono strong">${ui.esc(r.number)}</span>` },
        { title: 'Дата', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
        { title: 'Клиент', render: r => ui.esc(r.customer_name || '—') },
        { title: 'Продавец', render: r => `<span class="dim">${ui.esc(r.seller_name || '—')}</span>` },
        { title: 'Позиций', cls: 'num', render: r => r.items_count },
        { title: 'Оплата', render: r => ui.L.payment[r.payment_method] || r.payment_method },
        { title: 'Статус', render: r => ui.badge('saleStatus', r.status) },
        { title: 'Долг', cls: 'num', render: r => r.debt > 0.009
          ? `<span class="crit strong">${ui.money(r.debt)}</span>` : '<span class="dim">—</span>' },
        { title: 'Сумма', cls: 'num strong', render: r => ui.money(r.total) },
      ], items, { empty: 'Продаж за выбранный период нет.' });
    ui.bindRows(listEl, items, r => openDetail(r.id, () => refresh(el)));
  }

  // ---------- Чек (печать) ----------
  function printReceipt(s) {
    const root = document.getElementById('print-root');
    root.innerHTML = `<div class="receipt">
      <h2>${ui.esc(App.storeName)}</h2>
      <div class="r-center">Товарный чек ${ui.esc(s.number)}</div>
      <div class="r-center">${ui.dt(s.created_at)}</div>
      <div class="r-line"></div>
      <table>${s.items.map(i => `
        <tr><td>${ui.esc(i.name)}<br><small>${ui.esc(i.sku)}${i.metal ? ' · ' + ui.esc(i.metal) : ''}${i.weight ? ' · ' + i.weight + ' г' : ''}</small></td>
        <td style="text-align:right;vertical-align:top">${ui.money(i.price)}</td></tr>`).join('')}
      </table>
      <div class="r-line"></div>
      <div class="r-row"><span>Сумма</span><span>${ui.money(s.subtotal)}</span></div>
      ${s.discount_total > 0 ? `<div class="r-row"><span>Скидка${s.bonus_spent > 0 ? ' (в т.ч. бонусы)' : ''}</span><span>−${ui.money(s.discount_total)}</span></div>` : ''}
      <div class="r-row"><b>ИТОГО</b><b>${ui.money(s.total)}</b></div>
      <div class="r-row"><span>Оплата</span><span>${ui.L.payment[s.payment_method]}</span></div>
      ${s.customer_name ? `<div class="r-row"><span>Клиент</span><span>${ui.esc(s.customer_name)}</span></div>` : ''}
      ${s.bonus_earned > 0 ? `<div class="r-row"><span>Начислено бонусов</span><span>${ui.num(s.bonus_earned)}</span></div>` : ''}
      <div class="r-line"></div>
      <div class="r-center">Продавец: ${ui.esc(s.seller_name || '—')}</div>
      <div class="r-center">Спасибо за покупку! ✦</div>
    </div>`;
    window.print();
  }

  // ---------- Детали продажи / возврат ----------
  function openDetail(id, onChange) {
    api.get('/api/sales/' + id).then(s => {
      const canReturn = s.items.some(i => !i.returned);
      const m = ui.modal({
        title: 'Чек ' + s.number,
        size: 'lg',
        body: `
          <div class="grid grid-2" style="margin-bottom:6px">
            <dl class="kv">
              <dt>Дата</dt><dd>${ui.dt(s.created_at)}</dd>
              <dt>Клиент</dt><dd>${s.customer_id ? `<a href="#/customers/${s.customer_id}">${ui.esc(s.customer_name)}</a>` : '—'}</dd>
              <dt>Продавец</dt><dd>${ui.esc(s.seller_name || '—')}</dd>
            </dl>
            <dl class="kv">
              <dt>Оплата</dt><dd>${ui.L.payment[s.payment_method]}</dd>
              <dt>Статус</dt><dd>${ui.badge('saleStatus', s.status)}</dd>
              <dt>Оплачено</dt><dd>${ui.money(s.paid)}${s.debt > 0
                ? ` из ${ui.money(s.effective_total)}` : ''}</dd>
              ${s.debt > 0 ? `<dt>Долг</dt><dd class="big-money crit">${ui.money(s.debt)}${
                s.due_date ? `<div class="muted" style="font-size:13px;font-weight:400">до ${ui.dateOnly(s.due_date)}</div>` : ''}</dd>` : ''}
              ${s.bonus_spent > 0 ? `<dt>Списано бонусов</dt><dd>${ui.num(s.bonus_spent)}</dd>` : ''}
              ${s.bonus_earned > 0 ? `<dt>Начислено бонусов</dt><dd>${ui.num(s.bonus_earned)}</dd>` : ''}
            </dl>
          </div>
          ${s.payments && s.payments.length > 1 ? `
            <h4 style="margin:14px 0 8px">Платежи по чеку</h4>
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>Когда</th><th class="num">Сумма</th><th>Как</th><th>Комментарий</th></tr></thead>
              <tbody>${s.payments.map(p => `<tr>
                <td>${ui.dt(p.created_at)}</td>
                <td class="num ${p.amount < 0 ? 'crit' : 'good'}">${ui.money(p.amount)}</td>
                <td>${ui.esc(ui.L.payment[p.method] || p.method)}</td>
                <td class="dim">${ui.esc(p.note || '')}</td></tr>`).join('')}</tbody>
            </table></div>` : ''}
          <div class="table-wrap"><table class="tbl">
            <thead><tr>${canReturn ? '<th></th>' : ''}<th>Изделие</th><th class="num">Цена</th><th class="num">Скидка</th><th class="num">Итог</th><th></th></tr></thead>
            <tbody>${s.items.map(i => `<tr>
              ${canReturn ? `<td>${i.returned ? '' : `<input type="checkbox" class="ret-chk" value="${i.id}">`}</td>` : ''}
              <td>${ui.esc(i.name)}<div class="dim" style="font-size:11px">${ui.esc(i.sku)}${i.metal ? ' · ' + ui.esc(i.metal) : ''}</div></td>
              <td class="num">${ui.money(i.price)}</td>
              <td class="num">${i.discount ? '−' + ui.money(i.discount) : '—'}</td>
              <td class="num strong">${ui.money(i.final_price)}</td>
              <td>${i.returned ? `<span class="badge badge-crit">возврат ${ui.dateOnly(i.returned_at)}</span>` : ''}</td>
            </tr>`).join('')}</tbody>
            <tfoot><tr>${canReturn ? '<td></td>' : ''}<td>Итого</td><td class="num">${ui.money(s.subtotal)}</td>
              <td class="num">${s.discount_total ? '−' + ui.money(s.discount_total) : '—'}</td>
              <td class="num">${ui.money(s.total)}</td><td></td></tr></tfoot>
          </table></div>
          ${s.note ? `<p class="muted">Комментарий: ${ui.esc(s.note)}</p>` : ''}`,
        footer: `
          ${canReturn ? '<button class="btn btn-danger left" data-act="return" disabled>Оформить возврат</button>' : ''}
          ${s.debt > 0 ? '<button class="btn btn-primary" data-act="pay">₽ Принять оплату</button>' : ''}
          <button class="btn" data-act="print">🖨 Печать чека</button>
          <button class="btn" data-act="close">Закрыть</button>`,
      });
      const payBtn = m.foot.querySelector('[data-act=pay]');
      if (payBtn) payBtn.onclick = () => {
        m.close();
        Pages.debts.payDialog({
          customer: { id: s.customer_id, name: s.customer_name, phone: s.customer_phone },
          doc: { kind: 'sale', id: s.id, number: s.number, debt: s.debt },
          maxAmount: s.debt,
        });
      };
      const retBtn = m.foot.querySelector('[data-act=return]');
      m.body.querySelectorAll('.ret-chk').forEach(chk => chk.addEventListener('change', () => {
        if (retBtn) retBtn.disabled = !m.body.querySelector('.ret-chk:checked');
      }));
      if (retBtn) retBtn.onclick = async () => {
        const ids = [...m.body.querySelectorAll('.ret-chk:checked')].map(c => Number(c.value));
        const ok = await ui.confirmDialog(
          `Оформить возврат ${ids.length} позиц.? Изделия вернутся на витрину.` +
          (s.debt > 0 ? ' Сначала спишется долг клиента, деньгами вернём только полученное.'
                      : ' Деньги вернутся покупателю.'),
          { danger: true, okLabel: 'Возврат' });
        if (!ok) return;
        try {
          const res = await api.post(`/api/sales/${id}/return`, { item_ids: ids });
          ui.toast(res.debt_written_off > 0
            ? `Возврат оформлен. Списан долг ${ui.money(res.debt_written_off)}` +
              (res.cash_refund > 0 ? `, деньгами ${ui.money(res.cash_refund)}` : '')
            : 'Возврат оформлен');
          m.close(); onChange && onChange();
        } catch (e) { ui.toastErr(e); }
      };
      m.foot.querySelector('[data-act=print]').onclick = () => printReceipt(s);
      m.foot.querySelector('[data-act=close]').onclick = m.close;
    }).catch(ui.toastErr);
  }

  // ---------- Новая продажа (POS) ----------
  function newSale(initialProduct, initialCustomer) {
    const state = {
      items: [],          // {product, discount}
      customer: null,
      bonusSpend: 0,
      payment: 'cash',
    };

    const m = ui.modal({
      title: 'Новая продажа',
      size: 'lg',
      body: `
        <div class="rel" style="margin-bottom:14px">
          <input type="text" class="input" id="pos-search" placeholder="Изделие: название, артикул или сканируйте штрихкод…" autocomplete="off">
        </div>
        <div class="pos-items" id="pos-items"></div>
        <div class="form-grid">
          <div>
            <label class="field"><span>Клиент</span>
              <div class="rel"><input type="text" class="input" id="pos-customer" placeholder="Поиск клиента…" autocomplete="off"></div>
            </label>
            <div id="pos-cust-info" class="muted" style="margin:-6px 0 12px;font-size:12.5px">Продажа без клиента</div>
          </div>
          <div>
            <label class="field"><span>Способ оплаты</span>
              <select id="pos-payment">
                <option value="cash">Наличные</option><option value="card">Карта</option>
                <option value="transfer">Перевод</option><option value="installment">Рассрочка</option>
              </select></label>
          </div>
        </div>
        <div class="form-grid-3">
          <label class="field"><span>Скидка на чек, %</span><input type="number" id="pos-disc-pct" min="0" max="100" step="0.5" placeholder="0"></label>
          <label class="field"><span>Списать бонусы</span><input type="number" id="pos-bonus" min="0" step="1" placeholder="0" disabled></label>
          <label class="field"><span>Комментарий</span><input type="text" id="pos-note"></label>
        </div>

        <label class="row-tight" style="cursor:pointer;margin-bottom:10px">
          <input type="checkbox" id="pos-partial" style="width:20px;height:20px;cursor:pointer">
          <span style="font-weight:600">Платит не всю сумму — оставить долг</span>
        </label>
        <div id="pos-debt-fields" class="form-grid hidden">
          <label class="field"><span>Вносит сейчас</span>
            <input type="number" id="pos-paid" min="0" step="1" placeholder="0"></label>
          <label class="field"><span>Обещает погасить до</span><input type="date" id="pos-due"></label>
        </div>

        <div id="pos-summary"></div>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="submit" disabled>Оформить продажу</button>`,
    });

    const itemsEl = m.body.querySelector('#pos-items');
    const summaryEl = m.body.querySelector('#pos-summary');
    const submitBtn = m.foot.querySelector('[data-act=submit]');
    const bonusInput = m.body.querySelector('#pos-bonus');
    const discPctInput = m.body.querySelector('#pos-disc-pct');
    const partialCb = m.body.querySelector('#pos-partial');
    const paidInput = m.body.querySelector('#pos-paid');
    const dueInput = m.body.querySelector('#pos-due');

    function calc() {
      let subtotal = 0, discount = 0;
      for (const it of state.items) {
        subtotal += it.product.retail_price;
        discount += it.discount;
      }
      const afterItems = Math.max(0, subtotal - discount);
      state.bonusSpend = Math.min(Number(bonusInput.value) || 0, afterItems, state.customer ? state.customer.bonus_points : 0);
      const total = Math.round((afterItems - state.bonusSpend) * 100) / 100;
      return { subtotal, discount, total };
    }

    function renderItems() {
      if (!state.items.length) {
        itemsEl.innerHTML = '<div class="empty" style="padding:22px"><p>Добавьте изделия через поиск выше</p></div>';
      } else {
        itemsEl.innerHTML = state.items.map((it, i) => `
          <div class="pos-item">
            <div>
              <div class="pi-name">${ui.esc(it.product.name)}</div>
              <div class="pi-sub">${ui.esc(it.product.sku)}${it.product.metal ? ' · ' + ui.esc(it.product.metal) : ''}${it.product.status === 'reserved' ? ' · <b>из резерва</b>' : ''}</div>
            </div>
            <div class="num money">${ui.money(it.product.retail_price)}</div>
            <input type="number" class="input" data-i="${i}" min="0" max="${it.product.retail_price}" step="1" value="${it.discount || ''}" placeholder="скидка ₽">
            <button class="btn btn-sm btn-danger" data-del="${i}">×</button>
          </div>`).join('');
      }
      const { subtotal, discount, total } = calc();
      // Долг: сколько остаётся за клиентом после того, что он платит сейчас.
      const partial = partialCb.checked;
      paidInput.max = total;
      const paid = partial ? Math.min(Math.max(Number(paidInput.value) || 0, 0), total) : total;
      const debt = Math.round((total - paid) * 100) / 100;

      summaryEl.innerHTML = `
        <div class="pos-total"><span>Сумма</span><span class="money">${ui.money(subtotal)}</span></div>
        ${discount || state.bonusSpend ? `<div class="pos-total"><span>Скидка${state.bonusSpend ? ' + бонусы' : ''}</span><span class="money">−${ui.money(discount + state.bonusSpend)}</span></div>` : ''}
        <div class="pos-total grand"><span>К оплате</span><span class="money">${ui.money(total)}</span></div>
        ${debt > 0 ? `
          <div class="pos-total"><span>Вносит сейчас</span><span class="money good">${ui.money(paid)}</span></div>
          <div class="pos-total"><span><b>Останется долг</b></span>
            <span class="money crit" style="font-weight:700">${ui.money(debt)}</span></div>` : ''}`;

      // Долг всегда числится за конкретным человеком — иначе спросить будет не с кого.
      const needCustomer = debt > 0 && !state.customer;
      submitBtn.disabled = !state.items.length || needCustomer;
      submitBtn.textContent = debt > 0 ? 'Оформить с долгом' : 'Оформить продажу';
      if (needCustomer) {
        m.body.querySelector('#pos-cust-info').innerHTML =
          '<span class="crit">Для продажи в долг выберите клиента</span>';
      }
      bonusInput.disabled = !state.customer;
      bonusInput.placeholder = state.customer ? `доступно ${ui.num(state.customer.bonus_points)}` : 'выберите клиента';
      state.paid = paid;
    }

    itemsEl.addEventListener('input', e => {
      const i = e.target.dataset.i;
      if (i === undefined) return;
      const it = state.items[Number(i)];
      it.discount = Math.min(Math.max(Number(e.target.value) || 0, 0), it.product.retail_price);
      renderItems();
      // вернуть фокус в поле скидки после перерисовки
      const el2 = itemsEl.querySelector(`input[data-i="${i}"]`);
      if (el2) { el2.focus(); el2.value = it.discount || ''; }
    });
    itemsEl.addEventListener('click', e => {
      const del = e.target.dataset && e.target.dataset.del;
      if (del !== undefined) { state.items.splice(Number(del), 1); renderItems(); }
    });

    function applyPctDiscount() {
      const pct = Math.min(Math.max(Number(discPctInput.value) || 0, 0), 100);
      for (const it of state.items) {
        it.discount = Math.round(it.product.retail_price * pct) / 100;
      }
      renderItems();
    }
    discPctInput.addEventListener('input', ui.debounce(applyPctDiscount, 350));
    bonusInput.addEventListener('input', ui.debounce(renderItems, 300));
    m.body.querySelector('#pos-payment').addEventListener('change', e => {
      state.payment = e.target.value;
      // «Рассрочка» почти всегда означает частичную оплату — включаем поля сразу.
      if (e.target.value === 'installment' && !partialCb.checked) {
        partialCb.checked = true;
        partialCb.dispatchEvent(new Event('change'));
      }
    });
    partialCb.addEventListener('change', () => {
      m.body.querySelector('#pos-debt-fields').classList.toggle('hidden', !partialCb.checked);
      if (partialCb.checked && !paidInput.value) paidInput.value = 0;
      renderItems();
    });
    paidInput.addEventListener('input', ui.debounce(renderItems, 250));

    function addProduct(p) {
      if (state.items.some(it => it.product.id === p.id)) { ui.toast('Это изделие уже в чеке', true); return; }
      if (p.status !== 'in_stock' && p.status !== 'reserved') { ui.toast('Изделие недоступно для продажи', true); return; }
      state.items.push({ product: p, discount: 0 });
      if (Number(discPctInput.value)) applyPctDiscount(); else renderItems();
    }

    // Поиск изделий (+ сканер штрихкодов: ввод + Enter)
    const searchInput = m.body.querySelector('#pos-search');
    const searchWrap = searchInput.closest('.rel');
    const clearResults = () => searchWrap.querySelectorAll('.search-results').forEach(b => b.remove());
    let searchSeq = 0, lastResults = [];
    const doSearch = ui.debounce(async () => {
      const my = ++searchSeq;
      const q = searchInput.value.trim();
      clearResults();
      if (q.length < 2) return;
      const { items } = await api.get('/api/products?search=' + encodeURIComponent(q));
      if (my !== searchSeq) return; // ответ устарел
      clearResults();
      lastResults = items.filter(p => p.status === 'in_stock' || p.status === 'reserved');
      const resultsBox = document.createElement('div');
      resultsBox.className = 'search-results';
      resultsBox.innerHTML = lastResults.slice(0, 8).map((p, i) => `
        <div class="sr-item" data-i="${i}">
          <span>${ui.esc(p.name)} <span class="sr-sub">${ui.esc(p.sku)}${p.status === 'reserved' ? ' · резерв' : ''}</span></span>
          <b class="money">${ui.money(p.retail_price)}</b>
        </div>`).join('') || '<div class="sr-item muted">Нет доступных изделий по запросу</div>';
      resultsBox.querySelectorAll('.sr-item[data-i]').forEach(el => {
        el.addEventListener('mousedown', () => {
          addProduct(lastResults[Number(el.dataset.i)]);
          searchInput.value = '';
          clearResults();
          searchInput.focus();
        });
      });
      searchWrap.appendChild(resultsBox);
    }, 200);
    searchInput.addEventListener('input', doSearch);
    searchInput.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      // сканер: точное совпадение по штрихкоду или артикулу
      const { items } = await api.get('/api/products?search=' + encodeURIComponent(q));
      const exact = items.find(p => p.barcode === q || p.sku.toLowerCase() === q.toLowerCase());
      const pick = exact || (lastResults.length === 1 ? lastResults[0] : null);
      if (pick) {
        addProduct(pick);
        searchInput.value = '';
        clearResults();
      }
    });
    searchInput.addEventListener('blur', () => setTimeout(clearResults, 150));

    // Выбор клиента
    const custInput = m.body.querySelector('#pos-customer');
    const custInfo = m.body.querySelector('#pos-cust-info');
    function setCustomer(c) {
      state.customer = c;
      if (c) {
        custInput.value = c.name;
        custInfo.innerHTML = `${ui.badge('segment', c.segment)} · бонусов: <b>${ui.num(c.bonus_points)}</b>${c.discount ? ` · личная скидка ${c.discount}% применена` : ''}`;
        if (c.discount && !Number(discPctInput.value)) {
          discPctInput.value = c.discount;
          applyPctDiscount();
        }
      } else {
        custInfo.textContent = 'Продажа без клиента';
      }
      renderItems();
    }
    Pages.products.attachCustomerSearch(custInput, setCustomer);

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    submitBtn.onclick = async () => {
      const { total } = calc();
      const payload = {
        customer_id: state.customer ? state.customer.id : null,
        items: state.items.map(it => ({ product_id: it.product.id, discount: it.discount })),
        payment_method: m.body.querySelector('#pos-payment').value,
        bonus_spent: state.bonusSpend,
        note: m.body.querySelector('#pos-note').value.trim(),
      };
      if (partialCb.checked) {
        payload.paid = state.paid;
        payload.due_date = dueInput.value || '';
      }
      submitBtn.disabled = true;
      try {
        const sale = await api.post('/api/sales', payload);
        m.close();
        ui.toast(sale.debt > 0
          ? `Продажа ${sale.number} оформлена. Долг клиента: ${ui.money(sale.debt)}`
          : `Продажа ${sale.number} на ${ui.money(sale.total)} оформлена ✦`);
        if (Pages._salesRefresh) Pages._salesRefresh();
        if (location.hash.includes('dashboard') || location.hash === '' || location.hash === '#/') {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        const printOk = await ui.confirmDialog('Напечатать чек?', { okLabel: 'Печать' });
        if (printOk) printReceipt(sale);
      } catch (e) {
        ui.toastErr(e);
        submitBtn.disabled = false;
      }
    };

    renderItems();
    if (initialProduct) addProduct(initialProduct);
    if (initialCustomer) setCustomer(initialCustomer);
    setTimeout(() => searchInput.focus(), 60);
  }

  return {
    title: 'Продажи',
    newSale,
    openDetail,
    async render(el, param) {
      el.innerHTML = `
        <div class="toolbar">
          <input type="text" class="input search" id="sf-search" placeholder="Поиск: номер чека, изделие…" autocomplete="off">
          <select class="input" id="sf-period">
            <option value="1">Сегодня</option>
            <option value="7">7 дней</option>
            <option value="30" selected>30 дней</option>
            <option value="365">Год</option>
            <option value="">Всё время</option>
          </select>
          <select class="input" id="sf-payment">
            <option value="">Любая оплата</option>
            <option value="cash">Наличные</option><option value="card">Карта</option>
            <option value="transfer">Перевод</option><option value="installment">Рассрочка</option>
          </select>
          <div class="spacer"></div>
          ${App.isAdmin() ? '<a class="btn" href="/api/export/sales" download>Экспорт CSV</a>' : ''}
          <button class="btn btn-primary" id="sf-new">+ Новая продажа</button>
        </div>
        <div id="sales-list"></div>`;

      filters = { period: '30', payment_method: '', search: '' };
      const doRefresh = () => refresh(el).catch(ui.toastErr);
      Pages._salesRefresh = doRefresh;
      el.querySelector('#sf-search').addEventListener('input', ui.debounce(e => { filters.search = e.target.value.trim(); doRefresh(); }));
      el.querySelector('#sf-period').addEventListener('change', e => { filters.period = e.target.value; doRefresh(); });
      el.querySelector('#sf-payment').addEventListener('change', e => { filters.payment_method = e.target.value; doRefresh(); });
      el.querySelector('#sf-new').addEventListener('click', () => newSale());
      await refresh(el);
      if (param) openDetail(Number(param), doRefresh);
    },
  };
})();
