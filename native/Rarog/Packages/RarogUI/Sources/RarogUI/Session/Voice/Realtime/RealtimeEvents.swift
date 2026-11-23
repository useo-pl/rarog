import Foundation

// Zdarzenia OpenAI Realtime (GA) w obie strony: budowa zdarzeń klienta i odczyt zdarzeń serwera, bez stanu.
// Właściciel: agent głosowy. Zdarzenie serwera, którego rozmowa nie potrzebuje, czyta się
// jako `.other` z samym typem; treści w diagnostyce nie ma nigdy.

enum RealtimeClientEvent {
  static func encode(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }

  /// A text session: the answers come as text only, Soniox speaks them. `tools`: the host's function schemas.
  static func sessionUpdate(instructions: String, tools: [[String: Any]]) -> String {
    encode([
      "type": "session.update", "session": RealtimeInstructions.session(instructions: instructions, tools: tools),
    ])
  }

  static func appendAudio(_ pcm: Data) -> String {
    encode(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
  }

  /// Drops the microphone audio the server holds and not yet committed (mute): a half-spoken utterance is not left
  /// open. The server answers `input_audio_buffer.cleared`, which the conversation reads as `.other`.
  static func clearAudio() -> String { encode(["type": "input_audio_buffer.clear"]) }

  /// Element rozmowy z nowymi turami sesji: wiadomość systemowa, żeby model nie wziął jej za wypowiedź rozmówcy.
  static func sessionUpdateItem(_ text: String) -> String {
    encode([
      "type": "conversation.item.create",
      "item": ["type": "message", "role": "system", "content": [["type": "input_text", "text": text]]] as [String: Any],
    ])
  }

  static func functionOutput(callId: String, output: String) -> String {
    encode([
      "type": "conversation.item.create",
      "item": ["type": "function_call_output", "call_id": callId, "output": output],
    ])
  }

  static func responseCreate() -> String { encode(["type": "response.create"]) }

  /// Anulowanie odpowiedzi zamówionej przed przerwaniem mową, którą serwer utworzył dopiero po nim.
  static func responseCancel(_ responseId: String) -> String {
    encode(["type": "response.cancel", "response_id": responseId])
  }

  /// Removes an item from the conversation (an answer item Soniox speech did not finish saying).
  static func deleteItem(_ itemId: String) -> String {
    encode(["type": "conversation.item.delete", "item_id": itemId])
  }

  /// An assistant message with `text` in place of a deleted answer item, after `previous` (`nil`: at the end).
  static func assistantText(_ text: String, after previous: String?) -> String {
    var event: [String: Any] = [
      "type": "conversation.item.create",
      "item": [
        "type": "message", "role": "assistant", "content": [["type": "output_text", "text": text]],
      ] as [String: Any],
    ]
    if let previous { event["previous_item_id"] = previous }
    return encode(event)
  }
}

/// Błąd z `error` albo z `response.done` o statusie `failed`: tylko pola, z których rozmowa wnioskuje.
struct RealtimeServerError: Sendable, Equatable {
  var type: String?
  var code: String?
  var message: String?
  var param: String?

  enum Kind: Sendable, Equatable {
    /// Limit konta OpenAI (tokeny albo żądania na minutę): ponowienie trafiłoby w ten sam limit.
    case rateLimit
    /// Pole `instructions` ponad limit tokenów (zmierzone: 68 224 tokeny odrzucone, limit 65 536).
    case instructionsTooLong
    /// Wyścig `response.create` z odpowiedzią, której serwer jeszcze nie zamknął — nieszkodliwy.
    case activeResponse
    case other
  }

  /// Klasyfikacja po kodzie i typie, a gdy ich brak — po słowach komunikatu. Kodu błędu limitu instrukcji pomiar
  /// nie zapisał, więc rozpoznanie stoi na polu `param` i słowach „instructions” i „tokens”.
  var kind: Kind {
    let code = (code ?? "").lowercased()
    let type = (type ?? "").lowercased()
    let message = (message ?? "").lowercased()
    if code.contains("rate_limit") || type.contains("rate_limit") || message.contains("rate limit")
      || message.contains("tokens per min")
    {
      return .rateLimit
    }
    if code == "conversation_already_has_active_response" { return .activeResponse }
    let aboutInstructions = (param ?? "").contains("instructions") || message.contains("instructions")
    let tooLong = ["token", "too long", "maximum", "exceed", "length"].contains { message.contains($0) }
      || code.contains("max_length") || code.contains("too_long")
    if aboutInstructions && tooLong { return .instructionsTooLong }
    return .other
  }

