/// Zdarzenie SSE po złożeniu (WHATWG HTML, „Interpreting an event stream").
public struct SSEEvent: Sendable, Equatable {
  /// Pole `event:`; domyślnie `message`. Serwer Raroga nadaje też nazwane `ping` (heartbeat).
  public var type: String
  /// Pole `data:` — wieloliniowe `data:` sklejone znakiem `\n`.
  public var data: String
  /// `id:` z TEGO bloku albo `nil` (ulotne `delta`/`activity` nie niosą `id:`).
  public var id: String?
  /// Kursor strumienia po tym zdarzeniu — ostatnie `id:`, jakie przyszło (trwa między blokami).
  public var lastEventId: String

  public init(type: String = "message", data: String, id: String? = nil, lastEventId: String = "") {
    self.type = type
    self.data = data
    self.id = id
    self.lastEventId = lastEventId
  }
}

/// Parser strumienia SSE na BAJTACH.
///
/// Własny, bo `URLSession.AsyncBytes.lines` gubi puste linie (zmierzone), a pusta
/// linia zamyka zdarzenie. Reguły:
/// - końce linii: CR, LF i CRLF — także CRLF rozcięte na granicy dwóch kawałków;
/// - CAŁA składnia (koniec linii, `:`, spacja po `:`, nazwy pól) idzie po BAJTACH, a UTF-8
///   dekodowany jest dopiero z gotowej wartości. Na `Character`/`String` dwukropek i znak
///   łączący (`:` + U+0301) to JEDEN grafem, tak samo `\r\n` — operacje na znakach gubiłyby
///   separator. Bajty CR/LF/`:` nie występują w środku znaku
///   wielobajtowego, więc znak rozcięty między kawałkami przychodzi cały; U+2028 NIE jest
///   końcem linii; niepoprawny UTF-8 → znak zastępczy;
/// - BOM na początku strumienia jest pomijany;
/// - `:` na początku linii = komentarz; pole bez `:` = nazwa pola z pustą wartością; jeden
///   bajt spacji po `:` jest zdejmowany;
/// - `retry:` tylko z cyframi ASCII; `id:` ze znakiem NUL jest ignorowane;
/// - pusta linia wysyła zdarzenie, jeśli bufor `data` nie jest pusty; niedokończone zdarzenie
///   na końcu strumienia przepada.
public struct SSEParser: Sendable {
  /// Wynik jednej linii.
  public enum Output: Sendable, Equatable {
    case event(SSEEvent)
    /// `retry:` — sugerowany odstęp ponownego łączenia w ms.
    case retry(Int)
    /// Komentarz (heartbeat `: ping`) — dowód życia strumienia, bez treści protokołu.
    case comment(String)
  }

  private var line: [UInt8] = []
  private var afterCR = false
  private var atStreamStart = true
  /// Bufor `data` w bajtach (linie sklejone bajtem LF) — dekodowany raz, przy wysyłce.
  private var data: [UInt8] = []
  private var hasData = false
  private var eventType = ""
  private var blockID: String?
  public private(set) var lastEventId = ""

  public init() {}

  /// Przyjmuje jeden bajt; zwraca wynik, gdy bajt zamknął linię, która coś niesie.
  public mutating func push(_ byte: UInt8) -> Output? {
    if afterCR {
      afterCR = false
      // LF zaraz po CR to ten sam koniec linii (CRLF), także na granicy kawałków.
      if byte == 0x0A { return nil }
    }
    switch byte {
    case 0x0D:
      afterCR = true
      return endOfLine()
    case 0x0A:
      return endOfLine()
    default:
      line.append(byte)
      return nil
    }
  }

  /// Przyjmuje kawałek bajtów; zwraca wyniki w kolejności.
  public mutating func feed(_ bytes: some Sequence<UInt8>) -> [Output] {
    var out: [Output] = []
    for byte in bytes {
      if let output = push(byte) { out.append(output) }
    }
    return out
  }

  private mutating func endOfLine() -> Output? {
    var bytes = line[...]
    line.removeAll(keepingCapacity: true)
    if atStreamStart {
      atStreamStart = false
      if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes = bytes.dropFirst(3) }
    }
    if bytes.isEmpty { return dispatch() }
    let field: ArraySlice<UInt8>
    var value: ArraySlice<UInt8>
    if let colon = bytes.firstIndex(of: Self.colon) {
      if colon == bytes.startIndex { return .comment(Self.text(bytes.dropFirst())) }
      field = bytes[..<colon]
      value = bytes[(colon + 1)...]
      if value.first == Self.space { value = value.dropFirst() }
    } else {
      field = bytes
      value = []
    }
    return process(field: field, value: value)
  }

  private mutating func process(field: ArraySlice<UInt8>, value: ArraySlice<UInt8>) -> Output? {
    if field.elementsEqual("event".utf8) {
      eventType = Self.text(value)
    } else if field.elementsEqual("data".utf8) {
      if hasData { data.append(0x0A) }
      data.append(contentsOf: value)
      hasData = true
    } else if field.elementsEqual("id".utf8) {
      if !value.contains(0x00) {
        lastEventId = Self.text(value)
        blockID = lastEventId
      }
    } else if field.elementsEqual("retry".utf8) {
      return Self.milliseconds(value).map(Output.retry)
    }
    return nil
  }

  /// `retry:` — wyłącznie cyfry ASCII, bez przepełnienia; inaczej pole jest ignorowane.
  private static func milliseconds(_ value: ArraySlice<UInt8>) -> Int? {
    guard !value.isEmpty else { return nil }
    var result = 0
    for byte in value {
      guard (0x30...0x39).contains(byte) else { return nil }
      let (times, overflowA) = result.multipliedReportingOverflow(by: 10)
      let (sum, overflowB) = times.addingReportingOverflow(Int(byte - 0x30))
      guard !overflowA, !overflowB else { return nil }
      result = sum
    }
    return result
  }

  private static func text(_ bytes: some Collection<UInt8>) -> String {
    String(decoding: bytes, as: UTF8.self)
  }

  private static let colon = UInt8(ascii: ":")
  private static let space = UInt8(ascii: " ")

  private mutating func dispatch() -> Output? {
    defer {
      data.removeAll(keepingCapacity: true)
      hasData = false
      eventType = ""
      blockID = nil
    }
    guard hasData else { return nil }
    return .event(SSEEvent(
      type: eventType.isEmpty ? "message" : eventType,
      data: Self.text(data),
      id: blockID,
      lastEventId: lastEventId
    ))
  }
}
