import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Okno „Zaznacz więcej…” na prawdziwym ekranie sesji: pozycja w menu edycji wiadomości, migawka tekstu
/// z kursorem przy wiadomości, z której otwarto okno, kopia zakresu przez dwie wiadomości i z emoji (indeksy UTF-16),
/// tekst bez zmian przy odpowiedzi, która napływa przy otwartym oknie, i widok zaznaczalny oraz przewijalny z treścią
/// wyższą niż ramka. Przeciągnięcia uchwytu poza ekran test nie prowadzi (XCUITest nie steruje uchwytami pewnie) —
/// gest sprawdza odbiór. Logika tekstu: `TranscriptSelectionTextTests`. Właściciel: transkrypt.
@MainActor
final class TranscriptSelectionSheetTests: XCTestCase {
  // MARK: - Menu edycji

  func testSelectMoreIsInMessageEditMenu() throws {
    let store = try Self.store(count: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let field = try Self.field("message.m2.0", in: controller)
    let delegate = try XCTUnwrap(field.delegate, "pole wiadomości ma delegata menu")
    let menu = try XCTUnwrap(delegate.textView?(field, editMenuForTextIn: NSRange(location: 0, length: 4), suggestedActions: []))
    let actions = menu.children.compactMap { $0 as? UIAction }
    let more = try XCTUnwrap(actions.first { $0.identifier == MessageContentView.selectMoreAction }, "\(menu.children)")
    XCTAssertEqual(more.title, "Zaznacz więcej…")
  }

  /// Odpowiedź z samą tabelą: zaznaczenie w komórce żyje w polu tabeli (``MarkdownTableView``), więc i jego menu
  /// kończy się „Zaznacz więcej…”, a okno staje z kursorem przy wiadomości, w której stoi tabela.
  func testSelectMoreInTableCellOpensSheetAtItsMessage() throws {
    let store = try Self.store(count: 3, table: true)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let outer = try Self.field("message.m2.0", in: controller)
    let manager = try XCTUnwrap(outer.textLayoutManager)
    manager.ensureLayout(for: manager.documentRange)
    outer.layoutIfNeeded()
    let table = try XCTUnwrap(TranscriptLeadingTests.views(of: MarkdownTableView.self, in: outer).first, "widok tabeli")
    table.layoutIfNeeded()
    let cell = table.textView
    XCTAssertTrue(cell.text.contains("Kolumna"), cell.text)
    let delegate = try XCTUnwrap(cell.delegate, "pole tabeli ma delegata menu")
    let menu = try XCTUnwrap(delegate.textView?(cell, editMenuForTextIn: NSRange(location: 0, length: 3), suggestedActions: []))
    let actions = menu.children.compactMap { $0 as? UIAction }
    let more = try XCTUnwrap(actions.first { $0.identifier == MessageContentView.selectMoreAction }, "\(menu.children)")
    XCTAssertEqual(more.title, "Zaznacz więcej…")

    let navigation = RarogNavigation(prefs: MemoryPreferences())
    controller.navigation = navigation
    // Test uruchamia akcję tak, jak menu systemu (UIAction nie ma publicznego wywołania obsługi).
    let perform = NSSelectorFromString("performWithSender:target:")
    XCTAssertTrue(more.responds(to: perform))
    more.perform(perform, with: nil, with: nil)
    var request: TranscriptTextRequest?
    if case let .transcriptText(shown) = navigation.sheet { request = shown }
    let shown = try XCTUnwrap(request, "okno nie stanęło: \(String(describing: navigation.sheet))")
    let full = shown.text as NSString
    XCTAssertEqual(shown.cursor, full.range(of: "\n\n").location + 2, "kursor na nagłówku drugiej wiadomości")
    XCTAssertTrue(full.substring(from: shown.cursor).hasPrefix("Agent · "), full.substring(from: shown.cursor))
    XCTAssertTrue(full.substring(from: shown.cursor).contains("Kolumna\tWartość"))
  }

  func testSelectMoreLeavesSystemMenuWhenNoScreenAbove() throws {
    let config = MessageContentConfiguration(
      voice: nil, text: NSAttributedString(string: "Sam wiersz"), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
    let view = config.makeContentView()
    let field = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first)
    XCTAssertNil(field.delegate?.textView?(field, editMenuForTextIn: NSRange(location: 0, length: 3), suggestedActions: []),
      "bez ekranu sesji menu zostaje systemowe")
  }

  // MARK: - Migawka i kursor

  func testOpenSnapshotsLoadedMessagesWithCursorAtOrigin() throws {
    let store = try Self.store(count: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let (request, navigation) = try Self.open(controller, row: "m2.0")
    defer { withExtendedLifetime(navigation) {} }
    XCTAssertEqual(request.project, "project")
    XCTAssertEqual(request.text.components(separatedBy: "\n\n").count, 3, request.text)
    let second = (request.text as NSString).range(of: "Wiadomość 2.").location
    XCTAssertNotEqual(second, NSNotFound)
    let header = (request.text as NSString).range(of: "\n\n", options: .backwards, range: NSRange(location: 0, length: second))
    XCTAssertEqual(request.cursor, header.location + 2, "kursor na wierszu nagłówka wiadomości, z której otwarto okno")
  }

  func testIncomingReplyLeavesSheetTextUnchanged() throws {
    let store = try Self.store(count: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let (request, navigation) = try Self.open(controller, row: "m3.0")
    let (sheetWindow, text) = try Self.sheet(request)
    defer { sheetWindow.isHidden = true }
    XCTAssertEqual(text.text, request.text)

    try SessionToastTests.frame(store, #"{"type":"delta","sessionId":"s1","text":"Płynie odpowiedź"}"#, source: .session("s1"))
    try SessionToastTests.frame(store, Self.message(4, "assistant", "Nowa odpowiedź."), source: .session("s1"))
    SessionToastTests.until { controller.rows["m4.0"] != nil }
    SessionToastTests.spin(0.2)
    XCTAssertNotNil(controller.rows["m4.0"], "odpowiedź doszła do transkryptu")
    XCTAssertEqual(navigation.sheet, .transcriptText(request), "okno stoi z tą samą prośbą")
    XCTAssertEqual(text.text, request.text, "tekst okna bez zmian")
    XCTAssertFalse(text.text.contains("Nowa odpowiedź"))
  }

  // MARK: - Widok tekstu okna

  func testSheetTextIsSelectableScrollableAndTallerThanFrame() throws {
    let store = try Self.store(count: 60)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let (request, navigation) = try Self.open(controller, row: "m30.0")
    defer { withExtendedLifetime(navigation) {} }
    let (sheetWindow, text) = try Self.sheet(request)
    defer { sheetWindow.isHidden = true }
    XCTAssertTrue(text.isSelectable)
    XCTAssertFalse(text.isEditable)
    XCTAssertTrue(text.isScrollEnabled)
    XCTAssertGreaterThan(text.contentSize.height, text.bounds.height, "treść wyższa niż ramka")
    XCTAssertEqual(text.selectedRange, NSRange(location: request.cursor, length: 0), "kursor przy wiadomości z menu")
    let start = try XCTUnwrap(text.position(from: text.beginningOfDocument, offset: request.cursor))
    let caret = text.convert(text.caretRect(for: start), to: text.superview)
    XCTAssertTrue(text.frame.intersects(caret), "wiadomość z menu widać: \(caret) w \(text.frame)")
    XCTAssertGreaterThan(text.contentOffset.y, 0, "okno przewinięte do środka transkryptu")
  }

  /// Kursor spoza tekstu (ujemny, za końcem) widok ogranicza do granic tekstu, zamiast paść na zakresie.
  func testCursorOutsideTextIsClamped() throws {
    for (cursor, expected) in [(-5, 0), (10_000, ("Ty · 10:01\nkrótko" as NSString).length)] {
      let request = TranscriptTextRequest(sessionId: "s1", project: "project", text: "Ty · 10:01\nkrótko", cursor: cursor)
      let (sheetWindow, text) = try Self.sheet(request)
      defer { sheetWindow.isHidden = true }
      XCTAssertEqual(text.selectedRange, NSRange(location: expected, length: 0), "kursor \(cursor)")
    }
  }

  func testRangeAcrossTwoMessagesCopiesExactText() throws {
    let store = try Self.store(count: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let (request, navigation) = try Self.open(controller, row: "m1.0")
    defer { withExtendedLifetime(navigation) {} }
    let (sheetWindow, text) = try Self.sheet(request)
    defer { sheetWindow.isHidden = true }
    let full = request.text as NSString
    let from = full.range(of: "Wiadomość 1.").location + 3
    let to = NSMaxRange(full.range(of: "Wiadomość 2.")) - 1
    let range = NSRange(location: from, length: to - from)
    try Self.assertCopies(range, in: text, expected: full.substring(with: range))
    XCTAssertTrue(full.substring(with: range).contains("\n\n"), "zakres przechodzi przez granicę wiadomości")
  }

  func testRangeWithEmojiCopiesExactText() throws {
    let store = try Self.store(count: 2, emoji: true)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let (request, navigation) = try Self.open(controller, row: "m1.0")
    defer { withExtendedLifetime(navigation) {} }
    let (sheetWindow, text) = try Self.sheet(request)
    defer { sheetWindow.isHidden = true }
    let full = request.text as NSString
    let emoji = full.range(of: "👩‍💻")
    XCTAssertEqual(emoji.length, 5, "emoji z łącznikiem to pięć jednostek UTF-16")
    let range = NSRange(location: emoji.location, length: NSMaxRange(full.range(of: "🇵🇱")) - emoji.location)
    try Self.assertCopies(range, in: text, expected: "👩‍💻 gotowy 🇵🇱")
  }

  // MARK: - Pomocnicze

  /// Runner testów bez apki nie może czytać schowka: treść kopii to tekst zaznaczonego zakresu (systemowe „Kopiuj”
  /// zwykłego pola bierze właśnie jego), a zapis do schowka widać po liczniku zmian.
  private static func assertCopies(_ range: NSRange, in text: UITextView, expected: String) throws {
    text.selectedRange = range
    XCTAssertEqual(text.selectedRange, range)
    XCTAssertEqual(text.text(in: try XCTUnwrap(text.selectedTextRange)), expected)
    let before = UIPasteboard.general.changeCount
    text.copy(nil)
    XCTAssertGreaterThan(UIPasteboard.general.changeCount, before, "kopia poszła do schowka")
  }

  /// „Zaznacz więcej…” z wiersza `row` przez nawigację apki: prośba okna, które stanęło, i nawigacja (ekran trzyma ją
  /// słabo, więc trzyma ją test).
  private static func open(
    _ controller: SessionViewController, row: String
  ) throws -> (request: TranscriptTextRequest, navigation: RarogNavigation) {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    controller.navigation = navigation
    controller.openTranscriptSelection(row: row)
    var request: TranscriptTextRequest?
    if case let .transcriptText(shown) = navigation.sheet { request = shown }
    return (try XCTUnwrap(request, "okno nie stanęło: \(String(describing: navigation.sheet))"), navigation)
  }

  /// Okno z prośby w osobnym oknie iPada; zwraca jego widok tekstu po pierwszym układzie i przewinięciu.
  private static func sheet(_ request: TranscriptTextRequest) throws -> (UIWindow, UITextView) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 834, height: 1194))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = UIHostingController(rootView: TranscriptSelectionSheet(request: request, windowWidth: 834))
    window.isHidden = false
    var found: UITextView?
    SessionToastTests.until {
      found = TranscriptLeadingTests.views(of: UITextView.self, in: window).first { $0.text == request.text }
      return found != nil
    }
    SessionToastTests.spin(0.3)
    window.layoutIfNeeded()
    return (window, try XCTUnwrap(found, "widok tekstu okna"))
  }

  private static func field(_ identifier: String, in controller: SessionViewController) throws -> UITextView {
    try XCTUnwrap(
      TranscriptLeadingTests.views(of: UITextView.self, in: controller.collectionView)
        .first { $0.accessibilityIdentifier == identifier }, identifier)
  }

  private static func host(_ store: RarogStore) -> (SessionViewController, UIWindow) {
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 834, height: 1194))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    SessionToastTests.spin(0.2)
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    return (controller, window)
  }

