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
  /// Every input combination the header meets: project (popup terminal), right panel, terminal screen, and whether the
  /// terminal has a tab bar. The right panel toggle never stands on a terminal route (`inspectorSession`); the Recent
  /// Sessions clock stands in the project header of the list; the session "×" stands in the current tab.
  private static let inputs: [(popup: Bool, inspector: Bool, terminal: Bool, corner: Bool)] = {
    let flags = [false, true]
    return flags.flatMap { popup in
      [(false, false), (true, false), (false, true)].flatMap { inspector, terminal in
        flags.map { corner in (popup, inspector, terminal, corner) }
      }
    }
  }()

  @Test("at most three icons: with four the system hid the group in the bar's overflow “⋯”, which did nothing")
  func fitsBar() {
    for input in Self.inputs {
      for voice in [false, true] {
        let icons = HeaderTrailingIcons(
          voiceSessions: voice, popup: input.popup, inspector: input.inspector, terminal: input.terminal,
          closeInCorner: input.corner)
        #expect(icons.count <= HeaderMetrics.trailingIconsMax, "\(input), voice \(voice): \(icons.count) icons")
        #expect(icons.voiceSessions == voice, "\(input): the lit circle stands while the conversation runs")
        #expect(icons.inspector == input.inspector && icons.terminalMenu == input.terminal, "\(input), voice \(voice)")
        // Only the circle as a fourth icon makes “Pop-Up Terminal” give way; Cmd+F still opens the window.
        let fourth = voice && [input.popup, input.inspector, input.terminal, input.terminal && input.corner]
          .filter { $0 }.count == HeaderMetrics.trailingIconsMax
        #expect(icons.popup == (input.popup && !fourth), "\(input), voice \(voice): “Pop-Up Terminal”")
      }
    }
  }

  // Catches: the circle that would be a fourth icon on a terminal screen without a tab bar (Pop-Up Terminal, “⋯”,
  // “×”), so the system hid the whole group, End and the terminal's “×” with it, in the bar's overflow.
  @Test("a terminal without a tab bar: Pop-Up Terminal gives way to the lit circle while the conversation runs")
  func voiceSessionsOnTerminalWithoutBar() {
    let icons = HeaderTrailingIcons(
      voiceSessions: true, popup: true, inspector: false, terminal: true, closeInCorner: true)
    #expect(icons.voiceSessions && !icons.popup && icons.terminalMenu && icons.terminalClose)
    let session = HeaderTrailingIcons(
      voiceSessions: true, popup: true, inspector: true, terminal: false, closeInCorner: false)
    #expect(session.voiceSessions && session.popup && session.inspector, "the session screen keeps all three")
  }

  @Test("terminal screen: “⋯” in the corner; its “×” there only without a tab bar, else in the current tab")
  func terminalCloseOnlyWithoutBar() {
    let withBar = HeaderTrailingIcons(
      voiceSessions: false, popup: true, inspector: false, terminal: true, closeInCorner: false)
    #expect(withBar.terminalMenu && !withBar.terminalClose && withBar.count == 2)
    let withoutBar = HeaderTrailingIcons(
      voiceSessions: false, popup: false, inspector: false, terminal: true, closeInCorner: true)
    #expect(withoutBar.terminalMenu && withoutBar.terminalClose && withoutBar.count == 2)
    let session = HeaderTrailingIcons(
      voiceSessions: false, popup: true, inspector: true, terminal: false, closeInCorner: false)
    #expect(!session.terminalMenu && !session.terminalClose && session.count == 2, "session screen: no “×” in the corner")
  }
}
