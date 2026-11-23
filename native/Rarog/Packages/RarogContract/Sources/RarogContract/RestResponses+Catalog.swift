// Odpowiedzi REST katalogu projektów i zakładania sesji — lustro `shared/src/protocol.ts`
// (`recentProjectsSchema`, `createSessionResponseSchema`). Ta sama tolerancja co reszta REST:
// nieznane klucze odcięte, `null` w polu opcjonalnym i zły typ odrzucają odpowiedź.
// Właściciel: projekty i zakładki.

/// Projekt z historią sesji CLI: katalog i czas ostatniej sesji w nim (ISO). Zero treści rozmowy.
public struct RecentProject: Sendable, Equatable, Decodable {
  public var cwd: String
  public var mtime: String

  enum CodingKeys: String, CodingKey { case cwd, mtime }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    cwd = try c.nonEmpty(.cwd)
    mtime = try c.required(.mtime)
  }
}

/// `GET /api/projects/recent` (200): `{projects: [...]}`, at most 13 (`MAX_RECENT_PROJECTS`: twelve chips plus the
/// current project, which the app leaves out); projects with an open Rarog session first, then newest first.
public struct RecentProjectList: Sendable, Equatable, Decodable {
  public var projects: [RecentProject]

  enum CodingKeys: String, CodingKey { case projects }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    projects = try c.required(.projects)
  }
}

/// `POST /api/sessions` (202): panel założony, reszta startu jedzie po SSE.
///
/// `state` (literał `starting`) świadomie nie jest czytane: apka nie rysuje karty z odpowiedzi
/// (kartę tworzy wyłącznie strumień listy), więc wartość nie ma czytelnika.
/// `trustPrompt == true` = katalog nie był otwierany w Claude Code; brak = `false`.
public struct CreateSessionResponse: Sendable, Equatable, Decodable {
  public var sessionId: String
  public var trustPrompt: Bool

  enum CodingKeys: String, CodingKey { case sessionId, trustPrompt }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    sessionId = try c.nonEmpty(.sessionId)
    let flag: Bool? = try c.optional(.trustPrompt)
    trustPrompt = flag == true
  }
}
