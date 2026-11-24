import Foundation
import RarogContract
import RarogTransport

// Turn interrupt and "viewed". Results are
// typed; RarogUI builds the sentences. Every area request (also from the new session form) goes through
// `tracked`: logout cancels it in flight, and a result from before a login change goes to the bin. A 401
// logs out only within the login in which the request went out: the action takes `currentLogin`
// before the request and calls `handleUnauthorized(since:)`. Owner: interrupt and session
// control.

/// Rejestr żądań obszaru w drodze (pole magazynu `turnRequests`): anulowanie przy wylogowaniu.
struct TurnRequests {
  var cancels: [UUID: @Sendable () -> Void] = [:]
}

extension RarogStore {
  // MARK: - Przerwanie

  /// Stop albo Esc: przerywa turę. JEDNA droga dla obu gestów — dwa gesty przerwania nie mogą
  /// mieć dwóch umów ani dwóch zdań o jednym zdarzeniu.
  ///
  /// - Bramka gestu: drugi gest w oknie poprzedniego nic nie wysyła (przytrzymany klawisz,
  ///   podwójne naciśnięcie), ale po rozstrzygnięciu albo po sufitie 4 s przechodzi — prawdziwa
  ///   idempotencja jest na serwerze (jedno przerwanie w locie i okno 1 s).
  /// - Limit 10 s i JEDNO ponowienie po błędzie sieci: serwer dopina drugie żądanie
  ///   do pierwszego, więc ponowienie nie wysyła drugiego Esc.
  /// - Odpowiedź od razu naprawia stan sesji (`interruptReplied`).
  public func interrupt(_ sessionId: String) async -> InterruptOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    guard state.interruptAvailability(for: sessionId) == .enabled else { return .notAllowed }
    let startedAt = clock()
    if state.interruptHeld(sessionId, now: startedAt) { return .inFlight }
    dispatch(.turnControl(.interruptStarted(sessionId: sessionId, at: startedAt)))
    defer { dispatch(.turnControl(.interruptSettled(sessionId: sessionId, startedAt: startedAt))) }

