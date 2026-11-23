// Odpowiedzi REST — lustro `shared/src/rest.ts`. Ta sama reguła tolerancji co ramki:
// nieznane klucze odcięte, `null` w polu opcjonalnym odrzuca odpowiedź, brak flagi ma ustalone
// znaczenie. Złote odpowiedzi: `shared/fixtures/rest/` (`RestFixturesTests`).

/// System maszyny serwera z `GET /api/version` (`SERVER_SYSTEMS` z `shared/src/rest.ts`) + wartownik klienta.
///
/// `unsupported` to wartość, którą zna WYŁĄCZNIE klient: system nowszego serwera spoza tej listy (np. `freebsd`)
/// psuje samo pole, nie całą sondę wersji (``ContractEnum/clientSentinel``).
public enum ServerSystem: String, ContractEnum {
  case macos
  case linux
  case other
  case unsupported

  public static var clientSentinel: ServerSystem? { .unsupported }
}

/// `GET /api/version` — sonda poświadczenia przy starcie i flagi możliwości serwera.
///
/// Świadomie BEZ `hookSeenAgo` (diagnostyka operatora): apka go nie używa, a każde odczytane pole
/// to kolejny powód, żeby odpowiedź przestała się dekodować. Pól `release`, `webPushMutedClasses`,
/// `gitUiEnabled` i `gitWriteEnabled` serwer nie ma (starszy serwer je wysyła — odcina je reguła
/// nieznanych kluczy).
public struct VersionInfo: Sendable, Equatable, Decodable {
  public var version: String
  public var protocolVersion: Int
  public var serverStartId: String
  /// Brak = dyktowanie WŁĄCZONE (starszy serwer).
  public var voiceEnabled: Bool?
  /// Brak = funkcja wyłączona.
  public var termEnabled: Bool?
  public var notesEnabled: Bool?
  /// Agent głosowy przy sesji: trasa `POST /api/sessions/:id/companion/ask` odpowiada. Brak = wyłączony
  /// (serwer sprzed pola).
  public var companionEnabled: Bool?
  /// The voice agent speaks with a Soniox voice: `POST /api/companion/speech-token` gives keys. Missing = the
  /// OpenAI voice (server before the field).
  public var companionSpeech: Bool?
  /// The voice agent's mode across sessions works: `GET /api/sessions/:id/companion/turns` answers. Missing = off
  /// (also a server before the field); the server never sends `false`.
  public var companionSessions: Bool?
  /// Nazwa tailnetu; `null` = nie wiadomo (serwer pisze `null`, nie pomija klucza).
  public var tailnet: String?
  /// Kanał APNs apki natywnej. Brak = wyłączony (starszy serwer).
  public var apnsEnabled: Bool?
  /// Możliwości serwera po nazwie (`SERVER_CAPABILITIES` serwera). Brak pola = pusta lista (serwer
  /// sprzed pola), `null` odrzuca odpowiedź; nazwy, których apka nie zna, zostają na liście bez znaczenia.
  public var capabilities: [String]
  /// Serwer iroh (``ServerIroh``); `nil` = serwer bez nasłuchu iroh (`null`) albo sprzed pola (brak klucza).
  public var iroh: ServerIroh?
  /// System maszyny serwera (``ServerSystem``). `nil` = serwer sprzed pola (brak klucza), czyli „nie wiem”;
  /// wartość spoza listy = ``ServerSystem/unsupported``; `null` i zły typ odrzucają odpowiedź jak w każdym polu.
  public var system: ServerSystem?

