#if os(iOS)
import RarogContract
import RarogCore
import UIKit

// Wiersz aktywności: the first line of the field card, or a narrow card of its own at the top of
// the foot while the field hides (`SessionViewController+FootActivity`). Owner: list.

/// What the agent does now, as the quiet activity line (`ActivityRowLine`): a glyph, the label, the detail, the delegation
/// segments and the turn clock in a fixed field at the trailing edge. The detail truncates first, then the label; the
/// clock never. The row keeps one line's height also while empty; the field card shows that band through a whole turn
/// (`ActivityBand`), so a line coming and going in a turn moves nothing.
///
/// The line passes through ``ActivityLineHold`` (a quick run of tools does not flicker it): the row resolves the hold
/// on every render and every clock tick, and repaints once more at the moment the hold names. Motion comes from data
/// only: when the session's own stream brings an event in a turn (`AppState.turnEvents`), the glyph ticks once; while
/// the line says the agent works (`ActivityRowLine.isWorking`) the glyph breathes and a light band runs over the label;
/// in silence, offline, waiting and with Reduce Motion both stand. The clock tick, the motion and the VoiceOver
/// sentences live only while the row is actually on screen (in a window, no hidden ancestor); a card that shows or
/// hides it calls ``visibilityChanged()``.
@MainActor
final class ActivityRowView: UIView {
  let glyph = UIImageView()
  let label = ShimmerLabel()
  let detail = UILabel()
  let segments = ActivitySegmentsView()
  let clock = UILabel()
  /// One line's height at every text size: an empty row keeps its place.
  private let reserve = UILabel()
  /// The detail of the shown line is monospaced.
  private var detailIsMono = false
  private var timer: Timer?
  private var wakeTimer: Timer?
  /// The moment of the one extra repaint the hold asked for; `nil` = none pending.
  private(set) var wakeAt: Date?
  /// The last state from a render: the clock tick and the wake-up repaint the row from it.
  private var state: AppState?
  private var sessionId: String?
  /// Start of the whole outage of the session stream: reconnect attempts neither move the clock nor drop the offline
  /// line until `online`.
  private var link = ConnectionMemory()
  /// The hold of the shown line (minimum show time, tool → thinking delay); it starts over on a session switch.
  private var hold = ActivityLineHold()
  /// The session's event counter at the last render: the glyph ticks when it grows while the row is on screen.
  private var seenEvents: Int?
  /// Activity sentences: the gate and the content key VoiceOver has already "seen".
  private var speech = ActivitySpeechGate()
  private var heard: String?
  /// The symbol on the glyph now (a change of symbol gets the `replace` transition).
  private var symbolName: String?
  /// VoiceOver channel (tests pass a recorder).
  var announcer: Announcer = .shared
  /// The clock (tests pass a fixed one).
  var now: () -> Date = Date.init
  /// Reduce Motion from the system; tests replace the reading.
  var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
  /// The row got or lost something to say (`true` = content): the narrow card shows its glass only with content.
  var onContentChange: ((Bool) -> Void)?
  /// The row shows a line now (the band rule reads it, `ActivityBand`).
  private(set) var hasContent = false
  /// The second clock runs.
  var isTicking: Bool { timer != nil }
  /// The glyph breathes (a symbol effect UIKit does not report back, so the row keeps it).
  private(set) var isBreathing = false

  /// Key of the glyph tick animation.
  static let tickKey = "tick"
  /// Opacity of the glyph between ticks: the tick ends there, so it does not jump at its end.
  static let glyphRestOpacity: Float = 0.75

  /// A card around the row showed or hid it: the clock and the sentence follow, and a content the row could not show
  /// before is spoken now. Events that came while the row was hidden do not tick the glyph now.
  func visibilityChanged() {
    speak(paint())
  }

