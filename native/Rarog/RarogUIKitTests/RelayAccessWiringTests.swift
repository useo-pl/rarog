import Foundation
import RarogContract
import RarogCore
import RarogTransport
import RarogTransportTesting
import Synchronization
import XCTest

// The iroh relay registry client in the app (`RelayAccessWiring.swift`, triggers in `TunnelCoordinator.swift`): the
// coordinator hands triggers and the last server list to the client without waiting, the connector
// reaches it for pairing and removal, its statuses reach the store in order, and the app's EndpointId goes to
// `client.log` once per process. Both app files compile into this target through `membershipExceptions`. The client
// is a recorder (`RecordingRelayAccess`), except where a test needs the real actor with the package fakes.
// Owner: relay registry client.

@MainActor
final class RelayAccessWiringTests: XCTestCase {
  static let appId = String(repeating: "c3", count: 32)
  static let k = TunnelCoordinator.target(TunnelCoordinatorTests.iroh)
  static let iroh2 = ServerIrohConfig(
    endpointId: String(repeating: "cd", count: 32), relay: URL(string: "https://relay.example/")!)
  static let k2 = TunnelCoordinator.target(iroh2)

  // MARK: - Triggers from the coordinator

  func testStartWithIrohPairSetsServersThenStart() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    _ = coordinator.transport(.device(Self.credential(iroh: TunnelCoordinatorTests.iroh)), MutationRules())
    let statuses = RelayAccessWiring.start(relay) { _ in }
    defer { statuses.cancel() }
    try await relay.expect([.servers([Self.k]), .trigger(.start)])
  }

  func testCredentialWithoutIrohAndNoServerSetEmptyList() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    _ = coordinator.transport(.device(Self.credential(iroh: nil)), MutationRules())
    try await relay.expect([.servers([])])
    _ = coordinator.transport(.none, MutationRules())
    try await relay.expect([.servers([]), .servers([])])
  }

  func testCredentialChangedWithNewPairSetsNewList() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    _ = coordinator.transport(.device(Self.credential(iroh: TunnelCoordinatorTests.iroh)), MutationRules())
    coordinator.credentialChanged(.device(Self.credential(iroh: Self.iroh2)))
    try await relay.expect([.servers([Self.k]), .servers([Self.k2])])
    // Another device's credential is not the current one: no list.
    coordinator.credentialChanged(.device(Self.credential(iroh: TunnelCoordinatorTests.iroh, deviceId: "other")))
    try await relay.expectNothingMore(after: [.servers([Self.k]), .servers([Self.k2])])
  }

  func testEnteringActiveSceneTriggersForeground() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    coordinator.scene(.active)
    try await relay.expect([.trigger(.foreground)])
    coordinator.scene(.active)
    coordinator.scene(.background)
    try await relay.expectNothingMore(after: [.trigger(.foreground)])
    coordinator.scene(.inactive)
    coordinator.scene(.active)
    try await relay.expect([.trigger(.foreground), .trigger(.foreground)])
  }

  func testProtectedDataTriggersIdentityAvailable() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    coordinator.protectedDataBecameAvailable()
    try await relay.expect([.trigger(.identityAvailable)])
  }

  func testFailedIrohAttemptInLeaseTriggersTunnelFailed() async throws {
    let relay = RecordingRelayAccess()
    let coordinator = TunnelCoordinatorTests.coordinator(relayAccess: relay)
    coordinator.scene(.active)
    let credential = Self.credential(iroh: TunnelCoordinatorTests.iroh)
    _ = coordinator.transport(.device(credential), MutationRules())
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    // The test transport refuses every bind, so the first iroh attempt fails and the machine reports it to the lease.
    _ = await runtime.generation()
    try await TunnelCoordinatorTests.eventually("trigger after the iroh failure") {
      relay.calls.contains(.trigger(.tunnelFailed))
    }
    XCTAssertEqual(relay.calls.filter { $0 == .trigger(.tunnelFailed) }, [.trigger(.tunnelFailed)])
    coordinator.release(.device(credential))
  }

  // MARK: - Connector

  func testRelayPrepareAsksClientWithPairingBudget() async {
    let relay = RecordingRelayAccess(prepareResult: .fresh)
    let connector = RelayAccessWiring.connect(Self.connector(), to: relay)
    let iroh = await connector.relayPrepare(.iroh(TunnelCoordinatorTests.iroh))
    let both = await connector.relayPrepare(.both(TunnelCoordinatorTests.server, Self.iroh2))
    XCTAssertEqual(iroh, .fresh)
    XCTAssertEqual(both, .fresh)
    let https = await connector.relayPrepare(.https(TunnelCoordinatorTests.server))
    XCTAssertEqual(https, .skipped, "an address alone has no relay")
    XCTAssertEqual(relay.calls, [.prepare(Self.k, .seconds(8)), .prepare(Self.k2, .seconds(8))])
    XCTAssertEqual(RelayAccess.pairingBudget, .seconds(8))
  }

  func testRelayForgetCallsForgetAndReturnsItsStatus() async {
    let removed = RelayAccessStatus.optedOut(appId: Self.appId, removal: .confirmed)
    let relay = RecordingRelayAccess(forgetStatus: removed)
    let connector = RelayAccessWiring.connect(Self.connector(), to: relay)
    let status = await connector.relayForget()
    XCTAssertEqual(status, removed)
    XCTAssertEqual(relay.calls, [.forget])
  }

  // MARK: - Statuses

  func testStatusesReachStoreInOrder() async throws {
    let relay = RecordingRelayAccess()
    let store = RarogStore(
      transport: UIKitTransport(), rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    let seen = StatusRecorder()
    let task = RelayAccessWiring.start(relay) { status in
      seen.append(status)
      store.relayAccessChanged(status)
    }
    defer { task.cancel() }
    let until = Date(timeIntervalSince1970: 1_800_000_000)
    let sequence: [RelayAccessStatus] = [
      .inactive, .working, .registered(appId: Self.appId, until: until),
      .problem(.unreachable, appId: Self.appId, retryAt: until),
    ]
    for status in sequence { relay.publish(status) }
    try await TunnelCoordinatorTests.eventually("every status delivered") { seen.all.count == sequence.count }
    XCTAssertEqual(seen.all, sequence)
    XCTAssertEqual(store.state.relayAccess, sequence.last)
  }

  // MARK: - The app's EndpointId in `client.log`

  func testOneAppLinePerProcessWithFullEndpointId() async {
    let lines = LineRecorder()
    let appId = Self.appId
    let keychain = MemoryIrohIdentityKeychain(.init(locked: true))
    let identity = RelayAccessIdentity(
      identities: IrohIdentityStore(keychain: keychain), makeSigner: { _ in FakeRelaySigner(endpointId: appId) },
      log: { lines.append($0) })
    let relay: any RelayAccessControl = RelayAccess(
      signer: { await identity.signer() }, gate: FakeRelayGate(), transport: FakeRelayAuthTransport(),
      store: FakeRelayAccessStore(), log: { lines.append($0) })
    // Before the first unlock there is no identity: no line, and pairing goes on as without the registry.
    let locked = await relay.prepareForPairing(Self.k, budget: .seconds(8))
    XCTAssertEqual(locked, .skipped)
    XCTAssertEqual(lines.all.filter { $0.hasPrefix("relay-access: app") }, [])
    keychain.update { $0.locked = false }
    // A relay outside the map asks the registry nothing, but the identity is read for each call.
    for _ in 0 ..< 3 {
      let result = await relay.prepareForPairing(Self.k, budget: .seconds(8))
      XCTAssertEqual(result, .skipped)
    }
    _ = await identity.signer()
    XCTAssertEqual(lines.all.filter { $0.hasPrefix("relay-access: app") }, ["relay-access: app \(Self.appId)"])
  }

  // MARK: - Guard: the coordinator never waits for the registry client

  func testCoordinatorUsesRegistryClientOnlyInsideTasks() throws {
    let source = try String(contentsOf: Self.appSources.appending(path: "TunnelCoordinator.swift"), encoding: .utf8)
    let scan = RegistryUseScan(source)
    XCTAssertGreaterThanOrEqual(scan.uses, 3, "the coordinator passes setServers and triggers to the client")
    XCTAssertEqual(scan.outsideTasks, [], "lines of TunnelCoordinator.swift that reach the client outside a Task")
  }

  func testGuardCatchesUseOutsideTask() {
    let cases: [(source: String, outside: [Int])] = [
      ("func f() {\n  await relayAccess.trigger(.start)\n}", [2]),
      ("func f() {\n  Task {}\n  await relayAccess?.forget()\n}", [3]),
      ("func f() {\n  _ = RelayAccess.pairingBudget\n}", [2]),
      ("func f() {\n  Task.immediate { await relayAccess.trigger(.start) }\n}", []),
      ("func f() {\n  Task { @MainActor in\n    if true { await relayAccess?.setServers([]) }\n  }\n}", []),
      ("var c = x\nc.relayPrepare = { t in\n  await relayAccess.prepareForPairing(t, budget: .seconds(8))\n}", []),
      ("// await relayAccess.trigger(.start)\nlet s = \"relayAccess.trigger { \"\n/* relayAccess.forget() */", []),
      ("guard let relayAccess else { return }\nself.relayAccess = relayAccess\nlet r = { [relayAccess] in }", []),
    ]
    for (source, outside) in cases {
      XCTAssertEqual(RegistryUseScan(source).outsideTasks, outside, source)
    }
  }

  // MARK: - No DeviceCheck probe in the app

  func testDiagDeviceCheckLinkIsNotAnAppRoute() throws {
    XCTAssertNil(PushRouting.link(url: try XCTUnwrap(URL(string: "rarog://diag/devicecheck"))), "unknown link: the app")
    for name in ["DeviceCheckProbe.swift", "DeviceCheckProbeRoute.swift"] {
      XCTAssertFalse(FileManager.default.fileExists(atPath: Self.appSources.appending(path: name).path), name)
    }
    let app = try String(contentsOf: Self.appSources.appending(path: "RarogApp.swift"), encoding: .utf8)
    XCTAssertFalse(app.contains("devicecheck") || app.contains("DeviceCheck"), "RarogApp.swift without the probe route")
  }

  // MARK: - Helpers

  /// The app target's sources (`native/Rarog/Rarog/`), read from the repo.
  static let appSources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "Rarog", directoryHint: .isDirectory)

  static func credential(iroh: ServerIrohConfig?, deviceId: String = "d1") -> DeviceCredential {
    DeviceCredential(
      deviceId: deviceId, secret: "secret", serverURL: iroh == nil ? TunnelCoordinatorTests.server : nil,
      serverId: "srv", serverName: "mac-demo", label: "test·Rarog", kid: "k1",
      pairedAt: Date(timeIntervalSince1970: 1_792_000_000), iroh: iroh)
  }

  static func connector() -> ServerConnector {
    ServerConnector(
      keychain: MemoryKeychain(), label: "test·Rarog", build: 1, transport: { _, _ in UIKitTransport() },
      pairing: { _ in UIKitTransport() })
  }
}

