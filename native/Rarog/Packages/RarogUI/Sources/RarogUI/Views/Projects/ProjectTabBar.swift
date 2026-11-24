#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Pasek zakładek projektu w nagłówku sesji i terminala. Właściciel: projekty
// i zakładki.

/// Jedna przewijana lista: sesje projektu od najstarszej, terminale po slotach (albo jedno zaproszenie),
/// na końcu „+" z menu „Nowa sesja / Nowy terminal". Stan zakładki niesie znak przed etykietą: przy klawiaturze
/// sprzętowej kafelek z cyfrą skrótu Cmd (`TabShortcutKey`), bez cyfry kwadracik (`TabStateSquare`), oba w kolorze
/// kropki stanu z listy sesji (`TabTokens`); „tu jesteś" mówią neutralna płytka pod bieżącą i jasna,
/// pogrubiona etykieta. Zmiana stanu siostry przestawia tylko
/// kolor znaku (stabilne identyfikatory, szerokość ta sama), więc fokus i przewinięcie zostają; bieżąca zakładka
/// jest wyśrodkowana. Przewinięty pasek wygasza krawędź, za którą chowa się treść (`TabEdgeMask`).
/// A change of the current tab is the bar's only motion: the room for the divider and the "×" closes on the old
/// current tab and opens on the new one (`TabCloseRoomMotion`), so the siblings between them slide, and the centring
/// on the new tab runs on the same animation (`TabBarFollow`). The plate, the weight, the colours and the "×" switch
/// at once.
struct ProjectTabBar: View {
  let tabs: [ProjectTabModel]
  /// Cyfry klawiszy Cmd przed etykietami (`ShortcutMenu.tabDigits`); pusto bez klawiatury sprzętowej.
  let digits: [ProjectTabRef: Int]
  /// Zdanie blokady zakładania (`nil` = wolno; lista z pamięci podręcznej też blokuje) — „Nowa sesja"
  /// zostaje klikalna, a tap mówi dlaczego (`RarogNavigation.createSession`); czytnik słyszy to zdanie
  /// w nazwie „+".
  let addBlocked: String?
  let addBusy: Bool
  /// „Nowy terminal" w menu „+" — wygaszony, gdy serwer nie zna terminala (`termEnabled: false`).
  let terminalAvailable: Bool
  /// Kreska pod paskiem — tylko gdy pasek jest ostatnim rzędem nagłówka (linii statusu pod nim nie ma) i nie stoi
  /// pod nim terminal. Między paskiem a linią statusu kreski nie ma, nad
  /// terminalem też nie.
  let divider: Bool
  /// Notatka projektu: element za terminalami, przed „+"; `nil` = serwer notatek nie ma.
  var note: NoteTabModel?
  /// Klawiatura sprzętowa (dymek notatki pokazuje „⌘J" przy „Edytuj").
  var hardwareKeyboard = false
  /// Dyktowanie dostępne (mikrofon w dymku notatki).
  var voice = false
  /// The "×" of the current session or terminal tab (`RarogNavigation.tabClose`); it stands only in the tab it belongs
  /// to.
  var close: TabCloseModel?
  var closePress: (TabCloseModel) -> Void = { _ in }
  var closeBlur: () -> Void = {}
  let select: (ProjectTabModel) -> Void
  let addSession: () -> Void
  let addTerminal: () -> Void
  /// Krycie krawędzi z geometrii przewinięcia (`TabTokens.edgeFade`).
  @State private var fade = TabTokens.EdgeFade.off
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.displayScale) private var displayScale
  /// The tab identifiers of the last layout, so a change can tell a new current tab from a changed list.
  @State private var laidOutIds: [String] = []
  @State private var position = ScrollPosition(idType: String.self)
  /// The centring of the last change of the current tab (`TabBarFollow`).
  @State private var follow = TabBarFollow.rest
  @State private var scrollState = TabBarScrollState()

  private var currentId: String? { tabs.first(where: \.current)?.id }

  private var tabIds: [String] { tabs.map(\.id) }

  /// The current tab's index, the value the centring animates.
  private var currentIndex: Double { Double(tabs.firstIndex(where: \.current) ?? 0) }

  /// The animation of a change of the current tab; `nil` (a jump) when the list changes with it and under the system
  /// "Reduce Motion". The body reads it before `laidOutIds` catches up with the new list.
  private var roomAnimation: Animation? {
    switch TabCloseRoomMotion(reduceMotion: reduceMotion, tabsBefore: laidOutIds, tabsAfter: tabIds) {
    case .jump: nil
    case let .slide(duration): .easeOut(duration: duration)
    }
  }

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: Self.spacing) {
        ForEach(tabs) { tab in
          ProjectTabButton(
            tab: tab, digit: tab.target.flatMap { digits[$0] }, select: { select(tab) },
            close: close.flatMap { $0.stands(in: tab) ? $0 : nil },
            closePress: { if let close { closePress(close) } }, closeBlur: closeBlur,
            // The width of the label's content, from which the centring finds the new current tab's place before the
            // layout (`TabBarCentring.width`). A change of it (a label that came after entry, a rename, the digit
            // tiles of a hardware keyboard) puts the current tab back in the middle; becoming or leaving the current
            // tab does not change a session label's content, also at the target's minimum width.
            contentWidth: { width in
              guard scrollState.contentWidths[tab.id] != width else { return }
              scrollState.contentWidths[tab.id] = width
              // The rest follows the last geometry: the content's width can come before the tabs' widths, and a
              // current label near the 44 pt minimum can change its room without changing the content's width.
              if let viewport = scrollState.viewport,
                let room = tabs.firstIndex(where: \.current).flatMap(room(of:)) {
                scrollState.restContentWidth = viewport.contentWidth - room
              }
              center()
            })
            .id(tab.id)
            // A tab that comes or goes does it at once; only the others' places follow in the animation.
            .transition(.identity)
        }
        // Notatka i „+" stoją bez odstępu paska: ich glify są dużo węższe od celu 44 pt, więc powietrze dają same
        // cele. Z odstępem 8 pt „+" stał dalej od notatki niż notatka od ostatniej zakładki (~39 i ~34 pt, zrzut
        // z iPada); bez niego obie przerwy między glifami wychodzą po ~33 pt.
        HStack(spacing: 0) {
          if let note {
            NoteTabButton(model: note, hardwareKeyboard: hardwareKeyboard, voice: voice)
          }
          addMenu
        }
      }
      .modifier(TabBarFollowShift(
        follow: follow, id: currentId, index: currentIndex, shown: currentIndex, state: scrollState))
      // Only a change of the current tab moves the row: other changes (a new tab, a renamed label) keep their jump.
      .animation(roomAnimation, value: currentId)
      // Tekst pierwszej zakładki na wspólnym wcięciu nagłówka (16 pt, `HeaderMetrics`).
      .padding(.horizontal, HeaderMetrics.tabBarInset)
    }
    .scrollIndicators(.hidden)
    .scrollPosition($position)
    // Krawędź liczona od wcięcia treści, nie od ramki: na iPadzie ramka paska sięga pod listę sesji.
    .onScrollGeometryChange(for: TabTokens.EdgeFade.self) { geometry in
      TabTokens.edgeFade(
        offset: geometry.contentOffset.x, contentWidth: geometry.contentSize.width,
        containerWidth: geometry.containerSize.width, leadingInset: geometry.contentInsets.leading,
        trailingInset: geometry.contentInsets.trailing)
    } action: { _, new in
      fade = new
    }
    .onScrollGeometryChange(for: TabBarCentring.Viewport.self) { geometry in
      TabBarCentring.Viewport(
        contentWidth: geometry.contentSize.width, containerWidth: geometry.containerSize.width,
        leadingInset: geometry.contentInsets.leading, trailingInset: geometry.contentInsets.trailing)
    } action: { old, new in
      scrollState.viewport = new
      // The first geometry can come after the bar appeared, and the centring needs it.
      if old.containerWidth == 0 { center() }
    }
    .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, new in
      scrollState.offset = new
    }
    // The mask follows the row's shift on the same animated index, so the fade matches the offset the bar shows.
    .mask {
      TabEdgeMaskFollow(
        fade: fade, follow: follow, id: currentId, index: currentIndex, shown: currentIndex, state: scrollState)
        .animation(roomAnimation, value: currentId)
    }
    .onAppear {
      laidOutIds = tabIds
      center()
      // Na iPhonie pasek powstaje od nowa przy każdym wejściu z listy, a `scrollTo` w chwili pojawienia się
      // przychodzi, zanim zakładki mają miejsce, i nic nie robi (zmierzone: po wejściu w ostatnią
      // sesję pasek stał w pozycji startowej, a bieżąca za prawą krawędzią). Drugi raz w następnym obrocie pętli,
      // po układzie.
      DispatchQueue.main.async { center() }
    }
    // A new current tab within the same list: the scroll goes to its end at once, in this turn, and the row is drawn
    // shifted back by the distance still to cover, from the current tab's index that the rooms' animation moves. So
    // the bar's motion runs on the rooms' clock: frames that the new screen's build holds are lost to both alike,
    // instead of the scroll running ahead on its own animation. Any other change jumps.
    .onChange(of: currentId) { slide(to: currentId) }
    .onChange(of: tabIds) { laidOutIds = tabIds }
    // A change of the content's width puts the current tab back in the middle (a new or a closed tab, the note), unless
    // it is only the "×" room moving to the new current tab, whose width depends on the label (`TabBarCentring.room`):
    // that change slides. The first layout does not reach it when the width is final at once (hence `onAppear`).
    .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.width } action: { _, width in recenter(content: width) }
    // Wysokość z treści (≥ 44 pt z celów dotyku): sztywne 44 pt ucinało etykiety w piśmie dostępności.
    .fixedSize(horizontal: false, vertical: true)
    .background(Color(uiColor: Palette.background))
    .overlay(alignment: .bottom) {
      if divider {
        Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(UICopy.tabsLabel)
    .accessibilityIdentifier("tabs.bar")
  }

  /// „+" jako menu („natywnie lepiej": zamiast ukrytego przytrzymania z PWA).
  private var addMenu: some View {
    // Wskaźnik czyta widok NAD menu, nie etykieta. Z odczytem w etykiecie `Menu` płytka na iPadzie się nie zapalała,
    // a przy notatce i zakładkach, zwykłych przyciskach SwiftUI, tak. Prawdopodobna przyczyna (nie
    // zmierzona: XCUITest nie umie najechać kursorem na iPadzie): etykietę menu system stawia w przycisku UIKit.
    // Pod wskaźnikiem glif w pełnym tekście na płytce w połowie krycia.
    RarogHoverReader(enabled: !addBusy) { hovered in
      Menu {
        Button(UICopy.newSessionTitle, systemImage: "bubble.left", action: addSession)
          .accessibilityIdentifier("tabs.add.session")
        Button(UICopy.newTerminal, systemImage: "terminal", action: addTerminal)
          .disabled(!terminalAvailable)
          .accessibilityIdentifier("tabs.add.terminal")
      } label: {
        ZStack {
          if addBusy {
            ProgressView().controlSize(.small)
          } else {
            // Glif `subheadline` w celu 44 pt, o stopień mniejszy od `body`.
            Image(systemName: "plus")
              .appFont(.subheadline.weight(.medium))
          }
        }
        .foregroundStyle(Color(uiColor: hovered ? Palette.text : (addBlocked == nil ? Palette.muted : Palette.idleInk)))
        // W osi etykiet zakładek, które stoją `tabLabelDrop` niżej środka celu.
        .offset(y: HeaderMetrics.tabLabelDrop)
        .frame(minWidth: 44, minHeight: 44)
        .background { if hovered { TabPlate(opacity: HoverTokens.agentRowAlpha) } }
        .contentShape(Rectangle())
      }
      .menuStyle(.button)
      .buttonStyle(.plain)
      .disabled(addBusy)
      .accessibilityLabel(addBusy ? UICopy.newSessionBusy : (addBlocked ?? UICopy.newTabMenu))
      .accessibilityIdentifier("tabs.add")
      // Podpowiedź na menu, nie na etykiecie (ten sam powód co odczyt wskaźnika wyżej); wiersz na pozycję menu. Bez
      // gestu naciśnięcia obok menu: otwarcie menu zdejmuje kursor z przycisku, a z nim dymek.
      .shortcutTip(
        lines: [ShortcutTipLine(UICopy.newSessionTitle, .newSession), ShortcutTipLine(UICopy.newTerminal, .newTerminal)],
        pressGesture: false)
    }
  }

  private static let spacing: CGFloat = 8

  /// Puts the current tab in the middle at once and ends a motion in flight; before the bar knows its geometry and
  /// widths it does nothing, and their arrival calls it again.
  private func center() {
    guard let index = tabs.firstIndex(where: \.current), case let (end, viewport)? = centred(at: index) else { return }
    withTransaction(Transaction(animation: nil)) {
      follow = .rest
      position.scrollTo(x: end + viewport.leadingInset)
    }
  }

  /// The centring on a new current tab: the scroll at the end offset at once (`TabBarCentring`), the row's shift
  /// (`TabBarFollowShift`) from the offset the bar shows now, also in the middle of a motion. A change that does not
  /// slide, or before the bar knows its widths, jumps.
  private func slide(to id: String?) {
    let motion = TabCloseRoomMotion(reduceMotion: reduceMotion, tabsBefore: laidOutIds, tabsAfter: tabIds)
    guard case .slide = motion, let id, let index = tabs.firstIndex(where: { $0.id == id }),
      let shown = scrollState.shownIndex, case let (end, viewport)? = centred(at: index)
    else { return center() }
    let shows = scrollState.offset - scrollState.shownShift
    let units = Double(index) - shown
    withTransaction(Transaction(animation: nil)) {
      follow = TabBarFollow(
        id: id, distance: units == 0 ? 0 : (end - shows) / CGFloat(units), offset: end, viewport: viewport)
      // The position's point counts from the content's start, the offset from the scroll view's edge.
      position.scrollTo(x: end + viewport.leadingInset)
    }
  }

  /// The content's width less the "×" room of the current tab, which a change of the current tab leaves as it is; a
  /// change beyond a pixel's rounding recentres. Before the bar knows the current tab's width it recentres too, and
  /// `center()` waits for the widths.
  private func recenter(content width: CGFloat) {
    let rest = tabs.firstIndex(where: \.current).flatMap(room(of:)).map { width - $0 }
    let old = scrollState.restContentWidth
    scrollState.restContentWidth = rest
    if let rest, let old, abs(rest - old) < 0.5 { return }
    center()
  }

  /// The "×" room of tab `index` as the current tab (0 for a tab without the "×"); `nil` before its width is known.
  private func room(of index: Int) -> CGFloat? {
    guard tabs.indices.contains(index) else { return nil }
    guard tabs[index].closes else { return 0 }
    return scrollState.contentWidths[tabs[index].id].map(TabBarCentring.room(content:))
  }

  /// The scroll offset with tab `index` centred as the current tab, on the display's pixels, and the geometry with the
  /// content's width it has once that tab holds the "×"; `nil` before the bar knows its geometry and every tab's width.
  private func centred(at index: Int) -> (offset: CGFloat, viewport: TabBarCentring.Viewport)? {
    let widths = tabs.compactMap { scrollState.contentWidths[$0.id] }
    guard var viewport = scrollState.viewport, widths.count == tabs.count, let room = room(of: index) else {
      return nil
    }
    if let rest = scrollState.restContentWidth { viewport.contentWidth = rest + room }
    let span = TabBarCentring.span(
      of: index, contentWidths: widths, current: tabs[index].closes ? index : nil, spacing: Self.spacing,
      leading: HeaderMetrics.tabBarInset)
    let scale = max(displayScale, 1)
    return ((TabBarCentring.offset(tab: span, in: viewport) * scale).rounded() / scale, viewport)
  }
}

