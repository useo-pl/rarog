import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The Files section of the right panel: what a tap and the long-press menu of a row do, the copied path, the inks,
// the VoiceOver labels and what stands under the header. Owner: panel.

@Suite("Files section: tap, menu, copied path, inks and VoiceOver of the tree rows")
struct InspectorFilesTests {
  private func listing(_ dir: String, _ entries: [FileEntry], truncated: Bool = false) -> FileListing {
    FileListing(dir: dir, entries: entries, truncated: truncated, maxBytes: 1_048_576)
  }

  /// The demo project: `docs/guide.txt` modified, `src/new.ts` added, `src/old.ts` deleted, `dist` ignored.
  private func content(
    toggles: [String: Bool] = [:], listTruncated: Bool = false, diffTruncated: Bool = false
  ) -> FileTreeContent {
    let snapshot = FileTreeSnapshot(
      source: .files,
      listings: Dictionary(uniqueKeysWithValues: [
        listing("", [
          FileEntry(name: "dist", kind: .dir, ignored: true), FileEntry(name: "docs", kind: .dir),
          FileEntry(name: "src", kind: .dir), FileEntry(name: "README.txt", kind: .file, size: 10),
          FileEntry(name: "secrets.log", kind: .file, size: 5, ignored: true),
        ], truncated: listTruncated),
        listing("docs", [FileEntry(name: "guide.txt", kind: .file, size: 20)]),
        listing("src", [FileEntry(name: "index.ts", kind: .file, size: 30), FileEntry(name: "new.ts", kind: .file)]),
      ].map { ($0.dir, $0) }),
      diff: DiffFileList(
        files: [
          DiffListEntry(path: "docs/guide.txt", status: .modified, linesAdded: 2, linesDeleted: 1),
          DiffListEntry(path: "src/new.ts", status: .added, linesAdded: 9, linesDeleted: nil),
          DiffListEntry(path: "src/old.ts", status: .deleted, linesAdded: nil, linesDeleted: 4),
        ], truncated: diffTruncated),
      toggles: toggles)
    return FileTree.content(snapshot, git: nil)
  }

  private func file(_ content: FileTreeContent, _ path: String) throws -> FileTreeFileRow {
    for row in content.rows { if case let .file(f) = row, f.path == path { return f } }
    throw Missing(path: path)
  }

  private func directory(_ content: FileTreeContent, _ path: String) throws -> FileTreeDirectoryRow {
    for row in content.rows { if case let .directory(d) = row, d.path == path { return d } }
    throw Missing(path: path)
  }

  private struct Missing: Error { let path: String }

