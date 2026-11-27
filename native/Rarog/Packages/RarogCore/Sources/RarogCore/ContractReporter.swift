import Foundation
import RarogContract
import RarogTransport

/// Raport `kontrakt:` do `client.log` — nigdy treść rozmowy.
///
/// - Linie: `kontrakt: /sessions/state=zzz` (ścieżka BEZ indeksów tablic, wartość ≤ 40 znaków)
///   i `kontrakt: odrzucona <type>` (`?` bez czytelnego `type`).
/// - Ten sam bufor niesie nieobsłużone błędy apki (`błąd: …`, ``RarogStore/reportUnhandled(_:)``):
///   poziom `error` zamiast `debug`, ta sama bramka zalogowania, dedup i sufit.
/// - Sufit 50 linii na życie procesu.
/// - A line about server A never reaches server B. Every queued line carries a stamp when it is recorded: the server
///   it concerns (``ServerKey``) or the pairing offer it was recorded under. The producer names it (``Owner``); a line
///   of the running login takes that login's key, never a server read from the store's state. A flush sends and
///   removes only the lines stamped with its recipient's key; the others wait for a login to their server and go at a
///   login to another one (``bind(_:)``). A line with no server is accepted only before the first login of the
///   process, which it then goes to.
/// - Dedup by stamp and line: a line of server A never blocks the same line of server B.
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
  /// Lines of leaving the background (the session screen's return line, the Live Activity foreground line) per
  /// ``traceWindow`` (``TraceBudget/foreground``), apart from ``traceCap``: navigation lines spend the shared 20 within
  /// minutes, and a return must still reach the log. Two lines per return, up to about 100 returns in an hour.
  static let foregroundTraceCap = 240
  /// Live Activity content lines per ``traceWindow`` (``TraceBudget/liveActivityContent``), apart from
  /// ``foregroundTraceCap``: one per content the system hands the app, about 150 per device in the busiest hour, so a
  /// busy hour does not drop the return lines.
  static let liveActivityContentTraceCap = 240
  static let traceWindow: TimeInterval = 3600
  /// The server's ceiling for one `POST /api/client-log` body (`CLIENT_LOG_MAX_REQUEST_BYTES` in
  /// `server/src/client-log.ts`, read by the test): a bigger body is refused whole.
  static let serverRequestLimit = 64 * 1024
  /// Encoded event bytes one body carries at most: half the server's ceiling, which leaves room for what the server
  /// adds to each line (`receivedAt`, the client tag) and for the body around the events.
  static let batchBytes = serverRequestLimit / 2
  /// A longer line goes cut to its first characters, so one line always fits a body (a character takes at most 6
  /// bytes as a JSON escape) and never blocks the queue.
  static let maxLineCharacters = 2000
  /// Prefiks linii nieobsłużonego błędu — jedzie z poziomem `error`.
  static let problemPrefix = "błąd: "

  /// Whom a queued line belongs to: the server it concerns, or a pairing offer whose server is known only when its
  /// pairing succeeds (``resolveOffer(_:as:)``). A line of an offer never goes out on its own.
  enum Stamp: Hashable {
    case server(ServerKey)
    case offer(Int)
  }

  /// Whom a line belongs to, as its producer knows it.
  enum Owner {
    /// The login running now; without one, the pairing offer open now; without either, no server.
    case current
    /// The server the line concerns; `nil` = no single server.
    case server(ServerKey?)
    /// A pairing offer (``openOffer()``); a line of an offer closed meanwhile is dropped.
    case offer(Int)
  }

  /// A queued line; `stamp == nil` only for a line recorded before the first login of the process.
  struct Entry {
    let id: Int
    let line: String
    var stamp: Stamp?
    /// A `kontrakt:` or `błąd:` line (``record(_:owner:)``): one per stamp in the queue. Traces carry times, so they
    /// are not deduplicated.
    let deduplicated: Bool
  }

  /// Lines the current recipient got (dedup for its key); a new recipient starts empty.
  private(set) var reported: Set<String> = []
  private(set) var entries: [Entry] = []
  /// The queued lines, oldest first.
  var pending: [String] { entries.map(\.line) }
  /// Uzbrojony po zalogowaniu i otwarciu strumienia globalnego (wcześniej POST to 401).
  var armed = false
  /// Number of the queue's recipient: every login end (``retire()``) and every key change in place (``rekey(_:)``)
  /// starts a new one. A send in flight belongs to the recipient of its start; its late answer does not touch the
  /// queue of the next one.
  private(set) var recipient = 0
  /// The key of the running login (``bind(_:)`` to ``retire()``): the stamp of its lines and the key its flush sends.
  private(set) var login: ServerKey?
  /// The pairing offer open now (``openOffer()``).
  private(set) var offer: Int?
  /// A login happened in this process: a line with no server is dropped from then on.
  private var bound = false
  /// The owner of lines recorded with ``Owner/current`` inside ``within(_:_:)``.
  private var scope: Owner?
  private var offers = 0
  /// A pairing attempt already used the open offer (``attemptOffer()``).
  private var offerAttempted = false
  private var nextId = 0
  /// The recipient whose flush runs now; a flush of an older recipient does not hold the queue of the next.
  private var flushing: Int?
  /// Linie `kontrakt:`/`błąd:` przyjęte do bufora (wysłane albo czekające) — liczy je ``cap``.
  private var accepted = 0
  private var appTraces = TraceWindow()
  private var voiceAgentTraces = TraceWindow()
  private var connectivityTraces = TraceWindow()
  private var foregroundTraces = TraceWindow()
  private var liveActivityContentTraces = TraceWindow()

  func record(_ lines: [String], owner: Owner = .current) {
    guard let stamp = stamp(owner) else { return }
    for line in lines where !queued(line, stamp) {
      guard accepted < Self.cap else { return }
      append(line, stamp, deduplicated: true)
      accepted += 1
    }
  }

  /// Diagnostic trace under the budget the caller names, per ``traceWindow``; a clock set back (time
  /// change) opens a new window instead of closing traces until the process ends. A trace that would be dropped for
  /// its owner spends no budget.
  func recordTrace(_ line: String, budget: TraceBudget = .app, now: Date, owner: Owner = .current) {
    guard let stamp = stamp(owner) else { return }
    let admitted =
      switch budget {
      case .app: appTraces.admit(cap: Self.traceCap, window: Self.traceWindow, now: now)
      case .voiceAgent: voiceAgentTraces.admit(cap: Self.voiceAgentTraceCap, window: Self.traceWindow, now: now)
      case .voiceAgentEnd: true
      case .connectivity: connectivityTraces.admit(cap: Self.connectivityTraceCap, window: Self.traceWindow, now: now)
      case .foreground: foregroundTraces.admit(cap: Self.foregroundTraceCap, window: Self.traceWindow, now: now)
      case .liveActivityContent:
        liveActivityContentTraces.admit(cap: Self.liveActivityContentTraceCap, window: Self.traceWindow, now: now)
      }
    guard admitted else { return }
    append(line, stamp, deduplicated: false)
  }

  /// Lines recorded with ``Owner/current`` by `body` belong to `owner`. `body` is synchronous, so only the code it
  /// runs records under it.
  func within<T>(_ owner: Owner, _ body: () -> T) -> T {
    let outer = scope
    scope = owner
    defer { scope = outer }
    return body()
  }

  /// A login to `key` starts. Lines recorded before the first login of the process belong to it; lines of another
  /// server go, so they never reach this one. Lines of an open pairing offer stay with the offer.
  func bind(_ key: ServerKey) {
    login = key
    bound = true
    for index in entries.indices where entries[index].stamp == nil { entries[index].stamp = .server(key) }
    entries.removeAll { entry in
      if case let .server(server) = entry.stamp { server != key } else { false }
    }
    collapse()
  }

  /// The login ends (logout, server switch): a new recipient with no key, so a send in flight to the old server
  /// neither carries nor removes lines recorded later, and a new dedup. The cap of ``cap`` lines stays per process.
  func retire() {
    recipient += 1
    armed = false
    reported.removeAll()
    login = nil
  }

  /// The running login's key changed in place (a version probe brought another iroh key, no new transport): a new
  /// recipient with the new key, and the old key's lines go as at a login to another server. The stream stays open,
  /// so the reporter stays armed.
  func rekey(_ key: ServerKey) {
    guard let login, login != key else { return }
    recipient += 1
    reported.removeAll()
    bind(key)
  }

  /// A pairing link is offered: lines recorded for its pairing wait under a new offer. The previous offer closes.
  func openOffer() -> Int {
    closeOffer()
    offerAttempted = false
    offers += 1
    offer = offers
    return offers
  }

  /// The offer a pairing attempt records under. The first attempt of a sheet takes the sheet's offer with the lines
  /// recorded before it; every later attempt opens a new offer, so a failed attempt's lines (possibly about another
  /// server answering the same link) never go with a later success.
  func attemptOffer() -> Int {
    if let open = offer, !offerAttempted {
      offerAttempted = true
      return open
    }
    let fresh = openOffer()
    offerAttempted = true
    return fresh
  }

  /// The offer ends without a pairing (cancel, another link): its lines go.
  func closeOffer() {
    guard let open = offer else { return }
    offer = nil
    entries.removeAll { $0.stamp == .offer(open) }
  }

  /// The pairing of offer `number` produced the key of `key`: the offer's lines belong to that server.
  func resolveOffer(_ number: Int, as key: ServerKey?) {
    guard offer == number else { return }
    guard let key else { return closeOffer() }
    offer = nil
    for index in entries.indices where entries[index].stamp == .offer(number) { entries[index].stamp = .server(key) }
    collapse()
  }

  /// Wysyła bufor partiami, aż się opróżni: linia dopisana w trakcie wysyłki jedzie następną
  /// partią, nie czeka na kolejną ramkę. Porażka zostawia linie w buforze na następną próbę.
  /// A batch holds the oldest lines up to ``batchBytes`` encoded, so no body passes the server's ceiling; a failed
  /// batch keeps itself and every later line in the queue.
  /// `send` goes to the server of the current ``recipient``: the caller reads its transport in the same step as this
  /// call starts. A batch holds only lines stamped with the recipient's key. After a ``retire()`` or ``rekey(_:)``
  /// during a send the loop ends and leaves the queue alone.
  func flush(_ send: @Sendable (ClientLogBody) async -> Bool, now: Date) async {
    guard let key = login else { return }
    let recipient = recipient
    guard flushing != recipient else { return }
    flushing = recipient
    defer { if flushing == recipient { flushing = nil } }
    let at = ISOTime.string(now)
    while armed, recipient == self.recipient {
      let queued = entries.filter { $0.stamp == .server(key) }
      guard !queued.isEmpty else { return }
      let (batch, events) = Self.firstBatch(queued, at: at)
      let body = ClientLogBody(events: events)
      guard await send(body), recipient == self.recipient else { return }
      let sent = Set(batch.map(\.id))
      entries.removeAll { sent.contains($0.id) }
      reported.formUnion(batch.map(\.line))
    }
  }

  /// The oldest queued entries whose events fit ``batchBytes`` encoded, at least one, with their events. A queue
  /// gathered without a connection can pass the server's ceiling, and a refused body would come back whole at every
  /// flush; split, each body goes and leaves the queue on success.
  private static func firstBatch(_ queued: [Entry], at: String) -> ([Entry], [ClientLogBody.Event]) {
    let encoder = JSONEncoder()
    var batch: [Entry] = []
    var events: [ClientLogBody.Event] = []
    var bytes = 0
    for entry in queued {
      let event = ClientLogBody.Event(
        at: at, level: entry.line.hasPrefix(problemPrefix) ? "error" : "debug",
        msg: String(entry.line.prefix(maxLineCharacters)))
      // The comma between events counts too.
      let cost = ((try? encoder.encode(event).count) ?? batchBytes) + 1
      if !batch.isEmpty, bytes + cost > batchBytes { break }
      batch.append(entry)
      events.append(event)
      bytes += cost
    }
    return (batch, events)
  }

  /// The stamp of a line recorded now for `owner`; `nil` = the line is dropped.
  private func stamp(_ owner: Owner) -> Stamp?? {
    switch owner {
    case .current:
      switch scope {
      case let .server(key)?: return stamp(.server(key))
      case let .offer(number)?: return stamp(.offer(number))
      case .current?, nil: break
      }
      if let login { return .server(login) }
      if let offer { return .offer(offer) }
      return bound ? nil : .some(nil)
    case let .server(key?):
      return .server(key)
    case .server(nil):
      return bound ? nil : .some(nil)
    case let .offer(number):
      return offer == number ? .offer(number) : nil
    }
  }

  /// The line is already queued for `stamp`, or the current recipient already got it.
  private func queued(_ line: String, _ stamp: Stamp?) -> Bool {
    if let login, stamp == .server(login), reported.contains(line) { return true }
    return entries.contains { $0.deduplicated && $0.stamp == stamp && $0.line == line }
  }

  private func append(_ line: String, _ stamp: Stamp?, deduplicated: Bool) {
    nextId += 1
    entries.append(Entry(id: nextId, line: line, stamp: stamp, deduplicated: deduplicated))
  }

  /// After a restamp: a deduplicated line stays once per stamp, and a line the current recipient already got goes.
  private func collapse() {
    var seen: Set<Seen> = []
    entries.removeAll { entry in
      guard entry.deduplicated else { return false }
      if let login, entry.stamp == .server(login), reported.contains(entry.line) { return true }
      return !seen.insert(Seen(stamp: entry.stamp, line: entry.line)).inserted
    }
  }

  private struct Seen: Hashable {
    let stamp: Stamp?
    let line: String
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

  /// Line of a stream cut at the parser's ceiling (``SSEParser/maxEventBytes``): which part passed it, no content.
  nonisolated static func line(for oversized: SSEParser.Oversized) -> String {
    let part =
      switch oversized {
      case .line: "line"
      case .event: "event"
      }
    return "kontrakt: sse \(part) over \(SSEParser.maxEventBytes / (1024 * 1024)) MiB"
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
  /// Lines of leaving the background: ``ContractReporter/foregroundTraceCap`` per hour.
  case foreground
  /// Live Activity content lines: ``ContractReporter/liveActivityContentTraceCap`` per hour.
  case liveActivityContent
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

/// The server a `client.log` line concerns, by the one rule of "another server" (`PairingLink.leadsToAnotherServer`):
/// with an iroh key the full EndpointId, otherwise the origin of the address. The same origin with another iroh key is
/// another server, and a relay change keeps the key.
public struct ServerKey: Sendable, Hashable, CustomStringConvertible {
  private let value: String

  /// `nil` = neither an iroh key nor an address with a host.
  public init?(serverURL: URL?, iroh: ServerIrohConfig?) {
    if let iroh {
      value = ServerIdentity.irohPrefix + iroh.endpointId
    } else if let origin = serverURL.flatMap(ServerOrigin.init) {
      value = origin.description
    } else {
      return nil
    }
  }

  public init?(_ credential: DeviceCredential?) {
    guard let credential else { return nil }
    self.init(serverURL: credential.serverURL, iroh: credential.iroh)
  }

  private init(value: String) {
    self.value = value
  }

  /// The one server of a store without a server connector (tests of areas, the demo integration): no pairing, switch
  /// or unpairing exists there.
  static let withoutConnector = ServerKey(value: "")

  public var description: String { value }
}
