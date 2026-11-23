import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

// The iroh relay registry client in the app: `RelayAccess` from RarogTransport with the app's iroh
// identity, the DeviceCheck gate (`RelayGates.swift`), the Keychain store and the registry Worker client, one per
// process. `RarogApp` builds it and hands it to `TunnelCoordinator`, which passes the last server list and the
// triggers it sees inside tasks, never waiting for the client. This file adds the cold start trigger, forwards
// the client's statuses to the store in order and gives the connector its two registry calls (`relayPrepare`,
// `relayForget`). No dependency on `RarogApp`, because the file also compiles into `RarogUIKitTests`
// (`membershipExceptions` in `project.pbxproj`); the signer comes from the app, since `IrohSigner` lives in RarogIroh,
// which the tests do not link. Owner: relay registry client.

/// What the app uses of the registry client: `RelayAccess` in the app, a recorder in `RarogUIKitTests`.
nonisolated protocol RelayAccessControl: Sendable {
  /// The current status at once, then every change.
  var statuses: AsyncStream<RelayAccessStatus> { get }
  /// T-list: the iroh pairs of the current credential (today zero or one).
  func setServers(_ servers: [TunnelTarget]) async
  /// An automatic trigger; the client does not make the caller wait for the registry.
  func trigger(_ reason: RelayAccessTrigger) async
  /// Registration and sponsorship of `server` before pairing over iroh, back within `budget`.
  func prepareForPairing(_ server: TunnelTarget, budget: Duration) async -> RelayPrepareResult
  /// Remove Me from the Registry; the status after the operation.
  func forget() async -> RelayAccessStatus
}

extension RelayAccess: RelayAccessControl {}

/// The registry client's signer: the app's iroh key (the endpoint's key, so the app's EndpointId is the same), and
/// once per process the line `relay-access: app <EndpointId>` in `client.log`, by which the owner finds this device in
/// the registry.
nonisolated final class RelayAccessIdentity: Sendable {
  private let identities: IrohIdentityStore
  private let makeSigner: @Sendable (Data) throws -> any TunnelSigner
  private let log: @Sendable (String) -> Void
  private let announced = Mutex(false)

  /// - Parameters:
  ///   - identities: the process's one identity store (the endpoint lease reads the same one).
  ///   - makeSigner: a signer from the 32-byte secret key (`IrohSigner` in the app).
  ///   - log: a line to `client.log`.
  init(
    identities: IrohIdentityStore, makeSigner: @escaping @Sendable (Data) throws -> any TunnelSigner,
    log: @escaping @Sendable (String) -> Void
  ) {
    self.identities = identities
    self.makeSigner = makeSigner
    self.log = log
  }

  /// `nil` while the identity is unavailable (before the first unlock, a refused Keychain): the client then sends
  /// nothing and waits for `identityAvailable`.
  func signer() async -> (any TunnelSigner)? {
    guard case let .ready(identity) = await identities.identity() else { return nil }
    let signer: any TunnelSigner
    do {
      signer = try makeSigner(identity.secretKey)
    } catch {
      log("relay-access: signer unavailable")
      return nil
    }
    let first = announced.withLock { done in
      defer { done = true }
      return !done
    }
    if first { log("relay-access: app \(signer.endpointId)") }
    return signer
  }
}

/// Assembly of the registry client in the app.
@MainActor
enum RelayAccessWiring {
  /// The production client: the gate and the map from `RelayAccessSetup` (a fake gate and other values only in Debug),
  /// both Keychain items in the app's private group, requests with the app's version and build in the client header.
  static func live(
    identities: IrohIdentityStore, makeSigner: @escaping @Sendable (Data) throws -> any TunnelSigner,
    log: @escaping @Sendable (String) -> Void, bundle: Bundle = .main
  ) -> RelayAccess {
    let identity = RelayAccessIdentity(identities: identities, makeSigner: makeSigner, log: log)
    let info = { (key: String) in bundle.object(forInfoDictionaryKey: key) as? String ?? "" }
    return RelayAccess(
      signer: { await identity.signer() },
      gate: RelayAccessSetup.gate(environment: RelayAccessSetup.environment()),
      transport: RelayAuthClient(appVersion: info("CFBundleShortVersionString"), build: info("CFBundleVersion")),
      store: SystemRelayAccessStore(group: AppEnvironment.keychain(bundle: bundle).appGroup, log: log),
      registries: RelayAccessSetup.registries(log: log), renewEvery: RelayAccessSetup.renewEvery(log: log), log: log)
  }

  /// The connector with the registry calls: before pairing over iroh (`k` in the link, also with `u`) the client
  /// registers the app and sponsors the link's server within `RelayAccess.pairingBudget`; an address alone asks
  /// nothing. Remove Me from the Registry is the client's `forget`.
  static func connect(_ connector: ServerConnector, to relay: any RelayAccessControl) -> ServerConnector {
    var connector = connector
    connector.relayPrepare = { target in
      guard let iroh = target.iroh else { return .skipped }
      return await relay.prepareForPairing(TunnelCoordinator.target(iroh), budget: RelayAccess.pairingBudget)
    }
    connector.relayForget = { await relay.forget() }
    return connector
  }

  /// Cold start: the client's statuses go to `deliver` in the order the client reports them (for the whole process),
  /// and the client gets T-start. The store's first server list (`TunnelCoordinator.transport`) is already on its way.
  @discardableResult
  static func start(
    _ relay: any RelayAccessControl, statuses deliver: @escaping @MainActor @Sendable (RelayAccessStatus) -> Void
  ) -> Task<Void, Never> {
    let statuses = relay.statuses
    let forwarding = Task { @MainActor in
      for await status in statuses { deliver(status) }
    }
    Task.immediate { await relay.trigger(.start) }
    return forwarding
  }
}
