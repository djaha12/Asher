'use strict';
window.Pages = window.Pages || {};

window.Pages.settings = (() => {
  /*
   * QR с адресом системы: продавец наводит камеру телефона — и всё, никакого
   * набора «192.168...» вручную. Так же подключается второй, третий телефон.
   */
  /*
   * Адрес, который надо дать телефону.
   *
   * Пока система стоит в магазине, владелец смотрит её на самом компьютере —
   * по «localhost», а такой адрес на телефоне не откроется: нужен адрес
   * компьютера в сети Wi-Fi. Но как только система переедет на свой домен,
   * правильный адрес — ровно тот, по которому владелец сейчас и работает.
   * Поэтому: сидим на localhost — берём сетевой адрес, во всех остальных
   * случаях берём адрес из строки браузера. Он заведомо рабочий.
   */
  function publicBase(net) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
    if (!local) return location.origin;
    return (net && net.addresses && net.addresses[0]) || '';
  }

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
    // Работаем ли уже по своему адресу в интернете — от этого зависит,
    // что показывать: домен или список адресов в магазинной сети.
    const onDomain = !/^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)$/i.test(location.hostname);

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

              <h4 style="margin:18px 0 10px">Цена от грамма</h4>
              <div class="form-grid">
                <label class="field"><span>Цена грамма золота 750</span>
                  <input name="gram_price" type="number" step="1" min="0" value="${ui.esc(s.gram_price || '')}"></label>
                <label class="field"><span>Работа за грамм</span>
                  <input name="work_price" type="number" step="1" min="0" value="${ui.esc(s.work_price || '')}"></label>
              </div>
              <p class="form-hint">Заполните, если считаете розницу от веса: в карточке изделия
                появится кнопка «Посчитать от грамма» — вес × цена грамма + работа, и к этому
                вы добавляете стоимость камня. Оставьте пустыми, если ставите цену каждому
                изделию отдельно: тогда кнопки просто не будет.
                <b>Цена изделия хранится готовой суммой</b> — смена цены грамма не переписывает
                ни ценники, ни прошлые чеки.</p>
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
            ${publicBase(network) ? `
              <p class="muted" style="margin-top:0">Наведите камеру телефона на этот код —
              система откроется сама.${onDomain ? '' : ' Телефон должен быть в том же Wi-Fi, что и компьютер.'}</p>
              <div class="phone-qr">${phoneQr(publicBase(network))}</div>
              <div class="row" style="justify-content:center;margin-bottom:6px">
                <code style="font-size:17px;font-weight:600">${ui.esc(publicBase(network))}</code>
                <button class="btn btn-sm" data-copy="${ui.esc(publicBase(network))}">Копировать</button>
              </div>
              ${onDomain ? `<div class="hint-box" style="margin:0 0 12px">
                Система работает по своему адресу в интернете — телефоны открывают её
                откуда угодно, а не только из магазинного Wi-Fi.</div>` : ''}
              <p class="muted" style="font-size:13px;text-align:center;margin-top:0">
                Так подключается любое число телефонов — просто дайте каждому сканировать.</p>
              ${onDomain ? '' : `<div class="card-title" style="margin-top:16px">Или наберите адрес вручную</div>`}
              ${onDomain ? '' : network.addresses.map(a => `
                <div class="row" style="margin-bottom:8px">
                  <code style="font-size:19px;font-weight:600;flex:1;word-break:break-all">${ui.esc(a)}</code>
                  <button class="btn btn-sm" data-copy="${ui.esc(a)}">Копировать</button>
                </div>`).join('')}
              ${onDomain || !network.hostname_url ? '' : `
                <div class="card-title" style="margin-top:16px">Адрес, который не меняется</div>
                <div class="row" style="margin-bottom:6px">
                  <code style="font-size:19px;font-weight:600;flex:1;word-break:break-all">${ui.esc(network.hostname_url)}</code>
                  <button class="btn btn-sm" data-copy="${ui.esc(network.hostname_url)}">Копировать</button>
                </div>
                <p class="form-hint">Адрес вида 192.168… роутер может однажды поменять — тогда
                  сохранённая на телефонах ссылка перестанет открываться. Этот адрес привязан
                  к имени компьютера и переживает такую смену. Если телефон его не открывает
                  (бывает на старых роутерах) — пользуйтесь адресом с цифрами выше.</p>`}
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
          { title: 'Устройства', cls: 'num', render: r => r.devices
            ? `<span title="Устройств, где выполнен вход">${r.devices}</span>` : '<span class="dim">—</span>' },
          { title: '', cls: 'nowrap', render: r =>
            `<button class="btn btn-sm" data-user-phone="${r.id}" title="Подключить телефон">📱</button>
             ${r.devices ? `<button class="btn btn-sm" data-user-logout="${r.id}"
               title="Завершить вход на всех устройствах">⎋</button>` : ''}
             <button class="btn btn-sm" data-user-edit="${r.id}">✎</button>` },
        ], items)}
        <button class="btn" id="user-add" style="margin-top:12px">+ Сотрудник</button>
        <p class="form-hint">Столбец «Устройства» — сколько телефонов и компьютеров сейчас
          в системе под этим логином. Потеряли телефон или человек уволился — нажмите ⎋:
          вход прекратится немедленно на всех его устройствах.</p>
        <p class="form-hint">У каждого сотрудника — свой логин. Общий на всех логин
          обесценивает журнал: в нём будет видно, что действие сделал «кто-то».
          Кнопка 📱 открывает карточку подключения: сотрудник наводит камеру — и система
          открывается у него на телефоне с уже подставленным логином.</p>
      </div>`;
    box.querySelector('#user-add').addEventListener('click', () => userDialog(null, () => renderUsers(box)));
    box.querySelectorAll('[data-user-edit]').forEach(btn => btn.addEventListener('click', () => {
      userDialog(items.find(u => u.id === Number(btn.dataset.userEdit)), () => renderUsers(box));
    }));
    box.querySelectorAll('[data-user-phone]').forEach(btn => btn.addEventListener('click', () => {
      phoneCard(items.find(u => u.id === Number(btn.dataset.userPhone)));
    }));
    box.querySelectorAll('[data-user-logout]').forEach(btn => btn.addEventListener('click', async () => {
      const u = items.find(x => x.id === Number(btn.dataset.userLogout));
      const yes = await ui.confirmDialog(
        `Завершить вход «${u.name}» на всех устройствах (${u.devices})? ` +
        'Чтобы работать дальше, ему нужно будет войти заново со своим паролем.',
        { danger: true, okLabel: 'Завершить' });
      if (!yes) return;
      try {
        const r = await api.post(`/api/users/${u.id}/logout-all`);
        ui.toast(`Завершено сеансов: ${r.closed}`);
        renderUsers(box);
      } catch (e) { ui.toastErr(e); }
    }));
  }

  /*
   * Карточка подключения телефона.
   *
   * Шесть продавцов — шесть телефонов, и на каждом надо набрать адрес вида
   * «192.168.1.14:3000», а потом логин. Вручную это шесть возможностей ошибиться.
   * Карточку можно показать с экрана или распечатать: сотрудник наводит камеру,
   * система открывается, логин уже стоит — остаётся ввести пароль.
   */
  async function phoneCard(u) {
    if (!u) return;
    const net = await api.get('/api/settings/network').catch(() => ({ addresses: [] }));
    const base = publicBase(net);
    const link = base ? `${base}/#login=${encodeURIComponent(u.username)}` : '';
    const m = ui.modal({
      title: 'Телефон сотрудника: ' + u.name,
      size: 'sm',
      body: `<div id="phone-card">
        ${link ? `
          <div class="phone-qr">${phoneQr(link)}</div>
          <div style="text-align:center;margin-bottom:10px">
            <div style="font-size:19px;font-weight:600">${ui.esc(u.name)}</div>
            <div class="muted">логин: <b class="mono">${ui.esc(u.username)}</b></div>
            <div class="muted mono" style="font-size:13px;word-break:break-all">${ui.esc(base)}</div>
          </div>
          <div class="hint-box" style="margin:0">
            <strong>Что сделать на телефоне:</strong>
            <div style="margin-top:6px">1. Навести камеру на код — откроется система.</div>
            <div>2. Ввести пароль (логин уже подставлен).</div>
            <div>3. В браузере нажать «Поделиться» → <b>«На экран “Домой”»</b> (iPhone)
              или «⋮» → <b>«Установить приложение»</b> (Android) — появится значок Asher.</div>
            <div style="margin-top:6px">${/^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)$/i.test(location.hostname)
              ? 'Телефон должен быть в том же Wi-Fi, что и компьютер.'
              : 'Работает откуда угодно — Wi-Fi магазина не нужен.'}</div>
          </div>`
        : '<p class="muted">Компьютер не подключён к сети — адрес появится, когда включите Wi-Fi.</p>'}
      </div>`,
      footer: `<button class="btn" data-act="cancel">Закрыть</button>
        ${link ? `<button class="btn" data-act="pwd">Задать пароль</button>
          <button class="btn btn-primary" data-act="print">${ui.icon('print')} Печатать</button>` : ''}`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    const pwdBtn = m.foot.querySelector('[data-act=pwd]');
    if (pwdBtn) pwdBtn.onclick = () => { m.close(); userDialog(u, null); };
    const printBtn = m.foot.querySelector('[data-act=print]');
    if (printBtn) printBtn.onclick = () => {
      const root = document.getElementById('print-root');
      root.innerHTML = `<div style="padding:20mm;text-align:center">
        <h2 style="margin:0 0 8px">Asher — вход для сотрудника</h2>
        <div style="font-size:22px;font-weight:600;margin-bottom:4px">${ui.esc(u.name)}</div>
        <div style="margin-bottom:14px">логин: <b>${ui.esc(u.username)}</b></div>
        <div style="width:70mm;margin:0 auto 12px">${phoneQr(link)}</div>
        <div style="font-family:monospace">${ui.esc(base)}</div>
        <p style="margin-top:16px">Наведите камеру телефона на код, введите пароль,
          затем добавьте страницу на главный экран.</p>
      </div>`;
      setTimeout(() => {
        window.print();
        setTimeout(() => { root.innerHTML = ''; }, 500);
      }, 80);
    };
  }

  function userDialog(u, onChange) {
    const isNew = !u;
    u = u || {};
    const m = ui.modal({
      title: isNew ? 'Новый сотрудник' : 'Сотрудник: ' + u.name,
      size: 'sm',
      body: `<form id="user-form">
        ${isNew ? `<label class="field"><span>Логин *</span><input name="username" required placeholder="anna" autocapitalize="none" pattern="[a-z0-9._\\-]{3,30}"></label>` : ''}
        <label class="field"><span>Имя *</span><input name="name" required value="${ui.esc(u.name || '')}"></label>
        <label class="field"><span>Роль</span><select name="role">
          <option value="seller" ${u.role !== 'admin' ? 'selected' : ''}>Продавец</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option></select></label>
        <p class="form-hint" id="role-hint"></p>
        <label class="field"><span>${isNew ? 'Пароль * (не короче 8 знаков)' : 'Новый пароль (не короче 8 знаков)'}</span>
          <input name="password" type="password" ${isNew ? 'required' : ''} minlength="8" autocomplete="new-password"></label>
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
        let created = null;
        if (isNew) created = await api.post('/api/users', v);
        else {
          const payload = { name: v.name, role: v.role, active: v.active };
          if (v.password) payload.password = v.password;
          await api.put('/api/users/' + u.id, payload);
        }
        ui.toast('Сохранено');
        m.close(); onChange && onChange();
        // Завели человека — сразу показываем, как подключить его телефон:
        // отдельно искать эту кнопку никто не станет.
        if (isNew) phoneCard({ id: created && created.id, name: v.name, username: v.username });
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
    login_failed: 'неудачный вход', logout_all: 'завершение всех сеансов',
    backup: 'скачана резервная копия',
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
    'delete', 'import', 'transfer', 'finish', 'login', 'login_failed'];

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
      <div class="card" style="max-width:460px">
        <h3 class="card-title">Мой пароль</h3>
        <label class="field"><span>Новый пароль (не короче 8 знаков)</span>
          <input type="password" id="my-pwd" minlength="8" autocomplete="new-password"></label>
        <p class="form-hint">Смена пароля завершит вход на всех остальных устройствах —
          это устройство останется в системе. Так и должно быть: пароль меняют,
          когда подозревают, что его кто-то знает.</p>
        <button class="btn btn-primary" id="my-pwd-save">Сменить пароль</button>
      </div>`;
    box.querySelector('#my-pwd-save').addEventListener('click', async () => {
      const pwd = box.querySelector('#my-pwd').value;
      if (pwd.length < 8) { ui.toast('Пароль должен быть не короче 8 знаков', true); return; }
      try {
        const r = await api.post('/api/me/password', { password: pwd });
        ui.toast(r.sessions_closed
          ? `Пароль изменён. Завершено других входов: ${r.sessions_closed}`
          : 'Пароль изменён');
        box.querySelector('#my-pwd').value = '';
      } catch (e) { ui.toastErr(e); }
    });
  }

  /*
   * Безопасность одной страницей.
   *
   * Владельцу не нужно разбираться в заголовках и сертификатах — ему нужно
   * видеть, всё ли в порядке, и уметь нажать две кнопки: сменить стандартный
   * пароль и забрать копию базы. Всё остальное система делает сама.
   */
  async function renderSecurity(box) {
    // Спрашиваем систему, а не браузер: только сервер знает, что перед ним
    // прокси с https и что пароль администратора всё ещё стандартный.
    const st = await api.get('/api/security/status').catch(() => ({}));
    const устр = await api.get('/api/devices').catch(() => ({ pending: [], approved: [] }));
    const ждут = устр.pending || [];
    const разрешены = устр.approved || [];
    const hint = { default_admin: st.default_admin };
    const secure = Boolean(st.secure);
    const devices = Number(st.devices) || 0;
    const row = (good, title, text) => `
      <div class="row" style="align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <span class="badge ${good ? 'badge-good' : 'badge-crit'}" style="margin-top:2px">${good ? '✓' : '!'}</span>
        <div><div class="strong">${title}</div><div class="muted">${text}</div></div>
      </div>`;

    box.innerHTML = `
      <div class="two-col">
        <div>
          <div class="card">
            <h3 class="card-title">Что с безопасностью</h3>
            ${row(!hint.default_admin, 'Пароль администратора',
              hint.default_admin
                ? 'Стоит стандартный «admin123». Его знает любой, кто видел эту систему. Смените на вкладке «Мой пароль» — это первое, что нужно сделать.'
                : 'Стандартный пароль сменён.')}
            ${row(!st.backup_error && !st.backup_stale, 'Резервная копия',
              st.backup_error
                ? `Копии НЕ ДЕЛАЮТСЯ: ${ui.esc(st.backup_error)}. Это надо починить: пока копий нет, поломка компьютера означает потерю всего.`
                : st.backup_stale
                  ? (st.last_backup
                      ? `Последняя копия ${st.backup_hours_ago} ч назад, а должна делаться раз в сутки. Похоже, что-то мешает — нажмите «Скачать резервную копию» справа и посмотрите, пройдёт ли.`
                      : 'Копий ещё не было. Нажмите «Скачать резервную копию» справа.')
                  : `Последняя копия: ${ui.dt(st.last_backup)}. Не забывайте забирать её наружу — кнопка справа.`)}
            ${st.disk_free_mb === null ? '' : row(!st.disk_low, 'Место на диске',
              st.disk_low
                ? `Свободно всего ${st.disk_free_mb} МБ. Когда место кончится, копии перестанут делаться, а система — записывать продажи. Освободите место.`
                : `Свободно ${st.disk_free_mb >= 1024 ? (st.disk_free_mb / 1024).toFixed(1) + ' ГБ' : st.disk_free_mb + ' МБ'} — хватает.`)}
            ${row(secure, 'Защищённое соединение (https)',
              secure
                ? 'Соединение зашифровано: пароли и цены нельзя подсмотреть по дороге.'
                : 'Сейчас соединение обычное. Внутри магазинного Wi-Fi это допустимо. Когда система переедет в интернет, https нужен обязательно — иначе пароль виден любому в той же сети.')}
            ${row(true, 'Подбор пароля',
              'После пяти неудачных попыток вход закрывается на минуту, дальше пауза растёт до двух часов. Счёт идёт и по адресу, и по логину. Попытки видны в журнале действий.')}
            ${row(true, 'Закупочные цены',
              'Продавцы не получают их ни на экране, ни в ответах системы, и не могут стереть при правке изделия.')}
            ${row(devices > 0, 'Входы на устройствах',
              `Сейчас в системе устройств: ${devices}. Список — на вкладке «Сотрудники»; там же кнопка ⎋ завершает вход на всех устройствах человека.`)}
            ${row(ждут.length === 0, 'Вход только с разрешённых устройств',
              ждут.length
                ? `Прямо сейчас разрешения ждут: ${ждут.length}. Смотрите справа — если это не ваш сотрудник, отклоните и смените ему пароль.`
                : 'Знающий пароль не войдёт с чужого телефона: незнакомое устройство ждёт вашего разрешения. Разрешённых устройств: ' + разрешены.length + '.')}
          </div>
        </div>
        <div>
          ${ждут.length ? `
          <div class="card" style="border-color:var(--crit)">
            <h3 class="card-title">Просятся войти — ${ждут.length}</h3>
            <p class="muted" style="margin-top:0">Разрешайте, только если сотрудник сам просит вас об
              этом и называет тот же код. Если не просил — <b>отклоните</b>: значит его пароль
              у постороннего, и после отклонения сразу смените этому сотруднику пароль.</p>
            ${ждут.map(d => `
              <div class="row" style="align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)">
                <div class="login-wait-code" style="font-size:22px;margin:0;min-width:92px">${ui.esc(d.code)}</div>
                <div style="flex:1">
                  <div class="strong">${ui.esc(d.user_name)} <span class="muted">(${ui.esc(d.username)})</span></div>
                  <div class="muted">${ui.dt(d.created_at)}${d.last_ip ? ' · адрес ' + ui.esc(d.last_ip) : ''}</div>
                  ${d.name ? `<div class="muted" style="font-size:12px">${ui.esc(d.name)}</div>` : ''}
                </div>
                <button class="btn btn-primary" data-approve="${d.id}">Разрешить</button>
                <button class="btn btn-danger" data-deny="${d.id}">Отклонить</button>
              </div>`).join('')}
          </div>` : ''}
          ${разрешены.length ? `
          <div class="card">
            <h3 class="card-title">Разрешённые устройства — ${разрешены.length}</h3>
            <p class="muted" style="margin-top:0">Если устройство пропало или его больше нет
              у сотрудника — отклоните: вход с него прекратится сразу.</p>
            ${разрешены.map(d => `
              <div class="row" style="align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)">
                <div style="flex:1">
                  <div class="strong">${ui.esc(d.user_name)} <span class="muted">(${ui.esc(d.username)})</span></div>
                  <div class="muted">код ${ui.esc(d.code)}${d.last_seen ? ' · был(а) ' + ui.dt(d.last_seen) : ''}${d.last_ip ? ' · ' + ui.esc(d.last_ip) : ''}</div>
                </div>
                <button class="btn btn-danger" data-deny="${d.id}">Убрать</button>
              </div>`).join('')}
          </div>` : ''}
          <div class="card">
            <h3 class="card-title">Резервная копия</h3>
            <p class="muted" style="margin-top:0">Система и так делает копию раз в сутки, но кладёт её
              рядом с базой. Пропадёт компьютер — пропадут и копии. Нажмите кнопку, сохраните файл
              в облако или на флешку, и данные переживут что угодно.</p>
            <a class="btn btn-primary" href="/api/backup/download" download>Скачать резервную копию</a>
            <p class="form-hint">Один архив — вся система целиком: изделия, продажи, клиенты, долги,
              журнал и все фотографии. Восстановление: закрыть систему, распаковать архив в её
              папку, заменив <code>data</code>. Внутри архива лежит записка с этими же шагами.</p>
          </div>
          <div class="card">
            <h3 class="card-title">Правила, о которых стоит помнить</h3>
            <ul class="muted" style="margin:0;padding-left:18px;line-height:1.7">
              <li>У каждого сотрудника свой логин — общий обесценивает журнал.</li>
              <li>Уволился — не удаляйте, снимите «Активен»: вход закроется сразу,
                а его продажи останутся в истории.</li>
              <li>Потеряли телефон — нажмите ⎋ у этого сотрудника.</li>
              <li>Пароль не короче 8 знаков и не из тех, что подбирают первыми.</li>
            </ul>
          </div>
        </div>
      </div>`;

    box.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api.post(`/api/devices/${b.dataset.approve}/approve`);
        ui.toast('Устройство разрешено — сотрудник войдёт сам');
        await renderSecurity(box);
      } catch (e) { b.disabled = false; ui.toastErr(e); }
    }));
    box.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', async () => {
      if (!await ui.confirmDialog('Отклонить это устройство? Вход с него прекратится сразу.', { danger: true, okLabel: 'Отклонить' })) return;
      b.disabled = true;
      try {
        const r = await api.post(`/api/devices/${b.dataset.deny}/deny`);
        ui.toast(r && r.dropped ? `Отклонено, завершено входов: ${r.dropped}` : 'Устройство отклонено');
        await renderSecurity(box);
      } catch (e) { b.disabled = false; ui.toastErr(e); }
    }));
  }

  return {
    title: 'Настройки',
    async render(el) {
      const admin = App.isAdmin();
      const tabs = admin
        ? [['store', 'Магазин'], ['stores', 'Точки продаж'], ['refs', 'Справочники'],
           ['users', 'Сотрудники'], ['audit', 'Журнал действий'],
           ['security', 'Безопасность'], ['me', 'Мой пароль']]
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
          if (key === 'security') await renderSecurity(body);
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
