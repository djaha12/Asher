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

      <h2 class="section-title">Фотографии изделий</h2>
      <div class="card">
        <div class="hint-box" style="margin-bottom:14px">
          <strong>Перенос фотографий из 1С.</strong> Если фотографии лежат папкой и названы
          артикулом изделия — <code>AS-00120.jpg</code>, <code>AS-00120_2.jpg</code> — укажите папку,
          и система разложит их по изделиям сама. Второй и третий ракурс распознаются по суффиксу
          <code>_2</code>, <code>-3</code> или <code>(2)</code>.
        </div>
        <div class="dropzone" id="ph-drop">
          <div class="dz-ico">${ui.icon('folder')}</div>
          <div class="dz-main">Выбрать папку с фотографиями</div>
          <div class="dz-sub">Или перетащите сюда файлы — имя файла должно совпадать с артикулом</div>
        </div>
        <div id="ph-result" style="margin-top:14px"></div>
      </div>

      <h2 class="section-title">Экспорт данных из Asher</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Резервная копия или перенос в Excel — данные выгружаются в CSV (открывается в Excel).</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn" href="/api/export/products" download>${ui.icon('gem')} Изделия</a>
          <a class="btn" href="/api/export/customers" download>${ui.icon('users')} Клиенты</a>
          <a class="btn" href="/api/export/sales" download>${ui.icon('csv')} Продажи</a>
        </div>
      </div>`;

    bindPhotoImport(el);

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

  // ---------- Массовый перенос фотографий ----------

  function bindPhotoImport(el) {
    const drop = el.querySelector('#ph-drop');
    const result = el.querySelector('#ph-result');

    drop.addEventListener('click', async () => handleFiles(await Photos.pickFolder()));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async e => {
      e.preventDefault();
      drop.classList.remove('over');
      handleFiles([...e.dataTransfer.files]);
    });

    async function handleFiles(files) {
      const images = (files || []).filter(Photos.isImage);
      if (!images.length) { ui.toast('Изображений не найдено', true); return; }

      // Сначала спрашиваем сервер, какому изделию какой файл принадлежит —
      // так пользователь видит расклад до того, как что-то загрузится.
      const names = images.map(f => f.name);
      let match;
      try { match = await api.post('/api/images/match', { names }); }
      catch (e) { ui.toastErr(e); return; }

      const matched = images.filter(f => match.matched[f.name]);
      const unmatched = match.unmatched;
      const withPhotos = matched.filter(f => match.already[f.name]).length;

      result.innerHTML = `
        <div class="grid grid-3" style="margin-bottom:14px">
          <div class="stat-tile"><div class="stat-label">Файлов выбрано</div>
            <div class="stat-value">${images.length}</div></div>
          <div class="stat-tile"><div class="stat-label">Нашли своё изделие</div>
            <div class="stat-value good">${matched.length}</div></div>
          <div class="stat-tile"><div class="stat-label">Не нашли артикул</div>
            <div class="stat-value ${unmatched.length ? 'warn' : ''}">${unmatched.length}</div></div>
        </div>
        ${withPhotos ? `<p class="muted">У ${withPhotos} изделий фотографии уже есть — новые добавятся к ним.</p>` : ''}
        ${unmatched.length ? `<details style="margin-bottom:12px">
          <summary style="cursor:pointer">Показать файлы без совпадения (${unmatched.length})</summary>
          <div class="muted" style="font-size:13px;margin-top:8px;max-height:160px;overflow:auto">
            ${unmatched.slice(0, 300).map(n => ui.esc(n)).join('<br>')}
          </div></details>` : ''}
        ${matched.length ? `
          <div class="progress-label"><span id="ph-status">Готово к загрузке</span><span id="ph-count"></span></div>
          <div class="progress"><div class="pr-fill" id="ph-fill" style="width:0%"></div></div>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-primary" id="ph-go">Загрузить ${matched.length} фотографий</button>
            <button class="btn" id="ph-cancel" disabled>Остановить</button>
          </div>` : '<p class="muted">Загружать нечего: ни одно имя файла не совпало с артикулом.</p>'}`;

      if (!matched.length) return;

      const goBtn = result.querySelector('#ph-go');
      const cancelBtn = result.querySelector('#ph-cancel');
      const fill = result.querySelector('#ph-fill');
      const status = result.querySelector('#ph-status');
      const counter = result.querySelector('#ph-count');
      let stop = false;

      cancelBtn.addEventListener('click', () => { stop = true; status.textContent = 'Останавливаю…'; });
      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        cancelBtn.disabled = false;
        let done = 0;
        const failed = [];
        for (const file of matched) {
          if (stop) break;
          status.textContent = `Загружаю: ${file.name}`;
          try {
            await Photos.upload(match.matched[file.name], file);
          } catch (e) {
            failed.push(`${file.name}: ${e.message}`);
          }
          done++;
          const pct = Math.round(done / matched.length * 100);
          fill.style.width = pct + '%';
          counter.textContent = `${done} из ${matched.length} · ${pct}%`;
        }
        cancelBtn.disabled = true;
        status.textContent = stop
          ? `Остановлено. Загружено ${done - failed.length} фотографий.`
          : `Готово: загружено ${done - failed.length} из ${matched.length}.`;
        if (failed.length) {
          result.insertAdjacentHTML('beforeend',
            `<div class="hint-box" style="margin-top:12px"><strong>Не загрузились (${failed.length}):</strong><br>
             ${failed.slice(0, 20).map(f => ui.esc(f)).join('<br>')}</div>`);
        }
        ui.toast(`Фотографий загружено: ${done - failed.length}`);
      });
    }
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
        ${entity === 'products' ? `
          <div class="hint-box">
            <label class="row-tight" style="cursor:pointer">
              <input type="checkbox" id="imp-update" style="width:20px;height:20px;cursor:pointer">
              <strong>Это повторная выгрузка — обновить то, что уже есть</strong>
            </label>
            <div id="imp-update-opts" class="hidden" style="margin-top:10px">
              Изделия сопоставляются по артикулу. Что перезаписать из файла:
              <div class="row" style="gap:14px;margin-top:8px">
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="retail_price" checked style="width:20px;height:20px"> Розничная цена</label>
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="purchase_price" checked style="width:20px;height:20px"> Закупочная цена</label>
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="name" style="width:20px;height:20px"> Наименование</label>
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="barcode" style="width:20px;height:20px"> Штрихкод</label>
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="category_id" style="width:20px;height:20px"> Категория</label>
                <label class="row-tight" style="cursor:pointer"><input type="checkbox" data-uf="weight" style="width:20px;height:20px"> Вес</label>
              </div>
              <p style="margin:10px 0 0">Проданные и списанные изделия не трогаем — у них своя история.
              Новых позиций из файла это не касается: они добавятся в любом случае.</p>
            </div>
          </div>` : `
          <p class="form-hint">Клиенты с уже известным телефоном будут пропущены — задвоений не появится.</p>`}
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
    const updateCb = el.querySelector('#imp-update');
    if (updateCb) {
      updateCb.addEventListener('change', () => {
        el.querySelector('#imp-update-opts').classList.toggle('hidden', !updateCb.checked);
        el.querySelector('#imp-commit').textContent = updateCb.checked
          ? `Обновить и добавить (${preview.total_rows} строк)`
          : `Импортировать ${preview.total_rows} строк`;
      });
    }

    el.querySelector('#imp-commit').addEventListener('click', async e => {
      const mapping = {};
      el.querySelectorAll('#imp-mapping select').forEach(s => {
        if (s.value !== '') mapping[s.dataset.field] = Number(s.value);
      });
      if (mapping.name === undefined) { ui.toast('Укажите колонку «Наименование»', true); return; }
      const updateExisting = Boolean(updateCb && updateCb.checked);
      const updateFields = [...el.querySelectorAll('[data-uf]:checked')].map(c => c.dataset.uf);
      if (updateExisting && !updateFields.length) {
        ui.toast('Отметьте хотя бы одно поле для обновления', true);
        return;
      }
      if (updateExisting && mapping.sku === undefined) {
        ui.toast('Для обновления нужна колонка «Артикул» — по ней ищутся изделия', true);
        return;
      }
      e.target.disabled = true;
      try {
        const res = await api.post('/api/import/commit', {
          csv: state.csv, entity, mapping, delimiter: preview.delimiter,
          update_existing: updateExisting, update_fields: updateFields,
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
            <div class="stat-value good">${res.created}</div></div>
          ${res.updated ? `<div class="stat-tile" style="box-shadow:none"><div class="stat-label">Обновлено</div>
            <div class="stat-value gold">${res.updated}</div></div>` : ''}
          ${res.unchanged ? `<div class="stat-tile" style="box-shadow:none"><div class="stat-label">Без изменений</div>
            <div class="stat-value">${res.unchanged}</div></div>` : ''}
          <div class="stat-tile" style="box-shadow:none"><div class="stat-label">Пропущено</div>
            <div class="stat-value ${res.skipped ? 'warn' : ''}">${res.skipped}</div></div>
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
