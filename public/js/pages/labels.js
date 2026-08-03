'use strict';
window.Pages = window.Pages || {};

/*
 * Печать ценников и бирок.
 *
 * Штрихкод рисуется прямо в браузере (Code128) — печатать можно на обычном
 * принтере, а потом резать по пунктиру. Если у изделия свой штрихкод из 1С,
 * печатаем его; если нет — кодируем артикул, и такую бирку потом читает
 * сканер при продаже и инвентаризации.
 */
window.Pages.labels = (() => {
  let selected = new Map();   // id → изделие
  let pageEl = null;

  // Что печатать на бирке — набор полей запоминается между сеансами.
  const OPTS_KEY = 'asher_label_opts';
  const defaultOpts = { name: true, sku: true, metal: true, weight: true, price: true, barcode: true, qr: false, store: false };
  function loadOpts() {
    try { return { ...defaultOpts, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; }
    catch { return { ...defaultOpts }; }
  }
  let opts = loadOpts();

  // QR с артикулом: читается камерой любого телефона и «Распознать по фото».
  function qrSvg(code) {
    try {
      // Артикул может быть с кириллицей («К-001»). По умолчанию библиотека
      // кладёт в QR младший байт символа и превращает «Ж» в мусор — переключаем
      // на UTF-8, как и ждут все читающие программы.
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const qr = qrcode(0, 'M');
      qr.addData(String(code));
      qr.make();
      return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
    } catch { return ''; }
  }

  function labelHtml(p, o = opts) {
    const code = p.barcode || p.sku;
    const meta = [o.metal ? p.metal : '', o.weight && p.weight ? ui.num(p.weight) + ' г' : '', p.size]
      .filter(Boolean).join(' · ');
    return `
      <div class="jlabel">
        ${o.name ? `<div class="jl-name">${ui.esc(p.name)}</div>` : ''}
        ${o.sku ? `<div class="jl-sku">${ui.esc(p.sku)}</div>` : ''}
        ${meta ? `<div>${ui.esc(meta)}</div>` : ''}
        ${o.store && p.store_name ? `<div>${ui.esc(p.store_name)}</div>` : ''}
        ${o.price ? `<div class="jl-price">${ui.money(p.retail_price)}</div>` : ''}
        ${o.qr && code ? `<div class="jl-qr">${qrSvg(code)}</div>` : ''}
        ${o.barcode && code ? ui.barcodeSvg(code) +
          `<div class="jl-sku" style="text-align:center;letter-spacing:.08em">${ui.esc(code)}</div>` : ''}
      </div>`;
  }

  // Печать: кладём бирки в скрытый блок, который единственный виден при печати.
  function printLabels(products, o = opts) {
    if (!products.length) { ui.toast('Не выбрано ни одного изделия', true); return; }
    const root = document.getElementById('print-root');
    root.innerHTML = `<div class="label-sheet">${products.map(p => labelHtml(p, o)).join('')}</div>`;
    // Даём браузеру отрисовать SVG до вызова диалога печати.
    setTimeout(() => {
      window.print();
      setTimeout(() => { root.innerHTML = ''; }, 500);
    }, 60);
  }

  // Печать одной бирки — вызывается из карточки изделия.
  function printOne(product) {
    const m = ui.modal({
      title: 'Бирка: ' + product.name,
      size: 'sm',
      body: `<div id="one-preview" style="max-width:220px;margin:0 auto 14px">${labelHtml(product)}</div>
        <div class="form-hint">Печатается на обычном принтере. Штрихкод потом читается сканером
        при продаже и инвентаризации.</div>`,
      footer: `<button class="btn" data-act="cancel">Закрыть</button>
        <button class="btn btn-primary" data-act="print">${ui.icon('print')} Печатать</button>`,
    });
    m.foot.querySelector('[data-act=cancel]').onclick = m.close;
    m.foot.querySelector('[data-act=print]').onclick = () => { printLabels([product]); m.close(); };
  }

  // ---------- Страница ----------

  let refreshSeq = 0;
  async function refreshList(filters) {
    const my = ++refreshSeq;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    q.set('limit', '300');
    const { items, total } = await api.get('/api/products?' + q.toString());
    if (my !== refreshSeq || !pageEl.isConnected) return;

    const listEl = pageEl.querySelector('#lb-list');
    listEl.innerHTML = `<div class="muted" style="margin-bottom:8px">
        ${items.length < total ? `Показано ${items.length} из ${total} — уточните поиск` : `Найдено: ${total}`}
      </div>` + ui.table([
      { title: '', cls: 'nowrap', render: r =>
        `<input type="checkbox" data-pick="${r.id}" ${selected.has(r.id) ? 'checked' : ''}
          style="width:22px;height:22px;cursor:pointer">` },
      { title: 'Артикул', render: r => `<span class="mono strong">${ui.esc(r.sku)}</span>` },
      { title: 'Наименование', render: r => ui.esc(r.name) },
      { title: 'Металл', render: r => ui.esc(r.metal || '—') },
      { title: 'Вес', cls: 'num', render: r => r.weight ? ui.num(r.weight) + ' г' : '—' },
      { title: 'Цена', cls: 'num strong', render: r => ui.money(r.retail_price) },
      { title: 'Штрихкод', render: r => r.barcode
        ? `<span class="mono dim">${ui.esc(r.barcode)}</span>`
        : '<span class="dim">по артикулу</span>' },
    ], items, { empty: 'Изделий не найдено' });

    listEl.querySelectorAll('[data-pick]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.pick);
        if (cb.checked) selected.set(id, items.find(p => p.id === id));
        else selected.delete(id);
        updateSelection();
      });
    });
    // Клик по строке тоже переключает галочку — так быстрее набирать пачку.
    listEl.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.matches('[data-pick]')) return;
        const cb = tr.querySelector('[data-pick]');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });
    pageEl.querySelector('#lb-all').onclick = () => {
      const allPicked = items.every(p => selected.has(p.id));
      items.forEach(p => allPicked ? selected.delete(p.id) : selected.set(p.id, p));
      listEl.querySelectorAll('[data-pick]').forEach(cb => { cb.checked = !allPicked; });
      updateSelection();
    };
    updateSelection();
  }

  function updateSelection() {
    const count = selected.size;
    pageEl.querySelector('#lb-count').textContent = count
      ? `Выбрано изделий: ${count}` : 'Ничего не выбрано';
    pageEl.querySelector('#lb-print').disabled = count === 0;
    pageEl.querySelector('#lb-clear').disabled = count === 0;
    const preview = pageEl.querySelector('#lb-preview');
    const list = [...selected.values()].slice(0, 8);
    preview.innerHTML = list.length
      ? `<div class="label-sheet">${list.map(p => labelHtml(p)).join('')}</div>
         ${count > list.length ? `<div class="muted" style="margin-top:8px">…и ещё ${count - list.length}</div>` : ''}`
      : '<div class="muted">Отметьте изделия — здесь появится образец бирки.</div>';
  }

  async function render(el) {
    pageEl = el;
    selected = new Map();
    const [cats, stores] = await Promise.all([
      api.get('/api/categories').then(r => r.items),
      api.get('/api/stores').then(r => r.items).catch(() => []),
    ]);
    if (!el.isConnected) return;

    const filters = { search: '', category_id: '', store_id: '', status: 'in_stock' };
    const optRow = (key, title) =>
      `<label class="row-tight" style="cursor:pointer">
         <input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''}
           style="width:20px;height:20px;cursor:pointer"> ${title}</label>`;

    el.innerHTML = `
      <div class="hint-box">
        <strong>Ценники и бирки.</strong> Отметьте изделия, проверьте образец справа и печатайте.
        Штрихкод на бирке читается сканером при продаже и инвентаризации — даже если своего
        штрихкода у изделия нет, он будет закодирован из артикула.
      </div>

      <div class="two-col">
        <div>
          <div class="toolbar">
            <input type="text" class="input search" id="lb-search" placeholder="Поиск изделия…" autocomplete="off">
            <select class="input" id="lb-cat"><option value="">Все категории</option>
              ${cats.map(c => `<option value="${c.id}">${ui.esc(c.name)}</option>`).join('')}</select>
            ${stores.length > 1 ? `<select class="input" id="lb-store"><option value="">Все точки</option>
              ${stores.map(s => `<option value="${s.id}">${ui.esc(s.name)}</option>`).join('')}</select>` : ''}
            <button class="btn" id="lb-all">Выбрать все</button>
          </div>
          <div class="card"><div id="lb-list"></div></div>
        </div>

        <div>
          <div class="card">
            <div class="card-title">Что печатать на бирке</div>
            <div class="row" style="gap:14px;margin-bottom:14px">
              ${optRow('name', 'Название')}
              ${optRow('sku', 'Артикул')}
              ${optRow('metal', 'Металл')}
              ${optRow('weight', 'Вес')}
              ${optRow('price', 'Цена')}
              ${optRow('barcode', 'Штрихкод')}
              ${optRow('qr', 'QR-код')}
              ${stores.length > 1 ? optRow('store', 'Точка') : ''}
            </div>
            <div class="card-title">Образец</div>
            <div id="lb-preview"></div>
          </div>
          <div class="card">
            <div style="font-size:16px;font-weight:600;margin-bottom:12px" id="lb-count">Ничего не выбрано</div>
            <div class="row">
              <button class="btn btn-primary grow" id="lb-print">${ui.icon('print')} Печатать бирки</button>
              <button class="btn" id="lb-clear">Сбросить</button>
            </div>
          </div>
        </div>
      </div>`;

    const doRefresh = () => refreshList(filters).catch(ui.toastErr);
    el.querySelector('#lb-search').addEventListener('input', ui.debounce(e => {
      filters.search = e.target.value.trim();
      doRefresh();
    }));
    el.querySelector('#lb-cat').addEventListener('change', e => { filters.category_id = e.target.value; doRefresh(); });
    const storeSel = el.querySelector('#lb-store');
    if (storeSel) storeSel.addEventListener('change', e => { filters.store_id = e.target.value; doRefresh(); });

    el.querySelectorAll('[data-opt]').forEach(cb => {
      cb.addEventListener('change', () => {
        opts[cb.dataset.opt] = cb.checked;
        localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
        updateSelection();
      });
    });

    el.querySelector('#lb-print').addEventListener('click', () => printLabels([...selected.values()]));
    el.querySelector('#lb-clear').addEventListener('click', () => {
      selected = new Map();
      el.querySelectorAll('[data-pick]').forEach(cb => { cb.checked = false; });
      updateSelection();
    });

    await refreshList(filters);
  }

  return { title: 'Ценники и бирки', render, printOne, printLabels };
})();
