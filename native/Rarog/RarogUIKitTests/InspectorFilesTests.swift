import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The Files section of the right panel on a live SwiftUI view, read and driven through its accessibility elements
/// as VoiceOver does: the row labels, the menu items of each file kind (the same list stands in the long-press menu
/// and in the VoiceOver actions), what a tap and each item hand to the screen, and the panel that opens the tree of
/// its session and closes only its own. Owner: panel.
@MainActor
final class InspectorFilesTests: XCTestCase {
  /// What the section handed to the screen, in order.
  @MainActor
  private final class Recorder {
    var calls: [String] = []

    var actions: InspectorFilesActions {
      InspectorFilesActions(
        toggle: { [self] dir, expanded in calls.append("toggle \(dir) \(expanded)") },
        preview: { [self] path in calls.append("preview \(path)") },
        diff: { [self] path in calls.append("diff \(path)") },
        copy: { [self] path in calls.append("copy \(path)") })
    }
  }

  override func setUp() async throws {
    try await super.setUp()
    InboxScreenTests.enableAccessibility()
  }

  // MARK: - Rows

  func testRowsSpeakNameKindAndChangesInside() throws {
    let (window, _) = host(content(), Recorder())
    defer { window.isHidden = true }
    XCTAssertEqual(try label("inspector.git.file.docs/guide.txt", in: window), "guide.txt, zmieniony, 2 dodane linie, 1 usunięta linia")
    XCTAssertEqual(try label("inspector.git.file.src/old.ts", in: window), "old.ts, usunięty, 4 usunięte linie")
    XCTAssertEqual(try label("inspector.git.file.README.txt", in: window), "README.txt")
    XCTAssertEqual(try label("inspector.git.file.secrets.log", in: window), "secrets.log, ignorowany")
    XCTAssertEqual(try label("inspector.git.dir.src", in: window), "src, zmiany w środku: 2")
    XCTAssertEqual(try label("inspector.git.dir.dist", in: window), "dist, ignorowany")
    let src = try XCTUnwrap(InboxScreenTests.element("inspector.git.dir.src", in: window))
    XCTAssertEqual(src.accessibilityValue, "rozwinięty", "a directory with a change under it starts open")
    XCTAssertEqual(try XCTUnwrap(InboxScreenTests.element("inspector.git.title", in: window)).accessibilityLabel, "Pliki")
  }

  func testMenuItemsPerFileKind() throws {
    let (window, _) = host(content(), Recorder())
    defer { window.isHidden = true }
    XCTAssertEqual(try actions("inspector.git.file.docs/guide.txt", in: window), ["Podgląd", "Diff", "Kopiuj ścieżkę"])
    XCTAssertEqual(try actions("inspector.git.file.README.txt", in: window), ["Podgląd", "Kopiuj ścieżkę"], "unchanged: no Diff")
    XCTAssertEqual(try actions("inspector.git.file.src/old.ts", in: window), ["Diff", "Kopiuj ścieżkę"], "deleted: no Preview")
    XCTAssertEqual(try actions("inspector.git.file.secrets.log", in: window), ["Podgląd", "Kopiuj ścieżkę"])
  }

  func testTapPreviewsAnExistingFileAndOpensTheDiffOfADeletedOne() throws {
    let recorder = Recorder()
    let (window, _) = host(content(), recorder)
    defer { window.isHidden = true }
    try InboxScreenTests.activate("inspector.git.file.docs/guide.txt", in: window)
    try InboxScreenTests.activate("inspector.git.file.README.txt", in: window)
    try InboxScreenTests.activate("inspector.git.file.src/old.ts", in: window)
    try InboxScreenTests.activate("inspector.git.dir.src", in: window)
    XCTAssertEqual(recorder.calls, ["preview docs/guide.txt", "preview README.txt", "diff src/old.ts", "toggle src false"])
  }

  func testMenuItemsHandTheirFileToTheScreen() throws {
    let recorder = Recorder()
    let (window, _) = host(content(), recorder)
    defer { window.isHidden = true }
    let guide = try XCTUnwrap(InboxScreenTests.element("inspector.git.file.docs/guide.txt", in: window))
    XCTAssertTrue(InboxScreenTests.perform("Diff", on: guide))
    XCTAssertTrue(InboxScreenTests.perform("Kopiuj ścieżkę", on: guide))
    XCTAssertTrue(InboxScreenTests.perform("Podgląd", on: guide))
    XCTAssertEqual(recorder.calls, ["diff docs/guide.txt", "copy docs/guide.txt", "preview docs/guide.txt"])
  }

