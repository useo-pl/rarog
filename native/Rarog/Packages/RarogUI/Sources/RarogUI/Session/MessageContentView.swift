#if os(iOS)
import UIKit

/// Treść wiadomości w komórce transkryptu: tekst w `UITextView` (TextKit 2), a przy wiadomości człowieka dymek
/// szeroki jak treść z godziną obok albo pod nim; długi prompt zwinięty do 6 linii z przyciskiem na dole dymka.
///
/// `UITextView`, a nie SwiftUI `Text`: systemowe zaznaczanie fragmentu, klikalne linki,
/// bloki kodu i cytaty rysowane fragmentami układu TextKit 2, tabela jako widok
/// w załączniku. Ikony kopiowania bloków kodu leżą NAD tekstem, w paskach bloków —
/// jako zwykłe przyciski są osiągalne dla VoiceOver i testów UI, czego widok w środku tekstu
/// by nie dał. Etykiet ról na ekranie nie ma: rolę słyszy czytnik
/// (`accessibilityPrefix`). Stopki „Kopiuj” pod odpowiedzią nie ma („nigdy nie korzystam”).
/// Właściciel: transkrypt, markdown.
struct MessageContentConfiguration: UIContentConfiguration {
  /// Głos przy zmianie roli. Na ekranie nie stoi — daje tylko odstęp 12 pt poza granicą tury.
  var voice: String?
  var text: NSAttributedString
  /// The human message bubble (plum gray): on the left, as wide as its content, at most the bubble's cap
  /// (`plateCap`).
  var plate: Bool
  /// Wpis kolejki „w locie" — przygaszony, w układzie identycznym z przyszłym echem.
  var dimmed: Bool
  /// Wpis jeszcze czeka na podjęcie albo echo: po tle dymka płynie poświata (``PlateShimmer``). „Nie potwierdzono”
  /// i odmowa zostają przygaszone, ale bez niej — inaczej dymek udawałby wysyłkę w toku.
  var inFlight = false
  var accessibilityIdentifier: String
  /// Rola dla czytnika przed treścią („Ty", „Agent", „System", „Ty, w drodze") — zawsze, bez etykiety na ekranie.
  var accessibilityPrefix: String?
  /// Kolory składni zdjęte do atramentu linii (pod stojącą decyzją) — tekst i układ bez zmian.
  var plainSyntax = false
  /// Granica tury nad wierszem (32 pt nad promptem, 10 pt nad odpowiedzią); `.flow` = reguła wiersza.
  var gap: TurnGap = .flow
  /// The spacing tokens of the transcript's density: the turn boundary, the row rule and the bottom margin.
  var spacing: TranscriptSpacing = .standard
  /// Pierwszy wiersz promptu: cecha nagłówka dla VoiceOvera (raz na prompt — skok po promptach).
  var header = false
  /// The time: by the bubble on a prompt's last row, under the last text of a closed agent reply; `nil` = none.
  var clock: String?
  /// Godzina pod dymkiem, bo obok się nie mieści (``MessageContentView/clockFitsBeside(text:clock:rowWidth:traits:spacing:fold:)``,
  /// liczy ekran sesji z szerokości listy).
  var clockBelow = false

  /// The time stands under the text: a prompt's when it does not fit beside the bubble, an agent reply's always.
  var clockUnder: Bool { clockBelow || !plate }
  /// Długi prompt zwinięty do 6 linii albo rozwinięty; `nil` = bez przycisku.
  var fold: PromptFold?
  /// „Pokaż całość” / „Zwiń”: ekran sesji przestawia stan w `TranscriptReading` i trzyma miejsce czytania.
  var toggleFold: (@MainActor () -> Void)?
  /// A queued bubble, or a Not confirmed one while the session keeps a take-back without an answer: a tap on the
  /// bubble and the VoiceOver action take the queue back into the field (`MessageContentView+TakeBack`);
  /// `nil` = neither.
  var takeBack: (@MainActor () -> Void)?
  /// The queue of this queued bubble is being taken back: the bubble dims further until the server answers.
  var takingBack = false

  func makeContentView() -> any UIView & UIContentView {
    MessageContentView(configuration: self)
  }

  func updated(for state: any UIConfigurationState) -> MessageContentConfiguration {
    self
  }
}

final class MessageContentView: UIView, UIContentView {
  /// Wstawki tekstu w dymku.
  static let plateVertical: CGFloat = 10
  static let plateHorizontal: CGFloat = 12
  /// Godzina obok dymku: odstęp od jego prawej krawędzi; pod dymkiem: odstęp od dolnej.
  static let clockGap: CGFloat = 8
  static let clockUnderGap: CGFloat = 4
  /// Najmniejszy cel dotyku przycisku „Pokaż całość” / „Zwiń”.
  static let foldTarget: CGFloat = 44
  /// Odstęp okna tekstu od wiersza przycisku zwinięcia w dymku.
  static let foldGap: CGFloat = 4

