#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Właściciel: transkrypt.

extension Palette {
  /// Plama karty narzędzia: w ciemnym w pół drogi między tłem a kartą treści (widoczna, ale nie
  /// pcha się do przodu), w jasnym powierzchnia — czarna plama zabiłaby kontrast wyciszonej linii.
  static let toolCard = dynamic(PaletteTokens.toolCard)
}

/// Karta wywołania narzędzia: zwinięta linia „Narzędzie: cel" z bilansem
/// `+N −M`; tap rozwija pełne wejście bit w bit z klikalnymi adresami albo mini-diff edycji, który
/// stoi otwarty od razu (12 linii, reszta pod „… jeszcze N linii"). Kolor `+`/`−` dubluje znak.
/// Komenda powłoki stoi w kolorach składni w obu miejscach (`SyntaxHighlight`).
struct ToolCardView: View {
  let model: ToolRowModel
  /// Pod stojącą decyzją bez kolorów składni: przygaszony transkrypt trzyma 7:1 tylko zwykłym atramentem.
  let plainSyntax: Bool
  let toggle: () -> Void
  let openDiffTail: () -> Void

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap, chain: model.chain) {
      VStack(alignment: .leading, spacing: 0) {
        header
        if model.expanded {
          if let diff = model.diff {
            MiniDiffView(diff: diff, tailOpen: model.diffTailOpen, openTail: openDiffTail, id: model.id)
          } else if let detail = model.detail {
            ToolDetailView(text: detail, syntax: plainSyntax ? [] : model.detailSyntax, id: model.id)
          }
        }
      }
      .toolCardBackground(model.chain)
    }
  }

  private var header: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        if model.expandable {
          Image(systemName: "chevron.right")
            .imageScale(.small)
            .rotationEffect(.degrees(model.expanded ? 90 : 0))
            .foregroundStyle(Color(uiColor: Palette.muted2))
        }
        ToolLineText(line: model.line, syntax: plainSyntax ? [] : model.lineSyntax)
        if let diff = model.diff {
          if diff.added > 0 { Text(verbatim: "+\(diff.added)").foregroundStyle(Color(uiColor: Palette.run)) }
          if diff.deleted > 0 { Text(verbatim: "−\(diff.deleted)").foregroundStyle(Color(uiColor: Palette.err)) }
        }
      }
      .appFont(.footnote.monospaced())
      .padding(.horizontal, 12)
      .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(ToolHeaderStyle())
    .disabled(!model.expandable)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.toolSpoken(line: model.line, added: model.diff?.added ?? 0, deleted: model.diff?.deleted ?? 0))
    .accessibilityValue(model.expandable ? (model.expanded ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed) : "")
    .accessibilityAddTraits(model.expandable ? .isButton : .isStaticText)
    .accessibilityIdentifier("tool.\(model.id)")
  }
}

extension View {
  /// Tło wiersza karty narzędzi: plama `toolCard`, rogi zaokrąglone tylko na zewnątrz karty sąsiednich narzędzi,
  /// a na styku z wierszem powyżej kreska `border` grubości piksela. Wiersz sam (`.alone`) to dawna karta.
  func toolCardBackground(_ place: ToolChainPlace) -> some View {
    background(ToolCardBackground(place: place))
  }
}

private struct ToolCardBackground: View {
  let place: ToolChainPlace
  @Environment(\.displayScale) private var scale

  var body: some View {
    UnevenRoundedRectangle.block(top: !place.joinsAbove, bottom: !place.joinsBelow)
      .fill(Color(uiColor: Palette.toolCard))
      .overlay(alignment: .top) {
        if place.joinsAbove {
          Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1 / max(scale, 1))
        }
      }
      .accessibilityHidden(true)
  }
}

/// Zwinięta linia: jedna linijka, ucięta na końcu (przy największym piśmie łamie się w całości). Tokeny
/// składni mają własny kolor; reszta idzie za stylem przycisku (wyciszona, pod palcem pełny kontrast).
private struct ToolLineText: View {
  let line: String
  let syntax: [SyntaxToken]
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    Text(SyntaxPaint.painted(line, syntax: syntax))
      .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
      .truncationMode(.tail)
  }
}

/// Kolory składni na tekście SwiftUI: barwa klasy na zakresie tokenu, komentarz dodatkowo kursywą
/// (`.hl-c` w PWA). Tekst zostaje znak w znak — zaznaczanie i schowek widzą to samo co bez koloru.
enum SyntaxPaint {
  static func painted(_ text: String, syntax: [SyntaxToken]) -> AttributedString {
    var out = AttributedString(text)
    paint(&out, syntax: syntax)
    return out
  }

