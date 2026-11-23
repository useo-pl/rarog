#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// Korzeń interfejsu: logowanie albo podział lista ↔ szczegół. Apka tylko skleja — wszystkie
/// ekrany mieszkają tutaj (`RarogUI` rysuje, `RarogCore` wie).
public struct RarogRootView: View {
  let store: RarogStore
  /// Nawigacja (prawa kolumna, pamięć zakładek i projektów, zwinięcie listy). Wybrana sesja
  /// przeżywa wylogowanie: po ponownym zalogowaniu apka wraca tam, skąd 401 wyrzucił.
  /// Ekran logowania podmienia korzeń, więc nie zostawia śladu w historii.
  @State private var navigation = RarogNavigation()
  @State private var memory = ConnectionMemory()
  /// The viewed session's stream memory, next to the global one: every column with the global banners reads both
  /// (the gray card also comes from a session stream that does not come online), and the session column reads it for
  /// the stalled transcript banner.
  @State private var transcriptLink = TranscriptConnectionMemory()
  /// Szkice pól wiadomości: tekst i załączniki przeżywają nawigację i zabicie apki; leżą
  /// w przestrzeni bieżącego serwera — inny serwer to nowy korzeń (`interfaceEpoch`) i nowy katalog.
  @State private var drafts: ComposerDrafts
  /// Dymek o innej sesji i komunikaty apki.
  @State private var toasts = ToastCenter()
  /// The session switcher under Cmd+S: recently visited sessions (directory `Switcher/`).
  @State private var switcher = SessionSwitcher()
  /// Notatki projektów: jeden dokument na katalog, dłużej niż dymek i formularz; szkice na urządzeniu.
  @State private var notes: ProjectNotes
  @Environment(\.scenePhase) private var scenePhase

  public init(store: RarogStore) {
    self.store = store
    _drafts = State(initialValue: ComposerDrafts.inSpace(store.dataSpaceDirectory))
    _notes = State(initialValue: ProjectNotes.live(store: store, drafts: NoteDrafts.inSpace(store.dataSpaceDirectory)))
  }