  /// Tło dymku: ozdoba pod tekstem, szeroka jak tekst (``usedTextWidth()``) plus wstawki.
  let plateView = UIView()
  /// Pasmo poświaty na tle dymku w locie — zamiast wiersza „w kolejce” pod nim (``PlateShimmer``).
  private let shimmer = PlateShimmer()
  let textView = MessageTextView(usingTextLayoutManager: true)
  /// Okno tekstu. Przy zwiniętym prompcie przycina pole do 6 linii, a pole zostaje pełnej wysokości: pełny układ,
  /// zaznaczenie i kopia całości, tło dymku szerokie jak najszersza linia CAŁEGO tekstu (rozwinięcie nie poszerza
  /// dymku). Tła bloków kodu stoją w oknie, więc przycina je razem z tekstem.
  private let clipView = UIView()
  /// Ostatnia widoczna linia zwiniętego promptu zanika w kolor dymku — przycięcie w pół linii nie wygląda na błąd.
  private let fade = PromptFoldFade()
  let foldButton = PromptFoldButton()
  private let clockLabel = UILabel()
  private let layoutDelegate = MarkdownLayoutDelegate()
  private var textTop: NSLayoutConstraint!
  private var textBottom: NSLayoutConstraint!
  private var textLeading: NSLayoutConstraint!
  private var textTrailingMax: NSLayoutConstraint!
  private var textTrailingFill: NSLayoutConstraint!
  private var textWidthCap: NSLayoutConstraint!
  /// Okno tekstu idzie za wysokością pola (poza zwiniętym promptem to cała wysokość pola).
  private var clipFollow: NSLayoutConstraint!
  /// Sufit okna przy zwiniętym prompcie: 6 linii prozy.
  private var clipCap: NSLayoutConstraint!
  /// Miejsce pod dymkiem na godzinę (gdy pod nim).
  private var clockReserve: CGFloat = 0
  /// How far below the text's bottom the time's gap starts: a reply ending in a code block clears the box's padding.
  private var clockLift: CGFloat = 0
  /// Wiersz przycisku zwinięcia w dymku pod oknem tekstu.
  private var foldRow = FoldRow.none
  private var foldReserve: CGFloat { foldRow.reserve }
  /// Cechy dostępności pola bez cechy nagłówka.
  private var baseTraits: UIAccessibilityTraits = []
  private(set) var current: MessageContentConfiguration
  /// Tekst ostatnio wstawiony do widoku: ten sam obiekt z pamięci renderu nie kasuje zaznaczenia.
  private var shownText: NSAttributedString?
  /// Czy wstawiony tekst ma zdjęte kolory składni (``MessageContentConfiguration/plainSyntax``).
  private var shownPlain = false
  /// Ikony kopiowania nad paskami bloków kodu, w kolejności bloków (ptaszek trwa przy delcie).
  private(set) var codeButtons: [CopyIconButton] = []
  /// The tap that takes the queue back, live only on a queued bubble (`MessageContentView+TakeBack`).
  let takeBackTap = UITapGestureRecognizer()
  /// Tła bloków kodu POD tekstem, w kolejności bloków (podświetlenie zaznaczenia leży pod widokami
  /// fragmentów, więc tło narysowane we fragmencie by je zasłoniło).
  private var codeBoxes: [CodeBlockBox] = []
  private var hasCodeBars = false
  /// Tekst ma blok kodu, tabelę albo linię poziomą — dymek bierze pełną dozwoloną szerokość (ich tła i kreski idą
  /// przez cały kontener, a `usageBounds` widzi tylko glify).
  private var fullWidthPlate = false
  /// Cechy, od których zależą kolory ozdób (`MarkdownColors`): motyw i „Zwiększ kontrast”.
  private struct ColorsLook: Equatable {
    let style: UIUserInterfaceStyle
    let contrast: UIAccessibilityContrast

    init(_ traits: UITraitCollection) {
      style = traits.userInterfaceStyle
      contrast = traits.accessibilityContrast
    }
  }

  /// Motyw i kontrast, w których fragmenty układu tekstu mają kolory ozdób; zmiana w tle czeka na powrót na wierzch.
  private var colorsLook: ColorsLook?
  private var colorsPending = false

  var configuration: any UIContentConfiguration {
    get { current }
    set {
      guard let config = newValue as? MessageContentConfiguration else { return }
      apply(config)
    }
  }

