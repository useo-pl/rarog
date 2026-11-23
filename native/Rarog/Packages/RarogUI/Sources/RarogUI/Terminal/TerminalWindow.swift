#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Okno terminala nad ekranem: Cmd+F
// otwiera gołą powłokę projektu (rola `popup`), Cmd+G lazygita (rola `lazygit`). Naraz stoi jedno okno; ten sam
// skrót je zamyka, drugi przełącza (`RarogNavigation.togglePopup`). Arkusz stawia `SheetHost`. Zamyka je „×” z lewej
// strony paska (jak w każdym oknie apki), Esc
// w oknie powłoki, tap obok (iPad), gest w dół od uchwytu (iPhone), `exit` w powłoce (`q` w lazygicie), czytnik
// gestem „wstecz” (`accessibilityPerformEscape`) i zmiana ekranu pod spodem. Zamknięcie tylko ODPINA gniazdo — panel
// w herdr żyje dalej.
// Okno stoi na wspólnej ramie okien apki (`windowFrame`): szerokość, obrys, bez własnego tła, szkła i promienia.
// Pas między siatką a krawędzią okna ma kolor skrajnych komórek terminala: maluje go ekran, a okno podaje mu
// swój odstęp (`windowInsets`), więc nvim i lazygit nie mają widocznej ramy. Pasek ma „×”, tytuł „RODZAJ projekt”
// i „⋯”, a siatka zaczyna się POD nim: pierwszy wiersz, w którym `clear` stawia prompt,
// jest zawsze widoczny. Dół siatki dotyka łuku rogu (`WindowLayout.terminalBottomInset`). Na iPhonie
// arkusz ma systemowy uchwyt na środku u góry (o nim rozstrzyga urządzenie, nie klasa szerokości — jak dymki).
// Pasek to pasek nawigacji SYSTEMU w kontenerze UIKit (`UINavigationController`), nie `NavigationStack`: fokus
// terminala i Esc da się wtedy sprawdzić testami UIKit. Esc w oknie powłoki zamyka okno; w lazygicie idzie do
// programu („wróć"), dopóki program żyje (`EscapePolicy`). Gdy fokus nie stoi w terminalu, kontroler okna rozstrzyga
// Esc tak samo, zamiast puścić go niżej (Esc ekranu sesji pod oknem przerywa turę).
// Historia (Cmd+Y, „Historia" w menu „⋯", klawisz paska) to STRONA tego okna, nie drugi arkusz: wchodzi na stos
// kontenera nawigacji, terminal zostaje korzeniem z tym samym połączeniem. Przy stronie na wierzchu terminal
// niczego nie wysyła programowi, a Esc wraca o stopień — nigdy nie zamyka okna i nie idzie bajtem do programu.
// Zamknięte okno oddaje ekran do parkingu pod katalogiem i rolą: ponowne Cmd+F/Cmd+G w ciągu 2 min buduje
// NOWE okno wokół tego samego ekranu i gniazda. Okno działa na ekranie tylko, póki ekran jest jego dzieckiem
// (``TerminalPopupController/holdsScreen``): spóźnione zdarzenia starego okna nie ruszają ekranu w nowym.
// Zejście okna (przeciągnięcie w dół, klawiatura pola wiadomości, które wraca pod spodem) nie zmienia siatki ekranu
// (``TerminalScreenViewController/holdsGridWhileClosing``): ekran z parkingu wraca w rozmiarze sprzed
// zejścia, bez `rs` i przerysowania po pokazaniu.
// Nowy ekran Cmd+F, którego panel lista już zna, łączy się wprost do jego id, bez `POST`
// (``TerminalPopupController/target(for:listed:)``); lazygit zawsze przez `POST`.
// Dymek apki (np. „Skopiowano do schowka.” z tego okna) stoi u dołu arkusza (``TerminalWindowToast``,
// `ToastPlacement.terminalWindow`), bo arkusz przykrywa nakładkę kolumny.
// Właściciel: terminal.

