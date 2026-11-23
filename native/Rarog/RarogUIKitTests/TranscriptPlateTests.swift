@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Dymek promptu z lewej, szeroki jak treść (≤ 47,5 em), godzina obok albo pod nim, rola dla VoiceOvera bez etykiety
/// na ekranie i cecha nagłówka raz na prompt. Właściciel: transkrypt.
@MainActor
final class TranscriptPlateTests: XCTestCase {
  private static let long = "Popraw parser notatek tak, żeby dzielił linie po znaku nowej linii, a nie po średniku, "
    + "i dopisz test, który to sprawdza na pliku z końcami CRLF. Potem puść całą bramkę i powiedz, co padło, "
    + "zanim zaczniesz cokolwiek naprawiać w innych modułach."

  /// Tło dymku idzie za najszerszą linią tekstu (+ wstawki 12 pt), stoi 16 pt od lewej krawędzi i nie przekracza
  /// 47,5 em; z blokiem kodu bierze pełną dozwoloną szerokość.
  func testPlateIsAsWideAsTextAndCapped() throws {
    let cap = MessageContentView.plateCap(UITraitCollection(preferredContentSizeCategory: .large), spacing: .standard)
    XCTAssertEqual(cap, 760, "47,5 em przy 16 pt")

    let short = try Self.host("Krótko.", width: 1_000)
    defer { short.window.isHidden = true }
    let shortPlate = try Self.plate(short.view)
    XCTAssertEqual(shortPlate.minX, 16, accuracy: 0.5, "dymek od lewej krawędzi treści")
    let used = MessageContentView.measuredWidth(short.text, container: cap - 24)
    XCTAssertEqual(shortPlate.width, used + 24, accuracy: 1, "szeroki jak tekst")
    XCTAssertLessThan(shortPlate.width, 120)

    let wrapped = try Self.host(Self.long, width: 1_330)
    defer { wrapped.window.isHidden = true }
    let wrappedPlate = try Self.plate(wrapped.view)
    XCTAssertLessThanOrEqual(wrappedPlate.width, cap + 0.5, "najwyżej 47,5 em przy kolumnie 1330 pt")
    XCTAssertGreaterThan(wrappedPlate.width, cap - 80, "zawinięty tekst wypełnia dymek")

    let code = try Self.host("Zobacz:\n\n```\nlet x = 1\n```", width: 1_000)
    defer { code.window.isHidden = true }
    XCTAssertEqual(try Self.plate(code.view).width, cap, accuracy: 0.5, "z blokiem kodu pełna dozwolona szerokość")

    let phone = try Self.host(Self.long, width: 390)
    defer { phone.window.isHidden = true }
    XCTAssertLessThanOrEqual(try Self.plate(phone.view).maxX, 390 - 16 + 0.5, "w wąskiej kolumnie do prawego marginesu")
  }

  /// Godzina obok dymku, gdy mieści się po prawej (szeroka kolumna, krótki prompt w wąskiej), inaczej pod dymkiem —
  /// także w dużym piśmie; wiersz rośnie o miejsce na godzinę pod dymkiem.
  func testClockBesideOrBelowPlate() throws {
    let large = UITraitCollection(preferredContentSizeCategory: .large)
    let huge = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
    let style = { (traits: UITraitCollection) in
      MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: traits)
    }
    let shortText = MarkdownCache().text("Krótko.", style: style(large))
    XCTAssertTrue(MessageContentView.clockFitsBeside(text: shortText, clock: "14:05", rowWidth: 968, traits: large, spacing: .standard))
    XCTAssertTrue(MessageContentView.clockFitsBeside(text: shortText, clock: "14:05", rowWidth: 358, traits: large, spacing: .standard),
                  "telefon: krótki prompt zostawia miejsce po prawej")
    let longHuge = MarkdownCache().text(Self.long, style: style(huge))
    XCTAssertFalse(MessageContentView.clockFitsBeside(text: longHuge, clock: "14:05", rowWidth: 358, traits: huge, spacing: .standard),
                   "duże pismo, pełny dymek: godzina pod")

    let beside = try Self.host("Krótko.", width: 1_000, clock: "14:05")
    defer { beside.window.isHidden = true }
    let besidePlate = try Self.plate(beside.view)
    let besideClock = try Self.clock(beside.view)
    XCTAssertGreaterThanOrEqual(besideClock.minX, besidePlate.maxX + MessageContentView.clockGap - 0.5, "obok dymku")
    XCTAssertLessThan(besideClock.minY, besidePlate.maxY, "na wysokości dymku")

