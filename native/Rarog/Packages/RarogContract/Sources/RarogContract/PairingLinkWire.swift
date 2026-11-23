import Foundation

// Pairing link, the mirror of `shared/src/pairing-link.ts`: the same build and parse rules, the same
// error codes. The parser accepts `rarog://pair#v=1&…` and the universal link `https://rarog.ai/pair#v=1&…`
// with the same fragment body; the builder writes the universal link. The cases in
// `shared/fixtures/pairing-links/manifest.json` (`PairingLinkWireTests` and `shared/test/pairing-link.test.ts`)
// keep both sides in step.
// The rules work on UTF-8 bytes, not on `URL`/`URLComponents`: the Foundation URL parser and the WHATWG parser in TS
// differ at the edges, and the link has one definition. What the app does with the fields is up to `PairingLink`
// in RarogCore.

/// Pola linku parowania w postaci kanonicznej: co najmniej jedno z `server` (`u=`) i `iroh` (`k=` z `r=`).
public struct PairingLinkWire: Sendable, Equatable {
  /// Adres bazowy serwera (`https://host[:port]` w brzmieniu z linku, bez ukośnika), ``serverURL(_:)``.
  public let server: String?
  /// Serwer iroh: EndpointId (`k=`) i relay (`r=`) — ten sam kształt co `iroh` w odpowiedziach REST.
  public let iroh: ServerIroh?
  /// Kod jednorazowy (32 B base64url, 43 znaki).
  public let code: String

  /// Schemat linku (`PAIRING_LINK_SCHEME` w TS) — ten sam co `CFBundleURLSchemes`, `PushRouting.scheme`
  /// i `LiveActivityPresentation.scheme`; zgodności pilnuje `server/test/product-identity-guard.test.ts`.
  public static let scheme = "rarog"

  /// Host of the universal pairing link `https://<host>/pair#v=…` (`PAIRING_LINK_HOST` in TS), which ``link`` writes:
  /// the product site domain, the same as in `ProductLinks`; `server/test/product-identity-guard.test.ts` keeps them
  /// equal.
  public static let host = "rarog.ai"

  /// Link prefixes accepted before `#`, in lower case (`PAIRING_LINK_PREFIXES` in TS). Exact match only: no port,
  /// user, trailing slash, query, `www` or plain `http`.
  static let prefixes = [Array("\(scheme)://pair".utf8), Array("https://\(host)/pair".utf8)]

  /// Wersja linku (`v=1`), ta sama co w ciele `POST /api/pair`.
  public static let version = String(PairBody.protocolVersion)

  public init(server: String?, iroh: ServerIroh?, code: String) {
    self.server = server
    self.iroh = iroh
    self.code = code
  }

  // MARK: Składanie

  /// The universal link `https://rarog.ai/pair#v=1&u=…&k=…&r=…&c=…` (``host``), which iOS opens only in the app the
  /// domain names. Pola w postaci kanonicznej (wynik ``parse(_:)``, ``serverURL(_:)``, ``relayURL(_:)``); składanie
  /// ich nie sprawdza. Adresy przez `encodeURIComponent`, `k` i `c` bez zmian; kod na końcu, więc link ucięty przy
  /// kopiowaniu traci kod, a nie adres. Bez `iroh` — fragment bajt w bajt sprzed `k=`/`r=`.
  public var link: String {
    var parts = ["v=\(Self.version)"]
    if let server { parts.append("u=\(Self.encodeComponent(server))") }
    if let iroh { parts += ["k=\(iroh.endpointId)", "r=\(Self.encodeComponent(iroh.relay))"] }
    parts.append("c=\(code)")
    return "https://\(Self.host)/pair#\(parts.joined(separator: "&"))"
  }

  /// `encodeURIComponent`: wszystko poza literami, cyframi i `-_.!~*'()` kodowane procentem (UTF-8).
  static func encodeComponent(_ text: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
  }

  // MARK: Parsowanie

