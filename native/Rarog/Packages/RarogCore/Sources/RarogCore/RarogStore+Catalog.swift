import Foundation
import RarogContract
import RarogTransport

// Akcje katalogu projektów. Wyniki są typowane, zdania
// składa RarogUI. Właściciel: projekty i zakładki.
extension RarogStore {
  /// Ostatnie projekty z serwera. Lista nie jedzie strumieniem, więc odświeża się na żądanie
  /// widoku (połączenie, pokazanie sekcji), najwyżej co ``CatalogTiming/recentRefresh``.
  public func refreshRecentProjects(force: Bool = false) async {
    guard state.auth == .loggedIn else { return }
    let now = Date()
    if !force, let last = state.catalog.recentAt, now.timeIntervalSince(last) < CatalogTiming.recentRefresh { return }
    // Dławik od chwili wysłania: dwa widoki proszące naraz nie wysyłają dwóch żądań.
    dispatch(.catalog(.recentProjectsRequested(at: now)))
    let login = currentLogin
    do {
      let list = try await transport.recentProjects()
      dispatch(.catalog(.recentProjectsLoaded(list.projects, at: Date())))
    } catch {
      if case .unauthorized = error { handleUnauthorized(since: login) }
    }
  }

  /// „+" w pasku zakładek i Cmd+N: pusta sesja w katalogu z zapamiętanym modelem i effortem. Ultracode tu nie
  /// jedzie nigdy: pamięć urządzenia go nie zna, a każde włączenie to gest w oknie „Nowa sesja”.
  ///
  /// Bramka zakładania jak przy tapnięciu: `canLaunch == false` odmawia od razu ze zdaniem
  /// serwera. Zapamiętany model, którego serwer już nie zna (400 `model-unknown`), nie blokuje
  /// startu: drugie żądanie idzie na modelu domyślnym konta.
  public func createSession(in cwd: String, defaults: NewSessionDefaults) async -> CreateSessionOutcome {
    if state.launchBlocked { return .blocked(state.launchBlockedDetail) }
    let body = CreateSessionBody(cwd: cwd, model: defaults.model, effort: defaults.effort)
    let login = currentLogin
    do {
      let reply = try await createPanel(body, via: transport, login: login)
      // Ostrzeżenie o zaufaniu katalogu w transkrypcie nowej sesji.
      if reply.trustPrompt { noteTrustPrompt(reply.sessionId) }
      return .created(sessionId: reply.sessionId, trustPrompt: reply.trustPrompt)
    } catch {
      return catalogOutcome(error, login: login)
    }
  }

  /// „×" w nagłówku, na liście i drugie Cmd+X: `closePanel: true` (także panel
  /// założony poza Rarogiem). Codex, nieznany silnik i sesja nieobsługiwana nie wysyłają niczego.
  public func closeSession(_ sessionId: String) async -> CloseSessionOutcome {
    if let session = state.sessions[sessionId], !session.canClose { return .notAllowed }
    let login = currentLogin
    do {
      try await transport.closeSession(sessionId: sessionId, CloseSessionBody(closePanel: true))
      return .closed
    } catch {
      switch error {
      case let .refused(refusal): return .refused(refusal.message)
      case let .http(failure): return .refused(failure.message)
      case let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// Oba żądania idą tym samym transportem (`client` z chwili gestu) i tylko w tym samym zalogowaniu: spóźnione 400
  /// serwera A po parowaniu z B nie wysyła ponowienia z katalogiem A do B.
  private func createPanel(
    _ body: CreateSessionBody, via client: any RarogTransporting, login: Int
  ) async throws(TransportError) -> CreateSessionResponse {
    do {
      return try await client.createSession(body)
    } catch {
      guard case let .http(failure) = error, failure.status == 400, failure.code == "model-unknown",
        body.model != nil, isCurrentLogin(login)
      else { throw error }
      return try await client.createSession(CreateSessionBody(cwd: body.cwd))
    }
  }

  /// `login` = numer zalogowania sprzed żądania: spóźnione 401 nie wylogowuje nowego logowania.
  private func catalogOutcome(_ error: TransportError, login: Int) -> CreateSessionOutcome {
    switch error {
    case let .refused(refusal): return .refused(refusal.message)
    case let .http(failure): return .refused(failure.message)
    case let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .offline: return .offline
    case .timedOut: return .timedOut
    case .cancelled, .invalidResponse: return .failed
    }
  }
}
