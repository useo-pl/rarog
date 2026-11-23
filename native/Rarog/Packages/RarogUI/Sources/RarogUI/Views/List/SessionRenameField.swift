#if os(iOS)
import SwiftUI
import UIKit

// Renaming a session in place on the list row: the field that replaces the row and the pointer double click that
// opens it. The rules and the pending name live in `Model/SessionRename`. Owner: list.

/// The agent row as a field: the name in an accent outline, all of it selected, and under it the counter `n / 28`
/// and the keys. Return saves; Esc, losing focus and a tap elsewhere cancel. Without a hardware keyboard Cancel stands
/// at the end of the field's line, because touch has no Esc.
struct SessionRenameField: View {
  let initial: String
  /// The edit this field serves (`SessionRenamer.edit`).
  let edit: Int
  let hardwareKeyboard: Bool
  let save: (String) -> Void
  let cancel: () -> Void
  @State private var count: Int

  init(
    initial: String, edit: Int, hardwareKeyboard: Bool,
    save: @escaping (String) -> Void, cancel: @escaping () -> Void
  ) {
    let text = SessionRename.fieldText(initial)
    self.initial = text
    self.edit = edit
    self.hardwareKeyboard = hardwareKeyboard
    self.save = save
    self.cancel = cancel
    _count = State(initialValue: text.utf16.count)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        RenameTextField(initial: initial, edit: edit, changed: { count = $0.utf16.count }, save: save, cancel: cancel)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(RoundedRectangle.inner.fill(Color(uiColor: Palette.input)))
          .overlay(RoundedRectangle.inner.strokeBorder(Color(uiColor: Palette.accent), lineWidth: 1.5))
        if !hardwareKeyboard {
          Button(action: cancel) {
            Text(UICopy.renameCancel)
              .appFont(.subheadline)
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          // Borderless: in a list row only the button's own frame takes the tap, not the whole row.
          .buttonStyle(.borderless)
          .tint(Color(uiColor: Palette.accent))
          .accessibilityIdentifier("list.renameCancel")
        }
      }
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(UICopy.renameCounter(count, limit: SessionRename.maxLength))
          .monospacedDigit()
          .accessibilityIdentifier("list.renameCounter")
        Spacer(minLength: 4)
        Text(SessionRename.hint(hardwareKeyboard: hardwareKeyboard)).lineLimit(1)
      }
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: Palette.muted))
      // The field says its limit through the counter's value; the keys are for the eye.
      .accessibilityHidden(true)
    }
    .padding(.vertical, SessionListMetrics.agentRowPadding)
    // A view the list hands the next edit keeps its state: the counter starts from the new edit's name.
    .onChange(of: edit) { count = initial.utf16.count }
  }
}

/// `UITextField` behind the field: it takes the limit and line breaks of `SessionRename.edit` keystroke by keystroke,
/// selects the whole name when it gets focus, hears Esc from a hardware keyboard and ends as a cancel on a tap beside
/// it in the list.
private struct RenameTextField: UIViewRepresentable {
  let initial: String
  /// The edit this field serves (`SessionRenamer.edit`).
  let edit: Int
  let changed: (String) -> Void
  let save: (String) -> Void
  let cancel: () -> Void

  func makeUIView(context: Context) -> RenameTextFieldView {
    RenameTextFieldView()
  }

  func updateUIView(_ field: RenameTextFieldView, context: Context) {
    field.onChange = changed
    field.onSave = save
    field.onCancel = cancel
    field.start(edit, text: initial)
  }
}

