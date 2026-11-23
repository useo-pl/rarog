import Foundation
import RarogContract

/// Cięcie wejścia terminala na ramki `in` w budżecie ``TerminalWire/maxFrameBytes`` (wektory
/// w `shared/fixtures/term/chunk-vectors.json`).
///
/// Budżet liczy GOTOWĄ ramkę, nie treść: ramka ponad 8 KiB zamyka gniazdo kodem 1002, a escape JSON-a
/// puchnie (ESC = 6 B, cudzysłów i backslash = 2 B). Cięcie idzie po SKALARACH Unicode — kawałek nigdy
/// nie kończy się w połowie emoji. Rachunek na skalar (``framedBytes(_:)``) jest zmierzony 1:1 z koderem
/// ramek (``TerminalFrameEncoder``); każdą gotową ramkę i tak sprawdza się jeszcze raz na jej
/// RZECZYWISTYCH bajtach (``frames(_:maxFrameBytes:)``) i za dużą tnie dalej.
///
/// Treść wejścia nie trafia do logów: ten plik niczego nie zapisuje.
public enum TerminalInputChunker {
  /// Narzut pustej ramki `in` (`{"d":"","t":"in"}` = 17 B), liczony koderem, nie z pamięci autora.
  public static let frameOverheadBytes = TerminalFrameEncoder.data(.input("")).count

  /// Kawałki wejścia; pusty tekst = zero kawałków (gniazdo nie ma po co drgać). Sufit poniżej narzutu
  /// daje podłogę: jeden skalar na kawałek, zamiast pętli bez końca.
  ///
  /// - Parameter overheadBytes: stała część gotowej ramki (domyślnie ramka `in`; wklejka podaje narzut
  ///   ramki `pa`, dłuższej o pole `e`).
  public static func chunks(
    _ text: String, maxFrameBytes: Int = TerminalWire.maxFrameBytes, overheadBytes: Int = frameOverheadBytes
  ) -> [String] {
    guard !text.isEmpty else { return [] }
    let budget = max(maxFrameBytes - overheadBytes, 1)
    var chunks: [String] = []
    var current = String.UnicodeScalarView()
    var bytes = 0
    for scalar in text.unicodeScalars {
      let size = framedBytes(scalar)
      if bytes + size > budget, !current.isEmpty {
        chunks.append(String(current))
        current = String.UnicodeScalarView()
        bytes = 0
      }
      current.append(scalar)
      bytes += size
    }
    if !current.isEmpty { chunks.append(String(current)) }
    return chunks
  }

  /// Gotowe ramki `in` dla wejścia — kawałki z ``chunks(_:maxFrameBytes:)`` sprawdzone na prawdziwych
  /// bajtach kodera. Kawałek, którego ramka wyszłaby ponad sufit (rachunek na skalar rozjechany z koderem),
  /// dzielimy na pół, aż się zmieści albo zostanie jeden skalar — przycięte wejście do powłoki byłoby
  /// gorsze niż jego brak, a ramka ponad sufit zerwałaby gniazdo.
  public static func frames(_ text: String, maxFrameBytes: Int = TerminalWire.maxFrameBytes) -> [TerminalClientFrame] {
    chunks(text, maxFrameBytes: maxFrameBytes)
      .flatMap { fitted($0, maxFrameBytes: maxFrameBytes, frame: { .input($0) }) }
      .map { .input($0) }
  }

  /// Ile bajtów zajmie skalar W GOTOWEJ RAMCE (po kodowaniu JSON i UTF-8). To nie jest jego długość
  /// UTF-8: znaki sterujące wychodzą jako `\u00XX` (6 B), pięć z nich ma skrót (`\b \t \n \f \r`, 2 B),
  /// cudzysłów i backslash 2 B, ukośnik 1 B (koder bez escape'u ukośnika), reszta jak UTF-8. Samotnego
  /// surogatu (6 B w PWA) `String` nie mieści — w Swift zawsze jest już U+FFFD.
  static func framedBytes(_ scalar: Unicode.Scalar) -> Int {
    switch scalar.value {
    case 0x08, 0x09, 0x0A, 0x0C, 0x0D: 2
    case 0x00..<0x20: 6
    case 0x22, 0x5C: 2
    case 0x20..<0x80: 1
    case 0x80..<0x800: 2
    case 0x800..<0x10000: 3
    default: 4
    }
  }

  /// Kawałek dopasowany do sufitu na RZECZYWISTYCH bajtach ramki zbudowanej przez `frame`.
  static func fitted(
    _ chunk: String, maxFrameBytes: Int, frame build: (String) -> TerminalClientFrame
  ) -> [String] {
    let scalars = Array(chunk.unicodeScalars)
    guard TerminalFrameEncoder.data(build(chunk)).count > maxFrameBytes, scalars.count > 1 else { return [chunk] }
    let half = scalars.count / 2
    return fitted(String(String.UnicodeScalarView(scalars[..<half])), maxFrameBytes: maxFrameBytes, frame: build)
      + fitted(String(String.UnicodeScalarView(scalars[half...])), maxFrameBytes: maxFrameBytes, frame: build)
  }
}

/// Wklejka terminala — OSOBNA droga od pisania: ramki `pa`, nigdy `in`.
///
/// Serwer skleja kawałki jednego gniazda i oddaje herdr JEDNO `terminal.input` z `ESC[200~…ESC[201~`;
/// herdr koduje je według trybu programu (z 2004 owinięte, bez — sam tekst). Klient wysyła SUROWY tekst
/// schowka: końce linii i znaczniki 200~/201~ czyści serwer. Wektory
/// w `shared/fixtures/term/chunk-vectors.json`.
public enum TerminalPaste {
  /// Narzut pustej ramki `pa` z `e: false` (`{"d":"","e":false,"t":"pa"}` = 27 B) — budżet kawałka liczy
  /// się od dłuższego wariantu, więc ostatnia ramka (`e: true`) też się mieści.
  public static let frameOverheadBytes = TerminalFrameEncoder.data(.paste("", end: false)).count

  /// Gotowe ramki wklejki, ostatnia z `end: true`. `nil` = wklejka ponad ``TerminalWire/maxPasteBytes``
  /// (nie wysyłać NIC — serwer i tak odrzuciłby całość); pusty tekst = zero ramek.
  public static func frames(_ text: String, maxFrameBytes: Int = TerminalWire.maxFrameBytes) -> [TerminalClientFrame]? {
    guard text.utf8.count <= TerminalWire.maxPasteBytes else { return nil }
    let parts = TerminalInputChunker.chunks(text, maxFrameBytes: maxFrameBytes, overheadBytes: frameOverheadBytes)
      .flatMap { TerminalInputChunker.fitted($0, maxFrameBytes: maxFrameBytes, frame: { .paste($0, end: false) }) }
    return parts.enumerated().map { index, part in .paste(part, end: index == parts.count - 1) }
  }
}
