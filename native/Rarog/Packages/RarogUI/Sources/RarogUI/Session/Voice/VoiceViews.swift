#if os(iOS)
import UIKit

// Mikrofon i wiersz stanu dyktowania (`docs/design.md`: Stop, mikrofon i spinacz płaskie,
// kolor niesie kropka). Właściciel: dyktowanie.

/// Mikrofon pola: w rzędzie kontrolek, tuż przed „Wyślij” (`ComposerView.installVoice`). Nagranie kończy drugie
/// stuknięcie i tekst zostaje w polu. Osobnego „×” anulowania nie ma —
/// podyktowany tekst poprawia się w polu jak każdy inny.
@MainActor
final class VoiceButtons {
  let mic = RingButton(type: .system)
  /// Podpowiedź „Mikrofon (⌥⌘M)” po najechaniu kursorem.
  private(set) var tip: ShortcutTipTracker?

  var onMic: (() -> Void)?

  init() {
    // Dictation is the main way in, so the mic is a plate (`RingButton.plated`) as big as Send: it outranks the outlined
    // controls without the accent, which stays with a filled Send.
    mic.translatesAutoresizingMaskIntoConstraints = false
    mic.plated = true
    // Szerokość 999, nie 1000: schowany mikrofon dostaje od stosu rzędu kontrolek szerokość 0 z priorytetem 1000 — jak
    // „Schowaj klawiaturę” w `ComposerActionBar`.
    let width = mic.widthAnchor.constraint(equalToConstant: Self.side)
    width.priority = .required - 1
    NSLayoutConstraint.activate([width, mic.heightAnchor.constraint(equalToConstant: Self.side)])
    mic.accessibilityIdentifier = "composer.mic"
    mic.accessibilityLabel = UICopy.voiceMic
    mic.largeContentTitle = UICopy.voiceMic
    mic.showsLargeContentViewer = true
    mic.addAction(UIAction { [weak self] _ in self?.onMic?() }, for: .primaryActionTriggered)
    tip = ShortcutTipTracker(view: mic, line: ShortcutTipLine(UICopy.voiceMic, .dictation))
    render(available: false, recording: false, enabled: true)
  }

  /// `available` = mikrofon na miejscu (gospodarz pola wiadomości daje go zawsze: brak dyktowania na serwerze
  /// zmienia trasę, nie chowa mikrofonu); `recording` = mikrofon otwarty albo się otwiera; `enabled` = pole przyjmuje
  /// tekst. `conversationMuted`: a voice agent conversation runs (`nil` = none), so the mic mutes it instead of
  /// dictating.
  func render(available: Bool, recording: Bool, enabled: Bool, conversationMuted: Bool? = nil) {
    if let muted = conversationMuted, !recording {
      renderMute(muted: muted)
      return
    }
    mic.accessibilityLabel = UICopy.voiceMic
    mic.largeContentTitle = UICopy.voiceMic
    mic.isHidden = !available && !recording
    mic.isEnabled = recording || enabled
    // W nagraniu obrys i ikona w kolorze stanu, bez wypełnienia (docs/design.md, `.composer__mic--on`).
    mic.configuration = Self.ringed(symbol: recording ? "mic.fill" : "mic")
    mic.tone = recording ? Palette.err : nil
    // Cechy ustawione ręką zastępują systemowe — wygaszenie trzeba nazwać samemu (audyt dostępności).
    var traits: UIAccessibilityTraits = recording ? [.button, .selected] : .button
    if !mic.isEnabled { traits.insert(.notEnabled) }
    mic.accessibilityTraits = traits
    mic.accessibilityHint = recording ? UICopy.voiceMicStopHint : UICopy.voiceMicHint
  }

  /// The mic during a voice agent conversation: a crossed microphone that mutes it; muted, it is lit like
  /// dictation's recording (ring and icon in the state color, selected).
  private func renderMute(muted: Bool) {
    mic.isHidden = false
    mic.isEnabled = true
    mic.configuration = Self.ringed(symbol: muted ? "mic.slash.fill" : "mic.slash")
    mic.tone = muted ? Palette.err : nil
    mic.accessibilityTraits = muted ? [.button, .selected] : .button
    mic.accessibilityLabel = muted ? UICopy.voiceAgentUnmute : UICopy.voiceAgentMute
    mic.largeContentTitle = mic.accessibilityLabel
    mic.accessibilityHint = nil
  }

