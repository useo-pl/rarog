import Foundation
import RarogContract
import RarogCore
import RarogTransport

// Wartości klienta rejestru relaya iroh (`RelayAccess`) w celu apki: bramka, mapa relay → rejestr i okres odnowienia.
// W Release zawsze produkcyjne (``DeviceCheckGate``, `RelayAuthWire.registries`, 6 h); build Debug czyta zmienne
// środowiska procesu testów (opis przy ``RelayAccessSetup/debugGate(environment:variables:)``). Bez zależności od
// `RarogApp`, bo plik kompiluje też cel `RarogUIKitTests` (`membershipExceptions` w `project.pbxproj`).
// Właściciel: klient rejestru relaya.

/// Bramka, mapa rejestrów i okres odnowienia dla `RelayAccess`.
nonisolated enum RelayAccessSetup {
  /// Środowisko dowodu bramki z profilu podpisu tego procesu (odczyt ``PushEnvironment``).
  @MainActor
  static func environment() -> RelayAuthWire.Environment {
    DeviceCheckGate.environment(PushEnvironment.current())
  }

  /// Bramka dowodu urządzenia: ``DeviceCheckGate``; w Debug atrapa na żądanie zmiennej środowiska.
  static func gate(
    environment: RelayAuthWire.Environment, variables: [String: String] = ProcessInfo.processInfo.environment
  ) -> any RelayGate {
    #if DEBUG
    if let fake = debugGate(environment: environment, variables: variables) { return fake }
    #endif
    return DeviceCheckGate(environment: environment)
  }

  /// Mapa relay → rejestr: `RelayAuthWire.registries`; w Debug zastępuje ją zmienna środowiska.
  /// - Parameter log: linia do `client.log` z prefiksem `relay-access:`, gdy wartość zmiennej odrzucono.
  static func registries(
    variables: [String: String] = ProcessInfo.processInfo.environment, log: (String) -> Void
  ) -> [String: URL] {
    #if DEBUG
    if let map = debugRegistries(variables: variables, log: log) { return map }
    #endif
    return RelayAuthWire.registries
  }

  /// Okres odnowienia: `RelayAccessMachine.defaultRenewEvery`; w Debug zastępuje go zmienna środowiska.
  /// - Parameter log: linia do `client.log` z prefiksem `relay-access:`, gdy wartość zmiennej odrzucono.
  static func renewEvery(
    variables: [String: String] = ProcessInfo.processInfo.environment, log: (String) -> Void
  ) -> Duration {
    #if DEBUG
    if let period = debugRenewEvery(variables: variables, log: log) { return period }
    #endif
    return RelayAccessMachine.defaultRenewEvery
  }
}

#if DEBUG
// Tylko build Debug (testy przepływu na symulatorze, `SIMCTL_CHILD_<nazwa>`):
// - `RAROG_RELAY_FAKE_GATE=1` — ``AppFakeRelayGate`` zamiast DeviceCheck (symulator DeviceCheck nie wspiera);
// - `RAROG_RELAY_AUTH_MAP=<relay>=<rejestr>` — jedna para zamiast mapy produkcyjnej: relay jak `r=` linku parowania
//   (`https`), rejestr jak adres serwera (`https`, `http` tylko na loopbacku), bez ścieżki; zła wartość = mapa
//   produkcyjna z linią logu;
// - `RAROG_RELAY_RENEW_EVERY=<s>` — okres odnowienia w sekundach (liczba całkowita > 0); zła wartość = 6 h z linią
//   logu.
// Strażnik `server/test/relay-debug-guard.test.ts` pilnuje, że te nazwy i znacznik atrapy stoją w źródłach apki
// wyłącznie w blokach `#if DEBUG`.
nonisolated extension RelayAccessSetup {
  static let fakeGateVariable = "RAROG_RELAY_FAKE_GATE"
  static let authMapVariable = "RAROG_RELAY_AUTH_MAP"
  static let renewEveryVariable = "RAROG_RELAY_RENEW_EVERY"

  static func debugGate(environment: RelayAuthWire.Environment, variables: [String: String]) -> (any RelayGate)? {
    variables[fakeGateVariable] == "1" ? AppFakeRelayGate(environment: environment) : nil
  }

  static func debugRegistries(variables: [String: String], log: (String) -> Void) -> [String: URL]? {
    guard let raw = variables[authMapVariable] else { return nil }
    guard let separator = raw.firstIndex(of: "="),
      let relay = PairingLinkWire.relayURL(String(raw[..<separator])),
      let origin = PairingLinkWire.serverURL(String(raw[raw.index(after: separator)...])),
      let registry = URL(string: origin)
    else {
      log("relay-access: \(authMapVariable) ignored (expected <relay>=<registry origin>), production map in use")
      return nil
    }
    return [relay: registry]
  }

  static func debugRenewEvery(variables: [String: String], log: (String) -> Void) -> Duration? {
    guard let raw = variables[renewEveryVariable] else { return nil }
    guard let seconds = Int64(raw), seconds > 0 else {
      log("relay-access: \(renewEveryVariable) ignored (expected whole seconds > 0), default period in use")
      return nil
    }
    return .seconds(seconds)
  }
}
#endif
