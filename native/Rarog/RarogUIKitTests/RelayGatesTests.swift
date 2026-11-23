import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization
import XCTest

// Bramki rejestru relaya w celu apki (`RelayGates.swift`) i wartości klienta rejestru (`RelayAccessSetup.swift`).
// Oba pliki wchodzą do tego celu przez `membershipExceptions` (bez zależności od `RarogApp`), razem
// z `PushEnvironment.swift`, z którego bramka bierze środowisko. Testy chodzą na symulatorze w buildzie Debug, więc
// gałęzie zmiennych środowiska są tu widoczne; Release ich nie ma (strażnik `relay-debug-guard.test.ts`).
// Właściciel: klient rejestru relaya.

@MainActor
final class RelayGatesTests: XCTestCase {
  // MARK: - DeviceCheckGate

  func testSimulatorHasNoDeviceCheckAndProofIsUnsupported() async {
    XCTAssertFalse(SystemDeviceCheck().isSupported, "DCDevice na symulatorze")
    let gate = DeviceCheckGate(environment: .development)
    XCTAssertEqual(gate.kind, .devicecheck)
    XCTAssertFalse(gate.isSupported)
    do throws(RelayGateFailure) {
      _ = try await gate.proof()
      XCTFail("proof() bez DeviceCheck dał dowód")
    } catch {
      XCTAssertEqual(error, .unsupported)
    }
  }

  func testUnsupportedDeviceDoesNotAskForToken() async {
    let device = StubDeviceCheck(isSupported: false)
    let gate = DeviceCheckGate(environment: .production, device: device)
    do throws(RelayGateFailure) {
      _ = try await gate.proof()
      XCTFail("proof() bez DeviceCheck dał dowód")
    } catch {
      XCTAssertEqual(error, .unsupported)
    }
    XCTAssertEqual(device.generated, 0)
  }

  func testProofEnvironmentComesFromProfileReading() async throws {
    let cases: [(String, Data?, Bool, RelayAuthWire.Environment)] = [
      ("profil development", Self.profile(aps: "development"), false, .development),
      ("profil production", Self.profile(aps: "production"), false, .production),
      ("urządzenie bez profilu (TestFlight, App Store)", nil, false, .production),
      ("symulator bez profilu", nil, true, .development),
    ]
    for (name, profile, isSimulator, expected) in cases {
      let reading = ProvisioningProfile.pushEnvironment(profile: profile, isSimulator: isSimulator)
      let environment = DeviceCheckGate.environment(reading)
      XCTAssertEqual(environment, expected, name)
      let gate = DeviceCheckGate(environment: environment, device: StubDeviceCheck())
      let proof = try await gate.proof()
      XCTAssertEqual(proof.environment, expected, name)
      XCTAssertEqual(proof.kind, .devicecheck, name)
      XCTAssertEqual(proof.token, Data("token-1".utf8).base64EncodedString(), name)
    }
    // Proces testów: symulator bez `embedded.mobileprovision`.
    XCTAssertEqual(RelayAccessSetup.environment(), .development)
  }

  func testEveryProofAsksTheSystemForAFreshToken() async throws {
    let device = StubDeviceCheck()
    let gate = DeviceCheckGate(environment: .production, device: device)
    let first = try await gate.proof()
    let second = try await gate.proof()
    XCTAssertEqual(device.generated, 2, "bez pamięci podręcznej tokenu")
    XCTAssertNotEqual(first.token, second.token)
    XCTAssertEqual(Data(base64Encoded: second.token), Data("token-2".utf8))
  }

  func testTokenFailureIsGateFailureWithoutContent() async {
    let failing = StubDeviceCheck(failure: NSError(domain: "com.apple.devicecheck.error", code: 0))
    let empty = StubDeviceCheck(empty: true)
    let expected: [(StubDeviceCheck, RelayGateFailure)] = [
      (failing, .failed("devicecheck com.apple.devicecheck.error 0")),
      (empty, .failed("devicecheck empty token")),
    ]
    for (device, failure) in expected {
      do throws(RelayGateFailure) {
        _ = try await DeviceCheckGate(environment: .production, device: device).proof()
        XCTFail("porażka tokenu dała dowód")
      } catch {
        XCTAssertEqual(error, failure)
      }
    }
  }

  // MARK: - RelayAccessSetup (build Debug)