  enum CodingKeys: String, CodingKey {
    case version, protocolVersion, serverStartId, voiceEnabled, termEnabled, notesEnabled, companionEnabled
    case companionSpeech, companionSessions, tailnet, apnsEnabled, capabilities, iroh, system
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    version = try c.required(.version)
    protocolVersion = try c.required(.protocolVersion)
    serverStartId = try c.required(.serverStartId)
    voiceEnabled = try c.optional(.voiceEnabled)
    termEnabled = try c.optional(.termEnabled)
    notesEnabled = try c.optional(.notesEnabled)
    companionEnabled = try c.optional(.companionEnabled)
    companionSpeech = try c.optional(.companionSpeech)
    companionSessions = try c.optional(.companionSessions)
    tailnet = try c.optionalOrNull(.tailnet)
    apnsEnabled = try c.optional(.apnsEnabled)
    capabilities = try c.optional(.capabilities) ?? []
    iroh = try c.optionalOrNull(.iroh)
    let rawSystem: String? = try c.optional(.system)
    system = rawSystem.map { ServerSystem.wire($0) ?? .unsupported }
  }
}

/// Ciało błędu API: `{ error, message, messageRef? }` (+ `reason` przy odmowie decyzji 422).
///
/// `error` to kod (`bad-token`, `bad-origin`, `refused`…), `message` — angielskie zdanie serwera do
/// pokazania, `messageRef` — jego kod zdania, który apka tłumaczy (``translate(_:)``); serwer bez
/// kodu zdania pola nie wysyła. `reason` zostaje łańcuchem: lista `REFUSE_REASONS` rośnie po stronie serwera,
/// a nieznany powód nie może zepsuć odczytu całej odpowiedzi.
public struct APIErrorBody: Sendable, Equatable, Codable, SentenceBearing {
  public var error: String
  public var message: String?
  public var reason: String?
  public var messageRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case error, message, reason, messageRef }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    error = try c.required(.error)
    message = try c.optionalOrNull(.message)
    reason = try c.optionalOrNull(.reason)
    messageRef = try c.optional(.messageRef)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(error, forKey: .error)
    try c.encodeIfPresent(message, forKey: .message)
    try c.encodeIfPresent(reason, forKey: .reason)
    try c.encodeIfPresent(messageRef, forKey: .messageRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    message = message.map { render($0, messageRef) }
  }
}

/// Potwierdzenie bez treści (`close`, `seen`, `focus`): `{ok: true}`. Inna wartość `ok` odrzuca.
public struct OkAck: Sendable, Equatable, Decodable {
  enum CodingKeys: String, CodingKey { case ok }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let ok: Bool = try c.required(.ok)
    guard ok else { throw contractViolation(c.codingPath + [CodingKeys.ok], "ok musi być true") }
  }
}

/// 202 na `POST /api/sessions/<id>/messages`. `clientMessageId` wraca, gdy był w ciele;
/// `replayed == true` = ta wiadomość była już przyjęta i echa tej odpowiedzi NIE będzie.
/// `queued == true` = echo odroczone: serwer trzyma wiadomość, aż CLI weźmie prompt, więc echo
/// przyjdzie dopiero wtedy (także przy `replayed`, gdy pierwsze przyjęcie wciąż czeka).
public struct MessageAccepted: Sendable, Equatable, Decodable {
  public var clientMessageId: String?
  public var replayed: Bool
  public var queued: Bool

  enum CodingKeys: String, CodingKey { case ok, clientMessageId, replayed, queued }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let ok: Bool = try c.required(.ok)
    guard ok else { throw contractViolation(c.codingPath + [CodingKeys.ok], "ok musi być true") }
    clientMessageId = try c.optional(.clientMessageId)
    // `replayed` i `queued` to literał `true` albo brak pola — `false` na drucie nie istnieje.
    replayed = try Self.literalTrue(c, .replayed)
    queued = try Self.literalTrue(c, .queued)
  }

  private static func literalTrue(_ c: ContractContainer<CodingKeys>, _ key: CodingKeys) throws -> Bool {
    let flag: Bool? = try c.optional(key)
    if flag == false {
      throw contractViolation(c.codingPath + [key], "\(key.stringValue) jest literałem true")
    }
    return flag == true
  }
}

