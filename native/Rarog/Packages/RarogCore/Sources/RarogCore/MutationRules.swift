import Foundation
import RarogContract
import RarogTransport

/// Bramki klienta dla transportu (`MutationPolicy`) — stan bierze z ``RarogStore``.
///
/// - Zgodność: przed pierwszym `hello` mutacja czeka najwyżej `compatWait` (5 s), potem odmowa
///   „brak połączenia"; `tooOld`/`protocolMismatch` = odmowa z kierunkiem lekarstwa.
///   Wyjątki (logowanie, log diagnostyczny, obecność) zna `MutationGate` w transporcie.
/// - Lista z pamięci podręcznej: przy zgodnej apce mutacja czeka na świeży
///   `sessions-snapshot` w tym samym limicie, potem odmowa „brak połączenia" — na obrazie sprzed
///   uśpienia nic nie wychodzi. Sesja z cache dostaje po świeżej liście tylko trasy z
///   ``listOnlyRoutes`` (zamknięcie); reszta działa na treści sesji i czeka na jej pierwszy transkrypt.
/// - Sesja `unsupported` (nieznany stan albo silnik) nie dostaje niczego pod
///   `/api/sessions/<id>/…`. To wygoda klienta; granicą jest serwer.
///
/// Tworzona PRZED klientem HTTP (klient potrzebuje polityki), z magazynem dowiązanym później.
@MainActor
public final class MutationRules: MutationPolicy {
  weak var store: RarogStore?
  private let timing: CoreTiming
  private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

  public init(timing: CoreTiming = .production) {
    self.timing = timing
  }

  public func compatibilityRefusal() async -> PolicyRefusal? {
    let login = store?.currentLogin
    if !settled { await waitForHello() }
    // Oczekiwanie należy do zalogowania z chwili gestu. Nowe `hello` po 401 nie może wypuścić
    // starej akcji, którą klient HTTP wysłałby dopiero po otwarciu bramki.
    guard !Task.isCancelled, login == store?.currentLogin else { return Self.noConnection }
    switch currentCompat {
    case .ok: return listStale ? Self.noConnection : nil
    case .unknown: return Self.noConnection
    case .tooOld, .protocolMismatch: return currentCompat.permanentRefusal.map { PolicyRefusal($0) }
    }
  }

  /// Odmowa, która minie sama: brak `hello` albo świeżej listy w limicie czekania. Terminal ponawia po niej,
  /// zamiast stawać (`TerminalSession.openFailure`).
  static var noConnection: PolicyRefusal { PolicyRefusal(CoreCopy.noConnection, transient: true) }

  /// Wejście terminala: odmawia WYŁĄCZNIE niezgodność trwała (`tooOld`, `protocolMismatch`) i nie
  /// czeka na `hello` ani świeżą listę. Pyta ją też każde gniazdo terminala przed upgrade'em — także gniazdo
  /// bez `POST` (cel bez katalogu, znane id), które pełnej bramki `POST /api/term` nie przechodzi.
  /// Wejście terminala nie zależy od strumienia SSE — przejściowy brak listy po powrocie z tła nie ma prawa
  /// wstrzymywać klawiszy ani gniazda; granicą jest serwer (klucz urządzenia, `Origin`, rejestr terminali).
  public func terminalInputRefusal() async -> PolicyRefusal? {
    currentCompat.permanentRefusal.map { PolicyRefusal($0) }
  }

  /// Trasy sesji, którym wystarcza świeża lista: zamknięcie panelu wymaga tylko tego, że sesja
  /// istnieje (lista to mówi), a przełącznik „przeczytane / nieprzeczytane" z wiersza działa na stanie
  /// wyniku z listy. Karty, pole, Stop, tryb i „Wznów" działają na treści sesji, więc sesja z cache dostaje je
  /// dopiero po pierwszym transkrypcie; odbiór przy wejściu w sesję czeka na niego sam (`seenTarget`).
  static let listOnlyRoutes: Set<String> = ["close", "seen", "unseen"]

  public func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    guard let state = store?.state else { return nil }
    if state.sessions[sessionId]?.isUnsupported == true { return PolicyRefusal(CoreCopy.unsupportedSession) }
    let stale = Self.listOnlyRoutes.contains(route) ? state.listStale : state.sessionStale(sessionId)
    return stale ? Self.noConnection : nil
  }

  /// Woła magazyn po każdej zmianie zgodności i świeżości listy: czekające mutacje dostają
  /// odpowiedź od razu.
  func compatibilityChanged() {
    guard settled else { return }
    let ready = waiters.values
    waiters.removeAll()
    for waiter in ready { waiter.resume() }
  }

  private var currentCompat: Compatibility { store?.state.compat ?? .unknown }
  private var listStale: Bool { store?.state.listStale ?? false }

  /// Bramka zna odpowiedź: zgodność po `hello` i — przy zgodnej apce — lista świeża.
  private var settled: Bool {
    switch currentCompat {
    case .unknown: false
    case .ok: !listStale
    case .tooOld, .protocolMismatch: true
    }
  }

  private func waitForHello() async {
    let id = UUID()
    let limit = timing.compatWait
    await withCheckedContinuation { continuation in
      waiters[id] = continuation
      Task {
        try? await Task.sleep(for: limit)
        self.timeOut(id)
      }
    }
  }

  private func timeOut(_ id: UUID) {
    waiters.removeValue(forKey: id)?.resume()
  }
}
