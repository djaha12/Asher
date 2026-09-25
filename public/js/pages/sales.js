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
      ${s.discount_total > 0 ? `<div class="r-row"><span>Скидка</span><span>−${ui.money(s.discount_total)}</span></div>` : ''}
      <div class="r-row"><b>ИТОГО</b><b>${ui.money(s.total)}</b></div>
      <div class="r-row"><span>Оплата</span><span>${ui.L.payment[s.payment_method]}</span></div>
      ${s.debt > 0 ? `<div class="r-row"><span>Оплачено</span><span>${ui.money(s.paid)}</span></div>
      <div class="r-row"><b>Остаток долга</b><b>${ui.money(s.debt)}</b></div>
      ${s.due_date ? `<div class="r-row"><span>Погасить до</span><span>${ui.dateOnly(s.due_date)}</span></div>` : ''}` : ''}
      ${s.customer_name ? `<div class="r-row"><span>Клиент</span><span>${ui.esc(s.customer_name)}</span></div>` : ''}
      <div class="r-line"></div>
      <div class="r-center">Продавец: ${ui.esc(s.seller_name || '—')}</div>
      <div class="r-center">Спасибо за покупку!</div>
    </div>`;
    window.print();
  }

  /*
   * Акт приёма старого золота — два экземпляра на листе, клиенту и магазину,
   * с весом каждой вещи, пробой, ценой грамма и подписями. Без него через
   * месяц не доказать ни клиенту, ни себе, сколько золота приняли и почём.
   */
  function печатьАкта(а) {
    const root = document.getElementById('print-root');
    const г = w => ui.num(w, 3) + ' г';
    const экземпляр = кому => `<div class="receipt">
      <h2>${ui.esc(App.storeName)}</h2>
      <div class="r-center"><b>Акт приёма № ${ui.esc(а.number)}</b></div>
      <div class="r-center">старого золота в зачёт покупки</div>
      <div class="r-center">${ui.dt(а.created_at)}</div>
      <div class="r-line"></div>
      <div class="r-kv"><b>Клиент:</b> ${ui.esc(а.customer_name || '—')}${а.customer_phone ? ', ' + ui.esc(а.customer_phone) : ''}</div>
      <div class="r-line"></div>
      ${а.items.map(r => `<div class="r-kv">${ui.esc(r.description || 'Лом')}, проба ${r.fineness}</div>
        <div class="r-row"><span>${г(r.weight)} × ${ui.money(r.price)}</span><span>${ui.money(r.amount)}</span></div>`).join('')}
      <div class="r-line"></div>
      <div class="r-row"><span>Вес всего</span><span>${г(а.weight)}</span></div>
      <div class="r-row"><span>Чистого золота</span><span>${г(а.pure_weight)}</span></div>
      <div class="r-row"><b>В зачёт</b><b>${ui.money(а.amount)}</b></div>
      ${а.sale_number ? `<div class="r-kv">в оплату покупки по чеку ${ui.esc(а.sale_number)}</div>` : ''}
      <div class="r-line"></div>
      <div class="r-small">Вес и проба определены при клиенте, с оценкой клиент согласен.
        Изделия переданы магазину в зачёт покупки.</div>
      <div class="r-sign">Сдал (клиент): ________________</div>
      <div class="r-sign">Принял: ${ui.esc(а.user_name || '')} ____________</div>
      <div class="r-center r-small">${кому}</div>
    </div>`;
    root.innerHTML = экземпляр('Экземпляр клиента') +
      '<div class="r-cut">✂ - - - - - - - - - - - - - - - - - -</div>' + экземпляр('Экземпляр магазина');
    window.print();
  }

  // После продажи с зачётом: и чек, и акт — отдельными кнопками.
  function печатьПослеЗачёта(sale) {
    const m = ui.modal({
      title: `Продажа ${sale.number} оформлена`,
      size: 'sm',
      body: `<p style="margin:4px 0">Старое золото принято по акту <b>${ui.esc(sale.scrap.number)}</b>
        на ${ui.money(sale.scrap.amount)}. Дайте клиенту чек и акт: на экземпляре магазина клиент расписывается.</p>`,
      footer: `<button class="btn" data-act="done">Готово</button>
        <button class="btn" data-act="receipt">${ui.icon('print')} Чек</button>
        <button class="btn btn-primary" data-act="act">${ui.icon('print')} Акт приёма</button>`,
    });
    m.foot.querySelector('[data-act=done]').onclick = m.close;
    m.foot.querySelector('[data-act=receipt]').onclick = () => printReceipt(sale);
    m.foot.querySelector('[data-act=act]').onclick = () => печатьАкта(sale.scrap);
  }

  const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

  /*
   * Фото бирки → изделие. Распознаём QR, из текста готовим кандидатов
   * (артикул, штрихкод, кусок ссылки) и ищем точное совпадение в каталоге.
   */
  async function productByCode(text) {
    for (const code of Scan.candidates(text)) {
      const { items } = await api.get('/api/products?search=' + encodeURIComponent(code));
      const exact = items.find(pr => pr.barcode === code || pr.sku.toLowerCase() === code.toLowerCase());
      if (exact) return exact;
    }
    return null;
  }

  async function productFromPhoto() {
    const text = await Scan.pickAndDecode();
    if (!text) { ui.toast('QR-код на фото не распознан. Снимите ближе и без бликов.', true); return null; }
    const found = await productByCode(text);
    if (!found) ui.toast(`Изделие с кодом «${Scan.candidates(text)[0]}» не найдено`, true);
    return found;
  }

  /*
   * Камера в кассе и при обмене. Раньше на каждое изделие открывалась камера
   * телефона: снять, «использовать фото», и так на каждую бирку. Теперь одно
   * нажатие — и камера читает бирки сама, изделие за изделием, пока её не
   * выключат тем же нажатием. Где живой камеры браузер не даёт (адрес без
   * https), остаётся прежнее — распознать по фото.
   *
   * Возвращает «выключить»: окно зовёт его, закрываясь, иначе камера
   * телефона так и осталась бы включённой.
   */
  function камераВЧеке(кнопка, место, добавить) {
    let стоп = null;
    let занята = false;
    const взятые = new Set();   // бирка, долго стоящая в кадре, не добавляется по кругу
    function выключить() {
      if (стоп) { стоп(); стоп = null; }
      кнопка.classList.remove('active');
      кнопка.setAttribute('aria-pressed', 'false');
    }
    кнопка.addEventListener('click', async () => {
      if (стоп) { выключить(); return; }
      if (!Scan.cameraSupported()) {
        const found = await productFromPhoto();
        if (found) добавить(found);
        return;
      }
      стоп = await Scan.live(место, async код => {
        if (занята) return;
        занята = true;
        try {
          const found = await productByCode(код);
          if (!found) { ui.toast(`Изделие с кодом «${Scan.candidates(код)[0]}» не найдено`, true); return; }
          if (взятые.has(found.id)) return;
          взятые.add(found.id);
          добавить(found);
          if (navigator.vibrate) navigator.vibrate(40);
        } catch { /* связь моргнула — прочитаем эту бирку снова со следующего кадра */ }
        finally { занята = false; }
      });
      if (стоп) {
        кнопка.classList.add('active');
        кнопка.setAttribute('aria-pressed', 'true');
      }
    });
    return выключить;
  }

  /*
   * Обмен: клиент возвращает выбранные позиции чека и берёт другие изделия.
   * Деньги за возвращённое идут в зачёт нового чека — на руки выдаётся или
   * доплачивается только разница. Всё оформляется одним действием.
   */
  function exchangeDialog(s, returnIds, onChange) {
    const chosen = s.items.filter(i => returnIds.includes(i.id) && !i.returned);
    if (!chosen.length) { ui.toast('Не выбраны позиции для обмена', true); return; }
    const returnedValue = r2(chosen.reduce((sum, i) => sum + i.final_price, 0));
    const newEffective = r2(s.effective_total - returnedValue);
    // В зачёт идёт только реально оплаченное: если по чеку висел долг,
    // возврат сперва гасит его, и лишь остаток становится зачётом.
    const credit = Math.max(0, r2(s.paid - newEffective));
    const debtCut = r2(returnedValue - credit);
    const newItems = []; // {product, discount}

    let выключитьКамеру = null;
    const m = ui.modal({
      title: `Обмен по чеку ${s.number}`,
      size: 'lg',
      onClose: () => { if (выключитьКамеру) выключитьКамеру(); },
      грязно: () => newItems.length > 0 || ui.естьВведённое(m.body),
      body: `
        <div class="hint-box">
          Клиент возвращает: ${chosen.map(i => `<strong>${ui.esc(i.name)}</strong>`).join(', ')}
          на сумму <strong>${ui.money(returnedValue)}</strong>.
          ${debtCut > 0.009 ? `Сначала спишется долг по чеку ${ui.money(debtCut)}. ` : ''}
          В зачёт нового идёт <strong>${ui.money(credit)}</strong>.
        </div>
        <div class="row" style="margin-bottom:14px;flex-wrap:nowrap">
          <div class="rel grow">
            <input type="text" class="input" id="ex-search"
              placeholder="Что берёт взамен: название, артикул или сканируйте штрихкод…" autocomplete="off">
          </div>
          <button type="button" class="btn" id="ex-scan" title="Камера: читает бирки сама">${ui.icon('camera')}</button>
        </div>
        <div id="ex-camera" class="hidden" style="margin-bottom:14px"></div>
        <div class="pos-items" id="ex-items"></div>
        <div class="form-grid">
          <label class="field"><span>Способ оплаты доплаты</span>
            <select id="ex-payment">
              <option value="cash">Наличные</option><option value="card">Карта</option>
              <option value="transfer">Перевод</option>
            </select></label>
          <label class="field"><span>Комментарий</span><input type="text" id="ex-note"></label>
        </div>
        ${s.customer_id ? `
          <label class="row-tight" style="cursor:pointer;margin-bottom:10px">
            <input type="checkbox" id="ex-partial" style="width:20px;height:20px;cursor:pointer">
            <span style="font-weight:600">Доплачивает не всё — остаток в долг</span>
          </label>
          <div id="ex-debt-fields" class="form-grid hidden">
            <label class="field"><span>Доплачивает сейчас</span>
              <input type="number" id="ex-paid" min="0" step="1"></label>
            <label class="field"><span>Обещает погасить до</span><input type="date" id="ex-due"></label>
          </div>` : ''}
        <div id="ex-summary"></div>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok" disabled>Оформить обмен</button>`,
    });

    const itemsEl = m.body.querySelector('#ex-items');
    const summaryEl = m.body.querySelector('#ex-summary');
    const okBtn = m.foot.querySelector('[data-act=ok]');
    const partialCb = m.body.querySelector('#ex-partial');
    const paidInput = m.body.querySelector('#ex-paid');
    const dueInput = m.body.querySelector('#ex-due');
    let extraPaid = 0;

    function totals() {
      const newTotal = r2(newItems.reduce((sum, it) => sum + it.product.retail_price - it.discount, 0));
      const extraNeeded = Math.max(0, r2(newTotal - credit));
      const cashBack = Math.max(0, r2(credit - newTotal));
      return { newTotal, extraNeeded, cashBack };
    }

    function renderEx() {
      if (!newItems.length) {
        itemsEl.innerHTML = '<div class="empty" style="padding:22px"><p>Добавьте изделия через поиск выше</p></div>';
      } else {
        itemsEl.innerHTML = newItems.map((it, i) => `
          <div class="pos-item">
            <div>
              <div class="pi-name">${ui.esc(it.product.name)}</div>
              <div class="pi-sub">${ui.esc(it.product.sku)}${it.product.metal ? ' · ' + ui.esc(it.product.metal) : ''}</div>
            </div>
            <div class="num money">${ui.money(it.product.retail_price)}</div>
            <input type="number" class="input" data-i="${i}" min="0" max="${it.product.retail_price}" step="1"
              value="${it.discount || ''}" placeholder="скидка">
            <button class="btn btn-sm btn-danger" data-del="${i}">×</button>
          </div>`).join('');
      }

      const { newTotal, extraNeeded, cashBack } = totals();
      const partial = partialCb && partialCb.checked;
      if (paidInput) paidInput.max = extraNeeded;
      extraPaid = partial
        ? Math.min(Math.max(Number(paidInput.value) || 0, 0), extraNeeded)
        : extraNeeded;
      const newDebt = r2(extraNeeded - extraPaid);

      summaryEl.innerHTML = `
        <div class="pos-total"><span>Новые изделия</span><span class="money">${ui.money(newTotal)}</span></div>
        <div class="pos-total"><span>Зачёт за возвращённое</span>
          <span class="money good">−${ui.money(Math.min(credit, newTotal))}</span></div>
        ${cashBack > 0 ? `<div class="pos-total grand"><span>Вернуть клиенту</span>
          <span class="money">${ui.money(cashBack)}</span></div>` : ''}
        ${extraNeeded > 0 ? `<div class="pos-total grand"><span>К доплате</span>
          <span class="money">${ui.money(extraNeeded)}</span></div>` : ''}
        ${cashBack === 0 && extraNeeded === 0 && newItems.length
          ? '<div class="pos-total grand"><span>Ровный обмен</span><span class="money">0</span></div>' : ''}
        ${newDebt > 0.009 ? `
          <div class="pos-total"><span>Доплачивает сейчас</span><span class="money good">${ui.money(extraPaid)}</span></div>
          <div class="pos-total"><span><b>Останется долг</b></span>
            <span class="money crit" style="font-weight:700">${ui.money(newDebt)}</span></div>` : ''}`;

      okBtn.disabled = !newItems.length;
      okBtn.textContent = newDebt > 0.009 ? 'Оформить обмен с долгом' : 'Оформить обмен';
    }

    itemsEl.addEventListener('input', e => {
      const i = e.target.dataset.i;
      if (i === undefined) return;
      const it = newItems[Number(i)];
      it.discount = Math.min(Math.max(Number(e.target.value) || 0, 0), it.product.retail_price);
      renderEx();
      const el2 = itemsEl.querySelector(`input[data-i="${i}"]`);
      if (el2) { el2.focus(); el2.value = it.discount || ''; }
    });
    itemsEl.addEventListener('click', e => {
      const del = e.target.dataset && e.target.dataset.del;
      if (del !== undefined) { newItems.splice(Number(del), 1); renderEx(); }
    });
    if (partialCb) {
      partialCb.addEventListener('change', () => {
        m.body.querySelector('#ex-debt-fields').classList.toggle('hidden', !partialCb.checked);
        if (partialCb.checked && !paidInput.value) paidInput.value = 0;
        renderEx();
      });
      paidInput.addEventListener('input', ui.debounce(renderEx, 250));
    }

    // Поиск изделий — как в кассе: набор текста или сканер со считыванием + Enter.
    const searchInput = m.body.querySelector('#ex-search');
    const searchWrap = searchInput.closest('.rel');
    const clearResults = () => searchWrap.querySelectorAll('.search-results').forEach(b => b.remove());
    let seq = 0, lastResults = [];
    function addItem(prod) {
      if (newItems.some(it => it.product.id === prod.id)) { ui.toast('Это изделие уже в списке', true); return; }
      if (prod.status !== 'in_stock' && prod.status !== 'reserved') {
        ui.toast('Изделие недоступно для продажи', true);
        return;
      }
      newItems.push({ product: prod, discount: 0 });
      renderEx();
    }
    const doSearch = ui.debounce(async () => {
      const my = ++seq;
      const q = searchInput.value.trim();
      clearResults();
      if (q.length < 2) return;
      const { items } = await api.get('/api/products?search=' + encodeURIComponent(q));
      if (my !== seq) return;
      clearResults();
      lastResults = items.filter(pr => pr.status === 'in_stock' || pr.status === 'reserved');
      const box = document.createElement('div');
      box.className = 'search-results';
      box.innerHTML = lastResults.slice(0, 8).map((pr, i) => `
        <div class="sr-item" data-i="${i}">
          <span>${ui.esc(pr.name)} <span class="sr-sub">${ui.esc(pr.sku)}</span></span>
          <b class="money">${ui.money(pr.retail_price)}</b>
        </div>`).join('') || '<div class="sr-item muted">Нет доступных изделий по запросу</div>';
      box.querySelectorAll('.sr-item[data-i]').forEach(el => {
        el.addEventListener('mousedown', () => {
          addItem(lastResults[Number(el.dataset.i)]);
          searchInput.value = '';
          clearResults();
          searchInput.focus();
        });
      });
      searchWrap.appendChild(box);
    }, 200);
    searchInput.addEventListener('input', doSearch);
    searchInput.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      const { items } = await api.get('/api/products?search=' + encodeURIComponent(q));
      const exact = items.find(pr => pr.barcode === q || pr.sku.toLowerCase() === q.toLowerCase());
      const pick = exact || (lastResults.length === 1 ? lastResults[0] : null);
      if (pick) { addItem(pick); searchInput.value = ''; clearResults(); }
    });
    searchInput.addEventListener('blur', () => setTimeout(clearResults, 150));
    выключитьКамеру = камераВЧеке(m.body.querySelector('#ex-scan'), m.body.querySelector('#ex-camera'), addItem);

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    okBtn.onclick = async () => {
      okBtn.disabled = true;
      try {
        const res = await api.post(`/api/sales/${s.id}/exchange`, {
          return_item_ids: returnIds,
          items: newItems.map(it => ({ product_id: it.product.id, discount: it.discount })),
          payment_method: m.body.querySelector('#ex-payment').value,
          extra_paid: extraPaid,
          due_date: dueInput ? dueInput.value : '',
          note: m.body.querySelector('#ex-note').value.trim(),
        });
        m.close();
        const parts = [];
        if (res.credit_applied > 0) parts.push(`зачтено ${ui.money(res.credit_applied)}`);
        if (res.extra_paid > 0) parts.push(`доплата ${ui.money(res.extra_paid)}`);
        if (res.cash_back > 0) parts.push(`клиенту возвращено ${ui.money(res.cash_back)}`);
        if (res.new_debt > 0) parts.push(`долг ${ui.money(res.new_debt)}`);
        ui.toast(`Обмен оформлен: чек ${res.new.number}${parts.length ? ' · ' + parts.join(', ') : ''}`);
        if (Pages._salesRefresh) Pages._salesRefresh();
        onChange && onChange();
        const printOk = await ui.confirmDialog('Напечатать чек на новые изделия?', { okLabel: 'Печать' });
        if (printOk) printReceipt(res.new);
      } catch (e) {
        ui.toastErr(e);
        okBtn.disabled = false;
      }
    };

    renderEx();
    setTimeout(() => searchInput.focus(), 60);
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
          ${s.scrap ? `<div class="hint-box" style="margin-top:12px">Старое золото в зачёт по акту
            <b>${ui.esc(s.scrap.number)}</b>: ${s.scrap.items.map(r => `${ui.esc(r.description || 'лом')}
            ${r.fineness}, ${ui.num(r.weight, 3)} г`).join('; ')} — <b>${ui.money(s.scrap.amount)}</b></div>` : ''}
          ${s.note ? `<p class="muted">Комментарий: ${ui.esc(s.note)}</p>` : ''}`,
        footer: `
          ${s.scrap ? `<button class="btn" data-act="scrap-act">${ui.icon('print')} Акт приёма золота</button>` : ''}
          ${canReturn ? '<button class="btn btn-danger left" data-act="return" disabled>Оформить возврат</button>' : ''}
          ${canReturn ? `<button class="btn left" data-act="exchange" disabled>${ui.icon('exchange')} Обмен</button>` : ''}
          ${s.debt > 0 ? `<button class="btn btn-primary" data-act="pay">${ui.icon('money')} Принять оплату</button>` : ''}
          ${s.items.some(i => !i.returned) ? `<button class="btn" data-act="passports">${ui.icon('certificate')} Паспорт${
            s.items.filter(i => !i.returned).length > 1 ? 'а' : ''} изделия</button>` : ''}
          <button class="btn" data-act="print">${ui.icon('print')} Печать чека</button>
          <button class="btn" data-act="close">Закрыть</button>`,
      });
      const актЛома = m.foot.querySelector('[data-act=scrap-act]');
      if (актЛома) актЛома.onclick = () => печатьАкта(s.scrap);
      const паспорта = m.foot.querySelector('[data-act=passports]');
      if (паспорта) паспорта.onclick = () => Passport.изЧека(s).catch(ui.toastErr);
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
      const exBtn = m.foot.querySelector('[data-act=exchange]');
      m.body.querySelectorAll('.ret-chk').forEach(chk => chk.addEventListener('change', () => {
        const none = !m.body.querySelector('.ret-chk:checked');
        if (retBtn) retBtn.disabled = none;
        if (exBtn) exBtn.disabled = none;
      }));
      if (exBtn) exBtn.onclick = () => {
        const ids = [...m.body.querySelectorAll('.ret-chk:checked')].map(c => Number(c.value));
        m.close();
        exchangeDialog(s, ids, onChange);
      };
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

  /*
   * ---------- Потолок скидки ----------
   *
   * Касса обязана показать предел ЗАРАНЕЕ. Отказ в момент «Оформить продажу»,
   * когда клиент уже достал деньги, — худший момент из возможных: продавец
   * при клиенте выясняет, что так нельзя, и заново набирает чек.
   *
   * Настоящая проверка всё равно на сервере: здесь мы только не даём набрать
   * заведомо невозможное. Предел спрашиваем при каждом открытии кассы —
   * владелец мог поменять его минуту назад со своего компьютера.
   */
  async function пределИзНастроек() {
    try {
      const s = await api.get('/api/settings');
      const n = Number(s.max_discount_percent);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 15;
    } catch { return 15; }
  }

  // ---------- Новая продажа (POS) ----------
  async function newSale(initialProduct, initialCustomer, initialSet) {
    const [ПРЕДЕЛ, ЛОМ] = await Promise.all([
      App.isAdmin() ? 100 : пределИзНастроек(),
      // Цены грамма старого золота по пробам — оценку продавец видит сразу.
      api.get('/api/scrap/prices').catch(() => ({ price_585: 0, prices: {} })),
    ]);
    const state = {
      items: [],          // {product, discount}
      customer: null,
      payment: 'cash',
      лом: [],            // старое золото в зачёт: {description, fineness, weight, price}
    };

    /*
     * Сколько сом скидки можно поставить на эту позицию.
     *
     * Владелец не ограничен. У продавца потолок поднимает личная скидка
     * клиента — её назначил владелец. Изделия из комплекта не трогаем вовсе:
     * там скидка вытекает из цены комплекта, которую назначил тот же владелец,
     * и сервер сверяет её со своей раскладкой.
     */
    function обычнаяСкидка(it) {
      const личная = state.customer ? Number(state.customer.discount) || 0 : 0;
      return Math.round((Number(it.product.retail_price) || 0) * Math.max(ПРЕДЕЛ, личная)) / 100;
    }
    function максСкидка(it) {
      if (App.isAdmin() || it.setId) return Number(it.product.retail_price) || 0;
      // Разрешение владельца на этот чек поднимает потолок — ровно до разрешённого.
      const разрешено = state.разрешение ? state.разрешение.скидки.get(it.product.id) : undefined;
      return разрешено !== undefined ? Math.max(обычнаяСкидка(it), разрешено) : обычнаяСкидка(it);
    }
    const пределЧека = () => Math.max(ПРЕДЕЛ,
      state.customer ? Number(state.customer.discount) || 0 : 0);

    let выключитьКамеру = null;
    let опрос = null;   // ждём ответа владельца на запрос скидки
    const m = ui.modal({
      title: 'Новая продажа',
      size: 'lg',
      onClose: () => {
        if (выключитьКамеру) выключитьКамеру();
        if (опрос) clearInterval(опрос);
        // Касса закрыта — запрос владельцу больше не нужен: пусть не отвечает впустую.
        if (state.запрос && state.запрос.status === 'pending') api.del('/api/discount-requests/' + state.запрос.id).catch(() => {});
      },
      // Набранный чек — список изделий, а не поля: поиск после каждого
      // изделия снова пуст, и без этой проверки окно считалось бы пустым.
      грязно: () => state.items.length > 0 || ui.естьВведённое(m.body),
      body: `
        <div class="row" style="margin-bottom:14px;flex-wrap:nowrap">
          <div class="rel grow">
            <input type="text" class="input" id="pos-search" placeholder="Изделие: название, артикул или сканируйте штрихкод…" autocomplete="off">
          </div>
          <button type="button" class="btn" id="pos-scan" title="Камера: читает бирки сама">${ui.icon('camera')}</button>
        </div>
        <div id="pos-camera" class="hidden" style="margin-bottom:14px"></div>
        <div class="pos-items" id="pos-items"></div>
        <div class="row" style="gap:8px;align-items:flex-start;flex-wrap:wrap;margin:-4px 0 12px">
          <button type="button" class="btn btn-sm" id="pos-scrap-add">${ui.icon('exchange')} Старое золото в зачёт</button>
          <div id="pos-scrap" class="grow" style="min-width:200px"></div>
        </div>
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
        <div class="form-grid">
          <label class="field"><span>Скидка на чек, %</span>
            <input type="number" id="pos-disc-pct" min="0" max="100" step="0.5" placeholder="0">
            <span class="form-hint" id="pos-disc-hint"></span></label>
          <label class="field"><span>Комментарий</span><input type="text" id="pos-note"></label>
        </div>
        <div id="pos-approval" class="hidden" style="margin:-4px 0 12px"></div>

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
      const total = Math.round(Math.max(0, subtotal - discount) * 100) / 100;
      // Старое золото в зачёт: оценка — вес × цена грамма, как посчитает сервер.
      const лом = state.лом.reduce((s2, r) => s2 + Math.round(r.weight * r.price), 0);
      return { subtotal, discount, total, лом, зачёт: Math.min(лом, total) };
    }

    const граммы = w => ui.num(w, 3) + ' г';
    function показатьЛом() {
      const box = m.body.querySelector('#pos-scrap');
      box.innerHTML = state.лом.map((r, i) => `
        <div class="row" style="justify-content:space-between;gap:8px;padding:4px 0;font-size:13.5px">
          <span>${ui.esc(r.description || 'Лом')} · ${r.fineness} · ${граммы(r.weight)} × ${ui.money(r.price)}
            = <b>${ui.money(Math.round(r.weight * r.price))}</b></span>
          <button type="button" class="btn btn-sm btn-danger" data-scrap-del="${i}" title="Убрать">×</button>
        </div>`).join('');
    }

    function renderItems() {
      // Предел мог измениться после того, как скидку уже поставили: выбрали
      // клиента с личной скидкой, а потом убрали его. Подрезаем каждый раз,
      // чтобы на экране не осталось суммы, которую сервер не примет.
      for (const it of state.items) it.discount = Math.min(it.discount, максСкидка(it));

      if (!state.items.length) {
        itemsEl.innerHTML = '<div class="empty" style="padding:22px"><p>Добавьте изделия через поиск выше</p></div>';
      } else {
        itemsEl.innerHTML = state.items.map((it, i) => {
          const макс = максСкидка(it);
          const упёрся = !App.isAdmin() && !it.setId && it.discount >= макс - 0.009 && макс > 0;
          const поРазрешению = !App.isAdmin() && !it.setId && it.discount > обычнаяСкидка(it) + 0.009;
          // Продажа ниже закупочной — забота владельца: продавец закупочную
          // не видит, и говорить ему о ней здесь нельзя. Поле приходит только
          // в ответах администратору, поэтому строка сама собой не покажется.
          const убыток = it.product.purchase_price !== undefined
            && it.product.retail_price - it.discount < it.product.purchase_price;
          return `
          <div class="pos-item">
            <div>
              <div class="pi-name">${ui.esc(it.product.name)}</div>
              <div class="pi-sub">${ui.esc(it.product.sku)}${it.product.metal ? ' · ' + ui.esc(it.product.metal) : ''}${it.product.status === 'reserved' ? ' · <b>из резерва</b>' : ''}${
                убыток ? ' · <b class="crit">ниже закупочной</b>' : ''}${
                поРазрешению ? ' · <span class="good">по разрешению владельца</span>'
                  : упёрся ? ' · <span class="warn">предел скидки</span>' : ''}</div>
            </div>
            <div class="num money">${ui.money(it.product.retail_price)}</div>
            <input type="number" class="input" data-i="${i}" min="0" max="${макс}" step="1" value="${it.discount || ''}" placeholder="скидка">
            <button class="btn btn-sm btn-danger" data-del="${i}">×</button>
          </div>`;
        }).join('');
      }
      const подсказка = m.body.querySelector('#pos-disc-hint');
      if (подсказка) {
        подсказка.innerHTML = App.isAdmin()
          ? ''
          : `Больше ${пределЧека()}% проводит владелец — или разрешает вам на этот чек.
             <button type="button" class="btn btn-sm" data-act="ask-owner" style="margin-top:4px">Попросить владельца</button>`;
      }
      discPctInput.max = App.isAdmin() ? 100 : пределЧека();
      const { subtotal, discount, total, лом, зачёт } = calc();
      // Долг: сколько остаётся за клиентом после того, что он платит сейчас.
      // Зачёт старым золотом — тоже оплата; «вносит сейчас» — живые деньги.
      const деньгами = Math.round((total - зачёт) * 100) / 100;
      const partial = partialCb.checked;
      paidInput.max = деньгами;
      const paid = partial ? Math.min(Math.max(Number(paidInput.value) || 0, 0), деньгами) : деньгами;
      const debt = Math.round((деньгами - paid) * 100) / 100;
      const ломДороже = лом > total + 0.009;

      summaryEl.innerHTML = `
        <div class="pos-total"><span>Сумма</span><span class="money">${ui.money(subtotal)}</span></div>
        ${discount ? `<div class="pos-total"><span>Скидка</span><span class="money">−${ui.money(discount)}</span></div>` : ''}
        ${лом ? `<div class="pos-total"><span>Старое золото в зачёт</span><span class="money">−${ui.money(зачёт)}</span></div>` : ''}
        <div class="pos-total grand"><span>${лом ? 'К доплате' : 'К оплате'}</span><span class="money">${ui.money(деньгами)}</span></div>
        ${ломДороже ? `<div class="hint-box" style="background:var(--crit-soft);border-color:var(--crit)">Золото оценено в
          ${ui.money(лом)} — это больше покупки на ${ui.money(лом - total)}. Разницу деньгами система не выдаёт:
          добавьте изделие или примите меньше.</div>` : ''}
        ${debt > 0 ? `
          <div class="pos-total"><span>Вносит сейчас</span><span class="money good">${ui.money(paid)}</span></div>
          <div class="pos-total"><span><b>Останется долг</b></span>
            <span class="money crit" style="font-weight:700">${ui.money(debt)}</span></div>` : ''}`;

      // Долг всегда числится за конкретным человеком — иначе спросить будет не с кого.
      // Старое золото — тоже: имя клиента стоит в акте приёма.
      const needCustomer = (debt > 0 || state.лом.length > 0) && !state.customer;
      submitBtn.disabled = !state.items.length || needCustomer || ломДороже;
      submitBtn.textContent = debt > 0 ? 'Оформить с долгом' : 'Оформить продажу';
      if (needCustomer) {
        m.body.querySelector('#pos-cust-info').innerHTML = state.лом.length && !(debt > 0)
          ? '<span class="crit">Для приёма старого золота выберите клиента — его имя будет в акте</span>'
          : '<span class="crit">Для продажи в долг выберите клиента</span>';
      }
      state.paid = paid;
    }

    itemsEl.addEventListener('input', e => {
      const i = e.target.dataset.i;
      if (i === undefined) return;
      const it = state.items[Number(i)];
      const набрано = Math.max(Number(e.target.value) || 0, 0);
      const макс = максСкидка(it);
      // Сколько хотели — запомним: в запросе владельцу это и будет предложено.
      it.хочет = набрано > макс + 0.009 ? набрано : undefined;
      if (набрано > макс + 0.009 && !App.isAdmin()) {
        ui.toast(`Скидка больше ${пределЧека()}% — нажмите «Попросить владельца»`, true);
      }
      it.discount = Math.min(набрано, макс);
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
      const потолок = App.isAdmin() ? 100 : пределЧека();
      const набрано = Math.max(Number(discPctInput.value) || 0, 0);
      const pct = Math.min(набрано, потолок);
      if (набрано > потолок) {
        discPctInput.value = pct;
        ui.toast(`Скидка на чек больше ${потолок}% — нажмите «Попросить владельца»`, true);
      }
      for (const it of state.items) {
        if (!it.setId) it.хочет = набрано > потолок ? Math.round(it.product.retail_price * набрано) / 100 : undefined;
      }
      for (const it of state.items) {
        // Комплект пришёл со своей раскладкой от владельца — процент на чек
        // её не перебивает: иначе цена комплекта развалилась бы по копейкам.
        if (it.setId) continue;
        it.discount = Math.round(it.product.retail_price * pct) / 100;
      }
      renderItems();
    }
    discPctInput.addEventListener('input', ui.debounce(applyPctDiscount, 350));
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
      /*
       * Отложенное изделие продаётся только тому, за кем отложено. Раньше
       * касса молча пускала его в чек, а при оплате сервер отвечал «в резерве
       * за другим клиентом» — хотя клиента никто и не выбирал. Теперь клиент
       * подставляется сам, откуда бы изделие ни пришло: из карточки, поиска
       * или с камеры. Если в чеке уже другой клиент — говорим сразу.
       */
      if (p.status === 'reserved' && p.reserved_for) {
        if (state.customer && state.customer.id !== p.reserved_for) {
          ui.toast(`«${p.name}» отложено за ${p.reserved_for_name || 'другим клиентом'} — продать можно только ему`, true);
          return;
        }
        if (!state.customer) подставитьКлиентаРезерва(p.reserved_for);
      }
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
    выключитьКамеру = камераВЧеке(m.body.querySelector('#pos-scan'), m.body.querySelector('#pos-camera'), addProduct);

    // Выбор клиента
    const custInput = m.body.querySelector('#pos-customer');
    const custInfo = m.body.querySelector('#pos-cust-info');
    // Клиент отложенного изделия — с личной скидкой и телефоном, как при
    // обычном выборе из поиска. Пока ответ идёт, человек мог выбрать кого-то
    // сам — тогда его выбор не трогаем.
    async function подставитьКлиентаРезерва(id) {
      try {
        const c = await api.get('/api/customers/' + id);
        if (state.customer) return;
        setCustomer({ id: c.id, name: c.name, phone: c.phone, discount: c.discount });
        ui.toast(`Изделие отложено за ${c.name} — клиент подставлен`);
      } catch { /* не вышло — сервер всё равно не даст продать чужой резерв */ }
    }

    function setCustomer(c) {
      state.customer = c;
      if (c) {
        custInput.value = c.name;
        custInfo.innerHTML = c.discount ? `Личная скидка ${c.discount}% применена` : 'Клиент выбран';
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

    /*
     * ---------- Старое золото в зачёт ----------
     *
     * Взвесили, выбрали пробу — касса сразу показывает оценку: вес × цена
     * грамма этой пробы из Настроек. Продавец цену не меняет; владелец может
     * (например, за сплав с припоем). Сумма идёт в зачёт покупки.
     */
    function добавитьЛом() {
      if (!ЛОМ.price_585) { ui.toast('Цена грамма лома не задана — её задаёт владелец в Настройках', true); return; }
      const пробы = Object.keys(ЛОМ.prices).map(Number).sort((a, b) => a - b);
      const d = ui.modal({
        title: 'Старое золото в зачёт',
        size: 'sm',
        body: `<form id="scrap-form">
          <label class="field"><span>Что принесли</span>
            <input name="description" maxlength="100" placeholder="Например: кольцо, серьги"></label>
          <div class="form-grid">
            <label class="field"><span>Проба</span>
              <select name="fineness">${пробы.map(п => `<option value="${п}" ${п === 585 ? 'selected' : ''}>${п}</option>`).join('')}</select></label>
            <label class="field"><span>Вес без камней, г</span>
              <input name="weight" inputmode="decimal" autocomplete="off" placeholder="Например: 4,52" required></label>
          </div>
          ${App.isAdmin() ? `<label class="field"><span>Цена грамма, сом</span>
            <input name="price" inputmode="decimal" autocomplete="off"></label>` : ''}
          <div class="hint-box" id="scrap-sum" style="margin:0"></div>
        </form>`,
        footer: `<button class="btn" data-act="cancel">Отмена</button>
          <button class="btn btn-primary" data-act="ok">Добавить в зачёт</button>`,
      });
      const f = d.body.querySelector('#scrap-form');
      const поле = n => f.querySelector(`[name=${n}]`);
      const число = v => Number(String(v || '').trim().replace(',', '.'));
      const цена = () => {
        const своя = поле('price') ? число(поле('price').value) : 0;
        return своя > 0 ? своя : ЛОМ.prices[поле('fineness').value];
      };
      const пересчитать = () => {
        if (поле('price')) поле('price').placeholder = String(ЛОМ.prices[поле('fineness').value]);
        const вес = число(поле('weight').value);
        d.body.querySelector('#scrap-sum').innerHTML = вес > 0
          ? `${граммы(вес)} × ${ui.money(цена())} = <b>${ui.money(Math.round(вес * цена()))}</b>`
          : `Цена грамма ${поле('fineness').value}-й пробы: <b>${ui.money(цена())}</b>`;
      };
      f.addEventListener('input', пересчитать);
      f.addEventListener('change', пересчитать);
      пересчитать();
      setTimeout(() => поле('weight').focus(), 60);
      d.foot.querySelector('[data-act=cancel]').onclick = d.close;
      d.foot.querySelector('[data-act=ok]').onclick = () => {
        const вес = Math.round(число(поле('weight').value) * 1000) / 1000;
        if (!(вес > 0) || вес > 1000) { ui.toast('Введите вес в граммах, например 4,52', true); поле('weight').focus(); return; }
        const своя = поле('price') ? число(поле('price').value) : 0;
        state.лом.push({
          description: поле('description').value.trim(),
          fineness: Number(поле('fineness').value),
          weight: вес,
          price: цена(),
          своя: своя > 0,
        });
        d.close();
        показатьЛом();
        renderItems();
      };
    }
    m.body.querySelector('#pos-scrap-add').onclick = добавитьЛом;
    m.body.querySelector('#pos-scrap').addEventListener('click', e => {
      const b = e.target.closest('[data-scrap-del]');
      if (!b) return;
      state.лом.splice(Number(b.dataset.scrapDel), 1);
      показатьЛом();
      renderItems();
    });

    /*
     * ---------- Скидка по разрешению владельца ----------
     *
     * Продавец просит прямо отсюда: какие изделия и какую скидку. Владелец
     * видит запрос у себя на Главной. Касса тем временем работает дальше,
     * а ответ приходит сам: разрешили — скидка встаёт в чек, отказали —
     * так и написано. Разрешение — на этот чек и только на эти изделия.
     */
    function показатьЗапрос() {
      const box = m.body.querySelector('#pos-approval');
      const з = state.запрос;
      box.classList.toggle('hidden', !з);
      if (!з) { box.innerHTML = ''; return; }
      box.innerHTML = з.status === 'pending'
        ? `<div class="hint-box" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
             <span>Запрос скидки отправлен владельцу — ждём ответа…</span>
             <button type="button" class="btn btn-sm" data-act="dr-cancel">Отменить запрос</button></div>`
        : з.status === 'approved'
          ? `<div class="hint-box" style="background:var(--good-soft);border-color:var(--good)">✓ Скидка разрешена${
              з.decided_by_name ? ': ' + ui.esc(з.decided_by_name) : ''}. Действует на этот чек.</div>`
          : з.status === 'denied'
            ? `<div class="hint-box" style="background:var(--crit-soft);border-color:var(--crit)">Скидку сверх ${пределЧека()}%
                не разрешили${з.decided_by_name ? ' (' + ui.esc(з.decided_by_name) + ')' : ''}.</div>`
            : '';
      const отмена = box.querySelector('[data-act=dr-cancel]');
      if (отмена) отмена.onclick = async () => {
        clearInterval(опрос); опрос = null;
        await api.del('/api/discount-requests/' + з.id).catch(() => {});
        state.запрос = null;
        показатьЗапрос();
      };
    }

    function ждатьОтвета() {
      if (опрос) clearInterval(опрос);
      опрос = setInterval(async () => {
        let з;
        try { з = await api.get('/api/discount-requests/' + state.запрос.id); } catch { return; }
        if (з.status === 'pending') return;
        clearInterval(опрос); опрос = null;
        state.запрос = з;
        if (з.status === 'approved') {
          state.разрешение = { id: з.id, скидки: new Map(з.items.map(i => [i.product_id, i.discount])) };
          for (const it of state.items) {
            if (state.разрешение.скидки.has(it.product.id)) { it.discount = state.разрешение.скидки.get(it.product.id); it.хочет = undefined; }
          }
          ui.toast('Владелец разрешил скидку — она уже в чеке');
          renderItems();
        } else if (з.status === 'denied') {
          ui.toast('Скидку сверх предела не разрешили', true);
        }
        показатьЗапрос();
      }, 2500);
    }

    function попроситьВладельца() {
      const позиции = state.items.filter(it => !it.setId);
      if (!позиции.length) { ui.toast('Сначала добавьте изделия в чек', true); return; }
      const d = ui.modal({
        title: 'Попросить скидку у владельца',
        size: 'sm',
        body: `<p class="muted" style="margin:0 0 8px;font-size:13.5px">Владелец увидит запрос у себя на Главной
            и ответит. Разрешение — только на этот чек.</p>
          ${позиции.map((it, k) => `
            <div class="row" style="gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
              <div class="grow" style="min-width:0">
                <div style="font-weight:600">${ui.esc(it.product.name)}</div>
                <div class="muted" style="font-size:12.5px">${ui.money(it.product.retail_price)}
                  · <span data-pct="${k}"></span></div>
              </div>
              <input class="input" type="number" min="0" step="1" data-k="${k}" style="width:120px"
                value="${Math.round(it.хочет !== undefined ? it.хочет : it.discount) || ''}" placeholder="скидка, сом">
            </div>`).join('')}
          <label class="field" style="margin-top:12px"><span>Почему (владелец это увидит)</span>
            <input id="dr-note" maxlength="300" placeholder="Например: постоянная клиентка, берёт гарнитур"></label>`,
        footer: `<button class="btn" data-act="cancel">Отмена</button>
          <button class="btn btn-primary" data-act="send">Отправить владельцу</button>`,
      });
      const поля = [...d.body.querySelectorAll('[data-k]')];
      const проценты = () => поля.forEach(поле => {
        const it = позиции[Number(поле.dataset.k)];
        const pct = it.product.retail_price > 0 ? (Number(поле.value) || 0) * 100 / it.product.retail_price : 0;
        d.body.querySelector(`[data-pct="${поле.dataset.k}"]`).textContent = `${ui.num(pct, 1)}%`;
      });
      поля.forEach(поле => поле.addEventListener('input', проценты));
      проценты();
      d.foot.querySelector('[data-act=cancel]').onclick = d.close;
      d.foot.querySelector('[data-act=send]').onclick = async () => {
        const items = поля.map(поле => ({ product_id: позиции[Number(поле.dataset.k)].product.id,
          discount: Math.max(Number(поле.value) || 0, 0) }));
        try {
          state.запрос = await api.post('/api/discount-requests', {
            items, customer_id: state.customer ? state.customer.id : null,
            note: d.body.querySelector('#dr-note').value.trim(),
          });
          state.разрешение = null;
          d.close();
          показатьЗапрос();
          ждатьОтвета();
        } catch (e) { ui.toastErr(e); }
      };
    }
    m.body.addEventListener('click', e => {
      if (e.target.closest('[data-act=ask-owner]')) { e.preventDefault(); попроситьВладельца(); }
    });

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    submitBtn.onclick = async () => {
      const { total } = calc();
      const payload = {
        customer_id: state.customer ? state.customer.id : null,
        items: state.items.map(it => ({
          product_id: it.product.id, discount: it.discount, set_id: it.setId || null,
        })),
        payment_method: m.body.querySelector('#pos-payment').value,
        note: m.body.querySelector('#pos-note').value.trim(),
        ...(state.разрешение ? { discount_request_id: state.разрешение.id } : {}),
        // Цену грамма сервер считает сам; свою передаём, только если её поставил владелец.
        ...(state.лом.length ? { scrap: state.лом.map(r => ({
          description: r.description, fineness: r.fineness, weight: r.weight, ...(r.своя ? { price: r.price } : {}),
        })) } : {}),
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
          : `Продажа ${sale.number} на ${ui.money(sale.total)} оформлена`);
        if (Pages._salesRefresh) Pages._salesRefresh();
        if (location.hash.includes('dashboard') || location.hash === '' || location.hash === '#/') {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        // Со старым золотом клиенту нужен ещё и акт приёма — с весом и подписями.
        if (sale.scrap) печатьПослеЗачёта(sale);
        else {
          const printOk = await ui.confirmDialog('Напечатать чек?', { okLabel: 'Печать' });
          if (printOk) printReceipt(sale);
        }
      } catch (e) {
        ui.toastErr(e);
        submitBtn.disabled = false;
      }
    };

    renderItems();
    // Клиент — раньше изделий: отложенное за ним изделие тогда сразу ложится
    // в чек, а его личная скидка применяется ко всему, что добавится.
    if (initialCustomer) setCustomer(initialCustomer);
    // Одно изделие или несколько — «Продать отложенное» из карточки клиента.
    for (const p of [].concat(initialProduct || [])) addProduct(p);
    /*
     * Комплект приходит в кассу уже разложенным: сервер посчитал, какая часть
     * скидки приходится на каждое изделие, чтобы сумма чека совпала с ценой
     * комплекта до копейки. Здесь эту раскладку не пересчитываем.
     */
    if (initialSet) {
      for (const it of initialSet.items) {
        if (it.status !== 'in_stock' && it.status !== 'reserved') continue;
        if (state.items.some(x => x.product.id === it.id)) continue;
        state.items.push({
          product: { ...it, retail_price: it.retail_price },
          discount: it.sale_discount || 0,
          setId: initialSet.id,
        });
      }
      renderItems();
      ui.toast(`Комплект «${initialSet.name}» добавлен в чек`);
    }
    setTimeout(() => searchInput.focus(), 60);
  }

  return {
    title: 'Продажи',
    newSale,
    openDetail,
    печатьАкта,
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
      App.обновлятьТак(el, () => refresh(el));
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
