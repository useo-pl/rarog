#if os(iOS)
import SwiftUI
import UIKit

// Podpowiedź skrótu nad przyciskiem: „Nazwa (⌘B)” we własnym dymku po najechaniu
// kursorem (gładzik, mysz) i chwili spoczynku. Systemowy dymek (`help(_:)`, `UIToolTipInteraction`) na iPadzie się nie
// pokazuje, a na Macu stałby obok własnego — przyciski z podpowiedzią go nie mają.
// Jeden mechanizm SwiftUI (`.shortcutTip`) i jeden UIKit (`ShortcutTipTracker`), oba prowadzą ten sam kontroler
// (`ShortcutTipController`) i ten sam dymek. Stan bez UIKit: `ShortcutTipState`. Czytnik dymka nie widzi: nazwę mówi
// etykieta przycisku, a glifu ⌘ nie czyta się na głos. Właściciel: skróty.

/// Kontroler podpowiedzi jednego przycisku: zdarzenia kursora i naciśnięcia → stan → dymek nad oknem przycisku.
@MainActor
final class ShortcutTipController {
  /// Widok, pod którym staje dymek (przycisk UIKit albo kotwica w tle przycisku SwiftUI).
  weak var anchor: UIView?
  var text = "" {
    didSet {
      guard text != oldValue, state.shown else { return }
      present()
    }
  }

  private var state = ShortcutTipState()
  private var timer: Task<Void, Never>?
  private let clock: () -> TimeInterval

  init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.clock = clock
  }

  /// Dymek tego przycisku stoi.
  var shown: Bool { state.shown }

  func pointerMoved() {
    state.pointerMoved(at: clock())
    schedule()
  }

  func pointerExited() {
    state.pointerExited()
    timer?.cancel()
    dismiss()
  }

  func pressed() {
    state.pressed()
    timer?.cancel()
    dismiss()
  }

  private func schedule() {
    timer?.cancel()
    guard let due = state.due else { return }
    let wait = max(0, due - clock())
    timer = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(wait))
      guard !Task.isCancelled, let self else { return }
      if self.state.tick(at: self.clock()) { self.present() }
    }
  }

  private func present() {
    guard !text.isEmpty, let anchor, anchor.window != nil else { return }
    ShortcutTipBubble.show(text, below: anchor, owner: ObjectIdentifier(self))
  }

  private func dismiss() {
    ShortcutTipBubble.hide(owner: ObjectIdentifier(self))
  }
}

/// Dymek podpowiedzi: jeden na apkę, na wierzchu okna przycisku (także nad arkuszem), pod przyciskiem, a przy dolnej
/// krawędzi nad nim. Nie łapie dotyku i jest ukryty dla czytnika.
final class ShortcutTipBubble: UIView {
  /// Odstęp dymka od przycisku i od krawędzi okna.
  static let gap: CGFloat = 6
  static let margin: CGFloat = 8

  private static weak var current: ShortcutTipBubble?
  private static var currentOwner: ObjectIdentifier?

  let label = UILabel()

  private init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    accessibilityElementsHidden = true
    isAccessibilityElement = false
    accessibilityIdentifier = "shortcutTip"
    backgroundColor = Palette.surface
    layer.roundCorners(Radius.inner)
    layer.borderWidth = 1
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.18
    layer.shadowRadius = 6
    layer.shadowOffset = CGSize(width: 0, height: 2)
    label.font = Fonts.text(.footnote)
    label.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    label.textColor = Palette.text
    label.numberOfLines = 0
    addSubview(label)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: ShortcutTipBubble, _: UITraitCollection) in
      self.layer.borderColor = Palette.border.resolvedColor(with: self.traitCollection).cgColor
    }
    // On the flat path (a Mac) a step of the app's text size sends no trait change: the tip takes the new size, and a
    // tip on screen fits itself to the larger text under the same button.
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      self.label.font = Fonts.text(.footnote)
      if let anchor = self.anchor, let window = self.window, anchor.window === window { self.place(below: anchor) }
    }
  }

  /// The button the tip stands under, for placing it again after a step of the text size.
  private weak var anchor: UIView?

  /// The tip's frame and the label's frame from the text and the button's place in the window.
  private func place(below anchor: UIView) {
    guard let window else { return }
    self.anchor = anchor
    frame = Self.frame(for: label, anchor: anchor.convert(anchor.bounds, to: window), in: window.bounds)
    label.frame = bounds.insetBy(dx: 8, dy: 5)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Dymek, który stoi teraz (testy UIKit).
  static var visible: ShortcutTipBubble? { current?.superview == nil ? nil : current }

  static func show(_ text: String, below anchor: UIView, owner: ObjectIdentifier) {
    guard let window = anchor.window else { return }
    let bubble = current ?? ShortcutTipBubble()
    current = bubble
    currentOwner = owner
    if bubble.superview !== window { window.addSubview(bubble) } else { window.bringSubviewToFront(bubble) }
    bubble.layer.borderColor = Palette.border.resolvedColor(with: window.traitCollection).cgColor
    bubble.label.text = text
    bubble.place(below: anchor)
  }

  /// Zdejmuje dymek, o ile należy do tego właściciela (dymek innego przycisku zostaje).
  static func hide(owner: ObjectIdentifier) {
    guard currentOwner == owner else { return }
    currentOwner = nil
    current?.removeFromSuperview()
  }

  private static func frame(for label: UILabel, anchor: CGRect, in bounds: CGRect) -> CGRect {
    let limit = min(320, bounds.width - 2 * margin)
    let text = label.sizeThatFits(CGSize(width: limit - 16, height: .greatestFiniteMagnitude))
    let size = CGSize(width: ceil(min(text.width, limit - 16)) + 16, height: ceil(text.height) + 10)
    var x = anchor.midX - size.width / 2
    x = min(max(x, bounds.minX + margin), bounds.maxX - margin - size.width)
    var y = anchor.maxY + gap
    if y + size.height > bounds.maxY - margin { y = anchor.minY - gap - size.height }
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
  }
}

