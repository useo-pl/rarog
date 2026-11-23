import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Karta decyzji w transkrypcie, pole schowane (tryb `DecisionDock.Mode.transcript`):
/// karta zgody, pytanie albo „dialog w terminalu” stoi w ogonie transkryptu jak przed dokiem, a pole wiadomości znika,
/// dopóki karta czeka na decyzję. Prawdziwy `SessionViewController` w oknie iPhone'a (393 × 852) i iPada (834 × 1194).
/// Pomocnicze (magazyn, ramki, karty) bierze z `DecisionDockTests`. Przy `RAROG_CARD_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG. Właściciel: karty.
@MainActor
final class DecisionInTranscriptTests: XCTestCase {
  typealias D = DecisionDockTests
  static let sizes = [DecisionDockTests.phone, DecisionDockTests.pad]

  // MARK: - Kiedy pole jest schowane, gdzie stoi karta

  func testDefaultModeIsTranscript() {
    XCTAssertEqual(DecisionDock.mode, .transcript)
    let controller = SessionViewController(
      store: RarogStore.live(
        config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
        outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)),
      sessionId: "s1", drafts: ComposerDrafts())
    XCTAssertEqual(controller.decisionMode, .transcript, "ekran startuje w trybie z `DecisionDock.mode`")
  }

  /// Zgoda, formularz pytań i „dialog w terminalu”: pole schowane, dok schowany, karta ostatnim wierszem transkryptu
  /// (ten sam ogon co przed dokiem), bez sufitu doku. Po decyzji pole wraca.
  func testWaitingCardHidesComposerAndStandsInTranscript() throws {
    for size in Self.sizes {
      let fixture = try Self.make(size: size, messages: 3)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      XCTAssertFalse(controller.composer.isHidden, "\(size): pole przed kartą")

      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
      Self.assertCardInTranscript(fixture, "pp1", "\(size) zgoda")
      try D.resolve(fixture, "p1")
      D.waitRender(fixture) { !$0.composer.isHidden }
      XCTAssertNil(controller.rows["pp1"])

      try D.question(fixture, D.form)
      D.waitRender(fixture) { $0.rows["qdock-form"] != nil && $0.composer.isHidden }
      Self.assertCardInTranscript(fixture, "qdock-form", "\(size) formularz")
      // Bez sufitu doku (`decisionDockCeiling == nil`): karta w transkrypcie ma pełną wysokość, środek się nie przewija.
      let cell = try XCTUnwrap(Self.cell(controller, "qdock-form"), "\(size): komórka formularza")
      let scrolling = D.views(of: UIScrollView.self, in: cell).filter { $0.contentSize.height > $0.bounds.height + 1 }
      XCTAssertTrue(scrolling.isEmpty, "\(size): układ zwarty nieaktywny: \(scrolling.map(\.frame))")
      try D.frame(fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-form"}"#, source: .session("s1"))
      try D.session(fixture, state: "running")
      D.waitRender(fixture) { !$0.composer.isHidden }

      // „Dialog w terminalu”: po okresie łaski karta zapasowa w transkrypcie.
      try D.session(fixture, state: "waiting-permission")
      let entered = Date()
      D.spin(max(0, entered.addingTimeInterval(DecisionGraceTiming.window).timeIntervalSinceNow))
      D.waitRender(fixture) { $0.rows["dialog"] != nil }
      // Karta „dialog w terminalu” nie przygasza transkryptu — jak przed dokiem.
      Self.assertCardInTranscript(fixture, "dialog", "\(size) dialog", dimmed: false)
      XCTAssertFalse(controller.footFrames.contains { $0.composer && $0.dock })
    }
  }

  /// Okres łaski: zastępnik w transkrypcie, pole schowane; karta, która przychodzi, zastępuje go w tym samym miejscu
  /// (ostatni wiersz), bez klatki z polem pomiędzy.
  func testGracePlaceholderInTranscriptGivesWayToCardWithoutComposerFrame() throws {
    for size in Self.sizes {
      let fixture = try Self.make(size: size, messages: 6, state: "running")
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      XCTAssertFalse(controller.composer.isHidden)
      let framesBefore = controller.footFrames.count
      let since = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
      try D.frame(
        fixture.store, #"{"type":"state","sessionId":"s1","state":"waiting-permission","since":"\#(since)"}"#,
        source: .global)
      D.waitRender(fixture) { $0.rows["decisionPending"] != nil }
      XCTAssertTrue(controller.composer.isHidden, "\(size): pole schowane pod zastępnikiem")
      XCTAssertTrue(controller.decisionSlot.isHidden, "\(size): dok schowany")
      XCTAssertNil(controller.dockModel)
      XCTAssertEqual(controller.dataSource.snapshot().itemIdentifiers.last, "decisionPending", "\(size): ostatni wiersz")
      if size == DecisionDockTests.phone { D.snapshot(controller, name: "transkrypt-zastepnik-iphone") }

      try D.permission(fixture, "p1", state: nil)
      D.waitRender(fixture) { $0.rows["pp1"] != nil }
      XCTAssertNil(controller.rows["decisionPending"], "\(size): zastępnik ustąpił karcie")
      XCTAssertEqual(controller.dataSource.snapshot().itemIdentifiers.last, "pp1", "\(size): karta w miejscu zastępnika")
      XCTAssertTrue(controller.composer.isHidden)
      let frames = controller.footFrames.suffix(from: min(framesBefore + 1, controller.footFrames.count))
      XCTAssertFalse(frames.isEmpty)
      XCTAssertFalse(frames.contains { $0.composer || $0.dock }, "\(size): pusta stopa w każdej klatce: \(Array(frames))")
    }
  }

  /// Wejście do sesji, która czeka, przed pierwszą migawką transkryptu: pole nie pojawia się w żadnej klatce.
  func testWaitingSessionBeforeSnapshotNeverShowsComposer() throws {
    let store = try D.makeStore(messages: 0, state: "waiting-permission", snapshot: false)
    let fixture = Self.host(store, size: DecisionDockTests.phone)
    defer { fixture.window.isHidden = true }
    XCTAssertTrue(fixture.controller.composer.isHidden, "pole schowane od pierwszego renderu")
    try D.frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(D.messages(2))],
       "pendingPermissions":[\#(D.request("p1"))],"pendingQuestions":[]}
      """#, source: .session("s1"))
    D.waitRender(fixture) { $0.rows["pp1"] != nil }
    let frames = fixture.controller.footFrames
    XCTAssertFalse(frames.isEmpty)
    XCTAssertFalse(frames.contains { $0.composer || $0.dock }, "pole i dok w żadnej klatce: \(frames)")
  }

  // MARK: - Kiedy pole NIE jest schowane

  /// Samo trzymane potwierdzenie odpowiedzi: sesja ruszyła, pole wraca od razu, a potwierdzenie stoi w transkrypcie.
  func testHeldConfirmationBringsComposerBack() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.question(fixture, D.short)
    D.waitRender(fixture) { $0.rows["qdock-short"] != nil && $0.composer.isHidden }
    guard case let .question(card)? = controller.rows["qdock-short"] else { return XCTFail("karta pytania") }
    controller.ui.questions.begin(card, answers: [["Tak"]])
    controller.ui.questions.finish("dock-short", .accepted)
    try D.frame(fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-short"}"#, source: .session("s1"))
    try D.session(fixture, state: "running")
    D.waitRender(fixture) {
      if case let .question(card)? = $0.rows["qdock-short"] { return card.held }
      return false
    }
    D.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertTrue(controller.decisionSlot.isHidden)
    guard case let .question(held)? = controller.rows["qdock-short"] else { return XCTFail("potwierdzenie") }
    XCTAssertTrue(held.held, "potwierdzenie w transkrypcie, pole już stoi")
  }

  /// Karta zamknięta (herdr tylko do odczytu): `FootContent` daje pole, więc pole stoi tylko do odczytu, a karta
  /// w transkrypcie.
  func testLockedCardKeepsReadOnlyComposer() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.frame(
      fixture.store, #"{"type":"herdr-status","available":true,"agentCount":1,"readOnly":true}"#, source: .global)
    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.rows["pp1"] != nil }
    D.spin(0.2)
    XCTAssertEqual(controller.footContent, .composer)
    XCTAssertFalse(controller.composer.isHidden, "pole stoi przy karcie zamkniętej")
    XCTAssertFalse(controller.composer.isEditable, "pole tylko do odczytu")
    guard case let .permission(card)? = controller.rows["pp1"] else { return XCTFail("karta zgody") }
    XCTAssertNotNil(card.lockedReason, "karta zamknięta")
  }

  // MARK: - Transkrypt nie skacze

  /// Przypięty długi transkrypt: pole znika i wraca, lista stoi na dnie w pierwszej klatce i po ustabilizowaniu.
  func testPinnedTranscriptStaysAtBottomWhenComposerHidesAndReturns() throws {
    for size in Self.sizes {
      let fixture = try Self.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie przed kartą")

      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.composer.isHidden && $0.rows["pp1"] != nil }
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie w pierwszej klatce z kartą")
      D.spin(0.3)
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie po ustabilizowaniu")
      XCTAssertNotNil(Self.cell(controller, "pp1"), "\(size): karta na ekranie")

      try D.resolve(fixture, "p1")
      D.waitRender(fixture) { !$0.composer.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie w pierwszej klatce z polem")
      D.spin(0.3)
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie po powrocie pola")
      XCTAssertLessThanOrEqual(
        controller.readingChrome.counters.maxSettleTurns, SessionViewController.settleTurns, "\(size): wspólny limit")
    }
  }

  /// Odpięty transkrypt: górny widoczny wiersz nie rusza się, gdy pole znika i wraca.
  func testUnpinnedTopRowHoldsWhenComposerHidesAndReturns() throws {
    for size in Self.sizes {
      let fixture = try Self.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      let list = controller.collectionView!
      list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 900), animated: false)
      controller.pinned = false
      fixture.window.layoutIfNeeded()
      let (row, top) = try XCTUnwrap(D.topRow(controller), "\(size): górny wiersz")

      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.composer.isHidden && $0.rows["pp1"] != nil }
      fixture.window.layoutIfNeeded()
      XCTAssertEqual(try XCTUnwrap(D.screenY(controller, row)), top, accuracy: 0.5, "\(size): wiersz bez pola")
      D.spin(0.3)
      fixture.window.layoutIfNeeded()
      XCTAssertEqual(try XCTUnwrap(D.screenY(controller, row)), top, accuracy: 0.5, "\(size): wiersz po ustabilizowaniu")
      try D.resolve(fixture, "p1")
      D.waitRender(fixture) { !$0.composer.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertEqual(try XCTUnwrap(D.screenY(controller, row)), top, accuracy: 0.5, "\(size): wiersz z polem")
      XCTAssertFalse(controller.pinned, "\(size): przypięcie zmienia tylko gest")
    }
  }

  // MARK: - Pasek „na dół” i przygaszenie

  /// Karta w transkrypcie, człowiek przewinął wyżej: pasek mówi „Przewiń do decyzji” i przewija do karty; transkrypt
  /// przygaszony.
  func testJumpBarSaysScrollToDecisionAndReachesCard() throws {
    for size in Self.sizes {
      let fixture = try Self.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      try D.permission(fixture, "p1")
      D.waitRender(fixture) { $0.composer.isHidden && $0.rows["pp1"] != nil }
      XCTAssertTrue(controller.readingChrome.dimmed, "\(size): transkrypt przygaszony")
      let bar = controller.readingChrome.jumpBar
      XCTAssertTrue(bar.decision, "\(size): pasek decyzji")
      XCTAssertEqual(bar.accessibilityLabel, UICopy.jumpLabel(decision: true))

      let list = controller.collectionView!
      list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 900), animated: false)
      controller.pinned = false
      controller.updateJumpBar()
      fixture.window.layoutIfNeeded()
      XCTAssertGreaterThan(controller.distanceFromBottom(), SessionViewController.pinThreshold)
      XCTAssertEqual(bar.accessibilityLabel, UICopy.jumpLabel(decision: true), "\(size): „Przewiń do decyzji”")
      if size == DecisionDockTests.phone { D.snapshot(controller, name: "transkrypt-pasek-decyzji-iphone") }

      controller.jumpToBottom()
      D.spin(1.2)
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie po skoku")
      let card = try XCTUnwrap(Self.cell(controller, "pp1"), "\(size): karta na ekranie po skoku")
      let frame = card.convert(card.bounds, to: nil)
      // The list runs under the foot: "visible" means above the top of the foot.
      let uncovered = list.convert(controller.uncoveredTranscriptRect(), to: nil)
      XCTAssertLessThanOrEqual(frame.maxY, uncovered.maxY + 0.5, "\(size): karta cała widoczna")
    }
  }

  // MARK: - Szkic pola

  /// Szkic „abc” i załącznik przeżywają kartę; bez klawiatury sprzętowej pole po powrocie nie jest pierwszym
  /// responderem.
  func testDraftAndAttachmentComeBackAfterDecision() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer {
      fixture.window.isHidden = true
      AttachmentShelf.shared.removeAll()
    }
    let composer = fixture.controller.composer
    composer.textView.text = "abc"
    let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    let attachment = ComposerAttachment(kind: .file, name: "notatka.txt", mime: "text/plain", bytes: 7, file: file)
    AttachmentShelf.shared.restore([attachment], for: "s1")
    XCTAssertEqual(composer.attachments.count, 1)

    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.composer.isHidden && $0.rows["pp1"] != nil }
    XCTAssertFalse(composer.textView.isFirstResponder)
    try D.resolve(fixture, "p1")
    D.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertEqual(composer.text, "abc", "szkic wraca")
    XCTAssertEqual(composer.attachments.map(\.id), [attachment.id], "załącznik wraca")
    XCTAssertTrue(composer.isEditable)
    XCTAssertFalse(composer.textView.isFirstResponder, "bez klawiatury sprzętowej klawiatura nie wraca sama")
  }

  /// Pisanie z klawiaturą w górze: karta chowa pole i klawiaturę (pole traci responder), a dyktowanie nie ma dokąd
  /// pisać (pole tylko do odczytu, mikrofon wygaszony — nagranie w toku kończy się z tekstem, `ComposerDictation`).
  func testComposerHiddenWhileTypingDropsKeyboardAndDictation() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    fixture.window.makeKeyAndVisible()
    let composer = fixture.controller.composer
    XCTAssertTrue(composer.textView.becomeFirstResponder(), "pisanie w polu")
    composer.textView.insertText("abc")
    XCTAssertTrue(fixture.controller.dictation.canToggle, "mikrofon czynny przed kartą")

    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.composer.isHidden && $0.rows["pp1"] != nil }
    XCTAssertFalse(composer.textView.isFirstResponder, "pole schowane razem z klawiaturą")
    XCTAssertFalse(composer.isEditable, "pole schowane nie przyjmuje tekstu")
    XCTAssertFalse(fixture.controller.dictation.canToggle, "dyktowanie do schowanego pola nie rusza")
    XCTAssertEqual(composer.text, "abc", "tekst zostaje w polu")
  }

  /// Fokus w polu „Własna odpowiedź” karty w transkrypcie: rendery ekranu (pole schowane) go nie zabierają.
  func testCustomAnswerFieldKeepsFocusWhileComposerHidden() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    fixture.window.makeKeyAndVisible()
    let controller = fixture.controller
    try D.question(fixture, D.form)
    D.waitRender(fixture) { $0.rows["qdock-form"] != nil && $0.composer.isHidden }
    controller.ui.questions.drafts.update("dock-form", sections: 3) { $0.openCustom(in: 0) }
    controller.scheduleRender()
    var field: UITextView?
    for _ in 0..<100 where field == nil {
      D.spin(0.02)
      field = Self.cell(controller, "qdock-form").flatMap { D.views(of: UITextView.self, in: $0).first }
    }
    let text = try XCTUnwrap(field, "pole „Własna odpowiedź” w karcie w transkrypcie")
    XCTAssertTrue(text.becomeFirstResponder(), "fokus w polu karty")
    let before = controller.readingChrome.counters.renders
    try D.frame(fixture.store, #"""
      {"type":"message","sessionId":"s1","message":{"seq":50,"role":"assistant","at":"2026-10-06T10:00:00.000Z",
       "blocks":[{"type":"text","text":"Nowa wiadomość w trakcie pisania."}]}}
      """#, source: .session("s1"))
    D.waitRender(fixture) { $0.readingChrome.counters.renders > before }
    XCTAssertTrue(controller.composer.isHidden)
    XCTAssertTrue(text.isFirstResponder, "render ze schowanym polem nie zabiera fokusu polu karty")
    text.resignFirstResponder()
  }

  // MARK: - Klawisze i VoiceOver

  /// Cyfry i Enter idą do karty pytania w transkrypcie; Tab ma kartę, na którą może wejść, a pola nie ma.
  func testDigitEnterAndTabReachCardInTranscript() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.question(fixture, D.form)
    D.waitRender(fixture) { $0.rows["qdock-form"] != nil && $0.composer.isHidden }
    XCTAssertTrue(controller.hasFocusableCard, "Tab: karta w transkrypcie")
    XCTAssertNil(controller.dockedCard())
    let tab = try XCTUnwrap(controller.cardKeyCommands.first { $0.input == "\t" })
    XCTAssertTrue(controller.canPerformAction(try XCTUnwrap(tab.action), withSender: tab), "Tab należy do karty")
    let commands = controller.answerKeyCommands
    let digit = try XCTUnwrap(commands.first { $0.input == "1" }, "cyfry karty w transkrypcie")
    _ = controller.perform(try XCTUnwrap(digit.action), with: digit)
    XCTAssertEqual(controller.ui.questions.drafts.draft("dock-form", sections: 3).picks.first, ["shared/fixtures/sse"])
    D.spin(QuestionKeyRepeat.window + 0.1)
    let enter = try XCTUnwrap(commands.first { $0.input == "\r" }, "Enter karty w transkrypcie")
    _ = controller.perform(try XCTUnwrap(enter.action), with: enter)
    XCTAssertNotNil(controller.ui.questions.errors["dock-form"], "Enter bez kompletu: zdanie pod kartą")

    // Jedno pytanie (`instant`): cyfra wysyła odpowiedź z karty w transkrypcie.
    try D.frame(fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-form"}"#, source: .session("s1"))
    try D.question(fixture, D.short)
    D.waitRender(fixture) { $0.rows["qdock-short"] != nil && $0.rows["qdock-form"] == nil }
    D.spin(QuestionKeyRepeat.window + 0.1)
    let two = try XCTUnwrap(controller.answerKeyCommands.first { $0.input == "2" })
    _ = controller.perform(try XCTUnwrap(two.action), with: two)
    XCTAssertEqual(controller.ui.questions.flights["dock-short"]?.answered.answers, [["Nie"]])
  }

  /// Fokus czytnika w polu, karta staje w transkrypcie: czytnik przechodzi na komórkę karty. W okresie łaski czeka na
  /// kartę, która zastąpi zastępnik.
  func testVoiceOverMovesFromComposerToCardCell() throws {
    for grace in [false, true] {
      let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3, state: grace ? "running" : "waiting-input")
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      var posts: [(UIAccessibility.Notification, Any?)] = []
      controller.accessibilityPost = { posts.append(($0, $1)) }
      controller.voiceOverFocusedElement = { [weak controller] in controller?.composer.textView }
      if grace {
        let since = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
        try D.frame(
          fixture.store, #"{"type":"state","sessionId":"s1","state":"waiting-permission","since":"\#(since)"}"#,
          source: .global)
        D.waitRender(fixture) { $0.rows["decisionPending"] != nil && $0.composer.isHidden }
        XCTAssertTrue(posts.filter { $0.0 == .layoutChanged }.isEmpty, "zastępnik: czytnik czeka na kartę")
        try D.permission(fixture, "p1", state: nil)
      } else {
        try D.permission(fixture, "p1")
      }
      D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
      // Przeniesienie idzie po końcowym ułożeniu listy (kolejna tura pętli).
      D.spin(0.1)
      let layout = posts.filter { $0.0 == .layoutChanged }
      XCTAssertEqual(layout.count, 1, "łaska \(grace): jedno przeniesienie fokusu")
      let target = try XCTUnwrap(layout.first?.1 as? UICollectionViewCell, "łaska \(grace): fokus na komórce")
      XCTAssertTrue(target === Self.cell(controller, "pp1"), "łaska \(grace): komórka karty zgody")
    }
  }

  /// Kilka wysokich kart naraz w przypiętym transkrypcie: czytnik trafia na kartę, która PO ustabilizowaniu listy
  /// (powrót przypiętego transkryptu na dno) dalej jest na ekranie.
  func testVoiceOverTargetStaysVisibleWithTallCardQueue() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 6)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    var posts: [(UIAccessibility.Notification, Any?)] = []
    controller.accessibilityPost = { posts.append(($0, $1)) }
    controller.voiceOverFocusedElement = { [weak controller] in controller?.composer.textView }
    let plan = (1...20).map { "\($0). Krok planu z dłuższym opisem, który na telefonie zawija się w dwie linie." }
      .joined(separator: "\\n")
    try D.permission(fixture, "p1", extra: #""subject":"plan","displayText":"\#(plan)""#)
    try D.permission(fixture, "p2", extra: #""subject":"plan","displayText":"\#(plan)""#, state: nil)
    try D.permission(fixture, "p3", extra: #""subject":"plan","displayText":"\#(plan)""#, state: nil)
    D.waitRender(fixture) { $0.rows["pp3"] != nil && $0.composer.isHidden }
    D.spin(0.3)
    let target = try XCTUnwrap(
      posts.last { $0.0 == .layoutChanged }?.1 as? UICollectionViewCell, "fokus czytnika na komórce karty")
    // Only the part of the list above the foot is on screen.
    let visible = controller.uncoveredTranscriptRect()
    XCTAssertTrue(target.frame.intersects(visible), "karta celu na ekranie po ustabilizowaniu: \(target.frame) w \(visible)")
  }

  /// Fokus czytnika na karcie w transkrypcie i ratunek po jej zniknięciu.
  func testVoiceOverFocusOnCardIsRescued() throws {
    let fixture = try Self.make(size: DecisionDockTests.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try D.permission(fixture, "p1")
    D.waitRender(fixture) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    controller.trackVoiceOverCardFocus()
    let cell = try XCTUnwrap(Self.cell(controller, "pp1"))
    // Treść karty SwiftUI nie ma podwidoków-elementów; czytnik zgłasza węzeł w widoku treści komórki.
    let element = D.descendants(of: cell).first { $0.isAccessibilityElement || $0 is UILabel } ?? cell.contentView
    NotificationCenter.default.post(
      name: UIAccessibility.elementFocusedNotification, object: nil,
      userInfo: [UIAccessibility.focusedElementUserInfoKey: element])
    XCTAssertEqual(controller.focusedCardRow, "pp1", "fokus czytnika na karcie w transkrypcie")
    try D.resolve(fixture, "p1")
    D.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertNil(controller.focusedCardRow, "ratunek fokusu po zniknięciu karty")
  }

  // MARK: - Zrzuty

  /// Zrzuty do odbioru: iPhone z kartą zgody na dnie transkryptu i z formularzem pytań, bez pola.
  func testScreenshots() throws {
    let phone = try Self.make(size: DecisionDockTests.phone, messages: 6)
    defer { phone.window.isHidden = true }
    try D.permission(phone, "p1", extra: #""displayText":"npm test -- --run server/test/native-copy-guard.test.ts""#)
    D.waitRender(phone) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    D.snapshot(phone.controller, name: "transkrypt-zgoda-iphone")

    let form = try Self.make(size: DecisionDockTests.phone, messages: 6)
    defer { form.window.isHidden = true }
    try D.question(form, D.form)
    D.waitRender(form) { $0.rows["qdock-form"] != nil && $0.composer.isHidden }
    D.snapshot(form.controller, name: "transkrypt-formularz-iphone")

    let pad = try Self.make(size: DecisionDockTests.pad, messages: 6)
    defer { pad.window.isHidden = true }
    try D.permission(pad, "p1")
    D.waitRender(pad) { $0.rows["pp1"] != nil && $0.composer.isHidden }
    D.snapshot(pad.controller, name: "transkrypt-zgoda-ipad")
  }

  // MARK: - Pomocnicze

  static func make(size: CGSize, messages: Int, state: String = "waiting-input") throws -> D.Fixture {
    host(try D.makeStore(messages: messages, state: state), size: size)
  }

  static func host(_ store: RarogStore, size: CGSize) -> D.Fixture {
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.decisionMode = .transcript
    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    window.layoutIfNeeded()
    D.spin(0.1)
    window.layoutIfNeeded()
    return D.Fixture(controller: controller, store: store, window: window)
  }

  /// Komórka wiersza transkryptu, gdy jest na ekranie.
  static func cell(_ controller: SessionViewController, _ id: String) -> UICollectionViewCell? {
    guard let path = controller.dataSource.indexPath(for: id) else { return nil }
    return controller.collectionView.cellForItem(at: path)
  }

  /// Karta w transkrypcie (ten sam ogon co przed dokiem), pole i dok schowane, stopa bez klatki z polem i dokiem naraz.
  static func assertCardInTranscript(
    _ fixture: D.Fixture, _ id: String, _ label: String, dimmed: Bool = true,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let controller = fixture.controller
    XCTAssertTrue(controller.composer.isHidden, "\(label): pole schowane", file: file, line: line)
    XCTAssertTrue(controller.decisionSlot.isHidden, "\(label): dok schowany", file: file, line: line)
    XCTAssertNil(controller.dockModel, "\(label): karta nie w doku", file: file, line: line)
    XCTAssertNotNil(controller.rows[id], "\(label): karta wierszem transkryptu", file: file, line: line)
    let expected = TranscriptRows.build(state: fixture.store.state, sessionId: "s1", ui: controller.ui).map(\.id)
    XCTAssertEqual(
      controller.dataSource.snapshot().itemIdentifiers.suffix(3), expected.suffix(3),
      "\(label): ogon jak przed dokiem", file: file, line: line)
    XCTAssertEqual(controller.readingChrome.dimmed, dimmed, "\(label): przygaszenie", file: file, line: line)
  }
}