  public var body: some View {
    Group {
      switch store.state.auth {
      case .unknown:
        LaunchView()
      case let .loggedOut(reason):
        // Parowanie kluczem, ekran odpięcia albo logowanie tokenem (okres podwójny).
        PairingStartView(store: store, reason: reason)
      case .loggedIn:
        MainSplitView(
          store: store, navigation: navigation, memory: memory, transcriptLink: transcriptLink, drafts: drafts)
      }
    }
    // Szerokość CAŁEGO okna dla ramy okien apki (`WindowLayout`): kolumna szczegółu jest węższa od okna,
    // a środowisko płynie tylko w dół — stąd pomiar na korzeniu sceny.
    .measuresAppWindowWidth()
    // The session switcher window over the whole app window, its keys and the presentation gate.
    .modifier(SessionSwitcherHost(store: store, navigation: navigation, switcher: switcher))
    // The shortcut sheet under Cmd held alone for 1.5 s, over the sheets.
    .modifier(ShortcutSheetHost(store: store, navigation: navigation, switcher: switcher))
    // ⇧⌘= of Make Text Bigger, next to the menu's ⌘=.
    .modifier(TextScaleAlternateKeys())
    // Where text styles have one size (a Mac), the model's text size for every view below.
    .textScaleHost()
    .environment(navigation)
    .environment(toasts)
    .environment(switcher)
    .environment(notes)
    // Sygnały notatek ze strumienia: nowa epoka (powrót z przerwy), zmiany katalogów, flaga serwera.
    .onChange(of: store.state.notesEpoch) { notes.sync(store.state) }
    .onChange(of: store.state.notesRevision) { notes.sync(store.state) }
    .onChange(of: store.state.notesAvailable, initial: true) {
      // Dymek po zakończeniu formularza z jedną akcją: „Cofnij" skasowanie, „Otwórz" niezapisaną notatkę.
      notes.onEvent = { [toasts, notes, navigation] event in
        let text = UICopy.noteEvent(event)
        switch event {
        case let .deleted(cwd):
          toasts.notice(text, action: ToastAction(label: UICopy.noteUndo, identifier: "toast.note.undo")) {
            notes.document(cwd).undoDelete()
          }
        case let .notSaved(cwd):
          toasts.notice(text, action: ToastAction(label: UICopy.noteOpen, identifier: "toast.note.open")) {
            navigation.openNote(cwd: cwd)
          }
        }
      }
      notes.sync(store.state)
    }
    .onChange(of: scenePhase) { previous, phase in
      // Back from the background as `inactive` the streams wait for `active`: the card counts that wait.
      memory.observeScene(
        RarogCore.ScenePhase(phase), from: RarogCore.ScenePhase(previous), stream: store.state.global,
        loggedIn: store.state.auth == .loggedIn, now: Date())
      switch phase {
      case .background: NoteBackgroundSave.run(notes, store: store)
      case .active: notes.enterForeground()
      default: break
      }
    }
    // Skróty globalne (`RarogCommands`) czytają stan menu z chwili rysowania i wołają nawigację.
    .focusedSceneValue(\.rarogShortcuts, shortcuts)
    .onChange(of: store.state.global, initial: true) { _, status in
      let before = memory
      let now = Date()
      memory.observe(status, now: now)
      if status == .online,
        let line = DiagnosticsTrace.connection(.global, before: before, card: before.connectionCard, now: now)
      {
        store.trace(line, budget: .connectivity)
      }
    }
    // A session change only resets the memory (the status at that moment belongs to the previous stream); the new
    // session's statuses come through the second `onChange`. Two handlers in this order, so the first status of the
    // new session is not lost.
    .onChange(of: store.state.viewedSessionId, initial: true) { _, sessionId in
      transcriptLink.observe(store.state.sessionStream, sessionId: sessionId, now: Date())
    }
    .onChange(of: store.state.sessionStream, initial: true) { _, status in
      let sessionId = store.state.viewedSessionId
      let before = transcriptLink.connection(for: sessionId)
      let now = Date()
      transcriptLink.observe(status, sessionId: sessionId, now: now)
      let card = before.sessionGapCard(globalOnlineSince: memory.onlineSince)
      if status == .online, let sessionId,
        let line = DiagnosticsTrace.connection(.session(sessionId), before: before, card: card, now: now)
      {
        store.trace(line, budget: .connectivity)
      }
    }
    .onChange(of: store.state.auth == .loggedIn) { _, loggedIn in
      // Arkusz należy do zalogowanego interfejsu: po 401 nie wraca sam (formularz wróciłby pusty).
      if !loggedIn { navigation.dropSheet() }
      // Notatki: odpowiedzi z tego zalogowania już nic nie zmienią, szkice zostają na urządzeniu.
      if !loggedIn { notes.loggedOut() }
    }
    .onChange(of: store.state.transcriptTarget(navigation.selectedSessionId)) { _, target in
      // Rdzeń pamięta oglądaną sesję także przez wylogowanie; strumień wstaje, gdy pozna listę. Cel liczony
      // z danych sesji: wpis Codexa i agent w terminalu Raroga transkryptu nie mają, a `termId` potrafi
      // przyjść albo zniknąć bez zmiany wyboru.
      store.openSession(target)
    }
    .onChange(of: navigation.selectedSessionId.flatMap { store.state.hostTerminal(ofSession: $0) }, initial: true) {
      // Agent w terminalu Raroga: trasa przechodzi na terminal, żeby powłoka przeżyła zniknięcie jego karty.
      navigation.settleHostedRoute(store.state)
    }
    .onChange(of: navigation.listSelection(store.state), initial: true) { _, id in
      // Lustro zaznaczenia listy w rdzeniu: wiersz, z którego się zeszło, zostaje w zwiniętym projekcie
      // drzewa do spokojnej chwili — także trasa terminala z wpisem agenta i powrót do listy na iPhonie.
      store.selectListRow(id)
      // Session switcher history: every visited session, also an agent that appears in the watched terminal.
      navigation.noteSessionVisit(store.state)
      // Dymek o tej sesji gaśnie, gdy człowiek do niej doszedł dowolną drogą — także do terminala,
      // w którym stoi jej agent.
      toasts.reached(id)
    }
    .onChange(of: store.state.signal) { _, signal in
      // O tym, czy dymek staje, rozstrzyga ekran z chwili sygnału (tylko inna sesja). Sesją na
      // ekranie jest też agent stojący w oglądanym terminalu; goła powłoka dymków nie pokazuje.
      toasts.offer(signal, state: store.state, viewing: navigation.listSelection(store.state))
    }
    .onReceive(NotificationCenter.default.publisher(for: .rarogAppNotice)) { note in
      // Komunikat apki z UIKit.
      if let text = note.object as? String { toasts.notice(text) }
    }
    .onChange(of: store.state.push.notice) { _, notice in
      // „Włącz powiadomienia": sukces dopiero po odebranym pushu próbnym, porażki ze zdaniem.
      if let notice { toasts.notice(UICopy.pushNotice(notice.kind)) }
    }
    .onChange(of: store.state.readyPushTarget, initial: true) { _, target in
      // Tap w powiadomienie albo `rarog://session/<id>`: cel czekał na logowanie i świeżą listę.
      guard let target else { return }
      navigation.openPushTarget(target, state: store.state)
      store.consumePushTarget(target)
    }
    .onChange(of: store.state.settingsRoute, initial: true) { old, new in
      // A push tap (`device-paired`, `version-changed`) opens its Settings page; a pairing link while logged in
      // ("Pair with …?") opens the list, where the card stands. One observer, so the two resolve with one priority
      // (`Model/SettingsPage.swift`). On the first call `old == new`.
      if navigation.followSettingsRoute(new, previous: old == new ? nil : old) != nil {
        store.consumeSettingsScreenRequest()
      }
    }
    .onChange(of: store.state.readyLink, initial: true) { _, link in
      // Liczba albo tło kafla Live Activity: sesję wybiera świeża lista, a bez sesji tego rodzaju — lista.
      guard let link else { return }
      switch link {
      case let .jump(kind):
        if let session = store.state.firstSession(kind) {
          navigation.openPushTarget(PushTarget(sessionId: session.id), state: store.state)
        } else {
          navigation.openList()
        }
      case .list:
        navigation.openList()
      }
      store.consumeLink(link)
    }
    .onChange(of: visitKey, initial: true) {
      navigation.noteVisit(store.state)
    }
    .onChange(of: navigation.detail != nil, initial: true) { _, onProject in
      // Zakładki terminali: lista `GET /api/term` co ≤ 5 s, dopóki na ekranie stoi projekt.
      store.watchTerminals(onProject)
    }
    .task(id: store.state.global == .online) {
      // Ostatnie projekty nie jadą strumieniem: odczyt po każdym połączeniu (z dławikiem rdzenia).
      if store.state.global == .online { await store.refreshRecentProjects() }
    }
    .onReceive(NotificationCenter.default.publisher(for: .rarogCloseTabShortcut)) { note in
      guard let id = note.object as? String else { return }
      closeShortcut(id)
    }
  }

