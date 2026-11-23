import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Tekst okna „Zaznacz więcej…” jako czysta funkcja stanu transkryptu: kolejność wiadomości, wiersz nagłówka
// z rolą i godziną, Markdown jako zwykły tekst, tabela tabulatorami, karta narzędzia linią, zdjęcie podpisem, miejsce
// kursora w UTF-16 i czas budowy przy długiej sesji. Okno w UIKit: `TranscriptSelectionSheetTests`.
@Suite("tekst okna zaznaczania transkryptu")
struct TranscriptSelectionTextTests {
  static let utc = TimeZone(identifier: "UTC")!
  /// Najmniejszy PNG 1×1 — dekoder kontraktu przyjmuje tylko prawdziwy obrazek png albo jpeg.
  static let pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

  /// Rola słowem z tego samego słownika co nagłówek okna (`UICopy.rolePrefix`), nie literałem: słowo roli asystenta
  /// to zarazem nazwa narzędzia CLI, której strażnik źródeł (`SourceGuardTests`) nie wpuszcza do kodu apki.
  static func head(_ role: MessageRole, _ message: TranscriptMessage) -> String {
    "\(UICopy.rolePrefix(role)) · \(ServerTime.clock(message.at, timeZone: utc)!)"
  }

  static func view(_ messages: [TranscriptMessage], open: String? = nil) -> TranscriptState {
    Sample.state(session: Sample.session(), messages: messages, open: open).transcripts["s1"]!
  }

