// Karty decyzji: zgoda (`PermissionRequest`) i pytanie (`QuestionRequest`) — lustro schematów
// z `shared/src/protocol.ts`. Klient decyduje po polach semantycznych kontraktu (`subject`,
// `canAllow`, `customAnswer`, `role`, `terminalOnly`), nigdy po `toolName` ani kanale.

/// Czekająca zgoda na narzędzie (`permission-pending`, `pendingPermissions`).
public struct PermissionRequest: Sendable, Equatable, Codable {
  public var permId: String
  public var sessionId: String
  public var toolName: String
  public var displayText: String
  public var risk: Risk
  public var cwd: String
  public var createdAt: String
  /// `false` = karta bez „Zezwól" (serwer nie ma czym zatwierdzić).
  public var canAllow: Bool?
  public var alwaysLabel: String?
  /// Przedmiot zgody; brak = zwykła zgoda (nazwa narzędzia niczego nie przesądza).
  public var subject: DecisionSubject?
  /// `shell` = `displayText` to dosłownie komenda powłoki — karta koloruje ją składnią. Brak pola
  /// (karta z ekranu, zdegradowana, plan, JSON, komenda ucięta stopką) = komenda bez koloru.
  public var inputKind: InputKind?
  /// Kod zdania `displayText` (karta zdegradowana albo nieczytelna); brak = tekst z ekranu albo narzędzia.
  public var displayTextRef: SentenceRef?
  /// Ucięcie `displayText` przez serwer: komenda albo plan za długi na kartę.
  public var truncation: Truncation?
  /// `hook` = karta kanału zgód: stały `permId`, nowa karta o tym samym `permId` zastępuje poprzednią,
  /// zmiany w miejscu przez `permission-settled`. Brak = karta ekranowa jak dotąd; pola niżej niesie tylko kanał,
  /// `unavailable` także karta ekranowa.
  public var channel: PermissionChannel?
  public var state: ConsentCardState?
  /// Why the card cannot be allowed from the phone; also on a card without `channel` (screen values). Absent = allowed
  /// (with `canAllow`), or a degraded screen card that keeps the "deny only" sentence.
  public var unavailable: ConsentUnavailableReason?
  /// Czy dialog stoi w terminalu; brak = serwer nie wie.
  public var dialogVisible: Bool?
  /// Prośby rodzeństwa odrzucone razem z tą kartą; brak = żadnej.
  public var siblingsDenied: Int?
  /// Pola wejścia poza komendą, w kolejności serwera.
  public var fields: [ConsentInputField]?
  public var notes: [ConsentNote]?
  /// "Always" option of a channel card: the literal updates the hook writes and their destination; absent = no
  /// such option. The app offers it only with `canAllow`.
  public var always: [ConsentAlwaysEntry]?

  enum CodingKeys: String, CodingKey {
    case permId, sessionId, toolName, displayText, risk, cwd, createdAt, canAllow, alwaysLabel, subject, inputKind
    case displayTextRef, truncation
    case channel, state, unavailable, dialogVisible, siblingsDenied, fields, notes, always
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    permId = try c.required(.permId)
    sessionId = try c.required(.sessionId)
    toolName = try c.required(.toolName)
    displayText = try c.required(.displayText)
    risk = try c.lenient(.risk, degrade: .risk)
    cwd = try c.required(.cwd)
    createdAt = try c.required(.createdAt)
    canAllow = try c.optional(.canAllow)
    alwaysLabel = try c.optional(.alwaysLabel)
    subject = try c.lenientOptional(.subject, degrade: .subject)
    inputKind = try c.lenientOptional(.inputKind, degrade: .permissionInputKind)
    displayTextRef = try c.optional(.displayTextRef)
    truncation = try c.optional(.truncation)
    try Truncation.check(truncation, against: displayText, at: c.codingPath + [CodingKeys.truncation])
    channel = try c.strictOptional(.channel)
    state = try c.lenientOptional(.state, degrade: .permissionState)
    unavailable = try c.lenientOptional(.unavailable, degrade: .permissionUnavailable)
    dialogVisible = try c.optional(.dialogVisible)
    siblingsDenied = try c.optional(.siblingsDenied)
    if let siblingsDenied, siblingsDenied < 0 {
      throw contractViolation(c.codingPath + [CodingKeys.siblingsDenied], "siblingsDenied < 0")
    }
    fields = try c.optional(.fields)
    notes = try c.lenientArray(.notes, degrade: .permissionNotes)
    always = try c.optional(.always)
  }

  /// Karta kanału zgód (`channel: 'hook'`).
  public var isHookChannel: Bool {
    switch channel {
    case .hook: true
    case nil: false
    }
  }

  /// Karta kanału, której stanu, powodu albo uwagi ta wersja apki nie zna: bez żadnego przycisku.
  public var isUnsupportedHookCard: Bool {
    isHookChannel
      && (state == .unsupported || unavailable == .unsupported || (notes ?? []).contains(.unsupported))
  }

  /// Karta kanału w stanie, w którym wolno ją zwolnić do terminala albo na niej zdecydować (brak stanu = jak `pending`).
  public var isHookAwaitingDecision: Bool {
    isHookChannel && (state == nil || state == .pending || state == .sent) && !isUnsupportedHookCard
  }

