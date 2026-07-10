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

  return { esc, money, num, dt, dateOnly, monthName, badge, L, modal, confirmDialog, toast, toastErr, table, bindRows, formValues, debounce };
})();
