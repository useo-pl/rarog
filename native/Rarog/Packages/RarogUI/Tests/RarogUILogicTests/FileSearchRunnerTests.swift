import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The file search as the Files section runs it: a pause in typing before the match, the match off the main actor and
// one at a time, the newest query or data wins, and an inactive query drops the outcome at once.
// Owner: session files (native app).

/// Counts the runs of the injected search and the most that ran at once.
private final class RunLog: @unchecked Sendable {
  private let lock = NSLock()
  private var started: [String] = []
  private var running = 0
  private var peak = 0

  func begin(_ text: String) {
    lock.withLock {
      started.append(text)
      running += 1
      peak = max(peak, running)
    }
  }

  func end() { lock.withLock { running -= 1 } }

  var queries: [String] { lock.withLock { started } }
  var mostAtOnce: Int { lock.withLock { peak } }
}

/// Holds a run until the test opens it; cancellation of the waiting run does not open it.
private actor Gate {
  private var open = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func release() {
    open = true
    for continuation in waiting { continuation.resume() }
    waiting = []
  }
}

@MainActor
@Suite("file search runner: debounce, one run at a time, latest wins")
struct FileSearchRunnerTests {
  private func input(_ text: String, paths: [String] = ["src/main.ts", "docs/a.md"]) -> FileSearchInput {
    FileSearchInput(
      query: FileSearchQuery(text: text, regex: false),
      snapshot: FileTreeSnapshot(source: .files, diff: DiffFileList(files: [], truncated: false)),
      git: nil, mode: .all,
      index: .ready(FileSearchIndex(paths: paths, truncated: false, maxBytes: 1_048_576)))
  }

  private func settle(_ condition: () -> Bool) async {
    for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
  }

  private func hits(_ run: FileSearchRun?) -> [String] {
    guard case let .matches(matches)? = run?.outcome else { return [] }
    return matches.first.map(\.path)
  }

  @Test("a query waits for the pause in typing; two quick keys run only the second")
  func debounceRunsOnlyTheLastQuery() async {
    let log = RunLog()
    let runner = FileSearchRunner(debounce: .milliseconds(60)) { input in
      log.begin(input.query.text)
      defer { log.end() }
      return await FileSearchRunner.search(input)
    }
    runner.submit(input("ma"))
    runner.submit(input("main"))
    try? await Task.sleep(for: .milliseconds(20))
    #expect(runner.latest == nil, "nothing before the pause ends")
    await settle { runner.latest != nil }
    #expect(runner.latest?.input == input("main"))
    #expect(hits(runner.latest) == ["src/main.ts"])
    #expect(log.queries == ["main"], "the first key never ran")
  }

  @Test("a new index with the same text runs again and shows the new hit")
  func newDataSameTextRecomputes() async {
    let runner = FileSearchRunner(debounce: .milliseconds(5))
    runner.submit(input("a.md"))
    await settle { runner.latest != nil }
    #expect(hits(runner.latest) == ["docs/a.md"])
    let wider = input("a.md", paths: ["src/main.ts", "docs/a.md", "deep/x/a.md"])
    runner.submit(wider)
    await settle { runner.latest?.input == wider }
    #expect(hits(runner.latest) == ["docs/a.md", "deep/x/a.md"])
  }

