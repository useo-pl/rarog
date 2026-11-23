import CoreGraphics
import Foundation
@testable import RarogUI
import Testing

// Okna, dymki i formularze apki: wspólny szkielet arkusza i reguły, których pilnuje się w źródłach.
// Arkusz jest kontenerem systemu: bez własnego tła prezentacji, bez własnego szkła i bez własnego promienia;
// pasek, zamknięcie z lewej, odcień i rozmiar daje WYŁĄCZNIE szkielet. Lista
// `windowsOnScaffold` to okna na szkielecie. Wygląd na żywo sprawdza
// `WindowsUITests`.

@Suite("prezentacje: wspólny szkielet arkusza")
struct PresentationSourceTests {
  /// Okna stojące na szkielecie `WindowSheet`.
  static let windowsOnScaffold = [
    "Views/Header/DiffSheet.swift", "Terminal/TerminalHistorySheet.swift", "Session/TranscriptSelectionSheet.swift",
    "Session/Cards/ConsentInputSheet.swift",
  ]

  static func code(_ relative: String) throws -> String {
    try TerminalWindowChromeSourceTests.code(relative)
  }

  /// The New Session sheet with its section extensions (`+Project`, `+Start`, `+Conversations`), in that order.
  static func newSessionSheet() throws -> String {
    try ["", "+Project", "+Start", "+Conversations"]
      .map { try code("Views/NewSession/NewSessionSheet\($0).swift") }
      .joined(separator: "\n")
  }

  @Test("szkielet: pasek systemowy z zamknięciem z lewej, odcień, obrys i rozmiar okna — bez własnego tła i szkła")
  func scaffold() throws {
    let code = try Self.code("Views/Presentation/SheetScaffold.swift")
    #expect(code.contains("NavigationStack"), "pasek systemowy")
    #expect(code.contains("placement: .cancellationAction"), "zamknięcie z lewej")
    #expect(code.contains("Button(role: .close"), "rola zamknięcia")
    #expect(code.contains("systemImage: \"xmark\""), "jawny symbol (iOS 26.0 rysował tekst)")
    #expect(code.contains("placement: .principal"), "tytuł okna z nazwą projektu")
    #expect(code.contains(".windowFrame(width: windowWidth)"), "rama wspólna z oknem terminala")
    #expect(code.contains(".tint(Color(uiColor: Palette.text))"), "achromatyczny odcień")
    #expect(code.contains("ConcentricRectangle()"), "obrys w kształcie arkusza")
    #expect(code.contains("colorSchemeContrast"), "mocniejszy obrys przy „Zwiększ kontrast”")
    #expect(code.contains(".presentationSizing("), "wspólna szerokość okien")
    #expect(code.contains(".closesOnEscapeAndCommandW("), "Esc i Cmd+W zamykają")
    #expect(code.contains(".background { SheetKeyboardAnchor() }"), "okno bierze klawiaturę: skróty trafiają do niego")
    for banned in ["presentationBackground", "presentationCornerRadius", ".glassEffect(", "sharedBackgroundVisibility"] {
      #expect(!code.contains(banned), "szkielet bez `\(banned)`")
    }
  }

  @Test("okna na szkielecie nie mają własnego paska, rozmiaru, tła, promienia, szkła ani własnego Esc")
  func windows() throws {
    for file in Self.windowsOnScaffold {
      let code = try Self.code(file)
      #expect(code.contains("WindowSheet("), "\(file): wspólny szkielet")
      for banned in [
        "NavigationStack", ".presentationSizing(", "presentationBackground", "presentationCornerRadius",
        ".glassEffect(", ".dismissOnEscape", "cancellationAction", ".terminalWindowChrome(",
      ] {
        #expect(!code.contains(banned), "\(file): bez `\(banned)`")
      }
      // Kotwicę klawiatury stawia szkielet; w pliku historii ma ją jeszcze strona okna terminala (poza szkieletem).
      let anchors = code.components(separatedBy: "SheetKeyboardAnchor(").count - 1
      #expect(anchors == (file == "Terminal/TerminalHistorySheet.swift" ? 1 : 0), "\(file): kotwica klawiatury")
    }
  }

