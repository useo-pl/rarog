import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogTransport
import Testing

// Cięcie wejścia terminala: te same kawałki co `chunkInput` w PWA (wektory 1:1 z
// `shared/fixtures/term/chunk-vectors.json`) i KAŻDA gotowa ramka z drogi gniazda ≤ 8192 B.

/// Plik wektorów — kształt pilnuje też `shared/test/term-fixtures.test.ts`.
private struct Vectors: Decodable {
  struct Repeat: Decodable {
    let unit: String
    let count: Int
  }

  struct Case: Decodable {
    let name: String
    let max: Int
    let input: String?
    let `repeat`: Repeat?
    let inputUtf16: [Int]?
    let chunks: [String]?
    let chunkScalars: [Int]?
    let frameBytes: [Int]
  }

  struct PasteCase: Decodable {
    let name: String
    let input: String?
    let `repeat`: Repeat?
    let refused: Bool?
    let chunks: [String]?
    let chunkScalars: [Int]?
    let frameBytes: [Int]?
    let ends: [Bool]?
  }

  let maxFrameBytes: Int
  let frameOverheadBytes: Int
  let cases: [Case]
  let maxPasteBytes: Int
  let paste: [PasteCase]

  static let shared: Vectors = {
    do {
      let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/term/chunk-vectors.json")
      return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    } catch {
      fatalError("wektory cięcia: nie da się wczytać — \(error)")
    }
  }()
}

@Suite("cięcie wejścia terminala")
struct TerminalInputChunkerTests {
  @Test("stałe jak w PWA: sufit 8192 B, narzut pustej ramki `in` 17 B")
  func constants() {
    #expect(Vectors.shared.maxFrameBytes == TerminalWire.maxFrameBytes)
    #expect(Vectors.shared.frameOverheadBytes == TerminalInputChunker.frameOverheadBytes)
  }

  @Test(
    "wektor PWA: te same kawałki i te same bajty ramek",
    arguments: Vectors.shared.cases.filter { $0.inputUtf16 == nil }.map(\.name))
  func vector(_ name: String) throws {
    let entry = try #require(Vectors.shared.cases.first { $0.name == name })
    let input = entry.repeat.map { String(repeating: $0.unit, count: $0.count) } ?? entry.input ?? ""
    let chunks = TerminalInputChunker.chunks(input, maxFrameBytes: entry.max)
    if let expected = entry.chunks {
      #expect(chunks == expected)
    } else {
      #expect(chunks.map(\.unicodeScalars.count) == entry.chunkScalars)
    }
    #expect(chunks.map { TerminalFrameEncoder.data(.input($0)).count } == entry.frameBytes)
    #expect(chunks.joined() == input)
  }

  @Test("samotny surogat jest tylko w PWA: `String` w Swift go nie mieści (zamienia na U+FFFD)")
  func loneSurrogateIsUtf16Only() {
    #expect(Vectors.shared.cases.contains { $0.inputUtf16 != nil })
    let decoded = String(decoding: [UInt16(0xD800)], as: UTF16.self)
    #expect(decoded.unicodeScalars.map(\.value) == [0xFFFD])
  }

  @Test("rachunek na skalar = koder ramek: cały ASCII, granice UTF-8 i separatory")
  func framedBytesMatchEncoder() throws {
    let samples: [UInt32] = Array(0..<0x80) + [0x80, 0x85, 0x7FF, 0x800, 0x2028, 0x2029, 0xFEFF, 0xFFFD, 0xFFFF,
      0x1_0000, 0x1_F600, 0x10_FFFF]
    let overhead = TerminalInputChunker.frameOverheadBytes
    for value in samples {
      let scalar = try #require(Unicode.Scalar(value))
      let framed = TerminalFrameEncoder.data(.input(String(scalar))).count - overhead
      #expect(TerminalInputChunker.framedBytes(scalar) == framed, "U+\(String(value, radix: 16))")
    }
  }