  init(configuration: MessageContentConfiguration) {
    current = configuration
    super.init(frame: .zero)
    build()
    apply(configuration)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  private func build() {
    textView.isEditable = false
    textView.isScrollEnabled = false
    textView.isSelectable = true
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.adjustsFontForContentSizeCategory = false
    // Wygląd linku niesie tekst (podkreślenie w kolorze treści), nie odcień widoku.
    textView.linkTextAttributes = [:]
    textView.setContentCompressionResistancePriority(.required, for: .vertical)
    textView.textLayoutManager?.delegate = layoutDelegate
    // Menu edycji zaznaczenia dostaje „Zaznacz więcej…” (``textView(_:editMenuForTextIn:suggestedActions:)``).
    textView.delegate = self
    baseTraits = textView.accessibilityTraits

    plateView.layer.roundCorners(Radius.block)
    plateView.isUserInteractionEnabled = false
    plateView.isAccessibilityElement = false
    // Pasmo poświaty przycięte do zaokrąglonego tła; innych warstw dymek nie ma (tła kodu to widoki nad nim).
    plateView.layer.masksToBounds = true
    plateView.layer.addSublayer(shimmer.layer)

    clockLabel.textColor = Palette.muted2
    clockLabel.isAccessibilityElement = true

    textView.translatesAutoresizingMaskIntoConstraints = false
    clipView.translatesAutoresizingMaskIntoConstraints = false
    textView.accessibilityClip = clipView
    // Kolejność warstw: tło dymku, okno tekstu (tła bloków kodu wstawiane pod tekst, tekst, zanik), godzina, przycisk
    // zwinięcia, ikony kopiowania.
    addSubview(plateView)
    clipView.addSubview(textView)
    clipView.addSubview(fade)
    addSubview(clipView)
    addSubview(clockLabel)
    addSubview(foldButton)
    fade.isHidden = true
    foldButton.isHidden = true
    foldButton.addAction(UIAction { [weak self] _ in self?.current.toggleFold?() }, for: .primaryActionTriggered)
    buildTakeBack()

    let margins = layoutMarginsGuide
    textTop = clipView.topAnchor.constraint(equalTo: margins.topAnchor)
    textBottom = clipView.bottomAnchor.constraint(equalTo: margins.bottomAnchor)
    textLeading = clipView.leadingAnchor.constraint(equalTo: margins.leadingAnchor)
    textTrailingMax = clipView.trailingAnchor.constraint(lessThanOrEqualTo: margins.trailingAnchor)
    // The text fills the column unless the bubble's cap (`plateCap`) is narrower.
    textTrailingFill = clipView.trailingAnchor.constraint(equalTo: margins.trailingAnchor)
    textTrailingFill.priority = .required - 1
    textWidthCap = clipView.widthAnchor.constraint(lessThanOrEqualToConstant: Self.noCap)
    clipFollow = clipView.heightAnchor.constraint(equalTo: textView.heightAnchor)
    clipFollow.priority = .required - 1
    clipCap = clipView.heightAnchor.constraint(lessThanOrEqualToConstant: 0)
    NSLayoutConstraint.activate([
      textTop, textBottom, textLeading, textTrailingMax, textTrailingFill, textWidthCap, clipFollow,
      textView.topAnchor.constraint(equalTo: clipView.topAnchor),
      textView.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
      textView.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
    ])
    // Kreski markdownu (cytat, linia pozioma) mają kolory rozwiązane do `CGColor` we fragmentach układu.
    // Konfiguracja wpięta, gdy komórka ma jeszcze stare cechy (zrzuty przełącznika aplikacji w obu
    // motywach przy zejściu w tło), zostawia kolory starego motywu. Zmiana
    // motywu TEJ komórki podaje fragmentom nowe kolory.
    // W tle (zrzuty przełącznika w obu motywach) zmiana tylko się zapisuje: unieważniony
    // układ tekstu zmieniłby wysokości komórek i po powrocie transkrypt dochodziłby do miejsca w kilku klatkach.
    // Na wierzchu kolory idą od nowa wyłącznie wtedy, gdy motyw RÓŻNI się od tego, w którym je ustawiono.
    // Tak samo „Zwiększ kontrast”: kreska `border` ma wtedy mocniejsze krycie.
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
      (self: MessageContentView, _: UITraitCollection) in
      self.styleChanged()
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(foregroundReturned), name: TranscriptAppPhase.foreground, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(reduceMotionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification,
      object: nil)
  }

  /// The width cap of the text FIELD outside a bubble: the field spans the whole column, because a code block, a table
  /// and a rule take its full width; the paragraph style caps prose (``MarkdownRenderer/tailIndent(_:fonts:capEm:)``).
  private static let noCap: CGFloat = 100_000

  private func styleChanged() {
    if TranscriptAppPhase.isBackground() {
      colorsPending = true
      return
    }
    refreshDecorationColors()
  }

  @objc private func foregroundReturned() {
    guard colorsPending else { return }
    colorsPending = false
    refreshDecorationColors()
  }

  /// Kolory ozdób dla bieżących cech: nowe fragmenty biorą je od delegata, a fragmenty już ułożone (TextKit 2
  /// trzyma je z kolorami z chwili układu) dostają je wprost i układ tekstu idzie od nowa, więc się
  /// przerysowują. Zaznaczenie zostaje. Ten sam motyw i kontrast co przy ostatnim ustawieniu = nic do zrobienia.
  private func refreshDecorationColors() {
    let look = ColorsLook(traitCollection)
    guard look != colorsLook else { return }
    colorsLook = look
    updateShimmer()
    let colors = MarkdownColors.resolved(for: traitCollection)
    layoutDelegate.colors = colors
    guard let manager = textView.textLayoutManager else { return }
    manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: []) { fragment in
      (fragment as? MarkdownLayoutFragment)?.colors = colors
      return true
    }
    manager.invalidateLayout(for: manager.documentRange)
    textView.setNeedsLayout()
    setNeedsLayout()
  }

