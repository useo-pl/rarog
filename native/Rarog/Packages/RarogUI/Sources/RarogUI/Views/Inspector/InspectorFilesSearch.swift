#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// The controls under the Files header of the right panel: the Files / Changed only toggle and the file search field
// with its `.*` and clear buttons. The search itself runs in `FileSearchRunner`; the rules are `Model/FileSearch.swift`.
// Owner: session files (native app).

/// What the controls under the Files header show and do.
@MainActor
struct InspectorFilesControls {
  /// The toggle's choice; `nil` = no toggle (the fallback tree has only changes anyway).
  var mode: FileTreeMode?
  var setMode: (FileTreeMode) -> Void
  /// The search field stands.
  var searchShown: Bool
  var text: String
  var setText: (String) -> Void
  var regex: Bool
  var setRegex: (Bool) -> Void
  /// Esc in an EMPTY field goes on to the container (the phone sheet closes); `false` = the field keeps it and does
  /// nothing, so it never reaches the session screen.
  var emptyEscapeGoesOn: Bool
  /// Try Again after the file list failed.
  var retry: () -> Void

  /// No toggle and no field.
  static let hidden = InspectorFilesControls(
    mode: nil, setMode: { _ in }, searchShown: false, text: "", setText: { _ in }, regex: false, setRegex: { _ in },
    emptyEscapeGoesOn: false, retry: {})
}

/// Files / Changed Only in the look of the filter over the session list (`ListFilterBar`): one glass capsule, equal
/// segments, the active one on a capsule plate, a segment under the pointer on the plate at half opacity.
struct InspectorFilesModePicker: View {
  let mode: FileTreeMode
  let setMode: (FileTreeMode) -> Void

  var body: some View {
    HStack(spacing: 0) {
      ForEach(FileTreeMode.allCases, id: \.self) { option in
        RarogHoverReader { hovered in segment(option, hovered: hovered) }
      }
    }
    .background { FilterGlass(shape: Capsule()) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(UICopy.inspectorFilesModeLabel)
    .accessibilityIdentifier("inspector.files.mode")
  }

  private func segment(_ option: FileTreeMode, hovered: Bool) -> some View {
    let active = option == mode
    return Button {
      setMode(option)
    } label: {
      Text(UICopy.inspectorFilesMode(option))
        .appFont(.subheadline.weight(active ? .semibold : .regular))
        .foregroundStyle(Color(uiColor: active || hovered ? Palette.text : Palette.text2))
        .lineLimit(1)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: ListFilterBar.plateHeight)
        .background {
          let plate = Color(uiColor: Palette.filterGlassPlate)
          if active {
            Capsule().fill(plate)
          } else if hovered {
            Capsule().fill(plate.opacity(HoverTokens.agentRowAlpha))
          }
        }
        .padding(ListFilterBar.trackInset)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityIdentifier("inspector.files.mode.\(option.rawValue)")
  }
}

/// The search field: a magnifier, the text, "×" while there is text, and `.*` (a regular expression, lit when on).
struct InspectorFilesSearchField: View {
  let controls: InspectorFilesControls

  var body: some View {
    HStack(spacing: 2) {
      Image(systemName: "magnifyingglass")
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .padding(.leading, 8)
        .accessibilityHidden(true)
      FileSearchTextField(
        text: controls.text, setText: controls.setText, emptyEscapeGoesOn: controls.emptyEscapeGoesOn)
        .frame(maxWidth: .infinity)
      if !controls.text.isEmpty {
        button(symbol: "xmark.circle.fill", ink: Palette.muted) { controls.setText("") }
          .accessibilityLabel(UICopy.inspectorFilesSearchClear)
          .accessibilityIdentifier("inspector.files.searchClear")
      }
      Button { controls.setRegex(!controls.regex) } label: {
        Text(".*")
          .appFont(.footnote.monospaced().weight(.semibold))
          .foregroundStyle(Color(uiColor: controls.regex ? Palette.accent : Palette.muted))
          .frame(width: FileSearchFieldMetrics.button, height: FileSearchFieldMetrics.button)
          .background(
            controls.regex ? Color(uiColor: Palette.accent).opacity(0.14) : .clear, in: RoundedRectangle.inner)
          .contentShape(Rectangle())
          .rarogHover(.fill, in: RoundedRectangle.inner)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(UICopy.inspectorFilesSearchRegex)
      .accessibilityAddTraits(controls.regex ? .isSelected : [])
      .accessibilityIdentifier("inspector.files.searchRegex")
      .padding(.trailing, 2)
    }
    .frame(minHeight: FileSearchFieldMetrics.height)
    .background(RoundedRectangle.inner.fill(Color(uiColor: Palette.input)))
  }

  private func button(symbol: String, ink: UIColor, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: ink))
        .frame(width: FileSearchFieldMetrics.button, height: FileSearchFieldMetrics.button)
        .contentShape(Rectangle())
        .rarogHover(.fill, in: RoundedRectangle.inner)
    }
    .buttonStyle(.plain)
  }
}

