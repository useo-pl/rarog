#if os(iOS)
import RarogContract
import SwiftUI
import UIKit

// Widoki kafla Live Activity: ekran blokady i kawałki Dynamic Island. Same widoki
// SwiftUI bez WidgetKit — rozszerzenie `RarogWidgets` wkłada je w `ActivityConfiguration` (tam `widgetURL`,
// tło i obwódka wyspy), a testy UIKit renderują je `ImageRenderer`-em do zrzutów w obu motywach.
//
// Ekran blokady — układ „tekst | grafika": DWIE kolumny. Lewa to tekst: rząd trzech liczników (czekają · pracują
// · skończyły), a pod nim linia „usage 5h · 7d" z procentami pogrubionymi w kolorze progu limitu. Prawa to
// grafika: trzy pionowe słupki obciążenia Maca (CPU, RAM, dysk; kolor progu kafla) na całą wysokość
// tej pary, a pod nimi paski faz przebiegów w tej samej szerokości — przebieg stoi w jednym wierszu, tytuł
// i postęp w kolumnie tekstu. Kolor znaczy STAN (jak w apce): bursztyn — czeka na decyzję, zieleń — praca
// i postęp przebiegu, niebieski — wynik do odebrania; zero przygaszone. Stan niesie też słowo pod liczbą i stałe
// miejsce w rzędzie, nie sam kolor. Liczby i słupki rosną z pismem łagodnie (`.largeTitle`), żeby
// proporcja do podpisów nie rozjeżdżała się przy większym piśmie.
//
// Wysokość: system przycina kafel ekranu blokady i rozwiniętą wyspę powyżej 160 pt, więc każdy tekst ma
// `lineLimit(1)` (zawinięcie dokładałoby wiersz), pismo kafla kończy skalowanie na `maxTypeSize` (powyżej
// `.large` odstępy się zacieśniają), a wyspy — na `islandMaxTypeSize` (wyspa ma stały rozmiar fizyczny).
// Najwyższa treść mieści się w 160 pt przy każdym rozmiarze pisma (`LiveActivityViewTests`, pomiar:
// dwa przebiegi, „+N", oba limity, Mac i dane nieświeże).

/// Kolory SwiftUI z liczb palety (`LiveActivityPalette.swift`, poza `#if os(iOS)`).
extension LiveActivityPalette {
  /// Licznik tablicy — kolor stanu, który niesie.
  public enum Counter: Sendable {
    case waiting
    case working
    case finished

    /// Rodzaj sesji w adresie tapnięcia (``LiveActivityPresentation/jumpLink(_:)``).
    var tally: LiveActivityPresentation.Tally {
      switch self {
      case .waiting: .waiting
      case .working: .working
      case .finished: .finished
      }
    }
  }

  static func color(_ pair: (dark: UInt32, light: UInt32)) -> Color {
    Color(uiColor: UIColor { traits in
      rgb(traits.userInterfaceStyle == .light ? pair.light : pair.dark)
    })
  }

  /// Kolor pary w motywie widoku, a na wyspie (zawsze ciemnej) — zawsze wariant ciemny.
  static func color(_ pair: (dark: UInt32, light: UInt32), island: Bool) -> Color {
    island ? Color(uiColor: rgb(pair.dark)) : color(pair)
  }

  static func rgb(_ hex: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }

  static func pair(_ tone: LiveActivityPresentation.Tone) -> (dark: UInt32, light: UInt32) {
    switch tone {
    case .waiting: waitPair
    case .working: runPair
    case .quiet: quietPair
    }
  }

  static func pair(_ counter: Counter) -> (dark: UInt32, light: UInt32) {
    switch counter {
    case .waiting: waitPair
    case .working: runPair
    case .finished: newPair
    }
  }

  /// Kolor tonu w motywie widoku.
  public static func tone(_ tone: LiveActivityPresentation.Tone) -> Color {
    color(pair(tone))
  }

  /// Dynamic Island jest zawsze ciemna — tam zawsze kolory ciemnego motywu.
  public static func islandTone(_ tone: LiveActivityPresentation.Tone) -> Color {
    Color(uiColor: rgb(pair(tone).dark))
  }

