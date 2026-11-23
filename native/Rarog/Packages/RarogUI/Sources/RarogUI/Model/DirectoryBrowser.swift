import Foundation
import Observation
import RarogContract
import RarogCore

/// Project choice in the New Session form: the chosen directory and the directory
/// browser that changes it. Owner: session control.
///
/// - `chosen` is the only directory a launch and the Conversations section use. Browsing never changes it: only
///   Choose (``choose()``, ``chooseAnyway()``) and a recent project pill (``pick(_:)``) do.
/// - Change and More… (``change()``) open the browser on the PARENT of the chosen directory (its row is marked
///   current); a chosen root opens the roots level. A tap on a row opens it (``enter(_:)``), Up (``goUp()``) goes to
///   the parent the listing names, the path segments at or below a root go there, Cancel (``cancel()``) goes back to
///   the state before. Choose takes the directory on screen (``target``); the roots level has nothing to choose.
/// - Choosing a directory that is neither a `git` repository nor has Claude Code history, or whose facts the app
///   does not know (an older server), first shows a warning with Choose Anyway (``ChoiceWarning``).
/// - Every listing carries a request number: a late reply (after Cancel, Choose or another navigation) changes
///   nothing, and a listing never commits a choice. The field filters the listing on any part of a name; a value
///   that starts with `/` or `~` is a path (typing lists after 250 ms of silence, Enter at once).
/// - New Directory (`DirectoryBrowser+Create.swift`) creates a directory in the listed one and enters it; Choose takes
///   a directory created in this form without the warning.
@MainActor
@Observable
public final class DirectoryBrowser {
  /// Pause in typing before a path is listed.
  public static let debounce: Duration = .milliseconds(250)

  public typealias Loader = @MainActor (String?) async -> DirectoryOutcome
  /// New Directory: the parent (the listed directory) and the trimmed name.
  public typealias Creator = @MainActor (_ parent: String, _ name: String) async -> DirectoryCreateOutcome

  /// The directory the session launches in and Conversations list; `nil` until one is chosen.
  public private(set) var chosen: String?
  /// The browser is open: the Project card shows it, launching waits for a choice.
  public private(set) var browsing = false
  /// Filter or path field of the browser.
  public private(set) var input = ""
  /// Listing on screen (`dir == nil` = the roots level).
  public private(set) var view = DirectoryView()
  /// Roots from a roots level listing; `nil` = not known yet (path segments stay plain text).
  public private(set) var roots: [String]?
  /// Choice waiting for Choose Anyway.
  public private(set) var warning: ChoiceWarning?
  /// The open New Directory field; `nil` = closed.
  public internal(set) var creating: DirectoryCreate?

  @ObservationIgnored private let load: Loader
  @ObservationIgnored let create: Creator?
  @ObservationIgnored private let wait: Duration
  /// Number of the navigation (or New Directory request) the screen waits for; a reply with an older one is late.
  @ObservationIgnored var token = 0
  @ObservationIgnored private var probeToken = 0
  @ObservationIgnored private var rootsLoading = false
  /// Parent of the chosen directory: `.some(nil)` = the roots level, `nil` = not known (a lexical guess with a
  /// fallback to the roots level).
  @ObservationIgnored private var chosenParent: String??
  @ObservationIgnored private var typing: Task<Void, Never>?
  /// `git` and history of every directory a listing showed as a row, by path: Choose on a directory the user opened
  /// from its row knows them, although the listing of the directory itself carries none yet. Each entry keeps the
  /// number of the request it came from, so a late answer never overwrites facts from a newer one.
  @ObservationIgnored private var seen: [String: (facts: DirFacts, request: Int)] = [:]
  /// Number of the last listing request sent (probe, browser and roots level alike).
  @ObservationIgnored private var requests = 0
  /// Directories created in this form (normalized paths): choosing one needs no warning.
  @ObservationIgnored var created: Set<String> = []

  /// - Parameter create: New Directory; `nil` = the form has no such action (the button never shows).
  public init(debounce: Duration = DirectoryBrowser.debounce, load: @escaping Loader, create: Creator? = nil) {
    wait = debounce
    self.load = load
    self.create = create
  }