  /// The mic's side: the same as Send; the touch target grows to 44 pt.
  static let side: CGFloat = SendButton.side

  /// Okrągła płytka; kolory płytki, kreski i ikony (w nagraniu kolor stanu) daje `RingButton.tone`.
  private static func ringed(symbol: String) -> UIButton.Configuration {
    var config = configuration(symbol: symbol, color: Palette.muted)
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    config.cornerStyle = .capsule
    config.contentInsets = .zero
    return config
  }

  private static func configuration(symbol: String, color: UIColor) -> UIButton.Configuration {
    var config = UIButton.Configuration.plain()
    config.image = UIImage(systemName: symbol)
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    config.baseForegroundColor = color
    return config
  }
}

/// Wiersz stanu dyktowania między polem a rzędem kontrolek: kropka i jedno zdanie (+ „Ustawienia"
/// przy odmowie zgody na mikrofon albo na rozpoznawanie mowy, `VoiceNotice.opensSettings`). Pojawia się nad przyciskami, więc kciuk zastaje mikrofon i „Wyślij" tam,
/// gdzie były. Do czytnika idzie ZMIANA STANU (ogłoszenie), nie każde tyknięcie licznika.
/// The voice conversation shows its state in the same row; one owner at a time (`VoiceStatusOwner`).
@MainActor
final class VoiceStatusView: UIView {
  /// Bok kropki; kółko, więc promień to połowa boku (poza skalą `Radius`, jak kapsuły).
  private static let dotSide: CGFloat = 8
  private let dot = UIView()
  private let label = UILabel()
  private let settings = UIButton(type: .system)
  private var level: CGFloat = 0
  private var pulsing = false
  /// Dictation's state; shown unless the voice conversation owns the row (`VoiceStatusOwner`).
  private var dictation = VoiceView()
  /// The voice conversation's state (`SessionViewController+VoiceAgent.swift`); `nil` = none.
  private(set) var agent: VoiceAgentIndicator?

