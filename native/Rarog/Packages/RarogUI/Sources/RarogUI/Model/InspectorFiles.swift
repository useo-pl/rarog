import Foundation
import RarogContract
import RarogCore

// What a row of the Files section of the right panel does and says: the tap, the long-press menu, the copied path,
// the ink of the name, the VoiceOver label, and what stands under the section header. Pure functions, tests on
// macOS. Owner: panel.

/// The geometry of a tree row (pt, at the default text size).
public enum FileTreeMetrics {
  /// Indent of one level.
  public static let indent: Double = 12
  /// Axis of a level line from its indent: the middle of a directory chevron.
  public static let guideInset: Double = 5
  /// Gap between a directory chevron and its name.
  public static let chevronGap: Double = 6
  /// Start of a directory name from the indent of its level: the chevron (two axes) and the gap.
  public static let labelInset: Double = guideInset * 2 + chevronGap
  /// The kind letter of a file from the indent of its level: it stands on the axis of the NAME of the directory the
  /// file lies in (one level up).
  public static let letterInset: Double = labelInset - indent
  /// Start of a file name from the indent of its level; moving the letter does not move it.
  public static let nameInset: Double = 20
  /// Row height at the default text size; it grows with the text.
  public static let rowHeight: Double = 30
  /// The dot beside a directory with a change under it.
  public static let changeDot: Double = 6
}

/// An item of the long-press menu (a right click on a Mac) of a file row, in menu order.
public enum FileTreeMenuItem: Sendable, Equatable, Identifiable {
  case preview
  case diff
  case copyPath

  public var id: Self { self }

  public var title: String {
    switch self {
    case .preview: UICopy.inspectorFilesPreview
    case .diff: UICopy.showDiff
    case .copyPath: UICopy.inspectorFilesCopyPath
    }
  }

  public var symbol: String {
    switch self {
    case .preview: "eye"
    case .diff: "plus.forwardslash.minus"
    case .copyPath: "doc.on.doc"
    }
  }
}

/// What a tap on a tree row does.
public enum FileTreeTap: Sendable, Equatable {
  /// A directory opens or closes.
  case toggle(directory: String, expanded: Bool)
  /// The preview of the file (relative to the session directory).
  case preview(path: String)
  /// The diff window on this file (the server's name of it).
  case diff(path: String)
  case nothing
}

/// The ink of a row name.
public enum FileTreeInk: Sendable, Equatable {
  /// A change: full ink (`text2`, `text` under the pointer); a directory with a change under it is brighter.
  case changed
  /// Unchanged: `muted`.
  case dimmed
  /// Ignored by git: `muted2`, with the "ignored" note.
  case ignored
  /// Deleted: `err`, struck through.
  case removed
}

/// What stands under the section header.
public enum InspectorFilesBody: Sendable, Equatable {
  case tree
  /// No row: a known zero of changes ("Clean since …").
  case clean(commit: String?)
  /// No row and nothing known yet.
  case noData
}

/// A note under the tree.
public enum FileTreeNote: Sendable, Equatable, Identifiable {
  /// A listing on screen stopped at the server's ceiling.
  case listTruncated
  /// The change list does not carry every change.
  case diffTruncated

  public var id: Self { self }

  public var text: String {
    switch self {
    case .listTruncated: UICopy.inspectorFilesListTruncated
    case .diffTruncated: UICopy.inspectorFilesDiffTruncated
    }
  }
}

public enum InspectorFiles {
  /// The Files / Changed only toggle stands under the header for the `files` source only: the fallback tree has
  /// only changes anyway.
  public static func showsModeToggle(_ source: FileTreeSource) -> Bool { source == .files }

  /// A file is previewed when the server can send it: the source is `files` and the file stands on a loaded listing
  /// or in the file index. A deleted file is not on the disk, and a virtual one may be under a hidden directory the
  /// server refuses.
  public static func canPreview(_ file: FileTreeFileRow, source: FileTreeSource) -> Bool {
    source == .files && !file.removed && !file.virtual
  }

  /// A tap: a directory folds; a deleted file opens the diff; a file the server can send opens the preview; any other
  /// changed file opens the diff (the fallback tree, a virtual row), and an unchanged one does nothing.
  public static func tap(_ row: FileTreeRow, source: FileTreeSource) -> FileTreeTap {
    switch row {
    case let .directory(dir):
      return .toggle(directory: dir.path, expanded: !dir.expanded)
    case let .file(file):
      if file.removed { return .diff(path: file.path) }
      if canPreview(file, source: source) { return .preview(path: file.path) }
      return file.changed ? .diff(path: file.path) : .nothing
    }
  }

  /// The menu of a file row: Preview when the server can send the file, Diff when it is changed, Copy Path always.
  public static func menu(_ file: FileTreeFileRow, source: FileTreeSource) -> [FileTreeMenuItem] {
    var items: [FileTreeMenuItem] = []
    if canPreview(file, source: source) { items.append(.preview) }
    if file.changed { items.append(.diff) }
    items.append(.copyPath)
    return items
  }

  /// The path Copy Path puts on the clipboard: relative to the session directory, as a person types it. The fallback
  /// tree keeps git's quoting in `path` (the diff window finds the file by it), so the quoting goes here.
  public static func copiedPath(_ file: FileTreeFileRow, source: FileTreeSource) -> String {
    source == .fallback ? PathText.gitUnquoted(file.path) : file.path
  }

  /// Copy Path of a directory: its path relative to the session directory. The tree builds directories from unquoted
  /// paths, so the fallback tree needs no unquoting here.
  public static func copiedPath(_ directory: FileTreeDirectoryRow) -> String {
    directory.path
  }

  public static func ink(_ file: FileTreeFileRow) -> FileTreeInk {
    if file.removed { return .removed }
    if file.changed { return .changed }
    return file.ignored ? .ignored : .dimmed
  }

  public static func ink(_ dir: FileTreeDirectoryRow) -> FileTreeInk {
    if dir.changed { return .changed }
    return dir.ignored ? .ignored : .dimmed
  }

  /// "guide.txt, modified, 2 added lines": the name, the kind and the counts of a change; an unchanged file only its
  /// name, an ignored one with "ignored".
  public static func spoken(_ file: FileTreeFileRow) -> String {
    let base =
      file.changed
      ? UICopy.inspectorFileSpoken(
        path: file.name, status: file.status, added: file.added, deleted: file.deleted, binary: file.binary)
      : file.name
    return file.ignored ? UICopy.inspectorFilesIgnoredSpoken(base) : base
  }

  /// "src, changes inside: 3"; a directory without a change only its name, an ignored one with "ignored".
  public static func spoken(_ dir: FileTreeDirectoryRow) -> String {
    let base = dir.changed ? UICopy.inspectorFilesDirectorySpoken(name: dir.name, changes: dir.changes) : dir.name
    return dir.ignored ? UICopy.inspectorFilesIgnoredSpoken(base) : base
  }

  /// The tree when it has rows; without rows the sentence of the change state, as the frame or the list knows it.
  public static func body(_ content: FileTreeContent, changes: InspectorChanges) -> InspectorFilesBody {
    if !content.rows.isEmpty { return .tree }
    if case let .clean(commit) = changes.body { return .clean(commit: commit) }
    return .noData
  }

  /// The notes under the tree, the listing one first.
  public static func notes(_ content: FileTreeContent) -> [FileTreeNote] {
    guard !content.rows.isEmpty else { return [] }
    return (content.listTruncated ? [.listTruncated] : []) + (content.diffTruncated ? [.diffTruncated] : [])
  }
}