  func testFakeGateOnlyWithVariable() async throws {
    let fake = RelayAccessSetup.gate(environment: .production, variables: ["RAROG_RELAY_FAKE_GATE": "1"])
    XCTAssertTrue(fake is AppFakeRelayGate)
    XCTAssertTrue(fake.isSupported)
    XCTAssertEqual(fake.kind, .devicecheck)
    let first = try await fake.proof()
    let second = try await fake.proof()
    XCTAssertEqual(first.kind, .devicecheck)
    XCTAssertEqual(first.environment, .production)
    for (proof, attempt) in [(first, 1), (second, 2)] {
      let decoded = try XCTUnwrap(Data(base64Encoded: proof.token), "token atrapy w base64")
      XCTAssertEqual(String(decoding: decoded, as: UTF8.self), "RAROG_TEST_ONLY_RELAY_FAKE-\(attempt)")
    }
    for variables in [[:], ["RAROG_RELAY_FAKE_GATE": "0"], ["RAROG_RELAY_FAKE_GATE": "yes"]] {
      let gate = RelayAccessSetup.gate(environment: .development, variables: variables)
      XCTAssertTrue(gate is DeviceCheckGate, "\(variables)")
      XCTAssertEqual((gate as? DeviceCheckGate)?.environment, .development)
    }
  }

  func testAuthMapReplacesProductionMap() {
    var lines: [String] = []
    let log: (String) -> Void = { lines.append($0) }
    XCTAssertEqual(RelayAccessSetup.registries(variables: [:], log: log), RelayAuthWire.registries)
    let cases: [(String, [String: URL])] = [
      ("https://relay.rarog.ai/=http://127.0.0.1:8787", ["https://relay.rarog.ai/": URL(string: "http://127.0.0.1:8787")!]),
      ("https://Relay.Example.com:443=https://auth.example.com/",
       ["https://relay.example.com/": URL(string: "https://auth.example.com")!]),
    ]
    for (raw, expected) in cases {
      XCTAssertEqual(RelayAccessSetup.registries(variables: ["RAROG_RELAY_AUTH_MAP": raw], log: log), expected, raw)
    }
    XCTAssertEqual(lines, [])
  }

  func testBadAuthMapKeepsProductionMapWithLogLine() {
    let bad = [
      "", "https://relay.rarog.ai/", "=http://127.0.0.1:8787", "https://relay.rarog.ai/=",
      "http://relay.example.com/=http://127.0.0.1:8787", "https://relay.rarog.ai/=http://auth.example.com",
      "https://relay.rarog.ai/=https://auth.example.com/v1", "https://relay.rarog.ai/=ftp://127.0.0.1",
    ]
    for raw in bad {
      var lines: [String] = []
      let map = RelayAccessSetup.registries(variables: ["RAROG_RELAY_AUTH_MAP": raw]) { lines.append($0) }
      XCTAssertEqual(map, RelayAuthWire.registries, raw)
      // Jedna linia, bez wartości zmiennej.
      XCTAssertEqual(lines, [
        "relay-access: RAROG_RELAY_AUTH_MAP ignored (expected <relay>=<registry origin>), production map in use",
      ], raw)
    }
  }

  func testRenewEveryFromVariable() {
    var lines: [String] = []
    let log: (String) -> Void = { lines.append($0) }
    XCTAssertEqual(RelayAccessSetup.renewEvery(variables: [:], log: log), RelayAccessMachine.defaultRenewEvery)
    XCTAssertEqual(RelayAccessMachine.defaultRenewEvery, .seconds(6 * 3600))
    XCTAssertEqual(RelayAccessSetup.renewEvery(variables: ["RAROG_RELAY_RENEW_EVERY": "30"], log: log), .seconds(30))
    XCTAssertEqual(lines, [])
    for raw in ["", "0", "-5", "1.5", "30s", " 30"] {
      lines = []
      XCTAssertEqual(RelayAccessSetup.renewEvery(variables: ["RAROG_RELAY_RENEW_EVERY": raw], log: log),
                     RelayAccessMachine.defaultRenewEvery, raw)
      XCTAssertEqual(lines, [
        "relay-access: RAROG_RELAY_RENEW_EVERY ignored (expected whole seconds > 0), default period in use",
      ], raw)
    }
  }

  // MARK: - Pomocnicze

  /// Bajty `embedded.mobileprovision` z plistą w środku (CMS wokół niej czytnik pomija).
  private static func profile(aps: String) -> Data {
    Data(("\u{30}\u{80}signed<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict>"
      + "<key>Entitlements</key><dict><key>aps-environment</key><string>\(aps)</string></dict></dict></plist>tail")
      .utf8)
  }
}

/// Token DeviceCheck z atrapy: `token-<n>` dla n-tego wywołania, porażka albo pusty token.
private final class StubDeviceCheck: DeviceCheckDevice {
  let isSupported: Bool
  private let failure: NSError?
  private let empty: Bool
  private let calls = Mutex(0)

  init(isSupported: Bool = true, failure: NSError? = nil, empty: Bool = false) {
    self.isSupported = isSupported
    self.failure = failure
    self.empty = empty
  }

  /// Wywołania `generateToken()`.
  var generated: Int { calls.withLock { $0 } }

  func generateToken() async throws -> Data {
    let call = calls.withLock { count in
      count += 1
      return count
    }
    if let failure { throw failure }
    return empty ? Data() : Data("token-\(call)".utf8)
  }
}
