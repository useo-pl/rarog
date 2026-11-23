// Odpowiedzi REST sterowania żywą sesją i diffa — lustro `shared/src/protocol.ts`
// (`modelListSchema`, `commandListSchema` (slash-komendy sesji), `sessionModelResponseSchema`,
// `sessionModeResponseSchema` = `{ok: true}`,
// `sessionDiffSchema`, a dla diffa per plik `diffFileListSchema` i `diffFilePatchSchema`;
// restart: `RestartResponse` w `RestResponses.swift`). Ta sama tolerancja co reszta REST: nieznane
// klucze odcięte, `null` w polu opcjonalnym i zły typ odrzucają odpowiedź.
// Właściciel: nagłówek.

/// Pozycja listy modeli (`GET /api/models`). `value: ""` = „model domyślny konta" — należy do
/// formularza nowej sesji, w arkuszu żywej sesji nie ma postaci komendy.
public struct ModelChoice: Sendable, Equatable, Codable, SentenceBearing {
  public var value: String
  /// Krótka nazwa do UI („Fable", „Opus"); przy pozycji ze zdaniem serwera (konto domyślne) para z `labelRef`.
  public var label: String
  public var description: String?
  /// Poziomy effortu modelu; pusta lista = effort nie ma znaczenia (np. Haiku). Poziom spoza tej
  /// wersji apki wypada z listy: lista rośnie po stronie serwera, a nieznany poziom nie może
  /// zepsuć odczytu całej listy modeli (wysłać go i tak nie umiemy).
  public var effortLevels: [EffortLevel]
  /// Serwer umie włączyć ultracode przy tym modelu. Brak pola = `false`: serwer bez tej możliwości
  /// (także starszy, który pola nie zna), więc apka nie pokazuje przełącznika.
  public var ultracode: Bool
  /// Kod zdania `label` i `description` (tłumaczenie: ``translate(_:)``); brak = nazwa modelu, nie zdanie.
  public var labelRef: SentenceRef?
  public var descriptionRef: SentenceRef?

  enum CodingKeys: String, CodingKey {
    case value, label, description, effortLevels, ultracode, labelRef, descriptionRef
  }

  public init(
    value: String, label: String, description: String? = nil, effortLevels: [EffortLevel], ultracode: Bool = false,
    labelRef: SentenceRef? = nil, descriptionRef: SentenceRef? = nil
  ) {
    self.value = value
    self.label = label
    self.description = description
    self.effortLevels = effortLevels
    self.ultracode = ultracode
    self.labelRef = labelRef
    self.descriptionRef = descriptionRef
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    value = try c.required(.value)
    label = try c.nonEmpty(.label)
    description = try c.optional(.description)
    let raw: [String] = try c.required(.effortLevels)
    effortLevels = raw.compactMap(EffortLevel.wire)
    // `ultracode` to literał `true` albo brak pola — `false` na drucie nie istnieje.
    let flag: Bool? = try c.optional(.ultracode)
    if flag == false {
      throw contractViolation(c.codingPath + [CodingKeys.ultracode], "ultracode jest literałem true")
    }
    ultracode = flag == true
    labelRef = try c.optional(.labelRef)
    descriptionRef = try c.optional(.descriptionRef)
  }

  /// Lustro drutu: `ultracode` tylko jako `true`, pola `nil` nie wychodzą.
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(value, forKey: .value)
    try c.encode(label, forKey: .label)
    try c.encodeIfPresent(description, forKey: .description)
    try c.encode(effortLevels, forKey: .effortLevels)
    if ultracode { try c.encode(true, forKey: .ultracode) }
    try c.encodeIfPresent(labelRef, forKey: .labelRef)
    try c.encodeIfPresent(descriptionRef, forKey: .descriptionRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    label = render(label, labelRef)
    description = description.map { render($0, descriptionRef) }
  }
}

/// `GET /api/models` (200): `{models: [...]}` — lista wbudowana serwera.
public struct ModelList: Sendable, Equatable, Codable, SentenceBearing {
  public var models: [ModelChoice]

  enum CodingKeys: String, CodingKey { case models }

  public init(models: [ModelChoice]) {
    self.models = models
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    models = try c.required(.models)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    for index in models.indices { models[index].translate(render) }
  }
}

/// Jak kończy się komenda z listy (`COMMAND_CHOICE_KINDS`): wynik w linii i powrót do pola (`local`)
/// albo tura modelu (`prompt`).
public enum CommandChoiceKind: String, ContractEnum {
  case local, prompt
}

/// Skąd komenda (`COMMAND_CHOICE_SOURCES`): wbudowana w CLI (komenda albo skill), skill lub komenda
/// z dysku, plugin.
public enum CommandChoiceSource: String, ContractEnum {
  case builtin, skill, plugin
}

