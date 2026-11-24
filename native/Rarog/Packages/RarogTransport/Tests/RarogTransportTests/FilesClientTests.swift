import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogTransport
import Testing

// Session files on the `URLProtocol` fake: the listing and index routes and the fetch of one file to a private copy,
// with the caller's limit, the length check and the copy deleted on every failure. Each test writes copies into its
// own directory, so parallel tests do not see each other's files. Owner: session files (native app).

private func golden(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

/// A 200 with the file's bytes; `length` = the announced `Content-Length` (`nil` = no header).
private func file(
  _ data: Data, length: Int?, after: MockURLProtocol.Reply.AfterChunks = .finish
) -> MockURLProtocol.Reply {
  var headers = ["Content-Type": "application/octet-stream", "Cache-Control": "no-store"]
  if let length { headers["Content-Length"] = String(length) }
  return MockURLProtocol.Reply(status: 200, headers: headers, chunks: data.isEmpty ? [] : [data], afterChunks: after)
}

/// A directory of its own for one test's copies, and what is left in it.
private struct CopyDirectory {
  let url = FileManager.default.temporaryDirectory.appending(
    path: "rarog-files-test-\(UUID().uuidString)", directoryHint: .isDirectory)

  var contents: [URL] {
    (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
  }

  func remove() {
    try? FileManager.default.removeItem(at: url)
  }

  /// Bytes on disk in the one copy (0 = no copy yet).
  var written: Int {
    guard let copy = contents.first,
      let size = try? FileManager.default.attributesOfItem(atPath: copy.path(percentEncoded: false))[.size] as? Int
    else { return 0 }
    return size
  }

  /// Waits until the fetch has created its copy (the body is still open).
  func waitForCopy() async throws {
    for _ in 0 ..< 400 where contents.isEmpty {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(contents.count == 1, "the fetch never created its copy")
  }
}

private func paired(_ handler: @escaping MockURLProtocol.Handler) -> MockHarness {
  MockHarness(device: testDevice, handler: handler)
}

@Suite("REST client: session files")
struct FilesClientTests {
  // MARK: Listing

  @Test("GET …/files?dir=: the directory is encoded byte for byte (+ % # space tab Unicode)")
  func listingRoute() async throws {
    let body = try golden("files.list.json")
    let harness = paired { _ in .json(200, body) }
    let dirs = ["", "src", "a+b/c d", "100%/#x", "tab\there", "cafe\u{301}/ż"]
    for dir in dirs {
      let listing = try await harness.client.sessionFiles(sessionId: "w0:d4", dir: dir)
      #expect(listing.maxBytes == 52_428_800)
      #expect(listing.entries.map(\.name) == ["dist", "docs", "src", "coverage.json", "package.json", "README.md"])
    }
    #expect(harness.requests.map { "\($0.method) \($0.path)" } == [
      "GET /api/sessions/w0%3Ad4/files?dir=",
      "GET /api/sessions/w0%3Ad4/files?dir=src",
      "GET /api/sessions/w0%3Ad4/files?dir=a%2Bb%2Fc%20d",
      "GET /api/sessions/w0%3Ad4/files?dir=100%25%2F%23x",
      "GET /api/sessions/w0%3Ad4/files?dir=tab%09here",
      // The decomposed accent stays decomposed: the server matches names byte for byte.
      "GET /api/sessions/w0%3Ad4/files?dir=cafe%CC%81%2F%C5%BC",
    ])
  }

  // MARK: Index

  @Test("GET …/files/index: the session id is encoded, the golden index decodes with its limit")
  func indexRoute() async throws {
    let body = try golden("files.index.json")
    let harness = paired { _ in .json(200, body) }
    let index = try await harness.client.sessionFileIndex(sessionId: "w0:d4")
    #expect(index.paths.first == "package.json")
    #expect(index.paths.contains("src/index.ts"))
    #expect(index.truncated == false)
    #expect(index.maxBytes == 52_428_800)
    #expect(harness.requests.map { "\($0.method) \($0.path)" } == ["GET /api/sessions/w0%3Ad4/files/index"])
  }

  // MARK: Fetch

  @Test("GET …/files/raw?path=: the copy holds the bytes, its name is a UUID with the path's extension")
  func fetchSavesCopy() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let bytes = Data("%PDF-1.7 brief".utf8)
    let harness = paired { _ in file(bytes, length: bytes.count) }
    let result = try await harness.client.fetchSessionFile(
      sessionId: "w0:d4", path: "docs/my brief+1.pdf", maxBytes: 1024, into: copies.url)
    guard case let .saved(url) = result else { Issue.record("not saved: \(result)"); return }
    #expect(try Data(contentsOf: url) == bytes)
    #expect(url.deletingLastPathComponent().standardizedFileURL == copies.url.standardizedFileURL)
    #expect(url.pathExtension == "pdf")
    #expect(UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil)
    let request = try #require(harness.requests.first)
    #expect("\(request.method) \(request.path)" == "GET /api/sessions/w0%3Ad4/files/raw?path=docs%2Fmy%20brief%2B1.pdf")
    #expect(request.header("Authorization") == testDeviceHeader && request.header("Origin") == nil)
    #expect(request.header("Accept-Encoding") == "identity")
  }

  @Test("a name without a usable extension gives a bare UUID copy")
  func copyWithoutExtension() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in file(Data("x".utf8), length: 1) }
    for path in ["Makefile", "notes.żółw", "dir.d/LICENSE"] {
      let result = try await harness.client.fetchSessionFile(sessionId: "s1", path: path, maxBytes: 10, into: copies.url)
      guard case let .saved(url) = result else { Issue.record("not saved: \(result)"); return }
      #expect(url.pathExtension == "", "\(path) → \(url.lastPathComponent)")
    }
  }

  @Test("the limit is the caller's maxBytes: exactly maxBytes is saved, maxBytes + 1 is refused without a copy")
  func limitFromCaller() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let exact = Data(repeating: 7, count: 200)
    let harness = paired { request in
      request.path.hasSuffix("exact.bin") ? file(exact, length: 200) : file(Data(), length: 201, after: .stayOpen)
    }
    let saved = try await harness.client.fetchSessionFile(sessionId: "s1", path: "exact.bin", maxBytes: 200, into: copies.url)
    guard case let .saved(url) = saved else { Issue.record("not saved: \(saved)"); return }
    #expect(try Data(contentsOf: url) == exact)
    try FileManager.default.removeItem(at: url)

    let refused = try await harness.client.fetchSessionFile(sessionId: "s1", path: "over.bin", maxBytes: 200, into: copies.url)
    #expect(refused == .tooLarge(size: 201, maxBytes: 200))
    #expect(copies.contents == [])
    // The refused body was still open: the request is cancelled, not read on.
    for _ in 0 ..< 400 where MockURLProtocol.held(port: harness.port) > 0 {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(MockURLProtocol.held(port: harness.port) == 0)
  }

  @Test("an empty file gives an empty copy")
  func emptyFile() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in file(Data(), length: 0) }
    let result = try await harness.client.fetchSessionFile(sessionId: "s1", path: "empty.txt", maxBytes: 10, into: copies.url)
    guard case let .saved(url) = result else { Issue.record("not saved: \(result)"); return }
    #expect(try Data(contentsOf: url) == Data())
  }

  @Test("a body shorter or longer than Content-Length, or none announced, is an error and leaves no copy")
  func lengthMismatch() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { request in
      if request.path.hasSuffix("short.txt") { return file(Data("hello".utf8), length: 10) }
      if request.path.hasSuffix("long.txt") { return file(Data("hello".utf8), length: 3) }
      return file(Data("hello".utf8), length: nil)
    }
    for path in ["short.txt", "long.txt", "unannounced.txt"] {
      let error = await #expect(throws: TransportError.self, "\(path)") {
        try await harness.client.fetchSessionFile(sessionId: "s1", path: path, maxBytes: 100, into: copies.url)
      }
      guard case .invalidResponse = error else { Issue.record("\(path): \(String(describing: error))"); continue }
    }
    #expect(copies.contents == [])
  }

  @Test("413 file-too-large gives the server's size and limit; a 413 outside the contract stays .http")
  func serverTooLarge() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let body = try golden("error.file-too-large.json")
    let harness = paired { request in
      request.path.hasSuffix("big.iso") ? .json(413, body) : .json(413, #"{"error":"payload-too-large","message":"x"}"#)
    }
    let result = try await harness.client.fetchSessionFile(sessionId: "s1", path: "big.iso", maxBytes: 100, into: copies.url)
    #expect(result == .tooLarge(size: 52_428_801, maxBytes: 52_428_800))
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.fetchSessionFile(sessionId: "s1", path: "odd.iso", maxBytes: 100, into: copies.url)
    }
    guard case let .http(failure) = error else { Issue.record("not .http: \(String(describing: error))"); return }
    #expect(failure.status == 413 && failure.code == "payload-too-large")
    #expect(copies.contents == [])
  }

  @Test("404 and 400 refusals keep the status and the code and leave no copy")
  func fetchRefusals() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let notFound = try golden("error.files-not-found.json")
    let badPath = try golden("error.files-bad-path.json")
    let harness = paired { request in request.path.hasSuffix("gone.txt") ? .json(404, notFound) : .json(400, badPath) }
    for (path, status, code) in [("gone.txt", 404, "not-found"), ("bad.txt", 400, "bad-path")] {
      let error = await #expect(throws: TransportError.self) {
        try await harness.client.fetchSessionFile(sessionId: "s1", path: path, maxBytes: 100, into: copies.url)
      }
      guard case let .http(failure) = error else { Issue.record("not .http: \(String(describing: error))"); continue }
      #expect(failure.status == status && failure.code == code)
    }
    #expect(copies.contents == [])
  }

  @Test("401 of the key goes to the refusal latch")
  func unauthorized() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in .json(401, #"{"error":"unauthorized","message":"Sign in again."}"#) }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.fetchSessionFile(sessionId: "s1", path: "a.txt", maxBytes: 100, into: copies.url)
    }
    guard case .unauthorized = error else { Issue.record("not .unauthorized: \(String(describing: error))"); return }
    #expect(harness.client.credentialRejection == .unknown(deviceId: testDevice.deviceId))
  }

  @Test("no connection before the answer and a connection lost mid-body are .offline and leave no copy")
  func offline() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { request in
      request.path.hasSuffix("down.txt")
        ? MockURLProtocol.Reply(error: URLError(.cannotConnectToHost))
        : file(Data("half".utf8), length: 8, after: .fail(URLError(.networkConnectionLost)))
    }
    let down = await #expect(throws: TransportError.self) {
      try await harness.client.fetchSessionFile(sessionId: "s1", path: "down.txt", maxBytes: 100, into: copies.url)
    }
    #expect(down == .offline(.cannotConnectToHost))
    let lost = await #expect(throws: TransportError.self) {
      try await harness.client.fetchSessionFile(sessionId: "s1", path: "lost.txt", maxBytes: 100, into: copies.url)
    }
    #expect(lost == .offline(.networkConnectionLost))
    #expect(copies.contents == [])
  }

  @Test("the client invalidated mid-body (the transport changes) ends the fetch .cancelled and deletes the copy")
  func invalidatedMidBody() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in file(Data("partial".utf8), length: 100, after: .stayOpen) }
    let client = harness.client
    let directory = copies.url
    let fetch = Task { try await client.fetchSessionFile(sessionId: "s1", path: "a.log", maxBytes: 1000, into: directory) }
    try await copies.waitForCopy()
    client.invalidate()
    let result = await fetch.result
    #expect(throws: TransportError.cancelled) { _ = try result.get() }
    #expect(copies.contents == [])
  }

  @Test("the caller's task cancelled mid-body ends the fetch .cancelled and deletes the copy")
  func cancelledMidBody() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in file(Data("partial".utf8), length: 100, after: .stayOpen) }
    let client = harness.client
    let directory = copies.url
    let fetch = Task { try await client.fetchSessionFile(sessionId: "s1", path: "a.log", maxBytes: 1000, into: directory) }
    try await copies.waitForCopy()
    fetch.cancel()
    let result = await fetch.result
    #expect(throws: TransportError.cancelled) { _ = try result.get() }
    #expect(copies.contents == [])
  }

  @Test("a binary body over several full 64 KB chunks and a partial last one arrives byte for byte")
  func largeBinary() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let bytes = Data((0 ..< 200_000).map { UInt8($0 % 251) })
    let chunks = [bytes.prefix(100_000), bytes.dropFirst(100_000).prefix(99_000), bytes.suffix(1_000)].map { Data($0) }
    let harness = paired { _ in
      MockURLProtocol.Reply(
        status: 200, headers: ["Content-Type": "application/octet-stream", "Content-Length": "200000"], chunks: chunks)
    }
    let result = try await harness.client.fetchSessionFile(
      sessionId: "s1", path: "build/app.bin", maxBytes: 1_000_000, into: copies.url)
    guard case let .saved(url) = result else { Issue.record("not saved: \(result)"); return }
    #expect(try Data(contentsOf: url) == bytes)
  }

  @Test("a connection lost after a full 64 KB chunk reached the copy deletes the partial copy")
  func lostAfterFullChunk() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in
      file(Data(repeating: 1, count: 70_000), length: 100_000, after: .fail(URLError(.networkConnectionLost)))
    }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.fetchSessionFile(sessionId: "s1", path: "a.bin", maxBytes: 1_000_000, into: copies.url)
    }
    #expect(error == .offline(.networkConnectionLost))
    #expect(copies.contents == [])
  }

  @Test("the caller's task cancelled after a full 64 KB chunk reached the copy deletes the partial copy")
  func cancelledAfterFullChunk() async throws {
    let copies = CopyDirectory()
    defer { copies.remove() }
    let harness = paired { _ in file(Data(repeating: 2, count: 70_000), length: 100_000, after: .stayOpen) }
    let client = harness.client
    let directory = copies.url
    let fetch = Task { try await client.fetchSessionFile(sessionId: "s1", path: "a.bin", maxBytes: 1_000_000, into: directory) }
    for _ in 0 ..< 400 where copies.written < 65_536 {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(copies.written >= 65_536, "no full chunk reached the copy")
    fetch.cancel()
    let result = await fetch.result
    #expect(throws: TransportError.cancelled) { _ = try result.get() }
    #expect(copies.contents == [])
  }
}
