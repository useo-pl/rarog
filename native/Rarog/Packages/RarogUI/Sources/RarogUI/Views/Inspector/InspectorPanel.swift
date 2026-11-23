#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// Prawy panel sesji na iPadzie, a na telefonie ten sam panel w arkuszu
/// (`InspectorPanel+Sheet.swift`): W TLE (te same wiersze co popover pigułki, ta
/// sama reguła zamrożenia `BackgroundFreeze`), SKOŃCZONE OSTATNIO (notki zakończenia zadań z ogona transkryptu),
/// SCHEDULED TASKS (`SessionSummary.scheduledTasks`, `InspectorScheduledSection.swift`),
/// ARTEFAKTY (`SessionSummary.artifacts`), PULL REQUESTY (`SessionSummary.pullRequests`) i ZMIANY
/// W KATALOGU (ramka `git-status`) w JEDNYM przewijaniu z JEDNĄ kotwicą — wierszem „w tle" albo nagłówkiem sekcji.
/// Co sekundę tyka tylko sekcja W TLE (w każdym wierszu osobno, a zamrożenie liczy niewidoczny zegar panelu poza
/// stosem); wiersz skończonego zadania, artefaktu i PR liczy „ile temu" od nowa co pół minuty. Panel NIE pobiera
/// diffa: wiersze plików idą z `fileDetails`, a listę i patch stukniętego pliku pobiera dopiero okno
/// diffa (`RarogNavigation.openDiff`). Kotwica i rozwinięcia faz należą do sesji (`RarogInspector`), zwinięcie
/// całego drzewa zmian — do urządzenia; okno diffa zamyka zmiana ekranu (`RarogNavigation.detail`).
/// Właściciel: panel.
struct InspectorPanel: View {
  let store: RarogStore
  let sessionId: String
  /// Strumień sesji bez kontaktu: zmiany w katalogu to ostatni znany stan.
  let gitStale: Bool
  /// Kolumna obok transkryptu (iPad) albo arkusz (telefon, `InspectorPanel+Sheet.swift`).
  var placement: InspectorPlacement = .column
  @Environment(RarogNavigation.self) private var navigation
  /// Zamrożenie zegarów sekcji W TLE. Trzyma je panel, a liczy zegar w tle panelu — POZA leniwym stosem, więc
  /// działa także wtedy, gdy nagłówek sekcji jest przewinięty poza ekran.
  @State private var freeze = BackgroundFreeze()
  /// Merged and closed PRs unfolded. Folded by default; the panel is rebuilt for each session (`DetailView`, `.id`),
  /// so another session, or the panel closing, folds them again.
  @State private var settledOpen = false
  /// Ile klawiatura ekranowa zasłania panel od dołu (panel stoi pod `.ignoresSafeArea(.keyboard)` razem z ekranem
  /// sesji, więc odmierza ją sam).
  @State private var keyboard: CGFloat = 0
  /// The moment the Scheduled Tasks rows are chosen at: moved by `ScheduledTasksClock` when the visible set changes,
  /// on a new list from the server and on return to the foreground, so an expired task leaves without a new frame
  /// and a task that arrives already expired never shows.
  @State private var scheduleNow = Date()
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    let state = store.state
    let inspector = navigation.inspector
    let session = state.sessions[sessionId]
    let tasks = session?.backgroundTasks ?? []
    let lines = BackgroundPanel.lines(
      tasks, choices: state.sessionControls.models ?? [], expansion: inspector.expansions[sessionId] ?? WorkflowExpansion())
    let fresh = state.transcripts[sessionId]?.git
    let changes = InspectorChanges.make(meta: GitMeta(session: session, fresh: fresh), fresh: fresh, stale: gitStale)
    let finished = FinishedTasks.rows(state.transcripts[sessionId]?.messages ?? [])
    let scheduledTasks = session?.scheduledTasks ?? []
    let scheduled = ScheduledTaskRows.rows(scheduledTasks, now: scheduleNow)
    let artifacts = ArtifactRows.rows(session?.artifacts ?? [])
    let pullRequests = PullRequestRows.rows(session?.pullRequests ?? [])
    placed(ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        // Nagłówek i wiersze tylko czytają zamrożenie panelu; wiersze tykają pod własnym zegarem od tej samej chwili.
        // Wiersz musi być bezpośrednim dzieckiem stosu z `scrollTargetLayout`, żeby był celem kotwicy, a
        // `TimelineView` wokół całej sekcji tego nie gwarantuje (`InspectorUITests`).
        BackgroundTasksHeader(frozen: freeze.frozenAt != nil, header: BackgroundHeader(tasks))
          .padding(.bottom, 10)
          .id(InspectorModel.backgroundAnchor)
        if lines.isEmpty {
          Text(UICopy.inspectorNothingInBackground)
            .appFont(.subheadline)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .accessibilityIdentifier("inspector.background.empty")
        }
        ForEach(lines) { line in
          BackgroundTicker(frozenAt: freeze.frozenAt) { now in
            BackgroundTasksRow(
              line: line, now: now, frozen: freeze.frozenAt != nil,
              toggle: { key, current in expand(inspector) { $0.toggle(key, current: current) } },
              toggleDone: { key in expand(inspector) { $0.toggleDone(key) } })
          }
        }
        if !finished.isEmpty {
          InspectorFinishedSection(rows: finished)
        }
        if !scheduled.isEmpty {
          InspectorScheduledSection(rows: scheduled)
        }
        if !artifacts.isEmpty {
          InspectorArtifactsSection(rows: artifacts)
        }
        if !pullRequests.isEmpty {
          InspectorPullRequestsSection(
            rows: pullRequests, settledOpen: settledOpen,
            toggleSettled: { settledOpen.toggle() })
        }
        InspectorChangesSection(
          changes: changes, sectionCollapsed: inspector.changesCollapsed,
          toggleSection: { inspector.setChangesCollapsed(!inspector.changesCollapsed) },
          collapsed: inspector.collapsedDirs[sessionId] ?? [],
          toggle: { inspector.collapsedDirs[sessionId, default: []].formSymmetricDifference([$0]) }
        ) { path in
          // Każde otwarcie okna to świeży odczyt listy i patcha TEGO pliku — panel sam niczego nie pobiera.
          navigation.openDiff(sessionId: sessionId, path: path)
        }
      }
      .scrollTargetLayout()
      .padding(.horizontal, 20)
      .padding(.top, 18)
      .padding(.bottom, 24)
    }
    .scrollPosition(id: anchor(inspector), anchor: .top)
    .environment(\.sectionPlace, .inspector))
    // Zegar zamrożenia W TLE poza leniwym stosem: żyje, dopóki stoi panel, niezależnie od przewinięcia.
    .background { freezeClock(state) }
    .background { ScheduledTasksClock(tasks: scheduledTasks) { scheduleNow = $0 } }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { scheduleNow = Date() }
    }
    .onChange(of: scheduledTasks) { _, _ in scheduleNow = Date() }
    .onChange(of: BackgroundPanel.currentKeys(tasks), initial: true) { _, keys in
      expand(inspector) { $0.noteCurrent(keys) }
    }
    .onChange(of: state.global, initial: true) { _, status in
      freeze.observe(status, now: Date())
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(UICopy.inspectorLabel)
    .accessibilityIdentifier("inspector.panel")
  }

  /// Column: the width from `RarogInspector.displayedWidth`, the background, the hairline next to the transcript
  /// (its width handle stands in `DetailView`) and the panel's own keyboard measurement. Sheet: the container
  /// provides all of that (`InspectorPanel+Sheet.swift`).
  @ViewBuilder
  private func placed(_ scroll: some View) -> some View {
    switch placement {
    case .column:
      scroll
        .safeAreaPadding(.bottom, keyboard)
        .frame(width: navigation.inspector.displayedWidth)
        .frame(maxHeight: .infinity)
        // Bok iPada o stopień od transkryptu (`--sidebar`), jak lista z lewej.
        .background(Color(uiColor: Palette.sidebar))
        .background { KeyboardProbe { keyboard = $0 } }
        .overlay(alignment: .leading) { ColumnDivider() }
    case .sheet:
      scroll
    }
  }

  /// Tyk co 1 s, który ocenia regułę „bez kontaktu ze źródłem" (próg „łączę…" po sekundzie) i zapisuje chwilę
  /// zamrożenia przy zmianie. Niewidoczny, panel przerysowuje się tylko przy zamrożeniu i odmrożeniu.
  private func freezeClock(_ state: AppState) -> some View {
    let sessionStale = state.sessions[sessionId]?.stale == true
    let listStale = state.listStale
    return TimelineView(.periodic(from: .now, by: 1)) { context in
      let frozen = freeze.isFrozen(sessionStale: sessionStale, listStale: listStale, now: context.date)
      Color.clear
        .onChange(of: frozen, initial: true) { _, frozen in freeze.settle(frozen: frozen, now: Date()) }
    }
    .accessibilityHidden(true)
  }

  /// Rozwinięcia faz TEJ sesji.
  private func expand(_ inspector: RarogInspector, _ change: (inout WorkflowExpansion) -> Void) {
    change(&inspector.expansions[sessionId, default: WorkflowExpansion()])
  }

  /// Kotwica TEJ sesji: powrót do sesji wraca na jej miejsce, inna sesja nie dostaje cudzego.
  private func anchor(_ inspector: RarogInspector) -> Binding<String?> {
    Binding(get: { inspector.anchors[sessionId] }, set: { inspector.anchors[sessionId] = $0 })
  }
}

