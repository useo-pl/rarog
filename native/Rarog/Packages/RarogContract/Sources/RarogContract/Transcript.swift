// Wiadomości transkryptu i ich bloki — lustro `transcriptMessageSchema`, `blockSchema`,
// `messageAttachmentSchema`, `transcriptNoticeSchema` i `transcriptPromptBlockedSchema` z `shared/src/protocol.ts`.

/// Domknięta wiadomość transkryptu (`message`, `transcript-snapshot.messages`).
public struct TranscriptMessage: Sendable, Equatable, Codable {
  public var seq: Int
  public var role: MessageRole
  public var blocks: [Block]
  public var at: String
  public var attachments: [MessageAttachment]?
  /// Identyfikator wysyłki z `MessageBody.clientMessageId` — wyłącznie w echu wiadomości
  /// wysłanej z nim. Brak: wysyłka bez identyfikatora, prompt z terminala, odczyt z jsonl.
  public var clientMessageId: String?
  /// Notka harnessu: wpis, którego nikt nie napisał — rola efektywna to NIE człowiek, mimo
  /// `role == .user`. Bloki niosą wtedy surowy tekst, którego apka nie parsuje.
  public var notice: TranscriptNotice?
  /// Notka `system` o prompcie zablokowanym przez hook `UserPromptSubmit`. Bloki niosą gotowy tekst notki,
  /// więc klient bez obsługi pola pokazuje ją jak zwykłą notkę systemową.
  public var promptBlocked: TranscriptPromptBlocked?

  enum CodingKeys: String, CodingKey {
    case seq, role, blocks, at, attachments, clientMessageId, notice, promptBlocked
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    seq = try c.required(.seq)
    role = try c.lenient(.role, degrade: .messageRole)
    blocks = try c.required(.blocks)
    at = try c.required(.at)
    attachments = try c.optional(.attachments)
    clientMessageId = try c.optional(.clientMessageId)
    notice = try c.optional(.notice)
    promptBlocked = try c.optional(.promptBlocked)
  }
}

extension TranscriptMessage: SentenceBearing {
  /// Tłumaczy bloki `text` (zdanie serwera z `ref`; tekst agenta bez `ref` przechodzi z `nil`). Obraz i narzędzie
  /// bez zmian: `alt` zastępnika i stopkę ucięcia składa apka z `placeholder` i `truncation`.
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    for index in blocks.indices {
      guard case let .text(text, ref) = blocks[index] else { continue }
      blocks[index] = .text(render(text, ref), ref: ref)
    }
  }
}

/// Prompt zablokowany przez hook `UserPromptSubmit` — fakty notki, policzone przez serwer z pliku rozmowy.
///
/// `reason` to powód od hooka. `prompt` (cytat promptu) jest tylko w notce BEZ dymka promptu: prompt wpisany
/// w terminalu albo odczytany z historii bez echa wysyłki; prompt wysłany z Raroga stoi dymkiem nad notką.
public struct TranscriptPromptBlocked: Sendable, Equatable, Codable {
  public var reason: String
  public var prompt: String?

  enum CodingKeys: String, CodingKey { case reason, prompt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    reason = try c.required(.reason)
    prompt = try c.optional(.prompt)
  }
}

/// Notka harnessu — fakty do jednego zdania, policzone przez serwer z wpisu jsonl.
///
/// `outcome` tylko wtedy, gdy plik go mówi: brak NIE znaczy sukcesu. `name` ≤ 80 znaków,
/// `exitCode` wyłącznie z pliku. Klient składa z tego zdanie po polsku, nie z tekstu.
public struct TranscriptNotice: Sendable, Equatable, Codable {
  public var kind: NoticeKind
  public var outcome: NoticeOutcome?
  public var name: String?
  public var exitCode: Int?

  enum CodingKeys: String, CodingKey { case kind, outcome, name, exitCode }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    kind = try c.lenient(.kind, degrade: .noticeKind)
    outcome = try c.lenientOptional(.outcome, degrade: .noticeOutcome)
    name = try c.optional(.name)
    exitCode = try c.optional(.exitCode)
  }
}

/// Rodzaj notki. `unknown` to wartość PROTOKOŁU (kształt, którego serwer nie rozpoznał),
/// a zarazem wartość zapasowa degradacji — nie wartownik klienta.
public enum NoticeKind: String, ContractEnum {
  case command
  case agent
  case workflow
  case monitorEnd = "monitor-end"
  case monitorEvent = "monitor-event"
  case orphan
  /// Koniec obserwacji artefaktu: artefakt usunięty, publiczny spoza organizacji albo zmiana konta.
  /// Nie zadanie w tle i bez wyniku; `name` = tytuł artefaktu, gdy serwer go zna.
  case artifactWatch = "artifact-watch"
  case unknown
}

/// Wynik zadania z notki: skończone, niepowodzenie, zatrzymane albo postój (`waiting`): subagent stanął
/// i czeka na własne zadanie w tle. Postój nie jest końcem zadania i dotyczy tylko notki rodzaju `agent`.
public enum NoticeOutcome: String, ContractEnum {
  case done, failed, halted, waiting
}

