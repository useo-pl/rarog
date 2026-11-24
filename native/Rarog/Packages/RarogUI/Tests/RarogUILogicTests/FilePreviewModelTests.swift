import Foundation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import Testing

// The owner of a preview copy: a tap fetches, the presenter gets the copy with the real name, and every end that is
// not a shown preview deletes the copy (a newer tap, the panel closing, a refused presentation); refusals and a lost
// connection become one bubble. The fetch is a fake that writes real files and can hold its answer. Owner: panel.

/// The fetch route of the model: each call writes its copy (when the answer is a copy) and waits for `release`.
@MainActor
private final class FakeFetch {
  let directory = FileManager.default.temporaryDirectory.appending(path: "rarog-ui-fetch-\(UUID().uuidString)")
  private(set) var paths: [String] = []
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
private final class FakePresenter {
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

@MainActor
@Suite("file preview: one owner of the copy")
struct FilePreviewModelTests {
  private func model(_ fetch: FakeFetch, _ presenter: FakePresenter) -> FilePreviewModel {
    FilePreviewModel(
      fetch: { await fetch.fetch($0) }, present: { presenter.present($0) }, notice: { presenter.notice($0) })
  }

  private func settle(_ until: @MainActor () -> Bool) async {
    for _ in 0..<500 where !until() { await Task.yield() }
  }

  @Test("a tap presents the copy under the real name; closing the preview deletes it")
  func tapPresentsAndCloseDeletes() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    model.open("docs/guide.txt")
    await settle { !presenter.shown.isEmpty }
    let copy = try? #require(presenter.shown.first)
    #expect(copy?.title == "guide.txt")
    #expect(fetch.copies.count == 1)
    presenter.close()
    #expect(fetch.copies == [])
  }

  @Test("a source file the preview would not show as text is presented as a .txt copy, titled with its name")
  func sourceGoesAsText() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    model.open("server/src/router.ts")
    await settle { !presenter.shown.isEmpty }
    #expect(presenter.shown.first?.url.pathExtension == "txt")
    #expect(presenter.shown.first?.title == "router.ts")
    presenter.close()
    #expect(fetch.copies == [])
  }

  @Test("a refused presentation deletes the copy and shows nothing")
  func refusedPresentation() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    let presenter = FakePresenter()
    presenter.accepts = false
    let model = model(fetch, presenter)
    model.open("a.txt")
    await settle { fetch.paths.count == 1 && fetch.copies.isEmpty }
    #expect(fetch.copies == [])
    #expect(presenter.notices == [])
  }

  @Test("two fast taps: only the last is presented and the first copy is deleted, in either order of answers",
        arguments: [false, true])
  func twoTaps(lastAnswersFirst: Bool) async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    fetch.holding = true
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    model.open("a.txt")
    await settle { fetch.waiting == 1 }
    model.open("b.txt")
    await settle { fetch.waiting == 2 }
    fetch.release(lastAnswersFirst ? 1 : 0)
    fetch.release(0)
    await settle { presenter.shown.count == 1 && fetch.copies.count == 1 }
    #expect(presenter.shown.map(\.title) == ["b.txt"])
    #expect(fetch.copies.count == 1, "the copy of the first tap is gone")
    #expect(presenter.notices == [])
    presenter.close()
  }

  @Test("the panel closing during the fetch deletes the copy that still arrives")
  func panelClosedMidFetch() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    fetch.holding = true
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    model.open("a.txt")
    await settle { fetch.waiting == 1 }
    model.cancel()
    fetch.release()
    await settle { fetch.copies.isEmpty }
    #expect(fetch.copies == [])
    #expect(presenter.shown.isEmpty)
    #expect(presenter.notices == [])
  }

  @Test("413 gives a bubble with the size and the limit from the answer; no connection gives a bubble")
  func bubbles() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    fetch.answers = [
      "big.iso": .loaded(.tooLarge(size: 3 * 1_048_576, maxBytes: 2 * 1_048_576)), "a.txt": .offline,
      "gone.txt": .refused(DiffRefusal(status: 404, code: "not-found", message: nil)),
    ]
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    for path in ["big.iso", "a.txt", "gone.txt"] {
      let before = presenter.notices.count
      model.open(path)
      await settle { presenter.notices.count > before }
    }
    #expect(presenter.notices == [
      "Plik big.iso ma 3\u{00A0}MB, więcej niż limit podglądu 2\u{00A0}MB.", "Brak połączenia z serwerem. Podgląd się nie otworzył.",
      "Pliku gone.txt nie ma już w katalogu sesji.",
    ])
    #expect(presenter.shown.isEmpty)
  }

  @Test("an ended login shows nothing")
  func loggedOut() async {
    let fetch = FakeFetch()
    defer { fetch.remove() }
    fetch.answers = ["a.txt": .loggedOut]
    let presenter = FakePresenter()
    let model = model(fetch, presenter)
    model.open("a.txt")
    await settle { fetch.paths.count == 1 }
    for _ in 0..<50 { await Task.yield() }
    #expect(presenter.shown.isEmpty && presenter.notices.isEmpty)
  }
}
