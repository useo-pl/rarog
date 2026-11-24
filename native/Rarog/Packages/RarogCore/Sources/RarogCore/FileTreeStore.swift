import Foundation
import Observation
import RarogContract

// The file tree of the session in the right panel: listings per session and directory, the change list, the hand
// toggles, the refresh queue, and the file index of the search (its policy: `FileTreeStore+Index.swift`). Not a
// field of `AppState`: listings of up to a thousand entries do not belong in the value the reducer copies on every
// frame. Owner: session files (native app).

/// The file tree state of the app's sessions and the requests of the session whose panel is open.
///
/// Rules:
/// - a directory is listed only when its parent's loaded listing shows it as a directory and it is open
///   (``FileTreeRules/isExpanded(_:toggles:changed:)``); a directory known only from the change list (a deleted
///   one, one under a hidden directory) is never asked for, because the server answers 404 for it;
/// - at most ``maxInFlight`` requests at once, the change list included; a request of the same directory never
///   runs twice at once, and a refresh that finds it in flight asks it once more after the answer;
/// - refresh triggers fold into passes at least ``CoreTiming/fileTreeRefreshGap`` apart; triggers in the same turn of
///   the main actor are one pass;
/// - an answer that comes after the panel's session changed, after `reset` (logout, another server) or from an
///   ended login is dropped;
/// - a 404 `not-found` of a listing = the directory vanished: its listings go, its entry leaves the parent's rows,
///   the rest stays; a 400 `codex` or `out-of-scope` turns the session to ``FileTreeSource/fallback``.
@MainActor
@Observable
public final class FileTreeStore {
  /// Requests of one tree at once.
  public static let maxInFlight = 4
  /// Sessions whose listings and change list stay in memory: the open one and the ones opened just before it.
  public static let retainedSessions = 3

  struct SessionTree {
    var listings: [String: FileListing] = [:]
    var diff: DiffFileList?
    var gone: Set<String> = []
    var maxBytes: Int?
    /// The server refused the routes for this session (`codex`, `out-of-scope`).
    var refused = false
  }

  enum Job: Hashable {
    case diff
    case listing(String)
  }

  private struct Runtime {
    var generation = 0
    var queue: [Job] = []
    var inFlight: [Job: Task<Void, Never>] = [:]
    /// Jobs a refresh found in flight: asked once more after their answer.
    var again: Set<Job> = []
    /// Jobs that failed since the last pass: not asked again before the next one.
    var failed: Set<Job> = []
    /// Jobs asked since the last pass started: a directory that becomes reachable and open later in the pass (a new
    /// change list opens it) is asked too, even with a listing in memory, unless it is here.
    var refreshed: Set<Job> = []
    var lastPass: ContinuousClock.Instant?
    var scheduled: Task<Void, Never>?
    /// The scheduled pass runs on the next turn of the main actor, without waiting for the gap.
    var imminent = false
    var refreshWanted = false
  }

  /// The heavy data, for ``retainedSessions`` sessions at most.
  private var trees: [String: SessionTree] = [:]
  /// The file index per session, kept for the same sessions as ``trees``.
  var indexes: [String: SessionIndex] = [:]
  /// Sessions whose search field holds a query that searches the index, as the screen reported it; a session gone
  /// from the list and `reset` forget it, so the screen reports its query again when the panel appears.
  @ObservationIgnored var indexQueries: Set<String> = []
  @ObservationIgnored var indexRuntime = IndexRuntime()
  @ObservationIgnored let indexGap: Duration
  /// Hand toggles per session, kept apart: dropping a session's listings keeps its person's choices. They go with
  /// the session from the server's list.
  private var toggles: [String: [String: Bool]] = [:]
  /// Sessions by the last opening, the newest first.
  @ObservationIgnored private var recent: [String] = []
  /// The session whose tree the panel shows (also after the panel closes, until another one opens).
  public private(set) var openSessionId: String?
  /// The panel is on screen: only then do triggers ask the server.
  public private(set) var panelOpen = false

