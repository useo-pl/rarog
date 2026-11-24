#if os(iOS)
import GameController
import Observation
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Ekran sesji: transkrypt (`UICollectionView` + diffable data source), wiersz aktywności i pole
/// wiadomości przypięte do `keyboardLayoutGuide` — geometria klawiatury jest faktem systemu, więc
/// obejścia „bazy klawiatury" z PWA nie istnieją. Przy schowanej klawiaturze pole
/// stoi przy dolnej krawędzi ekranu według `FootRest` (`placeFoot`).
///
/// Przypięcie do dna jest STANEM UKŁADU: zmienia je wyłącznie gest człowieka (pozycja
/// ≤ 40 pt od dna = przypięty); rosnąca treść, karta i klawiatura przypięcia nie ruszają, a przy
/// przypiętym widok sam schodzi na dół. Wysłanie własnej wiadomości przypina.
///
/// Kontroler jest rozcięty na pliki-rozszerzenia per obszar (README „Układ plików i właściciele”):
/// `+Cells` (fabryka komórek), `+Send` (pole i wysyłka), `+Decisions` (karty decyzji),
/// `+Pinning` (przypięcie do dna), `+Keys<Obszar>` (skróty klawiszowe). Tu zostaje cykl życia,
/// układ i render. Stan wspólny jest `internal` (rozszerzenia w innych plikach go czytają);
/// komentarz „właściciel:" mówi, który obszar go ZMIENIA — reszta tylko czyta.
@MainActor
final class SessionViewController: UIViewController, UICollectionViewDelegate {
  let store: RarogStore
  let sessionId: String
  /// Kanał ogłoszeń z ujściem systemowym w apce, rejestratorem w testach cyklu życia UIKit.
  let announcer: Announcer
  /// Właściciel: `+Send` (szkic nieudanej wysyłki z zamkniętego ekranu).
  let drafts: ComposerDrafts
  /// Przełącznik sesji: w trakcie jego gestu Esc należy do niego (`+KeysInterrupt`, `+KeysCards`).
  /// Bez niego (testy) Esc działa jak zawsze.
  var switcher: SessionSwitcher?
  /// Nawigacja apki: okno tekstu transkryptu staje przez jej jedyny arkusz. Bez niej (testy) okno nie
  /// wstaje. Właściciel: `SessionControllerHost`.
  weak var navigation: RarogNavigation?