/// Maska wygaszenia krawędzi paska: pod obszarem bezpiecznym (iPad: pod listą sesji) krycie krawędzi, potem przejście
/// do pełnego na `TabTokens.edgeFadeWidth` od krawędzi kolumny, środek pełny. Na początku listy i przy pasku bez
/// przewijania krycie krawędzi to 1, więc maska niczego nie zmienia; tło paska stoi pod scrollem, poza maską.
struct TabEdgeMask: View {
  let fade: TabTokens.EdgeFade

  var body: some View {
    HStack(spacing: 0) {
      Color.black.opacity(fade.leading).frame(width: fade.leadingInset)
      LinearGradient(colors: [.black.opacity(fade.leading), .black], startPoint: .leading, endPoint: .trailing)
        .frame(width: TabTokens.edgeFadeWidth)
      Color.black
      LinearGradient(colors: [.black, .black.opacity(fade.trailing)], startPoint: .leading, endPoint: .trailing)
        .frame(width: TabTokens.edgeFadeWidth)
      Color.black.opacity(fade.trailing).frame(width: fade.trailingInset)
    }
    // Wcięcia maska liczy sama, więc obszar bezpieczny nie może jej wcisnąć drugi raz.
    .ignoresSafeArea(edges: .horizontal)
  }
}

