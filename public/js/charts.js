'use strict';
// Лёгкая библиотека графиков (SVG, без зависимостей).
// Спецификация: линии 2px, тонкие столбцы со скруглением 4px у вершины,
// волосяная сетка, подписи приглушённым цветом, тултип при наведении.
window.charts = (() => {
  const INK2 = '#57534b', MUTED = '#8d8781', GRID = '#e7e2d6', BASE = '#c9c2ae';

  function compact(n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
    if (a >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' тыс';
    return v.toLocaleString('ru-RU');
  }

  function niceTicks(maxV, count = 4) {
    if (maxV <= 0) maxV = 1;
    const rough = maxV / count;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const candidates = [1, 2, 2.5, 5, 10].map(m => m * pow);
    const step = candidates.find(c => c >= rough) || candidates[candidates.length - 1];
    const top = Math.ceil(maxV / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    return { ticks, top };
  }

  function makeTooltip(box) {
    const tip = document.createElement('div');
    tip.className = 'chart-tooltip hidden';
    box.appendChild(tip);
    return tip;
  }

  // ---------- Линейный график ----------
  // opts: { labels: ['2026-07-01',...], series: [{name, color, values}], height, isMoney, labelFmt }
  function lineChart(container, opts) {
    const { labels, series } = opts;
    const H = opts.height || 240;
    const W = Math.max(container.clientWidth || 600, 320);
    const padL = 52, padR = 14, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = labels.length;
    const maxV = Math.max(1, ...series.flatMap(s => s.values));
    const { ticks, top } = niceTicks(maxV);
    const x = i => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = v => padT + ih - (v / top) * ih;
    const fmtLabel = opts.labelFmt || (l => l.slice(8, 10) + '.' + l.slice(5, 7));

    let g = '';
    for (const t of ticks) {
      g += `<line x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}" stroke="${GRID}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="${MUTED}">${compact(t)}</text>`;
    }
    // подписи оси X — не чаще, чем помещается
    const every = Math.max(1, Math.ceil(n / Math.floor(iw / 56)));
    for (let i = 0; i < n; i++) {
      if (i % every !== 0 && i !== n - 1) continue;
      g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${MUTED}">${fmtLabel(labels[i])}</text>`;
    }
    g += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="${BASE}" stroke-width="1"/>`;

    let defs = '', paths = '';
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      if (series.length === 1) {
        defs += `<linearGradient id="ga${si}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.color}" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="${s.color}" stop-opacity="0.01"/></linearGradient>`;
        paths += `<polygon points="${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}" fill="url(#ga${si})"/>`;
      }
      paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    });

    const box = document.createElement('div');
    box.className = 'chart-box';
    box.innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">
      <defs>${defs}</defs>${g}${paths}
      <line class="ch-cross" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" stroke="${BASE}" stroke-width="1" stroke-dasharray="3,3" visibility="hidden"/>
      ${series.map(s => `<circle class="ch-dot" r="4" fill="${s.color}" stroke="#fff" stroke-width="2" visibility="hidden"/>`).join('')}
      <rect x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent" class="ch-hover"/>
    </svg>`;
    const tip = makeTooltip(box);
    const svg = box.querySelector('svg');
    const cross = box.querySelector('.ch-cross');
    const dots = box.querySelectorAll('.ch-dot');
    const hover = box.querySelector('.ch-hover');
    const fmtVal = opts.isMoney === false ? (v => ui.num(v)) : (v => ui.money(v));

    hover.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * (W / rect.width);
      let i = n <= 1 ? 0 : Math.round(((sx - padL) / iw) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      series.forEach((s, si) => {
        dots[si].setAttribute('cx', x(i));
        dots[si].setAttribute('cy', y(s.values[i]));
        dots[si].setAttribute('visibility', 'visible');
      });
      tip.classList.remove('hidden');
      tip.innerHTML = `<div class="t-title">${ui.esc(opts.tipTitle ? opts.tipTitle(labels[i]) : ui.dateOnly(labels[i]))}</div>` +
        series.map(s => `<div class="t-row"><span class="t-dot" style="background:${s.color}"></span>${ui.esc(s.name)}: <b>${fmtVal(s.values[i])}</b></div>`).join('');
      tip.style.left = (x(i) / W * rect.width) + 'px';
      tip.style.top = (Math.min(...series.map(s => y(s.values[i]))) / H * rect.height) + 'px';
    });
    hover.addEventListener('mouseleave', () => {
      tip.classList.add('hidden');
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    });

    container.innerHTML = '';
    container.appendChild(box);
    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML = series.map(s =>
        `<span class="l-item"><span class="l-dot" style="background:${s.color}"></span>${ui.esc(s.name)}</span>`).join('');
      container.appendChild(legend);
    }
  }

  // ---------- Столбцы (в т.ч. отрицательные значения) ----------
  // opts: { labels, values, height, posColor, negColor, labelFmt, tipName }
  function columnChart(container, opts) {
    const { labels, values } = opts;
    const H = opts.height || 240;
    const W = Math.max(container.clientWidth || 600, 320);
    const padL = 56, padR = 10, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = values.length;
    const maxV = Math.max(1, ...values.map(v => Math.abs(v)));
    const hasNeg = values.some(v => v < 0);
    const { top } = niceTicks(maxV);
    const zeroY = hasNeg ? padT + ih / 2 : padT + ih;
    const scale = hasNeg ? (ih / 2) / top : ih / top;
    const y = v => zeroY - v * scale;
    const bw = Math.min(38, (iw / n) * 0.62);
    const x = i => padL + (i + 0.5) * (iw / n) - bw / 2;
    const posColor = opts.posColor || '#2a78d6';
    const negColor = opts.negColor || '#e34948';

    let g = '';
    const tickVals = hasNeg ? [-top, -top / 2, 0, top / 2, top] : niceTicks(maxV).ticks;
    for (const t of tickVals) {
      g += `<line x1="${padL}" y1="${y(t)}" x2="${W - padR}" y2="${y(t)}" stroke="${t === 0 ? BASE : GRID}" stroke-width="1"/>`;
      g += `<text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="${MUTED}">${compact(t)}</text>`;
    }
    const fmtLabel = opts.labelFmt || (l => l);
    const every = Math.max(1, Math.ceil(n / Math.floor(iw / 46)));
    let bars = '';
    values.forEach((v, i) => {
      const h = Math.abs(v) * scale;
      const by = v >= 0 ? y(v) : zeroY;
      const r = Math.min(4, bw / 2, h);
      const color = v >= 0 ? posColor : negColor;
      // скругляем только «свободный» конец столбца
      const path = v >= 0
        ? `M${x(i)},${by + h} V${by + r} Q${x(i)},${by} ${x(i) + r},${by} H${x(i) + bw - r} Q${x(i) + bw},${by} ${x(i) + bw},${by + r} V${by + h} Z`
        : `M${x(i)},${by} V${by + h - r} Q${x(i)},${by + h} ${x(i) + r},${by + h} H${x(i) + bw - r} Q${x(i) + bw},${by + h} ${x(i) + bw},${by + h - r} V${by} Z`;
      bars += `<path d="${path}" fill="${color}" data-i="${i}" class="ch-bar" style="cursor:default"/>`;
      if (i % every === 0 || i === n - 1) {
        g += `<text x="${x(i) + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${MUTED}">${fmtLabel(labels[i])}</text>`;
      }
    });

    const box = document.createElement('div');
    box.className = 'chart-box';
    box.innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block">${g}${bars}</svg>`;
    const tip = makeTooltip(box);
    const svg = box.querySelector('svg');
    box.querySelectorAll('.ch-bar').forEach(bar => {
      bar.addEventListener('mousemove', () => {
        const i = Number(bar.dataset.i);
        const rect = svg.getBoundingClientRect();
        tip.classList.remove('hidden');
        tip.innerHTML = `<div class="t-title">${ui.esc(fmtLabel(labels[i]))}</div>
          <div class="t-row">${ui.esc(opts.tipName || '')} <b>${ui.money(values[i])}</b></div>`;
        tip.style.left = ((x(i) + bw / 2) / W * rect.width) + 'px';
        tip.style.top = (y(Math.max(values[i], 0)) / H * rect.height) + 'px';
      });
      bar.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    });
    container.innerHTML = '';
    container.appendChild(box);
  }

  // ---------- Горизонтальные полосы ----------
  // items: [{name, value, sub}] — одна мера, один цвет
  function barList(container, items, { color = '#2a78d6', isMoney = true, valueFmt } = {}) {
    const max = Math.max(1, ...items.map(i => i.value));
    const fmt = valueFmt || (v => isMoney ? ui.money(v) : ui.num(v));
    container.innerHTML = items.length ? `<div class="barlist">` + items.map(it => `
      <div class="bl-row">
        <span class="bl-name" title="${ui.esc(it.name)}">${ui.esc(it.name)}</span>
        <span class="bl-track"><span class="bl-fill" style="width:${Math.max(1.5, it.value / max * 100)}%;background:${color}"></span></span>
        <span class="bl-val">${fmt(it.value)}${it.sub ? ` <span class="muted">· ${ui.esc(it.sub)}</span>` : ''}</span>
      </div>`).join('') + `</div>`
      : `<div class="empty"><p>Нет данных за период</p></div>`;
  }

  return { lineChart, columnChart, barList, compact };
})();
