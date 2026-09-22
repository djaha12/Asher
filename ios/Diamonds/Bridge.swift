/*
 * Мост между страницей и приложением.
 *
 * Этот сценарий встраивается в страницу до её собственного кода. Он даёт
 * странице объект window.asherNative — по нему она понимает, что открыта
 * в приложении, а не в браузере, — и несколько просьб к приложению:
 * напечатать, спросить разрешение на уведомления, перекрасить часы.
 *
 * window.print подменяется по той же причине, по какой вообще нужен мост:
 * в окне приложения печать из страницы не делает ничего — ни ошибки, ни
 * диалога. Продавец нажимал бы «Печатать бирку» и молча не получал бы её.
 */
enum Bridge {
    static let script = """
    (function () {
      if (window.asherNative) return;
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.asher;
      if (!handler) return;
      var prints = {};
      var counter = 0;
      function send(message) { try { handler.postMessage(message); } catch (e) {} }
      window.asherNative = {
        app: true,
        token: '',
        print: function () {
          return new Promise(function (resolve) {
            var id = String(++counter);
            prints[id] = resolve;
            send({ type: 'print', id: id });
          });
        },
        requestPush: function () { send({ type: 'push' }); },
        statusBar: function (style) { send({ type: 'status', style: style }); },
        _printed: function (id) {
          var done = prints[id];
          delete prints[id];
          if (done) done();
        },
        _token: function (token, env) {
          window.asherNative.token = token;
          window.dispatchEvent(new CustomEvent('asher-push-token', { detail: { token: token, env: env } }));
        },
        _pushState: function (state) {
          window.dispatchEvent(new CustomEvent('asher-push-state', { detail: { state: state } }));
        },
        _open: function (route) {
          if (typeof route === 'string' && route.charAt(0) === '#') location.hash = route;
        }
      };
      window.print = function () { window.asherNative.print(); };
    })();
    """
}
