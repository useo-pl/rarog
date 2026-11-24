import Foundation
import RarogCore
@testable import RarogUI
import Testing

// The prompt block of the voice conversation at an Inbox card without a view (`InboxPromptBlock`): every transition of
// the block's state, the lock on the model's `send_prompt`, the outcomes of a send as the field's recovery plans them
// (`SendRecovery`), and what the end of the conversation hands back. Mutating calls stand outside `#expect`, whose
// expansion may take its operands as values. Owner: voice agent.

private typealias Block = InboxPromptBlock

private let firstSend = UUID()
private let secondSend = UUID()
private let agentText = "Run the tests"
private let personText = "Run all the tests"

/// `show_prompt` of `text` at the card's turn `turn` by the model's response `response`, over `block`.
private func show(
  _ text: String = agentText, turn: String = "t1", response: String = "r1", over block: inout Block?
) -> Block.ShowRefusal? {
  Block.show(text, turnId: turn, response: response, on: &block)
}

/// `show_prompt` with no block before: version 1, reading.
private func shown(_ text: String = agentText, turn: String = "t1", response: String = "r1") throws -> Block {
  var block: Block?
  let refusal = show(text, turn: turn, response: response, over: &block)
  #expect(refusal == nil)
  return try #require(block)
}

/// A block of version 1 whose reading ended with `end`.
private func read(_ end: Block.ReadEnd = .whole) throws -> Block {
  var block = try shown()
  block.readingEnded(version: 1, end)
  return block
}

/// A block of version 1 in `phase`, read whole: editing holds the person's text, sending carries the agent's text.
private func prepared(in phase: Block.Phase) throws -> Block {
  switch phase {
  case .reading:
    return try shown()
  case .ready:
    return try read()
  case .editing:
    var block = try read()
    block.edit()
    block.editText(personText)
    return block
  case .sending:
    var block = try read()
    let started = block.send(id: firstSend)
    _ = try #require(started)
    return block
  }
}

/// `send_prompt` by a later response, after the person's word, logged in, unless a test changes one of them.
private func voice(
  _ block: inout Block, id: UUID = firstSend, response: String = "r2", utteranceAfterReading: Bool = true,
  loggedIn: Bool = true
) -> Result<Block.Send, Block.VoiceSendRefusal> {
  block.sendByVoice(id: id, response: response, utteranceAfterReading: utteranceAfterReading, loggedIn: loggedIn)
}

/// The refusal of a voice send, or `nil` when it went to `sending`.
private func refusal(_ result: Result<Block.Send, Block.VoiceSendRefusal>) -> Block.VoiceSendRefusal? {
  if case let .failure(refusal) = result { return refusal }
  return nil
}

/// The send in flight of `block`.
private func inFlight(_ block: Block?) throws -> Block.Send {
  try #require(block?.inFlight)
}

/// One condition of the voice lock left unmet on a ready block.
enum UnmetVoiceCondition: Sendable, CaseIterable {
  case readingCut, readingNotRead, sameResponse, noUtteranceAfterReading, loggedOut
}

@Suite("voice conversation at an Inbox card: the prompt block")
struct InboxPromptBlockTests {
  // MARK: show_prompt

  @Test("no block → show_prompt → reading version 1, not heard whole, with the turn of the show")
  func showWithoutBlock() throws {
    let block = try shown(turn: "t1")
    #expect(block.phase == .reading)
    #expect(block.version == 1)
    #expect(!block.heardWhole)
    #expect(block.text == agentText)
    #expect(block.edited == nil)
    #expect(block.turnId == "t1")
    #expect(block.reason == nil)
    #expect(block.inFlight == nil)
  }

  @Test(
    "show_prompt takes at most 1000 characters; a longer prompt is refused and no block stands",
    arguments: [
      (String(repeating: "a", count: 1000), true),
      (String(repeating: "ż", count: 1000), true),
      (String(repeating: "a", count: 1001), false),
      (String(repeating: "🐛", count: 1001), false),
    ])
  func showLimit(text: String, accepted: Bool) {
    var block: Block?
    let refusal = show(text, over: &block)
    #expect(refusal == (accepted ? nil : .tooLong))
    #expect((block != nil) == accepted)
  }