/// Pozycja listy slash-komend sesji (`GET /api/sessions/<id>/commands`). `name` bez ukośnika,
/// wielkość liter ze źródła (rejestr, nazwa na dysku: `compact`, `pr-review-toolkit:review-pr`). Opis
/// i podpowiedź argumentu z frontmattera skilla albo komendy; wbudowane ich nie mają. Aliasów na liście nie ma — serwer ich nie przepuszcza.
public struct CommandChoice: Sendable, Equatable, Decodable, TolerantDecodable {
  public var name: String
  public var kind: CommandChoiceKind
  public var source: CommandChoiceSource
  public var description: String?
  public var argumentHint: String?

  enum CodingKeys: String, CodingKey { case name, kind, source, description, argumentHint }

  public init(
    name: String, kind: CommandChoiceKind, source: CommandChoiceSource, description: String? = nil,
    argumentHint: String? = nil
  ) {
    self.name = name
    self.kind = kind
    self.source = source
    self.description = description
    self.argumentHint = argumentHint
  }

  /// Nieznany `kind` albo `source` (nowszy serwer) → wpis znika z listy, reszta zostaje — jak `cliDialog`
  /// karty: apka nie wie, jak taka komenda się kończy, więc jej nie podpowiada.
  static func decodeTolerant(from decoder: any Decoder) throws -> CommandChoice? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let kind: String = try c.required(.kind)
    guard CommandChoiceKind.wire(kind) != nil else {
      c.degrade(.kind, raw: kind)
      return nil
    }
    let source: String = try c.required(.source)
    guard CommandChoiceSource.wire(source) != nil else {
      c.degrade(.source, raw: source)
      return nil
    }
    return try CommandChoice(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    name = try c.nonEmpty(.name)
    kind = try c.strict(.kind)
    source = try c.strict(.source)
    description = try c.optional(.description)
    argumentHint = try c.optional(.argumentHint)
  }
}

/// `GET /api/sessions/<id>/commands` (200): `{revision, commands}` — ta sama migawka
/// katalogu sesji, którą serwer sprawdza wysyłkę. Ta sama `revision` = ta sama lista. Kolejność: po nazwie.
public struct CommandList: Sendable, Equatable, Decodable {
  public var revision: String
  public var commands: [CommandChoice]

  /// Serwer bez tej trasy (405 starego routera) albo bez sesji (404): pusta lista z pustą `revision` —
  /// apka nic nie podpowiada, a błędu nie pokazuje. Serwer pustej `revision` nie nadaje.
  public static let unavailable = CommandList(revision: "", commands: [])

  enum CodingKeys: String, CodingKey { case revision, commands }

  public init(revision: String, commands: [CommandChoice]) {
    self.revision = revision
    self.commands = commands
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    revision = try c.nonEmpty(.revision)
    var items = try c.base.nestedUnkeyedContainer(forKey: .commands)
    var out: [CommandChoice] = []
    while !items.isAtEnd {
      if let entry = try CommandChoice.decodeTolerant(from: items.superDecoder()) { out.append(entry) }
    }
    commands = out
  }
}

/// `POST /api/sessions/<id>/model` (202): komenda poszła do panelu; `warning` = zdanie o skutku
/// globalnym zmiany modelu (`MODEL_CHANGE_WARNING`) — pole, a nie założenie klienta; `warningRef` = jego kod
/// zdania do tłumaczenia (``translate(_:)``).
public struct SessionModelAccepted: Sendable, Equatable, Codable, SentenceBearing {
  public var warning: String
  public var warningRef: SentenceRef?

  enum CodingKeys: String, CodingKey { case ok, warning, warningRef }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let ok: Bool = try c.required(.ok)
    guard ok else { throw contractViolation(c.codingPath + [CodingKeys.ok], "ok musi być true") }
    warning = try c.nonEmpty(.warning)
    warningRef = try c.optional(.warningRef)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(true, forKey: .ok)
    try c.encode(warning, forKey: .warning)
    try c.encodeIfPresent(warningRef, forKey: .warningRef)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    warning = render(warning, warningRef)
  }
}

/// Status pliku w diffie. Świadomie trzy litery: rename i copy serwer mapuje na `M`/`A`.
public enum DiffFileStatus: String, ContractEnum {
  case added = "A"
  case modified = "M"
  case deleted = "D"
}

/// Plik w `git diff HEAD --numstat`: ścieżka, litera i bilans linii.
public struct DiffFile: Sendable, Equatable, Decodable {
  public var path: String
  /// `nil` = litera spoza tej wersji apki: plik zostaje na liście, tylko bez litery (prawda
  /// zamiast zgadywania „zmieniony").
  public var status: DiffFileStatus?
  public var linesAdded: Int
  public var linesDeleted: Int

  enum CodingKeys: String, CodingKey { case path, status, linesAdded, linesDeleted }

  public init(path: String, status: DiffFileStatus?, linesAdded: Int, linesDeleted: Int) {
    self.path = path
    self.status = status
    self.linesAdded = linesAdded
    self.linesDeleted = linesDeleted
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    path = try c.required(.path)
    let raw: String = try c.required(.status)
    status = DiffFileStatus.wire(raw)
    linesAdded = try c.required(.linesAdded)
    linesDeleted = try c.required(.linesDeleted)
  }
}

