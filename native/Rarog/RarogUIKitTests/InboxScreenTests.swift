import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The Inbox button on the real list and the Inbox screen on a real store: the button follows the server's
/// capability and stands beside the filter track without a row of its own, the cards draw the transcript's
/// question stripe and decision cards, new cards below the top keep the screen still and raise the pill, and a
/// removal goes at once. With `RAROG_LIST_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR` for `xcodebuild`)
/// the tests also write `inbox-*.png`.
@MainActor
final class InboxScreenTests: XCTestCase {
  // MARK: - Button on the list

  /// The Inbox button stands on the right of the filter track: with the capability it appears there and the list's
  /// top inset keeps its height, so the first tree row does not move.
  func testButtonStandsOnlyWithInbox() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)], inbox: false)
    let window = rig.window(NavigationStack {
      SessionListView(store: rig.store, navigation: rig.navigation, memory: ConnectionMemory(), besideDetail: false)
    })
    defer { window.isHidden = true }
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first { $0.numberOfSections > 0 })
    let without = list.adjustedContentInset.top
    let bare = Self.image(window)
    XCTAssertFalse(rig.store.state.inboxAvailable)

    rig.store.dispatch(.versionProbed(try Rig.version(inbox: true)))
    Self.spin()
    XCTAssertEqual(list.adjustedContentInset.top, without, accuracy: 0.5, "the button adds no row to the top inset")
    XCTAssertNotEqual(Self.image(window), bare, "the button appears beside the track")
    try Self.snapshot(window, "inbox-button")

    rig.store.dispatch(.versionProbed(try Rig.version(inbox: false)))
    Self.spin()
    XCTAssertEqual(list.adjustedContentInset.top, without, accuracy: 0.5, "a server without Inbox: no row")
  }

  func testInboxRouteHasNoInspectorAndNoCmdI() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    rig.navigation.openInbox()
    XCTAssertEqual(rig.navigation.detail, .inbox)
    XCTAssertNil(rig.navigation.inspectorSession(rig.store.state), "no inspector on the Inbox")
    XCTAssertFalse(rig.navigation.shortcutMenu(rig.store.state).canToggleInspector, "Cmd+I opens nothing")
    XCTAssertFalse(rig.navigation.inspectorVisible(rig.store.state))
  }

  // MARK: - Cards

  func testQuestionStripeUsesTheTranscriptDelegate() throws {
    let long = (1...30).map { "Line \($0) of the work." }.joined(separator: "\n")
    let text = "First paragraph.\n\n\(long)\n\n**To you:** deploy now?"
    let rig = try Rig(cards: [Rig.Card("a", minute: 1, text: text)])
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let texts = Self.views(MessageContentView.self, in: window)
    let lead = try XCTUnwrap(texts.first { $0.textView.accessibilityIdentifier == "inbox.text.a" }, "the lead")
    XCTAssertEqual(lead.textView.text, "First paragraph.", "a folded card shows its first paragraph")
    let question = try XCTUnwrap(
      texts.first { $0.textView.accessibilityIdentifier == "inbox.question.a" }, "the question block of a folded card")
    let attributed = try XCTUnwrap(question.textView.attributedText)
    var striped = false
    attributed.enumerateAttribute(.rarogDecoration, in: NSRange(location: 0, length: attributed.length)) { value, _, _ in
      if (value as? MarkdownDecoration)?.question == true { striped = true }
    }
    XCTAssertTrue(striped, "the To you: block carries the transcript's question decoration")
    XCTAssertTrue(
      question.textView.textLayoutManager?.delegate is MarkdownLayoutDelegate, "the stripe is drawn by the delegate")

    rig.screen(in: window).toggleFold("a")
    Self.spin()
    let whole = Self.views(MessageContentView.self, in: window)
    XCTAssertNil(whole.first { $0.textView.accessibilityIdentifier == "inbox.question.a" }, "Show all: one text")
    XCTAssertTrue(
      whole.first { $0.textView.accessibilityIdentifier == "inbox.text.a" }?.textView.text.contains("Line 30") == true)
    try Self.snapshot(window, "inbox-question")
  }

  func testPermissionCardAllowsFromTheInbox() async throws {
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1, kind: "decision", state: "waiting-permission",
                       dialog: #"{"kind":"permission","requestId":"p1"}"#)],
      transport: UIKitTransport(onDecidePermission: { body in await sent.add(body.decision.rawValue) }))
    try rig.pendingPermission("a")
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let read = await Self.waitUntil { rig.store.state.inboxItems.first?.card != nil }
    XCTAssertTrue(read, "the card text came")
    let cards = rig.store.state.inboxCardModels
    XCTAssertEqual(cards.first?.footer, .decision, "the card takes its decision from the transcript")
    guard case let .permission(request, _)? = rig.store.state.inboxDecision("a") else {
      return XCTFail("no permission decision on the card")
    }
    let host = rig.decisions(in: window)
    let model = try XCTUnwrap(host.permissionCard(request, state: rig.store.state), "the transcript's permission card")
    XCTAssertTrue(model.canAllow)
    host.decide(model, .allow, store: rig.store)
    XCTAssertNotNil(rig.store.state.inbox.held["a"], "the card is held before the request leaves")
    let decided = await Self.waitUntil {
      let values = await sent.values
      return values == ["allow"]
    }
    let values = await sent.values
    XCTAssertTrue(decided, "Allow went out: \(values)")
    try Self.snapshot(window, "inbox-permission")
  }

  /// A dialog in the pane without a card: the dismiss request needs the signature of the transcript's pane dialog
  /// card, so the card offers "Open session" only until the Inbox's one transcript read brings the snapshot, and then
  /// Esc goes out. When the card showed "Dismiss dialog" without the transcript, the tap sent nothing.
  func testPaneDialogDismissesAfterTheTranscriptRead() async throws {
    let streams = Recorder()
    let sent = Recorder()
    let snapshot = #"""
      {"type":"transcript-snapshot","sessionId":"a","messages":[],"pendingPermissions":[],"pendingQuestions":[]}
      """#
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1, kind: "decision", state: "waiting-permission", dialog: #"{"kind":"panel"}"#)],
      transport: UIKitTransport(
        onOpenStream: { scope async throws(TransportError) -> [String] in
          guard case let .session(id) = scope else { throw UIKitTransport.refusal("openStream(global)") }
          await streams.add(id)
          return [snapshot]
        },
        onDecideDialog: { sessionId, body in await sent.add("\(sessionId):\(body.decision.rawValue)") }))
    XCTAssertNil(
      InboxDecisionHost().dialogCard("a", state: rig.store.state), "no dismiss before the transcript gives the dialog")
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    XCTAssertEqual(rig.store.state.inboxCardModels.first?.footer, .paneDialog)
    let host = rig.decisions(in: window)
    let loaded = await Self.waitUntil { host.dialogCard("a", state: rig.store.state) != nil }
    let opened = await streams.values
    XCTAssertTrue(loaded, "the pane dialog card after the transcript read")
    XCTAssertEqual(opened, ["a"], "one transcript read of the card's session")
    Self.spin()
    let dialog = try XCTUnwrap(host.dialogCard("a", state: rig.store.state))
    XCTAssertEqual(dialog.denyLabel, UICopy.herdrDialog(nil, reason: nil, cliDialog: nil).denyLabel)
    XCTAssertFalse(dialog.channelDead)
    try Self.snapshot(window, "inbox-pane-dialog")

    host.decideDialog(dialog, .deny, store: rig.store)
    XCTAssertNotNil(rig.store.state.inbox.held["a"], "the card is held before the request leaves")
    let dismissed = await Self.waitUntil {
      let values = await sent.values
      return values == ["a:deny"]
    }
    let values = await sent.values
    XCTAssertTrue(dismissed, "Esc went out: \(values)")
  }

  /// iPhone: the app's split collapsed to a stack. "Open session" pushes the session above the Inbox, so the stack's
  /// pop (Back, the edge swipe) uncovers the Inbox. When the session replaced the Inbox in place, the pop went to the
  /// list and the Inbox was pushed back over it a moment later: the list flashed.
  func testOpenSessionOnThePhoneIsPushedAboveTheInbox() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 2), Rig.Card("b", minute: 1)])
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.traitOverrides.horizontalSizeClass = .compact
    window.rootViewController = UIHostingController(rootView: MainSplitView(
      store: rig.store, navigation: rig.navigation, memory: ConnectionMemory(),
      transcriptLink: TranscriptConnectionMemory(), drafts: ComposerDrafts()
    ).environment(rig.navigation).environment(rig.toasts))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    rig.navigation.openInbox()
    rig.store.inboxOpened()
    Self.spin()
    let stack = try XCTUnwrap(Self.stack(in: window), "the collapsed split's stack")
    let depth = stack.viewControllers.count
    let inbox = try XCTUnwrap(rig.controller(in: window), "the Inbox on screen")

    inbox.actions.open("a")
    Self.spin()
    XCTAssertEqual(rig.navigation.detail, .session("a"), "the session stays on the route")
    XCTAssertEqual(stack.viewControllers.count, depth + 1, "the session is pushed above the Inbox")
    XCTAssertTrue(rig.navigation.inboxStands)

    stack.popViewController(animated: true)
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    XCTAssertEqual(stack.viewControllers.count, depth, "the pop uncovers the Inbox, not the list")
    Self.spin()
    XCTAssertEqual(rig.navigation.detail, .inbox, "Back from the session returns to the Inbox")
    XCTAssertEqual(stack.viewControllers.count, depth, "the Inbox stays without a second push")
    XCTAssertTrue(rig.controller(in: window) === inbox, "the same Inbox screen, not a new one")
  }

  /// iPhone: a Claude session standing in a Rarog terminal takes the terminal's route right after it opens
  /// (`settleHostedRoute`, the root's observer). The pushed screen stays, and Back still uncovers the Inbox with its
  /// held cards. When the route change dropped the Inbox origin, the stack popped to the list and the holds ended.
  func testHostedSessionFromTheInboxKeepsTheInboxBehindIt() throws {
    let terminal = "0123456789abcdef"
    let rig = try Rig(cards: [
      Rig.Card("a", minute: 2, session: #","termId":"\#(terminal)""#), Rig.Card("b", minute: 1),
    ])
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    window.traitOverrides.horizontalSizeClass = .compact
    window.rootViewController = UIHostingController(rootView: MainSplitView(
      store: rig.store, navigation: rig.navigation, memory: ConnectionMemory(),
      transcriptLink: TranscriptConnectionMemory(), drafts: ComposerDrafts()
    ).environment(rig.navigation).environment(rig.toasts))
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    rig.navigation.openInbox()
    rig.store.inboxOpened()
    Self.spin()
    let stack = try XCTUnwrap(Self.stack(in: window), "the collapsed split's stack")
    let depth = stack.viewControllers.count
    let inbox = try XCTUnwrap(rig.controller(in: window), "the Inbox on screen")

    rig.store.holdInboxCard("b")
    inbox.actions.open("a")
    Self.spin()
    XCTAssertEqual(stack.viewControllers.count, depth + 1, "the session is pushed above the Inbox")
    let pushed = stack.topViewController
    rig.navigation.settleHostedRoute(rig.store.state)
    // The root's mirror of the route (`RarogRootView`): leaving the Inbox ends the holds.
    if !rig.navigation.inboxStands { rig.store.inboxClosed() }
    Self.spin()
    XCTAssertEqual(rig.navigation.detail, .terminal(terminal), "the screen stands on its terminal's route")
    XCTAssertTrue(rig.navigation.inboxStands, "the Inbox still stands behind the terminal")
    XCTAssertEqual(stack.viewControllers.count, depth + 1, "the pushed screen stays")
    XCTAssertTrue(stack.topViewController === pushed, "the same pushed screen, not a pop and a push")

    stack.popViewController(animated: true)
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    Self.spin()
    if !rig.navigation.inboxStands { rig.store.inboxClosed() }
    XCTAssertEqual(rig.navigation.detail, .inbox, "Back from the terminal returns to the Inbox")
    XCTAssertEqual(stack.viewControllers.count, depth)
    XCTAssertTrue(rig.controller(in: window) === inbox, "the same Inbox screen, not a new one")
    XCTAssertNotNil(rig.store.state.inbox.held["b"], "the held card stays")
  }

  func testSwipeAndRemoveTakeTheCardAtOnce() async throws {
    let removed = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 2), Rig.Card("b", minute: 1)],
      transport: UIKitTransport(onRemoveInboxCard: { sessionId, _ in
        await removed.add(sessionId)
        return Self.removedAnswer
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let controller = try XCTUnwrap(rig.controller(in: window))
    let swipe = try XCTUnwrap(controller.swipeActions(at: IndexPath(item: 0, section: 0)), "the phone's swipe")
    XCTAssertEqual(swipe.actions.first?.title, UICopy.inboxSwipeRemove)
    XCTAssertTrue(swipe.performsFirstActionWithFullSwipe)
    swipe.actions.first?.handler(swipe.actions[0], UIView()) { _ in }
    let gone = await Self.waitUntil { rig.store.state.inboxItems.map(\.id) == ["b"] }
    XCTAssertTrue(gone, "the card goes before the server answers: \(rig.store.state.inboxItems.map(\.id))")
    let sent = await Self.waitUntil {
      let values = await removed.values
      return values == ["a"]
    }
    XCTAssertTrue(sent, "the removal went out")
  }

  /// ⌫ and forward delete on a hardware keyboard take the card with the keyboard focus the way "×" does: the card goes
  /// at once, the removal goes out and the toast offers Undo. Without a focused card the key is nobody's here. The
  /// focus system does not run in a test window, so the test sets the focused card the focus delegate would set.
  func testDeleteKeyRemovesTheFocusedCard() async throws {
    let removed = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 2), Rig.Card("b", minute: 1)],
      transport: UIKitTransport(onRemoveInboxCard: { sessionId, _ in
        await removed.add(sessionId)
        return Self.removedAnswer
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let controller = try XCTUnwrap(rig.controller(in: window))
    let cell = try XCTUnwrap(controller.collectionView.cellForItem(at: IndexPath(item: 0, section: 0)), "card a")
    XCTAssertTrue(controller.collectionView.allowsFocus, "the cards take the keyboard focus")
    let backspace = "\u{8}"
    XCTAssertNil(Self.keyTarget(backspace, from: cell), "no focused card: ⌫ is not the Inbox's")

    controller.focusedCardId = "a"
    for input in [backspace, UIKeyCommand.inputDelete] {
      let command = try XCTUnwrap(Self.keyTarget(input, from: cell)?.command, "\(input.debugDescription) is taken")
      XCTAssertEqual(command.repeatBehavior, .nonRepeatable, "a held key does not empty the Inbox")
    }
    let target = try XCTUnwrap(Self.keyTarget(backspace, from: cell))
    target.responder.perform(try XCTUnwrap(target.command.action), with: target.command)
    let gone = await Self.waitUntil { rig.store.state.inboxItems.map(\.id) == ["b"] }
    XCTAssertTrue(gone, "the card goes before the server answers: \(rig.store.state.inboxItems.map(\.id))")
    let sent = await Self.waitUntil {
      let values = await removed.values
      return values == ["a"]
    }
    XCTAssertTrue(sent, "the removal went out")
    XCTAssertEqual(rig.toasts.current?.action?.identifier, "toast.inbox.undo", "the toast offers Undo")
  }

  /// The header's number and the button's badge count every card on the screen, a received result too; other screens
  /// and an empty Inbox show no number.
  func testHeaderCountsEveryStandingCard() throws {
    let rig = try Rig(cards: [
      Rig.Card("a", minute: 2, seen: true),
      Rig.Card("b", minute: 1, kind: "decision", state: "waiting-permission", dialog: #"{"kind":"permission"}"#),
    ])
    XCTAssertEqual(rig.store.state.inboxCount, 2, "the button counts the received result too")
    XCTAssertEqual(HeaderTitleSlot.count(rig.store.state, detail: .inbox), 2, "the header counts both cards")
    XCTAssertEqual(HeaderTitleSlot.count(rig.store.state, detail: .session("a")), 0, "no number on a session")
    XCTAssertEqual(HeaderTitleSlot.count(try Rig(cards: []).store.state, detail: .inbox), 0, "empty: no number")

    let bare = UIHostingController(rootView: HeaderLeadingTitle(title: UICopy.inboxTitle, subtitle: "", maxWidth: 300))
    let counted = UIHostingController(
      rootView: HeaderLeadingTitle(title: UICopy.inboxTitle, subtitle: "", count: 2, maxWidth: 300))
    let free = CGSize(width: 1_000, height: 200)
    XCTAssertGreaterThan(
      counted.sizeThatFits(in: free).width, bare.sizeThatFits(in: free).width + 8, "the number stands after the title")
  }

  func testEmptyInboxSaysSo() throws {
    let rig = try Rig(cards: [])
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    XCTAssertTrue(rig.store.state.inboxCardModels.isEmpty)
    XCTAssertNil(
      Self.views(UICollectionView.self, in: window).first { $0.accessibilityIdentifier == "inbox.list" },
      "no card list: the empty sentence stands instead")
    try Self.snapshot(window, "inbox-empty")
  }

  func testNewCardBelowTheTopRaisesThePillAndKeepsTheScreen() throws {
    let body = (1...8).map { "Paragraph \($0) of a longer report." }.joined(separator: "\n\n")
    let rig = try Rig(cards: (0..<8).map { Rig.Card("c\($0)", minute: 10 - $0, text: body) })
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let list = try XCTUnwrap(Self.views(UICollectionView.self, in: window).first { $0.accessibilityIdentifier == "inbox.list" })
    list.setContentOffset(CGPoint(x: 0, y: 900), animated: false)
    Self.spin()
    let path = try XCTUnwrap(list.indexPathsForVisibleItems.sorted().dropFirst().first, "a card on screen")
    let before = try XCTUnwrap(list.layoutAttributesForItem(at: path)?.frame)
    let id = rig.store.state.inboxItems[path.item].id
    let beforeY = list.convert(before, to: window).minY

    try rig.add(Rig.Card("new", minute: 30, kind: "decision", state: "waiting-permission",
                         dialog: #"{"kind":"permission"}"#))
    Self.spin()
    let index = try XCTUnwrap(rig.store.state.inboxItems.firstIndex { $0.id == id })
    XCTAssertEqual(rig.store.state.inboxItems.first?.id, "new", "the new card is on top")
    let after = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame)
    XCTAssertEqual(list.convert(after, to: window).minY, beforeY, accuracy: 1, "the card under the finger stays")
    let screen = rig.screen(in: window)
    let side = try XCTUnwrap(screen.newCards.side(rig.store.state.inboxCardModels), "the new-cards pill")
    XCTAssertEqual(side.waiting, 1)
    XCTAssertEqual(side.target, "new")
    try Self.snapshot(window, "inbox-new-pill")

    rig.controller(in: window)?.scrollToTop()
    Self.spin()
    XCTAssertNil(screen.newCards.side(rig.store.state.inboxCardModels), "the top clears the pill")
  }

  // MARK: - Voice agent

  /// With the voice agent offered the screen's owner offers the result and decision cards and not a stop (the
  /// screenshot shows the buttons); a start sets the navigation's voice target, so the root opens the session's
  /// transcript stream, and the card says Connecting until the fresh snapshot; a second start ends it and the target
  /// goes. Another session opened from the Inbox ends a connecting conversation through the screen's place.
  func testVoiceButtonOnResultAndDecisionCards() throws {
    let rig = try Rig(cards: [
      Rig.Card("a", minute: 3),
      Rig.Card("b", minute: 2, kind: "decision", state: "waiting-permission",
               dialog: #"{"kind":"permission","requestId":"p1"}"#),
      Rig.Card("c", minute: 1, kind: "failed", state: "error"),
    ])
    rig.store.voiceAgent.acceptConsent()
    let version = #"""
      {"version":"1.0.0","protocolVersion":3,"serverStartId":"test","capabilities":["inbox"],
       "companionEnabled":true,"companionSpeech":true}
      """#
    rig.store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
    let window = rig.screenWindow(width: 820, height: 1180)
    defer { window.isHidden = true }
    let voice = try XCTUnwrap(rig.controller(in: window)?.voice, "the screen's voice owner reaches the cards")
    XCTAssertTrue(voice.offered(try rig.card("a")), "a result card has the button")
    XCTAssertTrue(voice.offered(try rig.card("b")), "a decision card has the button")
    XCTAssertFalse(voice.offered(try rig.card("c")), "a stop has none")
    try Self.snapshot(window, "inbox-voice")

    voice.toggle(try rig.card("a"))
    Self.spin()
    XCTAssertEqual(rig.navigation.inboxVoiceTarget, "a")
    XCTAssertEqual(rig.navigation.transcriptSessionId, "a", "the root opens a's transcript stream")
    XCTAssertEqual(voice.indicator, .connecting)
    XCTAssertEqual(voice.indicatorCard, "a", "Connecting stands on the card")
    XCTAssertTrue(voice.dims("b"), "the other buttons are dimmed")
    try Self.snapshot(window, "inbox-voice-connecting")

    voice.toggle(try rig.card("a"))
    Self.spin()
    XCTAssertNil(rig.navigation.inboxVoiceTarget, "the second start ends it")
    XCTAssertNil(voice.indicator)

    voice.toggle(try rig.card("a"))
    Self.spin()
    XCTAssertEqual(rig.navigation.inboxVoiceTarget, "a")
    rig.navigation.openSessionFromInbox("b")
    Self.spin()
    XCTAssertFalse(voice.isActive, "another session on screen ends it")
    XCTAssertNil(rig.navigation.inboxVoiceTarget)
  }

  // MARK: - Rig

  @MainActor
  struct Rig {
    struct Card {
      let id: String
      let minute: Int
      var kind = "result"
      var state = "waiting-input"
      var text = "Done. Tests pass."
      var dialog: String?
      var session = ""
      var seen = false

      init(
        _ id: String, minute: Int, kind: String = "result", state: String = "waiting-input",
        text: String = "Done. Tests pass.", dialog: String? = nil, session: String = "", seen: Bool = false
      ) {
        self.id = id
        self.minute = minute
        self.kind = kind
        self.state = state
        self.text = text
        self.dialog = dialog
        self.session = session
        self.seen = seen
      }

      var at: String { String(format: "2026-10-06T10:%02d:00.000Z", minute) }

      var summary: String {
        #"""
          {"id":"\#(id)","cwd":"/Users/demo/rarog","title":"rarog","label":"session \#(id)","state":"\#(state)",
           "seen":\#(seen),"stateSince":"\#(at)","createdAt":"2026-10-06T09:00:00.000Z","lastActivityAt":"\#(at)"\#(session)}
          """#
      }

      var head: String {
        let dialogKind = dialog.flatMap { $0.contains("panel") ? "panel" : $0.contains("question") ? "question" : "permission" }
        let field = dialogKind.map { #","dialog":"\#($0)""# } ?? ""
        return #"""
          {"sessionId":"\#(id)","turnId":"t-\#(id)","version":"v1","kind":"\#(kind)","state":"\#(state)","at":"\#(at)"\#(field)}
          """#
      }

      var card: String {
        let quoted = String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
        let field = dialog.map { #","dialog":\#($0)"# } ?? ""
        return #"""
          {"sessionId":"\#(id)","turnId":"t-\#(id)","version":"v1","kind":"\#(kind)","state":"\#(state)",
           "at":"\#(at)","text":\#(quoted),"truncated":false\#(field)}
          """#
      }
    }

    let store: RarogStore
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let toasts = ToastCenter()
    let cards: CardList
    /// The session drafts on disk, as the space keeps them: a reply field reads and writes the session's draft.
    let drafts = ComposerDrafts(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))

    init(cards: [Card], inbox: Bool = true, transport: UIKitTransport = UIKitTransport()) throws {
      let list = CardList(cards.map(\.card))
      var transport = transport
      transport.onInboxCards = { () throws(TransportError) -> InboxList in try list.decoded() }
      self.cards = list
      store = RarogStore(
        transport: transport, rules: MutationRules(),
        outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
      store.dispatch(.loggedIn)
      store.dispatch(.streamOpened(.global, resumedWithCursor: false))
      try Self.frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#)
      store.dispatch(.versionProbed(try Self.version(inbox: inbox)))
      try Self.frame(store, #"{"type":"sessions-snapshot","sessions":[\#(cards.map(\.summary).joined(separator: ","))]}"#)
      try Self.frame(store, #"{"type":"inbox-heads","heads":[\#(cards.map(\.head).joined(separator: ","))]}"#)
    }

    static func version(inbox: Bool) throws -> VersionInfo {
      let capabilities = inbox ? #"["inbox"]"# : "[]"
      let json = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"test","capabilities":\#(capabilities)}"#
      return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
    }

    static func frame(_ store: RarogStore, _ json: String, source: FrameSource = .global) throws {
      let event = try EventDecoder.decode(Data(json.utf8)).get().event
      store.dispatch(.frame(event, source: source, cursor: nil))
    }

    /// A new session with its card, as the stream brings it; its text is read through the list again.
    func add(_ card: Card) throws {
      cards.append(card.card)
      try Self.frame(store, #"{"type":"session-changed","session":\#(card.summary)}"#)
      try Self.frame(store, #"{"type":"inbox-head","head":\#(card.head)}"#)
    }

    /// The session's transcript with the pending permission `p1`, as the session stream brings it.
    func pendingPermission(_ sessionId: String) throws {
      store.dispatch(.viewSession(sessionId))
      store.dispatch(.streamOpened(.session(id: sessionId), resumedWithCursor: false))
      let permission = #"""
        {"permId":"p1","sessionId":"\#(sessionId)","toolName":"Shell","displayText":"npm test","risk":"normal",
         "cwd":"/Users/demo/rarog","createdAt":"2026-10-06T10:00:00.000Z"}
        """#
      try Self.frame(store, #"""
        {"type":"transcript-snapshot","sessionId":"\#(sessionId)","messages":[],
         "pendingPermissions":[\#(permission)],"pendingQuestions":[]}
        """#, source: .session(sessionId))

    }

    func window(_ root: some View, width: CGFloat = 402, height: CGFloat = 874) -> UIWindow {
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
      window.overrideUserInterfaceStyle = .dark
      window.rootViewController = UIHostingController(rootView: root.environment(navigation).environment(toasts))
      window.makeKeyAndVisible()
      InboxScreenTests.spin()
      return window
    }

    /// The Inbox screen open, as the root view opens it: the core reads the texts.
    /// `voice`: the cards' voice conversation (default: the app's, on the device's audio).
    func screenWindow(
      width: CGFloat = 402, height: CGFloat = 874,
      voice: (@MainActor (RarogStore, ComposerDrafts) -> VoiceAgentInboxConversation)? = nil
    ) -> UIWindow {
      navigation.openInbox()
      store.inboxOpened()
      let screen = voice.map { InboxScreen(store: store, drafts: drafts, makeVoice: $0) }
        ?? InboxScreen(store: store, drafts: drafts)
      return window(screen, width: width, height: height)
    }

    func replies(in window: UIWindow) -> InboxReplyHost {
      controller(in: window)!.replies
    }

    func card(_ id: String) throws -> InboxCardModel {
      try XCTUnwrap(store.state.inboxCardModels.first { $0.id == id }, "card \(id)")
    }

    func screen(in window: UIWindow) -> InboxScreenState {
      controller(in: window)!.screen
    }

    func decisions(in window: UIWindow) -> InboxDecisionHost {
      controller(in: window)!.decisions
    }

    func controller(in window: UIWindow) -> InboxViewController? {
      func find(_ controller: UIViewController?) -> InboxViewController? {
        guard let controller else { return nil }
        if let found = controller as? InboxViewController { return found }
        return controller.children.lazy.compactMap { find($0) }.first
      }
      return find(window.rootViewController)
    }
  }

  /// The texts `GET /api/inbox` answers with; a test adds to them.
  final class CardList: @unchecked Sendable {
    private var cards: [String]
    private let lock = NSLock()

    init(_ cards: [String]) { self.cards = cards }

    func append(_ card: String) { lock.withLock { cards.append(card) } }

    func decoded() throws(TransportError) -> InboxList {
      let json = lock.withLock { #"{"cards":[\#(cards.joined(separator: ","))]}"# }
      do {
        return try JSONDecoder().decode(InboxList.self, from: Data(json.utf8))
      } catch {
        throw .invalidResponse("inbox cards")
      }
    }
  }

  nonisolated static var removedAnswer: InboxActionResponse {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(InboxActionResponse.self, from: Data(#"{"ok":true,"changed":true}"#.utf8))
  }

  actor Recorder {
    private(set) var values: [String] = []
    func add(_ value: String) { values.append(value) }
  }


  // MARK: - Reply

  /// A result card has the reply field and ↑; the reply is the person's ordinary send to that card's session (no
  /// sender pair), and the card is held. Two quick replies go each to its own session.
  func testReplyGoesToTheCardSessionAndHoldsTheCard() async throws {
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1), Rig.Card("b", minute: 2)],
      transport: UIKitTransport(onSend: { sessionId, upload throws(TransportError) in
        let body = try? JSONSerialization.jsonObject(with: Self.data(upload)) as? [String: Any]
        let pair = body?["source"] != nil || body?["expectedConversation"] != nil || upload.expectsConversation
        await sent.add("\(sessionId):\(body?["text"] as? String ?? "?")\(pair ? ":pair" : "")")
        return nil
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    host.edit(try rig.card("a"), "Ship it")
    host.edit(try rig.card("b"), "Tag it")
    Self.spin()
    XCTAssertTrue(Self.hasField("Ship it", in: window), "the result card's reply field shows the text")
    host.send(try rig.card("a"), store: rig.store)
    host.send(try rig.card("b"), store: rig.store)
    XCTAssertEqual(host.field(try rig.card("a")).text, "", "↑ empties the field")
    let delivered = await Self.waitUntil { await sent.values.count == 2 }
    let values = await sent.values
    XCTAssertTrue(delivered, "both replies went out: \(values)")
    XCTAssertEqual(Set(values), ["a:Ship it", "b:Tag it"])
    XCTAssertNotNil(rig.store.state.inbox.held["a"], "the card the person answered is held")
    try Self.snapshot(window, "inbox-reply-sent")
  }

  /// The draft of the field is the session's draft: it survives leaving the Inbox and coming back.
  func testReplyDraftSurvivesLeavingTheInbox() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow()
    rig.replies(in: window).edit(try rig.card("a"), "Half a thought")
    window.isHidden = true
    window.rootViewController = nil
    Self.spin()
    rig.drafts.flush()
    let again = rig.screenWindow()
    defer { again.isHidden = true }
    XCTAssertEqual(rig.replies(in: again).field(try rig.card("a")).text, "Half a thought")
    XCTAssertTrue(Self.hasField("Half a thought", in: again), "the field shows the draft again")
  }

  /// A draft waiting for the session's field (a send that came back, with its reason) shows in the card's field, and
  /// an Inbox shown and left untouched leaves it waiting, reason included, for the session screen.
  func testUntouchedReplyFieldLeavesTheSessionDraft() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    rig.drafts.save("Waiting text", note: "Sending failed.", for: "a")
    let window = rig.screenWindow()
    XCTAssertEqual(rig.replies(in: window).field(try rig.card("a")).text, "Waiting text")
    window.isHidden = true
    window.rootViewController = nil
    Self.spin()
    XCTAssertEqual(rig.drafts.take(for: "a"), ComposerDrafts.Draft(text: "Waiting text", note: "Sending failed."))
  }

  /// "Open session" right after typing: the session screen that opens reads the typed text from the draft, not the
  /// text from before the typing pause.
  func testOpenSessionRightAfterTypingKeepsTheText() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    rig.replies(in: window).edit(try rig.card("a"), "Typed just now")
    rig.controller(in: window)!.actions.open("a")
    XCTAssertEqual(rig.drafts.take(for: "a")?.text, "Typed just now")
  }

  /// The card moved on before ↑ (another turn of the same session): nothing goes out, the text is back in the field
  /// with the reason, and the next ↑ answers the card now shown.
  func testReplyToAChangedCardComesBackWithTheReason() async throws {
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
        await sent.add(sessionId)
        return nil
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    host.edit(try rig.card("a"), "Ship it")
    try Rig.frame(rig.store, #"{"type":"inbox-head","head":{"sessionId":"a","turnId":"t-a2","version":"v2","kind":"result","state":"waiting-input","at":"2026-10-06T10:05:00.000Z"}}"#)
    Self.spin()
    host.send(try rig.card("a"), store: rig.store)
    let back = await Self.waitUntil { host.field(try! rig.card("a")).note != nil }
    XCTAssertTrue(back, "the refusal came")
    let field = host.field(try rig.card("a"))
    XCTAssertEqual(field.text, "Ship it")
    XCTAssertEqual(field.note, UICopy.inboxReplyCardChanged)
    XCTAssertEqual(field.turnId, "t-a2")
    let none = await sent.values
    XCTAssertEqual(none, [], "nothing went out")
    Self.spin()
    try Self.snapshot(window, "inbox-reply-changed")
  }

  /// The session stopped on a dialog while its result card still stands (the head follows the state later): the
  /// send refuses as the session screen does, and the text is back with that sentence.
  func testReplyToASessionOnADialogComesBack() async throws {
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
        await sent.add(sessionId)
        return nil
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    host.edit(try rig.card("a"), "Ship it")
    let dialog = Rig.Card("a", minute: 1, state: "waiting-permission")
    try Rig.frame(rig.store, #"{"type":"session-changed","session":\#(dialog.summary)}"#)
    Self.spin()
    host.send(try rig.card("a"), store: rig.store)
    let back = await Self.waitUntil { host.field(try! rig.card("a")).note != nil }
    XCTAssertTrue(back, "the refusal came")
    XCTAssertEqual(host.field(try rig.card("a")).text, "Ship it")
    let none = await sent.values
    XCTAssertEqual(none, [], "nothing went out")
    XCTAssertNil(rig.store.state.inbox.held["a"])
  }

  /// ↑, more typing before the typing pause, then the card turns into a decision (no field on screen any more) and the
  /// 202 comes: the text typed since goes to the session's draft, and the pause's write does not delete it.
  func testTextTypedAfterAReplyStaysWhenTheCardBecomesADecision() async throws {
    let gate = AsyncStream<Void>.makeStream()
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
        await sent.add(sessionId)
        for await _ in gate.stream { break }
        return nil
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    host.edit(try rig.card("a"), "Ship it")
    host.send(try rig.card("a"), store: rig.store)
    let inFlight = await Self.waitUntil { await sent.values.count == 1 }
    XCTAssertTrue(inFlight, "the reply is on its way")
    // One stretch, well inside the typing pause: the typing, the decision and the 202.
    host.edit(try rig.card("a"), "And tag it")
    try Rig.frame(rig.store, #"{"type":"inbox-head","head":{"sessionId":"a","turnId":"t-a","version":"v2","kind":"decision","state":"waiting-permission","at":"2026-10-06T10:05:00.000Z","dialog":"permission"}}"#)
    XCTAssertNotEqual(try rig.card("a").footer, .reply, "the card has no field any more")
    gate.continuation.yield()
    let accepted = await Self.waitUntil {
      if case .sent = rig.store.state.outbox.first?.state { true } else { false }
    }
    XCTAssertTrue(accepted, "the reply was accepted")
    try await Task.sleep(for: SessionViewController.draftDebounce * 2)
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.take(for: "a")?.text, "And tag it")
  }

  /// ↑, more typing before the typing pause, and the card hides before the reply leaves (its session started
  /// working): the reply comes back into the session's draft with its reason, on top of the text typed since, and the
  /// pause's write deletes neither.
  func testReplyToACardThatHidKeepsTheTextTypedSince() async throws {
    let sent = Recorder()
    let rig = try Rig(
      cards: [Rig.Card("a", minute: 1)],
      transport: UIKitTransport(onSend: { sessionId, _ throws(TransportError) in
        await sent.add(sessionId)
        return nil
      }))
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    let card = try rig.card("a")
    host.edit(card, "Ship it")
    host.send(card, store: rig.store)
    host.edit(card, "And tag it")
    let working = Rig.Card("a", minute: 1, state: "running")
    try Rig.frame(rig.store, #"{"type":"session-changed","session":\#(working.summary)}"#)
    XCTAssertNil(rig.store.state.inboxCardModels.first { $0.id == "a" }, "the card hid")
    try await Task.sleep(for: SessionViewController.draftDebounce * 2)
    rig.drafts.flush()
    XCTAssertEqual(
      rig.drafts.take(for: "a"),
      ComposerDrafts.Draft(text: "Ship it\nAnd tag it", note: UICopy.inboxReplyCardChanged))
    let none = await sent.values
    XCTAssertEqual(none, [], "nothing went out")
  }

  /// A queue take-back that comes into the session's draft after the field read it (the session screen closed
  /// before the answer): the field's next write takes it on top of what the person typed, so both are in the draft.
  func testLateTakeBackJoinsTheFieldBeforeItsWrite() async throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    XCTAssertEqual(host.field(try rig.card("a")).text, "", "the field read the session's empty draft")
    let saved = await rig.drafts.saveTaken("Taken back", for: "a")
    XCTAssertTrue(saved)
    host.edit(try rig.card("a"), "Typed")
    let card = try rig.card("a")
    let merged = await Self.waitUntil { host.field(card).text == "Taken back\nTyped" }
    XCTAssertTrue(merged, "the field shows both: \(host.field(card).text)")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.take(for: "a")?.text, "Taken back\nTyped", "and wrote both")
  }

  /// ↑, then the person leaves the Inbox and the screen lets the reply host go before the outbox answers that it
  /// could not store the reply: the text goes to the session's draft with its reason, not nowhere.
  func testReplyRefusedAfterTheHostWentLandsInTheDraft() async throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    let manager = FileManager.default
    let outbox = rig.store.persistence.directory
    try manager.createDirectory(at: outbox, withIntermediateDirectories: true)
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: outbox.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: outbox.path) }
    weak var gone: InboxReplyHost?
    do {
      let host = InboxReplyHost(drafts: rig.drafts)
      gone = host
      host.screenAppeared()
      let card = try rig.card("a")
      host.edit(card, "Ship it")
      host.send(card, store: rig.store)
      host.screenDisappeared()
    }
    XCTAssertNil(gone, "the host went before the answer")
    let back = await Self.waitUntil { rig.drafts.peek(for: "a").draft != nil }
    XCTAssertTrue(back, "the text came back")
    XCTAssertEqual(rig.drafts.take(for: "a"), ComposerDrafts.Draft(text: "Ship it", note: UICopy.notPersisted))
  }

  /// The card's voice conversation hands its block's text back into the card's field: on top of what the person
  /// typed, with the reason under it, answering the turn the card shows now (so ↑ does not meet the changed card
  /// again), shown by the real field and written to the session's draft at once. With the Inbox gone the field takes
  /// nothing, so the conversation writes the draft itself and the text never lands twice.
  func testHandBackPutsTheTextOnTopOfTheFieldAndInTheDraft() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1)])
    let window = rig.screenWindow()
    defer { window.isHidden = true }
    let host = rig.replies(in: window)
    let field: any VoiceAgentInboxField = host
    host.edit(try rig.card("a"), "Typed")
    try Rig.frame(rig.store, #"{"type":"inbox-head","head":{"sessionId":"a","turnId":"t-a2","version":"v2","kind":"result","state":"waiting-input","at":"2026-10-06T10:05:00.000Z"}}"#)
    Self.spin()
    let taken = field.handBack("Run the tests.", note: UICopy.inboxReplyCardChanged, noteIsError: false, into: "a")
    XCTAssertTrue(taken, "the card's field is on screen")
    Self.spin()
    let shown = host.field(try rig.card("a"))
    XCTAssertEqual(shown.text, "Run the tests.\nTyped")
    XCTAssertEqual(shown.note, UICopy.inboxReplyCardChanged)
    XCTAssertEqual(shown.turnId, "t-a2", "the field answers the turn the card shows now")
    XCTAssertTrue(Self.hasField("Run the tests.\nTyped", in: window), "the real field shows it")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, "Run the tests.\nTyped", "the draft holds it at once")

    host.screenDisappeared()
    XCTAssertFalse(field.handBack("Later", note: nil, noteIsError: false, into: "a"), "no field on screen")
    rig.drafts.flush()
    XCTAssertEqual(rig.drafts.peek(for: "a").draft?.text, "Run the tests.\nTyped", "the field took nothing")
  }

  /// The iPad's column with a result card and its reply field, for the screenshot.
  func testReplyFieldOnTheIPad() throws {
    let rig = try Rig(cards: [Rig.Card("a", minute: 1, text: "Done: the parser handles tabs now.\n\n**To you:** ship it?")])
    rig.navigation.openInbox()
    rig.store.inboxOpened()
    let window = rig.window(InboxScreen(store: rig.store, drafts: rig.drafts), width: 820, height: 700)
    defer { window.isHidden = true }
    rig.replies(in: window).edit(try rig.card("a"), "Yes, ship it and tag 1.4.")
    Self.spin()
    XCTAssertTrue(Self.hasField("Yes, ship it and tag 1.4.", in: window))
    try Self.snapshot(window, "inbox-reply-ipad")
  }

  /// A text field under the window showing `text` (the SwiftUI field of a card draws through a UIKit text view).
  static func hasField(_ text: String, in window: UIWindow) -> Bool {
    views(UITextView.self, in: window).contains { $0.text == text && $0.isEditable }
      || views(UITextField.self, in: window).contains { $0.text == text }
  }

  nonisolated static func data(_ upload: MessageUpload) -> Data {
    switch upload.body {
    case let .data(data): data
    case let .file(url): (try? Data(contentsOf: url)) ?? Data()
    }
  }

  // MARK: - Helpers

  static func spin() {
    for _ in 0..<8 { RunLoop.main.run(until: Date().addingTimeInterval(0.15)) }
  }

  static func waitUntil(_ condition: @MainActor () async -> Bool) async -> Bool {
    for _ in 0..<100 {
      if await condition() { return true }
      try? await Task.sleep(for: .milliseconds(30))
    }
    return false
  }

  /// UIKit's key command lookup, modelled from a responder up its chain (the focused cell when the focus system
  /// delivers the key): the first responder that lists the key and can perform its action now.
  static func keyTarget(_ input: String, from start: UIResponder) -> (responder: UIResponder, command: UIKeyCommand)? {
    var responder: UIResponder? = start
    while let current = responder {
      if let command = current.keyCommands?.first(where: { $0.input == input && $0.modifierFlags.isEmpty }),
        let action = command.action, current.canPerformAction(action, withSender: command)
      {
        return (current, command)
      }
      responder = current.next
    }
    return nil
  }

  /// The navigation controller with the deepest stack in the window (the collapsed split's stack).
  static func stack(in window: UIWindow) -> UINavigationController? {
    func all(_ controller: UIViewController?) -> [UIViewController] {
      guard let controller else { return [] }
      return [controller] + controller.children.flatMap { all($0) } + all(controller.presentedViewController)
    }
    return all(window.rootViewController).compactMap { $0 as? UINavigationController }
      .max { $0.viewControllers.count < $1.viewControllers.count }
  }

  static func views<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
    ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
  }

  /// Every accessibility element under the window: the views and what SwiftUI exposes inside its hosting views.
  static func elements(in root: NSObject) -> [NSObject] {
    var out: [NSObject] = []
    var seen = Set<ObjectIdentifier>()
    func walk(_ object: NSObject, depth: Int) {
      guard depth < 60, seen.insert(ObjectIdentifier(object)).inserted else { return }
      out.append(object)
      if let elements = object.accessibilityElements as? [NSObject] {
        elements.forEach { walk($0, depth: depth + 1) }
      } else {
        let count = object.accessibilityElementCount()
        if count != NSNotFound, count > 0 {
          for index in 0..<count {
            if let element = object.accessibilityElement(at: index) as? NSObject { walk(element, depth: depth + 1) }
          }
        }
      }
      if let view = object as? UIView { view.subviews.forEach { walk($0, depth: depth + 1) } }
    }
    walk(root, depth: 0)
    return out
  }

  /// The element with `identifier`. SwiftUI's elements answer `accessibilityIdentifier` without declaring
  /// `UIAccessibilityIdentification` to Swift, so the identifier is read by its name.
  static func element(_ identifier: String, in root: NSObject) -> NSObject? {
    let getter = #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier)
    return elements(in: root).first { element in
      guard element.responds(to: getter) else { return false }
      return element.value(forKey: "accessibilityIdentifier") as? String == identifier
    }
  }

  /// The window drawn from its layer tree, as PNG bytes.
  static func image(_ window: UIWindow) -> Data? {
    UIGraphicsImageRenderer(bounds: window.bounds).image { window.layer.render(in: $0.cgContext) }.pngData()
  }

  static func snapshot(_ window: UIWindow, _ name: String) throws {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_LIST_SNAPSHOT_DIR"], !dir.isEmpty else { return }
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
      window.layer.render(in: context.cgContext)
    }
    try XCTUnwrap(image.pngData(), "\(name): PNG").write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }
}