  /// In a window and no ancestor hidden: what the person can see.
  var isOnScreen: Bool {
    guard window != nil else { return false }
    var item: UIView? = self
    while let view = item {
      if view.isHidden { return false }
      item = view.superview
    }
    return true
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  /// A new store state (the session screen's render calls it).
  func render(state: AppState, sessionId: String) {
    let sameSession = self.sessionId == sessionId
    if !sameSession {
      speech = ActivitySpeechGate()
      heard = nil
    }
    self.state = state
    self.sessionId = sessionId
    link.observe(state.sessionStream, now: now())
    let events = state.turnEvents(sessionId)
    let grew = sameSession && seenEvents.map { events > $0 } == true
    seenEvents = events
    speak(paint())
    if grew, hasContent, isOnScreen, window?.windowScene?.activationState != .background { tick() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopTimer()
      stopWake()
      glyph.layer.removeAnimation(forKey: Self.tickKey)
      setWorking(false)
    } else {
      paint()
    }
  }

  // MARK: - Build

  private func build() {
    accessibilityIdentifier = "transcript.activity"
    isAccessibilityElement = false
    accessibilityTraits = [.updatesFrequently, .staticText]

    glyph.contentMode = .center
    glyph.isAccessibilityElement = false
    glyph.adjustsImageSizeForAccessibilityContentSizeCategory = true
    glyph.setContentHuggingPriority(.required, for: .horizontal)
    glyph.setContentCompressionResistancePriority(.required, for: .horizontal)

    label.textColor = Palette.prose
    detail.textColor = Palette.muted2
    clock.textColor = Palette.muted2
    clock.textAlignment = .right
    for text in [label, detail, clock] {
      text.adjustsFontForContentSizeCategory = true
      text.numberOfLines = 1
      text.lineBreakMode = .byTruncatingTail
      text.setContentHuggingPriority(.required, for: .horizontal)
    }
    // The detail truncates first, then the label; the clock, the glyph and the segments never.
    detail.setContentCompressionResistancePriority(UILayoutPriority(748), for: .horizontal)
    label.setContentCompressionResistancePriority(UILayoutPriority(749), for: .horizontal)
    clock.setContentCompressionResistancePriority(.required, for: .horizontal)

    let spacer = UIView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let row = UIStackView(arrangedSubviews: [glyph, label, detail, segments, spacer, clock])
    row.axis = .horizontal
    row.spacing = 6
    row.alignment = .center
    row.setCustomSpacing(8, after: spacer)
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)

    reserve.adjustsFontForContentSizeCategory = true
    reserve.text = " "
    reserve.isAccessibilityElement = false
    reserve.translatesAutoresizingMaskIntoConstraints = false
    reserve.setContentHuggingPriority(.required, for: .vertical)
    addSubview(reserve)

    // 6 pt from the top, 2 pt from the bottom: the card around the row adds its own padding. Sides 14 pt: the line
    // starts where the field's text starts in the card (`ComposerView.textLeading`).
    NSLayoutConstraint.activate([
      glyph.widthAnchor.constraint(greaterThanOrEqualToConstant: 16),
      reserve.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      reserve.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
      reserve.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      row.centerYAnchor.constraint(equalTo: reserve.centerYAnchor),
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      row.topAnchor.constraint(greaterThanOrEqualTo: topAnchor),
      row.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
    ])
    applyFonts()
    Fonts.follow(self) { [weak self] in self?.applyFonts() }
    setVisible(false)
  }

