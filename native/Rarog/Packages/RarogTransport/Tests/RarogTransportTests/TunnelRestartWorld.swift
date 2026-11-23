import Foundation
@testable import RarogTransport
import Testing

// Scripted world of the server restart for the machine tests (`TunnelMachineTests`, "Server restart with the app in
// the foreground").

private typealias F = MachineFixture

/// A scripted world around the machine for the server restart measured live: the runtime's results, the
/// endpoint lease (failure counter, `rebind`) and one consumer, the SSE supervisor (reconnect delays 0.5 s doubling to
/// 8 s, back to 0.5 s after a stream opens). HTTPS opens at once, because the runtime only lends the credential's
/// client, but every request on it, the probe included, fails: the HTTPS host is reachable only through Tailscale,
/// which is off in this world. The server closes its endpoint at `down` (the app's connection closes) and accepts iroh again at
/// `up`. An iroh attempt connects when the server is up (and, with `staleEndpointFails`, its endpoint was bound after
/// the restart); otherwise it hangs until the attempt budget elapses.
struct RestartWorld {
  struct Script {
    var routes = F.both
    var down = 10.0
    var up = 22.0
    /// An endpoint bound before the restart cannot reach the restarted server; a fresh one can.
    var staleEndpointFails = false
    /// Scene changes after the start in the foreground.
    var scenes: [(at: Double, scene: Machine.Scene)] = []
    var end = 300.0
  }

  private enum Happening {
    case machine(Machine.Event)
    case demand
    case serverDown
    case serverUp
    case scene(Machine.Scene)
  }

  let script: Script
  private(set) var machine: Machine
  private(set) var lines: [String] = []
  /// Lines the machine logged (`log` commands), in order.
  private(set) var machineLog: [String] = []
  /// Endpoint binds (each one a new relay connection) and iroh `connect` calls (what the server would count).
  private(set) var binds: [Double] = []
  private(set) var connects: [(at: Double, ok: Bool)] = []
  private(set) var readyAt: [(at: Double, gen: UInt64, choice: TransportChoice)] = []
  private var queue: [(at: Double, order: Int, what: Happening)] = []
  private var order = 0
  private var now = 0.0
  private var choices: [UInt64: TransportChoice] = [:]
  private var closed: Set<UInt64> = []
  private var endpointBoundAt: Double?
  private var leaseFailures = 0
  private var nextWaiter: UInt64 = 0
  private var waiting: Machine.WaiterID?
  private var stream: UInt64?
  private var irohLive: UInt64?
  private var paused = false
  private var delay = 0.5

  init(_ script: Script) {
    self.script = script
    machine = Machine(routes: script.routes)
    enqueue(0, .scene(.active))
    enqueue(script.down, .serverDown)
    enqueue(script.up, .serverUp)
    for change in script.scenes { enqueue(change.at, .scene(change.scene)) }
  }

  func firstReady(after seconds: Double) -> Double? {
    readyAt.first { $0.at > seconds }?.at
  }

  mutating func run() {
    while let next = queue.indices.min(by: { (queue[$0].at, queue[$0].order) < (queue[$1].at, queue[$1].order) }) {
      let item = queue.remove(at: next)
      guard item.at <= script.end else { break }
      now = item.at
      switch item.what {
      case let .machine(event): send(event)
      case .demand: demand()
      case .serverDown:
        note("SERVER: endpoint closed (restart)")
        if let gen = irohLive { send(.connectionLost(generation: gen)) }
      case .serverUp: note("SERVER: accepting iroh again (same EndpointId, new UDP ports)")
      case let .scene(scene):
        paused = scene == .background
        send(.scene(scene))
        if scene == .active { demand() }
      }
    }
  }

  /// The timeline for a failure message.
  var trace: String { lines.joined(separator: "\n") + "\nend: \(machine.state)" }

  // MARK: - Machine, runtime and lease

  private mutating func send(_ event: Machine.Event) {
    let commands = machine.handle(event, now: F.at(now))
    note("\(Self.describe(event)) → " + (commands.isEmpty ? "–" : commands.map(Self.describe).joined(separator: ", ")))
    for command in commands { apply(command) }
  }

