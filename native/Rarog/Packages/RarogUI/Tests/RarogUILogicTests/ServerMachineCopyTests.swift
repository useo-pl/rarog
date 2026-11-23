import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Słowo maszyny serwera w zdaniach apki: stan (`AppState.serverMachine` z sondy wersji) → modele i rejestr copy.
// „Mac” tylko na macOS i bez znanego systemu; Linux, inny system i system spoza listy apki mówią „VPS”.
@Suite("słowo maszyny serwera w zdaniach apki: Mac albo VPS")
struct ServerMachineCopyTests {
  /// Stan po sondzie `GET /api/version` z danym polem `system` (`nil` = serwer bez pola).
  static func machine(after system: String?) -> ServerMachine {
    var state = Sample.state(session: Sample.session())
    let field = system.map { #","system":"\#($0)""# } ?? ""
    state.apply(.versionProbed(Sample.decode(
      VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(field)}"#)), now: Sample.now)
    return state.serverMachine
  }

  @Test("sonda wersji: macos i brak pola = Mac; linux, other i system spoza listy = VPS")
  func fromProbe() {
    #expect(Self.machine(after: "macos") == .mac)
    #expect(Self.machine(after: nil) == .mac)
    #expect(Self.machine(after: "linux") == .vps)
    #expect(Self.machine(after: "other") == .vps)
    #expect(Self.machine(after: "freebsd") == .vps, "system nowszego serwera (`unsupported`)")
  }

  @Test("footer card and machine section: VoiceOver sentence, sheet note and section heading use the machine word")
  func macLoad() {
    let at = Sample.now
    var app = AppState(clientBuild: 1)
    app.apply(.mac(.loaded(MacLoad(cpu: 35), at: at)), now: at)
    let mac = MacLoadModel.make(app.macLoad, tailnet: "example.ts.net", machine: .mac)
    let vps = MacLoadModel.make(app.macLoad, tailnet: "example.ts.net", machine: .vps)
    #expect(mac.lineSpoken?.hasPrefix("Mac — procesor 35 procent") == true)
    #expect(vps.lineSpoken?.hasPrefix("VPS — procesor 35 procent") == true)
    #expect(MacLoadModel.make(MacLoadState(), tailnet: nil, machine: .vps).panelNote == "Obciążenie VPS-a — odczytuję…")
    #expect(UICopy.macSectionTitle(.vps) == "VPS" && UICopy.macSectionTitle(.mac) == "Mac")
    #expect(UICopy.macTailnetSpoken("example.ts.net", .vps) == "VPS w tailnecie example.ts.net")
    let usage = PlanUsageModel.make(app.planUsage, now: at)
    let card = ListFooterCardModel.make(usage: usage, mac: vps, now: at)
    #expect(card.machineLine == "VPS · example.ts.net" && card.spoken.contains("VPS — procesor 35 procent"))
    #expect(ListFooterCardModel.make(usage: usage, mac: mac, now: at).machineLine == "Mac · example.ts.net")
  }

  @Test("zdania o pracy na maszynie: przerwanie, notatka bez kontaktu, zamknięcie terminala")
  func sessionSentences() {
    let failed = InterruptPresentation.make(.notDelivered, prompt: "x", fieldEmpty: true, machine: .vps)
    #expect(failed?.line == "Nie udało się przerwać — panel nie przyjął Esc. Otwórz go w herdr na VPS-ie i naciśnij Esc tam.")
    #expect(failed?.spoken == failed?.line)
    #expect(UICopy.noteOffline(.vps) == "bez kontaktu z VPS-em — tekst czeka w apce")
    #expect(UICopy.terminalCloseConfirmSpoken(.vps) == "Zamknij terminal — naciśnij jeszcze raz, powłoka na VPS-ie się zakończy")
    #expect(UICopy.usageNoModelWindow(.vps) == "Bez limitu per model — Claude Code na VPS-ie nie zostawił jego odczytu.")
  }

  @Test("aktualizacja serwera: zdanie z komendą mówi słowem maszyny w odmianie, wiersz stopki bez maszyny")
  func serverUpdate() throws {
    let update = try #require(ServerUpdate(server: "0.1.0", release: "1.0.0"))
    #expect(UICopy.serverUpdateDetail(update, .mac)
      == "Serwer 0.1.0 jest starszy niż apka (1.0.0). Zaktualizuj go na Macu: "
      + "npm i -g @rarog/server@latest && rarog update")
    #expect(UICopy.serverUpdateDetail(update, .vps)
      == "Serwer 0.1.0 jest starszy niż apka (1.0.0). Zaktualizuj go na VPS-ie: "
      + "npm i -g @rarog/server@latest && rarog update")
    let fromThreshold = try #require(ServerUpdate(server: "0.1.1", release: "1.0.0"))
    #expect(UICopy.serverUpdateDetail(fromThreshold, .mac)
      == "Serwer 0.1.1 jest starszy niż apka (1.0.0). Zaktualizuj go na Macu: rarog update", "from the K14 threshold just rarog update")
    #expect(L("usage.serverUpdate.detail", language: .en, "0.1.1", "1.0.0", fromThreshold.command)
      == "Server 0.1.1 is older than this app (1.0.0). Update it on the Mac: rarog update")
    #expect(UICopy.serverUpdate == "Dostępna aktualizacja serwera")
  }

  @Test("parowanie: odpięcie z CLI, kod z maszyny, notka o nowym urządzeniu i pole nazwy serwera")
  func pairing() {
    let revocation = DeviceRevocation(deviceId: "x", server: "", revokedAt: "wczoraj", revokedBy: "admin")
    #expect(UICopy.revokedBody(revocation, .vps) == "Serwer odpiął to urządzenie (na VPS-ie: rarog devices). Sparuj je ponownie.")
    #expect(UICopy.revokedBy("forget", .vps) == "„Zapomnij serwer” w apce", "przyczyna bez maszyny bez wariantu")
    #expect(UICopy.deviceCreator("admin", labels: [:], .vps) == "kod z VPS-a")
    #expect(UICopy.deviceCreator("admin", labels: [:], .mac) == "kod z Maca")
    let notice = NewDeviceNotice(id: "d2", label: "iPad·Rarog", createdAt: "garbage", creator: "admin", creatorIsAdmin: true)
    #expect(UICopy.newDeviceNotice(notice, .vps)
      == "Nowe urządzenie: iPad·Rarog, kod z VPS-a. Jeśli to nie Ty, odepnij je na VPS-ie: rarog devices.")
    #expect(UICopy.serverName(.vps) == "VPS")
  }
}
