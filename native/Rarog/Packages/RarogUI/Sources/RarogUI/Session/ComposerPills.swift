#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Pigułki modelu i trybu w rzędzie kontrolek pod polem wiadomości: [spinacz] [model] [tryb] …
// [Wyślij] (`docs/design.md` „Composer"). Tryb widać tam,
// gdzie człowiek dyktuje — `auto` wykonuje polecenia bez pytania. Wynik akcji (odmowa, powód) mówi
// zdanie pod paskiem zakładek (`RarogNavigation.post`) — karta, nigdy modal. Nowy model i tryb
// przynosi strumień listy, nie odpowiedź na tap. Rząd wstawia `SessionViewController+Controls`.
// Właściciel: nagłówek.

struct ComposerPills: View {
  let store: RarogStore
  let sessionId: String
  /// Dymek modelu z komendy apki `/model` albo `/effort` (`+AppCommands`).
  let modelSheetRequests: ModelSheetRequests

  var body: some View {
    // Codex: Rarog widzi sam stan — modelu i trybu nie ma czym ruszyć.
    if let session = store.state.sessions[sessionId], ModelPillModel.shows(session) {
      HStack(spacing: 6) {
        if !ModelPillModel.hiddenForUITests(environment: ProcessInfo.processInfo.environment) {
          ModelPill(store: store, session: session, requests: modelSheetRequests)
        }
        // Tryb nie ustępuje miejsca: przy ciasnym rzędzie skraca się nazwa modelu.
        ModePill(store: store, session: session).layoutPriority(1)
      }
      .task {
        // Etykiety modeli z listy serwera (aliasy); pigułka działa i bez niej — z identyfikatora.
        if store.state.sessionControls.models == nil { await store.loadModels() }
      }
    }
  }
}

// MARK: - Model i effort

/// Prośba o dymek modelu spoza pigułki: komenda apki `/model` albo `/effort` wysłana z pola wiadomości
/// (`SessionViewController+AppCommands`). Jeden obiekt na ekran sesji: ekran prosi (``open()``), a pigułka otwiera
/// dymek tą samą drogą co stuknięcie, więc to ten sam dymek z tymi samymi blokadami.
@MainActor
@Observable
final class ModelSheetRequests {
  /// Numer prośby; każda zmiana to jedno otwarcie.
  private(set) var count = 0

  func open() {
    count += 1
  }
}

/// Pigułka modelu otwiera arkusz „Model i effort". W turze i przed świeżym stanem sesji nie gaśnie:
/// wygląda na wyciszoną, a tap otwiera arkusz z jednym zdaniem dlaczego (jak `aria-disabled` w PWA);
/// to samo zdanie czytnik słyszy w podpowiedzi. Ten sam arkusz otwiera komenda apki
/// (``ModelSheetRequests``).
struct ModelPill: View {
  let store: RarogStore
  let session: SessionSummary
  let requests: ModelSheetRequests
  /// Numer prezentacji arkusza: odpowiedź „Zatwierdź" dotyczy tylko arkusza, z którego wyszła.
  @State private var sheet = SheetPresentation()
  /// Klasa szerokości PREZENTUJĄCEGO: w wąskiej dymek modelu jest arkuszem, więc wysokość daje detent.
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    let state = store.state
    let now = Date()
    // In flight: the target set in the quiet tone with a spinner, until the list shows it or the deadline passes. A
    // tap opens the sheet with the in-flight sentence instead of Apply.
    let pill = ModelPillModel.make(
      session, choices: state.sessionControls.models ?? [], target: state.modelChangeTarget(session.id, now: now))
    let reason = state.modelChangeReason(for: session.id, now: now)
    Button {
      sheet.open()
    } label: {
      HStack(spacing: 4) {
        if pill.switching { ProgressView().controlSize(.mini) }
        PillLabel(text: pill.text, tone: pill.unknown || reason != nil ? .muted : .neutral, restFill: .clear)
      }
      .dynamicTypeSize(...PillLabel.barCeiling)
    }
    .buttonStyle(.plain)
    .accessibilityShowsLargeContentViewer { Text(pill.text) }
    .accessibilityLabel(pill.spoken)
    .accessibilityHint(reason ?? "")
    .accessibilityIdentifier("composer.model")
    // Komenda apki: stojący dymek zostaje (nowy numer prezentacji zamknąłby go i otworzył od nowa).
    .onChange(of: requests.count) {
      if sheet.current == nil { sheet.open() }
    }
    // Bez narzuconej krawędzi strzałki: pigułka stoi przy dolnej krawędzi, system wybiera miejsce.
    .popover(item: Binding(get: { sheet.current }, set: { if $0 == nil { sheet.dismiss() } })) { ticket in
      ModelSheet(
        store: store, sessionId: session.id,
        isCurrent: { sheet.isCurrent(ticket) },
        dismiss: { sheet.close(ticket) },
        compact: sizeClass != .regular)
        .popoverSheetChrome(title: UICopy.modelSheetTitle, fitsContent: true)
        .popoverSurface()
        .presentationCompactAdaptation(.sheet)
    }
  }
}

// MARK: - Tryb

/// Tap przełącza `plan` ↔ `auto`; pigułka zostaje klikalna także wtedy, gdy przełączenie
/// poczeka (w locie, sesja przed świeżym stanem), żeby powiedzieć dlaczego. W `plan` delikatny
/// błękit. Wybór trybu nie jest bramką bezpieczeństwa.
struct ModePill: View {
  let store: RarogStore
  let session: SessionSummary
  @Environment(RarogNavigation.self) private var navigation

  var body: some View {
    let busy = store.state.modeToggleInFlight(session.id, now: Date())
    if let pill = ModePillModel.make(session, busy: busy, stale: store.state.sessionStale(session.id)) {
      Button {
        tap(pill)
      } label: {
        HStack(spacing: 4) {
          if busy { ProgressView().controlSize(.mini) }
          PillLabel(text: pill.text, tone: tone(pill.tone), restFill: .clear)
        }
        .dynamicTypeSize(...PillLabel.barCeiling)
      }
      .buttonStyle(.plain)
      .accessibilityShowsLargeContentViewer { Text(pill.text) }
      .accessibilityLabel(pill.spoken)
      .accessibilityHint(pill.blockedReason ?? "")
      .accessibilityIdentifier("composer.mode")
    }
  }

  private func tone(_ tone: ModePillModel.Tone) -> PillLabel.Tone {
    switch tone {
    case .neutral: .neutral
    case .wait: .wait
    case .err: .err
    case .plan: .plan
    case .muted: .muted
    }
  }

  private func tap(_ pill: ModePillModel) {
    guard let mode = session.herdrMode else { return }
    if let reason = pill.blockedReason {
      navigation.post(reason)
      return
    }
    guard pill.target != nil else {
      navigation.post(UICopy.modeNoTarget(mode))
      return
    }
    guard !pill.busy else {
      navigation.post(UICopy.modeBusy)
      return
    }
    let id = session.id
    Task {
      let outcome = await store.toggleMode(id)
      if let message = UICopy.controlMessage(outcome, fallback: UICopy.modeFailed) { navigation.post(message) }
    }
  }
}
#endif
