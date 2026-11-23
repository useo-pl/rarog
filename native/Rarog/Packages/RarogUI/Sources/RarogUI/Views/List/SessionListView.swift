#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Kontener listy sesji: drzewo projektów, szkielet, nagłówek z „łączę…”, baner i stopka.
// Właściciel: kontener; wiersz w `SessionRow`, wiersze drzewa w `ProjectTreeList`, stopka w `ListFooter`.

/// Lista sesji jako drzewo projektów: nagłówki projektów w kolejności doby aktywności i alfabetu, pod nimi
/// agenci od najstarszego, projekty zwijane wyłącznie ręcznie.
///
/// The filter segments over the list (`ListFilterBar`) hide the rows outside the chosen segment and never reorder
/// the rest (`AppState.projectTree(collapsed:filter:held:)`).
///
/// The footer card floats over the list (`safeAreaBar`), and the last agent scrolls above it.
/// Lista żyje w kolumnie bocznej przez cały czas
/// (także zwinięta Cmd+B), więc powrót z sesji zastaje ją w miejscu, w którym ją zostawiono
/// — kontener nie zmienia jej tożsamości ani nie przewija jej sam; drzewo przewija wyłącznie po to,
/// żeby zaznaczona sesja została co do punktu w tym samym miejscu, gdy zmieniają się wiersze drzewa (`TreeListAnchor`).
/// In the stack, coming back from a session or terminal centers the last opened row once when none of it is on
/// screen (`TreeReturnScroll`).
/// A pill at the bottom or top edge says how many rows that need the human stand below or above the visible part and
/// scrolls to the nearest (`ListJumpPillTracker`, `ListJumpPillView`).
/// Ręczne zwinięcie albo rozwinięcie jednego projektu nie przewija: nagłówek stoi, a wiersze
/// rosną albo znikają pod nim (`TreeToggleGesture.project`).
struct SessionListView: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let memory: ConnectionMemory
  /// The viewed session's stream memory: a session stream that does not come online puts the gray card here too.
  var transcriptLink = TranscriptConnectionMemory()
  /// The list stands beside the detail (iPad, wide window), not as a stack (iPhone, narrow window). Beside the detail
  /// the open session's row carries the plate; in the stack the last opened session's row does
  /// (`ListRowHighlight`). The root reads the window size: the `NavigationSplitView` side column always gets
  /// `compact` from the system.
  var besideDetail = true
  /// The whole column and its bottom safe area (home indicator, without the keyboard): the footer card's distance
  /// from the screen edge.
  @State private var column = ListColumnGeometry()
  /// Kotwica zaznaczonej sesji w drzewie (`TreeListAnchor`) — bez obserwacji: przewijanie nie rysuje listy od nowa.
  /// Nie prywatna, żeby test UIKit mógł podać własną (ślad zdarzeń, przełącznik `enabled`) i zwijać projekty tą samą
  /// drogą co strzałka (`ProjectTreeRows.toggle`); apka jej nie podaje.
  @State var treeAnchor = TreeListAnchor()
  /// Scroll to the last opened row on the return from a session in the stack (`TreeReturnScroll`), without
  /// observation like the anchor.
  @State private var returnScroll = TreeReturnScroll()
  /// The jump pills' count on the live collection (`ListJumpPillTracker`). Not private, so a UIKit test can hold it
  /// and tap a pill the way the button does; the app does not pass one.
  @State var jumpPill = ListJumpPillTracker()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  /// Hardware keyboard: only with it the active project's rows show their tab digits, like the strip's keys.
  @State private var hardwareKeyboard = TerminalKeyboard.isConnected()
  /// Renaming a session in place on its row (`SessionRenamer`).
  @State private var renamer = SessionRenamer()

  /// Tło kolumny: bok iPada obok sesji (`--sidebar`) albo ekran listy w stosie (`--bg`).
  private var columnFill: UIColor { besideDetail ? Palette.sidebar : Palette.background }

  var body: some View {
    let state = store.state
    layoutList(state)
    .listStyle(.sidebar)
    // Zwijanie listy mieszka w nagłówku sesji (`HeaderListToggle`), więc systemowego uchwytu w pasku listy
    // obok „Nowej sesji” nie ma. Zdjęty TU, na samej liście: ten sam modyfikator na kolumnie (`MainSplitView`, za
    // `.navigationSplitViewColumnWidth`) zapętlał układ przy wysunięciu klawiatury — 100 % procesora w wątku
    // głównym, apka stała (zmierzone na symulatorze iOS 27).
    .toolbar(removing: .sidebarToggle)
    // Własne tło zamiast systemowego stylu `.sidebar` (#E2E6F0 jasny, #1D2225 ciemny — granatowa kolumna obok
    // czarnego szczegółu): obok sesji `--sidebar`, o stopień od transkryptu; w stosie (iPhone) `--bg`.
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: columnFill))
    // Wiersze 4 pt od lewej krawędzi kolumny i 8 pt od prawej (systemowe 16 pt). Z lewej 4 pt po to, żeby treść stała
    // bliżej lewej krawędzi podświetlenia, które zostaje 8 pt od kolumny (`SessionListMetrics.plateEdge`, plama
    // w `PlainListRow`).
    .contentMargins(.leading, SessionListMetrics.listLeadingMargin, for: .scrollContent)
    .contentMargins(.trailing, SessionListMetrics.listTrailingMargin, for: .scrollContent)
    // Pierwszy wiersz tuż pod paskiem: w stosie (iPhone) styl `.sidebar` dawał nad nim 35 pt pustki.
    .contentMargins(.top, 4, for: .scrollContent)
    .environment(\.defaultMinListRowHeight, 44)
    .accessibilityIdentifier("session.list")
    // The pills float over the list inside its safe area: under the filter segments and banners, over the footer card.
    .overlay(alignment: .top) { ListJumpPillView(tracker: jumpPill, direction: .above) }
    .overlay(alignment: .bottom) { ListJumpPillView(tracker: jumpPill, direction: .below) }
    // Tytuł zostaje dla przełącznika okien; widoczny jest „AGENCI (N)" w jednym wierszu paska z „łączę…"
    // i „Nową sesją". Bez dużego tytułu pasek ma stałą wysokość: zwijanie przy przewijaniu haczyło.
    .navigationTitle(UICopy.listTitle(count: state.sessions.count))
    .navigationBarTitleDisplayMode(.inline)
    // The banners (connection, push prompt, new devices) stand over the filter segments in the same inset: a notice
    // about the whole app comes before a control of the list. The segments stand from the first frame.
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        BannerStack(
          banners: state.banners(in: .list, global: memory, transcript: transcriptLink.connection(for: state.viewedSessionId)),
          pushPrompt: state.pushPromptVisible(in: .list, global: memory, now: Date()) ? store : nil,
          deviceNotices: state.pairing.newDevices.isEmpty ? nil : store)
        ListFilterBar(store: store, navigation: navigation, background: columnFill)
      }
    }
    // The footer bar is docked over the list: `safeAreaBar` instead of `safeAreaInset`, without a background,
    // so the list scrolls under the translucent bar and its last row still scrolls above it. No bottom scroll edge effect: the
    // soft one faded the rows before the card's translucency could show them, and the automatic one turned hard in
    // the list column beside an open session (a full-width hairline over the card, an opaque band under it; iPad).
    .scrollEdgeEffectHidden(true, for: .bottom)
    .safeAreaBar(edge: .bottom, spacing: 0) {
      ListFooter(
        store: store, stacked: !besideDetail, bottomGap: ListFooterMetrics.bottomGap(safeBottom: column.safeBottom))
    }
    // The footer reaches the bottom edge of the screen and keeps its own distance from it (from the home indicator):
    // standing above the whole safe area, it looked suspended. The keyboard does not lift it
    // either: SwiftUI counts the iPadOS shortcut bar of a hardware keyboard as the keyboard, and the card jumped up
    // whenever that pill showed. An on-screen keyboard covers it.
    .ignoresSafeArea(edges: .bottom)
    .background {
      // Tło kolumny także pod paskiem klawiatury iPadOS (bez tego pod stopką stoi jaśniejszy pas).
      Color(uiColor: columnFill).ignoresSafeArea()
      // Pomiar bez klawiatury: odstęp stopki liczy się od wskaźnika home, nie od klawiatury.
      Color.clear
        .onGeometryChange(for: ListColumnGeometry.self) { proxy in
          ListColumnGeometry(width: proxy.size.width, height: proxy.size.height, safeBottom: proxy.safeAreaInsets.bottom)
        } action: { column = $0 }
        .ignoresSafeArea(.keyboard)
      // Systemowy przycisk zwijania listy wyłączony także w samym `UISplitViewController`.
      SplitDisplayModeProbe(store: store)
    }
    .toolbar {
      // Jeden element na całą szerokość między krawędzią a przyciskami, tytuł po lewej.
      ToolbarItem(placement: .principal) {
        HStack(spacing: 0) {
          ListHeaderTitle(count: state.sessions.count)
          Spacer(minLength: 0)
        }
        // Bez systemowego uchwytu pasek centrował ten element, kiedy mieścił się symetrycznie, i „AGENCI”
        // odjeżdżało od lewej krawędzi (16 → 69 pt). Minimum szersze niż miejsce symetryczne trzyma go przy lewej.
        .frame(minWidth: SessionListMetrics.headerMinWidth(columnWidth: column.width), idealWidth: 2_000,
               maxWidth: .infinity)
      }
      // Napisy, nie przyciski — bez szklanej kapsuły paska narzędzi.
      .sharedBackgroundVisibility(.hidden)
    }
  }

  /// Drzewo projektów: nagłówki i agenci w jednym `List`, zaznaczenie typowane (`ProjectTreeID`).
  @ViewBuilder private func layoutList(_ state: AppState) -> some View {
    // Under the filter segment (`RarogNavigation.listFilter`): the same rows the collapse gesture announces.
    let rows = navigation.treeRows(
      state, openCwd: navigation.currentProjectCwd(state), jumpCwd: navigation.previousProjectCwd(state))
    // The segment's sessions as the list shows them now: they stay when they leave the segment (held rows).
    let filterMembers = navigation.listFilter == .all ? [] : state.listFilterMembers(navigation.listFilter)
    // Wiersze drzewa, które dostanie kolekcja: przy szkielecie i pustej liście kolekcja ma inne wiersze (pusto).
    let treeIds = state.sessionsLoaded && !state.sessions.isEmpty ? rows.map(\.id) : []
    // Odczyt „przed” (`TreeListAnchor`): to ciało liczy się, zanim kolekcja dostanie nowe wiersze.
    let _ = treeAnchor.body(ids: treeIds, columnHidden: navigation.listHidden) { [navigation, store] in
      navigation.listSelection(store.state)
    }
    let _ = returnScroll.body(ids: treeIds, besideDetail: besideDetail, navigation: navigation, anchor: treeAnchor) {
      [navigation, store] in navigation.lastVisitedSession(store.state)
    }
    // The pills count the same rows the collection gets; the skeleton and the empty list have none.
    let _ = jumpPill.body(
      rows: treeIds.isEmpty ? [] : rows.map(ListJumpPill.Row.init), hidden: navigation.listHidden,
      filter: navigation.listFilter, anchor: treeAnchor)
    List(selection: treeSelection(rows)) {
      if !state.sessionsLoaded {
        ForEach(0..<5, id: \.self) { _ in SkeletonRow().modifier(PlainListRow(highlighted: false)) }
      } else {
        // Without sessions there is no tree: a project has a header only while it has a session, and the filter's
        // sentence row gives way to the list's own sentence.
        if state.sessions.isEmpty {
          emptyRow
        } else {
          ProjectTreeRows(
            rows: rows, store: store, navigation: navigation, besideDetail: besideDetail, anchor: treeAnchor,
            hardwareKeyboard: hardwareKeyboard, renamer: renamer
          ) { id in Task { await navigation.close(id, store: store) } }
        }
      }
    }
    // Kolekcja ma już nowe wiersze (`onChange` przychodzi po `performBatchUpdates`): od nich liczy się następny odczyt.
    .onChange(of: treeIds, initial: true) { _, ids in
      treeAnchor.didApply(ids)
      jumpPill.didApply(ids)
    }
    .onChange(of: filterMembers, initial: true) { _, members in navigation.noteListFilterShown(members) }
    // A renamed row waits for the server's label; the new name arriving ends the wait at once.
    .onChange(of: renamer.awaitedLabels(in: state)) { _, labels in
      for (id, label) in labels { renamer.labelChanged(id, to: label) }
    }
    .onReceive(HeaderTabsSlot.keyboardChanges) { _ in hardwareKeyboard = TerminalKeyboard.isConnected() }
    // Another screen opening (a row, a notification, a shortcut) and the background end a rename field as Esc does:
    // back on the list no field waits with a half-typed name, and nothing was sent.
    .onChange(of: navigation.detail) { cancelRename() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { hardwareKeyboard = TerminalKeyboard.isConnected() }
      if phase == .background {
        cancelRename()
        // Rows that left the filter segment go at a calm moment, not under a finger.
        navigation.releaseListFilterHeld(store.state)
      }
    }
  }

  private func cancelRename() {
    if let id = renamer.editing { renamer.cancel(id) }
  }

  private var emptyRow: some View {
    Text(UICopy.listEmpty)
      .appFont(.body)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .modifier(PlainListRow(highlighted: false))
      .accessibilityIdentifier("list.empty")
  }

  /// Zaznaczenie drzewa, typowane (`ProjectTreeID`): agent zaznacza sesję; nagłówek projektu z agentami zwija się
  /// albo rozwija bez ruszania trasy, a bez agentów wchodzi w projekt jedną nawigacją (`ProjectTreeHeaderModel.tap`).
  /// Zaznaczony zostaje wiersz sesji na ekranie.
  private func treeSelection(_ rows: [ProjectTreeRow]) -> Binding<ProjectTreeID?> {
    Binding(get: { navigation.listSelection(store.state).map(ProjectTreeID.session) }, set: { next in
      switch next {
      case let .project(cwd)?:
        switch rows.header(cwd)?.tap ?? .open {
        case let .toggle(collapse):
          // Stuknięcie i Return: jeden projekt, nagłówek stoi (`TreeToggleGesture.project`).
          ProjectTreeRows.toggle(
            [cwd], collapse: collapse, gesture: .project, navigation: navigation, store: store,
            anchor: treeAnchor, reduceMotion: reduceMotion)
        case .open:
          navigation.openProject(cwd, state: store.state)
        }
      case let .session(id)?:
        selection.wrappedValue = id
      case .emptyFilter?:
        // The filter's sentence row is not a target.
        break
      case nil:
        selection.wrappedValue = nil
      }
    })
  }

  private var selection: Binding<String?> {
    // Na trasie terminala zaznaczony jest wpis Codexa, który w nim stoi.
    Binding(get: { navigation.listSelection(store.state) }, set: { next in
      let current = navigation.listSelection(store.state)
      if next != current {
        // Ślad zmiany zaznaczenia z listy: odbicie po Cmd+L (X → Y → X) widać w `client.log`
        // jako zmianę z listy kilkadziesiąt ms po zmianie ekranu. Same skrócone identyfikatory.
        let since = navigation.screenChangedAt.map { Date().timeIntervalSince($0) }
        store.trace(DiagnosticsTrace.listSelection(from: current, to: next, sinceScreenChange: since))
      }
      navigation.selectSession(next)
    })
  }
}

