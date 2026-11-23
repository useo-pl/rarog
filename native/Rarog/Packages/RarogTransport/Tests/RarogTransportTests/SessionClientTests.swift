import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// Sterowanie żywą sesją i diff na atrapie `URLProtocol`.

/// Złota odpowiedź REST (`shared/fixtures/rest/<name>`, produkuje ją serwer) jako ciało atrapy.
func goldenRest(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return String(decoding: try Data(contentsOf: url), as: UTF8.self)
}

/// Bramka z ustaloną odmową sesji nieobsługiwanej.
private struct UnsupportedPolicy: MutationPolicy {
  let unsupported: Set<String>

  func compatibilityRefusal() async -> PolicyRefusal? { nil }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    unsupported.contains(sessionId) ? PolicyRefusal("Ta wersja apki nie obsługuje tej sesji.") : nil
  }
}

@Suite("klient REST: model, tryb, restart i diff sesji")
struct SessionClientTests {
  @Test("GET /api/models i GET …/diff: odczyty bez Origin, segment zakodowany")
  func reads() async throws {
    let harness = MockHarness { request in
      request.path.hasSuffix("/diff")
        ? .json(200, #"{"files":[{"path":"a.ts","status":"A","linesAdded":2,"linesDeleted":0}],"patch":"","truncated":true}"#)
        : .json(200, #"{"models":[{"value":"fable","label":"Fable","effortLevels":["high"]}]}"#)
    }
    let list = try await harness.client.models()
    #expect(list.models.map(\.value) == ["fable"])
    let diff = try await harness.client.sessionDiff(sessionId: "w0:d4")
    #expect(diff.files.first?.status == .added && diff.truncated)
    let paths = harness.requests.map { "\($0.method) \($0.path)" }
    #expect(paths == ["GET /api/models", "GET /api/sessions/w0%3Ad4/diff"])
    #expect(harness.requests.allSatisfy { $0.header("Origin") == nil })
  }

  @Test("GET …/commands: odczyt bez Origin, segment zakodowany; 405 starego serwera i 404 to pusta lista")
  func commands() async throws {
    let harness = MockHarness { request in
      switch request.path {
      case "/api/sessions/w0%3Ad4/commands":
        .json(200, #"{"revision":"r1","commands":[{"name":"compact","kind":"local","source":"builtin"},{"name":"handoff","kind":"prompt","source":"skill","description":"Opis","argumentHint":"[cel]"}]}"#)
      case "/api/sessions/stary/commands":
        .json(405, #"{"error":"method-not-allowed","message":"Niedozwolona metoda."}"#, headers: ["Allow": "POST"])
      default:
        .json(404, #"{"error":"not-found","message":"Nie ma takiej sesji."}"#)
      }
    }
    let list = try await harness.client.commands(sessionId: "w0:d4")
    #expect(list.revision == "r1")
    #expect(list.commands == [
      CommandChoice(name: "compact", kind: .local, source: .builtin),
      CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Opis", argumentHint: "[cel]"),
    ])
    #expect(try await harness.client.commands(sessionId: "stary") == .unavailable)
    #expect(try await harness.client.commands(sessionId: "nie-ma") == .unavailable)
    #expect(harness.requests.map { "\($0.method) \($0.path)" } == [
      "GET /api/sessions/w0%3Ad4/commands", "GET /api/sessions/stary/commands", "GET /api/sessions/nie-ma/commands",
    ])
    #expect(harness.requests.allSatisfy { $0.header("Origin") == nil })
  }

  @Test("GET …/commands: 401 to odmowa klucza (zatrzask), 400 ze zdaniem serwera, kształt spoza kontraktu")
  func commandsFailures() async throws {
    let harness = MockHarness(device: testDevice) { request in
      switch request.path {
      case "/api/sessions/poza/commands":
        .json(400, #"{"error":"bad-request","message":"Panel jest poza RAROG_HERDR_ROOTS."}"#)
      case "/api/sessions/zly/commands":
        .json(200, #"{"commands":[]}"#)
      default:
        .json(401, #"{"error":"unauthorized","message":"Zaloguj się ponownie."}"#)
      }
    }
    let refused = await #expect(throws: TransportError.self) { _ = try await harness.client.commands(sessionId: "poza") }
    #expect(refused == .http(APIFailure(status: 400, code: "bad-request", message: "Panel jest poza RAROG_HERDR_ROOTS.")))
    let broken = await #expect(throws: TransportError.self) { _ = try await harness.client.commands(sessionId: "zly") }
    guard case .invalidResponse? = broken else {
      Issue.record("oczekiwano odpowiedzi spoza kontraktu, jest \(String(describing: broken))")
      return
    }
    #expect(harness.client.credentialRejection == nil, "400 i zły kształt to nie odmowa klucza")
    let lost = await #expect(throws: TransportError.self) { _ = try await harness.client.commands(sessionId: "s1") }
    #expect(lost == .unauthorized(APIFailure(status: 401, code: "unauthorized", message: "Zaloguj się ponownie.")))
    #expect(harness.client.credentialRejection == .unknown(deviceId: testDevice.deviceId))
  }

  @Test("GET …/diff/files i …/diff/file: odczyty bez Origin, kształt listy i patcha")
  func diffPerFile() async throws {
    let harness = MockHarness { request in
      request.path.hasSuffix("/diff/files")
        ? .json(200, #"{"files":[{"path":"a.ts","status":"M","linesAdded":2,"linesDeleted":1},{"path":"b.bin","status":"A","binary":true},{"path":"nowy.md","status":"A"}],"truncated":true}"#)
        : .json(200, #"{"path":"a.ts","patch":"diff --git a/a.ts b/a.ts\n","truncated":false}"#)
    }
    let list = try await harness.client.sessionDiffFiles(sessionId: "w0:d4")
    #expect(list.truncated && list.files.map(\.path) == ["a.ts", "b.bin", "nowy.md"])
    #expect(list.files[1].binary && list.files[2].linesAdded == nil, "liczniki są opcjonalne")
    let patch = try await harness.client.sessionDiffFile(sessionId: "w0:d4", path: "a.ts")
    #expect(patch == DiffFilePatch(path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n", truncated: false))
    let paths = harness.requests.map { "\($0.method) \($0.path)" }
    #expect(paths == ["GET /api/sessions/w0%3Ad4/diff/files", "GET /api/sessions/w0%3Ad4/diff/file?path=a.ts"])
    #expect(harness.requests.allSatisfy { $0.header("Origin") == nil })
  }

  /// Serwer czyta ścieżkę przez `URL.searchParams` (plus w query to spacja, `&` i `#` kończą wartość), więc
  /// klient koduje ją sam, zamkniętym zbiorem znaków. Dekodowanie niżej robi to, co serwer.
  @Test(
    "GET …/diff/file: ścieżka w adresie przeżywa plus, spację, procent, &, #, tabulator i znaki spoza ASCII",
    arguments: [
      ("src/a+b.ts", "src%2Fa%2Bb.ts"),
      ("docs/moja notatka.md", "docs%2Fmoja%20notatka.md"),
      ("raport 100%.txt", "raport%20100%25.txt"),
      ("a&b=c.ts", "a%26b%3Dc.ts"),
      ("uwagi#1.md", "uwagi%231.md"),
      ("kol\tumna.tsv", "kol%09umna.tsv"),
      ("zażółć/gęślą jaźń.txt", "za%C5%BC%C3%B3%C5%82%C4%87%2Fg%C4%99%C5%9Bl%C4%85%20ja%C5%BA%C5%84.txt"),
      ("emoji 🚀?.md", "emoji%20%F0%9F%9A%80%3F.md"),
      ("-._~/zwykle", "-._~%2Fzwykle"),
    ])
  func diffFilePathEncoding(path: String, encoded: String) async throws {
    let harness = MockHarness { _ in .json(200, #"{"path":"x","patch":"","truncated":false}"#) }
    _ = try await harness.client.sessionDiffFile(sessionId: "s1", path: path)
    let request = try #require(harness.requests.first)
    #expect(request.path == "/api/sessions/s1/diff/file?path=\(encoded)")
    // To samo, co `new URL(…).searchParams.get('path')` w Node: plus to spacja, potem dekodowanie procentów.
    let query = try #require(request.path.split(separator: "?", maxSplits: 1).last.map(String.init))
    #expect(!query.contains("+") && !query.dropFirst("path=".count).contains("&") && !query.contains("#"))
    let value = String(query.dropFirst("path=".count)).replacingOccurrences(of: "+", with: " ")
    #expect(value.removingPercentEncoding == path)
  }

  @Test("GET …/diff/file i …/diff/files: odmowa niesie status i kod (404 lista się zmieniła, 503 git, 405 starszy serwer)")
  func diffRefusals() async throws {
    let harness = MockHarness { request in
      if request.path.hasSuffix("/diff/files") {
        return .json(405, #"{"error":"method-not-allowed","message":"Niedozwolona metoda."}"#, headers: ["Allow": "POST"])
      }
      return request.path.hasSuffix("path=git.ts")
        ? .json(503, #"{"error":"git-failed","message":"Git nie odpowiedział. Spróbuj ponownie."}"#)
        : .json(404, #"{"error":"diff-file-not-found","message":"Tego pliku nie ma na liście zmian — lista mogła się zmienić."}"#)
    }
    func failure<T>(_ call: () async throws -> T) async -> APIFailure? {
      do {
        _ = try await call()
        return nil
      } catch {
        guard case let .http(failure)? = error as? TransportError else { return nil }
        return failure
      }
    }
    let outdated = await failure { try await harness.client.sessionDiffFiles(sessionId: "s1") }
    #expect(outdated?.status == 405 && outdated?.code == "method-not-allowed")
    let gone = await failure { try await harness.client.sessionDiffFile(sessionId: "s1", path: "a.ts") }
    #expect(gone?.status == 404 && gone?.code == "diff-file-not-found")
    let git = await failure { try await harness.client.sessionDiffFile(sessionId: "s1", path: "git.ts") }
    #expect(git?.status == 503 && git?.code == "git-failed" && git?.message == "Git nie odpowiedział. Spróbuj ponownie.")
  }

  @Test("POST …/model: różnica w ciele, Origin, ostrzeżenie z 202")
  func setModel() async throws {
    let harness = MockHarness { _ in .json(202, #"{"ok":true,"warning":"Skutek globalny."}"#) }
    let body = try #require(SessionModelBody(model: "opus[1m]", effort: .xhigh))
    let reply = try await harness.client.setSessionModel(sessionId: "s1", body)
    #expect(reply.warning == "Skutek globalny.")
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions/s1/model")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let sent = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: String]
    #expect(sent == ["model": "opus[1m]", "effort": "xhigh"])
  }

  @Test("POST …/model: ultracode w obie strony, `false` też jedzie na drut")
  func setModelUltracode() async throws {
    let harness = MockHarness { _ in .json(202, #"{"ok":true,"warning":"Koszt tury."}"#) }
    for value in [true, false] {
      let body = try #require(SessionModelBody(model: nil, effort: nil, ultracode: value))
      let reply = try await harness.client.setSessionModel(sessionId: "s1", body)
      #expect(reply.warning == "Koszt tury.")
    }
    #expect(harness.requests.count == 2)
    // Słownik ogólny, bo ciało niesie bool, nie tekst.
    let sent = try harness.requests.map { request in
      try JSONSerialization.jsonObject(with: try #require(request.body)) as? NSDictionary
    }
    #expect(sent == [["ultracode": true] as NSDictionary, ["ultracode": false] as NSDictionary])
  }

  @Test("POST …/mode i …/restart: ciało trybu, puste ciało restartu, odmowa ze zdaniem serwera")
  func modeAndRestart() async throws {
    let harness = MockHarness { request in
      request.path.hasSuffix("/mode")
        ? .json(202, #"{"ok":true}"#)
        : .json(409, #"{"error":"bad-state","message":"Sesja pracuje — uruchomisz ją ponownie, gdy stanie."}"#)
    }
    try await harness.client.setSessionMode(sessionId: "s1", SessionModeBody(mode: .plan))
    do {
      _ = try await harness.client.restartSession(sessionId: "s1")
      Issue.record("odmowa powinna rzucić")
    } catch {
      guard case let .http(failure) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(failure.status == 409 && failure.message == "Sesja pracuje — uruchomisz ją ponownie, gdy stanie.")
    }
    let bodies = harness.requests.map { String(decoding: $0.body ?? Data(), as: UTF8.self) }
    #expect(bodies == [#"{"mode":"plan"}"#, "{}"])
    #expect(harness.requests.map(\.path) == ["/api/sessions/s1/mode", "/api/sessions/s1/restart"])
  }

  /// „Uruchom ponownie i wyślij” niesie całą blokadę karty (`seq` i `id`), nigdy tekstu promptu; blokada
  /// nieaktualna wraca 409 zdaniem serwera, a pigułka „↑” dalej wysyła puste ciało.
  @Test("POST …/restart z `resend`: oba pola blokady w ciele, 409 nieaktualnej blokady ze zdaniem serwera")
  func restartResend() async throws {
    let stale = "Ten prompt już nie czeka na ponowne wysłanie."
    let harness = MockHarness { request in
      request.path == "/api/sessions/w0%3Ad4/restart" && (request.body?.count ?? 0) > 2
        ? .json(409, #"{"error":"bad-state","message":"\#(stale)"}"#)
        : .json(202, #"{"sessionId":"w0:d4"}"#)
    }
    let blocked = try JSONDecoder().decode(SessionPromptBlocked.self, from: Data(#"{"seq":7,"id":"b-1"}"#.utf8))
    do {
      _ = try await harness.client.restartSession(sessionId: "w0:d4", resend: blocked)
      Issue.record("odmowa powinna rzucić")
    } catch {
      guard case let .http(failure) = error else { Issue.record("zły błąd: \(error)"); return }
      #expect(failure.status == 409 && failure.message == stale)
    }
    #expect(try await harness.client.restartSession(sessionId: "w0:d4").sessionId == "w0:d4")
    // Kolejność kluczy na drucie nie jest kontraktem — porównanie po przepisaniu z posortowanymi kluczami.
    let sent = try harness.requests.map { request in
      let object = try JSONSerialization.jsonObject(with: try #require(request.body))
      return String(decoding: try JSONSerialization.data(withJSONObject: object, options: .sortedKeys), as: UTF8.self)
    }
    #expect(sent == [#"{"resend":{"id":"b-1","seq":7}}"#, "{}"])
    #expect(harness.requests.map(\.path) == ["/api/sessions/w0%3Ad4/restart", "/api/sessions/w0%3Ad4/restart"])
    #expect(harness.requests.allSatisfy { $0.header("Origin") == "http://127.0.0.1:\(harness.port)" })
  }

  @Test("restart: 202 z identyfikatorem; limit dłuższy niż serwera")
  func restartAccepted() async throws {
    let harness = MockHarness { _ in .json(202, #"{"sessionId":"s1"}"#) }
    #expect(try await harness.client.restartSession(sessionId: "s1").sessionId == "s1")
    #expect(RarogClient.restartTimeout == .seconds(20))
  }

  @Test("bramka sesji nieobsługiwanej: mutacje nie wychodzą, odczyt diffa tak")
  func gate() async throws {
    let refusal = "Ta wersja apki nie obsługuje tej sesji."
    let harness = MockHarness(policy: UnsupportedPolicy(unsupported: ["x"])) { _ in
      .json(200, #"{"files":[],"patch":"","truncated":false}"#)
    }
    do {
      try await harness.client.setSessionMode(sessionId: "x", SessionModeBody(mode: .auto))
      Issue.record("bramka powinna odmówić trybu")
    } catch {
      #expect(error == .refused(MutationRefusal(gate: .unsupportedSession(id: "x"), message: refusal)))
    }
    do {
      _ = try await harness.client.restartSession(sessionId: "x")
      Issue.record("bramka powinna odmówić restartu")
    } catch {
      #expect(error == .refused(MutationRefusal(gate: .unsupportedSession(id: "x"), message: refusal)))
    }
    #expect(harness.requests.isEmpty, "nic nie wyszło do serwera")
    _ = try await harness.client.sessionDiff(sessionId: "x")
    #expect(harness.requests.count == 1)
    // Trasy per plik to też odczyty: bramka sesji ich nie zatrzymuje (kształt odpowiedzi jest tu inny,
    // więc dekodowanie pada dopiero po wysłaniu żądania).
    _ = try? await harness.client.sessionDiffFiles(sessionId: "x")
    _ = try? await harness.client.sessionDiffFile(sessionId: "x", path: "a.ts")
    #expect(harness.requests.count == 3)
  }

  @Test("odpowiedź spoza kontraktu: 202 modelu bez ostrzeżenia, ok:false trybu")
  func contractViolations() async {
    let model = MockHarness { _ in .json(202, #"{"ok":true}"#) }
    await #expect(throws: TransportError.self) {
      _ = try await model.client.setSessionModel(sessionId: "s", #require(SessionModelBody(model: "fable", effort: nil)))
    }
    let mode = MockHarness { _ in .json(202, #"{"ok":false}"#) }
    await #expect(throws: TransportError.self) {
      try await mode.client.setSessionMode(sessionId: "s", SessionModeBody(mode: .plan))
    }
  }

  // MARK: - Zdania serwera z kodem: dekoder klienta tłumaczy odpowiedź rendererem (tu `pl`)

  @Test("GET /api/models na złotym pliku: etykieta i opis wyboru domyślnego po polsku, nazwy modeli i `*Ref` bez zmian")
  func modelsTranslated() async throws {
    let body = try goldenRest("models.json")
    let harness = MockHarness { _ in .json(200, body) }
    let list = try await harness.client.models()
    let first = try #require(list.models.first)
    #expect(first.label == "Model domyślny konta")
    #expect(first.description == "Bez flagi --model: dokładnie to, co masz ustawione w Claude Code.")
    #expect(first.labelRef == SentenceRef(code: "model.default-label"))
    #expect(list.models.dropFirst().map(\.label) == ["Fable", "Opus", "Sonnet", "Haiku"])
  }

  @Test("POST …/model na złotym pliku: ostrzeżenie po polsku")
  func modelWarningTranslated() async throws {
    let body = try goldenRest("model-accepted.json")
    let harness = MockHarness { _ in .json(202, body) }
    let reply = try await harness.client.setSessionModel(sessionId: "s1", try #require(SessionModelBody(model: "fable", effort: nil)))
    #expect(reply.warning == #"Zmiana leci do panelu jako polecenie „/model", a Claude Code zapisuje ją w ustawieniach konta: nowe sesje — także zakładane w terminalu — ruszą od tej chwili na tym modelu. Rarog nie przywróci poprzedniej wartości."#)
    #expect(reply.warningRef == SentenceRef(code: "model.change-warning"))
  }

  @Test("POST …/interrupt: `session.stateDetail` i `label` po polsku (złoty plik i stan z `stateDetailRef`)")
  func interruptTranslated() async throws {
    let golden = try goldenRest("interrupt.json")
    let withState = #"""
      {"ok":true,"delivered":"yes","session":{"id":"w0:a","cwd":"/x","title":"x","state":"starting",
       "stateSince":"2026-10-04T10:00:00.000Z","createdAt":"2026-10-04T10:00:00.000Z",
       "lastActivityAt":"2026-10-04T10:00:00.000Z","stateDetail":"pane state not known yet",
       "stateDetailRef":{"code":"state.herdr-unknown"}}}
      """#
    let harness = MockHarness { request in .json(200, request.path.contains("w0%3Ad5") ? golden : withState) }
    let labelled = try await harness.client.interruptSession(sessionId: "w0:d5")
    #expect(labelled.session?.label == "sesja 1")
    let state = try await harness.client.interruptSession(sessionId: "w0:a")
    #expect(state.session?.stateDetail == "stan panelu jeszcze nieznany")
    #expect(state.session?.stateDetailRef == SentenceRef(code: "state.herdr-unknown"))
  }

  @Test("kod zdania spoza rejestru i serwer bez `*Ref`: tekst serwera bez zmian")
  func untranslatable() async throws {
    let harness = MockHarness { request in
      request.path.hasSuffix("/model")
        ? .json(202, #"{"ok":true,"warning":"A sentence from the future.","warningRef":{"code":"model.z-przyszlosci"}}"#)
        : .json(200, #"{"models":[{"value":"","label":"Account Default Model","effortLevels":[]}]}"#)
    }
    #expect(try await harness.client.models().models.map(\.label) == ["Account Default Model"])
    let reply = try await harness.client.setSessionModel(sessionId: "s1", try #require(SessionModelBody(model: "fable", effort: nil)))
    #expect(reply.warning == "A sentence from the future.")
  }
}