// MARK: - UIKit

/// Podpowiedź przycisku UIKit: gest wskaźnika (słyszy wyłącznie kursor, nie przechwytuje tapnięć) i naciśnięcie
/// kontrolki prowadzą `ShortcutTipController`. Właściciel trzyma tracker obok przycisku i podaje wiersze
/// (``update(_:)``), także przy zmianie trybu („Wyślij” ↔ Stop).
@MainActor
final class ShortcutTipTracker: NSObject, UIGestureRecognizerDelegate {
  let controller = ShortcutTipController()
  private var lines: [ShortcutTipLine]

  init(view: UIView, lines: [ShortcutTipLine]) {
    self.lines = lines
    super.init()
    controller.anchor = view
    controller.text = ShortcutTipLine.text(lines)
    let recognizer = UIHoverGestureRecognizer(target: self, action: #selector(hover(_:)))
    recognizer.delegate = self
    view.addGestureRecognizer(recognizer)
    (view as? UIControl)?.addAction(
      UIAction { [weak self] _ in self?.controller.pressed() }, for: [.touchDown, .primaryActionTriggered])
  }

  convenience init(view: UIView, line: ShortcutTipLine) {
    self.init(view: view, lines: [line])
  }

  func update(_ line: ShortcutTipLine) {
    lines = [line]
    controller.text = line.text
  }

  /// Zdarzenie gestu wskaźnika (z gestu albo z testu UIKit).
  func pointer(_ state: UIGestureRecognizer.State) {
    switch state {
    case .began:
      // The glyphs are read again on each hover: a shortcut changed in Settings shows without a new button.
      controller.text = ShortcutTipLine.text(lines)
      controller.pointerMoved()
    case .changed: controller.pointerMoved()
    default: controller.pointerExited()
    }
  }

  @objc private func hover(_ recognizer: UIHoverGestureRecognizer) {
    pointer(recognizer.state)
  }

  /// Gest wskaźnika nikomu nie odbiera zdarzeń (jak `RarogHoverTracker`).
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

// MARK: - SwiftUI

extension View {
  /// Podpowiedź „Nazwa (⌘B)” po najechaniu kursorem. Zamiast systemowego `help(_:)`, nie obok niego.
  func shortcutTip(_ name: String, _ shortcuts: AppShortcut...) -> some View {
    modifier(ShortcutTipModifier(text: UICopy.shortcutHelp(name, shortcuts)))
  }

  /// The tip with the name alone, for a button without a shortcut. Instead of the system `help(_:)`, not beside it.
  func pointerTip(_ name: String) -> some View {
    modifier(ShortcutTipModifier(text: name))
  }

  /// Podpowiedź z kilku wierszy (menu „+”: wiersz na pozycję). `pressGesture: false` na `Menu`: gest obok menu mógłby
  /// przejąć jego otwarcie, a otwarte menu i tak zdejmuje kursor z przycisku.
  func shortcutTip(lines: [ShortcutTipLine], pressGesture: Bool = true) -> some View {
    modifier(ShortcutTipModifier(text: ShortcutTipLine.text(lines), pressGesture: pressGesture))
  }
}

/// Mechanizm SwiftUI: kursor z `onContinuousHover` (palec go nie wysyła), naciśnięcie z gestu obok akcji przycisku,
/// dymek pod kotwicą UIKit w tle przycisku (ramka i okno przycisku, także w arkuszu i w pasku narzędzi).
struct ShortcutTipModifier: ViewModifier {
  let text: String
  var pressGesture = true
  @State private var controller = ShortcutTipController()

  func body(content: Content) -> some View {
    content
      .background { ShortcutTipAnchor(controller: controller) }
      .onContinuousHover { phase in
        switch phase {
        case .active: controller.pointerMoved()
        case .ended: controller.pointerExited()
        }
      }
      .simultaneousGesture(TapGesture().onEnded { controller.pressed() }, including: pressGesture ? .all : .subviews)
      .onAppear { controller.text = text }
      .onChange(of: text) { controller.text = text }
      .onDisappear { controller.pointerExited() }
  }
}

/// Pusty widok UIKit w tle przycisku SwiftUI: ramka i okno dla dymka. Dotyku i czytnika nie łapie.
struct ShortcutTipAnchor: UIViewRepresentable {
  let controller: ShortcutTipController

  func makeUIView(context: Context) -> ShortcutTipAnchorView {
    let view = ShortcutTipAnchorView()
    view.controller = controller
    controller.anchor = view
    return view
  }

  func updateUIView(_ view: ShortcutTipAnchorView, context: Context) {
    view.controller = controller
    controller.anchor = view
  }
}

final class ShortcutTipAnchorView: UIView {
  /// Kontroler podpowiedzi przycisku nad tą kotwicą (testy UIKit sięgają przez nią do mechanizmu SwiftUI).
  var controller: ShortcutTipController?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  /// Bez identyfikatora: ten nałożony na przycisk po `shortcutTip` (np. `list.newSession`) SwiftUI przenosi też na
  /// kotwicę, a XCUITest pokazuje widok z identyfikatorem jako element `Other` — drugi, nieklikalny, o ramce przycisku,
  /// w który trafiał `firstMatch`.
  override var accessibilityIdentifier: String? {
    get { nil }
    set {}
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }
}
#endif
