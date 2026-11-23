import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Linia „NOWE" na prawdziwym ekranie sesji przy powrocie apki z tła, także na iPadzie
/// z otwartą sesją. Zejście w tło i powrót to powiadomienia systemu,
/// które ekran obserwuje; powtórka z bufora serwera to ramki `message` bez snapshotu. Właściciel: transkrypt.
@MainActor
final class TranscriptNewMarkerTests: XCTestCase {
  /// Sesja otwarta, apka w tle, w przerwie powtórka: ramka stanu, prompt z terminala, krok narzędzia, odpowiedź.
  /// Po powrocie linia stoi nad odpowiedzią, nie nad promptem; wiadomość po powrocie jej nie przesuwa; dwa kolejne
  /// powroty bez nowych wiadomości — bez linii.
  func testReturnFromBackgroundMarksAgentMessagesFromTheBreak() throws {
    let preferences = isolateMemory()
    let store = try Self.store(old: 3, new: 0)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    XCTAssertFalse(Self.ids(controller).contains("new"), "pierwsza wizyta bez linii")

    Self.background()
    XCTAssertEqual(
      LastSeenMemory.load(from: preferences).seenAt("s1"), Self.oldAt, "zejście w tło zapisuje najnowszą wiadomość")
    // Część przerwy doszła, zanim apka zasnęła (ramki już w magazynie przed powrotem), reszta to powtórka po powrocie.
    try Self.frames(store, [
      #"{"type":"state","sessionId":"s1","state":"running","since":"2026-10-06T11:00:00.000Z"}"#,
      Self.message(4, "user", "2026-10-06T11:00:00.000Z", #"[{"type":"text","text":"Prompt z terminala"}]"#),
    ])
    Self.settle(controller) { Self.ids(controller).contains("m4.0") }
    Self.foreground()
    try Self.frames(store, [
      Self.message(5, "assistant", "2026-10-06T11:00:05.000Z", #"[{"type":"tool-call","toolName":"Grep","summary":"krok"}]"#),
      Self.message(6, "assistant", "2026-10-06T11:00:09.000Z", #"[{"type":"text","text":"Odpowiedź z przerwy."}]"#),
    ])
    Self.settle(controller) { Self.ids(controller).contains("new") }
    var ids = Self.ids(controller)
    var line = try XCTUnwrap(ids.firstIndex(of: "new"), "linia po powrocie: \(ids)")
    XCTAssertEqual(ids[line + 1], "m6.0", "nad odpowiedzią z przerwy: \(ids)")
    XCTAssertLessThan(try XCTUnwrap(ids.firstIndex(of: "m4.0")), line, "prompt z terminala nad linią")
    // Wygląd linii (wariant B): zrzut ciemnego motywu w załączniku i w `RAROG_SHOTS`.
    TranscriptProseWidthTests.shoot(window, name: "nowe-po-powrocie-ciemny", test: self)

    try Self.frames(store, [Self.message(7, "assistant", Self.iso(Date().addingTimeInterval(1)), #"[{"type":"text","text":"Na żywo."}]"#)])
    Self.settle(controller) { Self.ids(controller).contains("m7.0") }
    ids = Self.ids(controller)
    line = try XCTUnwrap(ids.firstIndex(of: "new"))
    XCTAssertEqual(ids[line + 1], "m6.0", "wiadomość po powrocie nie przesuwa linii")

    for round in 1...2 {
      let renders = controller.readingChrome.counters.renders
      Self.background()
      Self.foreground()
      Self.settle(controller) { controller.readingChrome.counters.renders > renders }
      XCTAssertFalse(Self.ids(controller).contains("new"), "powrót \(round) bez nowych wiadomości: bez linii")
    }
  }

  /// Odpięty transkrypt czyta środek: linia z poprzedniej wizyty stoi nad ekranem. Powrót z tła bez nowych wiadomości
  /// zdejmuje ją, a wiersz u góry ekranu zostaje w miejscu (kotwica i przypięcie bez zmian). Powrót na wierzch bez
  /// zejścia w tło (Stage Manager, centrum sterowania) niczego nie zmienia.
  func testOldLineLeavesWithoutMovingUnpinnedReader() throws {
    let preferences = isolateMemory()
    var memory = LastSeenMemory()
    memory.note("s1", at: Self.oldAt)
    memory.save(to: preferences)
    let store = try Self.store(old: 30, new: 30)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let list = controller.collectionView!
    XCTAssertEqual(Self.ids(controller).firstIndex(of: "new").map { Self.ids(controller)[$0 + 2] }, "m31.0",
      "wizyta z linią nad pierwszą nową (pod nią godzina po przerwie): \(Self.ids(controller))")

    let target = try XCTUnwrap(controller.dataSource.indexPath(for: "m45.0"))
    list.scrollToItem(at: target, at: .top, animated: false)
    list.layoutIfNeeded()
    controller.pinned = false
    controller.updateJumpBar()
    func screenY() -> CGFloat? {
      guard let index = controller.dataSource.indexPath(for: "m45.0"),
        let frame = list.layoutAttributesForItem(at: index)?.frame
      else { return nil }
      return frame.minY - list.contentOffset.y
    }
    let before = try XCTUnwrap(screenY())

    let decision = controller.ui.reading.newMarker
    Self.foreground()
    SessionToastTests.spin(0.2)
    // Ta sama wizyta = ta sama chwila wejścia (stan pigułki w decyzji zmienia się w tym czasie sam).
    XCTAssertEqual(controller.ui.reading.newMarker.enteredAt, decision.enteredAt, "powrót bez zejścia w tło: bez nowej wizyty")
    XCTAssertEqual(controller.ui.reading.newMarker.seq, decision.seq)
    XCTAssertTrue(Self.ids(controller).contains("new"))

    Self.background()
    Self.foreground()
    Self.settle(controller) { !Self.ids(controller).contains("new") }
    list.layoutIfNeeded()
    XCTAssertFalse(Self.ids(controller).contains("new"), "nic nowego od zejścia w tło: stara linia znika")
    XCTAssertFalse(controller.pinned, "przypięcie bez zmian")
    XCTAssertEqual(try XCTUnwrap(screenY()), before, accuracy: 0.5, "wiersz u góry ekranu stoi w miejscu")
  }

  // MARK: - Pigułka „N nowych wiadomości"

  /// Wejście na dno (bez zmian), linia wysoko: pigułka z liczbą bloków tekstu agenta, na osi kolumny 6 pt pod górą safe
  /// area (pasek cytatu przy dnie schowany). Tap: linia staje 6 pt pod paskiem cytatu, transkrypt odpięty, pasek „na
  /// dół" stoi, a pigułka gaśnie i po zejściu na dno nie wraca.
  func testPillCountsMissedRepliesAndTapLandsLineUnderPromptBar() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 25, prompt: true)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    let bar = try XCTUnwrap(controller.turnChrome.promptBar)
    Self.settle(controller) { pill.isShown }
    XCTAssertTrue(controller.pinned, "wejście bez zmian: na dnie")
    XCTAssertTrue(pill.isShown, "linia nad ekranem: pigułka")
    XCTAssertEqual(pill.configuration?.title, "25 nowych wiadomości")
    XCTAssertEqual(pill.accessibilityLabel, "25 nowych wiadomości, przewiń do pierwszej")
    XCTAssertTrue(pill.accessibilityTraits.contains(.button))
    XCTAssertTrue(bar.isHidden, "przy dnie pasek cytatu schowany")
    let safe = controller.view.safeAreaLayoutGuide.layoutFrame
    XCTAssertEqual(pill.frame.minY, safe.minY + 6, accuracy: 0.5, "6 pt pod górą safe area")
    XCTAssertEqual(pill.frame.midX, safe.midX, accuracy: 0.5, "oś kolumny, jak pasek „na dół”")
    // Wysokość sprzed kółka „na dół”: stała pigułki, nie rama kółka.
    XCTAssertEqual(pill.frame.height, Self.formerBarHeight(), accuracy: 0.5, "wysokość pigułki bez zmian")
    XCTAssertNotEqual(pill.frame.height, JumpToBottomBar.diameter, "pigułka nie bierze średnicy kółka")
    // Wygląd F: zrzut ciemnego motywu w załączniku i w `RAROG_SHOTS`.
    TranscriptProseWidthTests.shoot(window, name: "nowe-pigulka-ciemny", test: self)

    pill.sendActions(for: .primaryActionTriggered)
    XCTAssertFalse(pill.isShown, "tap: gaśnie od razu")
    XCTAssertTrue(controller.readingChrome.lineJumping, "animowany skok w toku")
    // Okno bez sceny nie animuje i końca nie zgłasza — wtedy linię stawia zapas 1 s.
    Self.settle(controller) { !controller.readingChrome.lineJumping }
    SessionToastTests.spin(0.2)
    controller.view.layoutIfNeeded()
    XCTAssertFalse(controller.pinned, "transkrypt odpięty")
    XCTAssertTrue(controller.readingChrome.jumpBar.isShown, "pasek „na dół” jak przy każdym odjechaniu od dna")
    XCTAssertFalse(bar.isHidden, "poza dnem pasek cytatu stoi")
    let line = try XCTUnwrap(Self.screenFrame(controller, "new"))
    XCTAssertEqual(line.minY, bar.frame.maxY + 6, accuracy: 1, "linia u góry ekranu, pod paskiem cytatu")
    XCTAssertFalse(pill.isShown)

    controller.jumpToBottom()
    Self.settle(controller) { !controller.readingChrome.jumpAnimating }
    SessionToastTests.spin(0.2)
    XCTAssertTrue(controller.pinned)
    XCTAssertFalse(pill.isShown, "po zejściu na dno w tej wizycie nie wraca")
  }

  /// „×” na pigułce zamyka ją i oznacza resztę jako przeczytaną: pigułka gaśnie i nie wraca, linia „NOWE” znika bez
  /// ruchu odpiętego czytelnika, a „doczytane” jest w pamięci od razu, przed wyjściem z ekranu. Czytnik ma to samo jako
  /// akcję pigułki.
  func testCloseDismissesPillAndLineWithoutMovingReader() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 25)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    Self.settle(controller) { pill.isShown }
    XCTAssertEqual(pill.accessibilityCustomActions?.map(\.name), [UICopy.newPillDismiss])
    XCTAssertFalse(pill.closeButton.isPointerInteractionEnabled, "bez systemowego efektu wskaźnika")
    XCTAssertEqual(pill.closeButton.frame.maxX, pill.bounds.maxX, accuracy: 0.5, "„×” na prawym końcu kapsuły")
    // Dotyk w „×” trafia w „×”, także w celu 44 pt nad kapsułą; w napis — w pigułkę (skok do linii).
    let close = pill.closeButton.frame
    XCTAssertTrue(pill.hitTest(CGPoint(x: close.midX, y: close.midY), with: nil) === pill.closeButton, "„×”")
    XCTAssertTrue(pill.hitTest(CGPoint(x: close.midX, y: -5), with: nil) === pill.closeButton, "„×” nad kapsułą")
    XCTAssertTrue(pill.hitTest(CGPoint(x: pill.bounds.midX - 20, y: pill.bounds.midY), with: nil) === pill, "napis")
    TranscriptProseWidthTests.shoot(window, name: "nowe-pigulka-x-ciemny", test: self)

    // Czytelnik w środku nowych, odpięty: linia nad ekranem, pigułka stoi.
    let list = controller.collectionView!
    list.scrollToItem(at: try XCTUnwrap(controller.dataSource.indexPath(for: "m35.0")), at: .top, animated: false)
    list.layoutIfNeeded()
    controller.pinned = false
    controller.updateJumpBar()
    Self.settle(controller) { pill.isShown }
    XCTAssertTrue(pill.isShown, "linia nad ekranem: pigułka stoi")
    let before = try XCTUnwrap(Self.screenFrame(controller, "m35.0")).minY

    pill.closeButton.sendActions(for: .primaryActionTriggered)
    XCTAssertFalse(pill.isShown, "gaśnie od razu")
    Self.settle(controller) { !Self.ids(controller).contains("new") }
    XCTAssertFalse(Self.ids(controller).contains("new"), "linia „NOWE” znika")
    XCTAssertEqual(try XCTUnwrap(Self.screenFrame(controller, "m35.0")).minY, before, accuracy: 0.5, "wiersz stoi w miejscu")
    XCTAssertFalse(controller.pinned, "przypięcie bez zmian")
    XCTAssertEqual(
      LastSeenMemory.load(from: preferences).seenAt("s1"), "2026-10-06T10:30:00.000Z", "„doczytane” zapisane od razu")
    controller.updateNewPill()
    XCTAssertFalse(pill.isShown, "w tej wizycie nie wraca")
  }

  /// „×” przy przypiętym transkrypcie (wejście na dno, linia wysoko): linia znika, transkrypt zostaje przypięty na dnie.
  func testCloseKeepsPinnedReaderAtBottom() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 25)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    Self.settle(controller) { pill.isShown }
    XCTAssertTrue(controller.pinned, "wejście na dno")

    pill.closeButton.sendActions(for: .primaryActionTriggered)
    Self.settle(controller) { !Self.ids(controller).contains("new") }
    SessionToastTests.spin(0.2)
    controller.view.layoutIfNeeded()
    XCTAssertFalse(Self.ids(controller).contains("new"), "linia „NOWE” znika")
    XCTAssertTrue(controller.pinned, "przypięty zostaje przypięty")
    XCTAssertLessThanOrEqual(controller.distanceFromBottom(), 1, "na dnie")
    XCTAssertFalse(pill.isShown)
  }

