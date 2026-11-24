#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// The Files section of the right panel: the tree of the session directory with the change markers (`FileTree`), the
// header that folds the whole tree, the Files / Changed only toggle and the search field under it, the tree or the
// search result with their notes, and the gestures of its rows (`InspectorFiles`). The store wiring is
// `InspectorFilesContainer.swift`. Owner: panel.

/// What the rows of the Files section hand to the screen.
@MainActor
struct InspectorFilesActions {
  /// A directory opened or closed by hand (`FileTreeStore.setExpanded`).
  var toggle: (_ directory: String, _ expanded: Bool) -> Void
  /// The preview of a file the server can send (relative to the session directory).
  var preview: (_ path: String) -> Void
  /// The diff window on one file (`RarogNavigation.openDiff`).
  var diff: (_ path: String) -> Void
  /// Copy Path: the text for the clipboard.
  var copy: (_ path: String) -> Void
  /// A directory folded or unfolded in the shown tree only: Changed only and a search result. The hand toggles of the
  /// whole tree stay.
  var fold: (_ directory: FileTreeDirectoryRow) -> Void = { _ in }

  /// The same gestures with `fold` set.
  func folding(_ fold: @escaping (FileTreeDirectoryRow) -> Void) -> InspectorFilesActions {
    var actions = self
    actions.fold = fold
    return actions
  }

  /// Copy Path of the panel: the system clipboard.
  static func copyToClipboard(_ path: String) {
    _ = Clipboard.copy(path)
  }

  func perform(_ tap: FileTreeTap) {
    switch tap {
    case let .toggle(directory, expanded): toggle(directory, expanded)
    case let .preview(path): preview(path)
    case let .diff(path): diff(path)
    case .nothing: break
    }
  }

  func perform(_ item: FileTreeMenuItem, on file: FileTreeFileRow, source: FileTreeSource) {
    switch item {
    case .preview: preview(file.path)
    case .diff: diff(file.path)
    case .copyPath: copy(InspectorFiles.copiedPath(file, source: source))
    }
  }
}

/// FILES: the header with the number of changes, "last known state" without contact, the Files / Changed only toggle
/// and the search field, then the tree (or the search result) and under it its notes; without rows, one of the empty
/// sentences. With rows the header is a toggle with a chevron on the right that folds the whole section (a device
/// preference, `RarogInspector.changesCollapsed`). The rows stand flat, without a container: the section header is a
/// target of the panel's anchor (a tap on the git line in the session header).
struct InspectorFilesSection: View {
  /// The tree of the chosen mode.
  let content: FileTreeContent
  /// The result of an active query, drawn instead of the tree; `nil` = no query, or its first run has not finished.
  var result: FileSearchResult? = nil
  let changes: InspectorChanges
  let sectionCollapsed: Bool
  let toggleSection: () -> Void
  var controls: InspectorFilesControls = .hidden
  /// A tap on a directory folds it in the shown tree only (Changed only, a search result), not by hand.
  var foldsInPlace = false
  let actions: InspectorFilesActions
  /// Rows under the pointer: the name of a changed file under it stands in full ink, and the level lines show only
  /// while the pointer is over the tree.
  @State private var hovered: Set<FileTreeRowKey> = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The category and the text size path of the commit fragment in the clean line (an `AttributedString` has no
  /// environment of its own).
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.textStyleFlat) private var flat

  private var title: String { UICopy.inspectorFilesTitle }
  private var sectionBody: InspectorFilesBody { InspectorFiles.body(content, changes: changes) }

  /// The whole section folded to its header: only a section with a tree has the fold.
  static func folded(_ content: FileTreeContent, changes: InspectorChanges, sectionCollapsed: Bool) -> Bool {
    sectionCollapsed && InspectorFiles.body(content, changes: changes) == .tree
  }

  /// The search field stands under an unfolded header wherever there is something to search: the session directory
  /// (`files`), or the fallback tree with changes.
  static func showsSearch(_ content: FileTreeContent, changes: InspectorChanges, sectionCollapsed: Bool) -> Bool {
    !folded(content, changes: changes, sectionCollapsed: sectionCollapsed)
      && (content.source == .files || InspectorFiles.body(content, changes: changes) == .tree)
  }

  private var folded: Bool { Self.folded(content, changes: changes, sectionCollapsed: sectionCollapsed) }

