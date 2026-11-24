import Foundation
import RarogContract

// The file tree triggers the store sees itself: a new `git-status` frame of the open session, the end of its turn,
// and the server starting to announce `files`; the file index of the open session is invalidated by the end of its
// turn and asked for when the server starts to announce `file-index`, never by a `git-status` frame; and sessions
// gone from the server's list leave the tree. The return to the foreground and logout are wired in the store's life
// cycle (`setScenePhase`, `retire`). Owner: session files (native app).

extension RarogStore {
  /// What the file tree compares before and after an event.
  struct FileTreeProbe {
    let sessionId: String
    let git: GitStatusEvent?
    let working: Bool
    let filesAvailable: Bool
    let fileIndexAvailable: Bool
  }

  /// `nil` while no panel shows a tree: then events cost nothing.
  func fileTreeProbe() -> FileTreeProbe? {
    guard fileTree.panelOpen, let sessionId = fileTree.openSessionId else { return nil }
    return FileTreeProbe(
      sessionId: sessionId, git: state.transcripts[sessionId]?.git,
      working: Self.isWorking(state.sessions[sessionId]?.state), filesAvailable: state.filesAvailable,
      fileIndexAvailable: state.fileIndexAvailable)
  }

  /// One refresh for any of the three: the frame's content changed (not each `usage` frame, which only bumps the
  /// repository revision), the session left `starting` or `running`, or `files` appeared. The end of the turn and
  /// `file-index` appearing also invalidate the session's file index.
  func noteFileTreeEvent(before: FileTreeProbe?) {
    if state.sessionsLoaded { fileTree.forgetSessions(notIn: state.sessions) }
    guard let before, let after = fileTreeProbe(), after.sessionId == before.sessionId else { return }
    let gitChanged = after.git != before.git
    let turnEnded = before.working && !after.working
    let filesAppeared = !before.filesAvailable && after.filesAvailable
    if gitChanged || turnEnded || filesAppeared { fileTree.requestRefresh() }
    let indexAppeared = !before.fileIndexAvailable && after.fileIndexAvailable
    if turnEnded || indexAppeared { fileTree.invalidateIndex(after.sessionId) }
  }

  private static func isWorking(_ state: SessionState?) -> Bool {
    state == .running || state == .starting
  }
}
