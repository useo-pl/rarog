import DeviceCheck
import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

// Bramki rejestru relaya iroh w celu apki (`RelayGate` z RarogTransport): dowód urządzenia DeviceCheck dla `register`
// i atrapa buildu Debug. Bez zależności od `RarogApp`, bo plik kompiluje też cel `RarogUIKitTests`
// (`membershipExceptions` w `project.pbxproj`). Wybór bramki i wartości buildu Debug: `RelayAccessSetup.swift`.
// Właściciel: klient rejestru relaya.

/// Token DeviceCheck tego urządzenia: w apce ``SystemDeviceCheck`` (`DCDevice.current`), w testach atrapa.
nonisolated protocol DeviceCheckDevice: Sendable {
  var isSupported: Bool { get }
  /// Nowy token przy każdym wywołaniu.
  func generateToken() async throws -> Data
}

/// `DCDevice.current` systemu. Na symulatorze `isSupported == false`.
nonisolated struct SystemDeviceCheck: DeviceCheckDevice {
  var isSupported: Bool { DCDevice.current.isSupported }

  func generateToken() async throws -> Data {
    try await DCDevice.current.generateToken()
  }
}

/// Bramka DeviceCheck: dowód dla `register` to token `DCDevice` (base64) ze środowiskiem z profilu podpisu.
/// Token jest jednorazowy dla Workera (drugi `register` tym samym tokenem pada), więc każdy `proof()` prosi system
/// o nowy, bez pamięci podręcznej. Bramka nie zna platformy: zwraca to, co mówi `DCDevice`, także na Macu.
nonisolated struct DeviceCheckGate: RelayGate {
  let kind: RelayAuthWire.Gate = .devicecheck
  /// Środowisko usługi Apple, w której token powstał (``RelayAccessSetup/environment()``).
  let environment: RelayAuthWire.Environment
  private let device: any DeviceCheckDevice

  init(environment: RelayAuthWire.Environment, device: any DeviceCheckDevice = SystemDeviceCheck()) {
    self.environment = environment
    self.device = device
  }

  var isSupported: Bool { device.isSupported }

  func proof() async throws(RelayGateFailure) -> RelayAuthWire.Proof {
    guard device.isSupported else { throw .unsupported }
    let token: Data
    do {
      token = try await device.generateToken()
    } catch {
      // Domena i kod błędu systemu, bez treści: linia trafia do `client.log`.
      let failure = error as NSError
      throw .failed("devicecheck \(failure.domain) \(failure.code)")
    }
    guard !token.isEmpty else { throw .failed("devicecheck empty token") }
    return RelayAuthWire.Proof(kind: kind, environment: environment, token: token.base64EncodedString())
  }

  /// Środowisko dowodu z odczytu profilu podpisu (``PushEnvironment``): to samo, które dostaje APNs.
  static func environment(_ reading: PushEnvironmentReading) -> RelayAuthWire.Environment {
    switch reading.environment {
    case .development: .development
    case .production: .production
    }
  }
}

#if DEBUG
/// Atrapa bramki buildu Debug (`RAROG_RELAY_FAKE_GATE=1`, ``RelayAccessSetup/gate(environment:variables:)``): zawsze
/// wspierana, każdy `proof()` daje nowy token base64 ze znacznikiem `RAROG_TEST_ONLY_RELAY_FAKE` i numerem próby.
/// Znacznik czyta sam `proof()`, więc napis zostaje w pliku wykonywalnym, póki zostaje atrapa (świadek protokołu
/// przeżywa optymalizację Release także bez wywołania `init`), a oględziny wydania poznają go `strings`.
nonisolated final class AppFakeRelayGate: RelayGate {
  static let marker = "RAROG_TEST_ONLY_RELAY_FAKE"

  let kind: RelayAuthWire.Gate = .devicecheck
  let environment: RelayAuthWire.Environment
  let isSupported = true
  private let attempts = Mutex(0)

  init(environment: RelayAuthWire.Environment) {
    self.environment = environment
  }

  func proof() async throws(RelayGateFailure) -> RelayAuthWire.Proof {
    let attempt = attempts.withLock { count in
      count += 1
      return count
    }
    let token = Data("\(Self.marker)-\(attempt)".utf8).base64EncodedString()
    return RelayAuthWire.Proof(kind: kind, environment: environment, token: token)
  }
}
#endif