/// A tab: the state mark (a key tile or a small square) and the label (mono); the current one on the plate, with a
/// bright, bold label. The current session or terminal tab adds the divider and the "×" (`TabCloseButton`) after its
/// selection button, in a room that every tab has and only the current one opens (`TabCloseRoom`). The plate spans the
/// label, the divider and the "×" in two parts (`TabPlateSide`), outside the button's no-animation look; the selection
/// button keeps the tab's identifier, sentence and traits, so the "×" is an element of its own.
struct ProjectTabButton: View {
  let tab: ProjectTabModel
  let digit: Int?
  let select: () -> Void
  /// The tab's "×" (`ProjectTabModel.closes`); `nil` on siblings and the invite.
  var close: TabCloseModel?
  var closePress: () -> Void = {}
  var closeBlur: () -> Void = {}
  /// The width of the label's content as the layout gives it (`ProjectTabLabel.contentWidth`).
  var contentWidth: (CGFloat) -> Void = { _ in }
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

  var body: some View {
    HStack(spacing: 0) {
      Button(action: select) {
        ProjectTabLabel(tab: tab, showsMark: differentiateWithoutColor, digit: digit, contentWidth: contentWidth)
      }
      .buttonStyle(TabPressStyle())
      .accessibilityLabel(tab.spoken)
      // The current tab opens the window of the project's tabs (`HeaderTabsSlot.select`).
      .accessibilityHint(tab.tap == .switcher ? UICopy.switcherTabHint : "")
      .accessibilityAddTraits(tab.current ? .isSelected : [])
      .accessibilityIdentifier(tab.accessibilityId)
      .background {
        // The current tab's plate under the label: 10 pt under the tab's top and 6 pt over its bottom, centered on the
        // label's axis; with an open room its trailing part stands in the room. It comes and goes at once, so a new
        // current tab does not light up slowly, and the group moves it with the tab.
        ZStack {
          Color.clear
          if tab.current {
            TabPlateSide(rounded: tab.closes ? .leading : nil)
              // Under the room's part by a point, so no seam shows where the two parts meet.
              .padding(.trailing, tab.closes ? -1 : 0)
              .transition(.identity)
          }
        }
        .geometryGroup()
      }
      TabCloseRoom(open: tab.closes) {
        if tab.closes, let close {
          TabCloseButton(model: close, press: closePress, blur: closeBlur)
            // In at once on the new current tab and out at once on the old one: the room's width moves, not the "×".
            .transition(.identity)
        }
      }
    }
    // The divider and the "×" take the tab's height, which the label sets (44 pt, more in large text).
    .fixedSize(horizontal: false, vertical: true)
  }
}

