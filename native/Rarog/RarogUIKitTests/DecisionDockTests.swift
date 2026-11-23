import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Dok decyzji w miejscu pola wiadomości: karta zgody, „dialog w terminalu” albo pytanie (także
/// formularz i potwierdzenie odpowiedzi) staje w stopie zamiast pola, w okresie łaski — zastępnik; transkrypt nie
/// skacze, szkic wraca po decyzji. Prawdziwy `SessionViewController` w oknie iPhone'a (393 × 852) i iPada
/// (834 × 1194), z trybem `.dock` ustawionym przed pierwszym renderem (`decisionMode`; domyślny tryb
/// to `.transcript`, testy w `DecisionInTranscriptTests`). Właściciel: karty.
@MainActor
final class DecisionDockTests: XCTestCase {
  static let phone = CGSize(width: 393, height: 852)
  static let pad = CGSize(width: 834, height: 1194)

  // MARK: - Transkrypt nie skacze

  /// Przypięty długi transkrypt: karta wchodzi i schodzi, lista stoi na dnie w pierwszej klatce po renderze
  /// i po ustabilizowaniu.
  func testPinnedTranscriptStaysAtBottomWhenCardEntersAndLeaves() throws {
    for size in [Self.phone, Self.pad] {
      let fixture = try Self.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie przed kartą")

      try Self.permission(fixture, "p1")
      Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertTrue(controller.composer.isHidden, "\(size): pole schowane")
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie w pierwszej klatce z kartą")
      Self.spin(0.3)
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie po ustabilizowaniu")

      try Self.resolve(fixture, "p1")
      Self.waitRender(fixture) { $0.decisionSlot.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertFalse(controller.composer.isHidden, "\(size): pole wraca")
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie w pierwszej klatce bez karty")
      Self.spin(0.3)
      fixture.window.layoutIfNeeded()
      XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "\(size): na dnie po zejściu karty")
      XCTAssertLessThanOrEqual(
        controller.readingChrome.counters.maxSettleTurns, SessionViewController.settleTurns, "\(size): wspólny limit")
    }
  }

  /// Odpięty transkrypt: górny widoczny wiersz nie rusza się przy wejściu i zejściu karty.
  func testUnpinnedTopRowHoldsWhenCardEntersAndLeaves() throws {
    for size in [Self.phone, Self.pad] {
      let fixture = try Self.make(size: size, messages: 40)
      defer { fixture.window.isHidden = true }
      let controller = fixture.controller
      let list = controller.collectionView!
      list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 900), animated: false)
      controller.pinned = false
      fixture.window.layoutIfNeeded()
      let (row, top) = try XCTUnwrap(Self.topRow(controller), "\(size): górny wiersz")

      try Self.permission(fixture, "p1")
      Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertEqual(try XCTUnwrap(Self.screenY(controller, row)), top, accuracy: 0.5, "\(size): wiersz z kartą")
      try Self.resolve(fixture, "p1")
      Self.waitRender(fixture) { $0.decisionSlot.isHidden }
      fixture.window.layoutIfNeeded()
      XCTAssertEqual(try XCTUnwrap(Self.screenY(controller, row)), top, accuracy: 0.5, "\(size): wiersz po karcie")
      XCTAssertFalse(controller.pinned, "\(size): przypięcie zmienia tylko gest")
    }
  }

  /// Krótki transkrypt (jedna wiadomość): dół karty w doku stoi tam, gdzie stał dół pola.
  func testCardBottomStandsWhereComposerBottomStood() throws {
    for size in [Self.phone, Self.pad] {
      let fixture = try Self.make(size: size, messages: 1)
      defer { fixture.window.isHidden = true }
      let field = try XCTUnwrap(Self.fieldFrame(fixture.controller))
      try Self.permission(fixture, "p1")
      Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
      fixture.window.layoutIfNeeded()
      let card = try XCTUnwrap(Self.dockCardFrame(fixture.controller))
      // Karta ma 8 pt marginesu pod powierzchnią (`DecisionDockSlot.cardVerticalMargin`).
      let surfaceBottom = card.maxY - DecisionDockSlot.cardVerticalMargin
      XCTAssertEqual(surfaceBottom, field.maxY, accuracy: 0.5, "\(size): dół karty = dół pola \(field), karta \(card)")
      XCTAssertEqual(card.minX, 0, accuracy: 0.5, "\(size): ramka karty przez całą szerokość stopy, karta 16 pt od krawędzi")
    }
  }

  /// Wysoka karta: plan z 20 liniami i karta kanału z długimi polami przy największym piśmie. Dok przekazuje sufit
  /// (`decisionDockCeiling`) i sam nie jest wyższy niż sufit plus nagłówek „1 z N”. To, że nagłówek i przyciski karty
  /// mieszczą się pod sufitem, sprawdzi test po scaleniu z układem zwartym kart.
  func testTallCardStaysUnderCeiling() throws {
    for size in [Self.phone, Self.pad] {
      let fixture = try Self.make(size: size, messages: 3)
      defer { fixture.window.isHidden = true }
      fixture.controller.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge
      let plan = (1...20).map { "\($0). Krok planu z dłuższym opisem, który na telefonie zawija się w dwie linie." }
        .joined(separator: "\\n")
      try Self.permission(fixture, "plan", extra: #""subject":"plan","displayText":"\#(plan)""#)
      let fields = (1...12).map { #"{"name":"pole_\#($0)","value":"\#(String(repeating: "długa wartość ", count: 12))"}"# }
        .joined(separator: ",")
      try Self.permission(fixture, "k1", extra: #""channel":"\#(PermissionChannel.hook.rawValue)","state":"pending","fields":[\#(fields)]"#)
      Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
      for _ in 0..<3 {
        fixture.window.layoutIfNeeded()
        Self.spin(0.05)
      }
      let controller = fixture.controller
      let view = try XCTUnwrap(controller.view)
      let expected = CGFloat(DecisionDock.ceiling(
        screenHeight: Double(view.bounds.height), aboveKeyboard: Double(view.bounds.height - view.safeAreaInsets.top)))
      XCTAssertEqual(controller.dockCeiling, expected, accuracy: 0.5, "\(size): sufit z geometrii ekranu")
      let card = try XCTUnwrap(Self.dockCardFrame(controller))
      XCTAssertLessThanOrEqual(card.height, expected + 0.5, "\(size): karta w ramce doku nie wyższa niż sufit")
      let slot = controller.decisionSlot.convert(controller.decisionSlot.bounds, to: nil)
      let position = try XCTUnwrap(Self.label(in: controller.decisionSlot, id: "dock.position"))
      XCTAssertEqual(position.text, "1 z 2", "\(size): nagłówek kolejki")
      let header = position.convert(position.bounds, to: nil).maxY - slot.minY
      XCTAssertLessThanOrEqual(slot.height, expected + header + ComposerView.bottomInset + 0.5, "\(size): dok \(slot)")
      Self.attach("dok \(size): sufit \(expected), karta \(card.height), dok \(slot.height)")
      Self.snapshot(controller, name: "dok-wysoka-karta-\(Int(size.width))")
    }
  }

  // MARK: - Pole, szkic, kolejka

  /// Szkic „abc” i załącznik przeżywają kartę: po decyzji pole wraca z tekstem i załącznikiem, a bez klawiatury
  /// sprzętowej nie podnosi klawiatury (pole nie jest pierwszym responderem).
  func testDraftAndAttachmentComeBackAfterDecision() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
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

    try Self.permission(fixture, "p1")
    Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
    XCTAssertTrue(composer.isHidden)
    XCTAssertFalse(composer.textView.isFirstResponder)
    try Self.resolve(fixture, "p1")
    Self.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertEqual(composer.text, "abc", "szkic wraca")
    XCTAssertEqual(composer.attachments.map(\.id), [attachment.id], "załącznik wraca")
    XCTAssertTrue(composer.isEditable)
    XCTAssertFalse(composer.textView.isFirstResponder, "bez klawiatury sprzętowej klawiatura nie wraca sama")
  }

  /// Wejście do sesji, która czeka, przed pierwszą migawką transkryptu: pole nie pojawia się w żadnej klatce.
  func testWaitingSessionBeforeSnapshotNeverShowsComposer() throws {
    let store = try Self.makeStore(messages: 0, state: "waiting-permission", snapshot: false)
    let fixture = Self.host(store, size: Self.phone)
    defer { fixture.window.isHidden = true }
    XCTAssertTrue(fixture.controller.composer.isHidden, "pole schowane od pierwszego renderu")
    try Self.frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(Self.messages(2))],
       "pendingPermissions":[\#(Self.request("p1"))],"pendingQuestions":[]}
      """#, source: .session("s1"))
    Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
    XCTAssertFalse(fixture.controller.footFrames.isEmpty)
    XCTAssertFalse(fixture.controller.footFrames.contains { $0.composer }, "pole w żadnej klatce: \(fixture.controller.footFrames)")
    XCTAssertTrue(fixture.controller.footFrames.last?.dock == true)
  }

  /// Karta zgody i zmiana stanu sesji w dwóch renderach, w obu kolejnościach: żadnej klatki z polem i kartą naraz.
  func testCardAndStateChangeInTwoRendersNeverShowBoth() throws {
    for cardFirst in [true, false] {
      let fixture = try Self.make(size: Self.phone, messages: 3, state: "running")
      defer { fixture.window.isHidden = true }
      if cardFirst {
        try Self.permission(fixture, "p1", state: nil)
        Self.waitRender(fixture) { $0.store.state.transcripts["s1"]?.pendingPermissions.isEmpty == false }
        try Self.session(fixture, state: "waiting-permission")
      } else {
        try Self.session(fixture, state: "waiting-permission")
        Self.waitRender(fixture) { $0.store.state.sessions["s1"]?.state == .waitingPermission }
        try Self.permission(fixture, "p1", state: nil)
      }
      Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
      let frames = fixture.controller.footFrames
      XCTAssertFalse(frames.contains { $0.composer && $0.dock }, "karta pierwsza: \(cardFirst), klatki: \(frames)")
    }
  }

  /// Dwie zgody w kolejce: dok „1 z 2”, po pierwszej decyzji druga karta (bez nagłówka), potem pole.
  func testQueueShowsPositionThenNextCardThenComposer() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.permission(fixture, "p1")
    try Self.permission(fixture, "p2", state: nil)
    Self.waitRender(fixture) { $0.dockModel?.total == 2 }
    XCTAssertEqual(controller.dockModel?.row.id, "pp1")
    XCTAssertEqual(Self.label(in: controller.decisionSlot, id: "dock.position")?.text, "1 z 2")
    XCTAssertFalse(controller.rows.keys.contains("pp1"), "karta w doku nie jest wierszem transkryptu")
    XCTAssertTrue(controller.rows.keys.contains("pp2"), "druga karta czeka w transkrypcie")
    Self.snapshot(controller, name: "dok-kolejka-iphone")

    try Self.resolve(fixture, "p1", waiting: true)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "pp2" }
    XCTAssertEqual(controller.dockModel?.total, 1)
    XCTAssertTrue(Self.label(in: controller.decisionSlot, id: "dock.position")?.isHidden ?? true, "bez kolejki bez nagłówka")
    XCTAssertTrue(controller.composer.isHidden)

    try Self.resolve(fixture, "p2")
    Self.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertTrue(controller.decisionSlot.isHidden)
  }

  /// Karta „dialog w terminalu” też staje w doku, a transkrypt jej nie ma. Przez okres łaski w doku stoi zastępnik.
  func testHerdrDialogCardStandsInDock() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    try Self.session(fixture, state: "waiting-permission")
    let entered = Date()
    Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
    XCTAssertEqual(fixture.controller.dockModel?.row, .decisionPending, "w okresie łaski zastępnik w doku")
    Self.spin(max(0, entered.addingTimeInterval(DecisionGraceTiming.window).timeIntervalSinceNow))
    Self.waitRender(fixture) { $0.dockModel?.row.id == "dialog" }
    XCTAssertEqual(fixture.controller.dockModel?.row.id, "dialog")
    XCTAssertFalse(fixture.controller.rows.keys.contains("dialog"))
    XCTAssertTrue(fixture.controller.composer.isHidden)
  }

  /// Przygaszenie przy karcie w doku zostaje, ale kółko „na dół” nazywa się „Przewiń na dół”, nie „Przewiń do decyzji”,
  /// i nie bierze koloru czekania.
  func testDimmedTranscriptWithBottomJumpLabel() throws {
    let fixture = try Self.make(size: Self.phone, messages: 40)
    defer { fixture.window.isHidden = true }
    try Self.permission(fixture, "p1")
    Self.waitRender(fixture) { !$0.decisionSlot.isHidden }
    XCTAssertTrue(fixture.controller.readingChrome.dimmed, "transkrypt przygaszony")
    XCTAssertEqual(fixture.controller.readingChrome.jumpBar.accessibilityLabel, UICopy.jumpLabel(decision: false))
    XCTAssertFalse(fixture.controller.readingChrome.jumpBar.decision)
  }

  // MARK: - Karta pytania w doku

  /// Formularz trzech pytań na iPhonie: karta w doku zamiast pola, nie wyższa niż sufit; nagłówek u góry i „Odpowiedz”
  /// u dołu w ramce doku, sekcje przewijają się wewnątrz karty. Karty nie ma w transkrypcie.
  func testQuestionFormStandsInDockWithHeaderAndSubmitInFrame() throws {
    let fixture = try Self.make(size: Self.phone, messages: 6)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.form)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form" }
    for _ in 0..<3 {
      fixture.window.layoutIfNeeded()
      Self.spin(0.1)
    }
    XCTAssertTrue(controller.composer.isHidden, "pole schowane")
    XCTAssertFalse(controller.decisionSlot.isHidden, "dok widoczny")
    XCTAssertNil(controller.rows["qdock-form"], "karta pytania w doku nie jest wierszem transkryptu")
    let card = try XCTUnwrap(Self.dockCardFrame(controller))
    XCTAssertLessThanOrEqual(card.height, controller.dockCeiling + 0.5, "karta pod sufitem: \(card)")
    XCTAssertGreaterThan(card.height, controller.dockCeiling - 60, "formularz wypełnia sufit: \(card)")

    let bitmap = try XCTUnwrap(Self.bitmap(controller))
    let outer = DecisionDockSlot.cardVerticalMargin
    let top = CGRect(x: card.minX + 16, y: card.minY + outer, width: card.width - 32, height: 30)
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.wait.dark, in: top), "nagłówek u góry karty w doku")
    let bottom = CGRect(x: card.minX + 16, y: card.maxY - outer - 70, width: card.width - 32, height: 70)
    let submit = try XCTUnwrap(bitmap.box(of: PaletteTokens.text.dark, in: bottom, tolerance: 2), "„Odpowiedz” w doku")
    XCTAssertGreaterThanOrEqual(submit.height, 30, "wypełniony przycisk, nie litery: \(submit)")
    XCTAssertLessThanOrEqual(submit.maxY, card.maxY - outer + 0.5, "przycisk w ramce karty: \(submit), karta \(card)")

    let scrolls = Self.views(of: UIScrollView.self, in: controller.decisionSlot)
    XCTAssertTrue(
      scrolls.contains { $0.contentSize.height > $0.bounds.height + 1 },
      "sekcje przewijane w karcie: \(scrolls.map { ($0.bounds.height, $0.contentSize.height) })")
    Self.snapshot(controller, name: "dok-formularz-iphone")
  }

  /// Jedno pytanie w doku: karta zamiast pola; cyfra wybiera opcję karty w doku (karta `instant` wysyła od razu).
  func testDigitKeyPicksOptionOnDockedQuestion() throws {
    let fixture = try Self.make(size: Self.phone, messages: 6)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.short)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-short" }
    Self.snapshot(controller, name: "dok-pytanie-iphone")
    let digit = try XCTUnwrap(controller.answerKeyCommands.first { $0.input == "2" }, "cyfry karty w doku")
    _ = controller.perform(try XCTUnwrap(digit.action), with: digit)
    XCTAssertNotNil(controller.ui.questions.flights["dock-short"], "cyfra 2 wysłała odpowiedź z karty w doku")
    XCTAssertEqual(controller.ui.questions.flights["dock-short"]?.answered.answers, [["Nie"]])
  }

  /// Formularz w doku: cyfra zaznacza opcję pierwszego pytania, Enter bez kompletu odpowiedzi daje zdanie pod kartą.
  func testDigitAndEnterReachDockedForm() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.form)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form" }
    let commands = controller.answerKeyCommands
    let digit = try XCTUnwrap(commands.first { $0.input == "1" }, "cyfry karty w doku")
    _ = controller.perform(try XCTUnwrap(digit.action), with: digit)
    let draft = controller.ui.questions.drafts.draft("dock-form", sections: 3)
    XCTAssertEqual(draft.picks.first, ["shared/fixtures/sse"], "cyfra 1 zaznaczyła pierwszą opcję")
    // Przytrzymanie to nie druga decyzja: następny klawisz po oknie powtórzeń.
    Self.spin(QuestionKeyRepeat.window + 0.1)
    let enter = try XCTUnwrap(commands.first { $0.input == "\r" }, "Enter karty w doku")
    _ = controller.perform(try XCTUnwrap(enter.action), with: enter)
    XCTAssertNotNil(controller.ui.questions.errors["dock-form"], "Enter bez kompletu: zdanie pod kartą w doku")
    XCTAssertNil(controller.ui.questions.flights["dock-form"])
  }

  /// Trzymane potwierdzenie bez następcy: odpowiedź przyjęta, pytanie zdjęte, sesja pracuje — dok stoi
  /// z potwierdzeniem przez okno 6 s, potem wraca pole.
  func testHeldConfirmationWithoutSuccessorStandsInDockThenComposer() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.short)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-short" }
    try Self.answerAccepted(fixture, qId: "dock-short", answers: [["Tak"]])
    try Self.frame(fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-short"}"#, source: .session("s1"))
    try Self.session(fixture, state: "running")
    let gone = Date()
    Self.waitRender(fixture) {
      if case let .question(card)? = $0.dockModel?.row { return card.held }
      return false
    }
    guard case let .question(held)? = controller.dockModel?.row else { return XCTFail("potwierdzenie w doku") }
    XCTAssertTrue(held.held, "w doku trzymane potwierdzenie")
    XCTAssertTrue(controller.composer.isHidden, "pole schowane pod potwierdzeniem")
    XCTAssertNil(controller.rows["qdock-short"], "potwierdzenia nie ma w transkrypcie")
    Self.spin(max(0, gone.addingTimeInterval(QuestionTiming.sentGap - 1).timeIntervalSinceNow))
    XCTAssertEqual(controller.dockModel?.row.id, "qdock-short", "potwierdzenie stoi prawie całe okno")
    Self.spin(max(0, gone.addingTimeInterval(QuestionTiming.sentGap + 0.5).timeIntervalSinceNow))
    Self.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertTrue(controller.decisionSlot.isHidden, "po oknie dok schowany, pole wraca")
    XCTAssertFalse(controller.footFrames.contains { $0.composer && $0.dock }, "\(controller.footFrames)")
  }

  /// Trzymane potwierdzenie z następcą: najpierw dok z potwierdzeniem, a gdy przychodzi następne pytanie — dok
  /// pokazuje nowe pytanie, potwierdzenie stoi jeszcze 1,5 s w transkrypcie i znika.
  func testHeldConfirmationGivesWayToNextQuestion() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.short)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-short" }
    let framesBefore = controller.footFrames.count
    try Self.answerAccepted(fixture, qId: "dock-short", answers: [["Tak"]])
    try Self.frame(fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-short"}"#, source: .session("s1"))
    Self.waitRender(fixture) {
      if case let .question(card)? = $0.dockModel?.row { return card.held }
      return false
    }
    XCTAssertTrue(controller.composer.isHidden)

    try Self.question(fixture, Self.form)
    let arrived = Date()
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form" }
    XCTAssertEqual(controller.dockModel?.total, 2, "nowe pytanie i potwierdzenie w kolejce")
    XCTAssertNotNil(controller.rows["qdock-short"], "potwierdzenie ustąpiło nowej karcie, stoi w transkrypcie")
    Self.spin(max(0, arrived.addingTimeInterval(QuestionTiming.sentHold + 0.5).timeIntervalSinceNow))
    Self.waitRender(fixture) { $0.rows["qdock-short"] == nil }
    XCTAssertEqual(controller.dockModel?.row.id, "qdock-form", "w doku następna karta")
    XCTAssertEqual(controller.dockModel?.total, 1)
    // Klatki od pierwszej karty w doku: wcześniej (sesja pracowała) pole stało.
    let frames = Array(controller.footFrames.suffix(from: min(framesBefore, controller.footFrames.count)))
    XCTAssertFalse(frames.isEmpty)
    XCTAssertFalse(frames.contains { $0.composer }, "pole w żadnej klatce: \(frames)")
  }

  /// „Własna odpowiedź” w karcie w doku: pole (ten sam widok) i wpisany tekst przetrwają trzy kolejne rendery (nowa
  /// wiadomość, przebudowa hosta doku, zmiana stanu sesji); tekst idzie do szkicu karty przez akcję ekranu. Fokus
  /// test daje polu wprost (`becomeFirstResponder`), z pominięciem `@FocusState` karty — to, czy fokus zostaje, zależało
  /// tu od chwili, w której SwiftUI dogania stan fokusu (zmierzone: 3 z 4 przebiegów gubiło go po pierwszym renderze,
  /// także bez przebudowy hosta doku). Test pilnuje więc tożsamości widoku pola, od której fokus zależy; samo
  /// utrzymanie fokusu po dotknięciu pola sprawdza się ręcznie.
  func testCustomAnswerFieldAndDraftSurviveRenders() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    fixture.window.makeKeyAndVisible()
    let controller = fixture.controller
    try Self.question(fixture, Self.form)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form" }
    controller.ui.questions.drafts.update("dock-form", sections: 3) { $0.openCustom(in: 0) }
    var field: UITextView?
    for _ in 0..<100 where field == nil {
      Self.spin(0.02)
      field = Self.views(of: UITextView.self, in: controller.decisionSlot).first
    }
    let text = try XCTUnwrap(field, "pole „Własna odpowiedź” w doku")
    XCTAssertTrue(text.becomeFirstResponder(), "fokus w polu")
    text.insertText("abc")
    Self.spin(0.2)
    XCTAssertEqual(controller.ui.questions.drafts.draft("dock-form", sections: 3).customText(in: 0), "abc", "szkic karty")

    let renders = controller.readingChrome.counters.renders
    for round in 1...3 {
      switch round {
      case 1:
        try Self.frame(fixture.store, #"""
          {"type":"message","sessionId":"s1","message":{"seq":50,"role":"assistant","at":"2026-10-06T10:00:00.000Z",
           "blocks":[{"type":"text","text":"Nowa wiadomość w trakcie pisania."}]}}
          """#, source: .session("s1"))
      case 2:
        // Przebudowa hosta doku (nowy `rootView`), jak przy zmianie sufitu albo modelu karty.
        controller.renderedDock = nil
        controller.scheduleRender()
      default:
        controller.renderedDock = nil
        try Self.session(fixture, state: "waiting-question")
      }
      let before = controller.readingChrome.counters.renders
      Self.waitRender(fixture) { $0.readingChrome.counters.renders > before }
      Self.spin(0.15)
      let current = try XCTUnwrap(
        Self.views(of: UITextView.self, in: controller.decisionSlot).first, "render \(round): pole w doku")
      XCTAssertTrue(current === text, "render \(round): ten sam widok pola (fokus i kursor mają gdzie zostać)")
      XCTAssertEqual(current.text, "abc", "render \(round): tekst zostaje")
    }
    XCTAssertGreaterThanOrEqual(controller.readingChrome.counters.renders, renders + 3)
    XCTAssertEqual(controller.ui.questions.drafts.draft("dock-form", sections: 3).customText(in: 0), "abc")
    text.resignFirstResponder()
  }

  /// Przewinięcie należy do karty, nie do doku: formularz A przewinięty do końca zostaje przewinięty po przebudowie
  /// hosta doku (ten sam adres karty), a następny formularz B (inny `qId`) staje od góry — cyfry kierują do jego
  /// pierwszej sekcji, więc ona ma być widoczna.
  func testNextCardStartsAtTopAndSameCardKeepsScroll() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.question(fixture, Self.form)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form" }
    let first = try Self.scrolledSections(fixture)
    let bottom = first.contentSize.height - first.bounds.height
    XCTAssertGreaterThan(bottom, 100, "sekcje formularza A dłuższe od środka karty — inaczej test nic nie mówi")
    first.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
    fixture.window.layoutIfNeeded()
    Self.spin(0.1)

    // Ta sama karta, przebudowa hosta doku (jak przy zmianie sufitu albo modelu karty): przewinięcie zostaje.
    let renders = controller.readingChrome.counters.renders
    controller.renderedDock = nil
    controller.scheduleRender()
    Self.waitRender(fixture) { $0.readingChrome.counters.renders > renders }
    Self.spin(0.15)
    let same = try Self.scrolledSections(fixture)
    XCTAssertEqual(same.contentOffset.y, bottom, accuracy: 1, "ta sama karta: przewinięcie zostaje")

    // Formularz A zdjęty, przychodzi formularz B: staje od góry.
    try Self.frame(
      fixture.store, #"{"type":"question-resolved","sessionId":"s1","qId":"dock-form"}"#, source: .session("s1"))
    try Self.question(fixture, Self.form.replacing(#""qId":"dock-form""#, with: #""qId":"dock-form-b""#))
    Self.waitRender(fixture) { $0.dockModel?.row.id == "qdock-form-b" }
    Self.spin(0.15)
    let next = try Self.scrolledSections(fixture)
    XCTAssertEqual(
      next.contentOffset.y, -next.adjustedContentInset.top, accuracy: 1,
      "formularz B od góry, nie od przewinięcia A: \(next.contentOffset)")
  }

  /// Przewijany środek karty pytania w doku: przewijany widok z treścią dłuższą niż okno.
  static func scrolledSections(_ fixture: Fixture) throws -> UIScrollView {
    for _ in 0..<3 {
      fixture.window.layoutIfNeeded()
      spin(0.1)
    }
    let scrolls = views(of: UIScrollView.self, in: fixture.controller.decisionSlot)
    return try XCTUnwrap(
      scrolls.first { $0.contentSize.height > $0.bounds.height + 100 },
      "sekcje przewijane w karcie: \(scrolls.map { ($0.bounds.height, $0.contentSize.height) })")
  }

  /// Okres łaski z dokiem: sesja weszła w „czeka”, karty jeszcze nie ma — w doku zastępnik zamiast pola, w transkrypcie
  /// go nie ma. Karta, która przychodzi, staje w miejscu zastępnika bez klatki z polem pomiędzy.
  func testGracePlaceholderInDockGivesWayToCardWithoutComposerFrame() throws {
    let fixture = try Self.make(size: Self.phone, messages: 6, state: "running")
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    XCTAssertFalse(controller.composer.isHidden)
    let framesBefore = controller.footFrames.count
    let since = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
    try Self.frame(
      fixture.store, #"{"type":"state","sessionId":"s1","state":"waiting-permission","since":"\#(since)"}"#,
      source: .global)
    Self.waitRender(fixture) { $0.dockModel?.row == .decisionPending }
    XCTAssertTrue(controller.composer.isHidden, "pole schowane pod zastępnikiem")
    XCTAssertFalse(controller.decisionSlot.isHidden, "zastępnik w doku")
    XCTAssertNil(controller.rows["decisionPending"], "zastępnika nie ma w transkrypcie")
    XCTAssertFalse(controller.decisionSlot.hasCard, "zastępnik nie przyjmuje fokusu klawiatury")
    let pending = try XCTUnwrap(Self.dockCardFrame(controller))
    Self.snapshot(controller, name: "dok-zastepnik-iphone")

    try Self.permission(fixture, "p1", state: nil)
    Self.waitRender(fixture) { $0.dockModel?.row.id == "pp1" }
    XCTAssertTrue(controller.composer.isHidden)
    let frames = controller.footFrames.suffix(from: min(framesBefore + 1, controller.footFrames.count))
    XCTAssertFalse(frames.contains { $0.composer }, "pole w żadnej klatce od zastępnika do karty: \(Array(frames))")
    XCTAssertTrue(frames.allSatisfy(\.dock), "dok w każdej klatce: \(Array(frames))")
    let card = try XCTUnwrap(Self.dockCardFrame(controller))
    XCTAssertEqual(card.maxY, pending.maxY, accuracy: 0.5, "karta stoi dołem tam, gdzie zastępnik")
  }

  // MARK: - VoiceOver

  /// Fokus czytnika w polu, karta staje w doku: czytnik przechodzi na nagłówek doku; karta zastana przy wejściu do
  /// sesji jest ogłoszona raz.
  func testVoiceOverMovesToDockAndFoundCardIsAnnouncedOnce() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    var posts: [(UIAccessibility.Notification, Any?)] = []
    controller.accessibilityPost = { posts.append(($0, $1)) }
    controller.voiceOverFocusedElement = { [weak controller] in controller?.composer.textView }
    try Self.permission(fixture, "p1")
    try Self.permission(fixture, "p2", state: nil)
    Self.waitRender(fixture) { $0.dockModel?.total == 2 }
    let layout = posts.filter { $0.0 == .layoutChanged }
    XCTAssertEqual(layout.count, 1, "jedno przeniesienie fokusu")
    let target = try XCTUnwrap(layout.first?.1 as? UILabel)
    XCTAssertEqual(target.accessibilityIdentifier, "dock.position", "fokus na nagłówku doku")

    // Wejście do sesji z kartą zastaną w doku: jedno zdanie o niej.
    let said = Said()
    let store = try Self.makeStore(messages: 3, state: "waiting-permission", permissions: ["p9"])
    let entered = SessionViewController(
      store: store, sessionId: "s1", drafts: ComposerDrafts(), announcer: Announcer(sink: { said.items.append($0) }, now: Date.init))
    entered.decisionMode = .dock
    let window = UIWindow(frame: CGRect(origin: .zero, size: Self.phone))
    window.rootViewController = entered
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    window.layoutIfNeeded()
    Self.spin(0.2)
    entered.scheduleRender()
    Self.spin(0.2)
    guard case let .permission(card)? = entered.dockModel?.row else { return XCTFail("karta zgody w doku") }
    let spoken = UICopy.newDecisionSpoken(card.spokenHeader)
    XCTAssertEqual(said.items.filter { $0.text == spoken }.count, 1, "karta zastana ogłoszona raz: \(said.items)")
  }

  /// Fokus czytnika na przycisku karty w doku to fokus na karcie (`focusedCardRow`), więc po decyzji ratunek fokusu
  /// ma czego szukać i zeruje wiersz. Przed poprawką element spoza komórki transkryptu zerował wiersz od razu.
  func testVoiceOverFocusOnDockedCardIsTrackedAndRescued() throws {
    let fixture = try Self.make(size: Self.phone, messages: 3)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    try Self.permission(fixture, "p1")
    Self.waitRender(fixture) { $0.dockModel?.row.id == "pp1" }
    controller.trackVoiceOverCardFocus()
    let element = try XCTUnwrap(
      Self.descendants(of: controller.decisionSlot).first { $0.isAccessibilityElement || $0 is UILabel },
      "element dostępności w doku")
    NotificationCenter.default.post(
      name: UIAccessibility.elementFocusedNotification, object: nil,
      userInfo: [UIAccessibility.focusedElementUserInfoKey: element])
    XCTAssertEqual(controller.focusedCardRow, "pp1", "fokus czytnika na karcie w doku")

    try Self.resolve(fixture, "p1")
    Self.waitRender(fixture) { !$0.composer.isHidden }
    XCTAssertNil(controller.focusedCardRow, "ratunek fokusu po zniknięciu karty z doku")
  }

  static func descendants(of view: UIView) -> [UIView] {
    view.subviews.flatMap { [$0] + descendants(of: $0) }
  }

  // MARK: - Zrzuty

  /// Zrzuty do odbioru: iPhone z kartą zgody w doku, iPad z kartą planu.
  func testScreenshots() throws {
    let phone = try Self.make(size: Self.phone, messages: 6)
    defer { phone.window.isHidden = true }
    try Self.permission(phone, "p1", extra: #""displayText":"npm test -- --run server/test/native-copy-guard.test.ts""#)
    Self.waitRender(phone) { !$0.decisionSlot.isHidden }
    Self.snapshot(phone.controller, name: "dok-zgoda-iphone")

    let pad = try Self.make(size: Self.pad, messages: 6)
    defer { pad.window.isHidden = true }
    let plan = (1...8).map { "\($0). Krok planu: dopisać testy doku i przejrzeć zrzuty." }.joined(separator: "\\n")
    try Self.permission(pad, "plan", extra: #""subject":"plan","displayText":"\#(plan)","alwaysLabel":"Yes, and auto-accept""#)
    Self.waitRender(pad) { !$0.decisionSlot.isHidden }
    Self.snapshot(pad.controller, name: "dok-plan-ipad")
  }

  // MARK: - Pomocnicze

  final class Said {
    var items: [Announcer.Announcement] = []
  }

  struct Fixture {
    let controller: SessionViewController
    let store: RarogStore
    let window: UIWindow
  }

  static func make(size: CGSize, messages: Int, state: String = "waiting-input") throws -> Fixture {
    host(try makeStore(messages: messages, state: state), size: size)
  }

  static func host(_ store: RarogStore, size: CGSize) -> Fixture {
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.decisionMode = .dock
    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    window.layoutIfNeeded()
    spin(0.1)
    window.layoutIfNeeded()
    return Fixture(controller: controller, store: store, window: window)
  }

  static func makeStore(
    messages: Int, state: String, snapshot: Bool = true, permissions: [String] = []
  ) throws -> RarogStore {
    let store = RarogStore.live(
      config: RarogConfig(baseURL: URL(string: "http://127.0.0.1:9")!, clientLabel: "test·Rarog", build: 1),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session(state: state, since: 0))]}"#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    guard snapshot else { return store }
    let pending = permissions.map { request($0) }.joined(separator: ",")
    try frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(Self.messages(messages))],
       "pendingPermissions":[\#(pending)],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }

  /// Sesja `s1`; `since` = sekundy po 10:00 dnia próbki. Kolejne zmiany stanu idą naprzód w czasie: reduktor odrzuca
  /// zmianę starszą od znanej, więc licznik nie może się zawinąć (przy `% 60` zawijał się po 60 zmianach w procesie
  /// testów i „running” po zawinięciu nie zdejmował czekania).
  static func session(state: String, since: Int) -> String {
    let time = String(format: "%02d:%02d:%02d", 10 + since / 3600, since / 60 % 60, since % 60)
    return #"""
      {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"\#(state)",
       "stateSince":"2026-10-06T\#(time).000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
  }

  static func messages(_ count: Int) -> String {
    (0..<count).map { index in
      let seq = index + 1
      let text = "Odpowiedź \(seq).\\n\\nDrugi akapit odpowiedzi, dość długi, żeby zawinął się na wąskim ekranie i dał komórce kilka linii."
      return #"{"seq":\#(seq),"role":"assistant","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"\#(text)"}]}"#
    }.joined(separator: ",")
  }

  static func request(_ permId: String, extra: String? = nil) -> String {
    let base = #"""
      "permId":"\#(permId)","sessionId":"s1","toolName":"Write","displayText":"npm test","risk":"normal",
      "cwd":"/Users/demo/project","createdAt":"2026-10-06T10:00:00.000Z","canAllow":true
      """#
    guard let extra else { return "{\(base)}" }
    // Pola z `extra` wygrywają: dekoder bierze ostatnie wystąpienie klucza.
    return "{\(base),\(extra)}"
  }

  private static var stateSerial = 1

  /// Karta zgody; `state` = stan sesji, który przychodzi razem z nią (`nil` = bez zmiany).
  static func permission(_ fixture: Fixture, _ permId: String, extra: String? = nil, state: String? = "waiting-permission") throws {
    if let state, fixture.store.state.sessions["s1"]?.state.rawValue != state { try session(fixture, state: state) }
    try frame(fixture.store, #"{"type":"permission-pending","request":\#(request(permId, extra: extra))}"#, source: .session("s1"))
  }

  /// Karta rozstrzygnięta; `waiting` = sesja dalej czeka (kolejna karta), inaczej wraca do pracy.
  static func resolve(_ fixture: Fixture, _ permId: String, waiting: Bool = false) throws {
    try frame(fixture.store, #"""
      {"type":"permission-resolved","sessionId":"s1","permId":"\#(permId)","decision":"allow","by":"test"}
      """#, source: .session("s1"))
    if !waiting { try session(fixture, state: "running") }
  }

  static func session(_ fixture: Fixture, state: String) throws {
    stateSerial += 1
    try frame(fixture.store, #"{"type":"session-changed","session":\#(session(state: state, since: stateSerial))}"#,
              source: .global)
  }

  /// Formularz trzech pytań po cztery opcje z opisami i „Własną odpowiedzią” (jak `QuestionDockLayoutTests.form`).
  static let form = #"""
    {"qId":"dock-form","sessionId":"s1","createdAt":"2026-10-06T10:00:00.000Z","customAnswer":true,
     "questions":[
      {"question":"Gdzie trzymamy ramki testowe?","header":"Fixtures","multiSelect":false,"options":[
        {"label":"shared/fixtures/sse","description":"Wspólne dla serwera i apki."},
        {"label":"server/test/fixtures","description":"Tylko serwer."},
        {"label":"native/Rarog/Fixtures","description":"Tylko apka."},
        {"label":"Osobne repo","description":"Pakiet z ramkami."}]},
      {"question":"Które klienty mają je czytać?","header":"Klienci","multiSelect":true,"options":[
        {"label":"PWA","description":"Przeglądarka."},
        {"label":"Swift","description":"Apka natywna."},
        {"label":"CLI","description":"Komenda rarog."},
        {"label":"Przekaźnik","description":"Worker w chmurze."}]},
      {"question":"Kiedy odświeżamy ramki?","header":"Rytm","multiSelect":false,"options":[
        {"label":"Przy każdej zmianie","description":"Strażnik w bramce."},
        {"label":"Raz w tygodniu","description":"Ręcznie."},
        {"label":"Przed wydaniem","description":"Lista kontrolna."},
        {"label":"Nigdy","description":"Ramki zamrożone."}]}]}
    """#

  /// Jedno krótkie pytanie z dwiema opcjami (karta `instant`: tapnięcie albo cyfra wysyła).
  static let short = #"""
    {"qId":"dock-short","sessionId":"s1","createdAt":"2026-10-06T10:00:00.000Z",
     "questions":[{"question":"Puszczamy testy?","header":"Testy","multiSelect":false,"options":[
       {"label":"Tak"},{"label":"Nie"}]}]}
    """#

  /// Karta pytania; sesja przechodzi w „czeka na odpowiedź”, gdy jeszcze w nim nie jest.
  static func question(_ fixture: Fixture, _ request: String) throws {
    if fixture.store.state.sessions["s1"]?.state != .waitingQuestion { try session(fixture, state: "waiting-question") }
    let compact = request.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.joined()
    try frame(fixture.store, #"{"type":"question-pending","request":\#(compact)}"#, source: .session("s1"))
  }

  /// Odpowiedź z tego ekranu przyjęta przez serwer (bez sieci: stan ekranu jak po 200).
  static func answerAccepted(_ fixture: Fixture, qId: String, answers: [[String]]) throws {
    let controller = fixture.controller
    guard case let .question(card)? = controller.dockModel?.row, card.qId == qId else {
      return XCTFail("karta \(qId) w doku")
    }
    controller.ui.questions.begin(card, answers: answers)
    controller.ui.questions.finish(qId, .accepted)
    controller.scheduleRender()
    waitRender(fixture) {
      if case let .question(card)? = $0.dockModel?.row, case .sent = card.phase { return true }
      return false
    }
  }

  static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }

  /// Bitmapa okna kontrolera (jak `snapshot`), do szukania kolorów tokenów.
  static func bitmap(_ controller: SessionViewController) -> PendingMediaRowTests.Bitmap? {
    controller.view.window?.layoutIfNeeded()
    spin(0.2)
    let view = controller.view.window ?? controller.view!
    let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
    var image = renderer.image { context in view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
    }
    return PendingMediaRowTests.Bitmap(image)
  }

  static func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: source, cursor: nil))
  }

  /// Czeka na render, po którym warunek jest spełniony (render planuje zmiana magazynu, najwyżej co 60 ms).
  static func waitRender(
    _ fixture: Fixture, file: StaticString = #filePath, line: UInt = #line, _ done: (SessionViewController) -> Bool
  ) {
    for _ in 0..<200 where !done(fixture.controller) { spin(0.01) }
    XCTAssertTrue(done(fixture.controller), "warunek po renderze", file: file, line: line)
  }

  static func spin(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  static func fieldFrame(_ controller: SessionViewController) -> CGRect? {
    guard let container = controller.composer.textView.superview else { return nil }
    return container.convert(container.bounds, to: nil)
  }

  static func dockCardFrame(_ controller: SessionViewController) -> CGRect? {
    guard let frame = find(controller.decisionSlot, id: "dock.card") else { return nil }
    return frame.convert(frame.bounds, to: nil)
  }

  static func label(in view: UIView, id: String) -> UILabel? {
    find(view, id: id) as? UILabel
  }

  static func find(_ view: UIView, id: String) -> UIView? {
    if view.accessibilityIdentifier == id { return view }
    for sub in view.subviews { if let hit = find(sub, id: id) { return hit } }
    return nil
  }

  /// Pierwszy wiersz wiadomości na ekranie i jego górna krawędź w oknie.
  static func topRow(_ controller: SessionViewController) -> (String, CGFloat)? {
    let list = controller.collectionView!
    let top = list.contentOffset.y + list.adjustedContentInset.top
    let visible = list.indexPathsForVisibleItems.sorted()
    for path in visible {
      guard let id = controller.dataSource.itemIdentifier(for: path), id.hasPrefix("m"),
        let cell = list.cellForItem(at: path), cell.frame.minY >= top
      else { continue }
      return (id, cell.convert(cell.bounds, to: nil).minY)
    }
    return nil
  }

  static func screenY(_ controller: SessionViewController, _ id: String) -> CGFloat? {
    guard let path = controller.dataSource.indexPath(for: id), let cell = controller.collectionView.cellForItem(at: path)
    else { return nil }
    return cell.convert(cell.bounds, to: nil).minY
  }

  static func attach(_ text: String) {
    let attachment = XCTAttachment(string: text)
    attachment.lifetime = .keepAlways
    XCTContext.runActivity(named: text) { $0.add(attachment) }
  }

  /// Zrzut ekranu sesji do katalogu z `RAROG_CARD_SNAPSHOT_DIR` (bez zmiennej nic nie zapisuje).
  static func snapshot(_ controller: SessionViewController, name: String) {
    controller.view.window?.layoutIfNeeded()
    spin(0.2)
    let renderer = UIGraphicsImageRenderer(bounds: controller.view.bounds)
    // Proces testów bez `UIApplication`: `drawHierarchy` daje tu białą klatkę, więc najpierw warstwa (jak
    // `ScreenBlockAnchorTests`), a `drawHierarchy` tylko wtedy, gdy warstwa wyszła przezroczysta.
    let view = controller.view.window ?? controller.view!
    var image = renderer.image { context in view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    XCTContext.runActivity(named: name) { $0.add(attachment) }
    guard let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty,
      let data = image.pngData()
    else { return }
    try? data.write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }
}
