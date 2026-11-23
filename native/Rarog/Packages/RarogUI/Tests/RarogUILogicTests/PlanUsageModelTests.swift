import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Plan usage of the list footer card: segments, the card's two fields, thresholds, the
// reset and the ticks of its countdown, the stale note and VoiceOver sentences. Owner: list.

private let utc = TimeZone(identifier: "UTC")!
private let now = ServerTime.parse("2026-10-04T10:36:00.000Z")!

private let freshJSON = #"""
  {"fiveHour":{"percent":27,"resetsAt":"2026-10-04T13:20:00+00:00"},
   "weekly":{"percent":60.4,"resetsAt":"2026-10-09T15:00:00+00:00"},
   "weeklyModel":{"percent":91,"resetsAt":"2026-10-09T15:00:00+00:00","model":"Fable"},
   "account":" demo@example.com "}
  """#

private func usageState(_ outcomes: [PlanUsageOutcome]) -> PlanUsageState {
  var state = AppState(clientBuild: 1)
  for outcome in outcomes { state.apply(.planUsageResult(outcome, at: now), now: now) }
  return state.planUsage
}

private func usage(_ json: String) -> PlanUsage {
  Sample.decode(PlanUsage.self, json)
}

@Suite("limity planu: model stopki")
struct PlanUsageModelTests {
  @Test("świeże liczby: trzy okna w kolejności, etykieta modelu ścięta do 3 znaków, konto przycięte")
  func fresh() {
    let model = PlanUsageModel.make(usageState([.loaded(usage(freshJSON))]), now: now, timeZone: utc)
    #expect(model.phase == .ready && model.staleNote == nil)
    #expect(model.segments.map(\.short) == ["5h", "7d", "Fab"])
    #expect(model.segments.map(\.full) == ["Okno 5-godzinne", "Tydzień", "Tydzień — Fable"])
    #expect(model.segments.map(\.percent) == [27, 60, 91])
    #expect(model.segments.map(\.tone) == [.calm, .warn, .hot])
    #expect(model.account == "demo@example.com")
    #expect(model.tone == .hot)
  }

  @Test("progi: do 60 % spokojnie, 60–85 % uwaga, powyżej gorąco; procent zaokrąglony i przycięty")
  func thresholds() {
    #expect([59, 60, 85, 86].map(UsageTone.init(percent:)) == [.calm, .warn, .warn, .hot])
    let odd = usage(#"{"fiveHour":{"percent":101.4},"weekly":{"percent":-3},"weeklyModel":{"percent":27.5}}"#)
    let model = PlanUsageModel.make(usageState([.loaded(odd)]), now: now, timeZone: utc)
    #expect(model.segments.map(\.percent) == [100, 0, 28])
    #expect(model.segments.last?.short == "model" && model.segments.last?.full == "Tydzień — model")
  }

  @Test("procent spoza zakresu `Int` (1e20 przechodzi `z.number()`): przycięty przed konwersją, apka stoi")
  func hugePercent() {
    // NaN i nieskończoności nie przejdą: `JSONDecoder` odrzuca 1e400 i `NaN` jako niepoprawny JSON.
    let huge = usage(#"{"fiveHour":{"percent":1e20},"weekly":{"percent":-1e20}}"#)
    let model = PlanUsageModel.make(usageState([.loaded(huge)]), now: now, timeZone: utc)
    #expect(model.segments.map(\.percent) == [100, 0])
    #expect(model.segments.map(\.tone) == [.hot, .calm])
  }

  @Test("reset: godzina i dystans; innego dnia z datą; miniony = „lada chwila”")
  func reset() throws {
    let model = PlanUsageModel.make(usageState([.loaded(usage(freshJSON))]), now: now, timeZone: utc)
    #expect(model.resetLine(model.segments[0], now: now, timeZone: utc) == "reset 13:20 · za 2\u{00A0}h\u{00A0}44")
    #expect(model.resetLine(model.segments[1], now: now, timeZone: utc) == "reset 09.10\u{00A0}15:00 · za 5\u{00A0}d")
    #expect(UICopy.usageCountdown(seconds: -30) == "lada chwila")
    #expect(UICopy.usageCountdown(seconds: 45) == "za 45\u{00A0}s")
    #expect(UICopy.usageCountdown(seconds: 44 * 60) == "za 44\u{00A0}min")
    #expect(UICopy.usageCountdown(seconds: 3600) == "za 1\u{00A0}h\u{00A0}00", "a full hour has the hour form, not 60 min")
    #expect(UICopy.usageCountdown(seconds: 3900) == "za 1\u{00A0}h\u{00A0}05", "minutes with two digits")
    #expect(UICopy.usageCountdown(seconds: 36 * 3600) == "za 1\u{00A0}d", "days truncate, 36 h is 1 day")
    #expect(model.rowSpoken(model.segments[0], now: now, timeZone: utc)
      == "Okno 5-godzinne: 27 procent, reset 13:20 · za 2\u{00A0}h\u{00A0}44")
    let noReset = PlanUsageModel.make(usageState([.loaded(usage(#"{"weekly":{"percent":10}}"#))]), now: now, timeZone: utc)
    #expect(noReset.resetLine(noReset.segments[0], now: now) == nil)
  }

  @Test("nieświeże: ostatni dobry odczyt serwera, zapas z paska CLI, nasze nieudane odświeżenie")
  func staleNotes() {
    let api = usage(#"{"stale":true,"fetchedAt":"2026-10-04T10:00:00.000Z","fiveHour":{"percent":27}}"#)
    let apiModel = PlanUsageModel.make(usageState([.loaded(api)]), now: now, timeZone: utc)
    #expect(apiModel.phase == .stale)
    #expect(apiModel.staleNote == "Odczyt z 10:00 — API limitów nie odpowiada.")
    let cli = usage(#"{"stale":true,"source":"cli","fetchedAt":"2026-10-04T09:58:00.000Z","weekly":{"percent":63}}"#)
    #expect(PlanUsageModel.make(usageState([.loaded(cli)]), now: now, timeZone: utc).staleNote
      == "Z paska statusu Claude Code, 09:58.")
    let failed = PlanUsageModel.make(usageState([.loaded(usage(freshJSON)), .failed]), now: now, timeZone: utc)
    #expect(failed.phase == .stale && failed.segments.count == 3)
    #expect(failed.staleNote == "Odczyt z 10:36 — nie udało się odświeżyć.")
    let nextDay = ServerTime.parse("2026-10-05T08:00:00.000Z")!
    #expect(PlanUsageModel.make(usageState([.loaded(api)]), now: nextDay, timeZone: utc).staleNote
      == "Odczyt z 04.10\u{00A0}10:00 — API limitów nie odpowiada.")
  }

  @Test("bez liczb: szkielet przy ładowaniu, przygaszony przy 503; zdania czytnika dla każdego stanu")
  func skeletonAndSpoken() {
    let loading = PlanUsageModel.make(PlanUsageState(), now: now, timeZone: utc)
    #expect(loading.segments.isEmpty && loading.phase == .loading)
    #expect(loading.usageSpoken(timeZone: utc) == "Limity planu — ładuję.")
    let unavailable = PlanUsageModel.make(usageState([.loaded(usage(freshJSON)), .unavailable]), now: now)
    #expect(unavailable.segments.isEmpty && unavailable.phase == .unavailable, "503 = nie wiem: liczby znikają")
    #expect(unavailable.usageSpoken(timeZone: utc) == "Limity planu niedostępne.")
    // Okna per model karta nie pokazuje, więc i jej zdanie go pomija (arkusz `/usage` go ma).
    let ready = PlanUsageModel.make(usageState([.loaded(usage(freshJSON))]), now: now, timeZone: utc)
    #expect(ready.usageSpoken(timeZone: utc) == "Limity planu — okno 5 godzin: 27 procent, reset o 13:20; "
      + "tydzień: 60 procent, reset o 15:00.")
  }

  @Test("miejsca paska: zawsze 5 h z lewej i tydzień z prawej, także bez okna, przy szkielecie i 503")
  func slots() {
    func make(_ json: String) -> PlanUsageModel {
      PlanUsageModel.make(usageState([.loaded(usage(json))]), now: now, timeZone: utc)
    }
    let both = make(freshJSON)
    #expect(both.slots.map(\.id) == ["5h", "7d"] && both.slots.map(\.short) == ["5h", "7d"])
    #expect(both.slots.map(\.segment?.percent) == [27, 60] && !both.isSkeleton)
    #expect(both.segments.map(\.id) == ["5h", "7d", "model"], "arkusz dalej ma wszystkie okna")
    #expect(both.segments.last?.percent == 91)

    let fiveHourOnly = make(#"{"fiveHour":{"percent":12}}"#)
    #expect(fiveHourOnly.slots.map(\.segment?.percent) == [12, nil])
    // Regresja: bez okna 5 h tydzień stawał w kolumnie 5H.
    let weeklyOnly = make(#"{"weekly":{"percent":74}}"#)
    #expect(weeklyOnly.slots.map(\.id) == ["5h", "7d"] && weeklyOnly.slots.map(\.segment?.percent) == [nil, 74])
    // Starszy serwer z samym oknem per model: oba miejsca puste, okno per model tylko w arkuszu.
    let modelOnly = make(#"{"weeklyModel":{"percent":91,"model":"Fable"}}"#)
    #expect(modelOnly.slots.map(\.segment) == [nil, nil] && modelOnly.segments.map(\.short) == ["Fab"])
    #expect(!modelOnly.isSkeleton && modelOnly.phase == .ready)

    // Regresja: szkielet miał trzy segmenty, a dane dwa; ma te same dwa miejsca z etykietami co dane.
    let loading = PlanUsageModel.make(PlanUsageState(), now: now, timeZone: utc)
    #expect(loading.isSkeleton && loading.slots.map(\.short) == ["5h", "7d"] && loading.slots.allSatisfy { $0.segment == nil })
    #expect(loading.ghostOpacity == 1 && loading.staleNote == nil)
    let unavailable = PlanUsageModel.make(usageState([.loaded(usage(freshJSON)), .unavailable]), now: now)
    #expect(unavailable.isSkeleton && unavailable.slots.map(\.short) == ["5h", "7d"])
    #expect(unavailable.ghostOpacity == 0.55 && unavailable.staleNote == nil, "503: przygaszone widma, bez notki")
    let failed = PlanUsageModel.make(usageState([.loaded(usage(freshJSON)), .failed]), now: now, timeZone: utc)
    // Nieświeże: liczby w pełnym kryciu, a nieświeżość mówią notka w arkuszu i zdanie czytnika (bez znaku na karcie).
    #expect(failed.phase == .stale && failed.staleNote != nil && failed.ghostOpacity == 1)
    #expect(failed.slots.map(\.segment?.percent) == [27, 60])
  }

  @Test("VoiceOver sentence with a missing window: a word instead of the number, 5 h and week keep their order")
  func spokenMissingWindow() {
    let weeklyOnly = PlanUsageModel.make(
      usageState([.loaded(usage(#"{"weekly":{"percent":64,"resetsAt":"2026-10-09T15:00:00+00:00"},"#
        + #""weeklyModel":{"percent":91,"model":"Fable"}}"#))]), now: now, timeZone: utc)
    #expect(weeklyOnly.usageSpoken(timeZone: utc)
      == "Limity planu — okno 5 godzin: brak odczytu; tydzień: 64 procent, reset o 15:00.")
    let fiveHourOnly = PlanUsageModel.make(usageState([.loaded(usage(#"{"fiveHour":{"percent":5}}"#))]), now: now)
    #expect(fiveHourOnly.usageSpoken(timeZone: utc) == "Limity planu — okno 5 godzin: 5 procent; tydzień: brak odczytu.")
  }

  @Test("reset countdown ticks: the card redraws at each change, so it always agrees with the sheet")
  func resetTicks() {
    // A reset at a second other than the wall-clock minute — with an `.everyMinute` tick the card would say
    // "za 2 h 44" while the sheet says "za 2 h 43" for part of every minute. Plus a window that steps from
    // "za 1 d" to "za 23 h 59", and the 5 h window, which steps down to seconds and passes.
    let fiveHour = now.addingTimeInterval(2 * 3600 + 44 * 60 + 20)
    let weekly = now.addingTimeInterval(4 * 86_400 + 7)
    let resets = [
      fiveHour, weekly, now.addingTimeInterval(10 * 3600 + 30 * 60 + 13), now.addingTimeInterval(86_400 + 4800 + 41),
    ]
    func countdown(_ at: Date, _ reset: Date) -> String {
      UICopy.usageCountdown(seconds: Int(reset.timeIntervalSince(at).rounded()))
    }
    // The card shows the value of the last tick; at every moment it has what it would compute now.
    var tick = now
    for second in stride(from: 0.0, through: 3 * 3600, by: 0.25) {
      let moment = now.addingTimeInterval(second)
      while case let next = PlanUsageModel.nextResetTick(after: tick, resets: resets), next <= moment {
        // Called at the tick itself it returns the next one, not the same (otherwise `TimelineView` would stand still).
        guard next.timeIntervalSince(tick) >= 0.5 else {
          Issue.record("tick stands still: \(second) s")
          return
        }
        tick = next
      }
      for reset in resets where countdown(tick, reset) != countdown(moment, reset) {
        Issue.record("\(second) s: card \(countdown(tick, reset)), now \(countdown(moment, reset))")
      }
      if second == 30 {
        #expect(countdown(tick, fiveHour) == "za 2\u{00A0}h\u{00A0}43")
      }
    }
    // The 5 h window every minute, every second in its last minute, the week once a day — never two ticks a minute:
    // 163 minute changes, "1 min" → "59 s", 58 second changes, "1 s" → "lada chwila" and one change of the week.
    var ticks = 0
    tick = now
    while ticks < 1000 {
      tick = PlanUsageModel.nextResetTick(after: tick, resets: [fiveHour, weekly])
      guard tick <= now.addingTimeInterval(3 * 3600) else { break }
      ticks += 1
    }
    #expect(ticks == 224, "ticks: \(ticks)")
    // Windows past their reset no longer change — a tick every wall-clock minute.
    #expect(PlanUsageModel.nextResetTick(after: now, resets: [now.addingTimeInterval(-5)]) == now.addingTimeInterval(60))
    #expect(PlanUsageModel.nextResetTick(after: now, resets: []) == now.addingTimeInterval(60))
  }

  @Test("nagłówek listy: „Agenci (N)” i „TS · nazwa”")
  func header() {
    #expect(UICopy.listTitle(count: 7) == "Agenci (7)")
    #expect(UICopy.tailnetLabel("example.com") == "TS · example.com")
  }
}