  /// Właściciel: ten plik (budowa i render); `+Pinning` przewija, `+KeysCards` pyta o fokus.
  var collectionView: PinnedCollectionView!
  /// Właściciel: ten plik.
  var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  /// Wiersze ostatniego renderu po identyfikatorze. Właściciel: ten plik (`render`); reszta czyta.
  var rows: [String: TranscriptRow] = [:]
  /// Wiersz aktywności. Właściciel: `ActivityRowView`; ten plik podaje stan, `+FootActivity` go stawia.
  let activityRow = ActivityRowView()
  /// The activity row's own narrow card while the field hides — the first element of the foot (`+FootActivity`).
  let activityCard = FootActivityCard()
  /// The foot: activity card, field, dock, state card. Its top is the one "top of the foot" (`+UnderFoot`).
  private(set) var footStack: SessionFootStack!
  /// Właściciel: `+Send`.
  let composer = ComposerView()
  /// Miejsce karty stanu ZAMIAST pola — w jednym stosie z polem, więc
  /// schowane nie zajmuje miejsca. Właściciel: karty (`+StateCard`).
  let stateCardSlot = UIView()
  /// Dok decyzji ZAMIAST pola: karta zgody, „dialog w terminalu” albo pytanie, w okresie łaski zastępnik —
  /// trzeci element stosu stopy. Właściciel: karty (`+Dock`); widoczność przełącza `+StateCard`.
  let decisionSlot = DecisionDockSlot()
  /// Miejsce karty decyzji: transkrypt bez pola, dok albo transkrypt z polem tylko do odczytu (`DecisionDock.mode`).
  /// Testy ustawiają tryb przed pierwszym renderem (przed wstawieniem ekranu do okna). Właściciel: `+Dock`.
  var decisionMode = DecisionDock.mode
  /// Host karty w doku, miejsce karty, wiersz doku, sufit i ostatnio wyrenderowana treść. Właściciel: `+Dock`.
  var dockHost: UIHostingController<AnyView>?
  var dockPlacement = DecisionDock.Placement.none
  var dockModel: DecisionDockModel?
  var dockCeiling: CGFloat = 0
  var renderedDock: DockRenderKey?
  /// Fokus czytnika był w polu, gdy zamiast pola stanął zastępnik (w doku albo w transkrypcie): przechodzi na kartę,
  /// która go zastąpi (`+Dock`).
  var voiceOverAwaitsDockCard = false
  /// Stopa tego renderu (`FootContent`). Właściciel: ten plik (`render`); `+StateCard` czyta.
  var footContent = FootContent.none
  /// Co stopa pokazała po każdym renderze: (pole, dok). Testy UIKit sprawdzają, że nie ma klatki z oboma.
  var footFrames: [(composer: Bool, dock: Bool)] = []
  /// Ogłoszenia czytnika i jego fokus — w testach podmienione, bo VoiceOver w nich nie działa. Właściciel: `+Dock`.
  var accessibilityPost: (UIAccessibility.Notification, Any?) -> Void = { UIAccessibility.post(notification: $0, argument: $1) }
  var voiceOverFocusedElement: () -> Any? = {
    UIAccessibility.isVoiceOverRunning ? UIAccessibility.focusedElement(using: .notificationVoiceOver) : nil
  }
  /// Wiersz karty decyzji, na której ostatnio stał fokus klawiatury albo VoiceOvera (ratunek fokusu),
  /// i obserwator fokusu VoiceOvera. Właściciel: karty (`+KeysCards`).
  var focusedCardRow: String?
  var cardFocusObserver: NSObjectProtocol?
  /// Właściciel: `+Cells` (czyści go zmiana pisma i motywu tutaj).
  let markdown = MarkdownCache()
  /// The transcript width mode the agent's prose follows; tests put a model on scratch `UserDefaults` here before the
  /// view loads.
  var transcriptWidth = TranscriptWidth.shared
  /// The transcript density the gaps and side margins follow (`+Spacing`); tests put a model on scratch
  /// `UserDefaults` here before the view loads.
  var transcriptDensity = TranscriptDensity.shared

