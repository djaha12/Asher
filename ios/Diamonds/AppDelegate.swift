import UIKit
import UserNotifications

/*
 * Точка входа приложения.
 *
 * Здесь только то, что iOS отдаёт приложению целиком, а не его окну:
 * токен для уведомлений и нажатие на пришедшее уведомление. Всё остальное
 * живёт в WebViewController.
 */
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private let notifications = NotificationDelegate()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Делегат ставится до конца запуска: если приложение открыли нажатием
        // на уведомление, iOS сообщит об этом сразу после этой функции.
        UNUserNotificationCenter.current().delegate = notifications
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Push.shared.received(token: token)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.failed(error.localizedDescription)
    }
}

/*
 * Делегат уведомлений — отдельным классом, а не в AppDelegate.
 *
 * iOS вызывает его не обязательно из главного потока, а всё, что касается
 * окна, обязано жить в главном. Отдельный класс без привязки к окну не спорит
 * с этим правилом, а до окна добирается явно, через главный поток.
 */
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    // Уведомление пришло, пока приложение открыто: всё равно показываем
    // баннер — владелец мог смотреть совсем другой раздел.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // Нажали на уведомление — открываем раздел, о котором оно.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let route = response.notification.request.content.userInfo["route"] as? String {
            Task { @MainActor in Push.shared.open(route: route) }
        }
        completionHandler()
    }
}
