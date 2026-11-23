import Foundation
import Synchronization

// The limit for iroh failure reports, shared by runtimes that do not live long enough to hold it themselves.
// Each `TunnelMachine` reports a failure to the endpoint lease at most once per `irohRetryDelay`, but a pairing
// retry or a revoke of the previous key builds a new one-off runtime (`TunnelCoordinator.pairing`,
// `forgetTransport`) with a fresh machine. Without a shared limit three quick failures would reach
// `EndpointLease.brokenAfterFailures` and rebind the endpoint under the current server's working generation.
// Owner: the tunnel (`TunnelRuntime` applies it, the app coordinator holds one for both one-off paths).

/// One failure report to the lease per `TunnelMachine.irohRetryDelay` across every runtime that shares it. A success
/// report never passes through it.
public final class IrohReportThrottle: Sendable {
  private let reportedAt = Mutex<ContinuousClock.Instant?>(nil)

  public init() {}

  /// Whether a failure at `now` goes to the lease. The first failure goes, and so does the first one after
  /// `irohRetryDelay` from the last one that went; `true` counts as reported.
  public func admitFailure(at now: ContinuousClock.Instant) -> Bool {
    reportedAt.withLock { last in
      guard last.map({ $0.duration(to: now) >= TunnelMachine.irohRetryDelay }) ?? true else { return false }
      last = now
      return true
    }
  }
}
