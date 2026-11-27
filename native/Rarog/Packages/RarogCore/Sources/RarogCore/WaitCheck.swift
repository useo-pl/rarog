import Foundation

// "Check" next to a subagent that waits long on its own background command: one tap sends the main agent a fixed
// message (composed in `RarogUI`) through the outbox, as a typed prompt goes. This file holds the guard against a
// second message for the same wait: its state, its events and the button's answer. The action is
// `RarogStore+WaitCheck`, the branches `Reducer+WaitCheck`, the answer `Selectors+WaitCheck`. Owner: send.
//
// The guard has its own state and is not only a pointer to the outbox: the send adds the entry to the state only
// after the disk write, and the echo removes the entry, so neither "an entry in the outbox" nor "no entry" says whether
// the message went out.

/// The Check messages of this device, by wait key (`BackgroundTaskRules.waitKey`: the agent and its standby). In memory
/// only: a new app process starts empty. Emptied together with the outbox when the store enters another data space
/// (another server, Forget Server); a logout keeps both. Changed only by `Reducer+WaitCheck` and that space change.
public struct WaitCheckState: Sendable, Equatable {
  public struct Check: Sendable, Equatable {
    /// The outbox entry of the message, which is also its `clientMessageId`: a Retry sends this same entry.
    public let entryId: UUID
    /// When the server took the message: its 202 or its echo, whichever came first. `nil` = not yet. Once set it
    /// stays until the wait ends (a new standby is a new key): an entry gone from the outbox gives no right to send
    /// again.
    public internal(set) var acceptedAt: Date?

    init(entryId: UUID) {
      self.entryId = entryId
    }
  }

  public internal(set) var checks: [String: Check] = [:]

  public init() {}
}

public enum WaitCheckEvent: Sendable, Equatable {
  /// A tap took the wait for the entry `entryId`, before the first `await`: a second tap meanwhile finds it taken.
  case reserved(key: String, entryId: UUID)
  /// The send of `entryId` left no entry (refused before the disk, the disk refused, another data space): the wait is
  /// free again. A later reservation of the same key is left alone.
  case released(key: String, entryId: UUID)
}

/// What the Check button of one wait shows (`AppState.waitCheck(_:in:)`).
public enum WaitCheckStatus: Sendable, Equatable {
  /// No message for this wait yet, or the last one surely did not arrive: a tap sends a new one.
  case ready
  /// The entry is being written or its request is in flight: a tap sends nothing.
  case sending
  /// The entry is Not confirmed or refused with Retry (it may have arrived, or a gate stopped it): a tap sends this
  /// same entry again.
  case retry(UUID)
  /// The server took the message at this moment: a tap sends nothing until the wait ends.
  case sent(Date)
}
