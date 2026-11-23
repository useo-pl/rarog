#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Historia terminala: `GET history?lines=1000`
// w zwykłym `UITextView` (natywne zaznaczanie z uchwytami i lupką), na dole — ostatni output stoi na końcu
// i to on jest zwykle kopiowany. „Kopiuj całość" jednym gestem, stopka mówi, ile wierszy widać i czy historia
// została ucięta; „Wczytaj więcej" sięga do sufitu 5000.
// Dwa wejścia, JEDNA treść (`TerminalHistoryBody` i `TerminalHistoryState`):
// - z trasy terminala — okno na wspólnym szkielecie (`TerminalHistorySheet` na `WindowSheet`): pasek systemowy
//   z „×" z lewej, tytuł „HISTORIA" i projekt, „Kopiuj całość" ikoną z prawej; Esc, Cmd+W i „×" zamykają;
// - z okna terminala (Cmd+F, Cmd+G) — STRONA tego okna (`TerminalHistoryPage` w jego kontenerze nawigacji):
//   systemowy „‹" wraca do terminala, Esc, Cmd+W i Cmd+Y też; okno zostaje. Drugiego arkusza nad oknem nie ma.
// Jedno i drugie bierze klawiaturę od chwili pokazania (`SheetKeyboardAnchor`): terminal pod spodem nie dostaje
// liter wpisanych przy otwartej historii, a po zamknięciu klawiatura do niego wraca.
// Treść tylko w stanie widoku, do schowka wyłącznie gestem. Właściciel: terminal.

/// Stan jednej prezentacji historii: faza odczytu, limit wierszy i potwierdzenie kopii.
@MainActor
@Observable
final class TerminalHistoryState {
  var phase = TerminalHistoryPhase.loading
  var lines = TerminalHistoryLimits.initial
  var copied = false

  /// Odczyt historii dla bieżącego limitu (`task(id: lines)`).
  func load(store: RarogStore, terminalId: String) async {
    copied = false
    phase = .loading
    #if DEBUG
    // Szew testów UI: demo nie ma terminala, historia pokazuje zmyślony tekst (`TerminalDemoSeam`).
    if TerminalDemoSeam.isOn {
      phase = .loaded(text: TerminalDemoSeam.history, truncated: false)
      return
    }
    #endif
    phase = TerminalHistoryPhase(await store.terminalHistory(id: terminalId, lines: lines))
  }

  /// Cała historia do schowka — jawny eksport na gest człowieka (to samo, co zaznaczenie i „Kopiuj").
  func copyAll() {
    guard let text = phase.text else { return }
    UIPasteboard.general.string = text
    copied = true
    Announcer.shared.say(UICopy.terminalHistoryCopyDone)
  }
}

/// Okno historii z trasy terminala.
struct TerminalHistorySheet: View {
  let store: RarogStore
  let terminalId: String
  /// Szerokość okna apki (`appWindowWidth`), odczytana poza arkuszem.
  let windowWidth: CGFloat?
  @Environment(\.dismiss) private var dismiss
  @State private var state = TerminalHistoryState()

  var body: some View {
    WindowSheet(
      kind: UICopy.terminalHistory, name: TerminalHistoryBody.project(store: store, terminalId: terminalId),
      titleIdentifier: "terminal.history.title",
      close: SheetClose(label: UICopy.terminalHistoryClose, identifier: "terminal.history.close") { dismiss() },
      windowWidth: windowWidth
    ) {
      TerminalHistoryCopyButton(state: state)
    } content: {
      TerminalHistoryBody(store: store, terminalId: terminalId, state: state)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("terminal.history")
  }
}

/// Strona historii w oknie terminala: pasek daje kontener nawigacji okna (systemowy „‹" z lewej), a strona
/// dokłada tytuł, „Kopiuj całość" i klawisze powrotu. `back` zdejmuje stronę ze stosu.
struct TerminalHistoryPage: View {
  let store: RarogStore
  let terminalId: String
  let back: () -> Void
  @State private var state = TerminalHistoryState()