  @Test("wiadomości 1…N w kolejności: nagłówek z rolą i godziną, Markdown zwykłym tekstem, tabela, zdjęcie, narzędzie")
  func messagesInOrderWithImageAndTable() {
    let markdown = "**Plan:** zrób [to](https://example.com) w `main`\n\n| A | B |\n|---|---|\n| 1 | `x` |\n\n- jeden\n  1. dwa"
    let attachments = #"[{"kind":"image","name":"","bytes":10,"mime":"image/png","file":"1790000000000-0123456789abcdef.png"}]"#
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Popraw zapis")),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text(markdown)),
      Sample.message(seq: 3, role: "assistant", blocks: #"""
        [{"type":"image","dataUrl":"\#(Self.pixel)","alt":"Wykres"},
         {"type":"tool-call","toolName":"Edit","summary":"/Users/d/Projects/x/src/notes.ts"},
         {"type":"text","text":"```swift\nlet a = 1\n```"}]
        """#),
      Sample.message(seq: 4, role: "user", blocks: Sample.text("Zrzut"), attachments: attachments),
    ]
    let built = TranscriptSelectionText.build(Self.view(messages, open: "Płynie *dalej*"), timeZone: Self.utc)
    let expected = [
      Self.head(.user, messages[0]) + "\nPopraw zapis",
      Self.head(.assistant, messages[1]) + "\nPlan: zrób to w main\nA\tB\n1\tx\n- jeden\n  1. dwa",
      Self.head(.assistant, messages[2]) + "\nWykres\nEdit: …/x/src/notes.ts\nlet a = 1",
      Self.head(.user, messages[3]) + "\nZrzut\nZdjęcie 1",
      UICopy.rolePrefix(.assistant) + "\nPłynie dalej",
    ].joined(separator: "\n\n")
    #expect(built.text == expected)
  }

  @Test("kursor przy wiadomości, z której otwarto okno: wiersz nagłówka; otwarta odpowiedź; wpis kolejki na końcu")
  func cursorStartsAtMessageOfOrigin() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Pierwsza")),
      Sample.message(seq: 7, role: "assistant", blocks: Sample.text("Druga\n\nz akapitem")),
    ]
    let built = TranscriptSelectionText.build(Self.view(messages, open: "trzecia"), timeZone: Self.utc)
    let text = built.text as NSString
    #expect(built.cursor(row: "m1.0") == 0)
    #expect(built.cursor(row: "m7.1") == text.range(of: Self.head(.assistant, messages[1])).location)
    #expect(built.cursor(row: "open") == text.range(of: UICopy.rolePrefix(.assistant) + "\ntrzecia").location)
    #expect(built.cursor(row: "o\(UUID().uuidString)") == text.length)
    #expect(built.cursor(row: "m99.0") == text.length, "wiadomość spoza migawki")
  }

  @Test("indeksy UTF-16: emoji przed wiadomością przesuwa początek tak, jak liczy `NSRange` widoku tekstu")
  func cursorCountsUtf16WithEmoji() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Zespół 👩‍💻 gotowy 🇵🇱")),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text("Dalej")),
    ]
    let built = TranscriptSelectionText.build(Self.view(messages), timeZone: Self.utc)
    let text = built.text as NSString
    let start = built.cursor(row: "m2.0")
    #expect(start == text.range(of: Self.head(.assistant, messages[1])).location)
    #expect(text.substring(from: start) == Self.head(.assistant, messages[1]) + "\nDalej")
  }

  @Test("CRLF w treści: początek następnej wiadomości w UTF-16, choć `\\r\\n` to jeden znak Swifta")
  func cursorAfterCrlfText() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Pierwsza\r\nlinia\r\n\r\nakapit\r")),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text("Dalej\r\nz CRLF")),
      Sample.message(seq: 3, role: "assistant", blocks: Sample.text("Trzecia")),
    ]
    let built = TranscriptSelectionText.build(Self.view(messages), timeZone: Self.utc)
    let text = built.text as NSString
    for (index, body) in [(1, "Dalej"), (2, "Trzecia")] {
      let head = Self.head(.assistant, messages[index]) + "\n" + body
      let start = built.cursor(row: "m\(messages[index].seq).0")
      #expect(start == text.range(of: head).location, "\(body)")
      #expect(text.substring(from: start).hasPrefix(head), "\(body)")
    }
  }

  @Test("notka harnessu i blok nieobsługiwany tym samym zdaniem co na ekranie; pusta wiadomość nie daje nagłówka")
  func noticesAndEmptyMessages() {
    let messages = [
      Sample.message(seq: 1, role: "assistant", blocks: #"[{"type":"future-block","x":1}]"#),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text("   ")),
    ]
    let built = TranscriptSelectionText.build(Self.view(messages), timeZone: Self.utc)
    #expect(built.text == Self.head(.assistant, messages[0]) + "\n" + UICopy.unsupportedBlock)
    #expect(built.cursor(row: "m2.0") == (built.text as NSString).length)
  }

  @Test("okno tekstu to okno: ustępuje formularzowi i zastępuje inne okno")
  @MainActor
  func windowYieldsToFormAndReplacesWindow() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let request = TranscriptTextRequest(sessionId: "s1", project: "willow", text: "Ty\na", cursor: 0)
    let form = AppSheet.newSession(NewSessionRequest(cwd: nil))
    navigation.openSheet(form)
    navigation.openSheet(.transcriptText(request))
    #expect(navigation.sheet == form, "formularz trzyma")
    navigation.sheet = nil
    navigation.openSheet(.diff(DiffRequest(sessionId: "s1", path: nil)))
    navigation.openSheet(.transcriptText(request))
    #expect(navigation.sheet == .transcriptText(request))
    #expect(navigation.sheet?.isWindow == true && navigation.sheet?.id == request.id)
  }

  @Test("500 wiadomości: tekst okna powstaje poniżej 200 ms")
  func fiveHundredMessagesUnder200ms() {
    let body = "Akapit z **pogrubieniem** i [linkiem](https://example.com).\n\n- punkt\n- drugi\n\n```sh\nnpm test\n```"
    let messages = (1...500).map { seq in
      Sample.message(seq: seq, role: seq.isMultiple(of: 2) ? "assistant" : "user", blocks: Sample.text("\(seq): \(body)"))
    }
    let view = Self.view(messages)
    _ = TranscriptSelectionText.build(view, timeZone: Self.utc)
    let clock = ContinuousClock()
    var built: TranscriptSelectionText?
    // Najlepszy z pięciu przebiegów: zestaw testów biegnie równolegle z innymi, a pomiar pyta o koszt budowy, nie
    // o to, ile procesora zostało dla tego testu.
    let runs = (0..<5).map { _ in clock.measure { built = TranscriptSelectionText.build(view, timeZone: Self.utc) } }
    #expect(runs.min()! < .milliseconds(200), "przebiegi: \(runs)")
    #expect(built?.text.contains("500: Akapit") == true)
    #expect(built?.cursor(row: "m500.0") == (built!.text as NSString).range(of: "\n\n", options: .backwards).location + 2)
  }
}