  /// Licznik: kolor stanu, a przy zerze — przygaszony.
  static func counter(_ value: Int, _ counter: Counter, island: Bool) -> Color {
    color(value == 0 ? zeroPair : pair(counter), island: island)
  }

  /// Limit: kolor tekstu poniżej progu, bursztyn od 60 %, czerwień od 80 % (progi kafla, `LiveActivityPresentation`).
  static func limit(_ level: LiveActivityPresentation.Limit.Level, island: Bool) -> Color {
    switch level {
    case .normal: color(textPair, island: island)
    case .high: color(waitPair, island: island)
    case .critical: color(errPair, island: island)
    }
  }

  /// Procent i słupek Maca: zwykły atrament, bursztyn i czerwień — te same kolory co limity, progi kafla
  /// (`LiveActivityPresentation.macLevel`).
  static func mac(_ level: MacLoadLevel, island: Bool) -> Color {
    switch level {
    case .normal: ink(island: island)
    case .warning: color(waitPair, island: island)
    case .critical: color(errPair, island: island)
    }
  }

  /// Tor paska (słupek Maca, segment fazy): biel albo czerń o niskiej przezroczystości; bieżąca faza jaśniejsza.
  /// W ciemnym 0,20 / 0,28: słabszy tor zlewa się z czarnym kaflem ekranu blokady i nie widać, gdzie słupek się
  /// kończy.
  static func track(current: Bool, island: Bool) -> Color {
    if island { return Color.white.opacity(current ? 0.26 : 0.18) }
    return Color(uiColor: UIColor { traits in
      traits.userInterfaceStyle == .light
        ? UIColor.black.withAlphaComponent(current ? 0.16 : 0.08)
        : UIColor.white.withAlphaComponent(current ? 0.28 : 0.20)
    })
  }

  /// Segment fazy w kolorze stanu: na wyspie (zawsze ciemnej) wariant wyspy, na kaflu — wariant motywu widoku.
  static func phase(_ state: LiveActivityContentState.PhaseState, island: Bool) -> Color {
    func ui(_ ink: Ink) -> UIColor { rgb(ink.hex).withAlphaComponent(CGFloat(ink.alpha)) }
    if island { return Color(uiColor: ui(phase(state, on: .island))) }
    return Color(uiColor: UIColor { traits in
      ui(phase(state, on: traits.userInterfaceStyle == .light ? .light : .dark))
    })
  }

  /// Atrament etykiet („czekają", „limit 5h", „Mac").
  static func muted(island: Bool) -> Color {
    island ? Color.white.opacity(0.6) : Color.secondary
  }

  /// Atrament wartości (procenty Maca, tytuł przebiegu).
  static func ink(island: Bool) -> Color {
    island ? Color.white : Color.primary
  }
}

extension LiveActivityPresentation {
  /// Pismo kafla ekranu blokady przestaje rosnąć na tym rozmiarze: wyżej najwyższa treść (dwa przebiegi,
  /// limity, Mac) przekroczyłaby 160 pt, które system zostawia kafelkowi, i dół kafla zostałby ucięty
  /// (`.large` 155 pt, `.xLarge` z ciasnymi odstępami 156 pt).
  public static let maxTypeSize = DynamicTypeSize.xLarge
  /// Pismo wyspy (zwiniętej 37 pt, rozwiniętej do 160 pt) zostaje na rozmiarze domyślnym: wyspa ma stały
  /// rozmiar fizyczny, a rozwinięta z dwoma przebiegami i zdaniem o nieświeżych danych wypełnia go już przy
  /// `.large`.
  public static let islandMaxTypeSize = DynamicTypeSize.large
}

