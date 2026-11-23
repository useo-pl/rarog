import Foundation
import RarogContract
import RarogTransport

// "Forget Server" and revoking a previous device key on its server. Owner: pairing. Pairing itself, the device key
// and a 401 `device-revoked` live in `RarogStore+Pairing`; the data space dropped first lives in `RarogStore+Spaces`.
//
// - The server gets one tunnel attempt to answer (`ServerRuntime.forgetLimit`, `TunnelMachine.attemptBudget`), so an
//   iroh tunnel still connecting after a return from the background gets through; without an answer the server keeps
//   the device and Forget goes on locally (`docs/security-model.md`, "Native client: what is stored on the iPad").
// - The previous key after pairing with another one goes through the connector's one-off `forgetTransport`, in the
//   background; in the app that transport shares the pairing limit of iroh failure reports (`TunnelCoordinator`).

extension RarogStore {
  // MARK: - Forget Server

  /// Forget Server: the app stops reading its data at once (invalidated on disk as the FIRST step, `dropSpace`), the
  /// server revokes this device (best effort, within ``ServerRuntime/forgetLimit``), the Keychain item, the APNs token
  /// and the Live Activity go, and the app returns to the pairing screen. `false` = the server was not forgotten (the
  /// disk refused to invalidate the data, `PairingState.forgetFailed`, or there was nothing to forget).
  @discardableResult
  public func forgetServer() async -> Bool {
    // A pairing in flight excludes Forget (and the other way round, `offerPairing`/`confirmPairing`): the reply of one
    // would delete the key of the other.
    guard let connector = serverRuntime.connector, let credential = serverRuntime.endpoint.credential,
      !state.pairing.forgetting, !isPairingInFlight
    else { return false }
    dispatch(.pairing(.forgetting(true)))
    guard dropSpace() else {
      // A key whose data could not be invalidated on disk: after a restart the data would come back with pairing
      // again. Nothing is touched.
      dispatch(.pairing(.forgetting(false)))
      dispatch(.pairing(.forgetFailed))
      return false
    }
    serverRuntime.forgettingDevice = credential.deviceId
    serverRuntime.forgetRevoked = false
    defer {
      serverRuntime.forgettingDevice = nil
      serverRuntime.forgetRevoked = false
    }
    let transport = transport
    let forget = Task { try? await transport.forgetDevice() }
    // A slow or dead server does not hold the screen: after the limit the local cleanup goes on without an answer.
    let (wait, sleep) = (serverRuntime.forgetLimit, serverRuntime.forgetSleep)
    let limit = Task {
      await sleep(wait)
      forget.cancel()
    }
    _ = await forget.value
    limit.cancel()
    // The key is still the same: the usual path. Revoked by THIS operation (`device-revoked` before the 204):
    // `deviceRejected` already handled the key, the transport and the logout, and the data cleanup goes on.
    // Otherwise (cannot happen today: pairing is excluded meanwhile) nothing is touched.
    let same = serverRuntime.endpoint.credential?.deviceId == credential.deviceId
    guard same || serverRuntime.forgetRevoked else {
      dispatch(.pairing(.forgetting(false)))
      return false
    }
    if same { connector.keychain.delete(deviceId: credential.deviceId) }
    clearRevocation()
    dispatch(.pairing(.revoked(nil)))
    dispatch(.pairing(.forgetting(false)))
    if same { retire(.loggedOut(.notLoggedIn), unregisterPush: true) }
    // Entering "no space": the in-memory state goes, the space directories go to the trash (`selectSpace`).
    install(.none)
    interfaceEpoch += 1
    return true
  }

  /// `POST /api/pair` in flight (``PairingFlow/isRequestInFlight``).
  private var isPairingInFlight: Bool { state.pairing.flow.isRequestInFlight }

  /// The previous key on its server: `POST /api/devices/forget` in the background, the result does not matter.
  func forgetOnServer(_ transport: any RarogTransporting) {
    Task { try? await transport.forgetDevice() }
  }
}
