import Foundation

// Pad strzałek paska klawiszy (wzorzec Blink Shell). Strzałki wysyła GEST, nie tap: próg 12 pt,
// dominująca oś, histereza 6 pt przy zmianie osi, pierwsza strzałka od razu, seria po 350 ms w takcie
// 70 → 35 ms zależnie od wychylenia. Bajty STAŁE (`ESC[A/B/C/D`, bez DECCKM — herdr i tak trybu kursorów
// nie przepuszcza, zmierzone). Logika bez UIKit testuje się na macOS (`TerminalArrowPadTests`).
// Właściciel: terminal.

/// Kierunek pada.
public enum PadDirection: String, CaseIterable, Sendable {
  case up, down, left, right

  /// Sekwencja strzałki w trybie normalnym kursorów — dokładnie ta, którą wysyłają pigułki PWA.
  public var bytes: String {
    switch self {
    case .up: "\u{1B}[A"
    case .down: "\u{1B}[B"
    case .right: "\u{1B}[C"
    case .left: "\u{1B}[D"
    }
  }

  var isHorizontal: Bool { self == .left || self == .right }

  /// Nazwa dla czytnika (akcje dostępności pada).
  public var label: String {
    switch self {
    case .up: UICopy.terminalArrowUp
    case .down: UICopy.terminalArrowDown
    case .left: UICopy.terminalArrowLeft
    case .right: UICopy.terminalArrowRight
    }
  }
}

/// Reguły pada — stałe i czyste funkcje (PWA `PAD_*`).
public enum TerminalPad {
  /// Wychylenie, które odróżnia gest od tapnięcia (fałszywa strzałka w vimie kosztuje więcej niż brak).
  public static let slop: Double = 12
  /// Nowa oś musi wygrać wyraźnie, inaczej kciuk po przekątnej migotałby między osiami.
  public static let hysteresis: Double = 6
  /// Pauza przed serią — tyle, ile klawiatura systemowa (jeden dotyk ≠ seria).
  public static let repeatDelay: Duration = .milliseconds(350)
  /// Takt przy wychyleniu tuż za progiem i przy pełnym (ms).
  public static let intervalMaxMs: Double = 70
  public static let intervalMinMs: Double = 35
  /// Od tylu punktów wychylenie jest „pełne".
  public static let full: Double = 60

  /// Przesunięcie palca → kierunek albo `nil` („jeszcze nic"). Dominująca oś (remis = pion); dopóki próg nie
  /// padł, zostaje `current`; zwrot w tej samej osi jest natychmiastowy, zmiana osi wymaga histerezy.
  public static func direction(dx: Double, dy: Double, current: PadDirection? = nil) -> PadDirection? {
    guard dx.isFinite, dy.isFinite else { return current }
    let ax = abs(dx)
    let ay = abs(dy)
    let horizontal = ax > ay
    let reach = horizontal ? ax : ay
    // Palec pod progiem: trzymamy to, co jest — zerowanie w połowie gestu gasiłoby serię przy drgnięciu.
    guard reach >= slop else { return current }
    let next: PadDirection = horizontal ? (dx > 0 ? .right : .left) : (dy > 0 ? .down : .up)
    guard let current, next != current else { return next }
    if horizontal == current.isHorizontal { return next }
    return reach - min(ax, ay) > hysteresis ? next : current
  }

  /// Wychylenie na osi kierunku → takt serii w ms: ciągła interpolacja od 70 (próg) do 35 (pełne).
  public static func intervalMs(reach: Double) -> Double {
    guard reach.isFinite, reach > slop else { return intervalMaxMs }
    guard reach < full else { return intervalMinMs }
    let ratio = (reach - slop) / (full - slop)
    return intervalMaxMs - ratio * (intervalMaxMs - intervalMinMs)
  }
}

/// Stan jednego gestu pada: kierunek i wychylenie. Widok tylko odmierza czas.
public struct TerminalPadTracker: Sendable, Equatable {
  public private(set) var direction: PadDirection?
  /// Wychylenie na osi bieżącego kierunku — z niego liczy się takt serii.
  public private(set) var reach: Double = 0

  public init() {}

