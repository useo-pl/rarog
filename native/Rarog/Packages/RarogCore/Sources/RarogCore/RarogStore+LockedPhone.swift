import Foundation
import RarogTransport

// The store's part of the locked-phone monitor (`LockedPhoneMonitor` in RarogUI): its question whether the server
// answers, for the heartbeat line in `client.log`. Owner: voice agent.

extension RarogStore {
  /// Whether the server answers now: one `GET /api/version` through the current login's transport. It changes no
  /// state: the answer is not the version probe's (`probeVersion`), a failure, a 401 included, is only `false`, and
  /// an answer that comes after the login changed is `false` too. Signed out: `false` without a request.
  public func serverAnswers() async -> Bool {
    guard state.auth == .loggedIn else { return false }
    let login = currentLogin
    let transport = areaTransport
    let answered: Bool
    do throws(TransportError) {
      _ = try await transport.version()
      answered = true
    } catch {
      answered = false
    }
    return answered && isCurrentLogin(login)
  }
}
