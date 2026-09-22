import UIKit
import WebKit

/*
 * Просмотр сертификата или фотографии поверх системы.
 *
 * Раньше такая ссылка открывалась бы вместо самой системы — и вернуться
 * из PDF-файла было бы нечем. Здесь документ лежит в отдельном окне
 * с кнопкой «Готово», а система остаётся под ним ровно в том же месте.
 * Вход общий с системой: окно берёт те же данные входа, что и основное.
 */
final class DocumentViewController: UIViewController {
    private let url: URL

    init(url: URL) {
        self.url = url
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) не используется") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "Просмотр"
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })

        let viewer = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        viewer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(viewer)
        NSLayoutConstraint.activate([
            viewer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            viewer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            viewer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            viewer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        viewer.load(URLRequest(url: url))
    }
}