/// The current tab's plate, or one side of it: the label's part has the leading corners and the open room's part
/// the trailing ones (`TabCloseRoom`), so the plate grows with the room while it opens.
struct TabPlateSide: View {
  /// The side with rounded corners; `nil` = both.
  let rounded: HorizontalEdge?

  var body: some View {
    let leading = rounded == .trailing ? 0 : TabTokens.plateRadius
    let trailing = rounded == .leading ? 0 : TabTokens.plateRadius
    UnevenRoundedRectangle(
      topLeadingRadius: leading, bottomLeadingRadius: leading, bottomTrailingRadius: trailing,
      topTrailingRadius: trailing, style: .continuous)
      .fill(Color(uiColor: Palette.tabPlate))
      .padding(.top, TabTokens.plateTopInset)
      .padding(.bottom, TabTokens.plateBottomInset)
  }
}

/// The room after a tab's label for the divider and the "×": open on the current session or terminal tab
/// (`TabBarCentring.room` wider than the tab as a sibling), closed to nothing on the others. Its width follows the
/// bar's animation of a change of the current tab; its content and its part of the plate come and go at once, the
/// plate's part takes the room's width as it moves, and the room clips the "×" while it opens, so the "×" never lies
/// over the next tab.
struct TabCloseRoom<Content: View>: View {
  let open: Bool
  @ViewBuilder let content: Content

