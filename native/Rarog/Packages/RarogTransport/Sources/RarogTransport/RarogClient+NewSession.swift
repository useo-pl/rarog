import Foundation
import RarogContract

// New Session form: the directory browser, a new directory in it and the lists of CLI sessions to resume.
// The reads skip the mutation gate; `makeDirectory` is a mutation (gate and `Origin`). Creating the pane is
// `createSession` in `RarogClient+Catalog`. Owner: new session.
extension RarogClient {
  /// `GET /api/fs?path=` — podkatalogi ze znacznikami `git` i `historia`; `nil` = poziom korzeni.
  /// 400 (`cwd-not-allowed`, nieistniejąca ścieżka) przychodzi jako `.http` ze zdaniem serwera.
  public func directory(_ path: String?) async throws(TransportError) -> DirListing {
    let route = path.map { "/api/fs?path=\(Self.segment($0))" } ?? "/api/fs"
    let response = try await perform(.get(route))
    return try decodeCatalog(DirListing.self, from: response.body, path: "/api/fs")
  }

  /// `POST /api/fs/mkdir` — one new directory `name` in the listed directory `parent`; 200 is the new row (lexical
  /// path as in the parent's listing). Refusals (400 `dir-name-invalid`, 409 `dir-exists`, 409 `mkdir-disabled`,
  /// 429 `mkdir-busy`) arrive as `.http` or `.rateLimited` with the server's sentence. Sent once, never retried.
  public func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    let response = try await perform(.post("/api/fs/mkdir", json: body))
    return try decodeCatalog(DirEntry.self, from: response.body, path: "/api/fs/mkdir")
  }

  /// `GET /api/resumable?cwd=` — do 20 rozmów CLI z katalogu, żywe w herdr oznaczone.
  public func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    let response = try await perform(.get("/api/resumable?cwd=\(Self.segment(cwd))"))
    return try decodeCatalog(ResumableList.self, from: response.body, path: "/api/resumable")
  }

  /// `GET /api/resumable/recent?cwd=` — 10 najświeższych ZAMKNIĘTYCH rozmów projektu.
  public func recentResumable(cwd: String) async throws(TransportError) -> ResumableList {
    let response = try await perform(.get("/api/resumable/recent?cwd=\(Self.segment(cwd))"))
    return try decodeCatalog(ResumableList.self, from: response.body, path: "/api/resumable/recent")
  }
}