  /// Text (pasted, from a QR code, a URL opened by the system) → fields or an error code. Order of checks as in
  /// `parsePairingLink` in TS (the first failure wins): link prefix (``prefixes``, ASCII case-insensitive), `v`
  /// (duplicate, version), duplicate `u`, `k`, `r`, `c`, bad `u`/`k`/`r`, missing `r`/`k`, no transport, code.
  /// Unknown fields (`t` too) are skipped.
  public static func parse(_ text: String) -> Result<PairingLinkWire, PairingLinkWireError> {
    // Białe znaki pomijane WSZĘDZIE: link skopiowany z terminala bywa złamany na końcu linii ekranu.
    var scalars = String.UnicodeScalarView()
    scalars.append(contentsOf: text.unicodeScalars.filter { !isWhitespace($0) })
    let compact = Array(String(scalars).utf8)
    guard let hash = compact.firstIndex(of: UInt8(ascii: "#")) else { return .failure(.notALink) }
    guard prefixes.contains(asciiLower(compact[..<hash])) else { return .failure(.notALink) }
    let items = fragmentItems(compact[(hash + 1)...])
    func all(_ name: String) -> [String?] { items.filter { $0.name == name }.map(\.value) }

    let versions = all("v")
    if versions.isEmpty || versions == [nil] { return .failure(.notALink) }
    if versions.count > 1 { return .failure(.duplicateField) }
    guard versions[0] == version else { return .failure(.unsupportedVersion) }
    if ["u", "k", "r", "c"].contains(where: { all($0).count > 1 }) { return .failure(.duplicateField) }
    /// `nil` = brak pola, `""` = pole bez wartości (obecne, więc sprawdzane jak puste).
    func field(_ name: String) -> String? { all(name).first.map { $0 ?? "" } }
    let (u, k, r, c) = (field("u"), field("k"), field("r"), field("c"))

    let server = u.flatMap(serverURL)
    if u != nil, server == nil { return .failure(.badAddress) }
    if let k, !isEndpointId(k) { return .failure(.badEndpointId) }
    let relay = r.flatMap(relayURL)
    if r != nil, relay == nil { return .failure(.badRelay) }
    if k != nil, relay == nil { return .failure(.missingRelay) }
    if relay != nil, k == nil { return .failure(.missingEndpointId) }
    if server == nil, k == nil { return .failure(.badAddress) }
    guard let c, isCode(c) else { return .failure(.badCode) }
    let iroh = k.flatMap { endpointId in relay.map { ServerIroh(endpointId: endpointId, relay: $0) } }
    return .success(PairingLinkWire(server: server, iroh: iroh, code: c))
  }

  /// Adres serwera z `u=` w postaci kanonicznej albo `nil`: `schemat://host[:port]` bez ukośnika, schemat i host
  /// w brzmieniu z linku (z tego adresu apka liczy `Origin`, a serwer porównuje go dosłownie z `RAROG_ORIGINS`), port
  /// jak go podano. Host: nazwa DNS, IPv4 albo literał IPv6 w nawiasach. Wyłącznie `https`; `http` tylko na loopbacku
  /// `127.0.0.1` i `localhost` (serwer demo testów UI).
  public static func serverURL(_ raw: String) -> String? {
    guard let address = LinkAddress(raw) else { return nil }
    let (scheme, host) = (address.scheme.lowercased(), address.host.lowercased())
    let loopback = host == "127.0.0.1" || host == "localhost"
    guard scheme == "https" || (scheme == "http" && loopback) else { return nil }
    return "\(address.scheme)://\(address.host)\(address.port.map { ":\($0)" } ?? "")"
  }

  /// Relay iroh z `r=` w postaci kanonicznej albo `nil`: zapis `RelayUrl` biblioteki, `https://host[:port]/`
  /// (małe litery, ukośnik na końcu, port 443 pominięty, kropka na końcu hosta zostaje). Wyłącznie `https` i host DNS
  /// albo IPv4 (zapisu literału IPv6 crate `url` nie odtwarzamy).
  public static func relayURL(_ raw: String) -> String? {
    guard let address = LinkAddress(raw), address.scheme.lowercased() == "https", !address.host.hasPrefix("[") else {
      return nil
    }
    let port = address.port.flatMap { $0 == 443 ? nil : ":\($0)" } ?? ""
    return "https://\(address.host.lowercased())\(port)/"
  }