  private func apply(_ config: MessageContentConfiguration) {
    let sameMessage = config.accessibilityIdentifier == current.accessibilityIdentifier
    current = config
    // Granica tury: 32 pt nad promptem, 10 pt nad pierwszym wierszem odpowiedzi.
    // Poza nią odstęp większy przy zmianie głosu, a między wiadomościami jednego głosu daje go pierwszy blok tekstu
    // (nagłówek po liście z poprzedniej wiadomości ma powietrze, akapit się nie klei); dymek człowieka zostaje
    // ciasno — wpis kolejki i jego echo muszą stać identycznie.
    let lead = config.plate ? nil : MarkdownRenderer.leadGap(config.text)
    let spacing = config.spacing
    // The previous row's bottom margin is part of the lead gap, so it comes off here.
    let run = max(spacing.runTop, lead.map { $0 - spacing.rowBottom } ?? 0)
    let top = config.gap.points(spacing) ?? (config.voice != nil ? spacing.voiceChange : run)
    // Blok kodu na końcu wiadomości: dolne `codePadding` pudełka wystaje poza tekst (odstęp po ostatnim akapicie
    // nie wlicza się do wysokości pola), więc wiersz dokłada go do marginesu — inaczej dół bloku ucinałaby
    // następna wiadomość albo dolna krawędź transkryptu. W dymku człowieka
    // mieści się w jego wstawce 10 pt.
    let codeTail = !config.plate && Self.endsWithCode(config.text) ? MarkdownLayoutFragment.codePadding : 0
    // An agent reply's time stands under the code box's bottom padding, so that padding moves from the margin into
    // the room above the time.
    clockLift = !config.plate && config.clock != nil ? codeTail : 0
    directionalLayoutMargins = NSDirectionalEdgeInsets(
      top: top, leading: TranscriptSpacing.cellSide, bottom: spacing.rowBottom + codeTail - clockLift,
      trailing: TranscriptSpacing.cellSide)

    let vertical = config.plate ? Self.plateVertical : 0
    let horizontal = config.plate ? Self.plateHorizontal : 0
    clockReserve = config.clock != nil && config.clockUnder
      ? clockLift + Self.clockFont(traitCollection).lineHeight.rounded(.up) + Self.clockUnderGap : 0
    // Długi prompt: okno tekstu zwinięte do 6 linii prozy, pod nim, jeszcze w dymku, wiersz przycisku.
    let collapsed = config.fold.map { !$0.expanded } ?? false
    // Pod linią napisu cel dotyku ma wstawkę dymku, godzinę pod nim i margines wiersza.
    let room = vertical + clockReserve + directionalLayoutMargins.bottom
    foldRow = config.fold == nil ? .none : Self.foldRow(traits: traitCollection, collapsed: collapsed, room: room)
    clipCap.constant = Self.foldHeight(traitCollection)
    clipCap.isActive = collapsed
    clipView.clipsToBounds = collapsed
    foldButton.isHidden = config.fold == nil
    if let fold = config.fold {
      foldButton.show(fold, traits: traitCollection, identifier: "\(config.accessibilityIdentifier).fold")
    }
    textTop.constant = vertical
    textBottom.constant = -vertical - clockReserve - foldReserve
    textLeading.constant = horizontal
    textTrailingMax.constant = -horizontal
    textTrailingFill.constant = -horizontal
    textWidthCap.constant =
      config.plate ? Self.plateCap(traitCollection, spacing: config.spacing) - 2 * horizontal : Self.noCap
    plateView.backgroundColor = config.plate ? Palette.userPlate : .clear
    plateView.isHidden = !config.plate
    // Pismo z cech komórki przy każdej konfiguracji: zmiana rozmiaru pisma przekonfigurowuje komórki (`+Look`).
    clockLabel.font = Self.clockFont(traitCollection)
    clockLabel.text = config.clock
    clockLabel.isHidden = config.clock == nil
    clockLabel.accessibilityLabel = config.clock.map(config.plate ? UICopy.promptClockSpoken : UICopy.replyClockSpoken)

    layoutDelegate.colors = MarkdownColors.resolved(for: traitCollection)
    if shownText !== config.text {
      shownText = config.text
      shownPlain = config.plainSyntax
      // Nowy tekst = nowe fragmenty z kolorami delegata, czyli z bieżącego motywu i kontrastu.
      colorsLook = ColorsLook(traitCollection)
      textView.attributedText = config.plainSyntax ? MarkdownRenderer.withoutSyntax(config.text) : config.text
      hasCodeBars = Self.containsCodeBar(config.text)
      fullWidthPlate = Self.needsFullWidth(config.text)
      if !sameMessage { codeButtons.forEach { $0.reset() } }
      setNeedsLayout()
    } else if shownPlain != config.plainSyntax {
      // Decyzja stanęła albo zeszła: ten sam tekst w innych kolorach. Układ się nie zmienia (kolor i kursywa
      // o tych samych metrykach), zaznaczenie zostaje.
      shownPlain = config.plainSyntax
      let plain = MarkdownRenderer.withoutSyntax(config.text)
      if plain !== config.text {
        let selection = textView.selectedRange
        colorsLook = ColorsLook(traitCollection)
        textView.attributedText = config.plainSyntax ? plain : config.text
        textView.selectedRange = selection
        setNeedsLayout()
      }
    }
    for box in codeBoxes { box.inPlate = config.plate }
    alpha = Self.alpha(dimmed: config.dimmed, takingBack: config.takingBack)
    updateShimmer()

    textView.accessibilityIdentifier = config.accessibilityIdentifier
    let prefix = config.accessibilityPrefix.map { "\($0): " } ?? ""
    textView.accessibilityLabel = prefix + MarkdownPlainText.spoken(config.text)
    textView.accessibilityTraits = config.header ? baseTraits.union(.header) : baseTraits
    // Every configuration sets both: a reused cell that shows an echo must not keep the take-back of a queued bubble.
    applyTakeBack(config.takeBack != nil)
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Szerokość tekstu bywa w pierwszym przebiegu jeszcze zerowa — układ okna i pola przed pomiarem.
    clipView.layoutIfNeeded()
    textView.layoutIfNeeded()
    placePlate()
    placeCodeBlocks()
    placeClock()
    placeFold()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateShimmer()
  }