/// Wiersz „tytuł … postęp" przebiegu: oba w idealnej szerokości, gdy się mieszczą. Gdy nie — postęp
/// dostaje to, co zostaje po tytule, ale nie mniej niż połowę wiersza, a przycina się tytuł. Stała
/// `layoutPriority` nie wystarcza: przy długim tytule fazy (do 24 znaków) postęp zjadał cały tytuł,
/// a przy odwrotnym priorytecie długa nazwa projektu zjadała postęp.
struct LiveActivityRowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard subviews.count == 2 else { return .zero }
    // Propozycja bez szerokości albo nieskończona (rozmiar idealny) = oba człony w idealnej szerokości.
    let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
    let widths = split(width, subviews)
    let height = max(
      subviews[0].sizeThatFits(ProposedViewSize(width: widths.title, height: proposal.height)).height,
      subviews[1].sizeThatFits(ProposedViewSize(width: widths.progress, height: proposal.height)).height)
    return CGSize(width: width ?? widths.title + spacing + widths.progress, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard subviews.count == 2 else { return }
    let widths = split(bounds.width, subviews)
    subviews[0].place(
      at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
      proposal: ProposedViewSize(width: widths.title, height: bounds.height))
    subviews[1].place(
      at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing,
      proposal: ProposedViewSize(width: widths.progress, height: bounds.height))
  }

  private func split(_ width: CGFloat?, _ subviews: Subviews) -> (title: CGFloat, progress: CGFloat) {
    let title = subviews[0].sizeThatFits(.unspecified).width
    let progress = subviews[1].sizeThatFits(.unspecified).width
    guard let width else { return (title, progress) }
    let available = max(0, width - spacing)
    if title + progress <= available { return (title, progress) }
    let share = min(progress, max(available / 2, available - title))
    return (available - share, share)
  }
}

/// Pasek postępu: tor i wypełnienie od lewej (limit planu, segment fazy). Wypełnienie przycina kształt toru.
struct LiveActivityBar: View {
  let fraction: Double
  let fill: Color
  let track: Color

  var body: some View {
    Capsule()
      .fill(track)
      .overlay(alignment: .leading) {
        GeometryReader { geometry in
          Rectangle().fill(fill).frame(width: geometry.size.width * min(1, max(0, fraction)))
        }
      }
      .clipShape(Capsule())
  }
}

/// Liczba tablicy ze słowem pod nią („2" / „czekają"). Zero gaśnie razem ze słowem.
struct LiveActivityCounter: View {
  let value: Int
  let word: String
  let counter: LiveActivityPalette.Counter
  /// 34 pt przy piśmie domyślnym (rozmiar `.largeTitle`, większy niż reszta kafla);
  /// rośnie jak `.largeTitle` (do klamry kafla o ok. 6 %), a słowo pod liczbą — jak `.caption2`, więc
  /// proporcja nie odjeżdża tak, jak przy stałym rozmiarze.
  @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 34
  /// O tyle słowo wchodzi w pole wydłużeń dolnych liczby (cyfry ich nie mają): większa cyfra nie podnosi licznika,
  /// więc kafel zostaje w 160 pt, a linia usage obok słupków Maca.
  @ScaledMetric(relativeTo: .largeTitle) private var tuck: CGFloat = 5
  /// O tyle licznik wchodzi w górne wcięcie kafla: nad cyfrą 34 pt krój zostawia o tyle więcej pustego pola niż nad
  /// procentem Maca (`.caption2`), więc bez tego góra cyfr stoi 5 pt niżej niż góra procentów (zrzut z iPhone'a:
  /// 18,7 pt wobec 13,7 pt od krawędzi kafla).
  @ScaledMetric(relativeTo: .largeTitle) private var lift: CGFloat = 5

