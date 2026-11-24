import Foundation

/// Źródło decyzji bramki mutacji — wstrzykiwane przez `RarogCore`, który zna stan.
///
/// Transport nie wie, CO jest niezgodne ani która sesja jest nieobsługiwana; pyta tylko
/// i przenosi zdanie odmowy (copy należy do apki, nie do transportu) razem z tym, czy odmowa minie sama.
public protocol MutationPolicy: Sendable {
  /// Globalny stan zgodności (`Compatibility` z RarogCore): `nil` = wolno, inaczej odmowa.
  /// Wolno tu CZEKAĆ (przed pierwszym `hello` mutacje czekają ≤ 5 s) — stąd `async`.
  func compatibilityRefusal() async -> PolicyRefusal?
  /// Mutacja pod `/api/sessions/<id>/…` (sesja `unsupported`, sesja z pamięci podręcznej):
  /// `nil` = wolno, inaczej odmowa. `route` = trasa po identyfikatorze (`close`, `messages`,
  /// `answers/<qId>`…) — polityka rozróżnia akcje, które potrzebują tylko listy, od tych na treści sesji.
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal?
  /// The same for a request that tells the gate whether its body carries `expectedConversation` (a message of the
  /// voice agent, whose conversation the server checks). Default: ``sessionRefusal(sessionId:route:)``.
  func sessionRefusal(sessionId: String, route: String, expectsConversation: Bool) async -> PolicyRefusal?
  /// Wejście terminala (WS `in`/`rs`/`sc`): `nil` = wolno, inaczej odmowa TRWAŁA (apka za stara albo
  /// inny protokół). Bez czekania i bez świeżości listy sesji: gniazdo terminala nie zależy od strumienia
  /// SSE, a klawisz wstrzymany na 5 s po powrocie z tła byłby gorszy od PWA, która bramki nie ma wcale.
  /// Domyślnie: ``compatibilityRefusal()`` (polityki testowe i starsze implementacje).
  func terminalInputRefusal() async -> PolicyRefusal?
}

extension MutationPolicy {
  public func terminalInputRefusal() async -> PolicyRefusal? { await compatibilityRefusal() }

  public func sessionRefusal(sessionId: String, route: String, expectsConversation: Bool) async -> PolicyRefusal? {
    await sessionRefusal(sessionId: sessionId, route: route)
  }
}

/// Odmowa polityki: zdanie dla człowieka i to, czy minie sama (brak `hello` albo świeżej listy w limicie
/// czekania), w odróżnieniu od niezgodności trwałej. Decyzje (terminal ponawia po odmowie przejściowej) idą
/// po polu `transient`, nigdy po treści zdania — zdanie zależy od języka apki.
public struct PolicyRefusal: Sendable, Equatable {
  public let message: String
  public let transient: Bool

  public init(_ message: String, transient: Bool = false) {
    self.message = message
    self.transient = transient
  }
}

/// Polityka bez bramek — testy i wczesny etap, zanim `RarogCore` zna stan.
public struct AllowAllMutations: MutationPolicy {
  public init() {}
  public func compatibilityRefusal() async -> PolicyRefusal? { nil }
  public func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

/// Odmowa bramki, zanim cokolwiek wyszło do serwera.
public struct MutationRefusal: Error, Sendable, Equatable {
  public enum Gate: Sendable, Equatable {
    /// Apka za stara albo inny protokół (`tooOld`/`protocolMismatch`/brak `hello`).
    case compatibility
    /// Mutacja adresowana do sesji nieobsługiwanej.
    case unsupportedSession(id: String)
  }

  public let gate: Gate
  public let message: String
  /// Odmowa minie sama (``PolicyRefusal/transient``).
  public let transient: Bool

  public init(gate: Gate, message: String, transient: Bool = false) {
    self.gate = gate
    self.message = message
    self.transient = transient
  }

  public init(gate: Gate, _ refusal: PolicyRefusal) {
    self.init(gate: gate, message: refusal.message, transient: refusal.transient)
  }
}

/// JEDNO miejsce obu bramek klienta (`docs/security-model.md` „A session this app version cannot read”) —
/// przechodzi przez nie każda mutacja HTTP i każde wejście terminala.
///
/// - Odczyty (`GET`/`HEAD`) przechodzą zawsze: tryb czytania działa także przy niezgodności.
/// - Wyjątki od bramki zgodności: parowanie kodem (przed pierwszym `hello` nowego serwera), „Zapomnij
///   serwer” (odpięcie siebie działa też przy apce za starej i bez połączenia — best-effort), log diagnostyczny
///   i obecność — bez nich apka za stara nie mogłaby się sparować ani powiedzieć, że jest za stara.
/// - Bramka sesji obejmuje mutacje `/api/sessions/<id>/…`.
public struct MutationGate: Sendable {
  /// Ścieżki zwolnione z bramki zgodności.
  public static let compatibilityExempt: Set<String> = [
    "/api/pair", "/api/devices/forget", "/api/client-log", "/api/presence",
  ]

  public let policy: any MutationPolicy

  public init(policy: any MutationPolicy) {
    self.policy = policy
  }

  /// Sprawdza żądanie HTTP; rzuca ``MutationRefusal``, gdy któraś bramka odmawia.
  /// `expectsConversation`: the body carries `expectedConversation`; the policy decides what it changes.
  public func check(method: String, path: String, expectsConversation: Bool = false) async throws(MutationRefusal) {
    guard Self.isMutation(method) else { return }
    if !Self.compatibilityExempt.contains(path), let refusal = await policy.compatibilityRefusal() {
      throw MutationRefusal(gate: .compatibility, refusal)
    }
    if let target = Self.sessionTarget(inPath: path),
      let refusal = await policy.sessionRefusal(
        sessionId: target.id, route: target.route, expectsConversation: expectsConversation)
    {
      throw MutationRefusal(gate: .unsupportedSession(id: target.id), refusal)
    }
  }

  /// Wejście terminala (WS `in`/`rs`/`sc`) — podlega bramce zgodności
  /// (``MutationPolicy/terminalInputRefusal()``): odmowa znaczy niezgodność trwałą, nie chwilowy brak listy.
  public func checkTerminalInput() async throws(MutationRefusal) {
    if let refusal = await policy.terminalInputRefusal() {
      throw MutationRefusal(gate: .compatibility, refusal)
    }
  }

  static func isMutation(_ method: String) -> Bool {
    switch method.uppercased() {
    case "GET", "HEAD": false
    default: true
    }
  }

  /// `<id>` (zakodowany segment odkodowany) i trasa po nim z `/api/sessions/<id>/…`, inaczej `nil`.
  static func sessionTarget(inPath path: String) -> (id: String, route: String)? {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count >= 5, segments[0].isEmpty, segments[1] == "api", segments[2] == "sessions",
      !segments[3].isEmpty
    else { return nil }
    let raw = String(segments[3])
    return (raw.removingPercentEncoding ?? raw, segments[4...].joined(separator: "/"))
  }
}