  // MARK: - Poświata dymka w locie

  /// Czy po tle dymku płynie pasmo poświaty (testy).
  var shimmerRunning: Bool { !shimmer.layer.isHidden && shimmer.layer.animation(forKey: PlateShimmer.animationKey) != nil }

  private func updateShimmer() {
    let running = PlateShimmer.runs(
      inFlight: current.plate && current.inFlight, inWindow: window != nil,
      reduceMotion: UIAccessibility.isReduceMotionEnabled)
    shimmer.update(running: running, traits: traitCollection)
  }

  @objc private func reduceMotionChanged() {
    updateShimmer()
  }

  // MARK: - Dymek i godzina

  /// The widest bubble: the density's readable measure (``TranscriptSpacing/readableEm``, where readable prose ends)
  /// in the body text at the current text size, in both width modes.
  static func plateCap(_ traits: UITraitCollection, spacing: TranscriptSpacing) -> CGFloat {
    CGFloat(spacing.readableEm) * Fonts.text(MarkdownRenderer.transcriptStyle, traits: traits).pointSize
  }

  /// Wysokość okna zwiniętego promptu: ``PromptFolds/visible`` odstępów linii prozy w piśmie treści.
  static func foldHeight(_ traits: UITraitCollection) -> CGFloat {
    CGFloat(PromptFolds.visible) * prosePitch(traits)
  }

  /// Odstęp linii prozy w piśmie treści: 1,5 stopnia albo naturalny, gdy większy (``ProseLeading``).
  static func prosePitch(_ traits: UITraitCollection) -> CGFloat {
    let font = Fonts.text(MarkdownRenderer.transcriptStyle, traits: traits)
    return max(ProseLeading.naturalPitch(font), font.pointSize * ProseLeading.ratio)
  }

  /// Linia napisu „Pokaż całość” / „Zwiń” na dole dymka; rośnie z pismem. Cel dotyku (≥ 44 pt) wystaje poza nią.
  static func foldLineHeight(_ traits: UITraitCollection) -> CGFloat {
    Fonts.text(.footnote, traits: traits).lineHeight.rounded(.up)
  }

  /// Zanik dolnej pół linii okna zwiniętego promptu.
  static func fadeHeight(_ traits: UITraitCollection) -> CGFloat {
    prosePitch(traits) / 2
  }

  /// Wiersz przycisku zwinięcia w dymku pod oknem tekstu: odstęp nad linią napisu, linia napisu i o ile cel
  /// dotyku (≥ 44 pt) wystaje nad nią i pod nią.
  struct FoldRow: Equatable {
    var gap: CGFloat
    var line: CGFloat
    var above: CGFloat
    var below: CGFloat
    /// Miejsce w dymku pod oknem tekstu.
    var reserve: CGFloat { gap + line }
    static let none = FoldRow(gap: 0, line: 0, above: 0, below: 0)
  }

