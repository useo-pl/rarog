import RarogCore
@testable import RarogUI
import Testing

// Pasek zakładek (bez drabiny pilności): ton zakładki →
// wygląd kafelka z cyfrą i kwadracika, co stoi przed etykietą. Kontrast cyfry: `PaletteContrastTests`. Właściciel:
// projekty i zakładki.

@Suite("pasek zakładek: kafelek i kwadracik w kolorze kropki listy sesji")
struct TabTokensTests {
  private static func tab(_ kind: ProjectTabModel.Kind, target: ProjectTabRef? = .session("s1")) -> ProjectTabModel {
    ProjectTabModel(id: "t", kind: kind, target: target, label: "t", tone: .quiet, current: false, spoken: "t")
  }

  @Test("kafelek w ciszy jak klawisz: tło biel 13 % / czerń 8 % nad tłem paska, cyfra `muted`, medium")
  func quietKey() {
    let look = TabTokens.key(.quiet)
    #expect(look.fill == PaletteTokens.Pair(dark: 0x2A2A2A, light: 0xDFDFE3))
    #expect(look.ink == PaletteTokens.muted)
    #expect(!look.semibold)
  }

  /// Kafelki zakładek mają te same kolory co kropki listy sesji.
  /// Kropka wiersza listy sesji to `Palette.tone` (`SessionRow`), czyli `PaletteTokens.tone` w pełnym kryciu.
  @Test("kafelek każdego stanu poza ciszą: kolor kropki z listy sesji, cyfra `onState`, półgruba")
  func coloredKeys() {
    for tone in [StatusTone.working, .unread, .waiting, .failed, .backgroundWaitLong] {
      let look = TabTokens.key(tone)
      #expect(look.fill == PaletteTokens.tone(tone), "\(tone): kolor kropki listy")
      #expect(look.ink == PaletteTokens.onState, "\(tone)")
      #expect(look.semibold, "\(tone)")
    }
  }

  @Test("kafelek czekania na zadanie w tle: przydymiona zieleń, cyfra ciemna w obu motywach, półgruba")
  func backgroundWaitKey() {
    let look = TabTokens.key(.backgroundWait)
    #expect(look.fill == PaletteTokens.runSmoked)
    #expect(look.ink == PaletteTokens.onRunSmoked && look.ink != PaletteTokens.onState)
    #expect(look.semibold)
  }

  @Test("znak stanu przed etykietą: bieżąca kryjąco, siostra w 70 %, „czeka na zadanie w tle” kryjąco także u siostry")
  func markAlpha() {
    for tone in [StatusTone.working, .unread, .waiting, .failed] {
      #expect(TabTokens.markAlpha(tone, current: true) == .opaque, "\(tone)")
      #expect(TabTokens.markAlpha(tone, current: false) == TabTokens.Alpha(dark: 0.7, light: 0.7), "\(tone)")
    }
    #expect(TabTokens.markAlpha(.backgroundWait, current: true) == .opaque)
    #expect(TabTokens.markAlpha(.backgroundWait, current: false) == .opaque)
  }

  @Test("kwadracik: cisza neutralnie jak kafelek, każdy inny stan w kolorze kropki listy")
  func squares() {
    #expect(TabTokens.square(.quiet) == TabTokens.SquareLook(color: TabTokens.neutralInk, alpha: TabTokens.keyNeutralAlpha))
    for tone in [StatusTone.working, .unread, .waiting, .failed, .backgroundWait, .backgroundWaitLong] {
      #expect(TabTokens.square(tone) == TabTokens.SquareLook(color: PaletteTokens.tone(tone), alpha: .opaque), "\(tone)")
    }
  }

  @Test("przed etykietą: kafelek przy cyfrze, kwadracik bez niej (także w ciszy), nic przy zaproszeniu terminala")
  func marks() {
    #expect(Self.tab(.session).mark(digit: 3) == .key(3))
    #expect(Self.tab(.session).mark(digit: nil) == .square, "bez klawiatury sprzętowej albo dziewiąta i dalsze")
    #expect(Self.tab(.terminal, target: .terminal("term1")).mark(digit: 2) == .key(2))
    #expect(Self.tab(.terminal, target: .terminal("term1")).mark(digit: nil) == .square)
    // Terminal, którego id jeszcze nie znamy (bieżąca zakładka bez celu), też ma kwadracik.
    #expect(Self.tab(.terminal, target: nil).mark(digit: nil) == .square)
    for enabled in [true, false] {
      #expect(Self.tab(.invite(enabled: enabled), target: nil).mark(digit: nil) == .none, "zaproszenie \(enabled)")
    }
  }

