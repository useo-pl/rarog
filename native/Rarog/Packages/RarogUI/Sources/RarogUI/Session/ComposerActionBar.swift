#if os(iOS)
import RarogCore
import UIKit

/// Rząd kontrolek pod polem wiadomości (`docs/design.md` „Composer"): kontrolki pola po
/// lewej, akcje po prawej, odstęp między nimi. Kolejność od lewej, z właścicielami:
/// 1. spinacz — załączniki (`attachButton`);
/// 2. pigułki modelu i trybu — sterowanie sesją (`installControls`);
/// 3. rozmowa z agentem głosowym — tylko przy funkcji włączonej w apce i na serwerze
///    (`voiceAgentButton`, stan ustawia `SessionViewController+VoiceAgent`); in the left group, away from the
///    microphone, so the two voice controls do not stand side by side;
/// 4. zwinięcie klawiatury — tylko iPhone z fokusem w polu (`hideKeyboardButton`, widoczność ustawia
///    `ComposerView`); na końcu lewej grupy, więc pojawienie się nie przesuwa spinacza ani pigułek;
/// — odstęp —
/// 5. mikrofon — dyktowanie, a 44 pt plate (`VoiceButtons`);
/// 6. „Wyślij", przy pracującej turze i pustym polu Stop (`SendButton.mode`;
///    osobnego Stopu nie ma, tryb ustawia ekran sesji w `+Interrupt`).
/// Nowy przycisk akcji to `insertArrangedSubview(_:at:)` przed „Wyślij" (wypada za odstępem); układ
/// i cel dotyku 44 pt (`TouchTargetButton`) zostają bez zmian dla reszty.
final class ComposerActionBar: UIStackView {
  let sendButton = SendButton(type: .system)
  /// Spinacz: menu „Zdjęcia"/„Pliki" (składa je `ComposerView`). Właściciel: wysyłka.
  let attachButton = RingButton(type: .system)
  /// Zwinięcie klawiatury ekranowej jednym stuknięciem (iPhone). Daleko od
  /// „Wyślij", żeby nie wysłać promptu przez pomyłkę. Właściciel: wysyłka.
  let hideKeyboardButton = RingButton(type: .system)
  /// Rozmowa z agentem głosowym przy sesji: in the left group after the session pills, so the microphone and Send
  /// stay where they are when the button goes. Właściciel: agent głosowy.
  let voiceAgentButton = RingButton(type: .system)
  /// Odstęp między kontrolkami pola a akcjami — rośnie, gdy jest miejsce, i nie łapie dotyku.
  private let gap = UIView()

  init() {
    super.init(frame: .zero)
    axis = .horizontal
    alignment = .center
    spacing = 6
    buildSend()
    buildAttach()
    buildHideKeyboard()
    gap.isUserInteractionEnabled = false
    gap.setContentHuggingPriority(UILayoutPriority(1), for: .horizontal)
    addArrangedSubview(attachButton)
    addArrangedSubview(voiceAgentButton)
    addArrangedSubview(hideKeyboardButton)
    addArrangedSubview(gap)
    addArrangedSubview(sendButton)
  }

  /// Pigułki sesji tuż za spinaczem. Przy ciasnym rzędzie ustępują przyciskom akcji.
  func installControls(_ view: UIView) {
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentHuggingPriority(.defaultHigh, for: .horizontal)
    insertArrangedSubview(view, at: (arrangedSubviews.firstIndex(of: attachButton) ?? -1) + 1)
  }

  /// Mikrofon dyktowania przed „Wyślij". Stop to ten sam przycisk co „Wyślij", więc mikrofon nie
  /// przesuwa się, gdy tura zaczyna albo kończy pracę.
  func installVoice(_ mic: UIView) {
    insertArrangedSubview(mic, at: arrangedSubviews.firstIndex(of: sendButton) ?? arrangedSubviews.count)
    setCustomSpacing(Self.micToSend, after: mic)
  }

  /// Mikrofon – „Wyślij": odstęp rzędu i 10 pt więcej.
  static let micToSend: CGFloat = 16