  /// Zakładka i projekt, w którym stoi człowiek — zmienia się z wyborem i z pojawieniem się
  /// katalogu sesji albo terminala na liście (sesja albo terminal założone przed chwilą).
  private var visitKey: String {
    let state = store.state
    guard let tab = navigation.currentTab(state) else { return "" }
    return "\(tab)\u{0}\(navigation.standingProjectCwd(state) ?? "")"
  }

  private var shortcuts: RarogShortcutContext {
    RarogShortcutContext(
      menu: navigation.shortcutMenu(store.state),
      perform: { [store, navigation, switcher] shortcut in
        // Any other menu shortcut closes the switcher window without a jump and does its own thing.
        switcher.cancel(.otherCommand)
        navigation.perform(shortcut, store: store)
      },
      switchSession: { [store, navigation, switcher] backward in
        SessionSwitcherHost.command(backward: backward, switcher: switcher, store: store, navigation: navigation)
      },
      switcherDigit: { [switcher] number in switcher.menuDigit(number) },
      textScale: TextScale.shared,
      textSize: TextSizeMenu(TextScale.shared))
  }

  /// Cmd+X z ekranu sesji: pierwsze naciśnięcie uzbraja, drugie zamyka — ten sam stan
  /// co „×" w nagłówku.
  private func closeShortcut(_ sessionId: String) {
    // Pod arkuszem skrót milczy: „×" uzbrojone pod oknem zamknęłoby sesję, której nie widać.
    guard navigation.sheet == nil else { return }
    guard let session = store.state.sessions[sessionId] else { return }
    switch navigation.requestClose(sessionId, state: store.state, now: Date()) {
    case .armed:
      Announcer.shared.say(UICopy.closeArmed(session))
    case .confirmed:
      Task { await navigation.close(sessionId, store: store) }
    case .unavailable:
      break
    }
  }
}

