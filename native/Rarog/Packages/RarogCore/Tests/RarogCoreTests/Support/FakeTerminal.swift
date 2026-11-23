import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

/// Atrapa gniazda terminala: zdarzenia pcha test, wysłane ramki są zapisane, wysyłkę da się wstrzymać
/// (wklejka w połowie, gdy gniazdo pada).
final class FakeTerminalSocket: TerminalSocketing, @unchecked Sendable {
  struct State {
    var sent: [TerminalClientFrame] = []
    var closedByClient = false
    var finished = false
    /// Wysyłka wstrzymana: kolejne `send` czekają, aż test je puści albo gniazdo padnie.
    var holdSends = false
    var held: [CheckedContinuation<Void, Never>] = []
  }

  let events: AsyncStream<TerminalSocketEvent>
  let id: String
  let fresh: Bool
  /// Gniazdo bez `POST` (`direct=1`).
  let direct: Bool
  let grid: TerminalGrid?
  private let continuation: AsyncStream<TerminalSocketEvent>.Continuation
  private let lock = Mutex(State())

  init(id: String, fresh: Bool, direct: Bool = false, grid: TerminalGrid?) {
    (events, continuation) = AsyncStream<TerminalSocketEvent>.makeStream()
    self.id = id
    self.fresh = fresh
    self.direct = direct
    self.grid = grid
  }

  var sent: [TerminalClientFrame] { lock.withLock { $0.sent } }
  var closedByClient: Bool { lock.withLock { $0.closedByClient } }

  func emit(_ event: TerminalSocketEvent) {
    lock.withLock { state in
      guard !state.finished else { return }
      continuation.yield(event)
    }
  }

  /// Serwer zamyka gniazdo (zerwanie sieci, `ws.close`).
  func drop() { finish() }

  func holdSends(_ hold: Bool) {
    let released = lock.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.holdSends = hold
      guard !hold else { return [] }
      defer { state.held = [] }
      return state.held
    }
    for waiter in released { waiter.resume() }
  }

  func send(_ frame: TerminalClientFrame) async -> Bool {
    let mustWait = lock.withLock { state -> Bool in
      guard !state.finished else { return false }
      state.sent.append(frame)
      return state.holdSends
    }
    if mustWait {
      await withCheckedContinuation { waiter in
        let resumeNow = lock.withLock { state -> Bool in
          guard state.holdSends, !state.finished else { return true }
          state.held.append(waiter)
          return false
        }
        if resumeNow { waiter.resume() }
      }
    }
    return lock.withLock { !$0.finished }
  }

  func close() {
    lock.withLock { $0.closedByClient = true }
    finish()
  }

  private func finish() {
    let released = lock.withLock { state -> [CheckedContinuation<Void, Never>]? in
      guard !state.finished else { return nil }
      state.finished = true
      continuation.yield(.closed)
      continuation.finish()
      defer { state.held = [] }
      return state.held
    }
    for waiter in released ?? [] { waiter.resume() }
  }
}

/// Atrapa transportu terminala: `POST`, lista, zamknięcie, historia, bramka wejścia i gniazda.
final class FakeTerminalBackend: TerminalTransporting, @unchecked Sendable {
  struct SocketCall: Equatable {
    let id: String
    let fresh: Bool
    let grid: TerminalGrid?
    /// Gniazdo bez `POST` (`direct=1`).
    var direct = false
  }

  struct State {
    var opens: [TerminalOpenBody] = []
    /// Kolejne odpowiedzi `POST` (pusta = sukces z ``defaultId`` i slotem z ciała).
    var openReplies: [Result<TerminalOpenResponse, TransportError>] = []
    var defaultId = "0123456789abcdef"
    /// `POST` czeka na ``releaseOpens()`` (stan w trakcie żądania).
    var holdOpens = false
    var heldOpens: [CheckedContinuation<Void, Never>] = []
    var sockets: [FakeTerminalSocket] = []
    var socketCalls: [SocketCall] = []
    var inputRefusal: String?
    var gateChecks = 0
    var list = TerminalList.empty
    var listCalls = 0
    var listResult: TransportError?
    var closes: [String] = []
    var closeResult: TransportError?
    var historyCalls: [(id: String, lines: Int)] = []
    /// Wstrzymane wywołania po rodzaju (`gate`, `list`, `history`) — test puszcza je ``release(_:)``.
    var holds: Set<String> = []
    var held: [String: [CheckedContinuation<Void, Never>]] = [:]
    /// Kolejne wyniki bramki (w kolejności wywołań); pusta = ``inputRefusal``.
    var gateResults: [String?] = []
  }

  let lock = Mutex(State())

  func set(_ change: (inout State) -> Void) { lock.withLock { change(&$0) } }
  func read<T>(_ value: (State) -> T) -> T { lock.withLock { value($0) } }

  var opens: [TerminalOpenBody] { read(\.opens) }
  var sockets: [FakeTerminalSocket] { read(\.sockets) }
  var socketCalls: [SocketCall] { read(\.socketCalls) }
  var lastSocket: FakeTerminalSocket? { read(\.sockets.last) }

