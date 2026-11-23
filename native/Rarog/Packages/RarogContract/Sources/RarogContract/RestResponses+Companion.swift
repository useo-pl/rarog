// Agent głosowy — odpowiedź `POST /api/sessions/:id/companion/ask`, lustro `companionAskSchema` z
// `shared/src/rest.ts`, i klucz krótki `POST /api/companion/token` (`companionTokenSchema`). Złote odpowiedzi:
// `companion.ask*.json`, `companion.token.json` i `error.companion-*.json` w `shared/fixtures/rest/`.
// The last turns of a session for the voice agent across sessions: `companionTurnsSchema`, golden response
// `companion.turns.json`; its session catalog: `companionSessionsSchema`, golden response `companion.sessions.json`.
// Ta sama tolerancja co reszta REST: nieznane klucze odcięte, `null` i zły typ odrzucają odpowiedź.

/// 200 pytania o sesję: odpowiedź do przeczytania na głos (1–3 zdania), czy sesja ją zawiera, i propozycja promptu
/// dla agenta, gdy nie zawiera (brak pola = brak propozycji). Typowe kształty sekretów w `answer` i `prompt`
/// serwer już zamaskował (`[secret]`).
public struct CompanionAnswer: Sendable, Equatable, Decodable {
  public var answer: String
  public var found: Bool
  public var prompt: String?

  enum CodingKeys: String, CodingKey { case answer, found, prompt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    answer = try c.required(.answer)
    found = try c.required(.found)
    // Zod `.string().min(1).optional()`: brak = brak propozycji, pusty łańcuch odrzuca odpowiedź.
    prompt = c.contains(.prompt) ? try c.nonEmpty(.prompt) : nil
  }
}

/// 200 `POST /api/companion/token`: klucz KRÓTKI OpenAI Realtime (60 s od wybicia; w tym czasie otwiera kolejne sesje
/// Realtime, a otwarta sesja żyje dłużej niż on), jego ważność (ISO 8601) i model, który serwer ustawił przy wybiciu
/// (`RAROG_COMPANION_MODEL`). Stały klucz OpenAI zostaje na serwerze.
///
/// **`value` nie trafia do żadnego logu ani opisu.** `description` i lustro (`dump`, `print`) pokazują wyłącznie
/// model i ważność (wzór `VoiceToken`).
public struct CompanionToken: Sendable, Equatable, Decodable, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  public let value: String
  public let expiresAt: String
  public let model: String

  enum CodingKeys: String, CodingKey { case value, expiresAt, model }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    value = try c.nonEmpty(.value)
    expiresAt = try c.required(.expiresAt)
    model = try c.nonEmpty(.model)
  }

  public var description: String { "CompanionToken(model: \(model), expiresAt: \(expiresAt), klucz ukryty)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["model": model, "expiresAt": expiresAt]) }
}

/// 200 `POST /api/companion/speech-token`: a temporary Soniox TTS key for one voice conversation (it opens new
/// streams until `expiresAt`; streams already open live on), the EU WebSocket address, model, voice and sample rate
/// set by the server. Mirror of `companionSpeechTokenSchema` in `shared/src/rest.ts`.
///
/// **`apiKey` never goes to a log or a description.** `description` and the mirror show the model, voice and
/// expiry only (the `CompanionToken` pattern).
public struct CompanionSpeechToken: Sendable, Equatable, Decodable, CustomStringConvertible,
  CustomDebugStringConvertible, CustomReflectable
{
  public let apiKey: String
  public let expiresAt: String
  public let webSocketUri: String
  public let model: String
  public let voice: String
  public let sampleRate: Int

  enum CodingKeys: String, CodingKey { case apiKey, expiresAt, webSocketUri, model, voice, sampleRate }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    apiKey = try c.nonEmpty(.apiKey)
    expiresAt = try c.required(.expiresAt)
    webSocketUri = try c.nonEmpty(.webSocketUri)
    model = try c.nonEmpty(.model)
    voice = try c.nonEmpty(.voice)
    sampleRate = try c.required(.sampleRate)
  }

  public var description: String {
    "CompanionSpeechToken(model: \(model), voice: \(voice), expiresAt: \(expiresAt), key hidden)"
  }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["model": model, "voice": voice, "expiresAt": expiresAt, "sampleRate": sampleRate])
  }
}

/// 200 `GET /api/sessions/:id/companion/turns?count=1..3`: the messages of the last turns of the engine conversation
/// the session writes now, in the shape of the session stream (`seq` numbers the messages of this response from 1,
/// it is not the stream's `seq`). `conversation` is an opaque token of that conversation: another one after `/clear`
/// or `/resume` in the pane and after a server restart, never the engine's id. `stateSince` is the session's
/// `stateSince` at the read; `complete == false` = the read window starts inside the oldest returned turn.
public struct CompanionTurns: Sendable, Equatable, Decodable {
  public var messages: [TranscriptMessage]
  public var conversation: String
  public var stateSince: String
  public var complete: Bool

  enum CodingKeys: String, CodingKey { case messages, conversation, stateSince, complete }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    messages = try c.required(.messages)
    conversation = try c.nonEmpty(.conversation)
    stateSince = try c.required(.stateSince)
    complete = try c.required(.complete)
  }
}

/// 200 `GET /api/companion/sessions`: the voice agent's session catalog, one row per session it may see (a Claude
/// Code session in scope). `id` is the session's id in the session list; `conversation` is the same opaque token as in
/// ``CompanionTurns``, so a row and a turns read of one session compare; `stateSince` as the session list carries it.
/// `asksOwner` is `true` while the session waits for input and its newest message asks the owner (the question block
/// of `MarkdownQuestion` in RarogUI); on the wire it is the literal `true` or no field. A session without a row is
/// not the voice agent's to see.
public struct CompanionSessions: Sendable, Equatable, Decodable {
  public struct Row: Sendable, Equatable, Decodable {
    public var id: String
    public var asksOwner: Bool
    public var conversation: String
    public var stateSince: String

    enum CodingKeys: String, CodingKey { case id, asksOwner, conversation, stateSince }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      id = try c.nonEmpty(.id)
      let flag: Bool? = try c.optional(.asksOwner)
      if flag == false {
        throw contractViolation(c.codingPath + [CodingKeys.asksOwner], "asksOwner is the literal true")
      }
      asksOwner = flag == true
      conversation = try c.nonEmpty(.conversation)
      stateSince = try c.required(.stateSince)
    }
  }

  public var sessions: [Row]

  enum CodingKeys: String, CodingKey { case sessions }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessions = try c.required(.sessions)
  }
}
