import Darwin
import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// Stop of a send in flight (the stop in the progress ring): before the request a `cancelled` refusal with
// Retry and nothing sent, during the request Not confirmed that the echo still clears; the text never goes back to
// the field, and an attempt token keeps late results and progress of a stopped attempt off the entry.
// Owner: send.

private func sourceFile(_ name: String, _ data: Data) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-core-sources/\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let url = dir.appending(path: name)
  try data.write(to: url)
  return url
}

private func content(_ bytes: Int) -> Data {
  Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &* 31) })
}

private func picture(_ bytes: Int = 300) throws -> OutgoingAttachment {
  let data = content(bytes)
  return OutgoingAttachment(
    kind: .image, name: "IMG_0001.HEIC", mime: "image/jpeg", bytes: data.count, file: try sourceFile("photo.jpg", data))
}

/// Temporary body files of the entry (`rarog-send-<id>-….json`), which every attempt must remove.
private func bodyFiles(_ id: UUID) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)) ?? [])
    .filter { $0.hasPrefix("rarog-send-\(id.uuidString)") }
}

/// An echo of a photo message; `id: nil` = without `clientMessageId` (an older server, a rebuilt transcript).
private func echoFrame(_ text: String, seq: Int, id: UUID?, bytes: Int) -> String {
  let clientId = id.map { #""clientMessageId":"\#($0.uuidString.lowercased())","# } ?? ""
  return #"""
    {"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"user",
    "blocks":[{"type":"text","text":\#(Frames.quoted(text))}],"at":"\#(ISOTime.string(Date()))",\#(clientId)
    "attachments":[{"kind":"image","name":"","bytes":\#(bytes),"mime":"image/jpeg"}]}}
    """#
}

/// The transport's view of each send call: its progress report, whether it saw the cancellation, and a gate that
/// holds the call until the test opens it (a call that ignores cancellation answers late, as a slow server would).
private final class SendCalls: @unchecked Sendable {
  private let lock = NSLock()
  private var reporters: [@Sendable (UploadProgress) -> Void] = []
  private var cancelled: [Bool] = []
  private var open: Set<Int> = []
  private let honoursCancel: Bool

  init(honoursCancel: Bool) {
    self.honoursCancel = honoursCancel
  }

  /// The hook for `FakeTransport.onSendAsync`.
  var hook: @Sendable (SentBody, @escaping @Sendable (UploadProgress) -> Void) async -> Void {
    { [self] _, progress in
      let index = lock.withLock {
        reporters.append(progress)
        cancelled.append(false)
        return reporters.count - 1
      }
      // A deadline keeps a broken stop from hanging the suite: the call then simply answers.
      let deadline = ContinuousClock.now + .seconds(10)
      while !lock.withLock({ open.contains(index) }), ContinuousClock.now < deadline {
        if honoursCancel, Task.isCancelled { break }
        try? await Task.sleep(for: .milliseconds(2))
      }
      let seen = Task.isCancelled
      lock.withLock { cancelled[index] = seen }
    }
  }

  func report(_ call: Int, _ progress: UploadProgress) {
    let reporter = lock.withLock { reporters.indices.contains(call) ? reporters[call] : nil }
    reporter?(progress)
  }

  func release(_ call: Int) { _ = lock.withLock { open.insert(call) } }
  /// Whether call `call` reached the hook (its progress report can be used).
  func started(_ call: Int) -> Bool { lock.withLock { reporters.indices.contains(call) } }
  func sawCancel(_ call: Int) -> Bool { lock.withLock { cancelled.indices.contains(call) && cancelled[call] } }
}

/// The write end of a FIFO that stands in for the content file of an attachment. The body writer blocks on it, so
/// the test knows the encoding is under way and decides when the bytes come; it never sends an end of file.
private final class PayloadPipe: @unchecked Sendable {
  private var fd: Int32 = -1

  /// Replaces the content file with a FIFO.
  static func install(at url: URL) throws -> PayloadPipe {
    try FileManager.default.removeItem(at: url)
    guard mkfifo(url.path, 0o600) == 0 else { throw POSIXError(.EIO) }
    return PayloadPipe()
  }

  /// Opens the write end once the body writer holds the read end (a non-blocking open fails before that).
  @MainActor
  func connect(_ url: URL) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
      let opened = Darwin.open(url.path, O_WRONLY | O_NONBLOCK)
      if opened >= 0 {
        _ = fcntl(opened, F_SETNOSIGPIPE, 1)
        fd = opened
        return true
      }
      try? await Task.sleep(for: .milliseconds(2))
    }
    return false
  }

  /// Feeds `count` bytes, waiting while the pipe is full; stops early when the reader is gone.
  @MainActor
  func feed(_ count: Int) async {
    let chunk = [UInt8](repeating: 0x41, count: 16 * 1024)
    var left = count
    let deadline = ContinuousClock.now + .seconds(10)
    while left > 0, ContinuousClock.now < deadline {
      let written = chunk.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, min(left, chunk.count)) }
      if written > 0 {
        left -= written
      } else if errno == EAGAIN {
        try? await Task.sleep(for: .milliseconds(1))
      } else {
        return
      }
    }
  }

  func close() {
    if fd >= 0 { Darwin.close(fd) }
    fd = -1
  }
}

/// One encoding chunk of the body writer (`MessageBodyWriter.chunkBytes`).
private let writerChunk = 3 * 256 * 1024

@MainActor
@Suite("send: stop in the progress ring")
struct StoreSendCancelTests {
  @Test("stop while encoding → nothing sent, encoding stops, no body file, `cancelled` with Retry, payload kept")
  func stopWhileEncoding() async throws {
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let data = content(4 * writerChunk)
    let unsent = OutboxEntry(
      sessionId: "s1", text: "large photo", attachments: [.init(name: "", bytes: data.count, kind: .image, mime: "image/jpeg")],
      createdAt: Date(), state: .unconfirmed)
    let staged = try await persistence.stage(unsent, payloads: [try sourceFile("large.jpg", data)])
    let payload = try #require(persistence.payloadURL(staged, staged.attachments[0]))
    let pipe = try PayloadPipe.install(at: payload)
    defer { pipe.close() }
    let (store, transport) = try await readyStore(outbox: outbox)
    let id = staged.id
    #expect(store.state.outbox.first?.state == .unconfirmed)

    let first = Task { await store.retry(id) }
    await until("encoding") { store.state.sendProgress[id] == .encoding }
    #expect(await pipe.connect(payload), "the body writer opened the content file")
    // The task of the attempt itself: `retry` returns at the stop, the attempt ends when the writer sees it.
    let stoppedAttempt = try #require(store.sendFlights[id]?.task)
    store.cancelSend(id)
    #expect(store.state.outbox.first?.state == .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))
    #expect(store.state.sendProgress[id] == nil)
    #expect(store.state.outbox.first?.isRetryable == true)

    // One chunk only and no end of file: a writer that ignored the stop would wait for more bytes forever.
    await pipe.feed(writerChunk)
    let ended = Finished()
    Task { ended.set(await stoppedAttempt.value) }
    await until("the stopped attempt ends without the rest of the content") { ended.value != nil }
    pipe.close()
    #expect(ended.value == .refused(id, code: OutboxEntry.RefusalCode.cancelled, message: nil))
    #expect(await first.value == .refused(id, code: OutboxEntry.RefusalCode.cancelled, message: nil))
    #expect(transport.read { $0.messages.isEmpty }, "no request")
    #expect(bodyFiles(id).isEmpty, "temporary body removed: \(bodyFiles(id))")
    #expect(FileManager.default.fileExists(atPath: payload.path), "the content file stays for Retry")
    await store.flushPersistence()
    let saved = try JSONDecoder().decode(
      OutboxEntry.self, from: Data(contentsOf: outbox.appending(path: "\(id.uuidString).json")))
    #expect(saved.state == .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))

    // Retry after the stop: the same entry and id, accepted.
    try FileManager.default.removeItem(at: payload)
    try data.write(to: payload)
    #expect(await store.retry(id) == .accepted(id))
    #expect(transport.read { $0.messages.map(\.body.clientMessageId) } == [id.uuidString.lowercased()])
  }

  @Test("stop while uploading → the transport sees the cancellation, Not confirmed; the echo clears the entry")
  func stopWhileUploading() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    let calls = SendCalls(honoursCancel: true)
    transport.set { state in
      state.onSendAsync = calls.hook
      // What `RarogClient` throws when its task is cancelled.
      state.sendResult = .cancelled
    }
    let photo = try picture()
    let sending = Task { await store.send(text: "photo", attachments: [photo], to: "s1") }
    await until("request") { transport.read { $0.messages.count == 1 } }
    let id = try #require(store.state.outbox.first?.id)
    calls.report(0, .uploading(sent: 100, total: 1000))
    await until("uploading") { store.state.sendProgress[id] == .uploading(sent: 100, total: 1000) }

    store.cancelSend(id)
    #expect(store.state.outbox.first?.state == .unconfirmed)
    #expect(store.state.sendProgress[id] == nil)
    #expect(await sending.value == .unconfirmed(id))
    await until("the transport saw the cancellation") { calls.sawCancel(0) }

    transport.push(.session(id: "s1"), json: echoFrame("photo", seq: 3, id: id, bytes: 300))
    await until("echo") { store.state.echoed[id] == 3 }
    #expect(store.state.outbox.isEmpty)
    await store.flushPersistence()
    #expect(!FileManager.default.fileExists(atPath: outbox.appending(path: "\(id.uuidString).json").path))
  }

  @Test("stop while the transport waits before the first byte (still `.encoding`) → `cancelled`, the request cancelled")
  func stopWhileWaitingForTheTransport() async throws {
    let (store, transport) = try await readyStore()
    let calls = SendCalls(honoursCancel: true)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = .cancelled
    }
    let sending = Task { await store.send(text: "photo", attachments: [try picture()], to: "s1") }
    await until("the transport holds the request") { transport.read { $0.messages.count == 1 } }
    let id = try #require(store.state.outbox.first?.id)
    #expect(store.state.sendProgress[id] == .encoding, "no byte reported yet")
    let stoppedAttempt = try #require(store.sendFlights[id]?.task)

    store.cancelSend(id)
    let cancelled = SendOutcome.refused(id, code: OutboxEntry.RefusalCode.cancelled, message: nil)
    #expect(store.state.outbox.first?.state == .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))
    #expect(store.state.outbox.first?.isRetryable == true)
    #expect(store.state.sendProgress[id] == nil)
    #expect(try await sending.value == cancelled)
    #expect(await stoppedAttempt.value == cancelled)
    await until("the waiting request was cancelled") { calls.sawCancel(0) }
    #expect(store.state.outbox.first?.state == .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))
  }

  @Test("a byte reported, then the stop at once, before the report reaches the main actor → Not confirmed")
  func stopRightAfterTheFirstByte() async throws {
    let (store, transport) = try await readyStore()
    let calls = SendCalls(honoursCancel: true)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = .cancelled
    }
    let sending = Task { await store.send(text: "photo", attachments: [try picture()], to: "s1") }
    await until("the transport holds the request") { calls.started(0) }
    let id = try #require(store.state.outbox.first?.id)
    #expect(store.state.sendProgress[id] == .encoding)

    // The transport reports a byte sent and the stop comes in the same main-actor turn: the progress report has not
    // reached the entry yet, but the body may already be on the server.
    calls.report(0, .uploading(sent: 100, total: 1000))
    store.cancelSend(id)
    #expect(store.state.outbox.first?.state == .unconfirmed)
    #expect(try await sending.value == .unconfirmed(id))
    await until("the transport saw the cancellation") { calls.sawCancel(0) }
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.sendProgress[id] == nil, "the late progress report does not bring the ring back")
  }

  @Test("an echo without an id clears the sent entry with that content, not an older one stopped before the request")
  func stoppedEntryTakesOnlyItsOwnEcho() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    let calls = SendCalls(honoursCancel: true)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = .cancelled
    }
    let first = Task { await store.send(text: "photo", attachments: [try picture()], to: "s1") }
    await until("A at the transport") { calls.started(0) }
    let a = try #require(store.state.outbox.first?.id)
    store.cancelSend(a)
    #expect(try await first.value == .refused(a, code: OutboxEntry.RefusalCode.cancelled, message: nil))

    transport.set { state in
      state.onSendAsync = nil
      state.sendResult = nil
    }
    guard case let .accepted(b) = await store.send(text: "photo", attachments: [try picture()], to: "s1") else {
      Issue.record("B not accepted")
      return
    }
    transport.push(.session(id: "s1"), json: echoFrame("photo", seq: 3, id: nil, bytes: 300))
    await until("the echo of B") { !store.state.outbox.contains { $0.id == b } }
    #expect(store.state.outbox.map(\.id) == [a], "A stays")
    await store.flushPersistence()
    let stopped = try #require(store.state.outbox.first)
    let file = try #require(stopped.attachments.first?.file)
    let payload = try #require(store.outboxPayloadURL(entry: a, file: file))
    #expect(FileManager.default.fileExists(atPath: payload.path), "A keeps its content for Retry")
    #expect(FileManager.default.fileExists(atPath: outbox.appending(path: "\(a.uuidString).json").path))
  }

  @Test("stop, Retry at once, the first attempt answers 202 late → no effect; the state is the second attempt's")
  func lateAcceptanceOfStoppedAttempt() async throws {
    try await lateResultOfStoppedAttempt(nil)
  }

  @Test("stop, Retry at once, the first attempt fails late → no effect; the state is the second attempt's")
  func lateFailureOfStoppedAttempt() async throws {
    try await lateResultOfStoppedAttempt(.timedOut)
  }

  private func lateResultOfStoppedAttempt(_ late: TransportError?) async throws {
    let (store, transport) = try await readyStore()
    let calls = SendCalls(honoursCancel: false)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = late
    }
    let photo = try picture()
    let first = Task { await store.send(text: "photo", attachments: [photo], to: "s1") }
    await until("first request") { transport.read { $0.messages.count == 1 } }
    let id = try #require(store.state.outbox.first?.id)
    calls.report(0, .uploading(sent: 100, total: 1000))
    await until("uploading") { store.state.sendProgress[id] == .uploading(sent: 100, total: 1000) }
    let stoppedAttempt = try #require(store.sendFlights[id]?.task)
    store.cancelSend(id)
    #expect(store.state.outbox.first?.state == .unconfirmed)
    #expect(await first.value == .unconfirmed(id), "the send returns the stop's outcome at once")

    transport.set { $0.sendResult = nil }
    let second = Task { await store.retry(id) }
    await until("second request") { transport.read { $0.messages.count == 2 } }
    #expect(store.state.outbox.first?.state == .queued)
    #expect(store.state.sendProgress[id] == .encoding)

    // Progress of the first attempt, then its result: neither touches the entry of the second.
    calls.report(0, .uploading(sent: 900, total: 1000))
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.sendProgress[id] == .encoding, "late progress of the stopped attempt")
    calls.release(0)
    #expect(await stoppedAttempt.value == .unconfirmed(id), "the stopped attempt ends with the stop's outcome")
    #expect(store.state.outbox.first?.state == .queued, "late result of the stopped attempt")

    calls.report(1, .uploading(sent: 500, total: 1000))
    await until("second progress") { store.state.sendProgress[id] == .uploading(sent: 500, total: 1000) }
    calls.release(1)
    #expect(await second.value == .accepted(id))
    #expect(store.state.outbox.first?.state.isSent == true)
    let ids = transport.read { $0.messages.map(\.body.clientMessageId) }
    #expect(ids == [id.uuidString.lowercased(), id.uuidString.lowercased()], "Retry sends the same id")
  }

  @Test("stop during a Retry, Retry at once while the stopped attempt still runs → the second attempt goes out")
  func retryAtOnceAfterStoppedRetry() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "photo", attachments: [try picture()], to: "s1") else {
      Issue.record("not unconfirmed")
      return
    }
    // The transport ignores the cancellation for a while, as a closing upload connection can.
    let calls = SendCalls(honoursCancel: false)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = nil
    }
    let first = Task { await store.retry(id) }
    await until("first Retry request") { transport.read { $0.messages.count == 2 } }
    calls.report(0, .uploading(sent: 100, total: 1000))
    await until("uploading") { store.state.sendProgress[id] == .uploading(sent: 100, total: 1000) }
    let stoppedAttempt = try #require(store.sendFlights[id]?.task)
    store.cancelSend(id)
    // The stopped Retry ends with the stop while its attempt still waits in the transport (call 0 is not released),
    // so the next Retry is not held by the first one.
    let finished = Finished()
    Task { finished.set(await first.value) }
    await until("the stopped Retry ends", timeout: .seconds(3)) { finished.value != nil }
    #expect(finished.value == .unconfirmed(id))
    let second = Task { await store.retry(id) }
    await until("second Retry request", timeout: .seconds(3)) { transport.read { $0.messages.count == 3 } }
    #expect(store.state.outbox.first?.state == .queued)
    calls.release(0)
    #expect(await stoppedAttempt.value == .unconfirmed(id))
    #expect(store.state.outbox.first?.state == .queued, "late result of the stopped attempt")
    calls.release(1)
    #expect(await second.value == .accepted(id))
    #expect(store.state.outbox.first?.state.isSent == true)
  }

  @Test("Retry after a stop during the request → the same id and bytes, accepted")
  func retryAfterStop() async throws {
    let (store, transport) = try await readyStore()
    let calls = SendCalls(honoursCancel: true)
    transport.set { state in
      state.onSendAsync = calls.hook
      state.sendResult = .cancelled
    }
    let photo = try picture()
    let sending = Task { await store.send(text: "two", attachments: [photo], to: "s1") }
    await until("request") { transport.read { $0.messages.count == 1 } }
    let id = try #require(store.state.outbox.first?.id)
    calls.report(0, .awaitingResponse)
    await until("awaiting the response") { store.state.sendProgress[id] == .awaitingResponse }
    store.cancelSend(id)
    #expect(await sending.value == .unconfirmed(id))
    await until("the stop cancelled the request") { calls.sawCancel(0) }

    transport.set { state in
      state.onSendAsync = nil
      state.sendResult = nil
    }
    #expect(await store.retry(id) == .accepted(id))
    let bodies = transport.read { $0.messages.map(\.body) }
    #expect(bodies.count == 2)
    #expect(bodies[0] == bodies[1], "the same id and the same content")
    #expect(bodies[1].clientMessageId == id.uuidString.lowercased())
  }

  @Test("stop for an accepted, unknown, Not confirmed or refused entry → nothing")
  func nothingToStop() async throws {
    let (store, transport) = try await readyStore()
    guard case let .accepted(accepted) = await store.send(text: "accepted", to: "s1") else {
      Issue.record("not accepted")
      return
    }
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(unconfirmed) = await store.send(text: "lost", to: "s1") else {
      Issue.record("not unconfirmed")
      return
    }
    transport.set { $0.sendResult = .http(APIFailure(status: 413, code: "payload-too-large", message: "Too large.")) }
    guard case let .refused(refused, _, _) = await store.send(text: "large", to: "s1") else {
      Issue.record("not refused")
      return
    }
    let before = store.state.outbox
    for id in [accepted, UUID(), unconfirmed, refused] { store.cancelSend(id) }
    #expect(store.state.outbox == before)
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.outbox == before)
    transport.set { $0.sendResult = nil }
    #expect(await store.retry(unconfirmed) == .accepted(unconfirmed), "Retry still works")
  }

  @Test("a `cancelled` entry yields to the echo of its id: an earlier attempt may have arrived")
  func cancelledEntryTakesItsEcho() throws {
    let entry = OutboxEntry(
      sessionId: "s1", text: "photo", attachments: [.init(name: "", bytes: 300, kind: .image, mime: "image/jpeg")],
      createdAt: Date(), state: .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil))
    var refused = entry
    refused.state = .refused(code: "payload-too-large", message: nil)
    let message = try JSONDecoder().decode(TranscriptMessage.self, from: Data(#"""
      {"seq":3,"role":"user","blocks":[{"type":"text","text":"photo"}],"at":"\#(ISOTime.string(Date()))",
       "clientMessageId":"\#(entry.clientMessageId)",
       "attachments":[{"kind":"image","name":"","bytes":300,"mime":"image/jpeg"}]}
      """#.utf8))
    #expect(EchoMatching.matchIndex(in: [entry], sessionId: "s1", message: message, serverStartId: "s", skew: .seconds(60)) == 0)
    #expect(EchoMatching.matchIndex(in: [refused], sessionId: "s1", message: message, serverStartId: "s", skew: .seconds(60)) == nil)
  }
}

/// The outcome of a send task, for waiting with `until`.
@MainActor
private final class Finished {
  private(set) var value: SendOutcome?
  func set(_ outcome: SendOutcome) { value = outcome }
}