  func testFallbackTreeHasNoPreviewAndCopiesTheUnquotedPath() throws {
    let recorder = Recorder()
    let (window, _) = host(fallback(), recorder)
    defer { window.isHidden = true }
    let guide = "inspector.git.file.docs/guide.txt"
    XCTAssertEqual(try actions(guide, in: window), ["Diff", "Kopiuj ścieżkę"])
    try InboxScreenTests.activate(guide, in: window)
    let quoted = try XCTUnwrap(InboxScreenTests.element(#"inspector.git.file."src/\305\274.ts""#, in: window))
    XCTAssertTrue(InboxScreenTests.perform("Kopiuj ścieżkę", on: quoted))
    XCTAssertEqual(recorder.calls, ["diff docs/guide.txt", "copy src/ż.ts"])
  }

  func testCopyPathWritesTheRelativePathToTheClipboard() throws {
    var actions = Recorder().actions
    actions.copy = InspectorFilesActions.copyToClipboard
    let before = UIPasteboard.general.changeCount
    let (window, _) = show(VStack(alignment: .leading, spacing: 0) {
      InspectorFilesSection(content: content(), changes: changes(), sectionCollapsed: false, toggleSection: {}, actions: actions)
    })
    defer { window.isHidden = true }
    let guide = try XCTUnwrap(InboxScreenTests.element("inspector.git.file.docs/guide.txt", in: window))
    XCTAssertTrue(InboxScreenTests.perform("Kopiuj ścieżkę", on: guide))
    XCTAssertGreaterThan(UIPasteboard.general.changeCount, before, "the copy went to the clipboard")
  }

  // MARK: - Panel and tree store

  /// The panel is rebuilt for each session: the new one opens the tree of its session, and the old one leaving
  /// after it does not close the new one's tree.
  func testPanelOpensTheTreeOfItsSessionAndClosesOnlyItsOwn() throws {
    let store = try SessionToastTests.makeStore(messages: 1)
    let (window, holder) = hostPanel(store: store, session: "s1")
    defer { window.isHidden = true }
    XCTAssertEqual(store.fileTree.openSessionId, "s1")
    XCTAssertTrue(store.fileTree.panelOpen)
    holder.session = "s2"
    InboxScreenTests.spin()
    XCTAssertEqual(store.fileTree.openSessionId, "s2")
    XCTAssertTrue(store.fileTree.panelOpen, "the old panel leaving keeps the new one's tree open")
    holder.session = nil
    InboxScreenTests.spin()
    XCTAssertFalse(store.fileTree.panelOpen, "the panel left the screen")
  }

  // MARK: - Preview

  /// A tap on a file fetches it through the store with the limit of the session's listing and hands the copy, under
  /// the real name, to the presenter; an ignored file previews too. Closing the preview deletes the copy.
  func testTapPresentsTheFetchedCopyAndClosingDeletesIt() async throws {
    let copies = try PreviewCopies()
    defer { copies.remove() }
    let limits = Limits()
    let store = try await filesStore(UIKitTransport(
      onSessionFiles: { _, dir in Self.listingAnswer(dir) },
      onFetchSessionFile: { _, path, maxBytes throws(TransportError) in
        await limits.note(maxBytes)
        return .saved(try copies.write(path))
      }))
    let presenter = PreviewRecorder()
    let model = FilePreviewModel.session("s1", store: store, present: presenter.present, notice: presenter.notice)
    let (window, _) = hostPreviewing(model)
    defer { window.isHidden = true }
    try InboxScreenTests.activate("inspector.git.file.secrets.log", in: window)
    let shown = await InboxScreenTests.waitUntil { presenter.shown.count == 1 }
    XCTAssertTrue(shown, "the ignored file was presented")
    XCTAssertEqual(presenter.shown.map(\.title), ["secrets.log"])
    let limit = await limits.seen
    XCTAssertEqual(limit, [Self.maxBytes], "the limit comes from the session's listing")
    XCTAssertEqual(copies.contents.count, 1)
    presenter.close()
    XCTAssertEqual(copies.contents, [], "closing the preview deleted the copy")
  }

  /// 413 gives a bubble with the server's size and limit; no connection gives a bubble; the tree stays.
  func testTooLargeAndNoConnectionGiveABubbleAndTheTreeStays() async throws {
    let store = try await filesStore(UIKitTransport(
      onSessionFiles: { _, dir in Self.listingAnswer(dir) },
      onFetchSessionFile: { _, path, _ throws(TransportError) in
        if path == "README.txt" { return .tooLarge(size: 3 * 1_048_576, maxBytes: 2 * 1_048_576) }
        throw .offline(.notConnectedToInternet)
      }))
    let presenter = PreviewRecorder()
    let model = FilePreviewModel.session("s1", store: store, present: presenter.present, notice: presenter.notice)
    let (window, _) = hostPreviewing(model)
    defer { window.isHidden = true }
    try InboxScreenTests.activate("inspector.git.file.README.txt", in: window)
    _ = await InboxScreenTests.waitUntil { presenter.notices.count == 1 }
    try InboxScreenTests.activate("inspector.git.file.docs/guide.txt", in: window)
    _ = await InboxScreenTests.waitUntil { presenter.notices.count == 2 }
    XCTAssertEqual(presenter.notices, [
      "Plik README.txt ma 3\u{00A0}MB, więcej niż limit podglądu 2\u{00A0}MB.",
      "Brak połączenia z serwerem. Podgląd się nie otworzył.",
    ])
    XCTAssertEqual(presenter.shown.count, 0)
    XCTAssertNotNil(InboxScreenTests.element("inspector.git.file.docs/guide.txt", in: window), "the tree stays")
  }

  /// The login ends while the file is on its way: the copy is deleted and nothing is presented.
  func testLoginChangeDuringTheFetchDeletesTheCopy() async throws {
    let copies = try PreviewCopies()
    defer { copies.remove() }
    let hold = FetchHold()
    let store = try await filesStore(UIKitTransport(
      onSessionFiles: { _, dir in Self.listingAnswer(dir) },
      onFetchSessionFile: { _, path, _ throws(TransportError) in
        let copy = try copies.write(path)
        await hold.pause()
        return .saved(copy)
      }))
    let presenter = PreviewRecorder()
    let model = FilePreviewModel.session("s1", store: store, present: presenter.present, notice: presenter.notice)
    let (window, _) = hostPreviewing(model)
    defer { window.isHidden = true }
    try InboxScreenTests.activate("inspector.git.file.README.txt", in: window)
    let started = await InboxScreenTests.waitUntil { await hold.started }
    XCTAssertTrue(started)
    store.handleUnauthorized()
    await hold.release()
    let gone = await InboxScreenTests.waitUntil { copies.contents.isEmpty }
    XCTAssertTrue(gone, "the copy of the ended login is deleted")
    InboxScreenTests.spin()
    XCTAssertEqual(presenter.shown.count, 0)
    XCTAssertEqual(presenter.notices, [])
  }

  /// The QuickLook presenter refuses while its panel is out of the window, and otherwise shows the copy from the
  /// panel's own view controller under the real name; a second preview over the first is refused.
  func testQuickLookPresenterRefusesOutsideTheWindowAndShowsUnderTheRealName() throws {
    let copies = try PreviewCopies()
    defer { copies.remove() }
    let presenter = FilePreviewPresenter()
    presenter.anchor = UIView()
    let refused = FilePreviewCopy(url: try copies.write("a.txt"), title: "a.txt")
    XCTAssertFalse(presenter.present(refused))
    refused.discard()

    let host = UIViewController()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 360, height: 900))
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let anchor = UIView()
    host.view.addSubview(anchor)
    presenter.anchor = anchor
    XCTAssertTrue(presenter.present(FilePreviewCopy(url: try copies.write("guide.txt"), title: "guide.txt")))
    InboxScreenTests.spin()
    let preview = try XCTUnwrap(host.presentedViewController as? FilePreviewController, "QuickLook alone, no frame")
    XCTAssertEqual(preview.copy.title, "guide.txt")
    XCTAssertFalse(
      presenter.present(FilePreviewCopy(url: try copies.write("b.txt"), title: "b.txt")),
      "a second preview over the first is refused")
  }

