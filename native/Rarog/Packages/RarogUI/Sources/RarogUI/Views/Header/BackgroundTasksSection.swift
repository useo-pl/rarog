import RarogCore

/// Znak stanu wiersza zadania „w tle” jako dane (testy na macOS): kropka pracy w `run` albo klepsydra subagenta
/// w postoju w przydymionej zieleni (`runSmoked`). Bez kontaktu ze źródłem oba znaki gasną do `done` (zielony znak
/// przy stojącym zegarze kłamałby).
struct BackgroundTaskMark: Equatable {
  /// Klepsydra (postój); `false` — kropka pracy.
  let hourglass: Bool
  /// Ton znaku: `.working` (`run`), `.backgroundWait` (`runSmoked`) albo `.quiet` (`done`).
  let tone: StatusTone

  static func make(working: Bool, frozen: Bool) -> BackgroundTaskMark {
    BackgroundTaskMark(hourglass: !working, tone: frozen ? .quiet : working ? .working : .backgroundWait)
  }
}

#if os(iOS)
import RarogContract
import SwiftUI
import UIKit

// Treść sekcji „w tle" bez przewijania i kotwicy: nagłówek i wiersze dostają dane
// i akcje z zewnątrz, a chwilę zegarów — od zegara właściciela (tyka co 1 s, bez kontaktu ze źródłem staje,
// `BackgroundFreeze`).
// Składają ją popover pigułki (`BackgroundTasksPanel`) i prawy panel na iPadzie (`InspectorPanel`);
// każdy dokłada własne przewijanie z kotwicą. Identyfikatory XCUITest mówią, gdzie sekcja stoi
// (`SectionPlace`).
//
// Wiersz („bez elips" i „odróżnij to, co pracuje"): kolumna znaku stanu, PEŁNY opis łamany
// w kolejnych liniach i czas po prawej przy pierwszej linii; pod opisem linia meta `rodzaj · komenda · kto i czym`.
// Stan niesie znak i słowo, kolor praca, postój i błąd: kropka `run` — pracuje, klepsydra `runSmoked` — subagent
// w postoju (bursztyn zostaje dla tego, co czeka na człowieka), bez kontaktu ze źródłem oba znaki gasną do
// `done` (zielony znak przy stojącym zegarze kłamałby; `BackgroundTaskMark`). Zadanie bez startu licznika nie dostaje (liczenie od
// „teraz" pokazałoby świeże „0 s" dla czegoś, co mieli od godziny); po godzinie pod licznikiem stoi „od 20:33".
//
// Subagent w postoju ma pod opisem słowa „czeka na własne zadanie", a jego licznik liczy od początku postoju.
// Pod wierszem subagenta stoją jego własne komendy w tle (`ownTasks`): cała komenda mono, łamana, i czas od jej
// startu — na GAŁĘZI (`Branch`): wcięte do osi opisu, z kreską w osi kolumny znaku. Przy agencie w postoju
// poprzedza je linia „czeka na:", przy agencie, który pracuje, stoją bez tych słów. Wiersz z komendą ma w menu
// kontekstowym (i w akcjach czytnika) „Kopiuj komendę" — komendę surową, z nowymi liniami.
//
// Pod wierszem zadania `workflow` z rozkładem stoi jego przebieg, na tej samej gałęzi: linia
// `1/3 faz · 16 skończyło · 1 pracuje`, PIONOWA lista faz (`✓`/`●`/`○`, tytuł, skończeni/ruszyli), a pod
// rozwiniętą fazą najpierw jej żywi agenci, potem wiersz „✓ N skończyło" rozwijany ręcznie. Kolor idzie za stanem:
// zieleń tylko dla tego, co pracuje teraz, ✓ skończonych w `done`. Bieżąca faza jest rozwinięta sama, inne
// rozwija stuknięcie; odświeżenie co 5 s niczego nie zwija i nie przestawia faz (`WorkflowExpansion` trzyma
// właściciel). Właściciel: nagłówek.

