import Foundation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import Testing

// The open of a path tapped in the transcript: the session's file index is asked only when the opener has none or a
// miss meets an index older than the refresh gap; a resolved path is fetched with the index's limit and handed to the
// preview the way the Files tree does; the newest tap wins, `cancel()` and a pending open past its limit end silently,
// and a miss shows nothing and writes one trace line without the path. Time is a manual clock. Owner: transcript.

/// The index route: answers in order (the last one repeats) and can hold its answer.
@MainActor
private final class FakeIndex {
  var answers: [SessionFilesOutcome<FileIndex>]
  private(set) var requests = 0
  var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ answers: [SessionFilesOutcome<FileIndex>]) {
    self.answers = answers
  }

  func index() async -> SessionFilesOutcome<FileIndex> {
    let answer = answers[min(requests, answers.count - 1)]
    requests += 1
    if holding { await withCheckedContinuation { held.append($0) } }
    return answer
  }

  var waiting: Int { held.count }

  func release(_ index: Int = 0) {
    held.remove(at: index).resume()
  }
}

@MainActor
private final class ManualClock {
  var now = ContinuousClock.now

  func advance(_ duration: Duration) {
    now += duration
  }
}

@MainActor
private final class TraceLog {
  private(set) var lines: [String] = []

  func write(_ line: String) {
    lines.append(line)
  }
}

@MainActor
@Suite("transcript file opener: index, fetch and the newest tap")
struct TranscriptFileOpenerTests {
  private let gap = Duration.seconds(30)

  private static func loaded(_ paths: [String], maxBytes: Int = 2_000_000) -> SessionFilesOutcome<FileIndex> {
    .loaded(FileIndex(paths: paths, truncated: false, maxBytes: maxBytes))
  }

  private struct Rig {
    let index: FakeIndex
    let fetch: FakeFetch
    let presenter: FakePresenter
    let clock: ManualClock
    let trace: TraceLog
    let opener: TranscriptFileOpener
  }

  private func rig(_ answers: [SessionFilesOutcome<FileIndex>]) -> Rig {
    let index = FakeIndex(answers)
    let fetch = FakeFetch()
    let presenter = FakePresenter()
    let clock = ManualClock()
    let trace = TraceLog()
    let opener = TranscriptFileOpener(
      index: { await index.index() }, fetch: { await fetch.fetch($0, maxBytes: $1) },
      present: { presenter.present($0) }, notice: { presenter.notice($0) }, trace: { trace.write($0) },
      refreshGap: gap, now: { clock.now })
    return Rig(index: index, fetch: fetch, presenter: presenter, clock: clock, trace: trace, opener: opener)
  }

  private func settle(_ until: @MainActor () -> Bool) async {
    for _ in 0..<500 where !until() { await Task.yield() }
  }

  /// Lets every task that could still run do so, for the assertions that nothing happened.
  private func drain() async {
    for _ in 0..<100 { await Task.yield() }
  }

