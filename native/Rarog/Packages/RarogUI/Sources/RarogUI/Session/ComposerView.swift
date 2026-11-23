#if os(iOS)
import RarogContract
import RarogCore
import UIKit

/// Pole wiadomości z paskiem załączników nad tekstem, rzędem kontrolek pod tekstem
/// (`ComposerActionBar`: spinacz, pigułki modelu i trybu, „Wyślij"/Stop). The card is floating glass
/// over the transcript: its first line is the activity row (`activitySlot`, a band open from the start
/// of a turn to its end, `ActivityBand`), its last line the message line, never an alert; red only for an error. Właściciel: wysyłka.
///
/// The field is split into topic files: `ComposerTextView.swift` (the text view and its keys),
/// `ComposerView+Suggestions.swift` (slash command suggestions), `ComposerView+Attachments.swift` (the strip and its
/// sources). State those extensions read or write is `internal`, like the session screen's shared state.
final class ComposerView: UIView, UITextViewDelegate {
  let textView = ComposerTextView(usingTextLayoutManager: true)
  private let container = UIView()
  /// The card's material: glass with the measured layer, the `border` edge (`GlassSurfaceView`).
  private let surface = GlassSurfaceView(radius: ComposerView.cardRadius, castsShadow: true)
  /// The card's first line: the session screen puts the activity row here while the field shows (`installActivity`).
  /// The band stands through a whole turn, so the card keeps its height when the line goes out and comes back in it;
  /// idle, it is closed (``activityBandOpen``).
  let activitySlot = UIView()
  /// Closes the activity band: zero height, the row clipped. Its bottom pin gives way (`installActivity`).
  private var activityBandClosed: NSLayoutConstraint!
  private let placeholder = UILabel()
  let actionBar = ComposerActionBar()
  /// Wiersz między tekstem a rzędem kontrolek — stan dyktowania. Schowany = zero wysokości.
  private let barAccessory = UIStackView()
  private let hintLabel = UILabel()
  private let dashedBorder = CAShapeLayer()
  /// Styl pisma pola i podpowiedzi: `callout` (16 pt w rozmiarze domyślnym), o 1 pt więcej niż `subheadline`
  /// z PWA (`.composer__input` 14 px); z Dynamic Type. Wysokość linii, minimum
  /// pola i podpowiedź idą za tą stałą.
  static let textStyle = UIFont.TextStyle.callout
  /// Odstęp pola tekstu od lewej krawędzi karty: tekst zaczyna się 14 pt od niej (odstęp + wstawka 4 pt +
  /// margines fragmentu linii 5 pt). Prawa strona zostaje przy 10 pt.
  static let textLeading: CGFloat = 5
  /// Corner radius of the floating field card: an exception to the single block radius for elements floating near
  /// the screen corners, like the list footer card's 20 pt.
  static let cardRadius: CGFloat = 26
  /// The empty band under the card: over a raised keyboard, and part of the rest with the keyboard down (the session
  /// screen lets the foot down so the card's bottom stands `ListFooterMetrics.bottomGap` from the screen's edge). The
  /// state card and the dock have the same band under them, so their bottom stands where the card's does.
  static let bottomInset: CGFloat = 10
  /// The message line inside the card, under the control row.
  private var hintShown: [NSLayoutConstraint] = []
  private var hintHidden: NSLayoutConstraint!
  let strip = AttachmentStripView()
  private var textHeight: NSLayoutConstraint!
  var textTopToActivity: NSLayoutConstraint!
  var textTopToStrip: NSLayoutConstraint!

