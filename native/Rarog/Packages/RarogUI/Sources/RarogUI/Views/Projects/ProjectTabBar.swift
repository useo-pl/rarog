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
  let select: (ProjectTabModel) -> Void
  let addSession: () -> Void
  let addTerminal: () -> Void
  /// Krycie krawędzi z geometrii przewinięcia (`TabTokens.edgeFade`).
  @State private var fade = TabTokens.EdgeFade.off

  private var currentId: String? { tabs.first(where: \.current)?.id }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(tabs) { tab in
            ProjectTabButton(tab: tab, digit: tab.target.flatMap { digits[$0] }) { select(tab) }
              .id(tab.id)
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
        // Tekst pierwszej zakładki na wspólnym wcięciu nagłówka (16 pt, `HeaderMetrics`).
        .padding(.horizontal, HeaderMetrics.tabBarInset)
      }
      .scrollIndicators(.hidden)
      // Krawędź liczona od wcięcia treści, nie od ramki: na iPadzie ramka paska sięga pod listę sesji.
      .onScrollGeometryChange(for: TabTokens.EdgeFade.self) { geometry in
        TabTokens.edgeFade(
          offset: geometry.contentOffset.x, contentWidth: geometry.contentSize.width,
          containerWidth: geometry.containerSize.width, leadingInset: geometry.contentInsets.leading,
          trailingInset: geometry.contentInsets.trailing)
      } action: { _, new in
        fade = new
      }
      .mask { TabEdgeMask(fade: fade) }
      .onAppear {
        center(proxy)
        // Na iPhonie pasek powstaje od nowa przy każdym wejściu z listy, a `scrollTo` w chwili pojawienia się
        // przychodzi, zanim zakładki mają miejsce, i nic nie robi (zmierzone: po wejściu w ostatnią
        // sesję pasek stał w pozycji startowej, a bieżąca za prawą krawędzią). Drugi raz w następnym obrocie pętli,
        // po układzie.
        DispatchQueue.main.async { center(proxy) }
      }
      .onChange(of: currentId) { center(proxy) }
      // Każda zmiana szerokości treści stawia bieżącą z powrotem na środku: klawiatura sprzętowa (kafelki z cyfrą są
      // szersze od kwadracików), nowa albo przemianowana zakładka, etykieta, która doszła
      // po wejściu. Pierwszego układu ta zmiana nie łapie, gdy szerokość jest od razu ostateczna (stąd `onAppear`).
      .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.width } action: { _, _ in center(proxy) }
    }
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

  private func center(_ proxy: ScrollViewProxy) {
    guard let currentId else { return }
    proxy.scrollTo(currentId, anchor: .center)
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

/// Zakładka: znak stanu (kafelek albo kwadracik) i etykieta (mono); bieżąca na płytce, z jasną, pogrubioną etykietą.
struct ProjectTabButton: View {
  let tab: ProjectTabModel
  let digit: Int?
  let select: () -> Void
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

  var body: some View {
    Button(action: select) {
      ProjectTabLabel(tab: tab, showsMark: differentiateWithoutColor, digit: digit)
    }
    .buttonStyle(TabPressStyle())
    .accessibilityLabel(tab.spoken)
    // Bieżąca otwiera okno aktywnych sesji (`HeaderTabsSlot.select`).
    .accessibilityHint(tab.current ? UICopy.switcherTabHint : "")
    .accessibilityAddTraits(tab.current ? .isSelected : [])
    .accessibilityIdentifier(tab.accessibilityId)
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
    // Treść niżej w celu 44 pt, bliżej linii gita pod paskiem (`HeaderMetrics`).
    .offset(y: HeaderMetrics.tabLabelDrop)
    .padding(.horizontal, HeaderMetrics.tabLabelInset)
    .frame(minWidth: 44, minHeight: 44)
    .background {
      // Płytka bieżącej: pełna szerokość celu, 10 pt pod jego górą i 6 pt nad dołem — środek w osi etykiety.
      // Siostra pod wskaźnikiem dostaje tę samą płytkę w połowie krycia, jak wiersz agenta pod kursorem
      // (`HoverTokens.agentRowAlpha`).
      if tab.current || hovered {
        TabPlate(opacity: tab.current ? 1 : HoverTokens.agentRowAlpha)
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
    label
      .opacity(pressed ? 0.7 : 1)
      .transaction { $0.animation = nil }
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
      .appFont(.footnote)
      .foregroundStyle(Color(uiColor: Palette.text))
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
      .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
      // Krawędź karty na wcięciu nagłówka, jak dymki transkryptu pod nią.
      .padding(.horizontal, HeaderMetrics.contentInset)
      .padding(.top, 6)
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

/// „×" w nagłówku: dwa naciśnięcia. Pierwsze uzbraja „Na pewno?" na 5 s, drugie
/// zamyka; etykieta mówi skutek („Zamknij panel w herdr", przy done „Usuń z listy"). Fokus
/// klawiatury (Tab, Full Keyboard Access) schodzący z przycisku rozbraja — jak `blur` w PWA.
struct HeaderCloseButton: View {
  let session: SessionSummary
  let store: RarogStore
  let navigation: RarogNavigation
  @FocusState private var focused: Bool

  var body: some View {
    let armed = navigation.closeArm?.sessionId == session.id
    Button(action: tap) {
      if navigation.closing.contains(session.id) {
        ProgressView().controlSize(.small)
      } else if armed {
        Text(UICopy.confirmQuestion)
          .appFont(.subheadline.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.err))
      } else {
        Label(UICopy.closeLabel(session), systemImage: "xmark")
      }
    }
    .buttonStyle(HeaderIconButtonStyle())
    .disabled(navigation.closing.contains(session.id))
    .accessibilityLabel(armed ? UICopy.list([UICopy.confirmQuestion, UICopy.closeLabel(session)], .sentence) : UICopy.closeLabel(session))
    .accessibilityIdentifier("header.close")
    .shortcutTip(UICopy.closeLabel(session), .closeTab)
    .focused($focused)
    .onChange(of: focused) { wasFocused, isFocused in
      if wasFocused, !isFocused { navigation.disarmClose() }
    }
    .task(id: navigation.closeArm) {
      guard let arm = navigation.closeArm, arm.sessionId == session.id else { return }
      try? await Task.sleep(for: .seconds(max(0, arm.until.timeIntervalSinceNow)))
      navigation.disarm(arm)
    }
  }

  private func tap() {
    switch navigation.requestClose(session.id, state: store.state, now: Date()) {
    case .armed:
      Announcer.shared.say(UICopy.closeArmed(session))
    case .confirmed:
      Task { await navigation.close(session.id, store: store) }
    case .unavailable:
      break
    }
  }
}
#endif
