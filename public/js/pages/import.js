'use strict';
window.Pages = window.Pages || {};

window.Pages.import = (() => {
  const FIELD_LABELS = {
    sku: 'Артикул', name: 'Наименование *', barcode: 'Штрихкод', category: 'Категория / группа',
    metal: 'Металл / проба', weight: 'Вес, г', size: 'Размер', gem_summary: 'Вставки (камни)',
    purchase_price: 'Закупочная цена', retail_price: 'Розничная цена', description: 'Описание',
    phone: 'Телефон', email: 'E-mail', birthday: 'Дата рождения', discount: 'Скидка %', notes: 'Заметки',
  };

  let state = null; // { csv, entity, preview }

  // Файл из 1С часто в кодировке Windows-1251 — определяем автоматически
  async function readFileSmart(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('windows-1251').decode(buf);
    }
  }

  function renderStep1(el) {
    state = null;
    el.querySelector('#imp-body').innerHTML = `
      <div class="grid grid-2">
        <div class="card mb0">
          <h3 class="card-title">Шаг 1 · Что переносим</h3>
          <label class="field"><span>Тип данных</span>
            <select id="imp-entity">
              <option value="products">Изделия (номенклатура)</option>
              <option value="customers">Клиенты (контрагенты)</option>
            </select></label>
          <label class="field"><span>Файл CSV из 1С или Excel</span>
            <input type="file" id="imp-file" accept=".csv,.txt"></label>
          <p class="form-hint">Кодировки UTF-8 и Windows-1251 определяются автоматически. Разделитель — «;», «,» или табуляция.</p>
          <button class="btn btn-primary" id="imp-next" disabled>Далее: проверить колонки →</button>
        </div>
        <div class="card mb0">
          <h3 class="card-title">Как выгрузить из 1С</h3>
          <ol style="margin:0;padding-left:18px;line-height:1.55;font-size:13.5px">
            <li>Откройте в 1С список <b>Номенклатура</b> (или <b>Контрагенты</b>).</li>
            <li>Нажмите <b>Ещё → Вывести список</b>, отметьте нужные колонки (артикул, наименование, цены…).</li>
            <li>В открывшемся табличном документе: <b>Файл → Сохранить как…</b></li>
            <li>Выберите тип файла <b>«Текст CSV (разделитель — точка с запятой)»</b> или Excel, затем сохраните лист Excel как CSV.</li>
            <li>Загрузите файл здесь — Asher сам предложит соответствие колонок.</li>
          </ol>
          <p class="muted" style="font-size:12.5px">Также подойдёт любая таблица из Excel/Google Sheets, сохранённая как CSV: первая строка — названия колонок.</p>
        </div>
      </div>

      <h2 class="section-title">Экспорт данных из Asher</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Резервная копия или перенос в Excel — данные выгружаются в CSV (открывается в Excel).</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn" href="/api/export/products" download>💍 Изделия</a>
          <a class="btn" href="/api/export/customers" download>👤 Клиенты</a>
          <a class="btn" href="/api/export/sales" download>₽ Продажи</a>
        </div>
      </div>`;

    const fileInput = el.querySelector('#imp-file');
    const nextBtn = el.querySelector('#imp-next');
    fileInput.addEventListener('change', () => { nextBtn.disabled = !fileInput.files.length; });
    nextBtn.addEventListener('click', async () => {
      try {
        nextBtn.disabled = true;
        const csv = await readFileSmart(fileInput.files[0]);
        const entity = el.querySelector('#imp-entity').value;
        const preview = await api.post('/api/import/preview', { csv, entity });
        state = { csv, entity, preview };
        renderStep2(el);
      } catch (e) {
        ui.toastErr(e);
        nextBtn.disabled = false;
      }
    });
  }

  function renderStep2(el) {
    const { preview, entity } = state;
    const colOptions = idx => `<option value="">— не переносить —</option>` +
      preview.headers.map((h, i) =>
        `<option value="${i}" ${idx === i ? 'selected' : ''}>${ui.esc(h || 'колонка ' + (i + 1))}</option>`).join('');

    el.querySelector('#imp-body').innerHTML = `
      <div class="card">
        <h3 class="card-title">Шаг 2 · Соответствие колонок <span class="muted" style="text-transform:none;font-weight:400">· строк в файле: ${preview.total_rows}</span></h3>
        <div class="form-grid-3" id="imp-mapping">
          ${preview.fields.map(f => `
            <label class="field"><span>${FIELD_LABELS[f] || f}</span>
              <select data-field="${f}">${colOptions(preview.suggested_mapping[f])}</select></label>`).join('')}
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn" id="imp-back">← Назад</button>
          <button class="btn btn-primary" id="imp-commit">Импортировать ${preview.total_rows} строк</button>
        </div>
      </div>
      <div class="card">
        <h3 class="card-title">Первые строки файла</h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr>${preview.headers.map(h => `<th>${ui.esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${preview.preview.map(row =>
            `<tr>${preview.headers.map((_, i) => `<td>${ui.esc(String(row[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>`;

    el.querySelector('#imp-back').addEventListener('click', () => renderStep1(el));
    el.querySelector('#imp-commit').addEventListener('click', async e => {
      const mapping = {};
      el.querySelectorAll('#imp-mapping select').forEach(s => {
        if (s.value !== '') mapping[s.dataset.field] = Number(s.value);
      });
      if (mapping.name === undefined) { ui.toast('Укажите колонку «Наименование»', true); return; }
      e.target.disabled = true;
      try {
        const res = await api.post('/api/import/commit', {
          csv: state.csv, entity, mapping, delimiter: preview.delimiter,
        });
        renderResult(el, res);
      } catch (err) {
        ui.toastErr(err);
        e.target.disabled = false;
      }
    });
  }

  function renderResult(el, res) {
    el.querySelector('#imp-body').innerHTML = `
      <div class="card" style="max-width:640px">
        <h3 class="card-title">Импорт завершён</h3>
        <div class="grid grid-2">
          <div class="stat-tile" style="box-shadow:none"><div class="stat-label">Создано записей</div>
            <div class="stat-value" style="color:var(--good)">${res.created}</div></div>
          <div class="stat-tile" style="box-shadow:none"><div class="stat-label">Пропущено</div>
            <div class="stat-value" style="color:${res.skipped ? 'var(--warn)' : 'var(--ink)'}">${res.skipped}</div></div>
        </div>
        ${res.errors.length ? `<h4>Замечания</h4><ul style="padding-left:18px;color:var(--ink-2);font-size:13px">
          ${res.errors.map(e => `<li>${ui.esc(e)}</li>`).join('')}</ul>` : ''}
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="imp-again">Импортировать ещё файл</button>
          <a class="btn btn-primary" href="${state.entity === 'customers' ? '#/customers' : '#/products'}">Открыть ${state.entity === 'customers' ? 'клиентов' : 'каталог'}</a>
        </div>
      </div>`;
    el.querySelector('#imp-again').addEventListener('click', () => renderStep1(el));
  }

  return {
    title: 'Импорт из 1С',
    async render(el) {
      el.innerHTML = '<div id="imp-body"></div>';
      renderStep1(el);
    },
  };
})();