  static func paint(_ out: inout AttributedString, syntax: [SyntaxToken]) {
    for token in syntax {
      let span = NSRange(location: token.range.lowerBound, length: token.range.count)
      guard let range = Range(span, in: out) else { continue }
      out[range].swiftUI.foregroundColor = Color(uiColor: Palette.syntax(token.kind))
      if token.kind == .c { out[range].inlinePresentationIntent = .emphasized }
    }
  }
}

/// Spoczynkowo wyciszona, pod palcem i pod wskaźnikiem pełny kontrast (`.tool-call > summary:hover` w PWA) — reakcją
/// jest kolor, nie geometria. Nagłówek bez rozwinięcia (`disabled`) na wskaźnik nie reaguje.
private struct ToolHeaderStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    RarogHoverReader(enabled: isEnabled) { hovered in
      configuration.label
        .foregroundStyle(Color(uiColor: configuration.isPressed || hovered ? Palette.text : Palette.muted))
    }
  }
}

/// Pełne wejście narzędzia: pismo stałej szerokości, łamane (poziomy przewijak w karcie walczyłby
/// z przewijaniem transkryptu), adresy klikalne, zaznaczanie systemowe, komenda powłoki w kolorach składni.
private struct ToolDetailView: View {
  let text: String
  let syntax: [SyntaxToken]
  let id: String

  var body: some View {
    Text(Self.styled(text, syntax: syntax))
      .appFont(.footnote.monospaced())
      .foregroundStyle(Color(uiColor: Palette.text))
      .tint(Color(uiColor: Palette.text))
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 12)
      .padding(.bottom, 8)
      .accessibilityIdentifier("tool.\(id).detail")
  }

  /// Link w pełnym kontraście z podkreśleniem — bursztyn znaczy „ktoś czeka" i na link nie wchodzi. Link
  /// wewnątrz tokenu (adres w napisie shella) zdejmuje jego kolor i kursywę, jak `a .hl-*` w PWA.
  static func styled(_ text: String, syntax: [SyntaxToken]) -> AttributedString {
    var out = ToolDetailLinks.attributed(text)
    SyntaxPaint.paint(&out, syntax: syntax)
    for run in out.runs where run.link != nil {
      out[run.range].swiftUI.underlineStyle = .single
      out[run.range].swiftUI.foregroundColor = nil
      out[run.range].inlinePresentationIntent = nil
    }
    return out
  }
}

/// Mini-diff edycji: linie `+` na zielonym tincie, `−` na czerwonym, kontekst wyciszony.
private struct MiniDiffView: View {
  let diff: MiniDiff
  let tailOpen: Bool
  let openTail: () -> Void
  let id: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      lines(diff.head)
        .accessibilityIdentifier("tool.\(id).diff")
      if !diff.tail.isEmpty {
        if tailOpen {
          lines(diff.tail)
            .accessibilityIdentifier("tool.\(id).diffTail")
        } else {
          Button(action: openTail) {
            Text(verbatim: UICopy.diffMore(diff.tail.count))
              .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
              .padding(.horizontal, 8)
              .contentShape(Rectangle())
          }
          .buttonStyle(ToolHeaderStyle())
          .accessibilityIdentifier("tool.\(id).more")
        }
      }
    }
    .appFont(.footnote.monospaced())
    .padding(.horizontal, 8)
    .padding(.bottom, 8)
  }

  private func lines(_ slice: [MiniDiff.Line]) -> some View {
    // Jeden tekst na blok linii: zaznaczanie obejmuje całość, czytnik czyta ciąg, nie 40 elementów.
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(slice.enumerated()), id: \.offset) { _, line in
        Text(verbatim: line.text)
          .foregroundStyle(Color(uiColor: Self.ink(line.kind)))
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 8)
          .background(Self.tint(line.kind))
      }
    }
    .textSelection(.enabled)
    .accessibilityElement(children: .combine)
  }

  private static func ink(_ kind: MiniDiff.Kind) -> UIColor {
    switch kind {
    case .add: Palette.text
    case .del: Palette.muted
    case .ctx: Palette.muted2
    }
  }

  private static func tint(_ kind: MiniDiff.Kind) -> Color {
    switch kind {
    case .add: Color(uiColor: Palette.run).opacity(0.12)
    case .del: Color(uiColor: Palette.err).opacity(0.12)
    case .ctx: .clear
    }
  }
}
#endif
