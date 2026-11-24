import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The whole file tree of a session: listings merged with the change markers, virtual rows for changed paths the
// listings lack, the two truncation flags, the fallback tree from the `git-status` frame and the expansion rule.
// Owner: session files (native app).

@Suite("file tree: listings, change markers and virtual rows")
struct FileTreeTests {
  private func dir(_ name: String, ignored: Bool = false) -> FileEntry {
    FileEntry(name: name, kind: .dir, ignored: ignored)
  }

  private func file(_ name: String, ignored: Bool = false) -> FileEntry {
    FileEntry(name: name, kind: .file, size: 100, ignored: ignored)
  }

  private func listing(_ dir: String, _ entries: [FileEntry], truncated: Bool = false) -> FileListing {
    FileListing(dir: dir, entries: entries, truncated: truncated, maxBytes: 1_048_576)
  }

  private func change(_ path: String, _ status: DiffFileStatus, _ added: Int? = nil, _ deleted: Int? = nil)
    -> DiffListEntry
  {
    DiffListEntry(path: path, status: status, linesAdded: added, linesDeleted: deleted)
  }

  private func snapshot(
    _ listings: [FileListing], _ changes: [DiffListEntry], diffTruncated: Bool = false,
    toggles: [String: Bool] = [:], gone: Set<String> = []
  ) -> FileTreeSnapshot {
    FileTreeSnapshot(
      source: .files, listings: Dictionary(uniqueKeysWithValues: listings.map { ($0.dir, $0) }),
      diff: DiffFileList(files: changes, truncated: diffTruncated), toggles: toggles, gone: gone)
  }

  /// Rows as text: indent = depth; a directory ends with `/` (`>` when closed, `*` with a change under it, `~` when
  /// virtual); a file shows its letter, `.` when unchanged, `~` when virtual.
  private func shape(_ content: FileTreeContent) -> [String] {
    content.rows.map { row in
      let pad = String(repeating: "  ", count: row.depth)
      switch row {
      case let .directory(d):
        return "\(pad)\(d.expanded ? "" : ">")\(d.name)/\(d.changed ? "*" : "")\(d.virtual ? "~" : "")"
      case let .file(f):
        return "\(pad)\(f.status?.rawValue ?? (f.changed ? "?" : ".")) \(f.name)\(f.virtual ? "~" : "")"
      }
    }
  }

  private func directory(_ content: FileTreeContent, _ path: String) -> FileTreeDirectoryRow? {
    for row in content.rows { if case let .directory(d) = row, d.path == path { return d } }
    return nil
  }

  private func fileRow(_ content: FileTreeContent, _ path: String) -> FileTreeFileRow? {
    for row in content.rows { if case let .file(f) = row, f.path == path { return f } }
    return nil
  }

