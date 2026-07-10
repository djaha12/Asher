'use strict';
// Клиент API: JSON поверх fetch, единая обработка ошибок
window.api = (() => {
  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw new Error('Нет связи с сервером');
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