/// Gdzie stoi sekcja: popover nagłówka albo prawy panel — przestrzeń identyfikatorów XCUITest. Popover ma
/// identyfikatory sprzed panelu (`header.background.*`, `header.git.*`, przebieg `workflow.*`), panel — te same
/// z przedrostkiem `inspector.`.
enum SectionPlace: Sendable {
  case header
  case inspector

  /// `header.background.task.<id>` albo `inspector.background.task.<id>`.
  func id(_ suffix: String) -> String {
    switch self {
    case .header: "header.\(suffix)"
    case .inspector: "inspector.\(suffix)"
    }
  }

  /// Rozmiar etykiet sekcji: w prawym panelu 14 pt (`Eyebrow.panelSize`), w popoverze zwykłe 12 pt.
  var eyebrowSize: CGFloat? {
    switch self {
    case .header: nil
    case .inspector: Eyebrow.panelSize
    }
  }

  /// Przebieg workflow: `workflow.<zadanie>…` w popoverze, `inspector.workflow.<zadanie>…` w panelu.
  func workflow(_ suffix: String) -> String {
    switch self {
    case .header: "workflow.\(suffix)"
    case .inspector: "inspector.workflow.\(suffix)"
    }
  }
}

extension EnvironmentValues {
  /// Miejsce sekcji (`SectionPlace`): panel ustawia `.inspector`, popover zostaje przy domyślnym.
  @Entry var sectionPlace: SectionPlace = .header
}

/// Zegar sekcji „w tle" popovera: tyka co 1 s, a bez kontaktu ze źródłem staje od początku przerwy — treść dostaje
/// chwilę zegarów i znacznik „ostatni znany stan". Regułę i chwilę zamrożenia trzyma `BackgroundFreeze`,
/// wspólny z prawym panelem, który stawia własny zegar poza leniwym stosem (`InspectorPanel`).
struct BackgroundClock<Content: View>: View {
  let store: RarogStore
  let sessionId: String
  @ViewBuilder let content: (_ now: Date, _ frozen: Bool) -> Content

  @State private var freeze = BackgroundFreeze()

  var body: some View {
    let state = store.state
    let sessionStale = state.sessions[sessionId]?.stale == true
    let listStale = state.listStale
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let frozen = freeze.isFrozen(sessionStale: sessionStale, listStale: listStale, now: context.date)
      content(freeze.clock(frozen: frozen, now: context.date), frozen)
        .onChange(of: frozen, initial: true) { _, frozen in
          freeze.settle(frozen: frozen, now: Date())
        }
    }
    .onChange(of: state.global, initial: true) { _, status in
      freeze.observe(status, now: Date())
    }
  }
}

/// Etykieta „W TLE · N" i — gdy ktoś stoi w postoju — po prawej podział „2 pracują · 1 czeka" (`BackgroundHeader`);
/// w piśmie dostępności podział schodzi pod etykietę. Bez kontaktu ze źródłem pod nimi „ostatni znany stan".
/// Ten sam nagłówek w panelu i w popoverze.
struct BackgroundTasksHeader: View {
  let frozen: Bool
  let header: BackgroundHeader
  @Environment(\.sectionPlace) private var place
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if typeSize.isAccessibilitySize {
        title
        split
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          title
          Spacer(minLength: 8)
          split
        }
      }
      if frozen {
        Label(UICopy.workflowStale, systemImage: "clock")
          .appFont(.caption)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(UICopy.workflowStaleSpoken)
          .accessibilityAddTraits(.isStaticText)
          .accessibilityIdentifier(place.id("background.stale"))
      }
    }
  }

  private var title: some View {
    // Etykieta w `muted` (`Eyebrow`, wspólny styl etykiet sekcji panelu); w prawym panelu większa.
    Text(UICopy.inspectorBackgroundTitle(header.count).uppercased())
      .eyebrow(size: place.eyebrowSize)
      .accessibilityAddTraits(.isHeader)
  }

  @ViewBuilder
  private var split: some View {
    if let split = header.split {
      Text(split)
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(place.id("background.split"))
    }
  }
}