  @Test("znak przed etykietą nie zależy od stanu: szerokość zakładki nie skacze przy zmianie tonu")
  func markIgnoresTone() {
    for tone in [StatusTone.quiet, .working, .unread, .waiting, .failed, .backgroundWait, .backgroundWaitLong] {
      let tab = ProjectTabModel(
        id: "t", kind: .session, target: .session("s1"), label: "t", tone: tone, current: false, spoken: "t")
      #expect(tab.mark(digit: nil) == .square, "\(tone)")
      #expect(tab.mark(digit: 1) == .key(1), "\(tone)")
    }
  }

  @Test("wygaszenie krawędzi: 16 pt, narasta liniowo z przewinięciem, odbicie bez wygaszenia")
  func edgeOpacity() {
    #expect(TabTokens.edgeOpacity(hidden: 0) == 1)
    #expect(TabTokens.edgeOpacity(hidden: -5) == 1, "odbicie przy początku listy")
    #expect(TabTokens.edgeOpacity(hidden: 4) == 0.75)
    #expect(TabTokens.edgeOpacity(hidden: 8) == 0.5)
    #expect(TabTokens.edgeOpacity(hidden: 16) == 0)
    #expect(TabTokens.edgeOpacity(hidden: 300) == 0)
  }

  @Test("wygaszenie tylko po stronie, za którą chowa się treść; na iPadzie od wcięcia pod listą sesji, nie od ramki")
  func edgeFadeSides() {
    let start = TabTokens.edgeFade(offset: 0, contentWidth: 600, containerWidth: 400, leadingInset: 0, trailingInset: 0)
    #expect(start == TabTokens.EdgeFade(leading: 1, trailing: 0, leadingInset: 0, trailingInset: 0), "początek listy")
    let end = TabTokens.edgeFade(offset: 200, contentWidth: 600, containerWidth: 400, leadingInset: 0, trailingInset: 0)
    #expect(end.leading == 0 && end.trailing == 1, "koniec listy")
    let middle = TabTokens.edgeFade(offset: 100, contentWidth: 600, containerWidth: 400, leadingInset: 0, trailingInset: 0)
    #expect(middle.leading == 0 && middle.trailing == 0, "środek listy")
    let fits = TabTokens.edgeFade(offset: 0, contentWidth: 300, containerWidth: 400, leadingInset: 0, trailingInset: 0)
    #expect(fits == .off, "treść mieści się w widoku")
    // iPad: the bar's frame from x = 0 is 1000 pt, the content after the list (a 320 pt inset), at rest at offset -320;
    // `ScrollGeometry` reports the container as the visible part, 680 pt.
    let rest = TabTokens.edgeFade(offset: -320, contentWidth: 900, containerWidth: 680, leadingInset: 320, trailingInset: 0)
    #expect(rest.leading == 1 && rest.leadingInset == 320, "iPad w spoczynku: lewa krawędź kolumny bez wygaszenia")
    let nudged = TabTokens.edgeFade(offset: -316, contentWidth: 900, containerWidth: 680, leadingInset: 320, trailingInset: 0)
    #expect(nudged.leading == 0.75 && nudged.trailing == 0, "4 pt przewinięcia")
    // At the end the content's end stands at the visible part's end, at offset 900 - 680 - 320: nothing hidden there.
    let padEnd = TabTokens.edgeFade(offset: -100, contentWidth: 900, containerWidth: 680, leadingInset: 320, trailingInset: 0)
    #expect(padEnd.leading == 0 && padEnd.trailing == 1, "the iPad bar's end with the list beside it")
    let padNearEnd = TabTokens.edgeFade(
      offset: -104, contentWidth: 900, containerWidth: 680, leadingInset: 320, trailingInset: 0)
    #expect(padNearEnd.trailing == 0.75, "4 pt before the end")
    // iPhone in landscape: 62 pt of safe area on both sides of an 874 pt bar, a 750 pt container.
    let phoneEnd = TabTokens.edgeFade(
      offset: 1188, contentWidth: 2000, containerWidth: 750, leadingInset: 62, trailingInset: 62)
    #expect(phoneEnd.trailing == 1 && phoneEnd.trailingInset == 62, "the end of the phone bar in landscape")
  }
}