  @Test("no index yet: exactly one index request, then one fetch with the index's limit and a preview")
  func firstTapLoadsIndex() async {
    let rig = rig([Self.loaded(["server/src/files/path-rule.ts"], maxBytes: 777)])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "path-rule.ts")
    await settle { !rig.presenter.shown.isEmpty }
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["server/src/files/path-rule.ts"])
    #expect(rig.fetch.limits == [777])
    #expect(rig.presenter.shown.map(\.title) == ["path-rule.ts"])
    #expect(rig.trace.lines == [])
    rig.presenter.close()
  }

  @Test("a second tap within the gap uses the kept index without asking again")
  func keptIndex() async {
    let rig = rig([Self.loaded(["a.md", "b.md"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { rig.presenter.shown.count == 1 }
    rig.clock.advance(.seconds(5))
    rig.opener.open(candidate: "b.md")
    await settle { rig.presenter.shown.count == 2 }
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["a.md", "b.md"])
    rig.presenter.close()
  }

  @Test("a path missing in a fresh index: no second request, nothing fetched, one trace line without the path")
  func missInFreshIndex() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { rig.presenter.shown.count == 1 }
    rig.clock.advance(.seconds(5))
    rig.opener.open(candidate: "secret-name.md")
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["a.md"])
    #expect(rig.presenter.shown.count == 1 && rig.presenter.notices == [])
    #expect(rig.trace.lines == [TranscriptFileOpener.missLine(.notInIndex)])
    #expect(!rig.trace.lines.joined().contains("secret-name"))
    rig.presenter.close()
  }

  @Test("an ambiguous name traces its own reason")
  func ambiguousTrace() async {
    let rig = rig([Self.loaded(["server/index.ts", "relay/index.ts"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "index.ts")
    await settle { !rig.trace.lines.isEmpty }
    await drain()
    #expect(rig.fetch.paths == [])
    #expect(rig.trace.lines == [TranscriptFileOpener.missLine(.ambiguous)])
  }

  @Test("a path missing in an index older than the gap: one refresh, then the fetch once it is found")
  func missInStaleIndexRefreshes() async {
    let rig = rig([Self.loaded(["a.md"]), Self.loaded(["a.md", "docs/new.md"], maxBytes: 555)])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { rig.presenter.shown.count == 1 }
    rig.clock.advance(gap + .seconds(1))
    rig.opener.open(candidate: "new.md")
    await settle { rig.presenter.shown.count == 2 }
    await drain()
    #expect(rig.index.requests == 2)
    #expect(rig.fetch.paths == ["a.md", "docs/new.md"])
    #expect(rig.fetch.limits.last == 555)
    rig.presenter.close()
  }

  @Test("a path missing even after the refresh: nothing fetched, one trace line")
  func missAfterRefresh() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { rig.presenter.shown.count == 1 }
    rig.clock.advance(gap + .seconds(1))
    rig.opener.open(candidate: "gone.md")
    await settle { !rig.trace.lines.isEmpty }
    await drain()
    #expect(rig.index.requests == 2)
    #expect(rig.fetch.paths == ["a.md"])
    #expect(rig.trace.lines == [TranscriptFileOpener.missLine(.notInIndex)])
    rig.presenter.close()
  }

  @Test(
    "an index the app cannot get: nothing fetched, nothing shown, the pending open ends with one trace line",
    arguments: [SessionFilesOutcome<FileIndex>.unavailable, .failed, .offline, .loggedOut])
  func indexUnavailable(answer: SessionFilesOutcome<FileIndex>) async {
    let rig = rig([answer])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { !rig.trace.lines.isEmpty }
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == [])
    #expect(rig.presenter.shown.isEmpty && rig.presenter.notices.isEmpty)
    #expect(rig.trace.lines == [TranscriptFileOpener.missLine(.indexUnavailable)])
  }

  @Test("tap A waiting on the index, then tap B: B joins the same load, only B is fetched and presented")
  func newestTapDuringIndex() async {
    let rig = rig([Self.loaded(["a.md", "b.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    rig.opener.open(candidate: "b.md")
    await drain()
    #expect(rig.index.requests == 1, "the second tap joins the load in flight")
    rig.index.release()
    await settle { !rig.presenter.shown.isEmpty }
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["b.md"])
    #expect(rig.presenter.shown.map(\.title) == ["b.md"])
    #expect(rig.trace.lines == [])
    rig.presenter.close()
  }

  @Test("tap A waiting on its fetch, then tap B waiting on a refresh: A never shows and its copy is deleted")
  func newestTapDuringFetch() async {
    let rig = rig([Self.loaded(["a.md"]), Self.loaded(["a.md", "docs/b.md"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "a.md")
    await settle { rig.presenter.shown.count == 1 }
    rig.presenter.close()
    rig.clock.advance(gap + .seconds(1))
    rig.fetch.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.fetch.waiting == 1 }
    rig.index.holding = true
    rig.opener.open(candidate: "b.md")
    await settle { rig.index.waiting == 1 }
    rig.fetch.release()
    await drain()
    #expect(rig.presenter.shown.count == 1, "tap A's second open did not show")
    #expect(rig.fetch.copies == [], "tap A's copy is deleted")
    rig.index.release()
    await settle { rig.fetch.waiting == 1 }
    rig.fetch.release()
    await settle { rig.presenter.shown.count == 2 }
    #expect(rig.presenter.shown.map(\.title) == ["a.md", "b.md"])
    rig.presenter.close()
  }

  @Test("cancel() during the index request: nothing fetched, nothing presented")
  func cancelDuringIndex() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    rig.opener.cancel()
    rig.index.release()
    await drain()
    #expect(rig.fetch.paths == [])
    #expect(rig.presenter.shown.isEmpty && rig.presenter.notices.isEmpty)
  }

  @Test("cancel() during the index load does not end the load: a tap before its answer joins it and opens")
  func cancelKeepsIndexLoad() async {
    let rig = rig([Self.loaded(["a.md", "b.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    rig.opener.cancel()
    rig.opener.open(candidate: "b.md")
    await drain()
    rig.index.release()
    await settle { !rig.presenter.shown.isEmpty }
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["b.md"])
    #expect(rig.presenter.shown.map(\.title) == ["b.md"])
    rig.presenter.close()
  }

  @Test("each reason of a miss writes its trace line once per opener")
  func missTracedOnce() async {
    let rig = rig([Self.loaded(["a.md", "server/index.ts", "relay/index.ts"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "x.md")
    await settle { !rig.trace.lines.isEmpty }
    rig.opener.open(candidate: "y.md")
    await drain()
    rig.opener.open(candidate: "index.ts")
    await drain()
    rig.opener.open(candidate: "index.ts")
    await drain()
    #expect(rig.index.requests == 1)
    #expect(rig.trace.lines == [
      TranscriptFileOpener.missLine(.notInIndex), TranscriptFileOpener.missLine(.ambiguous),
    ])
  }

  @Test("cancel() during the fetch: nothing presented and the copy is deleted")
  func cancelDuringFetch() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.fetch.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.fetch.waiting == 1 }
    rig.opener.cancel()
    rig.fetch.release()
    await drain()
    #expect(rig.presenter.shown.isEmpty && rig.presenter.notices.isEmpty)
    #expect(rig.fetch.copies == [])
  }

  @Test("an index that answers more than 5 s after the tap: nothing fetched, nothing presented")
  func pendingPastLimitAtIndex() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    rig.clock.advance(.seconds(6))
    rig.index.release()
    await drain()
    #expect(rig.fetch.paths == [])
    #expect(rig.presenter.shown.isEmpty && rig.presenter.notices.isEmpty)
  }

  @Test("a late index is kept: the next tap opens without asking again")
  func lateIndexKept() async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    rig.clock.advance(.seconds(6))
    rig.index.release()
    await drain()
    #expect(rig.presenter.shown.isEmpty)
    rig.opener.open(candidate: "a.md")
    await settle { !rig.presenter.shown.isEmpty }
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["a.md"])
    rig.presenter.close()
  }

  @Test("a fetch that answers more than 5 s after the tap: nothing presented, no bubble, the copy deleted",
        arguments: [false, true])
  func pendingPastLimitAtFetch(refused: Bool) async {
    let rig = rig([Self.loaded(["a.md"])])
    defer { rig.fetch.remove() }
    if refused { rig.fetch.answers = ["a.md": .offline] }
    rig.fetch.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.fetch.waiting == 1 }
    rig.clock.advance(.seconds(6))
    rig.fetch.release()
    await drain()
    #expect(rig.presenter.shown.isEmpty && rig.presenter.notices.isEmpty)
    #expect(rig.fetch.copies == [])
  }

  @Test("404 on the fetch gives the tree's notice that the file is gone")
  func goneNotice() async {
    let rig = rig([Self.loaded(["docs/a.md"])])
    defer { rig.fetch.remove() }
    rig.fetch.answers = ["docs/a.md": .refused(DiffRefusal(status: 404, code: "not-found", message: nil))]
    rig.opener.open(candidate: "a.md")
    await settle { !rig.presenter.notices.isEmpty }
    #expect(rig.presenter.notices == [UICopy.filePreviewGone("a.md")])
    #expect(rig.presenter.shown.isEmpty)
  }

  // MARK: - Hover

  @Test("hover answers from the kept index: found, not found, and no refresh or trace on a miss in a stale index")
  func hoverKeptIndex() async {
    let rig = rig([Self.loaded(["server/src/files/path-rule.ts", "server/index.ts", "relay/index.ts"])])
    defer { rig.fetch.remove() }
    rig.opener.open(candidate: "path-rule.ts")
    await settle { rig.presenter.shown.count == 1 }
    let arrivals = Arrivals()
    #expect(rig.opener.hover("path-rule.ts", onIndex: { arrivals.note() }) == .file("server/src/files/path-rule.ts"))
    #expect(rig.opener.hover("missing.md", onIndex: { arrivals.note() }) == .none)
    #expect(rig.opener.hover("index.ts", onIndex: { arrivals.note() }) == .none)
    rig.clock.advance(gap + .seconds(1))
    #expect(rig.opener.hover("missing.md", onIndex: { arrivals.note() }) == .none)
    await drain()
    #expect(rig.index.requests == 1, "hover never refreshes the index")
    #expect(arrivals.count == 0)
    #expect(rig.trace.lines == [])
    rig.presenter.close()
  }

  @Test("hover without an index: unknown starts one load, later hovers join it, the callback runs once it arrives")
  func hoverStartsOneLoad() async {
    let rig = rig([Self.loaded(["docs/a.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    let arrivals = Arrivals()
    #expect(rig.opener.hover("a.md", onIndex: { arrivals.note() }) == .unknown)
    await settle { rig.index.waiting == 1 }
    #expect(rig.opener.hover("b.md", onIndex: { arrivals.note() }) == .unknown)
    await drain()
    #expect(rig.index.requests == 1)
    #expect(arrivals.count == 0)
    rig.index.release()
    await settle { arrivals.count == 1 }
    await drain()
    #expect(arrivals.count == 1, "one callback for the load, the newest hover's")
    #expect(rig.opener.hover("a.md", onIndex: { arrivals.note() }) == .file("docs/a.md"))
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == [] && rig.trace.lines == [])
  }

  @Test("hover joins a tap's load in flight and leaves the tap's open alone")
  func hoverJoinsTapLoad() async {
    let rig = rig([Self.loaded(["a.md", "b.md"])])
    defer { rig.fetch.remove() }
    rig.index.holding = true
    rig.opener.open(candidate: "a.md")
    await settle { rig.index.waiting == 1 }
    let arrivals = Arrivals()
    #expect(rig.opener.hover("b.md", onIndex: { arrivals.note() }) == .unknown)
    await drain()
    #expect(rig.index.requests == 1)
    rig.index.release()
    await settle { arrivals.count == 1 && !rig.presenter.shown.isEmpty }
    #expect(rig.index.requests == 1)
    #expect(rig.fetch.paths == ["a.md"], "the tap still opens")
    #expect(rig.opener.hover("b.md", onIndex: { arrivals.note() }) == .file("b.md"))
    rig.presenter.close()
  }

  @Test(
    "hover with an index the app cannot get: none until the refresh gap, without asking again and without a trace",
    arguments: [SessionFilesOutcome<FileIndex>.unavailable, .failed])
  func hoverAfterFailedLoad(answer: SessionFilesOutcome<FileIndex>) async {
    let rig = rig([answer])
    defer { rig.fetch.remove() }
    let arrivals = Arrivals()
    #expect(rig.opener.hover("a.md", onIndex: { arrivals.note() }) == .unknown)
    await settle { arrivals.count == 1 }
    #expect(rig.opener.hover("a.md", onIndex: { arrivals.note() }) == .none)
    await drain()
    #expect(rig.index.requests == 1)
    rig.clock.advance(gap + .seconds(1))
    #expect(rig.opener.hover("a.md", onIndex: { arrivals.note() }) == .unknown)
    await settle { arrivals.count == 2 }
    #expect(rig.index.requests == 2)
    #expect(rig.trace.lines == [])
  }
}

/// Counts the hover's index callbacks.
@MainActor
private final class Arrivals {
  private(set) var count = 0

  func note() {
    count += 1
  }
}
