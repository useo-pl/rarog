import Foundation
import RarogContract
import RarogTransport

// Akcje kart: decyzja na karcie zgody, decyzja o dialogu w panelu
// i „Wznów".
// Decyzji NIE kolejkujemy: bez połączenia odmowa od razu. Każde żądanie jest
// anulowane przy wylogowaniu, a jego wynik sprzed wylogowania ginie (`CardRequests`); 401 wylogowuje
// wyłącznie w zalogowaniu, w którym żądanie wyszło (`handleUnauthorized(since:)`).
// Właściciel: karty.
extension RarogStore {
  /// Decyzja na karcie zgody. „Zatwierdź i nie pytaj o …" (`allowAlways`) tylko dla karty, której
  /// serwer podał dosłowną etykietę tej opcji — bez niej opcja eskalująca z telefonu nie wychodzi.
  /// Karta kanału zgód: tylko z niepustą listą `always`, etykieta ekranu nic tu nie znaczy.
  public func decidePermission(sessionId: String, permId: String, decision: PermissionDecision) async -> DecisionOutcome {
    guard let view = state.transcripts[sessionId],
      let card = view.pendingPermissions.first(where: { $0.permId == permId })
    else { return .cardGone }
    // Zwolnienie do terminala ma własną drogę (`releasePermission`); karta kanału w nieznanym stanie nie ma przycisków.
    if decision == .release || card.isUnsupportedHookCard { return .notAllowed }
    guard view.decisions[permId] == nil else { return .alreadyInFlight }
    if decision != .deny, card.canAllow == false { return .notAllowed }
    if decision == .allowAlways, card.isHookChannel ? (card.always ?? []).isEmpty : (card.alwaysLabel ?? "").isEmpty {
      return .notAllowed
    }
    guard state.global == .online else { return .offline }
    dispatch(.decisionStarted(sessionId: sessionId, cardId: permId, choice: decision.rawValue))
    let finish = { (result: DecisionResultKind) in
      self.dispatch(.decisionFinished(sessionId: sessionId, cardId: permId, kind: .permission, result: result))
    }
    let transport = transport
    let body = PermissionDecisionBody(decision: decision)
    let login = currentLogin
    guard let result = await cardRequest(Self.decisionRequestKey(permId), { () async throws(TransportError) in
      try await transport.decidePermission(sessionId: sessionId, permId: permId, body)
    }) else { return .loggedOut }
    switch result {
    case .success:
      finish(.accepted)
      return .accepted
    case let .failure(error):
      switch error {
      case let .refused(refusal):
        finish(.keep)
        return .refusedByClient(message: refusal.message)
      case let .http(failure) where failure.status == 409 && failure.code == "conflict":
        // Konflikt to WYŁĄCZNIE `error: "conflict"`. Inne 409 (`bad-state`: np. dialog, którego
        // serwer nie umie zatwierdzić) zostawiają kartę i oddają zdanie serwera.
        finish(.conflict)
        return .alreadyDecided
      case let .http(failure) where failure.status == 410:
        finish(.gone)
        return .expired
      case let .http(failure) where failure.status == 422 || failure.status == 409:
        finish(.keep)
        return .refused(message: failure.message)
      case .unauthorized:
        finish(.keep)
        handleUnauthorized(since: login)
        return .loggedOut
      default:
        finish(.keep)
        return .failed
      }
    }
  }

  /// Zwolnienie karty kanału zgód do terminala (`release`): hook wychodzi bez wyniku, dialog zostaje przy biurku.
  /// Omija `canAllow` i trwającą zgodę albo odmowę (osobny klucz żądania i osobny wpis w stanie); blokuje je tylko
  /// trwające albo przyjęte zwolnienie tej samej karty (`.alreadyInFlight`, wpis w `releases` zostaje do zdjęcia
  /// karty). O tym, czy w tym stanie wolno, rozstrzyga serwer: 200 przy `pending`
  /// i `sent`, 409 przy odpowiedzi już odebranej, 409 `too-late` przy `unknown`.
  public func releasePermission(sessionId: String, permId: String) async -> ReleaseOutcome {
    guard let view = state.transcripts[sessionId],
      let card = view.pendingPermissions.first(where: { $0.permId == permId })
    else { return .cardGone }
    guard card.isHookChannel, !card.isUnsupportedHookCard else { return .notAllowed }
    let key = Self.releaseRequestKey(permId)
    guard view.releases[permId] == nil, cardRequests.cancel[key] == nil else { return .alreadyInFlight }
    guard state.global == .online else { return .offline }
    dispatch(.releaseStarted(sessionId: sessionId, permId: permId))
    let finish = { (result: DecisionResultKind) in
      self.dispatch(.releaseFinished(sessionId: sessionId, permId: permId, result: result))
    }
    let transport = transport
    let body = PermissionDecisionBody(decision: .release)
    let login = currentLogin
    guard let result = await cardRequest(key, { () async throws(TransportError) in
      try await transport.decidePermission(sessionId: sessionId, permId: permId, body)
    }) else { return .loggedOut }
    switch result {
    case .success:
      finish(.accepted)
      return .accepted
    case let .failure(error):
      switch error {
      case let .refused(refusal):
        finish(.keep)
        return .refusedByClient(message: refusal.message)
      case let .http(failure) where failure.status == 409 && failure.code == "too-late":
        finish(.keep)
        return .tooLate(message: failure.message)
      case let .http(failure) where failure.status == 410:
        finish(.gone)
        return .expired
      case let .http(failure) where failure.status == 422 || failure.status == 409:
        finish(.keep)
        return .refused(message: failure.message)
      case .unauthorized:
        finish(.keep)
        handleUnauthorized(since: login)
        return .loggedOut
      default:
        finish(.keep)
        return .failed
      }
    }
  }

