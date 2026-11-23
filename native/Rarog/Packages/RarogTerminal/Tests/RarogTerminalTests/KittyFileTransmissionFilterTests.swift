import CoreGraphics
import Foundation
import ImageIO
@testable import RarogTerminal
@preconcurrency import SwiftTerm
import Testing
import UniformTypeIdentifiers

// Odcięcie trybów plikowych grafiki Kitty przed SwiftTerm (`KittyFileTransmissionFilter`) na rdzeniu emulatora
// i SYNTETYCZNYCH bajtach (iOS i macOS). Dowód „bez `stat`”: SwiftTerm odpowiada programowi na KAŻDĄ przetworzoną
// transmisję (`OK` albo błąd), a przy `t=t` kasuje plik. Próby kanarkowe bez filtra pokazują te skutki na tych samych
// bajtach, więc cisza i nietknięty plik za filtrem znaczą, że komenda nie doszła do obsługi grafiki. Właściciel:
// terminal.

private final class Replies: TerminalDelegate {
  var bytes: [UInt8] = []
  func send(source: Terminal, data: ArraySlice<UInt8>) { bytes.append(contentsOf: data) }
  var text: String { String(decoding: bytes, as: UTF8.self) }
}

/// Rdzeń SwiftTerm z filtrem (jak `SwiftTermSurface.feed`) albo bez niego (próba kanarkowa).
private final class Rig {
  let replies = Replies()
  let terminal: Terminal
  private var filter: KittyFileTransmissionFilter?
  /// Bajty, które dostał emulator.
  private(set) var fed: [UInt8] = []
  /// Kawałki zmienione przez filtr.
  private(set) var changed = 0

  init(filtered: Bool = true) {
    terminal = Terminal(delegate: replies, options: TerminalOptions(cols: 40, rows: 4, scrollback: 0))
    terminal.silentLog = true
    filter = filtered ? KittyFileTransmissionFilter() : nil
  }

  func feed(_ chunks: [[UInt8]]) {
    for chunk in chunks {
      var bytes = chunk
      if let filtered = filter?.filter(chunk[...]) {
        bytes = filtered
        changed += 1
      }
      fed += bytes
      terminal.feed(byteArray: bytes)
    }
  }

  func feed(_ bytes: [UInt8]) { feed([bytes]) }

