import Foundation
import RarogContract
import RarogTransport

// Akcje sterowania żywą sesją z nagłówka: model i effort, tryb, restart
// na nowszym Claude Code, restart z ponowną wysyłką promptu zablokowanego przez hook (spod notki
// w transkrypcie) i diff sesji (także per plik). Wyniki są typowane, zdania
// składa RarogUI. Nowy model, tryb i stan restartu przychodzą strumieniem listy — akcja niczego
// w podsumowaniu sesji nie przestawia sama (prawda jest jedna, ta sama na każdym urządzeniu).
// Właściciel: nagłówek.
extension RarogStore {
  /// Lista modeli do arkusza. Arkusz rysuje od razu ostatnią znaną (`sessionControls.models`),
  /// a ta odpowiedź ją odświeża; porażka zostawia ostatnią znaną (`nil` = żadnej nie było).
  /// Etykieta i opis wyboru z `*Ref` wracają w języku apki: renderer magazynu, ten sam co dla SSE.
  @discardableResult
  public func loadModels() async -> [ModelChoice]? {
    let login = currentLogin
    do {
      var list = try await transport.models()
      list.translate(renderer)
      dispatch(.session(.modelsLoaded(list.models)))
      return list.models
    } catch {
      if case .unauthorized = error { handleUnauthorized(since: login) }
      return state.sessionControls.models
    }
  }

