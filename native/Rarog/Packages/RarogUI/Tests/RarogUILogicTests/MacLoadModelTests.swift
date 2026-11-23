import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Obciążenie Maca w stopce listy: metryki w stałej kolejności, progi z kontraktu, szkielet, brak funkcji,
// nazwa tailnetu w sekcji panelu i zdanie czytnika całej stopki. Właściciel: lista.

private let utc = TimeZone(identifier: "UTC")!
private let now = ServerTime.parse("2026-10-08T14:05:00.000Z")!

private func macState(_ events: [MacLoadEvent]) -> MacLoadState {
  var state = AppState(clientBuild: 1)
  for event in events { state.apply(.mac(event), now: now) }
  return state.macLoad
}

@Suite("obciążenie Maca: model stopki")
struct MacLoadModelTests {
  @Test("liczby: CPU, RAM, DSK w tej kolejności; progi z kontraktu na kolor i wagę")
  func ready() {
    let model = MacLoadModel.make(
      macState([.loaded(MacLoad(cpu: 35, ram: 80, disk: 95), at: now)]), tailnet: "example.ts.net", machine: .mac, timeZone: utc)
    #expect(model.phase == .ready && model.showsLine && model.hasNumbers && model.staleNote == nil)
    #expect(model.metrics.map(\.short) == ["CPU", "RAM", "DSK"])
    #expect(model.metrics.map(\.full) == ["Procesor", "Pamięć", "Dysk"])
    #expect(model.metrics.map(\.detail) == ["średnia z minuty", "presja", "zajęte"])
    #expect(model.metrics.map(\.percent) == [35, 80, 95])
    #expect(model.metrics.map(\.level) == [.normal, .warning, .critical])
    #expect(model.metrics.map(\.tone) == [.calm, .warn, .hot])
    #expect(model.level == .critical && model.tailnet == "example.ts.net" && model.panelNote == nil)
    let ram = model.metrics[1]
    #expect(ram.short == "RAM" && ram.percent == 80 && ram.tone == .warn)
  }

  @Test("część odczytów: brakująca metryka bez liczby (widmo w linii, „brak odczytu” w panelu); zero to liczba")
  func partial() {
    let model = MacLoadModel.make(macState([.loaded(MacLoad(cpu: 0, disk: 45), at: now)]), tailnet: nil, machine: .mac)
    #expect(model.metrics.map(\.percent) == [0, nil, 45])
    #expect(model.metrics[0].percent == 0 && model.metrics[1].percent == nil)
    #expect(model.rowSpoken(model.metrics[1]) == "Pamięć, presja: brak odczytu")
    #expect(model.rowSpoken(model.metrics[0]) == "Procesor, średnia z minuty: 0 procent")
  }

  @Test("szkielet: ładuję (puls), brak liczb (bez pulsu), pusty odczyt i po terminie — etykiety stoją, liczb nie ma")
  func skeleton() {
    let loading = MacLoadModel.make(MacLoadState(), tailnet: nil, machine: .mac)
    #expect(loading.phase == .loading && loading.pulses && loading.showsLine && !loading.hasNumbers)
    #expect(loading.metrics.map(\.short) == ["CPU", "RAM", "DSK"] && loading.panelNote == UICopy.macLoadingNote(.mac))
    let failed = MacLoadModel.make(macState([.failed]), tailnet: "example.ts.net", machine: .mac)
    #expect(failed.phase == .unavailable && !failed.pulses && failed.panelNote == UICopy.macUnavailableNote(.mac))
    #expect(failed.tailnet == "example.ts.net", "nazwa tailnetu stoi w panelu także bez liczb")
    let empty = MacLoadModel.make(macState([.loaded(MacLoad(), at: now)]), tailnet: nil, machine: .mac)
    #expect(empty.phase == .unavailable && !empty.hasNumbers)
    let expired = MacLoadModel.make(macState([.loaded(MacLoad(cpu: 50), at: now), .expired]), tailnet: nil, machine: .mac)
    #expect(expired.phase == .unavailable && !expired.hasNumbers, "po terminie żadnych starych liczb")
  }

  @Test("odświeżenie padło w terminie: liczby zostają z notką z godziną odczytu (panel i czytnik)")
  func stale() {
    let model = MacLoadModel.make(
      macState([.loaded(MacLoad(cpu: 70), at: now), .failed]), tailnet: nil, machine: .mac, timeZone: utc)
    #expect(model.phase == .stale && model.metrics[0].percent == 70)
    #expect(model.staleNote == "Odczyt z 14:05 — nie udało się odświeżyć.")
    #expect(model.lineSpoken == "Mac — procesor 70 procent, wysokie. Odczyt z 14:05 — nie udało się odświeżyć.")
  }

  @Test("serwer bez funkcji (404): linii nie ma, zdanie czytnika bez Maca, panel mówi dlaczego")
  func unsupported() {
    let model = MacLoadModel.make(macState([.unsupported(serverStartId: "s")]), tailnet: "example.ts.net", machine: .mac)
    #expect(!model.showsLine && model.lineSpoken == nil && model.panelNote == UICopy.macUnsupportedNote)
  }
}
