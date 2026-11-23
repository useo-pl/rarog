import Foundation
import RarogContract
import RarogTransport

// Formularz nowej sesji: przeglądarka katalogów, listy rozmów CLI do wznowienia
// i zakładanie panelu z ustawieniami startu. Stan formularza żyje w widoku (prezentacja arkusza),
// rdzeń daje typowane wyniki. Żądania idą przez `tracked` (wylogowanie je anuluje).
// Właściciel: nowa sesja.

/// Wynik odczytu katalogu (`GET /api/fs`).
public enum DirectoryOutcome: Sendable, Equatable {
  case loaded(DirListing)
  /// Odmowa serwera (400: katalog spoza allow-listy albo nie istnieje) — zdanie do pokazania przy polu.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}

/// Wynik listy rozmów do wznowienia (`GET /api/resumable`, `/api/resumable/recent`).
public enum ResumableOutcome: Sendable, Equatable {
  case loaded([ResumableSession])
  /// Każda porażka — status sekcji jest neutralny, obok stoi kompletny formularz.
  case failed
  case loggedOut
}

/// Wynik „Uruchom", „Wznów" i „Rozwidl".
public enum LaunchOutcome: Sendable, Equatable {
  /// 202: panel założony, reszta startu jedzie po SSE — apka od razu wchodzi w sesję „startuje".
  case created(sessionId: String, trustPrompt: Bool)
  /// Zakładanie wyłączone (`canLaunch == false`): zdanie serwera albo `nil`.
  case blocked(String?)
  /// 400 o katalogu (allow-lista, nieistniejąca ścieżka) — zdanie stoi przy polu ścieżki.
  case cwdRefused(String?)
  /// 400 `ultracode-refused`: bramka startu z ultracode odmówiła (Claude Code za stary albo wersja nieznana,
  /// poziom inny niż xhigh). Zdanie serwera o ustawieniach startu, nie o katalogu: pole ścieżki zostaje w spokoju.
  case ultracodeRefused(String?)
  /// Inna odmowa (409 sufit paneli, zapis wyłączony, żywa rozmowa; 429) — zdanie serwera.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut

  /// Kod błędu odmowy bramki startu z ultracode (`ULTRACODE_REFUSED_ERROR` w `shared/src/rest.ts`).
  static let ultracodeRefusedCode = "ultracode-refused"
}

/// Result of New Directory in the browser (`POST /api/fs/mkdir`).
public enum DirectoryCreateOutcome: Sendable, Equatable {
  /// 200: the new directory's row; the browser enters it.
  case created(DirEntry)
  /// 409 `dir-exists`: something already has that name. The transport does not retry, so after a lost reply this
  /// is also what a second attempt gets; the browser shows the sentence and lists the parent again.
  case exists(String?)
  /// Any other refusal (400 name or path, 404, 409 `mkdir-disabled`, 429 `mkdir-busy`, a client gate): the server's
  /// sentence under the name field.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut

  /// Error code of an existing name (`DIR_EXISTS_ERROR` in `shared/src/rest.ts`).
  static let existsCode = "dir-exists"
}

extension RarogStore {
  /// New Directory: `name` (already trimmed by the caller) in the listed directory `parent`. One request, no
  /// retry; the server judges the name.
  public func createDirectory(parent: String, name: String) async -> DirectoryCreateOutcome {
    let login = currentLogin
    let body = MakeDirBody(parent: parent, name: name)
    guard let result = await tracked({ try await $0.makeDirectory(body) }) else { return .loggedOut }
    switch result {
    case let .success(entry): return .created(entry)
    case let .failure(error):
      switch error {
      case let .http(failure) where failure.status == 409 && failure.code == DirectoryCreateOutcome.existsCode:
        return .exists(failure.message)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
      case let .refused(refusal): return .refused(refusal.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// Podkatalogi (`nil` = poziom korzeni). Odczyt bez bramek.
  public func listDirectory(_ path: String?) async -> DirectoryOutcome {
    let login = currentLogin
    guard let result = await tracked({ try await $0.directory(path) }) else { return .loggedOut }
    switch result {
    case let .success(listing): return .loaded(listing)
    case let .failure(error):
      switch error {
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
      case let .refused(refusal): return .refused(refusal.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }

  /// Do 20 rozmów CLI z katalogu (`recent: false`, „Wznów istniejącą") albo 10 najświeższych
  /// zamkniętych (`recent: true`, ekran „Ostatnie sesje").
  public func resumableSessions(cwd: String, recent: Bool = false) async -> ResumableOutcome {
    let login = currentLogin
    let result = await tracked { transport in
      recent ? try await transport.recentResumable(cwd: cwd) : try await transport.resumable(cwd: cwd)
    }
    guard let result else { return .loggedOut }
    switch result {
    case let .success(list): return .loaded(list.sessions)
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return .loggedOut
    case .failure: return .failed
    }
  }

  /// „Uruchom", „Wznów" i „Rozwidl": jeden endpoint (`POST /api/sessions`), różne flagi startu.
  /// Bramka zakładania jak przy „+": `canLaunch == false` odmawia od razu ze zdaniem serwera.
  /// Model spoza listy (400 `model-unknown`) NIE startuje po cichu na innym — człowiek wybrał.
  /// Odmowa bramki ultracode (400 `ultracode-refused`) ma własny wynik: dotyczy ustawień startu, nie katalogu.
  public func launchSession(_ body: CreateSessionBody) async -> LaunchOutcome {
    if state.launchBlocked { return .blocked(state.launchBlockedDetail) }
    let login = currentLogin
    guard let result = await tracked({ try await $0.createSession(body) }) else { return .loggedOut }
    switch result {
    case let .success(reply):
      // Ostrzeżenie o zaufaniu katalogu w transkrypcie nowej sesji, jak przy „+".
      if reply.trustPrompt { noteTrustPrompt(reply.sessionId) }
      return .created(sessionId: reply.sessionId, trustPrompt: reply.trustPrompt)
    case let .failure(error):
      switch error {
      case let .http(failure) where failure.status == 400 && failure.code == LaunchOutcome.ultracodeRefusedCode:
        return .ultracodeRefused(failure.message)
      case let .http(failure) where failure.status == 400 && failure.code != "model-unknown":
        return .cwdRefused(failure.message)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure): return .refused(failure.message)
      case let .refused(refusal): return .refused(refusal.message)
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline: return .offline
      case .timedOut: return .timedOut
      case .cancelled, .invalidResponse: return .failed
      }
    }
  }
}
