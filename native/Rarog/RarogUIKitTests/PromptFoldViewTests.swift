@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Długi prompt zwinięty do 6 linii z „Pokaż całość · N linii” na dole dymka: okno
/// przycina pole pełnej wysokości, więc czytnik, zaznaczenie i kopia bloku kodu mają całość; wpis w locie wygląda jak
/// echo; godzina stoi przy zwiniętym dymku; rozwinięcie i zwinięcie trzymają miejsce czytania. Właściciel: transkrypt.
@MainActor
final class PromptFoldViewTests: XCTestCase {
  private static func long(_ count: Int) -> String {
    (1...count).map { "Linia \($0) długiego promptu" }.joined(separator: "\n")
  }

  private static func turn(_ lines: Int, expanded: Bool = false, clock: String? = nil) -> TurnMark {
    TurnMark(gap: .turn, promptHead: true, clock: clock, fold: PromptFold(lines: lines, expanded: expanded))
  }

  /// Ekran sesji `s1`; po teście pamięć miejsca czytania wraca do pustej (jak w `TranscriptLeadingTests`).
  private func session() throws -> SessionLayoutTests.Fixture {
    addTeardownBlock { @MainActor in TranscriptMemory.positions = TranscriptPositionMemory() }
    return try SessionLayoutTests.makeSession(safeBottom: 0)
  }

  private struct Parts {
    let clip: UIView
    let text: UITextView
    let plate: CGRect
    let button: PromptFoldButton
    let fade: PromptFoldFade
    /// Okno tekstu w układzie wiersza.
    let window: CGRect
    /// Napis przycisku (ikona z tekstem) w układzie wiersza.
    let title: CGRect
  }

  private static func parts(_ view: UIView) throws -> Parts {
    let text = try XCTUnwrap(TranscriptLeadingTests.views(of: UITextView.self, in: view).first)
    let clip = try XCTUnwrap(text.superview)
    let plate = try XCTUnwrap(TranscriptLeadingTests.views(of: UIView.self, in: view).first { $0.backgroundColor == Palette.userPlate })
    let button = try XCTUnwrap(TranscriptLeadingTests.views(of: PromptFoldButton.self, in: view).first)
    let fade = try XCTUnwrap(TranscriptLeadingTests.views(of: PromptFoldFade.self, in: view).first)
    button.layoutIfNeeded()
    let label = try XCTUnwrap(button.titleLabel)
    let image = try XCTUnwrap(button.imageView)
    let title = label.convert(label.bounds, to: view).union(image.convert(image.bounds, to: view))
    return Parts(
      clip: clip, text: text, plate: plate.convert(plate.bounds, to: view), button: button, fade: fade,
      window: clip.convert(clip.bounds, to: view), title: title)
  }

  /// Wiersz przycisku w zwiniętym dymku pod oknem tekstu: odstęp i linia napisu (pod nią wstawka dymku i 2 pt marginesu
  /// wiersza, bez godziny pod dymkiem).
  private static func foldReserve(_ traits: UITraitCollection) -> CGFloat {
    MessageContentView.foldRow(traits: traits, collapsed: true, room: MessageContentView.plateVertical + 2).reserve
  }

  /// Czy dotyk w punkcie `y` pola (x tuż za początkiem linii) trafia w pole tekstu, a nie w przycisk nad nim.
  private static func textTakesTouch(_ parts: Parts, in view: UIView, y: CGFloat) -> Bool {
    let point = parts.text.convert(CGPoint(x: 4, y: y), to: view)
    return view.hitTest(point, with: nil)?.isDescendant(of: parts.text) == true
  }