    let below = try Self.host(Self.long, width: 390, clock: "14:05", clockBelow: true, category: .accessibilityExtraExtraExtraLarge)
    defer { below.window.isHidden = true }
    let belowPlate = try Self.plate(below.view)
    let belowClock = try Self.clock(below.view)
    XCTAssertGreaterThanOrEqual(belowClock.minY, belowPlate.maxY + MessageContentView.clockUnderGap - 0.5, "pod dymkiem")
    XCTAssertEqual(belowClock.minX, belowPlate.minX, accuracy: 0.5, "od lewej krawędzi dymku")
    XCTAssertLessThanOrEqual(belowClock.maxY, below.view.bounds.maxY + 0.5, "wiersz mieści godzinę")
  }

  /// Ekran sesji liczy miejsce godziny z szerokości listy: krótki prompt — obok, długi w wąskiej kolumnie przy dużym
  /// piśmie — pod.
  func testSessionPlacesPromptClockFromListWidth() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    let turn = TurnMark(promptHead: true, clock: "14:05")
    let short = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: "Krótko.", turn: turn))
    XCTAssertEqual(short.clock, "14:05")
    XCTAssertFalse(short.clockBelow)
    controller.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    controller.view.layoutIfNeeded()
    let long = controller.textConfiguration(.text(id: "m2.0", role: .user, voice: .user, markdown: Self.long, turn: turn))
    XCTAssertTrue(long.clockBelow)
  }

  /// Komórka skonfigurowana przy nowej szerokości listy nie odbiera przeliczenia godzin pozostałym wierszom: znacznik
  /// szerokości przesuwa wyłącznie `refreshPromptClocks`.
  func testCellConfigurationLeavesClockRefreshToList() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    let laidOut = controller.readingChrome.clockWidth
    XCTAssertEqual(laidOut, controller.collectionView.bounds.width)
    controller.collectionView.frame.size.width -= 100
    _ = controller.textConfiguration(
      .text(id: "m1.0", role: .user, voice: .user, markdown: "Krótko.", turn: TurnMark(promptHead: true, clock: "14:05")))
    XCTAssertEqual(controller.readingChrome.clockWidth, laidOut, "konfiguracja komórki nie przesuwa znacznika")
    controller.refreshPromptClocks()
    XCTAssertEqual(controller.readingChrome.clockWidth, controller.collectionView.bounds.width)
  }

  /// An agent reply's time stands under its last line, never beside it, from the prose's left edge; the row grows by
  /// the time's line, and a reply ending in a code block keeps the time below the box.
  func testReplyClockUnderLastLine() throws {
    let code = "Done:\n\n```\nlet x = 1\n```"
    for (markdown, width) in [("Short.", 1_000.0), (Self.long, 390.0), (code, 1_000.0)] {
      let plain = try Self.host(markdown, width: width, plate: false)
      defer { plain.window.isHidden = true }
      let timed = try Self.host(markdown, width: width, clock: "14:07", plate: false)
      defer { timed.window.isHidden = true }
      let traits = timed.view.traitCollection
      let line = MessageContentView.clockFont(traits).lineHeight.rounded(.up) + MessageContentView.clockUnderGap
      XCTAssertEqual(timed.view.bounds.height - plain.view.bounds.height, line, accuracy: 0.5, "one time line: \(markdown)")

      let textView = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: timed.view).first)
      let text = textView.convert(textView.bounds, to: timed.view)
      let label = try XCTUnwrap(TranscriptLeadingTests.views(of: UILabel.self, in: timed.view).first { $0.text == "14:07" })
      let clock = label.convert(label.bounds, to: timed.view)
      XCTAssertFalse(label.isHidden)
      XCTAssertGreaterThanOrEqual(clock.minY, text.maxY + MessageContentView.clockUnderGap - 0.5, "under the last line")
      XCTAssertEqual(clock.minX, text.minX, accuracy: 0.5, "from the prose's left edge")
      XCTAssertLessThanOrEqual(clock.maxY, timed.view.bounds.maxY + 0.5, "the row holds the time")
      XCTAssertEqual(label.accessibilityLabel, UICopy.replyClockSpoken("14:07"))
      for box in TranscriptLeadingTests.views(of: CodeBlockBox.self, in: timed.view) {
        XCTAssertGreaterThanOrEqual(clock.minY, box.convert(box.bounds, to: timed.view).maxY, "below the code box")
      }
    }
  }

  /// Prompt z samym blokiem nieobsługiwanym niesie godzinę pod linią, jak prompt ze zdjęciami.
  func testUnsupportedPromptShowsClock() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    func height(_ turn: TurnMark) -> CGFloat {
      UIHostingController(rootView: controller.hostedView(.unsupported(id: "m1.0", voice: .user, turn: turn)))
        .sizeThatFits(in: CGSize(width: 390, height: 1_000)).height
    }
    let plain = height(TurnMark(promptHead: true))
    XCTAssertGreaterThan(height(TurnMark(promptHead: true, clock: "14:05")), plain + 8, "godzina pod linią")
  }

  /// Rola dla czytnika przed treścią ZAWSZE (także bez zmiany głosu, w płynącej odpowiedzi i we wpisie w locie), a na
  /// ekranie żadnej etykiety roli.
  func testVoiceOverRoleWithoutVisibleLabel() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    let cases: [(TranscriptRow, String)] = [
      (.text(id: "m1.0", role: .user, voice: .user, markdown: "Prompt"), "Ty: Prompt"),
      (.text(id: "m2.0", role: .assistant, voice: nil, markdown: "Odpowiedź"), "Agent: Odpowiedź"),
      (.text(id: "m3.0", role: .system, voice: .system, markdown: "Wtrącenie"), "System: Wtrącenie"),
      (.open(voice: nil, markdown: "Płynie"), "Agent: Płynie"),
      (.pending(entry: UUID(), voice: .user, text: "W drodze"), "Ty, w drodze: W drodze"),
    ]
    for (row, spoken) in cases {
      let view = controller.textConfiguration(row).makeContentView()
      let text = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first)
      XCTAssertEqual(text.accessibilityLabel, spoken)
      let labels = TranscriptLeadingTests.views(of: UILabel.self, in: view).compactMap(\.text).filter { !$0.isEmpty }
      XCTAssertTrue(labels.isEmpty, "bez etykiety roli na ekranie: \(labels)")
    }
  }

  /// Cecha nagłówka RAZ na prompt: pierwszy wiersz wiadomości człowieka, nie drugi blok tej samej wiadomości ani
  /// odpowiedź agenta.
  func testHeaderOncePerPrompt() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    func traits(_ row: TranscriptRow) throws -> UIAccessibilityTraits {
      let view = controller.textConfiguration(row).makeContentView()
      return try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first).accessibilityTraits
    }
    XCTAssertTrue(try traits(.text(id: "m1.0", role: .user, voice: .user, markdown: "Pierwszy blok",
                                   turn: TurnMark(gap: .turn, promptHead: true))).contains(.header))
    XCTAssertFalse(try traits(.text(id: "m1.1", role: .user, voice: nil, markdown: "Drugi blok",
                                    turn: TurnMark(clock: "14:05"))).contains(.header))
    XCTAssertFalse(try traits(.text(id: "m2.0", role: .assistant, voice: .assistant, markdown: "Odpowiedź")).contains(.header))
  }

  /// Blok kodu w dymku w jasnym motywie: tło `codeInPlateFill` (biel 50 % nad dymkiem), poza dymkiem — `codeBlockFill`.
  func testCodeBlockInPlateHasPlateFill() throws {
    let plated = try Self.host("```\nlet x = 1\n```", width: 600, theme: .light)
    defer { plated.window.isHidden = true }
    let box = try XCTUnwrap(TranscriptLeadingTests.views(of: CodeBlockBox.self, in: plated.view).first { !$0.isHidden })
    let light = UITraitCollection(userInterfaceStyle: .light)
    XCTAssertEqual(box.backgroundColor?.resolvedColor(with: light), Palette.codeInPlateFill.resolvedColor(with: light))
    XCTAssertEqual(TranscriptLeadingTests.hex(Palette.codeInPlateFill.resolvedColor(with: light)), 0xF2F0F4)
  }

  /// Wpis w kolejce CLI niesie pasmo poświaty jak każdy wpis w locie. Czytnik dalej słyszy „Ty, w kolejce”, a wysokość
  /// jest ta sama co echa — przejście w wiadomość nie rusza transkryptu. Przejście w „Nie potwierdzono” gubi pasmo.
  func testQueuedPlateShimmers() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    let text = "Dopisek wysłany w trakcie pracy agenta."
    let entry = UUID()
    let queued = controller.textConfiguration(.pending(entry: entry, voice: .user, text: text, queued: true))
    let flying = controller.textConfiguration(.pending(entry: UUID(), voice: .user, text: text))
    let lost = controller.textConfiguration(.pending(entry: entry, voice: .user, text: text, inFlight: false))
    let echo = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: text))
    XCTAssertTrue(flying.inFlight, "przed 202 — poświata jak dotąd")
    XCTAssertTrue(queued.inFlight, "w kolejce — pasmo płynie")
    XCTAssertFalse(lost.inFlight, "„Nie potwierdzono” — bez pasma")
    XCTAssertTrue(queued.dimmed)
    XCTAssertEqual(queued.accessibilityPrefix, UICopy.queuedRolePrefix)

    let (window, view, field) = try TranscriptLeadingTests.host(queued, width: 600)
    defer { window.isHidden = true }
    let content = try XCTUnwrap(view as? MessageContentView)
    XCTAssertTrue(content.shimmerRunning, "dymek w kolejce z poświatą")
    XCTAssertEqual(field.accessibilityLabel, "Ty, w kolejce: \(text)")
    let (echoWindow, echoView, _) = try TranscriptLeadingTests.host(echo, width: 600)
    defer { echoWindow.isHidden = true }
    XCTAssertEqual(view.bounds.height, echoView.bounds.height, accuracy: 0.5, "ta sama wysokość co echo")

    content.configuration = lost
    XCTAssertFalse(content.shimmerRunning, "kolejka → „Nie potwierdzono”: pasmo znika")
  }

  /// Dwa dymki w kolejce płyną w jednej fazie: pasmo startuje na granicy cyklu wspólnego zegara
  /// (``PlateShimmerClock``), nie w chwili dodania. Faza zostaje wspólna po recyklingu komórki (ta sama komórka
  /// z inną konfiguracją) i po powrocie dymku do okna (powrót z tła dodaje pasmo od nowa).
  func testQueuedPlatesShareOnePhase() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    let controller = fixture.controller
    func queued(_ text: String) -> MessageContentConfiguration {
      controller.textConfiguration(.pending(entry: UUID(), voice: .user, text: text, queued: true))
    }
    func wait(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    func assertSamePhase(_ lhs: CFTimeInterval, _ rhs: CFTimeInterval, _ message: String) {
      XCTAssertEqual(remainder(lhs - rhs, PlateShimmerClock.period), 0, accuracy: 0.001, message)
    }

    let (firstWindow, firstView, _) = try TranscriptLeadingTests.host(queued("Pierwszy w kolejce."), width: 600)
    defer { firstWindow.isHidden = true }
    let first = try Self.bandBegin(firstView)
    // Drugi dymek powstaje w innym ułamku cyklu niż pierwszy.
    wait(0.35)
    let (secondWindow, secondView, _) = try TranscriptLeadingTests.host(queued("Drugi w kolejce."), width: 600)
    defer { secondWindow.isHidden = true }
    assertSamePhase(try Self.bandBegin(secondView), first, "dwa dymki w kolejce — jedna faza")

    // Recykling: ta sama komórka dostaje echo (pasmo znika), a potem inny wpis w kolejce (pasmo od nowa).
    let recycled = try XCTUnwrap(secondView as? MessageContentView)
    recycled.configuration = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: "Echo"))
    XCTAssertFalse(recycled.shimmerRunning)
    wait(0.5)
    recycled.configuration = queued("Trzeci w kolejce.")
    XCTAssertTrue(recycled.shimmerRunning)
    assertSamePhase(try Self.bandBegin(recycled), first, "po recyklingu komórki — ta sama faza")

    // Powrót z tła: dymek zdjęty z okna traci pasmo, po powrocie dostaje je od nowa w tej samej fazie.
    let superview = try XCTUnwrap(firstView.superview)
    firstView.removeFromSuperview()
    XCTAssertFalse(try XCTUnwrap(firstView as? MessageContentView).shimmerRunning)
    wait(0.6)
    superview.addSubview(firstView)
    XCTAssertTrue(try XCTUnwrap(firstView as? MessageContentView).shimmerRunning)
    assertSamePhase(try Self.bandBegin(firstView), first, "po powrocie do okna — ta sama faza")
  }

  /// Wpis w locie: po tle dymka płynie pasmo poświaty na całą jego ramkę, zamiast wiersza „w kolejce” pod nim.
  /// Echo, przygaszony wpis „Nie potwierdzono” i dymek zdjęty z okna — bez animacji;
  /// ograniczony ruch wyłącza pasmo. Kolejna konfiguracja tej samej komórki nie zaczyna przejścia od nowa.
  func testInFlightPlateShimmers() throws {
    let flying = try Self.host("W drodze.", width: 600, dimmed: true, inFlight: true)
    defer { flying.window.isHidden = true }
    let view = try XCTUnwrap(flying.view as? MessageContentView)
    XCTAssertTrue(view.shimmerRunning, "dymek w locie z poświatą")
    let plate = try XCTUnwrap(TranscriptLeadingTests.views(of: UIView.self, in: view).first { $0.backgroundColor == Palette.userPlate })
    let band = try XCTUnwrap(plate.layer.sublayers?.compactMap { $0 as? CAGradientLayer }.first)
    XCTAssertEqual(band.frame, plate.bounds, "pasmo na całe tło dymku")
    XCTAssertTrue(plate.layer.masksToBounds, "pasmo przycięte do zaokrąglonego tła")
    let started = try XCTUnwrap(band.animation(forKey: PlateShimmer.animationKey)).beginTime
    view.configuration = view.configuration
    XCTAssertEqual(band.animation(forKey: PlateShimmer.animationKey)?.beginTime, started, "render nie cofa pasma")

    let lost = try Self.host("Nie wiem, czy doszło.", width: 600, dimmed: true)
    defer { lost.window.isHidden = true }
    XCTAssertFalse(try XCTUnwrap(lost.view as? MessageContentView).shimmerRunning, "„Nie potwierdzono”: przygaszony, bez pasma")

    let echo = try Self.host("W drodze.", width: 600)
    defer { echo.window.isHidden = true }
    XCTAssertFalse(try XCTUnwrap(echo.view as? MessageContentView).shimmerRunning, "echo bez poświaty")

    view.removeFromSuperview()
    XCTAssertFalse(view.shimmerRunning, "poza oknem bez animacji")
    XCTAssertFalse(PlateShimmer.runs(inFlight: true, inWindow: true, reduceMotion: true), "ograniczony ruch: bez pasma")
    XCTAssertTrue(PlateShimmer.runs(inFlight: true, inWindow: true, reduceMotion: false))
    // Rytm pasma (także kafla w SwiftUI) sprawdza test logiki `PlateShimmerClockTests`.
  }

  // MARK: - Pomocnicze

  /// Początek animacji pasma na dymku, w czasie mediów (wspólny zegar poświaty).
  private static func bandBegin(_ view: UIView) throws -> CFTimeInterval {
    let plate = try XCTUnwrap(TranscriptLeadingTests.views(of: UIView.self, in: view).first { $0.backgroundColor == Palette.userPlate })
    let band = try XCTUnwrap(plate.layer.sublayers?.compactMap { $0 as? CAGradientLayer }.first)
    let animation = try XCTUnwrap(band.animation(forKey: PlateShimmer.animationKey), "pasmo płynie")
    return band.convertTime(animation.beginTime, to: nil)
  }

  private struct Hosted {
    let window: UIWindow
    let view: UIView
    let text: NSAttributedString
  }

  /// Dymek promptu w oknie o szerokości `width`; konfiguracja wpięta drugi raz już w oknie (cechy pisma okna).
  private static func host(
    _ markdown: String, width: CGFloat, clock: String? = nil, clockBelow: Bool = false,
    category: UIContentSizeCategory = .large, theme: UIUserInterfaceStyle = .dark, dimmed: Bool = false,
    inFlight: Bool = false, plate: Bool = true
  ) throws -> Hosted {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 1_600))
    window.overrideUserInterfaceStyle = theme
    window.traitOverrides.preferredContentSizeCategory = category
    let root = UIViewController()
    root.view.backgroundColor = Palette.background
    window.rootViewController = root
    window.makeKeyAndVisible()
    let traits = root.traitCollection
    let style = MarkdownRenderer.Style(textColor: Palette.text, base: MarkdownRenderer.transcriptStyle, traits: traits)
    let text = MarkdownCache().text(markdown, style: style)
    var config = MessageContentConfiguration(
      voice: "ty", text: text, plate: plate, dimmed: dimmed, accessibilityIdentifier: "message.m1.0", accessibilityPrefix: "Ty")
    config.clock = clock
    config.clockBelow = clockBelow
    config.inFlight = inFlight
    let view = config.makeContentView()
    view.frame = CGRect(x: 0, y: 0, width: width, height: 1_000)
    root.view.addSubview(view)
    view.configuration = config
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    let size = view.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    view.frame = CGRect(x: 0, y: 0, width: width, height: size.height)
    window.layoutIfNeeded()
    view.layoutIfNeeded()
    return Hosted(window: window, view: view, text: text)
  }

  /// Ramka tła dymku w układzie widoku treści.
  private static func plate(_ view: UIView) throws -> CGRect {
    let plate = try XCTUnwrap(TranscriptLeadingTests.views(of: UIView.self, in: view).first { $0.backgroundColor == Palette.userPlate })
    return plate.convert(plate.bounds, to: view)
  }

  private static func clock(_ view: UIView) throws -> CGRect {
    let label = try XCTUnwrap(TranscriptLeadingTests.views(of: UILabel.self, in: view).first { !$0.isHidden && $0.text != nil })
    return label.convert(label.bounds, to: view)
  }
}