/// Wiersze sekcji płaską listą (`BackgroundPanel.lines`), BEZ własnego kontenera: rodzic stawia je
/// w swoim stosie i to jego `scrollTargetLayout` czyni z nich cele kotwicy (tożsamość = `BackgroundPanelLine.id`).
struct BackgroundTasksRows: View {
  let lines: [BackgroundPanelLine]
  /// Chwila zegarów — tyka i staje u właściciela zegara (zamrożona sekcja liczy od utraty kontaktu).
  let now: Date
  /// Brak kontaktu ze źródłem: znaki pracy gasną (`BackgroundFreeze`).
  let frozen: Bool
  let toggle: (WorkflowExpansion.Key, Bool) -> Void
  let toggleDone: (WorkflowExpansion.Key) -> Void

  var body: some View {
    ForEach(lines) { line in
      BackgroundTasksRow(line: line, now: now, frozen: frozen, toggle: toggle, toggleDone: toggleDone)
    }
  }
}

/// Jedna linia sekcji: wiersz zadania, własna komenda subagenta (z linią „czeka na:" nad nimi przy agencie
/// w postoju) albo linia przebiegu workflow. Prawy panel stawia każdą pod własnym zegarem
/// (`BackgroundTicker`): wiersz ma być bezpośrednim dzieckiem stosu z `scrollTargetLayout` (cel kotwicy), a
/// `TimelineView` wokół całej sekcji tego nie gwarantuje.
struct BackgroundTasksRow: View {
  let line: BackgroundPanelLine
  let now: Date
  let frozen: Bool
  let toggle: (WorkflowExpansion.Key, Bool) -> Void
  let toggleDone: (WorkflowExpansion.Key) -> Void

  var body: some View {
    switch line {
    case let .task(task):
      BackgroundTaskRowView(row: task, now: now, frozen: frozen)
    case .ownLabel:
      // Dla czytnika niema: każda komenda pod nią mówi pełne zdanie („czeka na: pnpm test, od 21 minut").
      Text(UICopy.ownTasksAwaited)
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .padding(.top, 2)
        .modifier(Branch())
        .accessibilityHidden(true)
    case let .ownTask(own):
      OwnTaskRowView(row: own, now: now)
        .modifier(Branch())
    case let .workflow(workflow):
      WorkflowLineView(line: workflow, now: now, frozen: frozen, toggle: toggle, toggleDone: toggleDone)
        .modifier(Branch())
    }
  }
}

/// Chwila zegarów jednego wiersza: tyka co 1 s, a w zamrożonej sekcji stoi na `frozenAt` (`BackgroundFreeze`
/// właściciela sekcji). Zegar per wiersz trzyma wiersz jako cel kotwicy w stosie panelu.
struct BackgroundTicker<Content: View>: View {
  let frozenAt: Date?
  @ViewBuilder let content: (_ now: Date) -> Content

  var body: some View {
    if let frozenAt {
      content(frozenAt)
    } else {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        content(context.date)
      }
    }
  }
}

// MARK: - Siatka wiersza

/// Szerokość kolumny znaku i położenie znaku względem pierwszej linii tekstu — wspólne dla wierszy „w tle",
/// gałęzi i wierszy skończonych, skalowane z pismem.
struct RowGrid {
  /// Kolumna znaku stanu (pt przy domyślnym piśmie).
  static let column: CGFloat = 14
  /// Odstęp kolumny znaku od tekstu; oś opisu = kolumna + odstęp.
  static let gap: CGFloat = 8
}

