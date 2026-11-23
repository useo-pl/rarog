import Foundation
@testable import RarogTransport

// Wspólne narzędzia testów maszyny generacji: czas względny od jednej chwili, trasy, czekający i budowanie stanów
// wyjściowych zdarzeniami (nie przez wpisanie stanu), żeby test przechodził tą samą drogą co runtime.

typealias Machine = TunnelMachine

enum MachineFixture {
  static let origin = ContinuousClock.now

  static func at(_ seconds: Double) -> Machine.Instant {
    origin + .milliseconds(Int((seconds * 1000).rounded()))
  }

  static let both = Machine.Routes(hasHTTPS: true, hasIroh: true)
  static let irohOnly = Machine.Routes(hasHTTPS: false, hasIroh: true)
  static let httpsOnly = Machine.Routes(hasHTTPS: true, hasIroh: false)

  static func waiter(_ raw: UInt64) -> Machine.WaiterID { .init(raw) }
  static func work(_ raw: UInt64) -> Machine.WorkID { .init(raw) }
}

extension TunnelMachine {
  /// Zdarzenie w chwili `seconds` od początku testu; polecenia bez linii logu.
  mutating func send(_ event: Event, at seconds: Double = 0) -> [Command] {
    handle(event, now: MachineFixture.at(seconds)).filter {
      if case .log = $0 { return false }
      return true
    }
  }

  /// Polecenia razem z liniami logu.
  mutating func sendLogged(_ event: Event, at seconds: Double = 0) -> [Command] {
    handle(event, now: MachineFixture.at(seconds))
  }

  /// Maszyna na pierwszym planie (scena `active`).
  static func foreground(_ routes: Routes = MachineFixture.both, lease: LeaseReadiness = .ready,
                         policy: ReturnPolicy = TunnelMachine.returnPolicy) -> TunnelMachine {
    var machine = TunnelMachine(routes: routes, lease: lease, policy: policy)
    _ = machine.send(.scene(.active))
    return machine
  }

  /// `opening(1)` z czekającym `w1` w chwili 0.
  static func opening(_ routes: Routes = MachineFixture.both, lease: LeaseReadiness = .ready,
                      policy: ReturnPolicy = TunnelMachine.returnPolicy) -> TunnelMachine {
    var machine = foreground(routes, lease: lease, policy: policy)
    _ = machine.send(.demand(MachineFixture.waiter(1)))
    return machine
  }

  /// `probing(1)` generacji iroh.
  static func probing(_ routes: Routes = MachineFixture.both) -> TunnelMachine {
    var machine = opening(routes)
    _ = machine.send(.opened(generation: 1))
    return machine
  }

  /// `ready(1)`: iroh po sondzie albo HTTPS po otwarciu.
  static func ready(_ routes: Routes = MachineFixture.both, policy: ReturnPolicy = TunnelMachine.returnPolicy)
    -> TunnelMachine {
    var machine = opening(routes, policy: policy)
    _ = machine.send(.opened(generation: 1))
    if case .probing = machine.state {
      _ = machine.send(.probeFinished(generation: 1, .http(status: 200)))
    }
    return machine
  }

  /// Liczba poleceń `open` w liście.
  static func opens(_ commands: [Command]) -> Int {
    commands.filter {
      if case .open = $0 { return true }
      return false
    }.count
  }
}
