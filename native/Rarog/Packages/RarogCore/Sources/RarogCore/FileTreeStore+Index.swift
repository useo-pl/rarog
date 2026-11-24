import Foundation
import RarogContract

// The file index of the search in the Files section: one `GET …/files/index` per session at a time, asked when a
// query starts and the index is missing, invalidated or old, and again after an invalidation while a query stands,
// no sooner than ``CoreTiming/fileIndexRefreshGap`` after the previous request. Owner: session files (native app).

/// What the app has of a session's file index (RarogUI maps it to its search state).
public enum FileIndexState: Sendable, Equatable {
  /// No index for this session: the server lacks `file-index`, or the session has the fallback source.
  case unsupported
  /// The server has the index, but nothing was asked yet (no query since the panel opened this session).
  case notLoaded
  /// A request is on its way; `previous` = the index it replaces.
  case loading(previous: FileIndex?)
  case ready(FileIndex)
  /// The last request failed; `previous` = an older index.
  case failed(previous: FileIndex?)
}

extension FileTreeStore {
  /// One session's index.
  struct SessionIndex {
    var index: FileIndex?
    var loading = false
    var failed = false
    /// Invalidated since `index` was asked: the next query asks again.
    var stale = false
    /// When the request that brought `index` started.
    var indexAt: ContinuousClock.Instant?
    /// When the latest answered request started (an index or a failure): the start of the gap.
    var requestedAt: ContinuousClock.Instant?
  }

  /// The index request of the open session; a session change or a logout replaces it with a new generation.
  struct IndexRuntime {
    var generation = 0
    var task: Task<Void, Never>?
    var session: String?
    var startedAt: ContinuousClock.Instant?
    /// An invalidation came while the request was in flight: its answer may be old.
    var again = false
    /// The request an invalidation deferred to the end of the gap.
    var scheduled: Task<Void, Never>?
  }

  // MARK: - Reading

  /// The index state the search of `sessionId` reads.
  public func fileIndex(_ sessionId: String) -> FileIndexState {
    guard indexSupported(sessionId) else { return .unsupported }
    let entry = indexes[sessionId] ?? SessionIndex()
    if entry.loading { return .loading(previous: entry.index) }
    if entry.failed { return .failed(previous: entry.index) }
    if let index = entry.index { return .ready(index) }
    return .notLoaded
  }

  // MARK: - Inputs from the screen

  /// The search field of `sessionId` started (`true`) or stopped (`false`) holding a query that searches the index
  /// (the Files mode; Changed only does not search it). A start asks for the index at once when there is none, it is
  /// invalidated, it failed, or it is older than the gap; a repeated report changes nothing. The panel leaving the
  /// session forgets the report, so the screen reports on every appearance, also `false`.
  public func setSearchActive(_ active: Bool, in sessionId: String) {
    guard active else {
      indexQueries.remove(sessionId)
      return
    }
    guard indexQueries.insert(sessionId).inserted, canRequestIndex(sessionId) else { return }
    let entry = indexes[sessionId] ?? SessionIndex()
    let old = entry.indexAt.map { ContinuousClock.now - $0 >= indexGap } ?? true
    if entry.index == nil || entry.stale || entry.failed || old { requestIndex(sessionId, gated: false) }
  }

  /// Retry after a failure: asks now, unless a request is already in flight.
  public func reloadFileIndex(_ sessionId: String) {
    guard canRequestIndex(sessionId) else { return }
    requestIndex(sessionId, gated: false)
  }

  // MARK: - Inputs the store wires itself

  /// The end of a turn, the panel opening or the server starting to announce `file-index`: the index is old. With a
  /// query standing it is asked again, no sooner than the gap after the previous request.
  func invalidateIndex(_ sessionId: String) {
    if indexes[sessionId] != nil { indexes[sessionId]?.stale = true }
    if indexRuntime.task != nil, indexRuntime.session == sessionId {
      indexRuntime.again = true
      return
    }
    guard indexQueries.contains(sessionId), canRequestIndex(sessionId) else { return }
    requestIndex(sessionId, gated: true)
  }