  @Test(
    "over 1000 characters over a reading or ready block → refused; block and button stay, voice needs a new show",
    arguments: [InboxPromptBlock.Phase.reading, .ready])
  func showLimitOverBlock(phase: InboxPromptBlock.Phase) throws {
    var block: Block? = try prepared(in: phase)
    let before = try #require(block)
    let refused = show(String(repeating: "a", count: 1001), turn: "t2", response: "r2", over: &block)
    #expect(refused == .tooLong)
    var current = try #require(block)
    #expect(current.phase == before.phase)
    #expect(current.version == 1)
    #expect(current.text == agentText)
    #expect(current.turnId == "t1")
    #expect(current.heardWhole == before.heardWhole)
    current.readingEnded(version: 1, .whole)
    #expect(current.heardWhole)
    var voiced = current
    let result = voice(&voiced, response: "r3")
    #expect(refusal(result) == .withdrawn)
    #expect(voiced == current)
    let sent = current.send(id: firstSend)
    #expect(sent?.send == Block.Send(id: firstSend, version: 1, text: agentText, turnId: "t1"))
  }

  @Test(
    "reading or ready → show_prompt → reading the next version with the new text and the new turn",
    arguments: [Block.Phase.reading, .ready])
  func showReplaces(phase: InboxPromptBlock.Phase) throws {
    var block: Block? = try prepared(in: phase)
    let refusal = show("Run the linter", turn: "t2", response: "r3", over: &block)
    #expect(refusal == nil)
    let current = try #require(block)
    #expect(current.phase == .reading)
    #expect(current.version == 2)
    #expect(current.text == "Run the linter")
    #expect(current.turnId == "t2")
    #expect(!current.heardWhole)
    #expect(current.edited == nil)
  }

  @Test("a new version drops the reason of a send that came back and gets its own voice send")
  func showResetsSendState() throws {
    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let outcome = Block.settle(&block, send: send, .restoreToField(discard: nil), reason: "Busy")
    #expect(outcome == .restored)
    let refusal = show("Run the linter", turn: "t2", response: "r3", over: &block)
    #expect(refusal == nil)
    var current = try #require(block)
    #expect(current.reason == nil)
    current.readingEnded(version: 2, .whole)
    let result = voice(&current, id: secondSend, response: "r4")
    #expect(try result.get() == Block.Send(id: secondSend, version: 2, text: "Run the linter", turnId: "t2"))
  }

  @Test(
    "editing or sending → show_prompt → refused with the reason, the block stays as it was",
    arguments: [(Block.Phase.editing, Block.ShowRefusal.editing), (.sending, .sending)])
  func showRefused(phase: InboxPromptBlock.Phase, expected: InboxPromptBlock.ShowRefusal) throws {
    var block: Block? = try prepared(in: phase)
    let before = block
    let refusal = show("Run the linter", turn: "t2", response: "r3", over: &block)
    #expect(refusal == expected)
    #expect(block == before)
  }

  // MARK: The reading

  @Test("reading → read to the end → ready, heard whole")
  func readWhole() throws {
    let block = try read(.whole)
    #expect(block.phase == .ready)
    #expect(block.heardWhole)
  }

  @Test("reading → cut by speech or not read → ready, not heard whole", arguments: [Block.ReadEnd.cut, .notRead])
  func readNotWhole(end: InboxPromptBlock.ReadEnd) throws {
    let block = try read(end)
    #expect(block.phase == .ready)
    #expect(!block.heardWhole)
  }

  @Test("the end of an older version's reading does not change the newer version")
  func olderReadingEnd() throws {
    var block: Block? = try shown()
    let refusal = show("Run the linter", turn: "t2", response: "r2", over: &block)
    #expect(refusal == nil)
    var current = try #require(block)
    let before = current
    current.readingEnded(version: 1, .whole)
    #expect(current == before)
    #expect(current.phase == .reading)
    #expect(!current.heardWhole)
  }

  @Test("a reading that ends whole after Edit stopped it leaves the block unheard")
  func readingEndAfterEdit() throws {
    var block = try shown()
    block.edit()
    block.readingEnded(version: 1, .whole)
    #expect(block.phase == .editing)
    #expect(!block.heardWhole)
    block.cancelEdit()
    let result = voice(&block)
    #expect(refusal(result) == .notHeardWhole)
  }

