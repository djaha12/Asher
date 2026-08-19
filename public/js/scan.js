'use strict';
/*
 * Распознавание кодов с фотографий и с камеры.
 *
 * Два движка:
 *   - BarcodeDetector — встроен в Chrome на Android, читает и QR, и полосатые
 *     штрихкоды (Code128, EAN). Где он есть — пробуем первым.
 *   - jsQR (public/js/vendor) — работает в любом браузере, включая iPhone,
 *     но читает только QR-коды.
 *
 * На бирках из 1С в QR часто зашита не «голая» строка, а ссылка или текст
 * с артикулом внутри — поэтому из распознанного текста готовим несколько
 * кандидатов и пробуем их по очереди, пока изделие не найдётся.
 */
window.Scan = (() => {
  const BD_FORMATS = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'upc_e'];

  function detectorOrNull() {
    if (!('BarcodeDetector' in window)) return null;
    try { return new BarcodeDetector({ formats: BD_FORMATS }); }
    catch { return null; }
  }

  /*
   * Распознать код на фотографии (File/Blob). Возвращает строку или null.
   * Фотографии бирок бывают большие и смазанные, поэтому пробуем несколько
   * масштабов: мелкий убирает шум, крупный спасает мелкие QR в углу кадра.
   */
  async function decodeFile(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { return null; }
    try {
      const det = detectorOrNull();
      if (det) {
        try {
          const found = await det.detect(bitmap);
          if (found.length && found[0].rawValue) return found[0].rawValue;
        } catch { /* детектор капризен к источникам — едем дальше на jsQR */ }
      }
      if (typeof jsQR !== 'function') return null;
      for (const maxSide of [900, 1400, 550]) {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        // attemptBoth: тёмный QR на светлом и светлый на тёмном
        const res = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (res && res.data) return res.data;
      }
      return null;
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  // Открыть камеру/галерею и распознать выбранный снимок.
  function pickAndDecode({ camera = true } = {}) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (camera) input.setAttribute('capture', 'environment');
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        input.remove();
        resolve(file ? await decodeFile(file) : null);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  /*
   * Кандидаты кода из распознанного текста, в порядке убывания уверенности:
   * сырой текст → значения параметров ссылки → последний сегмент пути →
   * длинные цифровые последовательности.
   */
  function candidates(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    // Чистый код («AS-00120», «2000000000015») — берём как есть, без вариаций:
    // дробить его на куски значит рисковать ложным совпадением.
    if (/^[A-Za-z0-9А-Яа-яЁё_.\-]+$/.test(t) && !t.includes('://')) return [t];

    const out = [t];
    try {
      const u = new URL(t);
      for (const v of u.searchParams.values()) if (v) out.push(v.trim());
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg) out.push(seg.trim());
    } catch { /* не ссылка — и хорошо */ }
    for (const m of t.match(/\d{5,}/g) || []) out.push(m);
    return [...new Set(out.filter(Boolean))];
  }

  /*
   * Кадры с камеры → код. Работает и там, где нет BarcodeDetector:
   * тогда кадры прогоняются через jsQR (только QR-коды).
   * Возвращает функцию остановки.
   */
  function watchVideo(video, onCode, { intervalMs = 350 } = {}) {
    const det = detectorOrNull();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let running = true;

    const tick = async () => {
      if (!running || !video.isConnected || video.readyState < 2) {
        if (running) setTimeout(tick, intervalMs);
        return;
      }
      try {
        if (det) {
          const found = await det.detect(video);
          if (found.length && found[0].rawValue) onCode(found[0].rawValue);
        } else if (typeof jsQR === 'function') {
          const w = Math.min(video.videoWidth, 800);
          const h = Math.round(video.videoHeight * (w / video.videoWidth));
          canvas.width = w; canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const res = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
          if (res && res.data) onCode(res.data);
        }
      } catch { /* кадр не прочитался — пробуем следующий */ }
      if (running) setTimeout(tick, intervalMs);
    };
    tick();
    return () => { running = false; };
  }

  const cameraSupported = () => Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  /*
   * Почему камера может быть недоступна.
   *
   * Браузеры дают доступ к камере только на защищённом адресе (https) либо на
   * самом компьютере. По адресу вида «http://192.168.1.14:3000», то есть с
   * телефона в магазинном Wi-Fi, камеру не даст ни Chrome, ни Safari — и дело
   * не в разрешениях, поэтому «разрешите камеру в настройках» тут только сбивает
   * с толку. Распознавание по фото и обычный сканер работают всегда.
   */
  function cameraProblem() {
    if (cameraSupported()) return '';
    const local = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return local
      ? 'Камера в этом браузере недоступна. Используйте «Распознать по фото» или сканер штрихкодов.'
      : 'С телефона камера включается только по защищённому адресу (https) — по адресу с цифрами '
        + 'браузер её не даёт. Печатайте бирки со штрихкодом и пользуйтесь «Распознать по фото» '
        + 'или сканером. Чтобы заработала и камера, системе нужен адрес с https.';
  }

  return { decodeFile, pickAndDecode, candidates, watchVideo, cameraSupported, cameraProblem };
})();
