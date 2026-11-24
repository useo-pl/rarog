import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// Wysyłka: identyfikator wpisu (`clientMessageId`), załączniki w kolejce v2, postęp przesyłu.

private func payloadSource(_ name: String, _ data: Data) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-core-sources/\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let url = dir.appending(path: name)
  try data.write(to: url)
  return url
}

private func listing(_ directory: URL) -> [String] {
  guard let walker = FileManager.default.enumerator(atPath: directory.path) else { return [] }
  return walker.compactMap { $0 as? String }.sorted()
}

private func photo(_ bytes: Int = 300) throws -> OutgoingAttachment {
  let data = Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &* 31) })
  return OutgoingAttachment(kind: .image, name: "IMG_0001.HEIC", mime: "image/jpeg", bytes: data.count,
                            file: try payloadSource("zdjecie.jpg", data))
}

private func document(_ name: String = "raport.pdf", bytes: Int = 120) throws -> OutgoingAttachment {
  let data = Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ 3) })
  return OutgoingAttachment(kind: .file, name: name, mime: "application/pdf", bytes: data.count,
                            file: try payloadSource(name, data))
}

private func echo(_ text: String, seq: Int, id: String?, attachments: String = "") -> String {
  let idField = id.map { #","clientMessageId":"\#($0)""# } ?? ""
  let attachmentsField = attachments.isEmpty ? "" : #","attachments":[\#(attachments)]"#
  return #"""
    {"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"user",
    "blocks":[{"type":"text","text":\#(Frames.quoted(text))}],"at":"\#(ISOTime.string(Date()))"\#(idField)\#(attachmentsField)}}
    """#
}

@MainActor
@Suite("wysyłka z clientMessageId: identyfikator, powtórka, konflikt")
struct StoreSendClientMessageIdTests {
  @Test("identyfikator wpisu = clientMessageId w ciele (małe litery); sam tekst z limitem domyślnym")
  func idInBody() async throws {
    let (store, transport) = try await readyStore()
    guard case let .accepted(id) = await store.send(text: "zrób testy", to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    let body = try #require(transport.read { $0.messages.first?.body })
    #expect(body.clientMessageId == id.uuidString.lowercased())
    #expect(body.images == nil && body.files == nil)
    #expect(transport.read { $0.sendTimeouts } == [nil])
  }

  @Test("„Ponów” wysyła TEN SAM identyfikator i te same bajty (także z załącznikami)")
  func retrySameBytes() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "z plikiem", attachments: [try photo(), try document()], to: "s1")
    else {
      Issue.record("brak unconfirmed")
      return
    }
    transport.set { $0.sendResult = nil }
    #expect(await store.retry(id) == .accepted(id))
    let bodies = transport.read { $0.messages.map(\.body) }
    #expect(bodies.count == 2)
    #expect(bodies[0] == bodies[1], "ponowienie = te same bajty treści i ten sam identyfikator")
    #expect(bodies[1].clientMessageId == id.uuidString.lowercased())
  }

  @Test("echo z identyfikatorem PRZED odpowiedzią 202 gasi wpis; pliki znikają, „Nie potwierdzono” nie przychodzi")
  func echoBeforeAccepted() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { state in
      state.onSend = { [weak transport] _, body in
        transport?.push(.session(id: "s1"), json: echo("przed 202", seq: 3, id: body.clientMessageId))
      }
    }
    // Echo przychodzi strumieniem, a odpowiedź 202 czeka, aż reduktor je zobaczy.
    transport.set { state in
      state.onSendAsync = { _, _ in try? await Task.sleep(for: .milliseconds(50)) }
    }
    guard case let .accepted(id) = await store.send(text: "przed 202", attachments: [try photo()], to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    await until("echo") { store.state.echoed[id] == 3 }
    #expect(store.state.outbox.isEmpty)
    #expect(store.state.sendProgress.isEmpty)
    // The message carries a photo, so the countdown after 202 is the attachment one.
    try await Task.sleep(for: fastTiming.attachmentUnconfirmedAfter + .milliseconds(50))
    #expect(store.state.outbox.isEmpty, "spóźnione 202 i odliczanie nie wskrzeszają wpisu")
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty, "manifest i katalog treści skasowane")
  }

  @Test("202 `replayed:true` bez echa → wpis gaśnie jako przyjęty, razem z plikami")
  func replayedWithoutEcho() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .timedOut }
    guard case let .unconfirmed(id) = await store.send(text: "doszła?", attachments: [try document()], to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    transport.set { state in
      state.sendResult = nil
      state.sendReply = #"{"ok":true,"clientMessageId":"\#(id.uuidString.lowercased())","replayed":true}"#
    }
    #expect(await store.retry(id) == .accepted(id))
    #expect(store.state.outbox.isEmpty)
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  @Test("409 client-id-conflict → odmowa z kodem, bez „Ponów” (isRetryable false, retry ignorowane)")
  func conflict() async throws {
    let (store, transport) = try await readyStore()
    transport.set {
      $0.sendResult = .http(APIFailure(status: 409, code: "client-id-conflict", message: "Ten identyfikator ma inną treść."))
    }
    guard case let .refused(id, code, _) = await store.send(text: "x", to: "s1") else {
      Issue.record("brak refused")
      return
    }
    #expect(code == OutboxEntry.RefusalCode.clientIdConflict)
    #expect(store.state.outbox.first?.isRetryable == false)
    transport.set { $0.sendResult = nil }
    #expect(await store.retry(id) == .ignored)
    #expect(transport.read { $0.messages.count } == 1)
  }

  @Test("starszy serwer: 202 `{ok:true}` i echo bez identyfikatora → dopasowanie po podpisie")
  func oldServer() async throws {
    let (store, transport) = try await readyStore()
    transport.set { $0.sendReply = #"{"ok":true}"# }
    guard case let .accepted(id) = await store.send(text: "stary serwer", to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    #expect(store.state.outbox.first?.state.isSent == true)
    transport.push(.session(id: "s1"), json: echo("stary serwer", seq: 3, id: nil))
    await until("echo po podpisie") { store.state.echoed[id] == 3 }
  }
}

@MainActor
@Suite("wysyłka z załącznikami: kolejka v2 na dysku")
struct StoreAttachmentTests {
  @Test("pliki treści w `<id>/` PRZED żądaniem; zdjęcia przed plikami; zdjęcie bez nazwy; limit 200 s")
  func stagedBeforeRequest() async throws {
    let outbox = temporaryOutbox()
    let transport = FakeTransport()
    let seen = SeenListing()
    transport.set { state in
      state.onSend = { _, _ in seen.set(listing(outbox)) }
    }
    let (store, _) = try await readyStore(transport: transport, outbox: outbox)
    let file = try document("log.txt")
    let image = try photo()
    guard case let .accepted(id) = await store.send(text: "", attachments: [file, image], to: "s1") else {
      Issue.record("sam załącznik bez tekstu to poprawna wiadomość")
      return
    }
    #expect(Set(seen.value) == ["\(id.uuidString)", "\(id.uuidString)/0.jpg", "\(id.uuidString)/1.txt", "\(id.uuidString).json"])
    let entry = try #require(store.state.outbox.first)
    #expect(entry.attachments.map(\.kind) == [.image, .file])
    #expect(entry.attachments.map(\.name) == ["", "log.txt"], "zdjęcie na drucie nazwy nie ma (podpis echa)")
    let body = try #require(transport.read { $0.messages.first?.body })
    #expect(body.text == "")
    let imageBytes = try Data(contentsOf: image.file)
    let fileBytes = try Data(contentsOf: file.file)
    let sentImage = try #require(body.images?.first)
    let sentFile = try #require(body.files?.first)
    #expect(SentBody.content(sentImage) == imageBytes)
    #expect(sentFile.name == "log.txt")
    #expect(SentBody.content(sentFile.dataUrl) == fileBytes)
    #expect(body.images?.first?.hasPrefix("data:image/jpeg;base64,") == true)
    #expect(transport.read { $0.sendTimeouts } == [RarogStore.attachmentSendTimeout])
    // Plik wołającego zostaje (odmowa oddaje załączniki do pola).
    #expect(FileManager.default.fileExists(atPath: image.file.path))
  }

  @Test("echo z wizytówkami załączników gasi wpis po podpisie (bez identyfikatora) i kasuje pliki")
  func echoWithAttachments() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendReply = #"{"ok":true}"# }
    let image = try photo(300)
    let file = try document("raport.pdf", bytes: 120)
    guard case let .accepted(id) = await store.send(text: "zobacz", attachments: [image, file], to: "s1") else {
      Issue.record("brak accepted")
      return
    }
    transport.push(.session(id: "s1"), json: echo("zobacz", seq: 4, id: nil, attachments: #"""
      {"kind":"image","name":"","bytes":300,"mime":"image/jpeg"},
      {"kind":"file","name":"raport.pdf","bytes":120,"mime":"application/pdf"}
      """#))
    await until("echo") { store.state.echoed[id] == 4 }
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  @Test("„Odrzuć” sprząta manifest i katalog treści")
  func discardCleansPayloads() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .http(APIFailure(status: 413, code: "payload-too-large", message: "Za duże.")) }
    guard case let .refused(id, _, _) = await store.send(text: "x", attachments: [try photo()], to: "s1") else {
      Issue.record("brak refused")
      return
    }
    await store.flushPersistence()
    #expect(listing(outbox).count == 3)
    store.discard(id)
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  @Test("plik treści wpisu dla miniatury w drodze: ten sam, który idzie w ciele; nazwa ze ścieżką odrzucona")
  func payloadURLForThumbnail() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .http(APIFailure(status: 413, code: "payload-too-large", message: "Za duże.")) }
    let image = try photo(300)
    _ = await store.send(text: "", attachments: [image], to: "s1")
    let entry = try #require(store.state.outbox.first)
    let file = try #require(entry.attachments.first?.file)
    let url = try #require(store.outboxPayloadURL(entry: entry.id, file: file))
    #expect(try Data(contentsOf: url) == Data(contentsOf: image.file), "miniatura czyta bajty wpisu z kolejki")
    for bad in ["", ".", "..", "../\(entry.id.uuidString).json", "a/b.jpg"] {
      #expect(store.outboxPayloadURL(entry: entry.id, file: bad) == nil, "\(bad)")
    }
  }

  @Test("plik źródłowy zniknął przed „Wyślij” → nic nie wychodzi, bez manifestu i bez katalogu treści")
  func stageFailure() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    var missing = try photo()
    missing.file = missing.file.deletingLastPathComponent().appending(path: "nie-ma.jpg")
    guard case .notPersisted = await store.send(text: "x", attachments: [missing], to: "s1") else {
      Issue.record("oczekiwano notPersisted")
      return
    }
    #expect(transport.read { $0.messages.isEmpty })
    #expect(store.state.outbox.isEmpty)
    #expect(listing(outbox).isEmpty)
  }

  @Test("plik treści zniknął z kolejki przed „Ponów” → odmowa bez żądania, bez „Ponów”")
  func payloadVanishedBeforeRetry() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "x", attachments: [try photo()], to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    await store.flushPersistence()
    try FileManager.default.removeItem(at: outbox.appending(path: "\(id.uuidString)/0.jpg"))
    transport.set { $0.sendResult = nil }
    #expect(await store.retry(id) == .refused(id, code: OutboxEntry.RefusalCode.attachmentMissing, message: nil))
    #expect(transport.read { $0.messages.count } == 1, "ponowienie nie wyszło")
    #expect(store.state.outbox.first?.isRetryable == false)
  }

  @Test("ciało pada po pierwszym załączniku → częściowy plik ciała nie zostaje ani po odmowie, ani po „Odrzuć”")
  func partialBodyRemoved() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    transport.set { $0.sendResult = .offline(.networkConnectionLost) }
    guard case let .unconfirmed(id) = await store.send(text: "dwa", attachments: [try photo(), try document()], to: "s1") else {
      Issue.record("brak unconfirmed")
      return
    }
    await store.flushPersistence()
    // Zdjęcie (część 0) jest, plik (część 1) zniknął: składanie ciała pada w połowie.
    try FileManager.default.removeItem(at: outbox.appending(path: "\(id.uuidString)/1.pdf"))
    transport.set { $0.sendResult = nil }
    #expect(await store.retry(id) == .refused(id, code: OutboxEntry.RefusalCode.attachmentMissing, message: nil))
    let bodies = {
      ((try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)) ?? [])
        .filter { $0.hasPrefix("rarog-send-\(id.uuidString)") }
    }
    #expect(bodies().isEmpty, "częściowe ciało po odmowie: \(bodies())")
    store.discard(id)
    await store.flushPersistence()
    #expect(bodies().isEmpty, "częściowe ciało po „Odrzuć”: \(bodies())")
  }
}

@MainActor
@Suite("kolejka po restarcie apki: v1, sieroty, brak pliku")
struct OutboxRecoveryTests {
  @Test("awaria między plikami treści a manifestem: katalog bez manifestu znika przy starcie")
  func orphanRemoved() async throws {
    let outbox = temporaryOutbox()
    let orphan = outbox.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
    try Data("treść".utf8).write(to: orphan.appending(path: "0.jpg"))
    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    #expect(store.state.outbox.isEmpty)
    #expect(listing(outbox).isEmpty)
  }

  @Test("zapis manifestu pada przy zakładaniu wpisu → katalog treści sprzątnięty od razu")
  func manifestFailureCleansPayloads() async throws {
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let entry = OutboxEntry(sessionId: "s1", text: "x", attachments: [.init(name: "", bytes: 3, kind: .image)], createdAt: Date())
    // Katalog w miejscu pliku manifestu: zapis atomowy musi paść.
    try FileManager.default.createDirectory(
      at: outbox.appending(path: "\(entry.id.uuidString).json/zajete"), withIntermediateDirectories: true)
    await #expect(throws: (any Error).self) {
      try await persistence.stage(entry, payloads: [try payloadSource("a.jpg", Data([1, 2, 3]))])
    }
    #expect(!FileManager.default.fileExists(atPath: persistence.payloadDirectory(entry.id).path))
  }

  @Test("brak jednego pliku treści → wpis wraca jako odmowa bez „Ponów”; „Odrzuć” sprząta resztę")
  func missingPayload() async throws {
    let outbox = temporaryOutbox()
    let persistence = OutboxPersistence(directory: outbox)
    let entry = OutboxEntry(
      sessionId: "s1", text: "dwa pliki",
      attachments: [.init(name: "", bytes: 3, kind: .image), .init(name: "a.txt", bytes: 2, mime: "text/plain")],
      createdAt: Date(), state: .unconfirmed)
    let staged = try await persistence.stage(
      entry, payloads: [try payloadSource("a.jpg", Data([1, 2, 3])), try payloadSource("a.txt", Data([4, 5]))])
    try FileManager.default.removeItem(at: try #require(persistence.payloadURL(staged, staged.attachments[1])))

    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    let restored = try #require(store.state.outbox.first)
    #expect(restored.state == .refused(code: OutboxEntry.RefusalCode.attachmentMissing, message: nil))
    #expect(!restored.isRetryable)
    #expect(await store.retry(restored.id) == .ignored)
    store.discard(restored.id)
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  @Test("manifest v1 (sam tekst) czytany; ponowny zapis już jako v2")
  func readsVersionOne() async throws {
    let outbox = temporaryOutbox()
    try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
    let id = UUID()
    // Dokładnie format v1 (`sortedKeys`, daty jako sekundy od 2001).
    let v1 = #"""
      {"attachments":[],"createdAt":781000000,"id":"\#(id.uuidString)","sessionId":"s1",
      "state":{"queued":{}},"text":"z formatu v1","version":1}
      """#
    try Data(v1.utf8).write(to: outbox.appending(path: "\(id.uuidString).json"))
    let (store, _) = makeStore(outbox: outbox)
    await store.start()
    #expect(store.state.outbox.map(\.text) == ["z formatu v1"])
    #expect(store.state.outbox.first?.state == .unconfirmed)
    let saved = try JSONDecoder().decode(OutboxEntry.self, from: Data(contentsOf: outbox.appending(path: "\(id.uuidString).json")))
    #expect(saved.version == 2)
  }

  @Test("nowsza wersja formatu niż znana → pominięta, nie przewraca startu")
  func skipsNewerVersion() async throws {
    let outbox = temporaryOutbox()
    try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
    let id = UUID()
    let v9 = #"""
      {"attachments":[],"createdAt":781000000,"id":"\#(id.uuidString)","sessionId":"s1",
      "state":{"queued":{}},"text":"z przyszłości","version":9}
      """#
    try Data(v9.utf8).write(to: outbox.appending(path: "\(id.uuidString).json"))
    let load = await OutboxPersistence(directory: outbox).loadAll()
    #expect(load.entries.isEmpty)
    #expect(load.skipped == 1)
  }
}

@MainActor
@Suite("postęp wysyłki z załącznikiem")
struct StoreProgressTests {
  @Test("kodowanie → przesyłanie (bajty) → oczekiwanie na odpowiedź → po 202 pasek znika")
  func phases() async throws {
    let (store, transport) = try await readyStore()
    let valve = Valve()
    let reporter = ReporterBox()
    transport.set { state in
      state.onSendAsync = { _, progress in
        reporter.set(progress)
        await valve.wait()
      }
    }
    let big = try photo(5000)
    let sending = Task { await store.send(text: "duże", attachments: [big], to: "s1") }
    await until("żądanie w drodze") { transport.read { $0.messages.count == 1 } }
    let id = try #require(store.state.outbox.first?.id)
    #expect(store.state.sendProgress[id] == .encoding, "do pierwszego raportu przesyłu: kodowanie")
    let report = try #require(reporter.value)
    report(.uploading(sent: 2000, total: 8000))
    await until("przesyłanie") { store.state.sendProgress[id] == .uploading(sent: 2000, total: 8000) }
    // Ten sam pełny procent nie odświeża stanu (bez lawiny renderów).
    report(.uploading(sent: 2010, total: 8000))
    report(.awaitingResponse)
    await until("oczekiwanie na odpowiedź") { store.state.sendProgress[id] == .awaitingResponse }
    await valve.release()
    #expect(await sending.value == .accepted(id))
    #expect(store.state.sendProgress[id] == nil)
    // Spóźniony raport po 202 nie wskrzesza paska.
    report(.uploading(sent: 8000, total: 9000))
    try await Task.sleep(for: .milliseconds(30))
    #expect(store.state.sendProgress[id] == nil)
  }
}

// `fastTiming` scales one second to 10 ms: text 15 s → 150 ms, attachments 120 s → 1200 ms, so 75 s → 750 ms.
@MainActor
@Suite("send: \"Not confirmed\" deadline after 202")
struct StoreSendTests {
  private static let seventyFiveSeconds: Duration = .milliseconds(750)

  @Test("attachment accepted with 202, echo 75 s later → the entry is never `.unconfirmed`")
  func attachmentLateEcho() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    let seen = SeenStates()
    let watch = Task { @MainActor in
      while !Task.isCancelled {
        if let state = store.state.outbox.first?.state { seen.add(state) }
        try? await Task.sleep(for: .milliseconds(5))
      }
    }
    defer { watch.cancel() }
    guard case let .accepted(id) = await store.send(text: "photo", attachments: [try photo()], to: "s1") else {
      Issue.record("not accepted")
      return
    }
    try await Task.sleep(for: Self.seventyFiveSeconds)
    #expect(store.state.outbox.first?.state.isSent == true, "past the text deadline, still waiting for the echo")
    transport.push(.session(id: "s1"), json: echo(
      "photo", seq: 3, id: id.uuidString.lowercased(),
      attachments: #"{"kind":"image","name":"","bytes":300,"mime":"image/jpeg"}"#))
    await until("echo") { store.state.echoed[id] == 3 }
    #expect(store.state.outbox.isEmpty)
    #expect(!seen.states.contains(.unconfirmed), "a late echo must not be preceded by \"Not confirmed\"")
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  @Test("attachment accepted with 202, no echo → `.unconfirmed` 120 s after 202, not earlier; a late echo still clears it")
  func attachmentNoEcho() async throws {
    let outbox = temporaryOutbox()
    let (store, transport) = try await readyStore(outbox: outbox)
    guard case let .accepted(id) = await store.send(text: "photo", attachments: [try photo()], to: "s1") else {
      Issue.record("not accepted")
      return
    }
    let accepted = ContinuousClock.now
    try await Task.sleep(for: Self.seventyFiveSeconds)
    #expect(store.state.outbox.first?.state.isSent == true)
    await until("unconfirmed") { store.state.outbox.first?.state == .unconfirmed }
    #expect(ContinuousClock.now - accepted >= fastTiming.attachmentUnconfirmedAfter - .milliseconds(20))
    await store.flushPersistence()
    let stored = try JSONDecoder().decode(
      OutboxEntry.self, from: Data(contentsOf: outbox.appending(path: "\(id.uuidString).json")))
    #expect(stored.state == .unconfirmed)
    // The echo that arrives after "Not confirmed" still clears the entry and its payload files.
    transport.push(.session(id: "s1"), json: echo(
      "photo", seq: 4, id: id.uuidString.lowercased(),
      attachments: #"{"kind":"image","name":"","bytes":300,"mime":"image/jpeg"}"#))
    await until("echo") { store.state.echoed[id] == 4 }
    #expect(store.state.outbox.isEmpty)
    await store.flushPersistence()
    #expect(listing(outbox).isEmpty)
  }

  // The rule itself, without a clock: a wall-time bound on the 15 s timer fails when the test process stalls
  // under load. The store path for text is pinned by `restoreUsesAttachmentDeadline` (text past 15 s at restore).
  @Test("text only keeps the 15 s deadline")
  func textKeepsShortDeadline() {
    let accepted = Date()
    let text = OutboxEntry(sessionId: "s1", text: "text only", createdAt: accepted, state: .sent(acceptedAt: accepted))
    let withPhoto = OutboxEntry(
      sessionId: "s1", text: "photo", attachments: [.init(name: "", bytes: 3, kind: .image, mime: "image/jpeg")],
      createdAt: accepted, state: .sent(acceptedAt: accepted))
    #expect(CoreTiming.production.unconfirmedAfter(for: text) == .seconds(15))
    #expect(CoreTiming.production.unconfirmedAfter(for: withPhoto) == .seconds(120))
    #expect(fastTiming.unconfirmedAfter(for: text) == fastTiming.unconfirmedAfter)
  }
}

private final class SeenListing: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []
  func set(_ value: [String]) { lock.withLock { items = value } }
  var value: [String] { lock.withLock { items } }
}

private final class ReporterBox: @unchecked Sendable {
  private let lock = NSLock()
  private var report: (@Sendable (UploadProgress) -> Void)?
  func set(_ value: @escaping @Sendable (UploadProgress) -> Void) { lock.withLock { report = value } }
  var value: (@Sendable (UploadProgress) -> Void)? { lock.withLock { report } }
}
