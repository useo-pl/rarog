import Foundation
import RarogContract
import RarogTransport

// The voice agent at a session: the OpenAI ephemeral key, the Soniox speech key and the question about the
// session. Owner: voice agent. The conversation, audio and screen live in RarogUI (`Session/Voice/Realtime/`); a voice
// send of the message field is the ordinary send of the field (`RarogStore+Send.swift`). The core gives three requests
// with gates, the login rule and refusals typed by code. The mode across sessions adds two reads: the session catalog
// and the last turns of one session (the rule that offers the mode: `Selectors+Companion.swift`), and the pick-up of
// a result the agent read (`POST /api/sessions/<id>/seen` with `by`, `conversation` and `readMark`).
//
// Every result belongs to the login in which the request went out (`currentLogin`): logout, device unpairing
// and a server switch in flight give `.loggedOut`, also on success (a key issued to the old credential does not
// open a conversation), and a late 401 does not log out the new login.

/// Wynik pobrania klucza krótkiego. Zdania składa RarogUI.
public enum CompanionTokenOutcome: Sendable, Equatable {
  case token(CompanionToken)
  /// 404 (starszy serwer, demo) albo 503 `companion-disabled` (flaga albo brak klucza OpenAI na serwerze).
  case disabled(message: String?)
  /// 503 `companion-openai-key`: OpenAI odrzucił klucz serwera (konfiguracja Maca, `rarog voice-agent set-key`).
  case keyRejected(message: String?)
  /// 429 `companion-throttled`: serwer dławi pobieranie kluczy.
  case throttled(message: String?)
  /// 429 `companion-openai-limit`: limit konta OpenAI.
  case openAILimit(message: String?)
  /// Bramka klienta (zgodność wersji) odmówiła, zanim żądanie wyszło.
  case refused(message: String)
  /// 401 albo wylogowanie, odpięcie, zmiana serwera w trakcie żądania.
  case loggedOut
  case cancelled
  /// 502 `companion-openai`, sieć, limit czasu, inne odmowy, odpowiedź spoza kontraktu.
  case unavailable(message: String?)
}

/// Result of fetching the Soniox speech key. RarogUI builds the sentences.
public enum CompanionSpeechTokenOutcome: Sendable, Equatable {
  case token(CompanionSpeechToken)
  /// 404 (older server, demo) or 503 `companion-speech-unconfigured` (flag off, no Soniox key or one outside the EU,
  /// Soniox refused the server's key); the server's sentence says which.
  case disabled(message: String?)
  /// 429 `companion-speech-throttled`: the server throttles speech keys.
  case throttled(message: String?)
  /// The client gate (version compatibility) refused before the request went out.
  case refused(message: String)
  /// 401, or logout, unpairing or a server change during the request.
  case loggedOut
  case cancelled
  /// 502 `companion-speech-upstream`, network, timeout, other refusals, a reply outside the contract.
  case unavailable(message: String?)
}

/// Result of a question about the session (the `ask_session` tool). RarogUI builds the text for the model.
public enum CompanionAskOutcome: Sendable, Equatable {
  case answer(CompanionAnswer)
  /// 429 `companion-limit`: wyczerpany limit subskrypcji Claude.
  case limit(message: String?)
  /// 429 `companion-busy`: inne pytanie o tę sesję (albo dwa na serwer) w toku.
  case busy(message: String?)
  /// 404, 503 `companion-disabled`.
  case disabled(message: String?)
  case refused(message: String)
  case loggedOut
  case cancelled
  /// 503 `companion-cli`, 504 `companion-timeout`, odpowiedź zamknięta bez treści, sieć.
  case failed(code: String?, message: String?)
}

/// Result of reading the voice agent's session catalog (mode across sessions). RarogUI builds the text for the model.
public enum CompanionSessionsOutcome: Sendable, Equatable {
  case sessions([CompanionSessions.Row])
  /// The mode is off or absent: 404 (older server, demo), 503 `companion-disabled` (the voice agent is off) or 503
  /// `companion-sessions-disabled` (the mode across sessions is off). A 404 carries no sentence.
  case disabled(message: String?)
  /// 401, or logout, unpairing or a server change during the request.
  case loggedOut
  case cancelled
  /// Network, timeout, other refusals, a reply outside the contract.
  case failed(code: String?, message: String?)
}

/// Result of reading the last turns of one session (mode across sessions). The turns are kept whole: a later pick-up
/// of the result sends `conversation` and `readMark` back to the server.
public enum CompanionTurnsOutcome: Sendable, Equatable {
  case turns(CompanionTurns)
  /// 404: the session is not in the voice agent's catalog (gone, out of scope, a Codex session), with the server's
  /// sentence. Every 404 lands here, also a server without the route: the error carries no sentence code to tell
  /// them apart, so the caller asks only where ``AppState/companionSessionsOffered(sonioxAllowed:)`` holds.
  case outsideCatalog(message: String?)
  /// 503 `companion-disabled` or `companion-sessions-disabled`.
  case disabled(message: String?)
  case loggedOut
  case cancelled
  /// `count` outside 1…3 (refused before the request), network, timeout, other refusals, a reply outside the
  /// contract.
  case failed(code: String?, message: String?)
}