  /// Rows on screen: the result's with a query, the tree's without; none with the section folded.
  private var rows: [FileTreeRow] {
    guard !folded else { return [] }
    if let result { return result.content.rows }
    return sectionBody == .tree ? content.rows : []
  }

  var body: some View {
    let rows = self.rows
    Rectangle()
      .fill(Color(uiColor: Palette.border))
      .frame(height: 1)
      .padding(.top, 22)
      .accessibilityHidden(true)
    header
      .id(InspectorModel.changesAnchor)
      // A row that left from under the pointer (a folded directory or tree, a new listing) reports no exit. Its
      // trace goes with it: otherwise it would stand highlighted without the pointer when it comes back.
      .onChange(of: Set(rows.map(\.key))) { _, keys in hovered.formIntersection(keys) }
    if changes.stale {
      Label(UICopy.workflowStale, systemImage: "clock")
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .padding(.bottom, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UICopy.workflowStaleSpoken)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier("inspector.git.stale")
    }
    if !folded {
      if let mode = controls.mode {
        InspectorFilesModePicker(mode: mode, setMode: controls.setMode)
          .padding(.bottom, 8)
      }
      if controls.searchShown {
        InspectorFilesSearchField(controls: controls)
          .padding(.bottom, 6)
      }
    }
    if folded {
      EmptyView()
    } else if let result {
      treeRows(rows, source: result.content.source)
      ForEach(result.notes) { note in searchNote(note) }
      treeNotes(result.content)
    } else {
      switch sectionBody {
      case .tree:
        treeRows(rows, source: content.source)
        treeNotes(content)
      case let .clean(commit):
        clean(commit)
      case .noData:
        Text(UICopy.inspectorChangesNoData)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .accessibilityIdentifier("inspector.git.noData")
      }
    }
  }

  /// The rows, each a direct child of the panel's stack. Identity by bytes: two forms of one Unicode name are two
  /// rows.
  @ViewBuilder
  private func treeRows(_ rows: [FileTreeRow], source: FileTreeSource) -> some View {
    // The rows standing on screen count (the trace of a vanished one goes only after this pass).
    let guides = rows.contains { hovered.contains($0.key) }
    ForEach(rows, id: \.key) { row in
      FileTreeRowView(
        row: row, source: source, guides: guides, hovered: hovered.contains(row.key), foldsInPlace: foldsInPlace,
        actions: actions
      )
      .onHover { inside in
        if inside { hovered.insert(row.key) } else { hovered.remove(row.key) }
      }
    }
  }

  @ViewBuilder
  private func treeNotes(_ content: FileTreeContent) -> some View {
    ForEach(InspectorFiles.notes(content)) { note in
      Text(note.text)
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 4)
        .accessibilityIdentifier(note == .listTruncated ? "inspector.git.listTruncated" : "inspector.git.diffTruncated")
    }
  }

  /// A note of the search: a sentence; the failed file list adds Try Again.
  @ViewBuilder
  private func searchNote(_ note: FileSearchNote) -> some View {
    let text = Text(UICopy.inspectorFilesSearchNote(note))
      .appFont(.caption)
      .foregroundStyle(Color(uiColor: note == .invalidPattern || note == .tooSlow ? Palette.err : Palette.muted))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 4)
      .accessibilityIdentifier("inspector.files.note.\(Self.noteId(note))")
    if note == .indexFailed {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        text
        Button(UICopy.inspectorFilesSearchRetry, action: controls.retry)
          .appFont(.caption.weight(.semibold))
          .buttonStyle(.borderless)
          .tint(Color(uiColor: Palette.accent))
          .accessibilityIdentifier("inspector.files.retry")
      }
    } else {
      text
    }
  }

  private static func noteId(_ note: FileSearchNote) -> String {
    switch note {
    case .invalidPattern: "invalidPattern"
    case .tooSlow: "tooSlow"
    case .noMatch: "noMatch"
    case .shown: "shown"
    case .indexTruncated: "indexTruncated"
    case .openDirectoriesOnly: "openDirectoriesOnly"
    case .loadingIndex: "loadingIndex"
    case .indexFailed: "indexFailed"
    }
  }

  /// The section label; with a tree the whole row is a button (chevron on the right, as at workflow phases), without
  /// one only the label. The same identifier and height in both states.
  @ViewBuilder
  private var header: some View {
    if sectionBody == .tree {
      Button(action: toggleSection) {
        HStack(spacing: 8) {
          BackgroundSectionTitle(text: title)
          Spacer(minLength: 8)
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(sectionCollapsed ? 0 : 90))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: sectionCollapsed)
            .frame(width: FileTreeMetrics.guideInset * 2)
        }
        .padding(.top, 18)
        .padding(.bottom, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(title)
      .accessibilityValue(sectionCollapsed ? UICopy.disclosureCollapsed : UICopy.disclosureExpanded)
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("inspector.git.title")
    } else {
      BackgroundSectionTitle(text: title)
        .padding(.top, 18)
        .padding(.bottom, 8)
        .accessibilityIdentifier("inspector.git.title")
    }
  }

  /// "Clean since 7cdfbe4b": the commit in mono (a catalog sentence, the commit marked in it by its value).
  private func clean(_ commit: String?) -> some View {
    let text: Text =
      if let commit {
        Text({
          var line = AttributedString(UICopy.inspectorChangesClean(commit))
          if let range = line.range(of: commit) {
            line[range].font = AppFont.footnote.monospaced().resolve(typeSize: typeSize, flat: flat)
          }
          return line
        }())
      } else {
        Text(UICopy.inspectorChangesCleanNoCommit)
      }
    return text
      .appFont(.subheadline)
      .foregroundStyle(Color(uiColor: Palette.muted))
      .accessibilityIdentifier("inspector.git.clean")
  }
}