  @Test("a second end of a reading that already ended changes nothing")
  func readingEndAfterEnd() throws {
    var block = try read(.cut)
    let before = block
    block.readingEnded(version: 1, .whole)
    #expect(block == before)
  }

  // MARK: Edit and Cancel

  @Test("reading → Edit → the reading stops, editing the agent's text, not heard whole")
  func editWhileReading() throws {
    var block = try shown()
    let stopsReading = block.edit()
    #expect(stopsReading)
    #expect(block.phase == .editing)
    #expect(!block.heardWhole)
    #expect(block.edited == agentText)
  }

  @Test("ready → Edit → editing the agent's text, heard whole unchanged", arguments: [Block.ReadEnd.whole, .cut])
  func editWhenReady(end: InboxPromptBlock.ReadEnd) throws {
    var block = try read(end)
    let stopsReading = block.edit()
    #expect(!stopsReading)
    #expect(block.phase == .editing)
    #expect(block.heardWhole == (end == .whole))
    #expect(block.edited == agentText)
  }

  @Test(
    "editing → Cancel → ready with the agent's text, the person's text gone, heard whole unchanged",
    arguments: [Block.ReadEnd.whole, .cut])
  func cancelEdit(end: InboxPromptBlock.ReadEnd) throws {
    var block = try read(end)
    block.edit()
    block.editText(personText)
    #expect(block.edited == personText)
    block.cancelEdit()
    #expect(block.phase == .ready)
    #expect(block.edited == nil)
    #expect(block.text == agentText)
    #expect(block.heardWhole == (end == .whole))
  }

  @Test("Edit, a typed text and Cancel outside the phases that take them change nothing")
  func actionsOutsideTheirPhases() throws {
    var ready = try prepared(in: .ready)
    let readyBefore = ready
    ready.cancelEdit()
    ready.editText(personText)
    #expect(ready == readyBefore)

    var sending = try prepared(in: .sending)
    let sendingBefore = sending
    let stopsReading = sending.edit()
    sending.editText(personText)
    sending.cancelEdit()
    #expect(!stopsReading)
    #expect(sending == sendingBefore)
  }

  // MARK: The Send button

  @Test(
    "ready → Send → sending the agent's text with the turn of the show, read whole or not",
    arguments: [Block.ReadEnd.whole, .cut, .notRead])
  func buttonSendWhenReady(end: InboxPromptBlock.ReadEnd) throws {
    var block = try read(end)
    let sent = block.send(id: firstSend)
    let started = try #require(sent)
    #expect(started.send == Block.Send(id: firstSend, version: 1, text: agentText, turnId: "t1"))
    #expect(!started.stopsReading)
    #expect(block.phase == .sending)
    #expect(block.inFlight == started.send)
  }

  @Test("reading → Send → the reading stops, sending the agent's text, and the reading's late end changes nothing")
  func buttonSendWhileReading() throws {
    var block = try shown()
    let sent = block.send(id: firstSend)
    let started = try #require(sent)
    #expect(started.send == Block.Send(id: firstSend, version: 1, text: agentText, turnId: "t1"))
    #expect(started.stopsReading)
    #expect(block.phase == .sending)
    #expect(!block.heardWhole)
    block.readingEnded(version: 1, .whole)
    #expect(block.phase == .sending)
    #expect(!block.heardWhole)
  }

  @Test("editing → Send → sending the person's text with the turn kept from the show")
  func buttonSendEdited() throws {
    var block: Block? = try shown(turn: "t1")
    let refusal = show(turn: "t2", response: "r2", over: &block)
    #expect(refusal == nil)
    var current = try #require(block)
    current.readingEnded(version: 2, .whole)
    current.edit()
    current.editText(personText)
    let sent = current.send(id: firstSend)
    let started = try #require(sent)
    #expect(started.send == Block.Send(id: firstSend, version: 2, text: personText, turnId: "t2"))
    #expect(current.phase == .sending)
  }

  @Test("sending → Send or send_prompt → refused, nothing goes out a second time")
  func noSecondSend() throws {
    var block = try prepared(in: .sending)
    let before = block
    let again = block.send(id: secondSend)
    let result = voice(&block, id: secondSend, response: "r9")
    #expect(again == nil)
    #expect(refusal(result) == .sending)
    #expect(block == before)
  }

