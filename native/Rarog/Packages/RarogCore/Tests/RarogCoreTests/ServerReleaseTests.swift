import Foundation
import RarogContract
@testable import RarogCore
import Testing

// Wersja serwera wydana z apką: porównanie według semver i wiersz „Dostępna aktualizacja serwera” w stanie.
// Update command by server version: the `rarog update` threshold and the full chain with the install.
// Równość stałej z `package.json` pilnuje strażnik serwera `server/test/wersja-apki-i-serwera.test.ts`.

private func probe(_ version: String) -> VersionInfo {
  let json = #"{"version":"\#(version)","protocolVersion":3,"serverStartId":"s"}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

@Suite("wersja serwera wydana z apką: semver i wiersz aktualizacji")
struct ServerReleaseTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  @Test("serwer 0.1.0, apka 1.0.0 → wiersz")
  func olderMinor() {
    let update = ServerUpdate(server: "0.1.0", release: "1.0.0")
    #expect(update?.server == "0.1.0" && update?.release == "1.0.0")
  }

  @Test("wydanie próbne jest mniejsze od wydania: 1.0.0-rc.1 i 1.0.0 → wiersz")
  func prereleaseIsOlder() {
    #expect(ServerUpdate(server: "1.0.0-rc.1", release: "1.0.0") != nil)
    #expect(ServerUpdate(server: "1.0.0-alpha", release: "1.0.0-alpha.1") != nil, "krótszy zbiór pól jest mniejszy")
    #expect(ServerUpdate(server: "1.0.0-rc.2", release: "1.0.0-rc.10") != nil, "pola liczbowe liczbowo")
    #expect(ServerUpdate(server: "1.0.0-9", release: "1.0.0-alpha") != nil, "liczba przed polem z literami")
    #expect(ServerUpdate(server: "1.0.0-rc.10", release: "1.0.0-rc.2") == nil)
  }

  @Test("ta sama albo nowsza wersja → nic: 1.0.0 i 1.0.0, 1.0.1 i 1.0.0")
  func sameOrNewer() {
    #expect(ServerUpdate(server: "1.0.0", release: "1.0.0") == nil)
    #expect(ServerUpdate(server: "1.0.1", release: "1.0.0") == nil)
    #expect(ServerUpdate(server: "1.0.0", release: "1.0.0-rc.1") == nil)
    #expect(ServerUpdate(server: "1.10.0", release: "1.9.0") == nil, "pole liczbowe, nie napis")
  }

  @Test("`1.0.0+abc` czyta się jako 1.0.0")
  func buildMetadataIgnored() {
    #expect(ServerUpdate(server: "1.0.0+abc", release: "1.0.0") == nil)
    #expect(ServerUpdate(server: "0.9.0+abc", release: "1.0.0") != nil)
    #expect(ServerUpdate(server: "1.0.0-rc.1+abc", release: "1.0.0") != nil)
  }

  @Test("brak pola albo wartość nieczytelna → nic", arguments: [
    nil, "", "1", "1.0", "1.0.0.0", "v0.1.0", "0.1.x", "0.1.0-", "0.1.0-rc..1", "0.1.0-rc_1", " 0.1.0", "-1.0.0",
    "99999999999999999999.0.0",
  ])
  func unreadable(_ server: String?) {
    #expect(ServerUpdate(server: server, release: "1.0.0") == nil)
  }

  @Test("zero wiodące w polu liczbowym rdzenia albo wydania próbnego → nic (semver 2.0.0)", arguments: [
    "00.0.1", "0.01.0", "0.0.01", "0.1.0-01", "0.1.0-rc.01", "0.1.0-00",
  ])
  func leadingZeroUnreadable(_ server: String) {
    #expect(ServerUpdate(server: server, release: "1.0.0") == nil)
    #expect(ServerUpdate(server: "0.0.0-0", release: server) == nil, "\(server) jako wersja wydania")
  }

  @Test("samo zero, pole z literami i dopisek po `+` z zerem wiodącym czytają się")
  func zeroFieldsReadable() {
    #expect(ServerUpdate(server: "0.0.0", release: "1.0.0") != nil)
    #expect(ServerUpdate(server: "0.1.0-0", release: "0.1.0") != nil, "samo 0 w wydaniu próbnym")
    #expect(ServerUpdate(server: "0.1.0-0a", release: "0.1.0") != nil, "pole z literami może zaczynać się od 0")
    #expect(ServerUpdate(server: "0.1.0-rc.0", release: "0.1.0-rc.1") != nil)
    #expect(ServerUpdate(server: "0.9.0+001", release: "1.0.0") != nil, "dopisek po `+` pominięty")
  }

  @Test("stała wydania czyta się według semver")
  func releaseConstantParses() {
    #expect(ServerUpdate(server: "0.0.0-0", release: ServerRelease.version) != nil)
  }

  @Test("update command: server below the 0.1.1 threshold → chain with npm", arguments: [
    "0.1.0", "0.0.9", "0.1.0-rc.1", "0.1.0-local.202611131200.abc1234", "0.1.0+abc",
  ])
  func commandBelowThreshold(_ server: String) {
    #expect(ServerRelease.updateCommand(server: server) == "npm i -g @rarog/server@latest && rarog update")
  }

  @Test("update command: server from 0.1.1, also the local build 0.1.1-local.… → rarog update", arguments: [
    "0.1.1", "0.1.1-local.202611131200.abc1234", "0.1.2", "0.2.0", "1.0.0", "0.1.1+abc",
  ])
  func commandFromThreshold(_ server: String) {
    #expect(ServerRelease.updateCommand(server: server) == "rarog update")
  }

  @Test("update command: unreadable or missing version → no hint", arguments: [
    nil, "", "0.1", "v0.1.1", "0.1.x", "0.1.1-",
  ])
  func commandUnreadable(_ server: String?) {
    #expect(ServerRelease.updateCommand(server: server) == nil)
  }

  @Test("update command threshold and full chain: constants")
  func thresholdConstants() {
    #expect(ServerRelease.updateCommandSince == "0.1.1")
    #expect(SemanticVersion(ServerRelease.updateCommandSince) != nil)
    #expect(ServerRelease.installAndUpdateCommand == "npm i -g @rarog/server@latest && rarog update")
  }

  @Test("the update row carries the command for the server version")
  func updateCarriesCommand() {
    #expect(ServerUpdate(server: "0.1.0", release: "1.0.0")?.command == "npm i -g @rarog/server@latest && rarog update")
    #expect(ServerUpdate(server: "0.1.1", release: "1.0.0")?.command == "rarog update")
    #expect(ServerUpdate(server: "0.9.0-local.1.abc", release: "1.0.0")?.command == "rarog update")
  }

  @Test("sonda wersji daje wiersz; nowsza sonda (serwer zaktualizowany) go zdejmuje; offline wartość zostaje")
  func stateFromProbe() {
    var state = AppState(clientBuild: 1)
    #expect(state.serverVersion == nil && state.serverUpdate == nil, "przed sondą nic")
    state.apply(.versionProbed(probe("0.0.1")), now: t0)
    #expect(state.serverVersion == "0.0.1")
    #expect(state.serverUpdate == ServerUpdate(server: "0.0.1", release: ServerRelease.version))
    state.apply(.streamDropped(.global), now: t0)
    #expect(state.serverUpdate != nil, "przerwa łącza nie zdejmuje wiersza")
    state.apply(.versionProbed(probe(ServerRelease.version)), now: t0)
    #expect(state.serverUpdate == nil, "serwer zaktualizowany: następna sonda zdejmuje wiersz")
  }

  @Test("wylogowanie, logowanie i zmiana serwera kasują wersję od razu")
  func resetClearsVersion() {
    for reset in [CoreEvent.loggedOut(.deviceUnknown), .loggedIn, .switchingServer] {
      var state = AppState(clientBuild: 1)
      state.apply(.versionProbed(probe("0.0.1")), now: t0)
      state.apply(reset, now: t0)
      #expect(state.serverVersion == nil && state.serverUpdate == nil, "\(reset)")
    }
  }
}