  /// Linie bazowe pola (w jego układzie), w kolejności.
  private static func baselines(_ textView: UITextView) -> [CGFloat] {
    guard let manager = textView.textLayoutManager else { return [] }
    var out: [CGFloat] = []
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
      let frame = fragment.layoutFragmentFrame
      for line in fragment.textLineFragments where line.characterRange.length > 0 {
        out.append(frame.minY + line.typographicBounds.minY + line.glyphOrigin.y)
      }
      return true
    }
    return out
  }

  /// Zwinięty: okno na 6 linii prozy (w nim dokładnie 6 linii bazowych), na jego dole zanik, a pod oknem, jeszcze
  /// w dymku, przycisk z liczbą linii (cel ≥ 44 pt, od lewej krawędzi tekstu); dymek kończy się pod przyciskiem. Pole
  /// ma CAŁY tekst: czytnik i kopia zaznaczenia dostają ostatnią linię. Rozwinięty: okno = pole, „Zwiń”, bez zaniku.
  func testCollapsedShowsSixLinesAndButton() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let markdown = Self.long(20)
    let config = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(20)))
    XCTAssertEqual(config.fold, PromptFold(lines: 20, expanded: false))
    let (window, view, _) = try TranscriptLeadingTests.host(config, width: 420)
    defer { window.isHidden = true }
    let parts = try Self.parts(view)
    let height = MessageContentView.foldHeight(parts.text.traitCollection)
    XCTAssertEqual(height, CGFloat(PromptFolds.visible) * 24, accuracy: 0.5, "6 linii prozy po 24 pt (16 pt × 1,5)")
    XCTAssertEqual(parts.clip.bounds.height, height, accuracy: 0.5, "okno na 6 linii")
    XCTAssertGreaterThan(parts.text.bounds.height, height * 2, "pole pełnej wysokości pod oknem")
    XCTAssertEqual(Self.baselines(parts.text).filter { $0 < height }.count, PromptFolds.visible, "6 linii w oknie")
    let reserve = Self.foldReserve(parts.text.traitCollection)
    XCTAssertEqual(
      parts.plate.height, height + reserve + 2 * MessageContentView.plateVertical, accuracy: 0.5,
      "dymek kończy się pod wierszem przycisku")
    XCTAssertFalse(parts.fade.isHidden, "zanik ostatniej linii")
    // Krótkie linie: dymek węższy od okna, a zanik nie wychodzi poza niego.
    let fade = parts.fade.convert(parts.fade.bounds, to: view)
    XCTAssertLessThan(parts.plate.width, parts.clip.bounds.width, "dymek krótkich linii węższy od okna")
    let plateText = parts.plate.maxX - MessageContentView.plateHorizontal
    XCTAssertLessThanOrEqual(fade.maxX, plateText + 0.5, "zanik w dymku: \(fade)")
    XCTAssertGreaterThan(fade.width, 0)

    let button = parts.button.convert(parts.button.bounds, to: view)
    XCTAssertFalse(parts.button.isHidden)
    XCTAssertEqual(parts.button.accessibilityLabel, "Pokaż całość · 20\u{00A0}linii")
    XCTAssertEqual(parts.button.accessibilityIdentifier, "message.m1.0.fold")
    XCTAssertGreaterThanOrEqual(button.height, MessageContentView.foldTarget, "cel ≥ 44 pt")
    XCTAssertEqual(button.minX, parts.window.minX, accuracy: 0.5, "od lewej krawędzi tekstu")
    XCTAssertLessThanOrEqual(button.maxY, view.bounds.maxY + 0.5, "wiersz mieści cel dotyku")
    XCTAssertGreaterThanOrEqual(parts.title.minY, parts.window.maxY - 0.5, "napis pod oknem tekstu: \(parts.title)")
    XCTAssertLessThanOrEqual(
      parts.title.maxY, parts.plate.maxY - MessageContentView.plateVertical + 0.5, "napis w dymku: \(parts.title)")
    XCTAssertLessThanOrEqual(parts.title.maxX, parts.plate.maxX - MessageContentView.plateHorizontal + 0.5)
    let fadeTop = parts.window.maxY - MessageContentView.fadeHeight(parts.text.traitCollection)
    XCTAssertGreaterThanOrEqual(button.minY, fadeTop - 0.5, "cel dotyku nad napisem najwyżej na zanik")
    let visible = Self.baselines(parts.text).filter { $0 < fadeTop - parts.window.minY }
    XCTAssertTrue(Self.textTakesTouch(parts, in: view, y: try XCTUnwrap(visible.last) - 4), "widoczna linia łapie dotyk")

    XCTAssertTrue(parts.text.accessibilityLabel?.hasSuffix("Linia 20 długiego promptu") == true, "czytnik czyta całość")
    XCTAssertEqual(parts.text.accessibilityLabel?.hasPrefix("Ty: Linia 1 "), true)
    XCTAssertTrue(MarkdownPlainText.copy(parts.text.attributedText).contains("Linia 20 długiego promptu"), "kopia ma całość")
    // Ramka czytnika: pole bez okna sięga pod przycisk, z oknem kończy się na nim (ta sama góra, wysokość okna).
    let field = try XCTUnwrap(parts.text as? MessageTextView)
    let clipped = field.accessibilityFrame
    field.accessibilityClip = nil
    let full = field.accessibilityFrame
    field.accessibilityClip = parts.clip
    XCTAssertGreaterThan(full.height, height * 2, "bez okna ramka wystawała: \(full)")
    XCTAssertEqual(clipped.minY, full.minY, accuracy: 0.5, "ramka od góry pola: \(clipped)")
    XCTAssertEqual(clipped.height, height, accuracy: 0.5, "ramka czytnika kończy się na oknie: \(clipped)")
    XCTAssertEqual(clipped.width, full.width, accuracy: 0.5)

    var tapped = 0
    var tappable = config
    tappable.toggleFold = { tapped += 1 }
    (view as? UIContentView)?.configuration = tappable
    parts.button.sendActions(for: .primaryActionTriggered)
    XCTAssertEqual(tapped, 1, "przycisk przestawia zwinięcie")

    let open = controller.textConfiguration(
      .text(id: "m1.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(20, expanded: true)))
    let (openWindow, openView, _) = try TranscriptLeadingTests.host(open, width: 420)
    defer { openWindow.isHidden = true }
    let opened = try Self.parts(openView)
    XCTAssertEqual(opened.clip.bounds.height, opened.text.bounds.height, accuracy: 0.5, "rozwinięty: całe pole")
    XCTAssertTrue(opened.fade.isHidden)
    XCTAssertEqual(opened.button.accessibilityLabel, "Zwiń")
    XCTAssertGreaterThan(openView.bounds.height, view.bounds.height + height, "rozwinięty wyższy o resztę tekstu")
    // „Zwiń” nie nachodzi na w pełni widoczną ostatnią linię: zaznaczanie i linki zostają tekstowi.
    let openButton = opened.button.convert(opened.button.bounds, to: openView)
    XCTAssertGreaterThanOrEqual(openButton.height, MessageContentView.foldTarget, "cel ≥ 44 pt")
    XCTAssertGreaterThanOrEqual(openButton.minY, opened.window.maxY - 0.5, "cel „Zwiń” pod tekstem: \(openButton)")
    XCTAssertLessThanOrEqual(openButton.maxY, openView.bounds.maxY + 0.5)
    XCTAssertGreaterThanOrEqual(opened.title.minY, opened.window.maxY - 0.5)
    XCTAssertLessThanOrEqual(opened.title.maxY, opened.plate.maxY - MessageContentView.plateVertical + 0.5, "napis w dymku")
    let last = try XCTUnwrap(Self.baselines(opened.text).last)
    XCTAssertTrue(Self.textTakesTouch(opened, in: openView, y: last - 4), "ostatnia linia łapie dotyk")
    XCTAssertTrue(Self.textTakesTouch(opened, in: openView, y: last + 2), "ostatnia linia łapie dotyk pod linią bazową")
  }

  /// Blok kodu w zwiniętym prompcie dalej jest kodem (tło pod tekstem, ikona kopiowania), a ikona kopiuje CAŁY blok,
  /// nie widoczne linie; tło bloku przycina okno.
  func testCodeBlockInCollapsedPromptCopiesWholeBlock() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let code = (1...30).map { "let linia\($0) = \($0)" }.joined(separator: "\n")
    let markdown = "Popraw to:\n\n```swift\n\(code)\n```"
    let config = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(PromptFolds.lines(markdown))))
    let (window, view, _) = try TranscriptLeadingTests.host(config, width: 420)
    defer { window.isHidden = true }
    let parts = try Self.parts(view)
    let copy = try XCTUnwrap(TranscriptLeadingTests.views(of: CopyIconButton.self, in: view).first { !$0.isHidden })
    XCTAssertTrue(copy.payload?()?.contains("let linia30 = 30") == true, "ikona kopiuje cały blok")
    let box = try XCTUnwrap(TranscriptLeadingTests.views(of: CodeBlockBox.self, in: view).first { !$0.isHidden })
    XCTAssertTrue(box.superview === parts.clip, "tło bloku w oknie tekstu")
    XCTAssertGreaterThan(box.frame.maxY, parts.clip.bounds.height, "tło dłuższe niż okno — przycina je okno")
  }

  /// Wpis w locie zwija się tą samą regułą i stoi tak samo jak jego echo: ten sam tekst, ta sama wysokość, ten sam
  /// przycisk — dymek nie skacze przy potwierdzeniu.
  func testPendingEntryFoldsLikeItsEcho() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let markdown = Self.long(24)
    let entry = UUID()
    let pending = controller.pendingConfiguration(entry: entry, voice: .user, text: markdown, turn: Self.turn(24))
    let echo = controller.textConfiguration(.text(id: "m9.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(24)))
    XCTAssertEqual(pending.fold, echo.fold)
    XCTAssertEqual(pending.text, echo.text)
    let (pendingWindow, pendingView, _) = try TranscriptLeadingTests.host(pending, width: 420)
    defer { pendingWindow.isHidden = true }
    let (echoWindow, echoView, _) = try TranscriptLeadingTests.host(echo, width: 420)
    defer { echoWindow.isHidden = true }
    XCTAssertEqual(pendingView.bounds.height, echoView.bounds.height, accuracy: 0.5, "ta sama wysokość wiersza")
    let pendingParts = try Self.parts(pendingView)
    XCTAssertEqual(pendingParts.button.accessibilityLabel, try Self.parts(echoView).button.accessibilityLabel)
    XCTAssertEqual(pendingParts.button.accessibilityIdentifier, "pending.\(entry.uuidString).fold")
  }

  /// Godzina przy zwiniętym dymku: obok — na wysokości jego ostatniej linii, czyli wiersza przycisku; pod — pod dymkiem,
  /// a przycisk nad nią, w dymku.
  func testClockBesideAndBelowCollapsedPlate() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    var beside = controller.textConfiguration(
      .text(id: "m1.0", role: .user, voice: .user, markdown: Self.long(20), turn: Self.turn(20, clock: "14:05")))
    beside.clockBelow = false
    let (window, view, _) = try TranscriptLeadingTests.host(beside, width: 1_000)
    defer { window.isHidden = true }
    let parts = try Self.parts(view)
    let clock = try Self.clock(view)
    let reserve = Self.foldReserve(parts.text.traitCollection)
    XCTAssertGreaterThanOrEqual(clock.minX, parts.plate.maxX + MessageContentView.clockGap - 0.5, "obok dymku")
    XCTAssertEqual(clock.maxY, parts.window.maxY + reserve, accuracy: 0.5, "na wysokości wiersza przycisku")

    var below = beside
    below.clockBelow = true
    let (belowWindow, belowView, _) = try TranscriptLeadingTests.host(below, width: 420)
    defer { belowWindow.isHidden = true }
    let belowParts = try Self.parts(belowView)
    let belowClock = try Self.clock(belowView)
    let button = belowParts.button.convert(belowParts.button.bounds, to: belowView)
    XCTAssertGreaterThanOrEqual(belowClock.minY, belowParts.plate.maxY + MessageContentView.clockUnderGap - 0.5, "pod dymkiem")
    XCTAssertLessThanOrEqual(belowParts.title.maxY, belowParts.plate.maxY, "napis w dymku, nad godziną")
    XCTAssertGreaterThanOrEqual(button.height, MessageContentView.foldTarget, "cel ≥ 44 pt")
    XCTAssertLessThanOrEqual(button.maxY, belowView.bounds.maxY + 0.5)
  }

  /// Długi prompt z krótkich linii: dymek co najmniej tak szeroki jak „Pokaż całość · N linii”, a po rozwinięciu
  /// („Zwiń”, krótszy napis) ma tę samą szerokość. Godzina obok dymku liczy się z tej szerokości.
  func testShortLinesPlateHoldsFoldTitle() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    let markdown = (1...20).map { "x\($0)" }.joined(separator: "\n")
    let config = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(20)))
    let (window, view, _) = try TranscriptLeadingTests.host(config, width: 420)
    defer { window.isHidden = true }
    let parts = try Self.parts(view)
    let traits = parts.text.traitCollection
    let floor = PromptFoldButton.showWidth(lines: 20, traits: traits)
    XCTAssertGreaterThanOrEqual(parts.plate.width, floor + 2 * MessageContentView.plateHorizontal - 0.5)
    XCTAssertLessThanOrEqual(parts.title.maxX, parts.plate.maxX - MessageContentView.plateHorizontal + 0.5, "napis w dymku")

    let open = controller.textConfiguration(
      .text(id: "m1.0", role: .user, voice: .user, markdown: markdown, turn: Self.turn(20, expanded: true)))
    let (openWindow, openView, _) = try TranscriptLeadingTests.host(open, width: 420)
    defer { openWindow.isHidden = true }
    XCTAssertEqual(try Self.parts(openView).plate.width, parts.plate.width, accuracy: 0.5, "rozwinięcie nie zwęża dymku")

    let text = config.text
    let clockWidth = ("14:05" as NSString).size(withAttributes: [.font: MessageContentView.clockFont(traits)]).width.rounded(.up)
    let row = floor + 2 * MessageContentView.plateHorizontal + MessageContentView.clockGap + clockWidth - 1
    XCTAssertTrue(MessageContentView.clockFitsBeside(text: text, clock: "14:05", rowWidth: row, traits: traits, spacing: .standard))
    XCTAssertFalse(
      MessageContentView.clockFitsBeside(text: text, clock: "14:05", rowWidth: row, traits: traits, spacing: .standard, fold: config.fold),
      "dymek szeroki jak napis przycisku nie zostawia miejsca na godzinę")
  }

  /// Ekran sesji: rozwinięcie trzyma górę dymku w tym samym miejscu ekranu, zwinięcie — dół wiersza (przycisk na dole
  /// dymka pod palcem); obie zmiany zapisują miejsce czytania od nowa.
  func testToggleKeepsReadingPosition() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    func message(_ seq: Int, _ role: String, _ text: String) -> String {
      let escaped = text.replacingOccurrences(of: "\n", with: "\\n")
      return #"{"seq":\#(seq),"role":"\#(role)","at":"2026-10-06T10:00:00.000Z","blocks":[{"type":"text","text":"\#(escaped)"}]}"#
    }
    let before = (1...30).map { message($0, "assistant", "Odpowiedź \($0), dość długa, żeby komórka miała dwie linie tekstu.") }
    let after = (32...60).map { message($0, "assistant", "Dalej \($0).") }
    let messages = before + [message(31, "user", Self.long(40))] + after
    try SessionToastTests.frame(fixture.store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[\#(messages.joined(separator: ","))],
       "pendingPermissions":[],"pendingQuestions":[]}
      """#, source: .session("s1"))
    func settle() {
      SessionToastTests.spin(0.3)
      for _ in 0..<3 {
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        controller.collectionView.layoutIfNeeded()
        SessionToastTests.spin(0.05)
      }
    }
    func frame() throws -> CGRect {
      let index = try XCTUnwrap(controller.dataSource.indexPath(for: "m31.0"))
      return try XCTUnwrap(controller.collectionView.layoutAttributesForItem(at: index)).frame
    }
    /// Stawia krawędź wiersza na `screenY` ekranu; komórki wchodzące na ekran zmieniają wysokość z szacunkowej na
    /// prawdziwą, więc kilka obrotów.
    func place(bottom: Bool, at screenY: CGFloat) throws {
      for _ in 0..<4 {
        let edge = bottom ? try frame().maxY : try frame().minY
        controller.collectionView.contentOffset.y = edge - screenY
        settle()
      }
    }
    settle()
    XCTAssertEqual(controller.rows["m31.0"]?.turn.fold, PromptFold(lines: 40, expanded: false))
    controller.pinned = false
    let list = controller.collectionView!
    try place(bottom: false, at: 200)
    let collapsedHeight = try frame().height
    XCTAssertEqual(try frame().minY - list.contentOffset.y, 200, accuracy: 0.5)
    controller.togglePromptFold("m31.0")
    settle()
    XCTAssertEqual(controller.rows["m31.0"]?.turn.fold?.expanded, true)
    XCTAssertGreaterThan(try frame().height, collapsedHeight + 400, "rozwinięty")
    XCTAssertEqual(try frame().minY - list.contentOffset.y, 200, accuracy: 1, "góra dymku w tym samym miejscu ekranu")
    XCTAssertNotNil(TranscriptMemory.positions.recall("s1"), "miejsce czytania zapisane po przestawieniu")

    try place(bottom: true, at: 600)
    XCTAssertEqual(try frame().maxY - list.contentOffset.y, 600, accuracy: 0.5)
    controller.togglePromptFold("m31.0")
    settle()
    XCTAssertEqual(controller.rows["m31.0"]?.turn.fold?.expanded, false)
    XCTAssertEqual(try frame().height, collapsedHeight, accuracy: 0.5)
    XCTAssertEqual(try frame().maxY - list.contentOffset.y, 600, accuracy: 1, "przycisk pod palcem po zwinięciu")
    XCTAssertFalse(controller.pinned, "przestawienie nie przypina")
  }

  /// Zrzuty zwiniętego promptu z godziną (oba motywy) do oceny wyglądu.
  func testLookAttachments() throws {
    let fixture = try session()
    defer { fixture.window.isHidden = true }
    let markdown = "Popraw parser notatek według logu poniżej.\n\n" + Self.long(18) + "\n\n```\nnpm test -- notes\n```"
    for style in [UIUserInterfaceStyle.light, .dark] {
      fixture.controller.overrideUserInterfaceStyle = style
      let config = fixture.controller.textConfiguration(
        .text(id: "m1.0", role: .user, voice: .user, markdown: markdown,
              turn: Self.turn(PromptFolds.lines(markdown), clock: "14:05")))
      let (window, _, _) = try TranscriptLeadingTests.host(config, width: 700)
      defer { window.isHidden = true }
      window.overrideUserInterfaceStyle = style
      window.layoutIfNeeded()
      let format = UIGraphicsImageRendererFormat()
      format.scale = 2
      let image = UIGraphicsImageRenderer(bounds: CGRect(x: 0, y: 0, width: 700, height: 360), format: format).image { context in
        window.layer.render(in: context.cgContext)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = "dlugi-prompt-\(style == .dark ? "ciemny" : "jasny")"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }

  private static func clock(_ view: UIView) throws -> CGRect {
    let label = try XCTUnwrap(TranscriptLeadingTests.views(of: UILabel.self, in: view).first { !$0.isHidden && $0.text == "14:05" })
    return label.convert(label.bounds, to: view)
  }
}