/// Okno limitu planu: procent zużycia (liczba z API, bywa ułamkowa) i koniec okna (ISO).
public struct UsageWindow: Sendable, Equatable, Decodable {
  public var percent: Double
  public var resetsAt: String?
  /// Tylko przy oknie per model (`weeklyModel`): nazwa modelu, np. „Fable".
  public var model: String?

  enum CodingKeys: String, CodingKey { case percent, resetsAt, model }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    percent = try c.required(.percent)
    resetsAt = try c.optional(.resetsAt)
    model = try c.optional(.model)
  }
}

/// `GET /api/usage` (200) — limity planu Claude. 503 niesie ``APIErrorBody``
/// (`usage-unavailable`). `stale` + `fetchedAt` = ostatni dobry odczyt, bo bieżący padł.
public struct PlanUsage: Sendable, Equatable, Decodable {
  public var fiveHour: UsageWindow?
  public var weekly: UsageWindow?
  public var weeklyModel: UsageWindow?
  public var account: String?
  /// Brak = świeży odczyt.
  public var stale: Bool?
  public var fetchedAt: String?
  /// `"cli"` = liczby z paska statusu Claude Code (bez okna per model i bez konta). Łańcuch, nie
  /// wyliczenie: nowe źródło po stronie serwera nie może zepsuć odczytu całych limitów.
  public var source: String?

  enum CodingKeys: String, CodingKey {
    case fiveHour, weekly, weeklyModel, account, stale, fetchedAt, source
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    fiveHour = try c.optional(.fiveHour)
    weekly = try c.optional(.weekly)
    weeklyModel = try c.optional(.weeklyModel)
    account = try c.optional(.account)
    stale = try c.optional(.stale)
    fetchedAt = try c.optional(.fetchedAt)
    source = try c.optional(.source)
  }
}

/// Sesja CLI do wznowienia (`GET /api/resumable?cwd=`, `/api/resumable/recent`).
public struct ResumableSession: Sendable, Equatable, Decodable {
  public var engineSessionId: String
  public var cwd: String
  public var mtime: String
  public var firstPrompt: String
  public var gitBranch: String?
  /// `true` = ta rozmowa żyje w panelu herdr — wznowić jej nie wolno.
  public var liveInHerdr: Bool
  public var title: String?
  /// Karta Raroga, w której ta rozmowa żyje — cel „przejdź do otwartej rozmowy”. Brak u starszego serwera.
  public var sessionId: String?

  enum CodingKeys: String, CodingKey {
    case engineSessionId, cwd, mtime, firstPrompt, gitBranch, liveInHerdr, title, sessionId
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    engineSessionId = try c.required(.engineSessionId)
    cwd = try c.required(.cwd)
    mtime = try c.required(.mtime)
    firstPrompt = try c.required(.firstPrompt)
    gitBranch = try c.optional(.gitBranch)
    liveInHerdr = try c.required(.liveInHerdr)
    title = try c.optional(.title)
    sessionId = try c.optional(.sessionId)
  }
}

/// Lista sesji do wznowienia: `{sessions: [...]}`.
public struct ResumableList: Sendable, Equatable, Decodable {
  public var sessions: [ResumableSession]

  enum CodingKeys: String, CodingKey { case sessions }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessions = try c.required(.sessions)
  }
}

/// `POST /api/sessions/<id>/resume` (200): nowy panel, ta sama karta.
public struct ResumeResponse: Sendable, Equatable, Decodable {
  public var sessionId: String
  public var session: SessionSummary

  enum CodingKeys: String, CodingKey { case sessionId, session }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
    session = try c.required(.session)
  }
}

/// `POST /api/sessions/<id>/restart` (202): `/exit` poszedł, reszta jedzie po SSE.
public struct RestartResponse: Sendable, Equatable, Decodable {
  public var sessionId: String

  enum CodingKeys: String, CodingKey { case sessionId }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.required(.sessionId)
  }
}
