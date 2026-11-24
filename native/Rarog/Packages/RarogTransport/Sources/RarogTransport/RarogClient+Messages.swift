import Foundation
import RarogContract
import Synchronization

// Właściciel: wysyłka. `POST /api/sessions/<id>/messages` z postępem przesyłu,
// limitem czasu CAŁEJ wysyłki i odpowiedzią z identyfikatorem (`clientMessageId`, `replayed`).
extension RarogClient {
  /// Wysyłka bez załączników z `MessageBody` w pamięci (testy, demo).
  @discardableResult
  public func sendMessage(
    sessionId: String, _ body: MessageBody, timeout: Duration? = nil
  ) async throws(TransportError) -> MessageAccepted? {
    try await sendMessage(sessionId: sessionId, try .json(body), timeout: timeout, progress: nil)
  }

  /// `POST /api/sessions/<id>/messages` → 202. Odmowy serwera (400/409/410/413/429) jako `.http`.
  ///
  /// - Bramka mutacji, klucz urządzenia i `Origin` jak w ``perform(_:)``.
  /// - `timeout` (domyślnie `RarogConfig.requestTimeout`) to limit CAŁEJ wysyłki, nie ciszy:
  ///   `URLRequest.timeoutInterval` mierzy tylko przerwę między pakietami, a martwe łącze ma
  ///   szybko oddać tekst do pola. Po limicie: `.timedOut`.
  /// - `progress` dostaje raporty `URLSession` z wątku sesji (nie z głównego aktora).
  /// - Wynik: `MessageAccepted` z ciała 202 albo `nil`, gdy ciało nie jest odpowiedzią
  ///   z identyfikatorem (starszy serwer bez kontraktu odpowiedzi — wysyłka przyjęta). Identyfikator inny niż
  ///   wysłany to `.invalidResponse`: nie wiadomo, co serwer przyjął.
  @discardableResult
  public func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?,
    progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted? {
    let path = "/api/sessions/\(Self.segment(sessionId))/messages"
    do {
      try await gate.check(method: "POST", path: path, expectsConversation: upload.expectsConversation)
    } catch {
      throw .refused(error)
    }
    let limit = timeout ?? config.requestTimeout
    var prepared = try makeRequest(APIRequest(method: "POST", path: path, timeout: limit))
    prepared.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let request = prepared
    let delegate = UploadProgressDelegate(report: progress)
    let session = session
    let (data, http) = try await Self.withDeadline(limit) { () async throws -> (Data, URLResponse) in
      try await session.run(.upload) { urlSession in
        switch upload.body {
        case let .data(body): try await urlSession.upload(for: request, from: body, delegate: delegate)
        case let .file(url): try await urlSession.upload(for: request, fromFile: url, delegate: delegate)
        }
      }
    }
    guard (200..<300).contains(http.statusCode) else {
      throw rejection(http, body: data, request: request)
    }
    return try Self.accepted(data, sent: upload.clientMessageId)
  }

  /// Odpowiedź 202 → `MessageAccepted`; obcy identyfikator → błąd (nie wiadomo, co przyjęto).
  static func accepted(_ data: Data, sent: String?) throws(TransportError) -> MessageAccepted? {
    guard let accepted = try? JSONDecoder().decode(MessageAccepted.self, from: data) else { return nil }
    if let sent, let returned = accepted.clientMessageId, returned.lowercased() != sent.lowercased() {
      throw .invalidResponse("messages: serwer oddał inny clientMessageId niż wysłany")
    }
    return accepted
  }

  /// Żądanie z limitem CAŁEGO czasu: po `limit` zadanie jest anulowane, a błąd to `.timedOut`
  /// (nie `.cancelled`). Anulowanie wołającego anuluje żądanie (`.cancelled`).
  static func withDeadline(
    _ limit: Duration, _ work: @escaping @Sendable () async throws -> (Data, URLResponse)
  ) async throws(TransportError) -> (Data, HTTPURLResponse) {
    let expired = DeadlineFlag()
    let task = Task { try await work() }
    let timer = Task {
      try await Task.sleep(for: limit)
      expired.set()
      task.cancel()
    }
    defer { timer.cancel() }
    let result: (Data, URLResponse)
    do {
      result = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
    } catch {
      if expired.isSet { throw .timedOut }
      throw transportError(error)
    }
    guard let http = result.1 as? HTTPURLResponse else { throw .invalidResponse("odpowiedź nie jest HTTP") }
    return (result.0, http)
  }
}

/// Raport postępu przesyłu z delegata zadania `URLSession` (jeden na żądanie).
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  let report: (@Sendable (UploadProgress) -> Void)?

  init(report: (@Sendable (UploadProgress) -> Void)?) {
    self.report = report
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    report?(.from(sent: totalBytesSent, total: totalBytesExpectedToSend))
  }
}

/// Znacznik „limit minął" współdzielony przez zegar i wołającego.
final class DeadlineFlag: Sendable {
  private let state = Mutex(false)

  func set() { state.withLock { $0 = true } }
  var isSet: Bool { state.withLock { $0 } }
}
