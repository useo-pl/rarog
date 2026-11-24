#if os(iOS)
import GameController
import Observation
import RarogContract
import RarogCore
import UIKit

// Ekran terminala: linia stanu połączenia, powierzchnia terminala (renderer za
// `TerminalSurface`, SwiftTerm w `RarogTerminal`) i pasek klawiszy stale na dole — wyłącznie bez klawiatury
// sprzętowej, nad klawiaturą ekranową przez `keyboardLayoutGuide`. The "⋯" (Copy, Paste, History) stands in the
// navigation bar and the "×" in the current tab (`TerminalChrome`); the Cmd+F/Cmd+G window has a row of its own
// (`TerminalPopup`). Połączenie,
// ponawianie i kolejkę wyjścia prowadzi `TerminalSession` (RarogCore); magazyn usypia ją w tle i budzi po powrocie (nowe gniazdo `fresh=1`) — ekran trzyma TĘ SAMĄ sesję i TEN SAM
// cel, więc po blokadzie iPada wraca do tego samego terminala, nie do innego wpisu.
//
// The container places the surface in every layout pass: while the on-screen keyboard slides, the surface travels
// with the key bar and its grid changes where the change is out of sight (`TerminalScreenViewController+Keyboard`).
//
// Pierwszy ekran po KAŻDYM świeżym gnieździe (pierwsze połączenie ekranu, powrót z tła, ponowienie) wchodzi naraz:
// bajty zbiera okno ``TerminalScreenViewController/firstScreenWindow`` (80 ms) od pierwszego bajtu, potem `reset`
// i wszystkie `feed` w jednym obrocie pętli — SwiftTerm maluje je jedną klatką. Do końca okna stoi stary obraz.
// Pełna ramka serwera to jedna wiadomość WS, ale zaraz po niej panel wraca do rozmiaru iPada i program (zsh/p10k,
// nvim) dorysowuje się po SIGWINCH; bez okna widać by było dwa kroki („przerysowanie").
// Narysowanie pierwszego ekranu próby świeżej (nowy ekran, powrót z tła) zostawia ślad czasu otwarcia w `client.log`
// (`TerminalOpenTrace`, własny podbudżet 6 linii na godzinę): same liczby, bez treści. Powrót sceny z tła zostawia
// po 3 s własne linie (`TerminalReturnTrace`, do 3, podbudżet 4 powroty na godzinę): siatki z tła, próbki układu,
// pierwszy ekran i porcje bajtów — sam odczyt, bez wpływu na układ.
//
// Okno ekranu (Cmd+F/Cmd+G) włącza pas w kolorze krawędzi siatki (``TerminalScreenViewController/paintsEdges``):
// nakładka `TerminalEdgeFill` nad stosem maluje odstęp wokół siatki — także pas okna poza widokiem ekranu
// (``TerminalScreenViewController/windowInsets``) — kolorem skrajnych komórek. Trasa pasa nie ma.
//
// Wejścia do powłoki idą JEDNĄ drogą (`sendInput`: uzbrojone modyfikatory paska, ramki `in`), wklejka DRUGĄ
// (`paste`: ramki `pa`) — powierzchnia nigdy nie owija wklejki sama. Treść terminala nie trafia do logów,
// na dysk ani do pamięci podręcznej: schowek dostaje tekst wyłącznie na gest człowieka.
// Właściciel: terminal.

/// Czy jest klawiatura sprzętowa (`GCKeyboard.coalesced`). Build Debug: `RAROG_UI_TEST_NO_HW_KEYBOARD=1` udaje
/// jej brak — symulator zgłasza klawiaturę sprzętową zawsze, a zrzuty i testy paska jej nie chcą.
/// `RAROG_UI_TEST_HW_KEYBOARD=1` udaje jej obecność dla testu klawiszy skrótu na zakładkach: symulator nie
/// zawsze ją zgłasza (nagłówek na zrzucie stoi wtedy bez klawiszy), więc „zawsze” zależy od środowiska.
public enum TerminalKeyboard {
  @MainActor
  public static func isConnected() -> Bool {
    #if DEBUG
    if ProcessInfo.processInfo.environment["RAROG_UI_TEST_NO_HW_KEYBOARD"] == "1" { return false }
    if ProcessInfo.processInfo.environment["RAROG_UI_TEST_HW_KEYBOARD"] == "1" { return true }
    #endif
    return GCKeyboard.coalesced != nil
  }
}

/// Schowek ekranu — wstrzykiwany w testach.
struct TerminalClipboard {
  var read: @MainActor () -> String?
  var write: @MainActor (String) -> Void

  static var system: TerminalClipboard {
    TerminalClipboard(read: { UIPasteboard.general.string }, write: { UIPasteboard.general.string = $0 })
  }
}

/// Ekran jednego terminala. Tworzy go nawigacja apki z celu (`init?(store:target:factory:)`); punkty wpięcia nawigacji to
/// ``onClose``, ``onHistory``, ``onTerminalIdentified`` i ``chrome`` (przyciski w pasku nawigacji).
@MainActor
public final class TerminalScreenViewController: UIViewController {
  /// Sesja tego ekranu: jeden cel, jedna sesja przez całe życie ekranu.
  public let session: TerminalSession
  /// Ekran ma zniknąć: powłoka zamknięta „×" (`DELETE` przyjęty albo terminala już nie było) albo — przy
  /// ``closesOnExit`` — zakończona.
  public var onClose: (() -> Void)?
  /// „Historia" (pasek, menu „⋯", Cmd+Y) z id terminala. `nil` = pozycja wygaszona.
  public var onHistory: ((String) -> Void)? {
    didSet { updateHistoryAvailability() }
  }
  /// Id terminala poznany albo zmieniony (pierwsza odpowiedź `POST`, przeniesiony katalog). Nawigacja zapisuje
  /// go w trasie: cel „Nowy terminal" (`slot: next`) odtworzony od nowa założyłby KOLEJNĄ powłokę.
  public var onTerminalIdentified: ((String) -> Void)?
  /// Kopia się udała: zdanie wyniku do dymka apki (`ToastCenter.notice(_:hold:)`). Podpina je host (tab, okno
  /// Cmd+F/Cmd+G); `nil` = zdanie w linii stanu.
  var onCopied: ((String) -> Void)?
  /// Okno nad ekranem (Cmd+F, Cmd+G): koniec programu zamyka okno zamiast „Uruchom ponownie".
  public var closesOnExit = false
  /// Esc z klawiatury sprzętowej, zanim pójdzie do programu: `true` = wzięty. Ustawia okno nad ekranem (okno
  /// powłoki zamyka się Esc-em, `EscapePolicy`); na trasie `nil` — Esc należy do programu.
  var onEscape: (() -> Bool)?
  /// Esc, gdy nad ekranem stoi strona tego samego okna (historia w oknie terminala): `true` = wzięty. Pytany
  /// PRZED arkuszem i przed ``onEscape``, żeby Esc przy stronie na wierzchu nie zamknął okna.
  var escapeAboveScreen: (() -> Bool)?
  /// Ekran nie jest na wierzchu swojego okna (strona historii, zamykanie): pisanie, wklejka i przewijanie nie idą
  /// do programu.
  var inputSuspended = false
  public var terminalId: String? { session.terminalId }
  /// The route's "⋯" in the navigation bar and "×" in the current tab. The window over the screen has buttons of
  /// its own and does not set it.
  public var chrome: TerminalChrome? {
    didSet {
      guard oldValue !== chrome else { return }
      oldValue?.detach(self)
      if !shutDown { chrome?.attach(self) }
      renderChrome()
    }
  }

  let surface: any TerminalSurface
  private let closeTerminal: @MainActor (String) async -> TerminalCloseOutcome

