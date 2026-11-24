import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// File search in the Files section: the set of paths searched per source, mode and index state, plain and regex
// matching with its stop, and the result tree with its notes. Owner: session files (native app).

@Suite("file search: search set, matching with a stop, result tree and notes")
struct FileSearchTests {
  private func file(_ name: String, ignored: Bool = false) -> FileEntry {
    FileEntry(name: name, kind: .file, size: 100, ignored: ignored)
  }

  private func dir(_ name: String) -> FileEntry { FileEntry(name: name, kind: .dir) }

  private func listing(_ dir: String, _ entries: [FileEntry], truncated: Bool = false) -> FileListing {
    FileListing(dir: dir, entries: entries, truncated: truncated, maxBytes: 1_048_576)
  }

  private func change(_ path: String, _ status: DiffFileStatus) -> DiffListEntry {
    DiffListEntry(path: path, status: status, linesAdded: 1, linesDeleted: 1)
  }

  private func snapshot(
    _ listings: [FileListing] = [], _ changes: [DiffListEntry] = [], toggles: [String: Bool] = [:]
  ) -> FileTreeSnapshot {
    FileTreeSnapshot(
      source: .files, listings: Dictionary(uniqueKeysWithValues: listings.map { ($0.dir, $0) }),
      diff: DiffFileList(files: changes, truncated: false), toggles: toggles)
  }

  private func index(_ paths: [String], truncated: Bool = false) -> FileSearchIndex {
    FileSearchIndex(paths: paths, truncated: truncated, maxBytes: 2_097_152)
  }

  private func query(_ text: String, regex: Bool = false) -> FileSearchQuery {
    FileSearchQuery(text: text, regex: regex)
  }

