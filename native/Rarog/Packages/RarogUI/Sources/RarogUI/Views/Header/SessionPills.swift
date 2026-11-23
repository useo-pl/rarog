#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Pigułki w linii statusu: „w tle" i nowszy Claude Code. Model i tryb
// stoją w rzędzie kontrolek pola wiadomości (`Session/ComposerPills`, za
// `docs/design.md` „Composer"). Wynik akcji (odmowa, powód, „uruchamiam") mówi zdanie pod
// paskiem zakładek (`RarogNavigation.post`) — karta, nigdy modal. Prawdę o restarcie przynosi
// strumień listy, nie odpowiedź na tap. Właściciel: nagłówek.

struct SessionPills: View {
  let store: RarogStore
  let session: SessionSummary
  /// Prawy panel pokazuje „w tle" — pigułki nie ma.
  var backgroundInPanel = false
  /// Telefon: pigułka „w tle” otwiera panel sesji jako arkusz (`RarogNavigation.backgroundPillTap`).
  var backgroundTap: BackgroundPillTap = .popover

  var body: some View {
    HStack(spacing: 8) {
      if StatusPills.background(session, inPanel: backgroundInPanel), let badge = BackgroundBadge(session) {
        BackgroundTasksPill(store: store, sessionId: session.id, badge: badge, tap: backgroundTap)
      }
      // Codex: Rarog widzi sam stan — restartu nie ma czym ruszyć. Reguła: `StatusPills.cli`.
      switch StatusPills.cli(session, restarting: store.state.restartInProgress(session.id)) {
      case let .offer(update): CliUpdatePill(store: store, sessionId: session.id, update: update)
      case .restarting:
        ProgressView().controlSize(.mini)
          .accessibilityLabel(UICopy.cliRestartBusy)
          .accessibilityIdentifier("header.cli.restarting")
      case nil: EmptyView()
      }
    }
  }
}

/// Wygląd pigułki (linia statusu i rząd kontrolek pola): kapsuła, tekst mono, ton = tło
/// w odcieniu i tekst w tym samym hue (jak banery). Palec dostaje 44 pt, oko — kompaktową kapsułę.
/// Pod wskaźnikiem jak `.pill--button:hover` w PWA: kreska i cichy tekst w kolorze
/// tekstu; chip bez kreski dostaje delikatne wypełnienie (`HoverTokens.wash`). Pigułka stoi zawsze w przycisku.
struct PillLabel: View {
  enum Tone: Equatable {
    case neutral, muted, wait, err, plan, run
  }

  let text: String
  var tone: Tone = .neutral
  var leadingDot: UIColor?
  /// Fill of an untoned pill: `surface2` in the status line, clear in the message field, like the paperclip and
  /// microphone circles (`RingButton`) — on the glass card the pill shows by its line, not by a fill of its own.
  var restFill: UIColor = Palette.surface2
  /// Kreska `border` wokół kapsuły. Pigułki pola wiadomości jej potrzebują (bez niej znikają na karcie pola);
  /// chipy linii statusu — „w tle" i „↑ wersja CLI" — stoją bez niej. Cena: w jasnym motywie
  /// `surface2` prawie zlewa się z tłem, więc chip czyta się jak zielony tekst — świadomie.
  var bordered = true

  /// Sufit pisma pigułek w rzędzie kontrolek pola: rząd to pasek, jak systemowe — pismo rośnie do
  /// xxxLarge, dalej pigułkę czyta podgląd dużej treści (przytrzymanie) i czytnik pełnym zdaniem.
  /// Bez sufitu nazwa modelu ucina się w piśmie dostępności do „Fable 5.1 · …".
  /// Sufit stoi na etykiecie, nie na rzędzie: popover pigułki go nie dziedziczy.
  static let barCeiling = DynamicTypeSize.xxxLarge

  var body: some View {
    RarogHoverReader { hovered in
      HStack(spacing: 5) {
        if let leadingDot {
          Circle().fill(Color(uiColor: leadingDot)).frame(width: 6, height: 6)
        }
        Text(text)
          .appFont(.caption.monospaced())
          .lineLimit(1)
      }
      .foregroundStyle(Color(uiColor: ink(hovered: hovered)))
      // Widocznie ~32 pt jak `--control` w PWA; palec dostaje 44 pt z ramki niżej.
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      // Wypełnienie pod wskaźnikiem nad tłem pigułki (bliżej treści), pod napisem.
      .background { if hovered, !bordered { Capsule().fill(Color(uiColor: Palette.text).opacity(HoverTokens.wash)) } }
      .background(Capsule().fill(fill))
      // Kreska pod wskaźnikiem mocniejsza, ale ciemniejsza od napisu (`hoverStroke`, jak kółka rzędu pola).
      .overlay { if bordered { Capsule().strokeBorder(Color(uiColor: hovered ? Palette.hoverStroke : Palette.border)) } }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
  }

  /// Cichy tekst (bez tonu) pod wskaźnikiem bierze pełny tekst; tony stanu zostają w swoim kolorze.
  private func ink(hovered: Bool) -> UIColor {
    switch tone {
    case .neutral, .muted: hovered ? Palette.text : (tone == .neutral ? Palette.muted : Palette.muted2)
    default: ink
    }
  }

  private var ink: UIColor {
    switch tone {
    case .neutral: Palette.muted
    case .muted: Palette.muted2
    case .wait: Palette.wait
    case .err: Palette.err
    case .plan: Palette.new
    case .run: Palette.text
    }
  }

  private var fill: Color {
    switch tone {
    case .wait: Color(uiColor: Palette.wait).opacity(0.14)
    case .err: Color(uiColor: Palette.err).opacity(0.14)
    case .plan: Color(uiColor: Palette.new).opacity(0.14)
    case .neutral, .muted, .run: Color(uiColor: restFill)
    }
  }
}

// MARK: - Nowszy Claude Code

/// `↑ 2.1.283`: pierwszy tap uzbraja „Uruchomić ponownie?" na 5 s (ogłoszone czytnikowi), drugi
/// wznawia TĘ SAMĄ rozmowę na nowym CLI. Tylko wybrana sesja — akcji „wszystkie" nie ma.
/// From the second tap the pill gives way to a lone spinner (`SessionPills`) until the restart ends; it comes back only
/// when the restart failed.
struct CliUpdatePill: View {
  let store: RarogStore
  let sessionId: String
  let update: CliUpdate
  @Environment(RarogNavigation.self) private var navigation
  @State private var armedUntil: Date?

