#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// The session switcher window under Cmd+S: a vertical list of the recently
// visited sessions in the middle of the app window; with the keyboard each row starts with its digit key. It appears and disappears at once, without dimming underneath and
// without animation, and stays until a human picks a row or
// closes it. A SwiftUI overlay, not a sheet; with a hardware keyboard the window takes it through its UIKit key
// receiver (`SwitcherKeyResponder`), and a close without a jump gives the caret back where it was.
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
        SessionSwitcherOverlay(store: store, switcher: switcher)
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
      .onChange(of: Set(store.state.sessions.keys)) { _, existing in
        switcher.sessionsChanged(existing: existing)
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
    switcher.onOpen = { [navigation] id in
      // The gate and the scene once more right before the jump: a window may have appeared, or the app left the
      // foreground, after the last check.
      guard SwitcherPresentationGate.sceneIsActive(), !SwitcherPresentationGate.isBlocked() else { return }
      navigation.selectSession(id)
    }
  }

  /// The menu command: Cmd+S (`backward == false`) or Shift+Cmd+S. Silent without login and while anything is
  /// presented. `keyboard`: a hardware keyboard is connected (the window takes it).
  static func command(
    backward: Bool, switcher: SessionSwitcher, store: RarogStore, navigation: RarogNavigation,
    keyboard: Bool = TerminalKeyboard.isConnected()
  ) {
    let state = store.state
    guard state.auth == .loggedIn, !SwitcherPresentationGate.isBlocked() else { return }
    let current = navigation.listSelection(state)
    switcher.command(
      backward: backward, keyboard: keyboard, snapshot: snapshot(state: state, current: current, navigation: navigation),
      current: current)
  }

  /// A tap on the current tab: the window like Cmd+S. Silent where the command is.
  static func openByTap(
    switcher: SessionSwitcher, store: RarogStore, navigation: RarogNavigation,
    keyboard: Bool = TerminalKeyboard.isConnected()
  ) {
    let state = store.state
    guard state.auth == .loggedIn, !SwitcherPresentationGate.isBlocked() else { return }
    let current = navigation.listSelection(state)
    switcher.openByTap(
      keyboard: keyboard, snapshot: snapshot(state: state, current: current, navigation: navigation), current: current)
  }

  private static func snapshot(state: AppState, current: String?, navigation: RarogNavigation) -> [String] {
    SwitcherRows.snapshot(
      current: current, recent: navigation.recentSessions(state, limit: SwitcherRows.limit + 1), state: state)
  }
}

struct SessionSwitcherOverlay: View {
  let store: RarogStore
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
            rows: rows, selected: switcher.machine.selected, opening: switcher.machine.opening,
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

  /// The order from the snapshot, the content live. "You're here" is the session on screen at the opening.
  private var rows: [SwitcherRow] {
    SwitcherRows.rows(order: switcher.machine.order, state: store.state, current: switcher.machine.current)
  }
}