/// Treść arkusza: okno z terminalem.
struct TerminalPopupSheet: View {
  let store: RarogStore
  let request: TerminalPopupRequest
  /// Szerokość okna apki (`appWindowWidth`), odczytana poza arkuszem.
  let windowWidth: CGFloat?
  let close: () -> Void
  @Environment(\.terminalSurfaceFactory) private var factory
  @Environment(\.terminalScreenParking) private var parking

  var body: some View {
    Group {
      if let factory {
        TerminalPopupRepresentable(store: store, request: request, factory: factory, parking: parking, close: close)
          // Pasek, obszary bezpieczne i klawiaturę układa UIKit (kontener nawigacji, `keyboardLayoutGuide`).
          .ignoresSafeArea()
      } else {
        Text(UICopy.terminalUnavailable)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    // Dymek apki u dołu okna („Skopiowano do schowka." z tego okna i każdy inny), bo arkusz przykrywa nakładkę
    // kolumny (`ToastPlacement.terminalWindow`).
    .modifier(TerminalWindowToast())
    .windowFrame(width: windowWidth)
    // iPhone: uchwyt „ściągania” okna w dół zamiast przycisku zamknięcia; iPad bez uchwytu (zamyka tap obok).
    .presentationDragIndicator(TerminalPopupController.showsGrabber ? .visible : .hidden)
  }
}

/// Dymek apki u dołu okna terminala, póki okno stoi; bez nawigacji w środowisku (testy) — bez dymka.
struct TerminalWindowToast: ViewModifier {
  @Environment(RarogNavigation.self) private var navigation: RarogNavigation?

  func body(content: Content) -> some View {
    if let navigation {
      // Okno stoi, póki nawigacja ma jego żądanie; przy zejściu dymek wraca do kolumny. Bez stanu apki: ciało arkusza
      // nie przelicza się przy każdej ramce strumienia.
      content.modifier(ToastOverlay(
        navigation: navigation, placement: navigation.popup != nil ? .terminalWindow : .overlay,
        slot: .terminalWindow))
    } else {
      content
    }
  }
}

struct TerminalPopupRepresentable: UIViewControllerRepresentable {
  let store: RarogStore
  let request: TerminalPopupRequest
  let factory: TerminalSurfaceFactory
  let parking: TerminalScreenParking?
  let close: () -> Void
  /// Dymek „Skopiowano do schowka." z tego okna.
  @Environment(ToastCenter.self) private var toasts: ToastCenter?

  func makeUIViewController(context: Context) -> UIViewController {
    let popup = TerminalPopupController.make(
      request: request, parking: parking,
      listed: { [store, request] in store.state.projectPopupTerminal(request.cwd, role: request.role) }
    ) { [store, factory] target in
      TerminalScreenViewController(store: store, target: target, factory: factory)
    }
    guard let popup else {
      return UIHostingController(
        rootView: Text(UICopy.terminalUnavailable).foregroundStyle(Color(uiColor: Palette.muted)).textScaleHost())
    }
    wire(popup)
    return TerminalPopupController.window(popup)
  }

  func updateUIViewController(_ controller: UIViewController, context: Context) {
    if let popup = TerminalPopupController.root(of: controller) { wire(popup) }
  }

  static func dismantleUIViewController(_ controller: UIViewController, coordinator: ()) {
    TerminalPopupController.root(of: controller)?.dismantle()
  }

  private func wire(_ popup: TerminalPopupController) {
    popup.onDismiss = close
    popup.toasts = toasts
    popup.makeHistoryPage = { [store] terminalId, back in
      UIHostingController(
        rootView: TerminalHistoryPage(store: store, terminalId: terminalId, back: back).textScaleHost())
    }
  }
}

/// Korzeń okna terminala: pasek nawigacji systemu („×” z lewej, tytuł „RODZAJ projekt”, „⋯" z prawej) nad ekranem
/// terminala, który sięga pod pasek (bez `TerminalChrome`: jego „×" zabija powłokę, „×” okna tylko odpina).
@MainActor
final class TerminalPopupController: UIViewController {
  let screen: TerminalScreenViewController
  let request: TerminalPopupRequest
  /// „×” paska, `exit` w oknie, Esc w oknie powłoki, gest „wstecz” czytnika: arkusz schodzi (nawigacja zamyka go po
  /// żetonie).
  var onDismiss: (() -> Void)?
  /// Strona historii terminala o podanym id; drugi argument zdejmuje ją ze stosu (Esc, Cmd+W, Cmd+Y strony).
  /// Potrzebuje magazynu, więc daje ją ten, kto buduje okno; bez niej „Historia" jest wygaszona.
  var makeHistoryPage: ((String, @escaping () -> Void) -> UIViewController)? {
    didSet {
      guard !released else { return }
      screen.onHistory = makeHistoryPage == nil ? nil : { [weak self] id in self?.toggleHistory(id) }
    }
  }
  /// Centrum dymków: kopia w oknie mówi wynik dymkiem nad arkuszem (``TerminalWindowToast``), nie linią stanu.
  var toasts: ToastCenter? {
    didSet {
      guard !released else { return }
      screen.onCopied = ToastCenter.confirmation(toasts)
    }
  }

  /// Tytuł okna jak w innych oknach apki (`WindowTitle`): rodzaj etykietą maszynową, potem nazwa projektu.
  let kindLabel = UILabel()
  let titleLabel = UILabel()
  let titleView = UIStackView()
  /// „×” okna tylko odpina (powłoka żyje dalej), więc bez potwierdzenia.
  private(set) lazy var closeItem = UIBarButtonItem(
    systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.onDismiss?() })
  private(set) lazy var menuItem = UIBarButtonItem(
    image: UIImage(systemName: "ellipsis"),
    // Kopiuj, Wklej i Historia z ekranu — menu budowane przy otwarciu, bo Historia zależy od id terminala. Nagłówek
    // menu to nazwa projektu.
    menu: UIMenu(title: ProjectPath.name(request.cwd), children: [
      UIDeferredMenuElement.uncached { [weak self] completion in
        completion(self.flatMap { $0.holdsScreen ? $0.screen.headerMenu().children : nil } ?? [])
      }
    ]))
  /// Niewidoczny widok w kształcie arkusza: z niego system podaje promień rogu (`effectiveRadius(corner:)`).
  private let cornerProbe = UIView()
  private var screenBottom: NSLayoutConstraint?
  /// Parking, do którego okno oddaje ekran przy zamknięciu; `nil` = `shutdown`.
  private weak var parking: TerminalScreenParking?
  /// Czas postoju ekranu wziętego z parkingu; `nil` = ekran nowy.
  private var parkedFor: Duration?
  /// Okno oddało ekran (dismantle): od tej chwili niczego na nim nie robi.
  private var released = false

  init(
    screen: TerminalScreenViewController, request: TerminalPopupRequest, parking: TerminalScreenParking? = nil,
    parkedFor: Duration? = nil
  ) {
    self.screen = screen
    self.request = request
    self.parking = parking
    self.parkedFor = parkedFor
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  /// Okno: kontener nawigacji systemu z `popup` jako korzeniem. Odcień paska achromatyczny.
  static func window(_ popup: TerminalPopupController) -> UINavigationController {
    let navigation = UINavigationController(rootViewController: popup)
    navigation.view.backgroundColor = Palette.background
    navigation.view.tintColor = Palette.text
    return navigation
  }

  /// Korzeń okna zbudowanego przez ``window(_:)``.
  static func root(of controller: UIViewController) -> TerminalPopupController? {
    (controller as? UINavigationController)?.viewControllers.first as? TerminalPopupController
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    // Bez własnego tła okna i bez szkła: pas wokół siatki ma kolor terminala.
    view.backgroundColor = Palette.background
    view.accessibilityIdentifier = "terminal.popup"
    buildBar()
    // Okno zamyka się samo po `exit` (`q` w lazygicie): koniec programu nie zostawia „Uruchom ponownie".
    screen.closesOnExit = true
    // Pas wokół siatki w kolorze jej krawędzi — tylko w oknie.
    screen.paintsEdges = true
    // Zejście okna (przeciągnięcie w dół, klawiatura pola pod spodem) nie zmienia siatki.
    screen.holdsGridWhileClosing = true
    screen.onClose = { [weak self] in self?.onDismiss?() }
    screen.onEscape = { [weak self] in self?.closeOnEscape() ?? false }
    screen.escapeAboveScreen = { [weak self] in self?.escapeOnHistory() ?? false }
    addChild(screen)
    screen.loadViewIfNeeded()
    let screenView = screen.view!
    screenView.translatesAutoresizingMaskIntoConstraints = false
    cornerProbe.isUserInteractionEnabled = false
    cornerProbe.isAccessibilityElement = false
    cornerProbe.cornerConfiguration = .corners(radius: .containerConcentric())
    cornerProbe.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(cornerProbe)
    view.addSubview(screenView)
    let inset = WindowLayout.contentInset
    let bottom = screenView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
    screenBottom = bottom
    NSLayoutConstraint.activate([
      cornerProbe.topAnchor.constraint(equalTo: view.topAnchor),
      cornerProbe.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      cornerProbe.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      cornerProbe.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      // Terminal pod paskiem; siatka 16 pt od boków arkusza (8 pt tu i 8 pt w ekranie).
      screenView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      screenView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: inset),
      screenView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -inset),
      bottom,
    ])
    screen.didMove(toParent: self)
    activateParkedScreen()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    placeAboveCorners()
  }

