import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

/// Złota odpowiedź REST z `shared/fixtures/rest/` (produkuje ją kod serwera).
private func restFixture(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

@Suite("klient REST: limity planu")
struct RarogClientUsageTests {
  @Test("200: złota odpowiedź dekodowana; GET bez Origin")
  func fresh() async throws {
    let body = try restFixture("usage.json")
    let harness = MockHarness { _ in .json(200, body) }
    let usage = try await harness.client.usage()
    #expect(usage.fiveHour?.percent == 27)
    #expect(usage.weeklyModel == nil, "pasek statusu nie niesie okna per model")
    #expect(usage.account == "demo@example.com")
    #expect(usage.stale == nil && usage.source == "cli")
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/usage")
    #expect(request.header("Origin") == nil)
  }

  @Test("200 ze starym zrzutem paska statusu, z e-mailem konta i bez")
  func staleAndCli() async throws {
    let stale = try restFixture("usage.stale.json")
    let cli = try restFixture("usage.cli.json")
    let staleUsage = try await MockHarness { _ in .json(200, stale) }.client.usage()
    #expect(staleUsage.stale == true && staleUsage.fetchedAt == "2026-10-04T10:00:00.000Z")
    let cliUsage = try await MockHarness { _ in .json(200, cli) }.client.usage()
    #expect(cliUsage.source == "cli" && cliUsage.weeklyModel == nil && cliUsage.account == nil)
  }

  @Test("503: serwer nie wie — `.http` ze statusem i kodem, nie brak sieci")
  func unavailable() async {
    let harness = MockHarness { _ in
      .json(503, #"{"error":"usage-unavailable","message":"Limity niedostępne — Claude Code na Macu musi być zalogowany."}"#)
    }
    await #expect(throws: TransportError.http(APIFailure(
      status: 503, code: "usage-unavailable",
      message: "Limity niedostępne — Claude Code na Macu musi być zalogowany."))) {
      try await harness.client.usage()
    }
  }

  @Test("ciało spoza kontraktu (null w polu opcjonalnym) → invalidResponse")
  func malformed() async {
    let harness = MockHarness { _ in .json(200, #"{"fiveHour":null}"#) }
    do {
      _ = try await harness.client.usage()
      Issue.record("odpowiedź z null nie może przejść")
    } catch {
      guard case .invalidResponse = error else {
        Issue.record("oczekiwany invalidResponse, jest \(error)")
        return
      }
    }
  }
}

@Suite("klient REST: szczegóły limitów dla arkusza „Limity”")
struct RarogClientUsageDetailsTests {
  @Test("200: złote odpowiedzi — odczyt Claude Code z oknem per model i `{}`; GET bez Origin")
  func decodes() async throws {
    let body = try restFixture("usage.details.json")
    let harness = MockHarness { _ in .json(200, body) }
    let details = try await harness.client.usageDetails()
    #expect(details.weeklyModel?.model == "Fable" && details.weeklyModel?.percent == 34)
    #expect(details.fiveHour?.percent == 22 && details.weekly?.percent == 57)
    #expect(details.stale == true && details.fetchedAt == "2026-10-04T07:00:00.000Z" && details.source == nil)
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/usage/details")
    #expect(request.header("Origin") == nil)
    let empty = try restFixture("usage.details.empty.json")
    let none = try await MockHarness { _ in .json(200, empty) }.client.usageDetails()
    #expect(none.fiveHour == nil && none.weekly == nil && none.weeklyModel == nil && none.fetchedAt == nil)
  }

  @Test("404 serwera sprzed trasy → `.http` ze statusem; ciało spoza kontraktu → invalidResponse")
  func oldServerAndMalformed() async {
    let old = MockHarness { _ in .json(404, #"{"error":"not-found","message":"Nie ma takiej ścieżki."}"#) }
    await #expect(throws: TransportError.http(APIFailure(
      status: 404, code: "not-found", message: "Nie ma takiej ścieżki."))) {
      try await old.client.usageDetails()
    }
    let malformed = MockHarness { _ in .json(200, #"{"weeklyModel":{"model":"Fable"}}"#) }
    do {
      _ = try await malformed.client.usageDetails()
      Issue.record("okno bez procentu nie może przejść")
    } catch {
      guard case .invalidResponse = error else {
        Issue.record("oczekiwany invalidResponse, jest \(error)")
        return
      }
    }
  }
}

@Suite("klient REST: obciążenie Maca")
struct RarogClientMacTests {
  @Test("200: złota odpowiedź dekodowana; GET bez Origin")
  func decodes() async throws {
    let full = try restFixture("mac.json")
    let harness = MockHarness { _ in .json(200, full) }
    #expect(try await harness.client.mac() == MacLoad(cpu: 35, ram: 60, disk: 45))
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET" && request.path == "/api/mac")
    #expect(request.header("Origin") == nil)
  }

  @Test("404 starszego serwera → `.http` ze statusem 404, nie brak sieci")
  func oldServer() async {
    let harness = MockHarness { _ in .json(404, #"{"error":"not-found","message":"Nie ma takiej ścieżki."}"#) }
    do {
      _ = try await harness.client.mac()
      Issue.record("404 nie może przejść")
    } catch {
      guard case let .http(failure) = error, failure.status == 404 else {
        Issue.record("oczekiwany .http 404, jest \(error)")
        return
      }
    }
  }

  @Test("ciało spoza kontraktu (null, ułamek, ponad 100) → invalidResponse")
  func malformed() async {
    for body in [#"{"cpu":null}"#, #"{"ram":12.5}"#, #"{"disk":120}"#] {
      let harness = MockHarness { _ in .json(200, body) }
      do {
        _ = try await harness.client.mac()
        Issue.record("\(body) nie może przejść")
      } catch {
        guard case .invalidResponse = error else {
          Issue.record("\(body): oczekiwany invalidResponse, jest \(error)")
          continue
        }
      }
    }
  }
}