/// `GET /api/sessions/<id>/diff` (200): zmiany katalogu sesji względem HEAD. `truncated` = patch
/// przekroczył limit serwera (`MAX_DIFF_PATCH_BYTES`, 512 kB) i został ucięty.
public struct SessionDiff: Sendable, Equatable, Decodable {
  public var files: [DiffFile]
  public var patch: String
  public var truncated: Bool

  /// Limit patcha po stronie serwera (`MAX_DIFF_PATCH_BYTES`) — do zdania „diff ucięty".
  public static let maxPatchBytes = 512 * 1024

  enum CodingKeys: String, CodingKey { case files, patch, truncated }

  public init(files: [DiffFile], patch: String, truncated: Bool) {
    self.files = files
    self.patch = patch
    self.truncated = truncated
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    files = try c.required(.files)
    patch = try c.required(.patch)
    truncated = try c.required(.truncated)
  }
}

/// Pozycja listy zmian (`GET /api/sessions/<id>/diff/files`): ścieżka względem katalogu
/// sesji, litera i — opcjonalnie — bilans linii. Brak licznika = „nie wiem", nie zero: mają je
/// tylko pliki śledzone i tylko wtedy, gdy serwer zdążył je policzyć. Plik nieśledzony nie ma
/// żadnego z pól opcjonalnych.
public struct DiffListEntry: Sendable, Equatable, Decodable {
  public var path: String
  /// `nil` = litera spoza tej wersji apki: plik zostaje na liście, tylko bez litery.
  public var status: DiffFileStatus?
  public var linesAdded: Int?
  public var linesDeleted: Int?
  /// `true` = git nie liczy linii tego pliku (plik binarny), więc liczników nie ma.
  public var binary: Bool

  enum CodingKeys: String, CodingKey { case path, status, linesAdded, linesDeleted, binary }

  public init(
    path: String, status: DiffFileStatus?, linesAdded: Int? = nil, linesDeleted: Int? = nil,
    binary: Bool = false
  ) {
    self.path = path
    self.status = status
    self.linesAdded = linesAdded
    self.linesDeleted = linesDeleted
    self.binary = binary
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    path = try c.required(.path)
    let raw: String = try c.required(.status)
    status = DiffFileStatus.wire(raw)
    linesAdded = try c.optional(.linesAdded)
    linesDeleted = try c.optional(.linesDeleted)
    // `binary` to literał `true` albo brak pola — `false` na drucie nie istnieje.
    let flag: Bool? = try c.optional(.binary)
    if flag == false {
      throw contractViolation(c.codingPath + [CodingKeys.binary], "binary jest literałem true")
    }
    binary = flag == true
    // Kontrakt: liczniki to liczby całkowite ≥ 0 (`z.number().int().nonnegative()`).
    for (key, value) in [(CodingKeys.linesAdded, linesAdded), (.linesDeleted, linesDeleted)] {
      if let value, value < 0 {
        throw contractViolation(c.codingPath + [key], "ujemny licznik linii")
      }
    }
  }
}

/// `GET /api/sessions/<id>/diff/files` (200): zmienione pliki katalogu sesji — śledzone
/// w kolejności gita, potem nieśledzone. `truncated` = lista ucięta na suficie serwera; plik
/// spoza uciętej listy dalej da się pobrać po ścieżce.
public struct DiffFileList: Sendable, Equatable, Decodable {
  public var files: [DiffListEntry]
  public var truncated: Bool

  /// Sufit listy po stronie serwera (`MAX_DIFF_LIST_FILES`) — do zdania „lista ucięta".
  public static let maxFiles = 500

  enum CodingKeys: String, CodingKey { case files, truncated }

  public init(files: [DiffListEntry], truncated: Bool) {
    self.files = files
    self.truncated = truncated
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    files = try c.required(.files)
    truncated = try c.required(.truncated)
  }
}

/// `GET /api/sessions/<id>/diff/file?path=…` (200): patch JEDNEGO pliku. Bywa w nim więcej
/// niż jeden blok `diff --git` (zmiana typu pliku), a `path` to ścieżka z żądania. `truncated` =
/// patch tego pliku ucięty na granicy linii albo git doszedł do sufitu odczytu.
public struct DiffFilePatch: Sendable, Equatable, Decodable {
  public var path: String
  public var patch: String
  public var truncated: Bool

  /// Sufit patcha jednego pliku po stronie serwera (`MAX_DIFF_FILE_PATCH_BYTES`) — do zdania „plik ucięty".
  public static let maxPatchBytes = 512 * 1024

  enum CodingKeys: String, CodingKey { case path, patch, truncated }

  public init(path: String, patch: String, truncated: Bool) {
    self.path = path
    self.patch = patch
    self.truncated = truncated
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    path = try c.required(.path)
    patch = try c.required(.patch)
    truncated = try c.required(.truncated)
  }
}
