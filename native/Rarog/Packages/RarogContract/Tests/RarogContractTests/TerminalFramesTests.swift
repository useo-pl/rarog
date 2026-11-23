// Złote ramki terminala, strona klienta Swift — lustro `shared/test/term-fixtures.test.ts` na tych
// samych plikach (`shared/fixtures/term/`). Ramki klienta produkuje PWA: koder apki musi dać TĘ SAMĄ
// treść i TĘ SAMĄ długość na drucie (`wireBytes` z manifestu), bo od długości zależy budżet 8 KiB.
// Ramki serwera produkuje `ws.ts`: dekoder apki rozpoznaje każdą.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("złote ramki terminala: manifest → typy Swift")
struct TerminalFramesTests {
  struct Entry: Sendable, Decodable {
    let kind: String
    let t: String?
    let wireBytes: Int?
  }

  static let directory: URL = {
    do {
      return try GoldenFrames.repoRoot().appending(path: "shared/fixtures/term", directoryHint: .isDirectory)
    } catch {
      fatalError("złote ramki terminala: brak katalogu repo — \(error)")
    }
  }()

  static let manifest: [String: Entry] = {
    do {
      let data = try Data(contentsOf: directory.appending(path: "manifest.json"))
      return try JSONDecoder().decode([String: Entry].self, from: data)
    } catch {
      fatalError("złote ramki terminala: nie da się wczytać manifestu — \(error)")
    }
  }()

  static func names(_ kind: String) -> [String] {
    manifest.filter { $0.value.kind == kind }.keys.sorted()
  }

  static func document(_ name: String) throws -> JSONValue {
    try JSONValue.parse(Data(contentsOf: directory.appending(path: name)))
  }

