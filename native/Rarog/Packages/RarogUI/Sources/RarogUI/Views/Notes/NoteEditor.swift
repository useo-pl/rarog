#if os(iOS)
import RarogContract
import SwiftUI
import UIKit

// Pole notatki projektu: `UITextView` (UIKit, jak pole wiadomości) związany z dokumentem. Tekst należy do
// modelu (`NoteDocument`): pole zgłasza każdą zmianę, a zmianę z modelu (odświeżenie z drugiego urządzenia,
// „Połącz", „Przywróć", dyktowanie) przyjmuje bez ruszania kursora tam, gdzie się da. Sufit dokumentu liczy jednostki
// UTF-16, jak serwer: wpisanie i wklejka ponad sufit nie wchodzą. Składnię markdownu pokazuje „lustro" (`NoteMirror`):
// same atrybuty, żaden znak nie znika. Właściciel: notatki (apka natywna).

/// Pole z placeholderem w dwóch liniach.
final class NoteTextView: UITextView {
  private let placeholder = UILabel()
  /// Pole ma wziąć klawiaturę, gdy stanie w oknie (wejście „Edytuj", ⌘J, pusta notatka); przy dyktowaniu z dymka — nie.
  var wantsFocus = false
  private var focusAttempts = 0
  /// Bieżący pierwszy respondent — wstrzykiwany w testach.
  var currentResponder: @MainActor () -> UIResponder? = { FirstResponder.current() }
  /// Esc z klawiatury sprzętowej: `UITextView` go połyka, więc zamknięcie formularza idzie własnym skrótem
  /// z pierwszeństwem, jak w polu wiadomości.
  var onEscape: (() -> Void)?
  /// Atrament tekstu (wygaszony, gdy pole jest tylko do odczytu). Nie `textColor`: ten nadpisałby kolory lustra.
  var ink: UIColor = Palette.text {
    didSet { if ink != oldValue { applyMirror() } }
  }
  /// Kod w linii o dwa punkty mniejszy od tekstu (15 przy 17), jak w specyfikacji pola.
  static let codeScale: CGFloat = 15.0 / 17.0
  /// The app's text size the field follows; tests give their own.
  var textScale: TextScale = .shared {
    didSet {
      followTextScale()
      if TextStyleScaling.isFlat { applyTextSize() }
    }
  }

