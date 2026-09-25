'use strict';
window.Pages = window.Pages || {};

/*
 * Главная. Сверху — то, что владелец хочет видеть каждое утро:
 * деньги за день и месяц, кто сколько должен, склад в деньгах и граммах.
 */
window.Pages.dashboard = {
  title: 'Главная',
  async render(el) {
    const админ = App.isAdmin();
    const [d, bd, касса, скидкиЖдут, сводка] = await Promise.all([
      api.get('/api/dashboard?tz=' + api.tz()),
      api.get('/api/customers/occasions?days=14&today=' + new Date(Date.now() + api.tz() * 60000).toISOString().slice(0, 10)),
      // Сданная смена и сдачи денег владельцу — если не ответило, Главная всё равно открывается.
      api.get('/api/cash/pending').catch(() => ({ смена: null, сдачи: [] })),
      админ ? api.get('/api/discount-requests?status=pending').catch(() => ({ items: [] })) : { items: [] },
      админ ? api.get(`/api/summary/day?tz=${api.tz()}${Pages.dashboard._день ? '&date=' + Pages.dashboard._день : ''}`)
        .catch(() => null) : null,
    ]);
    if (!el.isConnected) return;
    Pages.dashboard._el = el;
    const admin = App.isAdmin();
    // «1 продажа», «3 продажи», «11 продаж».
    const продаж = n => (n % 100 >= 11 && n % 100 <= 14) ? 'продаж'
      : n % 10 === 1 ? 'продажа' : (n % 10 >= 2 && n % 10 <= 4) ? 'продажи' : 'продаж';
    const debts = d.debts || { customers_owe: 0, overdue: 0, debtors_count: 0, top: [] };

    // Разбивка склада по металлам — показываем три самых весомых.
    const metals = (d.stock.by_metal || []).filter(m => m.weight > 0).slice(0, 3);

    /*
     * Тревоги — самым первым, до денег.
     *
     * Это единственное место, где владелец узнает, что копии перестали
     * делаться или что кто-то просится войти. Ниже по странице он бы это
     * пролистал: там цифры, за которыми он и приходит.
     */
    const тревоги = (d['тревоги'] || []).map(т => `
      <div class="alert-row ${т['уровень'] === 'плохо' ? 'alert-bad' : 'alert-warn'}">
        <div class="alert-ico">${т['уровень'] === 'плохо' ? '!' : '?'}</div>
        <div>
          <div class="alert-what">${ui.esc(т['что'])}</div>
          <div class="alert-why">${ui.esc(т['почему'])}. ${ui.esc(т['делать'])}</div>
        </div>
      </div>`).join('');

    /*
     * Касса — тоже первым делом. Смену сдают, пока оба продавца у ящика:
     * через час расхождение уже не найти. А сданные владельцу деньги
     * подтверждает тот, кому их отдали, — и чем раньше, тем лучше.
     */
    const смена = касса['смена'];
    const сменаHtml = смена ? `
      <div class="alert-row alert-warn alert-act" id="dash-shift">
        <div class="alert-ico">→</div>
        <div class="grow">
          <div class="alert-what">Смену сдаёт ${ui.esc(смена['кто'])}: в ящике ${ui.money(смена['сдано'])}</div>
          <div class="alert-why">Сдано ${ui.dt(смена['когда'])}. Пересчитайте деньги вместе и примите смену — пока вы оба здесь,
            любое расхождение легко найти.</div>
        </div>
        <button class="btn btn-sm btn-primary" id="qa-accept">Принять смену</button>
      </div>` : '';
    const сдачиHtml = (касса['сдачи'] || []).map(с => `
      <div class="alert-row alert-warn alert-act" data-move="${с.id}">
        <div class="alert-ico">?</div>
        <div class="grow">
          <div class="alert-what">${ui.esc(с.user_name || '—')} сдаёт из кассы ${App.user && с.other_user_id === App.user.id
            ? 'вам' : ui.esc(с.other_name || '')} ${ui.money(с.amount)}</div>
          <div class="alert-why">${ui.dt(с.created_at)}${с.note ? ' · ' + ui.esc(с.note) : ''}. Подтвердите, что деньги у вас, —
            или отметьте, что не получали.</div>
        </div>
        <div class="alert-actions">
          <button class="btn btn-sm btn-primary" data-move-ok="${с.id}">Деньги у меня</button>
          <button class="btn btn-sm" data-move-no="${с.id}">Не получено</button>
        </div>
      </div>`).join('');
    /*
     * Продавец просит скидку сверх предела — у прилавка ждёт клиент.
     * Поэтому это самое первое, что видит владелец, с кнопками прямо здесь.
     */
    const скидкиHtml = (скидкиЖдут.items || []).map(з => `
      <div class="alert-row alert-warn alert-act" data-dr="${з.id}">
        <div class="alert-ico">%</div>
        <div class="grow">
          <div class="alert-what">${ui.esc(з.user_name)} просит скидку ${ui.money(з.total_discount)}${
            з.customer_name ? ' для ' + ui.esc(з.customer_name) : ''}</div>
          <div class="alert-why">${з.items.map(i => `${ui.esc(i.name)}: ${ui.money(i.price)}, скидка ${ui.money(i.discount)}
            (${ui.num(i.percent, 1)}%)`).join('; ')}${з.note ? `. «${ui.esc(з.note)}»` : ''}</div>
        </div>
        <div class="alert-actions">
          <button class="btn btn-sm btn-primary" data-dr-ok="${з.id}">Разрешить</button>
          <button class="btn btn-sm" data-dr-no="${з.id}">Отказать</button>
        </div>
      </div>`).join('');
    /*
     * Новое устройство — поимённо и с кодом. Сотрудник видит тот же код
     * у себя на экране: совпал — разрешайте одним нажатием. Раньше путь
     * лежал через Настройки → Безопасность, а человек стоял и ждал.
     */
    const устройстваHtml = (d['устройства'] || []).map(у => `
      <div class="alert-row alert-warn alert-act" data-dev="${у.id}">
        <div class="alert-ico">?</div>
        <div class="grow">
          <div class="alert-what">${ui.esc(у.user_name)} просится войти с нового устройства</div>
          <div class="alert-why">Код <b>${ui.esc(у.code)}</b>${у.name ? ' · ' + ui.esc(у.name) : ''} · ${ui.dt(у.created_at)}${
            у.last_ip ? ' · ' + ui.esc(у.last_ip) : ''}. Спросите у сотрудника код с его экрана: совпал — разрешайте.
            Не ваш сотрудник — отклоните.</div>
        </div>
        <div class="alert-actions">
          <button class="btn btn-sm btn-primary" data-dev-ok="${у.id}">Разрешить</button>
          <button class="btn btn-sm" data-dev-no="${у.id}">Отклонить</button>
        </div>
      </div>`).join('');
    const наверху = скидкиHtml + устройстваHtml + сменаHtml + сдачиHtml + тревоги;

    el.innerHTML = `
      ${наверху ? `<div class="alert-box">${наверху}</div>` : ''}
      ${сводка ? сводкаHtml(сводка) : ''}
      <div class="grid grid-4">
        <div class="big-stat accent-good">
          <div class="bs-label">Продали сегодня</div>
          <div class="bs-value">${ui.moneyRich(d.today.revenue)}</div>
          <div class="bs-sub">${d.today.sales_count
            ? `${d.today.sales_count} ${продаж(d.today.sales_count)}, средний чек ${ui.money(d.today.avg_check)}`
            : 'Продаж пока не было'}</div>
        </div>
        <div class="big-stat accent-gold">
          <div class="bs-label">Продали за месяц</div>
          <div class="bs-value">${ui.moneyRich(d.month.revenue)}</div>
          <div class="bs-sub">${admin
            ? `Заработали чистыми <b class="good">${ui.money(d.month.profit)}</b>`
            : `${d.month.sales_count} ${продаж(d.month.sales_count)}`}</div>
        </div>
        <div class="big-stat ${debts.overdue > 0 ? 'accent-crit' : ''}">
          <div class="bs-label">Должны нам</div>
          <div class="bs-value ${debts.overdue > 0 ? 'crit' : ''}">${ui.moneyRich(debts.customers_owe)}</div>
          <div class="bs-sub">${debts.customers_owe > 0
            ? `${debts.debtors_count} чел.` + (debts.overdue > 0
              ? ` · <b class="crit">просрочено ${ui.money(debts.overdue)}</b>` : ' · всё в срок')
            : 'Долгов нет'}</div>
        </div>
        <div class="big-stat">
          <div class="bs-label">Товара на складе</div>
          <div class="bs-value">${admin ? ui.moneyRich(d.stock.retail_value) : ui.num(d.stock.count) + ' шт'}</div>
          <div class="bs-sub">${ui.num(d.stock.count)} изделий · <b>${ui.num(d.stock.weight)} г</b>
            ${d.reserved ? ` · ${d.reserved} в резерве` : ''}</div>
        </div>
      </div>

      ${admin && debts.we_owe > 0 ? `
        <div class="card" style="margin-top:18px;border-left:4px solid var(--warn)">
          <div class="row">
            <div class="grow">
              <div class="stat-label">Мы должны поставщикам</div>
              <div class="big-money">${ui.moneyRich(debts.we_owe)}</div>
            </div>
            <button class="btn" id="qa-suppliers">Открыть расчёты</button>
          </div>
        </div>` : ''}

      <div class="two-col" style="margin-top:18px">
        <div>
          <div class="card">
            <h3 class="card-title">Выручка за 14 дней</h3>
            <div id="dash-chart"></div>
          </div>

          ${debts.top.length ? `<div class="card">
            <h3 class="card-title">Кто нам должен</h3>
            <div id="dash-debtors"></div>
            <button class="btn btn-block" id="qa-debts" style="margin-top:12px">Все долги и приём оплаты →</button>
          </div>` : ''}

          <div class="card">
            <h3 class="card-title">Последние продажи</h3>
            <div id="dash-recent"></div>
          </div>
        </div>

        <div>
          <div class="card">
            <h3 class="card-title">Быстрые действия</h3>
            <div style="display:flex;flex-direction:column;gap:9px">
              <button class="btn btn-primary" id="qa-sale">${ui.icon('plus')} Оформить продажу</button>
              <button class="btn" id="qa-pay">${ui.icon('money')} Принять оплату долга</button>
              <button class="btn" id="qa-product">${ui.icon('gem')} Добавить изделие</button>
              <button class="btn" id="qa-customer">${ui.icon('users')} Новый клиент</button>
              <button class="btn" id="qa-order">${ui.icon('wrench')} Принять заказ / ремонт</button>
              <button class="btn" id="qa-cash">${ui.icon('wallet')} Сверить кассу</button>
            </div>
          </div>

          ${metals.length ? `<div class="card">
            <h3 class="card-title">Склад по металлам</h3>
            ${metals.map(m => `
              <div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">
                <div class="grow">
                  <div style="font-weight:600">${ui.esc(m.metal)}</div>
                  <div class="muted" style="font-size:13px">${m.cnt} изделий</div>
                </div>
                <div style="text-align:right">
                  <div class="big-money">${ui.num(m.weight)} г</div>
                  ${admin ? `<div class="muted" style="font-size:13px">${ui.money(m.retail)}</div>` : ''}
                </div>
              </div>`).join('')}
          </div>` : ''}

          <div class="card">
            <h3 class="card-title">Заказы и ремонт</h3>
            <div class="row" style="padding:6px 0">
              <div class="grow">В работе</div><div class="big-money">${d.orders.active}</div>
            </div>
            <div class="row" style="padding:6px 0;border-top:1px solid var(--line)">
              <div class="grow">Готовы к выдаче</div>
              <div class="big-money ${d.orders.ready ? 'good' : ''}">${d.orders.ready}</div>
            </div>
          </div>

          <div class="card">
            <h3 class="card-title">Поводы связаться</h3>
            <div id="dash-bd"></div>
          </div>
        </div>
      </div>`;

    charts.lineChart(el.querySelector('#dash-chart'), {
      labels: d.revenue_14d.map(r => r.date),
      series: [{ name: 'Выручка', color: '#2a78d6', values: d.revenue_14d.map(r => r.revenue) }],
      height: 230,
    });

    const debtorsEl = el.querySelector('#dash-debtors');
    if (debtorsEl) {
      debtorsEl.innerHTML = debts.top.map(t => `
        <div class="debt-row ${t.overdue ? 'overdue' : ''}">
          <div>
            <div class="dr-name">${ui.esc(t.name)}</div>
            <div class="dr-sub">${ui.esc(t.phone || 'телефон не указан')}</div>
          </div>
          <div class="dr-sum">
            <div class="dr-amount">${ui.moneyRich(t.debt)}</div>
            ${t.overdue ? '<div class="dr-sub crit">просрочено</div>' : ''}
          </div>
        </div>`).join('');
      debtorsEl.querySelectorAll('.debt-row').forEach(row => {
        row.addEventListener('click', () => App.go('#/debts'));
      });
    }

    const recent = el.querySelector('#dash-recent');
    recent.innerHTML = ui.table([
      { title: 'Чек', render: r => `<span class="strong">${ui.esc(r.number)}</span>` },
      { title: 'Когда', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
      { title: 'Клиент', render: r => ui.esc(r.customer_name || '—') },
      { title: 'Сумма', cls: 'num strong', render: r => ui.money(r.total) },
    ], d.recent_sales, { empty: 'Продаж пока нет — самое время оформить первую!' });
    ui.bindRows(recent, d.recent_sales, r => App.go('#/sales/' + r.id));

    /*
     * Поводы связаться: праздники, «спасибо за покупку» через пару дней,
     * приглашение почистить изделие через полгода. У каждого — WhatsApp
     * с готовым текстом; кому написали, из списка пропадает у всех — чтобы
     * два продавца не поздравили одного человека дважды.
     */
    const bdEl = el.querySelector('#dash-bd');
    const магазин = App.storeName || 'наш магазин';
    const повод = {
      birthday: b => ({ что: b.in_days === 0 ? 'День рождения сегодня' : 'День рождения',
        текст: `Здравствуйте! ${магазин} от всей души поздравляет вас с днём рождения! Счастья, радости и красоты. Будем рады видеть вас в гостях.` }),
      anniversary: b => ({ что: b.in_days === 0 ? 'Годовщина сегодня' : 'Годовщина',
        текст: `Здравствуйте! ${магазин} поздравляет вас с годовщиной! Счастья и любви вашей семье.` }),
      thanks: b => ({ что: `Покупка ${ui.dateOnly(b.date)} — сказать спасибо`,
        текст: `Здравствуйте! Спасибо за покупку в ${магазин}. Если появятся вопросы по изделию — пишите, всегда поможем.` }),
      cleaning: b => ({ что: `Покупка полгода назад — пригласить почистить`,
        текст: `Здравствуйте! Полгода назад вы выбрали украшение в ${магазин}. Приходите — почистим его и проверим закрепку камней.` }),
    };
    const показать = items => {
      if (!items.length) {
        bdEl.innerHTML = '<p class="muted" style="margin:4px 0">Сегодня поводов нет: праздников в ближайшие две недели и свежих покупок не было.</p>';
        return;
      }
      bdEl.innerHTML = items.slice(0, 8).map((b, i) => {
        const п = повод[b.kind](b);
        const wa = b.phone ? ui.whatsappLink(b.phone, п.текст) : '';
        const когда = b.in_days === undefined ? ''
          : `<span class="badge ${b.in_days <= 3 ? 'badge-gold' : 'badge-gray'}">${b.in_days === 0 ? 'сегодня!' : 'через ' + b.in_days + ' дн.'}</span>`;
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
          <div>
            <a href="#/customers/${b.id}">${ui.esc(b.name)}</a>
            <div class="muted" style="font-size:13px">${ui.esc(п.что)} · ${ui.esc(b.phone || 'без телефона')}</div>
          </div>
          <span class="row-tight" style="gap:6px">${когда}
            ${wa ? `<a class="btn btn-sm" href="${ui.esc(wa)}" target="_blank" rel="noopener" data-occ="${i}">WhatsApp</a>` : ''}</span>
        </div>`;
      }).join('');
      bdEl.querySelectorAll('[data-occ]').forEach(a => a.addEventListener('click', () => {
        const b = items[Number(a.dataset.occ)];
        // Ссылка открывается сама; отметку ставим параллельно и убираем строку.
        api.post(`/api/customers/${b.id}/contacted`, { kind: b.kind, ref: b.ref }).catch(() => {});
        показать(items.filter(x => x !== b));
      }));
    };
    показать(bd.items);

    const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.onclick = fn; };
    on('qa-sale', () => Pages.sales.newSale());
    on('qa-pay', () => App.go('#/debts'));
    on('qa-debts', () => App.go('#/debts'));
    on('qa-suppliers', () => App.go('#/debts'));
    on('qa-product', () => { App.go('#/products'); setTimeout(() => Pages.products.openEditor(), 100); });
    on('qa-customer', () => { App.go('#/customers'); setTimeout(() => Pages.customers.openEditor(), 100); });
    on('qa-order', () => { App.go('#/orders'); setTimeout(() => Pages.orders.openEditor(), 100); });
    on('qa-cash', () => сверкаКассы());
    on('qa-accept', () => сверкаКассы('accept'));
    const отметить = async (b, действие) => {
      try {
        await api.post(`/api/cash/moves/${b.dataset[действие === 'confirm' ? 'moveOk' : 'moveNo']}/${действие}`, {});
        ui.toast(действие === 'confirm' ? 'Отмечено: деньги у вас' : 'Отмечено: не получено');
        b.closest('.alert-row').remove();
      } catch (e) { ui.toastErr(e); }
    };
    el.querySelectorAll('[data-move-ok]').forEach(b => { b.onclick = () => отметить(b, 'confirm'); });
    // Ответ на запрос скидки и разрешение устройства — одним нажатием, строка уходит.
    const ответить = async (b, путь, текст) => {
      b.disabled = true;
      try {
        await api.post(путь, {});
        ui.toast(текст);
        b.closest('.alert-row').remove();
      } catch (e) { b.disabled = false; ui.toastErr(e); }
    };
    el.querySelectorAll('[data-dr-ok]').forEach(b => {
      b.onclick = () => ответить(b, `/api/discount-requests/${b.dataset.drOk}/approve`, 'Скидка разрешена — у продавца она встанет в чек сама');
    });
    el.querySelectorAll('[data-dr-no]').forEach(b => {
      b.onclick = () => ответить(b, `/api/discount-requests/${b.dataset.drNo}/deny`, 'Отказано — продавец увидит это в кассе');
    });
    el.querySelectorAll('[data-dev-ok]').forEach(b => {
      b.onclick = () => ответить(b, `/api/devices/${b.dataset.devOk}/approve`, 'Устройство разрешено — сотрудник войдёт сам');
    });
    el.querySelectorAll('[data-dev-no]').forEach(b => {
      b.onclick = async () => {
        if (!await ui.confirmDialog('Отклонить это устройство? Если это чужой человек, все его входы закроются сразу.',
          { danger: true, okLabel: 'Отклонить' })) return;
        ответить(b, `/api/devices/${b.dataset.devNo}/deny`, 'Устройство отклонено');
      };
    });
    // Сводка: вчера или сегодня, и отправить сообщением.
    el.querySelectorAll('[data-sum]').forEach(b => {
      b.onclick = () => {
        Pages.dashboard._день = b.dataset.sum === 'today'
          ? new Date(Date.now() + api.tz() * 60000).toISOString().slice(0, 10) : '';
        перерисоватьГлавную();
      };
    });
    const отправитьСводку = el.querySelector('[data-sum-wa]');
    if (отправитьСводку && сводка) {
      отправитьСводку.onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(сводкаТекст(сводка)), '_blank', 'noopener');
    }
    el.querySelectorAll('[data-move-no]').forEach(b => {
      b.onclick = async () => {
        if (!await ui.confirmDialog('Отметить, что этих денег вы не получали? Отметка останется в истории.',
          { danger: true, okLabel: 'Не получено' })) return;
        отметить(b, 'dispute');
      };
    });
  },
};

/*
 * Сводка за день для владельца: утром — за вчера, вечером можно глянуть
 * «сегодня». Только то, что стоит прочесть: нули не показываем.
 */
function строкиСводки(с) {
  const п = с['продажи'];
  const о = с['оплаты'];
  const к = с['касса'];
  const чеков = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'чек' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? 'чека' : 'чеков'}`;
  const деньги = [о['наличными'] && `наличными ${ui.money(о['наличными'])}`, о['картой'] && `картой ${ui.money(о['картой'])}`,
    о['переводом'] && `переводом ${ui.money(о['переводом'])}`].filter(Boolean).join(' · ');
  const касса = к['сверок']
    ? (к['расхождения'].length
      ? к['расхождения'].map(р => `${р['разница'] < 0 ? 'недостача' : 'излишек'} ${ui.money(Math.abs(р['разница']))} (${р['кто']}${
        р['вид'] === 'accept' ? ', приём смены' : р['вид'] === 'handover' ? ', сдача смены' : ''})`).join('; ')
      : `${к['сверок']} ${к['сверок'] === 1 ? 'сверка' : 'сверки'} — всё сошлось`)
    : '';
  return [
    ['Продали', п['чеков'] ? `${ui.money(п['выручка'])}, ${чеков(п['чеков'])} (средний ${ui.money(п['средний'])})` : 'продаж не было', !п['чеков']],
    ['Заработали', п['чеков'] ? ui.money(п['прибыль']) : ''],
    ['Деньги пришли', деньги],
    ['Погашено долгов', о['долгов_погашено'] ? ui.money(о['долгов_погашено']) : ''],
    ['Не оплачено из этих чеков', с['не_оплачено'] ? ui.money(с['не_оплачено']) : ''],
    ['Возвраты', с['возвраты']['штук'] ? `${с['возвраты']['штук']} на ${ui.money(с['возвраты']['сумма'])}` : ''],
    ['Продавцы', с['продавцы'].map(x => `${x.name} — ${чеков(x['чеков'])}, ${ui.money(x['выручка'])}`).join('; ')],
    ['Касса', касса, к['недостача'] < 0],
    ['Смену никто не принял', к['смен_без_приёма'] ? String(к['смен_без_приёма']) : '', true],
    ['Сдано владельцу', к['сдано_владельцу'] ? ui.money(к['сдано_владельцу']) + (к['не_получено'] ? ` (не получено: ${ui.money(к['не_получено'])})` : '') : '', к['не_получено'] > 0],
    ['Скидки сверх предела', с['скидки']['сверх_предела'] ? `${с['скидки']['сверх_предела']}${
      с['скидки']['по_разрешению'] ? ` (по разрешению: ${с['скидки']['по_разрешению']})` : ''}` : ''],
    ['Ремонт', с['ремонт']['принято'] || с['ремонт']['выдано'] ? `принято ${с['ремонт']['принято']}, выдано ${с['ремонт']['выдано']}` : ''],
    ['Новых клиентов', с['клиенты']['новых'] ? String(с['клиенты']['новых']) : ''],
  ].filter(([, v]) => v);
}

function сводкаHtml(с) {
  const сегодня = new Date(Date.now() + api.tz() * 60000).toISOString().slice(0, 10);
  const заСегодня = с['дата'] === сегодня;
  return `<div class="card" id="dash-summary" style="margin-bottom:18px">
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <h3 class="card-title" style="margin:0">Сводка за ${заСегодня ? 'сегодня' : 'вчера'}, ${ui.dateOnly(с['дата'])}</h3>
      <div class="row-tight" style="gap:6px;flex-wrap:wrap">
        <button class="btn btn-sm ${заСегодня ? '' : 'active'}" data-sum="yesterday">Вчера</button>
        <button class="btn btn-sm ${заСегодня ? 'active' : ''}" data-sum="today">Сегодня</button>
        <button class="btn btn-sm" data-sum-wa>${ui.icon('whatsapp')} Отправить</button>
      </div>
    </div>
    <dl class="kv summary-kv">${строкиСводки(с).map(([k, v, тревожно]) =>
      `<dt>${k}</dt><dd class="${тревожно ? 'crit' : ''}">${ui.esc(v)}</dd>`).join('')}</dl>
  </div>`;
}

function сводкаТекст(с) {
  return [`${App.storeName || ''} — сводка за ${ui.dateOnly(с['дата'])}`.trim(),
    ...строкиСводки(с).map(([k, v]) => `${k}: ${v}`)].join('\n');
}

// После сверки, сдачи смены или денег — перерисовать Главную, если она открыта:
// своё изменение это устройство само себе не присылает.
function перерисоватьГлавную() {
  const el = Pages.dashboard._el;
  if (el && el.isConnected) Pages.dashboard.render(el).catch(() => {});
}

/*
 * Сверка кассы: вечером продавец пересчитывает ящик и вводит сумму.
 *
 * Порядок в окне важен и сделан намеренно: СНАЧАЛА система показывает, сколько
 * должно быть, и из чего это сложилось, и только потом просит ввести
 * пересчитанное. Наоборот было бы нечестно — человек подгонял бы свою цифру
 * под ожидаемую, и сверка перестала бы что-либо значить.
 */
async function сверкаКассы(режим = 'count') {
  let о;
  try { о = await api.get('/api/cash/expected'); }
  catch (e) { ui.toastErr(e); return; }
  const приём = режим === 'accept';
  const сдано = о['смена'];
  if (приём && (!сдано || (App.user && сдано.user_id === App.user.id))) {
    ui.toast('Принимать нечего: смену уже приняли');
    перерисоватьГлавную();
    return;
  }

  const дв = о['движение'];
  const строка = (подпись, сумма, знак) => `
    <div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <div class="grow muted">${подпись}</div>
      <div class="num">${знак || ''}${ui.money(Math.abs(сумма))}</div>
    </div>`;

  const m = ui.modal({
    title: приём ? 'Принять смену' : 'Сверка кассы',
    size: 'sm',
    body: `
      ${приём ? `<div class="hint-box" style="margin-bottom:12px">Смену сдаёт <b>${ui.esc(сдано['кто'])}</b>,
        при сдаче в ящике было <b>${ui.money(сдано['сдано'])}</b>. Пересчитайте деньги вместе и введите,
        сколько получилось у вас.</div>` : ''}
      ${о['первая'] ? `<div class="hint-box">
        <b>Это первая сверка — сравнивать пока не с чем.</b><br>
        Система не знает, сколько денег лежало в ящике до неё. Просто пересчитайте
        и запишите — это станет началом отсчёта. Со следующего раза она уже будет
        говорить, сколько должно быть, и показывать расхождение.</div>` : `
      <div class="card" style="margin:0 0 14px">
        ${строка(приём ? 'Было в ящике при сдаче смены' : 'Было в ящике на прошлой сверке', о['остаток'])}
        ${дв['продажи'] || !приём ? строка('Приняли от клиентов наличными', дв['продажи'], '+') : ''}
        ${дв['возвраты'] ? строка('Вернули покупателям', дв['возвраты'], '−') : ''}
        ${дв['приход'] ? строка('Прочий приход наличными', дв['приход'], '+') : ''}
        ${дв['расход'] ? строка('Расходы наличными', дв['расход'], '−') : ''}
        ${дв['внесли'] ? строка('Внесли размен', дв['внесли'], '+') : ''}
        ${дв['сдали'] ? строка('Сдали владельцу', дв['сдали'], '−') : ''}
        <div class="row" style="padding:10px 0 0;font-weight:600;font-size:17px">
          <div class="grow">Должно быть в ящике</div>
          <div class="num" id="cc-expected">${ui.money(о['ожидается'])}</div>
        </div>
      </div>`}
      ${приём ? '' : `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px">
        <span class="muted" style="font-size:13px">Отдали деньги или внесли размен?</span>
        <button type="button" class="btn btn-sm" data-act="to-owner">Сдать владельцу</button>
        <button type="button" class="btn btn-sm" data-act="from-owner">Внести размен</button>
      </div>`}
      <label class="field"><span>Сколько денег в ящике на самом деле</span>
        <input type="number" step="0.01" min="0" id="cc-counted" inputmode="decimal"
               placeholder="Пересчитайте и введите"></label>
      <label class="field"><span>Заметка (необязательно)</span>
        <input type="text" id="cc-note" placeholder="Например: сдачу брали из своих"></label>
      ${приём ? '' : `<label class="row-tight" style="gap:8px;align-items:flex-start;font-size:14px">
        <input type="checkbox" id="cc-handover" style="margin-top:3px">
        <span>Сдаю смену — следующий продавец пересчитает при мне и примет</span></label>`}`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" id="cc-save">${приём ? 'Принять смену' : 'Записать'}</button>`,
  });
  m.foot.querySelector('[data-act=cancel]').onclick = m.close;
  // Деньги владельцу или размен — отдельным окном, потом сверка заново:
  // «должно быть» после них другое.
  m.body.querySelectorAll('[data-act=to-owner], [data-act=from-owner]').forEach(b => {
    b.onclick = () => {
      m.close();
      деньгиВладельцу(b.dataset.act === 'to-owner' ? 'to_owner' : 'from_owner', () => сверкаКассы());
    };
  });

  const поле = m.body.querySelector('#cc-counted');
  setTimeout(() => поле.focus(), 60);

  m.foot.querySelector('#cc-save').onclick = async () => {
    const сумма = поле.value.trim();
    if (сумма === '') { ui.toast('Введите, сколько денег в ящике'); поле.focus(); return; }
    const галка = m.body.querySelector('#cc-handover');
    try {
      const r = await api.post('/api/cash/count', {
        counted: Number(сумма),
        note: m.body.querySelector('#cc-note').value.trim(),
        ...(приём ? { accept: true } : { kind: галка && галка.checked ? 'handover' : 'count' }),
      });
      m.close();
      перерисоватьГлавную();
      /*
       * Результат показываем отдельным окном, а не всплывающей подписью:
       * расхождение в кассе — это то, что человек должен прочитать и понять,
       * а не заметить краем глаза, пока оно исчезает.
       */
      const первая = r['первая'];
      const плохо = r['разница'] < 0;
      const ровно = r['разница'] === 0;
      const вид = r['вид'];
      const заголовок = вид === 'accept' ? (ровно ? 'Смена принята' : 'Смена принята с расхождением')
        : вид === 'handover' ? (ровно || первая ? 'Смена сдана' : плохо ? 'Смена сдана — недостача' : 'Смена сдана — излишек')
          : первая ? 'Начало отсчёта' : ровно ? 'Касса сошлась' : плохо ? 'Недостача' : 'Излишек';
      const пояснение = первая
        ? 'Это начало отсчёта. Со следующей сверки система будет сама считать, сколько должно быть в ящике, и показывать расхождение.'
        : вид === 'accept'
          ? `При сдаче было ${ui.money(r['сдано'])}, должно быть ${ui.money(r['ожидалось'])}, у вас ${ui.money(r['пересчитано'])}.
             ${ровно ? 'Всё сошлось — смена ваша.'
               : 'Разберитесь сейчас, пока оба здесь: пересчитайте ещё раз вместе. Расхождение записано.'}`
          : `В ящике ${ui.money(r['пересчитано'])}, ожидалось ${ui.money(r['ожидалось'])}.
             ${ровно ? 'Так и должно быть.'
               : плохо ? 'Денег меньше, чем должно. Проверьте: не забыли ли записать расход, всё ли пробили.'
                 : 'Денег больше, чем должно. Обычно это непробитая продажа или сдача, которую не отдали.'}`;
      const итог = ui.modal({
        title: заголовок,
        size: 'sm',
        body: `
          <div class="alert-row ${ровно ? 'alert-warn' : классТревоги(плохо)}"
               style="${ровно ? 'background:var(--good-soft);border-color:var(--good)' : ''}">
            <div class="alert-ico" style="${ровно ? 'background:var(--good)' : ''}">${ровно ? '✓' : '!'}</div>
            <div>
              <div class="alert-what" style="${ровно ? 'color:var(--good)' : ''}">
                ${первая ? `Записано: ${ui.money(r['пересчитано'])}`
                  : ровно ? 'Всё до копейки' : `Разница ${ui.money(Math.abs(r['разница']))}`}</div>
              <div class="alert-why">${пояснение}</div>
            </div>
          </div>
          ${вид === 'handover' ? `<p class="form-hint">Следующий продавец увидит на Главной «Принять смену»
            и пересчитает деньги при вас.</p>` : ''}
          <p class="form-hint">Запись сохранена и видна владельцу в Финансах и в журнале действий.
            Исправить её нельзя — если ошиблись, сделайте сверку заново.</p>`,
        footer: '<button class="btn btn-primary" data-act="cancel">Понятно</button>',
      });
      итог.foot.querySelector('[data-act=cancel]').onclick = итог.close;
    } catch (e) { ui.toastErr(e); }
  };
}

/*
 * Сдать владельцу / внести размен.
 *
 * Это не расход и не доход: деньги не ушли из магазина, а перешли из ящика
 * в руки владельца (или обратно). Раньше выемку записывали расходом, и отчёт
 * о прибыли каждый вечер «терял» дневную выручку. Сдачу подтверждает тот,
 * кому отдали: у него на Главной появится «Деньги у меня / Не получено».
 */
async function деньгиВладельцу(вид, после) {
  let кому = [];
  try { кому = (await api.get('/api/cash/receivers')).items; }
  catch (e) { ui.toastErr(e); return; }
  const сдать = вид === 'to_owner';
  const я = App.user ? App.user.id : 0;
  const сам = App.isAdmin();
  const m = ui.modal({
    title: сдать ? 'Сдать деньги владельцу' : 'Внести размен',
    size: 'sm',
    body: `<form id="cm-form">
      <label class="field"><span>Сумма *</span>
        <input type="number" name="amount" min="1" step="1" inputmode="decimal" required></label>
      <label class="field"><span>${сдать ? 'Кому отдали' : 'Кто внёс'}</span>
        <select name="other_user_id">${кому.map(u => `<option value="${u.id}" ${u.id === я ? 'selected' : ''}>${
          ui.esc(u.name)}${u.id === я ? ' (я)' : ''} — ${u.role === 'owner' ? 'основатель' : 'бухгалтер'}</option>`).join('')}</select></label>
      <label class="field"><span>Заметка</span><input name="note" maxlength="300" placeholder="необязательно"></label>
      <p class="form-hint" style="margin:0">${сдать
        ? `Это не расход: в отчёте о прибыли деньги не пропадут. ${сам ? '' : 'Тот, кому отдали, подтвердит у себя, что получил.'}`
        : 'Деньги на сдачу от владельца. Это не доход — просто в ящике станет больше.'}</p>
    </form>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
      <button class="btn btn-primary" data-act="ok">${сдать ? 'Сдать' : 'Внести'}</button>`,
  });
  const form = m.body.querySelector('#cm-form');
  m.foot.querySelector('[data-act=cancel]').onclick = () => { m.close(); if (после) после(); };
  m.foot.querySelector('[data-act=ok]').onclick = async () => {
    if (!form.reportValidity()) return;
    const v = ui.formValues(form);
    try {
      const r = await api.post('/api/cash/moves', { kind: вид, amount: v.amount, other_user_id: v.other_user_id, note: v.note });
      ui.toast(сдать ? (r.status === 'pending' ? 'Записано. Ждёт подтверждения того, кому отдали' : 'Записано') : 'Размен записан');
      m.close();
      перерисоватьГлавную();
      if (после) после();
    } catch (e) { ui.toastErr(e); }
  };
}

function классТревоги(плохо) { return плохо ? 'alert-bad' : 'alert-warn'; }