  /// Zmiana w miejscu z `permission-settled`: stan, przyciski, powód i widoczność dialogu.
  public mutating func settle(_ event: PermissionSettledEvent) {
    state = event.state
    canAllow = event.canAllow
    unavailable = event.unavailable
    if let visible = event.dialogVisible { dialogVisible = visible }
  }
}

/// Pole wejścia narzędzia poza komendą na karcie kanału zgód: nazwa i pełna wartość.
public struct ConsentInputField: Sendable, Equatable, Codable {
  public var name: String
  public var value: String

  enum CodingKeys: String, CodingKey { case name, value }

  public init(name: String, value: String) {
    self.name = name
    self.value = value
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    name = try c.required(.name)
    value = try c.required(.value)
  }
}

/// One update of the "always" option on a channel card: kind, literal value (rule `Tool(content)`, mode, directory)
/// and write destination, mirror of `ConsentAlwaysEntry` in `shared/src/protocol/consent.ts`.
public struct ConsentAlwaysEntry: Sendable, Equatable, Codable {
  public var kind: ConsentAlwaysKind
  public var value: String
  public var destination: ConsentAlwaysDestination

  enum CodingKeys: String, CodingKey { case kind, value, destination }

  public init(kind: ConsentAlwaysKind, value: String, destination: ConsentAlwaysDestination) {
    self.kind = kind
    self.value = value
    self.destination = destination
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    kind = try c.strict(.kind)
    value = try c.required(.value)
    destination = try c.strict(.destination)
  }
}

extension PermissionRequest: SentenceBearing {
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    displayText = render(displayText, displayTextRef)
  }
}

/// Czekające pytanie (`question-pending`, `pendingQuestions`).
public struct QuestionRequest: Sendable, Equatable, Codable {
  public var qId: String
  public var sessionId: String
  public var questions: [Question]
  public var createdAt: String
  /// Kanał odpowiedzi — tylko do dekodowania; decyzje idą po `customAnswer` i `role`.
  public var channel: QuestionChannel?
  /// `true` = pole „Własna odpowiedź" (wolny tekst).
  public var customAnswer: Bool?

  enum CodingKeys: String, CodingKey { case qId, sessionId, questions, createdAt, channel, customAnswer }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    qId = try c.required(.qId)
    sessionId = try c.required(.sessionId)
    questions = try c.required(.questions)
    createdAt = try c.required(.createdAt)
    channel = try c.lenientOptional(.channel, degrade: .channel)
    customAnswer = try c.optional(.customAnswer)
  }
}

extension QuestionRequest: SentenceBearing {
  /// Tłumaczy `question` każdego pytania; zdanie serwera ma tylko pytanie zapasowe (z `questionRef`).
  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    for index in questions.indices {
      questions[index].question = render(questions[index].question, questions[index].questionRef)
    }
  }
}

/// Jedno pytanie formularza.
public struct Question: Sendable, Equatable, Codable {
  public var question: String
  public var header: String
  public var multiSelect: Bool
  public var options: [QuestionOption]
  /// `true` = pytanie przyjmuje NOTATKĘ do wybranej opcji (pole „Notatka" na karcie).
  /// Liczy serwer; apka nie wyprowadza tego sama z kanału, podglądu ani wersji CLI. Brak = bez pola.
  public var notes: Bool?
  /// To pytanie jest ekranem PRZEGLĄDU formularza — pary pytanie → odpowiedzi liczy serwer
  /// z ekranu. Brak = zwykłe pytanie (albo serwer bez tego pola). `question` zostaje wtedy surowym
  /// tekstem ekranu, a opcje dosłownymi etykietami z ekranu.
  public var review: [ReviewPair]?
  /// Kod zdania `question` (pytanie zapasowe serwera); brak = treść od autora pytania albo z ekranu.
  public var questionRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case question, header, multiSelect, options, notes, review, questionRef }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    question = try c.required(.question)
    header = try c.required(.header)
    multiSelect = try c.required(.multiSelect)
    options = try c.required(.options)
    notes = try c.optional(.notes)
    review = try c.optional(.review)
    questionRef = try c.optional(.questionRef)
  }
}

/// Jedna para ekranu przeglądu formularza — treść pytania i wybrane odpowiedzi
/// (w kolejności z ekranu; wielokrotny wybór = kilka wartości).
public struct ReviewPair: Sendable, Equatable, Codable {
  public var question: String
  public var answers: [String]

  enum CodingKeys: String, CodingKey { case question, answers }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    question = try c.required(.question)
    answers = try c.required(.answers)
  }
}

/// Opcja pytania. `role` mówi, czym opcja jest (odpowiedź, pole własne, wyjście) — bez czytania
/// jej etykiety.
public struct QuestionOption: Sendable, Equatable, Codable {
  public var label: String
  public var description: String?
  /// `true` = opcję wolno wybrać tylko w terminalu (wiersz nieaktywny).
  public var terminalOnly: Bool?
  public var role: OptionRole?
  /// Podgląd opcji (kod, makieta, diagram) z payloadu autora pytania — nigdy z ekranu.
  /// Kopia przycięta przez serwer; ucięcie kończy linia `✂ …`. Spacje i złamania linii są treścią.
  public var preview: String?

  enum CodingKeys: String, CodingKey { case label, description, terminalOnly, role, preview }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    label = try c.required(.label)
    description = try c.optional(.description)
    terminalOnly = try c.optional(.terminalOnly)
    role = try c.lenientOptional(.role, degrade: .optionRole)
    preview = try c.optional(.preview)
  }
}
