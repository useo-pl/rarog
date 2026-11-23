#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Wspólne klocki rodziny kart decyzji (`docs/design.md` „Decision cards: layout rules"):
// jedna stopka zawijana w wiersze, wiersz stanu w miejscu stopki, blok „Co widać w terminalu",
// zdanie wyniku pod stopką. Karta pytania może z nich korzystać. Właściciel: karty.

/// Stopka karty: przyciski od lewej, zawijane CAŁE do następnego wiersza (długa etykieta eskalacji
/// łamie się w przycisku, nigdy nie jest ucinana). `Spacer` w środku = reszta po prawej; przycisk ze znacznikiem
/// `cardFooterNewLine()` zaczyna nowy wiersz, choćby zmieścił się w bieżącym.
struct CardFooterLayout: Layout {
  var spacing: CGFloat = 8
  var lineSpacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let lines = arrange(subviews, width: width)
    let height = lines.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, lines.count - 1))
    let used = lines.map(\.width).max() ?? 0
    return CGSize(width: proposal.width ?? used, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for line in arrange(subviews, width: bounds.width) {
      var x = bounds.minX
      // Rozpychacz (`Spacer`) bierze to, co w wierszu zostało — reszta przycisków stoi po prawej.
      let free = max(0, bounds.width - line.width)
      for item in line.items {
        let size = item.size
        if item.isSpacer { x += free; continue }
        subviews[item.index].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += line.height + lineSpacing
    }
  }

  private struct Item {
    let index: Int
    let size: CGSize
    let isSpacer: Bool
  }

  private struct Line {
    var items: [Item] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(_ subviews: Subviews, width: CGFloat) -> [Line] {
    var lines: [Line] = [Line()]
    for (index, subview) in subviews.enumerated() {
      let spacer = subview.priority < -100
      if spacer {
        lines[lines.count - 1].items.append(Item(index: index, size: .zero, isSpacer: true))
        continue
      }
      // Przycisk dostaje co najwyżej szerokość karty — dłuższa etykieta łamie się w nim.
      let size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
      var line = lines[lines.count - 1]
      let needed = line.width == 0 ? size.width : line.width + spacing + size.width
      if line.width > 0, needed > width || subview[CardFooterNewLine.self] {
        lines.append(Line())
        line = Line()
      }
      line.items.append(Item(index: index, size: size, isSpacer: false))
      line.width = line.width == 0 ? size.width : line.width + spacing + size.width
      line.height = max(line.height, size.height)
      lines[lines.count - 1] = line
    }
    return lines.filter { !$0.items.allSatisfy(\.isSpacer) }
  }
}

/// Rozpychacz stopki: mówi `CardFooterLayout`, że od tego miejsca przyciski stoją po prawej.
struct CardFooterSpacer: View {
  var body: some View {
    Color.clear.frame(width: 0, height: 0).layoutPriority(-1000).accessibilityHidden(true)
  }
}

/// Znacznik łamania stopki (`CardFooterLayout`): przycisk zaczyna nowy wiersz.
private struct CardFooterNewLine: LayoutValueKey {
  static let defaultValue = false
}

extension View {
  /// Przycisk stopki zaczyna NOWY wiersz, choćby zmieścił się obok poprzedniego — kafel „zawsze” pod parą
  /// „Zatwierdź”/„Odrzuć”. Stoi na końcu łańcucha modyfikatorów przycisku.
  func cardFooterNewLine() -> some View {
    layoutValue(key: CardFooterNewLine.self, value: true)
  }
}

/// Pasek stopki z kreską u góry. Wiersz stanu ZASTĘPUJE przyciski, ale stopka zostaje w układzie
/// (niewidoczna): karta ma tę samą wysokość co przed tapnięciem, więc transkrypt nie skacze
/// (`docs/design.md` „States").
struct CardFooter<Buttons: View>: View {
  let status: String?
  var spacing: CGFloat = 8
  @ViewBuilder let buttons: () -> Buttons
  /// W doku (sufit) zdanie stanu ma najwyżej dwie linie: długa etykieta „zawsze” nie rozpycha stopki ponad sufit.
  @Environment(\.decisionDockCeiling) private var dockCeiling

  var body: some View {
    VStack(spacing: 0) {
      Divider().overlay(Color(uiColor: Palette.border)).padding(.top, 8)
      CardFooterLayout(spacing: spacing) { buttons() }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(status == nil ? 1 : 0)
        .accessibilityHidden(status != nil)
        .allowsHitTesting(status == nil)
        .overlay(alignment: .leading) {
          if let status {
            Text(status)
              .appFont(.footnote.monospaced())
              .foregroundStyle(Color(uiColor: Palette.muted))
              .lineLimit(dockCeiling == nil ? nil : 2)
              .truncationMode(.middle)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.horizontal, 12)
              .accessibilityIdentifier("card.status")
          }
        }
    }
  }
}