  /// Wysyłka: Enter z klawiatury sprzętowej i przycisk w trybie „Wyślij" (gdy ekran nie podał `onPrimaryAction`).
  var onSend: (() -> Void)?
  /// Przycisk akcji pola, z trybem, który był NA EKRANIE w chwili dotknięcia.
  /// Osobno od Entera: Enter przy pustym polu nigdy nie przerywa, bo zawsze idzie do `onSend`.
  var onPrimaryAction: ((ComposerPrimaryAction) -> Void)?
  /// Zmiana tego, co rozstrzyga tryb przycisku: tekst (pisanie i zapis z kodu), pasek załączników.
  var onContentChange: (() -> Void)?
  var onEdit: (() -> Void)?
  /// Zmiana tekstu z kodu (setter ``text``) — `textViewDidChange` jej nie zgłasza, a dyktowanie
  /// musi wiedzieć, że pole nie jest już jego (`ComposerDictation`).
  var onReplace: (() -> Void)?
  /// Change of the selection or the cursor, also at the end of composing a character (IME): the voice conversation
  /// writes its prompt only after it (`SessionViewController+VoiceAgent.swift`).
  var onSelectionChange: (() -> Void)?
  /// The edit being made, as the text view reports it before applying it (`shouldChangeTextIn`, also for the edits
  /// of the field's own code, `ComposerTextView.insertFromCode`): the range in the text before the edit and the new
  /// text there; for text from code (setter ``text``) the whole field. Read in `onEdit` and `onReplace`. The voice
  /// conversation follows its prompt with it (`VoiceAgentDraft.Change`).
  private(set) var lastEdit: (range: NSRange, replacement: String)?
  /// Zdanie o załącznikach pod polem (odrzucenia, „Chwila…") — ekran sesji wpina je w swoją linię
  /// komunikatu (`nil` gasi; tak też zgłasza się początek wczytywania). `isError` = czerwień.
  var onAttachmentStatus: ((String?, Bool) -> Void)?
  /// Spinacz, przeglądarki i przeciąganie.
  let sources = AttachmentSources()

  /// Załączniki w pasku, zdjęcia przed plikami — odczyt półki sesji z ostatniej zmiany.
  var attachments: [ComposerAttachment] = []
  /// Półka sesji (``bind(to:sessionId:)``): JEDYNY stan paska i właściciel wczytywanej paczki —
  /// niewysłane załączniki i wynik wczytania przeżywają nawigację.
  var shelf: AttachmentShelf?
  var sessionId = ""

  /// Paczka w trakcie wczytywania — druga dostaje „Chwila…", „Wyślij" czeka. Stan półki, więc trwa
  /// także po zamknięciu i ponownym otwarciu ekranu sesji.
  var isLoadingAttachments: Bool {
    shelf?.isLoading(sessionId) ?? false
  }

  var text: String {
    get { textView.text ?? "" }
    set {
      let old = (textView.text ?? "") as NSString
      replacing = true
      textView.replace(all: newValue)
      replacing = false
      // Text from code replaces the whole field, and `onReplace` hears it with that range.
      lastEdit = (NSRange(location: 0, length: old.length), newValue)
      textChanged()
      onReplace?()
      lastEdit = nil
    }
  }

  /// Zapis z kodu (setter ``text``) w toku: edycja przez silnik pola zgłasza `textViewDidChange`, ale to nie
  /// jest pisanie człowieka (`onEdit`), tylko zmiana z kodu (`onReplace`).
  private var replacing = false

  /// Cechy klawiatury, które pole ma teraz (``ComposerTextTraits``): komenda „/” bez autokorekty i inteligentnej
  /// interpunkcji, każdy inny tekst jak zawsze.
  private var textTraits = ComposerTextTraits.message
  /// Zmiana cech czeka na koniec składania znaku (IME): przeładowanie klawiatury w jego trakcie psułoby wpis.
  private var textTraitsDeferred = false
  /// A step of the text size came while IME text was being composed: the field's font waits for the end of composing.
  private var fontDeferred = false

  /// Lista podpowiedzi slash-komend nad kartą: widok w hierarchii pola, model w ``suggestions``.
  let suggestionsView = CommandSuggestionsView()
  var suggestions = CommandSuggestions()
  /// Komendy sesji z magazynu (`SessionViewController+CommandSuggestions`); pusto = nic do podpowiedzenia.
  var commandChoices: [CommandChoice] = []
  /// Pole dostało token komendy z fokusem (pierwszy „/” albo powrót fokusu do pola z „/”): ekran prosi magazyn
  /// o listę sesji, a magazyn rozstrzyga, czy to pora na odczyt.
  var onCommandToken: (() -> Void)?
  /// Lista stanęła albo zniknęła — ekran przestawia nad nią pasek „Przewiń na dół” i dymek.
  var onSuggestionsShown: ((Bool) -> Void)?

