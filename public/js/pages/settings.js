'use strict';
window.Pages = window.Pages || {};

window.Pages.settings = (() => {
  /*
   * QR с адресом системы: продавец наводит камеру телефона — и всё, никакого
   * набора «192.168...» вручную. Так же подключается второй, третий телефон.
   */
  function phoneQr(address) {
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const qr = qrcode(0, 'M');
      qr.addData(String(address));
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    } catch { return ''; }
  }

  async function renderStore(box) {
    const [s, countries, network] = await Promise.all([
      api.get('/api/settings'),
      api.get('/api/settings/countries').then(r => r.items),
      api.get('/api/settings/network').catch(() => ({ addresses: [] })),
    ]);
    const cur = s.currency || 'сом';

    box.innerHTML = `
      <div class="two-col">
        <div>
          <div class="card">
            <h3 class="card-title">Магазин</h3>
            <form id="st-form">
              <label class="field"><span>Название (печатается на чеках)</span><input name="store_name" value="${ui.esc(s.store_name)}"></label>
              <div class="form-grid">
                <label class="field"><span>Адрес</span><input name="store_address" value="${ui.esc(s.store_address)}"></label>
                <label class="field"><span>Телефон</span><input name="store_phone" value="${ui.esc(s.store_phone)}"></label>
              </div>
              <label class="field"><span>Курс доллара для закупок</span>
                <input name="usd_rate" type="number" step="0.01" min="0" value="${ui.esc(s.usd_rate || '')}"></label>
              <p class="form-hint">Подставляется, когда изделие закупается в долларах.
                У каждого изделия курс запоминается на момент закупки, поэтому смена курса
                не меняет себестоимость и прибыль прошлых месяцев.</p>
              <button type="button" class="btn btn-primary" id="st-save">Сохранить</button>
            </form>
          </div>

          <div class="card">
            <h3 class="card-title">Страна и валюта</h3>
            <div class="hint-box">
              Выберите страну — подставятся валюта, формат сумм и телефонный код.
              Дальше при желании можно поправить любое поле вручную.
            </div>
            <form id="loc-form">
              <label class="field"><span>Страна</span>
                <select name="country" id="loc-country">
                  ${countries.map(c => `<option value="${c.code}" ${s.country === c.code ? 'selected' : ''}>${ui.esc(c.name)}</option>`).join('')}
                </select></label>
              <div class="form-grid">
                <label class="field"><span>Подпись валюты</span>
                  <input name="currency" value="${ui.esc(s.currency)}" placeholder="сом"></label>
                <label class="field"><span>Знаков после запятой в суммах</span>
                  <select name="money_decimals">
                    <option value="0" ${String(s.money_decimals) === '0' ? 'selected' : ''}>0 — «45 000 ${ui.esc(cur)}»</option>
                    <option value="2" ${String(s.money_decimals) === '2' ? 'selected' : ''}>2 — «45 000,00 ${ui.esc(cur)}»</option>
                  </select></label>
              </div>
              <div class="form-grid-3">
                <label class="field"><span>Код страны</span>
                  <input name="phone_code" value="${ui.esc(s.phone_code)}" placeholder="996"></label>
                <label class="field"><span>Местная приставка</span>
                  <input name="phone_trunk" value="${ui.esc(s.phone_trunk)}" placeholder="0"></label>
                <label class="field"><span>Всего цифр в номере</span>
                  <input name="phone_length" type="number" min="0" max="15" value="${ui.esc(s.phone_length)}"></label>
              </div>
              <p class="form-hint" id="loc-preview"></p>
              <button type="button" class="btn btn-primary" id="loc-save">Сохранить</button>
            </form>
          </div>
        </div>

        <div>
          <div class="card">
            <h3 class="card-title">Открыть на телефоне</h3>
            ${network.addresses.length ? `
              <p class="muted" style="margin-top:0">Наведите камеру телефона на этот код —
              система откроется сама. Телефон должен быть в том же Wi-Fi, что и компьютер.</p>
              <div class="phone-qr">${phoneQr(network.addresses[0])}</div>
              <p class="muted" style="font-size:13px;text-align:center;margin-top:0">
                Так подключается любое число телефонов — просто дайте каждому сканировать.</p>
              <div class="card-title" style="margin-top:16px">Или наберите адрес вручную</div>
              ${network.addresses.map(a => `
                <div class="row" style="margin-bottom:8px">
                  <code style="font-size:19px;font-weight:600;flex:1;word-break:break-all">${ui.esc(a)}</code>
                  <button class="btn btn-sm" data-copy="${ui.esc(a)}">Копировать</button>
                </div>`).join('')}
              <div class="hint-box" style="margin:14px 0 0">
                <strong>Чтобы стало приложением.</strong> Открыв систему на телефоне, нажмите
                в браузере «Поделиться» или «⋮» и выберите
                <b>«На экран “Домой”»</b> (iPhone) или <b>«Установить приложение»</b> (Android).
                Появится значок Asher — система будет открываться на весь экран, без адресной строки.
              </div>
            ` : `<p class="muted">Компьютер не подключён к сети — адрес появится, когда включите Wi-Fi.</p>`}
          </div>
        </div>
      </div>`;

    box.querySelector('#st-save').addEventListener('click', async () => {
      try {
        await api.put('/api/settings', ui.formValues(box.querySelector('#st-form')));
        ui.toast('Настройки сохранены');
        App.storeName = box.querySelector('[name=store_name]').value || 'Asher';
        document.getElementById('brand-name').textContent = App.storeName;
        document.getElementById('brand-name-mobile').textContent = App.storeName;
      } catch (e) { ui.toastErr(e); }
    });

    // Смена страны в списке сразу подставляет её набор в поля — до сохранения.
    const locForm = box.querySelector('#loc-form');
    const preview = box.querySelector('#loc-preview');
    // Образец считаем по значениям в форме, а не по сохранённым: владелец должен
    // видеть, что получится, ещё до нажатия «Сохранить».
    function updatePreview() {
      const v = ui.formValues(locForm);
      const country = countries.find(c => c.code === v.country);
      const numberLocale = country ? country.number_locale : 'ru-RU';
      let sum;
      try {
        sum = (45000).toLocaleString(numberLocale, {
          minimumFractionDigits: Number(v.money_decimals) || 0,
          maximumFractionDigits: Number(v.money_decimals) || 0,
        });
      } catch { sum = '45 000'; }

      const example = country ? country.phone_example : '';
      const digits = String(example).replace(/\D/g, '');
      const code = String(v.phone_code || '');
      const trunk = String(v.phone_trunk || '');
      const length = Number(v.phone_length) || 0;
      let wa = digits.startsWith(trunk) && trunk ? code + digits.slice(trunk.length) : code + digits;
      if (length && wa.length !== length) wa = digits;

      preview.innerHTML = `Сумма будет выглядеть так: <b>${ui.esc(sum)} ${ui.esc(v.currency || '')}</b>` +
        (example ? ` · телефон «${ui.esc(example)}» → WhatsApp <b>+${ui.esc(wa)}</b>` : '');
    }
    box.querySelector('#loc-country').addEventListener('change', e => {
      const c = countries.find(x => x.code === e.target.value);
      if (!c) return;
      locForm.querySelector('[name=currency]').value = c.currency;
      locForm.querySelector('[name=money_decimals]').value = String(c.money_decimals);
      locForm.querySelector('[name=phone_code]').value = c.phone_code;
      locForm.querySelector('[name=phone_trunk]').value = c.phone_trunk;
      locForm.querySelector('[name=phone_length]').value = String(c.phone_length);
      updatePreview();
    });
    box.querySelector('#loc-save').addEventListener('click', async () => {
      try {
        const v = ui.formValues(locForm);
        const country = countries.find(c => c.code === v.country);
        if (country) { v.number_locale = country.number_locale; v.fineness = country.fineness; v.phone_example = country.phone_example; }
        await api.put('/api/settings', v);
        // Обновляем локаль в памяти — иначе суммы останутся в старом формате до перезагрузки.
        const me = await api.get('/api/me');
        if (me.locale) App.locale = me.locale;
        ui.toast('Сохранено. Суммы и телефоны теперь в новом формате.');
        renderStore(box);
      } catch (e) { ui.toastErr(e); }
    });

    box.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        ui.toast('Адрес скопирован');
      } catch { ui.toast('Скопируйте адрес вручную', true); }
    }));

    updatePreview();
  }

  async function renderCatalogRefs(box) {
    const [cats, sups] = await Promise.all([
      api.get('/api/categories').then(r => r.items),
      api.get('/api/suppliers').then(r => r.items),
    ]);
    box.innerHTML = `
      <div class="grid grid-2">
        <div class="card mb0">
          <h3 class="card-title">Категории изделий</h3>
          <div id="cat-list">${cats.map(c => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
              <span>${ui.esc(c.name)}</span>
              <button class="btn btn-sm btn-danger" data-cat-del="${c.id}">×</button>
            </div>`).join('')}</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <input type="text" class="input" id="cat-new" placeholder="Новая категория">
            <button class="btn" id="cat-add">Добавить</button>
          </div>
        </div>
        <div class="card mb0">
          <h3 class="card-title">Поставщики</h3>
          <div>${sups.map(s => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)">
              <span>${ui.esc(s.name)}${s.phone ? ` <span class="muted">· ${ui.esc(s.phone)}</span>` : ''}
                <span class="muted" style="font-size:12px">(${s.products_count} изд.)</span></span>
              <span style="display:flex;gap:6px">
                <button class="btn btn-sm" data-sup-edit="${s.id}">✎</button>
                <button class="btn btn-sm btn-danger" data-sup-del="${s.id}">×</button>
              </span>
            </div>`).join('') || '<p class="muted">Поставщиков пока нет</p>'}</div>
          <button class="btn" id="sup-add" style="margin-top:12px">+ Поставщик</button>
        </div>
      </div>`;

    const redraw = () => renderCatalogRefs(box).catch(ui.toastErr);
    // обработчики вешаем на пересоздаваемый контейнер, а не на постоянный box —
    // иначе при каждой перерисовке они дублируются
    const root = box.querySelector('.grid');
    root.querySelector('#cat-add').addEventListener('click', async () => {
      const name = root.querySelector('#cat-new').value.trim();
      if (!name) return;
      try { await api.post('/api/categories', { name }); redraw(); } catch (e) { ui.toastErr(e); }
    });
    root.addEventListener('click', async e => {
      const catDel = e.target.dataset && e.target.dataset.catDel;
      const supDel = e.target.dataset && e.target.dataset.supDel;
      const supEdit = e.target.dataset && e.target.dataset.supEdit;
      try {
        if (catDel && await ui.confirmDialog('Удалить категорию?', { danger: true, okLabel: 'Удалить' })) {
          await api.del('/api/categories/' + catDel); redraw();
        }
        if (supDel && await ui.confirmDialog('Удалить поставщика? Изделия останутся без поставщика.', { danger: true, okLabel: 'Удалить' })) {
          await api.del('/api/suppliers/' + supDel); redraw();
        }
        if (supEdit) supplierDialog(sups.find(s => s.id === Number(supEdit)), redraw);
      } catch (err) { ui.toastErr(err); }
    });
    root.querySelector('#sup-add').addEventListener('click', () => supplierDialog(null, redraw));
  }

  function supplierDialog(s, onChange) {
    const isNew = !s;
    s = s || {};
    const m = ui.modal({
      title: isNew ? 'Новый поставщик' : 'Поставщик: ' + s.name,
      size: 'sm',
      body: `<form id="sup-form">
        <label class="field"><span>Название *</span><input name="name" required value="${ui.esc(s.name || '')}"></label>
        <label class="field"><span>Контактное лицо</span><input name="contact" value="${ui.esc(s.contact || '')}"></label>
        <label class="field"><span>Телефон</span><input name="phone" value="${ui.esc(s.phone || '')}"></label>
        <label class="field"><span>Заметки</span><input name="notes" value="${ui.esc(s.notes || '')}"></label>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">${isNew ? 'Добавить' : 'Сохранить'}</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      const form = m.body.querySelector('#sup-form');
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      try {
        if (isNew) await api.post('/api/suppliers', v);
        else await api.put('/api/suppliers/' + s.id, v);
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  // ---------- Точки продаж ----------

  async function renderStores(box) {
    const [{ items }, transfers] = await Promise.all([
      api.get('/api/stores'),
      api.get('/api/transfers?limit=30').then(r => r.items).catch(() => []),
    ]);
    box.innerHTML = `
      <div class="hint-box">
        <strong>Точки продаж.</strong> Если магазин один, здесь ничего менять не нужно.
        Несколько точек нужны, чтобы видеть остатки каждой отдельно и перемещать
        между ними товар. Удалить точку можно, только когда на ней не осталось изделий.
      </div>
      <div class="card">
        <h3 class="card-title">Точки</h3>
        ${ui.table([
          { title: 'Название', render: r => `<span class="strong">${ui.esc(r.name)}</span>` +
            (r.is_default ? ' <span class="badge badge-gold">основная</span>' : '') },
          { title: 'Адрес', render: r => `<span class="dim">${ui.esc(r.address || '—')}</span>` },
          { title: 'Телефон', render: r => ui.esc(r.phone || '—') },
          { title: 'Изделий', cls: 'num', render: r => ui.num(r.in_stock) },
          { title: 'Вес', cls: 'num', render: r => ui.num(r.stock_weight) + ' г' },
          { title: 'На сумму', cls: 'num strong', render: r => ui.money(r.stock_retail) },
          { title: '', render: r => `<button class="btn btn-sm" data-store-edit="${r.id}">✎</button>
            <button class="btn btn-sm btn-danger" data-store-del="${r.id}">×</button>` },
        ], items)}
        <button class="btn" id="store-add" style="margin-top:12px">+ Точка продаж</button>
      </div>
      ${transfers.length ? `<div class="card">
        <h3 class="card-title">Последние перемещения</h3>
        ${ui.table([
          { title: 'Когда', render: r => ui.dt(r.created_at) },
          { title: 'Изделие', render: r => `<span class="mono">${ui.esc(r.sku || '—')}</span> ${ui.esc(r.product_name || '')}` },
          { title: 'Откуда', render: r => `<span class="dim">${ui.esc(r.from_name || '—')}</span>` },
          { title: 'Куда', render: r => ui.esc(r.to_name || '—') },
          { title: 'Кто', render: r => `<span class="dim">${ui.esc(r.user_name || '—')}</span>` },
        ], transfers, { empty: '' })}
      </div>` : ''}`;

    box.querySelector('#store-add').addEventListener('click', () => storeDialog(null, () => renderStores(box)));
    box.querySelectorAll('[data-store-edit]').forEach(btn => btn.addEventListener('click', () =>
      storeDialog(items.find(s => s.id === Number(btn.dataset.storeEdit)), () => renderStores(box))));
    box.querySelectorAll('[data-store-del]').forEach(btn => btn.addEventListener('click', async () => {
      const store = items.find(s => s.id === Number(btn.dataset.storeDel));
      if (!await ui.confirmDialog(`Удалить точку «${store.name}»?`, { danger: true, okLabel: 'Удалить' })) return;
      try {
        await api.del('/api/stores/' + store.id);
        ui.toast('Точка удалена');
        renderStores(box);
      } catch (e) { ui.toastErr(e); }
    }));
  }

  function storeDialog(s, onChange) {
    const isNew = !s;
    s = s || {};
    const m = ui.modal({
      title: isNew ? 'Новая точка продаж' : 'Точка: ' + s.name,
      size: 'sm',
      body: `<form id="store-form">
        <label class="field"><span>Название *</span><input name="name" required
          value="${ui.esc(s.name || '')}" placeholder="Салон на Тверской"></label>
        <label class="field"><span>Адрес</span><input name="address" value="${ui.esc(s.address || '')}"></label>
        <label class="field"><span>Телефон</span><input name="phone" value="${ui.esc(s.phone || '')}"></label>
        ${isNew || s.is_default ? '' : `<label class="row-tight" style="cursor:pointer">
          <input type="checkbox" name="is_default" style="width:20px;height:20px;cursor:pointer">
          Сделать основной — сюда попадает новый товар</label>`}
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">${isNew ? 'Добавить' : 'Сохранить'}</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      const form = m.body.querySelector('#store-form');
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      try {
        if (isNew) await api.post('/api/stores', v);
        else await api.put('/api/stores/' + s.id, v);
        ui.toast(isNew ? 'Точка добавлена' : 'Сохранено');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  async function renderUsers(box) {
    const { items } = await api.get('/api/users');
    box.innerHTML = `
      <div class="hint-box" style="max-width:720px">
        <strong>Две роли — два вида системы.</strong>
        <div style="margin-top:8px"><span class="badge badge-gold">Администратор</span> —
          видит всё: закупочные цены, наценку, прибыль, расчёты с поставщиками,
          аналитику, финансы, импорт из 1С и журнал операций.</div>
        <div style="margin-top:6px"><span class="badge badge-gray">Продавец</span> —
          работает за прилавком: каталог, продажи, обмены и возвраты, клиенты, долги
          клиентов, заказы, комплекты, инвентаризация, бирки. Закупочных цен, наценки
          и прибыли не видит нигде — ни в карточке изделия, ни в чеке, ни в отчётах.</div>
      </div>
      <div class="card" style="max-width:720px">
        <h3 class="card-title">Сотрудники</h3>
        ${ui.table([
          { title: 'Логин', render: r => `<span class="mono">${ui.esc(r.username)}</span>` },
          { title: 'Имя', render: r => `<span class="strong">${ui.esc(r.name)}</span>` },
          { title: 'Роль', render: r => r.role === 'admin' ? '<span class="badge badge-gold">Администратор</span>' : '<span class="badge badge-gray">Продавец</span>' },
          { title: 'Статус', render: r => r.active ? '<span class="badge badge-good">Активен</span>' : '<span class="badge badge-crit">Отключён</span>' },
          { title: '', render: r => `<button class="btn btn-sm" data-user-edit="${r.id}">✎</button>` },
        ], items)}
        <button class="btn" id="user-add" style="margin-top:12px">+ Сотрудник</button>
      </div>`;
    box.querySelector('#user-add').addEventListener('click', () => userDialog(null, () => renderUsers(box)));
    box.querySelectorAll('[data-user-edit]').forEach(btn => btn.addEventListener('click', () => {
      userDialog(items.find(u => u.id === Number(btn.dataset.userEdit)), () => renderUsers(box));
    }));
  }

  function userDialog(u, onChange) {
    const isNew = !u;
    u = u || {};
    const m = ui.modal({
      title: isNew ? 'Новый сотрудник' : 'Сотрудник: ' + u.name,
      size: 'sm',
      body: `<form id="user-form">
        ${isNew ? `<label class="field"><span>Логин *</span><input name="username" required placeholder="anna" pattern="[a-z0-9._-]{3,30}"></label>` : ''}
        <label class="field"><span>Имя *</span><input name="name" required value="${ui.esc(u.name || '')}"></label>
        <label class="field"><span>Роль</span><select name="role">
          <option value="seller" ${u.role !== 'admin' ? 'selected' : ''}>Продавец</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option></select></label>
        <p class="form-hint" id="role-hint"></p>
        <label class="field"><span>${isNew ? 'Пароль *' : 'Новый пароль (не обязательно)'}</span>
          <input name="password" type="password" ${isNew ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
        ${!isNew ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="active" ${u.active ? 'checked' : ''} style="width:auto"> <span style="font-weight:400">Активен (может входить в систему)</span></label>` : ''}
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">${isNew ? 'Создать' : 'Сохранить'}</button>`,
    });
    // Владельцу важно понимать, что именно он открывает человеку, — пишем прямо здесь.
    const roleSel = m.body.querySelector('[name=role]');
    const roleHint = m.body.querySelector('#role-hint');
    const showRoleHint = () => {
      roleHint.textContent = roleSel.value === 'admin'
        ? 'Администратор видит закупочные цены, наценку, прибыль, расчёты с поставщиками, аналитику и финансы.'
        : 'Продавец работает с каталогом, продажами, клиентами и долгами, но закупочных цен, наценки и прибыли не видит нигде.';
    };
    roleSel.addEventListener('change', showRoleHint);
    showRoleHint();

    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      const form = m.body.querySelector('#user-form');
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      try {
        if (isNew) await api.post('/api/users', v);
        else {
          const payload = { name: v.name, role: v.role, active: v.active };
          if (v.password) payload.password = v.password;
          await api.put('/api/users/' + u.id, payload);
        }
        ui.toast('Сохранено');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  /*
   * Журнал действий сотрудников.
   *
   * Раньше это был список последних 500 строк по-английски. Владельцу нужно
   * другое: выбрать человека, период и вид действия — и увидеть, что именно
   * тот сделал. Поэтому здесь отбор, сводка «кто сколько» и человеческие
   * названия для каждого действия, включая обмены, резервы и списания.
   */
  const AUDIT_ACTIONS = {
    login: 'вход в систему', sale: 'продажа', return: 'возврат', exchange: 'обмен',
    payment: 'приём оплаты', status: 'смена статуса', create: 'создание',
    update: 'изменение', delete: 'удаление', import: 'импорт из файла',
    transfer: 'перемещение между точками', invoice: 'поставка',
    return_to_supplier: 'возврат поставщику', finish: 'итог инвентаризации',
    release_reserves: 'снятие просроченных резервов', reserve_expired: 'резерв истёк',
    upload_photo: 'загрузка фото', delete_photo: 'удаление фото',
    upload_certificate: 'загрузка сертификата', delete_certificate: 'удаление сертификата',
    password: 'смена пароля', sync: 'автообмен с 1С',
  };
  const AUDIT_ENTITIES = {
    product: 'изделие', products: 'изделия', customer: 'клиент', customers: 'клиенты',
    sale: 'чек', order: 'заказ', finance: 'касса', user: 'сотрудник',
    category: 'категория', supplier: 'поставщик', supplier_op: 'расчёт с поставщиком',
    settings: 'настройки', set: 'комплект', store: 'точка продаж',
    inventory: 'инвентаризация', debt: 'долг',
  };
  // Действия, за которыми владелец следит чаще всего, — их выносим в отбор.
  const AUDIT_PICK = ['sale', 'return', 'exchange', 'payment', 'status', 'create', 'update',
    'delete', 'import', 'transfer', 'finish', 'login'];

  async function renderAudit(box) {
    const users = await api.get('/api/users').then(r => r.items).catch(() => []);
    const f = { user_id: '', action: '', from: '', to: '', search: '' };
    let offset = 0;
    let rows = [];

    box.innerHTML = `
      <div class="hint-box">
        <strong>Кто что сделал.</strong> Здесь видно каждое действие каждого сотрудника:
        продажи, возвраты и обмены, приём оплаты, резервы и списания, правки изделий,
        входы в систему. Записи не удаляются и не редактируются.
      </div>
      <div class="toolbar">
        <select class="input" id="au-user"><option value="">Все сотрудники</option>
          ${users.map(u => `<option value="${u.id}">${ui.esc(u.name)}${u.role === 'admin' ? ' (админ)' : ''}</option>`).join('')}
        </select>
        <select class="input" id="au-action"><option value="">Любое действие</option>
          ${AUDIT_PICK.map(a => `<option value="${a}">${AUDIT_ACTIONS[a]}</option>`).join('')}
        </select>
        <label class="row-tight">с <input type="date" class="input" id="au-from" style="width:auto"></label>
        <label class="row-tight">по <input type="date" class="input" id="au-to" style="width:auto"></label>
        <input type="text" class="input search" id="au-search" placeholder="Поиск по деталям…" autocomplete="off">
        <button class="btn" id="au-reset">Сбросить</button>
      </div>
      <div id="au-summary"></div>
      <div class="card"><div id="au-list"><div class="empty"><p>Загрузка…</p></div></div>
        <div style="text-align:center;margin-top:12px">
          <button class="btn hidden" id="au-more">Показать ещё</button></div>
      </div>`;

    const listEl = box.querySelector('#au-list');
    const moreBtn = box.querySelector('#au-more');
    const sumEl = box.querySelector('#au-summary');

    const draw = () => {
      listEl.innerHTML = ui.table([
        { title: 'Когда', cls: 'nowrap', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
        { title: 'Кто', render: r => r.user_name
          ? `${ui.esc(r.user_name)}${r.user_role === 'admin'
            ? ' <span class="badge badge-gold">админ</span>'
            : ' <span class="badge badge-gray">продавец</span>'}`
          : '<span class="dim">система</span>' },
        { title: 'Действие', render: r =>
          `<span class="badge badge-gray">${ui.esc(AUDIT_ACTIONS[r.action] || r.action)}</span>` },
        { title: 'Что', render: r => `<span class="dim">${ui.esc(AUDIT_ENTITIES[r.entity] || r.entity)}</span>` },
        { title: 'Подробности', render: r => ui.esc(r.details || '—') },
      ], rows, { empty: 'За выбранный отбор действий нет' });
    };

    const load = async (append) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
      q.set('limit', '100');
      q.set('offset', String(append ? offset : 0));
      const res = await api.get('/api/audit?' + q.toString());
      rows = append ? [...rows, ...res.items] : res.items;
      offset = rows.length;
      draw();
      moreBtn.classList.toggle('hidden', rows.length >= res.total);
      moreBtn.textContent = `Показать ещё (осталось ${res.total - rows.length})`;
      sumEl.innerHTML = res.by_user.length > 1 || f.user_id
        ? `<div class="card"><div class="card-title">Кто сколько сделал${
            f.from || f.to ? ' за период' : ''} — всего действий: ${res.total}</div>
           ${res.by_user.map(u => `<div class="row" style="justify-content:space-between;padding:6px 0">
             <span class="strong">${ui.esc(u.name)}</span>
             <span><b>${u.count}</b> <span class="dim">· последнее ${ui.dt(u.last_at)}</span></span>
           </div>`).join('')}</div>`
        : '';
    };

    const reload = ui.debounce(() => load(false).catch(ui.toastErr), 250);
    box.querySelector('#au-user').addEventListener('change', e => { f.user_id = e.target.value; reload(); });
    box.querySelector('#au-action').addEventListener('change', e => { f.action = e.target.value; reload(); });
    box.querySelector('#au-from').addEventListener('change', e => { f.from = e.target.value; reload(); });
    box.querySelector('#au-to').addEventListener('change', e => { f.to = e.target.value; reload(); });
    box.querySelector('#au-search').addEventListener('input', e => { f.search = e.target.value.trim(); reload(); });
    box.querySelector('#au-reset').addEventListener('click', () => {
      Object.keys(f).forEach(k => { f[k] = ''; });
      box.querySelectorAll('#au-user, #au-action, #au-from, #au-to, #au-search')
        .forEach(el => { el.value = ''; });
      reload();
    });
    moreBtn.addEventListener('click', () => load(true).catch(ui.toastErr));
    await load(false);
  }

  function renderMyPassword(box) {
    box.innerHTML = `
      <div class="card" style="max-width:420px">
        <h3 class="card-title">Мой пароль</h3>
        <label class="field"><span>Новый пароль (мин. 6 символов)</span>
          <input type="password" id="my-pwd" minlength="6" autocomplete="new-password"></label>
        <button class="btn btn-primary" id="my-pwd-save">Сменить пароль</button>
      </div>`;
    box.querySelector('#my-pwd-save').addEventListener('click', async () => {
      const pwd = box.querySelector('#my-pwd').value;
      if (pwd.length < 6) { ui.toast('Пароль минимум 6 символов', true); return; }
      try {
        await api.post('/api/me/password', { password: pwd });
        ui.toast('Пароль изменён');
        box.querySelector('#my-pwd').value = '';
      } catch (e) { ui.toastErr(e); }
    });
  }

  return {
    title: 'Настройки',
    async render(el) {
      const admin = App.isAdmin();
      const tabs = admin
        ? [['store', 'Магазин'], ['stores', 'Точки продаж'], ['refs', 'Справочники'],
           ['users', 'Сотрудники'], ['audit', 'Журнал действий'], ['me', 'Мой пароль']]
        : [['me', 'Мой пароль']];
      el.innerHTML = `
        <div class="tabs">${tabs.map(([k, t], i) =>
          `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>
        <div id="set-body"></div>`;
      const body = el.querySelector('#set-body');
      const show = async (key) => {
        body.innerHTML = '<div class="empty"><p>Загрузка…</p></div>';
        try {
          if (key === 'store') await renderStore(body);
          if (key === 'stores') await renderStores(body);
          if (key === 'refs') await renderCatalogRefs(body);
          if (key === 'users') await renderUsers(body);
          if (key === 'audit') await renderAudit(body);
          if (key === 'me') renderMyPassword(body);
        } catch (e) { body.innerHTML = `<div class="empty"><p>${ui.esc(e.message)}</p></div>`; }
      };
      el.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
        el.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        show(t.dataset.tab);
      }));
      await show(tabs[0][0]);
    },
  };
})();