// MARK: - Skończone ostatnio

/// Ostatnie zakończenia zadań w tle (do `FinishedTasks.limit`), ciszej niż to, co trwa (`FinishedTaskRowView`,
/// wspólny z popoverem). Wiersze płasko, bez kontenera — każdy jest celem kotwicy panelu.
private struct InspectorFinishedSection: View {
  let rows: [FinishedTaskRow]

  var body: some View {
    BackgroundSectionTitle(text: UICopy.inspectorFinishedTitle)
      .padding(.top, 22)
      .padding(.bottom, 10)
      .id(InspectorModel.finishedAnchor)
      .accessibilityIdentifier("inspector.finished.title")
    ForEach(rows) { row in
      FinishedTaskRowView(row: row, identifier: "inspector.finished.\(row.id)")
    }
  }
}

// MARK: - Artefakty

/// ARTEFAKTY: strony na claude.ai opublikowane w bieżącej rozmowie sesji, najnowsza publikacja pierwsza;
/// sekcja stoi tylko z wierszami i się nie zwija (zmierzone maksimum to cztery). Nad etykietą kreska jak nad
/// ZMIANAMI W KATALOGU. Wiersze płasko, bez kontenera — każdy jest celem kotwicy panelu.
private struct InspectorArtifactsSection: View {
  let rows: [ArtifactRow]