  /// Dolny odstęp terminala od krawędzi arkusza: narożnik treści dotyka łuku rogu, ale go nie przekracza
  /// (``WindowLayout/terminalBottomInset(radius:)``; iPad 5 pt). Promień podaje system; dolny obszar
  /// bezpieczny (wskaźnik domu na telefonie) liczy się na poczet odstępu, bo ekran terminala sam go omija. Ten sam
  /// odstęp (i 8 pt z boków) dostaje ekran jako zasięg pasa w kolorze krawędzi.
  private func placeAboveCorners() {
    let needed = WindowLayout.terminalBottomInset(radius: cornerProbe.effectiveRadius(corner: .bottomLeft))
    let constant = -max(0, needed - view.safeAreaInsets.bottom)
    if screenBottom?.constant != constant { screenBottom?.constant = constant }
    // Spóźniony układ starego okna nie przestawia ekranu, który stoi już w nowym (parking).
    guard holdsScreen else { return }
    let inset = WindowLayout.contentInset
    screen.windowInsets = UIEdgeInsets(top: 0, left: inset, bottom: -constant, right: inset)
  }

  override func viewIsAppearing(_ animated: Bool) {
    super.viewIsAppearing(animated)
    // Fokus od razu w oknie: pole wiadomości sesji pod spodem nie zostaje pierwszym respondentem (jego Esc
    // przerwałby turę). Klawiaturę sprzętową terminal bierze sam w `viewDidAppear` ekranu.
    takeKeyboard()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard holdsScreen else { return }
    // Terminal znów na wierzchu (także po powrocie z historii): wejście idzie do programu.
    screen.inputSuspended = false
    // Ponowienie: przed końcem pokazywania okno bywa jeszcze poza hierarchią, a wtedy prośba przepada.
    takeKeyboard()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    guard holdsScreen else { return }
    // Od chwili, gdy terminal schodzi z wierzchu (strona historii, zamknięcie okna), niczego nie wysyła
    // programowi — także liter wpisanych w trakcie animacji.
    screen.inputSuspended = true
  }

