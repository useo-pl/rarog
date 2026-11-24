import Foundation

// The session file a path in the transcript names. Agents mention files in inline code, often as a bare file name or
// with a line number, rarely as a link, so the text of one inline code run is the input: `candidate(_:cwd:)` turns it
// into a path relative to the session directory or refuses it, and `resolve(_:in:)` finds the one index path it
// names. Paths compare by bytes, the way the Files search does
// (``FilePathKey``): two Unicode forms of one name are two files to the server. Pure, tested on macOS.
// Owner: transcript.

public enum TranscriptFilePath {
  /// What a candidate names in an index.
  public enum Match: Sendable, Equatable {
    case found(String)
    /// No index path is the candidate or ends with it.
    case notFound
    /// More than one index path ends with the candidate.
    case ambiguous
    /// Not an exact member of an index a server ceiling cut: a suffix found there may not be the only one.
    case truncated
  }

  /// The candidate in the text of one inline code run; `nil` = not a candidate. Takes off a trailing ":N", ":N:M" or
  /// ":N-M" and a leading "./"; an absolute path under `cwd` (on a segment boundary, a trailing slash of `cwd`
  /// tolerated) becomes relative. Any other absolute path, "~", a ".." segment, a URL, white space or a path ending
  /// in "/" is not a session file the server would send.
  public static func candidate(_ code: String, cwd: String) -> String? {
    guard !code.isEmpty, !code.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) })
    else { return nil }
    var path = withoutLineSuffix(code)
    guard !hasScheme(path), !path.hasPrefix("~") else { return nil }
    if path.hasPrefix("/") {
      guard let relative = relative(path, to: cwd) else { return nil }
      path = relative
    } else if path.hasPrefix("./") {
      path.removeFirst(2)
    }
    guard !path.isEmpty, !path.hasSuffix("/"), !path.split(separator: "/", omittingEmptySubsequences: false)
      .contains("..")
    else { return nil }
    return path
  }

  /// The index path the candidate names: an exact member; else the only index path that ends with "/" + candidate
  /// (a bare name without "/" only when it has an extension, and only in an index no ceiling cut); `nil` when none or
  /// more than one.
  public static func resolve(_ candidate: String, in index: FileSearchIndex) -> String? {
    if case let .found(path) = match(candidate, in: index) { return path }
    return nil
  }

  /// ``resolve(_:in:)`` with the reason of a miss.
  public static func match(_ candidate: String, in index: FileSearchIndex) -> Match {
    if index.contains(candidate) { return .found(candidate) }
    // A bare word without an extension (`README`, `Makefile`) reads as prose or a symbol as often as a file name.
    guard candidate.contains("/") || hasExtension(candidate) else { return .notFound }
    // The files past the ceiling are unknown, so one hit in the rest does not make the suffix unique.
    guard !index.truncated else { return .truncated }
    let suffix = Array(("/" + candidate).utf8)
    var hit: String?
    for path in index.paths where path.utf8.count > suffix.count && path.utf8.reversed().starts(with: suffix.reversed())
    {
      guard hit == nil else { return .ambiguous }
      hit = path
    }
    return hit.map(Match.found) ?? .notFound
  }

  /// The code without a trailing line reference (":42", ":42:5", ":3-9").
  private static func withoutLineSuffix(_ code: String) -> String {
    guard let range = code.range(of: #":[0-9]+(?::[0-9]+|-[0-9]+)?$"#, options: .regularExpression) else {
      return code
    }
    return String(code[..<range.lowerBound])
  }

  /// "https:", "mailto:", "file:" and any other URL scheme at the start.
  private static func hasScheme(_ text: String) -> Bool {
    text.range(of: #"^[A-Za-z][A-Za-z0-9+.\-]*:"#, options: .regularExpression) != nil
  }

  /// The absolute path relative to `cwd`, compared by bytes; `nil` outside it, for `cwd` itself and without a `cwd`.
  private static func relative(_ path: String, to cwd: String) -> String? {
    var root = cwd
    while root.count > 1, root.hasSuffix("/") { root.removeLast() }
    guard root.hasPrefix("/") else { return nil }
    let prefix = Array((root == "/" ? "/" : root + "/").utf8)
    let bytes = Array(path.utf8)
    guard bytes.count > prefix.count, bytes.starts(with: prefix) else { return nil }
    return String(decoding: bytes[prefix.count...], as: UTF8.self)
  }

  /// The last segment has a dot that is neither its first nor its last character.
  private static func hasExtension(_ name: String) -> Bool {
    let last = name.split(separator: "/").last.map(String.init) ?? name
    guard let dot = last.lastIndex(of: "."), dot != last.startIndex else { return false }
    return last.index(after: dot) != last.endIndex
  }
}