  /// Przewinięcie bez gestu nie „odczytuje” za człowieka: długa historia, linia
  /// przelatuje przez ekran przy przewinięciu z kodu i przy skoku „Przewiń na dół”, a pigułka po zejściu na dno znów
  /// stoi. Gest, który wprowadza linię na ekran, gasi ją; po powrocie na dno w tej wizycie nie wraca.
  func testOnlyGestureToLineRetiresPill() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 25)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    let list = controller.collectionView!
    Self.settle(controller) { pill.isShown }
    XCTAssertTrue(pill.isShown)

    // Rzut (przeciągnięcie z wytracaniem) przejęty przez skok „na dół”, a potem przewinięcie z kodu przez linię:
    // ruch po przejęciu nie jest gestem, choć lista nie zgłosiła końca wytracania.
    controller.scrollViewWillBeginDragging(list)
    controller.scrollViewDidEndDragging(list, willDecelerate: true)
    controller.jumpToBottom()
    controller.pinned = false
    list.scrollToItem(at: try Self.line(controller), at: .centeredVertically, animated: false)
    controller.updateNewPill()
    XCTAssertFalse(pill.isShown, "linia na ekranie: pigułka nie wskazuje w górę")
    XCTAssertFalse(controller.ui.reading.newMarker.lineSeen, "przewinięcie z kodu linii nie odczytuje")
    controller.jumpToBottom()
    Self.settle(controller) { !controller.readingChrome.jumpAnimating && pill.isShown }
    XCTAssertTrue(controller.pinned)
    XCTAssertTrue(pill.isShown, "po skoku na dno linia znów nad ekranem: pigułka stoi")

    // Gest: przeciągnięcie listy, aż linia stanie na ekranie (ciąg wywołań delegata jak przy palcu).
    controller.scrollViewWillBeginDragging(list)
    list.scrollToItem(at: try Self.line(controller), at: .centeredVertically, animated: false)
    controller.scrollViewDidEndDragging(list, willDecelerate: false)
    Self.settle(controller) { !pill.isShown }
    XCTAssertFalse(controller.pinned, "gest odjechał od dna")
    XCTAssertTrue(controller.ui.reading.newMarker.lineSeen, "gest doszedł do linii")
    XCTAssertFalse(pill.isShown)

    controller.jumpToBottom()
    Self.settle(controller) { !controller.readingChrome.jumpAnimating }
    SessionToastTests.spin(0.2)
    XCTAssertFalse(pill.isShown, "linia znów nad ekranem, ale gest już do niej doszedł")
  }

  /// Wysłanie promptu w trakcie skoku do linii przypina (`+Send`), a koniec skoku — tu zapas 1 s, bo okno testu nie
  /// animuje — nie ciągnie listy z powrotem do linii.
  func testPinDuringLineJumpKeepsBottom() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 25, prompt: true)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    Self.settle(controller) { pill.isShown }
    pill.sendActions(for: .primaryActionTriggered)
    XCTAssertTrue(controller.readingChrome.lineJumping)
    controller.pinned = true  // jak wysyłka: przypina, skoku nie odwołuje
    controller.settleAtBottom()
    Self.settle(controller) { !controller.readingChrome.lineJumping }
    SessionToastTests.spin(0.1)
    XCTAssertFalse(controller.readingChrome.lineJumping)
    XCTAssertTrue(controller.pinned)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 1, "przypięcie wygrywa: lista na dnie")
  }

  /// Linia na ekranie od razu przy wejściu: bez pigułki, ale też nie odczytana — dopiero gest przy widocznej linii.
  func testLineOnScreenAtEntryHasNoPill() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 30, new: 1)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let list = controller.collectionView!
    Self.settle(controller) { controller.readingChrome.counters.renders > 0 }
    SessionToastTests.spin(NewMarkerDecision.pillQuiet + 0.1)
    XCTAssertTrue(Self.ids(controller).contains("new"))
    XCTAssertFalse(controller.readingChrome.newPill.isShown, "linia na ekranie: bez pigułki")
    XCTAssertFalse(controller.ui.reading.newMarker.lineSeen, "wejście na dno to nie gest")

    controller.scrollViewWillBeginDragging(list)
    controller.updateNewPill()
    XCTAssertFalse(controller.ui.reading.newMarker.lineSeen, "gest bez ruchu listy (palec oparty) nie odczytuje")
    list.setContentOffset(CGPoint(x: 0, y: list.contentOffset.y - 20), animated: false)
    controller.scrollViewDidEndDragging(list, willDecelerate: false)
    Self.settle(controller) { controller.ui.reading.newMarker.lineSeen }
    XCTAssertTrue(controller.ui.reading.newMarker.lineSeen, "gest przy widocznej linii")
  }

  /// Sesja otwarta, apka w tle, w przerwie agent pisał (powtórka z bufora po powrocie, bez snapshotu, więc decyzja
  /// zostaje otwarta): pigułka liczy bloki tekstu agenta z przerwy — sklejona wiadomość z dwoma blokami daje dwa,
  /// prompt z terminala i krok narzędzia nic.
  func testReturnFromBackgroundShowsPillWithBreakCount() throws {
    let preferences = isolateMemory()
    Self.seen(Self.oldAt, preferences)
    let store = try Self.store(old: 20, new: 0, prompt: true)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    let pill = controller.readingChrome.newPill
    Self.settle(controller) { controller.readingChrome.counters.renders > 0 }
    XCTAssertFalse(pill.isShown, "nic nowego: bez pigułki")

    Self.background()
    Self.foreground()
    var frames = [
      Self.message(21, "user", "2026-10-06T11:00:00.000Z", #"[{"type":"text","text":"Prompt z terminala"}]"#),
      Self.message(22, "assistant", "2026-10-06T11:00:01.000Z", #"[{"type":"tool-call","toolName":"Grep","summary":"krok"}]"#),
      Self.message(23, "assistant", "2026-10-06T11:00:02.000Z", #"""
        [{"type":"text","text":"Sklejona tura, pierwszy blok."},{"type":"tool-call","toolName":"Grep","summary":"krok"},
         {"type":"text","text":"Sklejona tura, drugi blok."}]
        """#),
    ]
    frames += (24...43).map { seq in
      Self.message(seq, "assistant", "2026-10-06T11:01:\(seq).000Z", #"[{"type":"text","text":"\#(Self.longText(seq))"}]"#)
    }
    try Self.frames(store, frames)
    Self.settle(controller) { pill.isShown }
    XCTAssertFalse(controller.ui.reading.newMarker.fixed, "powtórka bez snapshotu: decyzja otwarta")
    XCTAssertTrue(pill.isShown, "po powrocie: pigułka bez czekania na zamrożenie")
    XCTAssertEqual(pill.configuration?.title, "22 nowe wiadomości")
  }

  // MARK: - Pomocnicze

  /// Pamięć „doczytane" i miejsca czytania tylko dla tego testu: zapis przy zejściu w tło nie trafia do UserDefaults
  /// hosta, a kotwica schowanego okna nie odpina ekranu `s1` w następnych klasach.
  private func isolateMemory() -> MemoryPreferences {
    let preferences = MemoryPreferences()
    TranscriptMemory.preferences = preferences
    TranscriptMemory.positions = TranscriptPositionMemory()
    addTeardownBlock { @MainActor in
      TranscriptMemory.preferences = UserDefaults.standard
      TranscriptMemory.positions = TranscriptPositionMemory()
    }
    return preferences
  }

  private static let oldAt = "2026-10-06T10:00:00.000Z"

  /// „Doczytane" tej sesji w pamięci urządzenia przed wejściem.
  private static func seen(_ at: String, _ preferences: MemoryPreferences) {
    var memory = LastSeenMemory()
    memory.note("s1", at: at)
    memory.save(to: preferences)
  }

  private static func line(_ controller: SessionViewController) throws -> IndexPath {
    try XCTUnwrap(controller.dataSource.indexPath(for: "new"), "linia „NOWE” w liście")
  }

  /// Ramka wiersza na ekranie sesji (układ widoku kontrolera).
  private static func screenFrame(_ controller: SessionViewController, _ rowId: String) -> CGRect? {
    guard let index = controller.dataSource.indexPath(for: rowId),
      let frame = controller.collectionView.layoutAttributesForItem(at: index)?.frame
    else { return nil }
    return controller.collectionView.convert(frame, to: controller.view)
  }

  private static func longText(_ seq: Int) -> String {
    "Odpowiedź \(seq).\\n\\nDrugi akapit odpowiedzi, dość długi, żeby zawinął się i dał komórce kilka linii."
  }

  private static func background() {
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
  }

  private static func foreground() {
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
  }

  private static func ids(_ controller: SessionViewController) -> [String] {
    controller.dataSource.snapshot().itemIdentifiers
  }

  /// Renderu po ramce albo po powrocie (planowany w pętli) i układu.
  private static func settle(_ controller: SessionViewController, until condition: () -> Bool) {
    SessionToastTests.until(condition)
    SessionToastTests.spin(0.1)
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
  }

  private static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private static func message(_ seq: Int, _ role: String, _ at: String, _ blocks: String) -> String {
    #"{"type":"message","sessionId":"s1","message":{"seq":\#(seq),"role":"\#(role)","at":"\#(at)","blocks":\#(blocks)}}"#
  }

  private static func frames(_ store: RarogStore, _ frames: [String]) throws {
    for frame in frames { try SessionToastTests.frame(store, frame, source: .session("s1")) }
  }

  /// Wysokość paska „Przewiń na dół” z napisem, zanim stał się kółkiem: napis `footnote`
  /// półgruby, strzałka `footnote` mała, odstępy 7 pt. Tyle miała i ma pigułka „N nowych”.
  private static func formerBarHeight() -> CGFloat {
    var config = UIButton.Configuration.plain()
    config.cornerStyle = .capsule
    config.image = UIImage(
      systemName: "arrow.down", withConfiguration: UIImage.SymbolConfiguration(textStyle: .footnote, scale: .small))
    config.imagePadding = 6
    config.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14)
    config.title = UICopy.jumpLabel(decision: false)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var out = attributes
      out.font = Fonts.text(.footnote, weight: .semibold)
      return out
    }
    return UIButton(configuration: config).intrinsicContentSize.height
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

  /// Sesja `s1` z `old` odpowiedziami o `oldAt` i `new` odpowiedziami pół godziny później (pełny stan z serwera).
  /// `prompt`: pierwsza wiadomość to prompt człowieka — pasek cytatu ma co cytować.
  private static func store(old: Int, new: Int, prompt: Bool = false) throws -> RarogStore {
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
    let body = (1...(old + new)).map { seq in
      let at = seq <= old ? oldAt : "2026-10-06T10:30:00.000Z"
      let role = prompt && seq == 1 ? "user" : "assistant"
      return #"{"seq":\#(seq),"role":"\#(role)","at":"\#(at)","blocks":[{"type":"text","text":"\#(longText(seq))"}]}"#
    }.joined(separator: ",")
    try SessionToastTests.frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(body)],"pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    return store
  }
}
