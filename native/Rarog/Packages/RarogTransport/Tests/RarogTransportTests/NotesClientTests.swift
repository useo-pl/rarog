import Foundation
import RarogContract
import RarogTransport
import Testing

// Notatki projektu na atrapie `URLProtocol`: odczyt bez bramki, zapis `PUT` przez bramkę zgodności,
// konflikt 409 jako wynik z aktualnym dokumentem.

@Suite("klient REST: notatki projektu")
struct NotesClientTests {
  static let doc = #"{"text":"Deploy\n- restart","updatedAt":1792006800000}"#

  @Test("GET /api/notes: katalog w query zakodowany ręcznie (plus, spacja, polskie znaki), bez Origin")
  func read() async throws {
    let harness = MockHarness { _ in .json(200, Self.doc) }
    let doc = try await harness.client.notes(cwd: "/Users/d/Projects/a+b/zażółć gęś")
    #expect(doc == NotesDoc(text: "Deploy\n- restart", updatedAt: 1_792_006_800_000))
    let request = try #require(harness.requests.first)
    #expect(request.method == "GET")
    #expect(request.path == "/api/notes?cwd=%2FUsers%2Fd%2FProjects%2Fa%2Bb%2Fza%C5%BC%C3%B3%C5%82%C4%87%20g%C4%99%C5%9B")
    #expect(request.header("Origin") == nil)
  }

  @Test("PUT /api/notes: ciało z wersją, Origin; 200 to nowa wersja")
  func save() async throws {
    let harness = MockHarness { _ in .json(200, #"{"updatedAt":1792006800001}"#) }
    let result = try await harness.client.saveNotes(
      NotesPutBody(cwd: "/Users/d/p", text: "dopisek", updatedAt: 1_792_006_800_000))
    #expect(result == .saved(1_792_006_800_001))
    let request = try #require(harness.requests.first)
    #expect(request.method == "PUT" && request.path == "/api/notes")
    #expect(request.header("Origin") != nil)
    let body = try #require(request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    #expect(body["cwd"] as? String == "/Users/d/p" && body["text"] as? String == "dopisek")
    #expect(body["updatedAt"] as? Double == 1_792_006_800_000)
  }

  @Test("PUT 409: wynik z aktualnym dokumentem")
  func conflict() async throws {
    let harness = MockHarness { _ in
      .json(409, #"{"error":"conflict","message":"Notatki zmieniły się na innym urządzeniu.","current":\#(Self.doc)}"#)
    }
    let result = try await harness.client.saveNotes(NotesPutBody(cwd: "/p", text: "x", updatedAt: 1))
    #expect(result == .conflict(NotesDoc(text: "Deploy\n- restart", updatedAt: 1_792_006_800_000)))
  }

  @Test("PUT 409 bez `current` to odpowiedź spoza kontraktu, nie konflikt")
  func conflictWithoutCurrent() async {
    let harness = MockHarness { _ in .json(409, #"{"error":"conflict","message":"x"}"#) }
    await #expect {
      _ = try await harness.client.saveNotes(NotesPutBody(cwd: "/p", text: "x", updatedAt: 1))
    } throws: { error in
      guard case .invalidResponse? = error as? TransportError else { return false }
      return true
    }
  }

  @Test("odmowy z kodem: 404 killswitcha, 400 katalogu, 413 ciała; bramka zgodności zatrzymuje zapis, nie odczyt")
  func refusals() async throws {
    let harness = MockHarness { request in
      if request.method == "PUT" { return .json(413, #"{"error":"too-large","message":"Za duże."}"#) }
      return request.path.contains("nie-ma")
        ? .json(400, #"{"error":"cwd-not-allowed","message":"Ten katalog nie jest na liście projektów."}"#)
        : .json(404, #"{"error":"not-found","message":"Nie znaleziono."}"#)
    }
    func status<T>(_ call: () async throws -> T) async -> (Int, String?)? {
      do {
        _ = try await call()
        return nil
      } catch {
        guard case let .http(failure)? = error as? TransportError else { return nil }
        return (failure.status, failure.code)
      }
    }
    #expect(await status { try await harness.client.notes(cwd: "/p") }.map { $0.0 } == 404)
    let bad = await status { try await harness.client.notes(cwd: "/nie-ma") }
    #expect(bad?.0 == 400 && bad?.1 == "cwd-not-allowed")
    #expect(await status { try await harness.client.saveNotes(NotesPutBody(cwd: "/p", text: "x", updatedAt: 0)) }?.0 == 413)

    let old = MockHarness(policy: IncompatiblePolicy()) { _ in .json(200, Self.doc) }
    _ = try await old.client.notes(cwd: "/p")
    await #expect {
      _ = try await old.client.saveNotes(NotesPutBody(cwd: "/p", text: "x", updatedAt: 0))
    } throws: { error in
      guard case .refused? = error as? TransportError else { return false }
      return true
    }
    #expect(old.requests.map(\.method) == ["GET"])
  }
}