  var body: some View {
    ZStack(alignment: .leading) {
      if open {
        TabPlateSide(rounded: .trailing).transition(.identity)
      }
      content
    }
      .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .leading)
      .clipped()
      // The group takes the animated frame from the bar and lays the "×" out in it, so a "×" that comes in on a tab
      // that moves stands at the tab's current place, not at its final one.
      .geometryGroup()
      .frame(width: open ? TabTokens.closeDividerWidth + TabTokens.closeTarget : 0)
  }
}

extension ProjectTabModel {
  /// Glif przed etykietą zakładki terminala i zaproszenia — zakładki sesji go nie mają.
  var glyph: String? {
    switch kind {
    case .session: nil
    case .terminal, .invite: "terminal"
    }
  }
}

/// Treść zakładki w celu dotyku 44 pt: kafelek z cyfrą albo kwadracik, przy „Rozróżniaj bez koloru" także znak stanu,
/// glif terminala i etykieta; bieżąca stoi na płytce.
struct ProjectTabLabel: View {
  let tab: ProjectTabModel
  /// Znak stanu przed etykietą stoi tylko przy systemowym „Rozróżniaj bez koloru":
  /// na co dzień stan niesie kolor kafelka albo kwadracika, a czytnik słyszy go w zdaniu zakładki
  /// (`tab.spoken`).
  let showsMark: Bool
  /// Cyfra skrótu Cmd w kafelku przed etykietą; `nil` = kwadracik (brak klawiatury sprzętowej, zakładka dziewiąta
  /// i dalsze poza ostatnią). Zaproszenie terminala nie ma ani jednego, ani drugiego (`ProjectTabModel.mark`).
  var digit: Int?
  /// The width of the content (the mark, the glyph and the text) without the insets and the target's minimum, from
  /// which the bar's centring derives the tab's width (`TabBarCentring.width`).
  var contentWidth: (CGFloat) -> Void = { _ in }
  /// Wskaźnik nad zakładką (`TabPressStyle` przez `RarogHoverReader`).
  @Environment(\.rarogHovered) private var hovered

