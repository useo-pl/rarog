#if os(iOS)
import UIKit

/// Pasek załączników nad polem: miniatury zdjęć, potem chipy plików, każdy z „×".
/// Właściciel: wysyłka. Przyciski nie zabierają fokusu z pola (klawiatura zostaje).
final class AttachmentStripView: UIView {
  static let height: CGFloat = 64
  private static let tile: CGFloat = 56

  var onRemove: ((UUID) -> Void)?

  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var thumbnails: [UUID: UIImage] = [:]
  /// Przyciski „×" w kolejności paska — do przeniesienia fokusu czytnika po usunięciu.
  private(set) var removeButtons: [UIButton] = []
  /// Chip texts with their styles: a step on the flat path sets their fonts again.
  private var chipTexts: [(label: UILabel, style: UIFont.TextStyle)] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroll.showsHorizontalScrollIndicator = false
    scroll.alwaysBounceHorizontal = false
    scroll.clipsToBounds = false
    stack.axis = .horizontal
    stack.alignment = .center
    stack.spacing = 8
    for view in [scroll, stack] as [UIView] { view.translatesAutoresizingMaskIntoConstraints = false }
    addSubview(scroll)
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
    ])
    accessibilityIdentifier = "composer.attachments"
    accessibilityLabel = UICopy.attachmentsStrip
    shouldGroupAccessibilityChildren = true
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      for text in self.chipTexts { text.label.font = Fonts.text(text.style, traits: self.traitCollection) }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Przebudowa paska (najwyżej 9 elementów) — miniatury z pamięci, nowe dociągane w tle.
  func update(_ attachments: [ComposerAttachment]) {
    for view in stack.arrangedSubviews { view.removeFromSuperview() }
    removeButtons = []
    chipTexts = []
    thumbnails = thumbnails.filter { id, _ in attachments.contains { $0.id == id } }
    var imageIndex = 0
    for (index, attachment) in attachments.enumerated() {
      if attachment.kind == .image { imageIndex += 1 }
      let item = attachment.kind == .image ? imageTile(attachment) : fileChip(attachment)
      item.isAccessibilityElement = true
      item.accessibilityLabel = UICopy.attachmentLabel(attachment, imageIndex: imageIndex)
      item.accessibilityIdentifier = "composer.attachment.\(index)"
      let wrapper = UIView()
      wrapper.translatesAutoresizingMaskIntoConstraints = false
      item.translatesAutoresizingMaskIntoConstraints = false
      wrapper.addSubview(item)
      let remove = removeButton(attachment, label: UICopy.removeAttachment(attachment, imageIndex: imageIndex), index: index)
      wrapper.addSubview(remove)
      NSLayoutConstraint.activate([
        item.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor),
        item.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
        item.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 6),
        remove.centerXAnchor.constraint(equalTo: item.trailingAnchor, constant: -2),
        remove.centerYAnchor.constraint(equalTo: item.topAnchor, constant: 2),
        wrapper.trailingAnchor.constraint(equalTo: item.trailingAnchor, constant: 8),
      ])
      stack.addArrangedSubview(wrapper)
      removeButtons.append(remove)
    }
  }

  private func imageTile(_ attachment: ComposerAttachment) -> UIView {
    let image = UIImageView()
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    image.layer.roundCorners(Radius.inner)
    image.backgroundColor = Palette.surface
    NSLayoutConstraint.activate([
      image.widthAnchor.constraint(equalToConstant: Self.tile),
      image.heightAnchor.constraint(equalToConstant: Self.tile),
    ])
    if let cached = thumbnails[attachment.id] {
      image.image = cached
    } else {
      let id = attachment.id
      let url = attachment.file
      // Kafel w pikselach ekranu; ostrość liczy krótszy bok (`tileThumbnail`), bo kafel wypełnia kwadrat.
      let scale = traitCollection.displayScale >= 1 ? traitCollection.displayScale : 3
      let side = Int((Self.tile * scale).rounded(.up))
      Task { [weak self, weak image] in
        let thumbnail = await Task.detached { ImagePreparer.tileThumbnail(of: url, side: side).map(SendableImage.init) }.value
        guard let thumbnail else { return }
        let loaded = UIImage(cgImage: thumbnail.image)
        self?.thumbnails[id] = loaded
        image?.image = loaded
      }
    }
    return image
  }

  private func fileChip(_ attachment: ComposerAttachment) -> UIView {
    let chip = UIView()
    chip.backgroundColor = Palette.surface
    chip.layer.roundCorners(Radius.inner)
    let icon = UIImageView(image: UIImage(systemName: "doc"))
    icon.tintColor = Palette.muted
    icon.setContentHuggingPriority(.required, for: .horizontal)
    let name = UILabel()
    name.text = attachment.name
    name.font = Fonts.text(.footnote)
    name.adjustsFontForContentSizeCategory = true
    name.textColor = Palette.text
    name.lineBreakMode = .byTruncatingMiddle
    let size = UILabel()
    size.text = UICopy.bytes(attachment.bytes)
    size.font = Fonts.text(.caption1)
    size.adjustsFontForContentSizeCategory = true
    size.textColor = Palette.muted
    chipTexts += [(name, .footnote), (size, .caption1)]
    let texts = UIStackView(arrangedSubviews: [name, size])
    texts.axis = .vertical
    texts.spacing = 1
    let row = UIStackView(arrangedSubviews: [icon, texts])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 6
    row.translatesAutoresizingMaskIntoConstraints = false
    chip.addSubview(row)
    NSLayoutConstraint.activate([
      chip.heightAnchor.constraint(equalToConstant: Self.tile),
      chip.widthAnchor.constraint(lessThanOrEqualToConstant: 200),
      row.leadingAnchor.constraint(equalTo: chip.leadingAnchor, constant: 10),
      row.trailingAnchor.constraint(equalTo: chip.trailingAnchor, constant: -14),
      row.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
    ])
    return chip
  }

  private func removeButton(_ attachment: ComposerAttachment, label: String, index: Int) -> UIButton {
    let button = TouchTargetButton(type: .system)
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "xmark.circle.fill")
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
      .applying(UIImage.SymbolConfiguration(paletteColors: [Palette.background, Palette.muted]))
    config.contentInsets = .zero
    button.configuration = config
    button.accessibilityLabel = label
    button.accessibilityIdentifier = "composer.attachment.remove.\(index)"
    button.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      button.widthAnchor.constraint(equalToConstant: 22),
      button.heightAnchor.constraint(equalToConstant: 22),
    ])
    let id = attachment.id
    button.addAction(UIAction { [weak self] _ in self?.onRemove?(id) }, for: .primaryActionTriggered)
    return button
  }
}

/// `CGImage` z wątku w tle na główny (obraz jest niezmienny).
private struct SendableImage: @unchecked Sendable {
  let image: CGImage
}
#endif