  @available(*, unavailable)
  required init(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Cel dotyku przycisku sięga poza pasek (36 → 44 pt): pasek przepuszcza każdy punkt,
  /// który przyjmie któryś z jego przycisków, inaczej powiększony cel kończyłby się na krawędzi paska.
  /// Odstęp dotyku nie łapie.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    arrangedSubviews.contains { view in
      !view.isHidden && view.isUserInteractionEnabled && view.point(inside: convert(point, to: view), with: event)
    }
  }

  /// Spinacz nie zabiera fokusu z pola: menu otwiera się bez zmiany pierwszego respondera.
  /// Okrągły z kreską, 32 pt dla oka (`.composer__attach` w PWA); cel 44 pt daje `TouchTargetButton`.
  private func buildAttach() {
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "paperclip")
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)
    config.cornerStyle = .capsule
    config.contentInsets = .zero
    attachButton.configuration = config
    attachButton.restyle()
    attachButton.showsMenuAsPrimaryAction = true
    attachButton.accessibilityLabel = UICopy.attach
    attachButton.accessibilityIdentifier = "composer.attach"
    attachButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      attachButton.widthAnchor.constraint(equalToConstant: 32),
      attachButton.heightAnchor.constraint(equalToConstant: 32),
    ])
  }

  /// Ten sam kształt co spinacz (32 pt, kreska, cel 44 pt); w spoczynku schowany.
  private func buildHideKeyboard() {
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: "keyboard.chevron.compact.down")
    // 12 pt: symbol klawiatury jest szerszy niż spinacz (15 pt) i przy 14 pt wygląda na za duży.
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    config.cornerStyle = .capsule
    config.contentInsets = .zero
    hideKeyboardButton.configuration = config
    hideKeyboardButton.restyle()
    hideKeyboardButton.accessibilityLabel = UICopy.hideKeyboard
    hideKeyboardButton.accessibilityIdentifier = "composer.hideKeyboard"
    hideKeyboardButton.isHidden = true
    hideKeyboardButton.translatesAutoresizingMaskIntoConstraints = false
    // Szerokość 999, nie 1000: schowany element stosu dostaje od `UIStackView` szerokość 0 z priorytetem 1000
    // i sztywne 32 pt dawało konflikt ograniczeń przy każdym układzie paska.
    let width = hideKeyboardButton.widthAnchor.constraint(equalToConstant: 32)
    width.priority = .required - 1
    NSLayoutConstraint.activate([width, hideKeyboardButton.heightAnchor.constraint(equalToConstant: 32)])
  }

  private func buildSend() {
    // Identyfikator jeden dla obu trybów: test i VoiceOver widzą ten sam przycisk, tryb mówi etykieta.
    sendButton.accessibilityIdentifier = "composer.send"
    sendButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      sendButton.widthAnchor.constraint(equalToConstant: SendButton.side),
      sendButton.heightAnchor.constraint(equalToConstant: SendButton.side),
    ])
  }
}

/// Przycisk akcji pola: „Wyślij" (strzałka w akcencie) albo Stop (■ w kolorze błędu).
/// Stop nie zabiera fokusu z pola: tapnięcie nie zmienia pierwszego respondera, więc
/// klawiatura nie zjeżdża, a prompt może wrócić do pola, w którym stoi kursor. Bez spinnera — przycisk wraca
/// do „Wyślij" dokładnie w oknie przerywania; status niesie wiersz aktywności.
///
/// Delikatny cień (`--shadow-send` w PWA) ma tylko „Wyślij" z treścią: uniesienie jest rangą akcji domyślnej, więc
/// Stop, mikrofon i spinacz go nie mają. Wyłączony i pusty (obrys, ``filled``) leży — bez cienia.
final class SendButton: TouchTargetButton {
  /// The visible side; the touch target grows to 44 pt.
  static let side: CGFloat = 40

  /// Tryb rysowany na ekranie. Tap idzie za TYM trybem, nie za regułą przeliczoną w chwili tapnięcia: co
  /// widać, to się dzieje (okno po wysyłce mogło już minąć, zanim ekran przeliczył przycisk).
  private(set) var mode: ComposerPrimaryAction = .send
  /// Tryb z chwili dotknięcia. Gest zaczęty na „Wyślij" nie kończy się Stopem, choć przycisk przestawił się
  /// w trakcie (koniec okna po wysyłce, tura ruszyła).
  private var pressedMode: ComposerPrimaryAction?

  /// Tryb, który wykonuje bieżąca aktywacja: z chwili dotknięcia, a bez dotyku (klawiatura, VoiceOver) — rysowany.
  var actionMode: ComposerPrimaryAction { pressedMode ?? mode }