  // MARK: - Strona historii

  /// Strona historii stoi nad terminalem (albo właśnie wchodzi).
  var historyShown: Bool {
    guard let navigationController else { return false }
    return navigationController.topViewController !== self
  }

  /// Cmd+Y, „Historia" w menu i klawisz paska: wejście na stronę; przy stronie na wierzchu — powrót.
  func toggleHistory(_ terminalId: String) {
    guard holdsScreen else { return }
    if historyShown {
      leaveHistory()
    } else if let page = makeHistoryPage?(terminalId, { [weak self] in self?.leaveHistory() }) {
      navigationController?.pushViewController(page, animated: true)
    }
  }

  /// Powrót ze strony historii (Esc, Cmd+W i Cmd+Y strony; systemowy „‹" i gest robią to same). W trakcie
  /// przejścia nic nie robi: drugi szybki klawisz nie zdejmuje niczego więcej.
  func leaveHistory() {
    guard let navigationController, historyShown, navigationController.transitionCoordinator == nil else { return }
    navigationController.popToRootViewController(animated: true)
  }

  /// Esc, który doszedł do terminala przy stronie historii na wierzchu albo w trakcie powrotu z niej: wraca
  /// o stopień albo jest połykany. Nigdy nie zamyka okna i nigdy nie idzie bajtem do programu.
  private func escapeOnHistory() -> Bool {
    guard let navigationController else { return false }
    if historyShown {
      leaveHistory()
      return true
    }
    return navigationController.transitionCoordinator != nil
  }