/// Wiersz agenta bez tła i bez kreski pod spodem. W stosie (iPhone, wąskie okno) styl `.sidebar` rysował zaokrągloną
/// kartę za wierszami
/// i kreski między nimi.
///
/// The selection plate is drawn here, like `.session-card--current` in the PWA: an achromatic rectangle with a 12 pt
/// radius like the app's standalone blocks. Beside the detail it marks the session open there (`surface2`); in the
/// stack it marks the last opened session and the agent row under a finger (`stackedPlate`, see
/// `ListRowHighlight`). The system capsule was sometimes blue on a device (a focused list), and a gray status
/// line disappeared on it. The row's own background replaces the system selection background.
///
/// Fokus klawiatury: systemowe halo komórki zdejmuje `ListCellFocusBridge` (rysowało niebieską
/// obwódkę wokół klikniętego agenta). Fokus na zaznaczonym wierszu wskazuje tło `surface2`, a na innym wierszu
/// — pierścień w atramencie tekstu, 2 pt jak `--focus-ring` w PWA, na tym samym prostokącie 12 pt co tło.
///
/// Wskaźnik: wiersz pod kursorem dostaje plamę zaznaczenia w połowie krycia
/// (`HoverTokens.agentRowAlpha`). Stan przychodzi od komórki
/// (`ListCellFocusBridge`), nie z treści wiersza: plama obejmuje wcięcia. Zaznaczenie wygrywa, pierścień fokusu
/// i `selectionFollowsFocus = false` bez zmian. A finger lights the full plate only on an agent row of the stacked
/// list, while the UIKit cell is highlighted.
///
/// Plama zaczyna się 8 pt od lewej krawędzi kolumny (`leadingInset`), choć komórka i treść już od 4 pt.
/// Drzewo dokłada w tle komórki oddech nad nagłówkiem (`topInset` — plama i pierścień
/// zaczynają się pod nim) i plamę agenta za prowadnicą (`leadingInset`). Samej prowadnicy w tle nie ma: tło
/// istniejących komórek lista odświeża z opóźnieniem, więc kreskę rysuje treść wiersza (`ProjectTreeGuide`).
struct PlainListRow: ViewModifier {
  let highlighted: Bool
  /// Oddech nad wierszem: część komórki, której plama nie obejmuje (nagłówek projektu, nie pierwszy na liście).
  var topInset: CGFloat = 0
  /// Lewy pas komórki bez plamy: zwykle `rowPlateInset` (plama 8 pt od kolumny, przy marginesie listy 4 pt), w wierszu
  /// agenta w drzewie więcej — prowadnica stoi w tym pasie, nie pod plamą.
  var leadingInset: CGFloat = SessionListMetrics.rowPlateInset
  /// Kotwica drzewa (`TreeListAnchor`): most komórki zgłasza jej kolekcję. Tylko wiersze drzewa; szkielet i pusta
  /// lista — `nil`.
  var anchor: TreeListAnchor?
  /// Plate colour: `surface2` beside the detail, `stackedPlate` in the stack (the column there is `background`).
  var plate: UIColor = Palette.surface2
  /// The row shows the plate while its cell is highlighted under a finger (stacked list, agent rows). The state comes
  /// from the UIKit cell (`ListCellFocusBridge`), so it waits for the collection's touch delay and goes out when the
  /// list starts to scroll.
  var pressFeedback = false
  @State private var focused = false
  @State private var hovered = false
  @State private var pressed = false