  /// The preview owns its copy: the controller going away deletes it. (The test host has no window scene, so a
  /// presented preview never finishes its transition and cannot be dismissed here.)
  func testPreviewControllerGoingAwayDeletesItsCopy() throws {
    let copies = try PreviewCopies()
    defer { copies.remove() }
    var preview: FilePreviewController? = FilePreviewController(
      copy: FilePreviewCopy(url: try copies.write("guide.txt"), title: "guide.txt"))
    XCTAssertEqual(copies.contents.count, 1)
    XCTAssertNotNil(preview)
    preview = nil
    InboxScreenTests.spin()
    XCTAssertEqual(copies.contents, [], "the copy left with its preview")
  }

  /// The type rule on iOS itself: the extension types the system declares differ from the Mac's, where the logic
  /// tests run.
  func testTypeRuleOnTheDevice() {
    let text = Data("export const x = 1\n".utf8)
    for name in [
      "router.ts", "main.go", "Makefile", "notes.test.ts", "config.yaml", "ci.yml", "styles.css", "Cargo.toml",
      "query.sql", "schema.proto", "Localizable.xcstrings",
    ] {
      XCTAssertTrue(FilePreviewType.showsAsText(name: name, head: text, complete: true), name)
    }
    for name in [
      "logo.png", "brief.pdf", "offer.docx", "package.json", "README.md", "main.swift", "notes.txt", "page.html",
      "feed.xml", "letter.rtf", "invite.ics", "card.vcf", "map.geojson",
    ] {
      XCTAssertFalse(FilePreviewType.showsAsText(name: name, head: text, complete: true), name)
    }
  }