/// A row of the file tree. Directory: chevron, name, the orange dot when a change lies under it (open or closed),
/// the crossed eye on the right for an ignored one, the `+a −b` sum when closed; a tap folds it, a long press (a right
/// click) offers Copy Path. File: the kind letter (the colour of the git expansion) on the axis of the name of the
/// directory above, the name in its ink (`InspectorFiles.ink`), on the right `+a −b` of a change (`GitFileStats`,
/// shared with the git popover and the diff window) or the crossed eye; a tap does `InspectorFiles.tap`, a long press
/// (a right click) opens its menu, and VoiceOver gets the same items as actions. Under the pointer the name goes to full
/// text ink and the app's tip shows the whole name, which the row may cut in the middle.
struct FileTreeRowView: View {
  let row: FileTreeRow
  let source: FileTreeSource
  /// The pointer is over the tree: the level lines show.
  let guides: Bool
  /// The pointer is over THIS row: its name in full text ink (a deleted file keeps the error colour).
  let hovered: Bool
  /// A directory folds in the shown tree only (``InspectorFilesActions/fold``).
  let foldsInPlace: Bool
  let actions: InspectorFilesActions
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @AppScaledMetric(relativeTo: .caption) private var dot = CGFloat(FileTreeMetrics.changeDot)

  var body: some View {
    switch row {
    case let .directory(directory):
      Button {
        if foldsInPlace { actions.fold(directory) } else { actions.perform(InspectorFiles.tap(row, source: source)) }
      } label: {
        HStack(spacing: FileTreeMetrics.chevronGap) {
          Image(systemName: "chevron.right")
            .appFont(.caption.weight(.semibold))
            .imageScale(.small)
            .foregroundStyle(Color(uiColor: Palette.muted2))
            .rotationEffect(.degrees(directory.expanded ? 90 : 0))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: directory.expanded)
            .frame(width: FileTreeMetrics.guideInset * 2)
          Text(directory.name)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: hovered ? Palette.text : ink(InspectorFiles.ink(directory))))
            .lineLimit(1)
            .truncationMode(.middle)
          if directory.changed {
            Circle()
              .fill(Color(uiColor: Palette.accent))
              .frame(width: dot, height: dot)
              .accessibilityHidden(true)
          }
          Spacer(minLength: 8)
          if directory.ignored { ignoredMark }
          if let sum = directory.sum {
            Text(sum)
              .appFont(.caption.monospacedDigit())
              .foregroundStyle(Color(uiColor: Palette.muted2))
          }
        }
        .modifier(TreeRowFrame(depth: row.depth, guides: guides))
      }
      .buttonStyle(.plain)
      .pointerTip(directory.name)
      .contextMenu {
        Button(FileTreeMenuItem.copyPath.title, systemImage: FileTreeMenuItem.copyPath.symbol) {
          actions.copy(InspectorFiles.copiedPath(directory))
        }
      }
      .accessibilityLabel(InspectorFiles.spoken(directory))
      .accessibilityValue(directory.expanded ? UICopy.inspectorDirectoryExpanded : UICopy.inspectorDirectoryCollapsed)
      .accessibilityActions {
        Button(FileTreeMenuItem.copyPath.title) { actions.copy(InspectorFiles.copiedPath(directory)) }
      }
      .accessibilityIdentifier("inspector.git.dir.\(directory.path)")
    case let .file(file):
      let menu = InspectorFiles.menu(file, source: source)
      let fileInk = InspectorFiles.ink(file)
      Button {
        actions.perform(InspectorFiles.tap(row, source: source))
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          // The letter column ends where the name starts: moving the letter does not move the name.
          Text(file.status?.rawValue ?? " ")
            .appFont(.footnote.monospaced())
            .foregroundStyle(Color(uiColor: GitInk.color(file.status)))
            .padding(.leading, FileTreeMetrics.letterInset)
            .frame(width: FileTreeMetrics.nameInset, alignment: .leading)
          Text(file.name)
            .appFont(.footnote.monospaced())
            .foregroundStyle(Color(uiColor: hovered && fileInk != .removed ? Palette.text : ink(fileInk)))
            .strikethrough(fileInk == .removed, color: Color(uiColor: Palette.err))
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 8)
          if file.changed {
            GitFileStats(added: file.added, deleted: file.deleted, binary: file.binary)
          } else if file.ignored {
            ignoredMark
          }
        }
        .modifier(TreeRowFrame(depth: row.depth, guides: guides))
      }
      .buttonStyle(.plain)
      .pointerTip(file.name)
      .contextMenu {
        ForEach(menu) { item in
          Button(item.title, systemImage: item.symbol) { actions.perform(item, on: file, source: source) }
        }
      }
      .accessibilityLabel(InspectorFiles.spoken(file))
      .accessibilityActions {
        ForEach(menu) { item in
          Button(item.title) { actions.perform(item, on: file, source: source) }
        }
      }
      .accessibilityIdentifier("inspector.git.file.\(file.path)")
    }
  }

  /// A crossed eye at the right edge for an ignored row, quieter than the name; a word took too much of a narrow
  /// panel. VoiceOver hears "ignored" in the row label.
  private var ignoredMark: some View {
    Image(systemName: "eye.slash")
      .appFont(.caption)
      .imageScale(.small)
      .foregroundStyle(Color(uiColor: Palette.muted2))
      .accessibilityHidden(true)
  }

  private func ink(_ ink: FileTreeInk) -> UIColor {
    switch ink {
    case .changed: Palette.text2
    case .dimmed: Palette.muted
    case .ignored: Palette.muted2
    case .removed: Palette.err
    }
  }
}