  /// A launch needs a chosen directory and a closed browser (the footer says "Choose a project to launch").
  public var canLaunch: Bool { chosen != nil && !browsing }

  /// The listing failed (network, 401): it is retried once when the connection comes back.
  public var failed: Bool {
    if case .error = view.status { return true }
    return false
  }

  // MARK: - Choice outside the browser

  /// Opening the form: a known directory (from the route or the last visited project) is chosen at once and checked
  /// in the background; one the server refuses falls back silently to browsing the roots. Without one the browser
  /// opens on the roots level.
  public func start(_ cwd: String?) {
    guard let cwd = cwd.map(ProjectPath.normalized), !cwd.isEmpty else {
      chosen = nil
      browsing = true
      navigate(nil)
      return
    }
    adopt(cwd)
  }

  /// A recent project pill: chosen at once, without a warning (it comes from the CLI history).
  public func pick(_ cwd: String) {
    let cwd = ProjectPath.normalized(cwd)
    close()
    adopt(cwd)
  }

  // MARK: - Browser

  /// Change and More…: the browser on the parent of the chosen directory.
  public func change() {
    clearField()
    warning = nil
    browsing = true
    guard let chosen else {
      navigate(nil)
      return
    }
    if let parent = chosenParent {
      navigate(parent)
    } else {
      navigate(Self.lexicalParent(chosen), fallbackToRoots: true)
    }
    loadRootsIfNeeded()
  }

  /// A tap on a row or a path segment (`nil` = the roots level): opens it, chooses nothing.
  public func enter(_ path: String?) {
    clearField()
    warning = nil
    navigate(path)
    loadRootsIfNeeded()
  }

  /// Where Up leads from the listing on screen: the parent the listing names; from a root the roots level when there
  /// is more than one root (or the roots are not known yet). `nil` = Up is disabled: the roots level, a single root,
  /// a listing on its way or a failed one.
  public var up: UpStep? {
    guard view.status == .ready, let listing = view.listing, listing.path != nil else { return nil }
    if let parent = listing.parent { return .directory(parent) }
    return (roots?.count ?? 2) > 1 ? .roots : nil
  }

  /// Up: one level towards the roots, never past a root.
  public func goUp() {
    switch up {
    case let .directory(parent): enter(parent)
    case .roots: enter(nil)
    case nil: return
    }
  }

  /// Typing in the field: a filter changes the list at once; a path is listed after the pause.
  public func type(_ value: String) {
    input = value
    warning = nil
    typing?.cancel()
    guard Self.isPath(value) else {
      typing = nil
      view.filter = value.trimmingCharacters(in: .whitespaces)
      return
    }
    let wait = wait
    typing = Task { [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled else { return }
      self?.commitTyped()
    }
  }

  /// Enter in the field: go to the typed path now (it does not launch).
  public func flush() {
    typing?.cancel()
    typing = nil
    if Self.isPath(input) { commitTyped() }
  }

  /// Retry after a failure (the connection came back). The filter goes with it, so the rows match the field.
  public func retry() {
    guard browsing, failed else { return }
    navigate(view.dir, filter: view.filter)
  }

  /// What Choose would choose: the listed directory itself; `nil` on the roots level and while a listing loads.
  public var target: ChoiceTarget? {
    guard view.status == .ready, let listing = view.listing, let path = listing.path else { return nil }
    return ChoiceTarget(
      path: path, facts: facts(of: listing), parent: .some(listing.parent),
      createdHere: created.contains(ProjectPath.normalized(path)))
  }

  /// Choose <name>: a directory without `git` and history (or with unknown facts) asks first, unless it was created
  /// in this form.
  public func choose() {
    guard let target else { return }
    if target.needsWarning {
      warning = ChoiceWarning(target: target)
      return
    }
    commit(target)
  }

  /// Choose Anyway in the warning.
  public func chooseAnyway() {
    guard let warning else { return }
    commit(warning.target)
  }

  /// Cancel in the warning: back to browsing, nothing chosen.
  public func dismissWarning() {
    warning = nil
  }

  /// Cancel in the browser: back to the state before Change. Without a chosen directory there is nothing to go back
  /// to, so the browser stays.
  public func cancel() {
    guard chosen != nil else { return }
    close()
  }

  /// Path segments of the listed directory; those at or below a known root lead there.
  public var crumbs: [Crumb] {
    guard let path = view.listing?.path ?? view.dir, path.hasPrefix("/") else { return [] }
    return Breadcrumbs.make(path, roots: roots)
  }

  // MARK: - Internals

  private func adopt(_ cwd: String) {
    chosen = cwd
    chosenParent = nil
    probeToken += 1
    let mine = probeToken
    let request = nextRequest()
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.load(cwd)
      if case let .loaded(listing) = outcome { self.remember(listing, request: request) }
      self.finishProbe(outcome, cwd: cwd, token: mine)
    }
  }

