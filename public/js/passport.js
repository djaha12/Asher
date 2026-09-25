'use strict';
/*
 * Паспорт изделия.
 *
 * Лист, который покупатель уносит вместе с украшением: что за изделие,
 * металл и проба, вес, камни с характеристиками, сертификат лаборатории
 * и где его проверить. Бирку с витрины выбрасывают, а паспорт хранят —
 * по нему через год вспоминают, что это за камень.
 *
 * QR внизу — код изделия, тот же, что на бирке: касса читает его камерой,
 * когда покупатель приносит изделие обратно. Если сертификат GIA или IGI —
 * рядом второй QR, на страницу проверки лаборатории: покупатель сам
 * убеждается, что камень тот, что указан.
 */
window.Passport = (() => {
  /*
   * Страницы проверки сертификата по номеру. Только у кого она открыта
   * без входа; для остальных лабораторий печатаем название и номер.
   */
  const ПРОВЕРКА = {
    GIA: н => `https://www.gia.edu/report-check?reportno=${encodeURIComponent(н)}`,
    IGI: н => `https://www.igi.org/reports/verify-your-report?r=${encodeURIComponent(н)}`,
  };

  function qrSvg(text) {
    try {
      // Артикул бывает с кириллицей — кладём в QR как UTF-8, как и на бирках.
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const qr = qrcode(0, 'M');
      qr.addData(String(text));
      qr.make();
      return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
    } catch { return ''; }
  }

  const металл = p => [p.metal, p.fineness].filter(Boolean).join(' ');
  const камень = p => [p.carat ? ui.num(p.carat) + ' ct' : '', p.color, p.clarity].filter(Boolean).join(' · ');
  const вставкиИз = p => (p.gems || []).filter(g => g && g.type);

  // Сертификаты — и загруженные файлом, и записанные в строках вставок, без повторов.
  function сертификаты(p) {
    const все = [];
    const добавить = (lab, number, date) => {
      const н = String(number || '').trim().toUpperCase();
      if (!н) return;
      const л = String(lab || '').trim().toUpperCase();
      const есть = все.find(c => c.lab === л && c.number === н);
      if (есть) { есть.date = есть.date || date || ''; return; }
      все.push({ lab: л, number: н, date: date || '', url: ПРОВЕРКА[л] ? ПРОВЕРКА[л](н) : '' });
    };
    (p.certificates || []).forEach(c => добавить(c.lab, c.number));
    вставкиИз(p).forEach(g => добавить(g.cert_lab, g.cert_number, g.cert_date));
    return все;
  }

  function строкаВставки(g) {
    return [g.type + ((g.count || 1) > 1 ? ' × ' + g.count : ''), g.carat ? ui.num(g.carat) + ' ct' : '',
      g.color, g.clarity, g.cut].filter(Boolean).join(', ');
  }

  /*
   * Продажа, к которой относится паспорт: из чека или — в карточке
   * изделия — последняя невозвращённая продажа из истории.
   */
  function продажаИзИстории(p) {
    if (p.status !== 'sold') return null;
    const h = (p.history || []).find(x => !x.returned);
    return h ? { number: h.sale_number, date: h.sale_date, customer_name: h.customer_name,
      customer_phone: h.customer_phone, price: h.final_price } : null;
  }

  function лист(p, продажа, { цена, покупатель }) {
    const фото = (p.images || []).find(i => i.is_main) || (p.images || [])[0];
    const вставки = вставкиИз(p);
    const серт = сертификаты(p);
    const свойства = [
      ['Металл', металл(p)],
      ['Вес изделия', p.weight ? ui.num(p.weight) + ' г' : ''],
      ['Размер', p.size],
      ['Бриллиант', камень(p)],
      ['Вставки', вставки.length ? '' : p.gem_summary],
    ].filter(([, v]) => v);
    const оПродаже = [
      продажа ? ['Продано', `${ui.dateOnly(продажа.date)}, чек ${продажа.number}`] : null,
      продажа && покупатель && продажа.customer_name ? ['Покупатель', продажа.customer_name] : null,
      цена ? ['Цена', ui.money(продажа ? продажа.price : p.retail_price)] : null,
    ].filter(Boolean);
    return `<div class="passport">
      <div class="pp-head">
        <div class="pp-store">${ui.esc(App.storeName || '')}</div>
        <div class="pp-title">Паспорт изделия</div>
      </div>
      <div class="pp-main">
        ${фото ? `<img class="pp-photo" src="${ui.esc(ui.photoUrl(фото.file))}" alt="">` : ''}
        <div class="pp-info">
          <div class="pp-name">${ui.esc(p.name)}</div>
          <div class="pp-sku">Артикул ${ui.esc(p.sku)}</div>
          <dl class="pp-kv">${свойства.map(([k, v]) => `<dt>${k}</dt><dd>${ui.esc(v)}</dd>`).join('')}</dl>
        </div>
      </div>
      ${вставки.length ? `<table class="pp-gems">
        <thead><tr><th>Камень</th><th>Шт</th><th>Караты</th><th>Цвет</th><th>Чистота</th><th>Огранка</th></tr></thead>
        <tbody>${вставки.map(g => `<tr><td>${ui.esc(g.type)}</td><td>${Number(g.count) || 1}</td>
          <td>${g.carat ? ui.num(g.carat) : '—'}</td><td>${ui.esc(g.color || '—')}</td>
          <td>${ui.esc(g.clarity || '—')}</td><td>${ui.esc(g.cut || '—')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${серт.map(c => `<div class="pp-cert">
        ${c.url ? `<div class="pp-qr">${qrSvg(c.url)}</div>` : ''}
        <div><b>Сертификат ${ui.esc(c.lab)} № ${ui.esc(c.number)}${c.date ? ' от ' + ui.dateOnly(c.date) : ''}</b>
          ${c.url ? `<div class="pp-small">Проверить: наведите камеру телефона на код — откроется страница
            лаборатории ${ui.esc(c.lab)} с этим сертификатом.</div>` : ''}</div>
      </div>`).join('')}
      ${оПродаже.length ? `<dl class="pp-kv pp-sale">${оПродаже.map(([k, v]) =>
        `<dt>${k}</dt><dd>${ui.esc(v)}</dd>`).join('')}</dl>` : ''}
      <div class="pp-foot">
        <div class="pp-qr">${qrSvg(p.barcode || p.sku)}</div>
        <div class="pp-small">Сохраните паспорт: в нём описание изделия и камней.
          ${App.storePhone ? `<br>${ui.esc(App.storeName || '')} · ${ui.esc(App.storePhone)}` : ''}</div>
      </div>
    </div>`;
  }

  // Тот же паспорт сообщением: для WhatsApp, когда печатать не на чем.
  function текст(p, продажа, { цена, покупатель }) {
    const вставки = вставкиИз(p);
    return [
      `${App.storeName || ''}. Паспорт изделия`.trim(),
      p.name,
      `Артикул: ${p.sku}`,
      металл(p) ? `Металл: ${металл(p)}` : '',
      p.weight ? `Вес: ${ui.num(p.weight)} г` : '',
      p.size ? `Размер: ${p.size}` : '',
      камень(p) ? `Бриллиант: ${камень(p)}` : '',
      ...(вставки.length ? вставки.map(g => 'Вставка: ' + строкаВставки(g)) : [p.gem_summary ? `Вставки: ${p.gem_summary}` : '']),
      ...сертификаты(p).map(c => `Сертификат ${c.lab} № ${c.number}${c.url ? ' — проверить: ' + c.url : ''}`),
      продажа ? `Продано: ${ui.dateOnly(продажа.date)}, чек ${продажа.number}` : '',
      продажа && покупатель && продажа.customer_name ? `Покупатель: ${продажа.customer_name}` : '',
      цена ? `Цена: ${ui.money(продажа ? продажа.price : p.retail_price)}` : '',
    ].filter(Boolean).join('\n');
  }

  function напечатать(html) {
    const root = document.getElementById('print-root');
    root.innerHTML = html;
    // Фото должно успеть загрузиться, иначе на бумаге окажется пустая рамка.
    // Но и ждать вечно нельзя: не загрузилось за пять секунд — печатаем так.
    const ждать = [...root.querySelectorAll('img')].filter(img => !img.complete)
      .map(img => new Promise(r => { img.onload = img.onerror = r; }));
    Promise.race([Promise.all(ждать), new Promise(r => setTimeout(r, 5000))]).then(() => window.print());
  }

  /*
   * Окно паспорта. листы — [{ p, продажа }]: одно изделие из карточки
   * или все изделия чека. Цена по умолчанию не печатается: паспорт часто
   * уходит вместе с подарком.
   */
  function окно(листы, телефон) {
    const естьПокупатель = листы.some(л => л.продажа && л.продажа.customer_name);
    const опции = { цена: false, покупатель: true };
    const m = ui.modal({
      title: листы.length > 1 ? `Паспорта изделий (${листы.length})` : 'Паспорт изделия',
      size: 'lg',
      body: `<div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:12px">
          ${естьПокупатель ? '<label class="row-tight" style="gap:6px"><input type="checkbox" id="pp-buyer" checked> Имя покупателя</label>' : ''}
          <label class="row-tight" style="gap:6px"><input type="checkbox" id="pp-price"> Цена
            <span class="muted" style="font-size:12.5px">(не ставьте, если это подарок)</span></label>
        </div>
        <div id="pp-preview" class="pp-preview"></div>`,
      footer: `<button class="btn" data-act="close">Закрыть</button>
        <button class="btn" data-act="send">${ui.icon('whatsapp')} Отправить клиенту</button>
        <button class="btn btn-primary" data-act="print">${ui.icon('print')} Печать</button>`,
    });
    const показать = () => {
      m.body.querySelector('#pp-preview').innerHTML = листы.map(л => лист(л.p, л.продажа, опции)).join('');
    };
    показать();
    const галка = (id, ключ) => {
      const el = m.body.querySelector(id);
      if (el) el.addEventListener('change', () => { опции[ключ] = el.checked; показать(); });
    };
    галка('#pp-buyer', 'покупатель');
    галка('#pp-price', 'цена');
    m.foot.querySelector('[data-act=close]').onclick = m.close;
    m.foot.querySelector('[data-act=print]').onclick = () =>
      напечатать(листы.map(л => лист(л.p, л.продажа, опции)).join('<div class="pp-break"></div>'));
    m.foot.querySelector('[data-act=send]').onclick = async () => {
      const сообщение = листы.map(л => текст(л.p, л.продажа, опции)).join('\n\n');
      /*
       * На телефоне — вместе с фото изделия, прямо в WhatsApp. На компьютере
       * браузер файлом делиться не умеет — открываем переписку с текстом.
       */
      if (navigator.canShare) {
        try {
          const файлы = [];
          for (const л of листы) {
            const фото = (л.p.images || []).find(i => i.is_main) || (л.p.images || [])[0];
            if (!фото) continue;
            const blob = await (await fetch(ui.photoUrl(фото.file))).blob();
            файлы.push(new File([blob], `${л.p.sku}.jpg`, { type: blob.type || 'image/jpeg' }));
          }
          if (файлы.length && navigator.canShare({ files: файлы })) {
            await navigator.share({ files: файлы, text: сообщение });
            return;
          }
        } catch (e) {
          if (e && e.name === 'AbortError') return;   // передумали — не ошибка
        }
      }
      const ссылка = телефон ? ui.whatsappLink(телефон, сообщение) : '';
      window.open(ссылка || 'https://wa.me/?text=' + encodeURIComponent(сообщение), '_blank', 'noopener');
    };
    return m;
  }

  // Из карточки изделия.
  function изИзделия(p) {
    const продажа = продажаИзИстории(p);
    return окно([{ p, продажа }], продажа && продажа.customer_phone);
  }

  // Из чека: все невозвращённые изделия, с датой и номером чека.
  async function изЧека(s) {
    const позиции = s.items.filter(i => !i.returned);
    if (!позиции.length) { ui.toast('В чеке не осталось изделий — всё возвращено', true); return null; }
    const изделия = await Promise.all(позиции.map(i => api.get('/api/products/' + i.product_id)));
    return окно(изделия.map((p, k) => ({
      p,
      продажа: { number: s.number, date: s.created_at, customer_name: s.customer_name,
        customer_phone: s.customer_phone, price: позиции[k].final_price },
    })), s.customer_phone);
  }

  return { изИзделия, изЧека, сертификаты, ПРОВЕРКА };
})();
