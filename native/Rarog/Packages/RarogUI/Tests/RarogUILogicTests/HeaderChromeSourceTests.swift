import Foundation
import Testing

// Strażnik źródeł nagłówka i paska listy: chipy linii statusu bez obrysu, „Nowa sesja"
// w stylu ikon nagłówka z tym samym celem dotyku. Właściciel: nagłówek i lista.

@Suite("nagłówek i pasek listy: strażnik źródeł")
struct HeaderChromeSourceTests {
  /// Kod bez komentarzy (jak `SessionListSourceTests.code`).
  private static func code(_ relative: String) throws -> String {
    try SessionListSourceTests.code(relative)
  }

  @Test("chipy „w tle” i „↑ wersja CLI” bez obrysu; pigułki pola wiadomości zostają z obrysem (domyślnie)")
  func chipsWithoutBorder() throws {
    let code = try Self.code("Views/Header/SessionPills.swift")
    #expect(code.contains("var bordered = true"), "obrys domyślnie — pigułki pola bez niego znikają na karcie")
    #expect(code.contains("if bordered { Capsule().strokeBorder("), "obrys tylko na żądanie")
    #expect(code.components(separatedBy: "bordered: false").count - 1 == 2, "dokładnie dwa chipy bez obrysu")
    // Kropka „w tle" to znak pracy: przy samych subagentach w postoju pigułka stoi bez niej.
    #expect(code.contains("tone: .run, leadingDot: badge.working ? Palette.run : nil, bordered: false"), "„w tle”")
    #expect(code.contains("UICopy.cliUpdatePill(update.installed), tone: .run, bordered: false"), "„↑ wersja CLI”")
  }

  @Test("„Nowa sesja” jak ikony nagłówka: ten sam styl, bez szklanej kapsuły paska")
  func newSessionLikeHeader() throws {
    let host = try Self.code("Views/NewSession/NewSessionListButton.swift")
    #expect(host.contains(".buttonStyle(HeaderIconButtonStyle())"))
    #expect(host.contains(".sharedBackgroundVisibility(.hidden)"))
    #expect(host.contains(".shortcutTip(UICopy.newSessionTitle, .newSession)"), "podpowiedź „Nowa sesja (⌘N)”")
    let style = try Self.code("Views/Header/HeaderIconButton.swift")
    #expect(style.contains("minWidth: HeaderMetrics.iconTarget, minHeight: HeaderMetrics.iconTarget"), "cel bez zmian")
    let tabs = try Self.code("Views/Projects/ProjectTabBar.swift")
    // Odczyt wskaźnika w etykiecie `Menu` nie zapalał płytki na iPadzie: stoi nad menu.
    #expect(tabs.contains("RarogHoverReader(enabled: !addBusy) { hovered in\n      Menu {"), "wskaźnik „+” nad menu")
  }

  @Test("klawisz skrótu na zakładce: cyfry z numeracji menu; bieżąca wraca na środek przy każdej zmianie szerokości")
  func tabShortcutKeys() throws {
    let tabs = try Self.code("Views/Projects/ProjectTabBar.swift")
    // Klawiatura zmienia szerokość zakładek; pierwszy układ paska na iPhonie też (`onAppear` nie wystarcza).
    #expect(tabs.contains(
      ".onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.width } action: { _, width in recenter(content: width) }"),
      "środkowanie przy zmianie szerokości treści")
    #expect(tabs.contains(".onChange(of: currentId) { slide(to: currentId) }"),
            "centring on a change of the current tab, on the clock of the “×” rooms")
    #expect(tabs.contains("DispatchQueue.main.async { center() }"), "drugi raz po układzie paska świeżo na stosie")
    let slot = try Self.code("Views/Header/HeaderTabsSlot.swift")
    #expect(slot.contains("ShortcutMenu.tabDigits(tabs.compactMap(\\.target), hardwareKeyboard: hardwareKeyboard)"),
            "jedno źródło numeracji i jedna reguła widoczności")
  }

  @Test("bez kreski stanu pod etykietą; znak przed etykietą z jednej reguły, kolory z `TabTokens`")
  func tabsWithoutUnderline() throws {
    let tabs = try Self.code("Views/Projects/ProjectTabBar.swift")
    #expect(!tabs.contains("Capsule()"), "kreska stanu pod etykietą zniknęła")
    #expect(tabs.contains("switch tab.mark(digit: digit)"), "kafelek, kwadracik albo nic: `ProjectTabModel.mark`")
    #expect(tabs.contains("TabTokens.key(tone)") && tabs.contains("TabTokens.square(tone)"), "kolory z jednego miejsca")
    #expect(tabs.contains("Palette.tabPlate"), "płytka bieżącej z tokenu")
  }

  @Test("wygaszenie krawędzi przewiniętego paska: maska z geometrii scrolla, od wcięcia treści")
  func tabsEdgeFade() throws {
    let tabs = try Self.code("Views/Projects/ProjectTabBar.swift")
    #expect(tabs.contains(".mask {\n      TabEdgeMaskFollow(\n        fade: fade,"), "maska na scrollu paska, tło paska poza nią")
    #expect(tabs.contains("TabTokens.edgeFade("), "krycie z jednej reguły")
    #expect(tabs.contains("leadingInset: geometry.contentInsets.leading"), "na iPadzie ramka paska sięga pod listę sesji")
  }
}