  var body: some View {
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 22)
      .accessibilityHidden(true)
    BackgroundSectionTitle(text: UICopy.inspectorArtifactsTitle)
      .padding(.top, 18)
      .padding(.bottom, 10)
      .id(InspectorModel.artifactsAnchor)
      .accessibilityIdentifier("inspector.artifacts.title")
    ForEach(rows) { row in
      ArtifactRowView(row: row)
    }
  }
}

/// Wiersz artefaktu w gramatyce „Skończonych” (`FinishedTaskRowView`): glif w kolumnie znaku (`RowMark`), tytuł
/// `footnote`, pełny, pod nim linia czasu w `muted2` (`StateLine`: „2 h temu · 14:05”, od doby „3 d temu · 9 paź”).
/// Aktywny artefakt (link) ma glif i tytuł w kolorze linku transkryptu (`linkInk`, bez podkreślenia), żeby był
/// lepiej widoczny; tytuł pod wskaźnikiem w `text`. Stuknięcie otwiera adres
/// systemem (`openURL`) w przeglądarce domyślnej, nie w apce Claude: adres po walidacji dostaje `#no_universal_links`;
/// przeglądarki w apce nie ma. Usunięty (i adres spoza gramatyki) nie jest przyciskiem: glif bez
/// strzałki w `muted2`, a usunięty ma tytuł w `muted` i linię „usunięty · …”.
private struct ArtifactRowView: View {
  let row: ArtifactRow
  @Environment(\.openURL) private var openURL
  @State private var hovered = false
  @AppScaledMetric(relativeTo: .footnote) private var capMid: CGFloat = 4.6