/// Result of the voice agent's pick-up of a session result it read (mode across sessions). It changes nothing in the
/// app state: the server's session frame brings `seenBy`, and a refused pick-up leaves the session as it is.
public enum CompanionPickUpOutcome: Sendable, Equatable {
  case pickedUp
  /// 409: the result is not the one read (a newer message or state, a dialog, another conversation, or a mark that
  /// names no read).
  case resultChanged
  /// 404: the session is unknown or outside the voice agent's catalog.
  case outsideCatalog
  /// 503 `companion-disabled` or `companion-sessions-disabled`.
  case disabled
  /// The client gate (compatibility, the session gate) refused before the request went out.
  case refused
  /// 401, or logout, unpairing or a server change during the request.
  case loggedOut
  case cancelled
  case timedOut
  /// Network, other refusals, a reply outside the contract.
  case failed
}

/// A failed read of the mode across sessions, before the route names its outcome.
private enum CompanionReadFailure {
  case notFound(message: String?)
  case disabled(message: String?)
  case loggedOut
  case cancelled
  case failed(code: String?, message: String?)
}

extension RarogStore {
  /// Numer zalogowania dla RarogUI: rośnie przy wylogowaniu, odpięciu, zmianie serwera i ponownym zalogowaniu.
  /// Rozmowa głosowa kończy się, gdy się zmieni.
  public var loginEpoch: Int { currentLogin }

