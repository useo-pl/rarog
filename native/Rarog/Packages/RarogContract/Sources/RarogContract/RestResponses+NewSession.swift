// Odpowiedzi REST formularza nowej sesji — lustro `dirListingSchema` i `dirEntrySchema` z
// `shared/src/protocol.ts` (`GET /api/fs?path=`; `POST /api/fs/mkdir` answers 200 with the new row as a ``DirEntry``). Lista sesji do wznowienia (`GET /api/resumable`,
// `/api/resumable/recent`) to ``ResumableList`` z `RestResponses.swift`. Ta sama tolerancja co reszta
// REST: nieznane klucze odcięte, `null` w polu opcjonalnym i zły typ odrzucają odpowiedź.
// Właściciel: nowa sesja.

/// Podkatalog w przeglądarce: nazwa, ścieżka absolutna (dokładnie to, co pójdzie w `cwd`)
/// i dwa znaczniki — repozytorium git i historia sesji CLI w tym katalogu.
public struct DirEntry: Sendable, Equatable, Decodable, Identifiable {
  public var name: String
  public var path: String
  public var git: Bool
  public var history: Bool

  public var id: String { path }

  enum CodingKeys: String, CodingKey { case name, path, git, history }

  public init(name: String, path: String, git: Bool = false, history: Bool = false) {
    self.name = name
    self.path = path
    self.git = git
    self.history = history
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    name = try c.nonEmpty(.name)
    path = try c.nonEmpty(.path)
    git = try c.required(.git)
    history = try c.required(.history)
  }
}

/// `GET /api/fs?path=` (200). `path == nil` = poziom korzeni (`RAROG_PROJECT_ROOTS`), wtedy
/// `entries` to korzenie, a `parent` nie istnieje; dla korzenia `parent == nil` (cofnięcie wraca
/// na poziom korzeni). `truncated` = katalog miał więcej wpisów niż sufit serwera.
/// `git` and `history` describe the listed directory itself, like the two marks of a ``DirEntry``.
/// `nil` means unknown: the roots level never carries them, and a server from before the fields omits them.
/// `canCreate` says whether the server creates directories (`POST /api/fs/mkdir`); only `true` means yes: the roots
/// level and a server from before the field give `nil`. A hint only, the route checks everything again.
public struct DirListing: Sendable, Equatable, Decodable {
  public var path: String?
  public var parent: String?
  public var git: Bool?
  public var history: Bool?
  public var canCreate: Bool?
  public var entries: [DirEntry]
  public var truncated: Bool

  enum CodingKeys: String, CodingKey { case path, parent, git, history, canCreate, entries, truncated }

  public init(
    path: String?, parent: String?, entries: [DirEntry], truncated: Bool = false,
    git: Bool? = nil, history: Bool? = nil, canCreate: Bool? = nil
  ) {
    self.path = path
    self.parent = parent
    self.git = git
    self.history = history
    self.canCreate = canCreate
    self.entries = entries
    self.truncated = truncated
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    path = try c.nullable(.path)
    parent = try c.nullable(.parent)
    git = try c.optional(.git)
    history = try c.optional(.history)
    canCreate = try c.optional(.canCreate)
    entries = try c.required(.entries)
    truncated = try c.required(.truncated)
  }
}