private enum FileSearchFieldMetrics {
  /// The field's height at the default text size.
  static let height: CGFloat = 36
  /// The clear and `.*` buttons, square.
  static let button: CGFloat = 32
}

/// `UITextField` behind the search field: SwiftUI's field cannot take Esc before the key commands above it (the phone
/// sheet closes on Esc), so the field offers its own.
private struct FileSearchTextField: UIViewRepresentable {
  let text: String
  let setText: (String) -> Void
  let emptyEscapeGoesOn: Bool

  func makeUIView(context: Context) -> FileSearchTextFieldView {
    let field = FileSearchTextFieldView()
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
  }

  func updateUIView(_ field: FileSearchTextFieldView, context: Context) {
    field.onChange = setText
    field.emptyEscapeGoesOn = emptyEscapeGoesOn
    // A clear by "×" or a text kept for the session comes from outside; typing does not echo back.
    if field.text != text { field.text = text }
  }
}

/// The field: no autocorrection or capitals (paths), Return ends the editing, and Esc from a hardware keyboard clears
/// a non-empty field and does nothing else. An empty field keeps Esc in the panel column and lets it go on in the
/// phone sheet. While a character is being composed, Esc belongs to the editor.
final class FileSearchTextFieldView: UITextField, UITextFieldDelegate {
  var onChange: ((String) -> Void)?
  var emptyEscapeGoesOn = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    font = TextStyleScaling.font(.footnote, category: TextScale.shared.effective, design: .monospaced)
    adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    textColor = Palette.text
    tintColor = Palette.accent
    attributedPlaceholder = NSAttributedString(
      string: UICopy.inspectorFilesSearchPlaceholder, attributes: [.foregroundColor: Palette.muted])
    returnKeyType = .search
    autocorrectionType = .no
    autocapitalizationType = .none
    spellCheckingType = .no
    smartQuotesType = .no
    smartDashesType = .no
    smartInsertDeleteType = .no
    clearButtonMode = .never
    accessibilityIdentifier = "inspector.files.search"
    accessibilityLabel = UICopy.inspectorFilesSearchPlaceholder
    addTarget(self, action: #selector(edited), for: .editingChanged)
    Fonts.follow(self, scale: .shared) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.font = TextStyleScaling.font(.footnote, category: TextScale.shared.effective, design: .monospaced)
      self.invalidateIntrinsicContentSize()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// Esc with priority over the system, as in the message field.
  override var keyCommands: [UIKeyCommand]? {
    let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeKey))
    escape.wantsPriorityOverSystemBehavior = true
    escape.repeatBehavior = .nonRepeatable
    return [escape]
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(escapeKey) {
      guard markedTextRange == nil else { return false }
      return !(text ?? "").isEmpty || !emptyEscapeGoesOn
    }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc private func escapeKey() {
    guard !(text ?? "").isEmpty else { return }
    // A second quick Esc after the clear does not interrupt the turn either.
    EscapeGrace.closedByEscape()
    text = ""
    edited()
  }

  @objc private func edited() {
    onChange?(text ?? "")
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    resignFirstResponder()
    return false
  }
}
#endif
