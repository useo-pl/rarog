import Foundation
import RarogContract

/// Raport `kontrakt:` do `client.log` — nigdy treść rozmowy.
///
/// - Linie: `kontrakt: /sessions/state=zzz` (ścieżka BEZ indeksów tablic, wartość ≤ 40 znaków)
///   i `kontrakt: odrzucona <type>` (`?` bez czytelnego `type`).
/// - Ten sam bufor niesie nieobsłużone błędy apki (`błąd: …`, ``RarogStore/reportUnhandled(_:)``):
///   poziom `error` zamiast `debug`, ta sama bramka zalogowania, dedup i sufit.
/// - Dedup po treści linii i sufit 50 linii na życie procesu.
/// - Linia trafia do zbioru „zgłoszone" dopiero, gdy WYSZŁA: linia sprzed
///   zalogowania czeka w buforze i wychodzi po zalogowaniu, zamiast przepaść jako „już zgłoszona".
/// - Ślady diagnostyczne (powrót do apki, przerwanie z czasem) jadą tym samym buforem
///   i poziomem `debug`, ale z WŁASNYM budżetem (20 na godzinę): niosą czasy, więc dedup ich nie
///   łapie, a nie mogą zjeść sufitu linii `kontrakt:` i `błąd:`, które log musi pokazać.
/// - Voice agent conversation lines have a budget of their own (``TraceBudget``): the caller picks it, the reporter
///   never reads the line prefix.
@MainActor
final class ContractReporter {
  static let cap = 50
  /// Diagnostic traces per ``traceWindow`` (``TraceBudget/app``), apart from ``cap``.
  static let traceCap = 20
  /// Voice agent conversation lines per ``traceWindow`` (``TraceBudget/voiceAgent``), apart from ``traceCap``: one
  /// conversation writes a line per response and per utterance, so the shared 20 would drop its cost and its end.
  static let voiceAgentTraceCap = 240
  /// Tunnel and stream connection lines per ``traceWindow`` (``TraceBudget/connectivity``), apart from ``traceCap``:
  /// navigation lines spend the shared 20 within minutes, and a drop the owner just saw must still reach the log.
  static let connectivityTraceCap = 60
  static let traceWindow: TimeInterval = 3600
  /// Prefiks linii nieobsłużonego błędu — jedzie z poziomem `error`.
  static let problemPrefix = "błąd: "

  private(set) var reported: Set<String> = []
  private(set) var pending: [String] = []
  /// Uzbrojony po zalogowaniu i otwarciu strumienia globalnego (wcześniej POST to 401).
  var armed = false
  private var flushing = false
  /// Linie `kontrakt:`/`błąd:` przyjęte do bufora (wysłane albo czekające) — liczy je ``cap``.
  private var accepted = 0
  private var appTraces = TraceWindow()
  private var voiceAgentTraces = TraceWindow()
  private var connectivityTraces = TraceWindow()

  func record(_ lines: [String]) {
    for line in lines where !reported.contains(line) && !pending.contains(line) {
      guard accepted < Self.cap else { return }
      pending.append(line)
      accepted += 1
    }
  }

  /// Diagnostic trace under the budget the caller names, per ``traceWindow``; a clock set back (time
  /// change) opens a new window instead of closing traces until the process ends.
  func recordTrace(_ line: String, budget: TraceBudget = .app, now: Date) {
    let admitted =
      switch budget {
      case .app: appTraces.admit(cap: Self.traceCap, window: Self.traceWindow, now: now)
      case .voiceAgent: voiceAgentTraces.admit(cap: Self.voiceAgentTraceCap, window: Self.traceWindow, now: now)
      case .voiceAgentEnd: true
      case .connectivity: connectivityTraces.admit(cap: Self.connectivityTraceCap, window: Self.traceWindow, now: now)
      }
    guard admitted else { return }
    pending.append(line)
  }

  /// Wysyła bufor partiami, aż się opróżni: linia dopisana w trakcie wysyłki jedzie następną
  /// partią, nie czeka na kolejną ramkę. Porażka zostawia linie w buforze na następną próbę.
  func flush(_ send: @Sendable (ClientLogBody) async -> Bool, now: Date) async {
    guard !flushing else { return }
    flushing = true
    defer { flushing = false }
    let at = ISOTime.string(now)
    while armed, !pending.isEmpty {
      let batch = pending
      let body = ClientLogBody(events: batch.map { line in
        ClientLogBody.Event(at: at, level: line.hasPrefix(Self.problemPrefix) ? "error" : "debug", msg: line)
      })
      guard await send(body) else { return }
      pending.removeAll { batch.contains($0) }
      reported.formUnion(batch)
    }
  }

  /// Linie raportu dla jednej ramki.
  nonisolated static func lines(for outcome: Result<DecodedEvent, EventRejection>, data: Data) -> [String] {
    switch outcome {
    case let .success(decoded):
      return decoded.degradations.map { "kontrakt: \(stripIndices($0.path))=\($0.value.prefix(40))" }
    case let .failure(rejection):
      let type: String
      if case let .unknownType(name) = rejection.reason {
        type = String(name.prefix(40))
      } else {
        type = frameType(data).map { String($0.prefix(40)) } ?? "?"
      }
      return ["kontrakt: odrzucona \(type)"]
    }
  }

  /// `/sessions/3/state` → `/sessions/state`: indeksy tablic nie niosą informacji, a mnożyłyby linie.
  nonisolated static func stripIndices(_ path: String) -> String {
    path.split(separator: "/", omittingEmptySubsequences: false)
      .filter { segment in segment.isEmpty || !segment.allSatisfy(\.isNumber) }
      .joined(separator: "/")
  }

  private nonisolated static func frameType(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return object["type"] as? String
  }
}

/// Budget a diagnostic trace counts against (``RarogStore/trace(_:budget:)``).
public enum TraceBudget: Sendable, Equatable {
  /// Shared by the whole app: ``ContractReporter/traceCap`` per hour.
  case app
  /// Voice agent conversation lines: ``ContractReporter/voiceAgentTraceCap`` per hour.
  case voiceAgent
  /// The end line of a voice agent conversation: always passes. One per conversation, and the user starts each.
  case voiceAgentEnd
  /// Tunnel and stream connection lines: ``ContractReporter/connectivityTraceCap`` per hour.
  case connectivity
}

/// Count of traces in the current window of one budget.
private struct TraceWindow {
  private var start: Date?
  private var count = 0

  mutating func admit(cap: Int, window: TimeInterval, now: Date) -> Bool {
    if let start, now >= start, now.timeIntervalSince(start) < window {
      guard count < cap else { return false }
    } else {
      start = now
      count = 0
    }
    count += 1
    return true
  }
}