  @Test("historia: jedna treść dla okna z trasy i strony okna terminala; kopia z ptaszkiem, stopka nad rogiem")
  func history() throws {
    let code = try Self.code("Terminal/TerminalHistorySheet.swift")
    #expect(code.contains("struct TerminalHistoryPage: View"), "strona okna terminala")
    #expect(code.components(separatedBy: "TerminalHistoryBody(store: store, terminalId: terminalId, state: state)").count - 1 == 2,
            "okno i strona rysują tę samą treść")
    #expect(code.contains(".closesOnEscapeAndCommandW(back)"), "Esc i Cmd+W strony wracają do terminala")
    #expect(code.contains(".keyboardShortcut(AppShortcut.terminalHistory.keyboardShortcut)"), "Cmd+Y na stronie wraca")
    #expect(AppShortcut.terminalHistory.glyphs == "⌘Y")
    #expect(code.contains(".background { SheetKeyboardAnchor() }"), "strona bierze klawiaturę od terminala")
    let window = try Self.code("Terminal/TerminalWindow.swift")
    #expect(window.contains("navigationController?.pushViewController(page, animated: true)"), "strona, nie arkusz")
    #expect(window.contains("screen.inputSuspended = true"), "terminal pod stroną nie wysyła")
    #expect(code.contains("\"terminal.history.close\"") && code.contains("\"terminal.history.copy\""))
    #expect(code.contains("copied ? \"checkmark\" : \"doc.on.doc\""), "potwierdzenie podmianą ikony")
    #expect(code.contains("WindowLayout.scrollBottomInset"), "stopka nad łukiem rogu")
    #expect(!code.contains("HistoryIconButton"), "bez własnego nagłówka")
  }

  @Test("strony formularza notatki (porównanie, „Dyktowanie”) biorą klawiaturę: Return nie trafia pod arkusz")
  func notePagesTakeKeyboard() throws {
    let conflict = try Self.code("Views/Notes/NoteConflict.swift")
    #expect(conflict.contains(".background { SheetKeyboardAnchor() }"), "strona porównania")
    let sheet = try Self.code("Views/Notes/NoteSheet.swift")
    let page = try #require(sheet.components(separatedBy: "struct NoteDictationPage: View").dropFirst().first)
    let body = page.components(separatedBy: "\nstruct ").first ?? page
    #expect(body.contains(".background { SheetKeyboardAnchor() }"), "strona „Dyktowanie”")
  }

  /// Without an anchor on a pushed Settings page the keyboard goes to the field under the sheet: letters would land
  /// in the message field and Esc and Cmd+W would miss the sheet.
  @Test("Settings pages take the keyboard: one anchor on every page of the list, and on the pages above them")
  func settingsPagesTakeKeyboard() throws {
    let sheet = try Self.code("Views/Settings/SettingsSheet.swift")
    let destination = try #require(sheet.components(separatedBy: ".navigationDestination(item:").dropFirst().first)
    let pages = destination.components(separatedBy: "\n      }\n").first ?? destination
    #expect(pages.contains(".background { SheetKeyboardAnchor() }"), "every page of the list")
    let about = try Self.code("Views/Settings/SettingsAboutPage.swift")
    #expect(about.contains(".background { SheetKeyboardAnchor() }"), "Licenses above About")
    let voice = try Self.code("Views/VoiceAgent/VoiceAgentSettingsPage.swift")
    #expect(voice.contains(".background { SheetKeyboardAnchor() }"), "consent above Voice Agent")
  }

  @Test("Esc i Cmd+W arkusza to dwa skróty na niewidocznych przyciskach; okno terminala ich nie używa")
  func shortcuts() throws {
    let code = try Self.code("Views/Presentation/EscapeDismiss.swift")
    #expect(code.contains(".keyboardShortcut(AppShortcut.dismissSheet.keyboardShortcut)"))
    #expect(code.contains(".keyboardShortcut(AppShortcut.closeSheet.keyboardShortcut)"))
    #expect(AppShortcut.dismissSheet.glyphs == "Esc" && AppShortcut.dismissSheet.modifiers.isEmpty, "Esc arkusza")
    #expect(AppShortcut.closeSheet.glyphs == "⌘W")
    let popup = try Self.code("Terminal/TerminalWindow.swift")
    #expect(!popup.contains("closesOnEscapeAndCommandW"), "w terminalu Cmd+W należy do programu")
    #expect(!popup.contains(".dismissOnEscape"), "Esc okna terminala rozstrzyga kontroler")
  }

  /// `.sheet(` poza `SheetHost`: nikt. Historia nad oknem terminala jest stroną tego okna.
  static let sheetExceptions: [String] = []

  @Test("jeden arkusz naraz: `.sheet(` i `.fullScreenCover(` tylko w `SheetHost`, związany ze stanem nawigacji")
  func oneSheet() throws {
    let root = TerminalWindowChromeSourceTests.sources
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    var presenters: [String] = []
    for case let file as URL in files where file.pathExtension == "swift" {
      let relative = String(file.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
      let code = try Self.code(relative)
      if code.contains(".sheet(") || code.contains(".fullScreenCover(") { presenters.append(relative) }
    }
    #expect(presenters.sorted() == (["Views/Presentation/SheetHost.swift"] + Self.sheetExceptions).sorted())
    let host = try Self.code("Views/Presentation/SheetHost.swift")
    #expect(host.components(separatedBy: ".sheet(").count - 1 == 1, "jeden punkt prezentacji")
    #expect(host.contains(".sheet(item: item)"))
    #expect(host.contains("get: { navigation.sheet }"), "stan trzyma nawigacja")
    #expect(host.contains("navigation.sheetDismissed(shown: shown)"), "gest zamyka arkusz, który stoi")
    #expect(host.contains("navigation.orphanedSheet(store.state)"), "diff bez sesji schodzi")
    #expect(host.contains(".id(sheet.id)"), "nowe otwarcie = nowa prezentacja")
    let split = try Self.code("Views/RarogRootView.swift")
    #expect(split.contains(".modifier(SheetHost(store: store, navigation: navigation))"))
    #expect(split.contains("if !loggedIn { navigation.dropSheet() }"), "arkusz nie przeżywa wylogowania")
    // Okno diffa pobiera samo i tylko to, co człowiek rozwinie; prezentujący nie pobierają niczego.
    let diff = try Self.code("Views/Header/DiffSheet.swift")
    #expect(diff.contains("@State private var model: DiffWindowModel"), "okno diffa pobiera samo")
    #expect(diff.contains("store.sessionDiffFiles(") && diff.contains("store.sessionDiffFile("), "lista i patch pliku")
    #expect(diff.contains(".task {") && !diff.contains(".task(id:"), "jeden przebieg odczytów; zamknięcie go anuluje")
    for file in ["Views/Header/DiffSheet.swift", "Views/Header/GitDetailsPanel.swift", "Views/Header/SessionStatusBar.swift",
                 "Views/Inspector/InspectorPanel.swift", "Views/Inspector/InspectorPanel+Sheet.swift", "Model/AppSheet.swift"] {
      let code = try Self.code(file)
      #expect(!code.contains("store.sessionDiff("), "\(file): bez diffa całej sesji jednym żądaniem")
      #expect(!code.contains("DiffSeed") && !code.contains("GitDiffLoader"), "\(file): bez ziarna i dawnego loadera")
    }
    for file in ["Views/Header/GitDetailsPanel.swift", "Views/Header/GitChangesSection.swift", "Views/Inspector/InspectorPanel.swift"] {
      #expect(!(try Self.code(file)).contains("sessionDiff"), "\(file): dymek i panel diffa nie pobierają")
    }
  }

  @Test("przyciski: żadnego systemowego `.bordered` ani `.borderedProminent` w RarogUI; akcja główna jednym stylem")
  func buttons() throws {
    let root = TerminalWindowChromeSourceTests.sources
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    for case let file as URL in files where file.pathExtension == "swift" {
      let relative = String(file.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
      let code = try Self.code(relative)
      #expect(!code.contains("buttonStyle(.bordered"), "\(relative): style apki zamiast systemowych")
    }
    let styles = try Self.code("Session/Buttons.swift")
    #expect(styles.contains("struct PrimaryButtonStyle: ButtonStyle"))
    #expect(styles.contains("isEnabled ? Palette.background : Palette.muted2"), "wygaszona: etykieta `muted2`")
    #expect(styles.contains("Capsule().strokeBorder(Color(uiColor: Palette.border)).opacity(isEnabled ? 0 : 1)"),
            "wygaszona: sam obrys, bez wypełnienia")
    #expect((try Self.code("Views/NewSession/NewSessionSheet.swift")).contains(".buttonStyle(PrimaryButtonStyle(size: size))"))
    let model = try Self.code("Views/Header/ModelSheet.swift")
    #expect(model.contains(".buttonStyle(PrimaryButtonStyle())") && !model.contains("ApplyButtonStyle"))
    let resume = try Self.code("Views/NewSession/ResumeRowView.swift")
    #expect(!resume.contains("FilledButtonStyle") && !resume.contains("Palette.accent"), "wiersze bez plam akcentu")
    // Wiersz w jednej linii: cel to cały wiersz, obok tylko „Rozwidl” w atramencie tekstu.
    #expect(resume.contains("OutlineButtonStyle(color: Color(uiColor: Palette.text))"), "„Rozwidl” jedynym przyciskiem obok")
    #expect(!resume.contains("OutlineButtonStyle(color: Color(uiColor: Palette.muted))"), "bez osobnego „Otwórz sesję”")
  }

  @Test("formularze: wspólny szkielet z zamknięciem z lewej, Esc i Cmd+W, blokadą w trakcie żądania; stopka na tle arkusza; nagłówki sekcji systemowe")
  func forms() throws {
    let scaffold = try Self.code("Views/Presentation/SheetScaffold.swift")
    #expect(scaffold.contains("struct FormSheet<Content: View>: View"))
    #expect(scaffold.contains("Button(role: discards ? .cancel : .close, action: close.action)"), "rola według skutku")
    #expect(scaffold.contains(".interactiveDismissDisabled(locked)"), "gest i tap obok zablokowane w trakcie żądania")
    #expect(scaffold.contains(".closesOnEscapeAndCommandW { if !locked { close.action() } }"), "Esc i Cmd+W też")
    #expect(scaffold.contains(".disabled(locked)"), "przycisk zamknięcia wygaszony")
    #expect(scaffold.contains(".presentationSizing(.form)"))
    let newSession = try Self.newSessionSheet()
    #expect(newSession.contains("discards: true, locked: requesting"), "„Nowa sesja” traci dane")
    // Blokady nie da się obejść treścią formularza: jeden stan żądania wygasza formularz i akcje, które go zamykają.
    #expect(newSession.contains("var requesting: Bool { launching || resuming }"))
    #expect(newSession.contains(".disabled(requesting)"), "treść formularza wygaszona na czas żądania")
    #expect(newSession.components(separatedBy: "guard !requesting else { return }").count - 1 == 3,
            "„Uruchom”, „Wznów”/„Rozwidl” i „Otwórz sesję” nie ruszają przy żądaniu w drodze")
    #expect(newSession.contains(".formFooterBar()") && !newSession.contains(".opaqueBar()"), "stopka na tle arkusza")
    let recent = try Self.code("Views/NewSession/RecentSessionsSheet.swift")
    #expect(recent.contains("locked: busy != nil") && recent.contains("\"recent.close\""))
    for (file, code) in [("NewSessionSheet", newSession), ("RecentSessionsSheet", recent)] {
      #expect(code.contains("FormSheet("), "\(file): wspólny szkielet")
      for banned in ["NavigationStack", ".presentationSizing(", "cancellationAction", "presentationBackground"] {
        #expect(!code.contains(banned), "\(file): bez `\(banned)`")
      }
    }
    // Nagłówek `Section` formularza systemowy, jak w Ustawieniach: bez `.eyebrow()`, które zostaje
    // etykietą kart, dymków i inspektora. Kolor wyciszony `Palette.muted` (AA), nie systemowa szarość.
    let root = TerminalWindowChromeSourceTests.sources
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    for case let file as URL in files where file.pathExtension == "swift" {
      let relative = String(file.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
      for header in Self.sectionHeaders(try Self.code(relative)) {
        #expect(!header.contains(".eyebrow("), "\(relative): nagłówek `Section` formularza bez `.eyebrow()`")
      }
    }
    let headers = Self.sectionHeaders(newSession)
    #expect(headers.count == 3, "„Nowa sesja”: Projekt, Start, Rozmowy")
    for header in headers {
      #expect(header.contains(".foregroundStyle(Color(uiColor: Palette.muted))"), "nagłówek w wyciszonym atramencie")
    }
    #expect(headers.last?.contains(".accessibilityIdentifier(\"newSession.resumeHeader\")") == true,
            "identyfikator nagłówka rozmów zostaje")
  }

  /// Treść bloków `header: { … }` (do domykającego nawiasu) w kodzie bez komentarzy.
  static func sectionHeaders(_ code: String) -> [String] {
    code.components(separatedBy: "header: {").dropFirst().map { tail in
      var depth = 1
      var end = tail.endIndex
      for index in tail.indices {
        switch tail[index] {
        case "{": depth += 1
        case "}": depth -= 1
        default: continue
        }
        if depth == 0 { end = index; break }
      }
      return String(tail[..<end])
    }
  }

  @Test("wiersz rozmowy: w wąskim arkuszu w pionie tylko tekst, plama poza treścią")
  func resumeRow() throws {
    let row = try Self.code("Views/NewSession/ResumeRowView.swift")
    // Kolumnę bierze tylko tekst; koło ▶ stało w niej w osobnej, trzeciej linii.
    #expect(row.contains("let line = large\n"), "▶ i znacznik schodzą pod tekst tylko w piśmie dostępności")
    #expect(row.contains("let text = large || stacked\n"))
    // Plama wskaźnika wychodzi poza treść, a ujemny odstęp oddaje to miejsce.
    #expect(row.contains(".padding(.horizontal, Self.hoverOutset)\n          .contentShape(Rectangle())\n"
      + "          .rarogHover(.fill"), "plama na treści z odstępem")
    #expect(row.contains(".padding(.horizontal, -Self.hoverOutset)"), "układ wiersza bez zmian")
    #expect(row.contains("spacing: 8 + Self.hoverOutset"), "„Rozwidl” za plamą, nie na jej krawędzi")
  }

  @Test("New Session browser: the whole row opens the directory, compact rows, Up before the path")
  func directoryBrowserRows() throws {
    let project = try Self.code("Views/NewSession/NewSessionSheet+Project.swift")
    // One target per row: the trailing chevron is only a sign, not a second button.
    #expect(project.components(separatedBy: "browser.enter(entry.path)").count == 2, "the row opens its directory")
    #expect(!project.contains("newSession.enter.") && !project.contains("browser.select("), "no › button, no selection")
    // ~44 pt rows: the 44 pt target comes from the row content, the list adds no vertical inset.
    #expect(project.contains(".listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))"))
    #expect(project.contains(".frame(minHeight: Self.dirRowHeight)"))
    #expect(project.contains("static let dirRowHeight: CGFloat = 44"))
    let sheet = try Self.code("Views/NewSession/NewSessionSheet.swift")
    #expect(sheet.contains(".environment(\\.defaultMinListRowHeight, browser.browsing ? Self.dirRowHeight : formRowHeight)"),
            "the form's 52 pt minimum row height does not apply while browsing")
    // Up stands at the leading edge of the path row and is disabled where there is nowhere to go.
    #expect(project.contains("browser.goUp()") && project.contains(".disabled(browser.up == nil)"))
    #expect(project.contains("UICopy.upSpoken(browser.up)") && project.contains("\"newSession.up\""))
    #expect(!project.contains(".defaultScrollAnchor(.trailing)\n"), "the path is leading-aligned when it fits")
  }

  @Test("„Nowa sesja”: zdanie o koszcie ultracode tylko przy włączonym przełączniku, bez animacji")
  func ultracodeNoteOnlyWhenOn() throws {
    let code = try Self.newSessionSheet()
    // Wyłączony przełącznik to wiersz jednej linii: trzy linie zdania spychałyby na iPadzie „Rozmowy” pod zgięcie
    // arkusza, a lista rozmów ma stać nad zgięciem.
    #expect(code.contains("if settings.ultracode {\n        Text(UICopy.ultracodeStartNote)"), "zdanie tylko przy włączonym")
    #expect(code.components(separatedBy: "UICopy.ultracodeStartNote").count == 2, "zdanie w jednym miejscu arkusza")
    // Reszta formularza pokazuje i chowa treść bez animacji (wiersz projektu, przeglądarka), więc zdanie też.
    #expect(!code.contains("withAnimation") && !code.contains(".animation("), "bez animacji")
  }

  @Test("dymki: wysokość ze zmierzonej treści do sufitu 600 pt; arkusz telefonu bez wysokości; prompty z liczby wierszy")
  func popoverHeights() {
    #expect(PopoverLayout.idealHeight(content: 180, ceiling: 600) == 180, "dwa pliki nie zostawiają pustego pasa")
    #expect(PopoverLayout.idealHeight(content: 180, footer: 45, ceiling: 600) == 225, "stopka dolicza się do treści")
    #expect(PopoverLayout.idealHeight(content: 900, footer: 45, ceiling: 600) == 600, "dłuższa treść przewija się w środku")
    #expect(PopoverLayout.idealHeight(content: 0, ceiling: 600) == PopoverLayout.minHeight, "przed pomiarem: najniższy")
    #expect(PopoverLayout.idealHeight(content: .infinity, ceiling: 600) == PopoverLayout.minHeight)
    #expect(PopoverLayout.idealHeight(content: 300, footer: 45, ceiling: nil) == nil, "telefon: wysokość daje detent")
    #expect(PopoverLayout.promptsHeight(rows: 1) == 116, "jeden prompt bez pustego pasa pod spodem")
    #expect(PopoverLayout.promptsHeight(rows: 5) == 356)
    #expect(PopoverLayout.promptsHeight(rows: 40) == PopoverLayout.ceiling)
    #expect(PopoverLayout.promptsHeight(rows: 0) == PopoverLayout.promptsHeight(rows: 1))
    // Pismo dostępności: wiersz i etykieta skalowane metryką pisma — jeden prompt dalej się mieści.
    #expect(PopoverLayout.promptsHeight(rows: 1, rowHeight: 150, header: 90) == 252)
    #expect(PopoverLayout.promptsHeight(rows: 1, rowHeight: 20, header: 10) == 116, "nigdy mniej niż przy domyślnym")
    #expect((PopoverLayout.minWidth, PopoverLayout.idealWidth, PopoverLayout.maxWidth) == (320, 420, 560))
  }

  @Test("dymki: wspólny rozmiar i pasek arkusza na telefonie bez „×”; bez własnych ram i bez przycisku w treści gita")
  func popovers() throws {
    for file in ["Views/Header/GitDetailsPanel.swift", "Views/Header/BackgroundTasksPanel.swift", "Views/Header/ModelSheet.swift"] {
      let code = try Self.code(file)
      #expect(code.contains(".popoverLayout("), "\(file): rozmiar z `PopoverLayout`")
      #expect(!code.contains("idealWidth:") && !code.contains("idealHeight:"), "\(file): bez własnej ramy")
      #expect(code.contains("PopoverLayout.contentInset"), "\(file): wcięcie treści 20 pt")
    }
    for file in ["Views/Header/SessionStatusBar.swift", "Views/Header/SessionPills.swift", "Session/ComposerPills.swift",
                 "Views/Inspector/InspectorPanel+Sheet.swift"] {
      let code = try Self.code(file)
      #expect(code.contains(".popoverSheetChrome(title:"), "\(file): na telefonie pasek arkusza z tytułem")
      #expect(!code.contains(".presentationDetents("), "\(file): detenty daje wspólny modyfikator")
    }
    let layout = try Self.code("Views/Presentation/PopoverLayout.swift")
    // Na telefonie bez „×”: zamyka uchwyt, tap nad arkuszem i gest
    // „wstecz” czytnika (bierze go system: `UITransitionView`, sonda `probe.axescape`).
    for banned in ["cancellationAction", "xmark", "popover.close", "UICopy.popoverClose", "role: .close"] {
      #expect(!layout.contains(banned), "pasek dymka na telefonie bez przycisku zamknięcia: `\(banned)`")
    }
    #expect(layout.contains("func popoverSheetChrome(title: String, fitsContent: Bool = false) -> some View"),
            "bez akcji zamknięcia w pasku")
    #expect(layout.contains(".presentationDetents([.medium, .large])") && layout.contains(".presentationDragIndicator(.visible)"))
    // Pasek zależy od urządzenia, nie od klasy szerokości: gałąź nie może zmienić się przy otwartym dymku.
    #expect(layout.contains("if PopoverLayout.sheetBar { bar(content) } else { content }"))
    #expect(layout.contains("UIDevice.current.userInterfaceIdiom == .phone") && !layout.contains("compact"))
    let git = try Self.code("Views/Header/GitDetailsPanel.swift")
    #expect(git.contains("PopoverFooterRow(") && git.contains("\"header.git.diff\""), "„Pokaż diff” w stopce dymka")
    #expect(!(try Self.code("Views/Header/GitChangesSection.swift")).contains(".buttonStyle(.bordered)"))
    #expect((try Self.code("Views/Header/BackgroundTasksPanel.swift")).contains("PopoverFooterRow("), "ta sama stopka")
    #expect(!(try Self.code("Views/Header/ModelSheet.swift")).contains("UICopy.modelSheetTitle"), "bez nagłówka w treści")
    let prompts = try Self.code("Session/SessionViewController+PromptBar.swift")
    #expect(prompts.contains("PopoverLayout.promptsHeight("), "dymek promptów tak wysoki jak lista")
    #expect(prompts.contains("relativeTo: .subheadline"), "wysokość rośnie z pismem")
    #expect(prompts.contains("adaptiveSheetPresentationController"), "na telefonie detenty i uchwyt")
    let list = try Self.code("Session/PromptBarView.swift")
    #expect(list.contains(".popoverSheetChrome(title: UICopy.promptsTitle)"))
    #expect(!list.contains("NavigationStack"), "na iPadzie bez paska tytułu")
  }

  @Test("dolny odstęp treści od rogu: 6 pt do łuku przy wcięciu 16 pt; nigdy mniej niż 8 pt")
  func bottomInset() {
    // Promień arkusza iPada z pomiaru: 32 pt → 12 pt (11,51 w górę).
    #expect(WindowLayout.bottomInset(radius: 32) == 12)
    #expect(WindowLayout.scrollBottomInset == 12)
    // Stary własny promień 12 pt: treść 16 pt od boku stoi poza strefą rogu.
    #expect(WindowLayout.bottomInset(radius: 12) == WindowLayout.minimumBottomInset)
    #expect(WindowLayout.bottomInset(radius: 0) == WindowLayout.minimumBottomInset)
    #expect(WindowLayout.bottomInset(radius: .infinity) == WindowLayout.minimumBottomInset)
    // Większy promień (arkusz iPhone'a u góry 38 pt, dymek 34 pt) → większy odstęp.
    #expect(WindowLayout.bottomInset(radius: 34) == 13)
    #expect(WindowLayout.bottomInset(radius: 38) == 15)
    // Wcięcie boczne mniejsze niż zapas: treść wychodzi nad całą strefę rogu i odsuwa się od końca łuku
    // (punkt (0, 32)): √(4² + 5²) ≥ 6, więc 32 + 4,47 w górę.
    #expect(WindowLayout.bottomInset(radius: 32, sideInset: 4) == 37)
    #expect(WindowLayout.bottomInset(radius: 32, sideInset: 6) == 32, "wcięcie równe zapasowi: koniec łuku")
    // Reguła trzyma dla każdego promienia i wcięcia: narożnik treści leży co najmniej 6 pt od łuku.
    for radius: CGFloat in [20, 24, 28, 32, 36, 40, 44, 50] {
      for side: CGFloat in [2, 4, 6, 8, 12, 16, 24] {
        let bottom = WindowLayout.bottomInset(radius: radius, sideInset: side)
        #expect(Self.arcDistance(radius: radius, side: side, bottom: bottom) >= WindowLayout.cornerGap - 0.001,
          "promień \(radius), wcięcie \(side): odstęp \(bottom)")
      }
    }
  }

  @Test("dolny odstęp okna terminala: narożnik siatki dotyka łuku rogu, bez zapasu i bez minimum 8 pt")
  func terminalBottomInset() {
    // iPad 32 pt: 32 − √(32² − 16²) = 4,29 → 5 pt (okna historii i diffa zostają przy 12 pt).
    #expect(WindowLayout.terminalBottomInset(radius: 32) == 5)
    #expect(WindowLayout.bottomInset(radius: 32) == 12, "historia i diff bez zmian")
    #expect(WindowLayout.terminalBottomInset(radius: 34) == 6)
    #expect(WindowLayout.terminalBottomInset(radius: 38) == 8)
    // Treść poza strefą rogu albo róg bez promienia: siatka do samej krawędzi.
    #expect(WindowLayout.terminalBottomInset(radius: 16) == 0)
    #expect(WindowLayout.terminalBottomInset(radius: 12) == 0)
    #expect(WindowLayout.terminalBottomInset(radius: 0) == 0)
    #expect(WindowLayout.terminalBottomInset(radius: .infinity) == 0)
    // Narożnik treści 16 pt od boku nigdy nie przekracza łuku i stoi przy nim (zaokrąglenie w górę: mniej niż 1 pt).
    for radius: CGFloat in [20, 24, 28, 32, 36, 40, 44, 50] {
      let bottom = WindowLayout.terminalBottomInset(radius: radius)
      let distance = Self.arcDistance(radius: radius, side: WindowLayout.sideInset, bottom: bottom)
      #expect(distance >= -0.001 && distance < 1, "promień \(radius): odstęp \(bottom), od łuku \(distance)")
      #expect(bottom <= WindowLayout.bottomInset(radius: radius), "promień \(radius): nigdy wyżej niż inne okna")
    }
  }

  /// Odległość punktu (`side` od boku, `bottom` od dołu) od łuku rogu o promieniu `radius` (ćwiartka koła ze
  /// środkiem w (radius, radius)); poza strefą rogu — od najbliższego końca łuku.
  static func arcDistance(radius: CGFloat, side: CGFloat, bottom: CGFloat) -> CGFloat {
    if side >= radius && bottom >= radius { return .infinity }
    if side < radius && bottom < radius {
      let across = radius - side
      let down = radius - bottom
      return radius - (across * across + down * down).squareRoot()
    }
    // Nad strefą rogu: koniec łuku na bocznej krawędzi (0, radius); obok niej: koniec na dolnej (radius, 0).
    return bottom >= radius
      ? (side * side + (bottom - radius) * (bottom - radius)).squareRoot()
      : ((side - radius) * (side - radius) + bottom * bottom).squareRoot()
  }
}
