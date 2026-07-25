'use strict';
window.Pages = window.Pages || {};

/*
 * Инвентаризация. Сканировать можно тремя способами:
 *   — обычным сканером штрихкодов (он «печатает» код и жмёт Enter);
 *   — камерой телефона, если браузер умеет BarcodeDetector (Chrome на Android);
 *   — просто набрать артикул руками.
 * Поле ввода всегда в фокусе, поэтому сканер работает без единого клика.
 */
window.Pages.inventory = (() => {
  let pageEl = null;
  let currentId = null;
  let cameraStop = null;   // остановка камеры, если она была включена

  function stopCamera() {
    if (cameraStop) { cameraStop(); cameraStop = null; }
  }

  // ---------- Список инвентаризаций ----------

  async function renderList(el) {
    const [{ items }, stores] = await Promise.all([
      api.get('/api/inventory'),
      api.get('/api/stores').then(r => r.items),
    ]);
    if (!el.isConnected) return;

    const open = items.find(i => i.status === 'open');
    el.innerHTML = `
      <div class="hint-box">
        <strong>Пересчёт витрины.</strong> Выберите точку и сканируйте изделия — сканером,
        камерой телефона или вводя артикул руками. Система сама покажет, чего не хватает
        и что лежит не на своём месте.
      </div>
      ${open ? `<div class="card" style="border-color:var(--gold)">
        <div class="row">
          <div class="grow">
            <div class="card-title" style="margin-bottom:4px">Идёт пересчёт</div>
            <div style="font-size:17px;font-weight:600">${ui.esc(open.store_name || 'Точка удалена')}</div>
            <div class="muted">начали ${ui.dt(open.started_at)} · отсканировано ${open.scans}</div>
          </div>
          <button class="btn btn-primary" data-continue="${open.id}">Продолжить</button>
        </div>
      </div>` : ''}

      <div class="toolbar">
        <select class="input" id="inv-store">
          ${stores.map(s => `<option value="${s.id}">${ui.esc(s.name)} — ${s.in_stock} изделий</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="inv-start">${ui.icon('scan')} Начать пересчёт</button>
      </div>

      <div class="card">
        <div class="card-title">История пересчётов</div>
        <div id="inv-list"></div>
      </div>`;

    const listEl = el.querySelector('#inv-list');
    const finished = items.filter(i => i.status === 'finished');
    listEl.innerHTML = ui.table([
      { title: 'Когда', render: r => ui.dt(r.started_at) },
      { title: 'Точка', render: r => ui.esc(r.store_name || '—') },
      { title: 'Кто считал', render: r => ui.esc(r.user_name || '—') },
      { title: 'Отсканировано', cls: 'num', render: r => r.scans },
      { title: 'Завершена', render: r => r.finished_at ? ui.dt(r.finished_at) : '—' },
    ], finished, { empty: 'Пересчётов ещё не было' });
    ui.bindRows(listEl, finished, r => openSession(r.id));

    const cont = el.querySelector('[data-continue]');
    if (cont) cont.addEventListener('click', () => openSession(Number(cont.dataset.continue)));

    el.querySelector('#inv-start').addEventListener('click', async () => {
      const storeId = el.querySelector('#inv-store').value;
      try {
        const res = await api.post('/api/inventory', { store_id: Number(storeId) });
        openSession(res.session.id);
      } catch (e) { ui.toastErr(e); }
    });
  }

  // ---------- Активная инвентаризация ----------

  async function openSession(id) {
    currentId = id;
    let data;
    try { data = await api.get('/api/inventory/' + id); }
    catch (e) { ui.toastErr(e); currentId = null; render(pageEl); return; }
    if (!pageEl || !pageEl.isConnected) return;

    const isOpen = data.session.status === 'open';
    const admin = App.isAdmin();

    pageEl.innerHTML = `
      <div class="row" style="margin-bottom:16px">
        <button class="btn" id="inv-back">← К списку</button>
        <div class="grow">
          <div style="font-size:18px;font-weight:600">${ui.esc(data.session.store_name || 'Точка')}</div>
          <div class="muted">${isOpen ? 'идёт пересчёт' : 'завершена ' + ui.dt(data.session.finished_at)}</div>
        </div>
      </div>

      ${isOpen ? `
        <div class="scan-box">
          <div class="progress-label">
            <span>Отсканировано ${data.counts.found} из ${data.counts.expected}</span>
            <strong>${data.progress}%</strong>
          </div>
          <div class="progress"><div class="pr-fill" style="width:${data.progress}%"></div></div>
          <input type="text" class="input scan-input" id="scan-code"
            placeholder="Отсканируйте или введите артикул" autocomplete="off"
            autocapitalize="none" autocorrect="off" spellcheck="false">
          <div class="row" style="justify-content:center;margin-top:10px">
            <button class="btn" id="scan-camera">${ui.icon('camera')} Сканировать камерой</button>
            <button class="btn" id="scan-photo">${ui.icon('image')} Распознать по фото</button>
          </div>
          <div id="camera-wrap" class="hidden" style="margin-top:12px">
            <video class="scan-video" id="scan-video" playsinline muted></video>
          </div>
          <div id="scan-msg"></div>
        </div>` : ''}

      <div class="grid grid-4" style="margin-bottom:18px">
        <div class="stat-tile"><div class="stat-label">Ожидается</div><div class="stat-value">${data.counts.expected}</div></div>
        <div class="stat-tile"><div class="stat-label">Найдено</div><div class="stat-value good">${data.counts.found}</div></div>
        <div class="stat-tile"><div class="stat-label">Не найдено</div>
          <div class="stat-value ${data.counts.missing ? 'crit' : ''}">${data.counts.missing}</div>
          ${data.counts.missing ? `<div class="stat-sub">на ${ui.money(data.values.missing_retail)}</div>` : ''}</div>
        <div class="stat-tile"><div class="stat-label">Лишнее</div>
          <div class="stat-value ${data.counts.extra ? 'warn' : ''}">${data.counts.extra}</div>
          <div class="stat-sub">не с этой точки</div></div>
      </div>

      ${data.missing.length ? `<div class="card">
        <div class="card-title">Не найдено — ${data.missing.length} шт${
          admin ? ` · закупочная стоимость ${ui.money(data.values.missing_cost)}` : ''}</div>
        ${itemsTable(data.missing)}
      </div>` : ''}

      ${data.extra.length ? `<div class="card">
        <div class="card-title">Лишнее — числится не здесь</div>
        ${ui.table([
          { title: '', cls: 'nowrap', render: thumbCell },
          { title: 'Артикул', render: r => `<span class="mono strong">${ui.esc(r.sku)}</span>` },
          { title: 'Наименование', render: r => ui.esc(r.name) },
          { title: 'Числится', render: r => r.status === 'in_stock' || r.status === 'reserved'
            ? `на точке «${ui.esc(r.store_name || '—')}»` : ui.badge('status', r.status) },
          { title: 'Цена', cls: 'num', render: r => ui.money(r.retail_price) },
        ], data.extra, { empty: '' })}
      </div>` : ''}

      ${data.found.length ? `<div class="card">
        <div class="card-title">Найдено — ${data.found.length} шт</div>
        ${itemsTable(data.found, isOpen)}
      </div>` : ''}

      ${isOpen ? `<div class="row" style="justify-content:flex-end;margin-top:8px">
        ${admin && data.missing.length
          ? '<button class="btn btn-danger" id="inv-writeoff">Завершить и списать недостачу</button>' : ''}
        <button class="btn btn-primary" id="inv-finish">Завершить пересчёт</button>
      </div>` : ''}`;

    pageEl.querySelector('#inv-back').addEventListener('click', () => {
      stopCamera(); currentId = null; render(pageEl);
    });

    if (isOpen) bindScanning();

    // Убрать ошибочно отсканированное изделие из списка найденного.
    pageEl.querySelectorAll('[data-unscan]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await api.del(`/api/inventory/${id}/scan/${btn.dataset.unscan}`);
          openSession(id);
        } catch (err) { ui.toastErr(err); }
      });
    });

    const finishBtn = pageEl.querySelector('#inv-finish');
    if (finishBtn) finishBtn.addEventListener('click', () => finish(id, false, data));
    const writeoffBtn = pageEl.querySelector('#inv-writeoff');
    if (writeoffBtn) writeoffBtn.addEventListener('click', () => finish(id, true, data));
  }

  function thumbCell(r) {
    return r.thumb
      ? `<img class="thumb-sm" src="${ui.esc(ui.photoUrl(r.thumb))}" alt="" loading="lazy">`
      : `<div class="thumb-sm-empty">${ui.icon('gem')}</div>`;
  }

  function itemsTable(rows, withRemove) {
    const cols = [
      { title: '', cls: 'nowrap', render: thumbCell },
      { title: 'Артикул', render: r => `<span class="mono strong">${ui.esc(r.sku)}</span>` },
      { title: 'Наименование', render: r => ui.esc(r.name) },
      { title: 'Металл', render: r => ui.esc(r.metal || '—') },
      { title: 'Вес', cls: 'num', render: r => r.weight ? ui.num(r.weight) + ' г' : '—' },
      { title: 'Цена', cls: 'num', render: r => ui.money(r.retail_price) },
    ];
    if (withRemove) {
      cols.push({ title: '', render: r =>
        `<button class="btn btn-sm btn-danger" data-unscan="${r.id}" title="Убрать из отсканированного">×</button>` });
    }
    return ui.table(cols, rows, { empty: '' });
  }

  async function finish(id, writeOff, data) {
    const text = writeOff
      ? `Завершить пересчёт и списать ${data.missing.length} ненайденных изделий? ` +
        'Они получат статус «Списано», а недостача попадёт в расходы. Отменить это будет нельзя.'
      : data.missing.length
        ? `Завершить пересчёт? ${data.missing.length} изделий так и не нашлись — они останутся в наличии.`
        : 'Завершить пересчёт? Всё сошлось.';
    if (!await ui.confirmDialog(text, { danger: writeOff, okLabel: writeOff ? 'Списать' : 'Завершить' })) return;
    try {
      await api.post(`/api/inventory/${id}/finish`, { write_off_missing: writeOff });
      stopCamera();
      ui.toast(writeOff ? 'Пересчёт завершён, недостача списана' : 'Пересчёт завершён');
      openSession(id);
    } catch (e) { ui.toastErr(e); }
  }

  // ---------- Сканирование ----------

  function bindScanning() {
    const input = pageEl.querySelector('#scan-code');
    const msg = pageEl.querySelector('#scan-msg');
    const focus = () => { if (input.isConnected) input.focus(); };
    focus();
    // Сканер штрихкодов «печатает» в активное поле — возвращаем фокус,
    // если пользователь случайно кликнул мимо.
    input.addEventListener('blur', () => setTimeout(focus, 400));

    let busy = false;
    async function submit(code) {
      if (busy || !code) return;
      busy = true;
      try {
        const res = await api.post(`/api/inventory/${currentId}/scan`, { code });
        const p = res.product;
        if (res.warning) {
          show('warn', `${p.sku} — ${p.name}. ${res.warning}`);
        } else if (res.duplicate) {
          show('ok', `${p.sku} — уже отсканировано`);
        } else {
          show('ok', `✓ ${p.sku} — ${p.name}`);
        }
        // Тихо обновляем счётчики, не сбрасывая фокус с поля ввода.
        refreshCounters();
      } catch (e) {
        show('err', e.message);
      } finally {
        busy = false;
        input.value = '';
        focus();
      }
    }

    function show(kind, text) {
      msg.innerHTML = `<div class="scan-feedback ${kind}">${ui.esc(text)}</div>`;
      if (navigator.vibrate) navigator.vibrate(kind === 'err' ? [90, 60, 90] : 40);
    }

    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submit(input.value.trim());
    });

    pageEl.querySelector('#scan-camera').addEventListener('click', () => startCamera(submit));

    // Фото бирки: в QR бывает и артикул, и ссылка с артикулом внутри —
    // пробуем варианты по очереди, пока изделие не найдётся.
    pageEl.querySelector('#scan-photo').addEventListener('click', async () => {
      show('ok', 'Выберите или сделайте фото бирки…');
      const text = await Scan.pickAndDecode();
      if (!text) { show('err', 'QR-код на фото не распознан. Снимите ближе и без бликов.'); return; }
      const list = Scan.candidates(text);
      for (const code of list) {
        try {
          await submitCode(code);
          return;
        } catch { /* этот вариант не подошёл — пробуем следующий */ }
      }
      show('err', `Код «${list[0]}» не найден в базе`);
    });

    // То же сканирование, но с ошибкой наружу — для перебора кандидатов.
    async function submitCode(code) {
      const res = await api.post(`/api/inventory/${currentId}/scan`, { code });
      const p = res.product;
      if (res.warning) show('warn', `${p.sku} — ${p.name}. ${res.warning}`);
      else if (res.duplicate) show('ok', `${p.sku} — уже отсканировано`);
      else show('ok', `✓ ${p.sku} — ${p.name}`);
      refreshCounters();
    }
  }

  // Обновление цифр без перерисовки страницы — чтобы не сбить сканирование.
  async function refreshCounters() {
    if (!currentId || !pageEl || !pageEl.isConnected) return;
    try {
      const d = await api.get('/api/inventory/' + currentId);
      const label = pageEl.querySelector('.progress-label');
      const fill = pageEl.querySelector('.pr-fill');
      if (!label || !fill) return;
      label.innerHTML = `<span>Отсканировано ${d.counts.found} из ${d.counts.expected}</span>
        <strong>${d.progress}%</strong>`;
      fill.style.width = d.progress + '%';
      const tiles = pageEl.querySelectorAll('.stat-tile .stat-value');
      if (tiles.length >= 4) {
        tiles[1].textContent = d.counts.found;
        tiles[2].textContent = d.counts.missing;
        tiles[3].textContent = d.counts.extra;
      }
    } catch { /* не критично: цифры обновятся при следующем открытии */ }
  }

  async function startCamera(submit) {
    const wrap = pageEl.querySelector('#camera-wrap');
    const video = pageEl.querySelector('#scan-video');
    if (cameraStop) { stopCamera(); wrap.classList.add('hidden'); return; }

    if (!Scan.cameraSupported()) {
      ui.toast('Камера в этом браузере недоступна. Используйте «Распознать по фото» ' +
        'или обычный сканер штрихкодов.', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
    } catch {
      ui.toast('Камера недоступна. Разрешите доступ к камере в настройках браузера.', true);
      return;
    }

    wrap.classList.remove('hidden');
    video.srcObject = stream;
    await video.play().catch(() => {});

    let last = '';
    let lastAt = 0;
    // Один и тот же код в кадре держится секундами — не шлём его на сервер потоком.
    const stopWatch = Scan.watchVideo(video, value => {
      if (value !== last || Date.now() - lastAt > 2500) {
        last = value;
        lastAt = Date.now();
        submit(value);
      }
    });

    cameraStop = () => {
      stopWatch();
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    };
  }

  async function render(el) {
    pageEl = el;
    stopCamera();
    if (currentId) return openSession(currentId);
    return renderList(el);
  }

  return { title: 'Инвентаризация', render };
})();