  /// The return to the foreground: every index is old; the open session's is asked again by the same rule.
  func invalidateIndexes() {
    for id in indexes.keys { indexes[id]?.stale = true }
    if let open = openSessionId { invalidateIndex(open) }
  }

  /// The panel closed: a deferred request does not go out; one in flight still lands.
  func cancelScheduledIndex() {
    indexRuntime.scheduled?.cancel()
    indexRuntime.scheduled = nil
  }

  /// A session change, a session gone or a logout: the request in flight is cancelled and its answer dropped.
  func cancelIndexRequest() {
    indexRuntime.task?.cancel()
    indexRuntime.scheduled?.cancel()
    if let session = indexRuntime.session, indexes[session] != nil {
      indexes[session]?.loading = false
      indexes[session]?.stale = true
    }
    indexRuntime = IndexRuntime(generation: indexRuntime.generation + 1)
  }

  // MARK: - Requests

  private func indexSupported(_ sessionId: String) -> Bool {
    owner?.state.fileIndexAvailable == true && source(sessionId) == .files
  }

  private func canRequestIndex(_ sessionId: String) -> Bool {
    canRequest(sessionId) && owner?.state.fileIndexAvailable == true
  }

  /// `gated` = an invalidation: not sooner than the gap after the previous answered request, deferred to its end.
  private func requestIndex(_ sessionId: String, gated: Bool) {
    guard indexRuntime.task == nil else { return }
    if gated, let last = indexes[sessionId]?.requestedAt {
      let since = ContinuousClock.now - last
      if since < indexGap {
        scheduleIndex(sessionId, after: indexGap - since)
        return
      }
    }
    startIndex(sessionId)
  }

  private func scheduleIndex(_ sessionId: String, after wait: Duration) {
    guard indexRuntime.scheduled == nil else { return }
    let generation = indexRuntime.generation
    indexRuntime.scheduled = Task { [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled, let self, generation == self.indexRuntime.generation else { return }
      self.indexRuntime.scheduled = nil
      guard self.indexQueries.contains(sessionId), self.canRequestIndex(sessionId) else { return }
      self.requestIndex(sessionId, gated: true)
    }
  }

  private func startIndex(_ sessionId: String) {
    guard let owner else { return }
    cancelScheduledIndex()
    let generation = indexRuntime.generation
    indexRuntime.session = sessionId
    indexRuntime.startedAt = .now
    indexRuntime.again = false
    indexes[sessionId, default: SessionIndex()].loading = true
    indexRuntime.task = Task { [weak self, weak owner] in
      guard let owner else { return }
      let outcome = await owner.sessionFileIndex(sessionId)
      self?.finishIndex(outcome, sessionId: sessionId, generation: generation)
    }
  }

  private func finishIndex(_ outcome: SessionFilesOutcome<FileIndex>, sessionId: String, generation: Int) {
    guard generation == indexRuntime.generation else { return }
    let startedAt = indexRuntime.startedAt
    let again = indexRuntime.again
    indexRuntime.task = nil
    indexRuntime.session = nil
    indexRuntime.startedAt = nil
    indexRuntime.again = false
    var entry = indexes[sessionId] ?? SessionIndex()
    entry.loading = false
    switch outcome {
    case let .loaded(index):
      entry.index = index
      entry.indexAt = startedAt
      entry.requestedAt = startedAt
      entry.failed = false
      entry.stale = again
    case let .refused(refusal) where Self.refusesSession(refusal):
      refuseSession(sessionId)
    case .unavailable, .loggedOut:
      break
    case .refused, .offline, .timedOut, .failed:
      entry.requestedAt = startedAt
      entry.failed = true
    }
    indexes[sessionId] = entry
    if again, indexQueries.contains(sessionId), canRequestIndex(sessionId) { requestIndex(sessionId, gated: true) }
  }
}
