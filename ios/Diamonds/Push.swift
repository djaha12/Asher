import UIKit
import UserNotifications

/*
 * Уведомления на телефон.
 *
 * Разрешение спрашивает не приложение при запуске, а система после входа —
 * и только у основателя и бухгалтера: уведомления приходят им («кто-то
 * просится войти с нового телефона», «не записана аренда», «копия не
 * сделалась»). Продавцу окно «разрешить уведомления» было бы вопросом
 * ни о чём.
 *
 * Токен — адрес этого телефона для уведомлений. Приложение передаёт его
 * странице, а страница отправляет на сервер от имени вошедшего человека:
 * так сервер знает, кому именно этот телефон принадлежит.
 */
@MainActor
final class Push {
    static let shared = Push()

    private(set) var token: String?
    weak var web: WebViewController?
    private var pendingRoute: String?

    /// Сборка из App Store и TestFlight получает уведомления через боевой сервер
    /// Apple, отладочная — через песочницу. Сервер системы должен знать, куда слать.
    var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func request() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in Push.shared.proceed(with: status) }
        }
    }

    private func proceed(with status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        case .notDetermined:
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                Task { @MainActor in
                    if granted {
                        UIApplication.shared.registerForRemoteNotifications()
                    } else {
                        Push.shared.web?.pushState("denied")
                    }
                }
            }
        default:
            web?.pushState("denied")
        }
    }

    func received(token: String) {
        self.token = token
        web?.pushToken(token, environment: environment)
    }

    func failed(_ message: String) {
        web?.pushState("error")
    }

    /// Уведомление открыли, когда страница ещё не загрузилась, — откроем раздел после загрузки.
    func open(route: String) {
        if let web = web, web.isLoaded {
            web.open(route: route)
        } else {
            pendingRoute = route
        }
    }

    func takePendingRoute() -> String? {
        let route = pendingRoute
        pendingRoute = nil
        return route
    }
}