  /// Grubość pierścienia fokusu (PWA: `--focus-ring: 2px solid var(--text)`).
  static let focusRingWidth: CGFloat = 2

  func body(content: Content) -> some View {
    content
      .background(
        ListCellFocusBridge(
          onFocusChange: { focused = $0 }, onHoverChange: { hovered = $0 },
          onPressChange: pressFeedback ? { pressed = $0 } : nil, anchor: anchor)
          .accessibilityHidden(true))
      .listRowSeparator(.hidden)
      .listRowBackground(
        ListRowBackground(
          highlighted: highlighted,
          hovered: hovered,
          focusRing: ListRowHighlight.showsFocusRing(focused: focused, highlighted: highlighted),
          topInset: topInset, leadingInset: leadingInset,
          plate: plate, pressed: pressFeedback && pressed)
      )
  }
}

/// Tło wiersza listy: plama zaznaczenia `surface2` (pod wskaźnikiem w połowie krycia) i pierścień fokusu
/// klawiatury, achromatycznie. Plama zostawia po 1 pt u góry i u dołu wiersza, więc plamy sąsiednich wierszy
/// (zaznaczony i ten pod wskaźnikiem) dzielą 2 pt przerwy zamiast się stykać.
struct ListRowBackground: View {
  let highlighted: Bool
  var hovered = false
  let focusRing: Bool
  /// Oddech nad plamą (nagłówek projektu w drzewie): plama i pierścień zaczynają się pod nim.
  var topInset: CGFloat = 0
  /// Pas z lewej bez plamy i pierścienia (wiersz agenta w drzewie: plama zaczyna się za prowadnicą).
  var leadingInset: CGFloat = 0
  /// Plate colour (`PlainListRow.plate`).
  var plate: UIColor = Palette.surface2
  /// A finger is down on the row (stacked list): the full plate, a background change only, never geometry.
  var pressed = false

