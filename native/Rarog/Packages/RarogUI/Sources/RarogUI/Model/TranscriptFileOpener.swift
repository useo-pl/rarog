import Foundation
import RarogContract
import RarogCore
import RarogTransport

// The open of one path tapped in the transcript. The candidate (``TranscriptFilePath``) is resolved against the
// session's file index, which the opener asks for itself: the tree store's index exists only while the Files panel
// stands. The opener keeps the last index it got with its time and asks again only when it has none, or when a miss
// meets an index older than the refresh gap (a file the agent just wrote). One load runs at a time: a tap that finds
// it in flight waits for it, and a newer tap or `cancel()` ends only the tap, not the load, whose answer the next tap
// uses. A resolved path goes to a
// ``FilePreviewModel`` with the index's limit, so the fetch, the copy, the bubbles and the presentation are the Files
// tree's own. Only the newest tap counts; a tap whose open is still pending after ``pendingLimit`` ends without a
// trace on screen, because by then the person has moved on. A miss shows nothing (inline code is often a symbol, not
// a file) and writes a trace line with the reason, never the path, once per reason: the app shares one trace budget.
// The pointer's hover asks the same opener whether a run names a file (`hover(_:onIndex:)`): it answers from the kept
// index at once, never refreshes it and never traces, because the pointer crosses many runs; without an index it
// starts or joins the one load. Logic without UIKit, tested on macOS.
// Owner: transcript.

@MainActor
final class TranscriptFileOpener {
  /// The session's file index (`RarogStore.sessionFileIndex`).
  typealias Index = () async -> SessionFilesOutcome<FileIndex>
  /// One file of the session with the index's limit (`RarogStore.fetchSessionFile`).
  typealias Fetch = (_ path: String, _ maxBytes: Int) async -> SessionFilesOutcome<SessionFileFetch>

  /// Why a tap opened nothing.
  enum Miss: String, Sendable, Equatable, CaseIterable {
    /// No index path is the candidate or ends with it.
    case notInIndex = "not in the index"
    /// More than one index path ends with the candidate.
    case ambiguous = "ambiguous name"
    /// Not an exact path of an index a server ceiling cut, where no suffix is proven unique.
    case truncatedIndex = "suffix in a truncated index"
    /// No index: no route, the request failed, or the login ended.
    case indexUnavailable = "index unavailable"
  }

  /// How long after the tap an open may still show.
  static let pendingLimit: Duration = .seconds(5)

  /// "transcript file: not opened, ambiguous name".
  static func missLine(_ miss: Miss) -> String {
    "transcript file: not opened, \(miss.rawValue)"
  }

  private let index: Index
  private let fetch: Fetch
  private let present: FilePreviewModel.Present
  private let notice: FilePreviewModel.Notice
  private let trace: (String) -> Void
  private let refreshGap: Duration
  private let limit: Duration
  private let now: () -> ContinuousClock.Instant

  /// The last index got, with the time it arrived.
  private var kept: (index: FileSearchIndex, at: ContinuousClock.Instant)?
  /// Grows with every tap and with ``cancel()``: a result of an older tap is not this tap's.
  private var generation = 0
  private var task: Task<Void, Never>?
  /// The preview of the newest resolved tap.
  private var preview: FilePreviewModel?
  /// The index load in flight; its result is the newest index, or `nil` when none came.
  private var load: Task<FileSearchIndex?, Never>?
  /// The miss reasons already traced.
  private var traced: Set<Miss> = []
  /// When the last index load ended without an index; the hover does not ask again before the refresh gap.
  private var failedAt: ContinuousClock.Instant?
  /// The hover's wait for the load in flight, and the newest hover's callback for its end.
  private var hoverWait: Task<Void, Never>?
  private var hoverArrival: (@MainActor () -> Void)?

  init(
    index: @escaping Index, fetch: @escaping Fetch, present: @escaping FilePreviewModel.Present,
    notice: @escaping FilePreviewModel.Notice, trace: @escaping (String) -> Void,
    refreshGap: Duration = CoreTiming.production.fileIndexRefreshGap,
    pendingLimit: Duration = TranscriptFileOpener.pendingLimit,
    now: @escaping () -> ContinuousClock.Instant = { ContinuousClock.now }
  ) {
    self.index = index
    self.fetch = fetch
    self.present = present
    self.notice = notice
    self.trace = trace
    self.refreshGap = refreshGap
    limit = pendingLimit
    self.now = now
  }