  /// Klawisz listy przyszedł, odkąd lista stoi — zaznaczenie widać także wtedy, gdy system nie zgłosił klawiatury
  /// sprzętowej (`GCKeyboard` bywa pusty w symulatorze i chwilę po podłączeniu).
  var suggestionKeysUsed = false

  /// Lista podpowiedzi stoi nad polem.
  var commandSuggestionsOpen: Bool { suggestions.isOpen }

  /// Trwa dyktowanie (ustawia ekran sesji z `ComposerDictation`, `+Interrupt`). Dla wypełnienia „Wyślij” to treść,
  /// jak dla wyboru trybu: przycisk zostaje wypełniony, choć tekst jeszcze nie doszedł.
  var isDictating = false {
    didSet { applyPrimaryFill() }
  }

  var isEditable: Bool = true {
    didSet { applyEditable() }
  }

  /// Wysyłka przechodzi (``ComposerModel/sendable``). W starcie agenta pole przyjmuje tekst, a „Wyślij” stoi
  /// wygaszony; Return nie łamie linii i nic nie wysyła (strażnik tu i w `SessionViewController.send`).
  var canSend: Bool = true {
    didSet { applyPrimaryEnabled() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  private func build() {
    // The transcript runs under the foot: around the card it shows through, in the card the glass blurs it.
    backgroundColor = .clear
    container.backgroundColor = .clear
    container.layer.roundCorners(Self.cardRadius)
    container.accessibilityIdentifier = "composer.card"
    dashedBorder.fillColor = nil
    dashedBorder.lineDashPattern = [5, 4]
    dashedBorder.lineWidth = 1
    container.layer.addSublayer(dashedBorder)

    textView.font = Fonts.text(Self.textStyle)
    textView.adjustsFontForContentSizeCategory = true
    textView.textColor = Palette.text
    textView.backgroundColor = .clear
    textView.delegate = self
    textView.textContainerInset = UIEdgeInsets(top: 11, left: 4, bottom: 11, right: 4)
    // Autokorekta, wielka litera, pisownia i inteligentna interpunkcja idą za tekstem (`applyTextTraits`).
    textTraits.apply(to: textView)
    textView.accessibilityLabel = UICopy.composerPlaceholder
    textView.accessibilityIdentifier = "composer.field"
    // Pasek skrótów iPadOS bez grup (cofnij, ponów, wklej): z nimi przy klawiaturze sprzętowej pasek zwija się do
    // pigułki „PL EN + mikrofon” pod polem, zwłaszcza po opróżnieniu pola.
    // Cofanie i wklejanie zostają pod Cmd+Z, Cmd+V i w menu edycji; podpowiedzi pisowni zostają.
    textView.inputAssistantItem.leadingBarButtonGroups = []
    textView.inputAssistantItem.trailingBarButtonGroups = []
    // W starcie agenta Return nic nie robi już tu: opakowanie dyktowania przed wysyłką kończy nagranie.
    textView.onHardwareReturn = { [weak self] in
      guard let self, self.canSend else { return }
      self.onSend?()
    }
    textView.onWidthChange = { [weak self] in self?.updateHeight() }
    textView.suggestionTakes = { [weak self] key in
      guard let self else { return false }
      return self.suggestions.takes(key, composing: self.textView.markedTextRange != nil)
    }
    textView.onSuggestionKey = { [weak self] key in self?.suggestionKey(key) }
    suggestionsView.onPick = { [weak self] index in self?.pickSuggestion(index) }

    placeholder.text = UICopy.composerPlaceholder
    placeholder.font = Fonts.text(Self.textStyle)
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.textColor = Palette.muted2
    placeholder.isAccessibilityElement = false
    // Przy dużym piśmie podpowiedź łamie się na kolejne linie, a puste pole rośnie razem z nią
    // (`updateHeight`). Zmniejszanie pisma do szerokości audyt dostępności zgłasza jako tekst ucięty.
    placeholder.numberOfLines = 0

    actionBar.sendButton.addAction(UIAction { [weak self] _ in self?.primaryTapped() }, for: .primaryActionTriggered)
    actionBar.attachButton.menu = attachMenu()
    actionBar.hideKeyboardButton.addAction(
      UIAction { [weak self] _ in self?.textView.resignFirstResponder() }, for: .primaryActionTriggered)
    strip.onRemove = { [weak self] id in self?.removeAttachment(id) }
    strip.isHidden = true
    textView.onPasteAttachments = { [weak self] providers in self?.pasteAttachments(providers) ?? false }
    sources.deliver = { [weak self] candidates in self?.ingest(candidates) }
    sources.accepting = { [weak self] in self?.isEditable ?? false }

    hintLabel.font = Fonts.text(.footnote)
    hintLabel.adjustsFontForContentSizeCategory = true
    hintLabel.numberOfLines = 0
    hintLabel.textColor = Palette.muted
    hintLabel.accessibilityIdentifier = "composer.hint"
    // Empty until the first sentence (`setHint`): the control row closes the card.
    hintLabel.isHidden = true

    barAccessory.axis = .vertical
    for view in [
      container, surface, activitySlot, textView, placeholder, actionBar, hintLabel, strip, barAccessory, suggestionsView,
    ] as [UIView] {
      view.translatesAutoresizingMaskIntoConstraints = false
    }
    addSubview(container)
    container.addSubview(surface)
    // The dashed edge of a disabled field stays over the card's material (a later subview's layer would cover it).
    container.layer.insertSublayer(dashedBorder, above: surface.layer)
    container.addSubview(activitySlot)
    // Lista nad kartą, poza granicą pola (``point(inside:with:)``): unosi się nad transkryptem, układ stoi.
    addSubview(suggestionsView)
    container.addSubview(strip)
    container.addSubview(textView)
    container.addSubview(placeholder)
    container.addSubview(barAccessory)
    container.addSubview(actionBar)
    container.addSubview(hintLabel)

    textHeight = textView.heightAnchor.constraint(equalToConstant: 44)
    // Pusty albo schowany wiersz dyktowania ma zero wysokości; treść ją rozpycha.
    let accessoryCollapsed = barAccessory.heightAnchor.constraint(equalToConstant: 0)
    accessoryCollapsed.priority = .defaultLow - 1
    // Without the activity row (it stands in the narrow card while the field hides) the slot has no height of its own.
    let activityCollapsed = activitySlot.heightAnchor.constraint(equalToConstant: 0)
    activityCollapsed.priority = .defaultLow - 1
    // Idle until the screen's first render says otherwise (`SessionViewController.placeActivityBand`).
    activitySlot.clipsToBounds = true
    activityBandClosed = activitySlot.heightAnchor.constraint(equalToConstant: 0)
    textTopToActivity = textView.topAnchor.constraint(equalTo: activitySlot.bottomAnchor)
    textTopToStrip = textView.topAnchor.constraint(equalTo: strip.bottomAnchor)
    hintHidden = actionBar.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -4)
    hintShown = [
      hintLabel.topAnchor.constraint(equalTo: actionBar.bottomAnchor, constant: 2),
      hintLabel.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
    ]
    NSLayoutConstraint.activate([
      container.topAnchor.constraint(equalTo: topAnchor),
      container.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
      container.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
      container.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.bottomInset),
      surface.topAnchor.constraint(equalTo: container.topAnchor),
      surface.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      surface.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      surface.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      activitySlot.topAnchor.constraint(equalTo: container.topAnchor, constant: 4),
      activitySlot.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      activitySlot.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      activityCollapsed,
      activityBandClosed,
      strip.topAnchor.constraint(equalTo: activitySlot.bottomAnchor, constant: 6),
      strip.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
      strip.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
      strip.heightAnchor.constraint(equalToConstant: AttachmentStripView.height),
      textTopToActivity,
      // Rząd kontrolek POD tekstem, na całą szerokość karty (`docs/design.md`, „Composer"); między
      // nimi wiersz stanu dyktowania — jego pojawienie się przesuwa tekst, nie przyciski.
      textView.bottomAnchor.constraint(equalTo: barAccessory.topAnchor),
      barAccessory.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
      barAccessory.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
      barAccessory.bottomAnchor.constraint(equalTo: actionBar.topAnchor),
      accessoryCollapsed,
      textView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: Self.textLeading),
      textView.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
      textHeight,
      // Podpowiedź stoi tam, gdzie zacznie się wpisany tekst (`textInsets`), więc kursor pustego pola
      // miga PRZED pierwszą literą. Stała 4 pt (sama wstawka, bez marginesu fragmentu linii) stawiałaby
      // kursor na „N".
      placeholder.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: textInsets.left),
      // Szerokość podpowiedzi = szerokość tekstu, nie „najwyżej tyle”. Przy „najwyżej” wieloliniowa etykieta
      // bierze szerokość z własnego łamania: po chwilowym zwężeniu pola zostaje złamana na starej szerokości
      // i druga linia wystaje pod pole (`ComposerLayoutTests`).
      placeholder.trailingAnchor.constraint(equalTo: textView.trailingAnchor, constant: -textInsets.right),
      placeholder.topAnchor.constraint(equalTo: textView.topAnchor, constant: textInsets.top),
      actionBar.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 6),
      actionBar.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -6),
      hintHidden,
      // The message line starts where the field's text starts (14 pt from the card's edge).
      hintLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
      hintLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
      suggestionsView.bottomAnchor.constraint(equalTo: container.topAnchor, constant: -CommandSuggestionsView.gap),
      suggestionsView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      suggestionsView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
    ])
    registerForTraitChanges([
      UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self, UITraitPreferredContentSizeCategory.self,
    ]) { (self: ComposerView, _: UITraitCollection) in
      // Kolor warstwy z cech widoku, nie z `UITraitCollection.current` (zmiana motywu w tle); kreskowany obrys
      // idzie też za „Zwiększ kontrast”. The card's edge follows the same traits in `GlassSurfaceView`.
      self.applyEditable()
      self.updateHeight()
    }
    applyEditable()
    Fonts.follow(self) { [weak self] in self?.applyFonts() }
  }

  /// A step of the text size on the flat path, where no trait change comes: the field, its placeholder and the
  /// message line take the new size, and the field's height follows.
  private func applyFonts() {
    placeholder.font = Fonts.text(Self.textStyle)
    hintLabel.font = Fonts.text(.footnote)
    applyFieldFont()
    updateHeight()
  }

  /// The field's font at the text size. The selection and the typing attributes stay; while IME text is being
  /// composed the change waits for the end of composing, as the keyboard traits do (``applyTextTraits()``).
  private func applyFieldFont() {
    guard textView.markedTextRange == nil else {
      fontDeferred = true
      return
    }
    fontDeferred = false
    let font = Fonts.text(Self.textStyle)
    guard textView.font != font else { return }
    let selection = textView.selectedRange
    var typing = textView.typingAttributes
    typing[.font] = font
    textView.font = font
    // The selection first: setting it resets the typing attributes.
    textView.selectedRange = selection
    textView.typingAttributes = typing
    updateHeight()
  }

  /// Lista podpowiedzi stoi nad granicą pola: dotyk w niej należy do pola (stopa ekranu pyta o to samo,
  /// `SessionFootStack`).
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    if super.point(inside: point, with: event) { return true }
    return !suggestionsView.isHidden && suggestionsView.frame.contains(point)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    dashedBorder.frame = container.bounds
    dashedBorder.path = UIBezierPath(
      roundedRect: container.bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: Self.cardRadius - 0.5).cgPath
    updateHeight()
  }

  /// Pigułki sesji w rzędzie kontrolek, za spinaczem (`SessionViewController+Controls`).
  func installControls(_ view: UIView) {
    actionBar.installControls(view)
  }

  /// Przycisk „Wyślij” jako kotwica okna, które otwiera komenda apki (arkusz „Limity”).
  var sendButtonView: UIView { actionBar.sendButton }

  /// Tryb przycisku akcji pola (`SessionViewController+Interrupt`): „Wyślij" albo Stop. Zmiana trybu
  /// przy fokusie VoiceOvera na przycisku zgłasza czytnikowi nową etykietę.
  var primaryAction: ComposerPrimaryAction {
    get { actionBar.sendButton.mode }
    set {
      let button = actionBar.sendButton
      guard newValue != button.mode else { return }
      button.setMode(newValue)
      applyPrimaryEnabled()
      if UIAccessibility.isVoiceOverRunning, button.accessibilityElementIsFocused() {
        UIAccessibility.post(notification: .layoutChanged, argument: button)
      }
    }
  }

  /// Pasek ma załącznik albo właśnie go wczytuje — dla trybu przycisku to wpis.
  var hasAttachmentEntry: Bool { !attachments.isEmpty || isLoadingAttachments }

  private func primaryTapped() {
    let mode = actionBar.sendButton.actionMode
    if let onPrimaryAction {
      onPrimaryAction(mode)
    } else if mode == .send {
      onSend?()
    }
  }

  /// Treść pola albo paska się zmieniła: wypełnienie „Wyślij” od razu, potem ekran sesji (tryb przycisku, szkic).
  func contentChanged() {
    applyPrimaryFill()
    onContentChange?()
  }

  /// „Wyślij” wypełniony tylko z treścią: tekst po przycięciu jak przy wysyłce
  /// (`RarogStore.send`), załącznik w pasku albo wczytywany, trwające dyktowanie. Liczone przy każdej zmianie,
  /// niezależnie od trybu: setter ``primaryAction`` pomija ten sam tryb, a pole „   ” w trakcie tury daje „Wyślij”
  /// (surowy tekst w wyborze trybu, `+Interrupt`), który ma być w obrysie.
  private func applyPrimaryFill() {
    let typed = !(textView.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    actionBar.sendButton.filled = typed || hasAttachmentEntry || isDictating
  }

  /// „Wyślij" działa z polem, które przyjmuje tekst, gdy wysyłka przechodzi; Stop — gdy przerwanie by doszło.
  private func applyPrimaryEnabled() {
    switch actionBar.sendButton.mode {
    case .send: actionBar.sendButton.isEnabled = isEditable && canSend
    case let .stop(enabled): actionBar.sendButton.isEnabled = enabled
    }
  }

  /// Dyktowanie (`ComposerDictation`): mikrofon przed „Wyślij", wiersz stanu nad rzędem.
  func installVoice(mic: UIView, status: UIView) {
    actionBar.installVoice(mic)
    barAccessory.addArrangedSubview(status)
  }

  /// Rozmowa z agentem głosowym w rzędzie kontrolek; stan ustawia `SessionViewController+VoiceAgent`.
  var voiceAgentButton: RingButton { actionBar.voiceAgentButton }

  /// The card's last line (send errors, interrupt refusals); `nil` gasi linię and the card closes under the controls.
  func setHint(_ text: String?, isError: Bool = false) {
    hintLabel.text = text
    hintLabel.textColor = isError ? Palette.err : Palette.muted
    let shown = text != nil
    if hintLabel.isHidden == shown {
      hintLabel.isHidden = !shown
      hintHidden.isActive = !shown
      if shown { NSLayoutConstraint.activate(hintShown) } else { NSLayoutConstraint.deactivate(hintShown) }
    }
    if let text, isError { Announcer.shared.say(text, priority: .urgent) }
  }

  /// The activity row as the card's first line (`SessionViewController+FootActivity`).
  func installActivity(_ row: UIView) {
    row.removeFromSuperview()
    row.translatesAutoresizingMaskIntoConstraints = false
    activitySlot.addSubview(row)
    // The row's height opens the band; a closed band (required zero height) wins over it and clips the row.
    let bottom = row.bottomAnchor.constraint(equalTo: activitySlot.bottomAnchor)
    bottom.priority = .required - 1
    NSLayoutConstraint.activate([
      row.topAnchor.constraint(equalTo: activitySlot.topAnchor),
      bottom,
      row.leadingAnchor.constraint(equalTo: activitySlot.leadingAnchor),
      row.trailingAnchor.constraint(equalTo: activitySlot.trailingAnchor),
    ])
  }

  /// The activity band is open: the row's line stands at the top of the card. Closed, the card is only as tall as the
  /// field; it grows upwards when the band opens (the foot is anchored at the bottom). The caller animates.
  var activityBandOpen: Bool {
    get { !activityBandClosed.isActive }
    set { activityBandClosed.isActive = !newValue }
  }

  private func applyEditable() {
    // „Wyłączone” dla czytnika dokłada getter `ComposerTextView.accessibilityTraits`.
    textView.isEditable = isEditable
    // Szkic da się zaznaczyć także w polu wygaszonym.
    textView.isSelectable = true
    applyPrimaryEnabled()
    // Wygaszone pole: spinacz też; upuszczanie odmawia przez `sources.accepting`.
    actionBar.attachButton.isEnabled = isEditable
    // Kreskowany obrys = „wyłączone" (zarezerwowany dla wygaszonego pola, docs/design.md).
    surface.showsEdge = isEditable
    dashedBorder.strokeColor = isEditable ? UIColor.clear.cgColor : Palette.muted2.resolvedColor(with: traitCollection).cgColor
    // The field's own content dims, not the card: alpha under 1 on a glass view's ancestor breaks the effect, and the
    // activity row and the message line in the card are not part of the disabled field.
    for item in [strip, textView, placeholder, barAccessory, actionBar] as [UIView] { item.alpha = isEditable ? 1 : 0.7 }
    if !isEditable, textView.isFirstResponder { textView.resignFirstResponder() }
    refreshSuggestions()
  }

  private func updateHeight() {
    // Nie `textView.font`: przy pustym polu bywa `nil`, a minimum ma iść za pismem systemu.
    let lineHeight = Fonts.text(Self.textStyle, traits: traitCollection).lineHeight
    let insets = textView.textContainerInset.top + textView.textContainerInset.bottom
    // Minimum = jedna linia aktualnego pisma: pole rośnie z Dynamic Type także, gdy jest puste.
    let minimum = max(44, ceil(lineHeight + insets))
    let width = textView.bounds.width
    guard width > 0 else {
      // Pierwszy przebieg układu: szerokości jeszcze nie ma, ale minimum już obowiązuje.
      if abs(textHeight.constant - minimum) > 0.5 { textHeight.constant = minimum }
      return
    }
    let fitting = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    // Pole rośnie z tekstem do 8 linii, dalej przewija się w środku.
    let ceiling = lineHeight * 8 + insets
    let height = max(minimum, placeholderHeight(width: width), min(fitting, ceiling))
    if abs(textHeight.constant - height) > 0.5 { textHeight.constant = height }
    textView.isScrollEnabled = fitting > ceiling
  }

  /// Puste pole mieści całą podpowiedź: przy największym piśmie łamie się ona na kilka linii.
  private func placeholderHeight(width: CGFloat) -> CGFloat {
    guard !placeholder.isHidden else { return 0 }
    let insets = textInsets
    let text = placeholder.sizeThatFits(CGSize(width: width - insets.left - insets.right, height: .greatestFiniteMagnitude))
    return ceil(text.height + insets.top + insets.bottom)
  }

  /// Gdzie w polu zaczyna się tekst: wstawka kontenera i, w poziomie, margines fragmentu linii TextKit
  /// (`lineFragmentPadding`) — tam stoi kursor pustego pola i pierwsza wpisana litera.
  private var textInsets: UIEdgeInsets {
    let inset = textView.textContainerInset
    let padding = textView.textContainer.lineFragmentPadding
    return UIEdgeInsets(top: inset.top, left: inset.left + padding, bottom: inset.bottom, right: inset.right + padding)
  }

  private func textChanged() {
    placeholder.isHidden = !(textView.text ?? "").isEmpty
    if fontDeferred { applyFieldFont() }
    applyTextTraits()
    updateHeight()
    refreshSuggestions()
    contentChanged()
  }

  /// Cechy klawiatury za tekstem pola — pisanie i każdy zapis z kodu (wysyłka, odmowa, szkic, prompt po Esc,
  /// dyktowanie) przechodzą przez `textChanged`. Wysunięta klawiatura bierze nowe cechy dopiero po
  /// `reloadInputViews()`, więc przeładowanie idzie tylko przy zmianie zestawu (pasek skrótów nie miga przy każdym
  /// znaku) i nigdy w trakcie tekstu zaznaczonego IME — wtedy zmiana czeka na koniec składania.
  private func applyTextTraits() {
    let traits = ComposerTextTraits(text: textView.text ?? "")
    guard traits != textTraits else {
      textTraitsDeferred = false
      return
    }
    guard textView.markedTextRange == nil else {
      textTraitsDeferred = true
      return
    }
    textTraitsDeferred = false
    textTraits = traits
    traits.apply(to: textView)
    if textView.isFirstResponder { textView.reloadInputViews() }
  }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    lastEdit = (range, text)
    return true
  }

  func textViewDidChange(_ textView: UITextView) {
    guard !replacing else { return }
    textChanged()
    onEdit?()
    lastEdit = nil
  }

  /// Odroczone cechy (``applyTextTraits``) dochodzą też przy zmianie zaznaczenia po końcu składania znaku — bez
  /// założenia, że koniec składania zgłasza `textViewDidChange`.
  func textViewDidChangeSelection(_ textView: UITextView) {
    if textTraitsDeferred { applyTextTraits() }
    if fontDeferred { applyFieldFont() }
    onSelectionChange?()
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    updateHideKeyboard()
    refreshSuggestions()
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    updateHideKeyboard()
    // Pole właśnie oddało fokus — bez polegania na tym, kiedy UIKit przestawia `isFirstResponder`.
    refreshSuggestions(focused: false)
  }

  /// Przycisk zwinięcia klawiatury: tylko na iPhonie (iPad ma klawisz zwijania na klawiaturze ekranowej,
  /// a przy sprzętowej nie ma czego zwijać) i tylko, gdy pole ma fokus. Stuknięcie odpala od razu — bez
  /// czekania na podwójne stuknięcie, które opóźnia zwinięcie stuknięciem w tekst transkryptu (~0,3 s).
  static func showsHideKeyboard(idiom: UIUserInterfaceIdiom, editing: Bool) -> Bool {
    idiom == .phone && editing
  }

  /// Rząd bez wymiarów (ekran przed pierwszym układem: przy klawiaturze sprzętowej pole dostaje fokus już
  /// w `viewDidAppear`) dostaje przycisk bez animacji. Blok animacji kończy się układem całego okna, więc pierwszy
  /// układ ekranu sesji szedłby w tej animacji, a transkrypt dochodziłby do dna jej ścieżką zamiast od razu
  /// (`settleAtBottom`; zmierzone na symulatorze iPhone'a).
  private func updateHideKeyboard() {
    let button = actionBar.hideKeyboardButton
    let shown = Self.showsHideKeyboard(idiom: traitCollection.userInterfaceIdiom, editing: textView.isFirstResponder)
    guard button.isHidden == shown else { return }
    guard window != nil, actionBar.bounds.width > 0, !UIAccessibility.isReduceMotionEnabled else {
      button.isHidden = !shown
      return
    }
    UIView.animate(withDuration: 0.2) {
      button.isHidden = !shown
      self.actionBar.layoutIfNeeded()
    }
  }
}
#endif
