#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

/// Most SwiftUI → UIKit dla ekranu terminala. Fabryka powierzchni przychodzi ze
/// środowiska (`terminalSurfaceFactory`, wstrzykuje ją apka); bez niej albo bez zalogowania ekran mówi
/// „niedostępny". Zejście z trasy oddaje ekran do parkingu (`terminalScreenParking` ze środowiska): czeka do
/// 2 min z żywym gniazdem, a powrót do tego terminala bierze go z powrotem. Bez parkingu, bez znanego id albo
/// z sesją, która nie łączy się i nie żyje, zejście zamyka gniazdo od razu (`shutdown`). Właściciel: terminal.
public struct TerminalScreen: View {
  let store: RarogStore
  let target: TerminalTarget
  /// „⋯" i „×" w pasku nawigacji (``TerminalChrome``); `nil` = ekran bez tych przycisków.
  let chrome: TerminalChrome?
  let onClose: () -> Void
  let onHistory: ((String) -> Void)?
  let onTerminalIdentified: ((String) -> Void)?
  @Environment(\.terminalSurfaceFactory) private var factory
  @Environment(\.terminalScreenParking) private var parking

  public init(
    store: RarogStore, target: TerminalTarget, chrome: TerminalChrome? = nil, onClose: @escaping () -> Void,
    onHistory: ((String) -> Void)? = nil, onTerminalIdentified: ((String) -> Void)? = nil
  ) {
    self.store = store
    self.target = target
    self.chrome = chrome
    self.onClose = onClose
    self.onHistory = onHistory
    self.onTerminalIdentified = onTerminalIdentified
  }

  public var body: some View {
    if let factory {
      TerminalControllerHost(
        store: store, target: target, chrome: chrome, factory: factory, parking: parking, onClose: onClose,
        onHistory: onHistory, onTerminalIdentified: onTerminalIdentified)
    } else {
      Text(UICopy.terminalUnavailable)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

/// Host taba: SwiftUI dostaje za każdym razem NOWY kontener (``TerminalScreenHolder``), nigdy ekranu wprost — ekran
/// przechodzi między kontenerami przez parking.
struct TerminalControllerHost: UIViewControllerRepresentable {
  let store: RarogStore
  let target: TerminalTarget
  let chrome: TerminalChrome?
  let factory: TerminalSurfaceFactory
  let parking: TerminalScreenParking?
  let onClose: () -> Void
  let onHistory: ((String) -> Void)?
  let onTerminalIdentified: ((String) -> Void)?
  @Environment(SessionSwitcher.self) private var switcher: SessionSwitcher?
  /// Dymek „Skopiowano do schowka."; bez centrum — linia stanu.
  @Environment(ToastCenter.self) private var toasts: ToastCenter?

  func makeUIViewController(context: Context) -> UIViewController {
    let holder = TerminalScreenHolder.make(target: target, parking: parking) { [store, target, factory] in
      TerminalScreenViewController(store: store, target: target, factory: factory)
    }
    guard let holder, let screen = holder.heldScreen else {
      return UIHostingController(
        rootView: Text(UICopy.terminalUnavailable).foregroundStyle(Color(uiColor: Palette.muted)).textScaleHost())
    }
    wire(screen)
    return holder
  }

  func updateUIViewController(_ controller: UIViewController, context: Context) {
    if let screen = (controller as? TerminalScreenHolder)?.heldScreen { wire(screen) }
  }

  static func dismantleUIViewController(_ controller: UIViewController, coordinator: ()) {
    (controller as? TerminalScreenHolder)?.dismantle()
  }

  private func wire(_ screen: TerminalScreenViewController) {
    screen.switcher = switcher
    screen.onClose = onClose
    screen.onHistory = onHistory
    screen.onTerminalIdentified = onTerminalIdentified
    screen.onCopied = ToastCenter.confirmation(toasts)
    screen.chrome = chrome
  }
}

/// Kontener ekranu taba: osadza ekran jako dziecko na całą swoją powierzchnię. `make` bierze ekran
/// z parkingu pod id celu — tylko gdy ekran dalej jest tym terminalem — albo buduje nowy; `dismantle` wyjmuje
/// ekran (`willMove(toParent: nil)`, `removeFromSuperview`, `removeFromParent`) i parkuje go pod jego bieżącym id.
/// Ekran z parkingu dostaje ``TerminalScreenViewController/activate(parkedFor:resumesInput:)`` po osadzeniu, czyli
/// po podpięciu wywołań hosta (`make` podpina je przed pierwszym układem kontenera).
final class TerminalScreenHolder: UIViewController {
  private let screen: TerminalScreenViewController
  private weak var parking: TerminalScreenParking?
  /// Czas postoju ekranu wziętego z parkingu; `nil` = ekran nowy.
  private var parkedFor: Duration?
  private var released = false

  /// Kontener z ekranem z parkingu albo z nowym (`build`); `nil` = nowego ekranu nie ma (bez zalogowania).
  static func make(
    target: TerminalTarget, parking: TerminalScreenParking?, build: () -> TerminalScreenViewController?
  ) -> TerminalScreenHolder? {
    let key = target.id.map(TerminalParkingLedger.Key.terminal)
    if let key, let parking, let parked = parking.take(key, terminalId: target.id) {
      return TerminalScreenHolder(screen: parked.screen, parking: parking, parkedFor: parked.parked)
    }
    guard let screen = build() else { return nil }
    if let key { parking?.claim(key, for: screen) }
    return TerminalScreenHolder(screen: screen, parking: parking, parkedFor: nil)
  }

  private init(screen: TerminalScreenViewController, parking: TerminalScreenParking?, parkedFor: Duration?) {
    self.screen = screen
    self.parking = parking
    self.parkedFor = parkedFor
    super.init(nibName: nil, bundle: nil)
    // Rodzic od razu: znak „ekran zajęty" dla parkingu, zanim kontener ułoży widok.
    addChild(screen)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  /// Ekran, dopóki stoi w tym kontenerze.
  var heldScreen: TerminalScreenViewController? {
    !released && screen.parent === self ? screen : nil
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Palette.background
    guard let screen = heldScreen else { return }
    let screenView = screen.view!
    screenView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(screenView)
    NSLayoutConstraint.activate([
      screenView.topAnchor.constraint(equalTo: view.topAnchor),
      screenView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      screenView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      screenView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    screen.didMove(toParent: self)
    if let parked = parkedFor {
      parkedFor = nil
      screen.activate(parkedFor: parked, resumesInput: true)
    }
  }

  /// Widok taba zszedł: ekran wychodzi z kontenera i idzie do parkingu (bez parkingu — `shutdown`).
  func dismantle() {
    guard let screen = heldScreen else { return }
    released = true
    screen.willMove(toParent: nil)
    if screen.isViewLoaded { screen.view.removeFromSuperview() }
    screen.removeFromParent()
    guard let parking else { return screen.shutdown() }
    parking.park(screen, under: screen.terminalId.map(TerminalParkingLedger.Key.terminal))
  }
}
#endif
