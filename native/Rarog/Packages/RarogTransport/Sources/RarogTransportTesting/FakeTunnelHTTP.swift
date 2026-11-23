import Foundation
import RarogTransport

/// Żądanie HTTP/1.1, które dotarło do serwera atrapy (ciało po `Content-Length`; `chunked` nieobsługiwane).
public struct FakeHTTPRequest: Sendable, Equatable {
  public let method: String
  /// Ścieżka z zapytaniem, jak w linii żądania.
  public let target: String
  /// Nagłówki z nazwami małymi literami.
  public let headers: [String: String]
  public let body: Data
  /// Numer strumienia, którym przyszło żądanie.
  public let stream: Int

  /// Ścieżka bez zapytania.
  public var path: String { String(target.split(separator: "?", maxSplits: 1).first ?? "") }
}

/// Odpowiedź serwera HTTP atrapy.
public struct FakeHTTPResponse: Sendable {
  public var status: Int
  public var headers: [(String, String)]
  public var body: Data
  /// Treść strumieniowana po nagłówkach (SSE): bez `Content-Length`, z `Connection: close`; po powrocie
  /// domknięcia serwer kończy strumień FIN-em.
  public var stream: (@Sendable (FakeServerStream) async throws -> Void)?

  public init(
    status: Int = 200,
    headers: [(String, String)] = [],
    body: Data = Data(),
    stream: (@Sendable (FakeServerStream) async throws -> Void)? = nil
  ) {
    self.status = status
    self.headers = headers
    self.body = body
    self.stream = stream
  }

  /// JSON z danym statusem.
  public static func json(_ status: Int = 200, _ text: String) -> FakeHTTPResponse {
    FakeHTTPResponse(status: status, headers: [("Content-Type", "application/json")], body: Data(text.utf8))
  }

  func head() -> Data {
    var lines = ["HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")"]
    for (name, value) in headers { lines.append("\(name): \(value)") }
    if stream == nil {
      lines.append("Content-Length: \(body.count)")
    } else {
      lines.append("Connection: close")
    }
    return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
  }
}

/// Obsługa strumieni przez serwer atrapy.
enum FakeTunnelServing {
  static func serve(_ stream: FakeServerStream, with script: FakeTunnelScript, transport: FakeTunnelTransport) async {
    switch script.server {
    case .echo:
      while let chunk = try? await stream.read(), !chunk.isEmpty {
        guard (try? await stream.write(chunk)) != nil else { return }
      }
      stream.finish()
    case .silent:
      while let chunk = try? await stream.read(), !chunk.isEmpty {}
    case let .custom(handler):
      await handler(stream)
    case let .http(responder):
      await serveHTTP(stream, responder: responder, script: script, transport: transport)
    }
  }

  private static let headerEnd = Data("\r\n\r\n".utf8)

  /// Keep-alive: kolejne żądania na tym samym strumieniu do FIN apki albo odpowiedzi strumieniowanej.
  private static func serveHTTP(
    _ stream: FakeServerStream,
    responder: @Sendable (FakeHTTPRequest) async -> FakeHTTPResponse,
    script: FakeTunnelScript,
    transport: FakeTunnelTransport
  ) async {
    var buffer = Data()
    while true {
      guard let request = await nextRequest(stream, buffer: &buffer) else {
        stream.finish()
        return
      }
      if request.method == "GET", request.path == "/api/version", script.probeFails(transport.nextProbe()) {
        stream.reset(code: 0)
        return
      }
      let response = await responder(request)
      do {
        try await stream.write(response.head())
        if let body = response.stream {
          try await body(stream)
          stream.finish()
          return
        }
        if !response.body.isEmpty { try await stream.write(response.body) }
      } catch {
        return
      }
    }
  }

  /// Następne żądanie albo `nil` przy FIN apki (albo błędzie strumienia).
  private static func nextRequest(_ stream: FakeServerStream, buffer: inout Data) async -> FakeHTTPRequest? {
    while buffer.range(of: headerEnd) == nil {
      guard let chunk = try? await stream.read(), !chunk.isEmpty else { return nil }
      buffer.append(chunk)
    }
    guard let end = buffer.range(of: headerEnd) else { return nil }
    let head = String(decoding: buffer[buffer.startIndex ..< end.lowerBound], as: UTF8.self)
    buffer = Data(buffer[end.upperBound...])
    var lines = head.components(separatedBy: "\r\n")
    let requestLine = lines.removeFirst().split(separator: " ")
    guard requestLine.count >= 2 else { return nil }
    var headers: [String: String] = [:]
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].lowercased()
      headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }
    let length = Int(headers["content-length"] ?? "") ?? 0
    while buffer.count < length {
      guard let chunk = try? await stream.read(), !chunk.isEmpty else { return nil }
      buffer.append(chunk)
    }
    let body = Data(buffer.prefix(length))
    buffer = Data(buffer.dropFirst(length))
    return FakeHTTPRequest(
      method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: body, stream: stream.index
    )
  }
}
