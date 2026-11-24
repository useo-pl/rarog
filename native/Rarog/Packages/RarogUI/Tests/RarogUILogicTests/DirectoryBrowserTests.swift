import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Project choice in the New Session form: the browser opens on the parent of the
// chosen project, a tap on a row opens it, Up goes to the parent the listing names, Choose takes the directory on
// screen, Cancel goes back, late listings commit nothing, and a directory without git and history warns first.
// Owner: session control.

@MainActor
@Suite("project choice: browser on the parent, explicit Choose, Cancel, late replies, warning")
struct DirectoryBrowserTests {
  @MainActor
  final class Loader {
    var calls: [String?] = []
    var replies: [String?: DirectoryOutcome] = [:]
    var gates: [String?: AsyncStream<Void>] = [:]
    /// A gate for the next request of that directory only.
    var onceGates: [String?: AsyncStream<Void>] = [:]

    /// The reply is the one set when the request arrives, as a server answers with the state of that moment.
    func load(_ dir: String?) async -> DirectoryOutcome {
      calls.append(dir)
      let reply = replies[dir]
      if let gate = onceGates.removeValue(forKey: dir) ?? gates[dir] { for await _ in gate { break } }
      return reply ?? .loaded(DirListing(path: dir, parent: nil, entries: []))
    }

    func listing(_ path: String?, parent: String?, _ entries: [DirEntry]) {
      replies[path] = .loaded(DirListing(path: path, parent: parent, entries: entries))
    }
  }

  static let home = "/Users/d"
  static let projects = "/Users/d/Projects"
  static let group = "/Users/d/Projects/demo"
  static let app = "/Users/d/Projects/demo/app"

  func settle(_ condition: () -> Bool) async {
    for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
  }

  /// `~/Projects` as the only root, the project `~/Projects/demo/app`.
  private func groupLoader() -> Loader {
    let loader = Loader()
    loader.listing(nil, parent: nil, [DirEntry(name: "Projects", path: Self.projects, git: false, history: false)])
    loader.listing(Self.app, parent: Self.group, [])
    loader.listing(Self.group, parent: Self.projects, [
      DirEntry(name: "app", path: Self.app, git: true, history: true),
      DirEntry(name: "notatki", path: "\(Self.group)/notatki"),
      DirEntry(name: "atlas-docs", path: "\(Self.group)/atlas-docs", git: true),
    ])
    return loader
  }

  /// Opens the form in `cwd` and waits for the background check of that directory.
  private func opened(_ loader: Loader, in cwd: String?) async -> DirectoryBrowser {
    let browser = DirectoryBrowser(debounce: .milliseconds(5)) { await loader.load($0) }
    browser.start(cwd)
    await settle { loader.calls.contains(cwd) }
    try? await Task.sleep(for: .milliseconds(10))
    return browser
  }

