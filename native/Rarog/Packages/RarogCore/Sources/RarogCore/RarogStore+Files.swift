import Foundation
import RarogContract
import RarogTransport

// Session files: the listing of one directory, the index of every file and the fetch of one file to a private copy.
// All are reads, so no gates; they go out only while the server's version answer lists `files`
// (``AppState/filesAvailable``), the index only with `file-index` too (``AppState/fileIndexAvailable``); without
// them the store sends nothing. A logout cancels the requests in flight, and a result or failure of a request
// from an ended login (logout or a new login) is dropped as `.loggedOut`; its copy is deleted first, so a fetched copy
// reaches only a caller of the current login, which then owns it. Owner: session files (native app).

/// The result of a session file route as the store gives it to a screen.
public enum SessionFilesOutcome<Value: Sendable & Equatable>: Sendable, Equatable {
  case loaded(Value)
  /// The server does not announce `files`, or no version answer came yet: no request went out.
  case unavailable
  /// The server or the client gate refused, with the status and the code (`bad-path`, `not-found`, `out-of-scope`,
  /// `codex`).
  case refused(DiffRefusal)
  case offline
  case timedOut
  /// The request was cancelled or the answer is outside the contract.
  case failed
  case loggedOut
}

/// Session file requests in flight (the store field `sessionFileReads`); a logout cancels them.
struct SessionFileReads {
  var inFlight: [UUID: @Sendable () -> Void] = [:]
}

extension RarogStore {
  /// One directory of the session (`dir` empty = the session directory).
  public func sessionFiles(_ sessionId: String, dir: String) async -> SessionFilesOutcome<FileListing> {
    guard state.filesAvailable else { return .unavailable }
    let login = currentLogin
    let transport = transport
    let result = await filesRequest { () async throws(TransportError) -> FileListing in
      try await transport.sessionFiles(sessionId: sessionId, dir: dir)
    }
    return filesOutcome(result, login: login)
  }

  /// Every file of the session directory; sent only while the server lists `file-index` too.
  public func sessionFileIndex(_ sessionId: String) async -> SessionFilesOutcome<FileIndex> {
    guard state.fileIndexAvailable else { return .unavailable }
    let login = currentLogin
    let transport = transport
    let result = await filesRequest { () async throws(TransportError) -> FileIndex in
      try await transport.sessionFileIndex(sessionId: sessionId)
    }
    return filesOutcome(result, login: login)
  }

  /// One file into a private copy; `maxBytes` is the limit from the session's latest listing or its index.
  public func fetchSessionFile(
    _ sessionId: String, path: String, maxBytes: Int
  ) async -> SessionFilesOutcome<SessionFileFetch> {
    guard state.filesAvailable else { return .unavailable }
    let login = currentLogin
    let transport = transport
    let result = await filesRequest { () async throws(TransportError) -> SessionFileFetch in
      try await transport.fetchSessionFile(sessionId: sessionId, path: path, maxBytes: maxBytes)
    }
    let outcome = filesOutcome(result, login: login)
    // A copy that is not handed over has no owner: it goes now.
    if case .loggedOut = outcome, case let .success(.saved(copy)) = result {
      try? FileManager.default.removeItem(at: copy)
    }
    return outcome
  }

  /// Logout (`retire`): the requests in flight are cancelled; their late results are dropped by the login number.
  func forgetSessionFileReads() {
    for cancel in sessionFileReads.inFlight.values { cancel() }
    sessionFileReads.inFlight = [:]
  }

  /// One request as a task the logout can cancel; the caller's cancellation cancels it too.
  private func filesRequest<Value: Sendable>(
    _ work: @escaping @Sendable () async throws(TransportError) -> Value
  ) async -> Result<Value, TransportError> {
    let request = Task<Result<Value, TransportError>, Never> {
      do throws(TransportError) {
        return .success(try await work())
      } catch {
        return .failure(error)
      }
    }
    let id = UUID()
    sessionFileReads.inFlight[id] = { request.cancel() }
    let result = await withTaskCancellationHandler { await request.value } onCancel: { request.cancel() }
    sessionFileReads.inFlight[id] = nil
    return result
  }

  /// `login` = the login before the request: a result or a failure from an ended login is `.loggedOut`, and a late
  /// 401 does not log out a newer login.
  private func filesOutcome<Value>(
    _ result: Result<Value, TransportError>, login: Int
  ) -> SessionFilesOutcome<Value> {
    guard isCurrentLogin(login), state.auth == .loggedIn else { return .loggedOut }
    let error: TransportError
    switch result {
    case let .success(value): return .loaded(value)
    case let .failure(failure): error = failure
    }
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
}