  var body: some View {
    VStack(alignment: .leading, spacing: -tuck) {
      Text(verbatim: String(value))
        .font(.system(size: size, weight: .bold, design: .rounded).monospacedDigit())
        .foregroundStyle(LiveActivityPalette.counter(value, counter, island: false))
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(word)
        .font(.caption2)
        .foregroundStyle(value == 0 ? LiveActivityPalette.counter(0, counter, island: false) : Color.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .padding(.top, -lift)
    .modifier(TallyLink(value: value, counter: counter))
  }
}

/// Liczba większa od zera prowadzi do pierwszej sesji swojego rodzaju (``LiveActivityPresentation/jumpLink(_:)``);
/// zero zostaje tłem kafla, czyli listą (`widgetURL`). `Link` działa na ekranie blokady i w rozwiniętej
/// wyspie; zwinięta i minimalna mają jeden adres na całość.
private struct TallyLink: ViewModifier {
  let value: Int
  let counter: LiveActivityPalette.Counter

  @ViewBuilder func body(content: Content) -> some View {
    if value > 0 {
      Link(destination: LiveActivityPresentation.jumpLink(counter.tally)) { content }
    } else {
      content
    }
  }
}

/// Licznik w jednym wierszu („2 czekają") — dół rozwiniętej wyspy.
struct LiveActivityInlineCounter: View {
  let value: Int
  let word: String
  let counter: LiveActivityPalette.Counter

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(verbatim: String(value))
        .font(.system(size: 20, weight: .bold, design: .rounded).monospacedDigit())
        .foregroundStyle(LiveActivityPalette.counter(value, counter, island: true))
      Text(word)
        .font(.caption2)
        .foregroundStyle(value == 0 ? LiveActivityPalette.counter(0, counter, island: true) : Color.white.opacity(0.6))
    }
    .lineLimit(1)
    .modifier(TallyLink(value: value, counter: counter))
  }
}

/// Obciążenie Maca na ekranie blokady: pionowy słupek z procentem nad nim
/// i „CPU"/„RAM"/„dysk" pod spodem, oba pismem linii usage (`.caption2`; procent pogrubiony jak tam). Kolor słupka
/// i procentu z progu kafla (``LiveActivityPresentation/macLevel(_:_:)``: zwykły atrament, bursztyn, czerwień) —
/// próg niesie też waga, nie sam kolor. Szerokość idzie za komórką, którą podaje kafel (``baseCell`` skalowane
/// z pismem); wysokość słupka wypełnia to, co zostaje z wysokości pary „liczniki + linia usage".
struct LiveActivityMacBar: View {
  let metric: LiveActivityPresentation.MacMetric
  let cell: CGFloat

  /// Komórka przy piśmie domyślnym: trzy po 36 pt i dwa odstępy po 6 pt to kolumna grafiki 120 pt.
  static let baseCell: CGFloat = 36
  /// Słupek 16 / 1,4 ≈ 11,4 pt przy komórce 36 pt.
  static let baseBarWidth: CGFloat = 16 / 1.4
  /// Najniższy słupek, gdy pismo zjada wysokość pary; idealny — gdy pary nic nie rozpycha (procent 13 + 3 + słupek
  /// + 3 + podpis 13 = 70 pt przy piśmie domyślnym, wysokość „liczniki + linia usage").
  static let minBarHeight: CGFloat = 24
  static let idealBarHeight: CGFloat = 38
  private var scale: CGFloat { cell / Self.baseCell }

  var body: some View {
    let color = LiveActivityPalette.mac(metric.level, island: false)
    let shape = RoundedRectangle(cornerRadius: 4 * scale, style: .continuous)
    VStack(spacing: 3) {
      Text(metric.value)
        .font(.caption2.weight(.bold).monospacedDigit())
        .foregroundStyle(color)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      shape
        .fill(LiveActivityPalette.track(current: false, island: false))
        .overlay(alignment: .bottom) {
          GeometryReader { geometry in
            Rectangle()
              .fill(color)
              .frame(height: geometry.size.height * min(1, max(0, metric.fraction)))
              .frame(maxHeight: .infinity, alignment: .bottom)
          }
        }
        .clipShape(shape)
        .frame(width: Self.baseBarWidth * scale)
        .frame(minHeight: Self.minBarHeight, idealHeight: Self.idealBarHeight, maxHeight: .infinity)
      Text(metric.label)
        .font(.caption2)
        .foregroundStyle(LiveActivityPalette.muted(island: false))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .frame(width: cell)
    .frame(maxHeight: .infinity)
  }
}

/// Limit w rogu rozwiniętej wyspy (72 pt): mały pierścień, „5h" i procent w jednym wierszu — niższy niż
/// wiersz z paskiem, więc wyspa nie rośnie.
struct LiveActivityIslandLimitRow: View {
  let limit: LiveActivityPresentation.Limit

