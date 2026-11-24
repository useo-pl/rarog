#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Drzewo projektów na liście agentów: nagłówki projektów i zagnieżdżeni agenci w jednej
// liście na całą wysokość kolumny. Kontener (lista, pasek, stopka) jest wspólny z listą klasyczną
// (`SessionListView`); tu są wiersze. Właściciel: lista i projekty.

/// Wiersze drzewa w jednym `ForEach` po typowanej tożsamości (`ProjectTreeID`). Zaznaczenie listy jest typowane tak
/// samo: wiersz agenta zaznacza sesję, nagłówek projektu z agentami zwija się albo rozwija, a bez agentów wchodzi
/// w projekt (`ProjectTreeHeaderModel.tap`) — klawiatura na nagłówku z fokusem idzie tą
/// samą drogą co tap (zaznaczenie listy). Strzałka to osobny przycisk z tym samym zwinięciem; trasy nie rusza.
struct ProjectTreeRows: View {
  /// Wiersze drzewa (`AppState.projectTreeRows`) — liczy je kontener, bo ich tożsamości pilnuje też kotwica przewinięcia.
  let rows: [ProjectTreeRow]
  let store: RarogStore
  let navigation: RarogNavigation
  let besideDetail: Bool
  /// Kotwica zaznaczonej sesji (`TreeListAnchor`): most komórki wiersza zgłasza jej kolekcję, gest zapowiada zmianę.
  let anchor: TreeListAnchor
  /// Hardware keyboard: the rename field's Return and Escape handling (`SessionRenameField`).
  var hardwareKeyboard = false
  /// Renaming in place: which row is a field and the names waiting for the server (`SessionRenamer`).
  let renamer: SessionRenamer
  /// Zamknięcie sesji z akcji wiersza (`RowActions`): przesunięcie albo menu kontekstowe, bez pytania.
  let close: (String) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// Notatki projektów; bez rejestru (testy widoków) menu nagłówka nie ma pozycji notatki.
  @Environment(ProjectNotes.self) private var notes: ProjectNotes?
  /// Opens Recent Sessions from the clock in the project header; without it (view tests) the header has no clock.
  @Environment(NewSessionPresenter.self) private var presenter: NewSessionPresenter?
  /// Projekt, którego notatka stoi w dymku przy nagłówku (z menu kontekstowego).
  @State private var noteCwd: String?
  /// Formularz do otwarcia po zejściu dymka (wzór `openPanelAfterDismiss`).
  @State private var noteThen: NoteRequest.Start?

  /// Wcięcie agenta pod nagłówkiem: lewa krawędź kropki = lewa krawędź tuszu nazwy
  /// projektu. Ramka nazwy zaczyna się na końcu celu strzałki (44 pt od krawędzi komórki), a tusz litery o
  /// `nameInkInset` dalej.
  static let agentIndent: CGFloat =
    ProjectTreeHeaderRow.chevronTarget + nameInkInset - SessionListMetrics.rowSideInset
  /// Odstęp tuszu pierwszej litery nazwy od jej ramki (mono półgruba 15 pt). Zmierzone na zrzucie iPada
  /// przy kropce od ramki nazwy: kropka od 52,0 pt kolumny, pień h/p/u od 53,0 pt, s od 53,5, v i y od 52,5–53.
  static let nameInkInset: CGFloat = 1
  /// Ile plamy zaznaczenia agenta stoi przed jego kropką: promień plamy (`Radius.block`), więc łuk rogu kończy się
  /// przed kropką.
  static let agentPlateLead: CGFloat = Radius.block
  /// Plama zaznaczenia, wskaźnika i pierścień fokusu agenta zaczynają się 12 pt przed kropką, czyli za prowadnicą,
  /// więc obszar zaznaczenia agenta kończy się przed linią drzewa: 8 + 37 − 12 = 33 pt od
  /// krawędzi komórki, a kreska stoi w osi 22 pt — zostaje ~11 pt czystego tła.
  static let agentPlateInset: CGFloat = SessionListMetrics.rowSideInset + agentIndent - agentPlateLead

