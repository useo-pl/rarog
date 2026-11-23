import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Arkusz „Limity” komendy apki `/usage`: 5 h i tydzień parą z odczytu świeższego (pasek statusu
// albo odczyt Claude Code), okno per model ze szczegółów, godzina odczytu w notce — dwie, gdy się różnią — i zdanie,
// czego brakuje. Liczby z pomiaru (pasek: 5 h 10 %, tydzień 71 %; odczyt CLI sprzed 4 h: tydzień 57 %,
// Fable 34 %). Arkusz na ekranie: `RarogUIKitTests/UsageSheetUIKitTests`. Właściciel: lista.

private let utc = TimeZone(identifier: "UTC")!
private let now = ServerTime.parse("2026-10-17T23:13:00.000Z")!

private let barJSON = #"""
  {"source":"cli","fetchedAt":"2026-10-17T23:12:33.924Z",
   "fiveHour":{"percent":10,"resetsAt":"2026-10-18T03:50:00.000Z"},
   "weekly":{"percent":71,"resetsAt":"2026-10-22T15:00:00.000Z"},"account":"kto@example.com"}
  """#
private let cliJSON = #"""
  {"stale":true,"fetchedAt":"2026-10-17T19:18:26.521Z",
   "weekly":{"percent":57,"resetsAt":"2026-10-22T15:00:00.403Z"},
   "weeklyModel":{"percent":34,"resetsAt":"2026-10-22T15:00:00.403Z","model":"Fable"},"account":"kto@example.com"}
  """#

private func usage(_ json: String) -> PlanUsage {
  Sample.decode(PlanUsage.self, json)
}

private func bar(_ json: String? = barJSON, at: Date = now) -> PlanUsageState {
  var state = AppState(clientBuild: 1)
  state.apply(.planUsageResult(json.map { .loaded(usage($0)) } ?? .unavailable, at: at), now: at)
  return state.planUsage
}

private func make(_ state: PlanUsageState, _ details: UsageDetailsPhase) -> UsageSheetModel {
  UsageSheetModel.make(usage: state, details: details, now: now, machine: .mac, timeZone: utc)
}

@Suite("arkusz „Limity”: źródła, godziny i braki (UsageSheetModel)")
struct UsageSheetModelTests {
  @Test("serwer starszy niż wydany z apką: sekcja maszyny z komendą, także w trakcie ładowania; aktualny — bez sekcji")
  func serverUpdateSection() throws {
    let update = try #require(ServerUpdate(server: "0.1.0", release: "1.0.0"))
    let loaded = UsageSheetModel.make(
      usage: bar(), details: .loaded(usage(cliJSON), receivedAt: now), now: now, machine: .mac, update: update,
      timeZone: utc)
    #expect(loaded.machine == UsageSheetModel.MachineSection(
      title: "Mac", tailnet: nil, spoken: "Mac", metrics: [], notes: [],
      update: "Serwer 0.1.0 jest starszy niż apka (1.0.0). Zaktualizuj go na Macu: "
        + "npm i -g @rarog/server@latest && rarog update"))
    #expect(loaded.segments.map(\.id) == ["5h", "7d", "model"], "wiersze limitów bez zmian")
    let vps = UsageSheetModel.make(usage: bar(), details: .loading, now: now, machine: .vps, update: update, timeZone: utc)
    #expect(vps.loading && vps.machine?.title == "VPS")
    #expect(vps.machine?.update?.contains("Zaktualizuj go na VPS-ie: npm i -g @rarog/server@latest") == true)
    #expect(make(bar(), .loaded(usage(cliJSON), receivedAt: now)).machine == nil, "bez wiersza aktualizacji: bez sekcji")
  }

  @Test("machine section carries the load from the footer card: rows with details, no reading, tailnet")
  func machineLoadSection() throws {
    var state = AppState(clientBuild: 1)
    state.apply(.mac(.loaded(MacLoad(cpu: 35, ram: 80), at: now)), now: now)
    let load = MacLoadModel.make(state.macLoad, tailnet: "example.ts.net", machine: .mac, timeZone: utc)
    let model = UsageSheetModel.make(
      usage: bar(), details: .loading, now: now, machine: .mac, load: load, timeZone: utc)
    let section = try #require(model.machine, "the section stands while the details load")
    #expect(section.title == "Mac" && section.tailnet == "TS · example.ts.net")
    #expect(section.spoken == "Mac w tailnecie example.ts.net" && section.update == nil)
    #expect(section.metrics.map(\.detail) == ["średnia z minuty", "presja", "zajęte"])
    #expect(section.metrics.map { MacLoadModel.rowSpoken($0) }
      == ["Procesor, średnia z minuty: 35 procent", "Pamięć, presja: 80 procent, wysokie", "Dysk, zajęte: brak odczytu"])
    #expect(section.notes.isEmpty)
    // Loading: no rows, the sentence why; a server without the feature (404) and up to date: no section.
    let loading = MacLoadModel.make(MacLoadState(), tailnet: nil, machine: .mac)
    let waiting = try #require(UsageSheetModel.make(usage: bar(), details: .loading, now: now, machine: .mac, load: loading).machine)
    #expect(waiting.metrics.isEmpty && waiting.notes == [UICopy.macLoadingNote(.mac)] && waiting.tailnet == nil)
    var gone = AppState(clientBuild: 1)
    gone.apply(.mac(.unsupported(serverStartId: nil)), now: now)
    let unsupported = MacLoadModel.make(gone.macLoad, tailnet: nil, machine: .mac)
    #expect(UsageSheetModel.make(usage: bar(), details: .loading, now: now, machine: .mac, load: unsupported).machine == nil)
  }

  @Test("fresh limits, stale machine: the stale note only in the machine section, with the machine's own time")
  func staleMachineOnly() throws {
    var state = AppState(clientBuild: 1)
    let earlier = now.addingTimeInterval(-120)
    state.apply(.mac(.loaded(MacLoad(cpu: 35, ram: 50, disk: 60), at: earlier)), now: earlier)
    state.apply(.mac(.failed), now: now)
    let load = MacLoadModel.make(state.macLoad, tailnet: nil, machine: .mac, timeZone: utc)
    let model = UsageSheetModel.make(
      usage: bar(), details: .loaded(usage(cliJSON), receivedAt: now), now: now, machine: .mac, load: load,
      timeZone: utc)
    let stale = "Odczyt z 23:11 — nie udało się odświeżyć."
    #expect(try #require(model.machine).notes == [stale])
    #expect(try #require(model.machine).metrics.map(\.percent) == [35, 50, 60], "the numbers stay with the note")
    #expect(!model.notes.contains(stale), "the limits' notes carry no machine note")
    #expect(model.notes == ["Stan z 23:12, tydzień Fable z 19:18."])
    #expect(PlanUsageModel.make(bar(), now: now, timeZone: utc).staleNote == nil, "the limits are fresh")
  }

  @Test("failed refresh of the limits: the stale note with the time of the last reading, in the limits' notes only")
  func staleLimitsRefreshFailed() throws {
    var state = AppState(clientBuild: 1)
    let earlier = now.addingTimeInterval(-60)
    state.apply(.planUsageResult(.loaded(usage(barJSON)), at: earlier), now: earlier)
    state.apply(.planUsageResult(.failed, at: now), now: now)
    state.apply(.mac(.loaded(MacLoad(cpu: 35, ram: 50, disk: 60), at: now)), now: now)
    let load = MacLoadModel.make(state.macLoad, tailnet: nil, machine: .mac, timeZone: utc)
    let model = UsageSheetModel.make(
      usage: state.planUsage, details: .unsupported, now: now, machine: .mac, load: load, timeZone: utc)
    let stale = "Odczyt z 23:12 — nie udało się odświeżyć."
    #expect(model.notes == ["Stan z 23:12.", stale, "Serwer nie zna szczegółów limitów."])
    #expect(try #require(model.machine).notes.isEmpty, "a fresh machine section carries no note")
    #expect(make(state.planUsage, .loading).notes.isEmpty, "while the details load: the indicator only")
  }

  @Test("server's stale limits (`stale` with `fetchedAt`): the note names the source, beside a stale machine too")
  func staleLimitsFromServer() throws {
    let api = #"{"stale":true,"fetchedAt":"2026-10-17T22:40:00.000Z","fiveHour":{"percent":27},"weekly":{"percent":64}}"#
    #expect(make(bar(api), .unsupported).notes
      == ["Stan z 22:40.", "Odczyt z 22:40 — API limitów nie odpowiada.", "Serwer nie zna szczegółów limitów."])
    let cli = api.replacingOccurrences(of: #""stale":true"#, with: #""stale":true,"source":"cli""#)
    var state = AppState(clientBuild: 1)
    let earlier = now.addingTimeInterval(-120)
    state.apply(.mac(.loaded(MacLoad(cpu: 35, ram: 50, disk: 60), at: earlier)), now: earlier)
    state.apply(.mac(.failed), now: now)
    let load = MacLoadModel.make(state.macLoad, tailnet: nil, machine: .mac, timeZone: utc)
    let model = UsageSheetModel.make(
      usage: bar(cli), details: .loaded(usage(cliJSON), receivedAt: now), now: now, machine: .mac, load: load,
      timeZone: utc)
    #expect(model.notes.contains("Z paska statusu Claude Code, 22:40."))
    #expect(try #require(model.machine).notes == ["Odczyt z 23:11 — nie udało się odświeżyć."], "the machine's own")
  }

  @Test("stale status bar, fresher Claude Code reading carries the numbers: no note about numbers not shown")
  func staleBarNotShown() {
    let api = #"{"stale":true,"fetchedAt":"2026-10-17T19:00:00.000Z","weekly":{"percent":64}}"#
    let model = make(bar(api), .loaded(usage(cliJSON), receivedAt: now))
    #expect(model.segments.map(\.percent) == [57, 34], "the pair and the model window from the fresher reading")
    #expect(model.notes == ["Stan z 19:18."])
  }

  @Test("szczegóły w drodze: sam wskaźnik, bez wierszy i notek")
  func loading() {
    let model = make(bar(), .loading)
    #expect(model.loading && model.segments.isEmpty && model.notes.isEmpty && model.account == nil)
  }

  @Test("pasek świeższy: 5 h i tydzień z paska, Fable ze szczegółów, dwie godziny w jednej notce")
  func barFresher() {
    let model = make(bar(), .loaded(usage(cliJSON), receivedAt: now))
    #expect(!model.loading)
    #expect(model.segments.map(\.id) == ["5h", "7d", "model"])
    #expect(model.segments.map(\.percent) == [10, 71, 34])
    #expect(model.segments.last?.full == "Tydzień — Fable")
    #expect(model.notes == ["Stan z 23:12, tydzień Fable z 19:18."])
    #expect(model.account == "kto@example.com")
    #expect(model.resetLine(model.segments[0], now: now, timeZone: utc)
      == "reset 18.10\u{00A0}03:50 · za 4\u{00A0}h\u{00A0}37")
    #expect(model.rowSpoken(model.segments[2], now: now, timeZone: utc).hasPrefix("Tydzień — Fable: 34 procent, reset "))
  }

  @Test("odczyt Claude Code świeższy: cała trójka z niego, jedna godzina")
  func cliFresher() {
    let fresh = cliJSON.replacingOccurrences(of: "2026-10-17T19:18:26.521Z", with: "2026-10-17T23:12:50.000Z")
    let model = make(bar(), .loaded(usage(fresh), receivedAt: now))
    #expect(model.segments.map(\.id) == ["7d", "model"], "para z odczytu świeższego, choć ten nie ma okna 5 h")
    #expect(model.segments.map(\.percent) == [57, 34])
    #expect(model.notes == ["Stan z 23:12."], "ta sama minuta: jedna godzina")
  }

  @Test("remis: para zostaje przy pasku statusu (to jego liczby widzi stopka)")
  func tie() {
    let same = cliJSON.replacingOccurrences(of: "2026-10-17T19:18:26.521Z", with: "2026-10-17T23:12:33.924Z")
    let model = make(bar(), .loaded(usage(same), receivedAt: now))
    #expect(model.segments.map(\.percent) == [10, 71, 34])
  }

  @Test("szczegóły bez okien (`{}`) i bez okna per model: 5 h i tydzień z paska, zdanie o braku odczytu")
  func noModelWindow() {
    let empty = make(bar(), .loaded(usage("{}"), receivedAt: now))
    #expect(empty.segments.map(\.id) == ["5h", "7d"])
    #expect(empty.notes == ["Stan z 23:12.", UICopy.usageNoModelWindow(.mac)])
    let noScoped = make(bar(), .loaded(usage(#"{"fetchedAt":"2026-10-17T19:18:26.521Z","weekly":{"percent":57}}"#),
      receivedAt: now))
    #expect(noScoped.segments.map(\.percent) == [10, 71])
    #expect(noScoped.notes == ["Stan z 23:12.", UICopy.usageNoModelWindow(.mac)])
  }

  @Test("serwer bez trasy i błąd odczytu: 5 h i tydzień z paska i jedno zdanie dlaczego bez Fable")
  func unsupportedAndFailed() {
    #expect(make(bar(), .unsupported).notes == ["Stan z 23:12.", "Serwer nie zna szczegółów limitów."])
    #expect(make(bar(), .failed).notes == ["Stan z 23:12.", "Nie udało się odczytać szczegółów limitów."])
    #expect(make(bar(), .failed).segments.map(\.id) == ["5h", "7d"])
  }

  @Test("stary serwer z oknem per model w `/api/usage` (i demo): trójka z paska, bez zdania o braku szczegółów")
  func modelFromBar() {
    let withModel = #"{"fiveHour":{"percent":27},"weekly":{"percent":64},"weeklyModel":{"percent":91,"model":"Fable"}}"#
    let received = now.addingTimeInterval(-90)
    let model = make(bar(withModel, at: received), .unsupported)
    #expect(model.segments.map(\.percent) == [27, 64, 91])
    #expect(model.notes == ["Stan z 23:11."], "bez `fetchedAt` godzina to chwila, gdy liczby doszły do apki")
  }

  @Test("bez paska statusu (503): para i Fable ze szczegółów; bez niczego — „niedostępne” i powód")
  func onlyDetailsAndNothing() {
    let all = cliJSON.replacingOccurrences(of: #""weekly""#, with: #""fiveHour":{"percent":22},"weekly""#)
    let fromCli = make(bar(nil), .loaded(usage(all), receivedAt: now))
    #expect(fromCli.segments.map(\.percent) == [22, 57, 34])
    #expect(fromCli.notes == ["Stan z 19:18."])
    let nothing = make(bar(nil), .loaded(usage("{}"), receivedAt: now))
    #expect(nothing.segments.isEmpty)
    #expect(nothing.notes == [UICopy.usagePanelUnavailable, UICopy.usageNoModelWindow(.mac)])
    #expect(make(bar(nil), .failed).notes == [UICopy.usagePanelUnavailable, UICopy.usageDetailsFailed])
  }

  @Test("godzina innego dnia z datą; stopka listy dalej bez okna per model ze szczegółów")
  func otherDayAndFooter() {
    let older = cliJSON.replacingOccurrences(of: "2026-10-17T19:18:26.521Z", with: "2026-10-16T21:05:00.000Z")
    let model = make(bar(), .loaded(usage(older), receivedAt: now))
    #expect(model.notes == ["Stan z 23:12, tydzień Fable z 16.10\u{00A0}21:05."])
    #expect(PlanUsageModel.make(bar(), now: now, timeZone: utc).segments.map(\.id) == ["5h", "7d"])
  }

  @Test("faza szczegółów z wyniku rdzenia")
  func phase() {
    let loaded = UsageDetailsPhase(.loaded(usage("{}")), receivedAt: now)
    #expect(loaded == .loaded(usage("{}"), receivedAt: now))
    #expect(UsageDetailsPhase(.unsupported, receivedAt: now) == .unsupported)
    #expect(UsageDetailsPhase(.failed, receivedAt: now) == .failed)
  }
}