  // Wstrzykiwane w testach.
  var hardwareKeyboard: @MainActor () -> Bool = { TerminalKeyboard.isConnected() }
  /// Arkusz nad terminalem (historia) i jego zamknięcie: proces testów arkusza nie prezentuje.
  var sheetAbove: @MainActor (UIView) -> PresentedSheet.Above = { PresentedSheet.above($0) }
  var dismissSheet: @MainActor (UIViewController) -> Void = { PresentedSheet.dismiss($0) }
  var sceneIsActive: (@MainActor () -> Bool)?
  /// Stan sceny dla śladu powrotu z tła (litera `a`/`n`/`t`); `nil` = stan sceny okna. Gospodarz testów UIKit nie ma
  /// `connectedScenes`, więc testy podają go tu (bez ``sceneIsActive`` wyznacza też aktywność sceny).
  var sceneActivation: (@MainActor () -> UIScene.ActivationState)?
  var settleDelay: Duration = ResizeSettler.quiet
  var clipboard = TerminalClipboard.system
  var announcer: Announcer = .shared
  var now: () -> Date = { Date() }
  var noticeHold: Duration = .seconds(3)
  /// Ślad diagnostyczny do `client.log` (`RarogStore.trace`) — wyłącznie fakty, nigdy treść terminala.
  var trace: ((String) -> Void)?
  /// Słowo maszyny serwera w zdaniu czytnika (``AppState/serverMachine``); ekran z magazynu czyta je ze stanu.
  var machine: () -> ServerMachine = { ServerMachine(nil) }
  /// Session switcher: with its window open, Esc and Cmd+. do not go to the program (`handleKey`, `sendInput`).
  var switcher: SessionSwitcher?
  /// Pas wokół siatki w kolorze jej skrajnych komórek: włącza go okno Cmd+F/Cmd+G, trasa nie — u niej
  /// powierzchnia niczego nie liczy, a ekran wygląda jak dotąd.
  public var paintsEdges = false {
    didSet { if paintsEdges != oldValue { updateEdgeFill() } }
  }
  /// Jak daleko poza widok ekranu sięga pas (boki i dół): okno podaje tu swój odstęp między ekranem a krawędzią
  /// arkusza, więc jeden właściciel maluje cały pas, a ramka ekranu, siatki i paska klawiszy zostaje ta sama.
  public var windowInsets = UIEdgeInsets.zero {
    didSet { if windowInsets != oldValue, isViewLoaded { view.setNeedsLayout() } }
  }
  /// Siatka trzyma rozmiar, gdy okno schodzi (zmierzone na iPhonie): stos nie idzie wtedy za
  /// prowadnicą klawiatury, więc ani przeciągnięcie arkusza w dół, ani klawiatura pola wiadomości, które wraca pod
  /// spodem, nie zmienia siatki i nie wysyła `rs`, a ekran idzie do parkingu w rozmiarze sprzed zejścia. Włącza ją
  /// okno Cmd+F/Cmd+G; trasa bez zmian.
  public var holdsGridWhileClosing = false {
    didSet { if holdsGridWhileClosing != oldValue, isViewLoaded { view.setNeedsLayout() } }
  }
  /// Dół stosu na prowadnicy klawiatury i — zamiast niego, gdy okno schodzi — wysokość stosu z ostatniego układu.
  private var stackBottom: NSLayoutConstraint?
  private(set) var heldHeight: NSLayoutConstraint?
  /// The surface while the on-screen keyboard slides (`TerminalScreenViewController+Keyboard`).
  var keyboardSlide = TerminalKeyboardSlide()
  /// Whether the on-screen keyboard is up; `nil` = the keyboard layout guide (tests: a fake).
  var keyboardIsUp: (@MainActor () -> Bool)?
  /// Czy koniec serii strzałki idzie do śladu — budżet wspólny dla procesu (``TerminalKeyRepeatTraceBudget``).
  var admitKeyRepeatTrace: (TerminalKeyRepeatEnd) -> Bool = { TerminalScreenViewController.keyRepeatBudget.admit($0) }
  private static var keyRepeatBudget = TerminalKeyRepeatTraceBudget()
  /// Zegar monotoniczny śladu otwarcia — ten sam, którym sesja stempluje próbę (testy: atrapa w obu).
  var clock: () -> ContinuousClock.Instant = { ContinuousClock.now }
  /// Czy ślad otwarcia idzie do `client.log` — podbudżet wspólny dla procesu (``TerminalOpenTraceBudget``).
  var admitOpenTrace: (ContinuousClock.Instant) -> Bool = { TerminalScreenViewController.openTraceBudget.admit(now: $0) }
  private static var openTraceBudget = TerminalOpenTraceBudget()
  /// Czy ślad powrotu z tła idzie do `client.log` — podbudżet wspólny dla procesu (``TerminalReturnTraceBudget``).
  var admitReturnTrace: (ContinuousClock.Instant) -> Bool = {
    TerminalScreenViewController.returnTraceBudget.admit(now: $0)
  }
  private static var returnTraceBudget = TerminalReturnTraceBudget()
  /// Okno i odstęp próbek śladu powrotu z tła — w testach krótsze.
  var returnTraceWindow: Duration = TerminalReturnTrace.window
  var returnSampleInterval: Duration = TerminalReturnTrace.sampleInterval
  /// Ślad powrotu z tła: od dezaktywacji sceny zmiany siatki i pominięte układy, od aktywacji po tle próbki przez
  /// ``returnTraceWindow``.
  /// `nil` = nic nie zbiera.
  private var returnTrace: TerminalReturnTrace?
  private var returnSampler: Task<Void, Never>?

  let statusBar = UIStackView()
  let statusLabel = UILabel()
  let statusButton = UIButton(type: .system)
  let container = TerminalSurfaceContainer()
  private(set) lazy var keyBar = TerminalKeyBar(pasteTarget: surface.view)
  private let stack = UIStackView()
  /// Nakładka pasa: nad stosem, pod linią stanu; ukryta, dopóki ``paintsEdges`` jest wyłączone.
  let edgeFill = TerminalEdgeFill()

  private(set) var modifiers = TerminalModifiers()
  private var settler = ResizeSettler()
  private var closeArm = TerminalCloseArm()
  private var closing = false
  private var notice: (id: Int, text: String)?
  private var noticeCount = 0
  /// Nowe gniazdo zaczyna się pełną ramką: emulator od zera przed jej pierwszymi bajtami.
  private var needsReset = true
  /// Odstęp treści terminala od lewej i prawej krawędzi ekranu (kreska listy, brzeg okna Cmd+F/G), żeby litery
  /// nie stały doklejone do kreski. Odstęp robi RAMKA widoku SwiftTerm, nie wstawka treści:
  /// kolumny liczą się z rzeczywistej szerokości widoku, a punkty gestów (`location(in:)`) są w jego układzie,
  /// więc zaznaczanie trafia w te same komórki. Tło odstępu to tło terminala (kontener).
  public static let sideInset: CGFloat = 8

  /// Okno sklejania pierwszego ekranu po świeżym gnieździe — w testach krótsze.
  var firstScreenWindow: Duration = TerminalScreenViewController.firstScreenDelay
  static let firstScreenDelay: Duration = .milliseconds(80)
  /// Numer połączenia (rośnie przy KAŻDYM pytaniu sesji o rozmiar, czyli przed każdym upgrade'em).
  private var connection = 0
  /// Bajty pierwszego ekranu w oknie — związane z połączeniem, które je przysłało.
  private var firstScreen: (connection: Int, chunks: [Data], flush: Task<Void, Never>)?
  /// Chwila `viewIsAppearing`, które wystartowało sesję — początek śladu „nowy ekran". Start bez pojawienia się
  /// (łączenie po odmowie `DELETE`) ją kasuje: nie ma od czego liczyć.
  private var appearedAt: ContinuousClock.Instant?
  /// Czasy próby świeżej od sesji: czekają na narysowanie pierwszego ekranu jej gniazda (odrzucony nie raportuje).
  private var openTiming: (connection: Int, origin: TerminalOpenTrace.Origin, timing: TerminalConnectTiming)?
  private var reportedId: String?
  private var lastSpoken: String?
  private var shutDown = false
  /// `DELETE` bez odpowiedzi: linia stanu mówi to wprost, a ekran nie łączy się sam (``TerminalStatus/closeUnknown``).
  private var closeUnknown = false
  /// Odmowa `DELETE` przyszła w tle: łączenie czeka na powrót sceny na wierzch.
  private var startOnActivation = false
  /// `exit` przyszedł, gdy okno nie miało właściciela (parking, droga do nowego okna): zamknie okno dopiero
  /// ``activate(parkedFor:resumesInput:)`` nowego.
  private var closeWhenAdopted = false
  /// Ekran czeka w parkingu: stan sesji nie idzie do czytnika — człowiek patrzy gdzie indziej.
  private var parked = false