  /// Pół przerwy między plamami sąsiednich wierszy.
  static let verticalInset: CGFloat = 1

  var body: some View {
    plateShape
      .padding(.top, Self.verticalInset + topInset)
      .padding(.bottom, Self.verticalInset)
      .padding(.leading, leadingInset)
      .accessibilityHidden(true)
  }

  private var plateShape: some View {
    RoundedRectangle.block
      .fill(fill)
      .overlay {
        if focusRing {
          RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.text), lineWidth: PlainListRow.focusRingWidth)
        }
      }
  }

  /// The selection and the finger give the full plate; the pointer gives half of `surface2` in either column
  /// (`HoverTokens.agentRow`).
  private var fill: Color {
    if highlighted || pressed { return Color(uiColor: plate) }
    return hovered ? Color(uiColor: Palette.surface2).opacity(HoverTokens.agentRowAlpha) : .clear
  }
}

/// Wymiary kolumny listy: szerokość (nagłówek), cała wysokość i dolna strefa bezpieczna bez klawiatury (stopka).
struct ListColumnGeometry: Equatable {
  var width: CGFloat = 0
  var height: CGFloat = 800
  var safeBottom: CGFloat = 0
}

/// Akcje wiersza agenta, jak w Mailu. Przesunięcie w lewo: „×" — czerwony przycisk zamyka od razu, a pełne
/// przesunięcie zamyka bez stuknięcia, tak samo jak przełącznik „Przeczytane” (potwierdzeniem
/// jest samo przesunięcie, bez pytania); Codex, nieznany silnik i sesja nieobsługiwana go nie mają. Przesunięcie
/// w prawo: przełącznik „Przeczytane / Nieprzeczytane" stojącego wyniku (`AppState.readToggle`) — także dla
/// Codexa. Obie akcje są też w menu kontekstowym, tam wybór pozycji zamyka od razu. Lista z pamięci podręcznej nie ma
/// żadnej. Wpina je `ProjectTreeRows`. The context menu starts with Rename when the row offers it
/// (`SessionRename.available`): the row turns into a field (`SessionRenameField`).
struct RowActions: ViewModifier {
  let session: SessionSummary?
  let readToggle: ReadToggle?
  /// Opens the row's rename field; `nil` — no item.
  var rename: (() -> Void)?
  let close: (String) -> Void
  let setRead: (String, Bool) -> Void