  private var identifier: String { "inspector.artifact.\(row.id)" }

  var body: some View {
    // Zegar per wiersz, jak `FinishedTaskRowView`: wiersz zostaje bezpośrednim dzieckiem stosu z kotwicą panelu.
    TimelineView(.periodic(from: .now, by: FinishedTaskRowView.refresh)) { context in
      content(now: context.date)
    }
  }

  @ViewBuilder
  private func content(now: Date) -> some View {
    if let link = row.link {
      Button {
        openURL(BrowserLinks.outside(link))
      } label: {
        label(now: now)
      }
      .buttonStyle(.plain)
      .onHover { hovered = $0 }
      .accessibilityLabel(row.spoken(now: now))
      .accessibilityRemoveTraits(.isButton)
      .accessibilityAddTraits(.isLink)
      .accessibilityIdentifier(identifier)
    } else {
      label(now: now)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.spoken(now: now))
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(identifier)
    }
  }

  private func label(now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
      RowMark(capMid: capMid) {
        // Strzałka z kwadratu zapowiada wyjście z apki; kwadrat z przerywaną krawędzią — strony już nie ma. Skala
        // średnia, nie mała jak znak „Skończonych”: w małej strzałka w kwadracie na zrzucie ginęła.
        Image(systemName: row.link != nil ? "arrow.up.right.square" : "square.dashed")
          .appFont(.caption.weight(.medium))
          .imageScale(.medium)
          .foregroundStyle(Color(uiColor: row.link != nil ? Palette.linkInk : Palette.muted2))
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: titleInk))
          .fixedSize(horizontal: false, vertical: true)
        StateLine(parts: status(now: now))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 6)
    .contentShape(Rectangle())
  }

  private var titleInk: UIColor {
    if row.gone { return Palette.muted }
    guard row.link != nil else { return Palette.text2 }
    return hovered ? Palette.text : Palette.linkInk
  }

  /// „usunięty · 2 h temu · 14:05” albo samo „2 h temu · 14:05”; czas, który nie jest czasem, nie daje członów.
  private func status(now: Date) -> [StateLine.Part] {
    let gone = row.gone ? [UICopy.artifactGone] : []
    return (gone + [row.ago(now: now), row.stamp(now: now)].compactMap { $0 })
      .map { StateLine.Part(text: $0, ink: Palette.muted2) }
  }
}

// MARK: - Pull requesty

/// PULL REQUESTY (`docs/pull-requests.md`): PR-y utworzone w bieżącej rozmowie sesji (`gh pr create` agenta,
/// subagenta albo agenta workflow), najnowszy pierwszy; sekcja stoi tylko z wierszami (serwer wysyła najwyżej 20).
/// Kreska nad etykietą i wiersze płasko, bez kontenera, jak ARTEFAKTY — każdy wiersz jest celem kotwicy panelu.
/// Open, draft and unknown-state PRs stay in view; merged and closed ones fold under one row at the end
/// (`PullRequestRows.split`), folded by default.
private struct InspectorPullRequestsSection: View {
  let rows: [PullRequestRow]
  let settledOpen: Bool
  let toggleSettled: () -> Void

  var body: some View {
    let split = PullRequestRows.split(rows)
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 22)
      .accessibilityHidden(true)
    BackgroundSectionTitle(text: UICopy.inspectorPullRequestsTitle)
      .padding(.top, 18)
      .padding(.bottom, 10)
      .id(InspectorModel.pullRequestsAnchor)
      .accessibilityIdentifier("inspector.pullRequests.title")
    ForEach(split.shown) { row in
      PullRequestRowView(row: row)
    }
    if !split.folded.isEmpty {
      PullRequestsSettledRow(count: split.folded.count, open: settledOpen, toggle: toggleSettled)
      if settledOpen {
        ForEach(split.folded) { row in
          PullRequestRowView(row: row)
        }
      }
    }
  }
}