  /// Ruch palca liczony od punktu dotknięcia. Zwraca kierunek, gdy strzałka ma polecieć TERAZ: pierwsze
  /// przekroczenie progu albo zmiana kierunku w locie (pauza przed serią liczy się wtedy od nowa).
  public mutating func move(dx: Double, dy: Double) -> PadDirection? {
    guard let next = TerminalPad.direction(dx: dx, dy: dy, current: direction) else { return nil }
    reach = next.isHorizontal ? abs(dx) : abs(dy)
    guard next != direction else { return nil }
    direction = next
    return next
  }

  /// Takt kolejnego powtórzenia — czytany przy KAŻDYM tyknięciu, bo palec wciąż się przesuwa.
  public var repeatInterval: Duration { .milliseconds(TerminalPad.intervalMs(reach: reach)) }

  /// Koniec gestu (palec w górę, przerwanie): bez ogonów.
  public mutating func end() {
    direction = nil
    reach = 0
  }
}

#if os(iOS)
import UIKit

/// Pad na pasku: przytrzymanie i przesunięcie palca daje strzałkę i serię. Dla czytnika ekranu cztery akcje
/// (gest pada jest dla VoiceOvera niedostępny).
final class TerminalArrowPadView: UIView {
  var onArrow: ((PadDirection) -> Void)?

  private var tracker = TerminalPadTracker()
  private var start: CGPoint = .zero
  private var repeatTask: Task<Void, Never>?
  private let icon = UIImageView()
  private let press = UILongPressGestureRecognizer()
  /// Tło klawisza wcięte jak u przycisków paska; gest łapie cały cel 44 pt.
  private let key = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    key.backgroundColor = Palette.surface2
    key.layer.roundCorners(Radius.inner)
    key.isUserInteractionEnabled = false
    key.translatesAutoresizingMaskIntoConstraints = false
    addSubview(key)
    let insets = TerminalKeyBar.keyInsets
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.tintColor = Palette.text
    icon.contentMode = .center
    icon.preferredSymbolConfiguration = TerminalKeyBar.symbolConfiguration
    // A step on the flat path, where no trait change comes: the glyph takes the new size.
    Fonts.follow(self) { [weak self] in self?.icon.preferredSymbolConfiguration = TerminalKeyBar.symbolConfiguration }
    addSubview(icon)
    NSLayoutConstraint.activate([
      key.topAnchor.constraint(equalTo: topAnchor, constant: insets.top),
      key.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -insets.bottom),
      key.leadingAnchor.constraint(equalTo: leadingAnchor, constant: insets.leading),
      key.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -insets.trailing),
      icon.centerXAnchor.constraint(equalTo: centerXAnchor),
      icon.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    showDirection(nil)
    press.minimumPressDuration = 0
    press.allowableMovement = .greatestFiniteMagnitude
    press.addTarget(self, action: #selector(handlePress(_:)))
    addGestureRecognizer(press)
    isAccessibilityElement = true
    accessibilityLabel = UICopy.terminalKeyPad
    accessibilityHint = UICopy.terminalKeyPadHint
    accessibilityTraits = .allowsDirectInteraction
    accessibilityCustomActions = PadDirection.allCases.map { direction in
      UIAccessibilityCustomAction(name: direction.label) { [weak self] _ in
        self?.onArrow?(direction)
        return true
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  @objc private func handlePress(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      stop()
      start = gesture.location(in: self)
    case .changed:
      let point = gesture.location(in: self)
      guard let fire = tracker.move(dx: point.x - start.x, dy: point.y - start.y) else { return }
      showDirection(fire)
      onArrow?(fire)
      scheduleSeries()
    default:
      stop()
    }
  }

  /// Seria: pauza `repeatDelay`, potem strzałka co takt z bieżącego wychylenia — aż palec puści.
  private func scheduleSeries() {
    repeatTask?.cancel()
    repeatTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: TerminalPad.repeatDelay)
      while !Task.isCancelled {
        guard let self, let direction = self.tracker.direction else { return }
        self.onArrow?(direction)
        let interval = self.tracker.repeatInterval
        try? await Task.sleep(for: interval)
      }
    }
  }

  private func stop() {
    repeatTask?.cancel()
    repeatTask = nil
    tracker.end()
    showDirection(nil)
  }

  private func showDirection(_ direction: PadDirection?) {
    let name = direction.map { "dpad.\($0.rawValue).filled" } ?? TerminalBarKey.pad.symbol
    icon.image = UIImage(systemName: name)
  }

  override func removeFromSuperview() {
    stop()
    super.removeFromSuperview()
  }
}
#endif