extension RarogCore.ScenePhase {
  /// `scenePhase` → wejście rdzenia: tło zamyka strumienie i od razu zgłasza `visible: false`.
  public init(_ phase: SwiftUI.ScenePhase) {
    switch phase {
    case .active: self = .active
    case .background: self = .background
    default: self = .inactive
    }
  }
}

/// Stan menu poleceń i wykonawca skrótów — wartość sceny dla `RarogCommands`.
public struct RarogShortcutContext {
  public let menu: ShortcutMenu
  public let perform: @MainActor (RarogShortcut) -> Void
  /// Cmd+S (`false`) i Shift+Cmd+S (`true`): przełącznik aktywnych sesji.
  public let switchSession: @MainActor (Bool) -> Void
  /// Cmd+1 to Cmd+9 asks the switcher first; `true`: the open window took the digit (or a digit has just closed it)
  /// and the tab shortcut stays silent.
  public let switcherDigit: @MainActor (Int) -> Bool
  /// ⌘+, ⌘- and ⌘0: the app's text size.
  public let textScale: TextScale
  /// Which text size commands are enabled, read while the root view draws.
  public let textSize: TextSizeMenu
}

extension FocusedValues {
  @Entry public var rarogShortcuts: RarogShortcutContext?
}

/// The first frame before the queue is read from disk (a fraction of a second): the background only, like the system
/// launch screen (`UILaunchScreen` → the `LaunchBackground` color in the app's asset catalog). No name and no logo:
/// the HIG ("Launching") wants the launch screen to look like the first screen, and any element that disappears
/// afterwards flashes. The logo stands on the pairing screen (onboarding).
struct LaunchView: View {
  var body: some View {
    Color(uiColor: Palette.background)
      .ignoresSafeArea()
  }
}