  /// Wcięcia komórki: nagłówek od krawędzi komórki (cel strzałki zaczyna się przy niej), nad nim oddech między
  /// projektami zależny od wiersza wyżej (`ProjectTreeRowLayout.gapAbove`); agent wcięty pod nazwę projektu.
  static func insets(_ row: ProjectTreeRow, _ layout: ProjectTreeRowLayout) -> EdgeInsets {
    if row.isHeader {
      return EdgeInsets(top: layout.gapAbove, leading: 0, bottom: 0, trailing: SessionListMetrics.rowSideInset)
    }
    if case .emptyFilter = row {
      // The filter's sentence starts where the project names under it start.
      return EdgeInsets(
        top: SessionListMetrics.rowVerticalInset, leading: ProjectTreeHeaderRow.chevronTarget + nameInkInset,
        bottom: SessionListMetrics.rowVerticalInset, trailing: SessionListMetrics.rowSideInset)
    }
    return EdgeInsets(
      top: SessionListMetrics.rowVerticalInset, leading: SessionListMetrics.rowSideInset + agentIndent,
      bottom: SessionListMetrics.rowVerticalInset, trailing: SessionListMetrics.rowSideInset)
  }

  var body: some View {
    let state = store.state
    let selected = navigation.listSelection(state)
    let layouts = Dictionary(
      zip(rows.map(\.id), ProjectTreeRowLayout.layout(rows, activeCwd: navigation.currentProjectCwd(state))),
      uniquingKeysWith: { first, _ in first })
    ForEach(rows) { row in
      let layout = layouts[row.id] ?? ProjectTreeRowLayout()
      let insets = Self.insets(row, layout)
      let plateInset = row.isHeader ? SessionListMetrics.rowPlateInset : Self.agentPlateInset
      // Cechy wiersza listy (wcięcia, tło, akcje przesunięcia) na zewnątrz rozgałęzienia: postawione w gałęzi `switch`
      // lista gubi je dla drugiej gałęzi (wiersz agenta bez wcięcia drzewa).
      content(row, state: state, selected: selected)
        // Prowadnica w treści wiersza, rozciągnięta na całą komórkę razem z wcięciami (`ProjectTreeGuide`).
        .overlay(alignment: .topLeading) {
          // An agent's leading swipe actions stand next to its plate, not at the column edge
          // (`TreeSwipeActionsShift`); a header has no swipe actions.
          ProjectTreeGuide(layout: layout, actionsInset: row.sessionId == nil ? nil : plateInset)
            .padding(EdgeInsets(top: -insets.top, leading: -insets.leading, bottom: -insets.bottom, trailing: 0))
        }
        .listRowInsets(insets)
        .modifier(PlainListRow(
          highlighted: highlighted(row, selected: selected),
          topInset: layout.gapAbove,
          leadingInset: plateInset,
          anchor: anchor,
          plate: besideDetail ? Palette.surface2 : Palette.stackedPlate,
          // Touch feedback only on an agent row of the stacked list: a header toggles in place, and a rename field
          // takes its touches for the text.
          pressFeedback: !besideDetail && row.sessionId != nil && !isEditing(row)))
        // Lista z pamięci podręcznej: bez akcji do świeżego stanu. The field of a row being renamed has none either:
        // a touch and hold in it belongs to the text.
        .modifier(RowActions(
          session: state.listStale || isEditing(row) ? nil : row.sessionId.flatMap { state.sessions[$0] },
          readToggle: row.sessionId.flatMap { state.readToggle($0) },
          rename: renameEntry(row, state: state),
          close: close,
          setRead: { id, read in store.setResultRead(id, read: read) }))
    }
  }