private struct SwitcherWindow: View {
  let rows: [SwitcherRow]
  let selected: String?
  let opening: Int
  let serial: Int
  let switcher: SessionSwitcher
  @AccessibilityFocusState private var spokenRow: String?
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
    .accessibilityLabel(UICopy.switcherLabel)
    .accessibilityAddTraits(.isModal)
    // The VoiceOver "back" gesture closes the window without a jump: the background under the window is hidden from
    // VoiceOver, and an empty window would have no other way out.
    .accessibilityAction(.escape) { switcher.cancel(.outside) }
    .accessibilityIdentifier("switcher.window")
    .onAppear { speak() }
    .onChange(of: serial) { speak() }
  }

  private var header: some View {
    Text(UICopy.switcherHeading(rows.count)).eyebrow()
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

  /// Lista przewijana: zaznaczenie zawsze zostaje w widoku.
  private var scrolling: some View {
    ScrollViewReader { proxy in
      ScrollView { list }
        .onAppear { proxy.scrollTo(selected, anchor: .center) }
        .onChange(of: selected) { _, id in proxy.scrollTo(id, anchor: .center) }
    }
  }

  private var list: some View {
    VStack(spacing: 2) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
        Button {
          switcher.tapRow(item.id)
        } label: {
          // Wskaźnik (gładzik, mysz) zapala wiersz jak zakładkę i agenta na liście; palec nie.
          RarogHoverReader { hovered in
            SwitcherRowView(
              item: item, selected: item.id == selected,
              digitKey: SwitcherRows.digitKey(at: index, keyboard: switcher.holdsKeyboard), hovered: hovered)
          }
        }
        .buttonStyle(.plain)
        // Bez fokusu klawiatury: okno nie zabiera klawiszy ekranowi pod spodem.
        .focusable(false)
        .accessibilityFocused($spokenRow, equals: item.id)
        .accessibilityAddTraits(item.id == selected ? .isSelected : [])
        .accessibilityIdentifier("switcher.row.\(item.id)")
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
    Announcer.shared.say(row.row.spoken(now: Date()), eventID: "switcher-\(opening)-\(serial)")
  }
}

private struct SwitcherRowView: View {
  let item: SwitcherRow
  let selected: Bool
  /// The digit key before the dot: only in a window that holds the
  /// keyboard.
  let digitKey: SwitcherDigitKey
  /// Wskaźnik nad wierszem: płytka zaznaczenia w połowie krycia (`HoverTokens.agentRowAlpha`), jak zakładka i wiersz
  /// agenta pod kursorem. Zaznaczenie wygrywa. `muted2` trzyma na tej płytce 4,5:1, więc tekst się nie zmienia.
  var hovered = false
  @Environment(\.dynamicTypeSize) private var typeSize
  @AppScaledMetric(relativeTo: .subheadline) private var dotLift: CGFloat = 4

  var body: some View {
    let row = item.row
    // Na zaznaczeniu `muted2` nie trzyma 4,5:1 — tekst drugorzędny idzie w `muted` (`PaletteContrastTests`).
    let secondary = Color(uiColor: selected ? Palette.muted : Palette.muted2)
    TimelineView(.periodic(from: .now, by: 1)) { timeline in
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        digitKeyView
        Circle()
          .fill(Color(uiColor: Palette.tone(row.status.tone)))
          .frame(width: 9, height: 9)
          .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + dotLift }
        VStack(alignment: .leading, spacing: 2) {
          Text("\(Text(row.project).fontWeight(.semibold))\(Text(row.titleTail).foregroundStyle(secondary))")
            .appFont(.subheadline)
            .foregroundStyle(Color(uiColor: Palette.text))
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            // The status word in the status colour; a quiet session (the recent list holds them) in `muted`,
            // because `done` is too weak as text (`PaletteContrastTests`).
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
        if !row.frozen, let since = row.clockSince {
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
      .opacity(row.frozen ? 0.55 : 1)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(row.spoken(now: timeline.date) + (item.isCurrent ? ", \(UICopy.switcherHere)" : ""))
      .accessibilityAddTraits(.isButton)
    }
  }

  /// An outlined key with the row's digit, like the footer keys: `caption` mono in `muted` (4.5:1 on the selection
  /// and on `surface`, `PaletteContrastTests`), a 1 pt `border` outline with the `ghost` corner, one width for every
  /// digit. A row past nine keeps the same room empty, so the dots stay in a column. Decoration: the row's
  /// sentence for VoiceOver ignores its children.
  @ViewBuilder private var digitKeyView: some View {
    switch digitKey {
    case .none:
      EmptyView()
    case .blank:
      keyCap("0").hidden()
    case let .digit(number):
      keyCap(String(number))
    }
  }

  private func keyCap(_ digit: String) -> some View {
    Text(verbatim: digit)
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: Palette.muted))
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle.ghost.strokeBorder(Color(uiColor: Palette.border), lineWidth: 1))
      .accessibilityHidden(true)
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
