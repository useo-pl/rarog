import Foundation
import Synchronization

// Linie tunelu do `client.log` przed wspólnym budżetem śladów apki (`ContractReporter.traceCap`, 20 na godzinę).
// Przy częstych cyklach tła tunel zjadał ten budżet liniami informacyjnymi, a porażka generacji iroh z późniejszego
// cyklu nie miała już linii. Reguły:
// - porażka generacji iroh (przejście na HTTPS) i watchdog to alarmy: własny podbudżet ``alertCap`` na godzinę,
//   którego linie informacyjne nie ruszają; so are a ready iroh generation closing in the foreground and the
//   recovery of an iroh-only outage (the machine writes one failure line and one recovery line per outage), and an
//   alarm line ends with the time of the event (`at HH:mm:ss UTC`), because a batch of lines gets the time it was
//   sent;
// - pozostałe linie `tunnel:` i `lease:` mają podbudżet ``infoCap`` na godzinę;
// - linia stanu `tunnel state:` przy wyjściu z tła: najwyżej raz na ``stateInterval``, od razu, gdy liczby
//   przekraczają stan ustalony (`excess` niżej); niesie liczbę linii, które podbudżety pominęły od poprzedniej.
// Okno podbudżetu liczy się od pierwszej linii po poprzednim oknie, jak `TerminalOpenTraceBudget`.

/// Liczby tunelu w chwili wyjścia z tła: liczniki koordynatora i runtime'ów, bez nowych źródeł.
nonisolated struct TunnelSnapshot: Sendable, Equatable {
  /// `routeStamp` bieżącej tożsamości: numer ostatniej generacji, którą dostał przełącznik (0 bez tożsamości).
  var route: UInt64 = 0
  /// Runtime'y w rejestrze dzierżawy (bieżący, jednorazowe, wycofane do `retiredKept`).
  var runtimes = 0
  var endpoints = 0
  var listeners = 0
  var pairs = 0
  /// Połączenia tunelu wszystkich runtime'ów.
  var connections = 0
  /// Drzwi uploadu wszystkich runtime'ów.
  var doors = 0
  /// Prace w tle z `needsServer` w toku.
  var works = 0
  var away: Duration = .zero

  /// Po minucie tła bez prac generacja jest zamknięta (łaska 8 s i zamykanie), a runtime'y wycofane zdjęte z rejestru
  /// (30 s), więc stan ustalony to zero połączeń, nasłuchów, par i drzwi i jeden runtime.
  static let quietAfter: Duration = .seconds(60)

  var quiet: Bool { away >= Self.quietAfter && works == 0 }

  /// Liczby ponad stan ustalony. Zawsze: endpointów ≤ 1, połączeń i nasłuchów ≤ 1 (żywa generacja)
  /// plus drzwi. Po ``quietAfter`` bez prac: zero połączeń, nasłuchów, par i drzwi, jeden runtime.
  var excess: [String] { exceeded.map(\.name) }

  /// Klucz nadmiaru: przekroczone liczniki z wartościami (`listeners=1`), bez `route`, czasu tła i liczników w normie.
  /// Ten sam nadmiar przy następnym powrocie, także po nowej generacji, nie daje drugiej linii przed
  /// ``TunnelTrace/stateInterval``, więc nie zjada wspólnego budżetu śladów przed alarmem.
  var excessKey: [String] { exceeded.map { "\($0.name)=\($0.value)" } }

  private var exceeded: [(name: String, value: Int)] {
    let live = quiet ? 0 : 1 + doors
    var over: [(name: String, value: Int)] = []
    if endpoints > 1 { over.append(("endpoints", endpoints)) }
    if listeners > live { over.append(("listeners", listeners)) }
    if connections > live { over.append(("connections", connections)) }
    if quiet, pairs > 0 { over.append(("pairs", pairs)) }
    if quiet, doors > 0 { over.append(("doors", doors)) }
    if quiet, runtimes > 1 { over.append(("runtimes", runtimes)) }
    return over
  }

  /// `tunnel state: steady; route=7 runtimes=1 endpoints=1 listeners=0 pairs=0 connections=0 doors=0 works=0
  /// away=63s dropInfo=2 dropAlert=0`, przy nadmiarze `tunnel state: over listeners,pairs; …`.
  func line(droppedInfo: Int, droppedAlerts: Int) -> String {
    let excess = excess
    let head = excess.isEmpty ? "steady" : "over \(excess.joined(separator: ","))"
    let seconds = Int((away / .seconds(1)).rounded(.down))
    return "tunnel state: \(head); route=\(route) runtimes=\(runtimes) endpoints=\(endpoints) listeners=\(listeners) "
      + "pairs=\(pairs) connections=\(connections) doors=\(doors) works=\(works) away=\(seconds)s "
      + "dropInfo=\(droppedInfo) dropAlert=\(droppedAlerts)"
  }
}

