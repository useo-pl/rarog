import Foundation

// Speech over the answer while Soniox speaks it: the synthesis stops, and the conversation at OpenAI keeps only what
// the user heard. Owner: voice agent. The barge-in itself stands in `RealtimeConversation+Playback.swift`, Soniox
// speech in `RealtimeConversation+Speech.swift`.
//
// Rules:
// - Every answer item not over yet stops: a running stream gets Soniox `cancel`, a waiting one never starts
//   (`tts cancel` in `client.log` for each). Late deltas of an interrupted response open no stream.
// - The heard text of an item = the characters Soniox returned whose end lies within the samples played of it
//   (`SonioxSpokenText.heard`). `conversation.item.truncate` cuts assistant audio only, and a text item has none, so
//   it is fixed with `conversation.item.delete` and then `conversation.item.create` (assistant, `output_text` with the heard text,
//   `previous_item_id` = the item before it). Nothing heard: `delete` only, no empty item. An item played out whole
//   stays as it is. A system item "the user heard only: …" is not used: measured on the live API, the model then
//   quoted the unheard rest anyway (3 of 3 runs), while `delete` + `create` left only the heard text (3 of 3).
// - The fixes of a response go out once its `response.done` came (items of an open response may still change); one
//   that is already over is fixed at once. A response created after the speech is cancelled, and its items are
//   deleted at its `response.done`.
// - The fixes go before the next `response.create`: an utterance committed while an interrupted response is still
//   open, or while a response ordered before the speech has not been created yet, holds its `response.create` until
//   those fixes went out. Such an order ends with its `response.created` (the response is cancelled, above) or with
//   the `activeResponse` error (the server never creates it; the active response's `response.done` follows). At a
//   `response.done` its fixes go out before the held order and before the retry after `activeResponse`.
// - An error that ends one stream (`SonioxSpeech.Failure.endsStreamOnly`: the stream limit, a request timeout) fixes
//   the item to what Soniox said once it played out.
//   Its later deltas go nowhere, also after it played out, so no second stream speaks it from the start.
// - `client.log` gets no text: the fixes themselves are not logged.

extension RealtimeConversation {
  /// Speech over the answer, or a lost playback: `played` is the sample the user heard up to on the playback axis;
  /// `responses` are interrupted besides those with items still speaking or on the axis.
  func speechInterrupted(played: Int, responses: Set<String>) {
    var interruptedNow = responses
    for (item, entry) in tts.items {
      interruptedNow.insert(entry.response)
      let span = items[item]
      let heardSamples = span.map { min($0.count, max(0, played - $0.start)) } ?? 0
      if !entry.synthesized {
        tts.client?.cancel(item)
        handlers.diagnostic(.speechCancel)
        tts.counts[entry.response, default: SpeechCount()].cut = true
        tts.total.cut = true
      }
      if entry.synthesized, !entry.cut, heardSamples >= (span?.count ?? 0) {
        tts.settled.insert(item)
      } else {
        tts.heardText[item] = entry.spoken.heard(
          playedSamples: heardSamples, sampleRate: RealtimeAudioFormat.sampleRate)
      }
    }
    for entry in items.values { interruptedNow.insert(entry.response) }
    tts.items = [:]
    interrupted.formUnion(interruptedNow)
    for response in interruptedNow {
      if doneResponses.contains(response) {
        fix(response)
        logSpeech(response)
      } else {
        tts.toFix.insert(response)
      }
    }
  }

  /// A response ordered before the speech and created after it: cancelled, so its items leave the conversation.
  func speechResponseCancelled(_ response: String) {
    tts.toFix.insert(response)
  }

  /// `conversation.item.added` of an assistant item: the item before it, for the item that may replace it.
  func speechItemAdded(_ item: String, previous: String?) {
    guard let previous else { return }
    tts.previous[item] = previous
  }

  /// `response.done`: an interrupted response gets its fixes; any other only for items a stream-only error cut.
  func fixAtDone(_ response: String) {
    if tts.toFix.contains(response) {
      fix(response)
      return
    }
    for item in tts.written[response] ?? [] where tts.heardText[item] != nil { fixItem(item) }
  }

  /// Fixes may still come before the next `response.create`: an interrupted response has not sent them, or a
  /// response ordered before the speech is not created yet (once created it is cancelled and its items deleted).
  private var fixesPending: Bool { !tts.toFix.isEmpty || ordersBeforeSpeechPending }

  /// The committed utterance waits with its `response.create` while fixes may still come.
  func holdOrderForFixes() -> Bool {
    guard fixesPending else { return false }
    tts.orderHeld = true
    return true
  }

  /// After a `response.done`: the held `response.create` goes out once no fixes may come. `ordered`: the done
  /// already ordered a response (tool results), so the held one is that one. True when the hold ended. An order from
  /// before the speech that the server refused (`activeResponse`) is no longer pending; the response that was
  /// still active ends with its own `response.done`, which then releases the hold.
  func releaseHeldOrder(ordered: Bool) -> Bool {
    guard tts.orderHeld, !fixesPending else { return false }
    tts.orderHeld = false
    if !ordered { orderResponse() }
    return true
  }

  // MARK: - Fixes

  /// Every text item of the response that the conversation does not keep as it is.
  private func fix(_ response: String) {
    tts.toFix.remove(response)
    for item in tts.written.removeValue(forKey: response) ?? [] where !tts.settled.contains(item) { fixItem(item) }
  }

  /// `delete`, then the heard text in its place (none when nothing was heard).
  func fixItem(_ item: String) {
    let heard = tts.heardText.removeValue(forKey: item) ?? ""
    send(RealtimeClientEvent.deleteItem(item))
    if !heard.isEmpty { send(RealtimeClientEvent.assistantText(heard, after: tts.previous[item])) }
    tts.previous[item] = nil
    tts.settled.insert(item)
  }
}
