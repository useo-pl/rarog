import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// New Directory in the browser: the button only where the server creates directories, the request names the listed
// directory and the trimmed name, a created directory is entered and chosen without the warning, a late reply
// changes nothing, a refusal stands under the field, and an existing name lists the parent again. Owner: session control.

extension DirectoryBrowserTests {
  @MainActor
  final class Creator {
    var calls: [(parent: String, name: String)] = []
    var replies: [DirectoryCreateOutcome] = []
    var gate: AsyncStream<Void>?

    func create(_ parent: String, _ name: String) async -> DirectoryCreateOutcome {
      calls.append((parent, name))
      let reply = replies.isEmpty ? .failed : replies.removeFirst()
      if let gate { for await _ in gate { break } }
      return reply
    }
  }

  static let notes = "\(useo)/notes"

  /// `~/Projects/USEO` listed with `canCreate`, opened from the project `app`; its new directory `notes` lists empty
  /// and, like every directory the server creates, has neither `git` nor history.
  private func creatable(_ creator: Creator?, canCreate: Bool? = true) async -> (DirectoryBrowser, Loader) {
    let loader = Loader()
    loader.listing(nil, parent: nil, [DirEntry(name: "Projects", path: Self.projects)])
    loader.listing(Self.app, parent: Self.useo, [])
    loader.replies[Self.useo] = .loaded(DirListing(
      path: Self.useo, parent: Self.projects,
      entries: [DirEntry(name: "app", path: Self.app, git: true, history: true)], canCreate: canCreate))
    loader.replies[Self.notes] = .loaded(DirListing(
      path: Self.notes, parent: Self.useo, entries: [], git: false, history: false, canCreate: canCreate))
    var create: DirectoryBrowser.Creator?
    if let creator { create = { parent, name in await creator.create(parent, name) } }
    let browser = DirectoryBrowser(debounce: .milliseconds(5), load: { await loader.load($0) }, create: create)
    browser.start(Self.app)
    await settle { loader.calls.contains(Self.app) }
    try? await Task.sleep(for: .milliseconds(10))
    browser.change()
    await settle { browser.view.status == .ready && browser.view.dir == Self.useo }
    return (browser, loader)
  }

  private static let created = DirectoryCreateOutcome.created(DirEntry(name: "notes", path: notes))

  @Test("New Directory shows only when the listing says canCreate true and the form can create")
  func createOnlyWhenAllowed() async {
    let (allowed, _) = await creatable(Creator())
    #expect(allowed.canCreate)
    allowed.enter(nil)
    await settle { allowed.view.status == .ready && allowed.view.dir == nil }
    #expect(!allowed.canCreate, "the roots level carries no canCreate")
    allowed.openCreate()
    #expect(allowed.creating == nil, "nothing opens where the button is hidden")

    for (canCreate, why) in [(Bool?.none, "an older server sends no field"), (false, "the server does not create")] {
      let (browser, _) = await creatable(Creator(), canCreate: canCreate)
      #expect(!browser.canCreate, "\(why)")
    }
    let (noCreator, _) = await creatable(nil)
    #expect(!noCreator.canCreate, "a form without the create action")
  }

  @Test("a name typed on the listing of D sends parent D and the trimmed name; the new directory opens, Choose takes it without the warning")
  func createEntersAndChooses() async {
    let creator = Creator()
    creator.replies = [Self.created]
    let (browser, loader) = await creatable(creator)
    browser.openCreate()
    browser.typeName("   ")
    #expect(browser.creating?.canSend == false, "a blank name cannot be sent")
    browser.submitCreate()
    #expect(creator.calls.isEmpty)
    browser.typeName("  notes ")
    #expect(browser.creating?.canSend == true)
    browser.submitCreate()
    await settle { browser.view.dir == Self.notes && browser.view.status == .ready }
    #expect(creator.calls.map(\.parent) == [Self.useo] && creator.calls.map(\.name) == ["notes"])
    #expect(loader.calls.last == Self.notes && browser.creating == nil, "the browser lists the new directory")
    #expect(browser.target?.path == Self.notes && browser.chosen == Self.app, "entering chooses nothing")
    browser.choose()
    #expect(browser.warning == nil && browser.chosen == Self.notes, "a directory created here needs no warning")
  }