/// Lista stale obok szczegółu na iPadzie; na iPhonie ten sam widok zwija się do stosu.
/// Cmd+B zwija listę tylko przy otwartym szczególe. Przycisk zwijania stoi w lewym górnym rogu
/// nagłówka sesji (`HeaderListToggle`) przy liście rozwiniętej i zwiniętej, więc zwinięcie nie jest
/// pułapką po odłączeniu klawiatury; systemowy uchwyt z paska listy zdjęty, żeby nie było dwóch przycisków.
/// Listę od szczegółu oddziela pionowa kreska (`ColumnDivider`).
struct MainSplitView: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let memory: ConnectionMemory
  let transcriptLink: TranscriptConnectionMemory
  let drafts: ComposerDrafts
  @Environment(\.dynamicTypeSize) private var typeSize
  /// Rozmiar okna, nie kolumny: w `compact` podział zwija się do stosu (iPhone, wąskie okno iPada).
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    NavigationSplitView(columnVisibility: columns, preferredCompactColumn: compactColumn) {
      // 320 pt jak `.pane--list` w PWA (20 rem); przy największym piśmie kolumna szersza, żeby tytuł
      // nie łamał się co słowo.
      SessionListView(
        store: store, navigation: navigation, memory: memory, transcriptLink: transcriptLink,
        besideDetail: sizeClass != .compact)
        .navigationSplitViewColumnWidth(min: 300, ideal: typeSize.isAccessibilitySize ? 460 : 320, max: 520)
        // „Ustawienia” i „Nowa sesja" jedną grupą w pasku listy.
        .modifier(NewSessionListButton(store: store, navigation: navigation))
        .overlay(alignment: .trailing) {
          if sizeClass != .compact { ColumnDivider() }
        }
        // iPhone: lista to osobny ekran stosu — dymek z akcją („Cofnij" po notatce) staje też nad nią. Na iPadzie
        // lista stoi obok szczegółu, który dymek już pokazuje.
        .modifier(ToastOverlay(
          navigation: navigation, placement: sizeClass == .compact ? .overlay : .sessionScreen, actionsOnly: true))
        // Zdanie pod paskiem nad listą w stosie.
        .modifier(ListNoticeOverlay(navigation: navigation, stacked: sizeClass == .compact))
    } detail: {
      NavigationStack {
        DetailView(store: store, navigation: navigation, drafts: drafts, memory: memory, transcriptLink: transcriptLink)
      }
      // Achromatycznie: przyciski systemowe szczegółu i jego arkuszy bez błękitu
      // akcentu — wyróżnia je kontrast, nie kolor (`docs/design.md` „Core principle").
      .tint(Color(uiColor: Palette.text))
    }
    .navigationSplitViewStyle(.balanced)
    // Jedyny arkusz apki: okna (terminal Cmd+F/Cmd+G, historia, diff) i formularze („Nowa sesja",
    // „Ostatnie sesje") — jeden naraz, nad dowolnym ekranem.
    .modifier(SheetHost(store: store, navigation: navigation))
  }

  private var columns: Binding<NavigationSplitViewVisibility> {
    Binding(
      get: { navigation.listHidden ? .detailOnly : .all },
      set: { visibility in
        // Systemowy uchwyt i gest zmieniają widoczność same — zapamiętujemy ją jak Cmd+B.
        guard navigation.canToggleList else { return }
        navigation.setListCollapsed(visibility == .detailOnly)
      }
    )
  }

  /// Kolumna na wierzchu stosu (iPhone, wąskie okno): szczegół, dopóki stoi w nim trasa (`compactShowsDetail`).
  /// Bez tego wiązania stos szedł za zaznaczeniem listy, a terminal i projekt bez sesji wiersza nie mają — wejście
  /// w terminal kończyło się na liście agentów. „Wstecz" i gest krawędzi zdejmują trasę; zapis z szerokiego okna
  /// (lista obok szczegółu) niczego nie zdejmuje.
  private var compactColumn: Binding<NavigationSplitViewColumn> {
    Binding(
      get: { navigation.compactShowsDetail ? .detail : .sidebar },
      set: { column in
        guard sizeClass == .compact, column == .sidebar, navigation.compactShowsDetail else { return }
        navigation.compactReturnedToList()
      }
    )
  }
}

/// Zdanie pod paskiem (`navigation.notice`) nad listą w stosie. Kartę rysuje kolumna
/// szczegółu (`HeaderTabsSlot`), ale w stosie (iPhone, wąskie okno iPada) na wierzchu stoi lista bez szczegółu,
/// a odmowa z jej menu (nowa sesja i terminal z nagłówka projektu, zamknięcie z wiersza) szłaby w próżnię. Tylko
/// gdy szczegółu nie ma na wierzchu: jedna karta naraz, jedno ogłoszenie czytnika. W zwykłej szerokości zdanie stoi
/// obok, w szczególe.
struct ListNoticeOverlay: ViewModifier {
  let navigation: RarogNavigation
  /// Podział zwinięty do stosu — rozmiar OKNA z `MainSplitView`. `horizontalSizeClass` w kolumnie listy jest
  /// `compact` także na iPadzie obok szczegółu (wąska kolumna): z nim karta stała dwa razy (zmierzone).
  let stacked: Bool

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .top) {
        if stacked, !navigation.compactShowsDetail, let notice = navigation.notice {
          NavigationNoticeCard(notice: notice) { navigation.clearNotice($0) }
        }
      }
  }
}

/// Pionowa kreska między listą a szczegółem:
/// 1 piksel fizyczny przez całą wysokość, w kolorze kresek nagłówka (`Palette.border`). Stoi przy
/// prawej krawędzi kolumny listy, więc znika razem z nią po zwinięciu i nie zmienia szerokości kolumn.
struct ColumnDivider: View {
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(width: 1 / max(1, displayScale))
      .ignoresSafeArea()
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}
#endif
