import Foundation
import RarogContract
@testable import RarogTransport
import Testing

// Wysyłka wiadomości: ciało z pliku, odpowiedź z identyfikatorem, limit całej wysyłki, postęp przesyłu.

private func scratch() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-transport-tests/\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

private func file(_ dir: URL, _ name: String, _ data: Data) throws -> URL {
  let url = dir.appending(path: name)
  try data.write(to: url)
  return url
}

/// Bajty „losowe", ale powtarzalne — treść nie może się kompresować ani wyglądać jak tekst.
private func bytes(_ count: Int, seed: UInt8 = 7) -> Data {
  var value = UInt32(seed) &* 2_654_435_761
  return Data((0..<count).map { _ in
    value = value &* 1_103_515_245 &+ 12345
    return UInt8(truncatingIfNeeded: value >> 16)
  })
}

private func json(_ url: URL) throws -> [String: Any] {
  try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

private func content(ofDataURL value: String) -> Data? {
  guard let comma = value.firstIndex(of: ",") else { return nil }
  return Data(base64Encoded: String(value[value.index(after: comma)...]))
}

@Suite("ciało wiadomości strumieniem do pliku")
struct MessageBodyWriterTests {
  @Test("ten sam kształt co JSONEncoder(MessageBody): zdjęcia, pliki, identyfikator; treść bajt w bajt")
  func sameShapeAsEncoder() throws {
    let dir = try scratch()
    let chunk = MessageBodyWriter.chunkBytes
    // Granice kawałka base64: dopełnienie wolno tylko na końcu treści.
    let sizes = [1, 2, 3, 4, chunk - 1, chunk, chunk + 1, 2 * chunk + 2]
    var parts: [OutgoingMessage.Part] = []
    var expectedImages: [String] = []
    var expectedFiles: [FileAttachment] = []
    for (index, size) in sizes.enumerated() {
      let data = bytes(size, seed: UInt8(index))
      if index < 3 {
        parts.append(.init(kind: .image, name: "", mime: "image/jpeg", file: try file(dir, "\(index).jpg", data)))
        expectedImages.append("data:image/jpeg;base64,\(data.base64EncodedString())")
      } else {
        let name = "raport \"\(index)\"\\ą.pdf"
        parts.append(.init(kind: .file, name: name, mime: "application/pdf", file: try file(dir, "\(index).bin", data)))
        expectedFiles.append(FileAttachment(name: name, dataUrl: "data:application/pdf;base64,\(data.base64EncodedString())"))
      }
    }
    let id = UUID().uuidString.lowercased()
    let text = "Porównaj \"zrzut\" z raportem\n\t— i popraw / manifest."
    let target = dir.appending(path: "body.json")
    let size = try MessageBodyWriter.write(OutgoingMessage(text: text, clientMessageId: id, parts: parts), to: target)
    #expect(size == (try Data(contentsOf: target)).count)

    let reference = MessageBody(text: text, images: expectedImages, files: expectedFiles, clientMessageId: id)
    let expected = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(reference)) as? NSDictionary
    #expect(try json(target) as NSDictionary == expected)
  }

  @Test("bez załączników i bez identyfikatora: brak kluczy images/files/clientMessageId")
  func minimal() throws {
    let target = try scratch().appending(path: "body.json")
    try MessageBodyWriter.write(OutgoingMessage(text: "ok", clientMessageId: nil, parts: []), to: target)
    #expect(try String(contentsOf: target, encoding: .utf8) == #"{"text":"ok"}"#)
  }

  @Test("brak pliku treści i pusty plik → błąd z indeksem części (nic nie wychodzi)")
  func missingAndEmpty() throws {
    let dir = try scratch()
    let image = OutgoingMessage.Part(kind: .image, name: "", mime: "image/jpeg", file: try file(dir, "a.jpg", bytes(10)))
    let missing = OutgoingMessage.Part(kind: .file, name: "x.pdf", mime: "application/pdf", file: dir.appending(path: "nie-ma"))
    let empty = OutgoingMessage.Part(kind: .file, name: "y.txt", mime: "text/plain", file: try file(dir, "y.txt", Data()))
    let target = dir.appending(path: "body.json")
    #expect(throws: MessageBodyError.missingPart(1)) {
      try MessageBodyWriter.write(OutgoingMessage(text: "", clientMessageId: nil, parts: [image, missing]), to: target)
    }
    #expect(throws: MessageBodyError.emptyPart(1)) {
      try MessageBodyWriter.write(OutgoingMessage(text: "", clientMessageId: nil, parts: [image, empty]), to: target)
    }
  }

  @Test("a cancelled task stops composing the body (the stop in the progress ring): `.cancelled`")
  func cancelledTask() async throws {
    let dir = try scratch()
    let part = OutgoingMessage.Part(
      kind: .image, name: "", mime: "image/jpeg", file: try file(dir, "a.jpg", bytes(3 * MessageBodyWriter.chunkBytes)))
    let target = dir.appending(path: "body.json")
    let result = await Task { () -> Result<Int, MessageBodyError> in
      withUnsafeCurrentTask { $0?.cancel() }
      do throws(MessageBodyError) {
        return .success(try MessageBodyWriter.write(OutgoingMessage(text: "x", clientMessageId: nil, parts: [part]), to: target))
      } catch {
        return .failure(error)
      }
    }.value
    #expect(result == .failure(.cancelled))
  }
}

