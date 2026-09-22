import UIKit
import WebKit

/*
 * Окно в систему.
 *
 * Всё, что видит человек, рисует сама система на сервере — та же, что открывается
 * в браузере, поэтому обновления приходят сразу всем, без новой версии приложения.
 * Приложение добавляет то, чего окно браузера на телефоне не умеет:
 *
 *   • печать ценников, бирок и чеков через AirPrint — в окне приложения печать
 *     из страницы иначе молча не делает ничего;
 *   • выгрузки и резервные копии сохраняются через «Поделиться» — в «Файлы»,
 *     в почту, в Telegram;
 *   • уведомления на телефон;
 *   • камера для штрихкодов работает без повторных вопросов на каждом входе;
 *   • экран «нет связи» вместо белого листа.
 */
final class WebViewController: UIViewController {
    private var webView: WKWebView!
    private let offline = OfflineView()
    private let base: URL
    private let hosts: Set<String>
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var statusStyle: UIStatusBarStyle = .lightContent
    private(set) var isLoaded = false

    init() {
        let address = Bundle.main.object(forInfoDictionaryKey: "AsherBaseURL") as? String ?? "https://diamonds.kg"
        base = URL(string: address) ?? URL(string: "https://diamonds.kg")!
        let host = base.host ?? "diamonds.kg"
        // Демо-версия для знакомства живёт рядом, на поддомене, и тоже открывается внутри.
        hosts = [host, "demo." + host]
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) не используется") }

    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

    override func viewDidLoad() {
        super.viewDidLoad()
        let background = UIColor(named: "LaunchBackground")
        view.backgroundColor = background

        let configuration = WKWebViewConfiguration()
        // Видео с камеры рисуется прямо в странице — иначе сканер штрихкодов
        // раскрывался бы во весь экран поверх кассы.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        configuration.applicationNameForUserAgent = "Mobile/15E148 AsherApp/\(version)"
        let content = WKUserContentController()
        content.add(WeakScriptHandler(self), name: "asher")
        content.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = content

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = background
        // Отступы под часы и «домашнюю полоску» страница делает сама (viewport-fit=cover),
        // поэтому окно тянется во весь экран и ничего не сдвигает за неё.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view.addSubview(webView)
        pin(webView)

        offline.translatesAutoresizingMaskIntoConstraints = false
        offline.isHidden = true
        offline.onRetry = { [weak self] in self?.retry() }
        view.addSubview(offline)
        pin(offline)

        Push.shared.web = self
        webView.load(URLRequest(url: base))
    }

    private func pin(_ child: UIView) {
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: view.topAnchor),
            child.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            child.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func retry() {
        offline.isHidden = true
        if webView.url == nil {
            webView.load(URLRequest(url: base))
        } else {
            webView.reload()
        }
    }

    private func isOurs(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host else { return false }
        return hosts.contains(host)
    }

    // MARK: - Сообщения странице

    func pushToken(_ token: String, environment: String) {
        call("window.asherNative && window.asherNative._token(\(js(token)), \(js(environment)))")
    }

    func pushState(_ state: String) {
        call("window.asherNative && window.asherNative._pushState(\(js(state)))")
    }

    func open(route: String) {
        call("window.asherNative && window.asherNative._open(\(js(route)))")
    }

    private func call(_ script: String) {
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Строка как литерал JavaScript — через JSON, чтобы кавычки и переводы строк не ломали код.
    private func js(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    // MARK: - Печать

    private func printPage(id: String) {
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = "Diamonds"
        controller.printInfo = info
        // Печатается то, что страница приготовила для печати (@media print):
        // бирки, чек или карточка подключения — не весь экран.
        controller.printFormatter = webView.viewPrintFormatter()
        let argument = js(id)
        controller.present(animated: true) { [weak self] _, _, _ in
            // Страница убирает приготовленное для печати только после этого ответа:
            // уберёт раньше — на бумагу уйдёт пустой лист.
            self?.call("window.asherNative && window.asherNative._printed(\(argument))")
        }
    }

    // MARK: - Показ поверх

    private func presentOnTop(_ controller: UIViewController) {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        top.present(controller, animated: true)
    }

    private func alert(_ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default))
        presentOnTop(alert)
    }

    private func share(_ file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        presentOnTop(sheet)
    }
}

// MARK: - Переходы

extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isOurs(url) || ["about", "blob", "data"].contains(url.scheme ?? "") {
            decisionHandler(.allow)
            return
        }
        // WhatsApp, звонок, почта, чужие сайты — открываются там, где им место,
        // а не внутри кассы, из которой потом не выйти.
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoaded = true
        offline.isHidden = true
        if let route = Push.shared.takePendingRoute() { open(route: route) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error, whileLoading: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error, whileLoading: false)
    }

    // Память под страницу отобрала система (долго висела в фоне) — загружаем заново,
    // иначе человек увидит белый экран.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func failed(_ error: Error, whileLoading: Bool) {
        let problem = error as NSError
        if problem.domain == NSURLErrorDomain && problem.code == NSURLErrorCancelled { return }
        // «Загрузка прервана» — так WebKit сообщает, что ответ ушёл в скачивание файла.
        if problem.domain == "WebKitErrorDomain" && problem.code == 102 { return }
        if whileLoading || !isLoaded { offline.isHidden = false }
    }
}

// MARK: - Окна, вопросы, камера

extension WebViewController: WKUIDelegate {
    // Ссылки «в новом окне»: свои (сертификат, фото) — в просмотре поверх системы,
    // чужие (WhatsApp) — в своём приложении.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isOurs(url) {
            presentOnTop(UINavigationController(rootViewController: DocumentViewController(url: url)))
        } else {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentOnTop(alert)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentOnTop(alert)
    }

    // Камера для штрихкодов. Системный вопрос «разрешить камеру» iOS задаст сама,
    // один раз; здесь решается только, пускать ли к ней эту страницу — только свою.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(hosts.contains(origin.host) ? .grant : .deny)
    }
}

// MARK: - Скачивание файлов

extension WebViewController: WKDownloadDelegate {
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }
        let file = folder.appendingPathComponent(suggestedFilename.isEmpty ? "файл" : suggestedFilename)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    // Файл скачан — сразу предлагаем, куда его деть: в «Файлы», в почту, в Telegram.
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        share(file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        alert("Файл не скачался", error.localizedDescription)
    }
}

// MARK: - Просьбы страницы

extension WebViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // Слушаем только свою страницу: чужой сайт, если он вдруг откроется внутри,
        // не должен уметь печатать или просить уведомления от имени системы.
        guard hosts.contains(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "print":
            printPage(id: body["id"] as? String ?? "")
        case "push":
            Push.shared.request()
        case "status":
            // Часы и батарея — светлые на тёмном экране входа и в тёмной теме,
            // тёмные в светлой. Сам телефон об этом не знает: тему выбирают в системе.
            statusStyle = (body["style"] as? String) == "dark" ? .darkContent : .lightContent
            setNeedsStatusBarAppearanceUpdate()
        default:
            break
        }
    }
}

/// Обёртка, чтобы страница не удерживала окно в памяти после его закрытия.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
