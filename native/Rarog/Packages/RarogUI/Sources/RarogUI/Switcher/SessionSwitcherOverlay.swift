#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// The session switcher window, opened by a tap on the current tab: a vertical list of the tabs of the current project
// in the order of the bar (sessions, then terminals), in the middle of the app window, under a heading that names the
// project once. It appears and disappears at once, without dimming underneath and without animation, and stays until
// a human picks a row or closes it. A SwiftUI overlay, not a sheet; with a hardware keyboard the window takes it
// through its UIKit key receiver (`SwitcherKeyResponder`), and a close without a jump gives the caret back where it
// was.
// Looks like the app's popovers: full `surface`, radii from the scale, no glass. Owner: shortcuts.

/// Wires the switcher to the root of the views: the window, the keys, the presentation gate and the jump.
struct SessionSwitcherHost: ViewModifier {
  let store: RarogStore
  let navigation: RarogNavigation
  let switcher: SessionSwitcher
  @State private var watch: SwitcherWatch?

  func body(content: Content) -> some View {
    content
      .overlay {
        SessionSwitcherOverlay(store: store, navigation: navigation, switcher: switcher)
      }
      .onAppear(perform: wire)
      .onDisappear {
        switcher.cancel(.sceneInactive)
        watch?.stop()
      }
      // A screen change under the window (a shortcut, a notification, the result of "New Session") closes it.
      .onChange(of: navigation.detail) { switcher.cancel(.screenChange) }
      .onChange(of: store.state.auth == .loggedIn) { _, loggedIn in
        if !loggedIn { switcher.cancel(.loggedOut) }
      }
      // The rows follow the bar while the window stands: a new tab comes in at its place, a closed one leaves.
      .onChange(of: navigation.tabRefs(store.state)) { _, tabs in
        switcher.tabsChanged(tabs)
      }
  }

  private func wire() {
    guard watch == nil else { return }
    let watch = SwitcherWatch(switcher: switcher) { SwitcherPresentationGate.isBlocked() }
    self.watch = watch
    // Weakly: the watch holds the switcher, so a strong closure would make a cycle; `@State` holds the watch.
    switcher.onWatch = { [weak watch] on in
      if on { watch?.start() } else { watch?.stop() }
    }
    switcher.onOpen = { [navigation, store] tab in
      // The gate and the scene once more right before the jump: a window may have appeared, or the app left the
      // foreground, after the last check. The same path as a tap on the tab.
      guard SwitcherPresentationGate.sceneIsActive(), !SwitcherPresentationGate.isBlocked() else { return }
      navigation.openTab(tab, state: store.state)
    }
  }

  /// A tap on the current tab, the only way to open the window. Silent without login and while anything is
  /// presented. `keyboard`: a hardware keyboard is connected (the window takes it). The tab on screen is the bar's
  /// current tab: a Rarog terminal with an agent inside stands on the terminal's tab.
  static func openByTap(
    switcher: SessionSwitcher, store: RarogStore, navigation: RarogNavigation,
    keyboard: Bool = TerminalKeyboard.isConnected()
  ) {
    let state = store.state
    guard state.auth == .loggedIn, !SwitcherPresentationGate.isBlocked() else { return }
    switcher.openByTap(keyboard: keyboard, tabs: navigation.tabRefs(state), current: navigation.currentTab(state))
  }
}

struct SessionSwitcherOverlay: View {
  let store: RarogStore
  let navigation: RarogNavigation
  let switcher: SessionSwitcher

  static let maxWidth: CGFloat = 560
  /// Najwyżej tyle wierszy bez przewijania.
  static let maxRows = 8
  /// Okno nie przekracza tej części wysokości okna apki, także przy największym piśmie.
  static let maxHeightFraction: CGFloat = 0.7

