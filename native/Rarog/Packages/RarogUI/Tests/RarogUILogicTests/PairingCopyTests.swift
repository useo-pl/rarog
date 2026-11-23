import Foundation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import Testing

// Copy i nawigacja parowania: zdania odmów parowania i linku, ekran odpięcia z datą i przyczyną,
// wiersz urządzenia z twórcą kodu, notka „Nowe urządzenie”, odliczanie kodu, „Ustawienia” jako formularz i wiersz
// języka apki.
// The pairing sheet against the paired server: the fingerprint of the link's server key, and the
// warning with "Cancel" as the default and "Replace" for a link to another server (the store's `replacedServer`).

@Suite("parowanie: copy i „Ustawienia”")
struct PairingCopyTests {
  static let utc = TimeZone(identifier: "UTC")!

  @Test("odpięte: serwer, data i godzina w strefie urządzenia, przyczyna po ludzku")
  func revoked() {
    let revocation = DeviceRevocation(
      deviceId: "03030303030303030303030303030303", server: "rarog.example", revokedAt: "2026-10-04T10:03:00.000Z",
      revokedBy: "admin")
    #expect(UICopy.revokedBody(revocation, .mac, timeZone: Self.utc)
      == "Serwer rarog.example odpiął to urządzenie 4 paź o 10:03 (na Macu: rarog devices). Sparuj je ponownie.")
    #expect(UICopy.revokedBy("forget", .mac) == "„Zapomnij serwer” w apce")
    #expect(UICopy.revokedBy("expired", .mac) == "30 dni bez użycia")
    #expect(UICopy.revokedBy("08080808080808080808080808080808", .mac) == "z innego urządzenia")
    let unknownDate = DeviceRevocation(deviceId: "x", server: "", revokedAt: "wczoraj", revokedBy: "admin")
    #expect(UICopy.revokedBody(unknownDate, .mac) == "Serwer odpiął to urządzenie (na Macu: rarog devices). Sparuj je ponownie.")
  }

  @Test("odmowy parowania: zły kod, serwer sprzed parowania, sieć, Keychain, 403 ze zdaniem serwera")
  func failures() {
    #expect(UICopy.pairFailure(.codeRejected).contains("wygeneruj nowy"))
    #expect(UICopy.pairFailure(.serverTooOld) == "Serwer nie umie parowania — zaktualizuj serwer Raroga.")
    #expect(UICopy.pairFailure(.offline).contains("połączenie z siecią"))
    #expect(UICopy.pairFailure(.keychain(-25_308)).contains("-25308"))
    #expect(UICopy.pairFailure(.forbidden("Żądanie z niedozwolonego origin."))
      == "Serwer odrzucił parowanie: Żądanie z niedozwolonego origin.")
    #expect(UICopy.pairFailure(.rateLimited(retryAfter: 42)) == "Za dużo nieudanych prób — spróbuj za 42\u{00A0}s.")
    #expect(UICopy.pairFailure(.failed(nil)) == "Parowanie się nie udało. Spróbuj ponownie.")
    #expect(UICopy.pairLinkError(.badCode).contains("ucięty"))
    #expect(UICopy.pairLinkError(.notALink).contains("https://rarog.ai/pair"))
  }

  @Test("lista urządzeń: data parowania, twórca kodu (Mac albo etykieta), ostatnie użycie albo „jeszcze bez”")
  func deviceRows() throws {
    let list = try JSONDecoder().decode(DeviceList.self, from: Data(#"""
      {"devices":[
        {"id":"03030303030303030303030303030303","label":"iPhone·Rarog","createdAt":"2026-10-04T10:00:00.000Z",
         "lastSeenAt":"2026-10-04T10:02:00.000Z","creator":"admin","build":"1700","current":true},
        {"id":"08080808080808080808080808080808","label":"iPad·Rarog","createdAt":"2026-10-04T10:01:00.000Z",
         "lastSeenAt":null,"creator":"03030303030303030303030303030303","build":"1700","current":false}]}
      """#.utf8))
    let labels = Dictionary(uniqueKeysWithValues: list.devices.map { ($0.id, $0.label) })
    #expect(UICopy.deviceDetail(list.devices[0], labels: labels, .mac, timeZone: Self.utc)
      == "sparowane 4 paź · kod z Maca · ostatnio 4 paź 10:02")
    #expect(UICopy.deviceDetail(list.devices[1], labels: labels, .mac, timeZone: Self.utc)
      == "sparowane 4 paź · kod z iPhone·Rarog · jeszcze bez połączenia")
    #expect(UICopy.deviceCreator("0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", labels: [:], .mac) == "kod z 0a0a0a0a")
  }

  @Test("notka o nowym urządzeniu: etykieta, data, twórca i co zrobić, gdy to nie Ty")
  func notice() {
    let notice = NewDeviceNotice(
      id: "08080808080808080808080808080808", label: "iPad·Rarog", createdAt: "2026-10-04T10:01:00.000Z",
      creator: "iPhone·Rarog", creatorIsAdmin: false)
    #expect(UICopy.newDeviceNotice(notice, .mac, timeZone: Self.utc)
      == "Nowe urządzenie: iPad·Rarog, 4 paź 10:01, kod z iPhone·Rarog. Jeśli to nie Ty, odepnij je na Macu: rarog devices.")
  }

  @Test("odliczanie kodu: minuty i sekundy w górę, zero po terminie")
  func remaining() {
    #expect(UICopy.pairCodeRemaining(299.2) == "Ważny jeszcze 5:00")
    #expect(UICopy.pairCodeRemaining(61) == "Ważny jeszcze 1:01")
    #expect(UICopy.pairCodeRemaining(-3) == "Ważny jeszcze 0:00")
  }

  @MainActor
  @Test("„Ustawienia” to formularz: link przy otwartych ustawieniach nie buduje ich od nowa, okno nie wchodzi")
  func settingsSheet() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openSettings()
    let first = navigation.settingsSheet
    #expect(first != nil && navigation.sheet?.isForm == true)
    navigation.openSettings()
    #expect(navigation.settingsSheet == first, "druga prośba nie zastępuje stojących ustawień")
    navigation.openDiff(sessionId: "s1", path: nil)
    #expect(navigation.settingsSheet == first, "okno nie wchodzi w miejsce formularza")
  }

  @MainActor
  @Test("Settings request from the core: waits for login, opens its page, also over an active pairing card")
  func settingsScreenRequest() throws {
    var pairing = PairingState()
    pairing.flow = .confirming(try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)"))
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(pairing.settingsRoute(loggedIn: true).card != nil)
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: nil) == nil)
    let shown = pairing.settingsRoute(loggedIn: true)
    pairing.settingsScreenRequested = .pairing
    #expect(pairing.settingsRoute(loggedIn: false) == SettingsRoute(), "logged out: both wait")
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: shown) == .pairing,
            "handled over the card that already stood, so the caller consumes it")
    #expect(navigation.settingsSheet != nil && navigation.settingsPage == .pairing)
    let requested = pairing.settingsRoute(loggedIn: true)
    pairing.settingsScreenRequested = nil
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: requested) == nil)
    #expect(navigation.settingsPage == .pairing, "consumed: nothing more")
    #expect(SettingsPage(.server) == .server, "the core's Server screen is the Server page")
  }

  @MainActor
  @Test("pairing link: Settings on the list, where the card stands; an open page goes back to the list")
  func pairingCardOpensList() throws {
    var pairing = PairingState()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: nil) == nil)
    #expect(navigation.sheet == nil, "no card: nothing")
    let linkA = try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)")
    pairing.flow = .confirming(linkA)
    _ = navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: false), previous: nil)
    #expect(navigation.sheet == nil, "logged out: the start screen draws the card")
    _ = navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: SettingsRoute())
    #expect(navigation.settingsSheet != nil && navigation.settingsPage == nil)
    navigation.openSettings(page: .server)
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: nil) == nil)
    #expect(navigation.settingsPage == nil, "a card shown again pops the page")
  }

  @MainActor
  @Test("the same link moving on keeps the page; a new link over a page opened by a push goes back to the list")
  func newLinkOverPage() throws {
    var pairing = PairingState()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let linkA = try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)")
    pairing.flow = .confirming(linkA)
    _ = navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: nil)
    navigation.openSettings(page: .pairing)
    var previous = pairing.settingsRoute(loggedIn: true)
    pairing.flow = .pairing(linkA)
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: previous) == nil)
    #expect(navigation.settingsPage == .pairing, "confirming to the request with the same link: not a new card")
    previous = pairing.settingsRoute(loggedIn: true)
    pairing.flow = .confirming(try Self.link("k=\(Self.pairedKey)&r=\(Self.relayField)"))
    _ = navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: previous)
    #expect(navigation.settingsPage == nil, "a new link shows its card on the list")
  }

  @MainActor
  @Test("a push request and a link both waiting for login: the card wins and the request is consumed")
  func cardAndRequestTogether() throws {
    var pairing = PairingState()
    pairing.flow = .confirming(try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)"))
    pairing.settingsScreenRequested = .pairing
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let before = pairing.settingsRoute(loggedIn: false)
    #expect(navigation.followSettingsRoute(pairing.settingsRoute(loggedIn: true), previous: before) == .pairing)
    #expect(navigation.settingsSheet != nil && navigation.settingsPage == nil)
  }

  @Test("akapit parowania: „rarog pair” pismem kodu w pl i en, tekst znak w znak, inne słowa bez kodu")
  func leadCommandAsCode() {
    for language in [CopyLanguage.pl, .en] {
      let text = L("pairing.lead", language: language)
      let styled = UICopy.pairCommandCode(text)
      #expect(String(styled.characters) == text, "\(language): tekst bez zmian")
      let code = styled.runs.filter { $0.inlinePresentationIntent == .code }.map { String(styled[$0.range].characters) }
      #expect(code == ["rarog pair"], "\(language): zakres kodu \(code)")
      let offset = text.range(of: "rarog pair").map { text.distance(from: text.startIndex, to: $0.lowerBound) }
      #expect(offset != nil, "\(language): komenda w akapicie")
      let codeRun = styled.runs.first { $0.inlinePresentationIntent == .code }
      #expect(codeRun.map { styled.characters.distance(from: styled.startIndex, to: $0.range.lowerBound) } == offset,
              "\(language): kod zaczyna się na „rarog pair”")
    }
    #expect(UICopy.pairCommandCode("Sparuj ponownie.").runs.allSatisfy { $0.inlinePresentationIntent == nil },
            "zdanie bez komendy bez kodu")
  }

  @Test("ścieżka w akapicie parowania = tytuł Ustawień → nagłówek sekcji → przycisk, w pl i en")
  func leadPathMatchesSettings() {
    #expect(UICopy.pairIssueSection == "Parowanie")
    #expect(L("pairing.issueSection", language: .en) == "Pairing")
    for language in [CopyLanguage.pl, .en] {
      let path = [L("pairing.settingsTitle", language: language), L("pairing.issueSection", language: language),
                  L("pairing.newDevice", language: language)].joined(separator: " → ")
      #expect(L("pairing.lead", language: language).contains(path), "\(language): \(path)")
      #expect(L("pairing.issueSection", language: language) != L("pairing.newDevice", language: language),
              "\(language): nagłówek sekcji inny niż przycisk")
    }
    #expect(UICopy.pairLead.contains("Ustawienia → Parowanie → Sparuj nowe urządzenie"))
  }

  @Test("wiersz języka apki: język nazwany w nim samym, etykieta i podpowiedź w tym samym języku")
  func languageRow() {
    let polish = AppLanguageRow(language: .pl)
    #expect(polish.label == "Język")
    #expect(polish.value == "Polski")
    #expect(polish.hint == "Otwiera ustawienia Raroga — tam zmienisz język apki.")
    let english = AppLanguageRow(language: .en)
    #expect(english.label == "Language")
    #expect(english.value == "English")
    #expect(english.hint == "Opens Rarog settings, where you can change the language.")
    #expect(AppLanguageRow() == polish, "domyślnie język procesu (testy: pl)")
  }

  // MARK: The sheet against the paired server

  static let pairedKey = "1a2b3c4d" + String(repeating: "5e6f7a8b", count: 7)
  static let otherKey = "9f8e7d6c" + String(repeating: "0a1b2c3d", count: 7)
  static let relayField = "https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"
  static let code = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"

  static func link(_ fragment: String) throws -> PairingLink {
    try PairingLink.parse("rarog://pair#v=1&\(fragment)&c=\(code)").get()
  }

  /// The pairing state of a device paired over iroh with `pairedKey`, the sheet showing `flow`.
  static func pairedState(_ flow: PairingFlow) throws -> PairingState {
    let iroh = try #require(try link("k=\(pairedKey)&r=\(relayField)").iroh)
    var state = PairingState()
    state.binding = .device(PairedServer(DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "secret", serverURL: nil, serverId: "server-1",
      serverName: "mac-studio", label: "iPhone·Rarog", kid: "kid-1", pairedAt: Date(timeIntervalSince1970: 0),
      iroh: iroh)))
    state.flow = flow
    return state
  }

  @Test("fingerprint: a link with `k` shows the first 16 characters of the server key in groups of 4, without `k` none")
  func fingerprint() throws {
    let irohOnly = try Self.link("k=\(Self.pairedKey)&r=\(Self.relayField)")
    #expect(UICopy.pairFingerprint(irohOnly) == "Odcisk klucza serwera: 1a2b 3c4d 5e6f 7a8b")
    let both = try Self.link("u=https%3A%2F%2Frarog.example.ts.net&k=\(Self.otherKey)&r=\(Self.relayField)")
    #expect(UICopy.pairFingerprint(both) == "Odcisk klucza serwera: 9f8e 7d6c 0a1b 2c3d")
    #expect(UICopy.pairFingerprint(try Self.link("u=https%3A%2F%2Frarog.example.ts.net")) == nil,
            "no key in the link, nothing to fingerprint")
  }

  @Test("another server: the warning names the paired server, “Cancel” comes first as the default, then “Replace”")
  func replaceWarning() throws {
    let other = try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)")
    let state = try Self.pairedState(.confirming(other))
    #expect(state.replacedServer != nil, "the store's rule sees another server")
    let warning = try #require(PairingReplaceWarning(state))
    #expect(warning.text
      == "To inny serwer niż obecny. Parowanie zastąpi obecne: to urządzenie przestanie być sparowane z mac-studio.")
    #expect(warning.controls == [.cancel, .replace])
    #expect(warning.defaultControl == .cancel)
    #expect(UICopy.pairReplace == "Zastąp")
    #expect(UICopy.pairFingerprint(other) == "Odcisk klucza serwera: 9f8e 7d6c 0a1b 2c3d")
    #expect(PairingReplaceWarning(try Self.pairedState(.pairing(other))) == nil,
            "after “Replace” the request is on its way: no second warning")
  }

  @Test("the same server or the first pairing: no warning, the fingerprint still shows")
  func noWarning() throws {
    let same = try Self.link("k=\(Self.pairedKey)&r=\(Self.relayField)")
    #expect(PairingReplaceWarning(try Self.pairedState(.confirming(same))) == nil)
    var first = PairingState()
    first.flow = .confirming(try Self.link("k=\(Self.otherKey)&r=\(Self.relayField)"))
    #expect(PairingReplaceWarning(first) == nil)
    #expect(UICopy.pairFingerprint(same) == "Odcisk klucza serwera: 1a2b 3c4d 5e6f 7a8b")
  }
}
