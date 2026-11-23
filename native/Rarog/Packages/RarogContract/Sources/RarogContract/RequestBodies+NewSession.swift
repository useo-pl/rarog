// Request bodies of the New Session form, the mirror of `makeDirBodySchema` in `shared/src/protocol/directories.ts`.
// Golden body: `shared/fixtures/requests/fs.mkdir.json` (producer `RequestFixturesTests`, read by the server schema).

/// `POST /api/fs/mkdir`: one new directory `name` in the listed directory `parent` (the `path` of a ``DirListing``).
/// The server judges the name (NFC, at most 255 bytes, no `/`, `:` or control characters, no leading dot, no space at
/// either end) and answers 200 with the new row as a ``DirEntry``; the app trims the name before sending.
public struct MakeDirBody: Sendable, Equatable, Encodable {
  public var parent: String
  public var name: String

  public init(parent: String, name: String) {
    self.parent = parent
    self.name = name
  }
}
