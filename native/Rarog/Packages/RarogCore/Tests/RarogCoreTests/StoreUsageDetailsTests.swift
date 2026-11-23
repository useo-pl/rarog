import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Testing

// Szczegóły limitów dla arkusza „Limity” komendy apki `/usage`: `loadUsageDetails` czyta
// `GET /api/usage/details` raz, na żądanie arkusza, i oddaje wynik bez śladu w stanie apki. Odmiany odpowiedzi
// z serwera: złote odpowiedzi REST `usage.details*.json`. Arkusz i źródła: `UsageSheetModelTests` (RarogUI).
// Właściciel: lista.

private func restUsage(_ name: String) throws -> PlanUsage {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try JSONDecoder().decode(PlanUsage.self, from: Data(contentsOf: url))
}

/// Odpowiedź serwera i to, jak czyta ją rdzeń.
struct DetailsCase: Sendable, CustomTestStringConvertible {
  let error: TransportError
  let outcome: UsageDetailsOutcome
  let testDescription: String
}

@MainActor
@Suite("rdzeń: szczegóły limitów dla arkusza „Limity”")
struct StoreUsageDetailsTests {
  /// Pętla limitów nie wchodzi w drogę: odczyt stopki od razu po starcie, następny dopiero po 10 min.
  private let timing = UsageTiming(refresh: .seconds(600), retry: .seconds(600), floor: .zero)

  @Test("200: złote odpowiedzi szczegółów (z oknem per model i `{}`) wracają bez zmian, jeden odczyt na wywołanie")
  func loaded() async throws {
    let transport = ProbeTransport()
    let details = try restUsage("usage.details.json")
    #expect(details.weeklyModel?.model == "Fable" && details.source == nil && details.stale == true)
    transport.set { $0.details = .success(details) }
    let store = makeProbeStore(transport, timing: timing)
    await store.start()
    #expect(await store.loadUsageDetails() == .loaded(details))
    #expect(transport.detailsCalls == 1)
    let empty = try restUsage("usage.details.empty.json")
    transport.set { $0.details = .success(empty) }
    #expect(await store.loadUsageDetails() == .loaded(empty))
    #expect(transport.detailsCalls == 2, "bez odpytywania: odczyt tylko na żądanie arkusza")
    #expect(store.state.auth == .loggedIn)
  }

  @Test(
    "serwer bez trasy (404, 405) to „nie zna”, reszta błędów — porażka bez wylogowania",
    arguments: [
      DetailsCase(
        error: .http(APIFailure(status: 404, code: "not-found")), outcome: .unsupported, testDescription: "404"),
      DetailsCase(
        error: .http(APIFailure(status: 405, code: "method-not-allowed")), outcome: .unsupported,
        testDescription: "405"),
      DetailsCase(error: .http(APIFailure(status: 503, code: "x")), outcome: .failed, testDescription: "503"),
      DetailsCase(error: .offline(.notConnectedToInternet), outcome: .failed, testDescription: "sieć"),
      DetailsCase(error: .invalidResponse("spoza kontraktu"), outcome: .failed, testDescription: "kontrakt"),
    ])
  func failures(_ answer: DetailsCase) async throws {
    let transport = ProbeTransport()
    transport.set { $0.details = .failure(answer.error) }
    let store = makeProbeStore(transport, timing: timing)
    await store.start()
    #expect(await store.loadUsageDetails() == answer.outcome)
    #expect(store.state.auth == .loggedIn)
  }

  @Test("401 wylogowuje jak każdy odczyt; bez logowania odczyt nie wychodzi")
  func unauthorized() async throws {
    let transport = ProbeTransport()
    transport.set { $0.details = .failure(.unauthorized(APIFailure(status: 401))) }
    let store = makeProbeStore(transport, timing: timing)
    #expect(await store.loadUsageDetails() == .failed, "przed logowaniem")
    #expect(transport.detailsCalls == 0)
    await store.start()
    #expect(await store.loadUsageDetails() == .failed)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(await store.loadUsageDetails() == .failed)
    #expect(transport.detailsCalls == 1, "po wylogowaniu nic nie wychodzi")
  }

  @Test("odpowiedź sprzed wylogowania i ponownego logowania nie wraca jako odczyt")
  func lateAcrossRelogin() async throws {
    let transport = ProbeTransport()
    let details = try restUsage("usage.details.json")
    transport.set { $0.details = .success(details) }
    let store = makeProbeStore(transport, timing: timing)
    await store.start()
    await until("online") { store.state.global == .online }
    // Odpowiedź już w drodze: wylogowanie jej nie zatrzyma.
    transport.set {
      $0.hold = true
      $0.holdIgnoresCancel = true
    }
    let read = Task { await store.loadUsageDetails() }
    await until("odczyt w drodze") { transport.detailsCalls == 1 }
    transport.base.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    transport.set { $0.hold = false }
    store.enterLoggedIn()
    transport.release()
    #expect(await read.value == .failed, "spóźnione 200 sprzed wylogowania")
    #expect(await store.loadUsageDetails() == .loaded(details), "nowe logowanie czyta zwyczajnie")
  }
}