  @ObservationIgnored private var runtime = Runtime()
  @ObservationIgnored let refreshGap: Duration
  /// The store whose routes and state the tree uses; set once by the store's initializer.
  @ObservationIgnored weak var owner: RarogStore?

  init(refreshGap: Duration, indexGap: Duration) {
    self.refreshGap = refreshGap
    self.indexGap = indexGap
  }

  // MARK: - Reading

  /// What the screen builds the session's tree from.
  public func snapshot(_ sessionId: String) -> FileTreeSnapshot {
    let tree = trees[sessionId] ?? SessionTree()
    let toggles = self.toggles[sessionId] ?? [:]
    guard source(sessionId) == .files else { return FileTreeSnapshot(source: .fallback, toggles: toggles) }
    return FileTreeSnapshot(source: .files, listings: tree.listings, diff: tree.diff, toggles: toggles, gone: tree.gone)
  }

  /// The largest file the server sends for this session, from its latest listing, else from its file index; `nil` =
  /// neither came yet.
  public func maxBytes(_ sessionId: String) -> Int? {
    trees[sessionId]?.maxBytes ?? indexes[sessionId]?.index?.maxBytes
  }

  public func source(_ sessionId: String) -> FileTreeSource {
    guard let state = owner?.state, state.filesAvailable, let session = state.sessions[sessionId],
      session.engine != .codex, session.outOfScope != true, trees[sessionId]?.refused != true
    else { return .fallback }
    return .files
  }

  // MARK: - Inputs from the screen

  /// The panel shows the tree of `sessionId`: a refresh, and its file index is invalidated. Another session than
  /// before drops the requests of the previous one and their late answers, and the previous one's search query: its
  /// screen reports the query again on appearing, and a mode changed meanwhile must not leave it searching the index.
  public func panelOpened(_ sessionId: String) {
    if sessionId != openSessionId {
      cancelRequests()
      if let left = openSessionId { indexQueries.remove(left) }
      openSessionId = sessionId
    }
    recent.removeAll { $0 == sessionId }
    recent.insert(sessionId, at: 0)
    for old in recent.dropFirst(Self.retainedSessions) {
      if trees[old] != nil { trees[old] = nil }
      if indexes[old] != nil { indexes[old] = nil }
    }
    recent = Array(recent.prefix(Self.retainedSessions))
    panelOpen = true
    requestRefresh()
    invalidateIndex(sessionId)
  }

  /// The panel left the screen: no new requests; the ones in flight still land in the tree.
  public func panelClosed() {
    panelOpen = false
    runtime.queue = []
    runtime.again = []
    runtime.refreshWanted = false
    runtime.scheduled?.cancel()
    runtime.scheduled = nil
    runtime.imminent = false
    cancelScheduledIndex()
  }

  /// A person opened or closed a directory; the choice stays for this session. Opening lists the directory: at once
  /// when it has no listing yet, as a refresh of it when it has one; a pass about to run carries it instead.
  public func setExpanded(_ dir: String, _ expanded: Bool, in sessionId: String) {
    toggles[sessionId, default: [:]][dir] = expanded
    guard expanded, canRequest(sessionId) else { return }
    // Opening by hand asks again after a failure, without waiting for the next pass.
    runtime.failed.remove(.listing(dir))
    guard !runtime.imminent else { return }
    if trees[sessionId]?.listings[dir] != nil {
      enqueue(.listing(dir), first: true)
      pump()
    } else {
      loadMissing()
    }
  }

  // MARK: - Inputs the store wires itself

  /// The app came back to the foreground, a new `git-status` frame or the end of a turn of the open session.
  func requestRefresh() {
    guard let sessionId = openSessionId, canRequest(sessionId) else { return }
    runtime.refreshWanted = true
    schedulePass()
  }

  /// Logout or another server: everything goes, and answers in flight are dropped.
  func reset() {
    cancelRequests()
    trees = [:]
    indexes = [:]
    indexQueries = []
    toggles = [:]
    recent = []
    openSessionId = nil
    panelOpen = false
  }