  public init(
    session: TerminalSession, surface: any TerminalSurface,
    close: @escaping @MainActor (String) async -> TerminalCloseOutcome
  ) {
    self.session = session
    self.surface = surface
    self.closeTerminal = close
    super.init(nibName: nil, bundle: nil)
  }

  /// Ekran dla celu z magazynu; `nil` bez zalogowania albo bez transportu terminala.
  public convenience init?(store: RarogStore, target: TerminalTarget, factory: TerminalSurfaceFactory) {
    guard let session = store.terminalSession(target) else { return nil }
    let surface = factory(.standard(idiom: UIDevice.current.userInterfaceIdiom))
    self.init(
      session: session, surface: surface,
      close: { [weak store] id in await store?.closeTerminal(id: id) ?? .failed(nil) })
    trace = { [weak store] line in store?.trace(line) }
    machine = { [weak store] in store?.state.serverMachine ?? ServerMachine(nil) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  isolated deinit {
    // Zejście ekranu bez `shutdown()` (np. zwolniony popup) nie może zostawić żywego gniazda ani renderera.
    session.stop()
    surface.close()
  }

  /// Koniec ekranu (zmiana trasy, zamknięte okno): gniazdo zamknięte, spóźnione odpowiedzi (także `DELETE`)
  /// odcięte, renderer zwolniony.
  public func shutdown() {
    shutDown = true
    chrome?.detach(self)
    startOnActivation = false
    discardFirstScreen()
    cancelReturnTrace()
    session.stop()
    surface.close()
  }

  // MARK: - Widok

  public override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Palette.background
    view.accessibilityIdentifier = "terminal.screen"
    buildStatus()
    buildSurface()
    keyBar.onKey = { [weak self] key in self?.barKey(key) }
    keyBar.onArrow = { [weak self] direction in self?.sendInput(direction.bytes) }
    stack.axis = .vertical
    stack.translatesAutoresizingMaskIntoConstraints = false
    for part in [container, keyBar] as [UIView] { stack.addArrangedSubview(part) }
    view.addSubview(stack)
    let guide = view.safeAreaLayoutGuide
    // Pasek (albo powierzchnia, gdy paska nie ma) stoi na klawiaturze ekranowej; bez niej — na dole.
    let bottom = stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
    stackBottom = bottom
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
      bottom,
    ])
    // Linia stanu NAKŁADA się na górę powierzchni zamiast brać jej miejsce: inaczej każde „Łączę…" przy połączeniu
    // i każde zdanie Kopiuj/Wklej zmieniałoby siatkę o wiersz — upgrade z rozmiarem bez wiersza, potem `rs`
    // z powrotem, czyli dwa SIGWINCH w panelu za jeden gest.
    // Pas nad stosem (przykrywa też wąski pas wewnątrz widoku SwiftTerm), pod linią stanu (ta ma własne tło).
    view.addSubview(edgeFill)
    statusBar.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(statusBar)
    // Stos pod górnym obszarem bezpiecznym, czyli pod paskiem — także w oknie Cmd+F/Cmd+G.
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: guide.topAnchor),
      statusBar.topAnchor.constraint(equalTo: container.topAnchor),
      statusBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      statusBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
    ])
    wireSession()
    updateKeyBar()
    updateHistoryAvailability()
    updateEdgeFill()
    observeSession()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(keyboardsChanged), name: .GCKeyboardDidConnect, object: nil)
    center.addObserver(self, selector: #selector(keyboardsChanged), name: .GCKeyboardDidDisconnect, object: nil)
    observeKeyboardSlide()
    center.addObserver(
      self, selector: #selector(sceneDeactivated(_:)), name: UIScene.willDeactivateNotification, object: nil)
    center.addObserver(self, selector: #selector(sceneActivated(_:)), name: UIScene.didActivateNotification, object: nil)
    center.addObserver(
      self, selector: #selector(sceneEnteredBackground(_:)), name: UIScene.didEnterBackgroundNotification, object: nil)
  }

  public override func viewWillLayoutSubviews() {
    super.viewWillLayoutSubviews()
    updateGridHold()
  }

  public override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    guard paintsEdges else { return }
    // Pas sięga poza widok ekranu o pas okna (boki i dół); u góry kończy się na ekranie.
    let reach = windowInsets
    edgeFill.frame = view.bounds.inset(
      by: UIEdgeInsets(top: 0, left: -reach.left, bottom: -reach.bottom, right: -reach.right))
    renderEdges()
  }

  public override func viewIsAppearing(_ animated: Bool) {
    super.viewIsAppearing(animated)
    updateKeyBar()
    // Pierwsze pojawienie się: układ już jest, więc rozmiar przed upgrade'em jest prawdziwy.
    if session.phase == .idle, !shutDown, !demoScreen {
      appearedAt = clock()
      session.start()
    }
  }

  public override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // Anulowane przeciągnięcie okna w dół: okno znów stoi, więc siatka wraca do prowadnicy klawiatury.
    updateGridHold()
    // Z klawiaturą sprzętową od razu się pisze; na dotyku klawiatura się nie wysuwa (jak pole sesji).
    // Fokus sam ponawia rozmiar (`onFocus`); bez fokusu robi to ekran — jeden `rs`, nie dwa.
    let focused = hardwareKeyboard() && surface.view.becomeFirstResponder()
    if !focused { reassertSize() }
    #if DEBUG
    if demoScreen { surface.feed(TerminalDemoSeam.screen(for: session.role)) }
    #endif
  }

  /// Ekran bez połączenia, ze zmyślonym ekranem powłoki — tylko build Debug i szew testów UI (``TerminalDemoSeam``).
  private var demoScreen: Bool {
    #if DEBUG
    TerminalDemoSeam.isOn
    #else
    false
    #endif
  }

  /// Id terminala dla historii; w szwie testów UI stały, bo ekran się nie łączy.
  private var historyTerminalId: String? {
    #if DEBUG
    if TerminalDemoSeam.isOn { return TerminalDemoSeam.terminalId }
    #endif
    return session.terminalId
  }

  public override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    closeArm.disarm()
    renderChrome()
  }

  private func buildStatus() {
    statusBar.axis = .horizontal
    statusBar.alignment = .center
    statusBar.spacing = 8
    statusBar.isLayoutMarginsRelativeArrangement = true
    statusBar.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16)
    statusBar.backgroundColor = Palette.background
    statusBar.accessibilityIdentifier = "terminal.status"
    applyStatusFonts()
    statusLabel.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    statusLabel.textColor = Palette.muted
    statusLabel.numberOfLines = 0
    statusLabel.accessibilityIdentifier = "terminal.status.text"
    statusButton.titleLabel?.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    statusButton.tintColor = Palette.text
    statusButton.accessibilityIdentifier = "terminal.status.action"
    statusButton.setContentHuggingPriority(.required, for: .horizontal)
    statusButton.addAction(UIAction { [weak self] _ in self?.statusActionTapped() }, for: .primaryActionTriggered)
    statusBar.addArrangedSubview(statusLabel)
    statusBar.addArrangedSubview(statusButton)
    // Kreska oddziela linię stanu od treści terminala, na którą się nakłada.
    let rule = UIView()
    rule.backgroundColor = Palette.border
    rule.translatesAutoresizingMaskIntoConstraints = false
    statusBar.addSubview(rule)
    NSLayoutConstraint.activate([
      rule.leadingAnchor.constraint(equalTo: statusBar.leadingAnchor),
      rule.trailingAnchor.constraint(equalTo: statusBar.trailingAnchor),
      rule.bottomAnchor.constraint(equalTo: statusBar.bottomAnchor),
      rule.heightAnchor.constraint(equalToConstant: 1),
    ])
    statusBar.isHidden = true
    // On the flat path (a Mac) a step of the app's text size sends no trait change: the fonts follow the model.
    Fonts.follow(self, scale: .shared) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.applyStatusFonts()
    }
  }

  /// The status line's fonts at the app's text size.
  private func applyStatusFonts() {
    let footnote = TextStyleScaling.font(.footnote, category: TextScale.shared.effective)
    statusLabel.font = footnote
    statusButton.titleLabel?.font = footnote.withTraits(.traitBold)
  }

  private func buildSurface() {
    container.screen = self
    container.surfaceView = surface.view
    container.backgroundColor = Palette.background
    container.accessibilityIdentifier = "terminal.surface"
    let surfaceView = surface.view
    // The container places the surface itself in every layout pass (`placeSurface()`), also while the on-screen
    // keyboard slides, and clips it: during the slide up the surface stands above the container's top.
    surfaceView.translatesAutoresizingMaskIntoConstraints = true
    surfaceView.autoresizingMask = []
    surfaceView.accessibilityLabel = UICopy.terminalScreen
    container.addSubview(surfaceView)
    container.clipsToBounds = true
    container.setContentHuggingPriority(.defaultLow, for: .vertical)
    container.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    surface.onInput = { [weak self] text in self?.sendInput(text) }
    surface.onPaste = { [weak self] text in self?.paste(text) }
    surface.onResize = { [weak self] cols, rows in self?.surfaceResized(cols: cols, rows: rows) }
    surface.onScroll = { [weak self] lines, cell in self?.scroll(lines: lines, cell: cell) }
    surface.onCopy = { [weak self] in self?.handleCopy() }
    surface.onFocus = { [weak self] in self?.reassertSize() }
    surface.onKeyRepeatEnded = { [weak self] end in self?.keyRepeatEnded(end) }
    surface.onLayoutSkipped = { [weak self] height in self?.noteReturnSkip(height: height) }
  }

  private func wireSession() {
    session.onBytes = { [weak self] data in self?.receive(data) }
    session.gridProvider = { [weak self] in
      // Sesja pyta o rozmiar tuż przed KAŻDYM upgrade'em, synchronicznie, zanim powstanie gniazdo — to jedyny
      // pewny znak „następne bajty są z nowego gniazda", a nowe gniazdo zaczyna się pełną ramką serwera.
      // Bajty starego gniazda sesja odcina numerem generacji, więc emulator zeruje się dokładnie raz. Okno
      // poprzedniego połączenia (ponowienie w jego trakcie) przepada — jego ekran już nie jest aktualny.
      guard let self else { return nil }
      self.connection += 1
      self.discardFirstScreen()
      self.needsReset = true
      return self.layoutGrid()
    }
    session.onEvent = { [weak self] event in self?.sessionEvent(event) }
    session.onConnectTiming = { [weak self] timing in self?.connectTimed(timing) }
  }

  // MARK: - Sesja

  /// Stan sesji → linia stanu i id terminala.
  private func observeSession() {
    withObservationTracking {
      renderStatus()
      reportIdentity()
      dropFirstScreenUnlessLive()
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in self?.observeSession() }
    }
  }

  private func receive(_ data: Data) {
    if returnTrace?.isRunning == true { returnTrace?.bytes(data.count, at: clock()) }  // sama liczba bajtów
    if needsReset {
      needsReset = false
      let id = connection
      let window = firstScreenWindow
      let flush = Task { @MainActor [weak self] in
        try? await Task.sleep(for: window)
        guard !Task.isCancelled else { return }
        self?.flushFirstScreen(connection: id)
      }
      firstScreen = (id, [data], flush)
      return
    }
    if firstScreen != nil {
      firstScreen?.chunks.append(data)
      return
    }
    surface.feed(data)
  }

  /// Koniec okna: emulator od zera i cały zebrany ekran w jednym obrocie (stary obraz stał do tej chwili). Połączenie
  /// spoza okna albo sesja już nie na żywo (uśpienie, zerwanie, błąd) — bez rysowania; `exit` rysuje zawsze. Ślad
  /// otwarcia zostawia wyłącznie ekran narysowany na żywo — ostatnie wyjście programu przy `exit` to nie otwarcie.
  private func flushFirstScreen(connection id: Int, exiting: Bool = false) {
    guard let pending = firstScreen, pending.connection == id else { return }
    firstScreen = nil
    pending.flush.cancel()
    let timed = openTiming
    openTiming = nil
    guard exiting || session.phase == .live else { return }
    surface.reset()
    for chunk in pending.chunks { surface.feed(chunk) }
    if !exiting, returnTrace?.isRunning == true { returnTrace?.firstScreen(at: clock()) }
    if !exiting, let timed, timed.connection == id { traceOpening(timed.origin, timing: timed.timing) }
  }

  private func discardFirstScreen() {
    firstScreen?.flush.cancel()
    firstScreen = nil
    openTiming = nil
  }

  /// Czasy próby świeżej (sesja oddaje je tuż przed pierwszymi bajtami): czekają na narysowanie pierwszego ekranu
  /// bieżącego połączenia. Start bez chwili pojawienia się (łączenie po odmowie `DELETE`) śladu nie zostawia.
  private func connectTimed(_ timing: TerminalConnectTiming) {
    let origin: TerminalOpenTrace.Origin
    switch timing.trigger {
    case .start:
      guard let appeared = appearedAt else { return }
      appearedAt = nil
      origin = .newScreen(appeared: appeared)
    case .resume:
      origin = .returnFromBackground
    }
    openTiming = (connection, origin, timing)
  }

  /// Jedna linia śladu otwarcia, w podbudżecie (``TerminalOpenTraceBudget``); chwila narysowania = po `feed`.
  private func traceOpening(_ origin: TerminalOpenTrace.Origin, timing: TerminalConnectTiming) {
    let drawn = clock()
    guard let trace, admitOpenTrace(drawn) else { return }
    trace(TerminalOpenTrace.line(origin, timing: timing, drawn: drawn))
  }

  /// Uśpienie, zerwanie, błąd, zatrzymanie: zebrane bajty należą do martwego połączenia — stary obraz zostaje,
  /// a następne gniazdo przyśle pełną ramkę.
  private func dropFirstScreenUnlessLive() {
    guard session.phase != .live, session.phase != .exited else { return }
    discardFirstScreen()
  }

  private func sessionEvent(_ event: TerminalSessionEvent) {
    switch event {
    case .exited:
      // Ostatnie wyjście programu ma być widać — także gdy przyszło w oknie pierwszego ekranu.
      if let pending = firstScreen { flushFirstScreen(connection: pending.connection, exiting: true) }
      if closesOnExit {
        shutdown()
        if let onClose { onClose() } else { closeWhenAdopted = true }  // okno bez właściciela
      }
    case .retargeted:
      discardFirstScreen()  // id raportuje obserwacja; ekran z okna należy do starego terminala
    case .unauthorized:
      break  // 401 wylogowuje magazyn
    }
  }

  private func reportIdentity() {
    guard let id = session.terminalId, id != reportedId else { return }
    reportedId = id
    onTerminalIdentified?(id)
    updateHistoryAvailability()
  }

  /// Siatka z układu do query upgrade'u (`?c=&r=`); `nil` przed układem i przy zerze wierszy (tło).
  private func layoutGrid() -> TerminalGrid? {
    let size = surface.gridSize
    return TerminalGrid(cols: size.cols, rows: size.rows)
  }

  private var isSceneActive: Bool {
    if let sceneIsActive { return sceneIsActive() }
    return sceneActivationState == .foregroundActive
  }

  /// Stan sceny ekranu: atrapa z testów albo scena okna; `nil` = ekran bez sceny.
  private var sceneActivationState: UIScene.ActivationState? {
    if let sceneActivation { return sceneActivation() }
    return viewIfLoaded?.window?.windowScene?.activationState
  }

  /// Zmiana siatki z układu: po ciszy `settleDelay` JEDEN `rs` z ostatnim rozmiarem. Pas w kolorze
  /// krawędzi od razu: siatka powstaje w układzie powierzchni, już PO układzie ekranu.
  private func surfaceResized(cols: Int, rows: Int) {
    if paintsEdges { renderEdges(layoutFirst: false) }
    noteReturnGrid(cols: cols, rows: rows)
    settle(settler.propose(cols: cols, rows: rows))
  }

  /// Fokus wrócił do terminala (i ekran się pojawił): `rs` z `force`. Po odejściu drugiego klienta tego samego
  /// terminala panel zostaje w JEGO rozmiarze, a serwer o tym nie mówi. Idzie po tej samej ciszy co
  /// zmiana układu: stuknięcie wysuwa klawiaturę ekranową, a `rs` ze starą siatką dałby odrysowanie starego ekranu
  /// w mniejszej siatce (skok). Gniazdo jeszcze nie na żywo: otwarcie samo wyśle `rs` z `force`, więc nic.
  private func reassertSize() {
    guard session.phase == .live else { return }
    settle(settler.reassert())
  }

  /// Po ciszy `settleDelay` `rs` zmiany `change`, o ile nadal jest ostatnia (z `force` po fokusie).
  func settle(_ change: Int) {
    let delay = settleDelay
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: delay)
      guard let self else { return }
      // The grid held through the on-screen keyboard's slide changes at its end: the quiet waits for it.
      if self.keyboardSlide.hold != nil {
        self.keyboardSlide.deferredSettle = change
        return
      }
      guard let next = self.settler.settled(change, sceneActive: self.isSceneActive) else { return }
      self.session.resize(next.grid, force: next.force)
    }
  }

  // MARK: - Wejście

  /// Pisanie (klawiatura, pasek, pad, skróty sprzętowe): uzbrojone modyfikatory paska, potem ramki `in`.
  func sendInput(_ text: String) {
    guard !inputSuspended else { return }
    // Sam Esc w geście przełącznika sesji nie wychodzi ŻADNĄ drogą ani w żadnym kodowaniu — także z klawisza,
    // który SwiftTerm obsłużył sam (Cmd+Esc nie przechodzi przez `handleKey`, a w protokole kitty nie jest bajtem).
    if TerminalKeyMap.isEscapeInput(text), takeEscapeForSwitcher() { return }
    let armed = modifiers
    let data = modifiers.apply(text)
    if modifiers != armed { keyBar.show(modifiers) }
    session.send(data)
  }

  /// Przewinięcie historii panelu (kółko, gest, bezwładność po geście). Poza wierzchem okna nie wychodzi na
  /// drut: bezwładność trwa jeszcze przez przejście do strony historii.
  func scroll(lines: Int, cell: TerminalCell?) {
    guard !inputSuspended else { return }
    session.scroll(lines: lines, cell: cell)
  }

  /// Wklejka z dowolnej drogi: surowy tekst schowka ramkami `pa`, NIGDY `in`. Wklejka to nie klawisz —
  /// gasi uzbrojone modyfikatory.
  func paste(_ text: String) {
    guard !inputSuspended else { return }
    modifiers.disarm()
    keyBar.show(modifiers)
    if let sentence = UICopy.terminalPasteOutcome(session.paste(text)) { showNotice(sentence) }
  }

  /// „Wklej" z menu „⋯" i Cmd+V poza powierzchnią: schowek czytany tutaj.
  func handlePasteCommand() {
    guard let text = clipboard.read(), !text.isEmpty else {
      showNotice(UICopy.terminalPasteEmpty)
      return
    }
    paste(text)
  }

  /// „Kopiuj": zaznaczenie, a bez niego widoczny ekran. Do schowka WYŁĄCZNIE na gest.
  /// Każda droga kopii (Cmd+C, „Kopiuj” z dymka zaznaczenia, z paska i z „⋯”) kończy się tu: zaznaczenie znika,
  /// a wynik mówi dymek apki (``onCopied``) zamiast linii stanu. Ekran bez dymków
  /// (host bez centrum) mówi wynik linią stanu jak dotąd. „Nie ma czego skopiować." zostaje w linii stanu.
  func handleCopy() {
    let selection = surface.selectedText.flatMap { $0.isEmpty ? nil : $0 }
    let text = selection ?? surface.visibleText
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      showNotice(UICopy.terminalCopyEmpty)
      return
    }
    clipboard.write(text)
    if selection != nil { surface.clearSelection() }
    if let onCopied {
      onCopied(UICopy.terminalCopyDone)
    } else {
      showNotice(UICopy.terminalCopyDone)
    }
  }

  func handleHistory() {
    guard let id = historyTerminalId, let onHistory else { return }
    onHistory(id)
  }

  /// Puszczenie albo anulowanie klawiszy, które doszło do kontenera — powierzchnia zatrzymuje serię strzałki.
  func hardwareKeysEnded(_ presses: Set<UIPress>, cancelled: Bool) {
    surface.hardwareKeysEnded(presses, cancelled: cancelled)
  }

  /// Koniec serii strzałki: ślad rozstrzyga na iPadzie, czy puszczenie dochodzi do kontenera.
  private func keyRepeatEnded(_ end: TerminalKeyRepeatEnd) {
    guard admitKeyRepeatTrace(end) else { return }
    trace?(end.traceLine)
  }

  /// Esc with the session switcher window open belongs to the switcher.
  /// `true` = Esc zabrany.
  private func takeEscapeForSwitcher() -> Bool {
    guard let switcher, switcher.absorbsEscape else { return false }
    switcher.cancel(.escapeKey)
    return true
  }

  /// Esc, który nie należy do programu: strona nad terminalem w tym samym oknie (``escapeAboveScreen``) i arkusz
  /// nad terminalem (historia z trasy) schodzą pierwsze, potem okno powłoki (``onEscape``). `false` = Esc idzie
  /// do programu. Bez tego Esc przy otwartej historii trafiał bajtem do
  /// programu POD arkuszem, a historia zostawała (klawiaturę trzyma terminal, nie arkusz).
  func takeEscape() -> Bool {
    if escapeAboveScreen?() == true { return true }
    switch sheetAbove(view) {
    case let .dismissable(sheet):
      dismissSheet(sheet)
      return true
    case .held:
      // Arkusz, który nie schodzi albo właśnie schodzi: drugi szybki Esc nie zamyka okna pod nim.
      return true
    case .nothing:
      return onEscape?() ?? false
    }
  }

  /// Klawisz sprzętowy z kontenera (``TerminalSurfaceContainer``).
  func handleKey(_ key: TerminalHardwareKey) {
    // Session switcher window open: Esc and Cmd+. close it and not a byte goes to the program.
    let escapeLike = key == TerminalHardwareKey(TerminalKeyMap.escape) || key == TerminalHardwareKey(".", command: true)
    if escapeLike, takeEscapeForSwitcher() { return }
    // Sam klawisz Esc. Cmd+. zostaje Esc-em dla programu — w oknie powłoki to droga do bajtu ESC z klawiatury.
    if key == TerminalHardwareKey(TerminalKeyMap.escape), takeEscape() { return }
    switch TerminalKeyMap.resolve(key) {
    case let .bytes(bytes)?: sendInput(bytes)
    case .action(.copy)?: handleCopy()
    case .action(.paste)?: handlePasteCommand()
    case .action(.history)?: handleHistory()
    case .action(.close)?: closeKeyPressed()
    case nil: break
    }
  }

  /// Cmd+X has something to close: the screen's "×" stands in the header (`chrome`; the Cmd+F/Cmd+G window has none)
  /// and nothing lies over the screen. Under a sheet the key stays silent: by History the terminal keeps the keyboard,
  /// so the key arrives here.
  var closesByKey: Bool {
    guard chrome != nil, case .nothing = sheetAbove(view) else { return false }
    return true
  }

  /// Cmd+X: the same as the header's "×": the first press arms, the second ends the shell. The arming speaks
  /// (``closeTapped()``), the key says nothing itself.
  private func closeKeyPressed() {
    guard closesByKey else { return }
    closeTapped()
  }

  private func barKey(_ key: TerminalBarKey) {
    switch key {
    case .esc, .tab:
      if let bytes = key.bytes { sendInput(bytes) }
    case .ctrl, .cmd:
      let armed = modifiers.toggle(key)
      keyBar.show(modifiers)
      if armed { announcer.say(key == .ctrl ? UICopy.terminalCtrlOn : UICopy.terminalCmdOn) }
    case .copy: handleCopy()
    case .paste: handlePasteCommand()
    case .history: handleHistory()
    case .pad: break  // pad wysyła gestem (`onArrow`)
    }
  }

  // MARK: - Pasek, menu, „×"

  @objc nonisolated private func keyboardsChanged() {
    Task { @MainActor in self.updateKeyBar() }
  }

  /// Ślad powrotu z tła rusza od razu (powiadomienia sceny przychodzą na głównym wątku): układ może przyjść, zanim
  /// zadanie dostanie głównego aktora.
  @objc nonisolated private func sceneDeactivated(_ note: Notification) {
    let scene = (note.object as? UIScene).map(ObjectIdentifier.init)
    MainActor.assumeIsolated { self.startReturnTrace(scene: scene) }
    Task { @MainActor in
      self.closeArm.disarm()
      self.renderChrome()
    }
  }

  @objc nonisolated private func sceneActivated(_ note: Notification) {
    let scene = (note.object as? UIScene).map(ObjectIdentifier.init)
    MainActor.assumeIsolated { self.beginReturnTrace(scene: scene) }
    Task { @MainActor in
      // `rs` z `force` po fokusie, którego cisza skończyła się na nieaktywnej scenie (``ResizeSettler/settled``).
      if self.settler.forced, self.isSceneActive { self.reassertSize() }
      guard self.startOnActivation, self.isSceneActive else { return }
      self.startOnActivation = false
      self.reconnectAfterRefusedClose()
    }
  }

  /// Pasek tylko bez klawiatury sprzętowej. Podpięcie klawiatury rozbraja modyfikatory (pasek znika razem z nimi).
  func updateKeyBar() {
    let hardware = hardwareKeyboard()
    if keyBar.isHidden != hardware {
      keyBar.isHidden = hardware
      // Pasek w stosie nie zmienia ramki stosu, więc układ ekranu sam by nie ruszył, a pas pod siatką zależy od paska.
      view.setNeedsLayout()
    }
    if hardware, modifiers.isArmed {
      modifiers.disarm()
      keyBar.show(modifiers)
    }
  }

  /// Menu „⋯" okna Cmd+F/Cmd+G (`TerminalPopup`): jedyne wejście do Kopiuj/Wklej/Historii obok Cmd+C/V/Y, gdy
  /// paska nie ma (klawiatura sprzętowa). Na trasie te same pozycje składa pasek nawigacji (`TerminalChrome`).
  public func headerMenu() -> UIMenu {
    let history = UIAction(
      title: UICopy.terminalSelectOutput, image: UIImage(systemName: TerminalBarKey.history.symbol),
      attributes: canShowHistory ? [] : .disabled
    ) { [weak self] _ in self?.handleHistory() }
    return UIMenu(children: [
      UIAction(title: UICopy.terminalCopy, image: UIImage(systemName: TerminalBarKey.copy.symbol)) { [weak self] _ in
        self?.handleCopy()
      },
      UIAction(title: UICopy.terminalPaste, image: UIImage(systemName: TerminalBarKey.paste.symbol)) { [weak self] _ in
        self?.handlePasteCommand()
      },
      history,
    ])
  }

  private var canShowHistory: Bool { onHistory != nil && historyTerminalId != nil }

  private func updateHistoryAvailability() {
    renderChrome()
    guard isViewLoaded else { return }
    keyBar.setHistoryEnabled(canShowHistory)
  }

  /// The header's "×" (`TerminalChrome`, the current tab or the corner) and Cmd+X: the first press arms, the second
  /// within the `TerminalCloseArm` window closes. The arming tells the screen reader what the next press does, once,
  /// here: the callers say nothing, and the card under the bar says nothing either.
  func closeTapped() {
    guard !closing else { return }
    guard closeArm.press(now: now()) else {
      announcer.say(UICopy.terminalCloseConfirmSpoken(machine()))
      renderChrome()
      let window = TerminalCloseArm.window
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(window))
        self?.renderChrome()
      }
      return
    }
    renderChrome()
    Task { await performClose() }
  }

  /// Drugie „×": `DELETE` powłoki, potem ekran znika. Terminal bez id (nic jeszcze nie wiadomo)
  /// po prostu znika z ekranu.
  private func performClose() async {
    guard let id = session.terminalId else {
      shutdown()
      onClose?()
      return
    }
    closeUnknown = false
    closing = true
    renderChrome()
    renderStatus()
    let outcome = await closeTerminal(id)
    // Ekran zszedł w trakcie `DELETE` (zmiana trasy): spóźniony wynik nie nawiguje i nic nie ogłasza.
    guard !shutDown else { return }
    closing = false
    renderChrome()
    switch outcome {
    case .closed, .gone:
      shutdown()
      onClose?()
    case let .failed(message?):
      // Serwer albo bramka odmówili: powłoka żyje, a magazyn zatrzymał sesję PRZED `DELETE` — ekran łączy się
      // z nią z powrotem.
      showNotice(message)
      reconnectAfterRefusedClose()
    case .failed(nil):
      // Bez odpowiedzi `DELETE` mógł dojść, a `POST` przy łączeniu założyłby wtedy NOWĄ powłokę w tym slocie.
      closeUnknown = true
      renderStatus()
    }
  }

  /// Łączenie po odmowie `DELETE`: na aktywnej scenie od razu, w tle dopiero po powrocie na wierzch — magazyn
  /// usypia w tle tylko sesje, które już biegły, więc gniazdo otwarte w tle zostałoby w tle.
  private func reconnectAfterRefusedClose() {
    guard session.phase == .idle, !shutDown else { return }
    appearedAt = nil  // to nie pojawienie się ekranu — bez śladu „nowy ekran"
    if isSceneActive {
      session.start()
    } else {
      startOnActivation = true
    }
  }

  /// The state of the "×" (with the arming's deadline, the card's identity) and of History for the header.
  private func renderChrome() {
    let close: TerminalChrome.Close = closing ? .closing : (closeArm.isArmed(now: now()) ? .armed : .idle)
    chrome?.show(close: close, armedUntil: closeArm.until, history: canShowHistory, from: self)
  }

  // MARK: - Siatka przy zejściu okna

  /// The window goes down: the stack keeps the height of the last layout instead of a bottom on the keyboard guide.
  /// The guide stands in the APP WINDOW's layout (the screen's bottom or the keyboard's top edge), so in a sheet moved
  /// down it stands higher. Measured on the iPhone 17 Pro simulator, iOS 27.0: a drag from the grabber squeezes the
  /// grid every frame (56 → 24 rows at 450 pt), and a close by shortcut gives the focus back to the message field
  /// underneath, whose keyboard squeezes the grid before `viewWillDisappear` (56 → 33). Without scrollback
  /// (`scrollback: 0`) the rows are lost, the sizer sends `rs` of the smaller size, and a screen from the parking
  /// comes back with a hole at the bottom until the `rs` after showing. The screen's layout turns the hold on
  /// (`viewWillLayoutSubviews`, before the frames are computed); the end of the transition, `viewDidAppear` after a
  /// cancelled drag and the first layout of a new window (a screen from the parking) turn it off.
  private func updateGridHold() {
    let hold = holdsGridWhileClosing && !shutDown && stack.bounds.height > 0 && Self.isBeingClosed(self)
    guard hold != (heldHeight != nil) else { return }
    if hold {
      let held = stack.heightAnchor.constraint(equalToConstant: stack.bounds.height)
      stackBottom?.isActive = false
      held.isActive = true
      heldHeight = held
      // Stos bez prowadnicy nie dostaje układu od jej zmian, więc blokady nie zdejmie sam układ: robi to koniec
      // przejścia (następny obrót pętli, po resecie `isBeingDismissed`) albo `viewDidAppear` po anulowanym
      // przeciągnięciu. Inaczej klawiatura terminala po anulowaniu przykryłaby pasek i dół siatki.
      _ = transitionCoordinator?.animate(alongsideTransition: nil) { [weak self] _ in
        Task { @MainActor [weak self] in self?.updateGridHold() }
      }
    } else {
      heldHeight?.isActive = false
      heldHeight = nil
      stackBottom?.isActive = true
    }
  }

  /// Prezentacja z kontrolerem schodzi (także przeciąganiem): korzeń jego rodziców jest w trakcie `dismiss`.
  static func isBeingClosed(_ controller: UIViewController) -> Bool {
    var top = controller
    while let parent = top.parent { top = parent }
    return top.isBeingDismissed
  }

  // MARK: - Pas w kolorze krawędzi

  /// Słuchacz krawędzi powierzchni i nakładka idą razem z ``paintsEdges``.
  private func updateEdgeFill() {
    surface.onEdgesChanged = paintsEdges && !shutDown ? { [weak self] in self?.renderEdges() } : nil
    guard isViewLoaded else { return }
    edgeFill.isHidden = !paintsEdges
    if !paintsEdges { edgeFill.bands = [] }
    view.setNeedsLayout()
  }

  /// Pasy z bieżących krawędzi i układu. Odświeżenie: zmiana krawędzi (sygnał powierzchni), układ ekranu (także
  /// zmiana rozmiaru bez zmiany liczby komórek — SwiftTerm nie daje wtedy sygnału), zmiana siatki i pokazanie albo
  /// schowanie paska klawiszy. Pasek klawiszy i pas pod nim zostają tłem ekranu.
  /// - Parameter layoutFirst: najpierw ułożyć stos (ramki kontenera, paska i siatki z tego samego przebiegu); `false`
  ///   z wnętrza układu powierzchni, gdy ramki już stoją.
  private func renderEdges(layoutFirst: Bool = true) {
    guard paintsEdges, isViewLoaded, !edgeFill.isHidden else { return }
    if layoutFirst { stack.layoutIfNeeded() }
    let surfaceView = surface.view
    let grid = surface.gridSize
    let limit = keyBar.isHidden ? edgeFill.bounds.maxY : keyBar.convert(keyBar.bounds, to: edgeFill).minY
    guard let edges = surface.edgeColors else {
      edgeFill.bands = []
      return
    }
    edgeFill.bands = clippedWhileHeld(
      TerminalEdgeBands.layout(
        edges: edges, area: edgeFill.bounds, grid: surfaceView.convert(surface.gridFrame, to: edgeFill),
        cols: grid.cols, rows: grid.rows, surface: surfaceView.convert(surfaceView.bounds, to: edgeFill),
        bottomLimit: limit, scale: displayScale))
  }

  /// Skala ekranu dla krawędzi pasów; przed pierwszym przekazaniem cech (okno bez sceny w testach) — 1.
  private var displayScale: CGFloat {
    let scale = view.traitCollection.displayScale
    return scale > 0 ? scale : 1
  }

  // MARK: - Linia stanu

  private func statusActionTapped() {
    guard currentStatus.action != nil else { return }
    closeUnknown = false
    session.restart()
    renderStatus()
  }

  private var currentStatus: TerminalStatus {
    closeUnknown ? .closeUnknown : TerminalStatus.of(session.phase)
  }

  private func renderStatus() {
    let status = currentStatus
    guard isViewLoaded else { return }
    let text = notice?.text ?? status.sentence
    statusLabel.text = text
    statusButton.setTitle(status.action?.title, for: .normal)
    statusButton.isHidden = status.action == nil
    let hidden = text == nil && status.action == nil
    if statusBar.isHidden != hidden { statusBar.isHidden = hidden }
    // Czytnik słyszy stany, które czekają na człowieka (koniec, błąd, brak) — „Łączę…" nie.
    if !parked, status.action != nil || session.phase == .missing, let sentence = status.sentence,
      sentence != lastSpoken
    {
      announcer.say(sentence)
    }
    lastSpoken = status.sentence
  }

  /// Zdanie wyniku akcji (Wklej, „×", kopia bez treści albo bez dymka apki) na 3 s w linii stanu i dla czytnika.
  func showNotice(_ text: String) {
    noticeCount += 1
    let id = noticeCount
    notice = (id, text)
    renderStatus()
    announcer.say(text)
    let hold = noticeHold
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: hold)
      guard let self, self.notice?.id == id else { return }
      self.notice = nil
      self.renderStatus()
    }
  }

  var noticeText: String? { notice?.text }
}

