import Foundation
import RarogContract
import RarogCore

// Karty narzędzi i serie kroków w transkrypcie. Czyste modele i reguły,
// testowane na macOS; widoki w `Session/Rows/`. Klient nie decyduje po nazwie narzędzia:
// mini-diff rozpoznaje `detailKind`, a nazwa jest tylko tekstem etykiety. Właściciel: transkrypt.

/// Mini-diff edycji pliku (kontrakt `detailKind: diff`): linie z prefiksem nadanym przez serwer.
public struct MiniDiff: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case add, del, ctx
  }

  public struct Line: Sendable, Equatable {
    public let kind: Kind
    public let text: String
  }

  /// Ile linii widać bez rozwijania — reszta stoi pod „… jeszcze N linii".
  public static let visible = 12

  public let added: Int
  public let deleted: Int
  /// Linie widoczne od razu.
  public let head: [Line]
  /// Linie pod rozwijakiem; puste, gdy zmiana mieści się w `visible + 2` (rozwijak na dwie linie
  /// zajmowałby tyle miejsca, ile oszczędza).
  public let tail: [Line]

  public init(_ detail: String) {
    // Rodzaj WYŁĄCZNIE z prefiksu: serwer daje każdej linii `+ `, `- ` albo dwie spacje, więc linia
    // kodu zaczynająca się od minusa nie udaje usunięcia. Stopka ucięcia nie jest linią diffu.
    // Serwer tnie po `\n`, więc plik z końcami CRLF przychodzi z `\r\n`, a to w Swifcie jeden
    // znak (grafem): podział po samym `"\n"` skleiłby cały diff w jedną linię.
    let lines = detail.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }).map { raw in
      let text = String(raw)
      let kind: Kind = text.hasPrefix("+") ? .add : text.hasPrefix("-") ? .del : .ctx
      return Line(kind: kind, text: text)
    }
    added = lines.count { $0.kind == .add }
    deleted = lines.count { $0.kind == .del }
    if lines.count <= Self.visible + 2 {
      head = lines
      tail = []
    } else {
      head = Array(lines.prefix(Self.visible))
      tail = Array(lines.dropFirst(Self.visible))
    }
  }
}

/// Karta wywołania narzędzia: zwinięta linia „Narzędzie: cel", rozwijana do pełnego wejścia
/// albo (edycja pliku) do mini-diffu otwartego od razu.
public struct ToolRowModel: Sendable, Equatable {
  public let id: String
  public let voice: VoiceLabel?
  /// Etykieta narzędzia z drutu — tekst, nie klucz decyzji.
  public let toolName: String
  /// Cel ze ścieżkami skróconymi do 3 ostatnich segmentów (adresy nietknięte).
  public let summary: String
  /// Pełne wejście bit w bit; `nil` = nie ma czego rozwijać.
  public let detail: String?
  /// Mini-diff, gdy serwer oznaczył wejście jako diff (`detailKind`).
  public let diff: MiniDiff?
  /// Wejście to komenda powłoki (`inputKind`): zwinięta linia i rozwinięcie w kolorach shella.
  public let shell: Bool
  public let expanded: Bool
  /// Ogon długiego mini-diffu rozwinięty („… jeszcze N linii").
  public let diffTailOpen: Bool
  public var turn = TurnMark()
  /// Miejsce w karcie sąsiednich narzędzi; liczy ``ToolChains/mark(_:)`` po złożeniu wierszy.
  public var chain = ToolChainPlace.alone

  /// Zwinięta linia karty.
  public var line: String { "\(toolName): \(summary)" }

  /// Czy karta ma rozwinięcie (bez treści linia stoi sama, bez rozwijaka).
  public var expandable: Bool { detail != nil }

  /// Język kolorowania wejścia: komenda powłoki (`inputKind: shell`) → shell.
  /// Wejście JSON innych narzędzi zostaje bez koloru.
  public var syntaxLanguage: String? { shell ? "sh" : nil }

  /// Kolor zwiniętej linii `Narzędzie: cel` — koloruje się tylko cel; zakresy w UTF-16 całej ``line``.
  public var lineSyntax: [SyntaxToken] {
    guard let language = syntaxLanguage else { return [] }
    let offset = toolName.utf16.count + 2
    return SyntaxHighlight.tokens(summary, language: language).map {
      SyntaxToken(($0.range.lowerBound + offset)..<($0.range.upperBound + offset), $0.kind)
    }
  }

