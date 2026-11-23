// Ramki gniazda terminala — lustro `termClientFrameSchema`
// i `termServerFrameSchema` z `shared/src/protocol.ts`. Złote ramki: `shared/fixtures/term/`
// (`TerminalFramesTests`).
//
// Kierunek klient → serwer to WYŁĄCZNIE tekstowy JSON (ramka binarna zamyka gniazdo kodem 1002),
// a każda ramka spoza kontraktu też kończy się zamknięciem 1002 — dlatego typy niżej nie dają się
// zbudować z wartością, której serwer nie przyjmie (rozmiar spoza 1…1000, przewinięcie ponad ±200).
// Kierunek serwer → klient: binarne = surowe bajty PTY (nie przechodzą przez żaden parser), tekstowe
// = zdarzenie `hello` | `exit` | `err`, czytane tolerancyjnie (nieznany typ ignorujemy).
//
// Treść terminala nie trafia do logów ani na dysk: ten plik niczego nie zapisuje.
import Foundation

/// Stałe drutu terminala.
public enum TerminalWire {
  /// `TERM_MAX_INPUT_BYTES` (PWA: `TERM_INPUT_MAX_BYTES`) — sufit GOTOWEJ ramki klienta w bajtach
  /// UTF-8. Liczony na całej ramce, nie na treści: escape JSON-a puchnie (ESC = 6 B), a serwer
  /// zrywa gniazdo za ramkę ponad `maxPayload` (16 KiB), zanim spojrzy na treść.
  public static let maxFrameBytes = 8192
  /// Zakres `c`/`r` w ramkach `rs` i `sc` oraz w query upgrade'u (`?c=&r=`).
  public static let gridRange = 1...1000
  /// Sufit `d` jednej ramki `sc` (`TERM_SCROLL_MAX_LINES`).
  public static let scrollMaxLines = 200
  /// `TERM_MAX_PASTE_BYTES` — sufit CAŁEJ wklejki (suma bajtów UTF-8 treści ramek `pa`). herdr gubi
  /// po cichu wejście ponad 1 MiB, a serwer odrzuca nadmiar bez słowa do klienta (bez ramki `err`, która
  /// zatrzymałaby automat), więc „za duża" mówi klient — przed wysyłką.
  public static let maxPasteBytes = 512 * 1024

  /// Id terminala w kształcie `TERM_ID_RE` (16 znaków małego hex). Id wchodzi do ścieżki gniazda,
  /// więc klient sprawdza je, zanim zbuduje adres.
  public static func isTerminalId(_ value: String) -> Bool {
    WireFormat.isTerminalId(value)
  }
}

/// Rozmiar siatki terminala: kolumny × wiersze, oba w 1…1000.
public struct TerminalGrid: Sendable, Hashable {
  public let cols: Int
  public let rows: Int

  /// `nil` poza 1…1000: `rs` z takim rozmiarem zamyka gniazdo (1002), a zejście apki w tło daje
  /// widok o zerze wierszy.
  public init?(cols: Int, rows: Int) {
    guard TerminalWire.gridRange.contains(cols), TerminalWire.gridRange.contains(rows) else { return nil }
    self.cols = cols
    self.rows = rows
  }
}

/// Komórka terminala (kolumna i wiersz od 1) — przy przewijaniu ta pod palcem: herdr kieruje kółko
/// do panelu aplikacji, który pod nią leży (lazygit: diff albo lista).
public struct TerminalCell: Sendable, Hashable {
  public let col: Int
  public let row: Int

  /// `nil` poza 1…1000 (ten sam zakres co w `rs`).
  public init?(col: Int, row: Int) {
    guard TerminalWire.gridRange.contains(col), TerminalWire.gridRange.contains(row) else { return nil }
    self.col = col
    self.row = row
  }
}

/// Jedna ramka `sc`: przewinięcie o `lines` wierszy (dodatnie = w dół), najwyżej ±200.
public struct TerminalScrollStep: Sendable, Hashable {
  public let lines: Int
  public let cell: TerminalCell?

  /// `nil` poza ±``TerminalWire/scrollMaxLines``.
  public init?(lines: Int, cell: TerminalCell?) {
    guard abs(lines) <= TerminalWire.scrollMaxLines else { return nil }
    self.lines = lines
    self.cell = cell
  }

  /// Przewinięcie dowolnej długości jako ramki po ±200 (PWA `sendScroll`): nadmiar jedzie kolejnymi
  /// ramkami w tym samym geście, a sufit `limit` ramek chroni przed zepsutym pomiarem. Zero = brak ramek.
  public static func steps(for lines: Int, cell: TerminalCell?, limit: Int = 8) -> [TerminalScrollStep] {
    var left = lines
    var steps: [TerminalScrollStep] = []
    while left != 0, steps.count < limit {
      let send = min(max(left, -TerminalWire.scrollMaxLines), TerminalWire.scrollMaxLines)
      guard let step = TerminalScrollStep(lines: send, cell: cell) else { break }
      steps.append(step)
      left -= send
    }
    return steps
  }
}