  @ViewBuilder private func content(
    _ row: ProjectTreeRow, state: AppState, selected: String?
  ) -> some View {
    switch row {
    case let .header(header):
      // Strzałka i akcja czytnika: jeden projekt, nagłówek stoi (`TreeToggleGesture.project`). Glif notatki przy
      // każdym projekcie, gdy serwer ma notatki; stuknięcie jak pozycja menu. The Recent
      // Sessions clock stands at every project, independent of notes; the pop-up terminal glyph before it only while
      // the server has the terminal on (off, it would be a dead glyph at every project).
      ProjectTreeHeaderRow(
        header: header, note: notes.flatMap { NoteTabModel.make(cwd: header.row.cwd, state: state, notes: $0) },
        openNote: { openNote(header.row.cwd, state: state) },
        openRecent: presenter.map { presenter in { presenter.openRecent(cwd: header.row.cwd) } },
        openTerminal: navigation.showsProjectPopupGlyph(state)
          ? { navigation.togglePopup(.popup, in: header.row.cwd, state: store.state) } : nil,
        pin: { pin(header.row.cwd, pinned: !header.pinned) }
      ) { toggle([header.row.cwd], collapse: !header.collapsed, gesture: .project) }
        .contextMenu {
          newTabMenu(header.row.cwd, state: state)
          Divider()
          if state.notesAvailable, notes != nil {
            Button(UICopy.noteProject, systemImage: "note.text") { openNote(header.row.cwd, state: state) }
              .accessibilityIdentifier("tree.note")
          }
          // Pin or unpin: a finger opens this menu with a touch and hold, the pointer with the secondary click.
          Button(header.pinned ? UICopy.treeUnpin : UICopy.treePin,
                 systemImage: header.pinned ? "pin.slash" : "pin") { pin(header.row.cwd, pinned: !header.pinned) }
            .accessibilityIdentifier("tree.pin")
          Divider()
          allProjectsMenu(rows)
        }
        .popover(isPresented: noteShown(header.row.cwd), arrowEdge: .trailing) {
          notePanel(header.row.cwd).popoverSurface()
        }
    case let .session(session):
      if renamer.editing == session.id, state.sessions[session.id] != nil {
        SessionRenameField(
          initial: renamer.editingName, edit: renamer.edit, hardwareKeyboard: hardwareKeyboard,
          save: { saveRename($0, sessionId: session.id) },
          cancel: { renamer.cancel(session.id) })
      } else {
        SessionRow(
          row: renamer.pendingName(session.id).map(session.renamed) ?? session,
          selected: highlighted(row, selected: selected))
          .background {
            if renameEntry(row, state: state) != nil {
              RenameDoubleClick { renamer.begin(session.id, name: shownName(session)) }.accessibilityHidden(true)
            }
          }
          .accessibilityIdentifier("session.\(session.id)")
      }
    case let .emptyFilter(filter):
      Text(UICopy.listFilterEmpty(filter) ?? "")
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .frame(maxWidth: .infinity, minHeight: SessionListMetrics.projectRowMinHeight, alignment: .leading)
        .selectionDisabled()
        .accessibilityIdentifier("list.filterEmpty")
    }
  }

  /// The row's rename item, when the row offers it (`SessionRename.available`).
  private func renameEntry(_ row: ProjectTreeRow, state: AppState) -> (() -> Void)? {
    guard case let .session(model) = row, let session = state.sessions[model.id],
          SessionRename.available(session, state: state)
    else { return nil }
    return { renamer.begin(model.id, name: shownName(model)) }
  }

  private func isEditing(_ row: ProjectTreeRow) -> Bool {
    row.sessionId != nil && renamer.editing == row.sessionId
  }

  /// The name the field starts with: the one the row shows, without its `#n`.
  private func shownName(_ row: SessionRowModel) -> String {
    renamer.pendingName(row.id) ?? row.sessionName
  }

  /// Return in the field: `/rename <name>` the ordinary way of a message to the session, compared with the name the
  /// field started with (`SessionRenamer.editingName`); a refusal or a name the server does not confirm comes back
  /// as a sentence card (`RarogNavigation.post`). The save decides at once, before the send suspends: a cancel right
  /// after Return (the field's loss of focus, another screen) finds the field already closed and the save under way.
  private func saveRename(_ draft: String, sessionId id: String) {
    Task.immediate {
      await renamer.save(
        draft, sessionId: id,
        send: { await store.send(text: $0, to: id) },
        label: { store.state.sessions[id]?.label },
        notice: { navigation.post($0) })
    }
  }