  /// Sessions the server's list no longer has lose their tree, their index, their query and their hand toggles;
  /// requests of the open one stop.
  func forgetSessions(notIn sessions: [String: SessionSummary]) {
    guard !trees.isEmpty || !toggles.isEmpty || !indexes.isEmpty || !indexQueries.isEmpty else { return }
    let known = Set(trees.keys).union(toggles.keys).union(indexes.keys).union(indexQueries)
    let gone = known.filter { sessions[$0] == nil }
    guard !gone.isEmpty else { return }
    for id in gone {
      trees[id] = nil
      indexes[id] = nil
      toggles[id] = nil
    }
    indexQueries.subtract(gone)
    recent.removeAll { gone.contains($0) }
    if let open = openSessionId, gone.contains(open) { cancelRequests() }
  }

  // MARK: - Queue

  func canRequest(_ sessionId: String) -> Bool {
    panelOpen && sessionId == openSessionId && source(sessionId) == .files
  }

  private func cancelRequests() {
    cancelIndexRequest()
    for task in runtime.inFlight.values { task.cancel() }
    runtime.scheduled?.cancel()
    runtime = Runtime(generation: runtime.generation + 1)
  }

  private func schedulePass() {
    guard runtime.scheduled == nil else { return }
    let generation = runtime.generation
    var wait = Duration.zero
    if let last = runtime.lastPass {
      let since = ContinuousClock.now - last
      if since < refreshGap { wait = refreshGap - since }
    }
    runtime.imminent = wait == .zero
    runtime.scheduled = Task { [weak self] in
      if wait > .zero { try? await Task.sleep(for: wait) }
      guard !Task.isCancelled else { return }
      self?.runPass(generation: generation)
    }
  }

  private func runPass(generation: Int) {
    guard generation == runtime.generation else { return }
    runtime.scheduled = nil
    runtime.imminent = false
    guard runtime.refreshWanted, let sessionId = openSessionId, canRequest(sessionId) else { return }
    runtime.refreshWanted = false
    runtime.lastPass = .now
    runtime.failed = []
    runtime.refreshed = []
    for job in wantedJobs(sessionId, includeGoneRoot: true) { enqueue(job, first: false) }
    pump()
  }

  /// The change list and every open directory reachable through loaded listings, the session directory first.
  private func wantedJobs(_ sessionId: String, includeGoneRoot: Bool) -> [Job] {
    let tree = trees[sessionId] ?? SessionTree()
    let changed = FileTreeRules.changedDirectories(tree.diff?.files.map(\.path) ?? [])
    let toggles = self.toggles[sessionId] ?? [:]
    var dirs: [String] = includeGoneRoot || !tree.gone.contains("") ? [""] : []
    var stack = [""]
    while let dir = stack.popLast() {
      guard !tree.gone.contains(dir), let listing = tree.listings[dir] else { continue }
      for entry in listing.entries where entry.kind == .dir {
        let path = FileTreeRules.join(dir, entry.name)
        guard !tree.gone.contains(path),
          FileTreeRules.isExpanded(path, toggles: toggles, changed: changed)
        else { continue }
        dirs.append(path)
        stack.append(path)
      }
    }
    return [.diff] + dirs.map(Job.listing)
  }

  /// Jobs the tree lacks or the current pass has not asked yet: a directory just opened, one a new change list (or
  /// a new listing of its parent) made reachable and open.
  private func loadMissing() {
    guard let sessionId = openSessionId, canRequest(sessionId) else { return }
    let tree = trees[sessionId] ?? SessionTree()
    for job in wantedJobs(sessionId, includeGoneRoot: false)
    where !runtime.failed.contains(job) && runtime.inFlight[job] == nil {
      let missing: Bool =
        switch job {
        case .diff: tree.diff == nil
        case let .listing(dir): tree.listings[dir] == nil
        }
      if missing || (runtime.lastPass != nil && !runtime.refreshed.contains(job)) { enqueue(job, first: false) }
    }
    pump()
  }

