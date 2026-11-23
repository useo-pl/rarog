import CoreText
@testable import RarogUI
import UIKit
import XCTest

/// Pismo treści transkryptu: dymek człowieka i odpowiedź agenta.
/// Właściciel: transkrypt.
@MainActor
final class TranscriptTextStyleTests: XCTestCase {
  /// Dymek wiadomości człowieka i odpowiedź agenta mają ten sam krój, stopień i wysokość linii w każdym
  /// rozmiarze pisma. Obie drogi idą przez
  /// `textConfiguration` ekranu sesji, jak komórki transkryptu.
  func testUserPlateAndAgentTextShareTypeAtEveryTextSize() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let controller = fixture.controller
    for category in [UIContentSizeCategory.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
      controller.traitOverrides.preferredContentSizeCategory = category
      controller.view.layoutIfNeeded()
      let user = controller.textConfiguration(.text(id: "m1.0", role: .user, voice: .user, markdown: "Linia logu\nDruga linia"))
      let agent = controller.textConfiguration(
        .text(id: "m2.0", role: .assistant, voice: .assistant, markdown: "Odpowiedź agenta\nw dwóch liniach"))
      XCTAssertTrue(user.plate, "dymek człowieka")
      let userFont = try XCTUnwrap(user.text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
      let agentFont = try XCTUnwrap(agent.text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
      XCTAssertEqual(userFont.pointSize, agentFont.pointSize, "\(category.rawValue): stopień pisma")
      XCTAssertEqual(userFont.lineHeight, agentFont.lineHeight, "\(category.rawValue): wysokość linii")
      XCTAssertEqual(userFont.fontName, agentFont.fontName, "\(category.rawValue): krój")
      // Dymek w locie (wpis kolejki przed echem) stoi tym samym pismem co echo.
      let pending = controller.pendingConfiguration(entry: UUID(), voice: .user, text: "Linia logu")
      let pendingFont = try XCTUnwrap(pending.text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
      XCTAssertEqual(pendingFont.pointSize, agentFont.pointSize, "\(category.rawValue): dymek w locie")
      if category == .large {
        // Domyślne pismo transkryptu 16 pt (`callout`), o 1 pt więcej niż PWA.
        XCTAssertEqual(agentFont.pointSize, 16, "treść transkryptu w domyślnym rozmiarze")
        let code = controller.textConfiguration(
          .text(id: "m3.0", role: .assistant, voice: .assistant, markdown: "```\nlet x = 1\n```"))
        let line = (code.text.string as NSString).range(of: "let x")
        XCTAssertNotEqual(line.location, NSNotFound, "linia kodu")
        let codeFont = try XCTUnwrap(code.text.attribute(.font, at: line.location, effectiveRange: nil) as? UIFont)
        // Kod w bloku 2 pt mniej niż treść, krojem stałej szerokości.
        XCTAssertEqual(codeFont.pointSize, agentFont.pointSize - 2, "kod 2 pt mniej niż treść")
        XCTAssertTrue(codeFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace), "kod krojem stałej szerokości")
      }
    }
  }

  /// Link w treści: stonowany niebieski z podkreśleniem, zwykły tekst obok — kolor treści.
  func testLinkIsSoftBlueAndUnderlined() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let text = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: "Zobacz [dokumentację](https://example.com) tu.")).text
    let link = (text.string as NSString).range(of: "dokumentację")
    XCTAssertNotEqual(link.location, NSNotFound)
    XCTAssertNotNil(text.attribute(.link, at: link.location, effectiveRange: nil), "link")
    XCTAssertEqual(text.attribute(.foregroundColor, at: link.location, effectiveRange: nil) as? UIColor, Palette.linkInk)
    XCTAssertEqual(
      text.attribute(.underlineStyle, at: link.location, effectiveRange: nil) as? Int, NSUnderlineStyle.single.rawValue)
    let plain = (text.string as NSString).range(of: "Zobacz")
    XCTAssertNotEqual(
      text.attribute(.foregroundColor, at: plain.location, effectiveRange: nil) as? UIColor, Palette.linkInk, "zwykły tekst")
  }

  /// Odpowiedź agenta: proza w `prose`, pogrubienie i nagłówek jaśniejsze, w `strong`; cytat cały w `muted`; dymek
  /// człowieka zostaje w `text`, z pogrubieniem tym samym kolorem.
  func testAgentBoldAndHeadingAreBrighterThanProse() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let markdown = "## Nagłówek\n\nZwykły **mocny** tekst.\n\n- punkt **teza**\n\n> cytat **ważny**"
    let agent = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: markdown)).text
    let user = fixture.controller.textConfiguration(
      .text(id: "m2.0", role: .user, voice: .user, markdown: "Zwykły **mocny** tekst.")).text
    func ink(_ text: NSAttributedString, _ fragment: String) -> UIColor? {
      let range = (text.string as NSString).range(of: fragment)
      XCTAssertNotEqual(range.location, NSNotFound, fragment)
      return text.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor
    }
    XCTAssertEqual(ink(agent, "Zwykły"), Palette.prose, "proza agenta")
    XCTAssertEqual(ink(agent, "mocny"), Palette.strong, "pogrubienie agenta")
    XCTAssertEqual(ink(agent, "Nagłówek"), Palette.strong, "nagłówek agenta")
    XCTAssertEqual(ink(agent, "teza"), Palette.strong, "pogrubienie w punkcie listy")
    XCTAssertEqual(ink(agent, "ważny"), Palette.muted, "pogrubienie w cytacie zostaje w `muted`")
    XCTAssertEqual(ink(user, "Zwykły"), Palette.text, "dymek człowieka")
    XCTAssertEqual(ink(user, "mocny"), Palette.text, "pogrubienie w dymku człowieka")
  }

  /// Link do claude.ai, z etykietą i goły, niesie w atrybucie adres z `#no_universal_links`: iOS otwiera go
  /// w przeglądarce, nie w apce Claude. Widoczny tekst bez zmian, link do innej domeny bez zmian.
  func testClaudeLinkGoesToBrowser() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    let markdown = "Zobacz [artefakt](https://claude.ai/artifact/AbC123), https://claude.ai/code/artifact/x1"
      + " i [repo](https://github.com/x)."
    let text = fixture.controller.textConfiguration(
      .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: markdown)).text
    XCTAssertTrue(text.string.contains("Zobacz artefakt, https://claude.ai/code/artifact/x1 i repo."), text.string)
    func link(_ visible: String) -> String? {
      let range = (text.string as NSString).range(of: visible)
      XCTAssertNotEqual(range.location, NSNotFound, visible)
      return (text.attribute(.link, at: range.location, effectiveRange: nil) as? URL)?.absoluteString
    }
    XCTAssertEqual(link("artefakt"), "https://claude.ai/artifact/AbC123#no_universal_links", "link z etykietą")
    XCTAssertEqual(
      link("https://claude.ai/code"), "https://claude.ai/code/artifact/x1#no_universal_links", "goły adres")
    XCTAssertEqual(link("repo"), "https://github.com/x", "inna domena")
  }

  /// Emoji na początku wiadomości to jeden glif w kroju emoji: znacznik odstępu nad wiadomością (`rarogLeadGap`)
  /// leży na całym pierwszym znaku. Na pierwszej jednostce UTF-16, czyli na połowie pary
  /// surogatów, TLDR z 💡 wychodziłby jako dwa glify LastResort (zrzut z iPhone'a).
  func testEmojiAtMessageStartStaysOneGlyph() throws {
    let fixture = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { fixture.window.isHidden = true }
    for markdown in ["> 💡 **TLDR:** krótko.", "💡 na początku akapitu", "👨‍👩‍👧 rodzina z łącznikami"] {
      let text = fixture.controller.textConfiguration(
        .text(id: "m1.0", role: .assistant, voice: .assistant, markdown: markdown)).text
      let first = (text.string as NSString).rangeOfComposedCharacterSequence(at: 0)
      XCTAssertGreaterThan(first.length, 1, "\(markdown): na początku tekstu stoi emoji")
      var attributes = NSRange()
      _ = text.attributes(at: 0, effectiveRange: &attributes)
      XCTAssertGreaterThanOrEqual(attributes.length, first.length, "\(markdown): przebieg atrybutów tnie pierwszy znak")
      let line = CTLineCreateWithAttributedString(text.attributedSubstring(from: first))
      let runs = CTLineGetGlyphRuns(line) as? [CTRun] ?? []
      XCTAssertEqual(runs.count, 1, "\(markdown): jeden przebieg glifów")
      for run in runs {
        let font = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String] as? UIFont
        XCTAssertNotNil(font, markdown)
        XCTAssertNotEqual(font?.fontName, "LastResort", "\(markdown): krój zastępczy zamiast emoji")
      }
    }
  }
}
