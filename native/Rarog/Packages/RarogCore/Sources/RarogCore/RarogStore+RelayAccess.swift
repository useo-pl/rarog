import Foundation
import RarogContract
import RarogTransport

// The iroh relay registry in the store. Owner: pairing. The registry client itself (`RelayAccess`, RarogTransport)
// lives in the app; the core reaches it only through `ServerConnector.relayPrepare` and `relayForget` and gets its
// statuses through `relayAccessChanged(_:)`. Contract: `docs/implementation-spec.md`, "iroh relay registry".
//
// - Status: `relayAccessChanged(_:)` → `AppState.relayAccess` (the "Server" screen). It belongs to the device, so
//   logout and switching servers leave it.
// - "Remove me from the registry": `forgetRelayRegistration()` calls `relayForget` once at a time and keeps the
//   returned status, unless the client's stream delivered a newer one meanwhile.
// - Pairing over iroh (`.iroh` and `.both`; `.https` skips all of this): after the space pointer check,
//   `relayPrepare` gets at most `RelayPairingTiming.prepareCeiling`; a client that does not answer by then counts as
//   `.unavailable` and pairing goes on (the client keeps syncing in the background). Meanwhile the sheet stays
//   `.pairing`, without "Cancel"; after `.skipped`, and after `.ready` without a recent sponsorship, it stays so during
//   the pairing request too.
// - The relay may not admit the server yet after `.fresh` (the client registered the app or sponsored the server
//   just now), after `.unavailable` (the registration may still be going on in the background, past the budget) and
//   after `.ready` whose sponsorship came less than `readinessWindow` before the end of the preparation (an earlier
//   preparation or a background sync). The sheet then turns into `.waitingForRelay(link, until:)` before the first
//   pairing request, with `until` = end of the preparation + `readinessWindow`. A transport failure of the request
//   (`offline`, which is also "no tunnel generation", or `timedOut`; never an HTTP answer of the server) repeats it
//   with a fresh `connector.pairing(target)` every `retryEvery` until `until`. Any other outcome, or the end of the
//   window, ends the pairing as without a registry. "Cancel" in this state, also during the first request, ends it
//   with `.ignored`: a late answer saves no key and switches nothing, and a request that still reaches the server
//   leaves a record there that expires on its own after 10 min.

/// Times of pairing over iroh against the relay registry, injected through ``ServerRuntime`` (tests use
/// milliseconds).
struct RelayPairingTiming: Sendable, Equatable {
  /// How long the core waits for `ServerConnector.relayPrepare` before `POST /api/pair` goes anyway: above the
  /// registry client's own budget (`RelayAccess.pairingBudget`, 8 s), so a working client answers first.
  var prepareCeiling: Duration
  /// How long after a fresh sponsorship the pairing request is repeated: the measured longest entry of a server
  /// into the relay with margin.
  var readinessWindow: Duration
  /// Gap between pairing requests inside the window.
  var retryEvery: Duration

  static let production = RelayPairingTiming(
    prepareCeiling: .seconds(10), readinessWindow: .seconds(60), retryEvery: .seconds(10))
}

/// Store bookkeeping of the relay registry (field `ServerRuntime.relay`).
struct RelayPairingRuntime {
  var timing = RelayPairingTiming.production
  /// The pause between pairing requests in the readiness window; "Cancel" cancels it.
  var wait: Task<Void, Never>?
  /// "Remove me from the registry" in flight: a second tap calls nothing.
  var forgetting = false
  /// Statuses delivered by `relayAccessChanged(_:)`: one that came during a removal is newer than its answer.
  var statusesSeen = 0
}

extension RarogStore {
  // MARK: - Status and removal

  /// A status from the app's registry client (in the order the client reports them).
  public func relayAccessChanged(_ status: RelayAccessStatus) {
    serverRuntime.relay.statusesSeen += 1
    dispatch(.pairing(.relayAccess(status)))
  }

  /// "Remove me from the registry" on the "Server" screen: the registry client forgets this device; its answer
  /// becomes ``AppState/relayAccess`` unless the client's stream delivered a status meanwhile. A tap while the previous
  /// one is in flight does nothing.
  public func forgetRelayRegistration() async {
    guard let connector = serverRuntime.connector, !serverRuntime.relay.forgetting else { return }
    serverRuntime.relay.forgetting = true
    defer { serverRuntime.relay.forgetting = false }
    let seen = serverRuntime.relay.statusesSeen
    let status = await connector.relayForget()
    // The client's stream reports the removal too, and a status it delivered meanwhile can be newer than this answer
    // (an empty server list queued behind the removal); the answer fills in only when the stream stayed silent.
    guard serverRuntime.relay.statusesSeen == seen else { return }
    dispatch(.pairing(.relayAccess(status)))
  }

  // MARK: - Pairing over iroh