  var body: some View {
    HStack(spacing: 4) {
      // Kafelek i kwadracik stoją 6 pt przed etykietą: odstęp rzędu i 2 pt.
      switch tab.mark(digit: digit) {
      case .key(let digit):
        TabShortcutKey(digit: digit, tone: tab.tone)
          .padding(.trailing, 2)
      case .square:
        TabStateSquare(tone: tab.tone)
          .padding(.trailing, 2)
      case .none:
        EmptyView()
      }
      if showsMark, let mark = StateGlyph.mark(tab.tone) {
        let color = PaletteTokens.tone(tab.tone)
        let alpha = TabTokens.markAlpha(tab.tone, current: tab.current)
        Image(systemName: mark)
          .appFont(.caption2.weight(.bold))
          .foregroundStyle(Color(uiColor: Palette.dynamic(
            dark: color.dark, light: color.light, darkAlpha: CGFloat(alpha.dark), lightAlpha: CGFloat(alpha.light))))
          .accessibilityHidden(true)
      }
      if let glyph = tab.glyph {
        Image(systemName: glyph)
          .appFont(glyphFont)
          .foregroundStyle(Color(uiColor: ink))
          .accessibilityHidden(true)
      }
      if tab.showsLabel {
        Text(tab.label)
          .appFont(.caption.monospaced().weight(tab.current ? .semibold : .regular))
          .foregroundStyle(Color(uiColor: ink))
          .lineLimit(1)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth($0) }
    // Treść niżej w celu 44 pt, bliżej linii gita pod paskiem (`HeaderMetrics`).
    .offset(y: HeaderMetrics.tabLabelDrop)
    .padding(.leading, HeaderMetrics.tabLabelInset)
    // Before the divider of the current tab the label keeps the divider gap instead of its inset, so the selection
    // button ends where the divider begins and shares no target with the "×"; the text stays where it is.
    .padding(.trailing, tab.closes ? TabTokens.closeDividerGap : HeaderMetrics.tabLabelInset)
    .frame(minWidth: HeaderMetrics.tabTarget, minHeight: HeaderMetrics.tabTarget)
    .background {
      // The current tab's plate stands outside the label (`ProjectTabButton`), under its "×" too. A sibling under the pointer
      // gets the same plate at half opacity, like an agent row under the cursor (`HoverTokens.agentRowAlpha`).
      if !tab.current && hovered {
        TabPlate(opacity: HoverTokens.agentRowAlpha)
      }
    }
    .contentShape(Rectangle())
  }

  /// Glif obok etykiety jest drobny; samodzielny glif zaproszenia ma pismo etykiety.
  private var glyphFont: AppFont {
    tab.showsLabel ? .caption2.weight(tab.current ? .semibold : .regular) : .caption
  }

  /// Wygaszone zaproszenie nie ma osobnego atramentu, więc kontrast zostaje AA; od czynnego odróżnia je zdanie
  /// czytnika i odpowiedź na tap. Siostra pod wskaźnikiem bierze pełny tekst, jak `.sibling:hover` w PWA.
  private var ink: UIColor {
    tab.current || hovered ? Palette.text : Palette.muted2
  }
}

/// Płytka w tle elementu paska: pełna szerokość celu, `TabTokens.plateTopInset` pod jego górą
/// i `plateBottomInset` nad dołem (środek w osi etykiety), w kolorze zaznaczonego wiersza listy. Bieżąca zakładka
/// w pełnym kryciu; zakładka, notatka i „+" pod wskaźnikiem w połowie (`HoverTokens.agentRowAlpha`), jak wiersz
/// agenta pod kursorem.
struct TabPlate: View {
  let opacity: Double