  /// Cel dotyku sięga najpierw w dół, na `room` pod linią napisu, potem w górę: przy zwiniętym prompcie najwyżej na
  /// zanik ostatniej linii, przy rozwiniętym wcale — tam rośnie odstęp nad napisem. Cel nie nachodzi więc na widoczny
  /// tekst, który ma zostać do zaznaczania i linków.
  static func foldRow(traits: UITraitCollection, collapsed: Bool, room: CGFloat) -> FoldRow {
    let line = foldLineHeight(traits)
    let spare = max(0, foldTarget - line)
    let below = min(max(0, room), spare)
    let above = spare - below
    let overlap = collapsed ? fadeHeight(traits) : 0
    return FoldRow(gap: max(foldGap, above - overlap), line: line, above: above, below: below)
  }

  /// Pismo godziny przy dymku: jak znacznik czasu (`caption`, stała szerokość), rośnie z Dynamic Type.
  static func clockFont(_ traits: UITraitCollection) -> UIFont {
    Fonts.mono(.caption1, traits: traits)
  }

  /// Whether the time fits BESIDE the bubble in a row `rowWidth` wide (after the side margins). A wide column (iPad in
  /// landscape) always has room; a narrower one when the widest text line leaves the gap and the label at the current
  /// text size on the right. Measured with the same TextKit 2 as the field, in a container of min(column, the bubble's
  /// cap at the density `spacing`) minus the insets. A long prompt (`fold`) has a bubble at least as wide as the
  /// button label at its bottom (``PromptFoldButton/showWidth(lines:traits:)``).
  static func clockFitsBeside(
    text: NSAttributedString, clock: String, rowWidth: CGFloat, traits: UITraitCollection, spacing: TranscriptSpacing,
    fold: PromptFold? = nil
  ) -> Bool {
    guard rowWidth > 0 else { return true }
    let clockWidth = (clock as NSString).size(withAttributes: [.font: clockFont(traits)]).width.rounded(.up)
    let cap = plateCap(traits, spacing: spacing)
    if rowWidth >= cap + clockGap + clockWidth { return true }
    let container = min(rowWidth, cap) - 2 * plateHorizontal
    let floor = fold.map { PromptFoldButton.showWidth(lines: $0.lines, traits: traits) } ?? 0
    let used = needsFullWidth(text) ? container : min(container, max(floor, measuredWidth(text, container: container)))
    return used + 2 * plateHorizontal + clockGap + clockWidth <= rowWidth
  }

  /// Najszersza linia tekstu w kontenerze `container` (TextKit 2, `usageBoundsForTextContainer`).
  static func measuredWidth(_ text: NSAttributedString, container: CGFloat) -> CGFloat {
    let storage = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    storage.addTextLayoutManager(manager)
    let box = NSTextContainer(size: CGSize(width: container, height: 0))
    box.lineFragmentPadding = 0
    manager.textContainer = box
    storage.attributedString = text
    manager.ensureLayout(for: manager.documentRange)
    return manager.usageBoundsForTextContainer.maxX.rounded(.up)
  }

  /// Szerokość zajęta przez tekst w polu (po układzie): najszersza linia, a przy kodzie, tabeli i linii poziomej —
  /// całe pole.
  private func usedTextWidth() -> CGFloat {
    let full = textView.bounds.width
    guard !fullWidthPlate, let manager = textView.textLayoutManager else { return full }
    manager.ensureLayout(for: manager.documentRange)
    return min(full, manager.usageBoundsForTextContainer.maxX.rounded(.up))
  }

  /// Szerokość tekstu w dymku: najszersza linia, a przy długim prompcie co najmniej napis przycisku na dole dymka.
  private func plateTextWidth() -> CGFloat {
    let used = usedTextWidth()
    guard let fold = current.fold else { return used }
    return min(textView.bounds.width, max(used, PromptFoldButton.showWidth(lines: fold.lines, traits: traitCollection)))
  }

  private func placePlate() {
    guard current.plate else { return }
    // Okno tekstu, nie pole: przy zwiniętym prompcie dymek kończy się pod szóstą linią i wierszem przycisku.
    let text = clipView.frame
    plateView.frame = CGRect(
      x: text.minX - Self.plateHorizontal, y: text.minY - Self.plateVertical,
      width: plateTextWidth() + 2 * Self.plateHorizontal, height: text.height + foldReserve + 2 * Self.plateVertical)
    shimmer.layout(plateView.bounds)
  }

  /// Godzina obok dymku, na wysokości jego ostatniej linii (przy długim prompcie — wiersza przycisku), albo pod nim,
  /// od jego lewej krawędzi.
  /// An agent reply's time: always under its last line, from the prose's left edge.
  private func placeClock() {
    guard current.clock != nil else { return }
    let size = clockLabel.intrinsicContentSize
    let plate = current.plate ? plateView.frame : clipView.frame
    if current.clockUnder {
      let top = plate.maxY + clockLift + Self.clockUnderGap
      clockLabel.frame = CGRect(x: plate.minX, y: top, width: size.width, height: size.height)
    } else {
      let limit = bounds.width - directionalLayoutMargins.trailing - size.width
      let x = min(plate.maxX + Self.clockGap, max(plate.minX, limit))
      let line = clipView.frame.maxY + foldReserve
      clockLabel.frame = CGRect(x: x, y: line - size.height, width: size.width, height: size.height)
    }
  }