/// Blok wiadomości. Nieznany `type` → `unsupported` (reszta pól bloku odcięta); USZKODZONY
/// znany blok (`{type: "text", text: 9}`) odrzuca ramkę — szeroki zapas schowałby błąd producenta.
public enum Block: Sendable, Equatable, Codable {
  /// Tekst bloku i `ref` zdania serwera (wiadomości systemowe, zastępnik obrazu, znacznik przycięcia).
  /// Tekst agenta i człowieka nie ma `ref`.
  case text(String, ref: SentenceRef? = nil)
  case toolCall(ToolCallBlock)
  case image(ImageBlock)
  case unsupported

  enum CodingKeys: String, CodingKey { case type, text, ref }

  private enum Kind: String, ContractEnum {
    case text
    case toolCall = "tool-call"
    case image
    case unsupported

    static var clientSentinel: Kind? { .unsupported }
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.type)
    switch Kind.wire(raw) {
    case .text: self = .text(try c.required(.text), ref: try c.optional(.ref))
    case .toolCall: self = .toolCall(try ToolCallBlock(from: decoder))
    case .image: self = .image(try ImageBlock(from: decoder))
    case .unsupported, nil:
      // `unsupported` od serwera to wartownik klienta, więc też nieznany łańcuch — degradacja.
      c.degrade(.type, raw: raw)
      self = .unsupported
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case let .text(text, ref):
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(Kind.text, forKey: .type)
      try c.encode(text, forKey: .text)
      if let ref { try c.encode(ref, forKey: .ref) }
    case let .toolCall(block):
      try block.encode(to: encoder)
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(Kind.toolCall, forKey: .type)
    case let .image(block):
      try block.encode(to: encoder)
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(Kind.image, forKey: .type)
    case .unsupported:
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(Kind.unsupported, forKey: .type)
    }
  }
}

/// Blok wywołania narzędzia. `toolName` to TEKST etykiety — klient po nim nie decyduje;
/// decyduje po `delegation`, `inputKind` i `detailKind`.
public struct ToolCallBlock: Sendable, Equatable, Codable {
  public var toolName: String
  public var summary: String
  public var detail: String?
  public var detailKind: DetailKind?
  public var delegation: Delegation?
  public var inputKind: InputKind?
  /// Ucięcie `detail` przez serwer; brak = `detail` w całości (albo starszy serwer).
  public var truncation: Truncation?

  enum CodingKeys: String, CodingKey { case toolName, summary, detail, detailKind, delegation, inputKind, truncation }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    toolName = try c.required(.toolName)
    summary = try c.required(.summary)
    detail = try c.optional(.detail)
    detailKind = try c.lenientOptional(.detailKind, degrade: .blockDetailKind)
    delegation = try c.lenientOptional(.delegation, degrade: .blockDelegation)
    inputKind = try c.lenientOptional(.inputKind, degrade: .blockInputKind)
    truncation = try c.optional(.truncation)
    try Truncation.check(truncation, against: detail, at: c.codingPath + [CodingKeys.truncation])
  }
}

/// Obrazek w wiadomości: wyłącznie base64 png/jpeg w limicie (`IMAGE_DATA_URL_PATTERN`).
public struct ImageBlock: Sendable, Equatable, Codable {
  public var dataUrl: String
  public var alt: String?
  /// `true` = obraz zastępczy serwera: `alt` to zdanie serwera, które apka składa sama. Brak pola = `false`;
  /// na drucie tylko `true` (zod `z.literal(true)`), każda inna wartość odrzuca blok.
  public var placeholder: Bool

  enum CodingKeys: String, CodingKey { case dataUrl, alt, placeholder }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    dataUrl = try c.required(.dataUrl)
    alt = try c.optional(.alt)
    let placeholder: Bool? = try c.optional(.placeholder)
    guard placeholder != false else {
      throw contractViolation(c.codingPath + [CodingKeys.placeholder], "placeholder inny niż true")
    }
    self.placeholder = placeholder ?? false
    guard WireFormat.isImageDataURL(dataUrl) else {
      throw contractViolation(c.codingPath + [CodingKeys.dataUrl], "obrazek spoza png/jpeg base64 albo za duży")
    }
  }

  /// `placeholder` wychodzi tylko jako `true`, więc round-trip bloku bez pola jest dosłowny.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(dataUrl, forKey: .dataUrl)
    try c.encodeIfPresent(alt, forKey: .alt)
    if placeholder { try c.encode(true, forKey: .placeholder) }
  }
}

/// Wizytówka załącznika w transkrypcie — nazwa, waga i typ, nigdy bajty.
public struct MessageAttachment: Sendable, Equatable, Codable {
  public var kind: AttachmentKind
  public var name: String
  public var bytes: Int
  public var mime: String
  /// Nazwa pliku zdjęcia w `.rarog-uploads/` — klucz miniatury, nigdy ścieżka.
  public var file: String?

  enum CodingKeys: String, CodingKey { case kind, name, bytes, mime, file }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    kind = try c.lenient(.kind, degrade: .attachmentsKind)
    name = try c.required(.name)
    bytes = try c.required(.bytes)
    mime = try c.required(.mime)
    file = try c.optional(.file)
    if let file, !WireFormat.isUploadImageFile(file) {
      throw contractViolation(c.codingPath + [CodingKeys.file], "nazwa pliku spoza wzorca uploadu")
    }
  }
}