  var body: some View {
    RoundedRectangle(cornerRadius: TabTokens.plateRadius, style: .continuous)
      .fill(Color(uiColor: Palette.tabPlate).opacity(opacity))
      .padding(.top, TabTokens.plateTopInset)
      .padding(.bottom, TabTokens.plateBottomInset)
  }
}

/// Kafelek skrótu na zakładce: cyfra, pod którą Cmd otwiera tę zakładkę, na tle bez obrysu.
/// Kafelek
/// niesie stan zakładki (`TabTokens.key`): cisza neutralnie (cyfra `muted`), każdy inny stan w kolorze kropki z listy
/// sesji; na kolorowym kafelku cyfra zawsze `onState` (kolor tła).
/// Wypełnienie jest kryjące, złożone na tle paska: na płytce bieżącej kafelek wygląda tak samo jak u sióstr. Pismo
/// `caption2`, o 1 pt mniejsze od etykiety — wyjątek na liście `DynamicTypeSourceTests`.
/// Czytnik kafelka nie słyszy: zdanie zakładki niesie przycisk.
struct TabShortcutKey: View {
  let digit: Int
  let tone: StatusTone

  var body: some View {
    let look = TabTokens.key(tone)
    Text(String(digit))
      .appFont(.caption2.monospaced().weight(look.semibold ? .semibold : .medium))
      .foregroundStyle(Color(uiColor: Palette.dynamic(look.ink)))
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .background(RoundedRectangle.ghost.fill(Color(uiColor: Palette.dynamic(look.fill))))
      .accessibilityHidden(true)
  }
}

/// Kwadracik stanu przed etykietą zakładki bez cyfry skrótu (iPhone, iPad bez klawiatury, zakładka dziewiąta i dalsze
/// poza ostatnią): `TabTokens.square` — cisza neutralnie, każdy inny stan w kolorze kropki z listy sesji. Stoi
/// zawsze, także w ciszy, żeby szerokość zakładki nie skakała przy zmianie stanu. Cichy jest półprzezroczysty, więc
/// na płytce bieżącej zostaje widoczny. Czytnik go nie słyszy.
struct TabStateSquare: View {
  let tone: StatusTone