  private func enqueue(_ job: Job, first: Bool) {
    runtime.refreshed.insert(job)
    if runtime.inFlight[job] != nil {
      runtime.again.insert(job)
      return
    }
    if first {
      runtime.queue.removeAll { $0 == job }
      runtime.queue.insert(job, at: 0)
    } else if !runtime.queue.contains(job) {
      runtime.queue.append(job)
    }
  }

  private func pump() {
    guard let sessionId = openSessionId, canRequest(sessionId), let owner else { return }
    while runtime.inFlight.count < Self.maxInFlight, !runtime.queue.isEmpty {
      let job = runtime.queue.removeFirst()
      guard runtime.inFlight[job] == nil else { continue }
      let generation = runtime.generation
      runtime.inFlight[job] = Task { [weak self, weak owner] in
        guard let owner else { return }
        switch job {
        case .diff:
          let outcome = await owner.sessionDiffFiles(sessionId)
          self?.finish(job, generation: generation) { $0.apply(diff: outcome, sessionId: sessionId) }
        case let .listing(dir):
          let outcome = await owner.sessionFiles(sessionId, dir: dir)
          self?.finish(job, generation: generation) { $0.apply(listing: outcome, dir: dir, sessionId: sessionId) }
        }
      }
    }
  }

  private func finish(_ job: Job, generation: Int, apply: (FileTreeStore) -> Void) {
    guard generation == runtime.generation else { return }
    runtime.inFlight[job] = nil
    apply(self)
    if runtime.again.remove(job) != nil, canRequest(openSessionId ?? "") { enqueue(job, first: false) }
    loadMissing()
    pump()
  }

  // MARK: - Answers

  private func apply(listing outcome: SessionFilesOutcome<FileListing>, dir: String, sessionId: String) {
    switch outcome {
    case let .loaded(listing):
      var tree = trees[sessionId] ?? SessionTree()
      tree.listings[dir] = listing
      tree.maxBytes = listing.maxBytes
      // A fresh listing is the truth about the directory and its direct children.
      tree.gone = tree.gone.filter { $0 != dir && FileTreeRules.parent(of: $0) != dir }
      trees[sessionId] = tree
    case let .refused(refusal) where refusal.status == 404 && refusal.code == "not-found":
      var tree = trees[sessionId] ?? SessionTree()
      tree.listings = tree.listings.filter { $0.key != dir && !FileTreeRules.isInside($0.key, dir) }
      tree.gone.insert(dir)
      trees[sessionId] = tree
      runtime.queue.removeAll {
        if case let .listing(queued) = $0 { return queued == dir || FileTreeRules.isInside(queued, dir) }
        return false
      }
    case let .refused(refusal) where Self.refusesSession(refusal):
      refuseSession(sessionId)
    case .unavailable, .loggedOut:
      break
    case .refused, .offline, .timedOut, .failed:
      runtime.failed.insert(.listing(dir))
    }
  }

  private func apply(diff outcome: DiffFetchOutcome<DiffFileList>, sessionId: String) {
    switch outcome {
    case let .loaded(list):
      trees[sessionId, default: SessionTree()].diff = list
    case let .refused(refusal) where Self.refusesSession(refusal):
      refuseSession(sessionId)
    case .loggedOut:
      break
    case .refused, .offline, .timedOut, .failed:
      // The listings stay on screen without markers (or with the last ones).
      runtime.failed.insert(.diff)
    }
  }

  /// The server refuses this session's directory as a whole: a Codex entry or a session out of scope.
  static func refusesSession(_ refusal: DiffRefusal) -> Bool {
    refusal.status == 400 && (refusal.code == "codex" || refusal.code == "out-of-scope")
  }

  /// The session turns to the fallback source: nothing more is asked for it.
  func refuseSession(_ sessionId: String) {
    trees[sessionId, default: SessionTree()].refused = true
    runtime.queue = []
  }

  // MARK: - Tests

  /// Nothing in flight, queued or scheduled: the synchronization point of tests.
  var idle: Bool {
    runtime.inFlight.isEmpty && runtime.queue.isEmpty && runtime.scheduled == nil && indexRuntime.task == nil
      && indexRuntime.scheduled == nil
  }
}