  /// The row's fonts at the text size; again after a step on the flat path, where no trait change comes.
  private func applyFonts() {
    glyph.preferredSymbolConfiguration =
      TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.footnote), scale: .medium)
      : UIImage.SymbolConfiguration(textStyle: .footnote, scale: .medium)
    label.font = Fonts.text(.footnote, weight: .medium)
    clock.font = Self.clockFont()
    reserve.font = Fonts.text(.footnote)
    detail.font = detailIsMono ? Fonts.mono(.footnote) : Fonts.text(.footnote)
  }

  /// Footnote with digits of one width, at the text size: the clock does not wobble as it counts.
  private static func clockFont() -> UIFont {
    let digits = UIFont.monospacedDigitSystemFont(ofSize: Fonts.base(.footnote), weight: .regular)
    return Fonts.scaled(digits, relativeTo: .footnote)
  }

  // MARK: - Render

  @discardableResult
  private func paint() -> ActivityRowLine? {
    guard let state, let sessionId else { return nil }
    let moment = now()
    let candidate = ActivityRowLine.make(state: state, sessionId: sessionId, now: moment, link: link)
    let outcome = hold.resolve(candidate, sessionId: sessionId, now: moment)
    scheduleWake(outcome.wakeAt, now: moment)
    guard let line = outcome.line else {
      setVisible(false)
      accessibilityLabel = nil
      isAccessibilityElement = false
      stopTimer()
      glyph.layer.removeAnimation(forKey: Self.tickKey)
      setWorking(false)
      contentChanged(false)
      return nil
    }
    draw(line)
    setWorking(line.isWorking && isOnScreen && !reduceMotion())
    setVisible(true)
    isAccessibilityElement = true
    accessibilityLabel = UICopy.activitySpoken(line.spoken)
    contentChanged(true)
    // The clock repaints the row every second; on a broken stream the model holds the clock at the break, so the
    // number stands. A row nobody sees does not tick.
    if isOnScreen {
      startTimer()
    } else {
      stopTimer()
    }
    return line
  }

  private func draw(_ line: ActivityRowLine) {
    let animated = isOnScreen && hasContent
    if symbolName != line.glyph.symbolName, let image = UIImage(systemName: line.glyph.symbolName) {
      // A new symbol starts without the breath; the paint gives it back when the new line still works.
      if isBreathing {
        glyph.removeSymbolEffect(ofType: .breathe, animated: false)
        isBreathing = false
      }
      if animated, !reduceMotion() {
        glyph.setSymbolImage(image, contentTransition: .replace)
      } else {
        glyph.image = image
      }
      symbolName = line.glyph.symbolName
    }
    glyph.tintColor = line.isLive ? Palette.run : Palette.muted2

    if label.text != line.label {
      if animated, label.text != nil {
        UIView.transition(with: label, duration: 0.2, options: [.transitionCrossDissolve, .beginFromCurrentState]) {
          self.label.text = line.label
        }
      } else {
        label.text = line.label
      }
    }
    detailIsMono = line.detailIsMono
    detail.font = line.detailIsMono ? Fonts.mono(.footnote) : Fonts.text(.footnote)
    detail.text = line.detail.isEmpty ? nil : line.detail
    detail.isHidden = line.detail.isEmpty
    segments.update(line.segments ?? [])
    segments.isHidden = line.segments == nil
    clock.text = line.clock
    clock.isHidden = line.clock == nil
  }

  /// The sentence for VoiceOver on a CHANGE of the line's content (not on a tick of a clock), through the gate
  /// `ActivitySpeechGate` and the shared channel — only from a screen in a window.
  private func speak(_ line: ActivityRowLine?) {
    // Only what is on screen: a content behind a hidden card stays unheard until the card shows it.
    guard isOnScreen else { return }
    let content = line?.contentKey
    guard content != heard else { return }
    heard = content
    guard speech.shouldSpeak(line?.kind, now: now()), let line else { return }
    announcer.say(UICopy.activitySpoken(line.spoken), priority: .ambient)
  }

  private func contentChanged(_ has: Bool) {
    guard has != hasContent else { return }
    hasContent = has
    onContentChange?(has)
  }

  private func setVisible(_ visible: Bool) {
    for view in [label, detail, segments, clock] as [UIView] { view.alpha = visible ? 1 : 0 }
    glyph.alpha = visible ? CGFloat(Self.glyphRestOpacity) : 0
  }

  // MARK: - Working motion

  /// The glyph breathes and the label shimmers while the line says the agent works (`ActivityRowLine.isWorking`), the
  /// row is on screen and Reduce Motion is off. Every paint (also each clock second) decides again, so silence, a
  /// broken stream or Reduce Motion switched on stop both within a second.
  private func setWorking(_ on: Bool) {
    label.setShimmering(on)
    guard on != isBreathing else { return }
    if on {
      // Plain: scale only. The default style follows the symbol and also fades the glyph.
      glyph.addSymbolEffect(.breathe.plain, options: .repeat(.continuous))
    } else {
      glyph.removeSymbolEffect(ofType: .breathe)
    }
    isBreathing = on
  }

  // MARK: - Glyph tick

  /// One tick of the glyph for a new event: scale 1 → 1.12 → 1 and opacity 0.5 → 1 → rest over 450 ms, ease out. A new
  /// event restarts it (no queue); Reduce Motion keeps the opacity only.
  private func tick() {
    let layer = glyph.layer
    layer.removeAnimation(forKey: Self.tickKey)
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = [0.5, 1, Self.glyphRestOpacity]
    var parts: [CAAnimation] = [fade]
    if !reduceMotion() {
      let scale = CAKeyframeAnimation(keyPath: "transform.scale")
      scale.values = [1, 1.12, 1]
      parts.append(scale)
    }
    let group = CAAnimationGroup()
    group.animations = parts
    group.duration = 0.45
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    layer.add(group, forKey: Self.tickKey)
  }

  // MARK: - Clock and wake-up

  private func startTimer() {
    guard timer == nil else { return }
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.speak(self?.paint()) }
    }
    Self.schedule(timer)
    self.timer = timer
  }

  /// In the common run loop modes: a finger dragging the transcript puts the run loop in the tracking mode, and a
  /// timer of the default mode would freeze the clock and keep a held line past its moment until the drag ends.
  private static func schedule(_ timer: Timer) {
    RunLoop.main.add(timer, forMode: .common)
  }

  private func stopTimer() {
    timer?.invalidate()
    timer = nil
  }

  /// One extra repaint at the moment the hold lets the waiting line in, so the change does not wait for the next
  /// second of the clock. Only in a window; each paint replaces the pending one (measured from the current clock).
  private func scheduleWake(_ moment: Date?, now current: Date) {
    stopWake()
    guard let moment, window != nil else { return }
    wakeAt = moment
    let wake = Timer(timeInterval: max(0, moment.timeIntervalSince(current)), repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.wakeTimer = nil
        self.wakeAt = nil
        self.speak(self.paint())
      }
    }
    Self.schedule(wake)
    wakeTimer = wake
  }

  private func stopWake() {
    wakeTimer?.invalidate()
    wakeTimer = nil
    wakeAt = nil
  }
}

