#if os(iOS)
import RarogContract
import UIKit

/// Lista podpowiedzi slash-komend nad kartą pola wiadomości. Stoi w hierarchii pola
/// (`ComposerView`), nie w regionie klawiatury: dodatek nad klawiaturą SwiftUI liczy jak klawiaturę, a ta podnosi
/// układ (pigułka paska skrótów). Unosi się nad transkryptem, więc nie przesuwa ani listy, ani pola.
///
/// Wygląd jak dymki apki: pełne `surface`, kreska `border`, promień bloku, bez szkła i bez cienia (karta pola też
/// go nie ma). Wiersz w jednej linii: `/nazwa` mono w atramencie tekstu, podpowiedź argumentu wygaszona, opis
/// w `muted`, ucinany na końcu. Zaznaczenie (klawiatura sprzętowa) i dotyk to płytka `switcherSelection`, jak
/// wiersz przełącznika sesji; tekst drugorzędny zaznaczonego wiersza idzie wtedy w `muted`. 1–6 wierszy, reszta
/// przewija się w środku. Pojawia się i znika od razu, bez animacji. Właściciel: pole.
final class CommandSuggestionsView: UIView {
  /// Odstęp listy od karty pola.
  static let gap: CGFloat = 6
  /// Wcięcie wierszy od krawędzi listy (płytka zaznaczenia stoi w środku bloku).
  static let inset: CGFloat = 4

  /// Stuknięcie w wiersz (palec, wskaźnik, VoiceOver).
  var onPick: ((Int) -> Void)?

  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var rows: [CommandSuggestionRow] = []
  private var choices: [CommandChoice] = []
  private var selected = 0
  private var showsSelection = false
  private var height: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  private func build() {
    backgroundColor = Palette.surface
    layer.roundCorners(Radius.block)
    layer.borderWidth = 1
    layer.borderColor = Palette.border.resolvedColor(with: traitCollection).cgColor
    clipsToBounds = true
    isHidden = true

    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.alwaysBounceVertical = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.keyboardDismissMode = .none
    scroll.accessibilityIdentifier = "commands.suggestions"
    scroll.accessibilityLabel = UICopy.commandSuggestionsLabel
    stack.axis = .vertical
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scroll)
    scroll.addSubview(stack)

    height = heightAnchor.constraint(equalToConstant: 0)
    // Pod sufitem ekranu (góra safe area, `SessionViewController+CommandSuggestions`) lista się skraca i przewija.
    height.priority = .required - 1
    NSLayoutConstraint.activate([
      height,
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Self.inset),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Self.inset),
      // Treść tak szeroka jak lista: przewija się wyłącznie w pionie.
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: Self.inset),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -Self.inset),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * Self.inset),
    ])
    registerForTraitChanges([
      UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self, UITraitPreferredContentSizeCategory.self,
    ]) { (self: CommandSuggestionsView, _: UITraitCollection) in
      // Kolor warstwy z cech widoku (motyw i „Zwiększ kontrast”); pismo wiersza przebudowuje wiersze i wysokość.
      self.layer.borderColor = Palette.border.resolvedColor(with: self.traitCollection).cgColor
      self.rebuild()
    }
    // On the flat path (a Mac) a step of the app's text size changes no trait: the rows take the new size.
    Fonts.follow(self) { [weak self] in self?.rebuild() }
  }

  /// Wiersze do pokazania (pusto = lista schowana), zaznaczony wiersz i czy zaznaczenie widać (klawiatura sprzętowa:
  /// tylko wtedy Return i Tab wstawiają zaznaczoną komendę). `reveal` = zaznaczenie właśnie przesunął klawisz, więc
  /// lista przewija się do niego; render bez klawisza nie rusza przewinięcia palcem.
  func show(_ choices: [CommandChoice], selected: Int, showsSelection: Bool, reveal: Bool = false) {
    let changed = choices != self.choices
    self.choices = choices
    self.selected = selected
    self.showsSelection = showsSelection
    if changed {
      rebuild()
      scroll.contentOffset = .zero
    } else {
      for (index, row) in rows.enumerated() { row.marked = showsSelection && index == selected }
    }
    if reveal { revealSelected() }
  }

  /// Wysokość wiersza: jedna linia pisma wiersza i oddech, co najmniej cel dotyku 44 pt.
  private var rowHeight: CGFloat {
    max(44, ceil(CommandSuggestionRow.lineHeight(traits: traitCollection) + 2 * CommandSuggestionRow.padding))
  }

  private func rebuild() {
    for row in rows { row.removeFromSuperview() }
    let rowHeight = rowHeight
    rows = choices.enumerated().map { index, choice in
      let row = CommandSuggestionRow(choice: choice)
      row.marked = showsSelection && index == selected
      row.heightAnchor.constraint(equalToConstant: rowHeight).isActive = true
      // Zwykły `UIControl` nie wysyła `.primaryActionTriggered` (robi to `UIButton`): stuknięcie to `.touchUpInside`,
      // także aktywacja VoiceOvera (dotyk w punkcie aktywacji).
      row.addAction(UIAction { [weak self] _ in self?.onPick?(index) }, for: .touchUpInside)
      stack.addArrangedSubview(row)
      return row
    }
    let visible = min(choices.count, CommandSuggestions.visibleRows)
    height.constant = visible == 0 ? 0 : CGFloat(visible) * rowHeight + 2 * Self.inset
  }

  /// Zaznaczony wiersz w widocznej części listy (↑/↓ przy dłuższej liście).
  private func revealSelected() {
    guard rows.indices.contains(selected) else { return }
    layoutIfNeeded()
    let frame = rows[selected].convert(rows[selected].bounds, to: scroll).insetBy(dx: 0, dy: -Self.inset)
    scroll.scrollRectToVisible(frame, animated: false)
  }

  /// Wiersze listy (testy UIKit).
  var rowViews: [UIControl] { rows }
}