  /// The selection plate of an agent row (`ListRowHighlight`): the session open beside the list, in the stack the last
  /// opened one; a header never.
  private func highlighted(_ row: ProjectTreeRow, selected: String?) -> Bool {
    guard let id = row.sessionId else { return false }
    let last = besideDetail ? nil : navigation.lastVisitedSession(store.state)
    return ListRowHighlight.isHighlighted(rowId: id, selectedId: selected, lastVisitedId: last, besideDetail: besideDetail)
  }

  /// „Nowa sesja” i „Nowy terminal” na górze menu nagłówka: te same akcje i bramki co menu
  /// „+” paska zakładek (`ProjectTabBar.addMenu`), w katalogu nagłówka — `ProjectRowModel.cwd` ma kształt
  /// `ProjectPath.normalized`, jak `currentProjectCwd` paska. Zakładanie w toku wygasza obie pozycje, jak całe „+”.
  /// Blokada startu „Nowej sesji” nie wygasza: `createSession` mówi powód zdaniem, w stosie nad listą.
  /// Sesja startuje od razu z zapamiętanymi ustawieniami i apka w nią wchodzi; zwiniętego projektu nie rozwija —
  /// zaznaczony wiersz stoi i tak (`AppState.treeShows`).
  @ViewBuilder private func newTabMenu(_ cwd: String, state: AppState) -> some View {
    Button(UICopy.newSessionTitle, systemImage: "bubble.left") {
      Task { await navigation.createSession(in: cwd, store: store) }
    }
    .disabled(navigation.creating)
    .accessibilityIdentifier("tree.newSession")
    Button(UICopy.newTerminal, systemImage: "terminal") {
      navigation.openTerminal(.next, in: cwd, state: store.state)
    }
    .disabled(navigation.creating || state.terminalFeature != .on)
    .accessibilityIdentifier("tree.newTerminal")
  }

  /// „Notatka projektu" z menu nagłówka i z glifu przy nazwie: z treścią dymek przy nagłówku, pusta (albo
  /// niezapisana) — formularz od razu.
  private func openNote(_ cwd: String, state: AppState) {
    guard let notes else { return }
    if state.hasNote(cwd) == true, !notes.unsaved(cwd) {
      noteCwd = cwd
    } else {
      navigation.openNote(cwd: cwd)
    }
  }

  private func noteShown(_ cwd: String) -> Binding<Bool> {
    Binding(get: { noteCwd == cwd }, set: { if !$0, noteCwd == cwd { noteCwd = nil } })
  }

  @ViewBuilder private func notePanel(_ cwd: String) -> some View {
    if let notes {
      NotePanel(
        doc: notes.document(cwd), compact: sizeClass != .regular, hardwareKeyboard: TerminalKeyboard.isConnected(),
        edit: { leaveNote(.edit) }, dictate: { leaveNote(.dictate) })
        .dismissOnEscape { noteCwd = nil }
        .popoverSheetChrome(title: UICopy.noteTitle)
        .presentationCompactAdaptation(.sheet)
        .onDisappear {
          guard let start = noteThen else { return }
          noteThen = nil
          navigation.openNote(cwd: cwd, start: start)
        }
    }
  }

  private func leaveNote(_ start: NoteRequest.Start) {
    noteThen = start
    noteCwd = nil
  }

  /// „Zwiń wszystkie” i „Rozwiń wszystkie” na dole menu kontekstowego każdego nagłówka: zaznaczona sesja stoi
  /// (`TreeToggleGesture.allProjects`, kotwica `TreeListAnchor`).
  @ViewBuilder private func allProjectsMenu(_ rows: [ProjectTreeRow]) -> some View {
    let headers = rows.compactMap { row -> ProjectTreeHeaderModel? in
      if case let .header(header) = row, header.collapsible { return header }
      return nil
    }
    Button(UICopy.treeCollapseAll, systemImage: "chevron.right") {
      toggle(headers.filter { !$0.collapsed }.map(\.row.cwd), collapse: true, gesture: .allProjects)
    }
    .disabled(headers.allSatisfy(\.collapsed))
    Button(UICopy.treeExpandAll, systemImage: "chevron.down") {
      toggle(headers.filter(\.collapsed).map(\.row.cwd), collapse: false, gesture: .allProjects)
    }
    .disabled(!headers.contains(where: \.collapsed))
  }

