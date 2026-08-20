'use strict';
window.Pages = window.Pages || {};

window.Pages.finance = (() => {
  let tab = 'ops', period = '30', typeFilter = '';

  function periodFrom(days) {
    if (!days) return '';
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(days) - 1));
    return d.toISOString();
  }

  let opsSeq = 0;
  async function renderOps(box) {
    const my = ++opsSeq;
    const q = new URLSearchParams();
    if (period) q.set('from', periodFrom(period));
    if (typeFilter) q.set('type', typeFilter);
    const { items, totals } = await api.get('/api/finance?' + q.toString());
    if (my !== opsSeq || !box.isConnected) return; // фильтры уже сменились
    box.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:16px">
        <div class="stat-tile"><div class="stat-label">Приход</div>
          <div class="stat-value" style="color:var(--good)">${ui.money(totals.income)}</div></div>
        <div class="stat-tile"><div class="stat-label">Расход</div>
          <div class="stat-value" style="color:var(--crit)">${ui.money(totals.expense)}</div></div>
        <div class="stat-tile"><div class="stat-label">Результат</div>
          <div class="stat-value">${ui.money(totals.profit)}</div></div>
      </div>
      <div id="ops-table"></div>`;
    const tbl = box.querySelector('#ops-table');
    tbl.innerHTML = ui.table([
      { title: 'Дата', render: r => `<span class="dim">${ui.dt(r.created_at)}</span>` },
      { title: 'Тип', render: r => r.type === 'income' ? '<span class="badge badge-good">Приход</span>' : '<span class="badge badge-crit">Расход</span>' },
      { title: 'Категория', render: r => `<span class="strong">${ui.esc(r.category)}</span>${
        r.employee_name ? ` <span class="dim">— ${ui.esc(r.employee_name)}</span>` : ''}` },
      { title: 'Описание', render: r => `<span class="dim">${ui.esc(r.note || '')}${r.sale_number ? ` <a href="#/sales/${r.sale_id}">${ui.esc(r.sale_number)}</a>` : ''}${r.order_number ? ' ' + ui.esc(r.order_number) : ''}</span>` },
      { title: 'Сотрудник', render: r => `<span class="dim">${ui.esc(r.user_name || '—')}</span>` },
      { title: 'Сумма', cls: 'num strong', render: r => (r.type === 'income' ? '+' : '−') + ui.money(r.amount) },
      { title: '', render: r => (!r.sale_id && !r.order_id) ? `<button class="btn btn-sm btn-danger" data-del="${r.id}">×</button>` : '' },
    ], items, { empty: 'Операций за период нет.' });
    tbl.addEventListener('click', async e => {
      const id = e.target.dataset && e.target.dataset.del;
      if (!id) return;
      e.stopPropagation();
      if (await ui.confirmDialog('Удалить операцию?', { danger: true, okLabel: 'Удалить' })) {
        try { await api.del('/api/finance/' + id); ui.toast('Удалено'); renderOps(box); }
        catch (err) { ui.toastErr(err); }
      }
    });
  }

  // Категории, для которых имеет смысл спрашивать «кому платили».
  const ЛИЧНЫЕ_КАТЕГОРИИ = ['Зарплата', 'Аванс', 'Премия'];
  const личная = c => ЛИЧНЫЕ_КАТЕГОРИИ.some(x => String(c || '').toLowerCase().includes(x.toLowerCase()));

  /*
   * Окно операции. Третьим доводом принимает заготовку — так «Записать»
   * у постоянного расхода открывает то же самое окно с уже подставленной
   * категорией, суммой и сотрудником. Владельцу остаётся сверить сумму
   * и нажать одну кнопку, а операция при этом всё равно создаётся его руками.
   */
  async function opDialog(type, onChange, заготовка = {}) {
    const cats = await api.get('/api/finance/categories');
    const list = type === 'income' ? cats.income : cats.expense;
    const сотрудники = type === 'expense'
      ? await api.get('/api/users').then(r => r.items.filter(u => u.active)).catch(() => [])
      : [];
    const наличными = заготовка.cash === undefined ? true : !!заготовка.cash;
    const m = ui.modal({
      title: type === 'income' ? 'Новый приход' : 'Новый расход',
      size: 'sm',
      body: `<form id="op-form">
        <label class="field"><span>Категория *</span>
          <input name="category" list="op-cats" required placeholder="Выберите или введите свою"
            value="${ui.esc(заготовка.category || '')}">
          <datalist id="op-cats">${list.filter(c => !['Продажа', 'Оплата заказа', 'Возврат покупателю'].includes(c)).map(c => `<option>${ui.esc(c)}</option>`).join('')}</datalist></label>
        <label class="field"><span>Сумма *</span><input name="amount" type="number" min="0.01" step="0.01" required
          value="${заготовка.amount != null ? заготовка.amount : ''}"></label>
        <label class="field hidden" id="op-emp-wrap"><span>Кому</span>
          <select name="employee_id" class="input">
            <option value="">— не указан —</option>
            ${сотрудники.map(u => `<option value="${u.id}"${Number(заготовка.employee_id) === u.id ? ' selected' : ''}>${ui.esc(u.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Описание</span><input name="note" value="${ui.esc(заготовка.note || '')}"></label>
        <label class="row-tight" style="cursor:pointer;margin-bottom:8px">
          <input type="checkbox" name="cash"${наличными ? ' checked' : ''}
            style="width:18px;height:18px;cursor:pointer"> Наличными, из кассы</label>
        <p class="form-hint">Снимите галочку, если платили переводом или картой:
          тогда эта сумма не будет вычитаться при сверке кассы. Иначе сверка
          показала бы недостачу на ровном месте.</p>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Записать</button>`,
    });
    const form = m.body.querySelector('#op-form');
    const катПоле = form.querySelector('[name=category]');
    const комуБлок = form.querySelector('#op-emp-wrap');
    // Поле «кому» появляется только для зарплатных категорий: в строке
    // «Зарплата 210 000» непонятно, заплатили ли Анне, а в остальных расходах
    // этот вопрос не возникает и лишнее поле только мешает.
    const показатьКому = () => комуБлок.classList.toggle(
      'hidden', !(сотрудники.length && личная(катПоле.value)));
    катПоле.addEventListener('input', показатьКому);
    катПоле.addEventListener('change', показатьКому);
    показатьКому();
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      try {
        await api.post('/api/finance', {
          type, category: v.category, amount: v.amount, note: v.note,
          cash: m.body.querySelector('[name=cash]').checked,
          employee_id: комуБлок.classList.contains('hidden') ? null : (v.employee_id || null),
        });
        ui.toast('Операция записана');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  /*
   * ---------- Постоянные расходы ----------
   *
   * Аренда и зарплата — самые крупные расходы магазина и самые забываемые:
   * сумма из месяца в месяц одна и та же, платятся они мимо кассы, и в отчёт
   * попадают, только если кто-то вспомнил их вписать. Не вписали — прибыль
   * в отчёте выше настоящей ровно на эту сумму.
   *
   * Раздел не платит за владельца и не записывает расход сам: сумма почти
   * каждый месяц немного другая. Он держит список того, что платится
   * регулярно, и в нужное число напоминает — здесь и на Главной.
   */
  async function regDialog(правило, onChange) {
    const cats = await api.get('/api/finance/categories');
    const сотрудники = await api.get('/api/users').then(r => r.items.filter(u => u.active)).catch(() => []);
    const п = правило || {};
    const m = ui.modal({
      title: правило ? 'Постоянный расход' : 'Новый постоянный расход',
      size: 'sm',
      body: `<form id="reg-form">
        <label class="field"><span>За что *</span>
          <input name="category" list="reg-cats" required placeholder="Аренда, Зарплата…"
            value="${ui.esc(п.category || '')}">
          <datalist id="reg-cats">${cats.expense.map(c => `<option>${ui.esc(c)}</option>`).join('')}</datalist></label>
        <label class="field"><span>Обычная сумма *</span>
          <input name="amount" type="number" min="0.01" step="0.01" required value="${п.amount != null ? п.amount : ''}"></label>
        <label class="field"><span>Какого числа платится *</span>
          <input name="day_of_month" type="number" min="1" max="28" required value="${п.day_of_month || 1}"></label>
        <p class="form-hint">До этого числа система молчит, после — напомнит,
          если расход ещё не записан. Больше 28 поставить нельзя: в феврале
          такого числа не бывает, и напоминание не сработало бы вовсе.</p>
        <label class="field"><span>Кому (для зарплаты)</span>
          <select name="employee_id" class="input">
            <option value="">— не указан —</option>
            ${сотрудники.map(u => `<option value="${u.id}"${п.employee_id === u.id ? ' selected' : ''}>${ui.esc(u.name)}</option>`).join('')}
          </select></label>
        <p class="form-hint">Укажите сотрудника — и на каждого будет своё
          напоминание. Иначе одна запись «Зарплата» закроет их все разом.</p>
        <label class="field"><span>Заметка</span><input name="note" value="${ui.esc(п.note || '')}"></label>
        <label class="row-tight" style="cursor:pointer">
          <input type="checkbox" name="cash"${(п.id ? п.cash : 0) ? ' checked' : ''}
            style="width:18px;height:18px;cursor:pointer"> Платится наличными из кассы</label>
      </form>`,
      footer: `<button class="btn" data-act="cancel">Отмена</button>
        <button class="btn btn-primary" data-act="ok">Сохранить</button>`,
    });
    const form = m.body.querySelector('#reg-form');
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=ok]').onclick = async () => {
      if (!form.reportValidity()) return;
      const v = ui.formValues(form);
      const данные = {
        category: v.category, amount: v.amount, day_of_month: v.day_of_month,
        employee_id: v.employee_id || null, note: v.note,
        cash: form.querySelector('[name=cash]').checked,
      };
      try {
        if (п.id) await api.put('/api/finance/regular/' + п.id, данные);
        else await api.post('/api/finance/regular', данные);
        ui.toast('Сохранено');
        m.close(); onChange && onChange();
      } catch (e) { ui.toastErr(e); }
    };
  }

  async function renderRegular(box) {
    const { items, ждут } = await api.get('/api/finance/regular');
    if (!box.isConnected) return;
    const ждётLi = new Map(ждут.map(ж => [ж.id, ж]));
    const активные = items.filter(i => i.active);
    const вМесяц = активные.reduce((s, i) => s + i.amount, 0);

    /*
     * Всё содержимое — внутри одной обёртки, и обработчик висит на ней,
     * а не на box: раздел перерисовывает сам себя после каждого действия,
     * и обработчик на переживающем перерисовку box накопился бы в несколько
     * штук — одно нажатие «Записать» открывало бы два окна подряд.
     */
    box.innerHTML = '<div id="reg-wrap"></div>';
    const wrap = box.querySelector('#reg-wrap');
    wrap.innerHTML = `
      <div class="toolbar">
        <div class="spacer"></div>
        <button class="btn btn-primary" id="reg-add">+ Постоянный расход</button>
      </div>
      ${ждут.length ? `<div class="card" style="border-color:var(--crit)">
        <h3 class="card-title" style="color:var(--crit)">Ещё не записано в этом месяце</h3>
        <div class="list">${ждут.map(ж => `
          <div class="row-tight" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
            <div><span class="strong">${ui.esc(ж.подпись)}</span>
              <span class="dim"> · обычно ${ui.money(ж.amount)} · ${ж.day_of_month}-го</span></div>
            <button class="btn btn-sm btn-primary" data-pay="${ж.id}">Записать</button>
          </div>`).join('')}</div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">Пока эти расходы не записаны,
          прибыль в отчёте выше настоящей. Сумму перед записью можно поправить.</p>
      </div>` : (активные.length ? `<div class="card">
        <p class="good" style="margin:0">Всё постоянное за этот месяц записано.</p></div>` : '')}
      <div class="card">
        <h3 class="card-title">Что платится каждый месяц${активные.length
          ? ` · ${ui.money(вМесяц)} в месяц` : ''}</h3>
        <div id="reg-table"></div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">Система ничего не платит
          и не записывает сама — только напоминает в нужное число.</p>
      </div>`;

    wrap.querySelector('#reg-table').innerHTML = ui.table([
      { title: 'За что', render: r => `<span class="strong${r.active ? '' : ' dim'}">${ui.esc(r.category)}</span>${
        r.employee_name ? ` <span class="dim">— ${ui.esc(r.employee_name)}</span>` : ''}` },
      { title: 'Сумма', cls: 'num', render: r => ui.money(r.amount) },
      { title: 'Число', cls: 'num', render: r => r.day_of_month },
      { title: 'Откуда', render: r => r.cash ? 'наличные' : '<span class="dim">перевод</span>' },
      { title: 'В этом месяце', render: r => !r.active ? '<span class="dim">не платится</span>'
        : (ждётLi.has(r.id) ? '<span class="crit">не записан</span>' : '<span class="good">записан</span>') },
      { title: 'Заметка', render: r => `<span class="dim">${ui.esc(r.note || '')}</span>` },
      { title: '', render: r => `<button class="btn btn-sm" data-edit="${r.id}">Изменить</button>
        <button class="btn btn-sm" data-toggle="${r.id}">${r.active ? 'Приостановить' : 'Вернуть'}</button>
        <button class="btn btn-sm btn-danger" data-del="${r.id}">×</button>` },
    ], items, { empty: 'Пока ничего не добавлено. Начните с аренды и зарплат.' });

    const обновить = () => renderRegular(box);
    wrap.querySelector('#reg-add').onclick = () => regDialog(null, обновить);
    wrap.addEventListener('click', async e => {
      const d = e.target.dataset;
      if (!d) return;
      const прав = id => items.find(i => i.id === Number(id));
      if (d.pay) {
        const ж = ждётLi.get(Number(d.pay));
        if (ж) opDialog('expense', обновить, ж);
      } else if (d.edit) {
        regDialog(прав(d.edit), обновить);
      } else if (d.toggle) {
        const п = прав(d.toggle);
        try { await api.put('/api/finance/regular/' + п.id, { active: !п.active }); обновить(); }
        catch (err) { ui.toastErr(err); }
      } else if (d.del) {
        const п = прав(d.del);
        if (await ui.confirmDialog(
          `Убрать «${п.category}» из постоянных расходов? Уже записанные расходы останутся — удаляется только напоминание.`,
          { danger: true, okLabel: 'Убрать' })) {
          try { await api.del('/api/finance/regular/' + п.id); обновить(); }
          catch (err) { ui.toastErr(err); }
        }
      }
    });
  }

  async function renderPnl(box, year) {
    const data = await api.get(`/api/finance/pnl?year=${year}&tz=${api.tz()}`);
    const nonEmpty = data.months.filter(m => m.revenue || m.expenses || m.other_income || m.cogs);
    const mName = ym => ui.monthName(ym).split(' ')[0];
    box.innerHTML = `
      <div class="card">
        <h3 class="card-title">Чистая прибыль по месяцам · ${year}</h3>
        <div id="pnl-chart"></div>
      </div>
      <div class="card">
        <h3 class="card-title">Отчёт о прибылях и убытках · ${year}</h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Месяц</th><th class="num">Выручка</th><th class="num">Себестоимость</th>
            <th class="num">Валовая прибыль</th><th class="num">Прочие доходы</th><th class="num">Расходы</th><th class="num">Чистая прибыль</th></tr></thead>
          <tbody>${data.months.map(m => `
            <tr class="${!m.revenue && !m.expenses && !m.other_income ? 'dim' : ''}">
              <td>${mName(m.month)}</td>
              <td class="num">${ui.money(m.revenue)}</td>
              <td class="num">${ui.money(m.cogs)}</td>
              <td class="num">${ui.money(m.gross_profit)}</td>
              <td class="num">${ui.money(m.other_income)}</td>
              <td class="num">${ui.money(m.expenses)}</td>
              <td class="num strong" style="color:${m.net_profit >= 0 ? 'var(--good)' : 'var(--crit)'}">${ui.money(m.net_profit)}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr><td>Итого</td>
            ${['revenue', 'cogs', 'gross_profit', 'other_income', 'expenses', 'net_profit'].map(k =>
              `<td class="num">${ui.money(data.months.reduce((s, m) => s + m[k], 0))}</td>`).join('')}
          </tr></tfoot>
        </table></div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">Закупка товара не входит в «Расходы» —
          стоимость изделий учитывается в «Себестоимости» в момент продажи. Возвраты уже вычтены из выручки.</p>
      </div>
      <div class="card" style="max-width:640px">
        <h3 class="card-title">Расходы по категориям · ${year}</h3>
        <div id="pnl-expenses"></div>
      </div>`;
    charts.columnChart(box.querySelector('#pnl-chart'), {
      labels: data.months.map(m => mName(m.month).slice(0, 3)),
      values: data.months.map(m => m.net_profit),
      posColor: '#2a78d6', negColor: '#e34948',
      tipName: 'Чистая прибыль:',
      height: 230,
    });
    const expItems = Object.entries(data.expense_by_category)
      .map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    charts.barList(box.querySelector('#pnl-expenses'), expItems, { color: '#e34948' });
    if (!nonEmpty.length) {
      box.querySelector('#pnl-chart').innerHTML = '<div class="empty"><p>За этот год данных пока нет</p></div>';
    }
  }

  /*
   * История сверок кассы.
   *
   * Владелец смотрит сюда не за суммами — суммы он и так знает, — а за одним
   * столбцом: расхождение. Поэтому расхождение выделено цветом и стоит
   * последним, где взгляд останавливается, а недостача и излишек названы
   * словами: «−300» само по себе ничего не говорит человеку, который не
   * держит в голове, что тут от чего отнимали.
   */
  async function renderCash(box) {
    const { items } = await api.get('/api/cash/counts?limit=100');
    if (!box.isConnected) return;

    if (!items.length) {
      box.innerHTML = `<div class="card empty">
        <p>Сверок ещё не было.</p>
        <p class="muted">Вечером продавец пересчитывает деньги в ящике и вводит сумму —
        кнопка «Сверить кассу» на Главной. Система сама посчитает, сколько должно быть,
        и покажет разницу.</p></div>`;
      return;
    }

    const сходится = items.filter(i => Math.abs(i.difference) < 0.01).length;
    const недостачи = items.filter(i => i.difference < -0.01);
    const сумма = недостачи.reduce((s, i) => s + i.difference, 0);

    box.innerHTML = `
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="big-stat"><div class="bs-label">Сверок сделано</div>
          <div class="bs-value">${items.length}</div></div>
        <div class="big-stat accent-good"><div class="bs-label">Сошлось точно</div>
          <div class="bs-value">${сходится}</div>
          <div class="bs-sub">из ${items.length}</div></div>
        <div class="big-stat ${недостачи.length ? 'accent-crit' : ''}">
          <div class="bs-label">Недостач</div>
          <div class="bs-value">${недостачи.length}</div>
          <div class="bs-sub">${недостачи.length ? 'всего ' + ui.money(Math.abs(сумма)) : 'ни одной'}</div></div>
        <div class="big-stat"><div class="bs-label">Последняя сверка</div>
          <div class="bs-value" style="font-size:19px">${ui.dt(items[0].created_at)}</div>
          <div class="bs-sub">${ui.esc(items[0].user_name || '—')}</div></div>
      </div>
      <div class="card">
        <h3 class="card-title">Все сверки</h3>
        <div id="cash-table"></div>
      </div>`;

    box.querySelector('#cash-table').innerHTML = ui.table([
      { title: 'Когда', render: r => ui.dt(r.created_at) },
      { title: 'Кто считал', render: r => ui.esc(r.user_name || '—') },
      { title: 'Должно быть', cls: 'num', render: r => ui.money(r.expected) },
      { title: 'В ящике', cls: 'num', render: r => ui.money(r.counted) },
      { title: 'Расхождение', cls: 'num', render: r => {
        if (Math.abs(r.difference) < 0.01) return '<span class="good">сошлось</span>';
        return r.difference < 0
          ? `<span class="crit">недостача ${ui.money(-r.difference)}</span>`
          : `<span class="warn">излишек ${ui.money(r.difference)}</span>`;
      } },
      { title: 'Заметка', render: r => ui.esc(r.note || '') },
    ], items, { empty: 'Сверок ещё не было' });
  }

  return {
    title: 'Финансы',
    async render(el) {
      const thisYear = new Date().getFullYear();
      el.innerHTML = `
        <div class="tabs">
          <button class="tab active" data-tab="ops">Операции</button>
          <button class="tab" data-tab="pnl">Прибыли и убытки (P&L)</button>
          <button class="tab" data-tab="regular">Постоянные расходы</button>
          <button class="tab" data-tab="cash">Сверка кассы</button>
        </div>
        <div id="fin-toolbar" class="toolbar">
          <select class="input" id="ff-period">
            <option value="1">Сегодня</option><option value="7">7 дней</option>
            <option value="30" selected>30 дней</option><option value="365">Год</option>
            <option value="">Всё время</option>
          </select>
          <select class="input" id="ff-type">
            <option value="">Приход и расход</option>
            <option value="income">Только приход</option>
            <option value="expense">Только расход</option>
          </select>
          <div class="spacer"></div>
          <button class="btn" id="ff-income" style="color:var(--good)">+ Приход</button>
          <button class="btn" id="ff-expense" style="color:var(--crit)">+ Расход</button>
        </div>
        <div id="fin-toolbar-pnl" class="toolbar hidden">
          <select class="input" id="ff-year">
            ${[thisYear, thisYear - 1, thisYear - 2].map(y => `<option>${y}</option>`).join('')}
          </select>
        </div>
        <div id="fin-body"></div>`;

      const body = el.querySelector('#fin-body');
      const show = async () => {
        el.querySelector('#fin-toolbar').classList.toggle('hidden', tab !== 'ops');
        el.querySelector('#fin-toolbar-pnl').classList.toggle('hidden', tab !== 'pnl');
        body.innerHTML = '<div class="empty"><p>Загрузка…</p></div>';
        try {
          if (tab === 'ops') await renderOps(body);
          else if (tab === 'regular') await renderRegular(body);
          else if (tab === 'cash') await renderCash(body);
          else await renderPnl(body, el.querySelector('#ff-year').value);
        } catch (e) { body.innerHTML = `<div class="empty"><p>${ui.esc(e.message)}</p></div>`; }
      };

      el.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
        el.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        tab = t.dataset.tab;
        show();
      }));
      el.querySelector('#ff-period').addEventListener('change', e => { period = e.target.value; show(); });
      el.querySelector('#ff-type').addEventListener('change', e => { typeFilter = e.target.value; show(); });
      el.querySelector('#ff-year').addEventListener('change', show);
      el.querySelector('#ff-income').addEventListener('click', () => opDialog('income', show));
      el.querySelector('#ff-expense').addEventListener('click', () => opDialog('expense', show));

      tab = 'ops'; period = '30'; typeFilter = '';
      await show();
    },
  };
})();
