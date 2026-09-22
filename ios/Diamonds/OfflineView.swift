import UIKit

/*
 * Экран «нет связи».
 *
 * Без него пропавший интернет выглядел бы как белый экран — будто приложение
 * сломалось, а данные пропали. Здесь прямо сказано, что случилось, что
 * данные целы и что нажать.
 */
final class OfflineView: UIView {
    var onRetry: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(named: "LaunchBackground")

        let title = UILabel()
        title.text = "Нет связи с системой"
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.textColor = .white
        title.textAlignment = .center
        title.numberOfLines = 0

        let detail = UILabel()
        detail.text = "Проверьте интернет и нажмите «Повторить». Данные магазина целы: они хранятся на сервере, а не в телефоне."
        detail.font = .systemFont(ofSize: 15)
        detail.textColor = UIColor(white: 1, alpha: 0.7)
        detail.textAlignment = .center
        detail.numberOfLines = 0

        var look = UIButton.Configuration.filled()
        look.title = "Повторить"
        look.baseBackgroundColor = UIColor(red: 201 / 255, green: 162 / 255, blue: 39 / 255, alpha: 1)
        look.baseForegroundColor = UIColor(red: 22 / 255, green: 19 / 255, blue: 15 / 255, alpha: 1)
        look.cornerStyle = .large
        look.contentInsets = NSDirectionalEdgeInsets(top: 13, leading: 32, bottom: 13, trailing: 32)
        let button = UIButton(configuration: look)
        button.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, detail, button])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(26, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -32),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) не используется") }
}
