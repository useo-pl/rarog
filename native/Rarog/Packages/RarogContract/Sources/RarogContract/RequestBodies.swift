// Ciała POST — lustro schematów z `shared/src/protocol.ts`. Serwer waliduje je
// ściśle (`z.object` odcina nieznane pola), więc klient nie wysyła niczego spoza schematu.

/// `POST /api/sessions/<id>/messages`. `images` to data URL-e png/jpeg po downscale,
/// `files` dowolne pliki jako data URL.
///
/// `clientMessageId`: UUID nadany RAZ na wiadomość i ten sam przy każdym „Ponów" — serwer
/// przyjmuje go najwyżej raz w oknie 24 h (powtórka: 202 `replayed`, inna treść: 409
/// `client-id-conflict`). Brak pola = wysyłka bez idempotencji.
///
/// `queueAware`: klient umie czekać na echo odroczone — prompt wysłany w trakcie pracy agenta staje
/// w transkrypcie dopiero, gdy CLI go weźmie, a 202 niesie wtedy `queued: true`. Na drucie literał `true`
/// albo brak pola (`nil`); starszy serwer pole odcina.
///
/// `source` and `expectedConversation`: a prompt the voice agent across sessions sends. `source` marks the audit entry
/// of the paste as the agent's; `expectedConversation` is the `conversation` token the agent read, and a session that
/// moved to another conversation answers 409 `session.conversation-changed` with nothing sent. The server takes them
/// only together (one without the other is a 400), so they come in as one ``MessageSender`` and cannot be set one by
/// one. With the server's mode across sessions off, such a body is a 503. `nil` = the field is absent from the body.
public struct MessageBody: Sendable, Equatable, Encodable {
  public var text: String
  public var images: [String]?
  public var files: [FileAttachment]?
  public var clientMessageId: String?
  public var queueAware: Bool?
  public private(set) var source: MessageSource?
  public private(set) var expectedConversation: String?

  public init(
    text: String, images: [String]? = nil, files: [FileAttachment]? = nil, clientMessageId: String? = nil,
    queueAware: Bool = false, sender: MessageSender? = nil
  ) {
    self.text = text
    self.images = images
    self.files = files
    self.clientMessageId = clientMessageId
    self.queueAware = queueAware ? true : nil
    self.source = sender?.source
    self.expectedConversation = sender?.expectedConversation
  }
}

/// The sender of a message (`MessageBody.source`); the server knows no other value (another one is a 400).
public enum MessageSource: String, Sendable, Equatable, Encodable {
  case voiceAgent = "voice-agent"
}

/// Who sends a message and the `conversation` token it read: the pair `MessageBody` puts on the wire as `source` and
/// `expectedConversation`, always both.
public struct MessageSender: Sendable, Equatable {
  public var source: MessageSource
  public var expectedConversation: String

  public init(source: MessageSource, expectedConversation: String) {
    self.source = source
    self.expectedConversation = expectedConversation
  }
}

/// Załącznik plikowy wiadomości: nazwa po sanityzacji i treść jako data URL.
public struct FileAttachment: Sendable, Equatable, Encodable {
  public var name: String
  public var dataUrl: String

  public init(name: String, dataUrl: String) {
    self.name = name
    self.dataUrl = dataUrl
  }
}

/// Decyzja na karcie zgody. Brak wartości „expired" — tę nadaje wyłącznie serwer.
public enum PermissionDecision: String, Sendable, Equatable, Encodable {
  case allow
  case allowAlways = "allow-always"
  case deny
  /// Zwolnienie karty kanału zgód (`channel: 'hook'`) do terminala: hook wychodzi bez wyniku, dialog zostaje.
  case release
}

/// `POST /api/sessions/<id>/permissions/<permId>`.
public struct PermissionDecisionBody: Sendable, Equatable, Encodable {
  public var decision: PermissionDecision
  public var message: String?

  public init(decision: PermissionDecision, message: String? = nil) {
    self.decision = decision
    self.message = message
  }
}

/// `POST /api/presence` — „patrzę" / „już nie patrzę". `clientId` PER SCENA (1…64 znaki),
/// `sessionId` = otwarty transkrypt (brak = lista).
public struct PresenceBody: Sendable, Equatable, Encodable {
  public var clientId: String
  public var visible: Bool
  public var sessionId: String?

  public init(clientId: String, visible: Bool, sessionId: String? = nil) {
    self.clientId = clientId
    self.visible = visible
    self.sessionId = sessionId
  }
}

/// `POST /api/client-log` — ślady diagnostyczne, nigdy treść rozmowy.
public struct ClientLogBody: Sendable, Equatable, Encodable {
  public struct Event: Sendable, Equatable, Encodable {
    public var at: String
    public var level: String
    public var msg: String

    public init(at: String, level: String, msg: String) {
      self.at = at
      self.level = level
      self.msg = msg
    }
  }

  public var events: [Event]

  public init(events: [Event]) {
    self.events = events
  }
}
