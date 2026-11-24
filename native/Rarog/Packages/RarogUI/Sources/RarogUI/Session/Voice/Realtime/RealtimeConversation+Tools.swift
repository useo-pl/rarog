import Foundation

// Model tools of the voice conversation (`RealtimeConversation`): the call of a host tool (`RealtimeToolSpec`), its
// asynchronous result and one `response.create` after all results of a closed response. Owner: voice agent.
// Conversation rules: `RealtimeConversation.swift`. While speech over the answer waits for its verdict, calls wait
// too (`RealtimeConversation+Noise.swift`).

extension RealtimeConversation {
  func call(response: String, callId: String, name: String, arguments: String) {
    guard audioRunning, !interrupted.contains(response) else { return }
    answers.calledTool.insert(response)
    callsByResponse[response, default: []].append(callId)
    let tool = content.tools.first { $0.name == name }
    usage.toolCall(tool?.tally)
    // The host reads the arguments now; the effects wait in the action until the call is performed.
    let action = tool.map { $0.action(arguments) }
    // Speech over the answer may be the user stopping it: the call waits for the verdict, registered with its
    // response, so the response's results do not go out without it.
    if hold(.call(response: response, callId: callId, action: action)) { return }
    perform(action, response: response, callId: callId)
  }

  /// The call itself, once no window holds it. `nil`: a tool the host does not have.
  func perform(_ action: RealtimeToolAction?, response: String, callId: String) {
    switch action {
    case let .answer(output)?:
      deliver(output, callId: callId, response: response, token: turnToken)
      return
    case let .work(checking, work)?:
      if checking { asking.insert(callId) } else { sending.insert(callId) }
      run(callId: callId, response: response) { .output(await work()) }
    case let .workAtTurn(checking, work)?:
      if checking { asking.insert(callId) } else { sending.insert(callId) }
      let turn = toolTurn(response)
      run(callId: callId, response: response) { .output(await work(turn)) }
    case let .workAndRead(checking, work)?:
      if checking { asking.insert(callId) } else { sending.insert(callId) }
      let turn = toolTurn(response)
      run(callId: callId, response: response) { await work(turn) }
    case let .showPrompt(place)?:
      let version = promptVersion + 1
      switch place(version) {
      case let .refused(output):
        deliver(output, callId: callId, response: response, token: turnToken)
        return
      case let .shown(output):
        promptVersion = version
        fieldPrompt = version
        promptResponse = response
        committedSincePrompt = 0
        deliver(output, callId: callId, response: response, token: turnToken)
      }
    case let .sendPrompt(refusals, send)?:
      guard let version = fieldPrompt else {
        let output = promptVersion == 0 ? refusals.noPrompt : refusals.promptGone
        deliver(output, callId: callId, response: response, token: turnToken)
        return
      }
      guard promptResponse != response, committedSincePrompt > 0 else {
        deliver(
          Self.toolError(
            "The user has not confirmed yet. Read the prompt aloud, ask whether to send it and wait for the answer."),
          callId: callId, response: response, token: turnToken)
        return
      }
      sending.insert(callId)
      run(callId: callId, response: response) { .output(await send(version)) }
    case nil:
      deliver(Self.toolError("Unknown tool."), callId: callId, response: response, token: turnToken)
    }
    updatePhase()
  }

  /// The moment of a call that `response` makes (``RealtimeToolTurn``).
  func toolTurn(_ response: String) -> RealtimeToolTurn {
    RealtimeToolTurn(response: response, utterances: utterances, utteranceAfterReading: readings.afterMark)
  }

  /// The work of a call between `run` and the start of its task.
  struct UnstartedWork {
    let callId: String
    let response: String
    let generation: Int
    let token: Int
    let work: @MainActor () async -> RealtimeToolResult
  }

  /// Wywołanie asynchroniczne: wynik liczy się tylko w tej samej generacji i przed przerwaniem mową. The work is
  /// registered before its task, so a window of speech over the answer that opens before the task starts takes it
  /// over (`RealtimeConversation+Noise.swift`). A text to read goes to the reading first
  /// (`RealtimeConversation+Reading.swift`), and the result goes at its end.
  func run(callId: String, response: String, _ work: @escaping @MainActor () async -> RealtimeToolResult) {
    if hold(.work(response: response, callId: callId, work: work)) { return }
    unstartedWork.append(
      UnstartedWork(callId: callId, response: response, generation: generation, token: turnToken, work: work))
    Task { [weak self] in
      // Koniec rozmowy albo przerwanie mową między wywołaniem a startem zadania: narzędzie nie rusza (wysyłka
      // promptu po końcu rozmowy poszłaby do sesji). Nor when a window took the work over.
      guard let entry = self?.startWork(callId) else { return }
      let result = await entry.work()
      guard let self, self.current(entry.generation) else { return }
      switch result {
      case let .output(output):
        self.deliver(output, callId: callId, response: entry.response, token: entry.token)
      case let .read(text, then, progress):
        self.read(
          text, then: then, progress: progress,
          call: ToolCall(callId: callId, response: entry.response, generation: entry.generation, token: entry.token))
      }
    }
  }

  /// A call whose result is still to come: the conversation run and the exchange it belongs to.
  struct ToolCall {
    let callId: String
    let response: String
    let generation: Int
    let token: Int
  }

  /// The task of a call starts: its work, while it still waits here, from the same generation and with no cut since
  /// the call.
  private func startWork(_ callId: String) -> UnstartedWork? {
    guard let index = unstartedWork.firstIndex(where: { $0.callId == callId }) else { return nil }
    let entry = unstartedWork.remove(at: index)
    return accepts(generation: entry.generation, token: entry.token, response: entry.response) ? entry : nil
  }

  func accepts(generation: Int, token: Int, response: String) -> Bool {
    current(generation) && token == turnToken && !interrupted.contains(response)
  }

  func deliver(_ output: String, callId: String, response: String, token: Int) {
    guard token == turnToken, !interrupted.contains(response) else { return }
    asking.remove(callId)
    sending.remove(callId)
    results[callId] = RealtimeSecretMask.apply(output)
    flush(response)
    updatePhase()
  }

  /// Wyniki wszystkich wywołań zamkniętej odpowiedzi, potem jedno `response.create`; `true`, gdy je wysłało.
  @discardableResult
  func flush(_ response: String) -> Bool {
    guard doneResponses.contains(response), let calls = callsByResponse[response], !calls.isEmpty,
      calls.allSatisfy({ results[$0] != nil })
    else { return false }
    // The item of a noise is still in the conversation: the results go after its delete
    // (`RealtimeConversation+Noise.swift`).
    if resultsAfterNoise != nil {
      resultsAfterNoise?.insert(response)
      return false
    }
    for callId in calls {
      send(RealtimeClientEvent.functionOutput(callId: callId, output: results[callId] ?? ""))
      results[callId] = nil
    }
    callsByResponse[response] = nil
    orderResponse()
    return true
  }

  static func argument(_ arguments: String, _ field: String) -> String? {
    guard let data = arguments.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let value = object[field] as? String
    else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  /// The prompt of the last `show_prompt` left the message field (a send took it, the user cleared or replaced it):
  /// `send_prompt` refuses until the next `show_prompt`.
  func promptLeftField() {
    fieldPrompt = nil
  }

  static func toolError(_ message: String) -> String { RealtimeClientEvent.encode(["error": message]) }
  static func toolResult(_ message: String) -> String { RealtimeClientEvent.encode(["result": message]) }
}
