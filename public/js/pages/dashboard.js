'use strict';
window.Pages = window.Pages || {};

/*
 * Главная. Сверху — то, что владелец хочет видеть каждое утро:
 * деньги за день и месяц, кто сколько должен, склад в деньгах и граммах.
 */
window.Pages.dashboard = {
  title: 'Главная',
  async render(el) {
    const [d, bd] = await Promise.all([
      api.get('/api/dashboard?tz=' + api.tz()),
      api.get('/api/customers/birthdays?days=14'),
    ]);
    if (!el.isConnected) return;
    const admin = App.isAdmin();
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

    el.innerHTML = `
      ${тревоги ? `<div class="alert-box">${тревоги}</div>` : ''}
      <div class="grid grid-4">
        <div class="big-stat accent-good">
          <div class="bs-label">Продали сегодня</div>
          <div class="bs-value">${ui.moneyRich(d.today.revenue)}</div>
          <div class="bs-sub">${d.today.sales_count
            ? `${d.today.sales_count} продаж, средний чек ${ui.money(d.today.avg_check)}`
            : 'Продаж пока не было'}</div>
        </div>
        <div class="big-stat accent-gold">
          <div class="bs-label">Продали за месяц</div>
          <div class="bs-value">${ui.moneyRich(d.month.revenue)}</div>
          <div class="bs-sub">${admin
            ? `Заработали чистыми <b class="good">${ui.money(d.month.profit)}</b>`
            : `${d.month.sales_count} продаж`}</div>
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

    const bdEl = el.querySelector('#dash-bd');
    if (!bd.items.length) {
      bdEl.innerHTML = '<p class="muted" style="margin:4px 0">В ближайшие 2 недели дней рождения и годовщин у клиентов нет.</p>';
    } else {
      bdEl.innerHTML = bd.items.slice(0, 8).map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)">
          <div>
            <a href="#/customers/${b.id}">${ui.esc(b.name)}</a>
            <div class="muted" style="font-size:13px">${b.kind === 'birthday' ? 'День рождения' : 'Годовщина'} · ${ui.esc(b.phone || 'без телефона')}</div>
          </div>
          <span class="badge ${b.in_days <= 3 ? 'badge-gold' : 'badge-gray'}">${b.in_days === 0 ? 'сегодня!' : 'через ' + b.in_days + ' дн.'}</span>
        </div>`).join('');
    }

    const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.onclick = fn; };
    on('qa-sale', () => Pages.sales.newSale());
    on('qa-pay', () => App.go('#/debts'));
    on('qa-debts', () => App.go('#/debts'));
    on('qa-suppliers', () => App.go('#/debts'));
    on('qa-product', () => { App.go('#/products'); setTimeout(() => Pages.products.openEditor(), 100); });
    on('qa-customer', () => { App.go('#/customers'); setTimeout(() => Pages.customers.openEditor(), 100); });
    on('qa-order', () => { App.go('#/orders'); setTimeout(() => Pages.orders.openEditor(), 100); });
    on('qa-cash', () => сверкаКассы());
  },
};

/*
 * Сверка кассы: вечером продавец пересчитывает ящик и вводит сумму.
 *
 * Порядок в окне важен и сделан намеренно: СНАЧАЛА система показывает, сколько
 * должно быть, и из чего это сложилось, и только потом просит ввести
 * пересчитанное. Наоборот было бы нечестно — человек подгонял бы свою цифру
 * под ожидаемую, и сверка перестала бы что-либо значить.
 */
