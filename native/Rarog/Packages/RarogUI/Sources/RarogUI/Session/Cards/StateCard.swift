#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Karta stanu w miejscu pola wiadomości: limit, przerwana,
// błąd, do wznowienia, gotowe, nieobsługiwana. Żadnego ślepego zaułka: każda karta mówi, co dalej.
// Wstawia ją `SessionViewController+StateCard`. Właściciel: karty.

struct StateCardView: View {
  let store: RarogStore
  let sessionId: String
  @Environment(RarogNavigation.self) private var navigation
  /// Wynik akcji należy do karty, z której wyszła (`StateCardModel.key`): po zmianie stanu nie wraca.
  @State private var result: Result?
  @State private var busy: Busy?
  /// Odświeżenie etykiety „×"/„Zamknij panel" po upływie uzbrojenia (5 s, wspólne z nagłówkiem).
  @State private var armTick = 0
  /// Fokus klawiatury na przycisku zamknięcia — jego utrata rozbraja (jak „×" nagłówka).
  @FocusState private var closeFocused: Bool

  struct Result: Equatable {
    let key: String
    let text: String
    let isError: Bool
  }

  struct Busy: Equatable {
    let key: String
    let action: Action
  }

  enum Action: Equatable { case resume, newSession }

  var body: some View {
    if let card = StateCards.make(state: store.state, sessionId: sessionId) {
      content(card)
        .id(card.key)
    }
  }

  private func content(_ card: StateCardModel) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(card.eyebrow)
        .eyebrow(tone(card.tone))
        // Kapitaliki są tylko wizualne: czytnik dostaje etykietę zwykłą wielkością liter.
        .accessibilityLabel(card.eyebrow)
        .accessibilityAddTraits(.isHeader)
      Text(card.text)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("state.text")
      actions(card)
      if let result, result.key == card.key {
        Text(result.text)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: result.isError ? Palette.err : Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("state.result")
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .cardSurface()
    // Karta stoi tam, gdzie pole wiadomości: 10 pt od krawędzi kolumny, like the field card, i z tym samym
    // miejscem pod sobą, więc jej dolna krawędź staje tam, gdzie dół karty pola.
    .padding(.horizontal, ListFooterMetrics.cardSide)
    .padding(.top, 8)
    .padding(.bottom, ComposerView.bottomInset)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("card.state")
  }

  @ViewBuilder private func actions(_ card: StateCardModel) -> some View {
    switch card.actions {
    case .none:
      EmptyView()
    case .resume:
      // Sesja stoi i sama nie ruszy: wznawiasz albo domykasz. Zamknięcie drugorzędne, po lewej;
      // „Wznów" zostaje SŁOWEM w akcencie — powód, dla którego wracasz na ten ekran.
      HStack(spacing: 12) {
        closeButton(card, label: UICopy.forgetCard)
        Spacer(minLength: 0)
        Button(isBusy(card, .resume) ? UICopy.resuming : UICopy.resume) { run(card, .resume) }
          .buttonStyle(FilledButtonStyle(fill: Color(uiColor: Palette.accent), text: Color(uiColor: Palette.onState)))
          .disabled(isBusy(card, .resume))
          .accessibilityIdentifier("state.resume")
      }
    case .livePanel:
      // Sesja żyje w panelu: z apki zostaje jej zamknięcie; panel w herdr człowiek znajdzie sam.
      closeButton(card, label: UICopy.closePanel)
    case .newSession:
      // The pane is gone (herdr side closed): removing the card sits next to starting a new session, as on the
      // resume card, so a finished session does not need the header or the list to leave it.
      HStack(spacing: 12) {
        closeButton(card, label: UICopy.forgetCard)
        Spacer(minLength: 0)
        Button(UICopy.newSession) { run(card, .newSession) }
          .buttonStyle(NeutralButtonStyle())
          .disabled(isBusy(card, .newSession) || navigation.creating)
          .accessibilityIdentifier("state.newSession")
      }
    }
  }

  /// Zamknięcie: pierwsze naciśnięcie pyta (uzbrojenie wspólne z „×" nagłówka, 5 s), drugie zamyka
  /// i prowadzi do ostatnio aktywnej siostry albo na listę. Fokus klawiatury (Tab, Full
  /// Keyboard Access) schodzący z przycisku rozbraja — powrót na niego uzbraja od nowa.
  private func closeButton(_ card: StateCardModel, label: String) -> some View {
    let _ = armTick
    let armed = navigation.isCloseArmed(sessionId, now: Date())
    return Button {
      close(card)
    } label: {
      if case .resume = card.actions, !armed {
        Image(systemName: "xmark").appFont(.subheadline.weight(.semibold)).frame(minWidth: 20)
      } else {
        Text(armed ? closeQuestion(card) : label)
      }
    }
    .buttonStyle(OutlineButtonStyle(color: Color(uiColor: Palette.err)))
    .disabled(navigation.closing.contains(sessionId))
    .accessibilityLabel(armed ? closeQuestion(card) : label)
    .accessibilityIdentifier("state.close")
    .focused($closeFocused)
    .onChange(of: closeFocused) { wasFocused, isFocused in
      if wasFocused, !isFocused { navigation.disarmClose() }
    }
  }

  private func closeQuestion(_ card: StateCardModel) -> String {
    if case .livePanel = card.actions { return UICopy.closePanelQuestion }
    return UICopy.confirmQuestion
  }

  private func isBusy(_ card: StateCardModel, _ action: Action) -> Bool {
    busy == Busy(key: card.key, action: action)
  }

  private func tone(_ tone: StateCardModel.Tone) -> UIColor {
    switch tone {
    case .failed: Palette.err
    case .waiting: Palette.wait
    case .quiet: Palette.muted
    }
  }

  // MARK: - Akcje

  private func close(_ card: StateCardModel) {
    switch navigation.requestClose(sessionId, state: store.state, now: Date()) {
    case .armed:
      if let session = store.state.sessions[sessionId] {
        Announcer.shared.say(UICopy.closeArmed(session))
      }
      Task {
        try? await Task.sleep(for: .seconds(RarogNavigation.closeArmWindow))
        armTick += 1
      }
    case .confirmed:
      Task { await navigation.close(sessionId, store: store) }
    case .unavailable:
      break
    }
  }

  private func run(_ card: StateCardModel, _ action: Action) {
    // Akcja w toku TEJ karty blokuje drugą; po zmianie stanu (nowa karta) stara blokada nie wiąże.
    if let busy, busy.key == card.key { return }
    busy = Busy(key: card.key, action: action)
    result = nil
    Task {
      let note: (text: String, isError: Bool)?
      switch action {
      case .resume:
        let outcome = await store.resumeSession(sessionId)
        note = outcome == .accepted
          ? (UICopy.resuming, false)
          : UICopy.resumeResult(outcome).map { ($0, true) }
      case .newSession:
        await navigation.createSession(in: card.actionsCwd ?? "", store: store)
        note = nil
      }
      // „Wznów" przyjęte trzyma przycisk w stanie „Wznawiam…", aż strumień przyniesie nowy stan.
      if !(action == .resume && note?.isError == false), busy?.key == card.key { busy = nil }
      guard let note else { return }
      result = Result(key: card.key, text: note.text, isError: note.isError)
      Announcer.shared.say(note.text)
    }
  }
}

extension StateCardModel {
  /// Katalog „Nowej sesji" (karta `gotowe`).
  var actionsCwd: String? {
    if case let .newSession(cwd) = actions { return cwd }
    return nil
  }
}
#endif