/// "Merged and Closed (3)" at the end of the PR section: a button that unfolds the merged and closed PRs under it.
/// The chevron sits in the glyph column of the PR rows and turns like the phase and directory chevrons; the label in
/// `text2`, the count in `muted2` like the rest of the metadata. VoiceOver hears the label with the count and the
/// expanded or collapsed value.
private struct PullRequestsSettledRow: View {
  let count: Int
  let open: Bool
  let toggle: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @AppScaledMetric(relativeTo: .footnote) private var capMid: CGFloat = 4.6

  var body: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
        RowMark(capMid: capMid) {
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(open ? 90 : 0))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: open)
        }
        Text(UICopy.pullRequestsSettled)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.text2))
        Text(UICopy.pullRequestsSettledCount(count))
          .appFont(.footnote.monospacedDigit())
          .foregroundStyle(Color(uiColor: Palette.muted2))
        Spacer(minLength: 8)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(UICopy.pullRequestsSettledSpoken(count))
    .accessibilityValue(open ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed)
    .accessibilityIdentifier("inspector.pullRequests.settled")
  }
}

/// PR row in the artifact look (`ArtifactRowView`): the PR glyph in the mark column, the first line in `footnote`
/// (the `--title`, without it `owner/repo#n`), under it the GitHub state label when the server knows it (the word
/// in a capsule of GitHub's state colour, `PullRequestStateTokens`) and a line in `muted2` ("acme/widget#42 · 2 h
/// ago · 14:05").
/// A PR whose address passes the grammar is a link: glyph and first line in `linkInk`, no underline, the first line
/// in `text` under the pointer. A tap hands the address to the system (`openURL`): the default browser or an app
/// that takes github.com addresses; the app has no browser of its own. An address outside the grammar is
/// not a button: glyph and first line in `muted2`/`text2`.
private struct PullRequestRowView: View {
  let row: PullRequestRow
  @Environment(\.openURL) private var openURL
  @State private var hovered = false
  @AppScaledMetric(relativeTo: .footnote) private var capMid: CGFloat = 4.6

  private var identifier: String { "inspector.pullRequest.\(row.id)" }

  var body: some View {
    // Zegar per wiersz, jak `FinishedTaskRowView`: wiersz zostaje bezpośrednim dzieckiem stosu z kotwicą panelu.
    TimelineView(.periodic(from: .now, by: FinishedTaskRowView.refresh)) { context in
      content(now: context.date)
    }
  }

  @ViewBuilder
  private func content(now: Date) -> some View {
    if let link = row.link {
      Button {
        openURL(BrowserLinks.outside(link))
      } label: {
        label(now: now)
      }
      .buttonStyle(.plain)
      .onHover { hovered = $0 }
      .accessibilityLabel(row.spoken(now: now))
      .accessibilityRemoveTraits(.isButton)
      .accessibilityAddTraits(.isLink)
      .accessibilityIdentifier(identifier)
    } else {
      label(now: now)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.spoken(now: now))
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(identifier)
    }
  }

  private func label(now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: RowGrid.gap) {
      RowMark(capMid: capMid) {
        Image(systemName: "arrow.triangle.pull")
          .appFont(.caption.weight(.medium))
          .imageScale(.medium)
          .foregroundStyle(Color(uiColor: row.link != nil ? Palette.linkInk : Palette.muted2))
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(row.heading)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: headingInk))
          .fixedSize(horizontal: false, vertical: true)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          if let state = row.state, let word = row.stateWord {
            PullRequestStateLabel(state: state, word: word)
          }
          StateLine(parts: row.status(now: now).map { StateLine.Part(text: $0, ink: Palette.muted2) })
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 6)
    .contentShape(Rectangle())
  }

  private var headingInk: UIColor {
    guard row.link != nil else { return Palette.text2 }
    return hovered ? Palette.text : Palette.linkInk
  }
}