  /// Ramka klienta z dokumentu złotego pliku — każdy typ z manifestu MUSI mieć tu swój przypadek
  /// (nowy typ ramki w kontrakcie bez typu Swift przewraca test).
  static func clientFrame(_ document: JSONValue) throws -> TerminalClientFrame {
    guard case let .object(fields) = document, case let .string(type)? = fields["t"] else {
      throw CocoaError(.coderReadCorrupt)
    }
    func int(_ key: String) -> Int? {
      if case let .number(value)? = fields[key] { return Int(exactly: value) }
      return nil
    }
    switch type {
    case "in":
      guard case let .string(text)? = fields["d"] else { throw CocoaError(.coderReadCorrupt) }
      return .input(text)
    case "rs":
      let grid = try #require(TerminalGrid(cols: int("c") ?? 0, rows: int("r") ?? 0))
      return .resize(grid)
    case "sc":
      let cell = int("c").flatMap { col in int("r").flatMap { TerminalCell(col: col, row: $0) } }
      return .scroll(try #require(TerminalScrollStep(lines: int("d") ?? .max, cell: cell)))
    case "pa":
      guard case let .string(text)? = fields["d"], case let .bool(end)? = fields["e"] else {
        throw CocoaError(.coderReadCorrupt)
      }
      return .paste(text, end: end)
    default:
      Issue.record("typ ramki klienta \(type) bez typu Swift")
      throw CocoaError(.coderReadCorrupt)
    }
  }

  @Test("manifest ↔ katalog w obie strony")
  func manifestMatchesDirectory() throws {
    let files = try FileManager.default.contentsOfDirectory(atPath: Self.directory.path)
      .filter { $0 != "manifest.json" }
      .sorted()
    #expect(files == Self.manifest.keys.sorted())
  }

  @Test("ramka klienta: ta sama treść i ta sama długość na drucie co w PWA", arguments: names("client"))
  func clientFrameParity(_ name: String) throws {
    let entry = try #require(Self.manifest[name])
    let document = try Self.document(name)
    let frame = try Self.clientFrame(document)
    #expect(frame.type == entry.t)
    let wire = TerminalFrameEncoder.data(frame)
    #expect(try JSONValue.parse(wire) == document)
    #expect(wire.count == entry.wireBytes)
    #expect(wire.count <= TerminalWire.maxFrameBytes)
  }

  @Test("ramka serwera: dekoder apki rozpoznaje każdą złotą ramkę", arguments: names("server"))
  func serverFrame(_ name: String) throws {
    let entry = try #require(Self.manifest[name])
    let text = try Self.document(name).compact
    let frame = try #require(TerminalServerFrame.decode(text))
    switch frame {
    case let .hello(backend): #expect(entry.t == "hello" && backend == "herdr")
    case .exit: #expect(entry.t == "exit")
    case let .error(message, _): #expect(entry.t == "err" && !message.isEmpty)
    }
  }

  @Test("kodowanie: ukośnik bez escape'u, klucze posortowane, komórka przewinięcia opcjonalna")
  func encoding() throws {
    #expect(TerminalFrameEncoder.text(.input("a/b")) == #"{"d":"a/b","t":"in"}"#)
    #expect(TerminalFrameEncoder.text(.input("")) == #"{"d":"","t":"in"}"#)
    #expect(TerminalFrameEncoder.text(.resize(try #require(TerminalGrid(cols: 80, rows: 24)))) == #"{"c":80,"r":24,"t":"rs"}"#)
    let bare = try #require(TerminalScrollStep(lines: -3, cell: nil))
    #expect(TerminalFrameEncoder.text(.scroll(bare)) == #"{"d":-3,"t":"sc"}"#)
    let cell = try #require(TerminalCell(col: 1, row: 1000))
    #expect(TerminalFrameEncoder.text(.scroll(try #require(TerminalScrollStep(lines: 200, cell: cell))))
      == #"{"c":1,"d":200,"r":1000,"t":"sc"}"#)
    #expect(TerminalFrameEncoder.text(.paste("a/b\r\n", end: false)) == #"{"d":"a/b\r\n","e":false,"t":"pa"}"#)
    #expect(TerminalFrameEncoder.text(.paste("", end: true)) == #"{"d":"","e":true,"t":"pa"}"#)
    #expect(TerminalWire.maxPasteBytes == 524_288)
  }

  @Test("wartości spoza kontraktu nie dają ramki: rozmiar i komórka poza 1…1000, przewinięcie ponad ±200")
  func invalidValues() {
    #expect(TerminalGrid(cols: 0, rows: 24) == nil)
    #expect(TerminalGrid(cols: 80, rows: 0) == nil)
    #expect(TerminalGrid(cols: 1001, rows: 24) == nil)
    #expect(TerminalGrid(cols: 1, rows: 1000) != nil)
    #expect(TerminalCell(col: 0, row: 1) == nil)
    #expect(TerminalScrollStep(lines: 201, cell: nil) == nil)
    #expect(TerminalScrollStep(lines: -201, cell: nil) == nil)
    #expect(TerminalScrollStep(lines: -200, cell: nil) != nil)
  }

  @Test("przewinięcie dzielone na ramki po ±200, nadmiar ponad sufit ramek odpada, zero = nic")
  func scrollSteps() {
    #expect(TerminalScrollStep.steps(for: 0, cell: nil).isEmpty)
    #expect(TerminalScrollStep.steps(for: 450, cell: nil).map(\.lines) == [200, 200, 50])
    #expect(TerminalScrollStep.steps(for: -201, cell: nil).map(\.lines) == [-200, -1])
    #expect(TerminalScrollStep.steps(for: 5000, cell: nil, limit: 8).count == 8)
  }

  @Test("dekoder serwera jest tolerancyjny: nieznany typ, zły JSON i `err` bez zdania to brak ramki")
  func tolerantServerDecoder() {
    #expect(TerminalServerFrame.decode(#"{"t":"exit","nowe":1}"#) == .exit)
    #expect(TerminalServerFrame.decode(#"{"t":"hello","backend":"herdr"}"#) == .hello(backend: "herdr"))
    #expect(TerminalServerFrame.decode(#"{"t":"err","msg":"Limit"}"#) == .error(message: "Limit"))
    for text in [#"{"t":"przyszla"}"#, "nie-json", #"{"t":"err"}"#, #"{"t":"err","msg":""}"#, #"{"t":"err","msg":1}"#,
      "[]", #"{"msg":"x"}"#]
    {
      #expect(TerminalServerFrame.decode(text) == nil, "\(text)")
    }
  }

  @Test("id terminala w kształcie TERM_ID_RE")
  func terminalId() {
    #expect(TerminalWire.isTerminalId("0123456789abcdef"))
    #expect(!TerminalWire.isTerminalId("0123456789ABCDEF"))
    #expect(!TerminalWire.isTerminalId("../../etc/passwd"))
    #expect(!TerminalWire.isTerminalId(""))
  }
}
