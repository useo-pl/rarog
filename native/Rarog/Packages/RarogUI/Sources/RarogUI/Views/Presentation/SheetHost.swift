#if os(iOS)
import RarogCore
import SwiftUI

// Jedyne miejsce, w którym apka stawia arkusz: okna (terminal Cmd+F/Cmd+G, historia z trasy, diff, tekst
// transkryptu) i formularze („Nowa sesja”, „Ostatnie sesje”) idą przez JEDEN `.sheet(item:)` na korzeniu zalogowanego interfejsu,
// związany z `RarogNavigation.sheet`. Nowy arkusz zastępuje stary (system zdejmuje jeden i stawia drugi), więc dwa
// naraz nie mają jak powstać, a okno „w kolejce” za formularzem nie istnieje. Reguły, kto komu ustępuje, trzyma
// nawigacja (`Model/AppSheet.swift`); ten plik tylko pokazuje.

/// Arkusz nad całym podziałem (lista + szczegół) i prezenter formularzy w środowisku.
struct SheetHost: ViewModifier {
  let store: RarogStore
  let navigation: RarogNavigation
  /// Szerokość okna z korzenia (`measuresAppWindowWidth()`); bez niej — szerokość podziału, na którym stoi ten
  /// modyfikator (podział zajmuje całe okno).
  @Environment(\.appWindowWidth) private var rootWidth
  /// Notatki projektów — arkusz staje z korzenia sceny, więc rejestr idzie do niego jawnie, jak nawigacja.
  @Environment(ProjectNotes.self) private var notes: ProjectNotes?
  /// The owner of the voice conversation across sessions from the root; its consent sheet starts it.
  @Environment(VoiceAgentSessionsConversation.self) private var voiceSessions: VoiceAgentSessionsConversation?
  @State private var measuredWidth: CGFloat?
  @State private var presenter: NewSessionPresenter
  /// Żeton arkusza, którego treść stanęła na ekranie jako ostatnia. Zostaje po zamknięciu: zapis `nil`, który
  /// przyszedłby przed pokazaniem następnego arkusza, należy wtedy do poprzedniego i następnego nie rusza.
  @State private var shown: UUID?

  init(store: RarogStore, navigation: RarogNavigation) {
    self.store = store
    self.navigation = navigation
    _presenter = State(initialValue: NewSessionPresenter(navigation: navigation))
  }

  func body(content: Content) -> some View {
    let windowWidth = rootWidth ?? measuredWidth
    content
      .environment(presenter)
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { measuredWidth = $0 }
      .sheet(item: item) { sheet in
        page(sheet, windowWidth: windowWidth)
          // Każde otwarcie to nowa prezentacja z czystym stanem, także dwa diffy albo dwa formularze z rzędu.
          .id(sheet.id)
          .onAppear { shown = sheet.id }
          // SwiftUI does not reach the root's ⇧⌘= under a sheet; the sheet carries its own.
          .modifier(TextScaleAlternateKeys())
          // Where text styles have one size (a Mac), the model's text size in the sheet too.
          .textScaleHost()
      }
      // Okno diffa bez swojej sesji (zamknięta gdzie indziej) schodzi samo.
      .onChange(of: orphan, initial: true) { _, orphan in
        if let orphan { navigation.closeSheet(id: orphan) }
      }
  }

  /// Stan apki czytany tylko przy otwartym diffie: bez niego ten modyfikator nie przelicza się przy każdej ramce.
  private var orphan: UUID? {
    guard case .diff = navigation.sheet else { return nil }
    return navigation.orphanedSheet(store.state)
  }

  @ViewBuilder
  private func page(_ sheet: AppSheet, windowWidth: CGFloat?) -> some View {
    switch sheet {
    case let .terminal(request, _):
      // Zamknięcie adresowane żetonem: spóźniony `exit` zamkniętego okna nie zamyka następnego.
      TerminalPopupSheet(store: store, request: request, windowWidth: windowWidth) {
        navigation.closeSheet(id: sheet.id)
      }
    case let .history(request, _):
      TerminalHistorySheet(store: store, terminalId: request.terminalId, windowWidth: windowWidth)
    case let .diff(request):
      DiffSheet(store: store, request: request, windowWidth: windowWidth)
    case let .transcriptText(request):
      TranscriptSelectionSheet(request: request, windowWidth: windowWidth)
    case let .consentInput(request):
      ConsentInputSheet(request: request, windowWidth: windowWidth)
    case let .newSession(request):
      NewSessionSheet(store: store, navigation: navigation, presenter: presenter, request: request)
        .environment(navigation)
    case let .recentSessions(recent):
      RecentSessionsSheet(store: store, navigation: navigation, presenter: presenter, recent: recent)
        .environment(navigation)
    case let .note(request):
      if let notes {
        NoteSheet(store: store, navigation: navigation, request: request)
          .environment(navigation)
          .environment(notes)
      }
    case let .settings(request):
      SettingsSheet(store: store, navigation: navigation, request: request)
    case let .dictation(request):
      DictationSheet(store: store, navigation: navigation, request: request)
    case let .voiceAgentSessionsConsent(request):
      VoiceAgentSessionsConsentSheet(
        settings: store.voiceAgent, request: request, close: { navigation.closeSheet(id: request.id) },
        start: { [voiceSessions] in Task { await voiceSessions?.start() } })
    }
  }

  /// Gest, tap obok i `dismiss()` zamykają arkusz, który STOI (`RarogNavigation.sheetDismissed`).
  private var item: Binding<AppSheet?> {
    Binding(
      get: { navigation.sheet },
      set: { value in
        if value == nil { navigation.sheetDismissed(shown: shown) }
      })
  }
}
#endif