  @Test(
    "20 kB z drogi gniazda: każda finalna ramka ≤ 8192 B, emoji nie łamane, nic nie ginie",
    arguments: ["/", "\u{1B}[A", "\"\\", "😀", "👍🏽", "zażółć\r\n", "\u{0}\u{7F}\u{2028}"])
  func finalFrameSize(_ unit: String) throws {
    var input = ""
    while input.utf8.count < 20_000 { input += unit }
    let frames = TerminalInputChunker.frames(input)
    #expect(frames.count >= 2)
    var rebuilt = ""
    for frame in frames {
      let message = try #require(TerminalRequestBuilder.message(for: frame))
      #expect(message.utf8.count <= TerminalWire.maxFrameBytes)
      guard case let .input(text) = frame else { Issue.record("ramka inna niż `in`"); continue }
      rebuilt += text
    }
    #expect(rebuilt == input)
    #expect(rebuilt.unicodeScalars.elementsEqual(input.unicodeScalars))
  }

  @Test("pusty tekst = zero ramek; sufit poniżej narzutu = jeden skalar na ramkę")
  func edges() {
    #expect(TerminalInputChunker.frames("").isEmpty)
    #expect(TerminalInputChunker.chunks("abc", maxFrameBytes: 5) == ["a", "b", "c"])
  }

  @Test("droga gniazda nie wypuści ramki ponad sufit (zerwałaby gniazdo)")
  func oversizedMessageRefused() {
    let big = TerminalClientFrame.input(String(repeating: "a", count: TerminalWire.maxFrameBytes))
    #expect(TerminalRequestBuilder.message(for: big) == nil)
    #expect(TerminalRequestBuilder.message(for: .input("ls\r")) == #"{"d":"ls\r","t":"in"}"#)
  }

  @Test("wklejka: sufit 512 kB i narzut ramki `pa` jak w PWA")
  func pasteConstants() {
    #expect(Vectors.shared.maxPasteBytes == TerminalWire.maxPasteBytes)
    // `{"d":"","e":false,"t":"pa"}` — o 10 B dłuższa od pustej ramki `in` (PWA: `PASTE_FRAME_EXTRA_BYTES`).
    #expect(TerminalPaste.frameOverheadBytes == TerminalInputChunker.frameOverheadBytes + 10)
  }

  @Test("wektor wklejki PWA: te same kawałki, bajty ramek i `e` tylko na ostatniej; odmowa ponad sufit",
    arguments: Vectors.shared.paste.map(\.name))
  func pasteVector(_ name: String) throws {
    let entry = try #require(Vectors.shared.paste.first { $0.name == name })
    let input = entry.repeat.map { String(repeating: $0.unit, count: $0.count) } ?? entry.input ?? ""
    let frames = TerminalPaste.frames(input)
    if entry.refused == true {
      #expect(frames == nil)
      return
    }
    let parts = try #require(frames).map { frame -> (String, Bool) in
      guard case let .paste(text, end) = frame else { Issue.record("ramka inna niż `pa`"); return ("", false) }
      return (text, end)
    }
    if let chunks = entry.chunks {
      #expect(parts.map(\.0) == chunks)
    } else {
      #expect(parts.map(\.0.unicodeScalars.count) == entry.chunkScalars)
    }
    #expect(parts.map(\.1) == entry.ends)
    let wire = try frames?.map { try #require(TerminalRequestBuilder.message(for: $0)).utf8.count }
    #expect(wire == entry.frameBytes)
    #expect(parts.map(\.0).joined() == input)
  }

  @Test("wklejka jedzie SUROWO: końce linii i znaczniki 200~/201~ czyści serwer, nie klient")
  func pasteIsRaw() throws {
    let text = "raz\r\ndwa\ntrzy\u{1B}[201~rm -rf /\r"
    let frames = try #require(TerminalPaste.frames(text))
    #expect(frames == [.paste(text, end: true)])
    #expect(TerminalPaste.frames("") == [])
  }
}
