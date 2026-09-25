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

  const граммы = w => (Number(w) > 0 ? ui.num(w, 3) + ' г' : '');
  const остаток = o => Math.max(0, (o.final_price || o.estimate) - o.paid);
  const открыт = o => o.status === 'accepted' || o.status === 'in_progress';

  // ---------- Тексты для клиента ----------

  function текстГотов(o) {
    const к = остаток(o);
    // Без имени: в базе оно бывает записано с фамилией и отчеством, а
    // «Здравствуйте, Соколов Бакыт Владимирович!» звучит как повестка.
    return `Здравствуйте! Ваш заказ ${o.number}` +
      `${o.item ? ' (' + o.item + ')' : ''} готов — ждём вас в ${App.storeName || 'магазине'}.` +
      `${к > 0 ? ' К оплате: ' + ui.money(к) + '.' : ''} Возьмите, пожалуйста, квитанцию.`;
  }

  // Что записано при приёме — одинаково для печати и для WhatsApp.
  function строкиКвитанции(o) {
    return [
      ['Клиент', o.customer_name], ['Телефон', o.customer_phone],
      ['Вид работ', ui.L.orderType[o.type] || o.type],
      ['Изделие', o.item], ['Вес при приёме', граммы(o.weight)],
      ['Камни', o.stones], ['Состояние', o.defects],
      ['Что сделать', o.description],
      ['Стоимость (оценка)', o.estimate ? ui.money(o.estimate) : ''],
      ['Оплачено', o.paid ? ui.money(o.paid) : ''],
      ['Срок', o.due_date ? ui.dateOnly(o.due_date) : ''],
    ].filter(([, v]) => v);
  }

  const ОГОВОРКА = 'Вес, камни и состояние изделия проверены при клиенте. ' +
    'Камни приняты без проверки подлинности. Изделие выдаётся по этой квитанции.';

  /*
   * Квитанция — два экземпляра на одном листе с линией отреза: клиенту
   * и магазину. На экземпляре магазина клиент расписывается, что сдал
   * изделие именно таким: с этим весом, этими камнями и этими дефектами.
   */
  function печатьКвитанции(o) {
    const root = document.getElementById('print-root');
    const экземпляр = кому => `<div class="receipt">
      <h2>${ui.esc(App.storeName)}</h2>
      <div class="r-center"><b>Квитанция № ${ui.esc(o.number)}</b></div>
      <div class="r-center">о приёме изделия · ${ui.dt(o.accepted_at)}</div>
      <div class="r-line"></div>
      ${строкиКвитанции(o).map(([k, v]) => `<div class="r-kv"><b>${k}:</b> ${ui.esc(v)}</div>`).join('')}
      <div class="r-line"></div>
      <div class="r-small">${ОГОВОРКА}</div>
      <div class="r-sign">Сдал (клиент): ________________</div>
      <div class="r-sign">Принял: ${ui.esc(o.user_name || '')} ____________</div>
      <div class="r-center r-small">${кому}</div>
    </div>`;
    root.innerHTML = экземпляр('Экземпляр клиента') +
      '<div class="r-cut">✂ - - - - - - - - - - - - - - - - - -</div>' + экземпляр('Экземпляр магазина');
    window.print();
  }

  // Та же квитанция сообщением: принтера в магазине может и не быть.
  function текстКвитанции(o) {
    return [`${App.storeName}. Квитанция № ${o.number} от ${ui.dateOnly(o.accepted_at)}`,
      ...строкиКвитанции(o).filter(([k]) => k !== 'Телефон').map(([k, v]) => `${k}: ${v}`),
      '', ОГОВОРКА, 'Сохраните это сообщение.'].join('\n');
  }

  // ---------- Список ----------

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
            <div class="kc-num">${ui.esc(o.number)} · ${ui.L.orderType[o.type] || o.type}${o.photo_count ? ` · ${o.photo_count} фото` : ''}</div>
            <div class="kc-desc">${o.item ? `<b>${ui.esc(o.item)}${o.weight ? ', ' + граммы(o.weight) : ''}</b> — ` : ''}${ui.esc(o.description.slice(0, 90))}${o.description.length > 90 ? '…' : ''}</div>
            <div class="kc-foot">
              <span>${ui.esc(o.customer_name || 'Без клиента')}</span>
              <b class="money">${ui.money(o.final_price || o.estimate)}</b>
            </div>
            ${o.due_date && o.status !== 'delivered' ? `<div class="kc-foot" style="margin-top:4px"><span class="${overdue(o.due_date) ? 'badge badge-crit' : 'muted'}">срок: ${ui.dateOnly(o.due_date)}</span></div>` : ''}
            ${быстрыеКнопки(o)}
          </div>`).join('') || '<div class="muted" style="padding:8px 4px;font-size:12.5px">Пусто</div>'}
      </div>`;
    }).join('');
    const заказ = id => items.find(o => o.id === Number(id));
    kanbanEl.querySelectorAll('.kanban-card').forEach(card => {
      card.addEventListener('click', () => openDetail(Number(card.dataset.id), () => refresh(el)));
    });
    // Кнопки на карточке — сами по себе, карточку не открывают.
    kanbanEl.querySelectorAll('[data-ready]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      отметитьГотов(заказ(b.dataset.ready), () => refresh(el));
    }));
    kanbanEl.querySelectorAll('[data-notify]').forEach(a => a.addEventListener('click', e => {
      e.stopPropagation();
      отметитьНаписали(заказ(a.dataset.notify), () => refresh(el));
    }));
    const cancelled = items.filter(o => o.status === 'cancelled');
    el.querySelector('#orders-cancelled').innerHTML = cancelled.length
      ? `<p class="muted">Отменённых заказов: ${cancelled.length}</p>` : '';
  }

  /*
   * «Готов» — одним нажатием прямо на карточке, из «Принят» или «В работе»:
   * мастер отдал изделие, открывать заказ ради этого незачем. У готового —
   * «Написать»: клиент узнаёт, что можно забирать; кому написали, видно всем.
   */
  function быстрыеКнопки(o) {
    if (открыт(o)) {
      return `<div class="kc-actions"><button class="btn btn-sm" data-ready="${o.id}">${ui.icon('check')} Готов</button></div>`;
    }
    if (o.status !== 'ready' || !o.customer_phone) return '';
    if (o.notified_at) {
      return `<div class="kc-actions"><span class="muted" style="font-size:12px">${ui.icon('check')} клиенту написали</span></div>`;
    }
    const wa = ui.whatsappLink(o.customer_phone, текстГотов(o));
    return wa ? `<div class="kc-actions"><a class="btn btn-sm" data-notify="${o.id}" href="${ui.esc(wa)}"
      target="_blank" rel="noopener">${ui.icon('whatsapp')} Написать: готово</a></div>` : '';
  }

  function isRecent(iso) {
    return iso && (Date.now() - new Date(iso).getTime()) < 14 * 86400000;
  }
  function overdue(d) {
    return d && d < new Date().toISOString().slice(0, 10);
  }

  // ---------- «Готов» и «написали» ----------

  async function отметитьГотов(o, onChange) {
    try {
      const свежий = await api.post(`/api/orders/${o.id}/status`, { status: 'ready' });
      ui.toast(`Заказ ${o.number} готов`);
      onChange && onChange();
      предложитьНаписать(свежий, onChange);
    } catch (e) { ui.toastErr(e); }
  }

  function отметитьНаписали(o, onChange) {
    // Ссылка открывается сама; отметку ставим параллельно.
    api.post(`/api/orders/${o.id}/notified`, {}).then(() => onChange && onChange()).catch(() => {});
  }

  function предложитьНаписать(o, onChange) {
    const ссылка = o.customer_phone ? ui.whatsappLink(o.customer_phone, текстГотов(o)) : '';
    if (!ссылка) return;
    const m = ui.modal({
      title: 'Написать клиенту, что готово?',
      size: 'sm',
      body: `<p style="margin:4px 0 8px">${ui.esc(o.customer_name || 'Клиент')} узнает, что заказ можно забирать.</p>
        <p class="muted" style="font-size:13px;white-space:pre-wrap;margin:0">${ui.esc(текстГотов(o))}</p>`,
      footer: `<button class="btn" data-act="later">Не сейчас</button>
        <a class="btn btn-primary" data-act="wa" href="${ui.esc(ссылка)}" target="_blank" rel="noopener">${ui.icon('whatsapp')} Написать в WhatsApp</a>`,
    });
    m.foot.querySelector('[data-act=later]').onclick = m.close;
    m.foot.querySelector('[data-act=wa]').addEventListener('click', () => {
      отметитьНаписали(o, onChange);
      m.close();
    });
  }

  // ---------- Карточка заказа ----------

  function openDetail(id, onChange) {
    api.get('/api/orders/' + id).then(o => {
      const rest = остаток(o);
      const приём = [['Изделие', o.item], ['Вес при приёме', граммы(o.weight)], ['Камни', o.stones], ['Состояние', o.defects]]
        .filter(([, v]) => v);
      const waГотов = o.status === 'ready' && o.customer_phone ? ui.whatsappLink(o.customer_phone, текстГотов(o)) : '';
      const waКвитанция = o.customer_phone ? ui.whatsappLink(o.customer_phone, текстКвитанции(o)) : '';
      const админ = App.isAdmin();
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
              ${o.ready_at ? `<dt>Готов</dt><dd>${ui.dt(o.ready_at)}</dd>` : ''}
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
          ${o.status === 'ready' && o.customer_phone ? `<div class="hint-box" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <span>${o.notified_at ? `Клиенту написали ${ui.dt(o.notified_at)}` : '<b>Клиент ещё не знает, что заказ готов</b>'}</span>
              ${waГотов ? `<a class="btn btn-sm ${o.notified_at ? '' : 'btn-primary'}" data-act="notify" href="${ui.esc(waГотов)}" target="_blank" rel="noopener">${ui.icon('whatsapp')} ${o.notified_at ? 'Написать ещё раз' : 'Написать: готово'}</a>` : ''}
            </div>` : ''}
          ${приём.length ? `<dl class="kv" style="margin-top:4px">${приём.map(([k, v]) => `<dt>${k}</dt><dd>${ui.esc(v)}</dd>`).join('')}</dl>` : ''}
          <p style="background:var(--surface-2);border-radius:8px;padding:10px 14px">${ui.esc(o.description)}</p>
          ${o.note ? `<p class="muted">${ui.esc(o.note)}</p>` : ''}
          <h4 style="margin:12px 0 6px">Фото при приёме</h4>
          <div class="order-photos" id="ord-photos">
            ${o.images.map((im, i) => `<span class="order-photo">
              <button type="button" data-ph="${i}" title="Открыть"><img src="${ui.esc(ui.photoUrl(im.thumb))}" alt="Фото ${i + 1}"></button>
              ${админ ? `<button type="button" class="order-photo-del" data-del-photo="${im.id}" title="Удалить фото">×</button>` : ''}</span>`).join('')}
            ${o.status !== 'cancelled' ? `<button type="button" class="btn btn-sm" data-act="add-photo">${ui.icon('camera')} Добавить фото</button>` : ''}
            ${!o.images.length && o.status === 'cancelled' ? '<span class="muted">Фото нет</span>' : ''}
          </div>
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
            <span class="muted" style="font-size:13px">Квитанция:</span>
            <button type="button" class="btn btn-sm" data-act="print">${ui.icon('print')} Печать</button>
            ${waКвитанция ? `<a class="btn btn-sm" href="${ui.esc(waКвитанция)}" target="_blank" rel="noopener">${ui.icon('whatsapp')} В WhatsApp клиенту</a>` : ''}
          </div>
          ${o.payments.length ? `<h4 style="margin:12px 0 6px">Оплаты</h4>${o.payments.map(p =>
            `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)">
              <span class="dim">${ui.dt(p.created_at)}</span><b>${ui.money(p.amount)}</b></div>`).join('')}` : ''}`,
        footer: `
          ${o.status !== 'delivered' && o.status !== 'cancelled' ? `
            <button class="btn btn-danger left" data-act="cancel-order">Отменить заказ</button>
            <button class="btn" data-act="edit">Редактировать</button>
            <button class="btn" data-act="pay">+ Оплата</button>` : ''}
          ${статусныеКнопки(o)}
          <button class="btn" data-act="close">Закрыть</button>`,
      });
      const заново = () => { m.close(); openDetail(id, onChange); onChange && onChange(); };

      m.body.querySelectorAll('[data-ph]').forEach(b => b.addEventListener('click', () =>
        ui.lightbox(o.images.map(im => ui.photoUrl(im.file)), Number(b.dataset.ph))));
      m.body.querySelectorAll('[data-del-photo]').forEach(b => b.addEventListener('click', async () => {
        if (!await ui.confirmDialog('Удалить это фото? Оно — подтверждение того, в каком виде изделие принесли.',
          { danger: true, okLabel: 'Удалить' })) return;
        try { await api.del(`/api/orders/${o.id}/images/${b.dataset.delPhoto}`); заново(); }
        catch (e) { ui.toastErr(e); }
      }));
      const добавить = m.body.querySelector('[data-act=add-photo]');
      if (добавить) добавить.onclick = async () => {
        const files = (await Photos.pickFiles({ camera: true })).filter(Photos.isImage);
        if (!files.length) return;
        добавить.disabled = true;
        try {
          for (const f of files) await api.post(`/api/orders/${o.id}/images`, await Photos.prepare(f));
          ui.toast(files.length > 1 ? 'Фото добавлены' : 'Фото добавлено');
        } catch (e) { ui.toastErr(e); }
        заново();
      };
      m.body.querySelector('[data-act=print]').onclick = () => печатьКвитанции(o);
      const написать = m.body.querySelector('[data-act=notify]');
      if (написать) написать.addEventListener('click', () => { отметитьНаписали(o, onChange); m.close(); });

      m.foot.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        const act = btn && btn.dataset.act;
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
          if (act === 'ready') { m.close(); await отметитьГотов(o, onChange); }
          if (act === 'next-status') {
            const next = btn.dataset.next;
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

  /*
   * «Готов» — из любого незакрытого статуса. Промежуточное «В работу»
   * остаётся для тех, кто им пользуется, но не стоит на пути. Готовый,
   * отмеченный по ошибке, возвращается в работу.
   */
  function статусныеКнопки(o) {
    const кнопка = (next, label, primary) =>
      `<button class="btn ${primary ? 'btn-primary' : ''}" data-act="next-status" data-next="${next}">${label}</button>`;
    if (o.status === 'accepted') {
      return кнопка('in_progress', 'В работу →') +
        `<button class="btn btn-primary" data-act="ready">${ui.icon('check')} Готов</button>`;
    }
    if (o.status === 'in_progress') return `<button class="btn btn-primary" data-act="ready">${ui.icon('check')} Готов</button>`;
    if (o.status === 'ready') return кнопка('in_progress', '← Вернуть в работу') + кнопка('delivered', 'Выдать клиенту ✓', true);
    return '';
  }

  function deliverDialog(o, onChange) {
    const m = ui.modal({
      title: 'Выдача заказа ' + o.number,
      size: 'sm',
      body: `<label class="field"><span>Итоговая стоимость *</span>
          <input type="number" id="dlv-price" min="0" step="1" value="${o.estimate || ''}"></label>
        <p class="muted" style="margin-top:0">Оплачено: ${ui.money(o.paid)}. Остаток будет записан как оплата при выдаче.</p>
        ${o.weight ? `<p class="hint-box" style="margin:0">Вес при приёме: <b>${граммы(o.weight)}</b>. Взвесьте изделие при клиенте.</p>` : ''}`,
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

  // ---------- Приём и правка ----------

  function openEditor(o, onChange) {
    const isNew = !o || !o.id;
    o = o || {};
    // Снимки нового заказа ждут в браузере, пока заказ не заведён: фото
    // привязываются к номеру, а номера до сохранения ещё нет.
    const снимки = [];
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
        <div class="form-grid">
          <label class="field"><span>Изделие</span>
            <input name="item" maxlength="200" placeholder="Например: цепь, золото 585" value="${ui.esc(o.item || '')}"></label>
          <label class="field"><span>Вес при приёме, г</span>
            <input name="weight" inputmode="decimal" autocomplete="off" placeholder="Например: 4,52" value="${o.weight ? ui.esc(String(o.weight)) : ''}"></label>
        </div>
        <div class="form-grid">
          <label class="field"><span>Камни</span>
            <input name="stones" maxlength="300" placeholder="Например: 3 фианита, одного нет" value="${ui.esc(o.stones || '')}"></label>
          <label class="field"><span>Состояние, дефекты</span>
            <input name="defects" maxlength="300" placeholder="Например: царапины, погнута шинка" value="${ui.esc(o.defects || '')}"></label>
        </div>
        <label class="field"><span>Что сделать *</span>
          <textarea name="description" required placeholder="Например: заменить замок на цепи, полировка">${ui.esc(o.description || '')}</textarea></label>
        <div class="form-grid-3">
          <label class="field"><span>Оценка стоимости</span><input name="estimate" type="number" min="0" step="1" value="${o.estimate || ''}"></label>
          ${isNew ? '<label class="field"><span>Предоплата</span><input name="prepayment" type="number" min="0" step="1"></label>' : ''}
          <label class="field"><span>Срок готовности</span><input name="due_date" type="date" value="${ui.esc(o.due_date || '')}"></label>
        </div>
        <label class="field"><span>Заметка</span><input name="note" value="${ui.esc(o.note || '')}"></label>
        ${isNew ? `<div class="field"><span>Фото при приёме</span>
          <div class="order-photos" id="ord-new-photos">
            <button type="button" class="btn btn-sm" id="ord-shot">${ui.icon('camera')} Сфотографировать</button>
          </div>
          <small class="muted">Снимите со всех сторон: камни, замок, клеймо пробы. Это защита и вам, и клиенту.</small></div>` : ''}
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="save">${isNew ? 'Принять заказ' : 'Сохранить'}</button>`,
      грязно: () => снимки.length > 0 || ui.естьВведённое(m.body),
    });
    let customer = o.customer_id ? { id: o.customer_id, name: o.customer_name } : null;
    Pages.products.attachCustomerSearch(m.body.querySelector('#ord-customer'), c => { customer = c; });
    const form = m.body.querySelector('#order-form');

    const снять = m.body.querySelector('#ord-shot');
    if (снять) снять.onclick = async () => {
      const files = (await Photos.pickFiles({ camera: true })).filter(Photos.isImage);
      for (const f of files) {
        try {
          const готово = await Photos.prepare(f);
          снимки.push(готово);
          const img = document.createElement('img');
          img.src = готово.thumb;
          img.alt = 'Фото ' + снимки.length;
          img.className = 'order-photo-new';
          снять.before(img);
        } catch { ui.toast('Не получилось прочитать фото — попробуйте ещё раз', true); }
      }
    };

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    const сохранить = m.foot.querySelector('[data-act=save]');
    сохранить.onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const payload = {
        type: v.type, description: v.description, estimate: v.estimate,
        due_date: v.due_date, note: v.note,
        item: v.item, weight: v.weight, stones: v.stones, defects: v.defects,
        customer_id: customer ? customer.id : null,
      };
      if (isNew) payload.prepayment = v.prepayment;
      сохранить.disabled = true;
      try {
        if (!isNew) {
          await api.put('/api/orders/' + o.id, payload);
          ui.toast('Сохранено');
          m.close(); onChange && onChange();
          return;
        }
        const created = await api.post('/api/orders', payload);
        // Заказ уже заведён: фото, которое не ушло, не должно его отменять.
        let неУшло = 0;
        for (const снимок of снимки) {
          try { await api.post(`/api/orders/${created.id}/images`, снимок); } catch { неУшло++; }
        }
        m.close(); onChange && onChange();
        if (неУшло) ui.toast(`Заказ ${created.number} принят, но ${неУшло} фото не загрузилось — добавьте в карточке заказа`, true);
        else ui.toast('Заказ ' + created.number + ' принят');
        послеПриёма(await api.get('/api/orders/' + created.id));
      } catch (e) { ui.toastErr(e); сохранить.disabled = false; }
    };
  }

  // Заказ принят — сразу квитанция: на бумаге или в WhatsApp.
  function послеПриёма(o) {
    const wa = o.customer_phone ? ui.whatsappLink(o.customer_phone, текстКвитанции(o)) : '';
    const m = ui.modal({
      title: `Заказ ${o.number} принят`,
      size: 'sm',
      body: `<p style="margin:4px 0">Дайте клиенту квитанцию: по ней изделие выдаётся. На экземпляре магазина клиент
        расписывается, что сдал изделие именно таким${o.weight ? ` — ${граммы(o.weight)}` : ''}.</p>`,
      footer: `<button class="btn" data-act="done">Готово</button>
        ${wa ? `<a class="btn" data-act="wa" href="${ui.esc(wa)}" target="_blank" rel="noopener">${ui.icon('whatsapp')} В WhatsApp</a>` : ''}
        <button class="btn btn-primary" data-act="print">${ui.icon('print')} Печать квитанции</button>`,
    });
    m.foot.querySelector('[data-act=done]').onclick = m.close;
    m.foot.querySelector('[data-act=print]').onclick = () => печатьКвитанции(o);
  }

  return {
    title: 'Заказы и ремонт',
    openEditor: (o) => openEditor(o, () => { if (Pages._ordersRefresh) Pages._ordersRefresh(); }),
    печатьКвитанции,
    async render(el, param) {
      showArchive = false; // чекбокс рисуется снятым — состояние должно совпадать
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
      const doRefresh = () => { if (el.isConnected) refresh(el).catch(ui.toastErr); };
      Pages._ordersRefresh = doRefresh;
      App.обновлятьТак(el, () => refresh(el));
      el.querySelector('#of-add').addEventListener('click', () => openEditor(null, doRefresh));
      el.querySelector('#of-archive').addEventListener('change', e => { showArchive = e.target.checked; doRefresh(); });
      await refresh(el);
      if (param) openDetail(Number(param), doRefresh);
    },
  };
})();