/// Znak stanu w kolumnie wiersza: wyśrodkowany na połowie wersalika pierwszej linii (`firstTextBaseline` minus
/// połowa wersalika), więc stoi przy pierwszej linii opisu także wtedy, gdy opis łamie się w kilka. Wspólny
/// z wierszem artefaktu w prawym panelu (`ArtifactRowView`) — ta sama gramatyka, nie kopia.
struct RowMark<Mark: View>: View {
  /// Połowa wersalika pisma pierwszej linii (subheadline ≈ 5,3 pt, footnote ≈ 4,6 pt), skalowana z pismem.
  let capMid: CGFloat
  @ViewBuilder let mark: () -> Mark
  @AppScaledMetric(relativeTo: .subheadline) private var column = RowGrid.column

  var body: some View {
    mark()
      .frame(width: column)
      .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + capMid }
      .accessibilityHidden(true)
  }
}

/// Gałąź pod wierszem zadania: dzieci (własne komendy subagenta, przebieg workflow) wcięte do osi opisu, z pionową
/// kreską w osi kolumny znaku. Kreska jest tłem CAŁEJ linii razem z jej odstępem, więc rodzeństwo składa się
/// w ciągłą gałąź (linie muszą zostać rodzeństwem wiersza — cele kotwicy panelu).
private struct Branch: ViewModifier {
  @AppScaledMetric(relativeTo: .subheadline) private var column = RowGrid.column

  func body(content: Content) -> some View {
    content
      .padding(.leading, column + RowGrid.gap)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(alignment: .leading) {
        Rectangle()
          .fill(Color(uiColor: Palette.border))
          .frame(width: 1)
          .offset(x: (column - 1) / 2)
          .accessibilityHidden(true)
      }
  }
}

/// „Kopiuj komendę" w menu kontekstowym i w akcjach czytnika — komenda surowa z kontraktu (heredoc z nowymi
/// liniami). Wiersz bez komendy zostaje bez menu.
private struct CopyCommand: ViewModifier {
  let raw: String?

  func body(content: Content) -> some View {
    if let raw {
      content
        .contextMenu {
          Button(UICopy.copyCommand, systemImage: "doc.on.doc") { UIPasteboard.general.string = raw }
        }
        .accessibilityAction(named: UICopy.copyCommand) { UIPasteboard.general.string = raw }
    } else {
      content
    }
  }
}

// MARK: - Wiersz zadania

private struct BackgroundTaskRowView: View {
  let row: BackgroundTaskRow
  let now: Date
  let frozen: Bool
  @Environment(\.sectionPlace) private var place
  @AppScaledMetric(relativeTo: .subheadline) private var capMid: CGFloat = 5.3
  @AppScaledMetric(relativeTo: .subheadline) private var dot: CGFloat = 6

  var body: some View {
    // Opis pierwszy, przy znaku stanu; pod nim linia „stan · czas", potem meta (jak „pracuje · 6 min"
    // na liście sesji). Czas pod opisem, nie obok: opis ma całą szerokość wiersza.
    HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
      RowMark(capMid: capMid) { mark }
      VStack(alignment: .leading, spacing: 3) {
        Text(row.text.isEmpty ? "—" : row.text)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
        // Stan i czas stoją PRZED linią meta: to one mówią, czy agent pracuje i od kiedy.
        StateLine(parts: status)
        meta
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 6)
    // Cecha tekstu: element złożony bez cechy audyt brał za kontrolkę („za mały cel dotyku").
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken(now: now))
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier(place.id("background.task.\(row.id)"))
    .modifier(CopyCommand(raw: row.rawCommand))
  }

  /// Kropka pracy (`run`) albo klepsydra postoju (`runSmoked`); bez kontaktu ze źródłem obie w `done`.
  @ViewBuilder
  private var mark: some View {
    let mark = BackgroundTaskMark.make(working: row.working, frozen: frozen)
    let ink = Color(uiColor: Palette.tone(mark.tone))
    if mark.hourglass {
      Image(systemName: "hourglass")
        .appFont(.caption.weight(.semibold))
        .imageScale(.small)
        .foregroundStyle(ink)
    } else {
      Circle()
        .fill(ink)
        .frame(width: dot, height: dot)
    }
  }

  /// `rodzaj · narzędzia komendy · kto i czym`: rodzaj cichszym atramentem, reszta w `muted`; łamie się jak opis.
  private var meta: some View {
    let kind = Text(row.kind).foregroundStyle(Color(uiColor: Palette.muted2))
    let line: Text = row.detail.isEmpty ? kind : Text("\(kind) · \(row.detail)")
    return line
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: Palette.muted))
      .fixedSize(horizontal: false, vertical: true)
  }

  /// „czeka na własne zadanie · 18 min", „5 min", po godzinie „2 h 05 · od 20:33": stan i licznik w `muted`
  /// (praca od startu zadania, postój od swojego początku — `BackgroundTaskRow.clockSince`), „od …" ciszej.
  private var status: [StateLine.Part] {
    row.status(now: now).map { StateLine.Part(text: $0, ink: Palette.muted) }
      + (row.since(now: now).map { [StateLine.Part(text: $0, ink: Palette.muted2)] } ?? [])
  }
}