final class RenameTextFieldView: UITextField, UITextFieldDelegate {
  var onChange: ((String) -> Void)?
  var onSave: ((String) -> Void)?
  var onCancel: (() -> Void)?
  /// Return or Esc ended the field: the loss of focus that follows is not a cancel.
  private var finished = false
  private var focusAttempts = 0
  /// Taps on the list while the field is open (`watchTapsBeside`).
  private var tapBeside: TapBeside?

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    font = TextStyleScaling.font(.subheadline, category: TextScale.shared.effective)
    adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    textColor = Palette.text
    tintColor = Palette.accent
    returnKeyType = .done
    autocorrectionType = .no
    spellCheckingType = .no
    smartQuotesType = .no
    smartDashesType = .no
    clearButtonMode = .never
    accessibilityIdentifier = "list.renameField"
    accessibilityLabel = UICopy.renameFieldLabel
    addTarget(self, action: #selector(edited), for: .editingChanged)
    setContentHuggingPriority(.required, for: .vertical)
    // On the flat path (a Mac) a step of the app's text size sends no trait change: the font follows the model.
    Fonts.follow(self, scale: .shared) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.font = TextStyleScaling.font(.subheadline, category: TextScale.shared.effective)
      self.invalidateIntrinsicContentSize()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// Esc from a hardware keyboard cancels: a key command with priority over the system, as in the message field.
  override var keyCommands: [UIKeyCommand]? {
    let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeKey))
    escape.wantsPriorityOverSystemBehavior = true
    escape.repeatBehavior = .nonRepeatable
    return [escape]
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    // While a character is being composed (IME), Esc belongs to the editor.
    if action == #selector(escapeKey) { return markedTextRange == nil }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc private func escapeKey() {
    EscapeGrace.closedByEscape()
    finish { $0.onCancel?() }
  }

  @objc private func edited() {
    onChange?(text ?? "")
  }

  /// The edit the field serves (`SessionRenamer.edit`); `nil` before the first.
  private(set) var edit: Int?

  /// The field serves edit `edit`, starting with `initial`. The list may hand the next edit of a row this same view
  /// (`makeUIView` does not run again), so a new number starts it over: the name, Return, the tap beside and the focus
  /// with the whole name selected. The same number, any later update of the list, leaves the typing alone.
  func start(_ edit: Int, text initial: String) {
    guard edit != self.edit else { return }
    self.edit = edit
    finished = false
    text = initial
    focusAttempts = 0
    if isFirstResponder {
      selectedTextRange = textRange(from: beginningOfDocument, to: endOfDocument)
      watchTapsBeside()
    } else {
      // Not inside the list's update: the focus comes on the next turn of the main loop, as its retries do.
      DispatchQueue.main.async { [weak self] in self?.focus() }
    }
  }

  /// The field takes focus as soon as it is in the window. The context menu that opened it may still be leaving and
  /// refuse the first attempt, so it tries again for a moment.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      tapBeside?.detach()
      return
    }
    focusAttempts = 0
    focus()
  }

  private func focus() {
    guard window != nil, !finished, !isFirstResponder else { return }
    if becomeFirstResponder() {
      selectedTextRange = textRange(from: beginningOfDocument, to: endOfDocument)
      return
    }
    focusAttempts += 1
    guard focusAttempts < 20 else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.focus() }
  }

  private func finish(_ action: (RenameTextFieldView) -> Void) {
    guard !finished else { return }
    finished = true
    tapBeside?.detach()
    action(self)
  }

  /// UIKit does not end editing on a tap elsewhere, so the list the field stands in (the nearest scroll view above
  /// it) gets a tap recognizer for as long as the field is open.
  private func watchTapsBeside() {
    guard !finished, tapBeside?.attached != true else { return }
    var view = superview
    while let current = view, !(current is UIScrollView) { view = current.superview }
    guard let list = view else { return }
    let watcher = tapBeside ?? TapBeside(field: self)
    watcher.attach(to: list)
    tapBeside = watcher
  }

  /// A tap at `point` (in the field's coordinates): beside the field it ends the field as a cancel, the way Esc does.
  /// The field leaves the list and its focus goes with it. It does not resign the focus itself: on the iOS 27
  /// simulator that ended in the collection view's first responder assertion during the list's next update.
  func tapped(at point: CGPoint) {
    guard !bounds.contains(point) else { return }
    finish { $0.onCancel?() }
  }

  // MARK: UITextFieldDelegate

  func textField(
    _ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String
  ) -> Bool {
    let current = text ?? ""
    let proposed = (current as NSString).replacingCharacters(in: range, with: string)
    let kept = SessionRename.edit(current, replacing: range, with: string)
    guard kept.text != proposed else { return true }
    // Past the limit or with a line break: only what fits goes in, a line break becomes a space, the rest of the
    // name stays. The caret moves after the kept part even when the text stays the same, so a selection the paste
    // covered does not stay for the next key to replace.
    if kept.text != current { text = kept.text }
    if let caret = position(from: beginningOfDocument, offset: kept.caret) {
      selectedTextRange = textRange(from: caret, to: caret)
    }
    if kept.text != current { edited() }
    return false
  }

  func textFieldDidBeginEditing(_ textField: UITextField) {
    watchTapsBeside()
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    finish { $0.onSave?($0.text ?? "") }
    return false
  }

  func textFieldDidEndEditing(_ textField: UITextField) {
    finish { $0.onCancel?() }
  }
}

