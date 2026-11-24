import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The Inbox card as the screen draws it, the new-cards pill and the Inbox route of the navigation.

private func head(
  _ sessionId: String = "s1", version: String = "v1", kind: String = "result", state: String = "waiting-input",
  dialog: String? = nil
) -> InboxHead {
  let dialogField = dialog.map { #","dialog":"\#($0)""# } ?? ""
  return Sample.decode(InboxHead.self, #"""
    {"sessionId":"\#(sessionId)","turnId":"t1","version":"\#(version)","kind":"\#(kind)","state":"\#(state)",
     "at":"\#(Sample.iso(60))"\#(dialogField)}
    """#)
}

private func card(
  for sessionId: String, kind: String = "result", state: String = "waiting-input", dialog: String? = nil,
  text: String = "Done."
) -> InboxCard {
  let dialogField = dialog.map { #","dialog":\#($0)"# } ?? ""
  let escaped = String(data: try! JSONEncoder().encode(text), encoding: .utf8)!
  return Sample.decode(InboxCard.self, #"""
    {"sessionId":"\#(sessionId)","turnId":"t1","version":"v1","kind":"\#(kind)","state":"\#(state)",
     "at":"\#(Sample.iso(60))","text":\#(escaped),"truncated":false\#(dialogField)}
    """#)
}

private func model(
  _ sessionId: String = "s1", version: String = "v1", kind: String = "result", state: String = "waiting-input",
  dialog: String? = nil, cardDialog: String? = nil, held: Bool = false, decision: Bool = false,
  sessionState: String? = nil, extra: String = ""
) -> InboxCardModel {
  InboxCardModel(
    head: head(sessionId, version: version, kind: kind, state: state, dialog: dialog),
    session: Sample.session(id: sessionId, state: sessionState ?? state, extra: extra),
    card: card(for: sessionId, kind: kind, state: state, dialog: cardDialog), held: held, decision: decision,
    freshResult: false)
}

@MainActor
@Suite("Inbox card model, new-cards pill and route")
struct InboxCardModelTests {
  @Test("what stands under the message: decision buttons, the pane dialog, Open session, the reply field, or nothing")
  func footer() {
    #expect(model(kind: "decision", state: "waiting-permission", dialog: "permission", decision: true).footer == .decision)
    #expect(model(kind: "decision", state: "waiting-permission", dialog: "permission").footer == .openSession)
    #expect(
      model(kind: "decision", state: "waiting-permission", dialog: "panel", cardDialog: #"{"kind":"panel"}"#).footer
        == .paneDialog)
    #expect(model(kind: "result").footer == .reply, "only a result card takes a reply")
    #expect(
      model(kind: "result", extra: #""termId":"0123456789abcdef""#).footer == .openSession,
      "a session in a Rarog terminal has no transcript for the reply's echo: its card leads to the session")
    #expect(model(kind: "failed", state: "error").footer == InboxCardModel.Footer.none)
  }

  @Test("the voice agent button: result and decision cards of a session with a transcript; no stop, no terminal session")
  func voiceButton() {
    #expect(model(kind: "result").voice)
    #expect(model(kind: "decision", state: "waiting-permission", dialog: "permission", decision: true).voice)
    #expect(model(kind: "decision", state: "waiting-question", dialog: "question").voice)
    #expect(!model(kind: "failed", state: "error").voice, "a stop has no conversation")
    #expect(
      !model(kind: "result", extra: #""termId":"0123456789abcdef""#).voice,
      "a session in a Rarog terminal has no transcript for the conversation")
    #expect(
      !model(kind: "decision", state: "waiting-permission", dialog: "permission", extra: #""termId":"0123456789abcdef""#)
        .voice)
  }

  @Test("a held card of a working session cannot be removed; any card of a standing session can")
  func removable() {
    #expect(model().removable)
    #expect(model(held: true).removable)
    #expect(!model(held: true, sessionState: "running").removable)
    #expect(model(sessionState: "running").removable)
  }

  @Test("⌫ removes the focused card only when it can be removed, nobody types and no sheet stands over the screen")
  func keyRemovalTarget() {
    let cards = [model("a"), model("b", held: true, sessionState: "running")]
    let target = { (focused: String?, typing: Bool, sheet: Bool) in
      InboxCardModel.keyRemovalTarget(focused: focused, cards: cards, typing: typing, sheetAbove: sheet)?.id
    }
    #expect(target("a", false, false) == "a")
    #expect(target(nil, false, false) == nil, "no focused card: the key is not the Inbox's")
    #expect(target("gone", false, false) == nil, "the focused card left the screen")
    #expect(target("b", false, false) == nil, "a held card of a working session cannot be removed")
    #expect(target("a", true, false) == nil, "a field keeps its own ⌫")
    #expect(target("a", false, true) == nil, "a sheet over the screen takes the keys")
  }

  @Test("the header is the list row: same state word and the session name for the toast")
  func header() {
    let card = model(kind: "decision", state: "waiting-permission", dialog: "permission")
    #expect(card.row.status == RowStatus(Sample.session(state: "waiting-permission")))
    #expect(card.name == "willow · zapis notatek")
    #expect(card.text == "Done.")
  }

  @Test("a new card below the top makes the pill with its state; the top clears it; held cards are not new")
  func newCardsPill() {
    var pill = InboxNewCards()
    let first = [model("a", state: "waiting-input")]
    pill.update(first, atTop: false)
    #expect(pill.side(first) == nil)

    let arrived = [model("b", kind: "decision", state: "waiting-permission")] + first
    pill.update(arrived, atTop: false)
    let side = pill.side(arrived)
    #expect(side?.waiting == 1)
    #expect(side?.count == 1)
    #expect(side?.target == "b")

    let heldChange = [model("b", kind: "decision", state: "waiting-permission"), model("a", version: "v2", held: true)]
    pill.update(heldChange, atTop: false)
    #expect(pill.side(heldChange)?.count == 1)

    pill.reachedTop()
    #expect(pill.side(heldChange) == nil)

    let atTop = [model("c", kind: "failed", state: "error")] + heldChange
    pill.update(atTop, atTop: true)
    #expect(pill.side(atTop) == nil)
  }

  @Test("Open session keeps the Inbox behind the session: Back returns to it, another screen leaves it")
  func route() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openInbox()
    #expect(navigation.inboxStands)
    #expect(navigation.detail == .inbox)

    navigation.openSessionFromInbox("s1")
    #expect(navigation.detail == .session("s1"))
    #expect(navigation.inboxStands)
    navigation.compactReturnedToList()
    #expect(navigation.detail == .inbox)
    navigation.compactReturnedToList()
    #expect(navigation.detail == nil)
    #expect(!navigation.inboxStands)

    navigation.openInbox()
    navigation.openSessionFromInbox("s1")
    navigation.selectSession("s2")
    #expect(!navigation.inboxStands)
    navigation.compactReturnedToList()
    #expect(navigation.detail == nil)
  }

  @Test("iPhone: the session opened from a card is pushed above the Inbox; popping it uncovers the Inbox")
  func compactStack() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openInbox()
    #expect(navigation.compactInboxPath.isEmpty, "the Inbox alone: nothing above it")

    navigation.openSessionFromInbox("s1")
    #expect(navigation.compactInboxPath == [InboxSessionPush(sessionId: "s1")])
    navigation.compactInboxPopped()
    #expect(navigation.detail == .inbox, "Back uncovers the Inbox")
    #expect(navigation.compactInboxPath.isEmpty)
    #expect(navigation.inboxStands)

    navigation.openSessionFromInbox("s1")
    navigation.selectSession("s2")
    #expect(navigation.compactInboxPath.isEmpty, "a session from the list is not above the Inbox")
    navigation.compactInboxPopped()
    #expect(navigation.detail == .session("s2"), "a pop with no Inbox below changes nothing")
  }

  @Test("a session opened from a card that stands in a Rarog terminal keeps the Inbox behind its terminal route")
  func hostedSessionKeepsTheInbox() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var state = AppState(clientBuild: 1)
    state.sessions["s1"] = Sample.session(state: "waiting-input", extra: #""termId":"0123456789abcdef""#)
    navigation.openInbox()
    navigation.openSessionFromInbox("s1")
    navigation.settleHostedRoute(state)
    #expect(navigation.detail == .terminal("0123456789abcdef"))
    #expect(navigation.inboxStands, "the holds of the Inbox stay")
    #expect(navigation.inboxBehindSession)
    #expect(navigation.compactInboxPath == [InboxSessionPush(sessionId: "s1")], "the same push: no pop and re-push")
    navigation.compactInboxPopped()
    #expect(navigation.detail == .inbox, "Back from the terminal returns to the Inbox")

    navigation.openSessionFromInbox("s1")
    navigation.settleHostedRoute(state)
    navigation.compactReturnedToList()
    #expect(navigation.detail == .inbox)

    navigation.openSessionFromInbox("s1")
    navigation.settleHostedRoute(state)
    navigation.selectSession("s2")
    #expect(!navigation.inboxStands, "another screen leaves the Inbox")
  }

  @Test("the transcript stream follows the voice target only while the Inbox is on screen; a session on screen wins")
  func voiceTargetStream() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openInbox()
    #expect(navigation.transcriptSessionId == nil, "the Inbox alone opens no session stream")
    navigation.setInboxVoiceTarget("s1")
    #expect(navigation.transcriptSessionId == "s1")
    #expect(navigation.selectedSessionId == nil, "the list selection and the session screen do not follow it")
    navigation.openSessionFromInbox("s2")
    #expect(navigation.transcriptSessionId == "s2")
    navigation.compactInboxPopped()
    #expect(navigation.transcriptSessionId == "s1")
    navigation.openList()
    #expect(navigation.transcriptSessionId == nil, "off the Inbox a stale target opens nothing")
    navigation.openInbox()
    navigation.setInboxVoiceTarget(nil)
    #expect(navigation.transcriptSessionId == nil)
  }

  @Test("the Inbox has no inspector, no project and no terminal route")
  func noInspector() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var state = AppState(clientBuild: 1)
    state.sessions["s1"] = Sample.session()
    navigation.openInbox()
    #expect(navigation.inspectorSession(state) == nil)
    #expect(navigation.currentProjectCwd(state) == nil)
    #expect(navigation.terminalRoute(state) == nil)
    #expect(!navigation.shortcutMenu(state).canToggleInspector)
  }
}
