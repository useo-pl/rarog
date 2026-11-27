import Foundation
import RarogContract

// Parowanie i klucz urządzenia w stanie widoku. Gałąź reduktora wołana z głównego `switch`
// w `Reducer.swift`; akcje, Keychain i czas w `RarogStore+Pairing`. Stan obszaru: `PairingState` (`Pairing.swift`).

extension AppState {
  mutating func applyPairing(_ event: PairingEvent) -> [CoreEffect] {
    switch event {
    case let .bound(binding):
      pairing.binding = binding
      // Inne poświadczenie (albo żadne): system z jego zapisu, do pierwszej sondy wersji.
      serverSystem = pairing.paired?.serverSystem
      // Kod i lista urządzeń należą do poprzedniego poświadczenia.
      pairing.issue = .idle
      pairing.devices = nil
    case let .routesUpdated(server):
      // Ten sam klucz: kod parowania, lista urządzeń i system zostają, zmienia się widoczny serwer.
      if pairing.paired?.deviceId == server.deviceId { pairing.binding = .device(server) }
    case let .offered(link):
      // A sheet with a request in flight (also while waiting for the relay) keeps its link under the finger — a link
      // offered meanwhile is dropped.
      if pairing.flow.isRequestInFlight { break }
      pairing.flow = .confirming(link)
    case let .linkRejected(error):
      if pairing.flow.isRequestInFlight { break }
      pairing.flow = .rejected(error)
    case .cancelled:
      // `.waitingForRelay` cancels (the store drops the request in flight and ends its repeats); `.pairing` does not.
      if case .pairing = pairing.flow { break }
      pairing.flow = .idle
    case let .started(link):
      pairing.flow = .pairing(link)
    case let .waitingForRelay(link, until):
      pairing.flow = .waitingForRelay(link, until: until)
    case let .failed(link, failure):
      pairing.flow = .failed(link, failure)
    case .paired:
      pairing.flow = .idle
      pairing.revoked = nil
    case let .revoked(revocation):
      pairing.revoked = revocation
    case .issuing:
      pairing.issue = .issuing
    case let .issued(code):
      pairing.issue = .issued(code)
    case let .issueFailed(failure):
      pairing.issue = .failed(failure)
    case .issueCleared:
      pairing.issue = .idle
    case let .devices(list):
      pairing.devices = list
    case let .newDevices(notices):
      pairing.newDevices = notices
    case let .forgetting(value):
      pairing.forgetting = value
      if value { pairing.forgetFailed = false }
    case .forgetFailed:
      pairing.forgetFailed = true
    case .dataWiped:
      // Stan w pamięci poprzedniej przestrzeni danych: kolejka wysyłki, cele tapnięć, urządzenia. Pliki zostają
      // w jej katalogu, którego nikt już nie czyta (`ServerSpaces`), więc skutków dyskowych nie ma.
      outbox = []
      echoed = [:]
      echoedPrompts = [:]
      unconfirmedOpenings = [:]
      sendProgress = [:]
      queuedIdleSince = [:]
      // The Check guard follows the outbox: its entries are gone with it.
      waitChecks = WaitCheckState()
      push.pendingTarget = nil
      push.pendingLink = nil
      pairing.newDevices = []
      pairing.devices = nil
    case let .settingsScreen(requested):
      pairing.settingsScreenRequested = requested
    case let .relayAccess(status):
      relayAccess = status
    }
    return []
  }
}