  var onSettings: (() -> Void)?
  /// The end sentence of the conversation was dismissed (tap on the row, field edit): its owner forgets it.
  var onAgentNoticeDismissed: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  private func build() {
    accessibilityIdentifier = "composer.voice"
    dot.layer.cornerRadius = Self.dotSide / 2
    dot.isAccessibilityElement = false
    label.font = Fonts.text(.footnote)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = Palette.muted
    label.numberOfLines = 0
    label.accessibilityIdentifier = "composer.voice.status"
    var config = UIButton.Configuration.plain()
    config.title = UICopy.voiceSettings
    config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)
    settings.configuration = config
    // The title font comes from the button's own traits: without them the font has the system's text size, not the
    // size set on the scene. A size change (a trait change, or a step on the flat path) asks for a new configuration.
    settings.configurationUpdateHandler = { button in
      guard var config = button.configuration else { return }
      let font = Fonts.text(.footnote, traits: button.traitCollection)
      config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
        var next = attributes
        next.font = font
        return next
      }
      button.configuration = config
    }
    settings.registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (button: UIButton, _) in
      button.setNeedsUpdateConfiguration()
    }
    Fonts.follow(self) { [weak self] in
      self?.label.font = Fonts.text(.footnote)
      self?.settings.setNeedsUpdateConfiguration()
    }
    settings.accessibilityIdentifier = "composer.voice.settings"
    settings.accessibilityHint = UICopy.voiceSettingsHint
    settings.addAction(UIAction { [weak self] _ in self?.onSettings?() }, for: .primaryActionTriggered)

    for view in [dot, label, settings] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    settings.setContentCompressionResistancePriority(.required, for: .horizontal)
    settings.setContentHuggingPriority(.required, for: .horizontal)
    NSLayoutConstraint.activate([
      dot.widthAnchor.constraint(equalToConstant: Self.dotSide),
      dot.heightAnchor.constraint(equalToConstant: Self.dotSide),
      dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
      dot.centerYAnchor.constraint(equalTo: label.firstBaselineAnchor, constant: -4),
      label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
      label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
      label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
      settings.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 4),
      settings.trailingAnchor.constraint(equalTo: trailingAnchor),
      settings.centerYAnchor.constraint(equalTo: label.centerYAnchor),
    ])
    let tight = label.trailingAnchor.constraint(equalTo: trailingAnchor)
    tight.priority = .defaultLow
    tight.isActive = true
    isHidden = true
    // A tap dismisses the end sentence of the voice conversation (dictation's notices go with a field edit).
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    NotificationCenter.default.addObserver(
      self, selector: #selector(reduceMotionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
  }

  /// Rysuje stan; `text` puste chowa wiersz.
  func render(_ view: VoiceView) {
    dictation = view
    apply()
  }

  /// The state of the voice conversation; while it runs it owns the row.
  func renderAgent(_ indicator: VoiceAgentIndicator?) {
    agent = indicator
    apply()
  }

  /// The field was edited: dictation's notice goes, and so does the end sentence of the conversation; the state of
  /// a running conversation stays (`VoiceStatusOwner.afterEdit`).
  func noticeEdit() {
    dictation = VoiceView()
    let kept = VoiceStatusOwner.afterEdit(agent)
    if kept != agent {
      agent = kept
      onAgentNoticeDismissed?()
    }
    apply()
  }

  private func apply() {
    let dictationText = UICopy.voiceStatus(dictation)
    switch VoiceStatusOwner.pick(dictationText: dictationText, agent: agent) {
    case .none:
      label.text = ""
      isHidden = true
      settings.isHidden = true
      pulsing = false
    case .dictation:
      label.text = dictationText
      isHidden = false
      settings.isHidden = dictation.notice?.opensSettings != true
      // Kolor niesie znaczenie: czerwień „nagrywam" i błąd, bursztyn „coś się dzieje", szarość reszta.
      dot.backgroundColor =
        if dictation.notice?.isError == true { Palette.err }
        else if dictation.phase == .recording { Palette.err }
        else if dictation.phase == .idle { Palette.muted2 }
        else { Palette.wait }
      pulsing = dictation.phase == .recording
    case let .voiceAgent(indicator):
      label.text = UICopy.voiceAgentStatus(indicator)
      isHidden = false
      settings.isHidden = !indicator.opensSettings
      dot.backgroundColor = Self.color(indicator.tone)
      pulsing = indicator.motion != .none
    }
    if !pulsing, dot.transform != .identity {
      level = 0
      dot.transform = .identity
    }
  }

  /// `Palette` color of a conversation state (dot, filled button).
  static func color(_ tone: VoiceAgentIndicator.Tone) -> UIColor {
    switch tone {
    case .wait: Palette.wait
    case .run: Palette.run
    case .new: Palette.new
    case .err: Palette.err
    }
  }

  /// Poziom dźwięku (szczyt ramki 0…1) jako oddech kropki — jedyny ruch dyktowania. Bez ruchu przy
  /// włączonej redukcji ruchu: kropka zostaje czerwona, informację niesie kolor i zdanie.
  func level(_ peak: Float) {
    guard pulsing, !UIAccessibility.isReduceMotionEnabled else { return }
    // Szybko w górę, wolno w dół — kropka nie miga z każdą ramką.
    let target = CGFloat(min(1, max(0, peak * 3)))
    level = max(target, level * 0.75)
    show(level: level)
  }

  /// The level of the voice conversation (already smoothed, 0…1) as the breath of the dot.
  func agentLevel(_ value: Double) {
    guard pulsing, agent?.isActive == true, !UIAccessibility.isReduceMotionEnabled else { return }
    level = CGFloat(value)
    show(level: level)
  }

  @objc private func tapped() {
    guard let agent, !agent.isActive else { return }
    self.agent = nil
    onAgentNoticeDismissed?()
    apply()
  }

  private func show(level: CGFloat) {
    let scale = 1 + level * 0.5
    UIView.animate(withDuration: 0.1, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.dot.transform = CGAffineTransform(scaleX: scale, y: scale)
    }
  }

  @objc private func reduceMotionChanged() {
    if UIAccessibility.isReduceMotionEnabled {
      level = 0
      dot.transform = .identity
    }
  }
}
#endif
