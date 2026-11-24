// The macOS folders the server keeps closed: the `folder-access` frame of the global stream, a mirror of
// `shared/src/protocol/folders.ts`. A server with the folder gate on sends the full list right after
// `sessions-snapshot`, also empty, and again on every change; a server without the gate never sends it.
// Golden frames: `folder-access.*.json` in `shared/fixtures/sse/`.
// Owner: macOS folders (native app).

/// `MAC_FOLDER_STATES`: no answer from the disk (macOS probably shows a window on the Mac), refused by macOS, or the
/// server could not tell.
public enum MacFolderState: String, ContractEnum {
  case waiting, denied, unchecked
}

/// One closed folder. A block with an unknown `state` drops out of the list (``decodeTolerant(from:)``).
public struct MacFolderBlock: Sendable, Equatable, Codable {
  /// The folder's name under home as macOS names it: `Desktop`, `Documents`, `Downloads`.
  public var name: String
  /// The absolute path on the server.
  public var path: String
  public var state: MacFolderState
  /// ISO 8601: when the folder entered this state.
  public var since: String

  enum CodingKeys: String, CodingKey { case name, path, state, since }

  /// `nil` = the block has an unknown `state` (recorded as a degradation `folder-access.block`) and drops out of the
  /// list. Every other field is checked first, so a broken block still rejects the frame, as in
  /// `shared/src/decode.ts`.
  static func decodeTolerant(from decoder: any Decoder) throws -> MacFolderBlock? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    _ = try c.nonEmpty(.name)
    _ = try c.nonEmpty(.path)
    let _: String = try c.required(.since)
    guard try c.known(.state, as: MacFolderState.self) else { return nil }
    return try MacFolderBlock(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    name = try c.nonEmpty(.name)
    path = try c.nonEmpty(.path)
    state = try c.strict(.state)
    since = try c.required(.since)
  }
}

/// Every closed folder, sorted by `name`; an empty list means every folder is open. A block the app cannot read drops
/// out and the other blocks stay, so a state added later does not hide the folders this app can name.
public struct FolderAccessEvent: Sendable, Equatable, Codable {
  public var blocked: [MacFolderBlock]

  enum CodingKeys: String, CodingKey { case blocked }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    var items = try c.base.nestedUnkeyedContainer(forKey: .blocked)
    var out: [MacFolderBlock] = []
    while !items.isAtEnd {
      if let block = try MacFolderBlock.decodeTolerant(from: items.superDecoder()) { out.append(block) }
    }
    blocked = out
  }
}
