import Foundation
import RarogContract
import RarogCore

// Tekst okna „Zaznacz więcej…”: migawka załadowanych wiadomości sesji jako jeden zwykły tekst, który zaznacza
// jeden `UITextView` (zaznaczenie systemu nie przechodzi przez komórki transkryptu). Czysta funkcja stanu: okno dostaje
// gotowy tekst z chwili otwarcia, więc odpowiedź, która napływa w tle, go nie zmienia. Okno:
// `Session/TranscriptSelectionSheet.swift`. Właściciel: transkrypt.

/// Prośba o okno tekstu transkryptu (``AppSheet/transcriptText(_:)``): migawka tekstu i miejsce kursora z chwili
/// otwarcia. Nowa prośba = nowa prezentacja.
public struct TranscriptTextRequest: Identifiable, Hashable, Sendable {
  public let id: UUID
  public let sessionId: String
  /// Nazwa projektu sesji w tytule okna.
  public let project: String
  public let text: String
  /// Kursor (UTF-16) przy wiadomości, z której otwarto okno.
  public let cursor: Int

  public init(id: UUID = UUID(), sessionId: String, project: String, text: String, cursor: Int) {
    self.id = id
    self.sessionId = sessionId
    self.project = project
    self.text = text
    self.cursor = cursor
  }
}

/// Tekst okna zaznaczania i początki wiadomości w nim (UTF-16, jak `NSRange` widoku tekstu).
public struct TranscriptSelectionText: Sendable, Equatable {
  public let text: String
  /// Początek wiadomości (wiersz nagłówka) po numerze `seq`.
  let starts: [Int: Int]
  /// Początek otwartej (płynącej) odpowiedzi; `nil` = bez niej.
  let openStart: Int?

  /// Miejsce kursora dla wiersza transkryptu, z którego otwarto okno (`m<seq>.<blok>`, `m<seq>.n`, `open`). Wiersz
  /// spoza migawki (wpis kolejki) stawia kursor na końcu tekstu.
  public func cursor(row: String) -> Int {
    let end = text.utf16.count
    if row == "open" { return openStart ?? end }
    guard row.hasPrefix("m"), let seq = Int(row.dropFirst().prefix { $0.isNumber }) else { return end }
    return starts[seq] ?? end
  }

  /// Wiadomości w kolejności transkryptu, potem otwarta odpowiedź. Każda: wiersz nagłówka (rola i godzina), pod nim
  /// treść; między wiadomościami pusta linia. Kroki schowane w zwiniętej serii też są w tekście.
  public static func build(_ view: TranscriptState, timeZone: TimeZone = .current) -> TranscriptSelectionText {
    var out = ""
    var length = 0
    var starts: [Int: Int] = [:]
    func append(_ piece: String) {
      out += piece
      length += piece.utf16.count
    }
    for item in view.messages {
      let body = lines(item)
      guard !body.isEmpty else { continue }
      if length > 0 { append("\n\n") }
      starts[item.seq] = length
      append(header(role: item.effectiveRole, clock: ServerTime.clock(item.at, timeZone: timeZone)))
      for line in body { append("\n" + line) }
    }
    var openStart: Int?
    if let open = view.open, !open.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      if length > 0 { append("\n\n") }
      openStart = length
      append(header(role: .assistant, clock: nil))
      append("\n" + MarkdownPlainText.document(open.text))
    }
    return TranscriptSelectionText(text: out, starts: starts, openStart: openStart)
  }

  /// Wiersz nagłówka: rola słowem z początku zdania i godzina, jak linia metadanych na ekranie.
  static func header(role: MessageRole, clock: String?) -> String {
    UICopy.list([UICopy.rolePrefix(role)] + (clock.map { [$0] } ?? []), .dot)
  }

  /// Treść wiadomości po linii: Markdown jako zwykły tekst, karta narzędzia linią opisu, zdjęcie podpisem dostępności,
  /// załącznik nazwą. Notka harnessu i notka blokady promptu tym samym zdaniem co na ekranie.
  static func lines(_ message: TranscriptMessage) -> [String] {
    if let notice = message.notice { return [UICopy.harnessNotice(notice).text] }
    if let blocked = message.promptBlocked {
      return [UICopy.promptBlockedTitle, PromptBlockedNote.detail(blocked)].filter { !$0.isEmpty }
    }
    var lines: [String] = []
    for block in message.blocks {
      switch block {
      case let .text(text, _):
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
        lines.append(MarkdownPlainText.document(text))
      case let .toolCall(tool):
        lines.append(TranscriptRows.toolRow(tool, id: "", voice: nil, reading: TranscriptReading()).line)
      case let .image(image):
        lines.append(MediaThumbnail.inline(image, rowId: "", index: 0).label)
      case .unsupported:
        lines.append(UICopy.unsupportedBlock)
      }
    }
    let attached = TranscriptRows.attachmentMedia(message.attachments ?? [])
    lines += attached.thumbnails.map(\.label) + attached.chips.map(\.name)
    return lines
  }
}

extension MarkdownPlainText {
  /// Źródło Markdownu jako zwykły tekst okna zaznaczania: bez znaczników emfazy i kodu, link etykietą, lista ze
  /// znacznikami `- ` i `3. `, blok kodu bez płotków, linia pozioma jako `---`, tabela wierszami komórek rozdzielonych
  /// tabulatorem (wklejka do arkusza trafia w kolumny).
  static func document(_ source: String) -> String {
    MarkdownParser.blocks(source).map(block).joined(separator: "\n")
  }

  private static func block(_ block: MarkdownBlock) -> String {
    switch block {
    case let .paragraph(text), let .heading(_, text):
      inline(text)
    case let .list(items):
      items.map(listItem).joined(separator: "\n")
    case let .code(_, text, _):
      text.hasSuffix("\n") ? String(text.dropLast()) : text
    case let .quote(blocks):
      blocks.map(Self.block).joined(separator: "\n")
    case .rule:
      "---"
    case let .table(table):
      ([table.header] + table.rows).map { $0.map(inline).joined(separator: "\t") }.joined(separator: "\n")
    }
  }

  private static func listItem(_ item: MarkdownListItem) -> String {
    let indent = String(repeating: "  ", count: item.depth)
    let marker = item.number.map { "\($0). " } ?? "- "
    let hang = indent + String(repeating: " ", count: marker.count)
    return item.paragraphs.enumerated().map { index, paragraph in
      (index == 0 ? indent + marker : hang) + inline(paragraph)
    }.joined(separator: "\n")
  }

  private static func inline(_ text: String) -> String {
    MarkdownInlineParser.spans(text).map(\.text).joined()
  }
}