  /// Lokalny stan wierszy. Właściciele: `+Decisions` (`errors`, `notes`, `fullInputRead`; przyjęcie decyzji trzyma
  /// store), `+Send` (`retrying`).
  var ui = TranscriptUIState()
  /// Właściciel: `+Pinning` (gest); `+Send` przypina przy wysłaniu; `+Reading` — skok „na dół"
  /// i powrót do odpiętej sesji.
  var pinned = true
  /// Pasek „na dół", przygaszenie, powrót na miejsce. Właściciel: `+Reading` i `+Pinning`.
  let readingChrome = ReadingChrome()
  /// The pointer selection across transcript rows. Owner: `+PointerSelection`, `+PointerAutoscroll`.
  let pointerChrome = TranscriptPointerChrome()
  /// A path in inline code opens the session file. Owner: `+FileOpen`.
  let fileChrome = TranscriptFileChrome()
  /// Dyktowanie w polu wiadomości. Właściciel: `+Voice` (`Session/Voice/`).
  let dictation = ComposerDictation()
  /// The voice conversation of this screen. Owner: `+VoiceAgent` (`Session/Voice/Realtime/`).
  let voiceAgentChrome = VoiceAgentChrome()
  /// Dymek o innej sesji nad promptem. Właściciel: `+Toast`.
  let toastChrome = ToastChrome()
  /// Prośby o dymek modelu z komendy apki `/model` i `/effort`. Prosi `+AppCommands`, otwiera
  /// pigułka modelu (`+Controls`).
  let modelSheetRequests = ModelSheetRequests()
  private var renderPending = false
  private var lastRenderAt = Date.distantPast
  private var announcedUnconfirmed: Set<UUID> = []
  /// Karty decyzji, o których czytnik już wie (ogłoszenie nowej karty).
  private var cardSpeech = DecisionCardSpeech()
  /// Okres łaski przed kartą „dialog w terminalu”: render na terminie i ślad pierwszej karty. Właściciel:
  /// `+DecisionGrace` (karty).
  let decisionGrace = DecisionGraceChrome()
  /// Karta zastana w doku, o której czytnik jeszcze nie słyszał (`announceUnspokenDockCard`).
  private var unspokenDockCard: DecisionCardSpeech.Event?
  /// Wynik akcji mówi tylko w tej prezentacji ekranu; opuszczenie jej unieważnia stare żądania.
  private(set) var announcementScope = UUID()
  /// Zdanie pod polem zostawione przez wynik akcji (gaśnie przy edycji). Właściciel: `+Send`
  /// (wynik przerwania stawia je też `+Interrupt`).
  var transientHint = false
  /// The light tap felt when a queue take-back gesture starts or replays a take-back (`+QueueTakeBack`); tests count
  /// the calls instead.
  var queueTakeBackFeedback: @MainActor () -> Void = { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
  /// Stop, szkic, ekran bez wygaszania, „obejrzane", pasek promptu. Właściciel: `+Interrupt`.
  let turnChrome = TurnChrome()
  /// Stopa (pole albo karta stanu) nad klawiaturą i przy dolnej krawędzi ekranu. Właściciel: ten plik
  /// (`layout`, `placeFoot`).
  private var footAboveKeyboard: NSLayoutConstraint!
  private var footDown: NSLayoutConstraint!
  private var footAtRest: NSLayoutConstraint!
  /// Linie paska skrótów już zapisane w `client.log` w tym procesie (pomiar na iPadzie).
  private static var shortcutBarTraced: Set<String> = []

  /// Najwyżej ~16 przebudów na sekundę przy strumieniu delt (plan: throttle 60 ms).
  private let minRenderInterval: TimeInterval = 0.06

  init(store: RarogStore, sessionId: String, drafts: ComposerDrafts, announcer: Announcer = .shared) {
    self.store = store
    self.sessionId = sessionId
    self.drafts = drafts
    self.announcer = announcer
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  // MARK: - Widok

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Palette.background
    buildCollection()
    buildComposer()
    layout()
    installDecisionDock()
    buildReading()
    buildPointerSelection()
    buildFileOpen()
    buildToast()
    buildCommandSuggestions()
    buildVoice()
    // Zmiana motywu albo pisma przebudowuje komórki tylko przy REALNEJ różnicy wobec tego, z czym je
    // skonfigurowano; w tle (zrzuty przełącznika aplikacji w obu motywach) decyzja czeka na powrót (`+Look`).
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]) {
      (self: SessionViewController, _: UITraitCollection) in
      self.lookChanged()
    }
    // On the flat path (a Mac) a step of the app's text size changes no trait: the model's step goes the same way.
    Fonts.follow(self) { [weak self] in self?.lookChanged() }
    // The width mode is chosen in Settings, which changes no trait either.
    TranscriptWidth.follow(self, width: transcriptWidth) { [weak self] in self?.lookChanged() }
    TranscriptDensity.follow(self, density: transcriptDensity) { [weak self] in self?.lookChanged() }
    installLook()
    trackAndRender()
    restoreDraft()
    installTurnControl()
    installDiagnostics()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // Z klawiaturą sprzętową od razu się pisze; na dotyku klawiatura się nie wysuwa.
    if GCKeyboard.coalesced != nil, composer.isEditable { composer.textView.becomeFirstResponder() }
    // Przy stojącej decyzji pole jest wygaszone: klawisze (Tab na kartę, Esc) odbiera ekran (`+KeysCards`).
    claimKeyboardForCards()
    announceUnspokenDockCard()
    appearTurnControl()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    placeFoot()
    // The foot's cards follow the transcript's side margin, which may grow with the width (`+Spacing`); before the
    // list's bottom inset, which reads the foot's top.
    placeFootSides()
    // Sufit karty w doku z wysokości ekranu i miejsca nad klawiaturą (`+Dock`).
    placeDockCeiling()
    traceShortcutBar()
    // Bottom inset of the list from the top of the foot, before the pin goes back to the bottom (`+UnderFoot`).
    placeTranscriptInset()
    // Nowa szerokość listy: godzina przy dymku promptu mogła przejść obok ↔ pod (`+Cells`). Przed przypięciem —
    // zmienione wysokości wierszy liczą się już w zejściu na dno.
    refreshPromptClocks()
    // The quote bar follows the transcript's side margin, which may grow with the width (`+Spacing`).
    placePromptBarSides()
    // Zmiana wysokości (klawiatura, obrót, baner) nie zmienia przypięcia — przypięty zostaje na dnie,
    // odpięty wraca na swój wiersz (`+Pinning`).
    holdPositionOnLayout()
    // Rozmiar dymka z szerokości transkryptu i przejazd nad pasek „na dół" (`+Toast`).
    settleToast()
    // Układ dojeżdża do dna albo wraca na miejsce: punkt obserwacji okna wejścia do sesji (`+Reading`).
    observeEntry()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    placeFoot()
    // A wider side margin of the density counts from the side safe areas (`+Spacing`).
    followTranscriptSafeArea()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    announcementScope = UUID()
    leaveReading()
    leavePointerSelection()
    leaveTurnControl()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Po przejściu, nie przed nim: cofnięty gest powrotu nie kończy dyktowania (`+Voice`).
    leaveVoice()
  }

  // MARK: - Klawiatura

  func canAnnounce(in scope: UUID) -> Bool {
    scope == announcementScope && viewIfLoaded?.window != nil && store.state.auth == .loggedIn
      && store.state.viewedSessionId == sessionId
  }

  /// Skróty składane z list per obszar (pliki `+Keys<Obszar>`); nowy obszar dopisuje swoją listę.
  override var keyCommands: [UIKeyCommand]? {
    // Kolejność ma znaczenie przy Esc: skrót kart (karta z fokusem, arkusz) stoi PRZED skrótem przerwania
    // tury — przy jego werdykcie `false` Esc idzie dalej, do przerwania (`+KeysInterrupt`).
    [cardKeyCommands, tabKeyCommands, answerKeyCommands, interruptKeyCommands, voiceKeyCommands, voiceAgentKeyCommands]
      .flatMap { $0 }
  }

  /// Ekran przyjmuje klawisze, gdy nikt nie pisze (pole wygaszone przy decyzji): Tab na kartę i Esc
  /// muszą do niego dojść (`+KeysCards`).
  override var canBecomeFirstResponder: Bool { true }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    // Obszar, który zna akcję, rozstrzyga; `nil` = nie jego akcja. Lista jak w `keyCommands`.
    let verdicts = [
      cardKeyVerdict(action), tabKeyVerdict(action), answerKeyVerdict(action), interruptKeyVerdict(action),
      voiceKeyVerdict(action), voiceAgentKeyVerdict(action), pointerSelectionVerdict(action),
    ]
    for case let allowed? in verdicts { return allowed }
    return super.canPerformAction(action, withSender: sender)
  }

  // MARK: - Budowa

  private func buildCollection() {
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.showsSeparators = false
    config.backgroundColor = .clear
    // Each layout pass asks for the section, so the side inset follows the column width and the density (`+Spacing`).
    let layout = UICollectionViewCompositionalLayout { [weak self, config] _, environment in
      let section = NSCollectionLayoutSection.list(using: config, layoutEnvironment: environment)
      self?.insetTranscriptSides(section, environment: environment)
      return section
    }
    collectionView = PinnedCollectionView(frame: .zero, collectionViewLayout: layout)
    collectionView.backgroundColor = .clear
    collectionView.delegate = self
    collectionView.keyboardDismissMode = .interactive
    collectionView.alwaysBounceVertical = true
    // Oddech pod ostatnią wiadomością nad wierszem aktywności: tekst nie stoi przyklejony do
    // pustego pasa „pracuje…”. Dno liczy się z `adjustedContentInset`, więc przypięcie schodzi razem z nim.
    // The list runs under the foot: the full inset (foot + this breath) comes from `placeTranscriptInset`.
    collectionView.contentInset.bottom = Self.transcriptBottomInset
    collectionView.allowsSelection = false
    // Fokus klawiatury (Tab) staje wyłącznie na kartach decyzji — Esc z fokusem w karcie zgody =
    // „Odrzuć", na karcie pytania cyfry wybierają, a Enter = „Odpowiedz" (`+KeysAnswers`).
    // Spacja (i Enter na karcie zgody) na skupionej komórce nic nie robi: bez zaznaczania i bez
    // akcji głównej.
    collectionView.allowsFocus = true
    collectionView.accessibilityIdentifier = "transcript"
    collectionView.onContentSizeChange = { [weak self] in
      guard let self, self.pinned, !self.autoScrollBlocked else { return }
      self.scrollToBottom()
      self.observeEntry()
    }
    dataSource = makeDataSource(collectionView)
  }

  private func layout() {
    // Stopa ekranu: wiersz aktywności we własnej karcie, gdy pole jest schowane (`+FootActivity`), pole, dok decyzji
    // (`+Dock`) albo karta stanu w jego miejscu (`+StateCard`) — schowane nie zajmuje miejsca. Lista podpowiedzi komend
    // stoi nad polem, poza stopą, a dotyk w niej i tak do niej dochodzi (`SessionFootStack`).
    let foot = SessionFootStack(arrangedSubviews: [activityCard, composer, decisionSlot, stateCardSlot])
    footStack = foot
    foot.axis = .vertical
    // The density's extra side margin is a margin of the arrangement (`+Spacing`): the stack itself, the container of
    // the soft scroll edge, keeps the full width. Its bottom stands under the bottom safe area at rest, so its margins
    // do not take the safe area in.
    foot.insetsLayoutMarginsFromSafeArea = false
    foot.directionalLayoutMargins = .zero
    foot.isLayoutMarginsRelativeArrangement = true
    activityCard.isHidden = true
    stateCardSlot.isHidden = true
    decisionSlot.isHidden = true
    composer.installActivity(activityRow)
    activityRow.announcer = announcer
    activityRow.onContentChange = { [weak self] has in
      self?.activityCard.setContent(has)
      self?.placeActivityBand()
    }
    for item in [collectionView!, foot] as [UIView] {
      item.translatesAutoresizingMaskIntoConstraints = false
    }
    view.addSubview(collectionView)
    view.addSubview(foot)
    // The foot floats over the transcript: glass cards, the system's soft scroll edge under them (`+UnderFoot`).
    installScrollEdge()
    // The field card 10 pt from the column's edges, like the list footer card, the dock and the state card.
    let side = ListFooterMetrics.cardSide
    composer.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: side, bottom: 0, trailing: side)
    let guide = view.keyboardLayoutGuide
    guide.followsUndockedKeyboard = true
    // Prowadnica bez safe area: przy schowanej klawiaturze jej góra to dolna krawędź ekranu, a odstęp pola
    // od tej krawędzi daje `placeFoot`. Wysunięta klawiatura stoi ponad safe area, więc nad nią stopa stoi
    // jak dawniej: dołem na górze klawiatury. Pasek skrótów klawiatury sprzętowej leży nad polem (`placeFoot`).
    guide.usesBottomSafeArea = false
    footAboveKeyboard = foot.bottomAnchor.constraint(lessThanOrEqualTo: guide.topAnchor)
    footAtRest = foot.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor)
    // Stopa ciągnie w dół, aż zatrzyma ją klawiatura albo odstęp od krawędzi ekranu.
    footDown = foot.bottomAnchor.constraint(equalTo: guide.topAnchor)
    footDown.priority = .defaultHigh
    NSLayoutConstraint.activate([
      footAboveKeyboard, footAtRest, footDown,
      collectionView.topAnchor.constraint(equalTo: view.topAnchor),
      collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      // The list reaches the bottom of the screen and the foot stands over it; its inset covers the foot (`+UnderFoot`).
      collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      foot.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      foot.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
    ])
  }

  /// The field card's bottom edge with the keyboard down stands `ListFooterMetrics.bottomGap` from the bottom edge of
  /// the screen, the list footer card's gap, so on the iPad both glass cards end on one line. Pod kartą pola
  /// stopa ma jeszcze `ComposerView.bottomInset`, więc schodzi o tyle niżej; nad klawiaturą stopa zawsze kończy się na
  /// jej górze, a karta stoi pasmem `bottomInset` nad nią.
  private func placeFoot() {
    guard let footAtRest, let footAboveKeyboard, let footDown else { return }
    let below = ComposerView.bottomInset
    let gap = ListFooterMetrics.bottomGap(safeBottom: view.safeAreaInsets.bottom)
    // Klawiatura = prowadnica wchodzi w ekran sesji. Sama wysokość prowadnicy kłamie, gdy widok nie sięga
    // dołu okna: wtedy prowadnica bez safe area ma wysokość pasa pod widokiem także bez klawiatury.
    let guideFrame = view.keyboardLayoutGuide.layoutFrame
    let overlap = max(0, view.bounds.maxY - guideFrame.minY)
    let rest = below - gap
    // Niska prowadnica (pigułka „PL EN + mikrofon” klawiatury sprzętowej) puszcza stopę pod siebie, do spoczynku:
    // pigułka pojawia się przy pustym polu i znika przy pisaniu, a liczona jak klawiatura podnosiłaby pole
    // o ~50 pt. Pasek skrótów nie przesuwa układu.
    let slack = CGFloat(FootRest.guideSlack(
      rest: Double(rest), overlap: Double(overlap), guideHeight: Double(guideFrame.height),
      hardwareKeyboard: GCKeyboard.coalesced != nil))
    if footAtRest.constant != rest { footAtRest.constant = rest }
    if footAboveKeyboard.constant != slack {
      footAboveKeyboard.constant = slack
      footDown.constant = slack
    }
  }

  /// Pasek skrótów (`FootRest.isShortcutBar`) — każdy nowy układ, najwyżej sześć linii na proces: pierwsza prowadnica
  /// bywa klatką animacji (3 pt), a stopa staje na miejscu dopiero w przebiegu po `placeFoot`. Linia mówi, czy układ
  /// został na miejscu: ekran sięga krawędzi okna, wstawka i odstęp pola jak bez pigułki.
  private func traceShortcutBar() {
    // Mierzona jest sama karta pola (pod nią bywa linia komunikatu); schowane pole nie ma czego mierzyć.
    guard Self.shortcutBarTraced.count < 6, let window = view.window, !composer.isHidden,
      let card = composer.textView.superview
    else { return }
    let frame = view.keyboardLayoutGuide.layoutFrame
    guard FootRest.isShortcutBar(guideHeight: Double(frame.height), hardwareKeyboard: GCKeyboard.coalesced != nil)
    else { return }
    let edge = window.bounds.maxY
    let layout = DiagnosticsTrace.ShortcutBarLayout(
      screenShort: Int((edge - view.convert(view.bounds, to: nil).maxY).rounded()),
      safeBottom: Int(view.safeAreaInsets.bottom.rounded()),
      fieldGap: Int((edge - card.convert(card.bounds, to: nil).maxY).rounded()))
    let line = DiagnosticsTrace.shortcutBar(
      height: Int(frame.height.rounded()), width: Int(frame.width.rounded()), layout: layout)
    guard Self.shortcutBarTraced.insert(line).inserted else { return }
    store.trace(line)
  }

  // MARK: - Render

  /// Obserwacja magazynu: każda zmiana stanu planuje JEDEN render (zmiany sklejają się w turze).
  private func trackAndRender() {
    withObservationTracking {
      render()
    } onChange: { [weak self] in
      Task { @MainActor in self?.scheduleRender() }
    }
    // Przypięty transkrypt staje na dnie w tej samej klatce, w której przyszła treść (`+Pinning`). Poza
    // obserwacją: układ komórek czyta stan widoków SwiftUI (szkic karty pytania), który nie może budzić
    // renderu transkryptu.
    if pinned, !autoScrollBlocked { settleAtBottom() }
    observeEntry()
  }

  /// Renders in the current turn instead of the next one: a gesture whose answer takes seconds shows its effect in
  /// the same frame (`+QueueTakeBack`). The render scheduled by the same state change follows and changes nothing.
  func renderNow() {
    // Before `viewDidLoad` there is nothing to render; its first render comes from there.
    guard isViewLoaded else { return }
    trackAndRender()
  }

  /// Planuje render (najwyżej jeden w kolejce). Wołają go obszary po zmianie lokalnego stanu `ui`.
  func scheduleRender() {
    guard !renderPending else { return }
    renderPending = true
    let delay = max(0, minRenderInterval - Date().timeIntervalSince(lastRenderAt))
    Task { @MainActor [weak self] in
      if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
      guard let self else { return }
      self.renderPending = false
      self.trackAndRender()
    }
  }

  private func render() {
    lastRenderAt = Date()
    readingChrome.counters.renders += 1
    // Okno wejścia do sesji (`+Reading`): początek renderu, który pierwszy niesie nowy pełny stan, to pierwsza
    // ramka — tylko on ją otwiera (układ i przewinięcie widzą stan z magazynu wcześniej, przed dławikiem renderu).
    observeEntry(.renderStart)
    // Cechy, z którymi komórki tego ekranu będą skonfigurowane (`+Look`).
    if readingChrome.look == nil { readingChrome.look = currentLook() }
    let state = store.state
    pruneCards(state)
    // Reguła stopy raz na render: miejsce karty decyzji (dok albo transkrypt), przygaszenie, pole (`+Dock`).
    // Jedna chwila na cały render: reguła stopy, dok i ogon liczą okres łaski wobec tego samego `now`.
    let now = Date()
    footContent = FootContent.make(state: state, sessionId: sessionId, ui: ui, now: now)
    let docked = placeDock(state, foot: footContent, now: now)
    prepareReading(state)
    var seen = Set<String>()
    let built = TranscriptRows.build(
      state: state, sessionId: sessionId, ui: ui, docked: docked, dockedPending: dockPlacement.pending, now: now)
      .filter { seen.insert($0.id).inserted }
    handOffPendingThumbnails(previous: rows.values, state: state)
    var next: [String: TranscriptRow] = [:]
    var changed: [String] = []
    var retyped: [String] = []
    for row in built {
      next[row.id] = row
      guard let old = rows[row.id], old != row else { continue }
      // Ten sam numer, inny rodzaj komórki (restart serwera przebudował wiadomość) = nowa komórka.
      if old.isTextual == row.isTextual { changed.append(row.id) } else { retyped.append(row.id) }
    }
    rows = next
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(built.map(\.id))
    if !changed.isEmpty { snapshot.reconfigureItems(changed) }
    if !retyped.isEmpty { snapshot.reloadItems(retyped) }
    dataSource.apply(snapshot, animatingDifferences: false)
    refreshPointerSelection()
    finishReading()
    announce(state, rows: built)
    // Okres łaski i jego ślad liczą też kartę i zastępnik w doku — pierwsze, bo dok stoi na pierwszej decyzji kolejki.
    renderDecisionGrace(state, rows: (dockModel.map { [$0.row] } ?? []) + built)
    activityRow.render(state: state, sessionId: sessionId)
    renderComposer(state)
    renderCommandSuggestions(state)
    // Karta stanu zamiast pola, ratunek fokusu po zniknięciu karty, klawisze przy decyzji.
    renderCards(state)
    renderTurnControl(state)
    renderVoice(state)
    observeEntry(.renderEnd)
  }

  func reconfigureAll() {
    readingChrome.counters.reconfigures += 1
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(snapshot.itemIdentifiers)
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  /// „Nie potwierdzono" słychać RAZ, przy przejściu wpisu; karta decyzji, która stanęła
  /// w trakcie wizyty, raz — nagłówkiem karty, tylko z ekranu w oknie.
  private func announce(_ state: AppState, rows: [TranscriptRow]) {
    let cards = cardSpeech.newCards(in: rows, docked: dockModel?.row)
    guard canAnnounce(in: announcementScope) else {
      // Karta zastana w doku przy wejściu: pierwszy render idzie przed oknem, więc zdanie czeka na `viewDidAppear`.
      if let found = cards.first(where: { $0.id == dockModel?.row.id }) { unspokenDockCard = found }
      return
    }
    announceUnspokenDockCard()
    for entry in state.outboxEntries(for: sessionId) where entry.state == .unconfirmed {
      guard announcedUnconfirmed.insert(entry.id).inserted else { continue }
      announcer.say(UICopy.unconfirmedSpoken, eventID: "unconfirmed:\(entry.id)")
    }
    for card in cards { announcer.say(card.text, eventID: "decision-card:\(sessionId):\(card.id)") }
  }

  /// Zdanie o karcie zastanej w doku, które nie mogło paść przed pojawieniem się ekranu — tylko gdy ta karta
  /// dalej stoi w doku.
  func announceUnspokenDockCard() {
    guard let card = unspokenDockCard, canAnnounce(in: announcementScope) else { return }
    unspokenDockCard = nil
    guard card.id == dockModel?.row.id else { return }
    announcer.say(card.text, eventID: "decision-card:\(sessionId):\(card.id)")
  }
}

// MARK: - Okno tekstu transkryptu

extension SessionViewController: TranscriptSelectionOpening {
  /// „Zaznacz więcej…” z menu wiadomości: migawka tekstu załadowanych wiadomości z TEJ chwili, kursor przy wierszu
  /// `row`. Bez nowego odczytu historii z serwera; okno ustępuje formularzowi jak każde okno.
  func openTranscriptSelection(row: String) {
    guard let navigation, let view = store.state.transcripts[sessionId] else { return }
    let built = TranscriptSelectionText.build(view)
    let project = store.state.sessions[sessionId].map { ProjectPath.name($0.cwd) } ?? ""
    navigation.openSheet(.transcriptText(TranscriptTextRequest(
      sessionId: sessionId, project: project, text: built.text, cursor: built.cursor(row: row))))
  }
}
#endif
