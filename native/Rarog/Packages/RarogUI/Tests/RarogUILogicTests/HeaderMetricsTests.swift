import CoreGraphics
@testable import RarogUI
import Testing

// Odstępy nagłówka sesji. Zrzuty mierzy
// `FramesScreenshotUITests`. Właściciel: nagłówek.

@Suite("nagłówek sesji: odstępy")
struct HeaderMetricsTests {
  @Test("cel dotyku ikony nagłówka co najmniej 44 pt")
  func iconTarget() {
    #expect(HeaderMetrics.iconTarget >= 44, "cel dotyku zostaje")
  }

  @Test("płytka bieżącej zakładki: środek w osi etykiety")
  func tabPlateGeometry() {
    // Środek płytki leży `tabLabelDrop` niżej środka celu, tam gdzie środek etykiety.
    let plateMid = (TabTokens.plateTopInset + (HeaderMetrics.iconTarget - TabTokens.plateBottomInset)) / 2
    #expect(plateMid == HeaderMetrics.iconTarget / 2 + HeaderMetrics.tabLabelDrop)
  }
}

@Suite("nagłówek sesji: przycisk zwijania listy i tytuł w lewym rogu")
struct HeaderLeadingMetricsTests {
  @Test("komplet ikon prawego rogu, pod który liczy się sufit tytułu: trzy")
  func trailingIconsMax() {
    #expect(HeaderMetrics.trailingIconsMax == 3)
  }

  @Test("sufit tytułu: kolumna bez przycisku, kompletu ikon i marginesów — długi tytuł nie wchodzi pod ikony")
  func titleMaxWidth() throws {
    // iPad Pro 11" w pionie: szczegół obok listy 320 pt (834 − 320) i po zwinięciu listy cały ekran.
    let beside = try #require(HeaderMetrics.titleMaxWidth(columnWidth: 514, toggle: true))
    // 514 − 2·16 − (44 + 2) − 136 − 16
    #expect(beside == 284)
    let collapsed = try #require(HeaderMetrics.titleMaxWidth(columnWidth: 834, toggle: true))
    #expect(collapsed == 604)
    // Tytuł i przycisk z ikonami mieszczą się w kolumnie razem z marginesami.
    #expect(2 * HeaderMetrics.barSideInset + HeaderMetrics.iconTarget + HeaderMetrics.titleSpacing + beside
      + HeaderMetrics.titleTrailingGap + 136 == 514)
  }

  @Test("uzbrojone „×” („Na pewno?”) szersze niż cel: tytuł oddaje 64 pt na czas uzbrojenia")
  func titleMaxWidthArmed() {
    let armed = HeaderMetrics.titleMaxWidth(columnWidth: 514, toggle: true, closeArmed: true)
    #expect(armed == 220, "\(String(describing: armed))")
    // Zapas liczy najszerszy język katalogu: polskie „Na pewno?”; angielskie “Sure?” i “Close?” są węższe.
    #expect(HeaderMetrics.armedCloseExtra >= 56, "„Na pewno?” w xxxLarge ma ~100 pt przy celu 44 pt")
  }

  @Test("kolumna niezmierzona: bez sufitu; za wąska: zero, nigdy ujemnie")
  func titleMaxWidthEdges() {
    #expect(HeaderMetrics.titleMaxWidth(columnWidth: 0, toggle: true) == nil)
    #expect(HeaderMetrics.titleMaxWidth(columnWidth: 120, toggle: true) == 0)
    #expect(HeaderMetrics.titleMaxWidth(columnWidth: 514, toggle: false) == 330, "bez przycisku tytuł dostaje jego miejsce")
  }
}

@Suite("nagłówek sesji: sufit tytułu na telefonie")
struct HeaderPhoneTitleTests {
  @Test("progi zmierzone na iOS 27: najszerszy tytuł, przy którym trzy ikony jeszcze stały w pasku")
  func measuredThresholds() {
    // iPhone Air: 420 pt, margines 20; 176 pt ikony stały, 177 pt — „⋯" przepełnienia.
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 420) == 176)
    // iPhone 17: 402 pt, margines 16; 166 pt stały, 167 pt — „⋯".
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 402) == 166)
    // iPhone 18 Pro Max: 440 pt, margines 20; 196 pt stały, 197 pt — „⋯".
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 440) == 196)
    // Wzór iPada dawał tu 190, 172 i 210 pt — wszystkie za szerokie. Na iPadzie Pro 11 obok listy (514 pt) daje
    // 284 pt przy zmierzonym progu 300 pt, więc tam zostaje.
    #expect(HeaderMetrics.titleMaxWidth(columnWidth: 420, toggle: true) == 190)
  }

  @Test("margines paska: 16 pt do iPhone'a 17 (402 pt), 20 pt od iPhone'a Air (420 pt)")
  func sideInset() {
    #expect(HeaderMetrics.phoneBarSideInset(columnWidth: 375) == 16)
    #expect(HeaderMetrics.phoneBarSideInset(columnWidth: 402) == 16)
    #expect(HeaderMetrics.phoneBarSideInset(columnWidth: 420) == 20)
    #expect(HeaderMetrics.phoneBarSideInset(columnWidth: 440) == 20)
  }

  @Test("uzbrojone „×”, kolumna niezmierzona i za wąska")
  func edges() {
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 420, closeArmed: true) == 112)
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 0) == nil)
    #expect(HeaderMetrics.phoneTitleMaxWidth(columnWidth: 200) == 0)
  }
}