  var body: some View {
    let look = TabTokens.square(tone)
    RoundedRectangle(cornerRadius: TabTokens.squareRadius, style: .continuous)
      .fill(Color(uiColor: Palette.dynamic(
        dark: look.color.dark, light: look.color.light, darkAlpha: CGFloat(look.alpha.dark),
        lightAlpha: CGFloat(look.alpha.light))))
      .frame(width: TabTokens.squareSide, height: TabTokens.squareSide)
      .accessibilityHidden(true)
  }
}

/// Palec: delikatnie przygaszona zakładka, bez dodatkowego tła i bez skali. Prostokąt `surface2` pod
/// wciśniętą zakładką błyskałby przy każdym tapnięciu: zapalałby się na
/// ułamek sekundy, a wybór i tak przestawia płytkę i pismo. Wskaźnik: etykieta siostry w pełnym tekście na płytce
/// w połowie krycia (`ProjectTabLabel` czyta `rarogHovered`); palec wskaźnika nie ma, więc tapnięcie jej nie zapala.
struct TabPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    RarogHoverReader { _ in
      TabPressLook(label: configuration.label, pressed: configuration.isPressed)
    }
  }
}

/// Wygląd zakładki pod palcem, wydzielony ze stylu, żeby test mógł go wyrenderować w obu stanach.
struct TabPressLook<Label: View>: View {
  let label: Label
  let pressed: Bool

  var body: some View {
    // Przygasza i wraca skokiem: przy płynnym powrocie krycia (0,2 s) nowo wybrana zakładka
    // „zapalałaby się” powoli razem z płytką.
    // Transakcja bez animacji obejmuje całą zakładkę: wybór (pismo, kolor, płytka) też bez animacji,
    // nawet gdy przełączenie przyjdzie w animowanej transakcji z zewnątrz.
    // The geometry group stands outside that transaction: the bar's animation still moves the tab as a whole (the
    // siblings slide when the current tab changes), while nothing inside it animates.
    label
      .opacity(pressed ? 0.7 : 1)
      .transaction { $0.animation = nil }
      .geometryGroup()
  }
}

/// Zdanie pod paskiem (powód blokady „+", odmowa serwera): karta, nigdy modal; gaśnie sama. Czytnikowi ogłasza je
/// `RarogNavigation.post` w chwili powstania, nie karta. Stoi w szczególe (`HeaderTabsSlot`), a w stosie przy liście na
/// wierzchu — u góry listy (`ListNoticeOverlay`).
struct NavigationNoticeCard: View {
  let notice: RarogNavigation.Notice
  let dismiss: (UUID) -> Void

  var body: some View {
    Text(notice.text)
      .underTabBarCard()
      .onTapGesture { dismiss(notice.id) }
      .accessibilityIdentifier("tabs.notice")
      .task(id: notice.id) {
        // Anulowane zadanie (karta zeszła z ekranu albo nie weszła) zdania nie gasi: gasi je karta, która dostała pełny
        // czas. W stosie przy liście na wierzchu zdanie gasło w tej samej chwili, w której powstało (zmierzone
        // XCUITest): zadanie którejś karty SwiftUI od razu anulował, a `try?` przepuszczał wtedy `dismiss`.
        guard (try? await Task.sleep(for: .seconds(notice.lifetime))) != nil else { return }
        dismiss(notice.id)
      }
  }
}

extension View {
  /// The surface of a card under the tab bar: the notice and the arming card (`CloseArmCard`).
  func underTabBarCard() -> some View {
    appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.text))
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
      .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
      // The card's edge on the header's inset, like the transcript bubbles under it.
      .padding(.horizontal, HeaderMetrics.contentInset)
      .padding(.top, 6)
  }
}
#endif