/// Brama linii tunelu: podbudżety i linia stanu.
nonisolated final class TunnelTrace: Sendable {
  static let alertCap = 6
  static let infoCap = 4
  static let window: Duration = .seconds(3600)
  static let stateInterval: Duration = .seconds(600)

  private struct Window {
    var start: ContinuousClock.Instant?
    var admitted = 0

    mutating func admit(_ now: ContinuousClock.Instant, cap: Int) -> Bool {
      if let start, now - start < TunnelTrace.window {
        guard admitted < cap else { return false }
      } else {
        start = now
        admitted = 0
      }
      admitted += 1
      return true
    }
  }

  private struct State {
    var alerts = Window()
    var info = Window()
    var droppedInfo = 0
    var droppedAlerts = 0
    var lastState: ContinuousClock.Instant?
    /// ``TunnelSnapshot/excessKey`` ostatniej linii z nadmiarem; `nil` po linii stanu ustalonego.
    var lastOver: [String]?
  }

  private let sink: @Sendable (String) -> Void
  private let now: @Sendable () -> ContinuousClock.Instant
  private let wallClock: @Sendable () -> Date
  private let state = Mutex(State())

  /// - Parameter wallClock: time of day for alarm lines (tests pass a fixed date).
  init(sink: @escaping @Sendable (String) -> Void, now: @escaping @Sendable () -> ContinuousClock.Instant,
       wallClock: @escaping @Sendable () -> Date = { Date() }) {
    self.sink = sink
    self.now = now
    self.wallClock = wallClock
  }

  /// Alarm: porażka generacji iroh (maszyna przechodzi na HTTPS) albo watchdog nasłuchów i endpointów; also a ready
  /// iroh generation closing in the foreground and the recovery of an iroh-only outage (`TunnelMachine`).
  static func isAlert(_ line: String) -> Bool {
    if line.hasPrefix("tunnel watchdog:") { return true }
    guard line.hasPrefix("tunnel: generation ") else { return false }
    return line.contains(" (iroh) failed: ") || line.contains(" (iroh) closed in foreground: ")
      || line.contains(" (iroh) recovered after ")
  }

  /// `HH:mm:ss` in UTC, the zone of the server's `receivedAt`.
  static func clockTime(_ date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
    let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
    return String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
  }

  /// Linia tunelu przez swój podbudżet.
  func send(_ line: String) {
    let alert = Self.isAlert(line)
    let at = now()
    let admitted = state.withLock { state -> Bool in
      if alert {
        guard state.alerts.admit(at, cap: Self.alertCap) else {
          state.droppedAlerts += 1
          return false
        }
      } else {
        guard state.info.admit(at, cap: Self.infoCap) else {
          state.droppedInfo += 1
          return false
        }
      }
      return true
    }
    guard admitted else { return }
    sink(alert ? "\(line) at \(Self.clockTime(wallClock())) UTC" : line)
  }

  /// Linia stanu przy wyjściu z tła (chwila `at`): pierwsza w procesie, potem co ``stateInterval``; nadmiar od razu,
  /// chyba że ten sam nadmiar (``TunnelSnapshot/excessKey``) miała już poprzednia linia.
  func state(_ snapshot: TunnelSnapshot, at: ContinuousClock.Instant) {
    let over = !snapshot.excess.isEmpty
    let line = state.withLock { state -> String? in
      let due = state.lastState.map { at - $0 >= Self.stateInterval } ?? true
      let newExcess = over && state.lastOver != snapshot.excessKey
      if !over { state.lastOver = nil }
      guard due || newExcess else { return nil }
      state.lastState = at
      if over { state.lastOver = snapshot.excessKey }
      defer {
        state.droppedInfo = 0
        state.droppedAlerts = 0
      }
      return snapshot.line(droppedInfo: state.droppedInfo, droppedAlerts: state.droppedAlerts)
    }
    if let line { sink(line) }
  }
}