  private mutating func apply(_ command: Machine.Command) {
    switch command {
    case let .open(gen, choice, _):
      choices[gen] = choice
      guard choice == .iroh else {
        enqueue(now + 0.01, .machine(.opened(generation: gen)))
        return
      }
      if endpointBoundAt == nil {
        endpointBoundAt = now
        binds.append(now)
        note("LEASE: bind endpoint #\(binds.count) (new relay connection)")
      }
      let serverUp = now < script.down || now >= script.up
      let stale = script.staleEndpointFails && now >= script.down && (endpointBoundAt ?? 0) < script.down
      let ok = serverUp && !stale
      connects.append((now, ok))
      note("IROH: connect on endpoint #\(binds.count): " + (ok ? "connects" : "hangs (\(serverUp ? "stale endpoint" : "server down"))"))
      if ok { enqueue(now + 0.3, .machine(.opened(generation: gen))) }
    case let .probe(gen):
      // A probe on HTTPS fails: the host is reachable only through Tailscale.
      let outcome: Machine.ProbeOutcome = choices[gen] == .https ? .transport : .http(status: 200)
      enqueue(now + 0.2, .machine(.probeFinished(generation: gen, outcome)))
    case let .close(gen), let .discard(gen):
      if irohLive == gen { irohLive = nil }
      if stream == gen {
        stream = nil
        retry()
      }
      guard choices[gen] != nil, closed.insert(gen).inserted else { return }
      enqueue(now + 0.1, .machine(.closed(generation: gen)))
    case let .rebindEndpoint(reason):
      rebind(reason)
    case let .reportIroh(success):
      guard !success else {
        leaseFailures = 0
        return
      }
      leaseFailures += 1
      guard leaseFailures >= EndpointLease.brokenAfterFailures, endpointBoundAt != nil else { return }
      note("LEASE: \(leaseFailures) consecutive iroh failures, endpoint broken")
      enqueue(now, .machine(.leaseChanged(.rebinding)))
      rebind(.broken)
    case let .release(ids, result):
      guard let waiter = waiting, ids.contains(waiter) else { return }
      waiting = nil
      switch result {
      case let .ready(gen):
        let choice = choices[gen] ?? .https
        readyAt.append((now, gen, choice))
        if choice == .iroh {
          irohLive = gen
          stream = gen
          delay = 0.5
        } else {
          note("CONSUMER: stream request over HTTPS fails (Tailscale off)")
          retry()
        }
      case .offline:
        retry()
      case .cancelled:
        break
      }
    case let .schedule(at):
      enqueue(Self.seconds(at), .machine(.tick))
    case let .log(line):
      machineLog.append(line)
    }
  }

  /// `EndpointLease.rebind`: a bound endpoint closes (the next `acquire` binds a fresh one), `ready` follows.
  private mutating func rebind(_ reason: RebindReason) {
    if reason != .policy { leaseFailures = 0 }
    if endpointBoundAt != nil {
      note("LEASE: rebind (\(reason)), endpoint #\(binds.count) closed")
      endpointBoundAt = nil
      enqueue(now + 0.2, .machine(.leaseChanged(.ready)))
    } else {
      enqueue(now, .machine(.leaseChanged(.ready)))
    }
  }

  // MARK: - Consumer (SSE supervisor)

  private mutating func demand() {
    guard !paused, waiting == nil, stream == nil else { return }
    nextWaiter += 1
    let waiter = Machine.WaiterID(nextWaiter)
    waiting = waiter
    send(.demand(waiter))
  }

  private mutating func retry() {
    enqueue(now + delay, .demand)
    delay = min(delay * 2, 8)
  }

  // MARK: - Trace

  private mutating func enqueue(_ at: Double, _ what: Happening) {
    order += 1
    queue.append((at, order, what))
  }

  private mutating func note(_ line: String) {
    lines.append(String(format: "%7.2f  ", now) + line)
  }

  private static func seconds(_ instant: Machine.Instant) -> Double {
    Double(F.origin.duration(to: instant) / .milliseconds(1)) / 1000
  }

  private static func describe(_ event: Machine.Event) -> String {
    switch event {
    case let .demand(waiter): "demand \(waiter)"
    case let .scene(scene): "scene \(scene)"
    case .tick: "tick"
    case let .opened(gen): "opened g\(gen)"
    case let .probeFinished(gen, outcome): "probeFinished g\(gen) \(outcome)"
    case let .connectionLost(gen): "connectionLost g\(gen)"
    case let .closed(gen): "closed g\(gen)"
    case let .leaseChanged(readiness): "leaseChanged \(readiness)"
    default: "\(event)"
    }
  }

  private static func describe(_ command: Machine.Command) -> String {
    switch command {
    case let .open(gen, choice, budget): "OPEN g\(gen) \(choice) \(budget.components.seconds) s"
    case let .probe(gen): "probe g\(gen)"
    case let .close(gen): "close g\(gen)"
    case let .discard(gen): "discard g\(gen)"
    case let .rebindEndpoint(reason): "LEASE rebind(\(reason))"
    case let .reportIroh(success): "LEASE reportIroh(\(success ? "success" : "failure"))"
    case let .release(ids, result): "release \(ids) \(result)"
    case let .schedule(at): "tick@" + String(format: "%.2f", seconds(at))
    case let .log(line): "log \"\(line)\""
    }
  }
}
