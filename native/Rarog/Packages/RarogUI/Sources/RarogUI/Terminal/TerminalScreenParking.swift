#if os(iOS)
import Observation
import RarogCore
import SwiftUI
import UIKit

// Parking ekranów terminala. Tab, z którego się zeszło, i okno
// Cmd+F/Cmd+G po zamknięciu nie kończą ekranu od razu: czeka on do 2 min (``TerminalParkingLedger/lifetime``)
// z żywą sesją i gniazdem, najwyżej cztery naraz, a powrót bierze go z powrotem — terminal stoi od razu, bez `POST`,
// nowego gniazda i okna pierwszego ekranu. Klucz: tab pod id terminala, okno pod katalogiem i rolą.
//
// Granice (dlaczego nie „na zawsze"): każdy ukryty terminal trzyma gniazdo i kontroler herdr (sufit
// `RAROG_TERM_MAX` serwera), ciągnie ramki działających programów i trzyma panel na Macu w rozmiarze iPada. Dlatego
// tło sceny, ostrzeżenie o pamięci i wylogowanie kończą wszystkie zaparkowane ekrany (inaczej `syncTerminals`
// budziłby ukryte sesje po powrocie), a parkowanie sprawdza zalogowanie i aktywną scenę w chwili parkowania —
// spóźniony dismantle po wyczyszczeniu nie odtwarza wpisu. Ekran bez id, po `shutdown()` albo z sesją, która nie
// łączy się i nie żyje (``TerminalScreenViewController/isReusable``), kończy się od razu.
//
// Kolejność dismantle i make w SwiftUI nie jest pewna (drugie Cmd+F w trakcie zamykania okna): parking pamięta
// ostatni ekran wydany pod każdym kluczem (``claim(_:for:)``), a starszy ekran parkowany pod kluczem nowszego,
// żywego ekranu kończy się zamiast czekać — jedno gniazdo na terminal. Ekran z rodzicem nie wychodzi z parkingu.
// Brak parkingu w środowisku (testy, podglądy) = zejście kończy ekran od razu. Właściciel: terminal.

/// Właściciel zaparkowanych ekranów terminala. Tworzy go apka przy magazynie i wstrzykuje środowiskiem
/// (`terminalScreenParking`) obok fabryki powierzchni.
@MainActor
public final class TerminalScreenParking {
  public typealias Key = TerminalParkingLedger.Key

  private var ledger = TerminalParkingLedger()
  /// Ekrany wpisów księgi, po numerze wpisu.
  private var screens: [Int: TerminalScreenViewController] = [:]
  /// Ostatni ekran wydany pod kluczem (nowy albo z parkingu) — słabo.
  private var owners: [Key: WeakScreen] = [:]
  private let isLoggedIn: @MainActor () -> Bool
  private let observeAuth: @MainActor (@escaping @Sendable () -> Void) -> Void
  private let sceneActive: @MainActor () -> Bool
  private let clock: @MainActor () -> ContinuousClock.Instant
  private let sleep: @Sendable (Duration) async -> Void
  private let center: NotificationCenter
  private var observers: [any NSObjectProtocol] = []
  /// Obserwacja zalogowania czeka na zmianę (tylko, gdy coś stoi w parkingu).
  private var authArmed = false

