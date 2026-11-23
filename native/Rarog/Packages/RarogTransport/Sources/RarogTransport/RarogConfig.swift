import Foundation

/// Adres serwera i tożsamość klienta. Wartości produkcyjne przychodzą z Info.plist apki
/// (adres Raroga NIE siedzi w kodzie); wariant testowy celuje w serwer demo na loopbacku.
public struct RarogConfig: Sendable, Equatable {
  /// Baza adresów API, np. `https://rarog.example.ts.net` albo `http://127.0.0.1:18930`.
  public var baseURL: URL
  /// Nagłówek `Origin` każdej mutacji. Musi stać w `RAROG_ORIGINS` serwera (także w demo), inaczej
  /// 403 `bad-origin`. Dla przeglądarki to bramka CSRF, dla apki — jawna deklaracja.
  public var origin: String
  /// Etykieta urządzenia (`iPad·Rarog`): `label` parowania i rejestracji push. Nagłówkiem nie jedzie — serwer bierze
  /// etykietę urządzenia z parowania.
  public var clientLabel: String
  /// Numer builda apki: `User-Agent: RarogApp/<build>` (tag `app/<build>` w `client.log`)
  /// i porównanie z `hello.minClientBuild`.
  public var build: Int
  /// Limit pojedynczego żądania (10 s; klient czeka dłużej niż serwer).
  public var requestTimeout: Duration
  /// Idle limit of the SSE request in `URLSession` (gap between packets): only a ceiling. A silent stream ends
  /// earlier through the stall guard of the stream loop in `RarogCore` (``StreamStallGuard``): 1.5 × the ping
  /// interval from `hello` (the server pings every 10 s → 15 s), 60 s without it.
  public var streamIdleTimeout: Duration

  public init(
    baseURL: URL,
    origin: String? = nil,
    clientLabel: String,
    build: Int,
    requestTimeout: Duration = .seconds(10),
    streamIdleTimeout: Duration = .seconds(60)
  ) {
    self.baseURL = baseURL
    self.origin = origin ?? Self.origin(of: baseURL)
    self.clientLabel = clientLabel
    self.build = build
    self.requestTimeout = requestTimeout
    self.streamIdleTimeout = streamIdleTimeout
  }

  /// Serwer demo na loopbacku (`RAROG_DEMO=1 RAROG_PORT=<port> RAROG_ORIGINS=http://127.0.0.1:<port>`).
  /// Origin = ten sam adres; żywy Rarog (8930) nie jest tu nigdy celem.
  public static func test(port: Int, build: Int = 1, clientLabel: String = "test·Rarog") -> RarogConfig {
    let base = URL(string: "http://127.0.0.1:\(port)")!
    return RarogConfig(baseURL: base, clientLabel: clientLabel, build: build)
  }

  public var userAgent: String { "RarogApp/\(build)" }

  /// `scheme://host[:port]` — postać nagłówka `Origin` (bez ścieżki i końcowego ukośnika).
  public static func origin(of url: URL) -> String {
    let scheme = url.scheme ?? "https"
    let host = url.host(percentEncoded: false) ?? ""
    return url.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
  }
}

extension Duration {
  var timeInterval: TimeInterval {
    let (seconds, attoseconds) = components
    return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
  }
}