  /// „Zatwierdź" w arkuszu modelu: RÓŻNICA wyboru jednym żądaniem. Blokada sesji (tura, kanał)
  /// odmawia bez żądania — arkusz w tym stanie i tak nie ma przycisku. `ultracode`: `true` włącza,
  /// `false` wyłącza, `nil` = bez zmiany; serwer składa komendę ultracode na końcu paczki.
  /// The in-flight entry stands before the request, so a second Apply in that window sends nothing (`.inFlight`);
  /// a refusal removes it, success leaves it to the list (the whole target) or the deadline.
  public func setModel(
    _ sessionId: String, model: String?, effort: EffortLevel?, ultracode: Bool? = nil
  ) async -> SessionControlOutcome {
    guard state.modelChangeBlock(for: sessionId) == nil,
      let body = SessionModelBody(model: model, effort: effort, ultracode: ultracode)
    else {
      return .notAllowed
    }
    let now = clock()
    if state.modelChangeInFlight(sessionId, now: now) { return .inFlight }
    let until = now.addingTimeInterval(SessionControlTiming.modelChangeWait)
    dispatch(.session(.modelChangeStarted(sessionId: sessionId, target: body, until: until)))
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(SessionControlTiming.modelChangeWait))
      self?.dispatch(.session(.modelChangeExpired(sessionId: sessionId, until: until)))
    }
    let login = currentLogin
    do {
      _ = try await transport.setSessionModel(sessionId: sessionId, body)
      return .accepted
    } catch {
      dispatch(.session(.modelChangeSettled(sessionId: sessionId, until: until)))
      return controlOutcome(error, login: login)
    }
  }

  /// Tap w pigułkę trybu: `plan` ↔ `auto`, `manual` → `plan`. Wpis „w locie" powstaje PRZED
  /// żądaniem (drugi tap w tym oknie nie ustawi w kolejce panelu powrotu), odmowa go zdejmuje,
  /// a sukces — dopiero lista z celem albo termin. Bramki stanu (tura, dialog) liczy serwer: tap
  /// w zajętą sesję wraca jego zdaniem, żeby pigułka mówiła, dlaczego zmiana poczeka.
  public func toggleMode(_ sessionId: String) async -> SessionControlOutcome {
    let now = clock()
    guard let target = ModeCycleTarget.toggle(from: state.sessions[sessionId]?.herdrMode) else { return .notAllowed }
    if state.modeToggleInFlight(sessionId, now: now) { return .inFlight }
    let until = now.addingTimeInterval(SessionControlTiming.modeToggleWait)
    dispatch(.session(.modeToggleStarted(sessionId: sessionId, target: target, until: until)))
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(SessionControlTiming.modeToggleWait))
      self?.dispatch(.session(.modeToggleExpired(sessionId: sessionId, until: until)))
    }
    let login = currentLogin
    do {
      try await transport.setSessionMode(sessionId: sessionId, SessionModeBody(mode: target))
      return .accepted
    } catch {
      dispatch(.session(.modeToggleSettled(sessionId: sessionId, until: until)))
      return controlOutcome(error, login: login)
    }
  }

  /// Drugi tap pigułki „↑ <wydanie>": wznawia TĘ SAMĄ rozmowę na nowym CLI. Apka nie
  /// dokłada bramek — każdą przeszkodę (tura, praca w tle, szkic w polu na Macu) serwer zwraca
  /// zdaniem, zanim cokolwiek się stanie. Dalszy przebieg jedzie po SSE.
  public func restartCli(_ sessionId: String) async -> SessionControlOutcome {
    await restart(sessionId, resend: nil)
  }

  /// „Uruchom ponownie i wyślij” pod notką promptu zablokowanego przez hook: restart TEJ jednej sesji
  /// i ponowna wysyłka zablokowanego promptu do nowego procesu, raz. Ciało niesie CAŁĄ blokadę karty (`seq`
  /// i `id`), tekst bierze serwer. Blokada inna niż ta, która stoi teraz na karcie (nowsza notka, przycisk już
  /// zgasł), nie wychodzi — serwer i tak odpowiedziałby 409. Bramki stanu (tura, pole na Macu, praca w tle)
  /// liczy serwer i oddaje zdaniem, jak przy pigułce.
  public func restartAndResend(_ sessionId: String, blocked: SessionPromptBlocked) async -> SessionControlOutcome {
    await restart(sessionId, resend: blocked)
  }

  /// Wspólna droga restartu. Wolno go, gdy karta ma nowszy CLI (`cliUpdate`, restart bez `resend`) albo TĘ blokadę
  /// promptu, którą niesie `resend` (`promptBlocked`) — inaczej `.notAllowed` bez żądania. Restart bez `resend`
  /// przy samej blokadzie serwer i tak odrzuca. Jeden restart sesji naraz, z pigułki albo spod notki, do końca
  /// widocznego na liście (`restartInProgress`).
  private func restart(_ sessionId: String, resend: SessionPromptBlocked?) async -> SessionControlOutcome {
    guard let session = state.sessions[sessionId] else { return .notAllowed }
    let allowed = resend.map { session.promptBlocked == $0 } ?? (session.cliUpdate != nil)
    guard allowed else { return .notAllowed }
    guard !state.restartInProgress(sessionId) else { return .inFlight }
    // In progress from the tap, not from the reply: the pill hides at once and comes back only when the restart fails
    // (`settleRestarts`) or the limit passes.
    let until = clock().addingTimeInterval(SessionControlTiming.restartLimit)
    dispatch(.session(.restartStarted(sessionId: sessionId, until: until)))
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(SessionControlTiming.restartLimit))
      self?.dispatch(.session(.restartExpired(sessionId: sessionId, until: until)))
    }
    defer { dispatch(.session(.restartFinished(sessionId: sessionId))) }
    let login = currentLogin
    do {
      _ = try await transport.restartSession(sessionId: sessionId, resend: resend)
      return .accepted
    } catch {
      let uncertain: Bool =
        switch error {
        case .offline, .timedOut, .cancelled, .invalidResponse: true
        default: false
        }
      dispatch(.session(.restartRefused(sessionId: sessionId, uncertain: uncertain)))
      return controlOutcome(error, login: login)
    }
  }

  /// Diff sesji względem HEAD. Odczyt, więc bez bramek; cache i unieważnianie po nowym stanie
  /// repozytorium trzyma widok (patch bywa wielkości pół megabajta — nie należy do stanu apki).
  public func sessionDiff(_ sessionId: String) async -> SessionDiffOutcome {
    let login = currentLogin
    do {
      return .loaded(try await transport.sessionDiff(sessionId: sessionId))
    } catch {
      switch error {
      case let .refused(refusal): return .refused(refusal.message)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// Lista zmienionych plików katalogu sesji. Odczyt, więc bez bramek; listę i rozwinięcia trzyma okno
  /// diffa (`DiffWindowModel` w RarogUI), nie stan apki.
  public func sessionDiffFiles(_ sessionId: String) async -> DiffFetchOutcome<DiffFileList> {
    let login = currentLogin
    do {
      return .loaded(try await transport.sessionDiffFiles(sessionId: sessionId))
    } catch {
      return diffOutcome(error, login: login)
    }
  }

  /// Patch jednego pliku z listy zmian. Ścieżkę sprawdza serwer: bierze ją tylko z listy, którą git
  /// wypisał w tym samym żądaniu.
  public func sessionDiffFile(_ sessionId: String, path: String) async -> DiffFetchOutcome<DiffFilePatch> {
    let login = currentLogin
    do {
      return .loaded(try await transport.sessionDiffFile(sessionId: sessionId, path: path))
    } catch {
      return diffOutcome(error, login: login)
    }
  }

  /// Błąd tras diffa per plik → wynik ze statusem i kodem odmowy (nie samo zdanie, jak przy `sessionDiff`).
  private func diffOutcome<Value>(_ error: TransportError, login: Int) -> DiffFetchOutcome<Value> {
    switch error {
    case let .refused(refusal): return .refused(DiffRefusal(status: nil, message: refusal.message))
    case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
      return .refused(DiffRefusal(status: failure.status, code: failure.code, message: failure.message))
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .offline: return .offline
    case .timedOut: return .timedOut
    case .cancelled, .invalidResponse: return .failed
    }
  }

  /// `login` = numer zalogowania sprzed żądania: spóźnione 401 nie wylogowuje nowego logowania.
  private func controlOutcome(_ error: TransportError, login: Int) -> SessionControlOutcome {
    switch error {
    case let .refused(refusal): return .refused(refusal.message)
    case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .offline: return .offline
    case .timedOut: return .timedOut
    case .cancelled, .invalidResponse: return .failed
    }
  }
}