  private func takeKeyboard() {
    guard holdsScreen, !screen.surface.view.isFirstResponder, !isFirstResponder else { return }
    becomeFirstResponder()
  }

  override var canBecomeFirstResponder: Bool { true }

  private lazy var escape: UIKeyCommand = {
    let command = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapePressed))
    command.wantsPriorityOverSystemBehavior = true
    // Przytrzymany klawisz nie jest drugą decyzją: nie zamyka kolejnej warstwy.
    command.repeatBehavior = .nonRepeatable
    return command
  }()

  override var keyCommands: [UIKeyCommand]? { [escape] }

  /// Esc, gdy fokus nie stoi w terminalu (kontener powierzchni bierze go sam): ta sama decyzja co z terminala
  /// (`TerminalScreenViewController.takeEscape`), a do programu — bajtem, nigdy do ekranu pod spodem.
  @objc func escapePressed() {
    guard holdsScreen else { return }
    if screen.takeEscape() { return }
    screen.sendInput("\u{1B}")
  }

  /// Esc w oknie powłoki zamyka okno; w lazygicie zostaje programowi, dopóki program żyje (``EscapePolicy``).
  private func closeOnEscape() -> Bool {
    guard holdsScreen else { return false }
    let presentation = EscapePresentation.terminalPopup(request.role, programAlive: screen.session.phase == .live)
    guard EscapePolicy.route(for: presentation) == .dismiss else { return false }
    EscapeGrace.closedByEscape()
    onDismiss?()
    return true
  }

  /// Gest „wstecz” czytnika (VoiceOver, dwa palce w kształt Z) na terminalu zamyka okno, jak „×” paska. Przy stronie
  /// historii na wierzchu gest zdejmuje stronę (kontener nawigacji, poza tym kontrolerem).
  override func accessibilityPerformEscape() -> Bool {
    guard holdsScreen, !historyShown else { return false }
    onDismiss?()
    return true
  }

  // MARK: - Parking

  /// Okno nad ekranem z parkingu pod katalogiem i rolą żądania albo nad nowym ekranem (`build` z celu okna);
  /// `nil` = nowego ekranu nie ma (bez zalogowania, katalog odrzucony).
  /// `listed` = wpis listy terminali dla katalogu i roli okna; pytany tylko przy budowie NOWEGO ekranu.
  static func make(
    request: TerminalPopupRequest, parking: TerminalScreenParking?, listed: () -> TerminalListEntry? = { nil },
    build: (TerminalTarget) -> TerminalScreenViewController?
  ) -> TerminalPopupController? {
    let key = parkingKey(request)
    if let parking, let parked = parking.take(key) {
      return TerminalPopupController(screen: parked.screen, request: request, parking: parking, parkedFor: parked.parked)
    }
    guard let target = target(for: request, listed: listed()), let screen = build(target) else { return nil }
    parking?.claim(key, for: screen)
    return TerminalPopupController(screen: screen, request: request, parking: parking)
  }

  /// Cel NOWEGO ekranu okna. Cmd+F, gdy lista zna panel `popup` tego katalogu: jego wpis — id znane, więc pierwsze
  /// gniazdo idzie bez `POST`, a po odmowie serwera `POST` odtwarza wpis jak dotąd. Lazygit (Cmd+G) i okno
  /// spoza listy: cel z katalogu i roli, zawsze przez `POST` (tylko on sprawdza zastany panel lazygita).
  static func target(for request: TerminalPopupRequest, listed entry: TerminalListEntry?) -> TerminalTarget? {
    if request.role == .popup, let entry, entry.role == .popup,
      ProjectPath.normalized(entry.cwd) == ProjectPath.normalized(request.cwd)
    {
      return .existing(entry)
    }
    return .popup(cwd: request.cwd, role: request.role)
  }

  static func parkingKey(_ request: TerminalPopupRequest) -> TerminalParkingLedger.Key {
    .popup(cwd: ProjectPath.normalized(request.cwd), role: request.role)
  }

  /// Ekran jest dzieckiem tego okna — tylko wtedy okno rusza wejście, fokus, historię i Esc ekranu.
  var holdsScreen: Bool { !released && screen.parent === self }

  /// Uchwyt arkusza na środku u góry: telefon. Rozstrzyga urządzenie, nie klasa szerokości (jak pasek dymków):
  /// w zwężonym oknie iPada okno zostaje bez uchwytu, a gałąź nie zmienia się przy otwartym oknie.
  static var showsGrabber: Bool { UIDevice.current.userInterfaceIdiom == .phone }

  /// Ekran z parkingu, już osadzony i podpięty (`viewDidLoad`): wraca do życia w tym oknie. Wejście zdejmuje
  /// `viewDidAppear` okna.
  private func activateParkedScreen() {
    guard let parked = parkedFor, holdsScreen else { return }
    parkedFor = nil
    screen.activate(parkedFor: parked, resumesInput: false)
  }

  /// Arkusz okna zszedł: ekran wychodzi z okna i idzie do parkingu (bez parkingu — `shutdown`). Ekran, który już
  /// stoi w innym rodzicu, nie jest tego okna.
  func dismantle() {
    guard !released else { return }
    released = true
    if screen.parent === self {
      screen.willMove(toParent: nil)
      screen.view.removeFromSuperview()
      screen.removeFromParent()
    } else if screen.parent != nil {
      return
    }
    guard let parking else { return screen.shutdown() }
    parking.park(screen, under: Self.parkingKey(request))
  }

  private func buildBar() {
    // Pasek jak w innych oknach apki (`WindowSheet`): „×” z lewej, tytuł „RODZAJ projekt”, akcje z prawej.
    let kind = UICopy.terminalPopupKind(request.role)
    let project = ProjectPath.name(request.cwd)
    kindLabel.attributedText = Eyebrow.text(kind)
    kindLabel.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    kindLabel.setContentHuggingPriority(.required, for: .horizontal)
    kindLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    titleLabel.text = project
    titleLabel.font = TextStyleScaling.font(.headline, category: TextScale.shared.effective)
    titleLabel.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    titleLabel.textColor = Palette.text
    titleLabel.lineBreakMode = .byTruncatingMiddle
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    titleLabel.isHidden = project.isEmpty
    titleView.addArrangedSubview(kindLabel)
    titleView.addArrangedSubview(titleLabel)
    titleView.axis = .horizontal
    titleView.alignment = .firstBaseline
    titleView.spacing = 8
    titleView.isAccessibilityElement = true
    titleView.accessibilityLabel = project.isEmpty ? kind : "\(kind): \(project)"
    titleView.accessibilityTraits = .header
    titleView.accessibilityIdentifier = "terminal.popup.title"
    navigationItem.titleView = titleView
    navigationItem.title = kind
    closeItem.accessibilityLabel = UICopy.terminalPopupClose(request.role)
    closeItem.accessibilityIdentifier = "terminal.popup.close"
    menuItem.accessibilityLabel = UICopy.terminalMoreSpoken
    menuItem.accessibilityIdentifier = "terminal.popup.menu"
    navigationItem.leftBarButtonItem = closeItem
    navigationItem.rightBarButtonItem = menuItem
    // On the flat path (a Mac) a step of the app's text size sends no trait change: the title follows the model.
    Fonts.follow(self, scale: .shared) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.kindLabel.attributedText = Eyebrow.text(kind)
      self.titleLabel.font = TextStyleScaling.font(.headline, category: TextScale.shared.effective)
      self.titleView.setNeedsLayout()
    }
  }
}
#endif