  private func pin(_ cwd: String, pinned: Bool) {
    Self.pin(cwd, pinned: pinned, navigation: navigation, store: store, anchor: anchor)
  }

  /// Pins or unpins a project from the header's menu or reader action. The rows change like with "Collapse All": the
  /// header moves to its new place and the selected row stays where it stood (`TreeListAnchor`), so the change goes
  /// without animation, the way a change from the server does.
  @MainActor
  static func pin(
    _ cwd: String, pinned: Bool, navigation: RarogNavigation, store: RarogStore, anchor: TreeListAnchor
  ) {
    // Every project with sessions, also one a filter segment hides now: the memory's cap must not unpin it.
    let present = Set(store.state.projectGroups().map(\.cwd))
    guard navigation.setProjectPinned(cwd, pinned: pinned, present: present) else { return }
    anchor.expect(nil)
  }

  private func toggle(_ cwds: [String], collapse: Bool, gesture: TreeToggleGesture) {
    Self.toggle(
      cwds, collapse: collapse, gesture: gesture, navigation: navigation, store: store, anchor: anchor,
      reduceMotion: reduceMotion)
  }

  /// Ręczne zwinięcie albo rozwinięcie (strzałka, menu nagłówka, stuknięcie w nagłówek): pamięć urządzenia i — tym
  /// samym gestem — zwolnienie ostatnio otwartych wierszy tych projektów w rdzeniu.
  /// `gesture` mówi, czy zaznaczony wiersz ma stać: przy jednym projekcie kotwica milczy,
  /// bo gest zapowiada jej wiersze, które da (`TreeAnchorSkip`). Liczy je tak samo jak lista
  /// (`SessionListView.layoutList`); `openCwd` i `jumpCwd` tożsamości wierszy nie zmieniają, a stan rdzenia
  /// (`RarogStore.projectsToggled`) i pamięć zwinięcia zmieniają się tu synchronicznie. Zapowiedź trafia do kotwicy
  /// przed następnym ciałem listy, które ją zużywa.
  @MainActor
  static func toggle(
    _ cwds: [String], collapse: Bool, gesture: TreeToggleGesture, navigation: RarogNavigation,
    store: RarogStore, anchor: TreeListAnchor, reduceMotion: Bool
  ) {
    guard !cwds.isEmpty else { return }
    // Every project with sessions, also one a filter segment hides now: the memory's cap must not push it out.
    let present = Set(store.state.projectGroups().map(\.cwd))
    var changed = false
    withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
      guard navigation.setProjectsCollapsed(cwds, collapsed: collapse, present: present) else { return }
      store.projectsToggled(cwds)
      changed = true
    }
    guard changed else { return }
    anchor.expect(
      gesture.holdsSelection ? nil : navigation.treeRows(store.state, openCwd: nil, jumpCwd: nil).map(\.id))
  }
}