  /// `POST /api/companion/token`. Wołający (rozmowa) prosi o klucz przy KAŻDYM otwarciu gniazda, nigdy na zapas.
  public func mintCompanionToken() async -> CompanionTokenOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let result: Result<CompanionToken, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.companionToken())
    } catch {
      result = .failure(error)
    }
    // Wylogowanie, odpięcie albo inny serwer w trakcie: wynik należy do poprzedniego zalogowania.
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(token): return .token(token)
    case let .failure(error): return companionTokenOutcome(error, login: login)
    }
  }

  /// `POST /api/companion/speech-token`. The conversation asks for the key when it starts and again when the key
  /// nears its expiry, never ahead of it. Same login rule as the OpenAI key.
  public func mintCompanionSpeechToken() async -> CompanionSpeechTokenOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let result: Result<CompanionSpeechToken, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.companionSpeechToken())
    } catch {
      result = .failure(error)
    }
    // Logout, unpairing or another server meanwhile: the key belongs to the previous login.
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(token): return .token(token)
    case let .failure(error): return companionSpeechTokenOutcome(error, login: login)
    }
  }

  /// `POST /api/sessions/<id>/companion/ask` z pytaniem (przycięte do sufitu kontraktu) i nowym `clientRequestId`.
  public func askCompanion(sessionId: String, question: String) async -> CompanionAskOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let body = CompanionAskBody(
      question: Self.companionQuestion(question), clientRequestId: UUID().uuidString.lowercased())
    let result: Result<CompanionAnswer, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.companionAsk(sessionId: sessionId, body))
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(answer): return .answer(answer)
    case let .failure(error): return companionAskOutcome(error, login: login)
    }
  }

  /// `GET /api/companion/sessions`: the voice agent's session catalog. The caller reads it again before each tool of
  /// the conversation; the server builds it from memory.
  public func loadCompanionSessions() async -> CompanionSessionsOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let result: Result<CompanionSessions, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.companionSessions())
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(catalog): return .sessions(catalog.sessions)
    case let .failure(error):
      switch companionReadFailure(error, login: login) {
      // A 404 is an older server or demo: the mode is absent, and its sentence ("no such endpoint") says nothing.
      case .notFound: return .disabled(message: nil)
      case let .disabled(message): return .disabled(message: message)
      case .loggedOut: return .loggedOut
      case .cancelled: return .cancelled
      case let .failed(code, message): return .failed(code: code, message: message)
      }
    }
  }

  /// `GET /api/sessions/<id>/companion/turns?count=<count>`: the last `count` (1…3) turns of the session's current
  /// engine conversation.
  public func loadCompanionTurns(sessionId: String, count: Int) async -> CompanionTurnsOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let result: Result<CompanionTurns, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.companionTurns(sessionId: sessionId, count: count))
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(turns): return .turns(turns)
    case let .failure(error):
      switch companionReadFailure(error, login: login) {
      case let .notFound(message): return .outsideCatalog(message: message)
      case let .disabled(message): return .disabled(message: message)
      case .loggedOut: return .loggedOut
      case .cancelled: return .cancelled
      case let .failed(code, message): return .failed(code: code, message: message)
      }
    }
  }

  /// `POST /api/sessions/<id>/seen` with the voice agent's pick-up: `by: voice-agent` and the `conversation` and
  /// `readMark` of the turns read it picks up, as the server sent them. The person's receipt is
  /// ``noteResultViewed(_:)``; this one writes nothing into the app state, also on success.
  public func pickUpCompanionResult(sessionId: String, conversation: String, readMark: String) async
    -> CompanionPickUpOutcome
  {
    guard state.auth == .loggedIn else { return .loggedOut }
    let login = currentLogin
    let pickUp = SeenPickUp(by: .voiceAgent, conversation: conversation, readMark: readMark)
    let result: Result<Void, TransportError>
    do throws(TransportError) {
      try await transport.pickUpResult(sessionId: sessionId, pickUp)
      result = .success(())
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case .success: return .pickedUp
    case let .failure(error): return companionPickUpOutcome(error, login: login)
    }
  }

  private func companionPickUpOutcome(_ error: TransportError, login: Int) -> CompanionPickUpOutcome {
    switch error {
    case let .http(failure) where failure.status == 409: return .resultChanged
    case let .http(failure) where failure.status == 404: return .outsideCatalog
    case let .http(failure)
    where failure.status == 503
      && (failure.code == "companion-disabled" || failure.code == "companion-sessions-disabled"):
      return .disabled
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled: return .cancelled
    case .refused: return .refused
    case .timedOut: return .timedOut
    case .http, .forbidden, .rateLimited, .offline, .invalidResponse: return .failed
    }
  }

  /// A failed read of the mode across sessions by code; the caller names what a 404 means on its route. 401 logs out
  /// the login the request went out in.
  private func companionReadFailure(_ error: TransportError, login: Int) -> CompanionReadFailure {
    switch error {
    case let .http(failure) where failure.status == 404:
      return .notFound(message: failure.message)
    case let .http(failure)
    where failure.status == 503
      && (failure.code == "companion-disabled" || failure.code == "companion-sessions-disabled"):
      return .disabled(message: failure.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled:
      return .cancelled
    case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
      return .failed(code: failure.code, message: failure.message)
    case let .refused(refusal):
      return .failed(code: nil, message: refusal.message)
    case .timedOut:
      return .failed(code: "timeout", message: nil)
    case .offline, .invalidResponse:
      return .failed(code: nil, message: nil)
    }
  }

  /// Sufit pytania w jednostkach UTF-16 (zod liczy `string.length`), bez rozcinania znaku.
  static func companionQuestion(_ question: String) -> String {
    guard question.utf16.count > CompanionAskBody.maxQuestionUnits else { return question }
    var out = ""
    var units = 0
    for character in question {
      let size = String(character).utf16.count
      if units + size > CompanionAskBody.maxQuestionUnits { break }
      out.append(character)
      units += size
    }
    return out
  }

  private func companionTokenOutcome(_ error: TransportError, login: Int) -> CompanionTokenOutcome {
    switch error {
    case let .http(failure) where failure.status == 404:
      return .disabled(message: nil)
    case let .http(failure) where failure.status == 503 && failure.code == "companion-disabled":
      return .disabled(message: failure.message)
    case let .http(failure) where failure.status == 503 && failure.code == "companion-openai-key":
      return .keyRejected(message: failure.message)
    case let .rateLimited(failure) where failure.code == "companion-openai-limit":
      return .openAILimit(message: failure.message)
    case let .rateLimited(failure):
      return .throttled(message: failure.message)
    case let .refused(refusal):
      return .refused(message: refusal.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled:
      return .cancelled
    case let .http(failure), let .forbidden(failure):
      return .unavailable(message: failure.message)
    case .timedOut, .offline, .invalidResponse:
      return .unavailable(message: nil)
    }
  }

  private func companionSpeechTokenOutcome(_ error: TransportError, login: Int) -> CompanionSpeechTokenOutcome {
    switch error {
    case let .http(failure) where failure.status == 404:
      return .disabled(message: nil)
    case let .http(failure) where failure.status == 503 && failure.code == "companion-speech-unconfigured":
      return .disabled(message: failure.message)
    case let .rateLimited(failure):
      return .throttled(message: failure.message)
    case let .refused(refusal):
      return .refused(message: refusal.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled:
      return .cancelled
    case let .http(failure), let .forbidden(failure):
      return .unavailable(message: failure.message)
    case .timedOut, .offline, .invalidResponse:
      return .unavailable(message: nil)
    }
  }

  private func companionAskOutcome(_ error: TransportError, login: Int) -> CompanionAskOutcome {
    switch error {
    case let .rateLimited(failure) where failure.code == "companion-limit":
      return .limit(message: failure.message)
    case let .rateLimited(failure):
      return .busy(message: failure.message)
    case let .http(failure) where failure.status == 404 || failure.code == "companion-disabled":
      return .disabled(message: failure.message)
    case let .refused(refusal):
      return .refused(message: refusal.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled:
      return .cancelled
    case let .http(failure), let .forbidden(failure):
      return .failed(code: failure.code, message: failure.message)
    case .timedOut:
      return .failed(code: "timeout", message: nil)
    case .offline, .invalidResponse:
      return .failed(code: nil, message: nil)
    }
  }
}
