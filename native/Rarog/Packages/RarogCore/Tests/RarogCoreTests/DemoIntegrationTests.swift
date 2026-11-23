// Magazyn przeciw PRAWDZIWEMU serwerowi demo — domyślnie pominięty (jak w RarogTransport).
//
//   P=18931; D=$(mktemp -d "$TMPDIR/rarog-demo.XXXXXX")
//   RAROG_DEMO=1 RAROG_PORT=$P RAROG_ORIGINS=http://127.0.0.1:$P RAROG_DATA_DIR=$D \
//     pnpm -C <repo> run demo:server &
//   RAROG_DEMO_PORT=$P swift test --package-path native/Rarog/Packages/RarogCore
import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

private let demoPort = ProcessInfo.processInfo.environment["RAROG_DEMO_PORT"].flatMap(Int.init)

/// Klucz urządzenia z demo: kod „jak z Maca” (`POST /api/demo/pairing`, tylko demo) i `POST /api/pair`.
private func demoCredential(port: Int, label: String) async throws -> DeviceCredential {
  let server = URL(string: "http://127.0.0.1:\(port)")!
  var request = URLRequest(url: server.appending(path: "api/demo/pairing"))
  request.httpMethod = "POST"
  request.setValue(server.absoluteString, forHTTPHeaderField: "Origin")
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = Data("{}".utf8)
  let (data, _) = try await URLSession.shared.data(for: request)
  let raw = try #require((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["link"] as? String)
  let link = try PairingLink.parse(raw).get()
  let response = try await RarogClient(config: .test(port: port, build: 1, clientLabel: label))
    .pair(PairBody(code: link.code, label: label, build: 1))
  return DeviceCredential(pair: response, serverURL: link.server, label: label, pairedAt: Date())
}

@MainActor
@Suite("serwer demo: parowanie → lista → sesja → wysyłka → echo (RAROG_DEMO_PORT)", .enabled(if: demoPort != nil))
struct DemoIntegrationTests {
  @Test("pełny przepływ na żywym serwerze demo")
  func fullFlow() async throws {
    let port = try #require(demoPort)
    try #require(port != 8930, "żywy Rarog — test celuje wyłącznie w demo")
    let credential = try await demoCredential(port: port, label: "test·Rarog")
    let store = RarogStore.live(
      config: .test(port: port, build: 1, clientLabel: "test·Rarog"), device: credential,
      outboxDirectory: temporaryOutbox())

    await store.start()
    #expect(store.state.auth == .loggedIn)
    await until("lista i zgodność", timeout: .seconds(15)) { store.state.sessionsLoaded && store.state.compat == .ok }

    let target = try #require(store.state.sortedSessions.first { store.state.sendBlock(for: $0.id) == nil },
                              "demo ma sesję, do której wolno pisać")
    store.openSession(target.id)
    await until("transkrypt", timeout: .seconds(15)) { (store.state.transcripts[target.id]?.snapshots ?? 0) > 0 }

    let text = "test echa \(UUID().uuidString.prefix(8))"
    let outcome = await store.send(text: text, to: target.id)
    guard case let .accepted(id) = outcome else {
      Issue.record("wysyłka nie przyjęta: \(outcome)")
      return
    }
    await until("echo dopasowane", timeout: .seconds(15)) { store.state.echoed[id] != nil }
    #expect(store.state.outbox.isEmpty)
    #expect(store.state.transcripts[target.id]?.messages.contains { $0.seq == store.state.echoed[id] } == true)
  }
}
