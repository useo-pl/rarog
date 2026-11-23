import RarogActivity
import RarogContract
import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Kafel Live Activity: widoki z `RarogActivity` renderowane
/// `ImageRenderer`-em w obu motywach — te same widoki wkłada rozszerzenie `RarogWidgets` w
/// `ActivityConfiguration`. Test pilnuje koloru stanu w motywie (bursztyn decyzji, zieleń pracy, niebieski
/// wyniku, progi limitów w linii usage i progi Maca na słupkach), zgodności palety kafla z paletą apki
/// i wysokości ≤ 160 pt (system przycina
/// wyżej); zrzuty (ekran blokady, wyspa rozwinięta, zwinięta i minimalna) zapisuje do katalogu z
/// `RAROG_LA_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_LA_SNAPSHOT_DIR` przy `xcodebuild`), bez niego tylko sprawdza.
@MainActor
final class LiveActivityViewTests: XCTestCase {
  static let now = Int(Date().timeIntervalSince1970)

  /// Komplet z makiety: 2/3/4, dwa przebiegi (z planem faz i bez), „+1", limity 42 % i 81 % (bursztyn), Mac.
  static let full = LiveActivityContentState(
    waiting: 2, working: 3, finished: 4, top: .init(sessionId: "demo-willow"),
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-ux", agents: 7, done: 3,
        phase: .init(index: 2, count: 4, title: "Weryfikacja"), segments: [100, 60, 0, 0]),
      .init(sessionId: "demo-atlas", project: "atlas-web", name: "review-changes", agents: 3, done: 1, segments: [33]),
    ],
    moreWorkflows: 1, limits: .init(fiveHour: 42, weekly: 81), mac: .init(cpu: 35, ram: 70, disk: 60),
    updatedEpoch: now)
  /// Sama praca z jednym przebiegiem, limit poniżej progu: bez bursztynu i bez niebieskiego.
  static let working = LiveActivityContentState(
    waiting: 0, working: 1, finished: 0, top: .init(sessionId: "demo-rarog"),
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0]),
    ],
    limits: .init(fiveHour: 20), updatedEpoch: now)
  /// Limit tygodniowy krytyczny (≥ 90 %), poza tym cisza.
  static let critical = LiveActivityContentState(
    waiting: 0, working: 0, finished: 0, limits: .init(fiveHour: 30, weekly: 93), updatedEpoch: now)
  static let quiet = LiveActivityContentState(waiting: 0, working: 0, finished: 0, updatedEpoch: now)
  /// Stan startowy z apki (same liczniki) — zanim serwer dośle przebiegi, limity i Maca.
  static let start = LiveActivityContentState(
    waiting: 1, working: 2, finished: 0, top: .init(sessionId: "demo-willow"), updatedEpoch: now)
  /// NAJWYŻSZA treść: dwa przebiegi z łańcuchami na suficie kontraktu (60 znaków) i najdłuższym tytułem fazy,
  /// który jeszcze stoi na kaflu, „+N", oba limity, trzy metryki Maca, dwucyfrowe liczniki.
  static let tallest: LiveActivityContentState = {
    let long = String(repeating: "projekt-z-dluga-nazwa-", count: 3).prefix(60)
    let name = String(repeating: "przebieg-", count: 7).prefix(60)
    let phase = String(repeating: "W", count: LiveActivityPresentation.phaseTitleMax)
    return LiveActivityContentState(
      waiting: 12, working: 24, finished: 18, top: .init(sessionId: "s"),
      workflows: [
        .init(
          sessionId: "a", project: String(long), name: String(name), agents: 40, done: 39,
          phase: .init(index: 11, count: 12, title: phase), segments: Array(repeating: 100, count: 10) + [50, 0]),
        .init(sessionId: "b", project: String(long), name: String(name), agents: 120, done: 99, segments: [83]),
      ],
      moreWorkflows: 12, limits: .init(fiveHour: 100, weekly: 95), mac: .init(cpu: 100, ram: 100, disk: 100),
      updatedEpoch: now)
  }()

  /// Pełna treść ze słupkami Maca — oba limity 100 %, dwa przebiegi, „+N", Mac na progach.
  static let barsFull: LiveActivityContentState = {
    var state = tallest
    state.limits = .init(fiveHour: 100, weekly: 100)
    state.mac = .init(cpu: 35, ram: 80, disk: 95)
    return state
  }()
  /// Cisza z limitami poniżej progu i Makiem na progach: kolor uwagi i czerwieni niesą WYŁĄCZNIE słupki Maca.
  static let macHot = LiveActivityContentState(
    waiting: 0, working: 0, finished: 0, limits: .init(fiveHour: 10, weekly: 20), mac: .init(cpu: 35, ram: 70, disk: 95),
    updatedEpoch: now)
  static let macCalm = LiveActivityContentState(
    waiting: 0, working: 0, finished: 0, limits: .init(fiveHour: 10, weekly: 20), mac: .init(cpu: 35, ram: 50, disk: 79),
    updatedEpoch: now)

  /// Przebieg z planem trzech faz w trzech stanach: skończona, w pracy, niezaczęta. Liczniki zerowe,
  /// bez limitów i Maca, więc zieleń i szarość niesie wyłącznie pasek.
  static let phased = LiveActivityContentState(
    waiting: 0, working: 0, finished: 0,
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0],
        states: [.done, .running, .pending]),
    ],
    updatedEpoch: now)
  /// Ten sam przebieg od serwera bez pola `states`: pasek z samych procentów.
  static let phasedPlain: LiveActivityContentState = {
    var state = phased
    state.workflows?[0].states = nil
    return state
  }()
  /// Zrzut do odbioru: przebieg ze stanami faz nad przebiegiem z planem bez `states`.
  static let phasedPair = LiveActivityContentState(
    waiting: 1, working: 2, finished: 0, top: .init(sessionId: "demo-rarog"),
    workflows: [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-docs", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "A2 Weryfikacja"), segments: [100, 50, 0],
        states: [.done, .running, .pending]),
      .init(
        sessionId: "demo-atlas", project: "atlas-web", name: "review-changes", agents: 4, done: 3,
        phase: .init(index: 2, count: 3, title: "Weryfikacja"), segments: [100, 50, 0]),
    ],
    limits: .init(fiveHour: 42, weekly: 81), mac: .init(cpu: 35, ram: 50, disk: 60), updatedEpoch: now)

  /// Paleta kafla = paleta apki (rozszerzenie nie linkuje `RarogUI`, więc wartości są skopiowane).
  func testPaletteMatchesAppTokens() {
    let pairs: [((dark: UInt32, light: UInt32), PaletteTokens.Pair, String)] = [
      (LiveActivityPalette.waitPair, PaletteTokens.wait, "wait"),
      (LiveActivityPalette.runPair, PaletteTokens.run, "run"),
      (LiveActivityPalette.newPair, PaletteTokens.new, "new"),
      (LiveActivityPalette.errPair, PaletteTokens.err, "err"),
      (LiveActivityPalette.quietPair, PaletteTokens.muted2, "muted2"),
      (LiveActivityPalette.zeroPair, PaletteTokens.idleInk, "idleInk"),
      (LiveActivityPalette.textPair, PaletteTokens.text, "text"),
    ]
    for (tile, app, name) in pairs {
      XCTAssertEqual(tile.dark, app.dark, "\(name): ciemny")
      XCTAssertEqual(tile.light, app.light, "\(name): jasny")
    }
  }

  /// Ekran blokady: kolor stanu w kolorze MOTYWU (jasny bursztyn ≠ ciemny), niebieski „skończyły", progi
  /// limitów (60 % bursztyn, 90 % czerwień), zera przygaszone, cisza bez koloru; zrzuty obu motywów.
  func testLockScreenRendersStateColorPerTheme() throws {
    for scheme in [ColorScheme.light, .dark] {
      let name = scheme == .light ? "jasny" : "ciemny"
      func tone(_ pair: (dark: UInt32, light: UInt32)) -> UInt32 { scheme == .light ? pair.light : pair.dark }
      let full = try render(lockScreen(Self.full, stale: false, scheme: scheme), "ekran-blokady-komplet-\(name)")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.waitPair), in: full), 20, "\(name): bursztyn decyzji")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.runPair), in: full), 20, "\(name): zieleń pracy")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.newPair), in: full), 20, "\(name): niebieski wyniku")
      XCTAssertLessThanOrEqual(full.height, 320, "\(name): komplet ≤ 160 pt")

      let working = try render(lockScreen(Self.working, stale: false, scheme: scheme), "ekran-blokady-praca-\(name)")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.runPair), in: working), 20, "\(name): zieleń i pasek")
      XCTAssertEqual(Self.count(of: tone(LiveActivityPalette.waitPair), in: working), 0, "\(name): bez decyzji i progu")
      XCTAssertEqual(Self.count(of: tone(LiveActivityPalette.newPair), in: working), 0, "\(name): zero skończonych")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.zeroPair), in: working), 20, "\(name): zera przygaszone")

      let critical = try render(lockScreen(Self.critical, stale: false, scheme: scheme), "ekran-blokady-limit-\(name)")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.errPair), in: critical), 10, "\(name): limit ≥ 90 %")

      let stale = try render(lockScreen(Self.full, stale: true, scheme: scheme), "ekran-blokady-nieswieze-\(name)")
      XCTAssertEqual(Double(stale.height), Double(full.height), accuracy: 4, "\(name): zdanie zastępuje linię usage")

      let start = try render(lockScreen(Self.start, stale: false, scheme: scheme), "ekran-blokady-start-\(name)")
      XCTAssertLessThan(start.height, full.height, "\(name): stan startowy — same liczniki")

      let quiet = try render(lockScreen(Self.quiet, stale: false, scheme: scheme), "ekran-blokady-cisza-\(name)")
      let colored = [LiveActivityPalette.waitPair, LiveActivityPalette.runPair, LiveActivityPalette.newPair]
        .map { Self.count(of: tone($0), in: quiet) }.reduce(0, +)
      XCTAssertEqual(colored, 0, "\(name): cisza bez koloru stanu")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.zeroPair), in: quiet), 20, "\(name): trzy przygaszone zera")
    }
  }

  /// Najwyższa treść (dwa przebiegi z długimi nazwami, „+N", oba limity, trzy metryki Maca; świeża
  /// i nieświeża) mieści się w 160 pt kafla ekranu blokady i rozwiniętej wyspy — wyższy system przycina.
  /// Także przy powiększonym piśmie: pismo kafla rośnie do `LiveActivityPresentation.maxTypeSize`, dalej stoi.
  func testTallestContentFitsHeightLimit() throws {
    for size in [DynamicTypeSize.large, .xLarge, .xxLarge, .accessibility3] {
      for stale in [false, true] {
        for scheme in [ColorScheme.light, .dark] {
          let label = "\(size)-\(stale ? "nieswieze" : "swieze")-\(scheme == .light ? "jasny" : "ciemny")"
          let lock = try render(
            lockScreen(Self.tallest, stale: stale, scheme: scheme).environment(\.dynamicTypeSize, size),
            "ekran-blokady-najwyzszy-\(label)")
          XCTAssertLessThanOrEqual(lock.height, 320, "ekran blokady \(label): \(lock.height / 2) pt > 160 pt")
          print("live-activity: ekran blokady \(label) = \(lock.height / 2) pt")
        }
        let island = try render(
          expandedIsland(Self.tallest, stale: stale).environment(\.dynamicTypeSize, size),
          "wyspa-rozwinieta-najwyzsza-\(size)-\(stale ? "nieswieze" : "swieze")")
        XCTAssertLessThanOrEqual(island.height, 320, "wyspa \(size): \(island.height / 2) pt > 160 pt")
        print("live-activity: wyspa rozwinięta \(size) stale=\(stale) = \(island.height / 2) pt")
      }
    }
  }

  /// BRAMKA: kafel ekranu blokady ze słupkami Maca mieści pełną treść — oba limity 100 %, dwa przebiegi,
  /// „+N", Mac na progach, świeży i nieświeży — w 160 pt przy `maxTypeSize` (.xLarge), w obu motywach.
  func testBarsTileFitsAtMaxTypeSize() throws {
    for stale in [false, true] {
      for scheme in [ColorScheme.light, .dark] {
        let label = "\(stale ? "nieswieze" : "swieze")-\(scheme == .light ? "jasny" : "ciemny")"
        let lock = try render(
          lockScreen(Self.barsFull, stale: stale, scheme: scheme)
            .environment(\.dynamicTypeSize, LiveActivityPresentation.maxTypeSize),
          "ekran-blokady-slupki-xlarge-\(label)")
        XCTAssertLessThanOrEqual(lock.height, 320, "słupki \(label): \(lock.height / 2) pt > 160 pt")
        print("live-activity: słupki .xLarge \(label) = \(lock.height / 2) pt")
        // Dysk 95 % = czerwony słupek (próg 95 %). Kafel nieświeży przygasa (0,7) i miesza kolor z tłem, więc
        // pełny odcień liczy się tylko na świeżym.
        if !stale {
          let red = scheme == .light ? LiveActivityPalette.errPair.light : LiveActivityPalette.errPair.dark
          XCTAssertGreaterThan(Self.count(of: red, in: lock), 200, "\(label): czerwony słupek dysku")
        }
      }
    }
  }

  /// Słupki i procenty Maca w kolorze progu kafla: RAM 70 % bursztyn (60/80), dysk 95 % czerwień (80/90), a dysk
  /// 79 % i RAM 50 % jeszcze bez koloru.
  func testMacPercentsColoredByThreshold() throws {
    for scheme in [ColorScheme.light, .dark] {
      let name = scheme == .light ? "jasny" : "ciemny"
      func tone(_ pair: (dark: UInt32, light: UInt32)) -> UInt32 { scheme == .light ? pair.light : pair.dark }
      let hot = try render(lockScreen(Self.macHot, stale: false, scheme: scheme), "ekran-blokady-mac-progi-\(name)")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.waitPair), in: hot), 10, "\(name): RAM bursztyn")
      XCTAssertGreaterThan(Self.count(of: tone(LiveActivityPalette.errPair), in: hot), 10, "\(name): dysk czerwień")
      let calm = try render(lockScreen(Self.macCalm, stale: false, scheme: scheme), "ekran-blokady-mac-spokojnie-\(name)")
      XCTAssertEqual(Self.count(of: tone(LiveActivityPalette.waitPair), in: calm), 0, "\(name): bez bursztynu")
      XCTAssertEqual(Self.count(of: tone(LiveActivityPalette.errPair), in: calm), 0, "\(name): bez czerwieni")
    }
  }

  /// Linia usage stoi w kolumnie tekstu obok słupków Maca, więc nie dokłada wiersza — wysokość pary wyznaczają
  /// słupki z procentem i podpisem, a kafel z limitami i bez nich jest tak samo wysoki.
  func testUsageLineSitsBesideMacBars() throws {
    var withoutLimits = Self.macCalm
    withoutLimits.limits = nil
    for scheme in [ColorScheme.light, .dark] {
      let name = scheme == .light ? "jasny" : "ciemny"
      let with = try render(lockScreen(Self.macCalm, stale: false, scheme: scheme), "ekran-blokady-usage-obok-\(name)")
      let without = try render(
        lockScreen(withoutLimits, stale: false, scheme: scheme), "ekran-blokady-bez-usage-\(name)")
      XCTAssertEqual(with.height, without.height, "\(name): linia usage dołożyła wysokość obok słupków")
    }
  }

  /// Góra cyfr liczników na wysokości góry procentów Maca, a lewa krawędź pierwszej cyfry tak daleko od brzegu
  /// kafla, jak ich góra od górnego. Pomiar na bursztynie: czekające „2” z lewej, RAM 70 % z prawej (komplet z
  /// makiety).
  func testCounterDigitsAlignWithMacPercentsAndMargins() throws {
    for scheme in [ColorScheme.light, .dark] {
      let name = scheme == .light ? "jasny" : "ciemny"
      let amber = scheme == .light ? LiveActivityPalette.waitPair.light : LiveActivityPalette.waitPair.dark
      let bitmap = try render(lockScreen(Self.full, stale: false, scheme: scheme), "ekran-blokady-wyrownanie-\(name)")
      let half = bitmap.width / 2
      let digit = try XCTUnwrap(Self.inkBox(of: amber, in: bitmap, columns: 0..<half), "\(name): cyfra")
      let percent = try XCTUnwrap(
        Self.inkBox(of: amber, in: bitmap, columns: half..<bitmap.width), "\(name): procent RAM")
      // Skala 2: 2 px = 1 pt.
      XCTAssertEqual(Double(digit.top), Double(percent.top), accuracy: 2, "\(name): góra cyfr = góra procentów")
      XCTAssertEqual(Double(digit.left), Double(digit.top), accuracy: 2, "\(name): margines z lewej = od góry")
    }
  }

  /// Serwer na VPS (`ServerMachine.vps`): słowo maszyny zmienia tylko zdania (`macLine`, mowa czytnika), nie
  /// układ — kafel i wyspa z `.vps` mają wysokość jak z `.mac`, dla pełnej treści i ciszy z Makiem. Klasa nie wybiera
  /// języka w procesie (`LiveActivityPresentation` bierze `CopyLanguage.current`), więc przypadek angielski to ten sam
  /// test w osobnym procesie z `TEST_RUNNER_RAROG_COPY_LANGUAGE=en` (`docs/localization.md`, „Tests”).
  func testVpsServerKeepsMacLayout() throws {
    for (state, label) in [(Self.full, "komplet"), (Self.macCalm, "cisza")] {
      let vps = LiveActivityPresentation(state, machine: .vps)
      XCTAssertEqual(vps.macLine?.hasPrefix("VPS "), true, "\(label): linia maszyny VPS: \(vps.macLine ?? "-")")
      let lock = try render(lockScreen(state, stale: false, scheme: .dark), "ekran-blokady-\(label)-mac")
      let lockVps = try render(
        lockScreen(state, stale: false, scheme: .dark, machine: .vps), "ekran-blokady-\(label)-vps")
      XCTAssertEqual(lockVps.height, lock.height, "\(label): ekran blokady VPS jak Mac")
      let island = try render(expandedIsland(state, stale: false), "wyspa-rozwinieta-\(label)-mac")
      let islandVps = try render(expandedIsland(state, stale: false, machine: .vps), "wyspa-rozwinieta-\(label)-vps")
      XCTAssertEqual(islandVps.height, island.height, "\(label): wyspa VPS jak Mac")
    }
  }

  /// Wyspa (zawsze ciemna): rozwinięta (limity w rogach, liczniki i przebiegi na dole), zwinięta (z przebiegami
  /// — czekające i pracujące | pierścień; bez — czekające | pracujące) i minimalna — kolory ciemnego motywu.
  func testIslandPiecesRender() throws {
    for (state, label) in [(Self.full, "komplet"), (Self.start, "start"), (Self.quiet, "cisza")] {
      let presentation = LiveActivityPresentation(state, machine: .mac)
      let expanded = try render(expandedIsland(state, stale: false), "wyspa-rozwinieta-\(label)")
      XCTAssertLessThanOrEqual(expanded.height, 320, "\(label): wyspa ≤ 160 pt")
      let compact = try render(
        HStack {
          LiveActivityCompactLeading(presentation: presentation)
          Spacer()
          LiveActivityCompactTrailing(presentation: presentation)
        }
        .padding(.leading, 14).padding(.trailing, 12).frame(width: 250, height: 37)
        .background(Capsule().fill(Color.black)),
        "wyspa-zwinieta-\(label)")
      _ = try render(
        LiveActivityMinimal(presentation: presentation).frame(width: 37, height: 37).background(Circle().fill(Color.black)),
        "wyspa-minimalna-\(label)")
      switch label {
      case "komplet":
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.waitPair.dark, in: expanded), 10, "bursztyn na wyspie")
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.newPair.dark, in: expanded), 10, "niebieski na wyspie")
        // Czekające (bursztyn) i pierścień postępu (zieleń) obok siebie.
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.waitPair.dark, in: compact), 10, "czekające zwinięte")
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.runPair.dark, in: compact), 10, "pracujące i pierścień")
      case "start":
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.runPair.dark, in: compact), 10, "pracujące z prawej")
        XCTAssertGreaterThan(Self.count(of: LiveActivityPalette.waitPair.dark, in: compact), 10, "czekające z lewej")
      default:
        XCTAssertEqual(Self.count(of: LiveActivityPalette.waitPair.dark, in: expanded), 0, "cisza bez bursztynu")
        XCTAssertEqual(Self.count(of: LiveActivityPalette.runPair.dark, in: expanded), 0, "cisza bez zieleni")
      }
    }
  }

  /// Stany faz na pasku: przy `states` trzy pełne kapsuły — przygaszona zieleń (skończona), pełna zieleń
  /// (w pracy), szary (niezaczęta) — bez wypełnienia procentem i bez toru fazy bieżącej. Bez `states` pasek
  /// z samych procentów: wypełnienie procentem (zieleń na półtora segmentu przy 100/50/0) i tor reszty faz. Ekran
  /// blokady w obu motywach i rozwinięta wyspa; zrzuty z przebiegiem ze stanami nad przebiegiem bez nich.
  func testPhaseBarDrawsThreePhaseStates() throws {
    typealias Surface = LiveActivityPalette.Surface
    let cases: [(Surface, String)] = [(.dark, "ciemny"), (.light, "jasny"), (.island, "wyspa")]
    for (surface, name) in cases {
      func shot(_ state: LiveActivityContentState, _ label: String) throws -> Bitmap {
        switch surface {
        case .island: try render(expandedIsland(state, stale: false), "wyspa-rozwinieta-fazy-\(label)")
        case .dark: try render(lockScreen(state, stale: false, scheme: .dark), "ekran-blokady-fazy-\(label)-ciemny")
        case .light: try render(lockScreen(state, stale: false, scheme: .light), "ekran-blokady-fazy-\(label)-jasny")
        }
      }
      // Tło widoku: zastępcze tło ekranu blokady (`lockScreen`) albo czerń wyspy (`expandedIsland`).
      let background = surface == .island ? 0 : surface == .light ? 0.95 : 0.12
      func ink(_ state: LiveActivityContentState.PhaseState) -> UInt32 {
        Self.blend(LiveActivityPalette.phase(state, on: surface), over: background)
      }
      // Tor faz poza bieżącą (`LiveActivityPalette.track(current: false)`): ciemny 0,20, wyspa 0,18, jasny czerń 0,08.
      let otherTrack = Self.blend(
        surface == .light ? .init(hex: 0x000000, alpha: 0.08) : .init(hex: 0xFFFFFF, alpha: surface == .island ? 0.18 : 0.20),
        over: background)

      // Liczymy w pasie paska: wiersze i lewa krawędź pierwszego segmentu (przy stanach przygaszona zieleń, bez
      // nich pełna), do prawej krawędzi. Poza pasem szarości tekstu i przygaszonych zer mieszają się z szarym faz.
      let states = try shot(Self.phased, "stany")
      let plain = try shot(Self.phasedPlain, "procent")
      let statesBar = try XCTUnwrap(Self.bar(of: ink(.done), in: states), "\(name): pasek ze stanami")
      let plainBar = try XCTUnwrap(Self.bar(of: ink(.running), in: plain), "\(name): pasek bez stanów")
      let count = { (bitmap: Bitmap, bar: Bar, hex: UInt32) in Self.count(of: hex, in: bitmap, bar: bar) }
      let (done, running, pending) = (
        count(states, statesBar, ink(.done)), count(states, statesBar, ink(.running)),
        count(states, statesBar, ink(.pending))
      )
      let (plainDone, plainRunning, plainTrack) = (
        count(plain, plainBar, ink(.done)), count(plain, plainBar, ink(.running)), count(plain, plainBar, otherTrack)
      )
      let statesTrack = count(states, statesBar, otherTrack)
      print(
        "live-activity: stany faz \(name): skończona \(done), w pracy \(running), niezaczęta \(pending), tor \(statesTrack);"
          + " bez stanów: przygaszona \(plainDone), zieleń \(plainRunning), tor \(plainTrack)")
      XCTAssertGreaterThan(done, 300, "\(name): przygaszona zieleń skończonej fazy")
      XCTAssertGreaterThan(running, 300, "\(name): pełna zieleń fazy w pracy")
      XCTAssertGreaterThan(pending, 300, "\(name): szary niezaczętej fazy")
      // Trzy segmenty tej samej szerokości, każdy pełny: tyle samo pikseli każdego stanu (bez wypełnienia procentem).
      XCTAssertEqual(Double(running) / Double(done), 1, accuracy: 0.2, "\(name): faza w pracy to pełna kapsuła")
      XCTAssertEqual(Double(pending) / Double(done), 1, accuracy: 0.2, "\(name): niezaczęta to pełna kapsuła")
      XCTAssertLessThan(statesTrack, plainTrack / 4, "\(name): przy stanach bez toru reszty faz")
      // Bez `states`: zieleń na 100 % + 50 % segmentu, bez przygaszonej zieleni, z torem fazy poza bieżącą.
      XCTAssertLessThan(plainDone, done / 4, "\(name): bez stanów nie ma przygaszonej zieleni")
      XCTAssertEqual(Double(plainRunning) / Double(running), 1.5, accuracy: 0.25, "\(name): bez stanów wypełnienie procentem")
      XCTAssertGreaterThan(plainTrack, 300, "\(name): bez stanów tor fazy poza bieżącą")

      let pair = try shot(Self.phasedPair, "dwa-przebiegi")
      XCTAssertLessThanOrEqual(pair.height, 320, "\(name): dwa przebiegi ≤ 160 pt")
    }
  }

  // MARK: - Render

  private func lockScreen(
    _ state: LiveActivityContentState, stale: Bool, scheme: ColorScheme, machine: ServerMachine = .mac
  ) -> some View {
    // Tło zastępcze w miejscu tapety i materiału ekranu blokady (w systemie kafel stoi na rozmyciu).
    LiveActivityLockScreenView(presentation: LiveActivityPresentation(state, machine: machine), isStale: stale)
      .frame(width: 364)
      .background(scheme == .light ? Color(white: 0.95) : Color(white: 0.12))
      .environment(\.colorScheme, scheme)
  }

  /// Rozwinięta wyspa złożona jak w `RarogWidgets`: limity w górnych rogach, dół na całą szerokość; marginesy
  /// jak w makiecie (system dokłada swoje — wynik to dolna granica wysokości, nie pomiar systemowy).
  private func expandedIsland(
    _ state: LiveActivityContentState, stale: Bool, machine: ServerMachine = .mac
  ) -> some View {
    let presentation = LiveActivityPresentation(state, machine: machine)
    return VStack(spacing: 9) {
      HStack(alignment: .top) {
        LiveActivityExpandedLeading(presentation: presentation)
        Spacer()
        LiveActivityExpandedTrailing(presentation: presentation)
      }
      LiveActivityExpandedBottom(presentation: presentation, isStale: stale)
    }
    .padding(.top, 14).padding(.bottom, 16).padding(.horizontal, 26)
    .frame(width: 371)
    .background(Color.black)
    .environment(\.colorScheme, .dark)
  }

  private struct Bitmap {
    let width: Int
    let height: Int
    let bytes: [UInt8]
  }

  /// Render w skali 2 do bitmapy RGBA; przy `RAROG_LA_SNAPSHOT_DIR` także PNG pod nazwą.
  private func render(_ view: some View, _ name: String) throws -> Bitmap {
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.cgImage, "\(name): render")
    if let dir = ProcessInfo.processInfo.environment["RAROG_LA_SNAPSHOT_DIR"], !dir.isEmpty {
      let url = URL(filePath: dir).appending(path: "\(name).png")
      try XCTUnwrap(UIImage(cgImage: image).pngData(), "\(name): PNG").write(to: url)
    }
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    XCTAssertTrue(drawn, "\(name): bitmapa")
    return Bitmap(width: image.width, height: image.height, bytes: bytes)
  }

  /// Najwyższy wiersz i najbardziej lewa kolumna pikseli w kolorze `hex` (±12 na kanał) w podanym pasie kolumn.
  private static func inkBox(of hex: UInt32, in bitmap: Bitmap, columns: Range<Int>) -> (top: Int, left: Int)? {
    let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
    var top: Int?
    var left = Int.max
    for y in 0..<bitmap.height {
      for x in columns {
        let index = (y * bitmap.width + x) * 4
        guard zip(target, bitmap.bytes[index..<index + 3]).allSatisfy({ abs($0 - Int($1)) <= 12 }) else { continue }
        top = top ?? y
        left = min(left, x - columns.lowerBound)
      }
    }
    return top.map { ($0, left) }
  }

  /// Pas paska faz: wiersze pikseli w kolorze pierwszego segmentu i jego lewa kolumna; pas biegnie do prawej krawędzi.
  private struct Bar {
    let rows: ClosedRange<Int>
    let left: Int
  }

  private static func bar(of hex: UInt32, in bitmap: Bitmap) -> Bar? {
    var top: Int?
    var bottom = 0
    var left = Int.max
    for y in 0..<bitmap.height {
      for x in 0..<bitmap.width where matches(hex, bitmap, x, y) {
        top = top ?? y
        bottom = y
        left = min(left, x)
      }
    }
    return top.map { Bar(rows: $0...bottom, left: left) }
  }

  private static func count(of hex: UInt32, in bitmap: Bitmap, bar: Bar) -> Int {
    var hits = 0
    for y in bar.rows {
      for x in bar.left..<bitmap.width where matches(hex, bitmap, x, y) { hits += 1 }
    }
    return hits
  }

  private static func matches(_ hex: UInt32, _ bitmap: Bitmap, _ x: Int, _ y: Int) -> Bool {
    let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
    let index = (y * bitmap.width + x) * 4
    return zip(target, bitmap.bytes[index..<index + 3]).allSatisfy { abs($0 - Int($1)) <= 12 }
  }

  /// Kolor z kryciem złożony na szarym tle `white` (0…1) w wartościach sRGB, jak w kontekście renderera.
  private static func blend(_ ink: LiveActivityPalette.Ink, over white: Double) -> UInt32 {
    func channel(_ shift: UInt32) -> UInt32 {
      let value = Double((ink.hex >> shift) & 0xFF) * ink.alpha + white * 255 * (1 - ink.alpha)
      return UInt32(value.rounded()) << shift
    }
    return channel(16) | channel(8) | channel(0)
  }

  /// Piksele w kolorze `hex` (±12 na kanał — krawędzie wygładzone mieszają się z tłem).
  private static func count(of hex: UInt32, in bitmap: Bitmap) -> Int {
    let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
    var hits = 0
    for index in stride(from: 0, to: bitmap.bytes.count, by: 4)
    where zip(target, bitmap.bytes[index..<index + 3]).allSatisfy({ abs($0 - Int($1)) <= 12 }) {
      hits += 1
    }
    return hits
  }
}