  func body(content: Content) -> some View {
    if let session, session.canClose || readToggle != nil {
      content
        // Swipe pills show the icon only; the label stays for VoiceOver. With a label iOS puts it inside the pill of
        // a two-line row (176 pt wide), and the row moved 196 pt, so a short title left the screen (measured on
        // iOS 27); with the icon only the row moves 80 pt.
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
          readButton(session, label: UICopy.readToggleSwipe).labelStyle(.iconOnly)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          closeButton(session, role: nil).labelStyle(.iconOnly)
        }
        .contextMenu {
          if let rename {
            Button(UICopy.renameSession, systemImage: "pencil", action: rename)
              .accessibilityIdentifier("list.rename")
          }
          readButton(session, label: UICopy.readToggleMenu)
          closeButton(session, role: .destructive)
        }
    } else {
      content
    }
  }

  @ViewBuilder private func readButton(_ session: SessionSummary, label: (ReadToggle) -> String) -> some View {
    if let readToggle {
      let read = readToggle == .markRead
      Button { setRead(session.id, read) } label: {
        Label(label(readToggle), systemImage: read ? "message" : "message.badge")
      }
      .tint(Color(uiColor: Palette.new))
    }
  }

  /// The swipe pill takes no role: with `.destructive` UIKit deletes the row from the collection right after the tap,
  /// while the session stays in the data until the server answers. SwiftUI then puts the row back and the list
  /// snapshot deletes it again; when the answer overtook the snapshot the item counts no longer matched and the app
  /// crashed (`Invalid_Number_Of_Items_In_Section`, `ListSwipeCloseCrashTests`, iOS 27). The pill keeps the system
  /// red by `tint`; the row leaves the list only with the snapshot. The context menu deletes nothing on its own and
  /// keeps the destructive role (red item).
  @ViewBuilder private func closeButton(_ session: SessionSummary, role: ButtonRole?) -> some View {
    if session.canClose {
      Button(role: role) { close(session.id) } label: {
        Label(UICopy.closeLabel(session), systemImage: "xmark")
      }
      .tint(Color(uiColor: .systemRed))
    }
  }
}