  /// EndpointId iroh (`IROH_ENDPOINT_ID_RE`): 64 znaki hex małymi literami — `Display` klucza w `iroh-base`.
  public static func isEndpointId(_ raw: String) -> Bool {
    raw.utf8.count == 64 && raw.utf8.allSatisfy { isDigit($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }
  }

  /// Kod (`PAIRING_CODE_RE`): 43 znaki base64url (32 B). Inny kształt to nie nasz link.
  public static func isCode(_ raw: String) -> Bool {
    raw.utf8.count == 43 && raw.utf8.allSatisfy { isAlnum($0) || $0 == UInt8(ascii: "-") || $0 == UInt8(ascii: "_") }
  }

  // MARK: Reguły pomocnicze (bajty UTF-8)

  /// Pole fragmentu: `value == nil` = pole bez `=`.
  private struct Item {
    let name: String
    let value: String?
  }

  /// Fragment `a=1&b=2` → pola po odkodowaniu procentów (`decodeURIComponent`). Procent nie do odkodowania (jak
  /// w dawnym parserze apki): w nazwie — pole pominięte jak nieznane; w wartości — pole obecne bez wartości, więc
  /// błąd tego pola. Puste kawałki (`&&`, `&` na końcu) są pomijane.
  private static func fragmentItems(_ fragment: ArraySlice<UInt8>) -> [Item] {
    var items: [Item] = []
    for piece in fragment.split(separator: UInt8(ascii: "&"), omittingEmptySubsequences: true) {
      let eq = piece.firstIndex(of: UInt8(ascii: "="))
      guard let name = String(decoding: piece[..<(eq ?? piece.endIndex)], as: UTF8.self).removingPercentEncoding
      else { continue }
      let value = eq.flatMap { String(decoding: piece[($0 + 1)...], as: UTF8.self).removingPercentEncoding }
      items.append(Item(name: name, value: value))
    }
    return items
  }

  /// Białe znaki (`WHITESPACE_RE`): zbiór `CharacterSet.whitespacesAndNewlines`, którym czytał link dawny parser
  /// apki (kategoria Unicode Z*, U+0009–U+000D, U+0085, U+200B), i U+FEFF (BOM), wypisane jawnie, żeby zmiana zbioru
  /// w Foundation nie rozjechała Swift z TS.
  static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x85, 0x200B, 0xFEFF: return true
    default:
      switch scalar.properties.generalCategory {
      case .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
      default: return false
      }
    }
  }

  /// `schemat://host[:port][/]`: schemat `[A-Za-z][A-Za-z0-9+.-]*`, host IPv4 kropkowe (0–255, bez zer wiodących),
  /// nazwa DNS (litery ASCII, cyfry, myślniki; ostatnia etykieta od litery; kropka na końcu dozwolona) albo literał
  /// IPv6 w nawiasach, port 1–65535 bez zer wiodących. Bez użytkownika, zapytania, fragmentu i ścieżki innej niż `/`.
  /// Schemat i host w brzmieniu z linku (wielkość liter rozstrzyga użycie).
  private struct LinkAddress {
    let scheme: String
    let host: String
    let port: Int?

    init?(_ raw: String) {
      let bytes = Array(raw.utf8)
      guard let colon = bytes.firstIndex(of: UInt8(ascii: ":")), colon > 0, isAlpha(bytes[0]),
        bytes[1..<colon].allSatisfy({ isAlnum($0) || $0 == UInt8(ascii: "+") || $0 == UInt8(ascii: ".") || $0 == UInt8(ascii: "-") }),
        bytes[colon...].starts(with: Array("://".utf8))
      else { return nil }
      let rest = bytes[(colon + 3)...]
      let hostEnd: Int
      if rest.first == UInt8(ascii: "[") {
        guard let close = rest.firstIndex(of: UInt8(ascii: "]")) else { return nil }
        hostEnd = close + 1
      } else {
        hostEnd = rest.firstIndex { Array("/?#@:[]".utf8).contains($0) } ?? rest.endIndex
      }
      let host = rest[..<hostEnd]
      var tail = rest[hostEnd...]
      var port: Int?
      if tail.first == UInt8(ascii: ":") {
        let portEnd = tail.firstIndex(of: UInt8(ascii: "/")) ?? tail.endIndex
        let digits = tail[(tail.startIndex + 1)..<portEnd]
        guard let first = digits.first, first != UInt8(ascii: "0"), digits.count <= 5, digits.allSatisfy(PairingLinkWire.isDigit),
          let value = Int(String(decoding: digits, as: UTF8.self)), value <= 65_535
        else { return nil }
        port = value
        tail = tail[portEnd...]
      }
      let ipv6 = host.first == UInt8(ascii: "[") && Self.isIPv6(host.dropFirst().dropLast())
      guard tail.isEmpty || Array(tail) == [UInt8(ascii: "/")], ipv6 || Self.isIPv4(host) || Self.isDNSName(host) else {
        return nil
      }
      scheme = String(decoding: bytes[..<colon], as: UTF8.self)
      self.host = String(decoding: host, as: UTF8.self)
      self.port = port
    }

    /// Literał IPv6 bez nawiasów według RFC 3986 (`IPv6address`, `isIPv6` w TS): osiem grup po 1–4 cyfry
    /// szesnastkowe, najwyżej jedno `::` w miejsce co najmniej jednej grupy zer, IPv4 najwyżej na końcu. Bez strefy.
    private static func isIPv6(_ text: ArraySlice<UInt8>) -> Bool {
      let colon = UInt8(ascii: ":")
      var halves: [ArraySlice<UInt8>] = []
      var start = text.startIndex
      var index = text.startIndex
      while index < text.endIndex {
        if text[index] == colon, index + 1 < text.endIndex, text[index + 1] == colon {
          halves.append(text[start..<index])
          index += 2
          start = index
        } else {
          index += 1
        }
      }
      halves.append(text[start..<text.endIndex])
      guard halves.count <= 2 else { return false }
      func groups(_ part: ArraySlice<UInt8>) -> [ArraySlice<UInt8>] {
        part.isEmpty ? [] : part.split(separator: colon, omittingEmptySubsequences: false)
      }
      var head = groups(halves[0])
      var tail = halves.count == 2 ? groups(halves[1]) : []
      var count = head.count + tail.count
      let last = halves.count == 2 ? tail.last : head.last
      if let last, last.contains(UInt8(ascii: ".")) {
        guard isIPv4(last) else { return false }
        if halves.count == 2 { tail.removeLast() } else { head.removeLast() }
        count += 1
      }
      let hex = { (byte: UInt8) in
        PairingLinkWire.isDigit(byte) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte | 0x20)
      }
      guard (head + tail).allSatisfy({ !$0.isEmpty && $0.count <= 4 && $0.allSatisfy(hex) }) else { return false }
      return halves.count == 2 ? count <= 7 : count == 8
    }

    /// `IPV4_RE`: cztery liczby 0–255 bez zer wiodących.
    private static func isIPv4(_ host: ArraySlice<UInt8>) -> Bool {
      let parts = host.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
      return parts.count == 4 && parts.allSatisfy { part in
        guard !part.isEmpty, part.count <= 3, part.allSatisfy(PairingLinkWire.isDigit),
          part.count == 1 || part.first != UInt8(ascii: "0"),
          let value = Int(String(decoding: part, as: UTF8.self))
        else { return false }
        return value <= 255
      }
    }

    /// `DNS_HOST_RE`: etykiety `[A-Za-z0-9-]+` rozdzielone kropkami, ostatnia od litery, kropka na końcu dozwolona.
    /// Host kończący się liczbą parser URL (WHATWG, crate `url` w iroh) czyta jako IPv4 i zapisuje inaczej.
    private static func isDNSName(_ host: ArraySlice<UInt8>) -> Bool {
      let name = host.last == UInt8(ascii: ".") ? host.dropLast() : host
      let labels = name.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
      guard let last = labels.last, let first = last.first, PairingLinkWire.isAlpha(first) else { return false }
      return labels.allSatisfy { label in
        !label.isEmpty && label.allSatisfy { PairingLinkWire.isAlnum($0) || $0 == UInt8(ascii: "-") }
      }
    }
  }

  /// Małe litery tylko w ASCII — reguły przyjmują wyłącznie ASCII.
  private static func asciiLower(_ bytes: ArraySlice<UInt8>) -> [UInt8] {
    bytes.map { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) ? $0 + 0x20 : $0 }
  }

  private static func isDigit(_ byte: UInt8) -> Bool { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) }

  private static func isAlpha(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
  }

  private static func isAlnum(_ byte: UInt8) -> Bool { isAlpha(byte) || isDigit(byte) }
}

/// Dlaczego tekst nie jest linkiem parowania — te same kody co `PAIRING_LINK_ERRORS` w TS (wartość surowa = kod
/// z manifestu). Zdań nie ma: ekran mówi przez `PairingLinkError` w RarogCore.
public enum PairingLinkWireError: String, Error, Sendable, CaseIterable {
  /// Neither `rarog://pair#…` nor `https://rarog.ai/pair#…`, unreadable fragment, no `v`.
  case notALink = "not-a-link"
  case unsupportedVersion = "unsupported-version"
  /// Znane pole (`v`, `u`, `k`, `r`, `c`) więcej niż raz.
  case duplicateField = "duplicate-field"
  /// `u=` spoza reguł albo brak transportu (ani `u`, ani `k`).
  case badAddress = "bad-address"
  case badEndpointId = "bad-endpoint-id"
  case badRelay = "bad-relay"
  /// `k=` bez `r=` — bez discovery relay jest potrzebny do każdego połączenia.
  case missingRelay = "missing-relay"
  case missingEndpointId = "missing-endpoint-id"
  case badCode = "bad-code"
}