  var body: some View {
    let shown = switcher.windowShown
    GeometryReader { proxy in
      ZStack {
        if shown {
          // Niewidoczna warstwa pod oknem: tap poza oknem zamyka je i nie trafia w ekran pod spodem.
          Color.clear
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { switcher.cancel(.outside) }
            .accessibilityHidden(true)
          SwitcherWindow(
            rows: rows, project: navigation.currentProjectCwd(store.state), selected: switcher.machine.selected, opening: switcher.machine.opening,
            serial: switcher.machine.selectionSerial, switcher: switcher
          )
          .frame(width: min(Self.maxWidth, proxy.size.width - 32))
          // Rama do sufitu wysokości; samo okno w środku ma wysokość treści i stoi na środku.
          .frame(maxHeight: proxy.size.height * Self.maxHeightFraction)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // Także wtedy, gdy przejście do sesji niesie własną animację: okno nie gaśnie, tylko znika.
      .animation(nil, value: shown)
    }
    // The window's key receiver stays for the life of the overlay; it takes the keyboard only on the machine's
    // request (no touches, zero size).
    .background { SwitcherKeyAnchor(switcher: switcher).frame(width: 0, height: 0) }
    .allowsHitTesting(shown)
  }

  /// The tabs of the bar, live: the same list the bar draws. "You're here" is the tab on screen.
  private var rows: [SwitcherRow] {
    SwitcherRows.rows(tabs: navigation.stripTabs(store.state), state: store.state)
  }
}

private struct SwitcherWindow: View {
  let rows: [SwitcherRow]
  /// The current project's directory: the heading names it once, the rows do not.
  let project: String?
  let selected: ProjectTabRef?
  let opening: Int
  let serial: Int
  let switcher: SessionSwitcher
  @AccessibilityFocusState private var spokenRow: ProjectTabRef?
  /// Przybliżona wysokość wiersza (tytuł i linia stanu) — sufit ośmiu wierszy rośnie z pismem.
  @AppScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 54

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      content
      // Key hints only when the window holds the keyboard; without it a row is picked by a tap.
      if switcher.holdsKeyboard { footer }
    }
    .padding(14)
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(SwitcherRows.heading(cwd: project, count: rows.count).label)
    .accessibilityAddTraits(.isModal)
    // The VoiceOver "back" gesture closes the window without a jump: the background under the window is hidden from
    // VoiceOver, and an empty window would have no other way out.
    .accessibilityAction(.escape) { switcher.cancel(.outside) }
    .accessibilityIdentifier("switcher.window")
    .onAppear { speak() }
    .onChange(of: serial) { speak() }
  }

  /// "PROJECT · PROJECT TABS · N" in one line: a long project name truncates, the count stays.
  private var header: some View {
    let heading = SwitcherRows.heading(cwd: project, count: rows.count)
    return HStack(spacing: 0) {
      if let name = heading.project {
        Text(name).truncationMode(.tail)
        Text(UICopy.switcherHeadingDot).layoutPriority(1)
      }
      Text(heading.tabs).layoutPriority(1)
    }
    .lineLimit(1)
    .eyebrow()
    .accessibilityHidden(true)
  }

  @ViewBuilder private var content: some View {
    if rows.isEmpty {
      note(UICopy.switcherEmpty)
    } else {
      if rows.count <= SessionSwitcherOverlay.maxRows {
        // Mieści się w oknie — bez przewijania; przy dużym piśmie przewija się i krótka lista.
        ViewThatFits(in: .vertical) {
          list
          scrolling
        }
      } else {
        scrolling.frame(maxHeight: rowHeight * CGFloat(SessionSwitcherOverlay.maxRows))
      }
      if rows.count == 1, rows[0].isCurrent { note(UICopy.switcherOnlyCurrent) }
    }
  }

  /// The scrolling list: the selection always stays in view. The rows are live, so tabs that come in or leave before
  /// the selected row move it while the selection stays on its tab; the list scrolls it back, or Return would confirm
  /// a row out of sight.
  private var scrolling: some View {
    ScrollViewReader { proxy in
      ScrollView { list }
        .onAppear { proxy.scrollTo(selected, anchor: .center) }
        .onChange(of: selected) { _, id in proxy.scrollTo(id, anchor: .center) }
        .onChange(of: rows.map(\.id)) { proxy.scrollTo(selected, anchor: .center) }
    }
  }

  private var list: some View {
    VStack(spacing: 2) {
      ForEach(rows) { item in
        Button {
          switcher.tapRow(item.id)
        } label: {
          // Wskaźnik (gładzik, mysz) zapala wiersz jak zakładkę i agenta na liście; palec nie.
          RarogHoverReader { hovered in
            SwitcherRowView(item: item, selected: item.id == selected, hovered: hovered)
          }
        }
        .buttonStyle(.plain)
        // Bez fokusu klawiatury: okno nie zabiera klawiszy ekranowi pod spodem.
        .focusable(false)
        .accessibilityFocused($spokenRow, equals: item.id)
        .accessibilityAddTraits(item.id == selected ? .isSelected : [])
        .accessibilityIdentifier("switcher.row.\(item.key)")
        .id(item.id)
      }
    }
  }

  private func note(_ text: String) -> some View {
    Text(text)
      .appFont(.subheadline)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
  }

  private var footer: some View {
    HStack(spacing: 14) {
      ForEach(Array(UICopy.switcherHints.enumerated()), id: \.offset) { _, hint in
        HStack(spacing: 5) {
          Text(hint.key)
            .appFont(.caption.monospaced())
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay(RoundedRectangle.ghost.strokeBorder(Color(uiColor: Palette.border)))
          Text(hint.action).appFont(.caption)
        }
      }
      Spacer(minLength: 0)
    }
    .foregroundStyle(Color(uiColor: Palette.muted))
    .lineLimit(1)
    .accessibilityHidden(true)
  }