  override var keyCommands: [UIKeyCommand]? {
    let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeKey))
    escape.wantsPriorityOverSystemBehavior = true
    escape.repeatBehavior = .nonRepeatable
    return [escape]
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    // W trakcie składania znaku (IME) Esc należy do edytora.
    if action == #selector(escapeKey) { return markedTextRange == nil && onEscape != nil }
    return super.canPerformAction(action, withSender: sender)
  }

  @objc private func escapeKey() {
    EscapeGrace.closedByEscape()
    onEscape?()
  }

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    font = TextStyleScaling.font(.body, category: textScale.effective)
    adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    textColor = Palette.text
    backgroundColor = .clear
    tintColor = Palette.text
    textContainerInset = UIEdgeInsets(top: 8, left: 16, bottom: 16, right: 16)
    self.textContainer.lineFragmentPadding = 0
    keyboardDismissMode = .interactive
    alwaysBounceVertical = true
    accessibilityIdentifier = "note.editor"
    accessibilityLabel = UICopy.noteProject
    placeholder.text = UICopy.notePlaceholder
    placeholder.numberOfLines = 0
    placeholder.font = TextStyleScaling.font(.body, category: textScale.effective)
    placeholder.adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    placeholder.textColor = Palette.muted2
    placeholder.isAccessibilityElement = false
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    addSubview(placeholder)
    NSLayoutConstraint.activate([
      placeholder.topAnchor.constraint(equalTo: topAnchor, constant: textContainerInset.top),
      placeholder.leadingAnchor.constraint(equalTo: frameLayoutGuide.leadingAnchor, constant: textContainerInset.left),
      placeholder.trailingAnchor.constraint(
        lessThanOrEqualTo: frameLayoutGuide.trailingAnchor, constant: -textContainerInset.right),
    ])
    // Lustro ma rozmiary z pisma systemu: zmiana wielkości pisma liczy atrybuty od nowa.
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (view: NoteTextView, _) in
      view.applyMirror()
    }
    followTextScale()
  }

  /// On the flat path (a Mac) the system sends no trait change for a step of the app's text size, so the field
  /// follows the model: the fonts again, with the selection and the typing attributes `applyMirror()` keeps.
  private func followTextScale() {
    Fonts.follow(self, scale: textScale) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.applyTextSize()
    }
  }

  /// The body font of the model's category on the placeholder, the field and the mirror. While a character is being
  /// composed (IME) only the placeholder changes: the end of the composition runs the mirror with the new size.
  private func applyTextSize() {
    let body = TextStyleScaling.font(.body, category: textScale.effective)
    placeholder.font = body
    guard markedTextRange == nil else { return }
    let selection = selectedRange
    font = body
    if selectedRange != selection { selectedRange = selection }
    applyMirror()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  func updatePlaceholder() {
    placeholder.isHidden = !text.isEmpty
  }

  /// Wpisuje tekst z modelu: kursor zostaje na swoim miejscu (przycięty do nowej długości), chyba że stał na końcu.
  func adopt(_ value: String) {
    let old = (text ?? "") as NSString
    let selection = voiceSelection(old: selectedRange, oldLength: old.length, newLength: (value as NSString).length)
    text = value
    selectedRange = selection
    updatePlaceholder()
    applyMirror()
  }

  /// „Lustro" markdownu: atrybuty z ról `NoteMirror` na tekście pola — bez zmiany znaków i zaznaczenia. W trakcie
  /// składania znaku (IME) czeka: zmiana atrybutów zerwałaby kompozycję, a jej koniec i tak zgłasza zmianę pola.
  func applyMirror() {
    guard markedTextRange == nil else { return }
    let body = TextStyleScaling.font(.body, category: textScale.effective, traits: traitCollection)
    let base: [NSAttributedString.Key: Any] = [.font: body, .foregroundColor: ink]
    let storage = textStorage
    let string = storage.string as NSString
    let selection = selectedRange
    storage.beginEditing()
    storage.setAttributes(base, range: NSRange(location: 0, length: storage.length))
    for span in NoteMirror.spans(storage.string) {
      storage.addAttributes(Self.attributes(span, body: body, string: string), range: span.range)
    }
    storage.endEditing()
    if selectedRange != selection { selectedRange = selection }
    // Wpisywany znak dziedziczyłby krój sąsiada (kod, nagłówek) do następnego przeliczenia.
    typingAttributes = base
  }

  static func attributes(
    _ span: NoteMirror.Span, body: UIFont, string: NSString
  ) -> [NSAttributedString.Key: Any] {
    switch span.role {
    case .marker:
      return [.foregroundColor: Palette.muted2]
    case .heading, .bold:
      return [.font: UIFont.systemFont(ofSize: body.pointSize, weight: .semibold)]
    case .code:
      return [
        .font: UIFont.monospacedSystemFont(ofSize: (body.pointSize * codeScale).rounded(), weight: .regular),
        .foregroundColor: Palette.inlineCodeInk, .backgroundColor: Palette.inlineCodeBackground,
      ]
    case .link:
      return [.foregroundColor: Palette.linkInk]
    case let .listItem(prefix):
      // Wiszące wcięcie: zawinięta pozycja listy nie wraca pod znacznik.
      let marker = string.substring(with: NSRange(location: span.range.location, length: prefix))
      let style = NSMutableParagraphStyle()
      style.headIndent = ceil((marker as NSString).size(withAttributes: [.font: body]).width)
      return [.paragraphStyle: style]
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    focusAttempts = 0
    takeKeyboard()
  }

  /// Klawiatura od kotwicy formularza (`SheetKeyboardAnchor` bierze ją pierwsza po pokazaniu arkusza), potem kursor
  /// na końcu. Wzór: tekst okna historii terminala — kilka prób w odstępach, bo kotwica łapie ją w następnym obrocie.
  func takeKeyboard() {
    guard wantsFocus, window != nil, !isFirstResponder, isEditable else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + (focusAttempts == 0 ? 0 : 0.15)) { [weak self] in
      guard let self, self.wantsFocus, self.window != nil, !self.isFirstResponder, self.isEditable else { return }
      if SheetKeyboardAnchor.handKeyboard(to: self, from: self.currentResponder()) {
        self.wantsFocus = false
        self.moveCursorToEnd()
        return
      }
      self.focusAttempts += 1
      if self.focusAttempts < 8 { self.takeKeyboard() }
    }
  }

  /// Kursor na końcu (wejście „Edytuj", ⌘J).
  func moveCursorToEnd() {
    selectedRange = NSRange(location: (text as NSString? ?? "").length, length: 0)
    scrollRangeToVisible(selectedRange)
  }
}

