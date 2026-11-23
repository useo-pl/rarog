import Foundation
import XCTest

/// Sterowanie wyłącznie własnym demo odbioru. Token `demo` jest publicznym tokenem testowym;
/// endpoint nie istnieje w produkcji i wymaga originu oraz połączenia z loopbacku.
@MainActor
struct DemoControl {
  let port: Int

  struct Message: Decodable {
    let sessionId: String
    let clientMessageId: String?
    let replayed: Bool?
  }

  /// POST odpowiedzi (`/answers/<qId>`) albo decyzji (`/permissions/<permId>`; `nil` = `/permission`)
  /// sesji odbioru, zanim oceni go router — także ten, który dostał 410 i nie doszedł do drivera.
  struct Answer: Decodable {
    let sessionId: String
    let qId: String
  }

  struct Decision: Decodable {
    let sessionId: String
    let permId: String?
  }

  struct Held: Decodable {
    let snapshots: Int
    let responses: Int
    let echoes: Int
    /// Żądania patcha pliku wstrzymane przez `configure(diffFile: "hold")`.
    let diffs: Int
  }

  struct Stats: Decodable {
    let receivedMessages: [Message]
    let acceptedMessages: [Message]
    let receivedAnswers: [Answer]
    let receivedDecisions: [Decision]
    let driverSends: Int
    let driverDecisions: Int
    let driverAnswers: [[[String]]]
    /// Żądania KAŻDEJ trasy diffa dowolnej sesji od `reset`: dawna `GET …/diff` i obie per plik. Prawy panel
    /// i dymek gita: zero bez stuknięcia.
    let diffRequests: Int
    /// `GET …/diff/files`: lista zmian okna diffa.
    let diffListRequests: Int
    /// `GET …/diff/file?path=…`: patch jednego pliku.
    let diffFileRequests: Int
    /// Ścieżki, o które poproszono, w kolejności żądań — dowód, że poszedł patch stukniętego pliku.
    let diffFilePaths: [String]
    /// Notatki projektów (magazyn demo w pamięci): `GET` i `PUT /api/notes` od `reset` i bieżąca treść notatki
    /// projektu z zasiewu — dowód, że dymek czyta, a zamknięcie formularza zapisuje.
    let notesGets: Int
    let notesPuts: Int
    let noteText: String?
    let held: Held
    let transcriptMessages: Int
  }

  private enum ControlError: Error {
    case unexpectedStatus(Int)
  }

  private var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

  func reset() async throws {
    _ = try await request(["action": "reset"])
  }

  /// `cwd`: katalog sesji zamiast `/Users/demo/Projects/rarog` (tytuł nagłówka to nazwa katalogu, nie etykieta).
  func create(_ scenario: String, label: String = "M1 odbiór", cwd: String? = nil) async throws -> String {
    var body = ["action": "create", "scenario": scenario, "label": label]
    if let cwd { body["cwd"] = cwd }
    let data = try await request(body)
    struct Created: Decodable { let sessionId: String }
    return try JSONDecoder().decode(Created.self, from: data).sessionId
  }

  /// `diffList`: `pass` albo `outdated` (lista zmian odpowiada 405, jak serwer sprzed tras diffa per plik);
  /// `diffFile`: `pass`, `hold` (patch pliku czeka na `release("diff")`), `fail` (503 `git-failed`) albo `long`
  /// (każda ścieżka dostaje patch o 400 liniach).
  func configure(
    snapshot: String? = nil, response: String? = nil, echo: String? = nil, unauthorized: Bool? = nil,
    diffList: String? = nil, diffFile: String? = nil
  ) async throws {
    var body: [String: Any] = ["action": "configure"]
    if let snapshot { body["snapshot"] = snapshot }
    if let response { body["messageResponse"] = response }
    if let echo { body["echo"] = echo }
    if let unauthorized { body["unauthorized"] = unauthorized }
    if let diffList { body["diffList"] = diffList }
    if let diffFile { body["diffFile"] = diffFile }
    _ = try await request(body)
  }

  /// Zapis notatki projektu z zasiewu „z innego urządzenia": nowa wersja i event `notes`.
  func noteRemote(_ text: String) async throws {
    _ = try await request(["action": "note-remote", "text": text])
  }

  func release(_ target: String) async throws {
    _ = try await request(["action": "release", "target": target])
  }

  func emit(_ event: String, sessionId: String, text: String? = nil) async throws {
    var body: [String: Any] = ["action": "emit", "sessionId": sessionId, "event": event]
    if let text { body["text"] = text }
    _ = try await request(body)
  }

  /// Ramka `git-status` sesji odbioru, ponawiana, aż apka ją pokaże (`arrived`). Serwer demo nie odtwarza ramki
  /// przy wejściu w sesję (produkcyjny wysyła ją zawsze), więc wysłana, zanim apka otworzy strumień sesji,
  /// przepada. Ponowienie niesie tę samą treść.
  func emitGitStatus(sessionId: String, until arrived: () -> Bool) async throws {
    for _ in 0..<6 where !arrived() {
      try await emit("git-status", sessionId: sessionId)
      let deadline = ContinuousClock.now + .seconds(3)
      while !arrived(), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(200))
      }
    }
    XCTAssertTrue(arrived(), "ramka git-status sesji odbioru na ekranie")
  }

  func stats() async throws -> Stats {
    let data = try await request(nil)
    return try JSONDecoder().decode(Stats.self, from: data)
  }

  /// Punkt synchronizacji to zdarzenie serwera, nie arbitralna pauza w testach.
  func wait(
    _ description: String, timeout: Duration = .seconds(15), until predicate: (Stats) -> Bool
  ) async throws -> Stats {
    let deadline = ContinuousClock.now + timeout
    var value = try await stats()
    while !predicate(value), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
      value = try await stats()
    }
    XCTAssertTrue(predicate(value), description)
    return value
  }

  /// Sprawdzenie negatywne: zdarzenie, którego ma nie być (druga wysyłka, POST po zniknięciu karty),
  /// nie daje punktu synchronizacji, więc predykat musi trwać przez całe krótkie okno.
  func stays(
    _ description: String, for window: Duration = .seconds(1), _ predicate: (Stats) -> Bool
  ) async throws -> Stats {
    let deadline = ContinuousClock.now + window
    var value = try await stats()
    while predicate(value), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
      value = try await stats()
    }
    XCTAssertTrue(predicate(value), description)
    return value
  }

  private func request(_ body: [String: Any]?) async throws -> Data {
    precondition(port != 8930, "testy nigdy nie sterują żywym Rarogiem")
    var request = URLRequest(url: baseURL.appending(path: "api/demo/control"))
    request.timeoutInterval = 15
    request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
    request.setValue("demo", forHTTPHeaderField: "X-Rarog-Demo-Token")
    if let body {
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw ControlError.unexpectedStatus(status) }
    return data
  }
}
