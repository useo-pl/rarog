import Foundation

// Rules of a credential with only an iroh route. Such a credential has no other route, so a failed
// attempt must not keep it offline for long: instead of the 2 min failure memory it gets a retry series and a longer
// attempt budget in the foreground; like every credential it reports a failure to the lease at most once per
// `irohRetryDelay`. Its trace in `client.log` is two alarm lines per outage: the first failure with its cause and the
// recovery. The state lives in `TunnelMachine.Memory`; the transitions stay in `TunnelMachine.swift`.

extension TunnelMachine {
  /// Attempt budget of an iroh-only credential in the foreground; with HTTPS and in the background `attemptBudget`.
  public static let irohOnlyAttemptBudget: Duration = .seconds(30)
  /// Pauses after the first, second, third and fourth failure of an iroh-only series; `irohOnlyRetryCeiling` after
  /// every later one.
  public static let irohOnlyRetryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8)]
  public static let irohOnlyRetryCeiling: Duration = .seconds(15)

  /// Pause of the iroh-only series after its `failures`-th failure (from 1).
  public static func irohOnlyRetryDelay(afterFailures failures: Int) -> Duration {
    let index = failures - 1
    guard index >= 0, index < irohOnlyRetryDelays.count else { return irohOnlyRetryCeiling }
    return irohOnlyRetryDelays[index]
  }

  /// Iroh-only outage for `client.log`: from the first failed attempt to the next ready iroh generation. A network
  /// change restarts the retry series but not the outage, so one outage gives at most two alarm lines.
  public struct Outage: Sendable, Equatable {
    public var since: Instant
    /// Failed attempts so far, the first one included.
    public var failures: Int
    public init(since: Instant, failures: Int) {
      self.since = since
      self.failures = failures
    }
  }

  /// Iroh-only credential: an iroh pair and no HTTPS address.
  var irohOnly: Bool { routes.hasIroh && !routes.hasHTTPS }

  /// Recovery line of an outage that ends with ready generation `gen`.
  static func recoveryLine(_ gen: UInt64, _ outage: Outage, now: Instant) -> String {
    let seconds = Int((outage.since.duration(to: now) / .seconds(1)).rounded(.down))
    return "generation \(gen) (iroh) recovered after \(outage.failures) attempts, \(seconds) s"
  }

  /// Alarm line of a ready iroh generation that closes in the foreground (`TunnelTrace` counts it as an alarm).
  static func foregroundCloseLine(_ gen: UInt64, reason: String) -> String {
    "generation \(gen) (iroh) closed in foreground: \(reason)"
  }
}
