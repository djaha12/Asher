'use strict';
// Общие компоненты интерфейса и форматирование
window.ui = (() => {
  /*
   * Иконки — простые SVG-контуры в стиле современных продуктов.
   * Рисуются кодом, без внешних библиотек; цвет наследуется от текста.
   * Эмодзи в интерфейсе больше не используются.
   */
  const ICONS = {
    diamond: '<path d="M7 3h10l4 6-9 12L3 9l4-6z"/><path d="M3 9h18M9.5 3 8 9l4 12M14.5 3 16 9l-4 12"/>',
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h12V10"/>',
    sale: '<path d="M6 3.5h12V20l-2-1.4L14 20l-2-1.4L10 20l-2-1.4L6 20V3.5z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
    gem: '<path d="M8 4h8l3 4.5L12 20 5 8.5 8 4z"/><path d="M5 8.5h14M10 4l-1 4.5 3 11.5M14 4l1 4.5-3 11.5"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M15.5 5.4a3.2 3.2 0 0 1 0 5.9M17 14.8c2 .6 3.5 2.3 3.5 4.7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    wrench: '<path d="M14.5 6.5a4.5 4.5 0 0 0-6 4.3L4 15.3a2 2 0 0 0 2.8 2.8l4.5-4.4a4.5 4.5 0 0 0 6-4.3l-2.6 2.5-2.5-.6-.6-2.5 2.9-2.3z"/>',
    clipboard: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5V3h6v3H9V4.5zM9 12l2 2 4-4"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9V4z"/><circle cx="8.5" cy="8.5" r="1.4"/>',
    wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17M7 6V4.5h10V6"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M5.5 3v4h4M18.5 21v-4h-4"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="m19 12 1.7-1-1-2.6-2 .3a7 7 0 0 0-1.4-1.4l.3-2-2.6-1-1 1.7a7 7 0 0 0-2 0l-1-1.7-2.6 1 .3 2A7 7 0 0 0 6.3 8.7l-2-.3-1 2.6L5 12l-1.7 1 1 2.6 2-.3a7 7 0 0 0 1.4 1.4l-.3 2 2.6 1 1-1.7a7 7 0 0 0 2 0l1 1.7 2.6-1-.3-2a7 7 0 0 0 1.4-1.4l2 .3 1-2.6L19 12z"/>',
    logout: '<path d="M14 4h-8.5v16H14"/><path d="M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8h3l1.8-2.5h6.4L17 8h3v11H4V8z"/><circle cx="12" cy="13" r="3.4"/>',
    folder: '<path d="M3.5 6h6l2 2.5h9V19h-17V6z"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4 3 2.5L16 12l3.5 3.5"/>',
    print: '<path d="M7 8V4h10v4M7 16H4.5V8h15V16H17"/><rect x="7" y="13.5" width="10" height="6.5"/>',
    exchange: '<path d="M4 8h13M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7M10 12.5 6.5 16l3.5 3.5"/>',
    money: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.7 9.5v.01M17.3 14.5v.01"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.8h2"/>',
    whatsapp: '<path d="M12 4a8 8 0 0 0-6.9 12L4 20l4.2-1A8 8 0 1 0 12 4z"/><path d="M9.3 9.2c.3 2.5 2.9 5.1 5.4 5.4l1-1.6-2-1.2-.9.7c-.7-.4-1.4-1.1-1.8-1.8l.7-.9-1.2-2-1.2.4z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M7 12h10"/>',
    gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M12 10v10M4.5 10H20M12 10s-4.5-.3-4.5-3a2 2 0 0 1 4-.5L12 10zm0 0s4.5-.3 4.5-3a2 2 0 0 0-4-.5L12 10z"/>',
    check: '<path d="m5 13 4.5 4.5L19 7"/>',
    truck: '<path d="M3.5 6h11v10h-11V6z"/><path d="M14.5 10h3.5l2.5 3v3h-6"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
    building: '<path d="M4.5 20V5.5h9V20M13.5 9.5h6V20"/><path d="M3 20h18M7 8.5h1.5M7 11.5h1.5M7 14.5h1.5M16 12.5h1.5M16 15.5h1.5"/>',
    csv: '<path d="M6 3.5h8l4 4V20.5H6V3.5z"/><path d="M14 3.5V8h4"/><path d="M9 13h6M9 16.5h6"/>',
    // Сертификат на камень: документ с печатью
    certificate: '<path d="M6 3.5h8l4 4v7H6V3.5z"/><path d="M14 3.5V8h4"/><circle cx="12" cy="18" r="3"/><path d="M10.4 20.4 9.5 23l2.5-1.3 2.5 1.3-.9-2.6"/>',
  };

  function icon(name, cls = '') {
    const path = ICONS[name] || ICONS.diamond;
    return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  }
  // экранируем и кавычки — строки подставляются в том числе в атрибуты value="…"
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
  }

  // ---------- Деньги и числа ----------
  // Формат зависит от страны магазина: в сомах и тенге разменной монеты нет,
  // поэтому «45 000 сом», а не «45 000,00». Настройки приходят с сервера,
  // здесь только запасные значения на случай, если страница открылась раньше их загрузки.
  const FALLBACK = { currency: 'сом', money_decimals: 0, number_locale: 'ru-RU' };
  function loc() { return (window.App && window.App.locale) || FALLBACK; }

  // Форматтеры дорогие, а вызываются на каждую ячейку таблицы — держим готовые.
  const fmtCache = new Map();
  function formatter(locale, decimals) {
    const key = locale + '|' + decimals;
    if (!fmtCache.has(key)) {
      let fmt;
      try {
        fmt = new Intl.NumberFormat(locale, {
          minimumFractionDigits: 0, maximumFractionDigits: decimals,
        });
      } catch {
        // Неизвестный браузеру код локали не должен ронять всю страницу.
        fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: decimals });
      }
      fmtCache.set(key, fmt);
    }
    return fmtCache.get(key);
  }

  function money(n, withSign) {
    const v = Number(n) || 0;
    const l = loc();
    const s = formatter(l.number_locale, l.money_decimals).format(v) + ' ' + (l.currency || '');
    return withSign && v > 0 ? '+' + s : s;
  }

  // Крупные суммы на плитках: цифра большая, подпись валюты мельче и приглушённее.
  // Со словом «сом» вместо знака «₽» сумма иначе не помещается в плитку,
  // а дробить число переносом строки нельзя — его перестаёт быть видно с прилавка.
  function moneyRich(n) {
    const l = loc();
    const value = formatter(l.number_locale, l.money_decimals).format(Number(n) || 0);
    return `${esc(value)}<span class="cur">${esc(l.currency || '')}</span>`;
  }

  // Не деньги: вес в граммах, количество. Здесь дробная часть нужна всегда,
  // иначе «3,15 г» превратится в «3 г».
  function num(n, decimals = 2) {
    return formatter(loc().number_locale, decimals).format(Number(n) || 0);
  }

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
      el.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
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

  /*
   * Приведение телефона к международному виду.
   *
   * Клиент может быть записан как «0555 12-34-56», «+996 555 123456» или
   * «555123456» — все три варианта должны дать одну ссылку. Номер, не похожий
   * на местный, оставляем как есть: у клиента-иностранца свой код страны.
   * Та же логика продублирована на сервере в src/locale.js.
   */
  function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 7) return '';
    const l = loc();
    const code = String(l.phone_code || '');
    const trunk = String(l.phone_trunk || '');
    const length = Number(l.phone_length) || 0;
    if (!code) return digits;

    if (length && digits.length === length && digits.startsWith(code)) return digits;
    if (trunk && digits.startsWith(trunk)) {
      const local = code + digits.slice(trunk.length);
      if (!length || local.length === length) return local;
    }
    const withCode = code + digits;
    if (!length || withCode.length === length) return withCode;
    return digits;
  }

  // Ссылка «написать в WhatsApp» с готовым текстом.
  function whatsappLink(phone, text) {
    const normalized = normalizePhone(phone);
    if (!normalized) return '';
    return `https://wa.me/${normalized}?text=${encodeURIComponent(text || '')}`;
  }

  return { esc, icon, money, moneyRich, num, dt, dateOnly, monthName, badge, L, modal, confirmDialog, toast, toastErr,
    table, bindRows, formValues, debounce, currentTheme, applyTheme, toggleTheme, lightbox,
    barcodeSvg, photoUrl, highlight, whatsappLink, normalizePhone, locale: loc };
})();

// Тему применяем сразу при загрузке, до первого кадра — чтобы не мигало белым.
ui.applyTheme(ui.currentTheme());