  /// A tap on a candidate. The newest call wins; an older one in flight ends silently.
  func open(candidate: String) {
    stop()
    let mine = generation
    let tapped = now()
    task = Task { [weak self] in
      await self?.run(candidate, generation: mine, tapped: tapped)
    }
  }

  /// The screen leaves the session or the window, or a new touch began: the pending open ends, and a copy that still
  /// arrives is deleted.
  func cancel() {
    stop()
  }

  /// What a hovered candidate names.
  enum Hover: Sendable, Equatable {
    /// The index path the candidate resolves to.
    case file(String)
    /// No file: a miss in the kept index, or no index since a load failed within the refresh gap.
    case none
    /// No index yet: the load runs, and `onIndex` of the newest hover is called when it ends.
    case unknown
  }

  /// The hover's question, answered from the kept index without refreshing it, tracing or touching a tap's open.
  /// Without an index it starts the load, or joins the one in flight, and calls `onIndex` of the newest such hover
  /// once that load ends, with or without an index.
  func hover(_ candidate: String, onIndex: @escaping @MainActor () -> Void) -> Hover {
    if let kept {
      if case let .found(path) = TranscriptFilePath.match(candidate, in: kept.index) { return .file(path) }
      return .none
    }
    if let failedAt, now() - failedAt < refreshGap { return .none }
    hoverArrival = onIndex
    if hoverWait == nil {
      hoverWait = Task { [weak self] in
        _ = await self?.loadIndex()
        guard let self else { return }
        self.hoverWait = nil
        let arrival = self.hoverArrival
        self.hoverArrival = nil
        arrival?()
      }
    }
    return .unknown
  }

  private func stop() {
    generation += 1
    task?.cancel()
    task = nil
    preview?.cancel()
    preview = nil
  }

  private func run(_ candidate: String, generation mine: Int, tapped: ContinuousClock.Instant) async {
    guard mine == generation else { return }
    if let kept {
      let match = TranscriptFilePath.match(candidate, in: kept.index)
      if case let .found(path) = match {
        return show(path, maxBytes: kept.index.maxBytes, generation: mine, tapped: tapped)
      }
      guard now() - kept.at >= refreshGap else { return finish(Self.miss(match), generation: mine) }
    }
    let fresh = await loadIndex()
    guard mine == generation, !expired(tapped) else { return }
    guard let fresh else { return finish(.indexUnavailable, generation: mine) }
    let match = TranscriptFilePath.match(candidate, in: fresh)
    if case let .found(path) = match { return show(path, maxBytes: fresh.maxBytes, generation: mine, tapped: tapped) }
    finish(Self.miss(match), generation: mine)
  }

  /// The load in flight, or a new one. It is not the tap's child, so a tap's end does not cancel it, and its index is
  /// kept even when every tap that waited for it has ended.
  private func loadIndex() async -> FileSearchIndex? {
    if let load { return await load.value }
    let started = Task { [weak self, index] () -> FileSearchIndex? in
      let outcome = await index()
      guard let self else { return nil }
      self.load = nil
      guard case let .loaded(fileIndex) = outcome else {
        self.failedAt = self.now()
        return nil
      }
      let built = FileSearchIndex(fileIndex)
      self.kept = (built, self.now())
      self.failedAt = nil
      return built
    }
    load = started
    return await started.value
  }

  private static func miss(_ match: TranscriptFilePath.Match) -> Miss {
    switch match {
    case .found, .notFound: .notInIndex
    case .ambiguous: .ambiguous
    case .truncated: .truncatedIndex
    }
  }

  /// The resolved path goes to the preview of this tap; past the pending limit its copy is refused (and so deleted)
  /// and its bubble dropped.
  private func show(_ path: String, maxBytes: Int, generation mine: Int, tapped: ContinuousClock.Instant) {
    task = nil
    let model = FilePreviewModel(
      fetch: { [fetch] path in await fetch(path, maxBytes) },
      present: { [weak self] copy in
        guard let self, !self.expired(tapped) else { return false }
        return self.present(copy)
      },
      notice: { [weak self] text in
        guard let self, !self.expired(tapped) else { return }
        self.notice(text)
      })
    preview = model
    model.open(path)
  }

  private func finish(_ miss: Miss, generation mine: Int) {
    guard mine == generation else { return }
    task = nil
    if traced.insert(miss).inserted { trace(Self.missLine(miss)) }
  }

  private func expired(_ tapped: ContinuousClock.Instant) -> Bool {
    now() - tapped > limit
  }
}
