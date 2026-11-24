import Foundation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI

// Shared doubles for the file preview tests (`FilePreviewModelTests`, `TranscriptFileOpenerTests`): a fetch route
// that writes real copies and can hold its answer, and a presenter that keeps what it showed. Owner: panel.

/// The fetch route of the preview: each call writes its copy (when the answer is a copy) and waits for `release`.
@MainActor
final class FakeFetch {
  let directory = FileManager.default.temporaryDirectory.appending(path: "rarog-ui-fetch-\(UUID().uuidString)")
  private(set) var paths: [String] = []
  /// The limit of each call, in the order of `paths`.
  private(set) var limits: [Int] = []
  var answers: [String: SessionFilesOutcome<SessionFileFetch>] = [:]
  var bytes = Data("let x = 1\n".utf8)
  var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  init() {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  func fetch(_ path: String) async -> SessionFilesOutcome<SessionFileFetch> {
    paths.append(path)
    let answer: SessionFilesOutcome<SessionFileFetch>
    if let given = answers[path] {
      answer = given
    } else {
      let name = path.split(separator: "/").last.map(String.init) ?? path
      let suffix = name.contains(".") ? ".\(name.split(separator: ".").last!)" : ""
      let copy = directory.appending(path: "\(UUID().uuidString)\(suffix)")
      try? bytes.write(to: copy)
      answer = .loaded(.saved(copy))
    }
    if holding { await withCheckedContinuation { held.append($0) } }
    return answer
  }

  /// The fetch with the limit the caller passes, recorded per call.
  func fetch(_ path: String, maxBytes: Int) async -> SessionFilesOutcome<SessionFileFetch> {
    limits.append(maxBytes)
    return await fetch(path)
  }

  var waiting: Int { held.count }

  func release(_ index: Int = 0) {
    held.remove(at: index).resume()
  }

  /// The copies on disk.
  var copies: [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))) ?? []).sorted()
  }

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

/// The presenter: keeps what it showed; `accepts = false` refuses like a panel that left the window.
@MainActor
final class FakePresenter {
  var accepts = true
  private(set) var shown: [FilePreviewCopy] = []
  private(set) var notices: [String] = []

  func present(_ copy: FilePreviewCopy) -> Bool {
    guard accepts else { return false }
    shown.append(copy)
    return true
  }

  func notice(_ text: String) {
    notices.append(text)
  }

  /// The preview closes the way the real presenter closes it.
  func close() {
    shown.forEach { $0.discard() }
  }
}
