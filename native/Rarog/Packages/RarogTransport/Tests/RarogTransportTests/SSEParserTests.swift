import Foundation
import RarogContractFixtures
@testable import RarogTransport
import Synchronization
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

  // MARK: - Ceiling

  /// Outputs in short form: an event of many megabytes in a failure message would flood the log.
  private func brief(_ outputs: [SSEParser.Output]) -> [String] {
    outputs.map { output in
      switch output {
      case let .event(event): "event \(event.data.utf8.count) B"
      case let .retry(milliseconds): "retry \(milliseconds)"
      case let .comment(text): "comment \(text.utf8.count) B"
      case let .oversized(part): "oversized \(part)"
      }
    }
  }

  private static let mebibyte = [UInt8](repeating: UInt8(ascii: "x"), count: 1 << 20)
  /// Ceiling of the 40 MiB cases: the real one sits far above, and a test must not buffer hundreds of MiB to reach it.
  private static let testCeiling = 32 << 20

  @Test("an event of 40 MiB without a line end is cut once, at the ceiling; later bytes give nothing")
  func longLineIsCut() {
    var parser = SSEParser(maxEventBytes: Self.testCeiling)
    var out = parser.feed(Array("data: ".utf8))
    for _ in 0 ..< 40 { out += parser.feed(Self.mebibyte) }
    out += parser.feed(Array("\n\ndata: a\n\n".utf8))
    #expect(brief(out) == ["oversized line"])
  }

  @Test("an event of 40 MiB from many short data lines is cut once, at the ceiling")
  func manyShortLinesAreCut() {
    var parser = SSEParser(maxEventBytes: Self.testCeiling)
    let line = Array("data: \(String(repeating: "x", count: 1017))\n".utf8)
    var out: [SSEParser.Output] = []
    for _ in 0 ..< 40 * 1024 { out += parser.feed(line) }
    out += parser.feed(Array("\ndata: a\n\n".utf8))
    #expect(brief(out) == ["oversized event"])
  }

  @Test("a line and an event of exactly the ceiling pass; one byte more cuts")
  func ceilingBoundary() {
    var parser = SSEParser(maxEventBytes: 16)
    #expect(brief(parser.feed(Array("data: 0123456789\n\n".utf8))) == ["event 10 B"])
    #expect(brief(parser.feed(Array("data: abcdefg\ndata: hijklmno\n\n".utf8))) == ["event 16 B"])
    var long = SSEParser(maxEventBytes: 16)
    #expect(brief(long.feed(Array("data: 0123456789A\n\n".utf8))) == ["oversized line"])
    var joined = SSEParser(maxEventBytes: 16)
    #expect(brief(joined.feed(Array("data: abcdefg\ndata: hijklmnop\n\ndata: z\n\n".utf8))) == ["oversized event"])
  }

  @Test("after a big event both buffers together keep at most 256 KiB", arguments: [100, 120, 200, 300, 1024])
  func capacityAfterBigEvent(kibibytes: Int) {
    var parser = SSEParser()
    let size = kibibytes * 1024
    let out = parser.feed(Array("data: ".utf8) + Self.mebibyte.prefix(size) + Array("\n\n".utf8))
    #expect(brief(out) == ["event \(size) B"])
    #expect(parser.bufferCapacity <= 256 * 1024)
  }

  @Test("short lines reuse one line buffer instead of a new one per line")
  func lineBufferReused() {
    var parser = SSEParser()
    _ = parser.feed(Array("data: first\n".utf8))
    let storage = parser.lineStorage
    var moved = 0
    for index in 0 ..< 8 {
      _ = parser.feed(Array("data: \(index)\n".utf8))
      if parser.lineStorage != storage { moved += 1 }
    }
    #expect(storage != nil && moved == 0)
  }

  /// The largest frame the server builds is a transcript snapshot: a full ring and the image budget, plus every
  /// pending consent card of the session, each with a presentation of up to `CONSENT_DISPLAY_MAX` bytes. JSON
  /// escaping at most doubles a presentation (its text is already JSON or a command), hence the factors of 2.
  @Test("the ceiling holds the server's largest legitimate frame: a full ring, the image budget and every consent card")
  func ceilingAboveServerFrame() throws {
    let ring = try Self.tsValue("RING_MAX_BYTES", in: "server/src/sessions/ring-buffer.ts")
    let images = try Self.tsValue("MAX_IMAGE_DATA_URL_BYTES", in: "shared/src/protocol/attachments.ts")
    let cards = try Self.tsValue(
      "CONSENT_REGISTRATIONS_PER_SESSION_MAX", in: "server/src/herdr/dialogs/layer1/contract.ts")
    let card = try Self.tsValue("CONSENT_DISPLAY_MAX", in: "server/src/herdr/dialogs/layer1/contract.ts")
    #expect(ring > 0 && images > 0 && cards > 0 && card > 0)
    #expect(SSEParser.maxEventBytes >= 2 * (ring + images) + 2 * cards * card)
  }

  /// Value of `export const <name> = <a> * <b> + <c> …;` (sums of products, also inside `Math.round(…)`) in a TS
  /// file of the repo.
  private static func tsValue(_ name: String, in path: String) throws -> Int {
    let source = try String(contentsOf: GoldenFrames.repoRoot().appending(path: path), encoding: .utf8)
    let pattern = try Regex(#"export const \#(name) = (?:Math\.round\()?([0-9.]+(?: [*+] [0-9.]+)*)\)?;"#)
    let match = try #require(source.firstMatch(of: pattern), "no \(name) in \(path)")
    let sum = try #require(match.output[1].substring).split(separator: "+").reduce(0.0) { total, term in
      total + term.split(separator: "*").reduce(1.0) { value, factor in
        value * (Double(factor.trimmingCharacters(in: .whitespaces)) ?? .nan)
      }
    }
    return Int(try #require(sum.isFinite ? sum.rounded() : nil))
  }

  @Test("RarogClient: a 40 MiB line ends the stream with the cut and lets the request go")
  func clientEndsCutStream() async throws {
    let chunks = [Data("data: ".utf8)] + Array(repeating: Data(Self.mebibyte), count: 40)
    let harness = MockHarness { _ in
      MockURLProtocol.Reply(
        status: 200, headers: ["Content-Type": "text/event-stream"], chunks: chunks, afterChunks: .stayOpen)
    }
    var client = harness.client
    client.streamEventCeiling = Self.testCeiling
    let outputs = Mutex<[SSEParser.Output]>([])
    let ended = Mutex(false)
    let stream = try await client.openStream(.global)
    let reader = Task {
      defer { ended.withLock { $0 = true } }
      for try await output in stream { outputs.withLock { $0.append(output) } }
    }
    try await until("the stream ends", limit: .seconds(60)) { ended.withLock { $0 } }
    reader.cancel()
    #expect(brief(outputs.withLock { $0 }) == ["oversized line"])
    try await until("the request is let go") { MockURLProtocol.held(port: harness.port) == 0 }
  }
}