@Suite("nagłówek sesji: ikony prawego rogu")
struct HeaderTrailingIconsTests {
  /// Every input combination: project (popup terminal), right panel, terminal screen, session "×". The Recent
  /// Sessions clock is not here: it stands in the project header of the list.
  private static let inputs: [(popup: Bool, inspector: Bool, terminal: Bool, close: Bool)] = {
    let flags = [false, true]
    return flags.flatMap { popup in flags.flatMap { inspector in
      flags.flatMap { terminal in flags.map { close in (popup, inspector, terminal, close) } } } }
  }()

  @Test("telefon: najwyżej trzy ikony — przy czterech system chował grupę w „⋯” przepełnienia, które nic nie robiło")
  func phoneFitsBar() {
    // Prawy panel na telefonie się nie mieści (`inspectorAvailable`), więc go tu nie ma.
    for input in Self.inputs where !input.inspector {
      let icons = HeaderTrailingIcons(
        popup: input.popup, inspector: false, terminal: input.terminal, sessionClose: input.close, compact: true)
      #expect(icons.count <= HeaderMetrics.trailingIconsMax, "\(input): \(icons.count) ikon")
    }
  }

  @Test("terminal screen on the phone: popup terminal, “⋯” and “×” fit in the bar, nothing moves to the menu")
  func phoneTerminalKeepsPopupInBar() {
    let icons = HeaderTrailingIcons(popup: true, inspector: false, terminal: true, sessionClose: false, compact: true)
    #expect(icons.popup && !icons.popupInMenu)
    #expect(icons.terminalMenu && icons.terminalClose && icons.count == 3)
    // An agent entry in Rarog's terminal: the session "×" instead of the terminal's, still three icons.
    let hosted = HeaderTrailingIcons(popup: true, inspector: false, terminal: true, sessionClose: true, compact: true)
    #expect(hosted.popup && !hosted.popupInMenu && hosted.sessionClose && !hosted.terminalClose)
    #expect(hosted.count == 3)
  }

  @Test("four icons on the phone: popup terminal moves to the terminal's “⋯” menu, iPad unchanged")
  func popupMovesToMenuOnlyWhenItDoesNotFit() {
    // Only a fourth icon (the right panel, if it ever fit on a phone) pushes the popup terminal into the menu.
    let crowded = HeaderTrailingIcons(popup: true, inspector: true, terminal: true, sessionClose: false, compact: true)
    #expect(!crowded.popup && crowded.popupInMenu && crowded.count == HeaderMetrics.trailingIconsMax)
    let session = HeaderTrailingIcons(popup: true, inspector: false, terminal: false, sessionClose: true, compact: true)
    #expect(session.popup && !session.popupInMenu, "session screen: two icons")
    for input in Self.inputs {
      let icons = HeaderTrailingIcons(
        popup: input.popup, inspector: input.inspector, terminal: input.terminal, sessionClose: input.close,
        compact: false)
      #expect(icons.popup == input.popup && !icons.popupInMenu, "iPad: \(input)")
    }
  }

  @Test("żadna akcja nie znika: „Terminal w oknie” stoi w pasku albo w menu, „×” zawsze jedno")
  func nothingLost() {
    for compact in [false, true] {
      for input in Self.inputs {
        let icons = HeaderTrailingIcons(
          popup: input.popup, inspector: input.inspector, terminal: input.terminal, sessionClose: input.close,
          compact: compact)
        #expect((icons.popup || icons.popupInMenu) == input.popup, "\(compact) \(input)")
        #expect(!(icons.popup && icons.popupInMenu), "\(compact) \(input): nie w obu miejscach")
        #expect(icons.popupInMenu ? icons.terminalMenu : true, "\(compact) \(input): menu stoi w pasku")
        let closes = (icons.terminalClose ? 1 : 0) + (icons.sessionClose ? 1 : 0)
        #expect(closes == (input.terminal || input.close ? 1 : 0), "\(compact) \(input): jedno „×”")
      }
    }
  }
}