// MARK: - Parkowanie

extension TerminalScreenViewController {
  /// Ekran nadaje się do parkingu i do wzięcia z niego: nie po `shutdown()`, a sesja łączy się albo żyje. Uśpiona,
  /// zatrzymana, zakończona albo z błędem — nie: powrót i tak budowałby wtedy połączenie od nowa.
  var isReusable: Bool {
    guard !shutDown else { return false }
    switch session.phase {
    case .connecting, .reconnecting, .live: return true
    case .idle, .suspended, .missing, .exited, .failed: return false
    }
  }

  /// Po `shutdown()`: ekran skończony na dobre (gniazdo zamknięte, renderer zwolniony).
  var isShutDown: Bool { shutDown }

  /// Ekran zszedł z taba albo z okna i czeka w parkingu (host już wyjął go z siebie). Sesja i powierzchnia żyją;
  /// odchodzi wszystko, co należało do starego właściciela: klawiatura, przyciski paska nawigacji (`chrome = nil`
  /// odpina je przez `didSet`), wywołania zwrotne i zapamiętany id — nowy właściciel dostaje go
  /// w ``activate(parkedFor:resumesInput:)``. Wejście stoi do aktywacji, a czytnik nie słyszy stanów ukrytego
  /// ekranu (np. `err` po przejęciu terminala przez drugie urządzenie). Pojawienie się sprzed parkingu nie liczy
  /// się już jako otwarcie (ślad „nowy ekran" mierzyłby postój).
  func park() {
    parked = true
    cancelReturnTrace()
    surface.view.resignFirstResponder()
    inputSuspended = true
    closeArm.disarm()
    chrome = nil
    onClose = nil
    onHistory = nil
    onEscape = nil
    escapeAboveScreen = nil
    onTerminalIdentified = nil
    onCopied = nil
    reportedId = nil
    appearedAt = nil
    openTiming = nil
  }