  // MARK: - Długi prompt

  /// Pole wyższe od okna: zwinięty prompt naprawdę coś chowa.
  private var foldClips: Bool {
    clipView.clipsToBounds && textView.frame.height > clipView.bounds.height + 0.5
  }

  /// Zanik na dole okna i przycisk na dole dymka, pod oknem tekstu, od lewej krawędzi tekstu. Ramka przycisku to cel
  /// dotyku ≥ 44 pt wokół linii napisu (``foldRow``), a napis trzymają w linii wstawki treści.
  private func placeFold() {
    fade.isHidden = !foldClips
    if foldClips {
      let height = Self.fadeHeight(traitCollection)
      // Szeroki jak tekst w dymku, nie jak okno: okno ma szerokość kontenera, a dymek krótkich linii jest węższy —
      // kryjący dół zaniku malowałby pas koloru dymku obok niego.
      let text = plateView.frame.width - 2 * Self.plateHorizontal
      let width = current.plate ? min(clipView.bounds.width, text) : clipView.bounds.width
      fade.frame = CGRect(x: 0, y: clipView.bounds.height - height, width: width, height: height)
      fade.paint(Palette.userPlate.resolvedColor(with: traitCollection))
      clipView.bringSubviewToFront(fade)
    }
    guard current.fold != nil else { return }
    let text = clipView.frame
    let row = foldRow
    let insets = NSDirectionalEdgeInsets(top: row.above, leading: 0, bottom: row.below, trailing: 0)
    if foldButton.configuration?.contentInsets != insets { foldButton.configuration?.contentInsets = insets }
    let width = bounds.width - text.minX - directionalLayoutMargins.trailing
    let fits = foldButton.sizeThatFits(CGSize(width: width, height: Self.foldTarget)).width
    foldButton.frame = CGRect(
      x: text.minX, y: text.maxY + row.gap - row.above, width: min(width, max(Self.foldTarget, fits)),
      height: row.above + row.line + row.below)
  }

  // MARK: - Bloki kodu: tło pod tekstem, ikony kopiowania nad nim

  /// Ostatni znak tekstu leży w linii bloku kodu.
  static func endsWithCode(_ text: NSAttributedString) -> Bool {
    guard text.length > 0,
      let decoration = text.attribute(.rarogDecoration, at: text.length - 1, effectiveRange: nil) as? MarkdownDecoration,
      case .codeLine = decoration.kind
    else { return false }
    return true
  }

  private static func containsCodeBar(_ text: NSAttributedString) -> Bool {
    var found = false
    text.enumerateAttribute(.rarogDecoration, in: NSRange(location: 0, length: text.length)) { value, _, stop in
      if let decoration = value as? MarkdownDecoration, case .codeBar = decoration.kind {
        found = true
        stop.pointee = true
      }
    }
    return found
  }

  /// Blok kodu, linia pozioma albo tabela (załącznik) — ich tła i kreski idą przez całe pole.
  static func needsFullWidth(_ text: NSAttributedString) -> Bool {
    let whole = NSRange(location: 0, length: text.length)
    var found = false
    text.enumerateAttribute(.rarogDecoration, in: whole) { value, _, stop in
      guard let decoration = value as? MarkdownDecoration else { return }
      switch decoration.kind {
      case .codeBar, .codeLine, .rule:
        found = true
        stop.pointee = true
      case .plain:
        break
      }
    }
    if !found {
      text.enumerateAttribute(.attachment, in: whole) { value, _, stop in
        if value != nil {
          found = true
          stop.pointee = true
        }
      }
    }
    return found
  }

