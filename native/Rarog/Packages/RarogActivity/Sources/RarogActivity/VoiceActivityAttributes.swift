import Foundation

#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

// The voice Live Activity: the app's own second Live Activity, beside the sessions board, shown while a voice
// conversation or a message-field dictation records under the locked-phone trial. The app starts, updates and ends
// it itself (no push type), so its state never comes from the server. Owner: voice agent.

/// Attributes of the voice Live Activity. Nothing fixed: everything it shows stands in ``ContentState``.
public struct VoiceActivityAttributes: Codable, Sendable, Hashable {
  public init() {}

  /// What records, what it does now, what it is about and since when, nothing else: no prompt, dictated text,
  /// question or end sentence. The Lock Screen shows the activity to anyone who holds the phone, so the only text
  /// the state carries is the session's project and name as the app shows them, each cut to ``nameCeiling``.
  public struct ContentState: Codable, Sendable, Hashable {
    /// What records on the app's one microphone.
    public enum Kind: String, Codable, Sendable, CaseIterable {
      case conversation
      case dictation
    }

    /// The word the activity shows for what the recording does.
    public enum Phase: String, Codable, Sendable, CaseIterable {
      case listening
      case answering
      case working
      /// The voice agent reads a session to answer.
      case reading
      /// A prompt the voice agent showed waits for the user's spoken yes or no.
      case prompt
      case muted
      case dictating
    }

    /// What the recording is about: all sessions, or one session (named by ``project`` and ``name`` when the app
    /// can name it).
    public enum Scope: String, Codable, Sendable, CaseIterable {
      case allSessions
      case session
    }

    /// Characters kept of a project or a session name: the tile shows one truncated line, and a longer value would
    /// only make the state bigger.
    public static let nameCeiling = 80

    public var kind: Kind
    public var phase: Phase
    public var scope: Scope
    /// The session's project; `nil` for all sessions or a session the app cannot name.
    public var project: String?
    /// The session's name; `nil` for all sessions or a session without a name.
    public var name: String?
    /// Start of the system timer on the activity (it counts up from here).
    public var startedAt: Date

    /// All sessions carry no names; an empty name counts as none.
    public init(
      kind: Kind, phase: Phase, scope: Scope, project: String? = nil, name: String? = nil, startedAt: Date
    ) {
      self.kind = kind
      self.phase = phase
      self.scope = scope
      self.project = scope == .session ? Self.cut(project) : nil
      self.name = scope == .session ? Self.cut(name) : nil
      self.startedAt = startedAt
    }

    private static func cut(_ value: String?) -> String? {
      guard let value, !value.isEmpty else { return nil }
      return String(value.prefix(nameCeiling))
    }
  }
}

#if canImport(ActivityKit) && os(iOS)
extension VoiceActivityAttributes: ActivityAttributes {}
#endif
