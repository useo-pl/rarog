#if os(iOS)
import UIKit

// Kopiowanie bloku kodu ikoną. Ikona jest WYCISZONA i widoczna zawsze — na palcu nie ma
// hovera, a kilkanaście podświetlonych przycisków przekrzykuje odpowiedź. Potwierdzeniem jest chwilowa
// podmiana na ptaszek BEZ koloru stanu (zielony czytałby się jako „pracuje"); porażka mówi „Nie udało
// się skopiować." i ptaszka nie pokazuje. Stopki „Kopiuj” pod odpowiedzią agenta nie ma.
// Właściciel: transkrypt, markdown.

/// Schowek systemu.
@MainActor
enum Clipboard {
  /// Ile trzyma się ptaszek, zanim ikona wróci (PWA `CODE_COPY_HOLD_MS`).
  static let hold: Duration = .milliseconds(1_600)

  /// `true` = schowek przyjął tekst (licznik zmian schowka urósł), bez czytania go z powrotem.
  static func copy(_ text: String) -> Bool {
    let pasteboard = UIPasteboard.general
    let before = pasteboard.changeCount
    pasteboard.string = text
    return pasteboard.changeCount != before
  }
}

/// Ikona kopiowania w UIKit (pasek bloku kodu). Pod wskaźnikiem ikona w pełnym tekście, jak `.msg__copy:hover`
/// w PWA — bez systemowej plamy wskaźnika.
@MainActor
final class CopyIconButton: UIButton {
  /// Tekst do skopiowania, liczony w chwili stuknięcia.
  var payload: (@MainActor () -> String?)?
  private let hitSize: CGSize
  private var resetTask: Task<Void, Never>?
  /// Wskaźnik nad ikoną (`RarogHoverTracker`); ptaszek po skopiowaniu ma już pełny tekst.
  private(set) var hover: RarogHoverTracker?
  private var showingIdle = true

  /// `hitSize` — cel dotyku większy od ikony, ale nie wchodzący głęboko w tekst obok.
  init(textStyle: UIFont.TextStyle, hitSize: CGSize) {
    self.hitSize = hitSize
    super.init(frame: .zero)
    var config = UIButton.Configuration.plain()
    config.contentInsets = .zero
    config.preferredSymbolConfigurationForImage = Self.symbol(textStyle)
    configuration = config
    accessibilityIdentifier = "code.copy"
    addAction(UIAction { [weak self] _ in self?.copyNow() }, for: .primaryActionTriggered)
    hover = RarogHoverTracker(view: self) { [weak self] _ in self?.refreshIdleInk() }
    showIdle()
    // A step on the flat path, where no trait change comes: the icon takes the new size.
    Fonts.follow(self) { [weak self] in
      self?.configuration?.preferredSymbolConfigurationForImage = Self.symbol(textStyle)
    }
  }

  /// The icon as large as `textStyle`: the text style itself on the standard path (the icon grows with Dynamic
  /// Type), the style's font at the model's size on the flat path.
  static func symbol(_ textStyle: UIFont.TextStyle) -> UIImage.SymbolConfiguration {
    TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(textStyle))
      : UIImage.SymbolConfiguration(textStyle: textStyle)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Ikona wraca do spoczynku (komórka dostała inną wiadomość).
  func reset() {
    resetTask?.cancel()
    resetTask = nil
    showIdle()
  }

  func copyNow() {
    guard let text = payload?(), !text.isEmpty, Clipboard.copy(text) else {
      Announcer.shared.say(UICopy.copyFailed)
      return
    }
    showingIdle = false
    show(symbol: "checkmark", color: Palette.text, label: UICopy.codeCopyDone)
    Announcer.shared.say(UICopy.sentence(UICopy.codeCopyDone))
    resetTask?.cancel()
    resetTask = Task { [weak self] in
      try? await Task.sleep(for: Clipboard.hold)
      guard !Task.isCancelled else { return }
      self?.showIdle()
    }
  }

  private func showIdle() {
    showingIdle = true
    show(symbol: "doc.on.doc", color: idleInk, label: UICopy.codeCopyHint)
  }

  /// Spoczynkowa ikona: `muted`, pod wskaźnikiem pełny tekst.
  var idleInk: UIColor {
    (hover?.hovering ?? false) ? Palette.text : Palette.muted
  }

  private func refreshIdleInk() {
    if showingIdle { configuration?.baseForegroundColor = idleInk }
  }

  private func show(symbol: String, color: UIColor, label: String) {
    configuration?.image = UIImage(systemName: symbol)
    configuration?.baseForegroundColor = color
    accessibilityLabel = label
  }

  /// Cel dotyku większy od ikony (pasek bloku jest niski).
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let dx = min(0, (bounds.width - hitSize.width) / 2)
    let dy = min(0, (bounds.height - hitSize.height) / 2)
    return bounds.insetBy(dx: dx, dy: dy).contains(point)
  }
}
#endif