  /// - Parameters:
  ///   - isLoggedIn: zalogowanie teraz; bez niego parking nie przyjmuje ekranu.
  ///   - observeAuth: rejestruje JEDNORAZOWE wywołanie przy zmianie zalogowania (`withObservationTracking`).
  ///   - sceneActive: scena na wierzchu teraz; bez niej parking nie przyjmuje ekranu.
  ///   - clock, sleep: zegar postoju i sen zegara wygaszenia (testy: atrapy).
  public init(
    isLoggedIn: @escaping @MainActor () -> Bool,
    observeAuth: @escaping @MainActor (@escaping @Sendable () -> Void) -> Void = { _ in },
    sceneActive: @escaping @MainActor () -> Bool = TerminalScreenParking.anySceneActive,
    clock: @escaping @MainActor () -> ContinuousClock.Instant = { ContinuousClock.now },
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    center: NotificationCenter = .default
  ) {
    self.isLoggedIn = isLoggedIn
    self.observeAuth = observeAuth
    self.sceneActive = sceneActive
    self.clock = clock
    self.sleep = sleep
    self.center = center
    for name in [UIScene.didEnterBackgroundNotification, UIApplication.didReceiveMemoryWarningNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.shutdownAll() }
      })
    }
  }

  /// Parking magazynu apki: zalogowanie ze stanu magazynu, wylogowanie z obserwacji `state.auth`.
  public convenience init(store: RarogStore) {
    self.init(
      isLoggedIn: { [weak store] in store?.state.auth == .loggedIn },
      observeAuth: { [weak store] onChange in
        guard let store else { return }
        withObservationTracking { _ = store.state.auth } onChange: { onChange() }
      })
  }

  isolated deinit {
    for observer in observers { center.removeObserver(observer) }
  }

  /// Któraś scena apki jest na wierzchu (jak bramka przełącznika sesji).
  public static func anySceneActive() -> Bool {
    UIApplication.shared.connectedScenes.contains { $0.activationState == .foregroundActive }
  }

  /// Ile ekranów czeka (testy, diagnostyka).
  var count: Int { screens.count }

  // MARK: - Wejście i wyjście

  /// Ekran pod `key`: jest, nie wygasł, nie ma rodzica i nadal się nadaje (`terminalId` = dalej ten terminal, gdy
  /// wołający go podał). Wychodzi z parkingu razem z czasem postoju; nienadający się kończy się. `nil` = budować nowy.
  func take(_ key: Key, terminalId: String? = nil) -> (screen: TerminalScreenViewController, parked: Duration)? {
    let now = clock()
    sweep(now: now)
    guard let entry = ledger.take(key, now: now), let screen = screens.removeValue(forKey: entry.number) else {
      return nil
    }
    // Ekran z rodzicem stoi już gdzie indziej: nie ruszać go, tylko zapomnieć wpis.
    guard screen.parent == nil else { return nil }
    guard screen.isReusable, terminalId == nil || screen.terminalId == terminalId else {
      screen.shutdown()
      return nil
    }
    claim(key, for: screen)
    return (screen, now - entry.parkedAt)
  }

  /// Nowy ekran pod `key` (zbudowany, bo parking go nie miał): od teraz to on jest pod tym kluczem najnowszy.
  func claim(_ key: Key, for screen: TerminalScreenViewController) {
    owners[key] = WeakScreen(screen: screen)
  }

  /// Ekran zszedł z taba albo okna (host już wyjął go z siebie): do parkingu albo `shutdown()`. Bez klucza (ekran
  /// nie zna id), bez zalogowania, bez aktywnej sceny, nienadający się i starszy od żywego ekranu pod tym kluczem —
  /// koniec od razu.
  func park(_ screen: TerminalScreenViewController, under key: Key?) {
    guard screen.parent == nil else { return }  // ktoś już go osadził: nie nasz
    forget(screen)
    guard let key, screen.isReusable, isLoggedIn(), sceneActive(), !isSuperseded(screen, under: key) else {
      screen.shutdown()
      return
    }
    screen.park()
    let now = clock()
    sweep(now: now)
    let (entry, evicted) = ledger.park(key, now: now)
    for old in evicted { screens.removeValue(forKey: old.number)?.shutdown() }
    screens[entry.number] = screen
    claim(key, for: screen)
    scheduleExpiry(entry.number)
    armAuth()
  }

  /// Wszystkie zaparkowane ekrany kończą się (tło sceny, ostrzeżenie o pamięci, wylogowanie). Pamięć ostatniego
  /// ekranu pod kluczem traci tylko ekrany skończone: ekran w drodze do nowego okna dalej wypiera starszy, którego
  /// dismantle przyjdzie po czyszczeniu.
  public func shutdownAll() {
    _ = ledger.removeAll()
    let parked = screens.values
    screens.removeAll()
    for screen in parked { screen.shutdown() }
    owners = owners.filter { $0.value.screen.map { !$0.isShutDown } ?? false }
  }

  // MARK: - Wygaszanie

  /// Wpisy po czasie kończą się przy każdym wejściu i wyjściu, nawet gdy zegar wygaszenia jeszcze nie zadzwonił.
  private func sweep(now: ContinuousClock.Instant) {
    for entry in ledger.expired(now: now) { screens.removeValue(forKey: entry.number)?.shutdown() }
  }

  /// Zegar wygaszenia wpisu: po ``TerminalParkingLedger/lifetime`` kończy ekran, jeśli TEN wpis wciąż stoi.
  private func scheduleExpiry(_ number: Int) {
    let sleep = sleep
    Task { [weak self] in
      await sleep(TerminalParkingLedger.lifetime)
      self?.expire(number)
    }
  }

  private func expire(_ number: Int) {
    guard let entry = ledger.drop(number: number) else { return }
    screens.removeValue(forKey: entry.number)?.shutdown()
  }

  // MARK: - Pomocnicze

  /// Ten sam ekran parkowany drugi raz: stary wpis znika bez zamykania ekranu.
  private func forget(_ screen: TerminalScreenViewController) {
    for (number, parked) in screens where parked === screen {
      screens.removeValue(forKey: number)
      _ = ledger.drop(number: number)
    }
  }

  /// Pod kluczem stoi już nowszy ekran, który nie zszedł (make nowego okna przed dismantle starego) — także taki,
  /// który jeszcze się nie połączył: łączy się, gdy stanie na ekranie.
  private func isSuperseded(_ screen: TerminalScreenViewController, under key: Key) -> Bool {
    guard let owner = owners[key]?.screen, owner !== screen else { return false }
    return !owner.isShutDown
  }

  /// Wylogowanie kończy zaparkowane ekrany. Obserwacja tylko, gdy parking nie jest pusty.
  private func armAuth() {
    guard !authArmed, !screens.isEmpty else { return }
    authArmed = true
    observeAuth { [weak self] in Task { @MainActor in self?.authChanged() } }
  }

  private func authChanged() {
    authArmed = false
    if !isLoggedIn() { shutdownAll() }
    armAuth()
  }

  private struct WeakScreen {
    weak var screen: TerminalScreenViewController?
  }
}

extension EnvironmentValues {
  /// Parking ekranów terminala; `nil` = każde zejście z terminala kończy ekran (testy, podglądy).
  @Entry public var terminalScreenParking: TerminalScreenParking? = nil
}
#endif