  /// The registry client's preparation for pairing with `target`, at most ``RelayPairingTiming/prepareCeiling``.
  /// `.https` asks nothing (`.skipped`). A late answer is dropped: the client finishes on its own in the background.
  /// `owner` = the pairing's `client.log` owner (its offer), never the server logged in now.
  func prepareRelay(
    for target: PairingTarget, connector: ServerConnector, owner: ContractReporter.Owner
  ) async -> RelayPrepareResult {
    guard target.iroh != nil else { return .skipped }
    let prepare = connector.relayPrepare
    let ceiling = serverRuntime.relay.timing.prepareCeiling
    // The first of the two answers wins; the stream drops the other one after `finish()`.
    let (answers, answer) = AsyncStream.makeStream(of: (value: RelayPrepareResult, late: Bool).self)
    let timer = Task {
      guard (try? await Task.sleep(for: ceiling)) != nil else { return }
      answer.yield((.unavailable, true))
    }
    Task { answer.yield((await prepare(target), false)) }
    var result: (value: RelayPrepareResult, late: Bool) = (.unavailable, true)
    for await first in answers {
      result = first
      break
    }
    timer.cancel()
    answer.finish()
    if result.late { trace("pairing: relay registry not ready within the ceiling, pairing goes on", owner: owner) }
    return result.value
  }

  /// `POST /api/pair` along the link's target. When the relay may not admit the server yet
  /// (``waitsForRelay(_:preparedAt:window:)``) the sheet is `.waitingForRelay` (with "Cancel") from the first request
  /// on, and a transport failure repeats the request with a fresh pairing transport in the readiness window counted
  /// from `preparedAt`. Returns the last result; "Cancel" in the window returns `.cancelled`
  /// at once, and the caller drops it (and a late result of a request in flight) by the attempt number. `owner` as in
  /// ``prepareRelay(for:connector:owner:)``.
  func pairAdmittedByRelay(
    _ body: PairBody, link: PairingLink, relay: RelayPrepareResult, preparedAt: Date, attempt: Int,
    connector: ServerConnector, owner: ContractReporter.Owner
  ) async -> Result<PairResponse, TransportError> {
    let timing = serverRuntime.relay.timing
    guard Self.waitsForRelay(relay, preparedAt: preparedAt, window: timing.readinessWindow) else {
      return await Self.pair(body, through: connector.pairing(link.target))
    }
    let until = preparedAt.addingTimeInterval(timing.readinessWindow.timeInterval)
    // The relay admits a freshly sponsored server only after a while, and the first request usually waits for it
    // inside the transport (measured up to 42 s) instead of failing, so "Cancel" is there before that request goes out.
    guard attempt == serverRuntime.pairingAttempt else { return .failure(.cancelled) }
    dispatch(.pairing(.waitingForRelay(link, until: until)))
    trace("pairing: \(Self.relayReason(relay)), waiting for the relay to admit the server", owner: owner)
    var result = await Self.pair(body, through: connector.pairing(link.target))
    while case let .failure(error) = result, Self.isTransportFailure(error) {
      let left = until.timeIntervalSince(areaNow)
      guard left > 0, attempt == serverRuntime.pairingAttempt else { break }
      await pauseForRelay(min(timing.retryEvery, .seconds(left)))
      guard attempt == serverRuntime.pairingAttempt else { return .failure(.cancelled) }
      // The last pause may end at `until`: no request starts after the window, the last failure ends the pairing.
      guard areaNow < until else { break }
      result = await Self.pair(body, through: connector.pairing(link.target))
    }
    return result
  }

  /// Whether the relay may not admit the server yet: a registration or sponsorship in this preparation (`.fresh`), a
  /// preparation that did not finish (`.unavailable`), or a sponsorship less than `window` before `preparedAt`.
  nonisolated static func waitsForRelay(_ relay: RelayPrepareResult, preparedAt: Date, window: Duration) -> Bool {
    switch relay {
    case .fresh, .unavailable: true
    case let .ready(sponsoredAt?): preparedAt.timeIntervalSince(sponsoredAt) < window.timeInterval
    case .ready(nil), .skipped: false
    }
  }

  /// Why pairing waits for the relay, for `client.log`.
  private nonisolated static func relayReason(_ relay: RelayPrepareResult) -> String {
    switch relay {
    case .fresh: "fresh relay sponsorship"
    case .unavailable: "relay registry not ready"
    case .ready: "recent relay sponsorship"
    case .skipped: "relay registry skipped"
    }
  }

  /// "Cancel" in `.waitingForRelay`: the attempt number moves on (a request in flight lands as `.ignored`) and the
  /// pause between requests ends at once. In `.pairing` nothing changes.
  func stopWaitingForRelay() {
    guard case .waitingForRelay = state.pairing.flow else { return }
    serverRuntime.pairingAttempt += 1
    serverRuntime.relay.wait?.cancel()
    serverRuntime.relay.wait = nil
  }

  private func pauseForRelay(_ delay: Duration) async {
    let pause = Task<Void, Never> { try? await Task.sleep(for: delay) }
    serverRuntime.relay.wait = pause
    await pause.value
    if serverRuntime.relay.wait == pause { serverRuntime.relay.wait = nil }
  }

  /// A failure on the way to the server, not its answer: no tunnel generation (`offline`), no network, timeout.
  /// Only these wait for the relay.
  nonisolated static func isTransportFailure(_ error: TransportError) -> Bool {
    switch error {
    case .offline, .timedOut: true
    case .unauthorized, .forbidden, .rateLimited, .http, .refused, .cancelled, .invalidResponse: false
    }
  }

  private static func pair(_ body: PairBody, through client: any RarogTransporting) async
    -> Result<PairResponse, TransportError>
  {
    do {
      return .success(try await client.pair(body))
    } catch {
      return .failure(error)
    }
  }
}
