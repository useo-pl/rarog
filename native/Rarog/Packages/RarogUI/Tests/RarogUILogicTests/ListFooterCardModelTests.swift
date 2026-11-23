import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The list footer card: what the card shows from the plan usage and the machine load.
// The view and its stages: `RarogUIKitTests/AccessibilityRegressionTests` (footer card tests). Owner: list.

private let utc = TimeZone(identifier: "UTC")!
private let now = ServerTime.parse("2026-11-12T08:00:00.000Z")!

private func app(usage json: String?, mac: MacLoadEvent?) -> AppState {
  var state = AppState(clientBuild: 1)
  if let json {
    state.apply(.planUsageResult(.loaded(Sample.decode(PlanUsage.self, json)), at: now), now: now)
  }
  if let mac { state.apply(.mac(mac), now: now) }
  return state
}

private func card(_ state: AppState, tailnet: String? = "example.ts.net", machine: ServerMachine = .mac)
  -> ListFooterCardModel
{
  ListFooterCardModel.make(
    usage: PlanUsageModel.make(state.planUsage, now: now, timeZone: utc),
    mac: MacLoadModel.make(state.macLoad, tailnet: tailnet, machine: machine, timeZone: utc), now: now, timeZone: utc)
}

/// The text without non-breaking spaces (the countdown keeps its number and unit together).
private func plain(_ text: String?) -> String? {
  text?.replacingOccurrences(of: "\u{00A0}", with: " ")
}

@Suite("list footer card: model")
struct ListFooterCardModelTests {
  @Test("no 5 h window, week 45 % resetting in 2 days, machine 25/50/80 → 5H —, 7D 45% za 2 d · 14.11, bars, Mac line")
  func mockupCase() throws {
    let state = app(
      usage: #"{"weekly":{"percent":45,"resetsAt":"2026-11-14T15:00:00.000Z"},"account":"kto@example.com"}"#,
      mac: .loaded(MacLoad(cpu: 25, ram: 50, disk: 80), at: now))
    let model = card(state)
    #expect(model.account == "kto@example.com" && model.machineLine == "Mac · example.ts.net")
    let fiveHour = model.limits[0]
    let weekly = model.limits[1]
    #expect(fiveHour.label == "5H" && fiveHour.percent == "—" && fiveHour.reset == "brak odczytu")
    #expect(fiveHour.tone == nil && fiveHour.fraction == 0)
    #expect(weekly.label == "7D" && weekly.percent == "45%" && plain(weekly.reset) == "za 2 d · 14.11")
    #expect(weekly.tone == .calm && weekly.fraction == 0.45)
    let machine = try #require(model.machine)
    #expect(machine.map(\.label) == ["CPU", "RAM", "DSK"] && machine.map(\.value) == ["25", "50", "80"])
    #expect(machine.map(\.fraction) == [0.25, 0.5, 0.8])
  }

  @Test("a server without the machine feature (404) has no machine columns; only the window above the threshold is amber")
  func unsupportedAndThreshold() {
    let state = app(
      usage: #"{"fiveHour":{"percent":20,"resetsAt":"2026-11-12T10:44:00.000Z"},"weekly":{"percent":70}}"#,
      mac: .unsupported(serverStartId: "s"))
    let model = card(state)
    #expect(model.machine == nil, "no columns and no divider")
    #expect(model.limits.map(\.tone) == [.calm, .warn], "the threshold color only on 7D")
    #expect(plain(model.limits[0].reset) == "za 2 h 44" && model.limits[1].reset == nil, "no reset moment: empty line")
    #expect(model.spoken == "Limity planu — okno 5 godzin: 20 procent, reset o 10:44; tydzień: 70 procent.")
  }

  @Test("skeleton: labels stand, no numbers and no reset; machine reading on its way pulses; machine word VPS")
  func skeleton() throws {
    let model = card(AppState(clientBuild: 1), tailnet: nil, machine: .vps)
    #expect(model.limits.map(\.label) == ["5H", "7D"])
    #expect(model.limits.allSatisfy { $0.percent == nil && $0.reset == nil && $0.tone == nil })
    #expect(model.limitsPulse && model.limitsGhostOpacity == 1 && model.machinePulses)
    #expect(try #require(model.machine).allSatisfy { $0.value == nil })
    #expect(model.machineLine == "VPS" && model.account == nil)
    #expect(model.spoken == "Limity planu — ładuję. VPS — odczytuję obciążenie.")
  }

  @Test("VoiceOver: one sentence for the whole card, limits then the machine with its levels, no expand state")
  func spoken() {
    let state = app(
      usage: #"{"fiveHour":{"percent":27},"weekly":{"percent":64}}"#,
      mac: .loaded(MacLoad(cpu: 35, ram: 80, disk: 95), at: now))
    #expect(card(state).spoken == "Limity planu — okno 5 godzin: 27 procent; tydzień: 64 procent. "
      + "Mac — procesor 35 procent; pamięć 80 procent, wysokie; dysk 95 procent, krytyczne.")
    var unavailable = AppState(clientBuild: 1)
    unavailable.apply(.planUsageResult(.unavailable, at: now), now: now)
    unavailable.apply(.mac(.unsupported(serverStartId: nil)), now: now)
    let gone = card(unavailable)
    #expect(gone.spoken == "Limity planu niedostępne." && gone.limitsGhostOpacity == 0.55 && !gone.limitsPulse)
  }

  @Test("reset line: minutes within a day, from a day on with the day of the reset; a passed reset is 'any moment'")
  func resetLine() {
    let line = { (seconds: TimeInterval) in
      plain(ListFooterCardModel.resetLine(now.addingTimeInterval(seconds), now: now, timeZone: utc))
    }
    #expect(line(38 * 60) == "za 38 min")
    #expect(line(23 * 3600 + 59 * 60) == "za 23 h 59")
    #expect(line(86_400) == "za 1 d · 13.11")
    #expect(line(-30) == "lada chwila")
  }
}