    let login = currentLogin
    var result = await tracked { try await $0.interruptSession(sessionId: sessionId) }
    if case let .failure(error)? = result, Self.isNetworkFailure(error) {
      try? await Task.sleep(for: TurnControlTiming.interruptRetryDelay)
      // Ponowienie należy do zalogowania pierwszej próby — po wylogowaniu w przerwie nie wychodzi.
      guard isCurrentLogin(login) else { return .loggedOut }
      if case .loggedIn = state.auth { result = await tracked { try await $0.interruptSession(sessionId: sessionId) } }
    }
    guard let result else { return .loggedOut }
    switch result {
    case let .success(reply):
      if let session = reply.session { dispatch(.turnControl(.interruptReplied(session))) }
      switch reply.delivered {
      // An empty field read is no hand-back: the app's field stays as it is.
      case nil, .yes?: return .delivered(returnedPrompt: reply.returnedPrompt.flatMap { $0.isEmpty ? nil : $0 })
      case .no?: return .notDelivered
      case .pending?: return .unsure
      }
    case let .failure(error):
      return interruptOutcome(error, login: login)
    }
  }

  /// Błąd → werdykt. Błąd sieci NIE dowodzi, że panel Esc nie przyjął: żądanie mogło dojść,
  /// a ponowienie dopięło się do pierwszego — „nie wiem". 4xx to bramka Raroga (nic nie poleciało
  /// do panelu), 5xx — awaria po drodze, więc droga wyjścia jest na Macu. Odpowiedź 2xx spoza
  /// kontraktu (nieznany los klawisza) też jest „nie wiem": przeczytana jako sukces oddałaby prompt
  /// do pola nad turą, która trwa.
  private func interruptOutcome(_ error: TransportError, login: Int) -> InterruptOutcome {
    switch error {
    case let .refused(refusal): return .refused(refusal.message)
    case let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
    case let .http(failure): return failure.status < 500 ? .refused(failure.message) : .notDelivered
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .offline, .timedOut, .cancelled, .invalidResponse: return .unsure
    }
  }

  static func isNetworkFailure(_ error: TransportError) -> Bool {
    switch error {
    case .offline, .timedOut: true
    default: false
    }
  }

  // MARK: - „Obejrzane"

  /// Ekran sesji (albo stanu Codexa) stoi na wierzchu z wynikiem: zgłasza „obejrzane" RAZ na wynik
  /// (`stateSince`). Wynik, którego już nie ma (tura ruszyła, odebrany gdzie indziej), zeruje
  /// pamięć — następny wynik i ponowne wejście zgłaszają się od nowa. Błąd jest cichy: karta
  /// zostaje w uwagach do następnego wejścia. Skutek uboczny świadomy: przestawia widok herdr na
  /// Macu.
  public func noteResultViewed(_ sessionId: String) {
    guard let target = state.seenTarget(sessionId) else {
      if state.turnControl.seen[sessionId] != nil { dispatch(.turnControl(.seenForgotten(sessionId: sessionId))) }
      return
    }
    guard state.turnControl.seen[sessionId] != target else { return }
    dispatch(.turnControl(.seenNoted(sessionId: sessionId, stateSince: target)))
    let login = currentLogin
    Task {
      guard case let .failure(error)? = await tracked({ try await $0.markSeen(sessionId: sessionId) }) else { return }
      if case .unauthorized = error { handleUnauthorized(since: login) }
    }
  }

  /// Ekran wyniku zniknął: ponowne wejście w tę samą sesję jest nowym „obejrzałem".
  public func leaveResultView(_ sessionId: String) {
    guard state.turnControl.seen[sessionId] != nil else { return }
    dispatch(.turnControl(.seenForgotten(sessionId: sessionId)))
  }

  /// Nowe wejście w sesję: koniec blokady ręcznego „nieprzeczytane”, ekran odbiera wynik jak zwykle. Ekran
  /// woła to RAZ na wejście — nie przy powrocie apki na wierzch i nie po zamknięciu podglądu nad sobą.
  public func enterResultView(_ sessionId: String) {
    guard state.turnControl.manualUnread.contains(sessionId) else { return }
    dispatch(.turnControl(.unreadReleased(sessionId: sessionId)))
  }

  // MARK: - „Przeczytane / nieprzeczytane” z listy

  /// Ręczny przełącznik odbioru wyniku. „Przeczytane” to ten sam `POST …/seen` co wejście w sesję, ale bez zapisu
  /// „obejrzane w tej wizycie” (to nie jest odbiór z ekranu). „Nieprzeczytane” najpierw blokuje odbiór z ekranu —
  /// sesja otwarta obok listy nie odbierze wyniku od razu z powrotem — potem `POST …/unseen`. Błąd cichy jak przy
  /// „obejrzane”: wiersz nie zmienia koloru; 401 wylogowuje.
  public func setResultRead(_ sessionId: String, read: Bool) {
    dispatch(.turnControl(read ? .unreadReleased(sessionId: sessionId) : .unreadMarked(sessionId: sessionId)))
    let login = currentLogin
    Task {
      let result = await tracked { transport in
        if read {
          try await transport.markSeen(sessionId: sessionId)
        } else {
          try await transport.markUnseen(sessionId: sessionId)
        }
      }
      guard case let .failure(error)? = result else { return }
      if case .unauthorized = error { handleUnauthorized(since: login) }
    }
  }

  // MARK: - Żądania obszaru

  /// Żądanie z numerem zalogowania. Wylogowanie anuluje je w drodze (spóźniony 401 nie ma prawa
  /// wylogować NOWEGO zalogowania); `nil` = wynik sprzed zmiany zalogowania — do kosza.
  /// Domknięcie rzuca wyłącznie ``TransportError`` (metody transportu); inny błąd byłby błędem
  /// programu i wraca jako `.invalidResponse`.
  func tracked<T: Sendable>(
    _ work: @escaping @Sendable (any RarogTransporting) async throws -> T
  ) async -> Result<T, TransportError>? {
    let login = state.turnControl.login
    let transport = transport
    let request = Task { () async -> Result<T, TransportError> in
      do {
        return .success(try await work(transport))
      } catch let error as TransportError {
        return .failure(error)
      } catch {
        return .failure(.invalidResponse(String(describing: error)))
      }
    }
    let id = UUID()
    turnRequests.cancels[id] = { request.cancel() }
    let result = await withTaskCancellationHandler { await request.value } onCancel: { request.cancel() }
    turnRequests.cancels[id] = nil
    guard login == state.turnControl.login, state.auth == .loggedIn else { return nil }
    return result
  }

  /// Wylogowanie: każde żądanie obszaru w drodze jest anulowane.
  func cancelTurnRequests() {
    let cancels = turnRequests.cancels.values
    turnRequests.cancels.removeAll()
    for cancel in cancels { cancel() }
  }
}