/// Sonda UIKit podziału, na wypadek systemowej ikony zwijania listy, którą iPad pokazał po aktualizacji apki.
/// OSTROŻNOŚĆ, nie diagnoza: na symulatorze zgłoszenia nie odtworzył ani start nowego buildu
/// zainstalowanego na stary bez resetu stanu, ani zmiana szerokości `compact` → `regular` (`SplitToggleUITests`),
/// a ślad pierwszego podziału mówił wtedy `uchwyt=never` (zmierzone na iOS 27: `.toolbar(removing:)`
/// ustawia to samo). Obok `.toolbar(removing: .sidebarToggle)` na liście sonda ustawia
/// `displayModeButtonVisibility = .never` wprost na `UISplitViewController`, za każdym razem, gdy widok wchodzi do
/// okna, gdy zmienia się rozmiar okna i gdy lista się przerysowuje — tylko gdy wartość jest inna, więc nie dokłada
/// przebiegów układu (pętla z `.sidebarToggle` na kolumnie, komentarz w `SessionListView.body`).
/// `presentsWithGesture` zostaje: gest krawędzi dalej zwija listę.
/// Przy pierwszym podziale jedna linia śladu (`client.log`): rozmiar okna, faza sceny, stan apki i to, czy system
/// stawiał wtedy swój przycisk — z niej następne zgłoszenie powie, w jakim stanie apka wstała.
struct SplitDisplayModeProbe: UIViewRepresentable {
  let store: RarogStore