/// The activity label with a light band running over it while the agent works: a gradient mask three label widths
/// wide, the light in its middle and 65 % opacity elsewhere. At rest the light stands before the leading edge (the
/// whole text dim); the sweep moves the mask by 1.4 widths in 1.6 s, then rests 0.8 s. The gradient stops stay inside
/// 0…1 and the mask always covers the whole label, so no part of the text ever falls outside it.
@MainActor
final class ShimmerLabel: UILabel {
  /// Key of the sweep animation on the mask.
  static let shimmerKey = "shimmer"
  private let band = CAGradientLayer()

  /// The band runs (the mask is on).
  var isShimmering: Bool { layer.mask === band }

  func setShimmering(_ on: Bool) {
    guard on != isShimmering else { return }
    guard on else {
      band.removeAnimation(forKey: Self.shimmerKey)
      layer.mask = nil
      return
    }
    let dim = UIColor(white: 0, alpha: 0.65).cgColor
    band.colors = [dim, UIColor.black.cgColor, dim]
    band.locations = [0.43, 0.5, 0.57]
    band.startPoint = CGPoint(x: 0, y: 0.5)
    band.endPoint = CGPoint(x: 1, y: 0.5)
    layer.mask = band
    placeBand()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard isShimmering, band.frame.size != CGSize(width: 3 * bounds.width, height: bounds.height) else { return }
    placeBand()
  }

  /// Sizes the mask to the label (light 0.2 widths before the leading edge) and starts the sweep over that width.
  private func placeBand() {
    let width = bounds.width
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    band.frame = CGRect(x: -1.7 * width, y: 0, width: 3 * width, height: bounds.height)
    CATransaction.commit()
    let move = CABasicAnimation(keyPath: "transform.translation.x")
    move.fromValue = 0
    move.toValue = 1.4 * width
    move.duration = 1.6
    move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    let cycle = CAAnimationGroup()
    cycle.animations = [move]
    cycle.duration = 2.4
    cycle.repeatCount = .infinity
    // Kept across the app's trip to the background, so the band runs again on return.
    cycle.isRemovedOnCompletion = false
    band.add(cycle, forKey: Self.shimmerKey)
  }
}

/// The workflow bar of a delegation on the activity line: one 2 pt segment per plan phase, 3 pt gaps. Progress jumps
/// without a width animation: the jump is the truth (a lower estimate).
@MainActor
final class ActivitySegmentsView: UIView {
  /// Width of one segment.
  private static let segmentWidth: CGFloat = 12
  private static let gap: CGFloat = 3
  private static let height: CGFloat = 2
  private var current: [ProgressSegment] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = false
    setContentHuggingPriority(.required, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .horizontal)
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) {
      (view: ActivitySegmentsView, _: UITraitCollection) in view.setNeedsLayout()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  override var intrinsicContentSize: CGSize {
    let count = CGFloat(current.count)
    return CGSize(width: max(0, count * Self.segmentWidth + (count - 1) * Self.gap), height: Self.height)
  }

  func update(_ segments: [ProgressSegment]) {
    guard segments != current else { return }
    current = segments
    invalidateIntrinsicContentSize()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    let y = (bounds.height - Self.height) / 2
    for (index, segment) in current.enumerated() {
      let x = CGFloat(index) * (Self.segmentWidth + Self.gap)
      let track = CALayer()
      track.frame = CGRect(x: x, y: y, width: Self.segmentWidth, height: Self.height)
      track.cornerRadius = Self.height / 2
      track.backgroundColor = (segment.active ? Palette.run.withAlphaComponent(0.3) : Palette.border)
        .resolvedColor(with: traitCollection).cgColor
      let fill = CALayer()
      fill.frame = CGRect(x: 0, y: 0, width: Self.segmentWidth * min(1, max(0, segment.fill)), height: Self.height)
      fill.cornerRadius = Self.height / 2
      fill.backgroundColor = Palette.run.resolvedColor(with: traitCollection).cgColor
      track.addSublayer(fill)
      layer.addSublayer(track)
    }
  }
}
#endif