  var body: some View {
    HStack(spacing: 4) {
      LiveActivityRing(
        progress: limit.fraction, fill: LiveActivityPalette.limit(limit.level, island: true),
        track: LiveActivityPalette.track(current: false, island: true), lineWidth: 2.5, size: 12, inset: 1.25)
      Text(limit.shortLabel)
        .foregroundStyle(LiveActivityPalette.muted(island: true))
      Spacer(minLength: 2)
      Text(limit.percentText)
        .fontWeight(.semibold)
        .monospacedDigit()
        .foregroundStyle(limit.level == .normal
          ? LiveActivityPalette.ink(island: true) : LiveActivityPalette.limit(limit.level, island: true))
    }
    .font(.caption2)
    .lineLimit(1)
    .minimumScaleFactor(0.8)
  }
}

/// Pasek przebiegu: segment na fazę planu (bez planu — jeden segment całości). Przy stanach faz
/// każdy segment to pełna kapsuła w kolorze stanu (``LiveActivityPalette/phase(_:on:)``), bez wypełniania
/// procentem i bez toru fazy bieżącej; bez stanów — wypełnienie procentem, a bieżąca faza z jaśniejszym torem.
struct LiveActivityPhaseBar: View {
  let row: LiveActivityPresentation.WorkflowRow
  let island: Bool

  var body: some View {
    HStack(spacing: 3) {
      if let states = row.states {
        ForEach(states.indices, id: \.self) { index in
          Capsule().fill(LiveActivityPalette.phase(states[index], island: island))
        }
      } else {
        ForEach(row.segments.indices, id: \.self) { index in
          LiveActivityBar(
            fraction: row.segments[index], fill: LiveActivityPalette.color(LiveActivityPalette.runPair, island: island),
            track: LiveActivityPalette.track(current: index == row.current, island: island))
        }
      }
    }
    .frame(height: 5)
  }
}

/// Przebieg na wyspie: nazwa z lewej, postęp z prawej (podział szerokości: ``LiveActivityRowLayout``), pod
/// spodem pasek faz.
struct LiveActivityWorkflowRowView: View {
  let row: LiveActivityPresentation.WorkflowRow
  let island: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      LiveActivityRowLayout {
        Text(island ? row.name : row.title)
          .fontWeight(.semibold)
          .foregroundStyle(LiveActivityPalette.ink(island: island))
          .truncationMode(.tail)
        Text(row.progress)
          .foregroundStyle(LiveActivityPalette.muted(island: island))
          .minimumScaleFactor(0.8)
      }
      .font(.caption)
      .lineLimit(1)
      LiveActivityPhaseBar(row: row, island: island)
    }
  }
}

/// Przebieg na ekranie blokady w JEDNYM wierszu: „projekt · nazwa" i postęp w kolumnie tekstu,
/// pasek faz w kolumnie pierścieni — ta sama szerokość, więc grafika kafla stoi w jednej kolumnie po prawej.
struct LiveActivityWorkflowLine: View {
  let row: LiveActivityPresentation.WorkflowRow
  let barWidth: CGFloat
  let spacing: CGFloat

  var body: some View {
    HStack(spacing: spacing) {
      LiveActivityRowLayout {
        Text(row.title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(LiveActivityPalette.ink(island: false))
          .truncationMode(.tail)
        Text(row.progress)
          .font(.caption2)
          .foregroundStyle(LiveActivityPalette.muted(island: false))
          .minimumScaleFactor(0.8)
      }
      .lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      LiveActivityPhaseBar(row: row, island: false)
        .frame(width: barWidth)
    }
  }
}

/// Dół lewej kolumny kafla: limity planu („usage   5h 42%   7d 81%", procenty pogrubione w kolorze progu limitu —
/// od 60 % bursztyn, od 80 % czerwień), a przy nieświeżych danych w ich miejscu „nieaktualne · stan z HH:MM"
/// (godzina mówi więcej niż zastygłe procenty). Jeden `Text`, więc w ciasnej kolumnie zwęża się całość, a nie
/// jedna wartość.
struct LiveActivityStatusLine: View {
  let presentation: LiveActivityPresentation
  let isStale: Bool

