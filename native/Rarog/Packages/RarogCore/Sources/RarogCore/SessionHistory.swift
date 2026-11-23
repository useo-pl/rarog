import Foundation

// Device history of visited sessions for the session switcher (Cmd+S): session ids only,
// no content. Entries are a HINT: the reader keeps only sessions the app still knows (`recent(limit:alive:)`).
// Stored under `NavigationPreferences.sessionHistory`, cleared with a new data space. Owner: projects and
// tabs.

/// Sessions this device visited, without duplicates, ceiling 32 (a reserve for deleted sessions; the switcher shows
/// 10). Newest at the END, like ``ProjectHistory``.
public struct SessionHistory: Sendable, Equatable, Codable {
  public static let capacity = 32

  public private(set) var ids: [String] = []

  public init() {}

  /// Records a visit; `true` = a change (save only then). Repeating the current session records nothing.
  @discardableResult
  public mutating func note(_ id: String) -> Bool {
    guard !id.isEmpty, ids.last != id else { return false }
    ids.removeAll { $0 == id }
    ids.append(id)
    if ids.count > Self.capacity { ids.removeFirst(ids.count - Self.capacity) }
    return true
  }

  /// Up to `limit` sessions, newest FIRST, only those `alive` accepts. A dead session is skipped, not deleted.
  public func recent(limit: Int, alive: (String) -> Bool) -> [String] {
    guard limit > 0 else { return [] }
    var result: [String] = []
    for id in ids.reversed() where alive(id) {
      result.append(id)
      if result.count == limit { break }
    }
    return result
  }

  enum CodingKeys: String, CodingKey { case ids }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = (try? c.decode([String].self, forKey: .ids)) ?? []
    // A damaged entry (empty id, a duplicate) must not break the order: each id keeps its newest place.
    for id in raw where !id.isEmpty {
      ids.removeAll { $0 == id }
      ids.append(id)
    }
    if ids.count > Self.capacity { ids.removeFirst(ids.count - Self.capacity) }
  }
}