  var body: some View {
    TerminalHistoryBody(store: store, terminalId: terminalId, state: state)
      .navigationTitle(UICopy.terminalHistory)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          WindowTitle(
            kind: UICopy.terminalHistory, name: TerminalHistoryBody.project(store: store, terminalId: terminalId),
            identifier: "terminal.history.title")
        }
        ToolbarItem(placement: .primaryAction) { TerminalHistoryCopyButton(state: state) }
      }
      // Strona bierze klawiaturę od terminala i oddaje mu ją przy powrocie; Esc i Cmd+W idą jej łańcuchem.
      .background { SheetKeyboardAnchor() }
      .closesOnEscapeAndCommandW(back)
      // Cmd+Y otworzył historię z terminala — na stronie wraca.
      .background {
        Button(action: back) { Color.clear.frame(width: 1, height: 1) }
          .keyboardShortcut(AppShortcut.terminalHistory.keyboardShortcut)
          .buttonStyle(.plain)
          .opacity(0.011)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
      .tint(Color(uiColor: Palette.text))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("terminal.history")
  }
}

/// „Kopiuj całość" w pasku. Potwierdzenie kopii to podmiana ikony na ptaszek, bez koloru stanu
/// (`docs/design.md`, „Anti-patterns").
struct TerminalHistoryCopyButton: View {
  let state: TerminalHistoryState

  var body: some View {
    Button(action: state.copyAll) {
      Label(UICopy.terminalHistoryCopy, systemImage: state.copied ? "checkmark" : "doc.on.doc")
    }
    .disabled(state.phase.text == nil)
    .accessibilityIdentifier("terminal.history.copy")
  }
}

/// Treść historii: stan odczytu albo tekst ze stopką. Ta sama w oknie z trasy i na stronie okna terminala.
struct TerminalHistoryBody: View {
  let store: RarogStore
  let terminalId: String
  let state: TerminalHistoryState

  /// Nazwa projektu terminala z listy `GET /api/term`; bez wpisu tytuł to sam rodzaj („HISTORIA").
  static func project(store: RarogStore, terminalId: String) -> String {
    store.state.terminals.entry(id: terminalId).map { ProjectPath.name($0.cwd) } ?? ""
  }

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .safeAreaInset(edge: .bottom, spacing: 0) { footer }
      .background(Color(uiColor: Palette.background))
      .task(id: state.lines) { await state.load(store: store, terminalId: terminalId) }
      .task(id: state.copied) {
        // „Skopiowano" stoi w stopce 3 s, potem wraca liczba wierszy.
        guard state.copied else { return }
        try? await Task.sleep(for: .seconds(3))
        state.copied = false
      }
  }

  @ViewBuilder
  private var content: some View {
    switch state.phase {
    case .loading:
      status(UICopy.terminalHistoryLoading, spinner: true)
    case .empty:
      status(UICopy.terminalHistoryEmpty, spinner: false)
    case let .failed(message):
      status(message, spinner: false)
    case let .loaded(text, _):
      TerminalHistoryText(text: text)
        .accessibilityIdentifier("terminal.history.text")
    }
  }

  private func status(_ text: String, spinner: Bool) -> some View {
    VStack(spacing: 12) {
      if spinner { ProgressView() }
      Text(text)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .multilineTextAlignment(.center)
    }
    .padding(24)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("terminal.history.status")
  }

  @ViewBuilder
  private var footer: some View {
    if case let .loaded(text, truncated) = state.phase {
      HStack(spacing: 12) {
        Text(
          state.copied
            ? UICopy.terminalHistoryCopyDone
            : UICopy.terminalHistoryFoot(text: text, truncated: truncated, limit: state.lines)
        )
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityIdentifier("terminal.history.foot")
        Spacer(minLength: 0)
        if let more = TerminalHistoryLimits.more(after: state.lines, truncated: truncated) {
          Button(UICopy.terminalHistoryMore(more)) { state.lines = more }
            .appFont(.footnote.weight(.semibold))
            .accessibilityIdentifier("terminal.history.more")
        }
      }
      .padding(.horizontal, WindowLayout.sideInset)
      .padding(.top, 10)
      // Tekst stopki trzyma odstęp od zaokrąglonego rogu okna.
      .padding(.bottom, WindowLayout.scrollBottomInset)
      .background(Color(uiColor: Palette.background))
      .overlay(alignment: .top) { Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1) }
    }
  }
}

