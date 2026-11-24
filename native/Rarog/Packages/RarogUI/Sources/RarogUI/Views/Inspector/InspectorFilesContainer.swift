#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// The Files section wired to the store: the tree of the chosen mode, the file search (the field per session in
// `RarogInspector`, the index from `FileTreeStore`, the run in `FileSearchRunner`) and where a tap on a directory goes.
// The section itself draws (`InspectorFilesSection.swift`). Owner: panel.

/// The Files section of one session's panel.
struct InspectorFilesContainer: View {
  let store: RarogStore
  let sessionId: String
  /// The `git-status` frame of the open transcript (the fallback tree, the header count).
  let git: GitStatusEvent?
  let changes: InspectorChanges
  let placement: InspectorPlacement
  let actions: InspectorFilesActions
  @Environment(RarogNavigation.self) private var navigation
  @State private var runner = FileSearchRunner()
  @State private var memo = FileSearchIndexMemo()

  var body: some View {
    let inspector = navigation.inspector
    let fileTree = store.fileTree
    let snapshot = fileTree.snapshot(sessionId)
    let source = snapshot.source
    let index = memo.state(fileTree.fileIndex(sessionId))
    let toggle = InspectorFiles.showsModeToggle(source)
    // The fallback tree has only changes anyway: it ignores the mode and leaves the preference alone.
    let mode = toggle ? inspector.filesMode : .all
    let folds = inspector.resultFolds(for: sessionId)
    let content = FileTree.content(snapshot, git: git, mode: mode, index: index.index, folds: folds)
    let query = FileSearchQuery(text: inspector.searchText(for: sessionId), regex: inspector.searchRegex)
    let searchShown = InspectorFilesSection.showsSearch(
      content, changes: changes, sectionCollapsed: inspector.changesCollapsed)
    let input =
      searchShown && query.isActive
      ? FileSearchInput(query: query, snapshot: snapshot, git: git, mode: mode, index: index) : nil
    let result = input.flatMap { result($0, snapshot: snapshot, index: index.index, folds: folds) }
    let indexQuery = query.isActive && mode == .all && source == .files
    InspectorFilesSection(
      content: content, result: result, changes: changes, sectionCollapsed: inspector.changesCollapsed,
      toggleSection: { inspector.setChangesCollapsed(!inspector.changesCollapsed) },
      controls: InspectorFilesControls(
        mode: toggle ? mode : nil, setMode: { inspector.setFilesMode($0) }, searchShown: searchShown,
        text: query.text, setText: { [sessionId] in inspector.setSearchText($0, for: sessionId) },
        regex: query.regex, setRegex: { inspector.setSearchRegex($0) },
        emptyEscapeGoesOn: placement == .sheet,
        retry: { [fileTree, sessionId] in fileTree.reloadFileIndex(sessionId) }),
      foldsInPlace: result != nil || (mode == .changed && source == .files),
      actions: actions.folding { [sessionId] directory in inspector.toggleResultFold(directory, in: sessionId) })
      .onChange(of: input, initial: true) { _, input in runner.submit(input) }
      // The index is asked only while a query searches it (Files mode). The store forgets the query of a session the
      // panel left, so on appearing the screen reports what it shows now, a query kept for this session or none.
      .onChange(of: indexQuery) { _, active in fileTree.setSearchActive(active, in: sessionId) }
      .onAppear { fileTree.setSearchActive(indexQuery, in: sessionId) }
  }

  /// The result tree of the newest finished run, built here so a fold in the result never runs the match again. A run
  /// of an older query or older data stays on screen until the newer one finishes.
  private func result(
    _ input: FileSearchInput, snapshot: FileTreeSnapshot, index: FileSearchIndex?, folds: Set<FilePathKey>
  ) -> FileSearchResult? {
    guard let run = runner.latest else { return nil }
    return FileSearch.result(
      run.outcome, query: run.input.query, scope: run.scope, snapshot: snapshot, git: git, index: index, folds: folds)
  }
}
#endif
