// Session files: the listing of one directory (`GET /api/sessions/:id/files?dir=`), the index of the session's files
// (`GET /api/sessions/:id/files/index`) and the 413 refusal of a file over the server's limit
// (`GET /api/sessions/:id/files/raw?path=`), a mirror of `fileListingSchema`, `fileIndexSchema` and
// `fileTooLargeBodySchema` in `shared/src/rest.ts` (types and order in `shared/src/protocol/files.ts`). Golden
// responses: `files.*.json` and `error.file*.json` in `shared/fixtures/rest/`. Owner: session files (native app).

/// Kind of a listing entry. The server lists directories and regular files only.
public enum FileEntryKind: String, ContractEnum {
  case dir
  case file
}

/// One entry of a listing: its name in the listed directory, never a path. `size` (bytes) comes for files only;
/// `ignored` = git ignores the entry, a label only (the file is fetched like any other).
public struct FileEntry: Sendable, Equatable, Decodable {
  public var name: String
  public var kind: FileEntryKind
  public var size: Int?
  public var ignored: Bool

  enum CodingKeys: String, CodingKey { case name, kind, size, ignored }

  public init(name: String, kind: FileEntryKind, size: Int? = nil, ignored: Bool = false) {
    self.name = name
    self.kind = kind
    self.size = size
    self.ignored = ignored
  }

  /// `nil` = an entry of a kind this app does not know: it drops out of the listing. Every other field is checked
  /// first, so a broken entry still rejects the whole listing.
  static func decodeTolerant(from decoder: any Decoder) throws -> FileEntry? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    _ = try c.nonEmpty(.name)
    _ = try size(c)
    _ = try ignored(c)
    guard try c.known(.kind, as: FileEntryKind.self) else { return nil }
    return try FileEntry(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    name = try c.nonEmpty(.name)
    kind = try c.strict(.kind)
    size = try Self.size(c)
    ignored = try Self.ignored(c)
  }

  private static func size(_ c: ContractContainer<CodingKeys>) throws -> Int? {
    let value: Int? = try c.optional(.size)
    if let value, value < 0 { throw contractViolation(c.codingPath + [CodingKeys.size], "negative size") }
    return value
  }

  /// `ignored` is the literal `true` or a missing field; `false` does not exist on the wire.
  private static func ignored(_ c: ContractContainer<CodingKeys>) throws -> Bool {
    let flag: Bool? = try c.optional(.ignored)
    if flag == false { throw contractViolation(c.codingPath + [CodingKeys.ignored], "ignored is the literal true") }
    return flag == true
  }

  /// The order of a listing (`compareFileEntries` in `shared/src/protocol/files.ts`): directories before files, then
  /// by the lowercased name, then by the name itself, both by UTF-16 code units, without a locale. The tie on the
  /// lowercased name is code units too: `String ==` holds for canonically equivalent text (`ά` and `α` with an acute),
  /// which the server's comparator tells apart.
  public static func listingOrder(_ a: FileEntry, _ b: FileEntry) -> Bool {
    if a.kind != b.kind { return a.kind == .dir }
    let (left, right) = (a.name.lowercased(), b.name.lowercased())
    if !left.utf16.elementsEqual(right.utf16) { return left.utf16.lexicographicallyPrecedes(right.utf16) }
    return a.name.utf16.lexicographicallyPrecedes(b.name.utf16)
  }
}

/// 200 of `GET /api/sessions/:id/files?dir=`: `dir` as requested (`""` = the session directory), entries in
/// ``FileEntry/listingOrder(_:_:)``, `truncated` = the directory had more than the server's ceiling. `maxBytes` is the
/// largest file the server sends; the app takes it from the latest listing of the session (else from its
/// ``FileIndex``) and has no limit of its own.
public struct FileListing: Sendable, Equatable, Decodable {
  public var dir: String
  public var entries: [FileEntry]
  public var truncated: Bool
  public var maxBytes: Int

  enum CodingKeys: String, CodingKey { case dir, entries, truncated, maxBytes }

  public init(dir: String, entries: [FileEntry], truncated: Bool, maxBytes: Int) {
    self.dir = dir
    self.entries = entries
    self.truncated = truncated
    self.maxBytes = maxBytes
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    dir = try c.required(.dir)
    var items = try c.base.nestedUnkeyedContainer(forKey: .entries)
    var out: [FileEntry] = []
    while !items.isAtEnd {
      if let entry = try FileEntry.decodeTolerant(from: items.superDecoder()) { out.append(entry) }
    }
    entries = out
    truncated = try c.required(.truncated)
    maxBytes = try c.required(.maxBytes)
    if maxBytes <= 0 { throw contractViolation(c.codingPath + [CodingKeys.maxBytes], "maxBytes is positive") }
  }
}

/// 200 of `GET /api/sessions/:id/files/index`: the regular files under the session directory, relative to it, segments
/// joined with `/`, in the order of the server's breadth-first walk; files git ignores are not in it. `truncated` = a
/// directory or the walk hit one of the server's ceilings, so the index is not the whole directory. `maxBytes` as in
/// ``FileListing``: a preview from the index needs no listing first.
public struct FileIndex: Sendable, Equatable, Decodable {
  public var paths: [String]
  public var truncated: Bool
  public var maxBytes: Int

  enum CodingKeys: String, CodingKey { case paths, truncated, maxBytes }

  public init(paths: [String], truncated: Bool, maxBytes: Int) {
    self.paths = paths
    self.truncated = truncated
    self.maxBytes = maxBytes
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    paths = try c.required(.paths)
    if paths.contains("") { throw contractViolation(c.codingPath + [CodingKeys.paths], "empty path") }
    truncated = try c.required(.truncated)
    maxBytes = try c.required(.maxBytes)
    if maxBytes <= 0 { throw contractViolation(c.codingPath + [CodingKeys.maxBytes], "maxBytes is positive") }
  }
}

/// 413 `file-too-large` of `GET /api/sessions/:id/files/raw?path=`: the error body plus the file's size and the
/// server's limit, both in bytes. The server refuses before the first byte of the file.
public struct FileTooLargeBody: Sendable, Equatable, Codable, SentenceBearing {
  public var error: String
  public var message: String
  public var messageRef: SentenceRef?
  public var size: Int
  public var maxBytes: Int

  enum CodingKeys: String, CodingKey { case error, message, messageRef, size, maxBytes }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    error = try c.required(.error)
    guard error == "file-too-large" else {
      throw contractViolation(c.codingPath + [CodingKeys.error], "error must be file-too-large")
    }
    message = try c.required(.message)
    messageRef = try c.optional(.messageRef)
    size = try c.required(.size)
    maxBytes = try c.required(.maxBytes)
    if size < 0 { throw contractViolation(c.codingPath + [CodingKeys.size], "negative size") }
    if maxBytes <= 0 { throw contractViolation(c.codingPath + [CodingKeys.maxBytes], "maxBytes is positive") }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(error, forKey: .error)
    try c.encode(message, forKey: .message)
    try c.encodeIfPresent(messageRef, forKey: .messageRef)
    try c.encode(size, forKey: .size)
    try c.encode(maxBytes, forKey: .maxBytes)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    message = render(message, messageRef)
  }
}