  /// Czy linia ma cokolwiek do pokazania.
  static func visible(_ presentation: LiveActivityPresentation, isStale: Bool) -> Bool {
    isStale || !presentation.limits.isEmpty
  }

  var body: some View {
    Text(content)
      .font(.caption2.monospacedDigit())
      .lineLimit(1)
      .minimumScaleFactor(0.75)
  }

  private var content: AttributedString {
    let muted = LiveActivityPalette.muted(island: false)
    if isStale {
      var note = AttributedString(LiveActivityPresentation.staleNote(updatedAt: presentation.updatedAt))
      note.foregroundColor = muted
      return note
    }
    var line = AttributedString(LiveActivityPresentation.usageLead)
    line.foregroundColor = muted
    for limit in presentation.limits {
      var label = AttributedString("   " + limit.shortLabel + " ")
      label.foregroundColor = muted
      // Pogrubione i w kolorze progu: próg niesie też waga, nie sam kolor.
      var value = AttributedString(limit.percentText)
      value.foregroundColor = LiveActivityPalette.limit(limit.level, island: false)
      value.font = .caption2.weight(.bold).monospacedDigit()
      line += label + value
    }
    return line
  }
}

/// „+N workflow" pod przebiegami: liczba w atramencie, słowo przygaszone.
struct LiveActivityMoreLine: View {
  let more: String

  var body: some View {
    Text(content)
      .font(.caption2)
      .lineLimit(1)
  }

  private var content: AttributedString {
    var line = AttributedString(more)
    line.foregroundColor = LiveActivityPalette.muted(island: false)
    // „+N" do pierwszej spacji (`LiveActivityPresentation.more`: „+1 workflow").
    if let range = line.range(of: more.prefix { $0 != " " }) {
      line[range].foregroundColor = LiveActivityPalette.ink(island: false)
      line[range].font = .caption2.weight(.bold).monospacedDigit()
    }
    return line
  }
}

/// Kafel na ekranie blokady (i baner Live Activity na iPadzie / iPhonie bez wyspy).
public struct LiveActivityLockScreenView: View {
  let presentation: LiveActivityPresentation
  let isStale: Bool
  /// Rozmiar pisma z systemu (przed klamrą ``LiveActivityPresentation/maxTypeSize``): powyżej `.large`
  /// odstępy się zacieśniają, żeby większe pismo zmieściło się w 160 pt.
  @Environment(\.dynamicTypeSize) private var typeSize

  public init(presentation: LiveActivityPresentation, isStale: Bool) {
    self.presentation = presentation
    self.isStale = isStale
  }

  private var tight: Bool { typeSize > .large }

  public var body: some View {
    // Wcięcie z lewej = wcięcie od góry: pierwsza cyfra i góra procentów Maca ~13,5 pt od krawędzi kafla.
    LiveActivityBoard(presentation: presentation, isStale: isStale, tight: tight)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(tight ? 8 : 12)
      .dynamicTypeSize(...LiveActivityPresentation.maxTypeSize)
      .opacity(isStale ? 0.7 : 1)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(presentation.spokenLabel(isStale: isStale))
  }
}

/// Treść kafla ekranu blokady (ze słupkami Maca): osobny widok, bo `@ScaledMetric` czyta rozmiar pisma
/// ze środowiska miejsca deklaracji — tu, pod klamrą ``LiveActivityPresentation/maxTypeSize``, a nie nad nią.
struct LiveActivityBoard: View {
  let presentation: LiveActivityPresentation
  let isStale: Bool
  let tight: Bool
  @ScaledMetric(relativeTo: .largeTitle) private var barCell = LiveActivityMacBar.baseCell

  static let barGap: CGFloat = 6
  static let columnGap: CGFloat = 16
  /// Kolumna grafiki: trzy słupki Maca, a pod nimi paski faz w tej samej szerokości.
  private var graphicsWidth: CGFloat { 3 * barCell + 2 * Self.barGap }