/// Zdanie pod stopką: wynik akcji (wyciszone) albo błąd (czerwień) — stoi przy karcie, nie w modalu.
struct CardResultLine: View {
  let text: String?
  let isError: Bool
  var identifier = "card.result"
  /// W doku (sufit) zdanie ma najwyżej trzy linie — pełne słyszy czytnik; w transkrypcie bez limitu.
  @Environment(\.decisionDockCeiling) private var dockCeiling

  var body: some View {
    if let text {
      Text(text)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: isError ? Palette.err : Palette.muted))
        .lineLimit(dockCeiling == nil ? nil : 3)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(identifier)
    }
  }
}

/// „Co widać w terminalu": wycinek ekranu rozwinięty od razu, pismem stałej szerokości, bez
/// zawijania (złamana linia formularza kłamie o tym, co stoi w panelu), z własnym sufitem w liniach
/// i wierszem „⌃ widzisz N z M linii — przewiń w górę", gdy sufit faktycznie ucina.
///
/// Blok jest zakotwiczony u DOŁU: serwer wysyła OSTATNIE linie ekranu
/// (`snippet` w `server/src/herdr/screen.ts`), a dialog z opcjami stoi na dole panelu. Blok od góry pokazywał
/// prompty nad dialogiem, a opcje pauzy „Session paused” zostawały pod krawędzią bloku.
struct ScreenBlockView: View {
  let screen: String
  var maxLines = 8
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var height: CGFloat = 0