  private static func message(_ seq: Int, _ role: String, _ text: String) -> String {
    #"{"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"\#(role)","at":"2026-10-06T10:\#(String(format: "%02d", seq % 60)):00.000Z","blocks":[{"type":"text","text":"\#(text)"}]}}"#
  }

  /// Sesja `s1` z `count` wiadomościami po pełnym stanie z serwera: pierwsza to prompt człowieka, reszta odpowiedzi
  /// agenta po kilka akapitów. `emoji`: pierwsza wiadomość niesie emoji z łącznikiem i flagę. `table`: druga wiadomość
  /// to sama tabela Markdown.
  private static func store(count: Int, emoji: Bool = false, table: Bool = false) throws -> RarogStore {
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try SessionToastTests.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    try SessionToastTests.frame(store, #"""
      {"type":"sessions-snapshot","sessions":[{"id":"s1","cwd":"/Users/demo/project","title":"project",
        "state":"waiting-input","stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T09:00:00.000Z",
        "lastActivityAt":"2026-10-06T10:00:00.000Z"}]}
      """#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    let body = (1...count).map { seq in
      let role = seq == 1 ? "user" : "assistant"
      let text = emoji && seq == 1
        ? "Wiadomość 1. Zespół 👩‍💻 gotowy 🇵🇱"
        : table && seq == 2
        ? #"| Kolumna | Wartość |\n|---|---|\n| pierwsza | 1 |\n| druga | 2 |"#
        : "Wiadomość \(seq). " + Array(repeating: "Akapit z treścią, która zawija się na kilka linii w oknie.", count: 3)
          .joined(separator: "\\n\\n")
      let at = "2026-10-06T10:\(String(format: "%02d", seq % 60)):00.000Z"
      return #"{"seq":\#(seq),"role":"\#(role)","at":"\#(at)","blocks":[{"type":"text","text":"\#(text)"}]}"#
    }.joined(separator: ",")
    try SessionToastTests.frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(body)],"pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }
}