/// The tap recognizer `RenameTextFieldView` puts on its list. It takes no touch from the list: a tap on another row
/// still opens that row, and a tap on the field itself stays the field's.
final class TapBeside: NSObject, UIGestureRecognizerDelegate {
  private weak var field: RenameTextFieldView?
  private var recognizer: UITapGestureRecognizer?

  init(field: RenameTextFieldView) {
    self.field = field
  }

  var attached: Bool { recognizer?.view != nil }

  func attach(to list: UIView) {
    detach()
    let recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    recognizer.cancelsTouchesInView = false
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
    recognizer.delegate = self
    list.addGestureRecognizer(recognizer)
    self.recognizer = recognizer
  }

  func detach() {
    if let recognizer { recognizer.view?.removeGestureRecognizer(recognizer) }
    recognizer = nil
  }

  @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended, let field else { return }
    field.tapped(at: recognizer.location(in: field))
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard let field else { return false }
    return !field.bounds.contains(touch.location(in: field))
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

/// A double click with a pointer (trackpad, mouse) on an agent row opens its field. The recognizer sits on the list
/// cell and takes pointer clicks only: a finger tap never waits for a second tap and opens the session at once, as
/// before. It takes nothing from the list: a single click selects the row as always.
struct RenameDoubleClick: UIViewRepresentable {
  let open: () -> Void

  func makeUIView(context: Context) -> RenameDoubleClickView {
    RenameDoubleClickView()
  }

  func updateUIView(_ view: RenameDoubleClickView, context: Context) {
    view.onDoubleClick = open
    view.attach()
  }
}

final class RenameDoubleClickView: UIView, UIGestureRecognizerDelegate {
  var onDoubleClick: (() -> Void)?
  private(set) var recognizer: UITapGestureRecognizer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { attach() } else { detach() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    attach()
  }

  /// The cell the row stands in (`nil` before it is in a window).
  private var cell: UICollectionViewCell? {
    var view = superview
    while let current = view {
      if let cell = current as? UICollectionViewCell { return cell }
      view = current.superview
    }
    return nil
  }

  /// One recognizer per cell; a view that moved to another cell takes it off the old one.
  func attach() {
    guard let cell else { return }
    if let recognizer, recognizer.view === cell { return }
    detach()
    let recognizer = UITapGestureRecognizer(target: self, action: #selector(clicked(_:)))
    Self.configure(recognizer)
    recognizer.delegate = self
    cell.addGestureRecognizer(recognizer)
    self.recognizer = recognizer
  }

  func detach() {
    if let recognizer { recognizer.view?.removeGestureRecognizer(recognizer) }
    recognizer = nil
  }

  /// Two clicks of a pointer only; touches reach the list unchanged and undelayed.
  static func configure(_ recognizer: UITapGestureRecognizer) {
    recognizer.numberOfTapsRequired = 2
    recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    recognizer.cancelsTouchesInView = false
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
  }

  @objc private func clicked(_ recognizer: UITapGestureRecognizer) {
    if recognizer.state == .ended { onDoubleClick?() }
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }
}
#endif