  private func finishProbe(_ outcome: DirectoryOutcome, cwd: String, token mine: Int) {
    guard mine == probeToken, chosen == cwd else { return }
    switch outcome {
    case let .loaded(listing):
      chosenParent = .some(listing.parent)
    case .refused:
      // The remembered directory is gone or outside the roots: browse the roots instead, silently.
      chosen = nil
      chosenParent = nil
      if !browsing {
        browsing = true
        navigate(nil)
      }
    case .offline, .timedOut, .failed, .loggedOut:
      return
    }
  }

  private func commit(_ target: ChoiceTarget) {
    chosen = ProjectPath.normalized(target.path)
    chosenParent = target.parent
    probeToken += 1
    close()
  }

  private func close() {
    typing?.cancel()
    typing = nil
    token += 1
    browsing = false
    warning = nil
    creating = nil
    input = ""
  }

  private func clearField() {
    typing?.cancel()
    typing = nil
    input = ""
    view.filter = ""
  }

  private func commitTyped() {
    let text = input.trimmingCharacters(in: .whitespaces)
    let (dir, filter) = PathField.parse(text == "~" ? "~/" : text)
    view.filter = filter
    if let dir, dir == view.dir || dir == view.listing?.path, view.status == .ready { return }
    navigate(dir, filter: filter)
    loadRootsIfNeeded()
  }

  /// Lists `dir`. Any navigation closes the New Directory field: it belonged to the directory on screen.
  func navigate(_ dir: String?, filter: String = "", fallbackToRoots: Bool = false) {
    token += 1
    let mine = token
    let request = nextRequest()
    creating = nil
    view = DirectoryView(dir: dir, filter: filter, status: .loading, listing: nil)
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.load(dir)
      if case let .loaded(listing) = outcome { self.remember(listing, request: request) }
      self.finish(outcome, dir: dir, token: mine, fallbackToRoots: fallbackToRoots)
    }
  }

  private func finish(_ outcome: DirectoryOutcome, dir: String?, token mine: Int, fallbackToRoots: Bool) {
    guard mine == token, browsing else { return }
    switch outcome {
    case let .loaded(listing):
      view.listing = listing
      view.status = .ready
      if listing.path == nil { roots = listing.entries.map(\.path) }
    case .loggedOut:
      return
    default:
      if fallbackToRoots {
        navigate(nil)
        return
      }
      view.listing = nil
      view.status = .error(UICopy.directoryError(outcome))
    }
  }

  /// Roots for the path segments: one roots level request per form, apart from the listing on screen.
  private func loadRootsIfNeeded() {
    guard roots == nil, !rootsLoading else { return }
    rootsLoading = true
    let request = nextRequest()
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.load(nil)
      self.rootsLoading = false
      if case let .loaded(listing) = outcome { self.remember(listing, request: request) }
      if case let .loaded(listing) = outcome, listing.path == nil, self.roots == nil {
        self.roots = listing.entries.map(\.path)
      }
    }
  }

  func nextRequest() -> Int {
    requests += 1
    return requests
  }

  /// Rows of every answer are kept, also of one the screen no longer waits for, unless a newer request already
  /// reported the same directory.
  func remember(_ listing: DirListing, request: Int) {
    for entry in listing.entries {
      let path = ProjectPath.normalized(entry.path)
      if let known = seen[path], known.request > request { continue }
      seen[path] = (DirFacts(entry: entry), request)
    }
  }

  /// Facts of the listed directory: its own when the listing carries them, otherwise those of its row in an earlier
  /// listing, otherwise unknown.
  private func facts(of listing: DirListing) -> DirFacts {
    let own = DirFacts(listing: listing)
    guard own == .unknown, let path = listing.path else { return own }
    return seen[ProjectPath.normalized(path)]?.facts ?? own
  }

  static func isPath(_ value: String) -> Bool {
    let text = value.trimmingCharacters(in: .whitespaces)
    return text.hasPrefix("/") || text.hasPrefix("~")
  }

  static func lexicalParent(_ path: String) -> String? {
    let path = ProjectPath.normalized(path)
    guard let cut = path.lastIndex(of: "/") else { return nil }
    return cut == path.startIndex ? (path == "/" ? nil : "/") : String(path[..<cut])
  }
}

