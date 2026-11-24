import Foundation
import RarogContract
import RarogCore
import RarogTransport

// The preview of one session file from the Files tree: a tap fetches the file into a private copy, the copy gets its
// QuickLook type (`FilePreviewType`) and goes to the presenter. The copy has exactly one owner at a time: the model
// from the end of the fetch until the presenter takes it, then the presenter until the preview closes. Every other
// end deletes it: a newer tap, the panel closing, a refused presentation, a failure to prepare it. A copy from an
// ended login never gets here (`RarogStore.fetchSessionFile` deletes it). Logic without UIKit, tested on macOS.
// Owner: panel.

/// A fetched file on disk with the name the preview shows. ``discard()`` deletes it; so does the last reference
/// going away, so a copy that falls out of every owner does not stay in the temporary directory.
@MainActor
final class FilePreviewCopy {
  let url: URL
  /// The real file name from the tree, never the copy's own name.
  let title: String
  private(set) var discarded = false

  init(url: URL, title: String) {
    self.url = url
    self.title = title
  }

  func discard() {
    guard !discarded else { return }
    discarded = true
    try? FileManager.default.removeItem(at: url)
  }

  isolated deinit {
    discard()
  }
}

@MainActor
final class FilePreviewModel {
  /// The fetch of one path of the panel's session (`RarogStore.fetchSessionFile` with the session's limit).
  typealias Fetch = (_ path: String) async -> SessionFilesOutcome<SessionFileFetch>
  /// Shows the copy; `true` = the presenter took it and discards it when the preview closes, `false` = it cannot
  /// show anything now (the panel left the window, another preview or sheet stands).
  typealias Present = (FilePreviewCopy) -> Bool
  /// A sentence for the app's bubble.
  typealias Notice = (String) -> Void

  private let fetch: Fetch
  private let present: Present
  private let notice: Notice
  /// Grows with every tap and with ``cancel()``: a result of an older tap is not this tap's.
  private var generation = 0
  private var task: Task<Void, Never>?

  init(fetch: @escaping Fetch, present: @escaping Present, notice: @escaping Notice) {
    self.fetch = fetch
    self.present = present
    self.notice = notice
  }

  /// A tap on a file or Preview in its menu. A newer tap replaces the fetch in flight: only the last one shows.
  func open(_ path: String) {
    generation += 1
    task?.cancel()
    let mine = generation
    let title = path.split(separator: "/").last.map(String.init) ?? path
    task = Task { [weak self, fetch] in
      let outcome = await fetch(path)
      guard let self, mine == self.generation else {
        // Superseded or cancelled: a copy that still arrived has no owner.
        if case let .loaded(.saved(url)) = outcome { try? FileManager.default.removeItem(at: url) }
        return
      }
      self.task = nil
      self.finish(outcome, title: title)
    }
  }

  /// The panel leaves: the fetch in flight stops and its copy, if any, is deleted.
  func cancel() {
    generation += 1
    task?.cancel()
    task = nil
  }

  private func finish(_ outcome: SessionFilesOutcome<SessionFileFetch>, title: String) {
    switch outcome {
    case let .loaded(.saved(url)):
      let copy = FilePreviewCopy(url: FilePreviewType.prepare(url, name: title), title: title)
      if !present(copy) { copy.discard() }
    case let .loaded(.tooLarge(size, maxBytes)):
      notice(UICopy.filePreviewTooLarge(name: title, size: UICopy.bytes(size), limit: UICopy.bytes(maxBytes)))
    case .offline, .timedOut:
      notice(UICopy.filePreviewOffline)
    case let .refused(refusal) where refusal.status == 404:
      notice(UICopy.filePreviewGone(title))
    case .refused, .failed:
      notice(UICopy.filePreviewFailed(title))
    case .unavailable, .loggedOut:
      // No route to ask, or the login ended: nothing to tell about this file.
      break
    }
  }
}

extension FilePreviewModel {
  /// The preview of one session's files: the store's fetch with the limit from the session's latest listing, else
  /// from its file index. Without either the app knows no limit and asks nothing (the tree then has no rows the
  /// server can send).
  static func session(
    _ sessionId: String, store: RarogStore, present: @escaping Present, notice: @escaping Notice
  ) -> FilePreviewModel {
    FilePreviewModel(
      fetch: { [weak store] path in
        guard let store, let maxBytes = store.fileTree.maxBytes(sessionId) else { return .unavailable }
        return await store.fetchSessionFile(sessionId, path: path, maxBytes: maxBytes)
      },
      present: present, notice: notice)
  }
}