/// Pole notatki w SwiftUI.
struct NoteEditor: UIViewRepresentable {
  let doc: NoteDocument
  /// Klawiatura od razu (wejście do pisania); przy dyktowaniu z dymka — nie.
  let focus: Bool
  /// Pole ma fokus (pasek nad klawiaturą pokazuje „Gotowe").
  @Binding var editing: Bool
  /// Wklejka ponad sufit: ile ma, ile zostało (zdanie w wierszu stanu).
  let rejected: (_ paste: Int, _ left: Int) -> Void
  /// Pole w UIKit dla gospodarza dyktowania i „Gotowe".
  let attach: (NoteTextView) -> Void
  /// Esc w polu: zamknięcie formularza.
  let close: () -> Void
  /// Człowiek zmienił pole (klawiatura, wklejka) — dyktowanie w trakcie bierze nowy punkt startu.
  let userEdit: () -> Void

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: NoteEditor

    init(_ parent: NoteEditor) {
      self.parent = parent
    }

    func textViewDidChange(_ textView: UITextView) {
      (textView as? NoteTextView)?.updatePlaceholder()
      (textView as? NoteTextView)?.applyMirror()
      parent.doc.edit(textView.text ?? "")
      parent.userEdit()
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      let current = (textView.text ?? "").utf16.count
      let next = current - range.length + text.utf16.count
      guard next > NotesRules.maxUnits, next > current else { return true }
      // Wklejka (więcej niż znak) mówi, ile ma i ile zostało; pojedynczy znak po prostu nie wchodzi.
      if text.utf16.count > 1 { parent.rejected(text.utf16.count, max(0, NotesRules.maxUnits - current + range.length)) }
      return false
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      parent.editing = true
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      parent.editing = false
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> NoteTextView {
    let view = NoteTextView(frame: .zero, textContainer: nil)
    view.delegate = context.coordinator
    view.text = doc.text
    view.isEditable = doc.editable
    view.updatePlaceholder()
    view.applyMirror()
    view.wantsFocus = focus
    view.onEscape = close
    attach(view)
    return view
  }

  func updateUIView(_ view: NoteTextView, context: Context) {
    context.coordinator.parent = self
    let editable = doc.editable
    if view.isEditable != editable {
      view.isEditable = editable
      if editable { view.takeKeyboard() } else { view.resignFirstResponder() }
    }
    view.ink = editable ? Palette.text : Palette.text2
    // Zmiana z modelu; w trakcie składania znaku (IME) pole należy do edytora.
    if view.text != doc.text, view.markedTextRange == nil { view.adopt(doc.text) }
  }
}
#endif