  /// Ekran z parkingu w nowym hoście, PO podpięciu wywołań i `chrome`: wejście wraca (tab; okno robi to w swoim
  /// `viewDidAppear`, więc `resumesInput == false`), nowy właściciel dostaje bieżący id terminala (zmiana id
  /// w parkingu dochodzi do nawigacji), a `client.log` linię „z parkingu" w podbudżecie śladów otwarcia. `exit`
  /// okna w drodze do nowego właściciela zamyka je teraz.
  func activate(parkedFor duration: Duration, resumesInput: Bool) {
    if closeWhenAdopted {
      closeWhenAdopted = false
      onClose?()
      return
    }
    guard !shutDown else { return }
    parked = false
    if resumesInput { inputSuspended = false }
    reportedId = nil
    reportIdentity()
    updateHistoryAvailability()
    let now = clock()
    guard let trace, admitOpenTrace(now) else { return }
    trace(TerminalOpenTrace.parked(after: duration, live: session.phase == .live))
  }
}

// MARK: - Ślad powrotu z tła

extension TerminalScreenViewController {
  /// Dezaktywacja sceny tego ekranu: od teraz zmiany siatki i pominięte układy (sekcja „tło”). Zbieranie, które już
  /// trwa (także okno próbek), zostaje. Ekran zaparkowany, zamknięty, w szwie demo albo bez okna nie zbiera.
  fileprivate func startReturnTrace(scene: ObjectIdentifier?) {
    guard isOwnScene(scene), returnTrace == nil, tracesReturn else { return }
    returnTrace = TerminalReturnTrace()
  }