  var body: some View {
    VStack(alignment: .leading, spacing: tight ? 6 : 8) {
      HStack(alignment: .top, spacing: Self.columnGap) {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .top, spacing: tight ? 14 : 22) {
            LiveActivityCounter(value: presentation.waiting, word: presentation.waitingWord, counter: .waiting)
            LiveActivityCounter(value: presentation.working, word: presentation.workingWord, counter: .working)
            LiveActivityCounter(value: presentation.finished, word: presentation.finishedWord, counter: .finished)
          }
          // Linia usage na dole kolumny: obok słupków stoi na linii podpisów „CPU/RAM/dysk".
          if LiveActivityStatusLine.visible(presentation, isStale: isStale) {
            Spacer(minLength: tight ? 6 : 8)
            LiveActivityStatusLine(presentation: presentation, isStale: isStale)
          } else {
            Spacer(minLength: 0)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        if !presentation.mac.isEmpty {
          // Stała szerokość kolumny: brak metryki nie przesuwa pasków faz pod spodem.
          HStack(alignment: .top, spacing: Self.barGap) {
            ForEach(presentation.mac.indices, id: \.self) { index in
              LiveActivityMacBar(metric: presentation.mac[index], cell: barCell)
            }
          }
          // Słupki rosną do wysokości lewej kolumny (dół podpisów na linii usage), ale jej nie podbijają.
          .frame(width: graphicsWidth, alignment: .leading)
          .frame(maxHeight: .infinity, alignment: .top)
        }
      }
      // Wysokość pary = wyższa z kolumn; lewa rozciąga się do niej (`maxHeight`), więc linia usage schodzi na dół.
      .fixedSize(horizontal: false, vertical: true)
      if let note = presentation.quietNote {
        Text(note)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      } else if !presentation.workflows.isEmpty {
        VStack(alignment: .leading, spacing: tight ? 4 : 5) {
          ForEach(presentation.workflows.indices, id: \.self) { index in
            LiveActivityWorkflowLine(
              row: presentation.workflows[index], barWidth: graphicsWidth, spacing: Self.columnGap)
          }
          if let more = presentation.more {
            LiveActivityMoreLine(more: more)
          }
        }
      }
    }
  }
}

/// Pierścień: tor i łuk od góry zgodnie z ruchem wskazówek. Domyślnie postęp całości pierwszego przebiegu na
/// zwiniętej wyspie (zawsze ciemnej); limity planu podają własny kolor, tor i rozmiar.
struct LiveActivityRing: View {
  let progress: Double
  var fill = LiveActivityPalette.color(LiveActivityPalette.runPair, island: true)
  var track = Color.white.opacity(0.2)
  var lineWidth: CGFloat = 2.5
  var size: CGFloat = 16
  var inset: CGFloat = 1

  var body: some View {
    ZStack {
      Circle().stroke(track, lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: min(1, max(0, progress)))
        .stroke(fill, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    // `size` to średnica osi łuku; połowa grubości wystaje poza ramkę — mieści ją `inset` wołającego.
    .frame(width: size, height: size)
    .padding(inset)
  }
}

/// Lewa część wyspy zwiniętej: czekające, a przy przebiegach workflow — czekające i pracujące obok siebie
/// (prawą stronę zajmuje wtedy pierścień postępu).
public struct LiveActivityCompactLeading: View {
  let presentation: LiveActivityPresentation

  public init(presentation: LiveActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    HStack(spacing: 8) {
      number(presentation.waiting, .waiting)
      if presentation.ring != nil { number(presentation.working, .working) }
    }
    .font(.system(.body, design: .rounded, weight: .bold).monospacedDigit())
    .dynamicTypeSize(...LiveActivityPresentation.islandMaxTypeSize)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.spoken)
  }

  private func number(_ value: Int, _ counter: LiveActivityPalette.Counter) -> some View {
    Text(verbatim: String(value)).foregroundStyle(LiveActivityPalette.counter(value, counter, island: true))
  }
}

/// Prawa część wyspy zwiniętej: pierścień postępu pierwszego przebiegu, a bez przebiegów — pracujące.
public struct LiveActivityCompactTrailing: View {
  let presentation: LiveActivityPresentation

