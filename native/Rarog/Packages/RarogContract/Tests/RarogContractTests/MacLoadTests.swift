import RarogContract
import Testing

// Progi obciążenia Maca — jedno źródło dla stopki listy i kafla Live Activity. Granice na zaokrąglonych
// procentach (krok 5 z serwera): wartość równa progowi już go przekracza.
@Suite("obciążenie Maca: progi koloru")
struct MacLoadTests {
  @Test(
    "granice progów: tuż pod, równo, nad",
    arguments: [
      (MacMetric.cpu, 65, MacLoadLevel.normal), (.cpu, 70, .warning), (.cpu, 85, .warning), (.cpu, 90, .critical),
      (.ram, 70, .normal), (.ram, 75, .warning), (.ram, 85, .warning), (.ram, 90, .critical),
      (.disk, 80, .normal), (.disk, 85, .warning), (.disk, 90, .warning), (.disk, 95, .critical),
      (.cpu, 0, .normal), (.disk, 100, .critical),
    ])
  func boundaries(metric: MacMetric, percent: Int, expected: MacLoadLevel) {
    #expect(metric.level(percent) == expected)
  }

  @Test("wartości spoza 0…100 przycięte; progi rosną: uwaga < czerwień")
  func clamps() {
    #expect(MacMetric.cpu.level(-10) == .normal)
    #expect(MacMetric.ram.level(250) == .critical)
    for metric in MacMetric.allCases {
      #expect(metric.thresholds.warning < metric.thresholds.critical, "\(metric)")
      #expect(metric.thresholds.warning % 5 == 0 && metric.thresholds.critical % 5 == 0, "krok 5 serwera")
    }
    #expect(MacLoadLevel.normal < .warning && MacLoadLevel.warning < .critical)
  }

  @Test("wartość metryki i pusty odczyt")
  func values() {
    let load = MacLoad(cpu: 35, disk: 95)
    #expect(load.value(.cpu) == 35 && load.value(.ram) == nil && load.value(.disk) == 95)
    #expect(!load.isEmpty && MacLoad().isEmpty)
  }
}
