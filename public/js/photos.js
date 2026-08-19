'use strict';
/*
 * Работа с фотографиями изделий.
 *
 * Уменьшением занимается браузер: он делает из снимка с телефона (5–10 МБ)
 * картинку 1600 px и миниатюру 400 px и отправляет уже их. Поэтому загрузка
 * идёт быстро даже с мобильного интернета, а серверу не нужны сторонние
 * библиотеки обработки изображений.
 */
window.Photos = (() => {
  const FULL_SIZE = 1600;
  const THUMB_SIZE = 400;
  const ACCEPT = 'image/jpeg,image/png,image/webp';

  async function toDataUrl(file, maxSize, quality) {
    // imageOrientation: 'from-image' — иначе фото с телефона окажется боком.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Белая подложка: у PNG с прозрачностью иначе получается чёрный фон.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    return canvas.toDataURL('image/jpeg', quality);
  }

  async function prepare(file) {
    const [data, thumb] = await Promise.all([
      toDataUrl(file, FULL_SIZE, 0.86),
      toDataUrl(file, THUMB_SIZE, 0.8),
    ]);
    return { data, thumb };
  }

  async function upload(productId, file) {
    const prepared = await prepare(file);
    return api.post(`/api/products/${productId}/images`, prepared);
  }

  // Скрытый <input type=file>: один на вызов, чтобы не копить их в DOM.
  function pickFiles({ multiple = true, camera = false } = {}) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT;
      if (multiple) input.multiple = true;
      // capture заставляет телефон открыть камеру, а не галерею
      if (camera) input.setAttribute('capture', 'environment');
      input.style.display = 'none';
      input.addEventListener('change', () => {
        resolve([...input.files]);
        input.remove();
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function pickFolder() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
      input.style.display = 'none';
      input.addEventListener('change', () => {
        resolve([...input.files]);
        input.remove();
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function isImage(file) {
    return /^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
  }

  /*
   * Галерея в карточке изделия: большое фото, миниатюры, загрузка.
   * onChange вызывается после любого изменения, чтобы страница обновила счётчики.
   */
  function gallery(host, productId, images, { editable = true, onChange } = {}) {
    let items = images.slice();
    let active = 0;

    function render() {
      const urls = items.map(i => ui.photoUrl(i.file));
      host.innerHTML = `
        <div class="gallery">
          <div class="gallery-main">
            ${items.length
              ? `<img src="${ui.esc(urls[active] || urls[0])}" alt="Фотография изделия">`
              : `<div class="no-photo">${ui.icon('diamond')}</div>`}
          </div>
          ${items.length ? `<div class="gallery-thumbs">${items.map((im, idx) => `
            <div class="gthumb ${idx === active ? 'active' : ''}" data-i="${idx}">
              <img src="${ui.esc(ui.photoUrl(im.thumb))}" alt="">
              ${im.is_main ? '<div class="gt-main">ГЛАВНОЕ</div>' : ''}
              ${editable ? '<button class="gt-del" title="Удалить фото">×</button>' : ''}
            </div>`).join('')}</div>` : ''}
          ${editable ? `
            <div class="row">
              <button class="btn btn-sm" data-act="add">${ui.icon('folder')} Добавить фото</button>
              <button class="btn btn-sm" data-act="camera">${ui.icon('camera')} Снять камерой</button>
              ${items.length > 1 ? `<button class="btn btn-sm" data-act="main">${ui.icon('check')} Сделать главным</button>` : ''}
            </div>
            <div class="dropzone" data-act="drop">
              <div class="dz-ico">${ui.icon('image')}</div>
              <div class="dz-main">Перетащите сюда фотографии</div>
              <div class="dz-sub">JPG, PNG или WEBP — можно сразу несколько</div>
            </div>` : ''}
        </div>`;

      host.querySelectorAll('.gthumb').forEach(el => {
        el.addEventListener('click', e => {
          if (e.target.classList.contains('gt-del')) return;
          active = Number(el.dataset.i);
          render();
        });
        const del = el.querySelector('.gt-del');
        if (del) del.addEventListener('click', async e => {
          e.stopPropagation();
          const im = items[Number(el.dataset.i)];
          if (!await ui.confirmDialog('Удалить эту фотографию?', { danger: true, okLabel: 'Удалить' })) return;
          try {
            await api.del(`/api/images/${im.id}`);
            await reload();
            ui.toast('Фотография удалена');
          } catch (err) { ui.toastErr(err); }
        });
      });

      const mainImg = host.querySelector('.gallery-main img');
      if (mainImg) mainImg.addEventListener('click', () => ui.lightbox(urls, active));

      if (!editable) return;
      host.querySelector('[data-act=add]').addEventListener('click', async () => {
        const files = await pickFiles({ multiple: true });
        await addFiles(files);
      });
      host.querySelector('[data-act=camera]').addEventListener('click', async () => {
        const files = await pickFiles({ multiple: false, camera: true });
        await addFiles(files);
      });
      const mainBtn = host.querySelector('[data-act=main]');
      if (mainBtn) mainBtn.addEventListener('click', async () => {
        const im = items[active];
        if (!im || im.is_main) { ui.toast('Это фото уже главное'); return; }
        try {
          await api.post(`/api/images/${im.id}/main`);
          await reload();
          ui.toast('Главное фото изменено');
        } catch (err) { ui.toastErr(err); }
      });

      const dz = host.querySelector('[data-act=drop]');
      dz.addEventListener('click', async () => addFiles(await pickFiles({ multiple: true })));
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', async e => {
        e.preventDefault();
        dz.classList.remove('over');
        await addFiles([...e.dataTransfer.files].filter(isImage));
      });
    }

    async function addFiles(files) {
      const list = (files || []).filter(isImage);
      if (!list.length) return;
      const dz = host.querySelector('[data-act=drop]');
      let done = 0;
      for (const file of list) {
        if (dz) dz.querySelector('.dz-main').textContent = `Загружаю ${done + 1} из ${list.length}…`;
        try {
          await upload(productId, file);
          done++;
        } catch (err) {
          ui.toastErr(err);
          break;
        }
      }
      await reload();
      if (done) ui.toast(done === 1 ? 'Фотография добавлена' : `Добавлено фотографий: ${done}`);
    }

    async function reload() {
      const res = await api.get(`/api/products/${productId}/images`);
      items = res.items;
      if (active >= items.length) active = Math.max(0, items.length - 1);
      render();
      if (onChange) onChange(items);
    }

    render();
    return { reload };
  }

  return { gallery, upload, prepare, pickFiles, pickFolder, isImage, FULL_SIZE, THUMB_SIZE };
})();
