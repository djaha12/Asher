'use strict';
window.Pages = window.Pages || {};

/*
 * Панель основателя: кто что делает.
 *
 * Журнал действий отвечает на вопрос «что сделал этот человек в тот день» —
 * для этого его надо открыть, выбрать сотрудника, выставить даты. Панель
 * отвечает на другой вопрос, с которого основатель начинает утро: «всё ли
 * в порядке у людей». Кто входил и когда, кто продавал и на сколько, кто
 * давал скидки, кто что удалял, кто просится с нового телефона — одним
 * экраном, без отбора. И здесь же заводятся люди: бухгалтер и продавцы,
 * с придуманным паролем, за одно окно.
 *
 * Видит её только основатель — сервер отдаёт данные только ему, меню
 * показывает пункт только ему. Бухгалтер имеет тот же доступ, что
 * основатель, кроме ровно этого.
 */
window.Pages.team = (() => {
  const ПЕРИОДЫ = [[1, 'Сегодня'], [7, '7 дней'], [30, '30 дней']];
  // Оба переживают перерисовку: страница обновляется сама каждые несколько
  // секунд, и выбранный период с выбранным человеком сбрасываться не должны.
  let период = 1;
  let выбранный = null;
  let очередь = 0;

  /*
   * Пароль для нового сотрудника. Без похожих знаков (0/O, 1/l/I): его будут
   * переписывать с экрана на карточку. Двенадцать знаков из этого набора —
   * больше, чем нужно, чтобы подбор не имел смысла.
   */
  function придуматьПароль() {
    const знаки = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
    const байты = new Uint8Array(12);
    crypto.getRandomValues(байты);
    let out = '';
    for (const b of байты) out += знаки[b % знаки.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
  }

  // «5 мин назад», «вчера» — для колонки «был в системе»: точная дата
  // и время там нужны реже, чем ощущение «давно ли».
  function давно(iso) {
    if (!iso) return '<span class="dim">ни разу</span>';
    const мин = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (мин < 1) return 'только что';
    if (мин < 60) return `${мин} мин назад`;
    const ч = Math.round(мин / 60);
    if (ч < 24) return `${ч} ч назад`;
    const д = Math.round(ч / 24);
    if (д === 1) return 'вчера';
    if (д < 30) return `${д} дн назад`;
    return ui.dt(iso);
  }

  const тире = '<span class="dim">—</span>';
  const число = n => (n ? String(n) : тире);

  function тревоги(a, дней) {
    const за = дней === 1 ? 'сегодня' : `за ${дней} дней`;
    const list = [];
    if (a.pending_devices.length) {
      list.push({
        плохо: true,
        что: `Ждут разрешения: ${a.pending_devices.length} ${a.pending_devices.length === 1 ? 'устройство' : 'устройств'}`,
        почему: a.pending_devices.map(d =>
          `${d.user_name} — код ${d.code}${d.last_ip ? `, адрес ${d.last_ip}` : ''}`).join('; '),
        делать: 'Если человек звонил и называл этот код — разрешите в Настройках → Безопасность. Если не звонил — пароль знает кто-то ещё.',
      });
    }
    if (a.failed_logins) {
      list.push({
        плохо: true,
        что: `Неверный пароль вводили ${a.failed_logins} раз ${за}`,
        почему: 'Кто-то несколько раз подряд пробовал войти и не смог',
        делать: 'Спросите у сотрудников. Если никто — смените пароли.',
      });
    }
    if (a.over_discounts) {
      list.push({
        что: `Скидок сверх предела продавца: ${a.over_discounts} ${за}`,
        почему: 'Такие скидки проводит основатель или бухгалтер',
        делать: 'Стоит помнить, кому и за что — ниже в ленте они отмечены.',
      });
    }
    if (a.deletes) {
      list.push({
        что: `Удалений: ${a.deletes} ${за}`,
        почему: 'Удалённое не восстанавливается кнопкой',
        делать: 'Посмотрите в ленте, что и кем удалено.',
      });
    }
    if (!list.length) return '';
    return `<div class="alert-box">${list.map(т => `
      <div class="alert-row ${т.плохо ? 'alert-bad' : 'alert-warn'}">
        <div class="alert-ico">${т.плохо ? '!' : '?'}</div>
        <div>
          <div class="alert-what">${ui.esc(т.что)}</div>
          <div class="alert-why">${ui.esc(т.почему)}. ${ui.esc(т.делать)}</div>
        </div>
      </div>`).join('')}</div>`;
  }

  function таблицаЛюдей(people) {
    const { roleBadge } = Pages.settings;
    return ui.table([
      { title: 'Кто', render: p => `<span class="strong">${ui.esc(p.name)}</span> ${roleBadge(p.role)}
        <div class="dim" style="font-size:12px">${ui.esc(p.username)}</div>` },
      { title: 'Был в системе', render: p => `${давно(p.last_action)}
        ${p.pending_devices ? '<div><span class="badge badge-crit">ждёт новое устройство</span></div>' : ''}
        ${p.sessions ? `<div class="dim" style="font-size:12px">вход открыт: ${p.sessions}</div>` : ''}` },
      { title: 'Продажи', cls: 'num', render: p => p.period.sales
        ? `<b>${p.period.sales}</b><div class="dim">${ui.money(p.period.revenue)}</div>` : тире },
      { title: 'Скидки', cls: 'num', render: p => p.period.discount
        ? `${ui.money(p.period.discount)}${p.period.over_discounts
          ? `<div><span class="badge badge-warn">сверх предела: ${p.period.over_discounts}</span></div>` : ''}`
        : тире },
      { title: 'Возвраты и обмены', cls: 'num', render: p => число(p.period.returns) },
      { title: 'Оплаты долгов', cls: 'num', render: p => число(p.period.payments) },
      { title: 'Заведено / правок', cls: 'num', render: p =>
        `${число(p.period.created)} / ${число(p.period.edits)}${p.period.deletes
          ? `<div><span class="badge badge-warn">удалений: ${p.period.deletes}</span></div>` : ''}` },
      { title: 'Действий', cls: 'num', render: p => число(p.period.actions) },
      { title: '', cls: 'nowrap', render: p =>
        `<button class="btn btn-sm" data-person="${p.id}" data-person-name="${ui.esc(p.name)}">Действия →</button>` },
    ], people, { empty: 'Пока никого нет' });
  }

  function таблицаЛенты(rows) {
    const { roleBadge, AUDIT_ACTIONS, AUDIT_ENTITIES } = Pages.settings;
    return ui.table([
      { title: 'Когда', cls: 'nowrap', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
      { title: 'Кто', render: r => r.user_name
        ? `${ui.esc(r.user_name)} ${roleBadge(r.user_role, true)}`
        : '<span class="dim">система</span>' },
      { title: 'Действие', render: r =>
        `<span class="badge ${r.action === 'delete' || r.action === 'discount' || r.action === 'login_failed'
          || r.action === 'device_new' ? 'badge-warn' : 'badge-gray'}">${ui.esc(AUDIT_ACTIONS[r.action] || r.action)}</span>` },
      { title: 'Что', render: r => `<span class="dim">${ui.esc(AUDIT_ENTITIES[r.entity] || r.entity)}</span>` },
      { title: 'Подробности', render: r => ui.esc(r.details || '—') },
    ], rows, { empty: 'Действий пока не было' });
  }

  async function рисоватьЛенту(el, data) {
    const box = el.querySelector('#team-feed');
    const title = el.querySelector('#team-feed-title');
    if (!box) return;
    if (выбранный) {
      const человек = data.people.find(p => p.id === выбранный);
      const имя = человек ? человек.name : '';
      title.innerHTML = `Лента действий — ${ui.esc(имя)}
        <button class="btn btn-sm" id="team-feed-all" style="margin-left:10px">Все</button>`;
      title.querySelector('#team-feed-all').addEventListener('click', () => {
        выбранный = null;
        рисоватьЛенту(el, data).catch(ui.toastErr);
      });
      box.innerHTML = '<div class="empty"><p>Загрузка…</p></div>';
      const res = await api.get(`/api/audit?user_id=${выбранный}&limit=60`);
      box.innerHTML = таблицаЛенты(res.items);
    } else {
      title.textContent = 'Лента действий — все';
      box.innerHTML = таблицаЛенты(data.feed);
    }
  }

  async function render(el) {
    const моя = ++очередь;
    const data = await api.get(`/api/team?days=${период}&tz=${api.tz()}`);
    if (моя !== очередь) return;   // пока ждали ответ, попросили перерисовать заново
    const t = data.totals;
    const r = data.roles;
    const за = период === 1 ? 'сегодня' : `за ${период} дней`;

    el.innerHTML = `
      <div class="toolbar">
        ${ПЕРИОДЫ.map(([d, name]) =>
          `<button class="btn ${d === период ? 'btn-primary' : ''}" data-days="${d}">${name}</button>`).join('')}
        <span class="spacer"></span>
        <span class="dim">Считается по часам магазина. Обновляется само.</span>
      </div>
      ${тревоги(data.alerts, период)}
      <div class="grid grid-4">
        <div class="stat-tile">
          <div class="stat-label">Продаж ${за}</div>
          <div class="stat-value">${t.sales}</div>
          <div class="stat-sub">${t.sales ? ui.money(t.revenue) : 'продаж не было'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Действий в системе</div>
          <div class="stat-value">${t.actions}</div>
          <div class="stat-sub">продажи, правки, входы — всё вместе</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Работали ${за}</div>
          <div class="stat-value">${t.worked}</div>
          <div class="stat-sub">из ${data.people.length} человек</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Вход открыт</div>
          <div class="stat-value">${t.online}</div>
          <div class="stat-sub">не выходили из системы</div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">Команда</h3>
        <div id="team-people">${таблицаЛюдей(data.people)}</div>
        <p class="form-hint">«Был в системе» — последнее действие человека, любое. «Вход открыт» —
          на скольких устройствах он вошёл и не вышел. Кнопка «Действия →» показывает ленту
          только этого человека; полный журнал с отбором по датам — в Настройках → Журнал действий.</p>
      </div>

      <div class="card">
        <h3 class="card-title">Учётные записи</h3>
        <div class="row" style="gap:22px;align-items:flex-start">
          <div>Основатель: <b>${r.owner}</b></div>
          <div>Бухгалтер: <b>${r.accountant}</b>
            ${r.accountant ? '' : ' <button class="btn btn-sm" data-add="accountant">+ Завести бухгалтера</button>'}</div>
          <div>Продавцы: <b>${r.seller}</b>
            <button class="btn btn-sm" data-add="seller">+ Завести продавца</button></div>
        </div>
        <p class="form-hint">Пароль новому сотруднику система придумает сама и покажет один раз —
          вместе с карточкой подключения телефона. Имя, роль и пароль потом можно поменять
          в Настройках → Сотрудники.</p>
      </div>

      <div class="card">
        <h3 class="card-title" id="team-feed-title">Лента действий</h3>
        <div id="team-feed"></div>
      </div>`;

    el.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => {
      период = Number(b.dataset.days);
      render(el).catch(ui.toastErr);
    }));
    el.querySelectorAll('[data-person]').forEach(b => b.addEventListener('click', () => {
      выбранный = Number(b.dataset.person);
      рисоватьЛенту(el, data).catch(ui.toastErr);
    }));
    el.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      Pages.settings.userDialog(null, () => render(el).catch(ui.toastErr),
        { role: b.dataset.add, password: придуматьПароль() });
    }));
    await рисоватьЛенту(el, data);
  }

  return { title: 'Панель основателя', render };
})();