  @Test("a listing that changes only the Unicode form of a name runs again; the hit is the new name, with a preview")
  func unicodeFormOfListingRecomputes() async throws {
    func listed(_ name: String) -> FileSearchInput {
      FileSearchInput(
        query: FileSearchQuery(text: "txt", regex: false),
        snapshot: FileTreeSnapshot(
          source: .files,
          listings: ["": FileListing(
            dir: "", entries: [FileEntry(name: name, kind: .file, size: 10)], truncated: false, maxBytes: 4096)],
          diff: DiffFileList(files: [], truncated: false)),
        git: nil, mode: .all, index: .unsupported)
    }
    let composed = "caf\u{E9}.txt"
    let decomposed = "cafe\u{301}.txt"
    let log = RunLog()
    let runner = FileSearchRunner(debounce: .milliseconds(5)) { input in
      log.begin(input.query.text)
      defer { log.end() }
      return await FileSearchRunner.search(input)
    }
    runner.submit(listed(composed))
    await settle { runner.latest != nil }
    let next = listed(decomposed)
    runner.submit(next)
    await settle { hits(runner.latest).map { Array($0.utf8) } == [Array(decomposed.utf8)] }
    #expect(log.queries.count == 2, "the new bytes ran the search again")
    let run = try #require(runner.latest)
    let result = try #require(FileSearch.result(
      run.outcome, query: run.input.query, scope: run.scope, snapshot: next.snapshot, git: nil, index: nil, folds: []))
    let rows = result.content.rows.compactMap { row -> FileTreeFileRow? in
      if case let .file(f) = row { f } else { nil }
    }
    #expect(rows.map { Array($0.path.utf8) } == [Array(decomposed.utf8)])
    let row = try #require(rows.first)
    #expect(!row.virtual, "the new listing confirms the row")
    #expect(InspectorFiles.tap(.file(row), source: .files) == .preview(path: decomposed))
  }

  @Test("a change list or a git-status frame that changes only the Unicode form of a path is a new input")
  func unicodeFormOfChangesIsNewInput() throws {
    let composed = "caf\u{E9}.txt"
    let decomposed = "cafe\u{301}.txt"
    func changed(_ path: String) -> FileSearchInput {
      FileSearchInput(
        query: FileSearchQuery(text: "txt", regex: false),
        snapshot: FileTreeSnapshot(
          source: .files,
          diff: DiffFileList(files: [DiffListEntry(path: path, status: .modified)], truncated: false)),
        git: nil, mode: .changed, index: .unsupported)
    }
    func frame(_ path: String) throws -> FileSearchInput {
      let json = #"{"sessionId":"s1","branch":"main","dirtyCount":1,"files":["\#(path)"]}"#
      return FileSearchInput(
        query: FileSearchQuery(text: "txt", regex: false), snapshot: FileTreeSnapshot(source: .fallback),
        git: try JSONDecoder().decode(GitStatusEvent.self, from: Data(json.utf8)), mode: .all, index: .unsupported)
    }
    #expect(changed(composed) == changed(composed))
    #expect(changed(composed) != changed(decomposed))
    #expect(try frame(composed) == frame(composed))
    #expect(try frame(composed) != frame(decomposed))
  }

  @Test("the same input again runs nothing; the outcome stays")
  func sameInputRunsOnce() async {
    let log = RunLog()
    let runner = FileSearchRunner(debounce: .milliseconds(5)) { input in
      log.begin(input.query.text)
      defer { log.end() }
      return await FileSearchRunner.search(input)
    }
    runner.submit(input("main"))
    await settle { runner.latest != nil }
    runner.submit(input("main"))
    try? await Task.sleep(for: .milliseconds(40))
    #expect(log.queries == ["main"])
    #expect(runner.latest?.input == input("main"))
  }

  @Test("an empty or blank query drops the outcome and the run in flight at once")
  func inactiveQueryDropsOutcome() async {
    let runner = FileSearchRunner(debounce: .milliseconds(5))
    runner.submit(input("main"))
    await settle { runner.latest != nil }
    runner.submit(input("   "))
    #expect(runner.latest == nil)
    runner.submit(input("docs"))
    runner.submit(nil)
    try? await Task.sleep(for: .milliseconds(40))
    #expect(runner.latest == nil, "a run cancelled by a cleared field publishes nothing")
  }

  @Test("a newer query stops the run in flight; the next starts only after it ended")
  func oneRunAtATime() async {
    let log = RunLog()
    let runner = FileSearchRunner(debounce: .milliseconds(1)) { input in
      log.begin(input.query.text)
      defer { log.end() }
      if input.query.text == "slow" {
        // Runs until the runner cancels it, as a regular expression stopped by a newer query does.
        while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(1)) }
        return (FileSearch.scope(input.snapshot, git: nil, mode: .all, index: input.index), .cancelled)
      }
      return await FileSearchRunner.search(input)
    }
    runner.submit(input("slow"))
    await settle { log.queries == ["slow"] }
    runner.submit(input("main"))
    await settle { runner.latest != nil }
    #expect(log.queries == ["slow", "main"])
    #expect(log.mostAtOnce == 1, "the stopped run ended before the next began")
    #expect(runner.latest?.input == input("main"))
  }

  /// A search for "slow" that keeps running after its cancellation until `gate` opens, as the search set of a large
  /// index does, which never asks for cancellation.
  private func gatedRunner(_ log: RunLog, gate: Gate) -> FileSearchRunner {
    FileSearchRunner(debounce: .milliseconds(1)) { input in
      log.begin(input.query.text)
      defer { log.end() }
      if input.query.text == "slow" {
        await gate.wait()
        return (FileSearch.scope(input.snapshot, git: nil, mode: .all, index: input.index), .cancelled)
      }
      return await FileSearchRunner.search(input)
    }
  }

  @Test("a run stopped by a cleared field still finishing holds the next query until it ended")
  func clearedFieldKeepsOneRunAtATime() async {
    let log = RunLog()
    let gate = Gate()
    let runner = gatedRunner(log, gate: gate)
    runner.submit(input("slow"))
    await settle { log.queries == ["slow"] }
    runner.submit(nil)
    runner.submit(input("main"))
    try? await Task.sleep(for: .milliseconds(40))
    #expect(log.queries == ["slow"], "the next query waits for the stopped run")
    await gate.release()
    await settle { runner.latest != nil }
    #expect(log.queries == ["slow", "main"])
    #expect(log.mostAtOnce == 1)
    #expect(runner.latest?.input == input("main"))
  }

  @Test("back to the shown input while a run is still finishing, the next query waits for that run too")
  func backToShownInputKeepsOneRunAtATime() async {
    let log = RunLog()
    let gate = Gate()
    let runner = gatedRunner(log, gate: gate)
    runner.submit(input("main"))
    await settle { runner.latest != nil }
    runner.submit(input("slow"))
    await settle { log.queries == ["main", "slow"] }
    runner.submit(input("main"))
    runner.submit(input("docs"))
    try? await Task.sleep(for: .milliseconds(40))
    #expect(log.queries == ["main", "slow"], "the next query waits for the stopped run")
    await gate.release()
    await settle { runner.latest?.input == input("docs") }
    #expect(log.queries == ["main", "slow", "docs"])
    #expect(log.mostAtOnce == 1)
  }

  @Test("a regular expression with catastrophic backtracking ends as too slow, off the main actor")
  func slowExpressionEndsTooSlow() async {
    let runner = FileSearchRunner(debounce: .milliseconds(1))
    let long = String(repeating: "a", count: 200) + ".txt"
    let slow = FileSearchInput(
      query: FileSearchQuery(text: "(a+)+$", regex: true),
      snapshot: FileTreeSnapshot(source: .files, diff: DiffFileList(files: [], truncated: false)),
      git: nil, mode: .all, index: .ready(FileSearchIndex(paths: [long], truncated: false, maxBytes: 1)))
    let start = ContinuousClock.now
    runner.submit(slow)
    // The main actor stays free while the expression runs: this loop still turns once the run has started. A run on
    // the main actor would hold it for the whole budget and leave no turn after the first milliseconds. The count of
    // turns and the run's length depend on the load of the parallel test run, so neither is a bound here.
    var turns = 0
    var turnsDuringRun = 0
    while runner.latest == nil, turns < 5000 {
      turns += 1
      if ContinuousClock.now - start > .milliseconds(50) { turnsDuringRun += 1 }
      try? await Task.sleep(for: .milliseconds(2))
    }
    #expect(runner.latest?.outcome == .tooSlow)
    #expect(turnsDuringRun > 0, "the main actor kept turning during the run")
  }
}