  @Test("a sent name is sent once: a second Enter while the request is on its way sends nothing")
  func createSendsOnce() async {
    let creator = Creator()
    creator.replies = [Self.created]
    let (gate, release) = AsyncStream<Void>.makeStream()
    creator.gate = gate
    let (browser, _) = await creatable(creator)
    browser.openCreate()
    browser.typeName("notes")
    browser.submitCreate()
    #expect(browser.creating?.sending == true && browser.creating?.canSend == false)
    browser.submitCreate()
    release.yield()
    await settle { browser.view.dir == Self.notes }
    #expect(creator.calls.count == 1)
  }

  @Test("a late reply after the field's Cancel, the browser's Cancel or another navigation changes nothing")
  func lateCreateReplies() async {
    for leave in ["field cancel", "browser cancel", "navigation"] {
      let creator = Creator()
      creator.replies = [Self.created]
      let (gate, release) = AsyncStream<Void>.makeStream()
      creator.gate = gate
      let (browser, loader) = await creatable(creator)
      browser.openCreate()
      browser.typeName("notes")
      browser.submitCreate()
      await settle { creator.calls.count == 1 }
      switch leave {
      case "field cancel": browser.cancelCreate()
      case "browser cancel": browser.cancel()
      default: browser.enter(Self.app)
      }
      release.yield()
      try? await Task.sleep(for: .milliseconds(30))
      #expect(browser.creating == nil, "\(leave): the field stays closed")
      #expect(!loader.calls.contains(Self.notes) && browser.view.dir != Self.notes, "\(leave): nothing entered")
      #expect(browser.chosen == Self.app, "\(leave): nothing chosen")
      if leave == "field cancel" {
        #expect(browser.browsing && browser.view.dir == Self.useo && browser.view.status == .ready)
        browser.enter(Self.notes)
        await settle { browser.view.dir == Self.notes && browser.view.status == .ready }
        browser.choose()
        #expect(browser.warning != nil, "the abandoned reply did not mark the directory as created here")
      }
    }
  }

  @Test("a refusal stands under the field with the name kept; a refusal without a sentence and the network have their own")
  func createRefused() async {
    let creator = Creator()
    creator.replies = [.refused("That name can't be used."), .refused(nil), .offline]
    let (browser, loader) = await creatable(creator)
    browser.openCreate()
    browser.typeName(".hidden")
    let listings = loader.calls.count
    for expected in ["That name can't be used.", UICopy.createDirFailed, UICopy.serverSilent] {
      browser.submitCreate()
      await settle { browser.creating?.error != nil }
      #expect(browser.creating?.error == expected)
      #expect(browser.creating?.name == ".hidden" && browser.creating?.sending == false)
      browser.typeName(".hidden")
      #expect(browser.creating?.error == nil, "editing the name clears the sentence")
    }
    #expect(loader.calls.count == listings && browser.view.dir == Self.useo, "a refusal lists nothing")
  }

  @Test("an existing name: the sentence stays under the field and the parent is listed again")
  func createExists() async {
    let creator = Creator()
    creator.replies = [.exists("Something with that name already exists here.")]
    let (browser, loader) = await creatable(creator)
    loader.replies[Self.useo] = .loaded(DirListing(
      path: Self.useo, parent: Self.projects,
      entries: [DirEntry(name: "app", path: Self.app, git: true, history: true), DirEntry(name: "notes", path: Self.notes)],
      canCreate: true))
    browser.openCreate()
    browser.typeName("notes")
    browser.submitCreate()
    await settle { loader.calls.filter { $0 == Self.useo }.count == 2 && browser.view.status == .ready }
    #expect(browser.view.entries.map(\.name) == ["app", "notes"], "the listing shows what is there now")
    #expect(browser.creating?.error == "Something with that name already exists here.")
    #expect(browser.creating?.name == "notes" && browser.creating?.sending == false)
    #expect(browser.view.dir == Self.useo && browser.chosen == Self.app)
  }
}