/// GitHub state of a PR as a label: the word in white on a capsule of GitHub's state colour (green open, grey draft,
/// purple merged, red closed; `PullRequestStateTokens`). The row's VoiceOver label already speaks the word.
struct PullRequestStateLabel: View {
  let state: PullRequestState
  let word: String

  var body: some View {
    Text(word)
      .appFont(.caption.weight(.semibold))
      .foregroundStyle(Color(uiColor: Palette.dynamic(PullRequestStateTokens.ink)))
      .padding(.horizontal, 6)
      .padding(.vertical, 1)
      .background(Capsule().fill(Color(uiColor: Palette.dynamic(PullRequestStateTokens.fill(state)))))
      .fixedSize()
      // Aligned on the text baseline the capsule read as sitting high next to the grey line;
      // 1 pt down, drawing only, the row height does not change.
      .offset(y: 1)
      .accessibilityHidden(true)
  }
}

// MARK: - Zmiany w katalogu

/// ZMIANY W KATALOGU: nagłówek z liczbą, przy braku kontaktu „ostatni znany stan", drzewo plików (`ChangesTree`:
/// katalogi, pod nimi pliki z literą i `+a −b`) albo jedno z dwóch zdań pustki i „pokazano 50 z N". Gdy jest
/// drzewo, nagłówek jest przełącznikiem ze strzałką po prawej: zwija całe drzewo do samego nagłówka (preferencja
/// urządzenia, `RarogInspector.changesCollapsed`). Diff otwiera stuknięcie pliku — osobnego przycisku nie ma.
/// Ostatniego commita panel nie pokazuje
/// (zostaje w dymku gita). Wiersze płasko, bez kontenera — nagłówek sekcji jest celem kotwicy (tap w linię gita
/// w nagłówku sesji).
private struct InspectorChangesSection: View {
  let changes: InspectorChanges
  /// Całe drzewo zwinięte do nagłówka (`RarogInspector.changesCollapsed`).
  let sectionCollapsed: Bool
  let toggleSection: () -> Void
  /// Zwinięte katalogi drzewa TEJ sesji (`RarogInspector.collapsedDirs`).
  let collapsed: Set<String>
  let toggle: (_ directory: String) -> Void
  let open: (_ path: String) -> Void
  /// Wiersze drzewa pod wskaźnikiem: nazwa pliku pod nim stoi w pełnym atramencie, a pionowe linie poziomów widać
  /// tylko wtedy, gdy wskaźnik stoi nad drzewem.
  @State private var hovered: Set<String> = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The category and the text size path of the commit fragment in the clean line (an `AttributedString` has no
  /// environment of its own).
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.textStyleFlat) private var flat

  private var title: String { UICopy.inspectorChangesTitle(changes.count) }

  /// Wiersze drzewa na ekranie: bez drzewa i przy zwiniętej sekcji — żadne.
  private var rows: [ChangesTreeRow] {
    guard case let .files(files) = changes.body, !sectionCollapsed else { return [] }
    return ChangesTree.rows(files, collapsed: collapsed)
  }

