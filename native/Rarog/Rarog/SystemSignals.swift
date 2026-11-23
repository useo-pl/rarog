import Foundation
import MetricKit
import Network
import RarogCore
import RarogTransport

/// Network change (Wi-Fi ↔ LTE, the link back, another gateway of the same network) = a fresh connection, never trust
/// in the old socket. The comparison and the client log line live in `NetworkPathSnapshot`; every changed report,
/// also one without network, gets a line, and only a changed satisfied path reconnects.
@MainActor
final class NetworkMonitor {
  private let monitor = NWPathMonitor()
  private var last: NetworkPathSnapshot?
  private var onChange: (@MainActor () -> Void)?
  private var log: (@MainActor (String) -> Void)?

  func start(log: @escaping @MainActor (String) -> Void, onChange: @escaping @MainActor () -> Void) {
    guard self.onChange == nil else { return }
    self.onChange = onChange
    self.log = log
    monitor.pathUpdateHandler = { [weak self] path in
      let snapshot = NetworkPathSnapshot(
        satisfied: path.status == .satisfied,
        interfaces: path.availableInterfaces.map { .init(type: "\($0.type)", name: $0.name) },
        expensive: path.isExpensive, gateways: path.gateways.map { "\($0)" })
      Task { @MainActor in self?.handle(snapshot) }
    }
    monitor.start(queue: DispatchQueue(label: "pl.useo.rarog.network"))
  }

  private func handle(_ snapshot: NetworkPathSnapshot) {
    defer { last = snapshot }
    if let line = snapshot.changeLine(after: last) { log?(line) }
    if snapshot.reconnects(after: last) { onChange?() }
  }
}

/// Raport awarii z poprzedniego uruchomienia (MetricKit) do `client.log` przez rdzeń:
/// sygnał, typ wyjątku i wersja apki — nigdy treść rozmowy.
final class CrashDiagnostics: NSObject, MXMetricManagerSubscriber, Sendable {
  private let store: RarogStore

  init(store: RarogStore) {
    self.store = store
  }

  nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
    var lines: [String] = []
    for payload in payloads {
      for crash in payload.crashDiagnostics ?? [] {
        let meta = crash.metaData
        let signal = crash.signal.map { "sygnał \($0)" } ?? "sygnał ?"
        let exception = crash.exceptionType.map { "wyjątek \($0)" } ?? "wyjątek ?"
        lines.append("awaria poprzedniego uruchomienia: build \(meta.applicationBuildVersion), \(signal), \(exception)")
      }
      for hang in payload.hangDiagnostics ?? [] {
        lines.append("zawieszenie interfejsu: build \(hang.metaData.applicationBuildVersion), \(hang.hangDuration)")
      }
    }
    guard !lines.isEmpty else { return }
    let store = store
    Task { @MainActor in
      for line in lines { store.reportUnhandled(line) }
    }
  }
}
