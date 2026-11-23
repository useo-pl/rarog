import Foundation

// The network path as the app compares it (`NetworkMonitor` in the app target feeds it from `NWPathMonitor`). A
// changed path that is satisfied closes the tunnel and starts a fresh generation (`TunnelRuntime.networkChanged`);
// a change of `isExpensive` alone only gets a log line.
// The client log line says what changed, so a drop the user did not cause can be traced to a VPN interface, a gateway
// or a moment without network. It carries interface types, interface names and the gateway count, never an address.

/// One report of the network path: status, interfaces, `isExpensive` and gateways.
public struct NetworkPathSnapshot: Sendable, Equatable {
  /// An interface as the line shows it: the type decides, the name (`en0`, `utun4`) only describes.
  public struct Interface: Sendable, Equatable {
    public let type: String
    public let name: String

    public init(type: String, name: String) {
      self.type = type
      self.name = name
    }
  }

  public let satisfied: Bool
  public let interfaces: [Interface]
  public let expensive: Bool
  public let gateways: [String]

  public init(satisfied: Bool, interfaces: [Interface], expensive: Bool, gateways: [String]) {
    self.satisfied = satisfied
    self.interfaces = interfaces
    self.expensive = expensive
    self.gateways = gateways
  }

  /// Equal when everything the log line shows is equal: an interface renamed with the same type is the same path.
  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.sameRoute(as: rhs) && lhs.expensive == rhs.expensive
  }

  /// Whether this report, after `previous`, reconnects: a satisfied path with another status, other interface types
  /// or other gateways. `isExpensive` alone does not count: on cellular it flips back and forth on the same interface,
  /// and the socket survives it, so a reconnect would only drop a working tunnel. The first report of the monitor is
  /// the starting state, not a change; a path without network waits for the next satisfied one.
  public func reconnects(after previous: NetworkPathSnapshot?) -> Bool {
    guard let previous, !previous.sameRoute(as: self) else { return false }
    return satisfied
  }

  private func sameRoute(as other: Self) -> Bool {
    satisfied == other.satisfied && interfaces.map(\.type) == other.interfaces.map(\.type) && gateways == other.gateways
  }

  /// The client log line of this report after `previous`, `nil` for the first report and for an equal path.
  public func changeLine(after previous: NetworkPathSnapshot?) -> String? {
    guard let previous, previous != self else { return nil }
    var changed: [String] = []
    if previous.satisfied != satisfied { changed.append("status") }
    if previous.interfaces.map(\.type) != interfaces.map(\.type) {
      changed.append("interfaces \(Self.list(previous.interfaces)) → \(Self.list(interfaces))")
    }
    if previous.expensive != expensive { changed.append("expensive \(previous.expensive) → \(expensive)") }
    if previous.gateways != gateways { changed.append("gateways \(previous.gateways.count) → \(gateways.count)") }
    let status = satisfied ? "satisfied" : "unsatisfied"
    let outcome = reconnects(after: previous) ? "reconnect" : "no reconnect"
    return "network: path \(status), changed \(changed.joined(separator: "; ")); now \(Self.list(interfaces)) → \(outcome)"
  }

  private static func list(_ interfaces: [Interface]) -> String {
    interfaces.isEmpty ? "none" : interfaces.map { "\($0.type)(\($0.name))" }.joined(separator: ",")
  }
}
