import Foundation
import RarogContract

// Zdjęcie z `.rarog-uploads/` sesji do miniatury w transkrypcie:
// `GET /api/sessions/<id>/uploads/<plik>` z kluczem urządzenia, jak każdy odczyt (bez bramki mutacji).
// Pamięć podręczna w pamięci procesu z limitem bajtów — trzyma ją magazyn (`RarogStore+Uploads`),
// bo to on wie o wylogowaniu. Właściciel: notki i miniatury.

/// Zdjęcie sesji: nazwa pliku jest unikalna i niezmienna (serwer nigdy nie nadpisuje, odpowiedź
/// ma `immutable`), ale katalog bierze się z sesji — stąd para.
public struct UploadImageKey: Sendable, Hashable {
  public let sessionId: String
  public let file: String

  public init(sessionId: String, file: String) {
    self.sessionId = sessionId
    self.file = file
  }
}

/// Pamięć podręczna zdjęć z `/uploads` w pamięci procesu, LRU po bajtach. Bez niej każde wejście
/// w transkrypt ściągałoby te same zdjęcia przez Tailscale (`URLSession` klienta nie ma cache).
/// Wartość, nie aktor: trzyma ją magazyn na głównym aktorze.
public struct UploadImageCache: Sendable {
  /// 32 MB ≈ 25 zdjęć po 1,2 MB (limit wysyłki to 1,5 MB data URL-a na zdjęcie).
  public static let defaultByteLimit = 32 * 1024 * 1024

  public let byteLimit: Int
  public private(set) var totalBytes = 0
  private var entries: [UploadImageKey: Data] = [:]
  /// Od najdawniej użytego.
  private var order: [UploadImageKey] = []

  public init(byteLimit: Int = Self.defaultByteLimit) {
    self.byteLimit = byteLimit
  }

  public var count: Int { entries.count }

  /// Bajty zdjęcia albo `nil`; trafienie odświeża wpis (najdłużej zostaje to, co oglądane).
  public mutating func data(for key: UploadImageKey) -> Data? {
    guard let data = entries[key] else { return nil }
    touch(key)
    return data
  }

  /// Zapisuje zdjęcie i wypycha najdawniej używane ponad limit. Zdjęcie większe niż cały limit
  /// nie wchodzi wcale (wypchnęłoby wszystko inne, a samo i tak by nie zostało).
  public mutating func store(_ data: Data, for key: UploadImageKey) {
    guard data.count <= byteLimit else { return }
    if let old = entries.updateValue(data, forKey: key) {
      totalBytes -= old.count
      touch(key)
    } else {
      order.append(key)
    }
    totalBytes += data.count
    while totalBytes > byteLimit, let oldest = order.first {
      order.removeFirst()
      totalBytes -= entries.removeValue(forKey: oldest)?.count ?? 0
    }
  }

  public mutating func removeAll() {
    entries = [:]
    order = []
    totalBytes = 0
  }

  private mutating func touch(_ key: UploadImageKey) {
    guard let index = order.firstIndex(of: key) else { return }
    order.remove(at: index)
    order.append(key)
  }
}

extension RarogClient {
  /// Sufit jednego zdjęcia z `/uploads`. Serwer zapisuje zdjęcia z data URL-a ≤ 1,5 MB (≈ 1,2 MB
  /// treści), więc większa odpowiedź to nie nasze zdjęcie — przerywamy, zanim zajmie pamięć.
  public static let uploadImageMaxBytes = 8 * 1024 * 1024

  /// `GET /api/sessions/<id>/uploads/<plik>` → bajty PNG albo JPEG (sprawdzone po sygnaturze, nie
  /// po nagłówku). 404 (zdjęcie sprzątnięte po 48 h, sesja go nie zna) przychodzi jako `.http`.
  ///
  /// Strumień bajtów zamiast `perform` (limit rozmiaru, sygnatura). O wylogowaniu po 401 decyduje magazyn, który
  /// wie, czy odpowiedź należy do bieżącego zalogowania (`RarogStore.uploadImage`) — miniatura bywa spóźniona.
  public func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    let path = "/api/sessions/\(Self.segment(sessionId))/uploads/\(Self.segment(file))"
    var request = try makeRequest(.get(path))
    request.setValue("image/png, image/jpeg", forHTTPHeaderField: "Accept")
    let opened: ClientURLSession.OpenedBytes
    do {
      opened = try await session.bytes(for: request)
    } catch {
      throw Self.transportError(error)
    }
    let bytes = opened.bytes
    defer { opened.pass.finish() }
    guard let http = opened.response as? HTTPURLResponse else {
      throw .invalidResponse("odpowiedź zdjęcia nie jest HTTP")
    }
    guard (200..<300).contains(http.statusCode) else {
      let body = (try? await Self.collect(bytes, limit: 64 * 1024, truncate: true)) ?? Data()
      // Klucz urządzenia: odmowa idzie do zatrzasku jak w `rejection`.
      if let device, http.statusCode == 401 {
        rejections.record(Self.credentialRejection(body, deviceId: device.deviceId))
      }
      throw failure(status: http.statusCode, response: http, body: body, readsRetryAfter: false)
    }
    if http.expectedContentLength > Int64(Self.uploadImageMaxBytes) {
      throw .invalidResponse("\(path): zdjęcie ponad limit \(Self.uploadImageMaxBytes) B")
    }
    let data = try await Self.collect(bytes, limit: Self.uploadImageMaxBytes, truncate: false, reserve: http.expectedContentLength)
    guard ImageSignature.isPNGOrJPEG(data) else {
      throw .invalidResponse("\(path): odpowiedź nie jest zdjęciem PNG ani JPEG")
    }
    return data
  }

  /// Ciało odpowiedzi do `limit` bajtów. `truncate: false` = przekroczenie to błąd (zdjęcie),
  /// `true` = ucięcie (ciało błędu jest tylko opisem).
  private static func collect(
    _ bytes: URLSession.AsyncBytes, limit: Int, truncate: Bool, reserve: Int64 = 0
  ) async throws(TransportError) -> Data {
    var data = Data()
    if reserve > 0 { data.reserveCapacity(Int(min(reserve, Int64(limit)))) }
    do {
      for try await byte in bytes {
        guard data.count < limit else {
          if truncate { break }
          throw TransportError.invalidResponse("zdjęcie ponad limit \(limit) B")
        }
        data.append(byte)
      }
    } catch {
      throw transportError(error)
    }
    return data
  }

}

/// Sygnatura pliku obrazka — odpowiedź `/uploads` ma być zdjęciem, nie stroną błędu proxy.
public enum ImageSignature {
  public static func isPNG(_ data: Data) -> Bool {
    data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  }

  public static func isJPEG(_ data: Data) -> Bool {
    data.starts(with: [0xFF, 0xD8, 0xFF])
  }

  public static func isPNGOrJPEG(_ data: Data) -> Bool {
    isPNG(data) || isJPEG(data)
  }
}
