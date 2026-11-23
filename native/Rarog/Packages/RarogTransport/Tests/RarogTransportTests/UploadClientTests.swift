import Foundation
import RarogContract
import RarogTransport
import Testing

// Zdjęcia z `/uploads` do miniatur na atrapie `URLProtocol`. Właściciel: notki i miniatury.

private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])

private func image(_ data: Data, type: String = "image/png") -> MockURLProtocol.Reply {
  MockURLProtocol.Reply(status: 200, headers: ["Content-Type": type], chunks: [data])
}

/// Klient z kluczem urządzenia i odpowiedź atrapy dla ścieżek `/uploads`.
private func paired(_ uploads: @escaping MockURLProtocol.Handler) -> MockHarness {
  MockHarness(device: testDevice, handler: uploads)
}

@Suite("klient REST: zdjęcia z /uploads")
struct UploadClientTests {
  @Test("GET …/uploads/<plik>: segmenty zakodowane, klucz urządzenia, bez Origin, bajty PNG i JPEG")
  func reads() async throws {
    let harness = paired { request in
      request.path.hasSuffix(".jpg") ? image(jpeg, type: "image/jpeg") : image(png)
    }
    let first = try await harness.client.uploadImage(sessionId: "w0:d4", file: "1790000000000-0123456789abcdef.png")
    #expect(first == png)
    let second = try await harness.client.uploadImage(sessionId: "s1", file: "1790000000001-0123456789abcdef.jpg")
    #expect(second == jpeg)
    let reads = harness.requests.filter { $0.path.contains("/uploads/") }
    #expect(reads.map { "\($0.method) \($0.path)" } == [
      "GET /api/sessions/w0%3Ad4/uploads/1790000000000-0123456789abcdef.png",
      "GET /api/sessions/s1/uploads/1790000000001-0123456789abcdef.jpg",
    ])
    #expect(reads.allSatisfy { $0.header("Authorization") == testDeviceHeader && $0.header("Origin") == nil })
    #expect(reads.allSatisfy { $0.header("Accept") == "image/png, image/jpeg" })
  }

  @Test("404 (zdjęcie sprzątnięte) → .http 404 ze zdaniem serwera")
  func missing() async throws {
    let harness = paired { _ in .json(404, #"{"error":"not-found","message":"Nie ma takiego zdjęcia."}"#) }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.uploadImage(sessionId: "s1", file: "1-0123456789abcdef.png")
    }
    #expect(error == .http(APIFailure(status: 404, code: "not-found", message: "Nie ma takiego zdjęcia.")))
  }

  @Test("błąd z kodem zdania (messageRef) idzie przez tłumacza klienta także na ścieżce strumienia bajtów")
  func failureSentenceGoesThroughRenderer() async throws {
    let harness = MockHarness(device: testDevice, renderer: { text, ref in ref.map { "R:\($0.code)" } ?? text }) { _ in
      .json(404, #"{"error":"not-found","message":"No such image.","messageRef":{"code":"rest.image-not-found"}}"#)
    }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.uploadImage(sessionId: "s1", file: "1-0123456789abcdef.png")
    }
    #expect(error == .http(APIFailure(status: 404, code: "not-found", message: "R:rest.image-not-found")))
  }

  @Test("401 klucza → błąd typowany i odmowa w zatrzasku; o wylogowaniu decyduje magazyn (spóźniona miniatura)")
  func unauthorizedRecordsRejection() async throws {
    let harness = paired { _ in
      .json(401, #"{"error":"unauthorized","message":"Zaloguj się ponownie."}"#)
    }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.uploadImage(sessionId: "s1", file: "1-0123456789abcdef.png")
    }
    #expect(error == .unauthorized(APIFailure(status: 401, code: "unauthorized", message: "Zaloguj się ponownie.")))
    #expect(harness.client.credentialRejection == .unknown(deviceId: testDevice.deviceId))
  }

  @Test("odpowiedź, która nie jest zdjęciem (strona proxy), i zdjęcie ponad limit → invalidResponse")
  func rejectsNonImages() async throws {
    let oversized = png + Data(count: RarogClient.uploadImageMaxBytes)
    let harness = paired { request in
      request.path.hasSuffix("a.png")
        ? MockURLProtocol.Reply(status: 200, headers: ["Content-Type": "text/html"], chunks: [Data("<html>".utf8)])
        : MockURLProtocol.Reply(status: 200, headers: ["Content-Type": "image/png"], chunks: [oversized])
    }
    for file in ["1-0123456789abcdea.png", "1-0123456789abcdeb.png"] {
      let error = await #expect(throws: TransportError.self) {
        try await harness.client.uploadImage(sessionId: "s1", file: file)
      }
      guard case .invalidResponse = error else {
        Issue.record("\(file): oczekiwane invalidResponse, jest \(String(describing: error))")
        continue
      }
    }
  }

  @Test("brak sieci → .offline (kafel „Zdjęcie”, próba przy następnym pokazaniu)")
  func offline() async throws {
    let harness = paired { _ in MockURLProtocol.Reply(error: URLError(.notConnectedToInternet)) }
    let error = await #expect(throws: TransportError.self) {
      try await harness.client.uploadImage(sessionId: "s1", file: "1-0123456789abcdef.png")
    }
    #expect(error == .offline(.notConnectedToInternet))
  }
}

@Suite("pamięć zdjęć: LRU po bajtach")
struct UploadImageCacheTests {
  private func key(_ file: String) -> UploadImageKey { UploadImageKey(sessionId: "s1", file: file) }

  @Test("trafienie odświeża wpis; ponad limit wypada najdawniej użyty")
  func lru() {
    var cache = UploadImageCache(byteLimit: 10)
    cache.store(Data(count: 4), for: key("a"))
    cache.store(Data(count: 4), for: key("b"))
    #expect(cache.data(for: key("a"))?.count == 4)
    cache.store(Data(count: 4), for: key("c"))
    #expect(cache.data(for: key("b")) == nil, "b był najdawniej użyty")
    #expect(cache.data(for: key("a")) != nil && cache.data(for: key("c")) != nil)
    #expect(cache.totalBytes == 8 && cache.count == 2)
  }

  @Test("nadpisanie liczy wagę raz; zdjęcie większe niż cały limit nie wchodzi; removeAll zeruje")
  func accounting() {
    var cache = UploadImageCache(byteLimit: 10)
    cache.store(Data(count: 3), for: key("a"))
    cache.store(Data(count: 5), for: key("a"))
    #expect(cache.totalBytes == 5 && cache.count == 1)
    cache.store(Data(count: 11), for: key("big"))
    #expect(cache.data(for: key("big")) == nil && cache.data(for: key("a")) != nil)
    cache.removeAll()
    #expect(cache.totalBytes == 0 && cache.count == 0 && cache.data(for: key("a")) == nil)
  }

  @Test("klucz to para (sesja, plik)")
  func keyPair() {
    var cache = UploadImageCache()
    cache.store(Data([1]), for: UploadImageKey(sessionId: "s1", file: "f"))
    #expect(cache.data(for: UploadImageKey(sessionId: "s2", file: "f")) == nil)
  }

  @Test("sygnatura obrazka: PNG, JPEG, reszta nie")
  func signature() {
    #expect(ImageSignature.isPNG(png) && !ImageSignature.isJPEG(png))
    #expect(ImageSignature.isJPEG(jpeg) && ImageSignature.isPNGOrJPEG(jpeg))
    #expect(!ImageSignature.isPNGOrJPEG(Data("<html>".utf8)) && !ImageSignature.isPNGOrJPEG(Data()))
  }
}