  /// The whole run: search set, match, result.
  private func search(
    _ text: String, regex: Bool = false, snapshot: FileTreeSnapshot, git: GitStatusEvent? = nil,
    mode: FileTreeMode = .all, index state: FileSearchIndexState, folds: Set<FilePathKey> = []
  ) throws -> FileSearchResult {
    let scope = FileSearch.scope(snapshot, git: git, mode: mode, index: state)
    let outcome = FileSearch.match(query(text, regex: regex), in: scope.candidates)
    return try #require(FileSearch.result(
      outcome, query: query(text, regex: regex), scope: scope, snapshot: snapshot, git: git, index: state.index,
      folds: folds))
  }

  /// Rows as text: indent = depth; a directory ends with `/` (`>` when closed); a file shows its letter (`.` when
  /// unchanged) and `~` when it has no preview source.
  private func shape(_ content: FileTreeContent) -> [String] {
    content.rows.map { row in
      let pad = String(repeating: "  ", count: row.depth)
      switch row {
      case let .directory(d): return "\(pad)\(d.expanded ? "" : ">")\(d.name)/"
      case let .file(f): return "\(pad)\(f.status?.rawValue ?? ".") \(f.name)\(f.virtual ? "~" : "")"
      }
    }
  }

  private func fileRow(_ content: FileTreeContent, _ path: String) throws -> FileTreeFileRow {
    for row in content.rows { if case let .file(f) = row, f.path == path { return f } }
    throw Missing(path: path)
  }

  private func directory(_ content: FileTreeContent, _ path: String) throws -> FileTreeDirectoryRow {
    for row in content.rows { if case let .directory(d) = row, d.path == path { return d } }
    throw Missing(path: path)
  }

  private struct Missing: Error { let path: String }

  private let threeFiles = ["src/main.ts", "src/Main.swift", "docs/a.md"]

  @Test("plain text matches a part of the path without letter case, trimmed of spaces; every hit has a preview")
  func plainMatch() throws {
    let result = try search("  main ", snapshot: snapshot(), index: .ready(index(threeFiles)))
    #expect(shape(result.content) == ["src/", "  . Main.swift", "  . main.ts"])
    for path in ["src/main.ts", "src/Main.swift"] {
      let row = try fileRow(result.content, path)
      #expect(InspectorFiles.tap(.file(row), source: .files) == .preview(path: path))
    }
    #expect(result.notes.isEmpty)
  }

  @Test("a regular expression matches the path; a syntax error gives its note and no row")
  func regexMatchAndSyntaxError() throws {
    let md = try search(#"\.md$"#, regex: true, snapshot: snapshot(), index: .ready(index(threeFiles)))
    #expect(shape(md.content) == ["docs/", "  . a.md"])

    let broken = try search("[", regex: true, snapshot: snapshot(), index: .ready(index(threeFiles)))
    #expect(broken.content.rows.isEmpty)
    #expect(broken.notes == [.invalidPattern])
    #expect(FileSearch.match(query("[", regex: true), in: []) == .invalidPattern, "an empty set still checks syntax")
    #expect(FileSearch.match(query("MAIN.SWIFT", regex: true), in: [FileSearchCandidate(path: "src/Main.swift")])
      == .matches(FileSearchMatches(first: [FileSearchCandidate(path: "src/Main.swift")], total: 1)),
      "a regex ignores letter case")
  }

  @Test("catastrophic backtracking stops at the budget as too slow, and the next query runs at once")
  func regexTooSlow() {
    let candidates = [FileSearchCandidate(path: String(repeating: "a", count: 200) + ".txt")]
    let clock = ContinuousClock()
    let start = clock.now
    let outcome = FileSearch.match(query("(a+)+$", regex: true), in: candidates)
    let spent = clock.now - start
    #expect(outcome == .tooSlow)
    #expect(spent >= FileSearch.regexBudget && spent < .seconds(1), "stopped at about the budget: \(spent)")

    let next = clock.now
    #expect(FileSearch.match(query(#"\.txt$"#, regex: true), in: candidates)
      == .matches(FileSearchMatches(first: candidates, total: 1)))
    #expect(clock.now - next < .milliseconds(100), "nothing is left over from the slow query")
  }

  @Test("a newer query stops the running one: plain and regex give cancelled, not an empty result")
  func cancelled() {
    let candidates = (0..<2000).map { FileSearchCandidate(path: "src/file\($0).ts") }
    #expect(FileSearch.match(query("file"), in: candidates, isCancelled: { true }) == .cancelled)
    #expect(FileSearch.match(query("file", regex: true), in: candidates, isCancelled: { true }) == .cancelled)
    let slow = [FileSearchCandidate(path: String(repeating: "a", count: 200) + ".txt")]
    let clock = ContinuousClock()
    let start = clock.now
    var calls = 0
    let stopped = FileSearch.match(query("(a+)+$", regex: true), in: slow, isCancelled: {
      calls += 1
      return calls > 3
    })
    #expect(stopped == .cancelled)
    #expect(clock.now - start < .milliseconds(200), "the stop comes from inside the match")
  }

  @Test("an inactive query (empty or only spaces) gives no result")
  func inactiveQuery() {
    #expect(!query("   ").isActive)
    #expect(query(" a ").isActive)
    let scope = FileSearch.scope(snapshot(), git: nil, mode: .all, index: .ready(index(threeFiles)))
    let outcome = FileSearch.match(query("  "), in: scope.candidates)
    #expect(FileSearch.result(
      outcome, query: query("  "), scope: scope, snapshot: snapshot(), git: nil, index: nil, folds: []) == nil)
  }

  @Test("the result opens every directory, also one closed by hand; the tree keeps the hand toggle")
  func resultIgnoresHandToggles() throws {
    let base = snapshot(
      [listing("", [dir("docs"), dir("src")]), listing("src", [file("Main.swift"), file("main.ts")])],
      toggles: ["src": false])
    let result = try search("src/", snapshot: base, index: .ready(index(threeFiles)))
    #expect(shape(result.content) == ["src/", "  . Main.swift", "  . main.ts"])
    #expect(try directory(result.content, "src").expanded)
    #expect(shape(FileTree.content(base, git: nil)) == [">docs/", ">src/"], "the cleared field shows src closed")
  }

  @Test("a result directory folds only in the result; the fold leaves the hand toggles alone")
  func resultFolds() throws {
    let base = snapshot([listing("", [dir("src")])], toggles: ["src": true])
    let open = try search("src/", snapshot: base, index: .ready(index(threeFiles)))
    let src = try directory(open.content, "src")
    let folds = FileSearch.toggledFolds([], directory: src)
    #expect(folds == ["src"])
    let folded = try search("src/", snapshot: base, index: .ready(index(threeFiles)), folds: folds)
    #expect(shape(folded.content) == [">src/"])
    #expect(FileSearch.toggledFolds(folds, directory: try directory(folded.content, "src")).isEmpty)
  }

  @Test("a hit in a directory never listed has a preview, and its directories are not loading")
  func hitInUnlistedDirectory() throws {
    let result = try search(
      "y.ts", snapshot: snapshot([listing("", [dir("deep")])]), index: .ready(index(["deep/x/y.ts"])))
    #expect(shape(result.content) == ["deep/", "  x/", "    . y.ts"])
    let row = try fileRow(result.content, "deep/x/y.ts")
    #expect(InspectorFiles.tap(.file(row), source: .files) == .preview(path: "deep/x/y.ts"))
    #expect(try !directory(result.content, "deep/x").loading)
    #expect(try !directory(result.content, "deep").loading)
  }

  @Test("an index before the first listing of the session directory confirms its files")
  func indexBeforeFirstListing() throws {
    let empty = FileTreeSnapshot(source: .files)
    let result = try search("a.md", snapshot: empty, index: .ready(index(threeFiles)))
    let row = try fileRow(result.content, "docs/a.md")
    #expect(InspectorFiles.tap(.file(row), source: .files) == .preview(path: "docs/a.md"))
  }

  /// The bytes of each path: `String ==` holds for canonically equivalent text, which the server tells apart.
  private func bytes(_ paths: [String]) -> [[UInt8]] { paths.map { Array($0.utf8) } }

  private let composed = "docs/\u{E9}.txt"
  private let decomposed = "docs/e\u{301}.txt"

  @Test("two names that differ only in the Unicode form are two files: two candidates, two rows")
  func unicodeFormsAreTwoFiles() throws {
    let both = index([composed, decomposed])
    #expect(both.contains(composed) && both.contains(decomposed))
    #expect(!index([composed]).contains(decomposed))
    let scope = FileSearch.scope(snapshot(), git: nil, mode: .all, index: .ready(both))
    #expect(bytes(scope.candidates.map(\.path)) == bytes([composed, decomposed]))
    let result = try search("txt", snapshot: snapshot(), index: .ready(both))
    let files = result.content.rows.compactMap { row -> String? in
      if case let .file(f) = row { f.path } else { nil }
    }
    #expect(files.count == 2)
    #expect(Set(bytes(files)) == Set(bytes([composed, decomposed])), "each row keeps its own bytes")
  }

  @Test("an index with the composed name does not confirm the decomposed one known only from the changes")
  func unicodeFormDoesNotConfirmTheOther() throws {
    let base = snapshot([], [change(decomposed, .modified)])
    let result = try search("txt", snapshot: base, index: .ready(index([composed])))
    let rows = result.content.rows.compactMap { row -> FileTreeFileRow? in
      if case let .file(f) = row { f } else { nil }
    }
    #expect(rows.count == 2)
    let changed = try #require(rows.first { Array($0.path.utf8) == Array(decomposed.utf8) })
    #expect(changed.virtual && changed.changed)
    #expect(InspectorFiles.tap(.file(changed), source: .files) == .diff(path: decomposed))
    let indexed = try #require(rows.first { Array($0.path.utf8) == Array(composed.utf8) })
    #expect(!indexed.virtual && !indexed.changed)
    let tree = FileTree.content(snapshot([listing("", [dir("docs")])], [change(decomposed, .modified)]), git: nil,
                                index: index([composed]))
    #expect(try fileRow(tree, decomposed).virtual, "the main tree asks the index by bytes too")
  }

  @Test("a listing left over under a directory gone from disk is neither searched nor a preview source")
  func staleListingUnderGoneDirectory() throws {
    var base = snapshot(
      [listing("", [dir("src")]), listing("src/app", [file("main.ts"), file("util.ts")])],
      [change("src/app/main.ts", .deleted)])
    base.gone = ["src"]
    let scope = FileSearch.scope(base, git: nil, mode: .all, index: .unsupported)
    #expect(scope.candidates.map(\.path) == ["src/app/main.ts"], "only the change, not the old listing")
    var modified = base
    modified.diff = DiffFileList(files: [change("src/app/main.ts", .modified)], truncated: false)
    let result = try search("main", snapshot: modified, index: .unsupported)
    let row = try fileRow(result.content, "src/app/main.ts")
    #expect(row.virtual)
    #expect(InspectorFiles.tap(.file(row), source: .files) == .diff(path: "src/app/main.ts"))
  }

  @Test("changes join the index: a deleted file and one under a hidden directory are found and open the diff")
  func changesJoinTheIndex() throws {
    let base = snapshot(
      [listing("", [dir("src")])], [change("src/main.ts", .modified), change("old.ts", .deleted),
                                    change(".github/ci.yml", .modified)])
    let scope = FileSearch.scope(base, git: nil, mode: .all, index: .ready(index(["src/main.ts", "src/util.ts"])))
    #expect(scope.candidates.map(\.path) == ["src/main.ts", "src/util.ts", "old.ts", ".github/ci.yml"],
      "the index order first, then changes the index lacks")
    let result = try search("t", snapshot: base, index: .ready(index(["src/main.ts", "src/util.ts"])))
    #expect(shape(result.content) == [".github/", "  M ci.yml~", "src/", "  M main.ts", "  . util.ts", "D old.ts~"])
    #expect(InspectorFiles.tap(.file(try fileRow(result.content, "old.ts")), source: .files) == .diff(path: "old.ts"))
    #expect(InspectorFiles.tap(.file(try fileRow(result.content, ".github/ci.yml")), source: .files)
      == .diff(path: ".github/ci.yml"))
  }

  @Test("600 hits show the first 500 files and the note of 500 out of 600")
  func firstFiveHundred() throws {
    let paths = (0..<600).map { String(format: "src/f%03d.ts", $0) }
    let result = try search("src", snapshot: snapshot(), index: .ready(index(paths)))
    let files = result.content.rows.filter { if case .file = $0 { true } else { false } }
    #expect(files.count == 500)
    #expect(try fileRow(result.content, "src/f499.ts").name == "f499.ts")
    #expect(result.notes == [.shown(500, of: 600)])
  }

  @Test("no hit: no row and the note naming the query, apart from the clean sentence of the tree")
  func noHit() throws {
    let result = try search(" zzz ", snapshot: snapshot(), index: .ready(index(threeFiles)))
    #expect(result.content.rows.isEmpty)
    #expect(result.notes == [.noMatch(query: "zzz")])
  }

  @Test("the fallback source searches the paths of the git-status frame, unquoted, and keeps git's name on the row")
  func fallbackSearchesTheFrame() throws {
    let frame = Sample.decode(GitStatusEvent.self, #"""
      {"sessionId":"s1","branch":"main","dirtyCount":2,"files":["a.ts","\"src/\\305\\274.ts\""],
       "fileDetails":[{"path":"a.ts","kind":"modified","linesAdded":1,"linesDeleted":0},
                      {"path":"\"src/\\305\\274.ts\"","kind":"added"}]}
      """#)
    let fallback = FileTreeSnapshot(source: .fallback)
    let scope = FileSearch.scope(fallback, git: frame, mode: .all, index: .unsupported)
    #expect(scope.note == nil)
    #expect(scope.candidates.map(\.plain) == ["a.ts", "src/ż.ts"])

    let a = try search("a", snapshot: fallback, git: frame, index: .unsupported)
    #expect(shape(a.content) == ["M a.ts~"])
    #expect(a.notes.isEmpty)
    let quoted = try search("ż", snapshot: fallback, git: frame, mode: .changed, index: .unsupported)
    #expect(try fileRow(quoted.content, #""src/\305\274.ts""#).name == "ż.ts")
    #expect(InspectorFiles.tap(.file(try fileRow(quoted.content, #""src/\305\274.ts""#)), source: .fallback)
      == .diff(path: #""src/\305\274.ts""#))
  }

  @Test("a server without the index: loaded listings and changes, without ignored files, and the note")
  func serverWithoutIndex() {
    let base = snapshot(
      [
        listing("src", [file("b.ts"), file("a.ts")]),
        listing("", [dir("src"), file("README.md"), file("debug.log", ignored: true)]),
      ],
      [change("src/a.ts", .modified), change("gone.ts", .deleted)])
    let scope = FileSearch.scope(base, git: nil, mode: .all, index: .unsupported)
    #expect(scope.candidates.map(\.path) == ["README.md", "src/b.ts", "src/a.ts", "gone.ts"])
    #expect(scope.note == .openDirectoriesOnly)
    #expect(!scope.indexTruncated)
  }

  @Test("index on its way, failed or cut: the set searched and the note under the field")
  func indexStates() throws {
    let base = snapshot([listing("", [file("README.md")])], [change("src/a.ts", .modified)])
    let loading = FileSearch.scope(base, git: nil, mode: .all, index: .loading(previous: nil))
    #expect(loading.candidates.map(\.path) == ["README.md", "src/a.ts"])
    #expect(loading.note == .loadingIndex)

    let refreshing = FileSearch.scope(base, git: nil, mode: .all, index: .loading(previous: index(["lib/x.ts"])))
    #expect(refreshing.candidates.map(\.path) == ["lib/x.ts", "src/a.ts"], "a refresh searches the previous index")
    #expect(refreshing.note == nil)

    let failed = FileSearch.scope(base, git: nil, mode: .all, index: .failed(previous: nil))
    #expect(failed.candidates.map(\.path) == ["README.md", "src/a.ts"])
    #expect(failed.note == .indexFailed)
    let failedWithPrevious = FileSearch.scope(base, git: nil, mode: .all, index: .failed(previous: index(["lib/x.ts"])))
    #expect(failedWithPrevious.candidates.map(\.path) == ["lib/x.ts", "src/a.ts"])
    #expect(failedWithPrevious.note == .indexFailed)
    let stillWorks = try search("readme", snapshot: base, index: .failed(previous: nil))
    #expect(shape(stillWorks.content) == [". README.md"], "the field keeps working")
    #expect(stillWorks.notes == [.indexFailed])

    let cut = try search("ts", snapshot: base, index: .ready(index(["lib/x.ts", "lib/y.ts"], truncated: true)))
    #expect(cut.notes == [.indexTruncated(files: 3)], "the files really searched: the index and the change")
  }

  @Test("Changed only searches the change list and never the index")
  func changedOnlySearchesChanges() {
    let base = snapshot([listing("", [file("README.md")])], [change("src/a.ts", .modified)])
    let scope = FileSearch.scope(base, git: nil, mode: .changed, index: .ready(index(["README.md", "lib/x.ts"])))
    #expect(scope.candidates.map(\.path) == ["src/a.ts"])
    #expect(scope.note == nil && !scope.indexTruncated)
    let unsupported = FileSearch.scope(base, git: nil, mode: .changed, index: .unsupported)
    #expect(unsupported.note == nil, "changed only needs no index: no note about open directories")
  }

  // MARK: - The store's index state

  @Test("the store's index states map to the search's; not loaded reads as loading without an index")
  func storeStateMapping() {
    let core = FileIndex(paths: ["src/main.ts"], truncated: true, maxBytes: 4096)
    let mapped = FileSearchIndex(paths: ["src/main.ts"], truncated: true, maxBytes: 4096)
    let cases: [(FileIndexState, FileSearchIndexState)] = [
      (.unsupported, .unsupported),
      (.notLoaded, .loading(previous: nil)),
      (.loading(previous: core), .loading(previous: mapped)),
      (.ready(core), .ready(mapped)),
      (.failed(previous: nil), .failed(previous: nil)),
      (.failed(previous: core), .failed(previous: mapped)),
    ]
    for (state, expected) in cases { #expect(FileSearchIndexState(state) == expected, "\(state)") }
  }

  @Test("the memo follows a new index of the store")
  @MainActor
  func memoFollowsTheStore() {
    let memo = FileSearchIndexMemo()
    let first = FileIndex(paths: ["a.ts"], truncated: false, maxBytes: 10)
    let second = FileIndex(paths: ["a.ts", "b.ts"], truncated: false, maxBytes: 10)
    #expect(memo.state(.ready(first)).index?.contains("a.ts") == true)
    #expect(memo.state(.loading(previous: first)) == .loading(previous: FileSearchIndex(first)))
    let next = memo.state(.ready(second)).index
    #expect(next?.paths == ["a.ts", "b.ts"] && next?.contains("b.ts") == true)
    #expect(memo.state(.failed(previous: first)) == .failed(previous: FileSearchIndex(first)))
  }

  @Test("the memo takes a new index that differs only in the Unicode form of a path")
  @MainActor
  func memoComparesBytes() {
    let memo = FileSearchIndexMemo()
    let composed = "caf\u{E9}.txt"
    let decomposed = "cafe\u{301}.txt"
    _ = memo.state(.ready(FileIndex(paths: [composed], truncated: false, maxBytes: 10)))
    let next = memo.state(.ready(FileIndex(paths: [decomposed], truncated: false, maxBytes: 10))).index
    #expect(next?.paths.first.map { Array($0.utf8) } == Array(decomposed.utf8))
    #expect(next?.contains(decomposed) == true)
    #expect(next?.contains(composed) == false, "the old bytes are no longer confirmed")
  }

  @Test("the notes read as sentences: the query quoted, the counts, the plural of the files searched")
  func notesAsSentences() {
    #expect(UICopy.inspectorFilesSearchNote(.noMatch(query: "main")) == "Brak plików pasujących do „main”.")
    #expect(UICopy.inspectorFilesSearchNote(.shown(500, of: 600)) == "Pokazano 500 z 600.")
    #expect(UICopy.inspectorFilesSearchNote(.indexTruncated(files: 20_000)).hasSuffix(" plikach."))
    #expect(UICopy.inspectorFilesSearchNote(.indexTruncated(files: 1)) == "Lista plików jest niepełna: szukam w 1 pliku.")
    #expect(UICopy.inspectorFilesSearchNote(.indexTruncated(files: 3)) == "Lista plików jest niepełna: szukam w 3 plikach.")
  }
}