  // MARK: send_prompt

  @Test("ready → send_prompt → sending the agent's text: read whole, another response, after the person's word")
  func voiceSend() throws {
    var block = try read(.whole)
    let result = voice(&block)
    #expect(try result.get() == Block.Send(id: firstSend, version: 1, text: agentText, turnId: "t1"))
    #expect(block.phase == .sending)
  }

  @Test(
    "ready → send_prompt with one condition unmet → refused with that reason, the block stays as it was",
    arguments: UnmetVoiceCondition.allCases)
  func voiceRefused(condition: UnmetVoiceCondition) throws {
    var block = try read(condition == .readingCut ? .cut : condition == .readingNotRead ? .notRead : .whole)
    let before = block
    let result: Result<Block.Send, Block.VoiceSendRefusal>
    let expected: Block.VoiceSendRefusal
    switch condition {
    case .readingCut, .readingNotRead:
      result = voice(&block)
      expected = .notHeardWhole
    case .sameResponse:
      result = voice(&block, response: "r1")
      expected = .sameResponse
    case .noUtteranceAfterReading:
      result = voice(&block, utteranceAfterReading: false)
      expected = .notConfirmed
    case .loggedOut:
      result = voice(&block, loggedIn: false)
      expected = .loggedOut
    }
    #expect(refusal(result) == expected)
    #expect(block == before)
  }

  @Test("a voice send that came back is not repeated by voice for the same version; the button still sends it")
  func voiceOnceAVersion() throws {
    var current = try read(.whole)
    let first = try voice(&current).get()
    var block: Block? = current
    let outcome = Block.settle(&block, send: first, .restoreToField(discard: nil), reason: "Busy")
    #expect(outcome == .restored)
    current = try #require(block)
    #expect(current.phase == .ready)
    #expect(current.heardWhole)
    let result = voice(&current, id: secondSend, response: "r3")
    #expect(refusal(result) == .attempted)
    let sent = current.send(id: secondSend)
    #expect(sent?.send.text == agentText)
  }

  @Test("a button send that came back counts as this version's attempt for send_prompt")
  func voiceAfterButtonAttempt() throws {
    var current = try read(.whole)
    let sent = current.send(id: firstSend)
    let first = try #require(sent).send
    var block: Block? = current
    let outcome = Block.settle(&block, send: first, .restoreToField(discard: nil), reason: nil)
    #expect(outcome == .restored)
    current = try #require(block)
    let result = voice(&current, id: secondSend)
    #expect(refusal(result) == .attempted)
  }

  @Test("reading or editing → send_prompt → refused with the reason; in the show's own response the reason is that")
  func voiceWhileReadingOrEditing() throws {
    var reading = try shown()
    let before = reading
    let later = voice(&reading)
    let same = voice(&reading, response: "r1")
    #expect(refusal(later) == .reading)
    #expect(refusal(same) == .sameResponse)
    #expect(reading == before)

    var editing = try prepared(in: .editing)
    let editingBefore = editing
    let result = voice(&editing)
    #expect(refusal(result) == .editing)
    #expect(editing == editingBefore)
  }

  // MARK: The outcome of a send

  @Test("accepted or queued by the server → the block goes and the bar says it was sent")
  func sendDelivered() throws {
    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let outcome = Block.settle(&block, send: send, .none, reason: nil)
    #expect(outcome == .sent)
    #expect(block == nil)
  }

  @Test("the text comes back after the agent's text was sent → ready with that text and the reason")
  func sendRestoredToReady() throws {
    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let outcome = Block.settle(&block, send: send, .restoreToField(discard: UUID()), reason: "Busy")
    #expect(outcome == .restored)
    let current = try #require(block)
    #expect(current.phase == .ready)
    #expect(current.text == agentText)
    #expect(current.edited == nil)
    #expect(current.reason == "Busy")
    #expect(current.heardWhole)
    #expect(current.turnId == "t1")
    #expect(current.version == 1)
    #expect(current.inFlight == nil)
  }