@Suite("klient: wysyłka wiadomości")
struct MessageSendTests {
  @Test("ciało z pliku: bajty pliku na drucie, nagłówki mutacji, odpowiedź z tym samym id")
  func fileBody() async throws {
    let id = UUID().uuidString.lowercased()
    let harness = MockHarness { _ in .json(202, #"{"ok":true,"clientMessageId":"\#(id)"}"#) }
    let dir = try scratch()
    let image = try file(dir, "0.jpg", bytes(5000))
    let body = dir.appending(path: "body.json")
    try MessageBodyWriter.write(
      OutgoingMessage(text: "zdjęcie", clientMessageId: id, parts: [.init(kind: .image, name: "", mime: "image/jpeg", file: image)]),
      to: body)
    let accepted = try await harness.client.sendMessage(
      sessionId: "s/1", MessageUpload(body: .file(body), clientMessageId: id), timeout: .seconds(200), progress: nil)
    #expect(accepted?.clientMessageId == id)
    #expect(accepted?.replayed == false)
    let request = try #require(harness.requests.first)
    #expect(request.path == "/api/sessions/s%2F1/messages")
    #expect(request.body == (try Data(contentsOf: body)))
    #expect(request.header("Content-Type") == "application/json")
    #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
    let raw = try #require(request.body)
    let sent = try #require(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
    let images = try #require(sent["images"] as? [String])
    #expect(content(ofDataURL: images[0]) == bytes(5000))
  }

  @Test("powtórka: replayed:true; starszy serwer: {ok:true} bez id; ciało spoza kontraktu → nil")
  func replies() async throws {
    let id = UUID().uuidString.lowercased()
    for (reply, expected) in [
      (#"{"ok":true,"clientMessageId":"\#(id.uppercased())","replayed":true}"#, true),
      (#"{"ok":true}"#, false),
    ] {
      let harness = MockHarness { _ in .json(202, reply) }
      let accepted = try await harness.client.sendMessage(
        sessionId: "s1", MessageUpload(body: .data(Data("{}".utf8)), clientMessageId: id), timeout: nil, progress: nil)
      #expect(accepted?.replayed == expected, "\(reply)")
    }
    let harness = MockHarness { _ in .json(202, "nie json") }
    let accepted = try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "x", clientMessageId: id))
    #expect(accepted == nil)
  }

  @Test("serwer oddał OBCY identyfikator → invalidResponse (nie wiadomo, co przyjął)")
  func foreignId() async throws {
    let harness = MockHarness { _ in .json(202, #"{"ok":true,"clientMessageId":"\#(UUID().uuidString)"}"#) }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "x", clientMessageId: UUID().uuidString))
    }
    guard case .invalidResponse = error else {
      Issue.record("oczekiwano invalidResponse, jest \(String(describing: error))")
      return
    }
  }

  @Test("409 client-id-conflict → .http z kodem i zdaniem serwera")
  func conflict() async throws {
    let harness = MockHarness { _ in
      .json(409, #"{"error":"client-id-conflict","message":"Ten identyfikator ma już inną treść."}"#)
    }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "x", clientMessageId: UUID().uuidString))
    }
    #expect(error == .http(APIFailure(status: 409, code: "client-id-conflict", message: "Ten identyfikator ma już inną treść.")))
  }

  @Test("bramka zgodności: wysyłka z pliku nie wychodzi")
  func gate() async throws {
    let harness = MockHarness(policy: RefuseAll()) { _ in .json(202, #"{"ok":true}"#) }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.sendMessage(
        sessionId: "s1", MessageUpload(body: .data(Data("{}".utf8)), clientMessageId: nil), timeout: nil, progress: nil)
    }
    #expect(error == .refused(MutationRefusal(gate: .compatibility, message: "Zaktualizuj apkę.")))
    #expect(harness.requests.isEmpty)
  }

  @Test("the session gate hears whether the body carries `expectedConversation`")
  func gateHearsConversation() async throws {
    let harness = MockHarness(policy: ConversationOnly()) { _ in .json(202, #"{"ok":true}"#) }
    let pair = MessageSender(source: .voiceAgent, expectedConversation: "Tjo8_3W")
    try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "Run the tests", sender: pair))
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "Run the tests"))
    }
    let refusal = MutationRefusal(gate: .unsupportedSession(id: "s1"), message: "Waits for the transcript.")
    #expect(error == .refused(refusal))
    #expect(harness.requests.count == 1)
  }

  @Test("limit CAŁEJ wysyłki: po czasie .timedOut (nie .cancelled), szybko")
  func deadline() async {
    let started = ContinuousClock.now
    let error = await #expect(throws: TransportError.self) {
      try await RarogClient.withDeadline(.milliseconds(100)) {
        try await Task.sleep(for: .seconds(5))
        return (Data(), URLResponse())
      }
    }
    #expect(error == .timedOut)
    #expect(ContinuousClock.now - started < .seconds(2))
  }

  @Test("anulowanie wołającego: .cancelled, nie .timedOut")
  func cancelled() async {
    let task = Task { () async throws -> Void in
      _ = try await RarogClient.withDeadline(.seconds(10)) {
        try await Task.sleep(for: .seconds(5))
        return (Data(), URLResponse())
      }
    }
    try? await Task.sleep(for: .milliseconds(50))
    task.cancel()
    let result = await task.result
    guard case let .failure(error) = result else {
      Issue.record("anulowane żądanie skończyło się sukcesem")
      return
    }
    #expect(error as? TransportError == .cancelled)
  }

  @Test("postęp: przesyłanie z liczbą bajtów, a pełne ciało = oczekiwanie na odpowiedź")
  func progressPhases() {
    #expect(UploadProgress.from(sent: 0, total: 1000) == .uploading(sent: 0, total: 1000))
    #expect(UploadProgress.from(sent: 400, total: 1000) == .uploading(sent: 400, total: 1000))
    #expect(UploadProgress.from(sent: 1000, total: 1000) == .awaitingResponse)
    #expect(UploadProgress.from(sent: 10, total: -1) == .uploading(sent: 10, total: 0), "nieznany rozmiar")

    let seen = Seen()
    let delegate = UploadProgressDelegate { seen.add($0) }
    let task = URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:1")!)
    delegate.urlSession(.shared, task: task, didSendBodyData: 500, totalBytesSent: 500, totalBytesExpectedToSend: 1000)
    delegate.urlSession(.shared, task: task, didSendBodyData: 500, totalBytesSent: 1000, totalBytesExpectedToSend: 1000)
    #expect(seen.values == [.uploading(sent: 500, total: 1000), .awaitingResponse])
  }
}

private struct RefuseAll: MutationPolicy {
  func compatibilityRefusal() async -> PolicyRefusal? { PolicyRefusal("Zaktualizuj apkę.") }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

/// Session gate that lets through only a message whose body carries `expectedConversation`.
private struct ConversationOnly: MutationPolicy {
  func compatibilityRefusal() async -> PolicyRefusal? { nil }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? {
    PolicyRefusal("Waits for the transcript.")
  }
  func sessionRefusal(sessionId: String, route: String, expectsConversation: Bool) async -> PolicyRefusal? {
    expectsConversation && route == "messages" ? nil : PolicyRefusal("Waits for the transcript.")
  }
}

private final class Seen: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [UploadProgress] = []
  func add(_ value: UploadProgress) { lock.withLock { items.append(value) } }
  var values: [UploadProgress] { lock.withLock { items } }
}