  /// Kolor rozwiniętego wejścia (pełna komenda, bit w bit ``detail``).
  public var detailSyntax: [SyntaxToken] {
    guard let detail, let language = syntaxLanguage else { return [] }
    return SyntaxHighlight.tokens(detail, language: language)
  }
}

/// Rozwijak zwiniętej serii narzędzi — jedna cicha linia nad najnowszym krokiem.
public struct ToolRunModel: Sendable, Equatable {
  /// `seq` pierwszej wiadomości serii — stały, gdy seria rośnie w dół.
  public let id: Int
  public let voice: VoiceLabel?
  /// Ile wywołań siedzi w schowanych wiadomościach.
  public let hidden: Int
  public let expanded: Bool
  public var turn = TurnMark()
  /// Rozwijak to wiersz karty sąsiednich narzędzi: zwinięty stoi jej pierwszym wierszem, rozwinięty — wierszem
  /// nad najnowszym krokiem, między schowanymi krokami a nim.
  public var chain = ToolChainPlace.alone

  public var rowId: String { "r\(id)" }
}

/// Miejsce wiersza w karcie sąsiednich narzędzi. Kolejne karty narzędzi i rozwijak
/// serii bez niczego między nimi rysują się jako JEDNA karta: rogi zaokrąglone tylko na zewnątrz, kreska między
/// wierszami, bez odstępu. Każdy wiersz zostaje osobną komórką (własny identyfikator, element VoiceOvera, rozwinięcie);
/// miejsce jest częścią modelu wiersza, więc zmiana sąsiedztwa (krok doszedł na koniec) przekonfigurowuje komórkę.
public enum ToolChainPlace: Sendable, Equatable {
  /// Karta z jednego wiersza.
  case alone
  case first
  case middle
  case last

  /// Nad wierszem stoi inny wiersz tej karty: bez odstępu nad nim, kreska u góry, górne rogi proste.
  public var joinsAbove: Bool { self == .middle || self == .last }
  /// Pod wierszem stoi inny wiersz tej karty: bez odstępu pod nim, dolne rogi proste.
  public var joinsBelow: Bool { self == .first || self == .middle }

  /// Miejsce `index`-tego wiersza (od 0) w karcie z `count` wierszy.
  public static func at(_ index: Int, of count: Int) -> ToolChainPlace {
    guard count > 1 else { return .alone }
    if index == 0 { return .first }
    return index == count - 1 ? .last : .middle
  }
}

/// Karty sąsiednich narzędzi liczone po WIERSZACH, ponad granicami wiadomości — na żywo każde wywołanie bywa
/// osobną wiadomością agenta. Ciąg tworzą wiersze `.tool` i rozwijak serii `.toolRun`; przerywa go każdy inny wiersz
/// (tekst, znacznik godziny albo dnia, „NOWE”, prompt, zdjęcia, notka harnessu, płynąca odpowiedź),
/// a także wiersz narzędzia z granicą tury albo zmianą głosu — granica musi zostać widoczna.
public enum ToolChains {
  public static func mark(_ rows: inout [TranscriptRow]) {
    var start: Int?
    func close(at end: Int) {
      guard let begin = start else { return }
      start = nil
      for index in begin..<end { rows[index].setChain(.at(index - begin, of: end - begin)) }
    }
    for index in rows.indices {
      guard let opensCard = rows[index].opensToolCard else {
        close(at: index)
        continue
      }
      if opensCard { close(at: index) }
      if start == nil { start = index }
    }
    close(at: rows.endIndex)
  }
}

extension TranscriptRow {
  /// Wiersz karty narzędzi: `true`, gdy zaczyna nową kartę (granica tury, zmiana głosu); `nil` = nie należy do karty.
  var opensToolCard: Bool? {
    switch self {
    case let .tool(model): model.turn.gap != .flow || model.voice != nil
    case let .toolRun(model): model.turn.gap != .flow || model.voice != nil
    default: nil
    }
  }

  /// Miejsce w karcie sąsiednich narzędzi; inne wiersze `.alone`.
  public var toolChain: ToolChainPlace {
    switch self {
    case let .tool(model): model.chain
    case let .toolRun(model): model.chain
    default: .alone
    }
  }

