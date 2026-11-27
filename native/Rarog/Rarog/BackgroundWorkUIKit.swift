import RarogCore
import RarogTransport
import UIKit

/// Czas od systemu na dokończenie żądania po zejściu w tło (`beginBackgroundTask`) — rdzeń owija
/// nim `visible: false`. Gdy czas się skończy, zadanie zamyka adapter sam (inaczej system zabija
/// apkę); późniejsze `end` rdzenia jest wtedy bez skutku. Jedyne miejsce apki, które woła
/// `UIApplication.beginBackgroundTask` (strażnik `server/test/native-background-work-guard.test.ts`).
/// Prace z `needsServer` adapter zgłasza koordynatorowi tunelu (start z terminem, koniec, wygaśnięcie), więc
/// generacja połączenia żyje w tle tak długo jak one; prace bez serwera (kończenie nagrania dyktowania) jej nie
/// trzymają. Łaskę tła tunelu koordynator trzyma własnym zadaniem bez serwera, z obsługą wygaśnięcia
/// (``begin(_:needsServer:expired:)``). That variant is a requirement of `BackgroundWork`, so the store's
/// `beginBackgroundWork(_:needsServer:expired:)` reaches it too (the send from the dictation's Live Activity).
@MainActor
final class UIKitBackgroundWork: BackgroundWork {
  /// Zadania w tle systemu: wejście adaptera (testy podają atrapę).
  struct System {
    /// Start zadania z obsługą wygaśnięcia; `nil` = system odmówił.
    var start: @MainActor (_ name: String, _ expired: @escaping @MainActor () -> Void) -> Int?
    var stop: @MainActor (_ id: Int) -> Void
    /// Czas, który system jeszcze daje (na wierzchu bez ograniczenia).
    var remaining: @MainActor () -> TimeInterval

    static var uikit: System {
      System(
        start: { name, expired in
          let id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated { expired() }
          }
          return id == .invalid ? nil : id.rawValue
        },
        stop: { id in UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id)) },
        remaining: { UIApplication.shared.backgroundTimeRemaining })
    }
  }

  /// Termin pracy, gdy system go nie podaje (praca rozpoczęta na wierzchu): wygaśnięcie i tak przychodzi
  /// zdarzeniem, termin tylko przycina budżet próby otwarcia w tle.
  static let foregroundAllowance: TimeInterval = 3600

  private let system: System
  private weak var observer: (any ServerWorkObserver)?
  private let now: () -> ContinuousClock.Instant
  /// Zadania otwarte i jeszcze nie zamknięte — `end` i wygaśnięcie zamykają każde dokładnie raz; wartość mówi,
  /// czy praca potrzebuje serwera, i kogo powiadomić o wygaśnięciu.
  private var live: [Int: Live] = [:]

  private struct Live {
    let needsServer: Bool
    let expired: (@MainActor () -> Void)?
  }

  /// Identyfikator dostępny w obsłudze wygaśnięcia, choć system nadaje go dopiero po jej podaniu.
  private final class Pending {
    var id: Int?
    var expiredEarly = false
  }

  init(
    system: System = .uikit, observer: (any ServerWorkObserver)? = nil,
    now: @escaping () -> ContinuousClock.Instant = { ContinuousClock.now }
  ) {
    self.system = system
    self.observer = observer
    self.now = now
  }

  func begin(_ name: String, needsServer: Bool) -> BackgroundWorkToken? {
    begin(name, needsServer: needsServer, expired: nil)
  }

  /// Jak ``begin(_:needsServer:)``, a `expired` dostaje wygaśnięcie zadania przez system (po jego zamknięciu,
  /// przed zdarzeniem dla koordynatora). Po `end` wygaśnięcia już nie ma.
  func begin(_ name: String, needsServer: Bool, expired: (@MainActor () -> Void)?) -> BackgroundWorkToken? {
    let pending = Pending()
    let started = system.start(name) { [weak self] in
      guard let id = pending.id else {
        pending.expiredEarly = true
        return
      }
      self?.expire(id)
    }
    guard let id = started else { return nil }
    pending.id = id
    live[id] = Live(needsServer: needsServer, expired: expired)
    if needsServer {
      let left = system.remaining()
      let allowance = left.isFinite && left < Self.foregroundAllowance ? max(left, 0) : Self.foregroundAllowance
      observer?.workStarted(TunnelMachine.WorkID(UInt64(id)), expiresAt: now() + .seconds(allowance))
    }
    if pending.expiredEarly { expire(id) }
    return BackgroundWorkToken(raw: id)
  }

  func end(_ token: BackgroundWorkToken) {
    guard let entry = finish(token.raw) else { return }
    if entry.needsServer { observer?.workFinished(TunnelMachine.WorkID(UInt64(token.raw))) }
  }

  private func expire(_ id: Int) {
    guard let entry = finish(id) else { return }
    entry.expired?()
    if entry.needsServer { observer?.workExpired(TunnelMachine.WorkID(UInt64(id))) }
  }

  /// Zamyka zadanie systemu raz; `nil` = już zamknięte.
  private func finish(_ id: Int) -> Live? {
    guard let entry = live.removeValue(forKey: id) else { return nil }
    system.stop(id)
    return entry
  }
}
