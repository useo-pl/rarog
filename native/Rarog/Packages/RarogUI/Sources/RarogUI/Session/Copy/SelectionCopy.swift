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

  /// The buttons held at the last pointer press in this view (primary for a click, secondary for a right click).
  private(set) var lastPointerButtons: UIEvent.ButtonMask = []
  private var touchKind: UIGestureRecognizer?

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    let recognizer = TouchKindRecognizer { [weak self] type, buttons in self?.touchBegan(type, buttons: buttons) }
    touchKind = recognizer
    addGestureRecognizer(recognizer)
  }

  private func touchBegan(_ type: UITouch.TouchType, buttons: UIEvent.ButtonMask) {
    lastTouchWasPointer = type == .indirectPointer
    lastPointerButtons = lastTouchWasPointer ? buttons : []
    pointerOwner?.transcriptTouchBegan(type, in: self)
  }

  /// The screen above this field that runs the pointer selection across transcript rows; `nil` outside the session
  /// screen (an Inbox card), where the field keeps every gesture of its own.
  private var pointerOwner: TranscriptPointerSelecting? { MessageContentView.pointerOwner(from: self) }

  /// Whether the pointer press that just began at `point` (in this field) belongs to the transcript's pointer
  /// selection: only a pointer touch, and only where the screen above says the selection starts (a primary press on
  /// the text of a transcript row) or owns the right click (a secondary press on its highlight). A finger or the pencil
  /// always keeps the field's own selection.
  func yieldsPointerPress(at point: CGPoint) -> Bool {
    guard lastTouchWasPointer, let owner = pointerOwner else { return false }
    return owner.pointerSelectionClaims(self, at: point, secondary: lastPointerButtons.contains(.secondary))
  }

  /// The field's own recognizers (the system's text selection, link taps, the right click menu, text drag) give way to
  /// the pointer selection of the transcript when it claims the press, so one click and drag selects across messages
  /// instead of inside one field. Hover (the text cursor shape) is never refused.
  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    if recognizer !== touchKind, !(recognizer is UIHoverGestureRecognizer),
      yieldsPointerPress(at: recognizer.location(in: self))
    {
      return false
    }
    return super.gestureRecognizerShouldBegin(recognizer)
  }

  /// Tests set the kind of the last touch without a real touch event.
  func recordTouchForTesting(_ type: UITouch.TouchType, buttons: UIEvent.ButtonMask = .primary) {
    touchBegan(type, buttons: buttons)
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
  private let record: (UITouch.TouchType, UIEvent.ButtonMask) -> Void

  init(record: @escaping (UITouch.TouchType, UIEvent.ButtonMask) -> Void) {
    self.record = record
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    if let touch = touches.first { record(touch.type, event.buttonMask) }
    state = .failed
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
#endif
