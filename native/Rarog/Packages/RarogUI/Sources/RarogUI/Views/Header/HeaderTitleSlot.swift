#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// Tytuł nagłówka: nazwa projektu, pod nią ścieżka. Której sesji ekran dotyczy, mówi
/// pasek zakładek. Sesja jeszcze nieznana liście mówi „Sesja", a założona z tego urządzenia —
/// „startuje"; słowa stanu w nagłówku nie ma. Właściciel: projekty i zakładki.
///
/// Na iPadzie (lista obok szczegółu) tytuł stoi w lewym górnym rogu, wyrównany do lewej, tuż za
/// przyciskiem zwijania listy (`HeaderListToggle`) — systemowy uchwyt z paska listy zdejmuje `SessionListView`.
/// Widoczny tytuł systemu zdejmuje wtedy `.toolbar(removing: .title)` (wyśrodkowany stałby daleko od przycisku), ale
/// `navigationTitle` zostaje: z niego iPadOS bierze nazwę okna w przełączniku aplikacji. W stosie (iPhone, wąskie
/// okno) tytuł stoi tak samo przy lewej krawędzi, za systemowym „wstecz", bez przycisku listy. Systemowy tytuł
/// stosu sam wybiera środek albo lewą stronę według miejsca obok ikon: sesja z trzema ikonami stałaby z lewej,
/// terminal z jedną — na środku. Sufit szerokości tytułu na
/// telefonie liczy się z marginesów paska telefonu (`HeaderMetrics.phoneTitleMaxWidth`): za szeroki tytuł
/// wypycha ikony do „⋯" przepełnienia.
struct HeaderTitleSlot: ViewModifier {
  let store: RarogStore
  let selection: String?
  /// Uzbrojone „×" terminala („Na pewno?") jest szersze — tytuł ustępuje mu miejsca jak przy „×" sesji.
  let terminal: TerminalChrome
  @Environment(RarogNavigation.self) private var navigation
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// Szerokość kolumny szczegółu (bez listy obok) — sufit tytułu.
  @State private var columnWidth: CGFloat = 0

  func body(content: Content) -> some View {
    let title = Self.title(
      store.state, detail: navigation.detail, launching: launching,
      terminalCwd: navigation.currentProjectCwd(store.state))
    let leading = navigation.detail != nil
    let toggle = sizeClass != .compact
    let closeArmed = navigation.closeArm != nil || (terminal.isAttached && terminal.close == .armed)
    // Przed tytułem przycisk listy na iPadzie (w grupie z tytułem, co 2 pt), w stosie systemowe „wstecz" (osobny
    // element paska, odstęp systemu).
    let maxWidth =
      toggle
      ? HeaderMetrics.titleMaxWidth(columnWidth: columnWidth, toggle: true, closeArmed: closeArmed)
      : HeaderMetrics.phoneTitleMaxWidth(columnWidth: columnWidth, closeArmed: closeArmed)
    content
      .navigationTitle(title.title)
      .navigationSubtitle(title.subtitle)
      .navigationBarTitleDisplayMode(.inline)
      // `nil` zostawia tytuł systemu: modyfikator stoi zawsze, więc zmiana rozmiaru okna nie przebudowuje ekranu.
      .toolbar(removing: leading ? .title : nil)
      // Ramka treści szczegółu stoi już w strefie bezpiecznej: na iPadzie 514 pt obok listy, 834 pt po zwinięciu.
      // Odejmowanie `safeAreaInsets` liczyło listę drugi raz (194 pt) i tytuł dostawał zero szerokości.
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { columnWidth = $0 }
      .toolbar {
        if leading {
          ToolbarItem(placement: .topBarLeading) {
            HStack(spacing: HeaderMetrics.titleSpacing) {
              if toggle { HeaderListToggle(navigation: navigation) }
              HeaderLeadingTitle(title: title.title, subtitle: title.subtitle, maxWidth: maxWidth)
            }
          }
          // Cichy glif i napis, bez szklanej kapsuły paska (jak ikony prawego rogu).
          .sharedBackgroundVisibility(.hidden)
        }
      }
  }

  private var launching: Bool {
    guard let id = navigation.selectedSessionId else { return false }
    return navigation.isLaunching(id, now: Date())
  }

  /// Tytuł i podtytuł z ekranu w prawej kolumnie (`""` = bez napisu). Terminal ma ten sam nagłówek co sesja:
  /// projekt i ścieżka; bez znanego katalogu (terminal z powiadomienia przed listą) — „Terminal".
  static func title(
    _ state: AppState, detail: RarogNavigation.Detail?, launching: Bool, terminalCwd: String? = nil
  ) -> (title: String, subtitle: String) {
    switch detail {
    case let .session(id):
      guard let session = state.sessions[id] else {
        return (UICopy.unknownSessionTitle, launching ? UICopy.sessionStarting : "")
      }
      return (session.title, PathText.shortPath(session.cwd))
    case let .project(cwd):
      return (ProjectPath.name(cwd), PathText.shortPath(cwd))
    case .terminal, .openingTerminal:
      guard let cwd = terminalCwd else { return (UICopy.terminalTitle, "") }
      return (ProjectPath.name(cwd), PathText.shortPath(cwd))
    case nil:
      return ("", "")
    }
  }
}

/// Przycisk zwijania listy w lewym górnym rogu nagłówka sesji: ten sam stan co Cmd+B,
/// widoczny przy liście rozwiniętej i zwiniętej. Cichy glif jak ikony prawego rogu, cel 44 pt.
struct HeaderListToggle: View {
  let navigation: RarogNavigation

  var body: some View {
    let label = navigation.listHidden ? UICopy.shortcutShowList : UICopy.shortcutHideList
    Button {
      navigation.toggleList()
    } label: {
      Label(label, systemImage: "sidebar.left")
    }
    .buttonStyle(HeaderIconButtonStyle())
    .shortcutTip(label, .toggleList)
    .accessibilityLabel(label)
    .accessibilityIdentifier("header.listToggle")
  }
}

/// Nazwa projektu i ścieżka wyrównane do lewej, w piśmie tytułu paska (`headline`, ścieżka `footnote` w `muted`).
/// Jedna linia każda: długa nazwa ucina się na końcu, długa ścieżka w środku, w suficie `maxWidth`.
struct HeaderLeadingTitle: View {
  let title: String
  let subtitle: String
  let maxWidth: CGFloat?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .appFont(.headline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .truncationMode(.tail)
      if !subtitle.isEmpty {
        Text(subtitle)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .truncationMode(.middle)
      }
    }
    .lineLimit(1)
    // Pasek nawigacji ma stałą wysokość: pismo rośnie do sufitu jak systemowy tytuł, dalej podgląd dużej treści.
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    // Pasek narzędzi proponuje elementowi z boku jego minimum: sama elastyczna ramka dostawała zero szerokości
    // i tytuł znikał obok przycisku (zmierzone na iOS 27). Szerokość to ideał tekstu przycięty do sufitu, więc
    // dłuższy tekst ucina się w tej szerokości.
    .frame(maxWidth: maxWidth ?? .infinity, alignment: .leading)
    .fixedSize(horizontal: true, vertical: false)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
    .accessibilityShowsLargeContentViewer()
    .accessibilityIdentifier("header.title")
  }
}
#endif