/// The registry client as a recorder: calls in order, statuses fed by the test. An actor like `RelayAccess`, so calls
/// sent from tasks in a row reach it in that order.
actor RecordingRelayAccess: RelayAccessControl {
  enum Call: Equatable, Sendable {
    case servers([TunnelTarget])
    case trigger(RelayAccessTrigger)
    case prepare(TunnelTarget, Duration)
    case forget
  }

  nonisolated let statuses: AsyncStream<RelayAccessStatus>
  private nonisolated let feed: AsyncStream<RelayAccessStatus>.Continuation
  private nonisolated let recorded = Mutex<[Call]>([])
  private let prepareResult: RelayPrepareResult
  private let forgetStatus: RelayAccessStatus

  init(prepareResult: RelayPrepareResult = .ready(sponsoredAt: nil), forgetStatus: RelayAccessStatus = .inactive) {
    (statuses, feed) = AsyncStream.makeStream()
    self.prepareResult = prepareResult
    self.forgetStatus = forgetStatus
  }

  nonisolated var calls: [Call] { recorded.withLock { $0 } }

  nonisolated func publish(_ status: RelayAccessStatus) {
    feed.yield(status)
  }

  func setServers(_ servers: [TunnelTarget]) async { record(.servers(servers)) }
  func trigger(_ reason: RelayAccessTrigger) async { record(.trigger(reason)) }

  func prepareForPairing(_ server: TunnelTarget, budget: Duration) async -> RelayPrepareResult {
    record(.prepare(server, budget))
    return prepareResult
  }

  func forget() async -> RelayAccessStatus {
    record(.forget)
    return forgetStatus
  }

  private func record(_ call: Call) {
    recorded.withLock { $0.append(call) }
  }
}