/// Where Up leads: a parent directory or the roots level.
public enum UpStep: Sendable, Equatable {
  case directory(String)
  case roots
}

/// What Choose acts on: the path, what the app knows about it and the directory it was listed in.
public struct ChoiceTarget: Sendable, Equatable {
  public var path: String
  public var facts: DirFacts
  /// Parent for the next Change: `.some(nil)` = the roots level, `nil` = not known.
  var parent: String??
  /// Created by New Directory in this form: empty by design, so its missing `git` and history are no surprise.
  var createdHere = false

  public var name: String { PathText.projectName(path) }
  /// Choose asks first: neither `git` nor history is known, and the directory was not created here.
  public var needsWarning: Bool { facts.needsWarning && !createdHere }
}

/// `git` and CLI history of one directory; `nil` = unknown.
public struct DirFacts: Sendable, Equatable {
  public var git: Bool?
  public var history: Bool?

  public static let unknown = DirFacts(git: nil, history: nil)

  public init(git: Bool?, history: Bool?) {
    self.git = git
    self.history = history
  }

  init(entry: DirEntry) {
    self.init(git: entry.git, history: entry.history)
  }

  /// The listed directory itself: `nil` fields stay unknown — the roots level and an older server send none.
  init(listing: DirListing) {
    self.init(git: listing.git, history: listing.history)
  }

  /// A warning before the choice: neither a repository nor history is known for it.
  public var needsWarning: Bool { git != true && history != true }
  /// Both facts are known (and so both false when ``needsWarning``).
  public var known: Bool { git != nil && history != nil }
}

/// Warning before choosing a directory without `git` and history.
public struct ChoiceWarning: Sendable, Equatable {
  public var target: ChoiceTarget

  public var sentence: String { UICopy.chooseWarning(PathText.shortPath(target.path), known: target.facts.known) }
}

/// One segment of the browser path: `~` for the home directory, then directory names.
public struct Crumb: Sendable, Equatable, Identifiable {
  public var label: String
  public var path: String
  /// The segment leads to its directory: at or below a known root, and not the listed directory itself.
  public var leads: Bool

  public var id: String { path }
}

/// Path segments of the browser: segments above a root stay plain text, because the server lists nothing
/// outside the roots.
public enum Breadcrumbs {
  public static func make(_ path: String, roots: [String]?) -> [Crumb] {
    let path = ProjectPath.normalized(path)
    var crumbs: [Crumb] = []
    var rest = Substring(path)
    var current: String
    if let home = path.firstMatch(of: /^\/(?:Users|home)\/[^\/]+/) {
      current = String(home.output)
      crumbs.append(Crumb(label: "~", path: current, leads: false))
      rest = path[home.range.upperBound...]
    } else {
      current = ""
      crumbs.append(Crumb(label: "/", path: "/", leads: false))
    }
    for segment in rest.split(separator: "/") {
      current += "/\(segment)"
      crumbs.append(Crumb(label: String(segment), path: current, leads: false))
    }
    let known = (roots ?? []).map(ProjectPath.normalized)
    return crumbs.map { crumb in
      var crumb = crumb
      crumb.leads = crumb.path != path && known.contains { root in
        crumb.path == root || crumb.path.hasPrefix(root == "/" ? "/" : "\(root)/")
      }
      return crumb
    }
  }
}