/// Linia „stan · czas" pod opisem wiersza („5 min", „czeka na własne zadanie · 18 min", „kod 1 · 2 h temu ·
/// 12:31"): człony sklejone „ · ", każdy w swoim atramencie, pismo zwykłe z cyframi w stałej szerokości. Bez
/// członów linii nie ma. Wspólna dla wierszy „w tle", skończonych i artefaktów.
struct StateLine: View {
  struct Part {
    let text: String
    let ink: UIColor
  }

  let parts: [Part]

  var body: some View {
    if let first = parts.first {
      parts.dropFirst()
        .reduce(Text(first.text).foregroundStyle(Color(uiColor: first.ink))) { line, part in
          Text("\(line) · \(Text(part.text).foregroundStyle(Color(uiColor: part.ink)))")
        }
        .appFont(.caption.monospacedDigit())
        .foregroundStyle(Color(uiColor: Palette.muted2))
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// Własna komenda subagenta w jednej linii: narzędzia komendy mono (`OwnTaskRow.tools`; pełną ma „Kopiuj
/// komendę") i za nimi czas od jej startu. Bez treści komendy stoi samo słowo „komenda", bez startu nie ma licznika.
private struct OwnTaskRowView: View {
  let row: OwnTaskRow
  let now: Date
  @Environment(\.sectionPlace) private var place
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    line
      .appFont(.caption.monospacedDigit())
      .foregroundStyle(Color(uiColor: Palette.muted2))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 3)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken(now: now))
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier(place.id("background.task.\(row.task).own.\(row.ownId)"))
    .modifier(CopyCommand(raw: row.rawCommand))
  }

  private var line: Text {
    let command = Text(row.text)
      .appFont(row.command == nil ? .caption : .caption.monospaced(), typeSize)
      .foregroundStyle(Color(uiColor: Palette.muted))
    guard let startedAt = row.startedAt else { return command }
    return Text("\(command) · \(RelativeTime.short(since: startedAt, now: now))")
  }
}

// MARK: - Skończone ostatnio (panel i popover)

/// Etykieta sekcji w stylu nagłówka „W TLE" (`Eyebrow`); w prawym panelu większa, jak tamten nagłówek.
struct BackgroundSectionTitle: View {
  let text: String
  @Environment(\.sectionPlace) private var place

  var body: some View {
    Text(text.uppercased())
      .eyebrow(size: place.eyebrowSize)
      .accessibilityAddTraits(.isHeader)
  }
}

/// Zakończenie zadania w tle — wspólne dla panelu (do 6) i popovera (do 3). Historia stoi ciszej niż to, co
/// trwa: znak wyniku (✓ ■ ? w `done`, ✗ w `err`), nazwa `footnote` w `text2` (niepowodzenie w `text`), pod nią
/// jedna linia „stan · czas": dopisek wyniku (kod wyjścia czerwienią), ile temu i godzina, od doby dzień —
/// „kod 1 · 2 h temu · 12:31" (rodzaju wiersz nie podpisuje). Nazwa pełna (serwer tnie ją do
/// 80 znaków).
struct FinishedTaskRowView: View {
  let row: FinishedTaskRow
  /// `inspector.finished.<id>` w panelu, `header.finished.<id>` w popoverze.
  let identifier: String
  @AppScaledMetric(relativeTo: .footnote) private var capMid: CGFloat = 4.6