@MainActor
extension RecordingRelayAccess {
  /// Calls reach the recorder through tasks: waits until they equal `expected`.
  func expect(_ expected: [Call], file: StaticString = #filePath, line: UInt = #line) async throws {
    try await TunnelCoordinatorTests.eventually("calls \(expected)") { calls == expected }
    XCTAssertEqual(calls, expected, file: file, line: line)
  }

  /// A moment for tasks in flight, then the calls are still `expected`.
  func expectNothingMore(after expected: [Call], file: StaticString = #filePath, line: UInt = #line) async throws {
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(calls, expected, file: file, line: line)
  }
}

/// Statuses in the order they reached the store.
final class StatusRecorder: Sendable {
  private let statuses = Mutex<[RelayAccessStatus]>([])

  var all: [RelayAccessStatus] { statuses.withLock { $0 } }

  func append(_ status: RelayAccessStatus) { statuses.withLock { $0.append(status) } }
}

/// Text guard over a Swift source that nothing waits for the registry client: every use of the client
/// (`relayAccess.` or `relayAccess?.`, and the type `RelayAccess.`) stands inside a `Task {}` or `Task.immediate {}`
/// closure, or in a closure assigned to the connector fields `relayPrepare` and `relayForget`. Comments and string
/// literals do not count.
struct RegistryUseScan {
  private(set) var uses = 0
  /// Line numbers (from 1) of uses outside such a closure.
  private(set) var outsideTasks: [Int] = []