  @Test("changed files get their letter, unchanged ones are dimmed, every ancestor of a change has the dot")
  func markersOnListings() throws {
    let base = snapshot(
      [
        listing("", [dir("lib"), dir("src"), file("README.md")]),
        listing("src", [dir("app"), file("index.ts")]),
        listing("src/app", [file("main.ts"), file("util.ts", ignored: true)]),
      ],
      [change("src/app/main.ts", .modified, 3, 1), change("README.md", .added, 10)])
    let open = FileTree.content(base, git: nil)
    #expect(shape(open) == [
      ">lib/", "src/*", "  app/*", "    M main.ts", "    . util.ts", "  . index.ts", "A README.md",
    ])
    #expect(directory(open, "src/app")?.sum == nil, "an open directory shows no sum")
    #expect(fileRow(open, "src/index.ts")?.dimmed == true)
    #expect(fileRow(open, "src/app/main.ts")?.dimmed == false)
    #expect(fileRow(open, "src/app/util.ts")?.ignored == true)
    #expect(fileRow(open, "README.md")?.added == 10)

    var closed = base
    closed.toggles = ["src": false]
    let shut = FileTree.content(closed, git: nil)
    #expect(shape(shut) == [">lib/", ">src/*", "A README.md"])
    let src = try #require(directory(shut, "src"))
    #expect(src.changes == 1)
    #expect(src.sum == "+3 −1")
  }

  @Test("a deleted file in a directory gone from disk stands under virtual ancestors")
  func deletedUnderMissingDirectory() throws {
    let content = FileTree.content(
      snapshot([listing("", [dir("src")])], [change("old/legacy/x.ts", .deleted, 0, 12)]), git: nil)
    #expect(shape(content) == ["old/*~", "  legacy/*~", "    D x.ts~", ">src/"])
    let row = try #require(fileRow(content, "old/legacy/x.ts"))
    #expect(row.removed)
    #expect(row.deleted == 12)
  }

  @Test("a change under a hidden directory brings a virtual directory with only that change")
  func hiddenDirectory() {
    let content = FileTree.content(
      snapshot([listing("", [dir("src"), file("a.txt")])], [change(".github/workflows/ci.yml", .modified, 1, 1)]),
      git: nil)
    #expect(shape(content) == [".github/*~", "  workflows/*~", "    M ci.yml~", ">src/", ". a.txt"])
  }

  @Test("a changed file past the listing ceiling is a virtual row; the two truncation flags are separate")
  func truncation() {
    let listTruncated = FileTree.content(
      snapshot([listing("", [file("a.txt")], truncated: true)], [change("z.txt", .modified)]), git: nil)
    #expect(shape(listTruncated) == [". a.txt", "M z.txt~"])
    #expect(listTruncated.listTruncated && !listTruncated.diffTruncated)

    let diffTruncated = FileTree.content(
      snapshot([listing("", [file("a.txt")])], [change("a.txt", .modified)], diffTruncated: true), git: nil)
    #expect(!diffTruncated.listTruncated && diffTruncated.diffTruncated)
  }

  @Test("the fallback source builds the tree from the git-status frame: quoted paths, untracked directories")
  func fallbackFromFrame() throws {
    let detailed = Sample.decode(GitStatusEvent.self, #"""
      {"sessionId":"s1","branch":"main","dirtyCount":4,
       "files":["src/a.ts","\"src/za\\305\\274\\303\\263\\305\\202\\304\\207.txt\"","docs/"],
       "fileDetails":[{"path":"src/a.ts","kind":"modified","linesAdded":2,"linesDeleted":1},
                      {"path":"\"src/za\\305\\274\\303\\263\\305\\202\\304\\207.txt\"","kind":"added"},
                      {"path":"docs/","kind":"added"}]}
      """#)
    let content = FileTree.content(FileTreeSnapshot(source: .fallback), git: detailed)
    #expect(content.source == .fallback)
    #expect(shape(content) == ["src/*~", "  M a.ts~", "  A zażółć.txt~", "A docs/~"])
    #expect(fileRow(content, #""src/za\305\274\303\263\305\202\304\207.txt""#)?.name == "zażółć.txt",
      "the row keeps the server's name of the file")
    #expect(content.diffTruncated, "the frame carries 3 of 4 changes")
    #expect(!content.listTruncated)

    let bare = Sample.decode(
      GitStatusEvent.self, #"{"sessionId":"s1","branch":"main","dirtyCount":1,"files":["lib/b.go"]}"#)
    #expect(shape(FileTree.content(FileTreeSnapshot(source: .fallback), git: bare)) == ["lib/*~", "  ? b.go~"])
    #expect(FileTree.content(FileTreeSnapshot(source: .fallback), git: nil).rows.isEmpty)
  }

  @Test("a vanished directory leaves the tree, the rest stays; a change under it comes back as virtual")
  func vanishedDirectory() {
    let listings = [listing("", [dir("docs"), dir("src")]), listing("docs", [file("guide.md")])]
    let toggles = ["docs": true]
    let quiet = FileTree.content(snapshot(listings, [], toggles: toggles, gone: ["src"]), git: nil)
    #expect(shape(quiet) == ["docs/", "  . guide.md"])

    let deleted = FileTree.content(
      snapshot(listings, [change("src/a.ts", .deleted)], toggles: toggles, gone: ["src"]), git: nil)
    #expect(shape(deleted) == ["docs/", "  . guide.md", "src/*~", "  D a.ts~"])
  }

  @Test("directories with changes start open, the rest closed; a hand toggle wins; an open unlisted one is loading")
  func expansion() throws {
    let base = snapshot([listing("", [dir("lib"), dir("src")])], [change("src/a.ts", .modified)])
    let first = FileTree.content(base, git: nil)
    #expect(shape(first) == [">lib/", "src/*", "  M a.ts~"])
    #expect(directory(first, "src")?.loading == true, "open, its listing not here yet")

    var toggled = base
    toggled.toggles = ["lib": true, "src": false]
    let second = FileTree.content(toggled, git: nil)
    #expect(shape(second) == ["lib/", ">src/*"])
    #expect(directory(second, "lib")?.loading == true)
    #expect(directory(second, "src")?.loading == false, "a closed directory is not loading")
  }

  @Test("a file replaced by a directory and a directory replaced by a file show every changed path")
  func kindChanged() {
    let fileToDir = FileTree.content(
      snapshot(
        [listing("", [dir("typ")]), listing("typ", [file("a.ts")])],
        [change("typ", .deleted), change("typ/a.ts", .added)]),
      git: nil)
    #expect(shape(fileToDir) == ["typ/*", "  A a.ts", "D typ~"])

    let dirToFile = FileTree.content(
      snapshot([listing("", [file("typ")])], [change("typ", .added), change("typ/x", .deleted)]), git: nil)
    #expect(shape(dirToFile) == ["typ/*~", "  D x~", "A typ"])
  }

  @Test("a changed file the listings lack is confirmed by the index: it has a preview, a deleted one never")
  func indexConfirmsChangedFiles() throws {
    let base = snapshot([listing("", [dir("src")])], [change("src/a.ts", .modified), change("src/b.ts", .deleted)])
    #expect(shape(FileTree.content(base, git: nil)) == ["src/*", "  M a.ts~", "  D b.ts~"])
    let index = FileSearchIndex(paths: ["src/a.ts", "src/b.ts"], truncated: false, maxBytes: 1_048_576)
    let confirmed = FileTree.content(base, git: nil, index: index)
    #expect(shape(confirmed) == ["src/*", "  M a.ts", "  D b.ts"])
    let a = try #require(fileRow(confirmed, "src/a.ts"))
    #expect(InspectorFiles.tap(.file(a), source: .files) == .preview(path: "src/a.ts"))
    let b = try #require(fileRow(confirmed, "src/b.ts"))
    #expect(InspectorFiles.tap(.file(b), source: .files) == .diff(path: "src/b.ts"), "deleted: always the diff")
  }

  @Test("Changed only: the tree of the change list, every directory open, a listed file previews, the rest diffs")
  func changedOnly() throws {
    let base = snapshot(
      [listing("", [dir("lib"), dir("src"), file("README.md")]),
       listing("src", [file("main.ts"), file("util.ts")])],
      [change("src/main.ts", .modified), change("old.txt", .deleted), change(".github/ci.yml", .modified)],
      toggles: ["src": false, ".github": false])
    let content = FileTree.content(base, git: nil, mode: .changed)
    #expect(shape(content) == [".github/*~", "  M ci.yml~", "src/*", "  M main.ts", "D old.txt~"])
    #expect(!content.listTruncated)
    let main = try #require(fileRow(content, "src/main.ts"))
    #expect(main.size == 100, "a listed file keeps what its listing says")
    #expect(InspectorFiles.tap(.file(main), source: .files) == .preview(path: "src/main.ts"))
    let old = try #require(fileRow(content, "old.txt"))
    #expect(old.removed)
    #expect(InspectorFiles.tap(.file(old), source: .files) == .diff(path: "old.txt"))
    let ci = try #require(fileRow(content, ".github/ci.yml"))
    #expect(InspectorFiles.tap(.file(ci), source: .files) == .diff(path: ".github/ci.yml"))
    #expect(directory(content, "src")?.loading == false, "children come from the changes, no listing is awaited")
    #expect(shape(FileTree.content(base, git: nil, mode: .changed, folds: ["src"])) == [
      ".github/*~", "  M ci.yml~", ">src/*", "D old.txt~",
    ])
  }

  @Test("Changed only without rows says the change state: clean, or nothing known without git")
  func changedOnlyEmpty() {
    let clean = InspectorChanges.make(
      meta: GitMeta(session: Sample.session(extra: #""branch":"main","dirtyCount":0"#), fresh: nil), fresh: nil,
      stale: false)
    let tree = FileTree.content(snapshot([listing("", [file("a.txt")])], []), git: nil, mode: .changed)
    #expect(tree.rows.isEmpty)
    #expect(InspectorFiles.body(tree, changes: clean) == .clean(commit: nil))
    let noGit = InspectorChanges.make(meta: GitMeta(session: Sample.session(), fresh: nil), fresh: nil, stale: false)
    let unknown = FileTree.content(
      FileTreeSnapshot(source: .files, listings: ["": listing("", [file("a.txt")])]), git: nil, mode: .changed)
    #expect(InspectorFiles.body(unknown, changes: noGit) == .noData)
  }

  @Test("the fallback source has no mode toggle and draws the same tree in either mode")
  func fallbackIgnoresMode() {
    let frame = Sample.decode(
      GitStatusEvent.self, #"{"sessionId":"s1","branch":"main","dirtyCount":1,"files":["lib/b.go"]}"#)
    let fallback = FileTreeSnapshot(source: .fallback, toggles: ["lib": false])
    #expect(FileTree.content(fallback, git: frame, mode: .changed) == FileTree.content(fallback, git: frame))
    #expect(!InspectorFiles.showsModeToggle(.fallback))
    #expect(InspectorFiles.showsModeToggle(.files))
  }
}