/// Ramka klient → serwer. Kodowanie: ``TerminalFrameEncoder``.
public enum TerminalClientFrame: Sendable, Hashable, Encodable {
  /// `{"t":"in","d":…}` — wejście z klawiatury. Sufit 8 KiB na gotowej ramce pilnuje cięcie
  /// (`TerminalInputChunker` w `RarogTransport`).
  case input(String)
  /// `{"t":"rs","c":…,"r":…}` — nowy rozmiar okna.
  case resize(TerminalGrid)
  /// `{"t":"sc","d":…,"c"?:…,"r"?:…}` — przewinięcie historii panelu.
  case scroll(TerminalScrollStep)
  /// `{"t":"pa","d":…,"e":…}` — kawałek WKLEJKI; `end` = ostatni. Serwer skleja kawałki gniazda
  /// i oddaje herdr JEDNO `terminal.input` z `ESC[200~…ESC[201~`, a herdr dopasowuje je do trybu programu.
  /// Treść to SUROWY tekst schowka: końce linii i znaczniki 200~/201~ czyści serwer, jeden dla obu klientów.
  case paste(String, end: Bool)

  /// Wartość pola `t` — nazwa typu ramki w kontrakcie.
  public var type: String {
    switch self {
    case .input: "in"
    case .resize: "rs"
    case .scroll: "sc"
    case .paste: "pa"
    }
  }

  enum CodingKeys: String, CodingKey { case t, d, c, r, e }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(type, forKey: .t)
    switch self {
    case let .input(text):
      try c.encode(text, forKey: .d)
    case let .resize(grid):
      try c.encode(grid.cols, forKey: .c)
      try c.encode(grid.rows, forKey: .r)
    case let .scroll(step):
      try c.encode(step.lines, forKey: .d)
      if let cell = step.cell {
        try c.encode(cell.col, forKey: .c)
        try c.encode(cell.row, forKey: .r)
      }
    case let .paste(text, end):
      try c.encode(text, forKey: .d)
      try c.encode(end, forKey: .e)
    }
  }
}

/// Koder ramek klienta — JEDEN dla wysyłki i dla rachunku budżetu.
///
/// `withoutEscapingSlashes`, bo `JSONEncoder` domyślnie pisze `\/` (2 B), a `JSON.stringify`
/// `/` (1 B): bez tego ta sama wklejka dawałaby inne ramki. `sortedKeys`, bo bez niego kolejność
/// kluczy jest losowa między uruchomieniami (zmierzone) — na długość to nie wpływa, na powtarzalność
/// testów tak. Escape znaków: zmierzony 1:1 z `JSON.stringify` dla U+0000…U+007F, U+2028/U+2029
/// i spoza BMP (``TerminalFramesTests``).
public enum TerminalFrameEncoder {
  /// Gotowa ramka jako tekst wiadomości WS (UTF-8).
  public static func text(_ frame: TerminalClientFrame) -> String {
    String(decoding: data(frame), as: UTF8.self)
  }

  /// Gotowa ramka w bajtach UTF-8 — to liczy budżet ``TerminalWire/maxFrameBytes``.
  public static func data(_ frame: TerminalClientFrame) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Kodowanie łańcucha i liczb całkowitych nie ma ścieżki błędu; `try?` tylko dla sygnatury.
    return (try? encoder.encode(frame)) ?? Data()
  }
}

/// Ramka TEKSTOWA serwer → klient.
public enum TerminalServerFrame: Sendable, Hashable {
  /// Pierwsza ramka tekstowa po udanym `attach`. Backend jest jeden (`herdr`); klient go nie
  /// potrzebuje, ale ramka mówi, że gniazdo przeszło `attach` (przy odmowie przychodzi samo `err`).
  case hello(backend: String)
  /// Powłoka (albo program popupu) się skończyła. Automat ponawiania staje; wraca gest człowieka.
  case exit
  /// Odmowa albo stan `failed` serwera — zdanie do pokazania wprost. KAŻDA zatrzymuje automat.
  /// `ref` (`msgRef`) = kod zdania; brak = zdanie bez kodu (starszy serwer albo tekst obcy).
  case error(message: String, ref: SentenceRef? = nil)

  /// Tolerancyjny dekoder:
  /// zły JSON, nieznany typ i `err` bez niepustego `msg` dają `nil` — nowszy serwer ma prawo przysłać
  /// typ, którego ta apka nie zna, i to nie jest powód do zrywania gniazda ani do straszenia człowieka.
  /// `msgRef` uszkodzone (`null`, reguły ``SentenceRef``) też daje `nil`, jak zły `msg`.
  public static func decode(_ text: String) -> TerminalServerFrame? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
      let fields = object as? [String: Any], let type = fields["t"] as? String
    else { return nil }
    switch type {
    case "hello":
      return .hello(backend: fields["backend"] as? String ?? "")
    case "exit":
      return .exit
    case "err":
      guard let message = fields["msg"] as? String, !message.isEmpty else { return nil }
      guard let rawRef = fields["msgRef"] else { return .error(message: message, ref: nil) }
      guard let ref = sentenceRef(rawRef) else { return nil }
      return .error(message: message, ref: ref)
    default:
      return nil
    }
  }

  /// `msgRef` tym samym dekoderem co każde pole `*Ref` (``SentenceRef``); obiekt spoza reguł = `nil`.
  private static func sentenceRef(_ raw: Any) -> SentenceRef? {
    // `NSNull`, łańcuch i liczba nie są obiektem; `data(withJSONObject:)` przyjmuje tylko obiekt albo tablicę.
    guard let object = raw as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: object)
    else { return nil }
    return try? JSONDecoder().decode(SentenceRef.self, from: data)
  }
}

extension TerminalServerFrame: SentenceBearing {
  /// Tłumaczy zdanie ramki `err`; `hello` i `exit` nie niosą tekstu.
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    guard case let .error(message, ref) = self else { return }
    self = .error(message: render(message, ref), ref: ref)
  }
}