  mutating func setChain(_ place: ToolChainPlace) {
    switch self {
    case var .tool(model):
      model.chain = place
      self = .tool(model)
    case var .toolRun(model):
      model.chain = place
      self = .toolRun(model)
    default:
      break
    }
  }
}

/// Seria ≥ 3 wiadomości agenta z samymi narzędziami (bez edycji pliku) zwinięta do ostatniej.
public struct ToolRun: Sendable, Equatable {
  /// `seq` PIERWSZEJ wiadomości serii.
  public let id: Int
  /// `seq` wiadomości schowanych (wszystkie poza ostatnią), w kolejności transkryptu.
  public let tucked: [Int]
  /// `seq` wiadomości widocznej — najnowszy krok.
  public let tail: Int
  /// Ile wywołań narzędzi siedzi w schowanych wiadomościach (wiadomość bywa kilkoma).
  public let hidden: Int
}

public enum ToolRuns {
  /// Od ilu wiadomości seria się zwija: przy dwóch rozwijak zajmuje tyle, ile oszczędza.
  public static let minimum = 3

  /// Wiadomość niesie WYŁĄCZNIE wywołania narzędzi (i co najmniej jedno).
  public static func isToolOnly(_ message: TranscriptMessage) -> Bool {
    guard !message.blocks.isEmpty else { return false }
    return message.blocks.allSatisfy { if case .toolCall = $0 { true } else { false } }
  }

  /// Wolno ją schować do serii: agent, same narzędzia i żadnej edycji pliku — mini-diff jest
  /// treścią, po którą się tu przychodzi, więc przerywa serię i zostaje na wierzchu.
  public static func isTuckable(_ message: TranscriptMessage) -> Bool {
    guard message.role == .assistant, isToolOnly(message) else { return false }
    return message.blocks.allSatisfy { block in
      if case let .toolCall(tool) = block { tool.detailKind != .diff } else { true }
    }
  }

  /// Serie w kolejności transkryptu. `breaks` — `seq` wiadomości, nad którymi seria się przerywa (ślad decyzji):
  /// rozwijak nie chowa kroków z obu stron wiersza, który między nimi stoi.
  public static func find(_ messages: [TranscriptMessage], breaks: Set<Int> = []) -> [ToolRun] {
    var runs: [ToolRun] = []
    var open: [TranscriptMessage] = []
    func close() {
      defer { open = [] }
      guard open.count >= minimum, let first = open.first, let last = open.last else { return }
      let tucked = open.dropLast()
      runs.append(ToolRun(
        id: first.seq, tucked: tucked.map(\.seq), tail: last.seq, hidden: tucked.reduce(0) { $0 + $1.blocks.count }))
    }
    for message in messages {
      if breaks.contains(message.seq) { close() }
      if isTuckable(message) { open.append(message) } else { close() }
    }
    close()
    return runs
  }
}

/// Klikalne adresy w ROZWINIĘTEJ karcie narzędzia. Zwinięta linia linków nie ma, żeby tap
/// rozwijał kartę. Tylko `http(s)://` zapisane wprost — `www.x`, poczta i ścieżki zostają tekstem;
/// kończąca interpunkcja należy do zdania. Treść karty nie zmienia się ani o znak.
public enum ToolDetailLinks {
  /// Adresy w kolejności tekstu.
  public static func urls(in text: String) -> [(range: NSRange, url: URL)] {
    guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
    let source = text as NSString
    return detector.matches(in: text, range: NSRange(location: 0, length: source.length)).compactMap { match in
      let written = source.substring(with: match.range).lowercased()
      guard written.hasPrefix("http://") || written.hasPrefix("https://"), let url = match.url,
        ["http", "https"].contains(url.scheme?.lowercased() ?? "")
      else { return nil }
      return (match.range, url)
    }
  }

  /// Tekst karty z linkami na adresach; poza tym bit w bit wejście z serwera. Adres `claude.ai` w atrybucie
  /// dostaje `#no_universal_links`, żeby otworzyła go przeglądarka, nie apka Claude.
  public static func attributed(_ text: String) -> AttributedString {
    var out = AttributedString(text)
    for found in urls(in: text) {
      guard let range = Range(found.range, in: out) else { continue }
      out[range].link = BrowserLinks.outside(found.url)
    }
    return out
  }
}