  @Test("form in ~/Projects/demo/app: Change opens ~/Projects/demo, Choose names it; segments above the root are text")
  func opensOnParent() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    #expect(browser.chosen == Self.app && !browser.browsing && browser.canLaunch)
    browser.change()
    await settle { browser.view.status == .ready && browser.roots != nil }
    #expect(browser.browsing && !browser.canLaunch, "launch waits for a choice")
    #expect(browser.view.dir == Self.group && browser.target?.path == Self.group, "Choose takes the directory on screen")
    #expect(browser.chosen == Self.app, "browsing does not change the chosen directory")
    #expect(browser.crumbs.map(\.label) == ["~", "Projects", "demo"])
    #expect(browser.crumbs.map(\.leads) == [false, true, false], "~ is above the root, demo is where we are")
    #expect(browser.up == .directory(Self.projects), "Up goes to the parent the listing names")
  }

  @Test("a project that is a root opens the roots level: nothing to choose there, no Up")
  func rootProject() async {
    let loader = groupLoader()
    loader.listing(Self.projects, parent: nil, [])
    let browser = await opened(loader, in: Self.projects)
    browser.change()
    await settle { browser.view.status == .ready }
    #expect(browser.view.dir == nil && browser.target == nil, "the roots level is not a directory")
    #expect(browser.up == nil, "nothing above the roots level")
    #expect(browser.crumbs.isEmpty, "the roots level has no path")
  }

  @Test("two roots: a project in the second root, Up from a root to the roots level, segments above it are text")
  func twoRoots() async {
    let loader = Loader()
    let work = "/Users/d/Documents/Work"
    loader.listing(nil, parent: nil, [
      DirEntry(name: "Projects", path: Self.projects), DirEntry(name: "Work", path: work),
    ])
    loader.listing("\(work)/x", parent: work, [])
    loader.listing(work, parent: nil, [DirEntry(name: "x", path: "\(work)/x", git: true)])
    let browser = await opened(loader, in: "\(work)/x")
    browser.change()
    await settle { browser.view.status == .ready && browser.roots?.count == 2 }
    #expect(browser.view.dir == work && browser.target?.path == work)
    #expect(browser.crumbs.map(\.label) == ["~", "Documents", "Work"])
    #expect(browser.crumbs.allSatisfy { !$0.leads }, "Documents is above the root, Work is where we are")
    #expect(browser.up == .roots, "from a root with two roots: Up to the roots level")
    browser.goUp()
    await settle { browser.view.status == .ready && browser.view.dir == nil }
    #expect(browser.view.entries.map(\.name) == ["Projects", "Work"])
    #expect(browser.up == nil && browser.target == nil, "the roots level: no Up, nothing to choose")
  }

  @Test("demo: projects are roots; a tap opens one, Choose takes it without a warning (facts from its row)")
  func demo() async {
    let loader = Loader()
    let willow = "/Users/demo/Projects/willow"
    loader.listing(nil, parent: nil, [
      DirEntry(name: "willow", path: willow, git: true, history: true),
      DirEntry(name: "rarog", path: "/Users/demo/Projects/rarog", git: true, history: true),
    ])
    loader.listing(willow, parent: nil, [])
    let browser = await opened(loader, in: willow)
    browser.change()
    await settle { browser.view.status == .ready }
    #expect(browser.view.dir == nil && browser.target == nil)
    browser.enter("/Users/demo/Projects/rarog")
    await settle { browser.view.dir == "/Users/demo/Projects/rarog" && browser.view.status == .ready }
    #expect(browser.target?.name == "rarog")
    #expect(browser.target?.facts == DirFacts(git: true, history: true), "the row on the roots level knew them")
    browser.choose()
    #expect(browser.warning == nil && browser.chosen == "/Users/demo/Projects/rarog" && !browser.browsing)
  }

  @Test("a tap opens the folder (chosen directory unchanged), Up goes back; Choose takes the folder on screen")
  func tapOpensUpChoose() async {
    let loader = groupLoader()
    loader.listing(Self.projects, parent: nil, [DirEntry(name: "demo", path: Self.group)])
    let docs = "\(Self.group)/atlas-docs"
    loader.listing(docs, parent: Self.group, [])
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready && browser.roots != nil }
    browser.enter(docs)
    #expect(browser.up == nil && browser.target == nil, "no Up and nothing to choose while the listing loads")
    await settle { browser.view.dir == docs && browser.view.status == .ready }
    #expect(browser.chosen == Self.app, "opening a folder does not choose it")
    #expect(browser.target?.path == docs && browser.target?.name == "atlas-docs")
    #expect(browser.target?.facts == DirFacts(git: true, history: false), "facts from the row it was opened from")
    #expect(browser.up == .directory(Self.group))
    browser.goUp()
    await settle { browser.view.dir == Self.group && browser.view.status == .ready }
    #expect(browser.target?.path == Self.group && browser.up == .directory(Self.projects))
    browser.goUp()
    await settle { browser.view.dir == Self.projects && browser.view.status == .ready }
    #expect(browser.up == nil, "one root: Up stops at the root, never past it")
    browser.goUp()
    #expect(browser.view.dir == Self.projects && browser.view.status == .ready, "a disabled Up does nothing")
    browser.enter(Self.group)
    await settle { browser.view.dir == Self.group && browser.view.status == .ready }
    browser.enter(docs)
    await settle { browser.view.dir == docs && browser.view.status == .ready }
    browser.choose()
    #expect(browser.warning == nil, "a repository: no warning")
    #expect(browser.chosen == docs && !browser.browsing && browser.canLaunch)
    browser.change()
    await settle { browser.view.status == .ready }
    #expect(browser.view.dir == Self.group, "parent from the listing")
  }

  @Test("Cancel goes back to the state before: chosen directory, no selection, browser closed")
  func cancelRestores() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready }
    browser.enter("\(Self.group)/notatki")
    browser.type("rar")
    browser.cancel()
    #expect(browser.chosen == Self.app && !browser.browsing && browser.input.isEmpty)
    #expect(browser.canLaunch)
  }

  @Test("without a chosen directory the form opens on the roots level and Cancel keeps the browser")
  func noChosenDirectory() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: nil)
    await settle { browser.view.status == .ready }
    #expect(browser.browsing && browser.view.dir == nil && !browser.canLaunch)
    browser.cancel()
    #expect(browser.browsing, "nothing to go back to")
  }

  @Test("a late listing after Cancel or after opening another folder commits nothing")
  func lateReplies() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    let (slow, release) = AsyncStream<Void>.makeStream()
    loader.gates[Self.group] = slow
    browser.change()
    await settle { loader.calls.filter { $0 == Self.group }.count == 1 }
    browser.cancel()
    release.yield()
    try? await Task.sleep(for: .milliseconds(30))
    #expect(!browser.browsing && browser.chosen == Self.app, "the reply after Cancel does not reopen or choose")
    #expect(browser.view.listing == nil, "and does not reach the screen")

    let (slow2, release2) = AsyncStream<Void>.makeStream()
    loader.gates[Self.group] = slow2
    browser.change()
    await settle { loader.calls.filter { $0 == Self.group }.count == 2 }
    browser.enter("\(Self.group)/notatki")
    release2.yield()
    await settle { browser.view.status == .ready }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(browser.view.dir == "\(Self.group)/notatki" && browser.chosen == Self.app,
            "the opened folder stays, nothing chosen")
  }

  @Test("the reply for an older directory does not overwrite the newer one")
  func staleReply() async {
    let loader = Loader()
    let (slow, release) = AsyncStream<Void>.makeStream()
    loader.gates["/old"] = slow
    loader.listing("/old", parent: nil, [DirEntry(name: "stary", path: "/old/stary")])
    let browser = await opened(loader, in: nil)
    browser.enter("/old")
    browser.enter("/new")
    await settle { browser.view.dir == "/new" && browser.view.status == .ready }
    release.yield()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(browser.view.dir == "/new" && browser.view.entries.isEmpty)
  }

  @Test("a late roots answer does not overwrite the facts a newer roots listing brought")
  func lateRootsFacts() async {
    let loader = Loader()
    let willow = "/Users/demo/Projects/willow"
    let sub = "\(willow)/sub"
    loader.listing(nil, parent: nil, [DirEntry(name: "willow", path: willow, git: false, history: false)])
    loader.listing(sub, parent: willow, [])
    loader.listing(willow, parent: nil, [DirEntry(name: "sub", path: sub)])
    let browser = await opened(loader, in: sub)
    let (slow, release) = AsyncStream<Void>.makeStream()
    loader.onceGates[nil] = slow
    browser.change()
    await settle { loader.calls.contains(nil) && browser.view.status == .ready }
    loader.listing(nil, parent: nil, [DirEntry(name: "willow", path: willow, git: true, history: true)])
    browser.enter(nil)
    await settle { browser.view.dir == nil && browser.view.status == .ready }
    browser.enter(willow)
    await settle { browser.view.dir == willow && browser.view.status == .ready }
    release.yield()
    try? await Task.sleep(for: .milliseconds(30))
    #expect(browser.target?.facts == DirFacts(git: true, history: true), "the newer roots listing wins")
  }

  @Test("a plain value filters without a request; a path lists after the pause, Enter at once")
  func typing() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready }
    let before = loader.calls.count
    browser.type("docs")
    #expect(browser.view.entries.map(\.name) == ["atlas-docs"], "any part of a name")
    #expect(loader.calls.count == before, "a filter sends nothing")
    browser.type("\(Self.app)/")
    browser.flush()
    await settle { browser.view.dir == Self.app && browser.view.status == .ready }
    #expect(browser.target?.path == Self.app, "Choose takes the typed directory")
  }

  @Test("a directory without git and history warns before the choice; Choose Anyway commits, Cancel only closes it")
  func warning() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready }
    browser.enter("\(Self.group)/notatki")
    await settle { browser.view.dir == "\(Self.group)/notatki" && browser.view.status == .ready }
    browser.choose()
    let warning = try? #require(browser.warning)
    #expect(warning?.target.facts.known == true && browser.chosen == Self.app && browser.browsing)
    #expect(warning?.sentence == "~/Projects/demo/notatki nie jest repozytorium i nie było tu sesji. Agent dostanie dostęp do całego katalogu.")
    browser.dismissWarning()
    #expect(browser.warning == nil && browser.browsing && browser.chosen == Self.app)
    browser.choose()
    browser.chooseAnyway()
    #expect(browser.chosen == "\(Self.group)/notatki" && !browser.browsing && browser.warning == nil)
  }

  @Test("unknown facts (no listing showed the directory as a row) warn too; opening a folder drops the warning")
  func unknownWarns() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready }
    browser.choose()
    #expect(browser.warning?.target.facts == .unknown)
    #expect(browser.warning?.sentence.hasPrefix("Rarog nie wie, czy ~/Projects/demo ") == true)
    browser.enter("\(Self.group)/atlas-docs")
    #expect(browser.warning == nil, "opening a folder drops the warning")
  }

  @Test("the listing's own facts win over those remembered from its row; a typed path needs no row")
  func listingFacts() async {
    let loader = groupLoader()
    let notatki = "\(Self.group)/notatki"
    loader.replies[notatki] = .loaded(DirListing(path: notatki, parent: Self.group, entries: [], git: true, history: false))
    let browser = await opened(loader, in: Self.app)
    browser.change()
    await settle { browser.view.status == .ready }
    browser.enter(notatki)
    await settle { browser.view.dir == notatki && browser.view.status == .ready }
    #expect(browser.target?.facts == DirFacts(git: true, history: false), "the row said no git, the listing says git")
    browser.choose()
    #expect(browser.warning == nil && browser.chosen == notatki)
  }

  @Test("the warning concerns the choice in the window: opening in a directory and a pill never warn")
  func openingNeverWarns() async {
    let loader = groupLoader()
    loader.listing("/Users/d/Projects/plain", parent: Self.projects, [])
    let browser = await opened(loader, in: "/Users/d/Projects/plain")
    #expect(browser.warning == nil && browser.canLaunch)
    browser.pick("\(Self.group)/notatki/")
    #expect(browser.warning == nil && browser.chosen == "\(Self.group)/notatki" && browser.canLaunch)
  }

  @Test("a remembered directory that is gone falls back silently to the roots; Change with an unknown parent too")
  func fallback() async {
    let loader = groupLoader()
    loader.replies["/Users/d/Projects/zniknal"] = .refused("Ten katalog nie jest na liście projektów.")
    let browser = await opened(loader, in: "/Users/d/Projects/zniknal")
    await settle { browser.view.status == .ready }
    #expect(browser.chosen == nil && browser.browsing && browser.view.dir == nil)

    let offline = Loader()
    offline.replies["/x/y"] = .offline
    offline.replies["/x"] = .refused("Poza korzeniami.")
    let other = await opened(offline, in: "/x/y")
    #expect(other.chosen == "/x/y", "offline keeps the directory, the launch checks it")
    other.change()
    await settle { other.view.dir == nil && other.view.status == .ready }
    #expect(other.target == nil, "the lexical parent was refused: the roots level")
  }

  @Test("an ordinary listing error stands at the field and is retried")
  func errorRetry() async {
    let loader = groupLoader()
    loader.replies["/bad"] = .refused("Ten katalog nie jest na liście projektów.")
    let browser = await opened(loader, in: Self.app)
    browser.change()
    browser.enter("/bad")
    await settle { browser.failed }
    #expect(browser.view.status == .error("Ten katalog nie jest na liście projektów.") && browser.target == nil)
    loader.replies["/bad"] = nil
    browser.retry()
    await settle { browser.view.status == .ready }
    #expect(!browser.failed)
  }

  @Test("a retry keeps the filter in the field: the list after it matches the typed text")
  func retryKeepsFilter() async {
    let loader = groupLoader()
    let browser = await opened(loader, in: Self.app)
    let listing = loader.replies[Self.group]
    loader.replies[Self.group] = .offline
    browser.change()
    await settle { browser.failed }
    browser.type("docs")
    #expect(browser.failed && browser.view.filter == "docs")
    loader.replies[Self.group] = listing
    browser.retry()
    await settle { browser.view.status == .ready }
    #expect(browser.input == "docs" && browser.view.filter == "docs")
    #expect(browser.view.entries.map(\.name) == ["atlas-docs"], "the rows match the field")
  }
}

