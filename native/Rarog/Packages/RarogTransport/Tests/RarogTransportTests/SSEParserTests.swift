import RarogTransport
import Testing

@Suite("parser SSE: przypadki brzegowe (WHATWG)")
struct SSEParserTests {
  /// Parsuje tekst podany kawałkami po `chunk` bajtów.
  private func parse(_ text: String, chunk: Int = .max) -> [SSEParser.Output] {
    parse(bytes: Array(text.utf8), chunk: chunk)
  }

  private func parse(bytes: [UInt8], chunk: Int = .max) -> [SSEParser.Output] {
    var parser = SSEParser()
    var out: [SSEParser.Output] = []
    var index = 0
    while index < bytes.count {
      let end = min(bytes.count, index + max(1, min(chunk, bytes.count)))
      out += parser.feed(bytes[index..<end])
      index = end
    }
    return out
  }

  private func events(_ outputs: [SSEParser.Output]) -> [SSEEvent] {
    outputs.compactMap { if case let .event(event) = $0 { event } else { nil } }
  }

  @Test("LF, CRLF i CR dają to samo", arguments: ["\n", "\r\n", "\r"])
  func lineEndings(_ eol: String) {
    let text = ["id: s:1", "data: {\"a\":1}", "", "data: b", ""].joined(separator: eol) + eol
    #expect(events(parse(text)) == [
      SSEEvent(data: #"{"a":1}"#, id: "s:1", lastEventId: "s:1"),
      SSEEvent(data: "b", id: nil, lastEventId: "s:1"),
    ])
  }

  @Test("CRLF rozcięte na granicy kawałków to JEDEN koniec linii")
  func splitCRLF() {
    var parser = SSEParser()
    var out = parser.feed(Array("data: a\r".utf8))
    out += parser.feed(Array("\ndata: b\r".utf8))
    out += parser.feed(Array("\n\r".utf8))
    out += parser.feed(Array("\n".utf8))
    #expect(events(out) == [SSEEvent(data: "a\nb")])
  }

  @Test("wieloliniowe data: sklejone \\n; pole bez dwukropka = pusta wartość")
  func multilineData() {
    #expect(events(parse("data: a\ndata: b\ndata\n\n")) == [SSEEvent(data: "a\nb\n")])
    #expect(events(parse("data\n\n")) == [SSEEvent(data: "")])
  }

  @Test("zdejmowana jest dokładnie jedna spacja po dwukropku")
  func singleSpace() {
    #expect(events(parse("data:x\n\ndata:  y\n\n")) == [SSEEvent(data: "x"), SSEEvent(data: " y")])
  }

  @Test("id trwa między zdarzeniami; id ze znakiem NUL jest ignorowane")
  func lastEventId() {
    let out = events(parse("id: 7\ndata: a\n\nid: x\u{0}y\ndata: b\n\nid\ndata: c\n\n"))
    #expect(out.map(\.lastEventId) == ["7", "7", ""])
    #expect(out.map(\.id) == ["7", nil, ""])
  }

  @Test("retry: tylko cyfry ASCII")
  func retry() {
    #expect(parse("retry: 3000\n\n") == [.retry(3000)])
    #expect(parse("retry: 3s\nretry:\nretry: -1\n\n") == [])
  }

  @Test("komentarz i nazwane zdarzenie heartbeat")
  func heartbeat() {
    #expect(parse(": ping\nevent: ping\ndata: {}\n\n") == [
      .comment(" ping"),
      .event(SSEEvent(type: "ping", data: "{}")),
    ])
  }

  @Test("blok bez data nie wysyła zdarzenia i zeruje typ zdarzenia")
  func emptyBlockResetsType() {
    #expect(events(parse("event: ping\n\ndata: y\n\n")) == [SSEEvent(data: "y")])
  }

  @Test("niedokończone zdarzenie na końcu strumienia przepada")
  func incompleteAtEOF() {
    #expect(events(parse("data: a\n")) == [])
    #expect(events(parse("data: a")) == [])
  }

  @Test("BOM pomijany tylko na początku strumienia")
  func byteOrderMark() {
    #expect(events(parse("\u{FEFF}data: a\n\n")) == [SSEEvent(data: "a")])
    #expect(events(parse("data: a\n\n\u{FEFF}data: b\n\n")) == [SSEEvent(data: "a")])
  }

  @Test("UTF-8 rozcięty na każdej granicy bajtu przychodzi cały; U+2028 nie tnie linii")
  func utf8Boundaries() {
    let text = "data: Zażółć gęślą jaźń 🚀\u{2028}druga\n\n"
    #expect(events(parse(text, chunk: 1)) == [SSEEvent(data: "Zażółć gęślą jaźń 🚀\u{2028}druga")])
  }

  @Test("niepoprawny UTF-8 → znak zastępczy, strumień żyje dalej")
  func invalidUTF8() {
    let bytes = Array("data: a".utf8) + [0xFF] + Array("b\n\ndata: c\n\n".utf8)
    #expect(events(parse(bytes: bytes)) == [SSEEvent(data: "a\u{FFFD}b"), SSEEvent(data: "c")])
  }

  /// Skalary danych — porównanie `String` jest kanoniczne, a tu liczy się każdy skalar z drutu.
  private func scalars(_ outputs: [SSEParser.Output]) -> [[Unicode.Scalar]] {
    events(outputs).map { Array($0.data.unicodeScalars) }
  }

  @Test("znak łączący tuż po dwukropku nie skleja się z separatorem (`:` + U+0301 to jeden grafem)")
  func combiningMarkAfterColon() {
    #expect(scalars(parse("data:\u{0301}x\n\n")) == [["\u{0301}", "x"]])
    #expect(parse(":\u{0301} komentarz\n") == [.comment("\u{0301} komentarz")])
    #expect(events(parse("id:\u{0301}7\ndata: a\n\n")).map(\.lastEventId) == ["\u{0301}7"])
  }

  @Test("znak łączący po spacji: zdejmowany jest tylko bajt spacji")
  func combiningMarkAfterSpace() {
    #expect(scalars(parse("data: \u{0301}x\n\n")) == [["\u{0301}", "x"]])
    #expect(scalars(parse("data:  \u{0301}x\n\n")) == [[" ", "\u{0301}", "x"]])
  }

  @Test("znak łączący rozcięty między kawałkami (U+0301 = CC 81) i sklejany z LF poprzedniej linii")
  func combiningMarkSplitAcrossChunks() {
    for chunk in [1, 2, 6, 7] {
      let parsed = scalars(parse("data:\u{0301}x\ndata: \u{0301}y\n\n", chunk: chunk))
      #expect(parsed == [["\u{0301}", "x", "\n", "\u{0301}", "y"]], "kawałki po \(chunk) B")
    }
  }

  @Test("`\\r\\n` (jeden grafem) i znak łączący po CR/LF — podział linii po bajtach")
  func crlfGraphemes() {
    // CR, potem znak łączący: CR kończy linię, znak łączący zaczyna następną (pole nieznane).
    let afterCR = events(parse("data: a\r\u{0301}data: b\n\ndata: c\r\n\r\n"))
    #expect(afterCR == [SSEEvent(data: "a"), SSEEvent(data: "c")])
    #expect(scalars(parse("data: a\r\ndata:\u{0301}\r\n\r\n", chunk: 1)) == [["a", "\n", "\u{0301}"]])
  }

  @Test("retry: przepełnienie Int jest ignorowane")
  func retryOverflow() {
    #expect(parse("retry: 99999999999999999999999\n\n") == [])
  }

  @Test("nieznane pole jest ignorowane")
  func unknownField() {
    #expect(events(parse("foo: bar\ndata: a\n\n")) == [SSEEvent(data: "a")])
  }
}