  var screen: [String] {
    var lines = (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
    while lines.last?.isEmpty == true { lines.removeLast() }
    return lines
  }
}

/// Komenda grafiki Kitty: `ESC _ G <klucze> ; <treść> <koniec>`.
func kittyCommand(_ control: String, _ payload: String = "", end: String = "\u{1B}\\") -> [UInt8] {
  Array("\u{1B}_G\(control);\(payload)\(end)".utf8)
}

func base64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

/// Obraz PNG 2×2 zrobiony na miejscu (bez pliku w repo).
func kittyTestImage() throws -> Data {
  let context = try #require(
    CGContext(
      data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
  context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
  let image = try #require(context.makeImage())
  let data = NSMutableData()
  let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
  CGImageDestinationAddImage(destination, image, nil)
  #expect(CGImageDestinationFinalize(destination))
  return data as Data
}

private func writeImage(named name: String) throws -> URL {
  let url = FileManager.default.temporaryDirectory.appending(path: name)
  try kittyTestImage().write(to: url)
  return url
}

private let tail = Array("dalej".utf8)
private let can: UInt8 = 0x18

/// Podziały strumienia: w każdym miejscu na dwa kawałki i na pojedyncze bajty.
private func splits(of bytes: [UInt8]) -> [[[UInt8]]] {
  (0...bytes.count).map { [Array(bytes[..<$0]), Array(bytes[$0...])] } + [bytes.map { [$0] }]
}

@Suite("terminal: odcięcie plikowych transmisji grafiki Kitty")
struct KittyFileTransmissionFilterTests {
  @Test("t=f: plik nietknięty — bez odpowiedzi i bez obrazu, terminal pisze dalej; bez filtra SwiftTerm czyta plik")
  func fileMode() throws {
    let url = try writeImage(named: "kitty-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: url) }
    let command = kittyCommand("a=T,f=100,t=f,i=7", base64(url.path))
    let canary = Rig(filtered: false)
    canary.feed(command)
    #expect(canary.replies.text.contains("Gi=7;OK"), "SwiftTerm 1.19.0 czyta obraz ze ścieżki z sekwencji")
    let rig = Rig()
    rig.feed(command + tail)
    #expect(rig.replies.bytes.isEmpty)
    #expect(rig.screen == ["dalej"])
    #expect(rig.fed == Array(command.dropLast(2)) + [can] + Array(command.suffix(2)) + tail, "CAN przed ESC \\")
  }

  @Test("t=t: plik tymczasowy zostaje, bez odpowiedzi; bez filtra SwiftTerm czyta go i kasuje")
  func temporaryFileMode() throws {
    let canaryURL = try writeImage(named: "tty-graphics-protocol-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: canaryURL) }
    let canary = Rig(filtered: false)
    canary.feed(kittyCommand("a=T,f=100,t=t,i=8", base64(canaryURL.path)))
    #expect(canary.replies.text.contains("Gi=8;OK"))
    #expect(!FileManager.default.fileExists(atPath: canaryURL.path), "SwiftTerm kasuje plik tymczasowy po odczycie")

    let url = try writeImage(named: "tty-graphics-protocol-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: url) }
    let rig = Rig()
    rig.feed(kittyCommand("a=T,f=100,t=t,i=8", base64(url.path)) + tail)
    #expect(rig.replies.bytes.isEmpty)
    #expect(FileManager.default.fileExists(atPath: url.path))
    #expect(rig.screen == ["dalej"])
  }

  @Test("t=s: pamięć współdzielona nie dochodzi do SwiftTerm; bez filtra SwiftTerm otwiera obiekt i odpowiada")
  func sharedMemoryMode() {
    let command = kittyCommand("a=T,f=100,t=s,i=9", base64("/kitty-brak"))
    let canary = Rig(filtered: false)
    canary.feed(command)
    #expect(canary.replies.text.contains("Gi=9;EINVAL"), "SwiftTerm próbuje `shm_open` i odpowiada błędem")
    let rig = Rig()
    rig.feed(command + tail)
    #expect(rig.replies.bytes.isEmpty)
    #expect(rig.screen == ["dalej"])
  }

  @Test("t=d i brak klucza t (domyślnie d): bajty bez zmian i bez kopii, SwiftTerm przyjmuje obraz")
  func directMode() throws {
    let image = try kittyTestImage().base64EncodedString()
    for control in ["a=T,f=100,t=d,i=3", "a=T,f=100,i=3", "t=d,a=T,f=100,i=3"] {
      let command = kittyCommand(control, image)
      var filter = KittyFileTransmissionFilter()
      #expect(filter.filter(command[...]) == nil, "\(control)")
      let rig = Rig()
      rig.feed(command)
      #expect(rig.replies.text.contains("Gi=3;OK"), "\(control)")
    }
  }

  @Test("sekwencja pocięta w każdym miejscu i na pojedyncze bajty: tryb plikowy odcięty, t=d bez zmian")
  func splitEverywhere() throws {
    for mode in ["f", "t", "s"] {
      let bytes = kittyCommand("a=T,f=100,t=\(mode),i=5", base64("/brak")) + tail
      for chunks in splits(of: bytes) {
        let rig = Rig()
        rig.feed(chunks)
        #expect(rig.replies.bytes.isEmpty, "t=\(mode), kawałki \(chunks.map(\.count))")
        #expect(rig.screen == ["dalej"], "t=\(mode), kawałki \(chunks.map(\.count))")
      }
    }
    let direct = kittyCommand("a=T,f=100,t=d,i=5", try kittyTestImage().base64EncodedString())
    for chunks in splits(of: direct) {
      let rig = Rig()
      rig.feed(chunks)
      #expect(rig.changed == 0 && rig.fed == direct, "kawałki \(chunks.map(\.count))")
      #expect(rig.replies.text.contains("Gi=5;OK"), "kawałki \(chunks.map(\.count))")
    }
  }

  @Test("kontynuacje (m=1) po odciętym pierwszym kawałku też odcięte; następny obraz t=d przechodzi")
  func continuations() throws {
    let path = base64("/brak/katalog/obraz.png")
    let parts = [path.prefix(8), path.dropFirst(8).prefix(8), path.dropFirst(16)].map(String.init)
    let chunked =
      kittyCommand("a=T,f=100,t=f,i=4,m=1", parts[0]) + kittyCommand("m=1", parts[1]) + kittyCommand("m=0", parts[2])
    // Kontynuacja nie powtarza `t`: bez jej odcięcia SwiftTerm bierze ją za nowy obraz `t=d` i odpowiada błędem.
    let canary = Rig(filtered: false)
    canary.feed(kittyCommand("m=0", parts[2]))
    #expect(canary.replies.text.contains("EINVAL"))
    let rig = Rig()
    rig.feed(chunked)
    #expect(rig.replies.bytes.isEmpty)
    rig.feed(kittyCommand("a=T,f=100,i=6", try kittyTestImage().base64EncodedString()))
    #expect(rig.replies.text.contains("Gi=6;OK"))
  }

  @Test("komenda usuwania (a=d) kończy kontynuacje i przechodzi bez zmian, jak w SwiftTerm")
  func deleteEndsContinuation() {
    var filter = KittyFileTransmissionFilter()
    #expect(filter.filter(kittyCommand("a=T,t=f,m=1", base64("/brak"))[...]) != nil)
    #expect(filter.filter(kittyCommand("a=d,d=A")[...]) == nil)
    #expect(filter.filter(kittyCommand("m=0", "QUFB")[...]) == nil, "po usunięciu to nowa komenda t=d")
  }

  @Test("tekst z UTF-8 (bajty 0x80–0x9F), CSI, OSC, DCS, inne APC i APC przerwane CAN przechodzą bajt w bajt")
  func passThrough() {
    let stream = Array(
      ("zażółć 😟ğG,t=f \u{1B}[1;31mczerwony\u{1B}[0m \u{1B}]0;tytuł 😟\u{07}"
        + "\u{1B}]8;;https://example.com/ğ\u{1B}\\link\u{1B}]8;;\u{1B}\\ \u{1B}(0qqq\u{1B}(B "
        + "\u{1B}Pq#0;2;0;0;0\u{1B}\\ \u{1B}_Xt=f;abc\u{1B}\\ \u{1B}_Ga=T,t=f;QUFB\u{18} koniec").utf8)
    for chunks in [[stream]] + splits(of: stream) {
      var filter = KittyFileTransmissionFilter()
      for chunk in chunks { #expect(filter.filter(chunk[...]) == nil, "kawałki \(chunks.map(\.count))") }
    }
  }

  @Test("APC z 8-bitowym 0x9F poza ground, koniec BEL i 8-bitowy ST na początku kawałka: odcięte jak ESC \\")
  func eightBitAndTerminators() {
    let body = Array("Ga=T,t=f;\(base64("/brak"))".utf8)
    let cases: [(String, [[UInt8]])] = [
      ("CSI, potem 0x9F", [[0x1B, 0x5B, 0x9F] + body + [0x1B, 0x5C]]),
      ("ESC, potem 0x9F", [[0x1B, 0x9F] + body + [0x1B, 0x5C]]),
      ("DCS, potem 0x9F", [Array("\u{1B}Pq#0".utf8) + [0x9F] + body + [0x1B, 0x5C]]),
      // W stanach „ignore” CSI i DCS bajt od 0xA0 nie wraca do `ground`, więc następne 0x9F dalej otwiera APC.
      ("CSI ignore, 0xA5, potem 0x9F", [[0x1B, 0x5B, 0x3F, 0x3F, 0xA5, 0x9F] + body + [0x1B, 0x5C]]),
      ("DCS ignore, 0xA5, potem 0x9F", [[0x1B, 0x50, 0x3A, 0xA5, 0x9F] + body + [0x1B, 0x5C]]),
      ("koniec BEL", [[0x1B, 0x5F] + body + [0x07]]),
      ("8-bitowy ST na początku kawałka", [[0x1B, 0x5F] + body, [0x9C]]),
    ]
    for (name, chunks) in cases {
      let canary = Rig(filtered: false)
      canary.feed(chunks)
      #expect(canary.replies.text.contains("EINVAL: bad path"), "\(name): SwiftTerm wysyła komendę do obsługi grafiki")
      let rig = Rig()
      rig.feed(chunks + [tail])
      #expect(rig.replies.bytes.isEmpty, "\(name)")
      #expect(rig.screen == ["dalej"], "\(name)")
    }
  }

  /// Różnicowo z prawdziwym parserem SwiftTerm: te same kawałki idą do emulatora bez filtra (kanarek: ile razy komenda
  /// trybu plikowego doszła do obsługi grafiki) i z filtrem (ani razu). Odpowiedź „bad path” daje tylko `t=f`/`t=t`.
  @Test("różnicowo z SwiftTerm: losowe strumienie i podziały — za filtrem tryb plikowy nie dochodzi do emulatora")
  func differential() {
    var random = SplitMix(seed: 0xA4)
    let path = Array(base64("/brak").utf8)
    // Wejścia w APC, komendy trybu plikowego i końce łańcucha częściej niż reszta: inaczej losowanie rzadko składa
    // komendę, którą SwiftTerm by wysłał.
    let frequent: [[UInt8]] = [
      [0x1B, 0x5F], [0x9F], Array("Ga=T,t=f;".utf8) + path, Array("Gt=t;".utf8) + path, Array("Gm=1,t=f;".utf8) + path,
      [0x1B, 0x5C], [0x07], [0x9C],
    ]
    let rare: [[UInt8]] = [
      [0x1B], [0x9B], [0x9D], [0x90], [0x98], [0x18], [0x1A], [0x19], [0x0A], [0x7F], [0xC4], [0xA5], [0x1B, 0x5B],
      [0x1B, 0x5D], [0x1B, 0x50], [0x1B, 0x28], Array("G".utf8), Array("t=f".utf8), Array("t=t".utf8),
      Array("t=d".utf8), Array("m=1".utf8), Array("m=0".utf8), Array("a=d".utf8), Array(",".utf8), Array(";".utf8),
      Array("=".utf8), path, Array("0".utf8), Array("1".utf8), Array("?".utf8), Array(":".utf8), Array("q".utf8),
      Array("x".utf8), Array("\\".utf8),
    ]
    var reached = 0
    for _ in 0..<10_000 {
      var stream: [UInt8] = []
      for _ in 0..<Int.random(in: 1...16, using: &random) {
        let pool = Bool.random(using: &random) ? frequent : rare
        stream += pool.randomElement(using: &random)!
      }
      var chunks: [[UInt8]] = [[]]
      for byte in stream {
        if Int.random(in: 0..<5, using: &random) == 0 { chunks.append([]) }
        chunks[chunks.count - 1].append(byte)
      }
      let canary = Rig(filtered: false)
      canary.feed(chunks)
      if canary.replies.text.contains("bad path") || canary.replies.text.contains("bad temp path") { reached += 1 }
      let rig = Rig()
      rig.feed(chunks)
      let replies = rig.replies.text
      #expect(!replies.contains("bad path") && !replies.contains("bad temp path"), "\(stream) \(chunks.map(\.count))")
      if !stream.contains(UInt8(ascii: "G")) { #expect(rig.changed == 0, "\(stream)") }
    }
    #expect(reached > 300, "losowanie trafia w tryb plikowy dość często, żeby test coś sprawdzał: \(reached)")
  }
}

/// Generator SplitMix64: powtarzalne losowanie w teście różnicowym.
private struct SplitMix: RandomNumberGenerator {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
