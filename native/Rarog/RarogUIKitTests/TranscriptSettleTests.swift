import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Transkrypt od razu na dole przy przełączeniu sesji i po powrocie z tła, bez
/// dociągania i przewijania na dół. Prawdziwy `SessionViewController` w oknie
/// z samowymiarującymi komórkami. Właściciel: transkrypt.
@MainActor
final class TranscriptSettleTests: XCTestCase {
  /// Nowy ekran sesji z transkryptem w pamięci: po JEDNYM przebiegu układu okna (bez obracania pętli, czyli
  /// w pierwszej wyświetlonej klatce) lista stoi na dnie, a dalsze klatki już jej nie przesuwają.
  func testFreshScreenStandsAtBottomAfterOneLayoutPass() throws {
    let store = try SessionToastTests.makeStore(messages: 60)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    window.layoutIfNeeded()
    let list = controller.collectionView!
    XCTAssertGreaterThan(list.contentSize.height, list.bounds.height * 2, "treść dłuższa niż ekran: \(list.contentSize)")
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "na dnie po pierwszym układzie")
    let counters = controller.readingChrome.counters
    XCTAssertEqual(counters.renders, 1, "jeden render do pierwszej treści (transkrypt w pamięci)")
    XCTAssertGreaterThanOrEqual(counters.settles, 1, "dojście do dna przez `settleAtBottom`")
    XCTAssertLessThanOrEqual(counters.maxSettleTurns, SessionViewController.settleTurns, "wspólny limit pracy")
    XCTAssertLessThan(counters.bottomScrolls, 20, "bez rekursji przewijania: \(counters)")
    let offset = list.contentOffset.y
    Self.spin(0.3)
    window.layoutIfNeeded()
    XCTAssertEqual(list.contentOffset.y, offset, accuracy: 0.5, "po pierwszej klatce lista już nie jedzie")
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5)
    let attachment = XCTAttachment(string: "liczniki po wejściu: \(controller.readingChrome.counters)")
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// Transkrypt wypadł z pamięci (więcej niż kilka sesji w obiegu): ekran wstaje ze szkieletem, a treść
  /// przychodzi strumieniem. Render, który przyniósł treść, stawia listę na dnie w tej samej turze pętli.
  func testTranscriptArrivingLaterLandsAtBottomInItsRender() throws {
    let store = try SessionToastTests.makeStore(messages: 1)
    store.dispatch(.viewSession("s2"))
    store.dispatch(.streamOpened(.session(id: "s2"), resumedWithCursor: false))
    let controller = SessionViewController(store: store, sessionId: "s2", drafts: ComposerDrafts())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 834, height: 1194))
    window.rootViewController = controller
    window.isHidden = false
    defer { window.isHidden = true }
    window.layoutIfNeeded()
    let before = controller.readingChrome.counters.renders
    let body = (1...60).map { seq in
      let text = "Odpowiedź \(seq).\\n\\nDrugi akapit odpowiedzi, dość długi, żeby zawinął się i dał komórce kilka linii."
      return #"{"seq":\#(seq),"role":"assistant","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"\#(text)"}]}"#
    }.joined(separator: ",")
    try SessionToastTests.frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s2","messages":[\#(body)],"pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s2"))
    for _ in 0..<100 where controller.readingChrome.counters.renders == before { Self.spin(0.01) }
    XCTAssertGreaterThan(controller.readingChrome.counters.renders, before, "render z treścią")
    XCTAssertEqual(store.state.transcriptPhase(for: "s2"), .content)
    let list = controller.collectionView!
    XCTAssertGreaterThan(list.contentSize.height, list.bounds.height * 2)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "dno w turze renderu z treścią")
  }

  /// Zejście w tło: iOS robi zrzuty przełącznika w obu motywach (cechy tam i z powrotem). Komórki się nie
  /// przebudowują, a po powrocie do tego samego motywu nic się nie dzieje — zaznaczenie tekstu zostaje.
  func testBackgroundThemeRoundTripKeepsCellsAndSelection() throws {
    defer { Self.resetPhase() }
    let store = try SessionToastTests.makeStore(messages: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    window.layoutIfNeeded()
    Self.spin(0.1)
    let text = try XCTUnwrap(Self.textViews(in: controller.collectionView).first, "tekst odpowiedzi w komórce")
    let shown = text.attributedText
    text.selectedRange = NSRange(location: 0, length: 5)
    let reconfigures = controller.readingChrome.counters.reconfigures

    TranscriptAppPhase.isBackground = { true }
    window.overrideUserInterfaceStyle = .light
    window.layoutIfNeeded()
    window.overrideUserInterfaceStyle = .dark
    window.layoutIfNeeded()
    TranscriptAppPhase.isBackground = { false }
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
    Self.spin(0.1)
    window.layoutIfNeeded()

    XCTAssertEqual(controller.readingChrome.counters.reconfigures, reconfigures, "ten sam motyw po powrocie: bez przebudowy")
    XCTAssertTrue(text.attributedText === shown || text.attributedText == shown, "ten sam tekst w komórce")
    XCTAssertEqual(text.selectedRange, NSRange(location: 0, length: 5), "zaznaczenie zostaje")
  }

  /// Realna zmiana motywu w tle (człowiek przełączył wygląd systemu) przebudowuje komórki RAZ, po powrocie;
  /// zmiana na wierzchu — od razu.
  func testRealThemeChangeRebuildsOnceOnReturn() throws {
    defer { Self.resetPhase() }
    let store = try SessionToastTests.makeStore(messages: 3)
    let (controller, window) = Self.host(store)
    defer { window.isHidden = true }
    window.layoutIfNeeded()
    let start = controller.readingChrome.counters.reconfigures

    TranscriptAppPhase.isBackground = { true }
    window.overrideUserInterfaceStyle = .light
    window.layoutIfNeeded()
    XCTAssertEqual(controller.readingChrome.counters.reconfigures, start, "w tle tylko znacznik")
    TranscriptAppPhase.isBackground = { false }
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
    XCTAssertEqual(controller.readingChrome.counters.reconfigures, start + 1, "po powrocie jedna przebudowa")
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
    XCTAssertEqual(controller.readingChrome.counters.reconfigures, start + 1, "drugi powrót bez zmian")

    window.overrideUserInterfaceStyle = .dark
    window.layoutIfNeeded()
    XCTAssertEqual(controller.readingChrome.counters.reconfigures, start + 2, "zmiana na wierzchu od razu")
  }

  /// Komórka tekstu: kolory ozdób markdownu (kreska cytatu) w tle się nie ruszają, a po powrocie idą od nowa
  /// tylko przy innym motywie niż ten, w którym je ustawiono.
  func testMessageCellDefersDecorationColorsInBackground() throws {
    defer { Self.resetPhase() }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
    window.overrideUserInterfaceStyle = .dark
    let root = UIViewController()
    window.rootViewController = root
    window.isHidden = false
    defer { window.isHidden = true }
    let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: root.traitCollection)
    let config = MessageContentConfiguration(
      voice: "agent", text: MarkdownCache().text("Akapit.\n\n> Cytat.\n", style: style), plate: false, dimmed: false,
      accessibilityIdentifier: "message.m1.0", accessibilityPrefix: nil)
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
    root.view.addSubview(view)
    window.layoutIfNeeded()
    let dark = Self.rgba(Palette.border.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).cgColor)
    let light = Self.rgba(Palette.border.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).cgColor)
    XCTAssertEqual(try Self.quoteBars(in: view), [dark])

    TranscriptAppPhase.isBackground = { true }
    window.overrideUserInterfaceStyle = .light
    window.layoutIfNeeded()
    XCTAssertEqual(try Self.quoteBars(in: view), [dark], "w tle kolory czekają")
    window.overrideUserInterfaceStyle = .dark
    window.layoutIfNeeded()
    TranscriptAppPhase.isBackground = { false }
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
    XCTAssertEqual(try Self.quoteBars(in: view), [dark], "ten sam motyw po powrocie")

    TranscriptAppPhase.isBackground = { true }
    window.overrideUserInterfaceStyle = .light
    window.layoutIfNeeded()
    TranscriptAppPhase.isBackground = { false }
    NotificationCenter.default.post(name: TranscriptAppPhase.foreground, object: nil)
    view.layoutIfNeeded()
    XCTAssertEqual(try Self.quoteBars(in: view), [light], "inny motyw po powrocie: nowe kolory")
  }

  /// Animowany skok „Przewiń na dół" z hostem dymka na ekranie: skok przestawia więzy
  /// dymka i planuje układ, a układ przy przypiętym transkrypcie schodził na dno BEZ animacji — w pół drogi.
  /// Układ w trakcie animacji nie stawia listy na dnie od razu; po końcu animacji lista stoi na dnie.
  func testAnimatedJumpIsNotCutByLayout() throws {
    let fixture = try SessionToastTests.make(messages: 40)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let list = controller.collectionView!
    list.setContentOffset(.zero, animated: false)
    controller.pinned = false
    controller.updateJumpBar()
    SessionToastTests.layout(fixture)
    XCTAssertTrue(controller.readingChrome.jumpBar.isShown, "pasek „na dół” po odjechaniu od dna")
    let far = controller.distanceFromBottom()
    XCTAssertGreaterThan(far, 200, "lista daleko od dna")

    controller.jumpToBottom()
    XCTAssertTrue(controller.readingChrome.jumpAnimating, "animowany skok w toku")
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    XCTAssertGreaterThan(controller.distanceFromBottom(), far / 2, "układ w trakcie animacji nie skacze na dno")

    // Okno testu nie stoi na ekranie, więc lista może nie zgłosić końca animacji — wtedy kończy ją zapas 1 s.
    for _ in 0..<150 where controller.readingChrome.jumpAnimating { SessionToastTests.spin(0.02) }
    XCTAssertFalse(controller.readingChrome.jumpAnimating, "koniec animacji (albo zapas) kasuje flagę")
    SessionToastTests.layout(fixture)
    XCTAssertLessThanOrEqual(abs(controller.distanceFromBottom()), 0.5, "po animacji lista na dnie")
    XCTAssertTrue(controller.pinned)
  }

  // MARK: - Pomocnicze

  private static func resetPhase() {
    TranscriptAppPhase.isBackground = { UIApplication.shared.applicationState == .background }
  }

  private static func host(_ store: RarogStore) -> (SessionViewController, UIWindow) {
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 834, height: 1194))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    return (controller, window)
  }

  private static func spin(_ seconds: TimeInterval) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
  }

  private static func textViews(in view: UIView) -> [UITextView] {
    view.subviews.flatMap { ($0 as? UITextView).map { [$0] } ?? textViews(in: $0) }
  }

  private static func quoteBars(in view: UIView) throws -> [String] {
    let manager = try XCTUnwrap(textViews(in: view).first?.textLayoutManager)
    var bars: [String] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      if let fragment = fragment as? MarkdownLayoutFragment, (fragment.decoration?.quoteDepth ?? 0) > 0 {
        let color = rgba(fragment.colors.quoteBar)
        if !bars.contains(color) { bars.append(color) }
      }
      return true
    }
    return bars
  }

  private static func rgba(_ color: CGColor) -> String {
    let srgb = color.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil) ?? color
    return (srgb.components ?? []).prefix(4).map { String(format: "%02X", Int(($0 * 255).rounded())) }.joined()
  }
}