  /// Jest co wysłać: tekst po przycięciu białych znaków, załącznik albo trwające dyktowanie (ustawia
  /// `ComposerView`). Bez tego „Wyślij” rysuje obrys jak kółka obok, bez wypełnienia i cienia, i dalej przyjmuje
  /// tap (pusta wysyłka daje fokus polu). Stop rysuje się bez zmian.
  var filled = false {
    didSet {
      guard filled != oldValue else { return }
      apply(mode)
    }
  }

  /// Wskaźnik nad przyciskiem: wypełnienie z domieszką tekstu (`Palette.filledHover`),
  /// zamiast systemowego efektu.
  private(set) var hover: RarogHoverTracker?
  /// Podpowiedź po najechaniu kursorem: „Wyślij (↩)” albo „Stop (Esc)”, za rysowanym trybem.
  private(set) var tip: ShortcutTipTracker?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isPointerInteractionEnabled = false
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOffset = CGSize(width: 0, height: 3)
    layer.shadowRadius = 4
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: SendButton, _: UITraitCollection) in
      self.updateShadow()
    }
    apply(.send)
    hover = RarogHoverTracker(view: self) { [weak self] _ in
      guard let self else { return }
      self.apply(self.mode)
    }
    tip = ShortcutTipTracker(view: self, line: Self.tipLine(mode))
  }

  private static func tipLine(_ mode: ComposerPrimaryAction) -> ShortcutTipLine {
    switch mode {
    case .send: ShortcutTipLine(UICopy.send, .send)
    case .stop: ShortcutTipLine(UICopy.stop, .stop)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override var isEnabled: Bool {
    didSet { apply(mode) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.shadowPath = UIBezierPath(ovalIn: bounds).cgPath
  }

  override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
    pressedMode = mode
    return super.beginTracking(touch, with: event)
  }

  override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
    super.endTracking(touch, with: event)
    // Akcja gestu idzie w tym samym obiegu zdarzenia; zapamiętany tryb gaśnie dopiero po nim.
    Task { @MainActor [weak self] in self?.pressedMode = nil }
  }

  override func cancelTracking(with event: UIEvent?) {
    super.cancelTracking(with: event)
    pressedMode = nil
  }

  /// Przestawia tryb; przejście krycia 150 ms (bez ruchu, przy ograniczeniu ruchu od razu).
  func setMode(_ next: ComposerPrimaryAction) {
    guard next != mode else { return }
    let kindChanged = (next == .send) != (mode == .send)
    mode = next
    guard kindChanged, window != nil, !UIAccessibility.isReduceMotionEnabled else {
      apply(next)
      return
    }
    UIView.transition(with: self, duration: 0.15, options: [.transitionCrossDissolve, .allowUserInteraction]) {
      self.apply(next)
    }
  }

  private func apply(_ mode: ComposerPrimaryAction) {
    let lit = isEnabled && (hover?.hovering ?? false)
    var config: UIButton.Configuration
    // Stały rozmiar symbolu: przycisk ma 40 pt (`.composer__send` w PWA) i nie rośnie z pismem.
    switch mode {
    case .send where filled:
      config = .filled()
      config.image = UIImage(systemName: "arrow.up")
      config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .bold)
      config.baseForegroundColor = Palette.onState
      // Akcent to bursztyn stanu „czeka” (`Palette.accent`).
      config.baseBackgroundColor = lit ? Palette.filledHover(PaletteTokens.wait) : Palette.accent
      config.background.strokeWidth = 0
    case .send:
      // Obrys jak `RingButton`: cicha ikona na kresce `border`, pod wskaźnikiem ikona w `text` i kreska `hoverStroke`.
      config = .plain()
      config.image = UIImage(systemName: "arrow.up")
      config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .bold)
      config.baseForegroundColor = lit ? Palette.text : Palette.muted
      config.background.strokeColor = lit ? Palette.hoverStroke : Palette.border
      config.background.strokeWidth = 1
      // `.clear`, nie `nil`: tło bez koloru bierze kolor odcienia widoku (jak w `RingButton`).
      config.background.backgroundColor = .clear
    case .stop:
      config = .filled()
      config.image = UIImage(systemName: "stop.fill")
      config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 13, weight: .bold)
      config.baseForegroundColor = Palette.onState
      config.baseBackgroundColor = lit ? Palette.filledHover(PaletteTokens.err) : Palette.err
      config.background.strokeWidth = 0
    }
    config.cornerStyle = .capsule
    switch mode {
    case .send:
      accessibilityLabel = UICopy.send
      accessibilityHint = nil
    case .stop:
      accessibilityLabel = UICopy.stop
      accessibilityHint = UICopy.stopHint
    }
    configuration = config
    tip?.update(Self.tipLine(mode))
    updateShadow()
  }

  private func updateShadow() {
    let lifted = isEnabled && mode == .send && filled
    layer.shadowOpacity = lifted ? (traitCollection.userInterfaceStyle == .light ? 0.12 : 0.35) : 0
  }
}