  /// Scena tego ekranu zeszła w tło: okno w toku przepada bez linii i zbieranie rusza od nowa; zbieranie od
  /// dezaktywacji trwa dalej. Dopiero tło sprawia, że aktywacja da linie. Synchronicznie, jak dezaktywacja.
  @objc nonisolated fileprivate func sceneEnteredBackground(_ note: Notification) {
    let scene = (note.object as? UIScene).map(ObjectIdentifier.init)
    MainActor.assumeIsolated {
      guard self.isOwnScene(scene) else { return }
      if self.returnTrace?.isRunning == true || !self.tracesReturn { self.cancelReturnTrace() }
      guard self.tracesReturn else { return }
      if self.returnTrace == nil { self.returnTrace = TerminalReturnTrace() }
      self.returnTrace?.enteredBackground()
    }
  }

  /// Ekran może zbierać ślad powrotu.
  private var tracesReturn: Bool { !shutDown && !parked && !demoScreen && view.window != nil }

  /// Powiadomienie sceny dotyczy sceny tego ekranu (brak sceny w powiadomieniu albo ekranu bez sceny: tak).
  private func isOwnScene(_ scene: ObjectIdentifier?) -> Bool {
    guard let scene, let own = viewIfLoaded?.window?.windowScene else { return true }
    return ObjectIdentifier(own) == scene
  }

