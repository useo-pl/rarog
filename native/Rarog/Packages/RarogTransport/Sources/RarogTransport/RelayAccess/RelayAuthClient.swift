import Foundation
import RarogContract

// Klient HTTP rejestru relaya iroh (Worker `relay-auth/`, trasy apki `/v1/app/*`). Jedno żądanie = jeden
// `RelayAuthReply`; o ponowieniach, przerwach i stanie decyduje wołający.
//
// - Żądanie: `POST <rejestr><ścieżka trasy>`, `content-type: application/json`,
//   `x-rarog-relay-client: rarog-app/<CFBundleShortVersionString>+<build>` (najwyżej 128 znaków, sufit Workera), ciało
//   `RelayAuthWire.Request.body()` z `sig` = hex małymi literami podpisu `TunnelSigner` nad `signingBytes`.
// - Termin żądania 10 s; brak odpowiedzi, termin i żądanie, które nie wyszło (podpis), to `.unreachable`.
// - Odpowiedź 200 przechodzi walidację: `Registered.endpointId` = EndpointId podpisu, `Sponsored.server` =
//   poręczany serwer, `expiresAt` w `(issuedAt, issuedAt + 90 d + 300 s + zapas]` (chwila żądania; 300 s to
//   tolerancja zegara Workera), `Renewed.unsponsored` ⊆ wysłana lista, `Forgotten.forgotten == true`. 200, które
//   jej nie przechodzi, i każda inna odpowiedź bez wyniku trasy to `.failure(status:code:gate:)`. Zapas = termin
//   żądania w pełnych sekundach + 1 s: Worker sprawdza zegar na wejściu, a termin wpisu liczy po obsłudze (bramka
//   woła Apple), w pełnych sekundach.
// - Klient nie loguje: token dowodu, podpis i ciało nie wychodzą poza żądanie.

/// Klient rejestru: produkcyjny ``RelayAuthTransport``.
public struct RelayAuthClient: RelayAuthTransport {
  /// Sufit długości nagłówka klienta (`CLIENT_HEADER_MAX_CHARS` Workera).
  public static let clientHeaderMax = 128
  /// Termin wpisu i poręczenia w rejestrze (90 dni).
  static let termSeconds: Int64 = 90 * 86_400

  /// Wartość nagłówka ``RelayAuthWire/clientHeader``.
  public let clientHeader: String
  let session: URLSession
  /// Zapas górnej granicy `expiresAt` w sekundach: termin żądania zaokrąglony w górę + 1 s.
  let slackSeconds: Int64

  /// `appVersion` = `CFBundleShortVersionString`, `build` = `CFBundleVersion`. `configuration` dostaje termin
  /// `timeout` na całe żądanie.
  public init(
    appVersion: String, build: String, configuration: URLSessionConfiguration = .ephemeral,
    timeout: Duration = .seconds(10)
  ) {
    clientHeader = Self.clientHeader(appVersion: appVersion, build: build)
    let configuration = configuration.copy() as? URLSessionConfiguration ?? .ephemeral
    configuration.timeoutIntervalForRequest = timeout.timeInterval
    configuration.timeoutIntervalForResource = timeout.timeInterval
    session = URLSession(configuration: configuration)
    slackSeconds = Int64(timeout.timeInterval.rounded(.up)) + 1
  }

  /// `rarog-app/<wersja>+<build>`, przycięte do ``clientHeaderMax`` znaków.
  public static func clientHeader(appVersion: String, build: String) -> String {
    String("rarog-app/\(appVersion)+\(build)".prefix(clientHeaderMax))
  }

  public func send(_ fields: RelayAuthWire.Fields, signer: any TunnelSigner, issuedAt: Int64, registry: URL) async
    -> RelayAuthReply {
    let request: URLRequest
    switch Self.request(fields, signer: signer, issuedAt: issuedAt, registry: registry, clientHeader: clientHeader) {
    case let .success(signed): request = signed
    case let .failure(failure): return .unreachable(failure.reason)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError {
      return .unreachable("network: URLError \(error.code.rawValue)")
    } catch {
      return .unreachable("network: \(type(of: error))")
    }
    guard let http = response as? HTTPURLResponse else { return .unreachable("network: no HTTP response") }
    return Self.reply(status: http.statusCode, body: data, sent: fields, endpointId: signer.endpointId,
      issuedAt: issuedAt, slackSeconds: slackSeconds)
  }

  // MARK: Żądanie

  /// Żądanie, które nie wyszło (powód bez treści żądania).
  struct NotSent: Error, Equatable {
    let reason: String
  }

  /// Podpisane żądanie trasy `fields`.
  static func request(
    _ fields: RelayAuthWire.Fields, signer: any TunnelSigner, issuedAt: Int64, registry: URL, clientHeader: String
  ) -> Result<URLRequest, NotSent> {
    var wire = RelayAuthWire.Request(endpointId: signer.endpointId, issuedAt: issuedAt, fields: fields)
    let signature: Data
    do {
      signature = try signer.sign(wire.signingBytes)
    } catch {
      return .failure(NotSent(reason: "signature: \(type(of: error))"))
    }
    guard signature.count == 64 else { return .failure(NotSent(reason: "signature: \(signature.count) bytes")) }
    wire.sig = signature.map { String(format: "%02x", $0) }.joined()
    let body: Data
    do { body = try wire.body() } catch { return .failure(NotSent(reason: "body: encoding")) }
    var request = URLRequest(url: registry.appending(path: fields.route.path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(clientHeader, forHTTPHeaderField: RelayAuthWire.clientHeader)
    request.httpBody = body
    return .success(request)
  }

  // MARK: Odpowiedź

  /// Odpowiedź rejestru → wynik trasy wysłanej w `sent`; `slackSeconds` to zapas górnej granicy `expiresAt`.
  static func reply(
    status: Int, body: Data, sent: RelayAuthWire.Fields, endpointId: String, issuedAt: Int64, slackSeconds: Int64
  ) -> RelayAuthReply {
    guard status == 200 else {
      guard let failure = try? RelayAuthWire.decode(RelayAuthWire.Failure.self, from: body) else {
        return .failure(status: status, code: nil, gate: nil)
      }
      return .failure(status: status, code: failure.code, gate: failure.gateKind)
    }
    let latest = issuedAt + termSeconds + RelayAuthWire.clockSkewSeconds + slackSeconds
    let fresh = { (expiresAt: Int64) in expiresAt > issuedAt && expiresAt <= latest }
    let result: RelayAuthReply? =
      switch sent {
      case .register:
        (try? RelayAuthWire.decode(RelayAuthWire.Registered.self, from: body))
          .flatMap { $0.endpointId == endpointId && fresh($0.expiresAt) ? .registered($0) : nil }
      case let .renew(servers):
        (try? RelayAuthWire.decode(RelayAuthWire.Renewed.self, from: body))
          .flatMap { Set($0.unsponsored).isSubset(of: servers) && fresh($0.expiresAt) ? .renewed($0) : nil }
      case let .sponsor(server):
        (try? RelayAuthWire.decode(RelayAuthWire.Sponsored.self, from: body))
          .flatMap { $0.server == server && fresh($0.expiresAt) ? .sponsored($0) : nil }
      case .forget:
        (try? RelayAuthWire.decode(RelayAuthWire.Forgotten.self, from: body))
          .flatMap { $0.forgotten ? .forgotten($0) : nil }
      }
    return result ?? .failure(status: status, code: nil, gate: nil)
  }
}