async function сверкаКассы() {
  let о;
  try { о = await api.get('/api/cash/expected'); }
  catch (e) { ui.toastErr(e); return; }

  const дв = о['движение'];
  const строка = (подпись, сумма, знак) => `
    <div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <div class="grow muted">${подпись}</div>
      <div class="num">${знак || ''}${ui.money(Math.abs(сумма))}</div>
    </div>`;

  const m = ui.modal({
    title: 'Сверка кассы',
    size: 'sm',
    body: `
      ${о['первая'] ? `<div class="hint-box">
        <b>Это первая сверка — сравнивать пока не с чем.</b><br>
        Система не знает, сколько денег лежало в ящике до неё. Просто пересчитайте
        и запишите — это станет началом отсчёта. Со следующего раза она уже будет
        говорить, сколько должно быть, и показывать расхождение.</div>` : `
      <div class="card" style="margin:0 0 14px">
        ${строка('Было в ящике на прошлой сверке', о['остаток'])}
        ${строка('Приняли от клиентов наличными', дв['продажи'], '+')}
        ${дв['возвраты'] ? строка('Вернули покупателям', дв['возвраты'], '−') : ''}
        ${дв['приход'] ? строка('Прочий приход наличными', дв['приход'], '+') : ''}
        ${дв['расход'] ? строка('Расходы наличными', дв['расход'], '−') : ''}
        <div class="row" style="padding:10px 0 0;font-weight:600;font-size:17px">
          <div class="grow">Должно быть в ящике</div>
          <div class="num">${ui.money(о['ожидается'])}</div>
        </div>
      </div>`}
      <label class="field"><span>Сколько денег в ящике на самом деле</span>
        <input type="number" step="0.01" min="0" id="cc-counted" inputmode="decimal"
               placeholder="Пересчитайте и введите"></label>
      <label class="field"><span>Заметка (необязательно)</span>
        <input type="text" id="cc-note" placeholder="Например: сдачу брали из своих"></label>
      <div id="cc-result"></div>`,
    footer: `<button class="btn" data-act="cancel">Отмена</button>
             <button class="btn btn-primary" id="cc-save">Записать</button>`,
  });

  const поле = m.body.querySelector('#cc-counted');
  setTimeout(() => поле.focus(), 60);

  m.foot.querySelector('#cc-save').onclick = async () => {
    const сумма = поле.value.trim();
    if (сумма === '') { ui.toast('Введите, сколько денег в ящике'); поле.focus(); return; }
    try {
      const r = await api.post('/api/cash/count', {
        counted: Number(сумма),
        note: m.body.querySelector('#cc-note').value.trim(),
      });
      m.close();
      /*
       * Результат показываем отдельным окном, а не всплывающей подписью:
       * расхождение в кассе — это то, что человек должен прочитать и понять,
       * а не заметить краем глаза, пока оно исчезает.
       */
      const первая = r['первая'];
      const плохо = r['разница'] < 0;
      const ровно = r['разница'] === 0;
      ui.modal({
        title: первая ? 'Начало отсчёта' : ровно ? 'Касса сошлась' : плохо ? 'Недостача' : 'Излишек',
        size: 'sm',
        body: `
          <div class="alert-row ${ровно ? 'alert-warn' : классТревоги(плохо)}"
               style="${ровно ? 'background:var(--good-soft);border-color:var(--good)' : ''}">
            <div class="alert-ico" style="${ровно ? 'background:var(--good)' : ''}">${ровно ? '✓' : '!'}</div>
            <div>
              <div class="alert-what" style="${ровно ? 'color:var(--good)' : ''}">
                ${первая ? `Записано: ${ui.money(r['пересчитано'])}`
                  : ровно ? 'Всё до копейки' : `Разница ${ui.money(Math.abs(r['разница']))}`}</div>
              <div class="alert-why">
                ${первая
                  ? 'Это начало отсчёта. Со следующей сверки система будет сама считать, сколько должно быть в ящике, и показывать расхождение.'
                  : `В ящике ${ui.money(r['пересчитано'])}, ожидалось ${ui.money(r['ожидалось'])}.
                     ${ровно ? 'Так и должно быть.'
                       : плохо ? 'Денег меньше, чем должно. Проверьте: не забыли ли записать расход, всё ли пробили.'
                         : 'Денег больше, чем должно. Обычно это непробитая продажа или сдача, которую не отдали.'}`}
              </div>
            </div>
          </div>
          <p class="form-hint">Запись сохранена и видна владельцу в Финансах и в журнале действий.
            Исправить её нельзя — если ошиблись, сделайте сверку заново.</p>`,
        footer: '<button class="btn btn-primary" data-act="cancel">Понятно</button>',
      });
    } catch (e) { ui.toastErr(e); }
  };
}

function классТревоги(плохо) { return плохо ? 'alert-bad' : 'alert-warn'; }
