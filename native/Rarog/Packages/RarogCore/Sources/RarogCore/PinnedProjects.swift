import Foundation

// Projects pinned in the list tree on this device: directory paths only, no content. A pinned project stands above
// the others (`AppState.projectGroups(pinned:)`). Owner: projects and tabs.

/// Directories the human pinned on this device, the earliest pinned first. A project outside the set is not pinned.
/// The cap of 64 applies to HISTORY: the earliest pinned directory that is not in the tree today goes first. A
/// project standing in the tree is never unpinned by the cap, because that would move it on its own; when more pinned
/// projects stand in the tree than the cap, the set grows past it.
public struct PinnedProjects: Sendable, Equatable, Codable {
  public static let capacity = 64
  /// Cap on reading from disk: reading does not know which directories stand in the tree today, so it trims only a
  /// bloated (or damaged) record, with room for every project of the tree above the history.
  static let storedLimit = 128

  public private(set) var cwds: [String] = []

  public init() {}

  public func contains(_ cwd: String) -> Bool {
    cwds.contains(ProjectPath.normalized(cwd))
  }

  /// Pins or unpins a project; `true` = a change (save only then). Pinning a pinned project does not move it in the
  /// cap's queue. `present` = directories of the headers standing in the tree today: the cap does not push them out.
  @discardableResult
  public mutating func set(_ cwd: String, pinned: Bool, present: Set<String> = []) -> Bool {
    let key = ProjectPath.normalized(cwd)
    guard !key.isEmpty else { return false }
    let before = cwds
    if pinned {
      if !cwds.contains(key) { cwds.append(key) }
    } else {
      cwds.removeAll { $0 == key }
    }
    trim(keeping: Set(present.map(ProjectPath.normalized)))
    return cwds != before
  }

  /// History cap: the earliest pinned directories outside the tree go until the set fits in ``capacity``.
  private mutating func trim(keeping present: Set<String>) {
    var excess = cwds.count - Self.capacity
    guard excess > 0 else { return }
    var kept: [String] = []
    for cwd in cwds {
      if excess > 0, !present.contains(cwd) {
        excess -= 1
      } else {
        kept.append(cwd)
      }
    }
    cwds = kept
  }

  enum CodingKeys: String, CodingKey { case cwds }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Entry by entry: one damaged entry does not unpin the rest.
    var raw: [String] = []
    if var items = try? c.nestedUnkeyedContainer(forKey: .cwds) {
      while !items.isAtEnd {
        if let cwd = try? items.decode(String.self) {
          raw.append(cwd)
        } else {
          _ = try? items.decode(SkippedEntry.self)
        }
      }
    }
    for cwd in raw.map(ProjectPath.normalized) where !cwd.isEmpty && !cwds.contains(cwd) { cwds.append(cwd) }
    if cwds.count > Self.storedLimit { cwds.removeFirst(cwds.count - Self.storedLimit) }
  }
}