  // MARK: - Preview fixtures

  nonisolated private static let maxBytes = 4 * 1_048_576

  /// The panel's listings: the section fixture's files.
  nonisolated private static func listingAnswer(_ dir: String) -> FileListing {
    FileListing(
      dir: dir,
      entries: dir.isEmpty
        ? [FileEntry(name: "README.txt", kind: .file, size: 10), FileEntry(name: "secrets.log", kind: .file, size: 5, ignored: true)]
        : [],
      truncated: false, maxBytes: Self.maxBytes)
  }

  /// A logged-in store with the `files` route and session `s1` whose root listing has arrived.
  private func filesStore(_ transport: UIKitTransport) async throws -> RarogStore {
    let store = RarogStore(
      transport: transport, rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try SessionToastTests.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    let session = #"""
      {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-input",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
    try SessionToastTests.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
    let version = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":["files"]}"#
    store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    store.fileTree.panelOpened("s1")
    let listed = await InboxScreenTests.waitUntil { store.fileTree.maxBytes("s1") != nil }
    XCTAssertTrue(listed, "the root listing arrived")
    return store
  }

  /// The section with the panel's preview wiring: a tap goes to `model`.
  private func hostPreviewing(_ model: FilePreviewModel) -> (UIWindow, UIViewController) {
    var actions = Recorder().actions
    actions.preview = { path in model.open(path) }
    return show(VStack(alignment: .leading, spacing: 0) {
      InspectorFilesSection(content: content(), changes: changes(), sectionCollapsed: false, toggleSection: {}, actions: actions)
    })
  }

  // MARK: - Fixtures

  private func listing(_ dir: String, _ entries: [FileEntry]) -> FileListing {
    FileListing(dir: dir, entries: entries, truncated: false, maxBytes: 1_048_576)
  }

  /// `docs/guide.txt` modified, `src/new.ts` added, `src/old.ts` deleted, `dist` and `secrets.log` ignored.
  private func content() -> FileTreeContent {
    let snapshot = FileTreeSnapshot(
      source: .files,
      listings: Dictionary(uniqueKeysWithValues: [
        listing("", [
          FileEntry(name: "dist", kind: .dir, ignored: true), FileEntry(name: "docs", kind: .dir),
          FileEntry(name: "src", kind: .dir), FileEntry(name: "README.txt", kind: .file, size: 10),
          FileEntry(name: "secrets.log", kind: .file, size: 5, ignored: true),
        ]),
        listing("docs", [FileEntry(name: "guide.txt", kind: .file, size: 20)]),
        listing("src", [FileEntry(name: "index.ts", kind: .file, size: 30), FileEntry(name: "new.ts", kind: .file)]),
      ].map { ($0.dir, $0) }),
      diff: DiffFileList(
        files: [
          DiffListEntry(path: "docs/guide.txt", status: .modified, linesAdded: 2, linesDeleted: 1),
          DiffListEntry(path: "src/new.ts", status: .added, linesAdded: 9, linesDeleted: nil),
          DiffListEntry(path: "src/old.ts", status: .deleted, linesAdded: nil, linesDeleted: 4),
        ], truncated: false))
    return FileTree.content(snapshot, git: nil)
  }

  private func fallback() -> FileTreeContent {
    let frame = try! JSONDecoder().decode(GitStatusEvent.self, from: Data(#"""
      {"sessionId":"s1","branch":"main","dirtyCount":2,"files":["docs/guide.txt","\"src/\\305\\274.ts\""],
       "fileDetails":[{"path":"docs/guide.txt","kind":"modified","linesAdded":2,"linesDeleted":1},
                      {"path":"\"src/\\305\\274.ts\"","kind":"deleted","linesDeleted":3}]}
      """#.utf8))
    return FileTree.content(FileTreeSnapshot(source: .fallback), git: frame)
  }

  private func changes() -> InspectorChanges {
    InspectorChanges(count: 3, body: .noData, stale: false)
  }

  private func host(_ content: FileTreeContent, _ recorder: Recorder) -> (UIWindow, UIViewController) {
    // Without a scroll view: a hosted view does not expose the elements inside one to accessibility.
    let section = VStack(alignment: .leading, spacing: 0) {
      InspectorFilesSection(
        content: content, changes: changes(), sectionCollapsed: false, toggleSection: {}, actions: recorder.actions)
    }
    .padding(.horizontal, 20)
    return show(section)
  }

  /// Which session the hosted panel shows; `nil` = no panel.
  @Observable
  final class PanelHolder {
    var session: String? = nil
  }

  private struct PanelHost: View {
    let store: RarogStore
    let navigation: RarogNavigation
    let holder: PanelHolder

    var body: some View {
      if let session = holder.session {
        InspectorPanel(store: store, sessionId: session, gitStale: false)
          .environment(navigation)
          .id(session)
      }
    }
  }

  private func hostPanel(store: RarogStore, session: String) -> (UIWindow, PanelHolder) {
    let holder = PanelHolder()
    holder.session = session
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session(session)
    let (window, _) = show(PanelHost(store: store, navigation: navigation, holder: holder))
    return (window, holder)
  }

  private func show(_ view: some View) -> (UIWindow, UIViewController) {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 360, height: 900))
    window.overrideUserInterfaceStyle = .dark
    let host = UIHostingController(rootView: AnyView(view))
    window.rootViewController = host
    window.makeKeyAndVisible()
    AppFontTests.settle(window)
    InboxScreenTests.spin()
    return (window, host)
  }

  private func label(_ identifier: String, in window: UIWindow) throws -> String? {
    try XCTUnwrap(InboxScreenTests.element(identifier, in: window), "\(identifier) among \(identifiers(window))")
      .accessibilityLabel
  }

  /// The identifiers the window exposes, for a failure message.
  private func identifiers(_ window: UIWindow) -> [String] {
    InboxScreenTests.elements(in: window).compactMap { element in
      element.responds(to: #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier))
        ? element.value(forKey: "accessibilityIdentifier") as? String : nil
    }.filter { !$0.isEmpty }
  }

  /// The VoiceOver actions of a row as a set: SwiftUI hands them to UIKit in its own order, and the order of the menu
  /// is a rule of the model (`InspectorFiles.menu`), checked by the logic tests.
  private func actions(_ identifier: String, in window: UIWindow) throws -> Set<String> {
    Set(try XCTUnwrap(InboxScreenTests.element(identifier, in: window), identifier).accessibilityCustomActions?.map(\.name)
      ?? [])
  }
}

/// What the preview model handed to the screen: the copies it presented and the bubbles.
@MainActor
private final class PreviewRecorder {
  private(set) var shown: [FilePreviewCopy] = []
  private(set) var notices: [String] = []

  func present(_ copy: FilePreviewCopy) -> Bool {
    shown.append(copy)
    return true
  }

  func notice(_ text: String) {
    notices.append(text)
  }

  /// The preview closes the way `FilePreviewController` closes it.
  func close() {
    shown.forEach { $0.discard() }
  }
}

/// Fetched copies of one test in their own directory.
private struct PreviewCopies: Sendable {
  let url = FileManager.default.temporaryDirectory.appending(path: "rarog-uikit-preview-\(UUID().uuidString)")

  init() throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  /// A copy of `path` with its extension, as the client writes one.
  func write(_ path: String) throws(TransportError) -> URL {
    let suffix = (path as NSString).pathExtension
    let copy = url.appending(path: suffix.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(suffix)")
    do {
      try Data("text\n".utf8).write(to: copy)
    } catch {
      throw .invalidResponse("cannot write the test copy")
    }
    return copy
  }

  var contents: [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: url.path(percentEncoded: false))) ?? []).sorted()
  }

  func remove() {
    try? FileManager.default.removeItem(at: url)
  }
}

/// The limits the fetch route saw.
private actor Limits {
  private(set) var seen: [Int] = []

  func note(_ maxBytes: Int) {
    seen.append(maxBytes)
  }
}

/// Holds one fetch until the test releases it.
private actor FetchHold {
  private(set) var started = false
  private var continuation: CheckedContinuation<Void, Never>?

  func pause() async {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      started = true
    }
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}