  public init(presentation: LiveActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    Group {
      if let ring = presentation.ring {
        LiveActivityRing(progress: ring)
      } else {
        Text(verbatim: String(presentation.working))
          .font(.system(.body, design: .rounded, weight: .bold).monospacedDigit())
          .foregroundStyle(LiveActivityPalette.counter(presentation.working, .working, island: true))
      }
    }
    .dynamicTypeSize(...LiveActivityPresentation.islandMaxTypeSize)
    .accessibilityHidden(true)
  }
}

/// Wyspa minimalna (dzielona z inną aktywnością): czekające, a bez nich pracujące; cisza — przygaszone zero.
public struct LiveActivityMinimal: View {
  let presentation: LiveActivityPresentation

  public init(presentation: LiveActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    Text(verbatim: String(presentation.count))
      .font(.system(.body, design: .rounded, weight: .bold).monospacedDigit())
      .foregroundStyle(
        LiveActivityPalette.counter(presentation.count, presentation.tone == .waiting ? .waiting : .working, island: true))
      .dynamicTypeSize(...LiveActivityPresentation.islandMaxTypeSize)
      .accessibilityLabel(presentation.spoken)
  }
}

/// Wyspa rozwinięta, lewy górny róg: limit 5 h (bez okna — pusto).
public struct LiveActivityExpandedLeading: View {
  let presentation: LiveActivityPresentation

  public init(presentation: LiveActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    LiveActivityIslandLimit(limit: presentation.limit(.fiveHour))
  }
}

/// Wyspa rozwinięta, prawy górny róg: limit tygodniowy (bez okna — pusto).
public struct LiveActivityExpandedTrailing: View {
  let presentation: LiveActivityPresentation

  public init(presentation: LiveActivityPresentation) {
    self.presentation = presentation
  }

  public var body: some View {
    LiveActivityIslandLimit(limit: presentation.limit(.weekly))
  }
}

/// Limit w rogu wyspy: stała szerokość obok kamery, pismo do ``LiveActivityPresentation/islandMaxTypeSize``.
struct LiveActivityIslandLimit: View {
  let limit: LiveActivityPresentation.Limit?

  var body: some View {
    Group {
      if let limit {
        LiveActivityIslandLimitRow(limit: limit).frame(width: 72)
      } else {
        Color.clear.frame(width: 72, height: 1)
      }
    }
    .dynamicTypeSize(...LiveActivityPresentation.islandMaxTypeSize)
    .accessibilityHidden(true)
  }
}

/// Wyspa rozwinięta, dół: liczniki w jednym wierszu i do dwóch przebiegów (bez nich przy ciszy — zdanie
/// ciszy), przy nieświeżych danych zdanie „nieaktualne · stan z HH:MM" na dole. „+N" i Maca na wyspie nie
/// ma — nie mieszczą się w 160 pt obok limitów w rogach.
public struct LiveActivityExpandedBottom: View {
  let presentation: LiveActivityPresentation
  let isStale: Bool

  public init(presentation: LiveActivityPresentation, isStale: Bool) {
    self.presentation = presentation
    self.isStale = isStale
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 14) {
        LiveActivityInlineCounter(value: presentation.waiting, word: presentation.waitingWord, counter: .waiting)
        LiveActivityInlineCounter(value: presentation.working, word: presentation.workingWord, counter: .working)
        LiveActivityInlineCounter(value: presentation.finished, word: presentation.finishedWord, counter: .finished)
      }
      .minimumScaleFactor(0.8)
      if let note = presentation.quietNote {
        Text(note).font(.caption).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
      } else {
        ForEach(presentation.workflows.indices, id: \.self) { index in
          LiveActivityWorkflowRowView(row: presentation.workflows[index], island: true)
        }
      }
      if isStale {
        Text(LiveActivityPresentation.staleNote(updatedAt: presentation.updatedAt))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(LiveActivityPalette.muted(island: true))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .dynamicTypeSize(...LiveActivityPresentation.islandMaxTypeSize)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.spokenLabel(isStale: isStale))
  }
}
#endif