  /// Co ile wiersz liczy „ile temu" od nowa: skala to minuty, więc pół minuty wystarcza.
  static let refresh: TimeInterval = 30

  var body: some View {
    // Zegar per wiersz, jak `BackgroundTicker`: wiersz zostaje bezpośrednim dzieckiem stosu z kotwicą panelu.
    TimelineView(.periodic(from: .now, by: Self.refresh)) { context in
      content(now: context.date)
    }
  }

  private func content(now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
      RowMark(capMid: capMid) {
        Image(systemName: symbol)
          .appFont(.caption.weight(.semibold))
          .imageScale(.small)
          .foregroundStyle(Color(uiColor: row.failed ? Palette.err : Palette.done))
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: row.failed ? Palette.text : Palette.text2))
          .fixedSize(horizontal: false, vertical: true)
        StateLine(parts: status(now: now))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(row.spoken(now: now))
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier(identifier)
  }

  /// „kod 1 · 2 h temu · 12:31": dopisek wyniku przy niepowodzeniu czerwienią, reszta cichym atramentem — linia
  /// stoi ciszej niż nazwa. Sukces nie ma dopisku, czas, który nie jest czasem, nie daje członów.
  private func status(now: Date) -> [StateLine.Part] {
    var parts: [StateLine.Part] = []
    if let note = row.note { parts.append(.init(text: note, ink: row.failed ? Palette.err : Palette.muted2)) }
    for text in [row.ago(now: now), row.stamp(now: now)] {
      if let text { parts.append(.init(text: text, ink: Palette.muted2)) }
    }
    return parts
  }

  /// Znak wyniku: ✓ skończone, ✗ niepowodzenie, ■ zatrzymane, ? wynik nieznany (brak NIE znaczy sukcesu).
  /// Postój subagenta (`waiting`) do tej sekcji nie trafia (`FinishedTasks.rows`); klepsydra domyka `switch`.
  private var symbol: String {
    switch row.outcome {
    case .done?: "checkmark"
    case .failed?: "xmark"
    case .halted?: "stop.fill"
    case .waiting?: "hourglass"
    case nil: "questionmark"
    }
  }
}

// MARK: - Przebieg workflow

/// Jedna linia sekcji przebiegu. Czytnik dostaje podsumowanie jednym zdaniem (osobny element), fazy jako
/// przyciski z wartością „rozwinięte/zwinięte", agentów rozwiniętych faz po jednym.
private struct WorkflowLineView: View {
  let line: WorkflowLine
  let now: Date
  let frozen: Bool
  let toggle: (WorkflowExpansion.Key, Bool) -> Void
  let toggleDone: (WorkflowExpansion.Key) -> Void
  @Environment(\.sectionPlace) private var place

  var body: some View {
    switch line {
    case let .summary(task, summary):
      Text(summary.text)
        .appFont(.caption.monospacedDigit())
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 2)
        .accessibilityLabel(summary.spoken)
        .accessibilityIdentifier(place.workflow("\(task).summary"))
    case let .plan(task, text):
      // Przebieg bez tagów: sam plan, bez glifów i licznika — stanu faz nie znamy.
      Text(text)
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 4)
        .accessibilityIdentifier(place.workflow("\(task).plan"))
    case let .agentsLabel(task):
      Text(UICopy.workflowAgentsLabel.uppercased())
        .eyebrow()
        .padding(.top, 6)
        .padding(.bottom, 2)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier(place.workflow("\(task).agents"))
    case let .phase(item, expanded):
      WorkflowPhaseRowView(item: item, expanded: expanded, frozen: frozen) { toggle(item.key, item.isCurrent) }
    case let .agent(task, agent):
      WorkflowAgentRowView(task: task, agent: agent, now: now, frozen: frozen)
    case let .doneGroup(group, expanded):
      WorkflowDoneGroupRowView(group: group, expanded: expanded) { toggleDone(group.key) }
    }
  }
}