/// Prowadnica drzewa: kreska włoskowata w osi strzałki, od nagłówka do ostatniego
/// widocznego agenta projektu — „prowadnica, ale delikatniejsza linia”. Rysuje ją TREŚĆ wiersza: nakładka na treść
/// z ujemnym paddingiem o wcięcia komórki, więc sięga całej wysokości komórki i odcinki sąsiednich komórek stykają
/// się w jedną kreskę; leży nad plamą zaznaczenia. Nie rysuje jej tło komórki (`listRowBackground`), bo
/// lista przekłada tło istniejących komórek dopiero po animacji albo przy następnej rekonfiguracji (zmierzone: treść
/// od razu, tło ~0,47 s później w teście, 0,7–4 s na nagraniu) — przy zwijaniu i rozwijaniu kreska rwała się na
/// kawałki i dochodziła skokiem. W treści zmienia się w tej samej transakcji co wiersze (pojawia się i znika
/// z przejściem przezroczystości). Odcinek wybiera `ProjectTreeRowLayout` (model), tu jest tylko geometria:
/// - nagłówek: od ~4 pt pod glifem strzałki do dołu komórki (oddech nad nagłówkiem należy do niego, nie do kreski
///   poprzedniego projektu);
/// - agent w środku projektu: cała wysokość komórki;
/// - ostatni agent: od góry komórki do dołu bloku tekstu (bez dolnego wcięcia i paddingu wiersza).
///
/// The line itself is a UIKit view (`TreeGuideLine`, same geometry and colour): while the list swipes the row (swipe
/// actions), the line stays in place instead of travelling with the cell.
struct ProjectTreeGuide: View {
  let role: TreeGuide
  /// Oddech nad nagłówkiem: o tyle niżej stoi strzałka.
  let headerTop: CGFloat
  /// How far the plate of a row with swipe actions starts into the cell (`TreeGuideLine.actionsInset`); `nil` — the
  /// row has no swipe actions.
  var actionsInset: CGFloat?
  /// The active project (`ProjectTreeRowLayout.active`): a brighter line.
  var active = false
  @Environment(\.displayScale) private var displayScale
  /// Od środka celu strzałki do dolnej krawędzi tuszu glifu (`caption`, półgruba, w dół — kreskę ma tylko projekt
  /// rozwinięty). Rośnie z pismem jak sam glif. Zmierzone na zrzucie iPada: kreska 4,0 pt pod glifem.
  @AppScaledMetric(relativeTo: .caption) private var chevronDownHalf: CGFloat = 3.5

  /// Odstęp kreski od dolnej krawędzi glifu strzałki.
  static let chevronGap: CGFloat = 4

  init(role: TreeGuide, headerTop: CGFloat = 0) {
    self.role = role
    self.headerTop = headerTop
  }

  init(layout: ProjectTreeRowLayout, actionsInset: CGFloat? = nil) {
    self.init(role: layout.guide, headerTop: layout.gapAbove)
    self.actionsInset = actionsInset
    active = layout.active
  }

  var body: some View {
    if let span {
      TreeGuideLine(shape: TreeGuideShape(
        axis: ProjectTreeHeaderRow.chevronTarget / 2, scale: displayScale, top: span.top, bottom: span.bottom),
        actionsInset: actionsInset ?? 0, active: active)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    } else if let actionsInset {
      // A row without a guide segment (an agent left on screen in a collapsed project) still moves its leading swipe
      // actions next to its plate: the same view without a line. A separate branch, so the line still comes and
      // goes with its fade when the project expands or collapses.
      TreeGuideLine(shape: nil, actionsInset: actionsInset)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
  }

  /// Początek od góry i koniec od dołu komórki; bez kreski — `nil`.
  private var span: (top: CGFloat, bottom: CGFloat)? {
    switch role {
    case .none: nil
    case .start:
      (headerTop + ProjectTreeHeaderRow.chevronTarget / 2 + chevronDownHalf + Self.chevronGap, 0)
    case .middle: (0, 0)
    case .end: (0, SessionListMetrics.agentEdge)
    }
  }
}

/// Kreska prowadnicy w komórce: szerokość jednego piksela ekranu, wyrównana do siatki pikseli wokół osi strzałki.
struct TreeGuideShape: Shape, Equatable {
  let axis: CGFloat
  let scale: CGFloat
  let top: CGFloat
  let bottom: CGFloat

  func path(in rect: CGRect) -> Path {
    let scale = max(scale, 1)
    let width = 1 / scale
    let minX = ((rect.minX + axis - width / 2) * scale).rounded(.down) / scale
    let minY = rect.minY + top
    let maxY = rect.maxY - bottom
    guard maxY > minY else { return Path() }
    return Path(CGRect(x: minX, y: minY, width: width, height: maxY - minY))
  }
}
#endif
