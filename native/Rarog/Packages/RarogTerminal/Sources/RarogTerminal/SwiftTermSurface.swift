#if os(iOS)
import CoreText
import GameController
import RarogContract
import RarogUI
@preconcurrency import SwiftTerm
import UIKit

/// Powierzchnia terminala na SwiftTerm 1.19.0. Różnice wobec
/// `TerminalView`:
/// - `scrollback: 0` i wyłączone przewijanie `UIScrollView`: historia żyje w panelu herdr, palec i dwa palce na
///   gładziku proszą o nią ramką `sc` (``onScroll``) z komórką pod palcem, z rozpędem; przy zaznaczeniu palec
///   ciągnie uchwyty SwiftTerm, a przewinięcie dwoma palcami czyści zaznaczenie;
/// - zaznaczanie dwiema drogami: DOTYK (palec, rysik) — stuknięcia ×1/×2/×3 i przytrzymanie SwiftTerm z jego menu;
///   WSKAŹNIK (gładzik, mysz; od iOS 17 kliknięcia przychodzą jako `.indirectPointer`) — własny rozpoznawacz jak na
///   Macu: klik czyści i kotwiczy, przeciągnięcie zaznacza od punktu wciśnięcia, ×2 słowo, ×3 wiersz, bez menu
///   (Cmd+C kopiuje, zaznaczenie zostaje). Rozpoznawacze SwiftTerm nie widzą wskaźnika (`allowedTouchTypes`), więc
///   klik gładzikiem nie zaznacza już słowa ani nie stawia menu „losowo";
/// - mysz wyłączona (`allowMouseReporting = false`, bez panu myszy SwiftTerm) — herdr i tak trybów myszy nie
///   przepuszcza, przewijanie jedzie zawsze `sc`;
/// - `optionAsMetaKey = false`: Option + litera to znak narodowy (ą, ę, ś); Meta daje Cmd + litera (kontener
///   ekranu) albo pigułka „Cmd" paska;
/// - Home/End/PageUp/PageDown bez modyfikatorów (fn+strzałki) idą do programu (`ESC O H`/`ESC O F` i `ESC[5~`/`ESC[6~`, mapa
///   `TerminalKeyMap`), nie przewijają lokalnego bufora; Cmd SwiftTerm pomija sam i oddaje apce;
/// - strzałki klawiatury sprzętowej wysyła i powtarza powierzchnia, nie SwiftTerm (`TerminalKeyRepeat`: 300 ms,
///   potem ~30/s zamiast 0,4 s i 10/s); seria staje na puszczeniu, które dochodzi przez kontener ekranu;
/// - KAŻDA wklejka (menu edycji, Cmd+V, `UIPasteControl`, przeciągnięcie tekstu) idzie surowym tekstem do
///   ``onPaste`` — własny `paste(_:)` SwiftTerm, który owija tekst w `ESC[200~…ESC[201~` według
///   `bracketedPasteMode`, nie biegnie NIGDY, więc żaden bajt wklejki nie trafia do ramek `in`;
/// - pasek `TerminalAccessory` SwiftTerm zdjęty (`inputAccessoryView = nil`) — pasek klawiszy stawia ekran;
/// - kursor stały: mrugający to animacja bez końca, przy której XCUITest nie widzi apki „w spoczynku";
/// - pismo Menlo 13/11 pt (iPad/telefon, `TerminalFontSize`) z kaskadą Symbols Nerd Font Mono (glify p10k i eza),
///   kolory z palety apki za motywem; the font follows the app's text size live (`SwiftTermSurface+TextScale.swift`);
/// - kolory krawędzi siatki dla pasa wokół niej (``edgeColors``) liczy tylko wtedy, gdy ktoś słucha
///   ``onEdgesChanged`` (okno Cmd+F/Cmd+G): dopiero wtedy SwiftTerm zgłasza zmiany ekranu (`notifyUpdateChanges`);
/// - układ, w którym widok jest mniejszy niż jedna komórka, i układ na nieaktywnej scenie nie zmieniają siatki
///   (``layoutSubviews()``): bez historii (`scrollback: 0`) zejście do jednego wiersza kasowało ekran, a układy
///   z czasu, gdy apka była w tle, zostawiały po powrocie tylko dolną połowę ekranu;
/// - inside an animated layout (rotation, the shortcut bar of a hardware keyboard) the layer's drawing is not scaled
///   (`contentMode = .topLeft`: the drawing for the final size stands at once where the grid will be; a strip it
///   does not cover shows the layer's background, kept in the terminal's theme colour)
///   and SwiftTerm's own layout runs without animation (``layoutSubviews()``), so the caret does not slide across
///   the rows; while the on-screen keyboard comes up the screen holds the surface's height and moves it up by
///   ``rowsLeavingTop(shrinkingTo:)``, the rows SwiftTerm's shrink takes from the top; the scroll view's edge effects
///   are off, so nothing blurs the rows that go up under the header;
/// - grafika Kitty tylko w treści sekwencji (`t=d`): tryby plikowe (`t=f`, `t=t`, `t=s`) odcina przed emulatorem
///   ``KittyFileTransmissionFilter`` w ``feed(_:)`` — terminal jest zdalny, a SwiftTerm zrobiłby `stat` na ścieżce
///   przysłanej z panelu;
/// - adresy http(s) na ekranie (reguła ``TerminalLinks``): stuknięcie palcem i klik wskaźnikiem
///   otwierają adres w przeglądarce systemowej, przytrzymanie palcem daje menu „Otwórz link” i „Kopiuj link”.
///   Własne rozpoznawacze ``linkTap`` i ``linkHold`` ruszają tylko nad adresem, a stuknięcie i przytrzymanie SwiftTerm
///   czekają na ich porażkę. SwiftTerm sam linków palcem nie otwiera (wymaga podświetlenia kursorem) i nie skleja
///   adresu zawiniętego przez Claude Code albo herdr.
///
/// Treść terminala nie trafia do logów: `silentLog` rdzenia jest włączony na stałe (w buildzie
/// Debug SwiftTerm wypisywałby nieznane sekwencje razem z ich treścią), OSC 52 nie dotyka schowka, a tytuł
/// okna i katalog z OSC 7 są ignorowane. Poza ekran wychodzi tylko na gest: zaznaczenie do schowka, adres do
/// przeglądarki albo do schowka.
public final class SwiftTermSurface: TerminalView, TerminalSurface, UIGestureRecognizerDelegate,
  @preconcurrency UIEditMenuInteractionDelegate
{
  /// Fabryka do środowiska apki (`terminalSurfaceFactory`).
  public static let factory = TerminalSurfaceFactory { SwiftTermSurface(configuration: $0) }

  public var onInput: ((String) -> Void)?
  public var onPaste: ((String) -> Void)?
  public var onResize: ((Int, Int) -> Void)?
  public var onScroll: ((Int, TerminalCell?) -> Void)?
  public var onCopy: (() -> Void)?
  public var onFocus: (() -> Void)?
  public var onKeyRepeatEnded: ((TerminalKeyRepeatEnd) -> Void)?
  public var onLayoutSkipped: ((CGFloat) -> Void)?
  /// Czy scena widoku jest aktywna — w testach atrapa (gospodarz testów nie ma `connectedScenes`); `nil` = stan
  /// sceny okna (``sceneInactive``).
  var sceneIsActive: (@MainActor () -> Bool)?
  public var onEdgesChanged: (() -> Void)? {
    didSet {
      // `rangeChanged` SwiftTerm woła tylko przy tej fladze — trasa (bez słuchacza) nie płaci nic.
      notifyUpdateChanges = onEdgesChanged != nil
      handedEdges = nil
    }
  }

  public var view: UIView { self }

  /// Odczyt schowka przy `paste(_:)` — wstrzykiwany w testach (symulator pytałby o zgodę).
  var pasteboardText: @MainActor () -> String? = { UIPasteboard.general.string }
  /// Otwarcie adresu w przeglądarce systemowej (adres claude.ai z `#no_universal_links`) — w testach atrapa.
  var openLink: @MainActor (URL) -> Void = { UIApplication.shared.open(BrowserLinks.outside($0)) }
  /// „Kopiuj link” — w testach atrapa.
  var copyLinkText: @MainActor (String) -> Void = { UIPasteboard.general.string = $0 }
  /// Stuknięcie palcem w adres.
  let linkTap = UITapGestureRecognizer()
  /// Przytrzymanie palcem na adresie: menu „Otwórz link” i „Kopiuj link”.
  let linkHold = UILongPressGestureRecognizer()
  /// Prawy klik wskaźnikiem (także klik dwoma palcami na gładziku) na adresie: to samo menu.
  let linkSecondaryClick = UITapGestureRecognizer()
  /// Najechanie wskaźnikiem: przerywane podkreślenie całego adresu (``linkUnderline``).
  let linkHover = UIHoverGestureRecognizer()
  /// Warstwa podkreślenia adresu pod wskaźnikiem; pusta ścieżka = nic.
  let linkUnderlineLayer = CAShapeLayer()
  /// Podkreślony adres: wiersz ekranu → kolumny (od 0). `nil` = nic nie jest podkreślone.
  private(set) var linkUnderline: LinkUnderline?
  /// Ostatni punkt wskaźnika nad powierzchnią; `nil` = wskaźnik poza nią.
  private var hoverPoint: CGPoint?

  struct LinkUnderline: Equatable {
    let url: URL
    let rows: [Int: ClosedRange<Int>]
  }
  private var linkMenu: UIEditMenuInteraction?
  /// Okno dwukliku wskaźnika, po którym klik ×1 w adres go otwiera — w testach krótsze.
  var linkClickDelay: Duration = .seconds(TerminalClickCounter.interval)
  /// Otwarcie adresu po kliku wskaźnikiem, które czeka na koniec okna dwukliku.
  private(set) var pendingLinkOpen: Task<Void, Never>?
  /// Adres menu przytrzymania.
  private(set) var menuLink: URL?

  let configuration: TerminalSurfaceConfiguration
  private let bridge = SurfaceDelegate()
  /// Model parsera SwiftTerm dla odcięcia trybów plikowych Kitty; `reset()` go nie zeruje, bo nie zeruje parsera.
  private var kittyFilter = KittyFileTransmissionFilter()
  let scrollPan = UIPanGestureRecognizer()
  /// Zaznaczanie wskaźnikiem: przytrzymanie bez progu czasu = wciśnięcie, ruch i puszczenie przycisku.
  let pointerSelection = UILongPressGestureRecognizer()
  private var clickCounter = TerminalClickCounter()
  var pointerGesture: PointerGesture?
  /// Ostatnie zdarzenie, które dostał pan przewijania, było przewinięciem (dwa palce na gładziku), nie dotykiem.
  var scrollPanByScrollEvent = false
  private var accumulator = ScrollAccumulator()
  private var momentum: ScrollMomentum?
  private var momentumLink: CADisplayLink?
  private var scrollCell: TerminalCell?
  private(set) var closed = false
  /// Ostatnie krawędzie oddane słuchaczowi (odczytem albo sygnałem): sygnał idzie tylko przy innym wyniku.
  private var handedEdges: TerminalEdges?
  /// Paleta 256 kolorów, przeliczana przy zmianie tła, pierwszego planu albo strategii.
  private var palette: TerminalPalette?
  /// Sprawdzenia krawędzi po sygnale SwiftTerm (`rangeChanged`, zmiana zaznaczenia) — pomiar w testach.
  private(set) var edgeChecks = 0

  /// Takt serii strzałki — w testach krótszy.
  var keyRepeatTiming = (
    delay: TerminalKeyRepeat.delay, interval: TerminalKeyRepeat.interval, ceiling: TerminalKeyRepeat.ceiling
  )
  /// Stan klawisza wg `GCKeyboard` (zapas, gdy puszczenie nie dojdzie do kontenera); `nil` = nie wiadomo.
  var keyIsPressed: @MainActor (UIKeyboardHIDUsage) -> Bool? = { HardwareKeys.isPressed($0) }
  /// Bieżąca seria strzałki; `token` odcina spóźnione obroty zadania po zatrzymaniu.
  private(set) var arrowRepeat: ArrowRepeat?
  private var arrowRepeatTask: Task<Void, Never>?
  private var arrowRepeatTokens = 0

  struct ArrowRepeat {
    let token: Int
    let keyCode: UIKeyboardHIDUsage
    let started: ContinuousClock.Instant
    var repeats = 0
    /// `GCKeyboard` widział klawisz wciśnięty w tym przytrzymaniu — dopiero wtedy jego „puszczony" coś znaczy.
    var seenPressed = false
  }

  public init(configuration: TerminalSurfaceConfiguration) {
    self.configuration = configuration
    let fonts = Self.fonts(size: TerminalFontSize.points(configuration.fontSize, scale: configuration.textScale))
    super.init(frame: .zero, font: fonts.normal, options: TerminalOptions(cursorStyle: .steadyBlock, scrollback: 0))
    setFonts(normal: fonts.normal, bold: fonts.bold, italic: fonts.italic, boldItalic: fonts.boldItalic)
    configure()
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) { fatalError("init(coder:) nieużywany") }

  private func configure() {
    bridge.surface = self
    terminalDelegate = bridge
    getTerminal().silentLog = true
    optionAsMetaKey = false
    allowMouseReporting = false
    inputAccessoryView = nil
    isScrollEnabled = false
    // SwiftTerm draws the layer for the final size at once, while an animated layout (rotation) animates the bounds:
    // `.scaleToFill` stretched that drawing over the animated bounds. Unscaled and top-aligned, the drawing sits
    // where the grid will be (cell 0,0 in the top-left corner, like SwiftTerm's caret subview; `.top` would centre it
    // horizontally while a rotation animates the width); the strip under it shows the layer's background until the
    // bounds reach the final size. Bottom-aligned, the caret floated above its row.
    contentMode = .topLeft
    // The surface is a scroll view that does not scroll: the system's edge effects only blur rows. Held while the
    // on-screen keyboard comes up, the surface stands above its container, and the top effect blurred the rows going
    // up (a dark band the height of the rise, recorded on an iPhone).
    topEdgeEffect.isHidden = true
    bottomEdgeEffect.isHidden = true
    // `UIScrollView` sam obsługuje PageUp/PageDown/Home/End (przewijanie klawiaturą) — te klawisze nie
    // dochodziły do `pressesBegan`; należą do programu w terminalu.
    allowsKeyboardScrolling = false
    // Wklejka i upuszczenie tekstu (`UIPasteControl` paska, przeciągnięcie) kończą w `paste(itemProviders:)`.
    pasteConfiguration = UIPasteConfiguration(forAccepting: NSString.self)
    accessibilityIdentifier = "terminal.surface.view"
    applyColors()
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: SwiftTermSurface, _: UITraitCollection) in
      self.applyColors()
    }
    scrollPan.addTarget(self, action: #selector(handleScrollPan(_:)))
    scrollPan.allowedScrollTypesMask = .all
    scrollPan.allowedTouchTypes = Self.touchTypes
    scrollPan.maximumNumberOfTouches = 1
    scrollPan.delegate = self
    addGestureRecognizer(scrollPan)
    pointerSelection.addTarget(self, action: #selector(handlePointerSelection(_:)))
    pointerSelection.minimumPressDuration = 0
    pointerSelection.allowableMovement = .greatestFiniteMagnitude
    pointerSelection.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    addGestureRecognizer(pointerSelection)
    // Rozpoznawacze dodane przez SwiftTerm w `init` (zanim `configure` ruszył) — nadpisany `addGestureRecognizer`
    // ograniczył je już do dotyku; drugi raz nic nie zmienia, a pilnuje kolejności inicjalizacji.
    gestureRecognizers?.forEach(restrictToTouch)
    configureLinkGestures()
    followTextScale()
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(sceneWillDeactivate), name: UIScene.willDeactivateNotification, object: nil)
    center.addObserver(self, selector: #selector(sceneDidActivate(_:)), name: UIScene.didActivateNotification, object: nil)
    center.addObserver(self, selector: #selector(keyboardDisconnected), name: .GCKeyboardDidDisconnect, object: nil)
  }

  /// Kolory motywu: SwiftTerm zamienia je na swoje wartości, więc przy zmianie motywu podajemy je od nowa.
  private func applyColors() {
    let background = configuration.background.resolvedColor(with: traitCollection)
    let foreground = configuration.foreground.resolvedColor(with: traitCollection)
    nativeBackgroundColor = background
    // SwiftTerm fills the layer's background once, in `init`, from its default colour. It shows wherever the
    // unscaled drawing does not reach (under the grid while a layout animates the bounds), so it follows the theme.
    layer.backgroundColor = background.cgColor
    nativeForegroundColor = foreground
    caretColor = foreground
    linkUnderlineLayer.strokeColor = foreground.cgColor
  }

  /// Menlo (zwykły, pogrubiony, kursywa) z kaskadą Symbols Nerd Font Mono — dlaczego nie monospace systemowy:
  /// ``TerminalSymbolsFont/baseNames``.
  static func fonts(size: CGFloat) -> (normal: UIFont, bold: UIFont, italic: UIFont, boldItalic: UIFont) {
    let names = TerminalSymbolsFont.baseNames
    func make(_ name: String) -> UIFont { TerminalSymbolsFont.font(named: name, size: size) as UIFont }
    return (make(names.regular), make(names.bold), make(names.italic), make(names.boldItalic))
  }

  // MARK: - TerminalSurface

  public var gridSize: (cols: Int, rows: Int) {
    let terminal = getTerminal()
    return (terminal.cols, terminal.rows)
  }

  public var selectedText: String? {
    guard hasActiveSelection, let text = getSelection(), !text.isEmpty else { return nil }
    return text
  }

  // `clearSelection()` protokołu (zaznaczenie znika po kopii) daje sam `TerminalView` SwiftTerm
  // (`selection.selectNone()`, jak `scrollBegan`); metoda nie jest `open`, więc tu jej nie ma.

  public var visibleText: String {
    let terminal = getTerminal()
    var lines = (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
    while lines.last?.isEmpty == true { lines.removeLast() }
    return lines.joined(separator: "\n")
  }

  /// Jedyne wejście bajtów panelu do SwiftTerm: przez ``KittyFileTransmissionFilter`` (tryby plikowe grafiki Kitty
  /// nie dochodzą do emulatora). Kawałek bez zmian idzie bez kopii.
  public func feed(_ data: Data) {
    let bytes = [UInt8](data)[...]
    if let filtered = kittyFilter.filter(bytes) {
      feed(byteArray: filtered[...])
    } else {
      feed(byteArray: bytes)
    }
    // Nowy ekran pod nieruchomym wskaźnikiem: podkreślenie idzie za treścią, nie zostaje na starym miejscu.
    if hoverPoint != nil { updateLinkUnderline() }
  }

  // MARK: - Krawędzie siatki

  public var gridFrame: CGRect { getOptimalFrameSize() }

  /// SwiftTerm's shrink (`Buffer.resize`) first removes the rows below the cursor, then scrolls the top away; without
  /// history (`scrollback: 0`) the scrolled rows are gone.
  public func rowsLeavingTop(shrinkingTo rows: Int) -> Int {
    let terminal = getTerminal()
    let dropped = terminal.rows - rows
    guard dropped > 0 else { return 0 }
    let below = max(0, terminal.rows - 1 - terminal.buffer.y)
    return max(0, dropped - below)
  }

  public var edgeColors: TerminalEdges? {
    let edges = readEdges()
    handedEdges = edges
    return edges
  }

  /// Kolory krawędzi z widocznego ekranu: efektywne tło i pierwszy plan widoku (także po OSC 11), paleta z kotwic
  /// emulatora — tych samych, z których liczy ją SwiftTerm.
  func readEdges() -> TerminalEdges {
    let terminal = getTerminal()
    let key = TerminalPalette.Key(
      background: TerminalEdgeColor(terminal.backgroundColor), foreground: TerminalEdgeColor(terminal.foregroundColor),
      strategy: terminal.ansi256PaletteStrategy)
    let current: TerminalPalette
    if let palette, palette.key == key {
      current = palette
    } else {
      current = TerminalPalette(
        background: terminal.backgroundColor, foreground: terminal.foregroundColor, strategy: key.strategy)
      palette = current
    }
    return TerminalEdgeReader.edges(
      of: terminal, palette: current, background: TerminalEdgeColor(nativeBackgroundColor),
      foreground: TerminalEdgeColor(nativeForegroundColor), selecting: hasActiveSelection)
  }

  /// Sygnał SwiftTerm (porcja bajtów, zmiana kolorów, zaznaczenie): przy innym wyniku — ``onEdgesChanged``.
  func edgesMayHaveChanged() {
    guard onEdgesChanged != nil, !closed else { return }
    edgeChecks += 1
    let edges = readEdges()
    guard edges != handedEdges else { return }
    handedEdges = edges
    onEdgesChanged?()
  }

  /// Zaznaczenie zmienia, czy wąski pas wewnątrz powierzchni wolno zamalować (uchwyty, ``TerminalEdges/selecting``).
  public override func selectionChanged(source: Terminal) {
    super.selectionChanged(source: source)
    edgesMayHaveChanged()
  }

  /// Nowy pełny ekran: zaznaczenie siedzi na komórkach bufora, a herdr przepisuje je w miejscu — bez czyszczenia
  /// podświetlenie zostałoby na zmienionym tekście.
  public func reset() {
    selectNone()
    let terminal = getTerminal()
    terminal.resetToInitialState()
    terminal.silentLog = true
    setNeedsDisplay()
    if hoverPoint != nil { updateLinkUnderline() }
  }

  // MARK: - Schowek

  /// Menu edycji („Wklej" z dymka zaznaczenia), Cmd+V z menu apki, pasek skrótów klawiatury: surowy tekst do
  /// ``onPaste``. `super` (owijanie według `bracketedPasteMode` i wysyłka przez `send`) nie biegnie nigdy.
  public override func paste(_ sender: Any?) {
    guard let text = pasteboardText(), !text.isEmpty else { return }
    onPaste?(text)
  }

  /// `UIPasteControl` paska (wklejka bez systemowego pytania o zgodę) i upuszczenie tekstu na terminal.
  public override func paste(itemProviders: [NSItemProvider]) {
    guard let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return }
    _ = provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
      guard let text = (object as? NSString).map({ String($0) }), !text.isEmpty else { return }
      Task { @MainActor in self?.onPaste?(text) }
    }
  }

  public override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
    itemProviders.contains { $0.canLoadObject(ofClass: NSString.self) }
  }

  /// „Kopiuj" z dymka zaznaczenia i Cmd+C przy zaznaczeniu: kopię robi ekran (zaznaczenie albo ekran, jedno
  /// zdanie wyniku). Bez zaznaczenia SwiftTerm akcji nie przyjmuje — Cmd+C łapie wtedy kontener ekranu.
  /// Zaznaczenie po kopii zdejmuje ekran (``clearSelection()``); poza tym znika na
  /// klik, stuknięcie, przewinięcie albo nowy ekran.
  public override func copy(_ sender: Any?) {
    onCopy?()
  }

  // MARK: - Klawiatura sprzętowa

  public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    // Nowy klawisz kończy serię strzałki: SwiftTerm nie woła `super` dla klawiszy, które obsłużył, więc kontener
    // wciśnięcia drugiego klawisza nie zobaczy. Sam modyfikator (Shift, Ctrl…) serii nie przerywa.
    if arrowRepeat != nil, presses.contains(where: { !Self.isModifier($0.key) }) { stopArrowRepeat(.newKey) }
    if let bytes = Self.programKey(presses) {
      onInput?(bytes)
      return
    }
    if presses.count == 1, let key = presses.first?.key,
      let bytes = arrowCapture(key.keyCode, modifiers: key.modifierFlags)
    {
      beginArrowRepeat(keyCode: key.keyCode, bytes: bytes)
      return
    }
    super.pressesBegan(presses, with: event)
  }

  // `pressesEnded` SwiftTerm nie jest `open`; dla tych klawiszy tylko gasi powtarzanie i stan Cmd — bez bajtów.
  // Puszczenie strzałki dochodzi przez jego `super` do kontenera ekranu, a ten oddaje je `hardwareKeysEnded`.

  /// `pressesCancelled` SwiftTerm nie nadpisuje — tu seria staje od razu, zanim zdarzenie pójdzie dalej.
  public override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    stopArrowRepeat(.cancelled)
    super.pressesCancelled(presses, with: event)
  }

  public func hardwareKeysEnded(_ presses: Set<UIPress>, cancelled: Bool) {
    for press in presses {
      guard let code = press.key?.keyCode else { continue }
      arrowKeyReleased(code, cancelled: cancelled)
    }
  }

  /// Puszczenie klawisza (z kontenera): seria staje tylko przy ZGODNYM kodzie — puszczenie Shift w trakcie
  /// Shift+strzałki jej nie zatrzymuje. Anulowanie zatrzymuje zawsze.
  func arrowKeyReleased(_ keyCode: UIKeyboardHIDUsage, cancelled: Bool) {
    guard let current = arrowRepeat else { return }
    if cancelled {
      stopArrowRepeat(.cancelled)
    } else if current.keyCode == keyCode {
      stopArrowRepeat(.released)
    }
  }

  /// Strzałka, którą powierzchnia przejmuje (``TerminalKeyMap/arrowBytes(_:modifiers:applicationCursor:)``):
  /// tylko bez kompozycji znaków (`markedTextRange`) i bez protokołu klawiatury kitty (program poprosił
  /// `ESC[>…u` — wtedy koduje i powtarza SwiftTerm, łącznie ze zdarzeniami puszczenia). `nil` = oddać SwiftTerm.
  func arrowCapture(_ keyCode: UIKeyboardHIDUsage, modifiers: UIKeyModifierFlags) -> String? {
    let terminal = getTerminal()
    guard markedTextRange == nil, terminal.keyboardEnhancementFlags.isEmpty else { return nil }
    return TerminalKeyMap.arrowBytes(keyCode, modifiers: modifiers, applicationCursor: terminal.applicationCursor)
  }

  /// Pierwsze bajty od razu, seria po `delay` w takcie `interval` — wysyłka publicznym `send(txt:)` jak SwiftTerm
  /// (echo rysuje się od razu, bez dławika 16 ms). Zadanie na głównym aktorze; każda droga zatrzymania je anuluje.
  /// Sufit liczy REALNY czas od wciśnięcia przed każdym wysłaniem: obrót spóźniony przez zajęty główny aktor nie
  /// wysyła już nic (suma nominalnych taktów rośnie wolniej niż zegar).
  func beginArrowRepeat(keyCode: UIKeyboardHIDUsage, bytes: String) {
    stopArrowRepeat(nil)
    stopSwiftTermKeyRepeat()
    guard !closed else { return }
    arrowRepeatTokens += 1
    let token = arrowRepeatTokens
    let started = ContinuousClock.now
    var current = ArrowRepeat(token: token, keyCode: keyCode, started: started)
    current.seenPressed = keyIsPressed(keyCode) == true
    arrowRepeat = current
    send(txt: bytes)
    let timing = keyRepeatTiming
    let deadline = started + timing.ceiling
    arrowRepeatTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: timing.delay)
      while !Task.isCancelled {
        guard let self, self.arrowRepeat?.token == token else { return }
        guard ContinuousClock.now < deadline else { return self.stopArrowRepeat(.ceiling) }
        if let pressed = self.keyIsPressed(keyCode) {
          if pressed {
            self.arrowRepeat?.seenPressed = true
          } else if self.arrowRepeat?.seenPressed == true {
            return self.stopArrowRepeat(.gameController)
          }
        }
        self.send(txt: bytes)
        self.arrowRepeat?.repeats += 1
        try? await Task.sleep(for: timing.interval)
      }
    }
  }

  /// Zegar powtarzania SwiftTerm (`keyRepeat`, wewnętrzny) klawisza trzymanego PRZED strzałką — np. F5 — biegłby
  /// dalej obok naszej serii, bo przejęta strzałka nie idzie do `super.pressesBegan`, które go podmienia. Jedyna
  /// publiczna droga to `pressesEnded` SwiftTerm z pustym zbiorem: unieważnia zegar, a przy pustych flagach kitty
  /// (warunek przejęcia) nic nie wysyła; jego `super` oddaje pusty zbiór kontenerowi, który nic z nim nie robi.
  private func stopSwiftTermKeyRepeat() {
    super.pressesEnded([], with: nil)
  }

  /// Koniec serii; `reason == nil` = cicho (nowa seria tuż po poprzedniej w tym samym `pressesBegan`).
  func stopArrowRepeat(_ reason: TerminalKeyRepeatStop?) {
    guard let current = arrowRepeat else { return }
    arrowRepeat = nil
    arrowRepeatTask?.cancel()
    arrowRepeatTask = nil
    guard let reason else { return }
    let milliseconds = Int(((ContinuousClock.now - current.started) / .milliseconds(1)).rounded())
    onKeyRepeatEnded?(TerminalKeyRepeatEnd(reason: reason, repeats: current.repeats, heldMilliseconds: milliseconds))
  }

  private static func isModifier(_ key: UIKey?) -> Bool {
    switch key?.keyCode {
    case .keyboardLeftShift?, .keyboardRightShift?, .keyboardLeftControl?, .keyboardRightControl?,
      .keyboardLeftAlt?, .keyboardRightAlt?, .keyboardLeftGUI?, .keyboardRightGUI?, .keyboardCapsLock?:
      true
    default:
      false
    }
  }

  @objc nonisolated private func sceneWillDeactivate() {
    Task { @MainActor in self.stopArrowRepeat(.sceneInactive) }
  }

  @objc nonisolated private func keyboardDisconnected() {
    Task { @MainActor in self.stopArrowRepeat(.keyboardDisconnected) }
  }

  /// fn+↑/↓/←/→ (PageUp, PageDown, Home, End) bez modyfikatorów: bajty dla programu; `nil` = oddać SwiftTerm.
  private static func programKey(_ presses: Set<UIPress>) -> String? {
    guard presses.count == 1, let key = presses.first?.key else { return nil }
    return TerminalKeyMap.pressBytes(key)
  }

  public override func becomeFirstResponder() -> Bool {
    let became = super.becomeFirstResponder()
    if became { onFocus?() }
    return became
  }

  public override func resignFirstResponder() -> Bool {
    stopArrowRepeat(.resigned)
    return super.resignFirstResponder()
  }

  // MARK: - Mysz i przewijanie

  /// SwiftTerm przy włączonym trybie myszy dokłada pan raportujący mysz — zostaje wyłączony.
  public override func mouseModeChanged(source: Terminal) {}

  public override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === linkTap || gestureRecognizer === linkHold || gestureRecognizer === linkSecondaryClick {
      // Obok adresu rozpoznawacz pada, a stuknięcie albo przytrzymanie SwiftTerm idzie jak dotąd.
      return link(at: gestureRecognizer.location(in: self)) != nil
    }
    if gestureRecognizer !== scrollPan, type(of: gestureRecognizer) == UIPanGestureRecognizer.self {
      // Pan zaznaczenia SwiftTerm (dokładany po ×2/×3 palcem) bez zaznaczenia przesuwa KURSOR strzałkami
      // (`sendKey`) — po wyczyszczeniu zaznaczenia nie jego czas.
      guard hasActiveSelection else { return false }
    }
    guard gestureRecognizer === scrollPan else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
    // Przy zaznaczeniu palec ciągnie uchwyty SwiftTerm; przewinięcie dwoma palcami na gładziku idzie zawsze
    // (i czyści zaznaczenie). Poziomy ruch należy do terminala.
    guard !hasActiveSelection || scrollPanByScrollEvent else { return false }
    let velocity = scrollPan.velocity(in: self)
    return abs(velocity.y) >= abs(velocity.x)
  }

  /// Pan przewijania z niczym naraz; najechanie wskaźnikiem (podkreślenie adresu) obok wszystkiego, także obok
  /// najechania SwiftTerm — inaczej jedno z nich nie dostawałoby ruchów wskaźnika.
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    gestureRecognizer === linkHover || other === linkHover
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
    if gestureRecognizer === scrollPan { scrollPanByScrollEvent = event.type == .scroll }
    return true
  }

  /// Dotyk i rysik — bez wskaźnika (gładzik, mysz).
  static let touchTypes: [NSNumber] = [UITouch.TouchType.direct, .pencil].map { NSNumber(value: $0.rawValue) }

  /// Każdy rozpoznawacz SwiftTerm (stuknięcia ×1/×2/×3, przytrzymanie, pan zaznaczenia dokładany PÓŹNIEJ) dostaje
  /// tylko dotyk: klik gładzikiem łapał je jak stuknięcie i zaznaczał słowo albo stawiał menu przy kursorze.
  public override func addGestureRecognizer(_ gestureRecognizer: UIGestureRecognizer) {
    restrictToTouch(gestureRecognizer)
    super.addGestureRecognizer(gestureRecognizer)
  }

  /// Tylko publiczne klasy, których używa SwiftTerm: prywatne podklasy systemu (wskaźnik, pan `UIScrollView`)
  /// i nasze rozpoznawacze zostają nietknięte.
  private func restrictToTouch(_ recognizer: UIGestureRecognizer) {
    guard recognizer !== scrollPan, recognizer !== pointerSelection, recognizer !== linkSecondaryClick else { return }
    let kind = type(of: recognizer)
    guard kind == UITapGestureRecognizer.self || kind == UILongPressGestureRecognizer.self
      || kind == UIPanGestureRecognizer.self
    else { return }
    recognizer.allowedTouchTypes = Self.touchTypes
  }

  /// Wymiar komórki z siatki (SwiftTerm nie wystawia `cellDimension`).
  var cellSize: CGSize {
    let terminal = getTerminal()
    let frame = getOptimalFrameSize()
    guard terminal.cols > 0, terminal.rows > 0 else { return .zero }
    return CGSize(width: frame.width / CGFloat(terminal.cols), height: frame.height / CGFloat(terminal.rows))
  }

  /// Komórka pod palcem (od 1).
  func cell(at point: CGPoint) -> TerminalCell? {
    let size = cellSize
    let terminal = getTerminal()
    guard size.width > 0, size.height > 0 else { return nil }
    let col = min(max(Int(point.x / size.width) + 1, 1), terminal.cols)
    let row = min(max(Int(point.y / size.height) + 1, 1), terminal.rows)
    return TerminalCell(col: col, row: row)
  }

  @objc private func handleScrollPan(_ pan: UIPanGestureRecognizer) {
    switch pan.state {
    case .began:
      scrollBegan()
      scrollCell = cell(at: pan.location(in: self))
    case .changed:
      let translation = pan.translation(in: self)
      pan.setTranslation(.zero, in: self)
      scrollCell = cell(at: pan.location(in: self)) ?? scrollCell
      // Palec w górę (y < 0) = treść w dół historii = `d` dodatnie.
      emit(-translation.y)
    case .ended:
      if let start = ScrollMomentum(velocity: -pan.velocity(in: self).y) { startMomentum(start) }
    default:
      accumulator.reset()
    }
  }

  /// Początek przewijania: rozpęd stoi, a zaznaczenie znika — przewinięta historia przepisuje ekran w miejscu.
  func scrollBegan() {
    stopMomentum()
    accumulator.reset()
    if hasActiveSelection { selectNone() }
  }

  // MARK: - Zaznaczanie wskaźnikiem

  /// Gest wskaźnika od wciśnięcia do puszczenia.
  struct PointerGesture {
    let anchor: CGPoint
    let clicks: Int
    /// ×1: przeciąganie ruszyło (za progiem ``pointerDragSlop``) — dopiero wtedy jest zaznaczenie.
    var selecting = false
  }

  /// Ruch ×1 mniejszy niż tyle to drżenie palca na gładziku, nie przeciągnięcie.
  static let pointerDragSlop: CGFloat = 4

  @objc private func handlePointerSelection(_ recognizer: UILongPressGestureRecognizer) {
    let point = recognizer.location(in: self)
    switch recognizer.state {
    case .began:
      pointerDown(at: point, count: clickCounter.register(at: point, time: CACurrentMediaTime()))
    case .changed:
      pointerDrag(to: point)
    case .ended:
      pointerUp(at: point)
    default:
      pointerGesture = nil
    }
  }

  /// Puszczenie przycisku: klik ×1 bez przeciągnięcia na adresie otwiera adres, ale dopiero po oknie
  /// dwukliku — następne wciśnięcie w tym czasie (×2 zaznacza słowo) otwarcie odwołuje. Inaczej dwuklik w adres
  /// otwierałby przeglądarkę już po pierwszym puszczeniu.
  func pointerUp(at point: CGPoint) {
    defer { pointerGesture = nil }
    guard let gesture = pointerGesture, gesture.clicks == 1, !gesture.selecting, let url = link(at: point) else { return }
    let delay = linkClickDelay
    pendingLinkOpen = Task { @MainActor [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled, let self, !self.closed else { return }
      self.pendingLinkOpen = nil
      self.openLink(url)
    }
  }

  private func cancelPendingLinkOpen() {
    pendingLinkOpen?.cancel()
    pendingLinkOpen = nil
  }

  /// Wciśnięcie wskaźnika: fokus klawiatury (jak stuknięcie SwiftTerm), ×1 czyści zaznaczenie i kotwiczy, ×2
  /// zaznacza słowo, ×3 wiersz.
  func pointerDown(at point: CGPoint, count: Int) {
    cancelPendingLinkOpen()
    if !isFirstResponder { _ = becomeFirstResponder() }
    stopMomentum()
    pointerGesture = PointerGesture(anchor: point, clicks: count)
    let terminal = getTerminal()
    let cell = gridCell(at: point)
    let row = cell.row + terminal.buffer.yDisp
    switch count {
    case 1:
      selectNone()
    case 2:
      selection.selectWordOrExpression(at: Position(col: cell.col, row: row), in: terminal.buffer)
    default:
      selectRows(cell.row, cell.row)
    }
  }

  /// Przeciągnięcie z wciśniętym przyciskiem: ×1 po znakach od punktu wciśnięcia (granice komórek, jak w polu
  /// tekstu na Macu), ×2 po słowach, ×3 po wierszach. Poza powierzchnią — do krawędzi siatki.
  func pointerDrag(to point: CGPoint) {
    guard var gesture = pointerGesture else { return }
    switch gesture.clicks {
    case 1:
      if !gesture.selecting {
        let moved = hypot(point.x - gesture.anchor.x, point.y - gesture.anchor.y)
        guard moved > Self.pointerDragSlop else { return }
        gesture.selecting = true
        let start = gridBoundary(at: gesture.anchor)
        selection.startSelection(row: start.row, col: start.col)
      }
      let end = gridBoundary(at: point)
      selection.dragExtend(row: end.row, col: end.col)
    case 2:
      let cell = gridCell(at: point)
      selection.dragExtend(row: cell.row, col: cell.col)
    default:
      let first = gridCell(at: gesture.anchor).row
      let last = gridCell(at: point).row
      selectRows(min(first, last), max(first, last))
    }
    pointerGesture = gesture
  }

  /// Całe wiersze `top…bottom` (ekranowe). Koniec zaznaczenia SwiftTerm jest WYŁĄCZNY, więc stoi na `cols` —
  /// `select(row:)` stawia go na `cols − 1`, a `setSelection` przycina do `cols − 1`: znak w ostatniej kolumnie
  /// ginąłby z kopii. `startSelection` + `dragExtend` nie przycinają.
  private func selectRows(_ top: Int, _ bottom: Int) {
    selection.startSelection(row: top, col: 0)
    selection.dragExtend(row: bottom, col: getTerminal().cols)
  }

  /// Komórka pod punktem (od 0), przyciśnięta do siatki.
  private func gridCell(at point: CGPoint) -> (col: Int, row: Int) {
    let size = cellSize
    let terminal = getTerminal()
    guard size.width > 0, size.height > 0 else { return (0, 0) }
    let col = min(max(Int(point.x / size.width), 0), max(terminal.cols - 1, 0))
    let row = min(max(Int(point.y / size.height), 0), max(terminal.rows - 1, 0))
    return (col, row)
  }

  /// Granica komórek najbliższa punktowi (0…cols) w wierszu pod punktem — koniec zaznaczenia SwiftTerm jest
  /// wyłączny, więc granica `n` zamyka zaznaczenie przed komórką `n`.
  private func gridBoundary(at point: CGPoint) -> (col: Int, row: Int) {
    let size = cellSize
    let cols = getTerminal().cols
    let row = gridCell(at: point).row
    guard size.width > 0 else { return (0, row) }
    return (min(max(Int((point.x / size.width).rounded()), 0), cols), row)
  }

  private func emit(_ delta: CGFloat) {
    let lines = accumulator.push(Double(delta), cellHeight: Double(cellSize.height))
    guard lines != 0 else { return }
    onScroll?(lines, scrollCell)
  }

  private func startMomentum(_ start: ScrollMomentum) {
    momentum = start
    let link = CADisplayLink(target: self, selector: #selector(stepMomentum(_:)))
    link.add(to: .main, forMode: .common)
    momentumLink = link
  }

  @objc private func stepMomentum(_ link: CADisplayLink) {
    guard var current = momentum else { return stopMomentum() }
    let step = current.step(seconds: link.targetTimestamp - link.timestamp)
    momentum = current
    emit(CGFloat(step.delta))
    if !step.running { stopMomentum() }
  }

  func stopMomentum() {
    momentumLink?.invalidate()
    momentumLink = nil
    momentum = nil
  }

  /// `updateUiClosed()` unieważnia `CADisplayLink` odświeżania SwiftTerm — pętla trzyma go, a on trzyma ten
  /// widok, więc bez tego powierzchnia (z emulatorem i jego ekranem) nie schodzi z pamięci nigdy.
  public func close() {
    guard !closed else { return }
    stopArrowRepeat(.closed)
    closed = true
    stopMomentum()
    updateUiClosed()
    linkMenu?.dismissMenu()
    menuLink = nil
    cancelPendingLinkOpen()
    hoverEnded()
    onInput = nil
    onPaste = nil
    onResize = nil
    onScroll = nil
    onCopy = nil
    onFocus = nil
    onKeyRepeatEnded = nil
    onEdgesChanged = nil
    onLayoutSkipped = nil
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopMomentum()
      stopArrowRepeat(.detached)
    } else {
      // A text size step taken while parked lands on return.
      applyScaledFont()
    }
  }

  // MARK: - Linki

  /// Przytrzymanie adresu rusza przed menu SwiftTerm (0,7 s), więc obok adresu menu SwiftTerm nie czeka dłużej.
  static let linkHoldDuration: TimeInterval = 0.5

  /// Stuknięcie i przytrzymanie SwiftTerm czekają na porażkę rozpoznawaczy linku; stuknięcie linku czeka na porażkę
  /// stuknięcia ×2 SwiftTerm, więc dwa stuknięcia w adres dalej zaznaczają słowo.
  private func configureLinkGestures() {
    linkTap.addTarget(self, action: #selector(handleLinkTap(_:)))
    linkHold.addTarget(self, action: #selector(handleLinkHold(_:)))
    linkHold.minimumPressDuration = Self.linkHoldDuration
    for recognizer in gestureRecognizers ?? [] {
      if type(of: recognizer) == UITapGestureRecognizer.self, let tap = recognizer as? UITapGestureRecognizer {
        switch tap.numberOfTapsRequired {
        case 1: tap.require(toFail: linkTap)
        case 2: linkTap.require(toFail: tap)
        default: break
        }
      } else if type(of: recognizer) == UILongPressGestureRecognizer.self, recognizer !== pointerSelection {
        recognizer.require(toFail: linkHold)
      }
    }
    // Po pętli: przez nadpisany `addGestureRecognizer` oba dostają tylko dotyk (wskaźnik ma ``pointerUp(at:)``).
    addGestureRecognizer(linkTap)
    addGestureRecognizer(linkHold)
    // Prawy klik: tylko wskaźnik i tylko drugi przycisk, więc nie rusza zaznaczania (`pointerSelection`, przycisk główny).
    linkSecondaryClick.addTarget(self, action: #selector(handleLinkSecondaryClick(_:)))
    linkSecondaryClick.buttonMaskRequired = .secondary
    linkSecondaryClick.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    addGestureRecognizer(linkSecondaryClick)
    // Podkreślenie SwiftTerm zdjęte: po najechaniu jego reguła nie widzi zawinięć (podkreślała jeden wiersz adresu)
    // i podkreśla też ścieżki, których klik nie otwiera, a linku OSC 8 na iPadzie nie podkreślał wcale. Zostaje mu
    // tylko link OSC 8 przy wciśniętym Cmd; każdy adres, który klik otwiera, podkreśla ``linkUnderlineLayer``.
    linkHighlightMode = .alwaysWithModifier
    linkReporting = .none
    linkHover.addTarget(self, action: #selector(handleLinkHover(_:)))
    linkHover.delegate = self
    addGestureRecognizer(linkHover)
    linkUnderlineLayer.fillColor = nil
    linkUnderlineLayer.lineWidth = 1
    linkUnderlineLayer.lineDashPattern = [2, 2]
    linkUnderlineLayer.zPosition = 1
    layer.addSublayer(linkUnderlineLayer)
  }

  @objc private func handleLinkSecondaryClick(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    linkHeld(at: recognizer.location(in: self))
  }

  @objc private func handleLinkHover(_ recognizer: UIHoverGestureRecognizer) {
    switch recognizer.state {
    case .began, .changed:
      hoverMoved(to: recognizer.location(in: self))
    default:
      hoverEnded()
    }
  }

  /// Wskaźnik nad powierzchnią w punkcie `point`: podkreślenie adresu pod nim.
  func hoverMoved(to point: CGPoint) {
    hoverPoint = point
    updateLinkUnderline()
  }

  func hoverEnded() {
    hoverPoint = nil
    updateLinkUnderline()
  }

  /// Podkreślenie adresu pod wskaźnikiem, wiersz po wierszu, z tej samej reguły co klik (``link(at:)``): link OSC 8
  /// komórki, a bez niego goły adres z ekranu.
  /// `redraw` rysuje ścieżkę także przy tym samym adresie (nowy rozmiar komórki po zmianie układu).
  func updateLinkUnderline(redraw: Bool = false) {
    var underline: LinkUnderline?
    if let point = hoverPoint, point.x.isFinite, point.y.isFinite, !closed {
      let cell = gridCell(at: point)
      if let explicit = getTerminal().link(at: .screen(Position(col: cell.col, row: cell.row)), mode: .explicitOnly) {
        let rows = explicitLinkRows(explicit, at: cell)
        if let url = TerminalLinks.web(explicit), !rows.isEmpty {
          underline = LinkUnderline(url: url, rows: rows)
        }
      } else if let found = TerminalLinks.link(
        in: screenCells(), at: TerminalLinks.Cell(row: cell.row, col: cell.col))
      {
        var rows: [Int: ClosedRange<Int>] = [:]
        for cell in found.cells {
          let current = rows[cell.row]
          rows[cell.row] = min(current?.lowerBound ?? cell.col, cell.col)...max(current?.upperBound ?? cell.col, cell.col)
        }
        underline = LinkUnderline(url: found.url, rows: rows)
      }
    }
    guard redraw || underline != linkUnderline else { return }
    linkUnderline = underline
    drawLinkUnderline()
  }

  /// Wiersze linku OSC 8 o celu `target` pod komórką `cell`: w wierszu komórki ciągły odcinek komórek z tym celem,
  /// który ją obejmuje; z sąsiednim wierszem łączy go ta sama reguła co zwykły adres (``TerminalLinks``): odcinek
  /// wyżej kończy się przy prawej krawędzi (najwyżej ``TerminalLinks/edgeGap`` wolnych kolumn), a odcinek niżej
  /// zaczyna się po wcięciu najwyżej ``TerminalLinks/maxIndent``. herdr
  /// rysuje taki link wiersz po wierszu, z sekwencją otwartą przez wszystkie wiersze (pomiar na herdr 0.9.5 i Claude Code 2.1.319, adres
  /// z `claude auth login`), a SwiftTerm podaje cel tylko dla jednej komórki naraz. Jedno przejście po komórkach
  /// wiersza: `terminal.link(at:)` dla każdej kolumny przeszukiwałby cały odcinek od nowa.
  private func explicitLinkRows(_ target: String, at cell: (col: Int, row: Int)) -> [Int: ClosedRange<Int>] {
    let terminal = getTerminal()
    func runs(_ row: Int) -> [ClosedRange<Int>] {
      guard let line = terminal.getLine(row: row) else { return [] }
      var result: [ClosedRange<Int>] = []
      var start: Int?
      let count = min(terminal.cols, line.count)
      for col in 0...count {
        if col < count, Self.linkTarget(line, col) == target {
          if start == nil { start = col }
        } else if let first = start {
          result.append(first...(col - 1))
          start = nil
        }
      }
      return result
    }
    let here = runs(cell.row)
    guard let index = here.firstIndex(where: { $0.contains(cell.col) }) else { return [:] }
    let lastCol = terminal.cols - 1
    func joined(_ upper: ClosedRange<Int>, _ lower: ClosedRange<Int>) -> Bool {
      upper.upperBound >= lastCol - TerminalLinks.edgeGap && lower.lowerBound <= TerminalLinks.maxIndent
    }
    var rows = [cell.row: here[index]]
    var run = here[index]
    var current = cell.row
    var first = index == 0
    while first, current > 0, let above = runs(current - 1).last, joined(above, run) {
      current -= 1
      rows[current] = above
      run = above
      first = runs(current).count == 1
    }
    run = here[index]
    current = cell.row
    var last = index == here.count - 1
    while last, current + 1 < terminal.rows, let below = runs(current + 1).first, joined(run, below) {
      current += 1
      rows[current] = below
      run = below
      last = runs(current).count == 1
    }
    return rows
  }

  /// Cel linku OSC 8 komórki (`params;cel`); druga komórka szerokiego znaku bierze go od pierwszej, jak w SwiftTerm.
  private static func linkTarget(_ line: BufferLine, _ col: Int) -> String? {
    var payload = line[col].getPayload() as? String
    if payload == nil, col > 0, line[col - 1].width == 2 { payload = line[col - 1].getPayload() as? String }
    guard let payload, let separator = payload.firstIndex(of: ";") else { return nil }
    return String(payload[payload.index(after: separator)...])
  }

  /// Ścieżka warstwy z ``linkUnderline``: odcinek pod każdym wierszem adresu, tuż nad dolną krawędzią komórki.
  private func drawLinkUnderline() {
    guard let underline = linkUnderline else {
      linkUnderlineLayer.path = nil
      return
    }
    let size = cellSize
    let path = UIBezierPath()
    for (row, cols) in underline.rows {
      let y = CGFloat(row + 1) * size.height - 1
      path.move(to: CGPoint(x: CGFloat(cols.lowerBound) * size.width, y: y))
      path.addLine(to: CGPoint(x: CGFloat(cols.upperBound + 1) * size.width, y: y))
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    linkUnderlineLayer.frame = bounds
    linkUnderlineLayer.path = path.cgPath
    CATransaction.commit()
  }

  /// Adres http(s) pod punktem: link OSC 8 komórki, a bez niego goły adres z ekranu, sklejony z zawiniętych wierszy.
  func link(at point: CGPoint) -> URL? {
    guard point.x.isFinite, point.y.isFinite else { return nil }
    let cell = gridCell(at: point)
    let terminal = getTerminal()
    if let explicit = terminal.link(at: .screen(Position(col: cell.col, row: cell.row)), mode: .explicitOnly) {
      return TerminalLinks.web(explicit)
    }
    return TerminalLinks.url(in: screenCells(), at: TerminalLinks.Cell(row: cell.row, col: cell.col))
  }

  /// Ekran po komórkach; pusta komórka, druga połowa szerokiego znaku i znak sterujący to spacja.
  func screenCells() -> [[Character]] {
    let terminal = getTerminal()
    let cols = terminal.cols
    return (0..<terminal.rows).map { row in
      guard let line = terminal.getLine(row: row) else { return Array(repeating: " ", count: cols) }
      return (0..<cols).map { col in
        guard col < line.count else { return " " }
        let char = terminal.getCharacter(for: line[col])
        guard let scalar = char.unicodeScalars.first, scalar.value > 0x20 else { return " " }
        return char
      }
    }
  }

  @objc private func handleLinkTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    linkTapped(at: recognizer.location(in: self))
  }

  /// Stuknięcie palcem w adres: przeglądarka. Fokusu klawiatury nie bierze.
  func linkTapped(at point: CGPoint) {
    guard let url = link(at: point) else { return }
    openLink(url)
  }

  @objc private func handleLinkHold(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    linkHeld(at: recognizer.location(in: self))
  }

  /// Przytrzymanie adresu: menu edycji z „Otwórz link” i „Kopiuj link” przy palcu.
  func linkHeld(at point: CGPoint) {
    guard let url = link(at: point) else { return }
    menuLink = url
    let menu = linkMenu ?? {
      let interaction = UIEditMenuInteraction(delegate: self)
      addInteraction(interaction)
      linkMenu = interaction
      return interaction
    }()
    menu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
  }

  /// Pozycje menu przytrzymania adresu.
  func linkMenuActions(_ url: URL) -> [UIAction] {
    [
      UIAction(title: UICopy.terminalLinkOpen, image: UIImage(systemName: "safari")) { [weak self] _ in
        self?.openLink(url)
      },
      UIAction(title: UICopy.terminalLinkCopy, image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
        self?.copyLinkText(url.absoluteString)
      },
    ]
  }

  public func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let url = menuLink else { return nil }
    return UIMenu(children: linkMenuActions(url))
  }

  public func editMenuInteraction(
    _ interaction: UIEditMenuInteraction, willDismissMenuFor configuration: UIEditMenuConfiguration,
    animator: any UIEditMenuInteractionAnimating
  ) {
    menuLink = nil
  }

  // MARK: - Układ

  /// Ostatni przebieg układu był pominięty (widok mniejszy niż komórka albo scena nieaktywna).
  private var skippedLayout = false
  /// Jakiś układ doszedł już do SwiftTerm: jest siatka z ramki i treść, które chroni pominięcie na nieaktywnej scenie.
  private var laidOut = false

  /// Scena widoku nie jest aktywna (``sceneIsActive`` w testach). Widok bez okna albo bez sceny (gospodarz testów)
  /// liczy się jako aktywny: układa się jak zawsze.
  private var sceneInactive: Bool {
    if let sceneIsActive { return !sceneIsActive() }
    guard let scene = window?.windowScene else { return false }
    return scene.activationState != .foregroundActive
  }

  /// Układ nie dochodzi do SwiftTerm w dwóch przypadkach.
  ///
  /// Widok mniejszy niż jedna komórka (wysokość albo szerokość): jego `layoutSubviews` przeliczyłby siatkę na zero
  /// wierszy (rdzeń trzyma jeden), a bez historii (`scrollback: 0`) reszta ekranu przepadałaby na dobre. Tak jest przy
  /// zamykaniu okna Cmd+F/Cmd+G: w przejściu zamykania arkusza prowadnica klawiatury ekranu ma y = 0 i wysokość 0, więc
  /// stos ekranu ma na chwilę 0 pt. Ekran szedłby do parkingu pusty, a po ponownym Cmd+F czekałby na przerysowanie
  /// herdr po `rs` z końca animacji (pomiar: sonda w apce i `TerminalPopupOpeningProbeTests`).
  ///
  /// Scena widoku nieaktywna (w tle albo w przejściu między apkami): po powrocie z tła na iPadzie (nagranie z buildu
  /// 3549) ekran 51 wierszy pokazywał dawne wiersze 26–51 u góry i 25 pustych pod nimi, aż do pierwszego ekranu
  /// z serwera. Taki obraz zostawia SwiftTerm po mniejszej siatce: przy zmniejszeniu z kursorem w ostatnim wierszu
  /// wyrzuca wiersze z góry, a przy powiększeniu dopisuje puste na dole. W tle system układa powierzchnię w innych
  /// rozmiarach (ślad powrotu z buildu 3692: 820, 1258, 840 i 820 pt wysokości przy jednym powrocie); odkąd te
  /// układy nie dochodzą do SwiftTerm, treść zostaje. Po aktywacji sceny powierzchnia układa się od nowa
  /// (``sceneDidActivate(_:)``): bieżąca ramka dochodzi do SwiftTerm, a taka jak przed przerwą niczego nie zmienia.
  /// Pierwszy układ nowej powierzchni dochodzi także na nieaktywnej scenie: nie ma jeszcze treści do ochrony, a nowe
  /// gniazdo bierze siatkę z układu (start apki prosto w terminal).
  ///
  /// W obu przypadkach siatka i treść zostają, `onResize` nie wychodzi, a ``onLayoutSkipped`` dostaje wysokość widoku
  /// (ślad powrotu z tła). Powrót do poprzedniej ramki niczego nie zmienia: SwiftTerm porównuje ramkę z ostatnim
  /// przebiegiem, który przeprowadził. Pominięty jest cały przebieg, także `UIScrollView`, a następny przebieg
  /// w zwykłej ramce na aktywnej scenie układa wszystko.
  public override func layoutSubviews() {
    let cell = cellSize
    let tooSmall = cell.width > 0 && cell.height > 0 && (bounds.width < cell.width || bounds.height < cell.height)
    if tooSmall || (laidOut && sceneInactive) {
      skippedLayout = true
      onLayoutSkipped?(bounds.height)
      return
    }
    // Inside an animation block (a rotation) SwiftTerm's layout would animate what it moves (the caret slid across
    // the rows); the new grid stands at once instead.
    UIView.performWithoutAnimation { super.layoutSubviews() }
    laidOut = true
    if hoverPoint != nil || linkUnderline != nil { updateLinkUnderline(redraw: true) }
    guard skippedLayout else { return }
    skippedLayout = false
    // Rysunek z czasu zdegenerowanej ramki (np. po nowych bajtach) mógł zostawić warstwę pustą, a powrót do tej
    // samej ramki co przed przerwą nie każe SwiftTerm rysować od nowa.
    setNeedsDisplay()
  }

  /// Aktywacja sceny tego widoku (brak sceny w powiadomieniu albo widok bez sceny: tak): układ pominięty na
  /// nieaktywnej scenie przychodzi teraz. Powiadomienia sceny przychodzą na głównym wątku.
  @objc nonisolated private func sceneDidActivate(_ note: Notification) {
    let scene = (note.object as? UIScene).map(ObjectIdentifier.init)
    MainActor.assumeIsolated {
      if let scene, let own = window?.windowScene, ObjectIdentifier(own) != scene { return }
      guard skippedLayout else { return }
      setNeedsLayout()
    }
  }
}

/// Delegat widoku SwiftTerm: bajty klawiatury do ``SwiftTermSurface/onInput``, siatka do ``onResize``. Reszta
/// (tytuł, katalog z OSC 7, OSC 52, linki, dzwonek) świadomie nic nie robi: treść terminala nie wychodzi poza
/// ekran, a do schowka tylko na gest. Linki otwiera sama powierzchnia (``SwiftTermSurface/link(at:)``):
/// `requestOpenLink` SwiftTerm woła tylko przy podświetleniu kursorem, a stuknięcie palcem do niego nie dochodzi.
@MainActor
private final class SurfaceDelegate: @preconcurrency TerminalViewDelegate {
  weak var surface: SwiftTermSurface?

  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    surface?.onResize?(newCols, newRows)
  }

  func send(source: TerminalView, data: ArraySlice<UInt8>) {
    surface?.onInput?(String(decoding: data, as: UTF8.self))
  }

  func setTerminalTitle(source: TerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func scrolled(source: TerminalView, position: Double) {}
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
  func bell(source: TerminalView) {}
  func clipboardCopy(source: TerminalView, content: Data) {}
  func clipboardRead(source: TerminalView) -> Data? { nil }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

  /// Porcja wyświetlona (raz na odświeżenie, także bez brudnych wierszy) — tylko przy słuchaczu krawędzi.
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
    surface?.edgesMayHaveChanged()
  }
}

extension TerminalEdgeColor {
  /// Kolor widoku (sRGB) w 16 bitach na kanał, zaokrąglony — pas z niego i komórka z `UIColor` mają jeden kolor.
  init(_ color: UIColor) {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    func channel(_ value: CGFloat) -> UInt16 { UInt16((min(max(value, 0), 1) * 65535).rounded()) }
    self.init(red: channel(red), green: channel(green), blue: channel(blue))
  }
}
#endif