  static let armWindow: TimeInterval = 5

  var body: some View {
    let armed = armedUntil.map { $0 > Date() } ?? false
    Button(action: tap) {
      PillLabel(
        text: armed ? UICopy.cliRestartQuestion : UICopy.cliUpdatePill(update.installed), tone: .run, bordered: false)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(armed
      ? UICopy.cliRestartQuestion
      : UICopy.cliUpdateSpoken(running: update.running, installed: update.installed))
    .accessibilityIdentifier("header.cli")
    .task(id: armedUntil) {
      guard let until = armedUntil else { return }
      try? await Task.sleep(for: .seconds(max(0, until.timeIntervalSinceNow)))
      if armedUntil == until { armedUntil = nil }
    }
  }

  private func tap() {
    if store.state.restartInProgress(sessionId) {
      navigation.post(UICopy.cliRestartBusy)
      return
    }
    // Uzbrojenie SYNCHRONICZNIE, zanim cokolwiek wyjdzie: dwa szybkie tapy nie zatwierdzą
    // pytania, którego człowiek nie widział.
    guard let until = armedUntil, until > Date() else {
      armedUntil = Date().addingTimeInterval(Self.armWindow)
      Announcer.shared.say(UICopy.cliRestartArmed)
      return
    }
    armedUntil = nil
    let installed = update.installed
    Task {
      let outcome = await store.restartCli(sessionId)
      if outcome == .accepted {
        navigation.post(UICopy.cliRestarting(installed))
      } else if let message = UICopy.controlMessage(outcome, fallback: UICopy.cliRestartFailed) {
        navigation.post(message)
      }
    }
  }
}

// MARK: - Zadania w tle

/// `● 3 w tle` — sama liczba, kropka w barwie pracy (proces w tle nikogo nie blokuje, więc bez
/// bursztynu). Kropka to znak pracy: gdy na liście stoją sami subagenci w postoju, pigułka dalej liczy
/// zadania (`1 w tle`), ale kropki nie ma (`BackgroundBadge`). Licznik czasu tylko w panelu, żeby
/// nagłówek nie tykał. Po ostatnim zadaniu pigułka znika razem z panelem — pusta ramka nie zostaje (koniec
/// przebiegu workflow też zamyka panel). Panel czyta zadania z magazynu sam, więc otwarty popover nadąża za
/// ramkami listy.
struct BackgroundTasksPill: View {
  let store: RarogStore
  let sessionId: String
  let badge: BackgroundBadge
  /// Dymek z zadaniami (iPad, Codex) albo arkusz panelu sesji (telefon).
  var tap: BackgroundPillTap = .popover
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(RarogNavigation.self) private var navigation
  @State private var open = false
  /// Stopka „Otwórz w panelu z prawej": panel staje dopiero PO zamknięciu popovera — stojący panel zdejmuje
  /// pigułkę, czyli źródło popovera, a zdjęte w trakcie zamykania osierociłoby prezentację.
  @State private var openPanelAfterDismiss = false


  /// Prawy panel może stanąć przy tej sesji (iPad, kolumna od 920 pt) — wtedy popover ma stopkę z przejściem.
  private var panelFits: Bool {
    sizeClass == .regular && navigation.inspectorSession(store.state) != nil && navigation.inspector.canOpen
  }

  var body: some View {
    Button {
      switch tap {
      case .popover: open = true
      case let .panelSheet(anchor): navigation.openInspectorSheet(sessionId: sessionId, anchor: anchor)
      }
    } label: {
      PillLabel(text: badge.text, tone: .run, leadingDot: badge.working ? Palette.run : nil, bordered: false)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(badge.spoken)
    .accessibilityIdentifier("header.background")
    .popover(isPresented: $open, arrowEdge: .top) {
      // Zwykła szerokość = popover (sufit wysokości); wąska = arkusz od połowy ekranu — skończeni agenci są
      // zwinięci, więc i przebieg workflow mieści się zwykle w połowie (pełna wysokość gestem).
      BackgroundTasksPanel(
        store: store, sessionId: sessionId, ceiling: sizeClass == .regular ? PopoverLayout.ceiling : nil,
        openInPanel: panelFits ? { openPanelAfterDismiss = true; open = false } : nil)
        .dismissOnEscape { open = false }
        .popoverSheetChrome(title: UICopy.popoverBackgroundTitle)
        .popoverSurface()
        .presentationCompactAdaptation(.sheet)
        .onDisappear {
          guard openPanelAfterDismiss else { return }
          openPanelAfterDismiss = false
          // Panel otwiera się na sekcji W TLE — to ten sam widok, z którego człowiek przyszedł.
          navigation.inspector.anchors[sessionId] = InspectorModel.backgroundAnchor
          navigation.toggleInspector(store.state)
        }
    }
  }
}
#endif