  var body: some View {
    // The line height at the view's text size, not the system's: the ceiling grows with the text it holds.
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
    let size = Fonts.text(.caption1, traits: traits, category: TextSizeCategory(typeSize)).pointSize
    let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let ceiling = font.lineHeight * CGFloat(maxLines) + 16
    let total = screen.replacing(/\n$/, with: "").split(separator: "\n", omittingEmptySubsequences: false).count
    VStack(alignment: .leading, spacing: 6) {
      Text(UICopy.screenHeader)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityAddTraits(.isHeader)
      ScrollView([.vertical, .horizontal]) {
        Text(screen)
          .appFont(.caption.monospaced())
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize()
          .padding(8)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
      }
      // Pierwsze pokazanie = koniec tekstu, od lewej krawędzi; ucięta część jest nad blokiem i przewija się w górę.
      // Także przy zmianie rozmiaru dół zostaje na miejscu: blok maleje do sufitu dopiero po pomiarze wysokości
      // (drugi przebieg), a nowy wycinek tej samej karty dokłada linie na dole.
      .defaultScrollAnchor(.bottomLeading, for: .initialOffset)
      .defaultScrollAnchor(.bottomLeading, for: .sizeChanges)
      .scrollIndicators(.visible)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(height: height == 0 ? nil : min(height, ceiling))
      .commandBlock()
      .accessibilityLabel("\(UICopy.screenHeader): \(screen)")
      .accessibilityIdentifier("card.screen")
      if height > ceiling {
        Text(UICopy.screenClipped(shown: maxLines, total: max(total, maxLines)))
          .appFont(.caption.monospaced())
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
  }
}

/// Układ karty decyzji z sufitem doku (`decisionDockCeiling`, dok
/// decyzji w miejscu pola). Bez sufitu (`nil`, karta w transkrypcie) to zwykły
/// stos nagłówek–treść–stopka, jak dotąd. Z sufitem nagłówek i stopka stoją zawsze w ramce karty, a treść między nimi
/// przewija się wewnątrz karty, gdy się nie mieści; karta niższa od sufitu ma swoją naturalną wysokość. Sufit liczy
/// CAŁĄ kartę razem z jej pionowym marginesem poza ramką (`outside`, `.padding(.vertical, 8)` kart), więc dok ustawia
/// tylko `.environment(\.decisionDockCeiling, …)`. Nagłówek i stopka razem wyższe od sufitu: treść trzyma swoje
/// minimum, części przypięte dzielą resztę (`DecisionDock.compactHeights`, stopka z przyciskami pierwsza) i przewijają
/// się w swoim przydziale (`dockPinned`) — każda część karty zostaje osiągalna.
struct CardDockColumn<Header: View, Content: View, Footer: View>: View {
  let outside: CGFloat
  let header: Header
  let content: Content
  let footer: Footer
  @Environment(\.decisionDockCeiling) private var ceiling
  @State private var contentHeight: CGFloat = 0

  init(
    outside: CGFloat = 16, @ViewBuilder header: () -> Header, @ViewBuilder content: () -> Content,
    @ViewBuilder footer: () -> Footer
  ) {
    self.outside = outside
    self.header = header()
    self.content = content()
    self.footer = footer()
  }

  var body: some View {
    if let ceiling {
      CardDockStack(ceiling: max(0, ceiling - outside)) {
        VStack(alignment: .leading, spacing: 0) { header }
          .dockPinned()
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.visible)
        .scrollIndicatorsFlash(onAppear: true)
        // Przed pomiarem treść bierze całe miejsce pod sufitem (karta i tak nie wyjdzie ponad sufit), po pomiarze
        // najwyżej swoją wysokość: krótka karta nie rośnie.
        .frame(maxHeight: contentHeight == 0 ? .infinity : contentHeight)
        VStack(alignment: .leading, spacing: 0) { footer }
          .dockPinned()
      }
    } else {
      VStack(alignment: .leading, spacing: 0) {
        header
        content
        footer
      }
    }
  }
}

/// Stos trzech części karty pod sufitem (`CardDockColumn`): nagłówek i stopka w swojej wysokości, przewijana
/// treść w środku dostaje najwyżej to, co zostaje pod sufitem, i nie mniej niż swoje minimum (`compactHeights`).
struct CardDockStack: Layout {
  let ceiling: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
    return CGSize(width: width, height: heights(width: width, subviews: subviews).reduce(0, +))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for (subview, height) in zip(subviews, heights(width: bounds.width, subviews: subviews)) {
      subview.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: height))
      y += height
    }
  }

  private func heights(width: CGFloat, subviews: Subviews) -> [CGFloat] {
    let natural = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
    guard subviews.count == 3 else { return natural }
    // Środek: wysokość treści zmierzona w karcie (`CardDockColumn`), przed pomiarem cały sufit — przy propozycji `nil`
    // przewijany pojemnik nie podaje jej wiarygodnie.
    let middle = subviews[1].sizeThatFits(ProposedViewSize(width: width, height: ceiling)).height
    // Przypięte części dostają swoje, środek resztę, ale nie mniej niż swoje minimum (`compactHeights`).
    return DecisionDock.compactHeights([natural[0], middle, natural[2]], ceiling: ceiling)
  }
}

/// Powierzchnia karty decyzji: bez tintu i cienia, `--surface` z kreską.
struct CardSurface: ViewModifier {
  func body(content: Content) -> some View {
    content
      .background(Color(uiColor: Palette.surface), in: .block)
      .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
  }
}

/// Blok komendy i wycinka ekranu na karcie: pole `input` (ciemniejsze od karty) z kreską, jak `.perm__cmd`.
struct CommandBlockSurface: ViewModifier {
  func body(content: Content) -> some View {
    content
      .background(Color(uiColor: Palette.input), in: .inner)
      .overlay(RoundedRectangle.inner.strokeBorder(Color(uiColor: Palette.border)))
  }
}

extension View {
  func cardSurface() -> some View { modifier(CardSurface()) }
  func commandBlock() -> some View { modifier(CommandBlockSurface()) }
}
#endif
