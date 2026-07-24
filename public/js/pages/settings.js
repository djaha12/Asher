'use strict';
window.Pages = window.Pages || {};

window.Pages.settings = (() => {
  async function renderStore(box) {
    const s = await api.get('/api/settings');
    box.innerHTML = `
      <div class="card" style="max-width:560px">
        <h3 class="card-title">Магазин</h3>
        <form id="st-form">
          <label class="field"><span>Название (печатается на чеках)</span><input name="store_name" value="${ui.esc(s.store_name)}"></label>
          <div class="form-grid">
            <label class="field"><span>Адрес</span><input name="store_address" value="${ui.esc(s.store_address)}"></label>
            <label class="field"><span>Телефон</span><input name="store_phone" value="${ui.esc(s.store_phone)}"></label>
          </div>
          <div class="form-grid">
            <label class="field"><span>Бонусы с покупки, %</span><input name="bonus_percent" type="number" min="0" max="50" step="0.5" value="${ui.esc(s.bonus_percent)}"></label>
            <label class="field"><span>Порог VIP-сегмента, ₽</span><input name="vip_threshold" type="number" min="0" step="10000" value="${ui.esc(s.vip_threshold || 500000)}"></label>
          </div>
          <button type="button" class="btn btn-primary" id="st-save">Сохранить</button>
        </form>
      </div>`;
    box.querySelector('#st-save').addEventListener('click', async () => {
      try {
        await api.put('/api/settings', ui.formValues(box.querySelector('#st-form')));
        ui.toast('Настройки сохранены');
        App.storeName = box.querySelector('[name=store_name]').value || 'Asher';
        document.getElementById('brand-name').textContent = App.storeName;
      } catch (e) { ui.toastErr(e); }
    });
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
        <label class="field"><span>${isNew ? 'Пароль *' : 'Новый пароль (не обязательно)'}</span>
          <input name="password" type="password" ${isNew ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
        ${!isNew ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="active" ${u.active ? 'checked' : ''} style="width:auto"> <span style="font-weight:400">Активен (может входить в систему)</span></label>` : ''}
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">${isNew ? 'Создать' : 'Сохранить'}</button>`,
    });
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

  async function renderAudit(box) {
    const { items } = await api.get('/api/audit');
    const actionRu = { login: 'вход', create: 'создание', update: 'изменение', delete: 'удаление',
      sale: 'продажа', return: 'возврат', status: 'статус', payment: 'оплата', import: 'импорт', password: 'пароль' };
    const entityRu = { product: 'изделие', customer: 'клиент', sale: 'продажа', order: 'заказ',
      finance: 'финансы', user: 'сотрудник', category: 'категория', supplier: 'поставщик',
      settings: 'настройки', products: 'изделия', customers: 'клиенты' };
    box.innerHTML = `<div class="card">
      <h3 class="card-title">Журнал операций (последние 500)</h3>
      ${ui.table([
        { title: 'Когда', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
        { title: 'Кто', render: r => ui.esc(r.user_name || '—') },
        { title: 'Действие', render: r => `<span class="badge badge-gray">${actionRu[r.action] || r.action}</span>` },
        { title: 'Объект', render: r => entityRu[r.entity] || r.entity },
        { title: 'Детали', render: r => `<span class="dim">${ui.esc(r.details)}</span>` },
      ], items, { empty: 'Журнал пуст' })}
    </div>`;
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
           ['users', 'Сотрудники'], ['audit', 'Журнал'], ['me', 'Мой пароль']]
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