  /// Czeka, jeśli rodzaj wywołania jest wstrzymany.
  private func pause(_ kind: String) async {
    guard read({ $0.holds.contains(kind) }) else { return }
    await withCheckedContinuation { waiter in
      let resumeNow = lock.withLock { state -> Bool in
        guard state.holds.contains(kind) else { return true }
        state.held[kind, default: []].append(waiter)
        return false
      }
      if resumeNow { waiter.resume() }
    }
  }

  func hold(_ kind: String) { set { $0.holds.insert(kind) } }

  func heldCount(_ kind: String) -> Int { read { $0.held[kind]?.count ?? 0 } }

  /// Puszcza wstrzymane wywołania rodzaju po kolei (od najstarszego) i zdejmuje wstrzymanie.
  func release(_ kind: String) {
    let waiters = lock.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.holds.remove(kind)
      defer { state.held[kind] = [] }
      return state.held[kind] ?? []
    }
    for waiter in waiters { waiter.resume() }
  }

  func releaseOpens() {
    let held = lock.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.holdOpens = false
      defer { state.heldOpens = [] }
      return state.heldOpens
    }
    for waiter in held { waiter.resume() }
  }

  // MARK: TerminalTransporting

  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    let hold = lock.withLock { state -> Bool in
      state.opens.append(body)
      return state.holdOpens
    }
    if hold {
      await withCheckedContinuation { waiter in
        let resumeNow = lock.withLock { state -> Bool in
          guard state.holdOpens else { return true }
          state.heldOpens.append(waiter)
          return false
        }
        if resumeNow { waiter.resume() }
      }
    }
    let reply = lock.withLock { state -> Result<TerminalOpenResponse, TransportError> in
      if !state.openReplies.isEmpty { return state.openReplies.removeFirst() }
      let slot: Int = switch body.slot {
      case let .number(value)?: value
      case .next?: 3
      case nil: body.role?.isPopup == true ? 0 : 1
      }
      return .success(.make(id: state.defaultId, slot: slot, role: body.role ?? .shell))
    }
    return try reply.get()
  }

  func terminals() async throws(TransportError) -> TerminalList {
    // Lista z chwili WYSŁANIA żądania (serwer odpowiada stanem sprzed późniejszych zmian).
    let result = lock.withLock { state -> Result<TerminalList, TransportError> in
      state.listCalls += 1
      if let failure = state.listResult { return .failure(failure) }
      return .success(state.list)
    }
    await pause("list")
    return try result.get()
  }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    lock.withLock { $0.historyCalls.append((id, lines)) }
    await pause("history")
    do {
      return try JSONDecoder().decode(TerminalHistory.self, from: Data(#"{"text":"$ ls\n","truncated":false}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa historii")
    }
  }

  func closeTerminal(id: String) async throws(TransportError) {
    let failure = lock.withLock { state -> TransportError? in
      state.closes.append(id)
      return state.closeResult
    }
    if let failure { throw failure }
  }

  func checkTerminalInput() async throws(MutationRefusal) {
    let refusal = lock.withLock { state -> String? in
      state.gateChecks += 1
      return state.gateResults.isEmpty ? state.inputRefusal : state.gateResults.removeFirst()
    }
    await pause("gate")
    if let refusal { throw MutationRefusal(gate: .compatibility, message: refusal) }
  }

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    let socket = FakeTerminalSocket(id: id, fresh: fresh, direct: direct, grid: grid)
    lock.withLock { state in
      state.sockets.append(socket)
      state.socketCalls.append(SocketCall(id: id, fresh: fresh, grid: grid, direct: direct))
    }
    return socket
  }
}

extension FakeTransport: TerminalTransporting {
  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    try await terminal.openTerminal(body)
  }

  func terminals() async throws(TransportError) -> TerminalList { try await terminal.terminals() }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    try await terminal.terminalHistory(id: id, lines: lines)
  }

  func closeTerminal(id: String) async throws(TransportError) { try await terminal.closeTerminal(id: id) }

  func checkTerminalInput() async throws(MutationRefusal) { try await terminal.checkTerminalInput() }

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    try terminal.terminalSocket(id: id, fresh: fresh, direct: direct, grid: grid)
  }
}

extension TerminalOpenResponse {
  static func make(id: String, slot: Int, role: TerminalRole) -> TerminalOpenResponse {
    let json = #"{"id":"\#(id)","slot":\#(slot),"role":"\#(role.rawValue)"}"#
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(TerminalOpenResponse.self, from: Data(json.utf8))
  }
}

extension TerminalList {
  static let empty: TerminalList = make([])

  static func make(_ entries: [(id: String, cwd: String, slot: Int, role: TerminalRole)]) -> TerminalList {
    let items = entries.map { entry in
      #"{"id":"\#(entry.id)","cwd":"\#(entry.cwd)","live":true,"slot":\#(entry.slot),"proc":"zsh","role":"\#(entry.role.rawValue)"}"#
    }
    // swiftlint:disable:next force_try
    return try! JSONDecoder().decode(TerminalList.self, from: Data(#"{"terminals":[\#(items.joined(separator: ","))]}"#.utf8))
  }
}