/// Wiersz listy: przycisk na całą szerokość, płytka zaznaczenia pod palcem i przy zaznaczeniu z klawiatury.
final class CommandSuggestionRow: UIControl {
  /// Oddech nad i pod linią tekstu.
  static let padding: CGFloat = 10
  private static let textInset: CGFloat = 10

  let choice: CommandChoice
  private let label = UILabel()

  /// Zaznaczony z klawiatury sprzętowej.
  var marked = false {
    didSet {
      guard marked != oldValue else { return }
      restyle()
    }
  }

  override var isHighlighted: Bool {
    didSet { restyle() }
  }

  init(choice: CommandChoice) {
    self.choice = choice
    super.init(frame: .zero)
    layer.roundCorners(Radius.inner)
    label.numberOfLines = 1
    label.lineBreakMode = .byTruncatingTail
    label.isUserInteractionEnabled = false
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.textInset),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.textInset),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityLabel = UICopy.commandSuggestionLabel(choice)
    accessibilityHint = UICopy.commandSuggestionHint
    accessibilityIdentifier = "commands.suggestion.\(choice.name)"
    restyle()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Wysokość linii najwyższego pisma wiersza.
  static func lineHeight(traits: UITraitCollection) -> CGFloat {
    max(nameFont(traits).lineHeight, detailFont(traits).lineHeight)
  }

  private static func nameFont(_ traits: UITraitCollection) -> UIFont { Fonts.mono(.subheadline, traits: traits) }
  private static func detailFont(_ traits: UITraitCollection) -> UIFont { Fonts.text(.footnote, traits: traits) }
  private static func hintFont(_ traits: UITraitCollection) -> UIFont { Fonts.mono(.footnote, traits: traits) }

  private func restyle() {
    let plate = marked || isHighlighted
    backgroundColor = plate ? Palette.switcherSelection : .clear
    // `muted2` nie trzyma 4,5:1 na płytce zaznaczenia (`PaletteContrastTests`), więc zaznaczony wiersz bierze `muted`.
    let quiet = plate ? Palette.muted : Palette.muted2
    let text = NSMutableAttributedString(
      string: "/\(choice.name)",
      attributes: [.font: Self.nameFont(traitCollection), .foregroundColor: Palette.text])
    if let hint = choice.argumentHint {
      text.append(NSAttributedString(
        string: " \(hint)", attributes: [.font: Self.hintFont(traitCollection), .foregroundColor: quiet]))
    }
    if let detail = choice.description {
      text.append(NSAttributedString(
        string: "  \(detail)", attributes: [.font: Self.detailFont(traitCollection), .foregroundColor: Palette.muted]))
    }
    label.attributedText = text
    accessibilityTraits = marked ? [.button, .selected] : .button
  }
}
#endif