  /// Aktywacja sceny po tle (samo `willDeactivate` → `didActivate` kasuje zbieranie bez linii): t0, pierwsza próbka
  /// i próbki co ``returnSampleInterval`` do końca ``returnTraceWindow``, potem linie.
  fileprivate func beginReturnTrace(scene: ObjectIdentifier?) {
    guard isOwnScene(scene), let pending = returnTrace, !pending.isRunning else { return }
    guard pending.sawBackground, tracesReturn, isSceneActive else {
      cancelReturnTrace()
      return
    }
    returnTrace?.begin(at: clock())
    sampleReturn()
    let interval = returnSampleInterval
    let ticks = max(1, Int((returnTraceWindow / interval).rounded(.down)))
    let start = ContinuousClock.now
    returnSampler = Task { @MainActor [weak self] in
      for tick in 1...ticks {
        do { try await Task.sleep(until: start + interval * tick, clock: .continuous) } catch { return }
        guard let self, self.returnTrace != nil else { return }
        self.sampleReturn()
        if tick == ticks { self.finishReturnTrace() }
      }
    }
  }

  /// Zmiana siatki z układu: w oknie — próbka; przed aktywacją — element sekcji „tło” ze stanem sceny.
  fileprivate func noteReturnGrid(cols: Int, rows: Int) {
    guard let pending = returnTrace else { return }
    if pending.isRunning {
      sampleReturn()
    } else {
      returnTrace?.grid(cols: cols, rows: rows, state: returnSceneState)
    }
  }