  /// The fallback tree from a `git-status` frame (a server without `files`, a Codex entry, out of scope).
  private func fallback() -> FileTreeContent {
    let frame = Sample.decode(GitStatusEvent.self, #"""
      {"sessionId":"s1","branch":"main","dirtyCount":2,"files":["docs/guide.txt","\"src/\\305\\274.ts\""],
       "fileDetails":[{"path":"docs/guide.txt","kind":"modified","linesAdded":2,"linesDeleted":1},
                      {"path":"\"src/\\305\\274.ts\"","kind":"deleted","linesDeleted":3}]}
      """#)
    return FileTree.content(FileTreeSnapshot(source: .fallback), git: frame)
  }

  @Test("long press: a changed file has Preview, Diff, Copy Path; unchanged without Diff; deleted without Preview")
  func menuPerFileKind() throws {
    let tree = content()
    #expect(InspectorFiles.menu(try file(tree, "docs/guide.txt"), source: .files) == [.preview, .diff, .copyPath])
    #expect(InspectorFiles.menu(try file(tree, "src/new.ts"), source: .files) == [.preview, .diff, .copyPath])
    #expect(InspectorFiles.menu(try file(tree, "README.txt"), source: .files) == [.preview, .copyPath])
    #expect(InspectorFiles.menu(try file(tree, "src/old.ts"), source: .files) == [.diff, .copyPath])
    #expect(InspectorFiles.menu(try file(tree, "secrets.log"), source: .files) == [.preview, .copyPath],
      "an ignored file has a preview like any other")
    #expect([FileTreeMenuItem.preview, .diff, .copyPath].map(\.title) == ["Podgląd", "Diff", "Kopiuj ścieżkę"])
  }

  @Test("the fallback tree has no Preview: a changed file keeps Diff and Copy Path")
  func fallbackMenuWithoutPreview() throws {
    let tree = fallback()
    #expect(tree.source == .fallback)
    let guide = try file(tree, "docs/guide.txt")
    #expect(InspectorFiles.menu(guide, source: .fallback) == [.diff, .copyPath])
    #expect(InspectorFiles.tap(.file(guide), source: .fallback) == .diff(path: "docs/guide.txt"), "a tap as before")
    // A listing row seen through the fallback source (the session turned to it) has no preview either.
    let readme = try file(content(), "README.txt")
    #expect(InspectorFiles.menu(readme, source: .fallback) == [.copyPath])
    #expect(InspectorFiles.tap(.file(readme), source: .fallback) == .nothing)
  }

  @Test("tap: an existing file opens the preview of its path, a deleted one the diff on it, a directory folds")
  func tapPerRowKind() throws {
    let tree = content()
    #expect(InspectorFiles.tap(.file(try file(tree, "docs/guide.txt")), source: .files) == .preview(path: "docs/guide.txt"))
    #expect(InspectorFiles.tap(.file(try file(tree, "README.txt")), source: .files) == .preview(path: "README.txt"))
    #expect(InspectorFiles.tap(.file(try file(tree, "src/old.ts")), source: .files) == .diff(path: "src/old.ts"))
    #expect(InspectorFiles.tap(.directory(try directory(tree, "src")), source: .files)
      == .toggle(directory: "src", expanded: false))
    #expect(InspectorFiles.tap(.directory(try directory(tree, "dist")), source: .files)
      == .toggle(directory: "dist", expanded: true))
  }

  @Test("a changed file known only from the change list opens the diff, not a preview")
  func virtualChangedFileOpensDiff() throws {
    let snapshot = FileTreeSnapshot(
      source: .files, listings: ["": listing("", [])],
      diff: DiffFileList(files: [DiffListEntry(path: ".github/ci.yml", status: .modified, linesAdded: 1, linesDeleted: 0)],
        truncated: false))
    let ci = try file(FileTree.content(snapshot, git: nil), ".github/ci.yml")
    #expect(ci.virtual)
    #expect(InspectorFiles.menu(ci, source: .files) == [.diff, .copyPath])
    #expect(InspectorFiles.tap(.file(ci), source: .files) == .diff(path: ".github/ci.yml"))
  }

  @Test("Copy Path gives the path relative to the session directory, without git's quoting in the fallback tree")
  func copiedPathIsRelative() throws {
    #expect(InspectorFiles.copiedPath(try file(content(), "docs/guide.txt"), source: .files) == "docs/guide.txt")
    let quoted = try file(fallback(), #""src/\305\274.ts""#)
    #expect(InspectorFiles.copiedPath(quoted, source: .fallback) == "src/ż.ts")
  }

  @Test("Copy Path of a directory gives its path, without git's quoting in the fallback tree")
  func copiedDirectoryPathIsRelative() throws {
    #expect(InspectorFiles.copiedPath(try directory(content(), "src")) == "src")
    // The parent of the quoted `"src/\305\274.ts"`.
    #expect(InspectorFiles.copiedPath(try directory(fallback(), "src")) == "src")
  }

  @Test("inks: changed full, unchanged dimmed, ignored dimmer, deleted struck through in the error colour")
  func inks() throws {
    let tree = content()
    #expect(InspectorFiles.ink(try file(tree, "docs/guide.txt")) == .changed)
    #expect(InspectorFiles.ink(try file(tree, "README.txt")) == .dimmed)
    #expect(InspectorFiles.ink(try file(tree, "secrets.log")) == .ignored)
    #expect(InspectorFiles.ink(try file(tree, "src/old.ts")) == .removed)
    #expect(InspectorFiles.ink(try directory(tree, "src")) == .changed)
    #expect(InspectorFiles.ink(try directory(tree, "dist")) == .ignored)
  }

  @Test("a directory with a change under it keeps the dot open; closed it adds the sum")
  func changedDirectoryDotAndSum() throws {
    let open = try directory(content(), "src")
    #expect(open.expanded && open.changed && open.sum == nil, "open: the dot, no sum")
    let closed = try directory(content(toggles: ["src": false]), "src")
    #expect(!closed.expanded && closed.changed && closed.sum == "+9 −4", "closed: the dot and the sum")
    let plain = try directory(content(), "dist")
    #expect(!plain.changed && plain.sum == nil, "no change under it: no dot, no sum")
  }

  @Test("VoiceOver: a file by name and kind, a directory by name and the changes inside, ignored said aloud")
  func spokenLabels() throws {
    let tree = content()
    #expect(InspectorFiles.spoken(try file(tree, "docs/guide.txt")) == "guide.txt, zmieniony, 2 dodane linie, 1 usunięta linia")
    #expect(InspectorFiles.spoken(try file(tree, "src/old.ts")) == "old.ts, usunięty, 4 usunięte linie")
    #expect(InspectorFiles.spoken(try file(tree, "README.txt")) == "README.txt")
    #expect(InspectorFiles.spoken(try file(tree, "secrets.log")) == "secrets.log, ignorowany")
    #expect(InspectorFiles.spoken(try directory(tree, "src")) == "src, zmiany w środku: 2")
    #expect(InspectorFiles.spoken(try directory(tree, "dist")) == "dist, ignorowany")
    let three = FileTreeDirectoryRow(
      path: "src", name: "src", depth: 0, expanded: true, changes: 3, added: nil, deleted: nil, virtual: false,
      ignored: false, loading: false)
    #expect(InspectorFiles.spoken(three) == "src, zmiany w środku: 3")
  }

  @Test("under the header: the tree with its two notes, or without rows the sentence of the change state")
  func bodyAndNotes() throws {
    let clean = InspectorChanges.make(
      meta: GitMeta(session: Sample.session(extra: #""branch":"main","dirtyCount":0"#), fresh: nil), fresh: nil,
      stale: false)
    let empty = FileTree.content(FileTreeSnapshot(source: .files), git: nil)
    #expect(InspectorFiles.body(empty, changes: clean) == .clean(commit: nil))
    let unknown = InspectorChanges.make(meta: GitMeta(session: Sample.session(), fresh: nil), fresh: nil, stale: false)
    #expect(InspectorFiles.body(empty, changes: unknown) == .noData)
    #expect(InspectorFiles.body(content(), changes: clean) == .tree, "a clean session still shows its tree")

    #expect(InspectorFiles.notes(content()).isEmpty)
    #expect(InspectorFiles.notes(content(listTruncated: true, diffTruncated: true)) == [.listTruncated, .diffTruncated])
    #expect(InspectorFiles.notes(content(diffTruncated: true)) == [.diffTruncated])
    #expect(InspectorFiles.notes(empty).isEmpty)
    #expect(FileTreeNote.listTruncated.text != FileTreeNote.diffTruncated.text, "two separate sentences")
  }

  @Test("the kind letter of a file stands on the axis of the name of the directory above it")
  func letterAlignsWithDirectoryLabel() {
    for depth in 0..<4 {
      let label = FileTreeMetrics.indent * Double(depth) + FileTreeMetrics.labelInset
      let letter = FileTreeMetrics.indent * Double(depth + 1) + FileTreeMetrics.letterInset
      #expect(letter == label, "level \(depth)")
    }
    // A `footnote` mono letter is about 8 pt wide: it fits between its axis and the name.
    #expect(FileTreeMetrics.nameInset - FileTreeMetrics.letterInset >= 12)
  }
}
