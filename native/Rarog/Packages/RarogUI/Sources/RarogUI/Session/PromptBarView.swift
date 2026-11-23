#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Pasek cytatu promptu nad transkryptem i arkusz „Prompty w tej sesji". Pasek leży NA
// treści (nie przesuwa układu), u góry transkryptu — pola ani stopki karty nie zasłania; cel dotyku
// 44 pt. Właściciel: sterowanie sesją.

/// The bar: a quote icon and one line of the prompt on the prompt bubble's background: a full `userPlate` without
/// glass or a frame, the bubble's radius, the bubble's text insets, as wide as its content and at most the bubble's cap
/// (``MessageContentView/plateCap(_:spacing:)``). The session screen gives its leading edge and the column's cap. A tap
/// opens the list of turns.
final class PromptBarView: UIControl {
  /// Visible height: 14 pt text with a tight vertical inset. The touch target stays 44 pt
  /// (`point(inside:with:)`).
  static let visibleHeight: CGFloat = 39
  /// Wstawka treści od lewej i prawej krawędzi tła — jak tekst w dymku promptu.
  static let inset: CGFloat = MessageContentView.plateHorizontal
  /// The quote's font: `footnote` + 1 pt (14 pt at the default size), scaled by `footnote` with the text size.
  static func quoteFont() -> UIFont {
    Fonts.scaled(.systemFont(ofSize: Fonts.base(.footnote) + 1), relativeTo: .footnote)
  }

  private let icon = UIImageView(image: UIImage(systemName: "text.quote"))
  private let label = UILabel()
  /// The width cap: the bubble's cap at the current text size, again after a change of text size or density.
  private var widthCap: NSLayoutConstraint!
  /// The transcript's density: the bar ends where the prompt bubble does. The session screen sets it.
  var spacing: TranscriptSpacing = .standard {
    didSet {
      guard spacing != oldValue else { return }
      applyCap()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    build()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  var quote: String = "" {
    didSet {
      label.text = quote.replacingOccurrences(of: "\n", with: " ")
      accessibilityLabel = UICopy.promptBarSpoken(quote)
    }
  }

  private func build() {
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityHint = UICopy.promptBarHint
    accessibilityIdentifier = "transcript.promptBar"
    // Tło pełne, więc zmniejszona przezroczystość niczego tu nie zmienia — wariantu dla niej nie ma.
    backgroundColor = Palette.userPlate
    layer.roundCorners(Radius.block)
    icon.tintColor = Palette.muted
    icon.setContentHuggingPriority(.required, for: .horizontal)
    icon.setContentCompressionResistancePriority(.required, for: .horizontal)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = Palette.text
    label.lineBreakMode = .byTruncatingTail
    label.numberOfLines = 1
    // As wide as its content: the label keeps its width and gives way with an ellipsis past the column's or the
    // bubble's cap.
    label.setContentHuggingPriority(.defaultHigh, for: .horizontal)
    label.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    for view in [icon, label] as [UIView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      view.isUserInteractionEnabled = false
    }
    addSubview(icon)
    addSubview(label)
    widthCap = widthAnchor.constraint(
      lessThanOrEqualToConstant: MessageContentView.plateCap(traitCollection, spacing: spacing))
    NSLayoutConstraint.activate([
      widthCap,
      heightAnchor.constraint(greaterThanOrEqualToConstant: Self.visibleHeight),
      icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset),
      icon.centerYAnchor.constraint(equalTo: centerYAnchor),
      label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
      label.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 5),
      label.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -5),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: PromptBarView, _: UITraitCollection) in
      self.applyCap()
    }
    applyFonts()
    Fonts.follow(self) { [weak self] in
      guard let self else { return }
      self.applyFonts()
      self.applyCap()
    }
  }

  private func applyCap() {
    widthCap.constant = MessageContentView.plateCap(traitCollection, spacing: spacing)
  }

  /// The quote's font and icon at the text size; again after a step on the flat path, where no trait change comes.
  private func applyFonts() {
    icon.preferredSymbolConfiguration =
      TextStyleScaling.isFlat
      ? UIImage.SymbolConfiguration(font: Fonts.text(.footnote))
      : UIImage.SymbolConfiguration(textStyle: .footnote)
    label.font = Self.quoteFont()
  }

  /// Cel dotyku 44 pt mimo niższego paska: obszar trafienia rośnie w pionie po równo.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let dy = max(0, (44 - bounds.height) / 2)
    return bounds.insetBy(dx: 0, dy: -dy).contains(point)
  }

  /// VoiceOver i Full Keyboard Access: aktywacja to tap.
  override func accessibilityActivate() -> Bool {
    sendActions(for: .touchUpInside)
    return true
  }

  /// Palec: tło dymku o ton jaśniejsze (ciemny) albo ciemniejsze (jasny), nie skala.
  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? Palette.userPlatePressed : Palette.userPlate }
  }
}