  /// Klucz żądania karty zgody: para (`permId`, rodzaj). Zgoda i odmowa dzielą klucz (pierwsza wygrywa), zwolnienie
  /// ma własny, więc koniec jednego nie zwalnia drugiego.
  static func decisionRequestKey(_ permId: String) -> String { "perm:\(permId)" }
  static func releaseRequestKey(_ permId: String) -> String { "release:\(permId)" }

  /// Decyzja o dialogu stojącym w panelu, którego Rarog nie zna z jsonl (adresem jest sama sesja).
  /// `deny` = Esc do panelu i wolno je zawsze, gdy karta stoi; `allow` wyłącznie dla dialogu
  /// rozpoznanego z zamkniętej listy — i tak rozstrzyga serwer (409 ze zdaniem).
  /// `seen` = podpis dialogu z karty, na której padł gest. Serwer zatwierdza dialog stojący
  /// w chwili żądania (adresem jest sesja), więc `allow` wychodzi WYŁĄCZNIE, gdy stoi dokładnie ten
  /// dialog — podmiana pod tym samym `stateSince` daje `.changed` i nic nie wysyła.
  public func decideDialog(
    sessionId: String, decision: PermissionDecision, seen: HerdrDialogSignature
  ) async -> DialogDecisionOutcome {
    guard let current = state.herdrDialogSignature(for: sessionId) else { return .notShown }
    if decision == .allowAlways || decision == .release { return .notAllowed }
    if decision == .allow, state.dialogAllowId(for: sessionId) == nil { return .notAllowed }
    if decision == .allow, current != seen { return .changed }
    let key = "dialog:\(sessionId)"
    guard cardRequests.cancel[key] == nil else { return .inFlight }
    guard state.global == .online else { return .offline }
    let transport = transport
    let body = PermissionDecisionBody(decision: decision)
    let login = currentLogin
    guard let result = await cardRequest(key, { () async throws(TransportError) in
      try await transport.decideDialog(sessionId: sessionId, body)
    }) else { return .loggedOut }
    switch result {
    case .success:
      return .accepted
    case let .failure(error):
      switch error {
      case let .refused(refusal): return .refused(message: refusal.message)
      case let .http(failure) where failure.status == 410: return .expired
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(message: failure.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline, .timedOut, .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// „Wznów" na karcie sesji bez panelu: nowy panel z tą samą rozmową, pod tym samym identyfikatorem.
  /// Sesja z żywym panelem dostaje odmowę serwera; nowy stan przychodzi strumieniem
  /// listy — odpowiedzi nie nakładamy na stan (prawda jest jedna, ta sama na każdym urządzeniu).
  public func resumeSession(_ sessionId: String) async -> CardActionOutcome {
    guard state.canResume(sessionId) else { return .notAllowed }
    let transport = transport
    return await cardAction("resume:\(sessionId)") { () async throws(TransportError) in
      _ = try await transport.resumeSession(sessionId: sessionId)
    }
  }

  /// Ostrzeżenie o zaufaniu katalogu po założeniu sesji z tego urządzenia. Woła je
  /// zakładanie sesji (`RarogStore+Catalog`), gdy odpowiedź 202 niesie `trustPrompt: true`.
  func noteTrustPrompt(_ sessionId: String) {
    dispatch(.cards(.trustPromptArmed(sessionId: sessionId)))
  }

  /// Wylogowanie: żądania kart w drodze anulowane, wyniki sprzed niego odcięte numerem zalogowania.
  func forgetCardRequests() {
    cardRequests.login += 1
    let pending = cardRequests.cancel.values
    cardRequests.cancel.removeAll()
    for cancel in pending { cancel() }
  }

  // MARK: - Pomocnicze

  private func cardAction(
    _ key: String, _ work: @escaping @Sendable () async throws(TransportError) -> Void
  ) async -> CardActionOutcome {
    guard cardRequests.cancel[key] == nil else { return .inFlight }
    guard state.global == .online else { return .offline }
    let login = currentLogin
    guard let result = await cardRequest(key, work) else { return .loggedOut }
    switch result {
    case .success:
      return .accepted
    case let .failure(error):
      switch error {
      case let .refused(refusal): return .refused(message: refusal.message)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(message: failure.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// Żądanie karty jako osobne zadanie z anulowaniem przy wylogowaniu. `nil` = wynik sprzed
  /// wylogowania (albo anulowany przez nie) — nie ma prawa wrócić na ekran.
  private func cardRequest<T: Sendable>(
    _ key: String, _ work: @escaping @Sendable () async throws(TransportError) -> T
  ) async -> Result<T, TransportError>? {
    let login = cardRequests.login
    let task = Task<Result<T, TransportError>, Never> {
      do throws(TransportError) {
        return .success(try await work())
      } catch {
        return .failure(error)
      }
    }
    cardRequests.cancel[key] = { task.cancel() }
    let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    // Klucz zwalnia tylko żądanie z bieżącego zalogowania — po wylogowaniu wyczyścił go `forgetCardRequests`,
    // a nowe żądanie o tym samym kluczu należy już do nowego logowania.
    guard login == cardRequests.login else { return nil }
    cardRequests.cancel[key] = nil
    guard state.auth == .loggedIn else { return nil }
    return result
  }
}