/// Siatka przebiegu: faza, agent i „✓ N skończyło”
/// mają tę samą wysokość linii, a glif każdej z nich stoi w kolumnie tej samej szerokości. Poziom wcina o kolumnę
/// i odstęp, więc glif żywego agenta i wiersza „✓ N skończyło” stoi w osi tytułu fazy, a glif skończonego agenta —
/// w osi napisu „N skończyło” (✓, ● i ○ mają różną szerokość, więc stałe wcięcie nie trafiłoby w żadną oś).
private enum WorkflowGrid {
  /// Kolumna glifu (pt przy domyślnym piśmie).
  static let glyph: CGFloat = 12
  /// Odstęp glifu od tekstu; krok wcięcia poziomu = kolumna + odstęp.
  static let gap: CGFloat = 6
  /// Wysokość linii (pt przy domyślnym piśmie); tekst łamany w kilka linii ją podnosi.
  static let row: CGFloat = 24
}

/// Glif linii przebiegu w kolumnie siatki, półgruby i mały, w piśmie swojej linii.
private struct WorkflowGlyph: View {
  let symbol: String
  let font: AppFont
  let ink: UIColor
  @AppScaledMetric(relativeTo: .footnote) private var width = WorkflowGrid.glyph

  var body: some View {
    Image(systemName: symbol)
      .appFont(font.weight(.semibold))
      .imageScale(.small)
      .foregroundStyle(Color(uiColor: ink))
      .frame(width: width)
      .accessibilityHidden(true)
  }
}

/// Linia przebiegu na siatce: wcięcie poziomu (0 — faza, 1 — żywy agent i „✓ N skończyło”, 2 — skończony agent)
/// i wysokość linii, oba skalowane z pismem. Cała linia jest celem stuknięcia.
private struct WorkflowRowFrame: ViewModifier {
  let level: Int
  @AppScaledMetric(relativeTo: .footnote) private var glyph = WorkflowGrid.glyph
  @AppScaledMetric(relativeTo: .footnote) private var height = WorkflowGrid.row

  func body(content: Content) -> some View {
    content
      .padding(.leading, CGFloat(level) * (glyph + WorkflowGrid.gap))
      // Oddech dla linii łamanej w kilka (faza z dopiskiem, długa nazwa agenta); jednej linii nie podnosi.
      .padding(.vertical, 2)
      .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
      .contentShape(Rectangle())
  }
}

/// Kolor znaku stanu w przebiegu: zieleń tylko dla tego, co pracuje teraz (bez kontaktu ze źródłem gaśnie),
/// ✓ skończonych w `done`, ○ tego, co nie ruszyło, w `muted`. Znak niesie znaczenie, kolor je powtarza.
private func workflowInk(_ state: WorkflowPhaseState, frozen: Bool) -> UIColor {
  switch state {
  case .running: frozen ? Palette.done : Palette.run
  case .done: Palette.done
  case .pending: Palette.muted
  }
}

