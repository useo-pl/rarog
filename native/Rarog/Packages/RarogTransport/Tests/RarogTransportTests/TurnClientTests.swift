import Foundation
import RarogContract
import RarogTransport
import Testing

// Przerwanie, „obejrzane" i odczyty formularza nowej sesji na atrapie
// `URLProtocol`.

@Suite("klient REST: przerwanie, obejrzane i formularz nowej sesji")
struct TurnClientTests {
  @Test("POST …/interrupt: Origin, ciało {}, karta i los klawisza z 202; brak pól = starszy serwer")
  func interrupt() async throws {
    let session = #"{"id":"w0:d4","cwd":"/x","title":"x","state":"waiting-input","stateSince":"t","createdAt":"t","lastActivityAt":"t"}"#
    let harness = MockHarness { request in
      request.path.contains("w0%3Ad4")
        ? .json(202, #"{"ok":true,"session":\#(session),"delivered":"pending"}"#)
        : .json(202, #"{"ok":true}"#)
    }
    let reply = try await harness.client.interruptSession(sessionId: "w0:d4")
    #expect(reply.delivered == .pending && reply.session?.state == .waitingInput)
    let old = try await harness.client.interruptSession(sessionId: "s1")
    #expect(old.delivered == nil && old.session == nil)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/sessions/w0%3Ad4/interrupt")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    #expect(String(decoding: request.body ?? Data(), as: UTF8.self) == "{}")
  }

  @Test("przerwanie: nieznany los klawisza i ok:false odrzucają odpowiedź; odmowa 4xx ze zdaniem serwera")
  func interruptRejections() async {
    let unknown = MockHarness { _ in .json(202, #"{"ok":true,"delivered":"maybe"}"#) }
    await #expect(throws: TransportError.self) { _ = try await unknown.client.interruptSession(sessionId: "s") }
    let notOk = MockHarness { _ in .json(202, #"{"ok":false}"#) }
    await #expect(throws: TransportError.self) { _ = try await notOk.client.interruptSession(sessionId: "s") }
    let gate = MockHarness { _ in .json(409, #"{"error":"bad-state","message":"Wysyłka do herdr jest wyłączona."}"#) }
    do {
      _ = try await gate.client.interruptSession(sessionId: "s")
      Issue.record("odmowa powinna rzucić")
    } catch {
      #expect(error == .http(APIFailure(status: 409, code: "bad-state", message: "Wysyłka do herdr jest wyłączona.")))
    }
  }

  @Test("POST …/seen i …/unseen (200): `{ok:true}`; trasy z segmentem")
  func seen() async throws {
    let harness = MockHarness { _ in .json(200, #"{"ok":true}"#) }
    try await harness.client.markSeen(sessionId: "s 1")
    try await harness.client.markUnseen(sessionId: "s 1")
    #expect(harness.requests.map(\.path) == ["/api/sessions/s%201/seen", "/api/sessions/s%201/unseen"])
    #expect(harness.requests.allSatisfy { $0.method == "POST" && $0.header("Origin") != nil })
  }

  @Test("GET /api/fs: korzenie bez parametru, katalog zakodowany w zapytaniu; null w ścieżce i rodzicu")
  func directory() async throws {
    let harness = MockHarness { request in
      request.path == "/api/fs"
        ? .json(200, #"{"path":null,"parent":null,"entries":[{"name":"Projects","path":"/Users/d/Projects","git":false,"history":false}],"truncated":false}"#)
        : .json(200, #"{"path":"/Users/d/Projects","parent":null,"entries":[],"truncated":true}"#)
    }
    let roots = try await harness.client.directory(nil)
    #expect(roots.path == nil && roots.entries.map(\.name) == ["Projects"])
    let inside = try await harness.client.directory("/Users/d/Projects")
    #expect(inside.path == "/Users/d/Projects" && inside.truncated)
    #expect(harness.requests.map(\.path) == ["/api/fs", "/api/fs?path=%2FUsers%2Fd%2FProjects"])
    #expect(harness.requests.allSatisfy { $0.method == "GET" && $0.header("Origin") == nil })
  }

  @Test("listing spoza kontraktu: brak ścieżki, pusta nazwa wpisu")
  func directoryRejections() async {
    for body in [
      #"{"parent":null,"entries":[],"truncated":false}"#,
      #"{"path":null,"parent":null,"entries":[{"name":"","path":"/a","git":false,"history":false}],"truncated":false}"#,
    ] {
      let harness = MockHarness { _ in .json(200, body) }
      await #expect(throws: TransportError.self, "\(body)") { _ = try await harness.client.directory(nil) }
    }
  }

  @Test("POST /api/fs/mkdir: Origin, body {parent, name}, the new row from 200; a refusal is sent once, not retried")
  func makeDirectory() async throws {
    let harness = MockHarness { request in
      String(decoding: request.body ?? Data(), as: UTF8.self).contains("taken")
        ? .json(409, #"{"error":"dir-exists","message":"Something with that name already exists here."}"#)
        : .json(200, #"{"name":"notes","path":"/Users/d/Projects/notes","git":false,"history":false}"#)
    }
    let entry = try await harness.client.makeDirectory(MakeDirBody(parent: "/Users/d/Projects", name: "notes"))
    #expect(entry.path == "/Users/d/Projects/notes" && entry.git == false)
    let request = try #require(harness.requests.first)
    #expect(request.method == "POST" && request.path == "/api/fs/mkdir")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let body = try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String]
    #expect(body == ["parent": "/Users/d/Projects", "name": "notes"])
    do {
      _ = try await harness.client.makeDirectory(MakeDirBody(parent: "/Users/d/Projects", name: "taken"))
      Issue.record("a refusal should throw")
    } catch {
      #expect(error == .http(APIFailure(
        status: 409, code: "dir-exists", message: "Something with that name already exists here.")))
    }
    #expect(harness.requests.count == 2, "one request per call: the refusal is not retried")
  }

  @Test("GET /api/resumable i …/recent: katalog w zapytaniu")
  func resumable() async throws {
    let entry = #"{"engineSessionId":"e1","cwd":"/a b","mtime":"t","firstPrompt":"p","liveInHerdr":true,"title":"T"}"#
    let harness = MockHarness { _ in .json(200, #"{"sessions":[\#(entry)]}"#) }
    #expect(try await harness.client.resumable(cwd: "/a b").sessions.first?.liveInHerdr == true)
    #expect(try await harness.client.recentResumable(cwd: "/a b").sessions.count == 1)
    #expect(harness.requests.map(\.path) == ["/api/resumable?cwd=%2Fa%20b", "/api/resumable/recent?cwd=%2Fa%20b"])
  }
}
