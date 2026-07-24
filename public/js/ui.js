'use strict';
// Общие компоненты интерфейса и форматирование
window.ui = (() => {
  // экранируем и кавычки — строки подставляются в том числе в атрибуты value="…"
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
  }

  const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  function money(n, withSign) {
    const v = Number(n) || 0;
    const cur = (window.App && window.App.currency) || '₽';
    const s = moneyFmt.format(v) + ' ' + cur;
    return withSign && v > 0 ? '+' + s : s;
  }
  function num(n) { return moneyFmt.format(Number(n) || 0); }

  function dt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function dateOnly(iso) {
    if (!iso) return '—';
    // '2026-07-10' без сдвига часового пояса
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split('-');
      return `${d}.${m}.${y}`;
    }
    return new Date(iso).toLocaleDateString('ru-RU');
  }

  const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  function monthName(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    return `${MONTHS_RU[(m || 1) - 1]} ${y}`;
  }

  // Справочники подписей
  const L = {
    status: { in_stock: 'В наличии', reserved: 'Резерв', sold: 'Продано', written_off: 'Списано' },
    statusBadge: { in_stock: 'good', reserved: 'warn', sold: 'gray', written_off: 'crit' },
    segment: { new: 'Новый', regular: 'Постоянный', vip: 'VIP' },
    segmentBadge: { new: 'gray', regular: 'info', vip: 'gold' },
    payment: { cash: 'Наличные', card: 'Карта', transfer: 'Перевод', installment: 'Рассрочка' },
    saleStatus: { completed: 'Завершена', partial_return: 'Част. возврат', returned: 'Возврат' },
    saleStatusBadge: { completed: 'good', partial_return: 'warn', returned: 'crit' },
    orderType: { repair: 'Ремонт', custom: 'Изготовление', engraving: 'Гравировка', resize: 'Изм. размера', cleaning: 'Чистка', appraisal: 'Оценка' },
    orderStatus: { accepted: 'Принят', in_progress: 'В работе', ready: 'Готов', delivered: 'Выдан', cancelled: 'Отменён' },
    orderStatusBadge: { accepted: 'info', in_progress: 'warn', ready: 'good', delivered: 'gray', cancelled: 'crit' },
  };
  function badge(kind, value) {
    const label = (L[kind] && L[kind][value]) || value || '—';
    const tone = (L[kind + 'Badge'] && L[kind + 'Badge'][value]) || 'gray';
    return `<span class="badge badge-${tone}">${esc(label)}</span>`;
  }

  // ---------- Модальные окна ----------
  const modalRoot = () => document.getElementById('modal-root');

  function modal({ title, body, footer, size, onClose }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${size === 'lg' ? 'modal-lg' : size === 'sm' ? 'modal-sm' : ''}">
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          <button class="modal-close" title="Закрыть">×</button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;
    const bodyEl = overlay.querySelector('.modal-body');
    const footEl = overlay.querySelector('.modal-foot');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else if (footer) footEl.appendChild(footer);
    else footEl.remove();

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
      if (onClose) onClose();
    }
    // Escape закрывает только верхнюю модалку (важно для вложенных подтверждений)
    const escHandler = e => {
      if (e.key === 'Escape' && overlay === modalRoot().lastElementChild) close();
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    overlay.querySelector('.modal-close').addEventListener('click', close);
    document.addEventListener('keydown', escHandler);
    modalRoot().appendChild(overlay);
    return { overlay, body: bodyEl, foot: footEl, close };
  }

  function confirmDialog(text, { danger = false, okLabel = 'Подтвердить' } = {}) {
    return new Promise(resolve => {
      const m = modal({
        title: 'Подтверждение',
        size: 'sm',
        body: `<p style="margin:4px 0 8px">${esc(text)}</p>`,
        footer: `
          <button class="btn" data-act="cancel">Отмена</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okLabel)}</button>`,
        onClose: () => resolve(false),
      });
      m.foot.querySelector('[data-act=cancel]').onclick = () => { m.close(); };
      m.foot.querySelector('[data-act=ok]').onclick = () => { resolve(true); m.close(); };
    });
  }

  // ---------- Тосты ----------
  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' err' : '');
    el.textContent = msg;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3400);
    setTimeout(() => el.remove(), 3800);
  }
  function toastErr(e) { toast(e && e.message ? e.message : String(e), true); }

  // ---------- Таблица ----------
  // cols: [{title, cls, render(row)}]
  function table(cols, rows, { onRow, empty = 'Ничего не найдено', foot } = {}) {
    if (!rows.length) {
      return `<div class="empty"><div class="empty-ico">◇</div><p>${esc(empty)}</p></div>`;
    }
    const head = cols.map(c => `<th class="${c.cls || ''}">${c.title}</th>`).join('');
    const body = rows.map((r, i) =>
      `<tr class="${onRow ? 'clickable' : ''}" data-i="${i}">` +
      cols.map(c => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('') + '</tr>'
    ).join('');
    const footHtml = foot ? `<tfoot><tr>${foot.map(f => `<td class="${f.cls || ''}">${f.html}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footHtml}</table></div>`;
  }
  function bindRows(container, rows, onRow) {
    if (!onRow) return;
    container.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => onRow(rows[Number(tr.dataset.i)]));
    });
  }

  // ---------- Формы ----------
  function formValues(formEl) {
    const out = {};
    for (const el of formEl.querySelectorAll('[name]')) {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    }
    return out;
  }

  function debounce(fn, ms = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---------- Тема оформления ----------
  // Выбор запоминается в браузере: у каждого сотрудника на своём устройстве свой.
  const THEME_KEY = 'asher_theme';
  function currentTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.textContent = theme === 'dark' ? '☀' : '☾';
      el.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    });
  }
  function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

  // ---------- Просмотр фотографий во весь экран ----------
  function lightbox(urls, startIndex = 0) {
    if (!urls.length) return;
    let i = Math.max(0, Math.min(startIndex, urls.length - 1));
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <button class="lb-close" title="Закрыть">×</button>
      ${urls.length > 1 ? '<button class="lb-nav lb-prev" title="Предыдущее">‹</button>' : ''}
      <img alt="Фотография изделия">
      ${urls.length > 1 ? '<button class="lb-nav lb-next" title="Следующее">›</button>' : ''}`;
    const img = box.querySelector('img');
    const show = () => { img.src = urls[i]; };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const step = d => { i = (i + d + urls.length) % urls.length; show(); };
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    }
    box.querySelector('.lb-close').onclick = close;
    box.querySelector('.lb-prev')?.addEventListener('click', e => { e.stopPropagation(); step(-1); });
    box.querySelector('.lb-next')?.addEventListener('click', e => { e.stopPropagation(); step(1); });
    box.addEventListener('click', e => { if (e.target === box || e.target === img) close(); });
    document.addEventListener('keydown', onKey);
    show();
    document.body.appendChild(box);
  }

  // ---------- Штрихкод Code128 для бирок ----------
  // Ширины полос для всех 107 знаков таблицы Code128 (символ 106 — стоп).
  const C128 = ('212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,' +
    '122132,122231,113222,123122,123221,223211,221132,221231,213212,223112,312131,311222,321122,321221,' +
    '312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,231113,' +
    '231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,' +
    '311321,331121,312113,312311,332111,314111,221411,431111,111224,111422,121124,121421,141122,141221,' +
    '112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,111242,121142,121241,' +
    '114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,' +
    '411113,411311,113141,114131,311141,411131,211412,211214,211232,2331112').split(',');

  // Возвращает SVG со штрихкодом. Кодируем набором B: подходит для цифр,
  // латиницы и дефисов — то, из чего состоят ювелирные артикулы.
  function barcodeSvg(text, { height = 40 } = {}) {
    const value = String(text || '').replace(/[^\x20-\x7e]/g, '');
    if (!value) return '';
    const codes = [104]; // старт B
    for (const ch of value) codes.push(ch.charCodeAt(0) - 32);
    let sum = codes[0];
    for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
    codes.push(sum % 103, 106); // контрольный знак и стоп

    let x = 0;
    let bars = '';
    for (const code of codes) {
      let dark = true;
      for (const ch of C128[code]) {
        const w = Number(ch);
        if (dark) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
        x += w;
        dark = !dark;
      }
    }
    return `<svg viewBox="0 0 ${x} ${height}" preserveAspectRatio="none" fill="currentColor" ` +
      `role="img" aria-label="Штрихкод ${esc(value)}">${bars}</svg>`;
  }

  // Ссылка на фотографию по пути из базы.
  function photoUrl(file) { return file ? '/media/' + file : ''; }

  // Подсветка совпадения при поиске — глазам легче найти нужную строку.
  function highlight(text, query) {
    const s = esc(text);
    const q = String(query || '').trim();
    if (!q) return s;
    const idx = s.toLowerCase().indexOf(esc(q).toLowerCase());
    if (idx < 0) return s;
    return s.slice(0, idx) + '<mark>' + s.slice(idx, idx + q.length) + '</mark>' + s.slice(idx + q.length);
  }

  // Ссылка «написать в WhatsApp» с готовым текстом.
  function whatsappLink(phone, text) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 10) return '';
    const normalized = digits.length === 11 && digits[0] === '8' ? '7' + digits.slice(1) : digits;
    return `https://wa.me/${normalized}?text=${encodeURIComponent(text || '')}`;
  }

  return { esc, money, num, dt, dateOnly, monthName, badge, L, modal, confirmDialog, toast, toastErr,
    table, bindRows, formValues, debounce, currentTheme, applyTheme, toggleTheme, lightbox,
    barcodeSvg, photoUrl, highlight, whatsappLink };
})();

// Тему применяем сразу при загрузке, до первого кадра — чтобы не мигало белым.
ui.applyTheme(ui.currentTheme());