  func makeUIView(context: Context) -> SplitDisplayModeProbeView {
    SplitDisplayModeProbeView()
  }

  func updateUIView(_ view: SplitDisplayModeProbeView, context: Context) {
    view.trace = { [store] in store.trace($0) }
    view.scenePhase = context.environment.scenePhase
    view.apply()
  }
}

final class SplitDisplayModeProbeView: UIView {
  var trace: (@MainActor (String) -> Void)?
  var scenePhase: SwiftUI.ScenePhase = .active
  private var traced = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) {
      (view: SplitDisplayModeProbeView, _: UITraitCollection) in
      view.apply()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    apply()
  }

  /// Systemowy przycisk wyłączony; przy pierwszym podziale ślad stanu sprzed wyłączenia.
  func apply() {
    guard window != nil, let split = splitController else { return }
    if !traced, let trace {
      traced = true
      trace(Self.summary(split: split, phase: scenePhase, app: UIApplication.shared.applicationState))
    }
    if split.displayModeButtonVisibility != .never { split.displayModeButtonVisibility = .never }
  }

  private var splitController: UISplitViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let split = current as? UISplitViewController { return split }
      responder = current.next
    }
    return nil
  }

  /// Linia śladu (`DiagnosticsTrace.split`) z bieżącego stanu podziału, sceny i apki.
  static func summary(split: UISplitViewController, phase: SwiftUI.ScenePhase, app: UIApplication.State) -> String {
    let size = switch split.traitCollection.horizontalSizeClass {
    case .compact: "compact"
    case .regular: "regular"
    default: "?"
    }
    let scene = switch phase {
    case .active: "active"
    case .inactive: "inactive"
    case .background: "background"
    @unknown default: "?"
    }
    let state = switch app {
    case .active: "active"
    case .inactive: "inactive"
    case .background: "background"
    @unknown default: "?"
    }
    let visibility = switch split.displayModeButtonVisibility {
    case .automatic: "automatic"
    case .never: "never"
    case .always: "always"
    @unknown default: "?"
    }
    let item = split.displayModeButtonItem
    let inBar = split.viewControllers.contains { column in
      let items = (column as? UINavigationController)?.viewControllers.map(\.navigationItem) ?? [column.navigationItem]
      return items.contains { navigationItem in
        (navigationItem.leftBarButtonItems ?? []).contains(item)
          || navigationItem.leadingItemGroups.contains { $0.barButtonItems.contains(item) }
      }
    }
    return DiagnosticsTrace.split(size: size, phase: scene, app: state, button: visibility, inBar: inBar)
  }
}

/// Szkielet przed pierwszym stanem listy: pusto ≠ ładuję.
struct SkeletonRow: View {
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle().fill(Color(uiColor: Palette.border)).frame(width: 9, height: 9).padding(.top, 6)
      VStack(alignment: .leading, spacing: 6) {
        RoundedRectangle.ghost.fill(Color(uiColor: Palette.border)).frame(width: 180, height: 14)
        RoundedRectangle.ghost.fill(Color(uiColor: Palette.border)).frame(width: 110, height: 10)
      }
    }
    .padding(.vertical, 6)
    .accessibilityHidden(true)
  }
}
#endif