  init(_ source: String) {
    var frames: [Bool] = []  // one per open brace: does it open a closure where a use is allowed?
    let lines = Self.codeOnly(source).split(separator: "\n", omittingEmptySubsequences: false)
    for (index, text) in lines.enumerated() {
      let line = String(text)
      let starts = Set(Self.uses(in: line))
      var cursor = line.startIndex
      while cursor < line.endIndex {
        if starts.contains(cursor) {
          uses += 1
          if !frames.contains(true) { outsideTasks.append(index + 1) }
        }
        switch line[cursor] {
        case "{": frames.append(Self.opensAllowedClosure(String(line[..<cursor])))
        case "}": _ = frames.popLast()
        default: break
        }
        cursor = line.index(after: cursor)
      }
    }
  }

  /// Start indices of `relayAccess.`, `relayAccess?.` and `RelayAccess.` as whole identifiers.
  private static func uses(in line: String) -> [String.Index] {
    line.matches(of: /(^|[^A-Za-z0-9_])([rR]elayAccess\??\.)/).map(\.output.2.startIndex)
  }

  /// The text before `{` ends with `Task`, `Task.immediate` (optionally with arguments), or assigns to or labels
  /// `relayPrepare`/`relayForget`.
  private static func opensAllowedClosure(_ before: String) -> Bool {
    let trimmed = before.trimmingCharacters(in: .whitespaces)
    if trimmed.contains(/(^|[^A-Za-z0-9_.])Task(\.immediate)?(\([^)]*\))?$/) { return true }
    return trimmed.contains(/(relayPrepare|relayForget)\s*[=:]$/)
  }

  /// The source with comments and string literals blanked (newlines kept, so line numbers stay).
  static func codeOnly(_ source: String) -> String {
    var out = ""
    var chars = Array(source)
    chars.append("\n")
    var index = 0
    var blockDepth = 0
    while index < chars.count - 1 {
      let char = chars[index]
      let next = chars[index + 1]
      if blockDepth > 0 {
        if char == "/" && next == "*" { blockDepth += 1; index += 2; out += "  "; continue }
        if char == "*" && next == "/" { blockDepth -= 1; index += 2; out += "  "; continue }
        out.append(char == "\n" ? "\n" : " ")
        index += 1
      } else if char == "/" && next == "/" {
        while index < chars.count - 1 && chars[index] != "\n" { out.append(" "); index += 1 }
      } else if char == "/" && next == "*" {
        blockDepth = 1
        index += 2
        out += "  "
      } else if char == "\"" {
        let multiline = index + 2 < chars.count && chars[index + 1] == "\"" && chars[index + 2] == "\""
        let quote = multiline ? 3 : 1
        out += String(repeating: " ", count: quote)
        index += quote
        while index < chars.count - 1 {
          if chars[index] == "\\" {
            out += "  "
            index += 2
            continue
          }
          if multiline, index + 2 < chars.count,
            chars[index] == "\"", chars[index + 1] == "\"", chars[index + 2] == "\""
          {
            out += "   "
            index += 3
            break
          }
          if !multiline && (chars[index] == "\"" || chars[index] == "\n") {
            out.append(chars[index] == "\n" ? "\n" : " ")
            index += 1
            break
          }
          out.append(chars[index] == "\n" ? "\n" : " ")
          index += 1
        }
      } else {
        out.append(char)
        index += 1
      }
    }
    return out
  }
}
