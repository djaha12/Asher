'use strict';
// Клиент API: JSON поверх fetch, единая обработка ошибок
window.api = (() => {
  /*
   * Отметка этого устройства. Нужна ровно для одного: чтобы приложение не
   * перерисовывало страницу в ответ на своё же собственное действие — оно
   * и так перерисовывает её сразу, а второй раз это выглядело бы миганием.
   * Ничего личного в отметке нет, это случайный набор знаков.
   */
  const УСТРОЙСТВО = (() => {
    try {
      let id = localStorage.getItem('asher-устройство');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('asher-устройство', id);
      }
      return id;
    } catch { return Math.random().toString(36).slice(2); }
  })();

  async function request(method, url, body) {
    const opts = { method, headers: { 'X-Asher-Device': УСТРОЙСТВО } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      // Самая частая причина у живых людей: закрыли чёрное окно, в котором
      // работает система. Говорим не «что случилось», а «что сделать».
      throw new Error('Нет связи с системой. Проверьте, что чёрное окно Asher открыто ' +
        '(если нет — запустите СТАРТ), затем обновите эту страницу.');
    }
    if (res.status === 401 && !url.startsWith('/api/login')) {
      window.App && window.App.showLogin();
      throw new Error('Требуется вход');
    }
    let data = null;
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) {
      throw new Error((data && data.error) || `Ошибка ${res.status}`);
    }
    return data;
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url) => request('DELETE', url),
    // смещение локального времени в минутах (для группировок по дням на сервере)
    tz: () => -new Date().getTimezoneOffset(),
  };
})();