  var body: some View {
    let rows = self.rows
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 22)
      .accessibilityHidden(true)
    header
      .id(InspectorModel.changesAnchor)
      // Wiersz, który zniknął pod wskaźnikiem (zwinięty katalog albo całe drzewo, nowa ramka gita), wyjścia nie
      // zgłasza. Jego ślad schodzi razem z nim: inaczej po powrocie stałby podświetlony bez wskaźnika.
      .onChange(of: Set(rows.map(\.id))) { _, ids in hovered.formIntersection(ids) }
    if changes.stale {
      Label(UICopy.workflowStale, systemImage: "clock")
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .padding(.bottom, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UICopy.workflowStaleSpoken)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier("inspector.git.stale")
    }
    switch changes.body {
    case .files:
      if !sectionCollapsed {
        // Liczą się wiersze stojące na ekranie (ślad po znikniętym schodzi dopiero po tym przebiegu).
        let guides = rows.contains { hovered.contains($0.id) }
        ForEach(rows) { row in
          ChangesTreeRowView(row: row, guides: guides, hovered: hovered.contains(row.id), toggle: toggle, open: open)
            .onHover { inside in
              if inside { hovered.insert(row.id) } else { hovered.remove(row.id) }
            }
        }
        if let shown = changes.shown {
          Text(UICopy.inspectorChangesShown(shown.rows, of: shown.of))
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .padding(.top, 4)
            .accessibilityIdentifier("inspector.git.shown")
        }
      }
    case let .clean(commit):
      clean(commit)
    case .noData:
      Text(UICopy.inspectorChangesNoData)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityIdentifier("inspector.git.noData")
    }
  }

  /// Etykieta sekcji; przy drzewie cały wiersz jest przyciskiem (strzałka po prawej, jak przy fazach workflow),
  /// bez drzewa — samą etykietą. Ten sam identyfikator i ta sama wysokość w obu stanach.
  @ViewBuilder
  private var header: some View {
    if changes.collapsible {
      Button(action: toggleSection) {
        HStack(spacing: 8) {
          BackgroundSectionTitle(text: title)
          Spacer(minLength: 8)
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(sectionCollapsed ? 0 : 90))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: sectionCollapsed)
            .frame(width: ChangesTree.guideInset * 2)
        }
        .padding(.top, 18)
        .padding(.bottom, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(title)
      .accessibilityValue(sectionCollapsed ? UICopy.disclosureCollapsed : UICopy.disclosureExpanded)
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("inspector.git.title")
    } else {
      BackgroundSectionTitle(text: title)
        .padding(.top, 18)
        .padding(.bottom, 8)
        .accessibilityIdentifier("inspector.git.title")
    }
  }

  /// „Czysto od 7cdfbe4b" — skrót commita w mono (zdanie z katalogu, commit wyróżniony w nim po wartości).
  private func clean(_ commit: String?) -> some View {
    let text: Text =
      if let commit {
        Text({
          var line = AttributedString(UICopy.inspectorChangesClean(commit))
          if let range = line.range(of: commit) {
            line[range].font = AppFont.footnote.monospaced().resolve(typeSize: typeSize, flat: flat)
          }
          return line
        }())
      } else {
        Text(UICopy.inspectorChangesCleanNoCommit)
      }
    return text
      .appFont(.subheadline)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .accessibilityIdentifier("inspector.git.clean")
  }
}

/// Wiersz drzewa zmian. Katalog: strzałka, sklejona ścieżka (ucinana od początku — zostaje najgłębszy człon), przy
/// zwiniętym suma `+a −b`; stuknięcie zwija i rozwija. Plik: litera rodzaju (kolor jak w rozwinięciu gita) w osi
/// nazwy katalogu nad nim, nazwa w `text2` (pod wskaźnikiem w `text`), `+a −b` w kolorach znaku, binarny — „bin"
/// zamiast liczników (`GitFileStats`, wspólne z dymkiem gita i oknem diffa); stuknięcie otwiera diff na tym pliku.
private struct ChangesTreeRowView: View {
  let row: ChangesTreeRow
  /// Wskaźnik stoi nad drzewem: widać pionowe linie poziomów.
  let guides: Bool
  /// Wskaźnik stoi nad TYM wierszem: nazwa pliku w pełnym atramencie.
  let hovered: Bool
  let toggle: (_ directory: String) -> Void
  let open: (_ path: String) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    switch row {
    case let .directory(directory):
      Button {
        toggle(directory.path)
      } label: {
        HStack(spacing: ChangesTree.chevronGap) {
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(directory.collapsed ? 0 : 90))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: directory.collapsed)
            .frame(width: ChangesTree.guideInset * 2)
          Text(directory.label)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: Palette.muted))
            .lineLimit(1)
            .truncationMode(.head)
          Spacer(minLength: 8)
          if directory.collapsed, let sum = directory.sum {
            Text(sum)
              .appFont(.caption.monospacedDigit())
              .foregroundStyle(Color(uiColor: Palette.muted2))
          }
        }
        .modifier(TreeRowFrame(depth: row.depth, guides: guides))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(directory.spoken)
      .accessibilityValue(directory.collapsed ? UICopy.inspectorDirectoryCollapsed : UICopy.inspectorDirectoryExpanded)
      .accessibilityIdentifier("inspector.git.dir.\(directory.path)")
    case let .file(file, _):
      Button {
        open(file.path)
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          // Kolumna litery kończy się tam, gdzie zaczyna się nazwa: przesunięcie litery nazwy nie rusza.
          Text(file.status?.rawValue ?? " ")
            .appFont(.footnote.monospaced())
            .foregroundStyle(Color(uiColor: GitInk.color(file.status)))
            .padding(.leading, ChangesTree.letterInset)
            .frame(width: ChangesTree.nameInset, alignment: .leading)
          Text(file.name)
            .appFont(.footnote.monospaced())
            .foregroundStyle(Color(uiColor: hovered ? Palette.text : Palette.text2))
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 8)
          GitFileStats(added: file.added, deleted: file.deleted, binary: file.binary)
        }
        .modifier(TreeRowFrame(depth: row.depth, guides: guides))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(file.spoken)
      .accessibilityIdentifier("inspector.git.file.\(file.path)")
    }
  }
}