  init(type: String? = nil, code: String? = nil, message: String? = nil, param: String? = nil) {
    self.type = type
    self.code = code
    self.message = message
    self.param = param
  }

  init(_ object: [String: Any]) {
    type = object["type"] as? String
    code = object["code"] as? String
    message = object["message"] as? String
    param = object["param"] as? String
  }
}

/// Zdarzenie serwera w kształcie, którego potrzebuje rozmowa.
enum RealtimeServerEvent: Sendable, Equatable {
  /// Pierwsze zdarzenie gniazda; z całej sesji tylko jej model.
  case sessionCreated(model: String?)
  case sessionUpdated
  case error(RealtimeServerError)
  /// `audio_start_ms` and `audio_end_ms`: the VAD's times on the input audio axis, `nil` when the event carries none
  /// (`RealtimeBargeIn.speechLength`).
  case speechStarted(itemId: String?, audioStartMs: Int?)
  case speechStopped(audioEndMs: Int?)
  case committed(itemId: String?)
  case responseCreated(id: String)
  /// Text of an answer item in a text session (Soniox speaks it).
  case textDelta(responseId: String, itemId: String, text: String)
  /// The item's text is complete.
  case textDone(responseId: String, itemId: String)
  /// An assistant message item joined the conversation after `previousId` (`nil`: the event names none).
  case assistantItemAdded(itemId: String, previousId: String?)
  /// Początek elementu wywołania: nazwa narzędzia, gdy `arguments.done` jej nie niesie.
  case functionCallAdded(callId: String, name: String)
  case functionCall(responseId: String, callId: String, name: String, arguments: String)
  /// End of a response; `usage` is `nil` when the event carries none.
  case responseDone(id: String, status: String, error: RealtimeServerError?, usage: RealtimeUsage?)
  case other(String)

  static func parse(_ text: String) -> RealtimeServerEvent? {
    guard let data = text.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let type = object["type"] as? String
    else { return nil }
    let string = { (key: String) in object[key] as? String }
    switch type {
    case "session.created":
      return .sessionCreated(model: (object["session"] as? [String: Any])?["model"] as? String)
    case "session.updated":
      return .sessionUpdated
    case "error":
      return .error(RealtimeServerError(object["error"] as? [String: Any] ?? [:]))
    case "input_audio_buffer.speech_started":
      return .speechStarted(itemId: string("item_id"), audioStartMs: object["audio_start_ms"] as? Int)
    case "input_audio_buffer.speech_stopped":
      return .speechStopped(audioEndMs: object["audio_end_ms"] as? Int)
    case "input_audio_buffer.committed":
      return .committed(itemId: string("item_id"))
    case "response.created":
      guard let id = (object["response"] as? [String: Any])?["id"] as? String else { return nil }
      return .responseCreated(id: id)
    case "response.output_text.delta":
      guard let responseId = string("response_id"), let itemId = string("item_id"), let text = string("delta")
      else { return nil }
      return .textDelta(responseId: responseId, itemId: itemId, text: text)
    case "response.output_text.done":
      guard let responseId = string("response_id"), let itemId = string("item_id") else { return nil }
      return .textDone(responseId: responseId, itemId: itemId)
    case "conversation.item.added", "conversation.item.created":
      guard let item = object["item"] as? [String: Any], item["type"] as? String == "message",
        item["role"] as? String == "assistant", let id = item["id"] as? String
      else { return .other(type) }
      return .assistantItemAdded(itemId: id, previousId: string("previous_item_id"))
    case "response.output_item.added":
      guard let item = object["item"] as? [String: Any], item["type"] as? String == "function_call",
        let callId = item["call_id"] as? String
      else { return .other(type) }
      return .functionCallAdded(callId: callId, name: item["name"] as? String ?? "")
    case "response.function_call_arguments.done":
      guard let responseId = string("response_id"), let callId = string("call_id") else { return nil }
      return .functionCall(
        responseId: responseId, callId: callId, name: string("name") ?? "", arguments: string("arguments") ?? "")
    case "response.done":
      guard let response = object["response"] as? [String: Any], let id = response["id"] as? String else { return nil }
      let details = response["status_details"] as? [String: Any]
      let error = (details?["error"] as? [String: Any]).map(RealtimeServerError.init)
      return .responseDone(
        id: id, status: response["status"] as? String ?? "", error: error,
        usage: RealtimeUsage(response["usage"] as? [String: Any]))
    default:
      return .other(type)
    }
  }
}
