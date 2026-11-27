#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// The "New Session" sheet: Project (name, path, context
/// line and Change; one row of recent project pills with More…; the browser on the project's parent with an explicit
/// Choose) → Start (mode switch, model and effort menus, the sentence about the chosen mode — for auto a warning from
/// the first frame; below them the ultracode switch, when on with the cost sentence; folded to the summary
/// while the browser is open) → Conversations of the chosen directory ("Open" above "Resumable") → a one-line
/// footer: the summary and Launch; while the browser is open the footer holds the hint, Cancel and "Choose <name>"
/// instead (``NewSessionChooseBar``), so the choice is on screen however long the list. No prompt field: the first
/// message is written in the session. After Launch the app enters the session in "starting" at once, and model and
/// effort go to the device memory (mode and ultracode do not — auto remembered globally is a risk, and ultracode
/// costs on every turn). Resume and Fork do not take the Start settings: the conversation comes back on its own
/// (server). Cmd+Enter launches from any field, Enter in the browser field goes to the typed path. Owner: session control.
///
/// The sections live in extensions: `NewSessionSheet+Project`, `+Start` and `+Conversations`; this file holds the
/// state, the footer and the launch actions.
struct NewSessionSheet: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let presenter: NewSessionPresenter
  let request: NewSessionPresenter.Request

  @State var browser: DirectoryBrowser
  @State var path = ""
  /// Recent project pills: the order holds while the window is open (``RecentChips``).
  @State var chips: [String] = []
  @State var settings = StartSettings()
  @State var choices: [ModelChoice] = []
  /// Effort wybrany ręką w tej prezentacji (`.some(nil)` = „auto"); przeżywa przełączanie modeli.
  @State var chosenEffort: EffortLevel??
  /// Zapamiętany wybór urządzenia z chwili otwarcia okna — drugie wejście ``StartModel/resolveEffort``.
  @State var savedDefaults: NewSessionDefaults?
  /// Model wybrany ręką w tej prezentacji — spóźniona lista modeli go nie nadpisuje.
  @State var chosenModel: String?
  @State var resumes = ResumeSection()
  @State private var launching = false
  /// „Wznów" albo „Rozwidl" w drodze. Osobno od `resumes`: sekcja wymienia się przy każdej zmianie katalogu,
  /// a blokada formularza ma trzymać do odpowiedzi.
  @State var resuming = false
  @State var cwdError: String?
  @State private var formError: String?
  @FocusState var pathFocused: Bool
  /// The New Directory name field: focused when it opens.
  @FocusState var dirNameFocused: Bool
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.defaultMinListRowHeight) private var formRowHeight
  /// Rozmiar arkusza: wysokość to sufit zdań stopki, szerokość decyduje o układzie linii Startu
  /// i stopki. Klasa szerokości nie wystarcza: arkusz `.form` na iPadzie raportuje `compact`.
  @State var sheetSize = CGSize(width: 0, height: 800)

  /// Żądanie startu albo wznowienia jest w drodze: formularz nie daje się zamknąć, a jego treść jest wygaszona,
  /// bo każda akcja w niej (zmiana katalogu, „Otwórz sesję", drugie żądanie) zostawiłaby wynik bez adresata.
  var requesting: Bool { launching || resuming }

  /// Zdania stopki (błąd startu, blokada zakładania) zabierają najwyżej tyle wysokości arkusza; ponad sufitem
  /// przewijają się. W największym piśmie stopka bez sufitu zakrywała cały formularz.
  static let footerTextShare: CGFloat = 0.3

  init(store: RarogStore, navigation: RarogNavigation, presenter: NewSessionPresenter, request: NewSessionPresenter.Request) {
    self.store = store
    self.navigation = navigation
    self.presenter = presenter
    self.request = request
    _browser = State(initialValue: DirectoryBrowser(
      load: { [store] dir in await store.listDirectory(dir) },
      create: { [store] parent, name in await store.createDirectory(parent: parent, name: name) }))
  }

  /// Katalog z wejścia ma pierwszeństwo przed ostatnio odwiedzonym projektem tego urządzenia.
  static func startCwd(_ request: NewSessionPresenter.Request, navigation: RarogNavigation) -> String? {
    request.cwd ?? navigation.history.cwds.last
  }

  var body: some View {
    // Wspólny szkielet formularza: pasek z zamknięciem z lewej, Esc i Cmd+W, blokada w trakcie żądania.
    FormSheet(
      title: UICopy.newSessionTitle,
      close: SheetClose(label: UICopy.cancel, identifier: "newSession.cancel") { presenter.close(request) },
      discards: true, locked: requesting
    ) {
      Form {
        projectSection
        startSection
        if browser.browsing || resumes.cwd != nil { resumeSection }
      }
      // Gęsto: na iPadzie lista rozmów ma zacząć się nad zgięciem arkusza.
      .listSectionSpacing(.compact)
      // Compact directory rows while browsing: the form's own minimum row height (52 pt on iOS 26)
      // is read by the form itself, so a row-level value does not apply. Closed browser: the system value.
      .environment(\.defaultMinListRowHeight, browser.browsing ? Self.dirRowHeight : formRowHeight)
      // Achromatycznie: menu i „Zmień” bez systemowego błękitu — przyciski wyróżnia kontrast, nie
      // kolor akcentu (`docs/design.md` „Core principle”).
      .tint(Color(uiColor: Palette.text))
      .toggleStyle(.appSwitch)
      .disabled(requesting)
      .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { sheetSize = $0 }
    // Kontener, nie etykieta na dzieciach: sam identyfikator na szkielecie trafiał w jeden z jego elementów.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("newSession.sheet")
    .task { await start() }
    .onChange(of: browser.input) { _, input in
      if input != path { path = input }
    }
    // Conversations follow the chosen directory, not the browser listing: they reload only after Choose.
    .onChange(of: browser.chosen) { _, chosen in
      cwdError = nil
      Task { await loadResumes(chosen) }
    }
    .onChange(of: store.state.catalog.recent) { _, recent in updateChips(recent) }
    .onChange(of: store.state.global == .online) { _, online in
      // Listing padł (offline, 401) — ponawiamy dokładnie raz, gdy połączenie WRACA.
      if online, browser.failed { browser.retry() }
    }
    .onChange(of: settings.mode) { _, mode in
      // Zdanie o trybie zmienia się na ekranie — czytnik dostaje je od razu, bo dla auto jest ostrzeżeniem.
      Announcer.shared.say(UICopy.startModeHint(mode))
    }
  }

  // MARK: - Stopka i „Uruchom"

  /// iPad: jedna linia — podsumowanie z lewej, „Uruchom” w linii z prawej. Telefon i pismo dostępności:
  /// podsumowanie nad przyciskiem na całą szerokość. O układzie decyduje szerokość arkusza (patrz `sheetSize`).
  private var inlineFooter: Bool {
    sheetSize.width >= Self.oneLineStartWidth && !typeSize.isAccessibilitySize
  }

  /// The auto mode sentence also stands in the footer when the Start section may be below the fold: at
  /// accessibility sizes. The warning must be there from the first frame next to the button that launches.
  /// While the browser is open there is no Launch, and the mode word in the folded Start is amber.
  private var footerWarning: Bool {
    settings.mode == .auto && typeSize.isAccessibilitySize
  }

  /// The footer is pinned under the form: Launch, or while the browser is open the choice.
  private var footer: some View {
    Group {
      if browser.browsing { chooseFooter } else { launchFooter }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .formFooterBar()
  }

  private var launchFooter: some View {
    let blocked = store.state.launchBlocked ? UICopy.launchBlocked(store.state.launchBlockedDetail) : nil
    return VStack(alignment: .leading, spacing: 8) {
      if formError != nil || blocked != nil {
        // Idealna wysokość przewijania = wysokość zdań: bez sufitu stopka wygląda jak bez przewijania.
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            if let formError {
              Text(formError)
                .appFont(.footnote)
                .foregroundStyle(Color(uiColor: Palette.err))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("newSession.formError")
            }
            if let blocked {
              Text(blocked)
                .appFont(.footnote)
                .foregroundStyle(Color(uiColor: Palette.muted))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("newSession.launchBlocked")
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: sheetSize.height * Self.footerTextShare)
        .fixedSize(horizontal: false, vertical: true)
      }
      if footerWarning {
        Text(UICopy.startModeHint(.auto))
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.wait))
          .accessibilityIdentifier("newSession.footerWarning")
      }
      if inlineFooter {
        HStack(spacing: 12) {
          launchSummary.frame(maxWidth: .infinity, alignment: .leading)
          launchButton(blocked: blocked != nil, size: .inline)
        }
      } else {
        launchSummary
        launchButton(blocked: blocked != nil, size: .fullWidth)
      }
    }
  }

  /// "willow · Auto · Opus · xhigh" — the auto mode word in amber, the rest muted.
  @ViewBuilder
  private var launchSummary: some View {
    let cwd = browser.canLaunch ? browser.chosen ?? "" : ""
    let summary = settings.launchSummary(cwd: cwd)
    if !summary.isEmpty {
      let dir = PathField.basename(cwd)
      let mode = UICopy.startModeShort(settings.mode)
      let rest = summary.dropFirst("\(dir) · \(mode)".count)
      (Text("\(dir) · ")
        + Text(mode).foregroundStyle(Color(uiColor: settings.mode == .auto ? Palette.wait : Palette.muted))
        + Text(String(rest)))
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .lineLimit(2)
        .accessibilityLabel(summary)
        .accessibilityIdentifier("newSession.launchSummary")
    }
  }

  private func launchButton(blocked: Bool, size: PrimaryButtonStyle.Size) -> some View {
    Button {
      Task { await launch() }
    } label: {
      if launching {
        ProgressView().tint(Color(uiColor: Palette.muted2))
      } else {
        Text(UICopy.launch)
      }
    }
    // Atrament, nie bursztyn — jak „Sparuj” i `.btn--primary` w PWA: akcentem jest tylko „Wyślij”,
    // a bursztyn w tym formularzu znaczy tryb auto (słowo w podsumowaniu i zdanie pod przełącznikiem).
    .buttonStyle(PrimaryButtonStyle(size: size))
    .frame(minWidth: size == .inline ? 120 : nil)
    .disabled(requesting || blocked || !browser.canLaunch)
    .keyboardShortcut(AppShortcut.launchSession.keyboardShortcut)
    .shortcutTip(UICopy.launch, .launchSession)
    .accessibilityIdentifier("newSession.launch")
  }

  // MARK: - Akcje

  private func start() async {
    let cwd = Self.startCwd(request, navigation: navigation)
    browser.start(cwd)
    if browser.browsing {
      pathFocused = PathField.focusesOnBrowse(hardwareKeyboard: TerminalKeyboard.isConnected())
    } else if let cwd {
      Task { await loadResumes(ProjectPath.normalized(cwd)) }
    }
    updateChips(store.state.catalog.recent)
    let saved = navigation.newSessionDefaults
    savedDefaults = saved
    choices = store.state.sessionControls.models ?? []
    applyModels(saved: saved)
    async let models: Void = loadModels(saved: saved)
    async let recent: Void = store.refreshRecentProjects()
    _ = await (models, recent)
  }

  /// Pills without the project the window opened in; a refreshed list adds new ones at the end.
  private func updateChips(_ recent: [RecentProject]) {
    chips = RecentChips.update(
      shown: chips, server: recent.map(\.cwd), excluding: Self.startCwd(request, navigation: navigation))
  }

  private func loadModels(saved: NewSessionDefaults) async {
    guard let loaded = await store.loadModels(), presenter.isCurrent(request) else { return }
    choices = loaded
    applyModels(saved: saved)
  }

  private func applyModels(saved: NewSessionDefaults) {
    let model = StartModel.resolveModel(options, saved: saved, chosen: chosenModel)
    settings.model = model
    settings.modelLabel = options.first { $0.value == model }?.label ?? model
    syncEffort()
  }

  private func launch() async {
    guard !requesting else { return }
    guard browser.canLaunch, let cwd = browser.chosen else {
      cwdError = UICopy.enterProject
      if !browser.browsing { openBrowser() }
      return
    }
    launching = true
    cwdError = nil
    formError = nil
    let chosen = settings
    let outcome = await store.launchSession(chosen.body(cwd: cwd))
    launching = false
    if case .created = outcome { navigation.rememberNewSessionDefaults(chosen.defaults) }
    finish(outcome, failure: UICopy.launchFailed)
  }

  /// Wynik startu dla TEJ prezentacji: sukces zamyka arkusz i wchodzi w sesję „startuje", błąd
  /// zostaje w formularzu (katalog przy polu, reszta nad „Uruchom", także odmowa ultracode).
  func finish(_ outcome: LaunchOutcome, failure: String) {
    guard presenter.isCurrent(request) else { return }
    switch outcome {
    case let .created(id, _):
      presenter.close(request)
      navigation.openLaunched(id)
    case let .cwdRefused(message):
      // A refused directory opens the browser on its parent, and the sentence stands under it.
      openBrowser()
      cwdError = message ?? failure
      Announcer.shared.say(cwdError ?? "", priority: .urgent)
    case .ultracodeRefused, .blocked, .refused, .offline, .timedOut, .failed, .loggedOut:
      // Odmowa bramki ultracode nie mówi o katalogu: stoi nad „Uruchom” jak reszta odmów, bez
      // rozwijania przeglądarki i bez fokusu na ścieżce.
      formError = UICopy.launchMessage(outcome, fallback: failure)
      if let formError { Announcer.shared.say(formError, priority: .urgent) }
    }
  }
}
#endif