/// The frame of a tree row: the indent of its level, the row height (30 pt at the default text size, growing with
/// the text) and the vertical level lines on the axis of the directory chevrons. The lines show only under the pointer
/// over the tree; under a finger the tree carries the indent alone, and nothing lights up.
private struct TreeRowFrame: ViewModifier {
  let depth: Int
  let guides: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @AppScaledMetric(relativeTo: .footnote) private var height = CGFloat(FileTreeMetrics.rowHeight)

  func body(content: Content) -> some View {
    content
      .padding(.leading, FileTreeMetrics.indent * Double(depth))
      .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
      .contentShape(Rectangle())
      .background(alignment: .leading) {
        HStack(spacing: 0) {
          ForEach(0..<depth, id: \.self) { _ in
            Rectangle()
              .fill(Color(uiColor: Palette.border))
              .frame(width: 1)
              .frame(width: FileTreeMetrics.indent, alignment: .leading)
          }
        }
        .padding(.leading, FileTreeMetrics.guideInset)
        .opacity(guides ? 1 : 0)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: guides)
        .accessibilityHidden(true)
      }
  }
}
/// The identity of a row on screen: its kind and its path by bytes. ``FileTreeRow/id`` compares paths as `String`,
/// which treats two Unicode forms of one name as the same, while the disk may hold both.
struct FileTreeRowKey: Hashable {
  let directory: Bool
  let path: FilePathKey
}

extension FileTreeRow {
  var key: FileTreeRowKey {
    switch self {
    case let .directory(row): FileTreeRowKey(directory: true, path: FilePathKey(row.path))
    case let .file(row): FileTreeRowKey(directory: false, path: FilePathKey(row.path))
    }
  }
}
#endif