  /// Tło każdego bloku kodu (pudełko z paskiem) pod tekstem i ikona na lewym końcu paska, w jednej
  /// linii z pierwszym znakiem kodu. Geometrię pudełka daje fragment układu (`codeBoxInContainer`).
  private func placeCodeBlocks() {
    var bars: [(rect: CGRect, code: String)] = []
    var blocks: [(box: CGRect, bar: CGFloat)] = []
    if hasCodeBars, let manager = textView.textLayoutManager, textView.bounds.width > 0 {
      manager.ensureLayout(for: manager.documentRange)
      manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
        guard let fragment = fragment as? MarkdownLayoutFragment, let decoration = fragment.decoration,
          let box = fragment.codeBoxInContainer
        else { return true }
        switch decoration.kind {
        case let .codeBar(code):
          blocks.append((box, box.height))
          if let line = fragment.textLineFragments.first {
            let frame = fragment.layoutFragmentFrame
            let lineRect = line.typographicBounds.offsetBy(dx: frame.minX, dy: frame.minY)
            let x = decoration.leftIndent + MarkdownRenderer.codeInset - 7
            bars.append((CGRect(x: x, y: lineRect.midY - 14, width: 28, height: 28), code))
          }
        case .codeLine:
          if let last = blocks.indices.last, blocks[last].box.maxY >= box.minY - 1 {
            blocks[last].box = blocks[last].box.union(box)
          } else {
            blocks.append((box, 0))
          }
        case .plain, .rule:
          break
        }
        return true
      }
    }
    for (index, block) in blocks.enumerated() {
      if index == codeBoxes.count {
        let box = CodeBlockBox()
        // Nad tłem dymku, pod tekstem — w oknie tekstu, więc zwinięty prompt przycina je razem z tekstem.
        clipView.insertSubview(box, belowSubview: textView)
        codeBoxes.append(box)
      }
      let box = codeBoxes[index]
      box.inPlate = current.plate
      box.frame = textView.convert(block.box, to: clipView)
      box.barHeight = block.bar
      box.isHidden = false
    }
    for box in codeBoxes.dropFirst(blocks.count) { box.isHidden = true }
    for (index, bar) in bars.enumerated() {
      if index == codeButtons.count {
        let button = CopyIconButton(textStyle: .caption1, hitSize: CGSize(width: 44, height: 36))
        addSubview(button)
        codeButtons.append(button)
      }
      let button = codeButtons[index]
      button.frame = textView.convert(bar.rect, to: self)
      // Kopiuje CAŁY blok także przy zwiniętym prompcie; ikona pod zanikiem albo poza oknem się chowa.
      let code = bar.code
      button.payload = { code }
      let cut = clipView.frame.maxY - Self.fadeHeight(traitCollection)
      button.isHidden = clipView.clipsToBounds && button.frame.midY > cut
    }
    for button in codeButtons.dropFirst(bars.count) { button.isHidden = true }
  }
}

// MARK: - „Zaznacz więcej…”

/// Ekran, który otwiera okno tekstu transkryptu od wiersza `row` (zaznaczenie systemu nie wychodzi poza jedną
/// wiadomość). Wiersz szuka go w łańcuchu responderów.
@MainActor protocol TranscriptSelectionOpening: AnyObject {
  func openTranscriptSelection(row: String)
}

extension MessageContentView: UITextViewDelegate {
  /// Menu systemowe zaznaczenia i na końcu „Zaznacz więcej…”, gdy nad wierszem stoi ekran, który umie otworzyć okno.
  func textView(
    _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let opener = Self.opener(from: textView) else { return nil }
    let row = String(current.accessibilityIdentifier.trimmingPrefix("message."))
    let more = UIAction(
      title: UICopy.transcriptSelectMore, image: UIImage(systemName: "text.viewfinder"),
      identifier: Self.selectMoreAction
    ) { [weak opener] _ in
      opener?.openTranscriptSelection(row: row)
    }
    return UIMenu(children: suggestedActions + [more])
  }

  /// Identyfikator pozycji „Zaznacz więcej…” w menu edycji.
  static let selectMoreAction = UIAction.Identifier("transcript.selectMore")

  /// Pierwszy responder nad widokiem, który otwiera okno tekstu transkryptu.
  static func opener(from view: UIResponder) -> TranscriptSelectionOpening? {
    var next = view.next
    while let responder = next {
      if let opener = responder as? TranscriptSelectionOpening { return opener }
      next = responder.next
    }
    return nil
  }
}

/// Tło bloku kodu pod tekstem: kryjące `codeBlockFill` (w dymku człowieka `codeInPlateFill`), u góry pasek z językiem
/// (`barFill`) i włos pod nim. Kolory dynamiczne idą za motywem same. Nie łapie dotyku — zaznaczanie i ikona
/// kopiowania zostają tekstowi i przyciskowi nad nim.
final class CodeBlockBox: UIView {
  private let bar = UIView()
  private let hairline = UIView()

  /// Wysokość paska z językiem u góry pudełka (0 = bez paska).
  var barHeight: CGFloat = 0 {
    didSet { if oldValue != barHeight { setNeedsLayout() } }
  }

  /// Blok w dymku człowieka: w jasnym motywie jaśniejsze tło, które odcina się od dymku.
  var inPlate = false {
    didSet { backgroundColor = inPlate ? Palette.codeInPlateFill : Palette.codeBlockFill }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = Palette.codeBlockFill
    layer.roundCorners(Radius.inner)
    clipsToBounds = true
    bar.backgroundColor = MarkdownColors.barFill
    hairline.backgroundColor = Palette.border
    addSubview(bar)
    addSubview(hairline)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    bar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: barHeight)
    hairline.frame = CGRect(x: 0, y: barHeight - 0.5, width: bounds.width, height: 0.5)
    bar.isHidden = barHeight <= 0
    hairline.isHidden = barHeight <= 0
  }
}
#endif
