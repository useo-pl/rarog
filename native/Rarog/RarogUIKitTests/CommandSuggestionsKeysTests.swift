import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Podpowiedzi slash-komend nad polem wiadomości na prawdziwym `SessionViewController` z fokusem w polu:
/// lista z magazynu po pierwszym „/”, klawisze sprzętowe pola (Return, Tab, ↑/↓, Esc) przez jego skróty
/// i `canPerformAction`, jak przy klawiaturze — pierwszy Return wstawia, drugi wysyła, Esc zamyka listę bez przerwania
/// tury, a w trakcie składania znaku (IME) klawisze zostają edytorowi. Dotyk w wierszu dochodzi do listy, choć ta
/// stoi poza granicą pola. Model i filtr: `CommandSuggestionsTests` (RarogUI). Właściciel: pole.
@MainActor
final class CommandSuggestionsKeysTests: XCTestCase {
  func testFirstReturnInsertsSecondSends() throws {
    let fixture = try Fixture(state: "waiting-input")
    defer { fixture.close() }
    try fixture.type("/comp")
    XCTAssertEqual(fixture.composer.suggestionsView.rowViews.count, 1, "prefiks: tylko /compact")
    XCTAssertEqual(fixture.calls.read(\.commands), ["s1"], "lista po pierwszym „/”")

    try fixture.press(.enter)
    XCTAssertEqual(fixture.composer.text, "/compact ", "pierwszy Return wstawia nazwę ze spacją")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "spacja zamyka listę")
    XCTAssertTrue(fixture.composer.suggestionsView.isHidden)
    XCTAssertEqual(fixture.calls.read(\.sends), [], "wstawienie nic nie wysyła")