/// Kółko z kreską w rzędzie pod polem wiadomości: spinacz, zwinięcie klawiatury, agent głosowy; the microphone is
/// the same button on a plate (``plated``). Kształt i ikonę daje
/// właściciel (`configuration`), kolory kreski i ikony ustawia wyłącznie ``restyle()``. Pod wskaźnikiem (ta sama
/// reakcja co pigułki modelu i trybu): bez tonu ikona w `text`, kreska
/// `hoverStroke`; w kolorze stanu (mikrofon w nagraniu) kreska i ikona zostają, a tło dostaje ten kolor w kryciu
/// `HoverTokens.outlineTint`, jak przycisk z kolorowym obrysem na karcie. Systemowy efekt wskaźnika jest zdjęty.
final class RingButton: TouchTargetButton {
  /// Kolor stanu kreski i ikony; `nil` — cicha ikona `muted` na kresce `border`.
  var tone: UIColor? {
    didSet { restyle() }
  }

  /// A circle filled with this color and an icon in the background color (the voice agent button during a
  /// conversation); `nil` = the ring.
  var fill: UIColor? {
    didSet { restyle() }
  }

  /// A plate instead of the ring (the dictation microphone): `micPlate` with the icon in `text`, under the pointer
  /// lightened like a filled button; with a `tone` the plate is `micPlateLive` and the outline and icon take the tone.
  var plated = false {
    didSet { restyle() }
  }

  private(set) var hover: RarogHoverTracker?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isPointerInteractionEnabled = false
    hover = RarogHoverTracker(view: self) { [weak self] _ in self?.restyle() }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override var isEnabled: Bool {
    didSet { restyle() }
  }

  /// Kolory kreski, ikony i tła ze stanu i wskaźnika. Właściciel woła po każdej nowej `configuration`.
  func restyle() {
    guard var config = configuration else { return }
    if let fill {
      config.baseForegroundColor = Palette.background
      config.background.strokeColor = fill
      config.background.strokeWidth = 1
      config.background.backgroundColor = fill
      configuration = config
      return
    }
    let lit = isEnabled && (hover?.hovering ?? false)
    if plated {
      if let tone {
        config.baseForegroundColor = tone
        config.background.strokeColor = tone
        config.background.strokeWidth = 1
        config.background.backgroundColor = lit ? Palette.filledHover(PaletteTokens.micPlateLive) : Palette.micPlateLive
      } else {
        config.baseForegroundColor = isEnabled ? Palette.text : Palette.muted2
        config.background.strokeWidth = 0
        config.background.backgroundColor = lit ? Palette.filledHover(PaletteTokens.micPlate) : Palette.micPlate
      }
      configuration = config
      return
    }
    config.baseForegroundColor = tone ?? (lit ? Palette.text : Palette.muted)
    config.background.strokeColor = tone ?? (lit ? Palette.hoverStroke : Palette.border)
    config.background.strokeWidth = 1
    // `.clear`, nie `nil`: tło bez koloru bierze kolor odcienia widoku (w apce jasny) i kółko było białe (zrzut).
    let tint = lit ? tone?.withAlphaComponent(HoverTokens.outlineTint) : nil
    config.background.backgroundColor = tint ?? .clear
    configuration = config
  }
}

/// Przycisk 36 pt z celem dotyku 44 pt: kompakt odstępami, nie mniejszym celem.
class TouchTargetButton: UIButton {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let dx = max(0, (44 - bounds.width) / 2)
    let dy = max(0, (44 - bounds.height) / 2)
    return bounds.insetBy(dx: -dx, dy: -dy).contains(point)
  }
}
#endif