@Suite("browser path segments")
struct BreadcrumbsTests {
  @Test("home as ~, every directory a segment; segments at or below a root lead there, the last one does not")
  func segments() {
    let crumbs = Breadcrumbs.make("/Users/d/Projects/demo/", roots: ["/Users/d/Projects"])
    #expect(crumbs.map(\.label) == ["~", "Projects", "demo"])
    #expect(crumbs.map(\.path) == ["/Users/d", "/Users/d/Projects", "/Users/d/Projects/demo"])
    #expect(crumbs.map(\.leads) == [false, true, false])
    #expect(Breadcrumbs.make("/srv/code/a", roots: ["/srv"]).map(\.label) == ["/", "srv", "code", "a"])
    #expect(Breadcrumbs.make("/srv/code/a", roots: ["/srv"]).map(\.leads) == [false, true, true, false])
    #expect(Breadcrumbs.make("/Users/d/Projects/x", roots: ["/Users/d"]).map(\.leads) == [true, true, false], "root ~")
    #expect(Breadcrumbs.make("/Users/d/Projects/x", roots: nil).allSatisfy { !$0.leads }, "roots unknown: text")
    #expect(Breadcrumbs.make("/Users/d/Projectsy/x", roots: ["/Users/d/Projects"]).allSatisfy { !$0.leads },
            "a name prefix is not a root")
  }
}