  /// Czytnik: fokus na zaznaczonym wierszu i zdanie po każdej zmianie. Każda zmiana ma własne zdarzenie
  /// (numer otwarcia i numer zmiany), więc szybki powrót na ten sam wiersz też jest czytany.
  private func speak() {
    spokenRow = selected
    guard let row = rows.first(where: { $0.id == selected }) else { return }
    Announcer.shared.say(row.spoken(now: Date()), eventID: "switcher-\(opening)-\(serial)")
  }
}

private struct SwitcherRowView: View {
  let item: SwitcherRow
  let selected: Bool
  /// Wskaźnik nad wierszem: płytka zaznaczenia w połowie krycia (`HoverTokens.agentRowAlpha`), jak zakładka i wiersz
  /// agenta pod kursorem. Zaznaczenie wygrywa. `muted2` trzyma na tej płytce 4,5:1, więc tekst się nie zmienia.
  var hovered = false
  @Environment(\.dynamicTypeSize) private var typeSize
  @AppScaledMetric(relativeTo: .subheadline) private var dotLift: CGFloat = 4

  /// Na zaznaczeniu `muted2` nie trzyma 4,5:1 — tekst drugorzędny idzie w `muted` (`PaletteContrastTests`).
  private var secondary: Color { Color(uiColor: selected ? Palette.muted : Palette.muted2) }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { timeline in
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        switch item.content {
        case let .session(row):
          sessionContent(row)
        case let .terminal(label, detail, _):
          terminalContent(label: label, detail: detail)
        }
        Spacer(minLength: 8)
        if item.isCurrent {
          Text(UICopy.switcherHere)
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .overlay(Capsule().strokeBorder(Color(uiColor: Palette.border)))
            .lineLimit(1)
        }
        // Sam czas, bez „czeka od”; zamrożony wiersz zegara nie pokazuje (liczba nie jest żywa).
        if let row = item.session, !row.frozen, let since = row.clockSince {
          Text(RelativeTime.short(since: since, now: timeline.date))
            .appFont(.caption.monospaced())
            .monospacedDigit()
            .foregroundStyle(secondary)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(plate, in: .inner)
      .contentShape(Rectangle())
      .opacity(item.session?.frozen == true ? 0.55 : 1)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(item.spoken(now: timeline.date))
      .accessibilityAddTraits(.isButton)
    }
  }

  /// A session: the state dot, "name #n" without the project (the heading names it), under it the state word in its
  /// colour and the "waiting for" line or the stage line.
  @ViewBuilder private func sessionContent(_ row: SessionRowModel) -> some View {
    Circle()
      .fill(Color(uiColor: Palette.tone(row.status.tone)))
      .frame(width: 9, height: 9)
      .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + dotLift }
    VStack(alignment: .leading, spacing: 2) {
      Text(item.title)
        .fontWeight(.semibold)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        // The status word in the status colour; a quiet session in `muted`, because `done` is too weak as text
        // (`PaletteContrastTests`).
        Text(row.status.text)
          .foregroundStyle(
            Color(uiColor: row.status.tone == .quiet ? Palette.muted : Palette.tone(row.status.tone)))
        if row.isCodex { Text(UICopy.codexTag).foregroundStyle(secondary) }
        if let detail = Self.detail(row) {
          Text(detail).foregroundStyle(secondary).truncationMode(.tail)
        }
      }
      .appFont(.caption.monospaced())
      .lineLimit(1)
    }
  }

  /// A terminal: the terminal glyph in the place of the dot, the tab label (the foreground process) and a quiet line
  /// (slot, running) in the secondary ink — a terminal has no state colour, like its tab.
  @ViewBuilder private func terminalContent(label: String, detail: String?) -> some View {
    Image(systemName: "terminal")
      .appFont(.caption)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .accessibilityHidden(true)
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .appFont(.subheadline.weight(.semibold))
        .foregroundStyle(Color(uiColor: Palette.text))
        .lineLimit(1)
      if let detail {
        Text(detail)
          .appFont(.caption.monospaced())
          .foregroundStyle(secondary)
          .lineLimit(1)
      }
    }
  }

  private var plate: Color {
    if selected { return Color(uiColor: Palette.switcherSelection) }
    return hovered ? Color(uiColor: Palette.switcherSelection).opacity(HoverTokens.agentRowAlpha) : .clear
  }

  /// Linia „na co czeka” albo linia etapu — to samo, co pod wierszem listy.
  private static func detail(_ row: SessionRowModel) -> String? {
    if let waiting = row.waiting, !waiting.isEmpty { return waiting }
    if let stage = row.stage, !stage.isEmpty { return stage }
    return nil
  }
}
#endif