    try fixture.press(.enter)
    fixture.wait("wysyłka drugim Returnem") { fixture.calls.read(\.sends) == ["/compact"] }
    XCTAssertEqual(fixture.composer.text, "", "pole puste po wysyłce")
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen)
  }

  func testEscapeClosesListWithoutInterruptingTurn() throws {
    EscapeGrace.reset()
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    try fixture.type("/c")
    try fixture.press(.escape)
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "Esc zamyka listę")
    XCTAssertEqual(fixture.composer.text, "/c", "tekst zostaje")
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(fixture.calls.read(\.interrupts), [], "tura pracuje dalej")

    // Drugi Esc tuż po zamknięciu listy (okno łaski) też tury nie przerywa; dopiero później Esc wraca do tury.
    XCTAssertFalse(fixture.can(.escape), "okno łaski po zamknięciu listy Esc-em")
    EscapeGrace.reset()
    try fixture.press(.escape)
    fixture.wait("przerwanie tury bez listy") { fixture.calls.read(\.interrupts) == ["s1"] }
  }

  func testArrowsAndTabInsertSelectedAndPassWhenClosed() throws {
    let fixture = try Fixture(state: "waiting-input")
    defer { fixture.close() }
    fixture.composer.textView.insertText("hej")
    for key in [Key.up, .down, .tab] {
      XCTAssertFalse(fixture.can(key), "\(key) bez listy idzie do edytora i dalej")
    }
    fixture.composer.text = ""
    try fixture.type("/c")
    XCTAssertEqual(fixture.composer.suggestionsView.rowViews.count, 4)
    try fixture.press(.down)
    try fixture.press(.down)
    try fixture.press(.up)
    try fixture.press(.tab)
    XCTAssertEqual(fixture.composer.text, "/clear ", "Tab wstawia zaznaczony wiersz")
    XCTAssertFalse(fixture.can(.tab), "po wstawieniu Tab znowu należy do reszty łańcucha")
  }

  func testComposingKeepsKeysInEditor() throws {
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    try fixture.type("/c")
    let field = fixture.composer.textView
    field.setMarkedText("o", selectedRange: NSRange(location: 1, length: 0))
    XCTAssertNotNil(field.markedTextRange, "znak w składaniu")
    for key in [Key.up, .down, .tab, .enter, .escape] {
      XCTAssertFalse(fixture.can(key), "\(key) w trakcie IME należy do edytora")
    }
    field.unmarkText()
    XCTAssertTrue(fixture.can(.enter))
  }

  func testTapOnRowReachesListAboveFieldAndJumpBarMovesAbove() throws {
    let fixture = try Fixture(state: "waiting-input")
    defer { fixture.close() }
    try fixture.type("/c")
    let list = fixture.composer.suggestionsView
    let card = try XCTUnwrap(fixture.composer.textView.superview)
    let listFrame = list.convert(list.bounds, to: nil)
    let cardFrame = card.convert(card.bounds, to: nil)
    XCTAssertEqual(cardFrame.minY - listFrame.maxY, CommandSuggestionsView.gap, accuracy: 0.5, "lista tuż nad kartą")
    XCTAssertEqual(listFrame.minX, cardFrame.minX, accuracy: 0.5)
    XCTAssertEqual(listFrame.maxX, cardFrame.maxX, accuracy: 0.5)
    XCTAssertGreaterThanOrEqual(listFrame.height, 4 * 44 + 2 * CommandSuggestionsView.inset - 0.5, "cztery wiersze bez ściśnięcia")
    XCTAssertTrue(fixture.controller.readingChrome.jumpAboveSuggestions?.isActive == true, "pasek „na dół” nad listą")
    let bar = fixture.controller.readingChrome.jumpBar
    XCTAssertLessThanOrEqual(bar.convert(bar.bounds, to: nil).maxY, listFrame.minY - 8 + 0.5, "pasek „na dół” stoi nad listą")

    let row = try XCTUnwrap(list.rowViews.first)
    let center = row.convert(CGPoint(x: row.bounds.midX, y: row.bounds.midY), to: nil)
    let hit = fixture.window.hitTest(center, with: nil)
    XCTAssertTrue(hit?.isDescendant(of: row) == true, "dotyk w wierszu dochodzi do listy, nie do transkryptu: \(String(describing: hit))")
    row.sendActions(for: .touchUpInside)
    XCTAssertEqual(fixture.composer.text, "/claude-api ")
    XCTAssertTrue(list.isHidden)
    XCTAssertTrue(fixture.controller.readingChrome.jumpAboveSuggestions?.isActive == false)
    XCTAssertTrue(fixture.composer.textView.isFirstResponder, "kursor zostaje w polu")

    // Schowana klawiatura (fokus poza polem) zamyka listę, powrót fokusu z tym samym tokenem ją otwiera.
    fixture.composer.text = "/co"
    XCTAssertTrue(fixture.composer.commandSuggestionsOpen)
    fixture.composer.textView.resignFirstResponder()
    XCTAssertFalse(fixture.composer.commandSuggestionsOpen, "bez fokusu listy nie ma")
    XCTAssertTrue(list.isHidden)
    XCTAssertTrue(fixture.composer.textView.becomeFirstResponder())
    XCTAssertTrue(fixture.composer.commandSuggestionsOpen, "fokus wraca — lista wraca")
  }

  func testListShowsAtMostSixRowsAndScrollsToSelection() throws {
    let fixture = try Fixture(state: "waiting-input")
    defer { fixture.close() }
    try fixture.type("/")
    let list = fixture.composer.suggestionsView
    // Komendy apki stoją od razu, lista sesji dochodzi z magazynu.
    fixture.wait("lista sesji") { list.rowViews.count == 11 }
    fixture.controller.view.layoutIfNeeded()
    XCTAssertEqual(
      list.rowViews.count, 11, "sam „/” = cała lista sesji i trzy komendy apki (/effort, /model, /usage)")
    let rowHeight = try XCTUnwrap(list.rowViews.first).bounds.height
    XCTAssertGreaterThanOrEqual(rowHeight, 44, "cel dotyku")
    XCTAssertEqual(list.bounds.height, 6 * rowHeight + 2 * CommandSuggestionsView.inset, accuracy: 0.5, "sześć wierszy widać")
    for _ in 0..<10 { try fixture.press(.down) }
    let last = try XCTUnwrap(list.rowViews.last)
    let visible = list.convert(list.bounds, to: nil)
    let lastFrame = last.convert(last.bounds, to: nil)
    XCTAssertTrue(visible.contains(CGPoint(x: lastFrame.midX, y: lastFrame.midY)), "zaznaczony wiersz przewinięty w widok: lista \(visible), wiersz \(lastFrame)")
    try fixture.press(.enter)
    XCTAssertEqual(fixture.composer.text, "/usage ")
  }

  /// Popover nad ekranem przy kursorze w polu (dymek modelu na iPadzie): Esc należy do okna, nie do listy ani tury.
  func testEscapeBelongsToWindowOverScreen() throws {
    EscapeGrace.reset()
    let fixture = try Fixture(state: "running")
    defer { fixture.close() }
    try fixture.type("/c")
    fixture.controller.present(UIViewController(), animated: false)
    XCTAssertNotNil(fixture.controller.presentedViewController, "okno nad ekranem")
    XCTAssertFalse(fixture.can(.escape), "Esc idzie do okna")
    XCTAssertTrue(fixture.composer.commandSuggestionsOpen, "lista stoi dalej")
    XCTAssertEqual(fixture.calls.read(\.interrupts), [])
    fixture.controller.dismiss(animated: false)
  }

  /// Niskie okno (telefon w poziomie z klawiaturą): lista dochodzi do sufitu, a pasek „Przewiń na dół” zostaje na
  /// ekranie, pod górą safe area, zamiast wyjechać nad nią.
  func testLowWindowKeepsJumpBarOnScreen() throws {
    let fixture = try Fixture(state: "waiting-input", height: 240)
    defer { fixture.close() }
    try fixture.type("/c")
    let view = try XCTUnwrap(fixture.controller.view)
    let top = view.safeAreaLayoutGuide.layoutFrame.minY
    let list = fixture.composer.suggestionsView
    let listFrame = list.convert(list.bounds, to: view)
    XCTAssertGreaterThanOrEqual(listFrame.minY, top + 8 - 0.5, "lista pod sufitem")
    XCTAssertLessThan(listFrame.height, 4 * 44 + 2 * CommandSuggestionsView.inset - 0.5, "lista skrócona do miejsca")
    XCTAssertEqual(listFrame.minY, top + 8, accuracy: 0.5, "lista dochodzi do sufitu")
    let bar = fixture.controller.readingChrome.jumpBar
    let barFrame = bar.convert(bar.bounds, to: view)
    XCTAssertGreaterThanOrEqual(barFrame.minY, top + 8 - 0.5, "pasek na ekranie: \(barFrame), safe area od \(top)")
    XCTAssertGreaterThan(barFrame.height, 0)
    XCTAssertEqual(
      view.subviews.firstIndex(of: bar).map { $0 > (view.subviews.firstIndex { list.isDescendant(of: $0) } ?? .max) },
      true, "pasek nad listą w kolejności warstw")
  }

  // MARK: - Ekran i klawisze

  typealias Key = CommandSuggestions.Key

  /// Ekran sesji `s1` w oknie z fokusem w polu; magazyn bez sieci, transport z listą komend. `pills` = rząd pigułek
  /// modelu i trybu pod polem, jak u hosta ekranu (`SessionControllerHost`; komendy apki).
  @MainActor
  struct Fixture {
    let controller: SessionViewController
    let window: UIWindow
    let calls: CallLog
    let store: RarogStore

    var composer: ComposerView { controller.composer }

    init(
      state: String, height: CGFloat = 874, pills: Bool = false, drafts: ComposerDrafts = ComposerDrafts(),
      announcer: Announcer = .shared
    ) throws {
      let log = CallLog()
      calls = log
      let transport = UIKitTransport.suggestions(calls: log)
      let store = RarogStore(
        transport: transport, rules: MutationRules(),
        outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
      self.store = store
      store.dispatch(.loggedIn)
      store.dispatch(.streamOpened(.global, resumedWithCursor: false))
      try Self.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
      let session = #"""
        {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"\#(state)",
         "stateSince":"2026-10-17T10:00:00.000Z","createdAt":"2026-10-17T10:00:00.000Z",
         "lastActivityAt":"2026-10-17T10:00:00.000Z"}
        """#
      try Self.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
      store.dispatch(.viewSession("s1"))
      store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
      try Self.frame(store, #"""
        {"type":"transcript-snapshot","sessionId":"s1","messages":[
         {"seq":1,"role":"assistant","at":"2026-10-17T10:00:00.000Z","blocks":[{"type":"text","text":"Gotowe."}]}],
         "pendingPermissions":[],"pendingQuestions":[]}
        """#, source: .session("s1"))
      controller = SessionViewController(store: store, sessionId: "s1", drafts: drafts, announcer: announcer)
      if pills { controller.installComposerPills(navigation: RarogNavigation(prefs: MemoryPreferences())) }
      window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: height))
      window.rootViewController = controller
      window.makeKeyAndVisible()
      controller.view.layoutIfNeeded()
      XCTAssertTrue(controller.composer.textView.becomeFirstResponder(), "pole z fokusem")
    }

    func close() {
      window.isHidden = true
    }

    /// Pisanie jak z klawiatury i czekanie na listę z magazynu.
    func type(_ text: String) throws {
      composer.textView.insertText(text)
      wait("lista po „\(text)”") { composer.commandSuggestionsOpen }
      controller.view.layoutIfNeeded()
      XCTAssertFalse(composer.suggestionsView.isHidden, "lista nad polem")
    }

    /// Skrót pola dla klawisza (te same obiekty, które dostaje system).
    func command(_ key: Key) throws -> UIKeyCommand {
      let input: String =
        switch key {
        case .up: UIKeyCommand.inputUpArrow
        case .down: UIKeyCommand.inputDownArrow
        case .tab: "\t"
        case .enter: "\r"
        case .escape: UIKeyCommand.inputEscape
        }
      return try XCTUnwrap(composer.textView.keyCommands?.first { $0.input == input && $0.modifierFlags.isEmpty })
    }

    func can(_ key: Key) -> Bool {
      guard let command = try? command(key), let action = command.action else { return false }
      return composer.textView.canPerformAction(action, withSender: command)
    }

    /// Naciśnięcie: skrót, który system by wywołał, tylko gdy pole go teraz przyjmuje.
    func press(_ key: Key) throws {
      let command = try command(key)
      let action = try XCTUnwrap(command.action)
      XCTAssertTrue(composer.textView.canPerformAction(action, withSender: command), "\(key) przyjęty przez pole")
      composer.textView.perform(action, with: command)
      controller.view.layoutIfNeeded()
    }

    func wait(_ what: String, timeout: TimeInterval = 3, _ condition: () -> Bool) {
      let deadline = Date().addingTimeInterval(timeout)
      while !condition(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
      XCTAssertTrue(condition(), "nie doczekałem się: \(what)")
    }

    private static func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
      let event = try EventDecoder.decode(Data(json.utf8)).get().event
      store.dispatch(.frame(event, source: source, cursor: nil))
    }
  }
}

/// Wywołania transportu z testu (lista komend, wysyłki, przerwania).
final class CallLog: @unchecked Sendable {
  struct Calls {
    var commands: [String] = []
    var sends: [String] = []
    /// Every call of `sendMessage`, also a body with attachments, which `sends` does not record.
    var sendCalls = 0
    var interrupts: [String] = []
    /// The send waits in the transport until this goes back to `false` (a late result).
    var holdSends = false
    /// The send fails with this error instead of 202 (a refusal, a lost network).
    var sendFailure: TransportError?
    /// The `operationId` of every queue take-back.
    var takeBacks: [UUID] = []
    /// The take-back's answer: a JSON body or an error; `nil` = nothing was queued (`{"items":[]}`).
    var takeBackReply: Result<String, TransportError>?
    /// The take-back waits in the transport until this goes back to `false` (an answer after the screen closed).
    var holdTakeBack = false
    /// The interrupt's 202 JSON body; `nil` = a 409 refusal (no retry).
    var interruptReply: String?
    /// The interrupt waits in the transport until this goes back to `false` (typing while the answer travels).
    var holdInterrupt = false
  }

  private let lock = NSLock()
  private var calls = Calls()

  func record(_ change: (inout Calls) -> Void) { lock.withLock { change(&calls) } }
  func read<T>(_ value: (Calls) -> T) -> T { lock.withLock { value(calls) } }
}

extension UIKitTransport {
  /// Test transport: the demo command list, a send answered 202 without a body (or held and failed on request,
  /// `CallLog.Calls`), an interrupt refused (no retry) unless the test gives its answer; nothing else goes to the
  /// network.
  fileprivate static func suggestions(calls: CallLog) -> UIKitTransport {
    UIKitTransport(
      onCommands: { sessionId throws(TransportError) in
        calls.record { $0.commands.append(sessionId) }
        return CommandList(revision: "r1", commands: [
          CommandChoice(name: "claude-api", kind: .prompt, source: .builtin),
          CommandChoice(name: "clear", kind: .local, source: .builtin),
          CommandChoice(name: "compact", kind: .local, source: .builtin),
          CommandChoice(name: "context", kind: .local, source: .builtin),
          CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Zrzut stanu", argumentHint: "[cel]"),
          CommandChoice(name: "init", kind: .prompt, source: .builtin),
          CommandChoice(name: "plan", kind: .local, source: .builtin),
          CommandChoice(name: "rename", kind: .local, source: .builtin),
        ])
      },
      onSend: { _, upload throws(TransportError) in
        calls.record { $0.sendCalls += 1 }
        guard case let .data(data) = upload.body,
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let text = body["text"] as? String
        else { throw .invalidResponse("ciało wysyłki") }
        calls.record { $0.sends.append(text) }
        while calls.read(\.holdSends) { try? await Task.sleep(for: .milliseconds(10)) }
        if let failure = calls.read(\.sendFailure) { throw failure }
        return nil
      },
      onInterrupt: { sessionId throws(TransportError) in
        calls.record { $0.interrupts.append(sessionId) }
        while calls.read(\.holdInterrupt) { try? await Task.sleep(for: .milliseconds(10)) }
        guard let body = calls.read(\.interruptReply) else {
          throw .http(APIFailure(status: 409, code: "conflict", message: "Test: bez przerwania."))
        }
        do {
          return try JSONDecoder().decode(InterruptResponse.self, from: Data(body.utf8))
        } catch {
          throw .invalidResponse("interrupt body: \(error)")
        }
      },
      onTakeBackQueue: { _, operationId throws(TransportError) in
        calls.record { $0.takeBacks.append(operationId) }
        while calls.read(\.holdTakeBack) { try? await Task.sleep(for: .milliseconds(10)) }
        let body = try (calls.read(\.takeBackReply) ?? .success(#"{"items":[]}"#)).get()
        do {
          return try JSONDecoder().decode(QueueTakeBackResponse.self, from: Data(body.utf8))
        } catch {
          throw .invalidResponse("take-back body: \(error)")
        }
      })
  }
}