  @Test("the text comes back after the person's text was sent → editing that text with the reason")
  func sendRestoredToEditing() throws {
    var current = try prepared(in: .editing)
    let sent = current.send(id: firstSend)
    let send = try #require(sent).send
    var block: Block? = current
    let outcome = Block.settle(&block, send: send, .restoreToField(discard: nil), reason: "Busy")
    #expect(outcome == .restored)
    current = try #require(block)
    #expect(current.phase == .editing)
    #expect(current.edited == personText)
    #expect(current.text == agentText)
    #expect(current.reason == "Busy")
    // Cancel goes back to the agent's text; voice sends only what stands in `ready`, and only once a version.
    current.cancelEdit()
    #expect(current.phase == .ready)
    #expect(current.edited == nil)
    let result = voice(&current, id: secondSend)
    #expect(refusal(result) == .attempted)
    let again = current.send(id: secondSend)
    #expect(again?.send.text == agentText)
  }

  @Test("the entry stays in the transcript with Retry → the block goes, and no copy of the text is handed back")
  func sendKeptInTranscript() throws {
    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let outcome = Block.settle(&block, send: send, .keepEntry, reason: nil)
    #expect(outcome == .keptInTranscript)
    #expect(block == nil)
  }

  @Test(
    "the text goes to the draft → the block goes and hands the sent text back",
    arguments: [Block.Phase.ready, .editing])
  func sendToDraft(from phase: InboxPromptBlock.Phase) throws {
    var current = try prepared(in: phase)
    let sent = current.send(id: firstSend)
    let send = try #require(sent).send
    var block: Block? = current
    let outcome = Block.settle(&block, send: send, .saveDraft, reason: "Not saved")
    #expect(outcome == .handOver(phase == .editing ? personText : agentText))
    #expect(block == nil)
  }

  @Test(
    "the outcome of a send of an ended block does not change the newer block's send",
    arguments: [SendRecovery.none, .restoreToField(discard: nil), .keepEntry, .saveDraft])
  func olderSendOutcome(recovery: SendRecovery) throws {
    var block: Block? = try prepared(in: .sending)
    let older = try inFlight(block)
    let handedBack = Block.end(&block)
    #expect(handedBack == nil)
    let refusal = show(over: &block)
    #expect(refusal == nil)
    var current = try #require(block)
    current.readingEnded(version: 1, .whole)
    let sent = current.send(id: secondSend)
    let newer = try #require(sent).send
    #expect(newer.version == older.version)
    block = current
    let stale = Block.settle(&block, send: older, recovery, reason: "Busy")
    #expect(stale == .notMine)
    #expect(block == current)
    let own = Block.settle(&block, send: newer, .none, reason: nil)
    #expect(own == .sent)
  }

  @Test("an outcome with no send in flight is not the block's: no block, or a repeat after the text came back")
  func outcomeWithoutSendInFlight() throws {
    var none: Block?
    let ticket = Block.Send(id: firstSend, version: 1, text: agentText, turnId: "t1")
    let withoutBlock = Block.settle(&none, send: ticket, .none, reason: nil)
    #expect(withoutBlock == .notMine)
    #expect(none == nil)

    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let first = Block.settle(&block, send: send, .restoreToField(discard: nil), reason: nil)
    #expect(first == .restored)
    let restored = block
    let repeated = Block.settle(&block, send: send, .none, reason: nil)
    #expect(repeated == .notMine)
    #expect(block == restored)
  }

  // MARK: The end of the conversation

  @Test(
    "the end with the block reading, ready or editing hands back the person's text, or else the agent's",
    arguments: [Block.Phase.reading, .ready, .editing])
  func endHandsBack(phase: InboxPromptBlock.Phase) throws {
    var block: Block? = try prepared(in: phase)
    let handedBack = Block.end(&block)
    #expect(handedBack == (phase == .editing ? personText : agentText))
    #expect(block == nil)
  }

  @Test("the end while sending leaves the text to that send's recovery: nothing handed back, the block goes")
  func endWhileSending() throws {
    var block: Block? = try prepared(in: .sending)
    let send = try inFlight(block)
    let handedBack = Block.end(&block)
    #expect(handedBack == nil)
    #expect(block == nil)
    let outcome = Block.settle(&block, send: send, .saveDraft, reason: nil)
    #expect(outcome == .notMine)
  }

  @Test("the end with no block hands nothing back")
  func endWithoutBlock() {
    var block: Block?
    let handedBack = Block.end(&block)
    #expect(handedBack == nil)
  }
}