/// Tekst historii: `UITextView` tylko do odczytu, pismo terminala, zawijanie długich wierszy (kopia ma
/// oryginalne końce linii), przewinięty na koniec.
struct TerminalHistoryText: UIViewRepresentable {
  let text: String

  func makeUIView(context: Context) -> UITextView {
    let view = HistoryTextView()
    view.isEditable = false
    view.isSelectable = true
    view.backgroundColor = Palette.background
    view.textColor = Palette.text
    view.applyFont()
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.dataDetectorTypes = []
    view.smartInsertDeleteType = .no
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    guard view.text != text else { return }
    view.text = text
    // Na dół: kopiuje się zwykle ostatni output, a on stoi na końcu historii.
    DispatchQueue.main.async {
      view.layoutIfNeeded()
      view.scrollRangeToVisible(NSRange(location: (text as NSString).length, length: 0))
    }
    (view as? HistoryTextView)?.takeKeyboard()
  }
}

/// Tekst historii jako odbiorca klawiatury: po wczytaniu bierze ją od kotwicy okna (`SheetKeyboardAnchor`), więc
/// Cmd+A zaznacza, a Cmd+C kopiuje bez dotykania tekstu. Pole jest tylko do
/// odczytu, więc klawiatura ekranowa się nie wysuwa. Esc i Cmd+W idą jego łańcuchem do skrótów okna.
final class HistoryTextView: UITextView {
  /// Bieżący pierwszy respondent — wstrzykiwany w testach (proces testów nie ma `UIApplication`).
  var currentResponder: @MainActor () -> UIResponder? = { FirstResponder.current() }
  private var attempts = 0
  /// The app's text size the history font follows (``applyFont()``); tests give their own.
  var textScale: TextScale = .shared {
    didSet {
      guard followsTextScale else { return }
      followTextScale()
      if TextStyleScaling.isFlat { applyFont() }
    }
  }
  private var followsTextScale = false

  /// The terminal's monospaced font at the text size, as the history text uses it. On the standard path the system
  /// scales it with the content size category; on the flat path (a Mac) it comes from the model's category and the
  /// view sets it again on each step from the first call on.
  func applyFont() {
    let base = UIFont.monospacedSystemFont(
      ofSize: TerminalFontSize.points(pad: UIDevice.current.userInterfaceIdiom == .pad), weight: .regular)
    font = TextStyleScaling.font(base, relativeTo: .body, category: textScale.effective)
    adjustsFontForContentSizeCategory = !TextStyleScaling.isFlat
    guard !followsTextScale else { return }
    followsTextScale = true
    followTextScale()
  }

  private func followTextScale() {
    Fonts.follow(self, scale: textScale) { [weak self] in
      guard let self, TextStyleScaling.isFlat else { return }
      self.applyFont()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    attempts = 0
    takeKeyboard()
  }

  /// W następnym obrocie kolejki: kotwica okna bierze klawiaturę pierwsza. Gdy jeszcze nie zdążyła, dwie próby
  /// ponowienia; komuś spoza okna tekst klawiatury nie zabiera.
  func takeKeyboard() {
    guard window != nil, !isFirstResponder, !(text ?? "").isEmpty else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + (attempts == 0 ? 0 : 0.15)) { [weak self] in
      guard let self, self.window != nil, !self.isFirstResponder else { return }
      if SheetKeyboardAnchor.handKeyboard(to: self, from: self.currentResponder()) { return }
      self.attempts += 1
      if self.attempts < 3 { self.takeKeyboard() }
    }
  }
}
#endif