/// Wiersz fazy: glif stanu, tytuł, `skończeni/ruszyli` i chevron. Bieżąca faza pogrubiona; spoza planu
/// i „bez fazy" z dopiskiem pod tytułem. Faza, która nie ruszyła, nie ma czego rozwinąć — nie jest przyciskiem.
private struct WorkflowPhaseRowView: View {
  let item: WorkflowPhaseItem
  let expanded: Bool
  let frozen: Bool
  let toggle: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.sectionPlace) private var place

  private var identifier: String { place.workflow("\(item.key.task).phase.\(item.title)") }

  var body: some View {
    if item.expandable {
      Button(action: toggle) { label }
        .buttonStyle(.plain)
        .accessibilityLabel(item.spoken)
        .accessibilityValue(expanded ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed)
        .accessibilityIdentifier(identifier)
    } else {
      label
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.spoken)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(identifier)
    }
  }

  private var label: some View {
    HStack(alignment: .firstTextBaseline, spacing: WorkflowGrid.gap) {
      WorkflowGlyph(symbol: item.symbol, font: .footnote, ink: workflowInk(item.state, frozen: frozen))
      VStack(alignment: .leading, spacing: 0) {
        Text(item.title)
          .appFont(.footnote.weight(item.state == .running && !item.secondary ? .semibold : .regular))
          .foregroundStyle(Color(uiColor: item.state == .running && !item.secondary ? Palette.text : Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
        if let note = item.note {
          Text(note)
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
        }
        // W piśmie dostępności licznik schodzi pod tytuł: obok niego tytuł łamał się w środku słowa.
        if typeSize.isAccessibilitySize { count }
      }
      Spacer(minLength: 8)
      if !typeSize.isAccessibilitySize { count }
      if item.expandable {
        Image(systemName: "chevron.right")
          .appFont(.caption.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.muted))
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: expanded)
      }
    }
    .modifier(WorkflowRowFrame(level: 0))
  }

  @ViewBuilder
  private var count: some View {
    if let count = item.count {
      Text(count)
        .appFont(.caption.monospacedDigit())
        .foregroundStyle(Color(uiColor: Palette.muted))
    }
  }
}

/// Agent pod rozwiniętą fazą: `●` żywy z czasem od startu (zieleń; bez kontaktu ze źródłem gaśnie), `✓` skończony
/// w `done`, bez czasu (czasu końca serwer nie daje). Nazwa mono, jak etykiety tagów `[faza · etykieta]`.
private struct WorkflowAgentRowView: View {
  let task: String
  let agent: WorkflowAgentItem
  let now: Date
  let frozen: Bool
  @Environment(\.sectionPlace) private var place

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: WorkflowGrid.gap) {
      WorkflowGlyph(
        symbol: agent.symbol, font: .caption, ink: workflowInk(agent.done ? .done : .running, frozen: frozen))
      Text(agent.name)
        .appFont(.caption.monospaced())
        .foregroundStyle(Color(uiColor: agent.done ? Palette.muted : Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      if let since = agent.since {
        Text(RelativeTime.short(since: since, now: now))
          .appFont(.caption.monospacedDigit())
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
    // Żywy glifem w osi tytułu fazy, skończony — w osi napisu swojego wiersza „✓ N skończyło".
    .modifier(WorkflowRowFrame(level: agent.done ? 2 : 1))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.workflowAgentSpoken(agent, now: now))
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier(place.workflow("\(task).agent.\(agent.id)"))
  }
}

/// „✓ 44 skończyło" pod żywymi agentami fazy: przycisk, który ręcznie rozwija listę skończonych (domyślnie
/// zwinięta). Glif w `done`, napis w `muted` (`done` nie trzyma progu tekstu na `surface`). Celem jest cała linia
/// siatki (`WorkflowGrid`); czytnik słyszy, czyja to lista, i wartość „rozwinięte/zwinięte".
private struct WorkflowDoneGroupRowView: View {
  let group: WorkflowDoneGroup
  let expanded: Bool
  let toggle: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.sectionPlace) private var place

  var body: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: WorkflowGrid.gap) {
        WorkflowGlyph(symbol: "checkmark", font: .caption, ink: Palette.done)
        Text(UICopy.agentsDone(group.count))
          .appFont(.caption)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .appFont(.caption.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.muted))
          .rotationEffect(.degrees(expanded ? 90 : 0))
          .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: expanded)
      }
      .modifier(WorkflowRowFrame(level: 1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(group.spoken)
    .accessibilityValue(expanded ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed)
    .accessibilityIdentifier(place.workflow("\(group.key.task).done.\(group.title)"))
  }
}
#endif