/// Arkusz „Prompty w tej sesji": prompt i godzina, od najnowszego u góry, bieżący
/// oznaczony; tap w wiersz skacze do tury. Lista startuje od góry, czyli od najnowszego, bez przewijania, a fokus
/// klawiatury stoi na pierwszym wierszu — strzałka w dół idzie w przeszłość. Tło pełne `surface`, nie szkło
/// popovera (systemowe szkło nad ciemnym transkryptem wychodzi szarą plamą, a godziny `muted2`
/// giną); bieżący prompt na tle dymku (`userPlate`), jak pasek, z którego arkusz wychodzi.
struct PromptListView: View {
  /// Prompty od najstarszego (`PromptBar.entries`).
  let entries: [PromptEntry]
  /// Numer wiadomości promptu, którego wynik stoi na ekranie.
  let currentSeq: Int?
  let select: (Int) -> Void
  @FocusState private var focused: Int?

  /// Tło arkusza: pełne, także pod strzałką popovera (ekran sesji ustawia je na kontrolerze).
  static let background = Palette.surface
  /// Godzina wiersza: `muted`, nie `muted2` jak przy dymku — `muted2` na tle dymku bieżącego wiersza ma ~4,2:1.
  static let clockInk = Palette.muted

  var body: some View {
    let ordered = PromptBar.listOrder(entries)
    let numbers = Dictionary(entries.enumerated().map { ($0.element.seq, $0.offset + 1) }) { first, _ in first }
    VStack(alignment: .leading, spacing: 0) {
      if !PopoverLayout.sheetBar {
        // Dymek iPada nie ma paska tytułu: nazwę niesie etykieta sekcji.
        Text(UICopy.promptsTitle)
          .eyebrow()
          .padding(.horizontal, PopoverLayout.contentInset)
          .padding(.top, 16)
          .padding(.bottom, 6)
          .accessibilityAddTraits(.isHeader)
      }
      if entries.isEmpty {
        Text(UICopy.promptsEmpty)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        List(ordered) { entry in
          row(entry, number: numbers[entry.seq] ?? 0, current: entry.seq == currentSeq)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .defaultFocus($focused, ordered.first?.seq)
      }
    }
    .popoverSheetChrome(title: UICopy.promptsTitle)
    .frame(minWidth: PopoverLayout.minWidth, idealWidth: PopoverLayout.idealWidth)
    .accessibilityIdentifier("prompts.sheet")
  }

  private func row(_ entry: PromptEntry, number: Int, current: Bool) -> some View {
    Button { select(entry.seq) } label: {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(entry.text)
          .appFont(.subheadline.weight(current ? .semibold : .regular))
          .foregroundStyle(Color(uiColor: Palette.text))
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(ServerTime.clock(entry.at) ?? "")
          .appFont(.footnote.monospacedDigit())
          .foregroundStyle(Color(uiColor: Self.clockInk))
      }
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focused($focused, equals: entry.seq)
    .listRowBackground(current ? Color(uiColor: Palette.userPlate) : Color.clear)
    .accessibilityLabel(UICopy.promptRowSpoken(entry, number: number, count: entries.count, current: current))
    .accessibilityAddTraits(current ? .isSelected : [])
    .accessibilityIdentifier("prompts.row.\(entry.seq)")
  }
}
#endif