/// Rama wiersza drzewa: wcięcie poziomu, wysokość wiersza (26 pt przy domyślnym piśmie, rośnie z pismem) i pionowe
/// linie poziomów w osi strzałek katalogów. Linie widać tylko pod wskaźnikiem nad drzewem —
/// pod palcem drzewo niesie samo wcięcie.
private struct TreeRowFrame: ViewModifier {
  let depth: Int
  let guides: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @AppScaledMetric(relativeTo: .footnote) private var height = CGFloat(ChangesTree.rowHeight)

  func body(content: Content) -> some View {
    content
      .padding(.leading, ChangesTree.indent * Double(depth))
      .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
      .contentShape(Rectangle())
      .background(alignment: .leading) {
        HStack(spacing: 0) {
          ForEach(0..<depth, id: \.self) { _ in
            Rectangle()
              .fill(Color(uiColor: Palette.border))
              .frame(width: 1)
              .frame(width: ChangesTree.indent, alignment: .leading)
          }
        }
        .padding(.leading, ChangesTree.guideInset)
        .opacity(guides ? 1 : 0)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: guides)
        .accessibilityHidden(true)
      }
  }
}

// MARK: - Klawiatura ekranowa

/// Ile klawiatura ekranowa zasłania widok od dołu — z `keyboardLayoutGuide` UIKit (bez dolnej safe area: guide
/// bez klawiatury stoi wtedy na dolnej krawędzi widoku i daje zero).
private struct KeyboardProbe: UIViewRepresentable {
  let report: (CGFloat) -> Void

  func makeUIView(context: Context) -> ProbeView {
    let view = ProbeView()
    view.report = report
    return view
  }

  func updateUIView(_ view: ProbeView, context: Context) {
    view.report = report
  }

  final class ProbeView: UIView {
    var report: ((CGFloat) -> Void)?
    private let marker = UIView()
    private var last: CGFloat = -1

    override init(frame: CGRect) {
      super.init(frame: frame)
      isUserInteractionEnabled = false
      isAccessibilityElement = false
      keyboardLayoutGuide.usesBottomSafeArea = false
      marker.translatesAutoresizingMaskIntoConstraints = false
      addSubview(marker)
      NSLayoutConstraint.activate([
        marker.leadingAnchor.constraint(equalTo: leadingAnchor),
        marker.widthAnchor.constraint(equalToConstant: 0),
        marker.heightAnchor.constraint(equalToConstant: 0),
        marker.topAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
      ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:)") }

    override func layoutSubviews() {
      super.layoutSubviews()
      let overlap = max(0, bounds.height - marker.frame.minY)
      guard abs(overlap - last) > 0.5 else { return }
      last = overlap
      let report = report
      // Poza przebiegiem układu: zapis stanu SwiftUI w `layoutSubviews` odpalałby kolejny układ w tym samym.
      DispatchQueue.main.async { report?(overlap) }
    }
  }
}
#endif