  /// Układ, który nie doszedł do renderera, przed aktywacją: element sekcji „tło” z wysokością widoku powierzchni.
  fileprivate func noteReturnSkip(height: CGFloat) {
    guard let pending = returnTrace, !pending.isRunning else { return }
    returnTrace?.skippedLayout(height: TerminalReturnLayout.points(height), state: returnSceneState)
  }

  /// Stan sceny w chwili układu; ekran bez sceny — z ``isSceneActive``.
  private var returnSceneState: TerminalReturnSceneState {
    guard let state = sceneActivationState else { return isSceneActive ? .active : .inactive }
    switch state {
    case .foregroundActive: return .active
    case .foregroundInactive: return .inactive
    case .background, .unattached: return .background
    @unknown default: return .background
    }
  }

  /// Próbka układu — sam odczyt.
  private func sampleReturn() {
    guard returnTrace?.isRunning == true else { return }
    let surfaceView = surface.view
    let scroll = surfaceView as? UIScrollView
    let grid = surface.gridSize
    let keyboard = view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY
    let offset: CGFloat = scroll?.contentOffset.y ?? 0
    let inset: CGFloat = scroll?.adjustedContentInset.bottom ?? 0
    let corner = container.convert(container.bounds.origin, to: nil)
    let layout = TerminalReturnLayout(
      height: TerminalReturnLayout.points(container.bounds.height), x: TerminalReturnLayout.points(corner.x),
      y: TerminalReturnLayout.points(corner.y), cols: grid.cols, rows: grid.rows,
      offset: TerminalReturnLayout.points(offset), inset: TerminalReturnLayout.points(inset),
      keyboard: TerminalReturnLayout.points(keyboard), focused: surfaceView.isFirstResponder)
    returnTrace?.sample(layout, at: clock())
  }

  /// Koniec okna: linie śladu po kolei, jeden powrót z podbudżetu (``TerminalReturnTraceBudget``).
  private func finishReturnTrace() {
    returnSampler = nil
    guard let finished = returnTrace else { return }
    returnTrace = nil
    guard let trace, admitReturnTrace(clock()) else { return }
    for line in finished.lines() { trace(line) }
  }

  /// Zbieranie przepada bez linii (ponowne tło, park, zamknięcie).
  private func cancelReturnTrace() {
    returnSampler?.cancel()
    returnSampler = nil
    returnTrace = nil
  }
}

/// Kontener powierzchni: następny respondent po widoku terminala. Trzyma skróty klawiatury sprzętowej
/// (`TerminalKeyMap`) i obsługę Kopiuj/Wklej, gdy powierzchnia jej nie bierze (Cmd+C bez zaznaczenia). Do niego
/// dochodzi też PUSZCZENIE klawisza (`pressesEnded` SwiftTerm nie jest `open`, ale woła `super`) — oddaje je
/// powierzchni, która zatrzymuje serię strzałki (``TerminalKeyRepeat``).
/// Skróty NIE mogą mieszkać w podklasie widoku SwiftTerm — jej `canPerformAction` nie jest `open` i odmawia
/// każdej akcji spoza edycji.
final class TerminalSurfaceContainer: UIView {
  weak var screen: TerminalScreenViewController?
  /// Widok SwiftTerm w kontenerze — cel kliknięć w bocznych odstępach (``hitTest(_:with:)``).
  weak var surfaceView: UIView?

  /// The container places the surface in every layout pass (`TerminalScreenViewController+Keyboard`).
  override func layoutSubviews() {
    super.layoutSubviews()
    screen?.placeSurface()
  }

  /// Boczne odstępy (`TerminalScreenViewController.sideInset`) należą do terminala: kliknięcie w nie trafia
  /// w powierzchnię — oddaje jej fokus, a zaznaczanie wskaźnikiem zaczyna od skrajnej kolumny (punkt poza ramką
  /// przyciska do siatki `pointerDown`). Bez tego trafiał kontener, który gestów nie ma.
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    guard hit === self, let surfaceView, surfaceView.superview === self, !surfaceView.isHidden else { return hit }
    return surfaceView
  }

  private lazy var commands: [UIKeyCommand] = TerminalKeyMap.commands.map {
    let closes = TerminalKeyMap.resolve($0) == .action(.close)
    return $0.keyCommand(action: closes ? #selector(closeKey(_:)) : #selector(terminalKey(_:)))
  }

  override var keyCommands: [UIKeyCommand]? { commands }

  @objc private func terminalKey(_ command: UIKeyCommand) {
    screen?.handleKey(TerminalHardwareKey(command))
  }

  /// Cmd+X has its own action so it can be turned off: without the "×" on screen (the Cmd+F/Cmd+G window, a sheet
  /// over the terminal) the shortcut leaves the iPadOS menu bar and does nothing.
  @objc private func closeKey(_ command: UIKeyCommand) {
    screen?.handleKey(TerminalHardwareKey(command))
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(closeKey(_:)) { return screen?.closesByKey == true }
    if action == #selector(copy(_:)) || action == #selector(paste(_:)) { return screen != nil }
    return super.canPerformAction(action, withSender: sender)
  }

  override func copy(_ sender: Any?) { screen?.handleCopy() }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    screen?.hardwareKeysEnded(presses, cancelled: false)
    super.pressesEnded(presses, with: event)
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    screen?.hardwareKeysEnded(presses, cancelled: true)
    super.pressesCancelled(presses, with: event)
  }

  override func paste(_ sender: Any?) { screen?.handlePasteCommand() }
}

private extension UIFont {
  func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
    fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: 0) } ?? self
  }
}
#endif
