#if os(iOS)
import UIKit

// Zaznaczanie i kopiowanie fragmentu transkryptu. Zaznacza systemowy `UITextView`;
// tu są dwie reguły ponad system:
// - do schowka idzie tekst, nie układ: znaczniki list jako `- `/`3. `, tabela jako markdown,
//   zaznaczenie w środku tabeli (jej własne pole, ``MarkdownTableView``) komórkami, linia pozioma
//   jako `---`, bez paska bloku kodu (``MarkdownPlainText``);
// - po kopii zaznaczenia zrobionego KURSOREM fokus wraca do pola wiadomości (zaznacz → Cmd+C →
//   pisz), po palcu nie — otworzyłby klawiaturę ekranową na pół transkryptu (PWA
//   `transcriptCopyReturnsFocus`). Ekran sesji odbiera prośbę łańcuchem responderów.
// Właściciel: transkrypt, markdown.

/// Ekran, który umie oddać fokus polu wiadomości po kopii zaznaczenia.
@MainActor @objc protocol TranscriptCopyFocusReturning {
  func rarogFocusComposerAfterCopy(_ sender: Any?)
}

/// Tekst wiadomości: systemowe zaznaczanie, kopia przez ``MarkdownPlainText``.
final class MessageTextView: UITextView {
  /// Ostatni dotyk w tym widoku był kursorem (gładzik, mysz), a nie palcem.
  private(set) var lastTouchWasPointer = false
  /// Okno, które przycina pole przy zwiniętym prompcie: ramka dla czytnika kończy się na nim, a nie wystaje pod
  /// przycisk „Pokaż całość”. Tekst dla czytnika zostaje cały.
  weak var accessibilityClip: UIView?

  /// Ramka systemu (całe pole na ekranie) przycięta do części pola w oknie — przeliczona proporcją z układu pola, bo
  /// `UIAccessibility.convertToScreenCoordinates` dla okna w komórce oddawał jego `bounds` bez przesunięcia.
  override var accessibilityFrame: CGRect {
    get {
      let full = super.accessibilityFrame
      guard let clip = accessibilityClip, clip.clipsToBounds, bounds.width > 0, bounds.height > 0 else { return full }
      let local = clip.convert(clip.bounds, to: self).intersection(bounds)
      guard !local.isNull, local != bounds else { return full }
      let scaleX = full.width / bounds.width
      let scaleY = full.height / bounds.height
      return CGRect(
        x: full.minX + (local.minX - bounds.minX) * scaleX, y: full.minY + (local.minY - bounds.minY) * scaleY,
        width: local.width * scaleX, height: local.height * scaleY)
    }
    set { super.accessibilityFrame = newValue }
  }

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    addGestureRecognizer(TouchKindRecognizer { [weak self] pointer in self?.lastTouchWasPointer = pointer })
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func copy(_ sender: Any?) {
    let range = selectedRange
    guard range.length > 0, NSMaxRange(range) <= attributedText.length else {
      super.copy(sender)
      return
    }
    let text = MarkdownPlainText.copy(attributedText.attributedSubstring(from: range))
    guard Clipboard.copy(text) else {
      Announcer.shared.say(UICopy.copyFailed)
      return
    }
    if lastTouchWasPointer {
      UIApplication.shared.sendAction(
        #selector(TranscriptCopyFocusReturning.rarogFocusComposerAfterCopy(_:)), to: nil, from: self, for: nil)
    }
  }
}

/// Rozpoznawacz, który niczego nie rozpoznaje: zapisuje rodzaj dotyku i od razu odpada,
/// nie zabierając gestów systemowemu zaznaczaniu.
private final class TouchKindRecognizer: UIGestureRecognizer {
  private let record: (Bool) -> Void

  init(record: @escaping (Bool) -> Void) {
    self.record = record
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    if let touch = touches.first { record(touch.type == .indirectPointer) }
    state = .failed
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
#endif
