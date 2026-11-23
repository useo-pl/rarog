import Foundation
import RarogActivity
import RarogContract
import Testing

// Copy kafla Live Activity (tablica z paskami faz): liczniki z odmianą, limity z progami,
// przebiegi workflow („faza 2/4 · Tytuł", bez planu „agenci 3/7"), segmenty paska, „+N", linia Maca, zdanie
// ciszy, VoiceOver, nieświeże dane i adres tapnięcia. Stan powstaje z JSON-u tym samym dekoderem, którym
// przychodzi z APNs (`LiveActivityContentState` — typ kontraktu).

@Suite("Live Activity: copy kafla i adres tapnięcia")
struct LiveActivityPresentationTests {
  static let epoch = 1_791_331_200

  /// Najpełniejszy kafel: trzy liczniki, dwa przebiegi (z planem faz i bez), „+1", oba limity, trzy metryki.
  static let full = #"""
    {"waiting":2,"working":3,"finished":4,"top":{"sessionId":"demo-willow"},
     "workflows":[
       {"sessionId":"demo-rarog","project":"rarog","name":"audyt-ux","agents":7,"done":3,
        "phase":{"index":2,"count":4,"title":"Weryfikacja"},"segments":[100,60,0,0]},
       {"sessionId":"demo-atlas","project":"atlas-web","name":"review-changes","agents":3,"done":1,"segments":[33]}],
     "moreWorkflows":1,"limits":{"fiveHour":42,"weekly":81},"mac":{"cpu":35,"ram":70,"disk":60},
     "updatedEpoch":1791331200}
    """#

  private func state(_ json: String) throws -> LiveActivityContentState {
    try JSONDecoder().decode(LiveActivityContentState.self, from: Data(json.utf8))
  }

  private func presentation(_ json: String, machine: ServerMachine = .mac) throws -> LiveActivityPresentation {
    LiveActivityPresentation(try state(json), machine: machine)
  }

  /// „HH:MM" chwili w strefie — oczekiwana godzina bez powtarzania arytmetyki stref w teście.
  static func clock(_ epoch: Int, _ zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let parts = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: TimeInterval(epoch)))
    return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
  }

  private func counts(_ waiting: Int, _ working: Int, _ finished: Int = 0) throws -> LiveActivityPresentation {
    try presentation(#"{"waiting":\#(waiting),"working":\#(working),"finished":\#(finished),"updatedEpoch":1791331200}"#)
  }

  @Test("liczniki: słowo odmienione po liczebniku (czeka/czekają, pracuje/pracują, skończyła/skończyły/skończyło)")
  func counters() throws {
    let busy = try counts(2, 1, 4)
    #expect(busy.waiting == 2 && busy.waitingWord == "czekają")
    #expect(busy.working == 1 && busy.workingWord == "pracuje")
    #expect(busy.finished == 4 && busy.finishedWord == "skończyły")
    let many = try counts(5, 12, 5)
    #expect(many.waitingWord == "czeka" && many.workingWord == "pracuje" && many.finishedWord == "skończyło")
    let few = try counts(22, 3, 1)
    #expect(few.waitingWord == "czekają" && few.workingWord == "pracują" && few.finishedWord == "skończyła")
    let teen = try counts(14, 13, 12)
    #expect(teen.waitingWord == "czeka" && teen.workingWord == "pracuje" && teen.finishedWord == "skończyło")
    let zero = try counts(0, 0)
    #expect(zero.waitingWord == "czeka" && zero.workingWord == "pracuje" && zero.finishedWord == "skończyło")
  }

  @Test("ton i liczba w Dynamic Island: czekające wygrywają z pracą, przebieg w tle to praca, cisza = 0")
  func toneAndCount() throws {
    #expect(try counts(2, 3).tone == .waiting && counts(2, 3).count == 2)
    #expect(try counts(0, 3).tone == .working && counts(0, 3).count == 3)
    #expect(try counts(0, 0, 2).tone == .quiet && counts(0, 0, 2).count == 0)
    let milling = try presentation(#"""
      {"waiting":0,"working":0,"finished":1,"workflows":[{"sessionId":"s","project":"p","name":"n","agents":2,
       "done":1,"segments":[50]}],"updatedEpoch":1}
      """#)
    #expect(milling.tone == .working && milling.count == 0)
  }

  @Test("limity: „limit 5h”/„limit 7d” z procentem; brak okna = brak wiersza; progi 60 % i 90 %")
  func limits() throws {
    let full = try presentation(Self.full)
    #expect(full.limits.map(\.label) == ["limit 5h", "limit 7d"] && full.limits.map(\.shortLabel) == ["5h", "7d"])
    #expect(full.limits.map(\.percentText) == ["42%", "81%"] && full.limits.map(\.fraction) == [0.42, 0.81])
    #expect(full.limits.map(\.level) == [.normal, .high])
    func level(_ percent: Int) throws -> LiveActivityPresentation.Limit.Level? {
      try presentation(#"{"waiting":0,"working":0,"finished":0,"limits":{"weekly":\#(percent)},"updatedEpoch":1}"#)
        .limit(.weekly)?.level
    }
    #expect(try level(0) == .normal && level(59) == .normal && level(60) == .high && level(79) == .high)
    #expect(try level(80) == .high && level(89) == .high && level(90) == .critical && level(100) == .critical)
    let weeklyOnly = try presentation(#"{"waiting":0,"working":0,"finished":0,"limits":{"weekly":7},"updatedEpoch":1}"#)
    #expect(weeklyOnly.limits.map(\.label) == ["limit 7d"] && weeklyOnly.limit(.fiveHour) == nil)
    #expect(try counts(1, 0).limits.isEmpty)
  }

  @Test("przebiegi: „projekt · nazwa”, „faza 2/4 · Tytuł”, bez planu „agenci n/m”, segmenty i bieżąca faza")
  func workflows() throws {
    let full = try presentation(Self.full)
    #expect(full.workflows.count == 2)
    let planned = full.workflows[0]
    #expect(planned.title == "rarog · audyt-ux" && planned.name == "audyt-ux")
    #expect(planned.progress == "faza 2/4 · Weryfikacja")
    #expect(planned.segments == [1, 0.6, 0, 0] && planned.current == 1)
    #expect(abs(planned.overall - 0.4) < 1e-9, "postęp całości = średnia segmentów")
    let unplanned = full.workflows[1]
    #expect(unplanned.title == "atlas-web · review-changes" && unplanned.progress == "agenci 1/3")
    #expect(unplanned.segments == [0.33] && unplanned.current == nil && unplanned.overall == 0.33)
    #expect(full.ring == planned.overall, "pierścień zwiniętej wyspy = pierwszy przebieg")
    #expect(full.more == "+1 workflow")
    #expect(try counts(1, 0).workflows.isEmpty && counts(1, 0).ring == nil && counts(1, 0).more == nil)
  }

  /// Przebieg z planem trzech faz, bieżąca faza druga; `states` wstawia test (`nil` = bez pola).
  static func phased(_ states: String?) -> String {
    let field = states.map { #","states":\#($0)"# } ?? ""
    return #"""
      {"waiting":0,"working":1,"finished":0,"workflows":[{"sessionId":"s","project":"rarog","name":"audyt-docs",
       "agents":4,"done":3,"phase":{"index":2,"count":3,"title":"A2 Weryfikacja"},"segments":[100,50,0]\#(field)}],
       "updatedEpoch":1}
      """#
  }

  @Test("stany faz: przy `states` wiersz niesie stan każdej fazy, procenty i faza bieżąca bez zmian")
  func phaseStates() throws {
    let row = try #require(try presentation(Self.phased(#"["done","running","pending"]"#)).workflows.first)
    #expect(row.states == [.done, .running, .pending])
    #expect(row.segments == [1, 0.5, 0] && row.current == 1 && row.progress == "faza 2/3 · A2 Weryfikacja")
    #expect(abs(row.overall - 0.5) < 1e-9, "pierścień zwiniętej wyspy dalej ze średniej procentów")
    let plain = try #require(try presentation(Self.phased(nil)).workflows.first)
    #expect(plain.states == nil && plain.segments == [1, 0.5, 0] && plain.current == 1)
    // Przebieg bez planu nie ma stanów (dekoder odrzuca `states` bez `phase`).
    #expect(try presentation(Self.full).workflows[1].states == nil)
  }

  @Test("stany faz w zdaniu VoiceOvera: stan każdej fazy po numerze; inna kolejność stanów = inne zdanie; bez pola jak dziś")
  func phaseStatesSpoken() throws {
    let lead = "Rarog: nic nie czeka na decyzję, 1 pracuje. "
    let base = "rarog, audyt-docs: faza 2 z 3, A2 Weryfikacja"
    let first = try presentation(Self.phased(#"["running","done","pending"]"#)).spoken
    #expect(first == lead + base + "; faza 1 w toku, faza 2 skończona, faza 3 jeszcze nie ruszyła.")
    let second = try presentation(Self.phased(#"["running","pending","done"]"#)).spoken
    #expect(second == lead + base + "; faza 1 w toku, faza 2 jeszcze nie ruszyła, faza 3 skończona.")
    #expect(first != second)
    #expect(try presentation(Self.phased(nil)).spoken == lead + base + ".", "bez `states` zdanie jak dziś")
  }

  @Test("tytuł fazy: pusty albo dłuższy niż 24 znaki zostaje samym numerem")
  func phaseTitle() throws {
    func progress(_ title: String) throws -> String? {
      try presentation(#"""
        {"waiting":0,"working":1,"finished":0,"workflows":[{"sessionId":"s","project":"p","name":"n","agents":1,
         "done":0,"phase":{"index":3,"count":3,"title":"\#(title)"},"segments":[100,100,0]}],"updatedEpoch":1}
        """#).workflows.first?.progress
    }
    #expect(try progress("") == "faza 3/3")
    #expect(try progress("  ") == "faza 3/3")
    let max = String(repeating: "x", count: LiveActivityPresentation.phaseTitleMax)
    #expect(try progress(max) == "faza 3/3 · " + max)
    #expect(try progress(max + "x") == "faza 3/3")
  }

  @Test("linia Maca: tylko obecne metryki, w stałej kolejności; bez metryk — brak linii")
  func mac() throws {
    #expect(try presentation(Self.full).macLine == "Mac  CPU 35% · RAM 70% · dysk 60%")
    let partial = try presentation(#"{"waiting":0,"working":0,"finished":0,"mac":{"disk":55,"cpu":5},"updatedEpoch":1}"#)
    #expect(partial.macLine == "Mac  CPU 5% · dysk 55%" && partial.mac.map(\.label) == ["CPU", "dysk"])
    let empty = try presentation(#"{"waiting":0,"working":0,"finished":0,"mac":{},"updatedEpoch":1}"#)
    #expect(empty.macLine == nil && empty.mac.isEmpty)
  }

  @Test("słowo maszyny z atrybutów kafla: macOS i brak systemu (kafel sprzed pola) = Mac; Linux, inny, spoza listy = VPS")
  func machineWord() throws {
    let cases: [(ServerSystem?, String)] = [(.macos, "Mac"), (nil, "Mac"), (.linux, "VPS"), (.other, "VPS"), (.unsupported, "VPS")]
    for (system, word) in cases {
      let shown = try presentation(Self.full, machine: RarogActivityAttributes(serverSystem: system).machine)
      #expect(shown.macLine == "\(word)  CPU 35% · RAM 70% · dysk 60%", "\(String(describing: system))")
      #expect(shown.spoken.hasSuffix("\(word): CPU 35%, RAM 70% (wysokie), dysk 60%."), "\(String(describing: system))")
    }
    let empty = try presentation(#"{"waiting":0,"working":0,"finished":0,"updatedEpoch":1}"#, machine: .vps)
    #expect(empty.macLine == nil && !empty.spoken.contains("VPS"), "bez metryk słowa nie ma")
  }

  @Test("atrybuty: kafel zapisany przed polem (`{}`) dekoduje się bez systemu; system wraca; nieznany = unsupported")
  func attributesDecoding() throws {
    let old = try JSONDecoder().decode(RarogActivityAttributes.self, from: Data("{}".utf8))
    #expect(old.serverSystem == nil && old.machine == .mac)
    for system in ServerSystem.allCases {
      let data = try JSONEncoder().encode(RarogActivityAttributes(serverSystem: system))
      #expect(try JSONDecoder().decode(RarogActivityAttributes.self, from: data).serverSystem == system)
    }
    #expect(String(decoding: try JSONEncoder().encode(RarogActivityAttributes()), as: UTF8.self) == "{}", "bez systemu: `{}` jak przed polem")
    let future = try JSONDecoder().decode(RarogActivityAttributes.self, from: Data(#"{"serverSystem":"freebsd"}"#.utf8))
    #expect(future.serverSystem == .unsupported && future.machine == .vps)
    let broken = try JSONDecoder().decode(RarogActivityAttributes.self, from: Data(#"{"serverSystem":3}"#.utf8))
    #expect(broken.serverSystem == nil)
  }

  @Test("progi Maca na kaflu: CPU i RAM 60/80, dysk 80/90; czytnik słyszy próg słowem")
  func macLevels() throws {
    #expect(try presentation(Self.full).mac.map(\.level) == [.normal, .warning, .normal])
    let hot = try presentation(
      #"{"waiting":0,"working":0,"finished":0,"mac":{"cpu":80,"ram":60,"disk":79},"updatedEpoch":1}"#)
    #expect(hot.mac.map(\.level) == [.critical, .warning, .normal])
    #expect(hot.spoken.hasSuffix("Mac: CPU 80% (krytyczne), RAM 60% (wysokie), dysk 79%."))
    func level(_ metric: String, _ percent: Int) throws -> MacLoadLevel? {
      try presentation(#"{"waiting":0,"working":0,"finished":0,"mac":{"\#(metric)":\#(percent)},"updatedEpoch":1}"#)
        .mac.first?.level
    }
    for metric in ["cpu", "ram"] {
      #expect(try level(metric, 59) == .normal && level(metric, 60) == .warning, "\(metric)")
      #expect(try level(metric, 79) == .warning && level(metric, 80) == .critical, "\(metric)")
    }
    #expect(try level("disk", 79) == .normal && level("disk", 80) == .warning && level("disk", 89) == .warning)
    #expect(try level("disk", 90) == .critical)
    let disk = try presentation(#"{"waiting":0,"working":0,"finished":0,"mac":{"disk":95},"updatedEpoch":1}"#)
    #expect(disk.mac.map(\.level) == [.critical] && disk.macLine == "Mac  dysk 95%")
  }

  @Test("cisza: 0/0/0 bez przebiegów — zdanie ciszy; skończona sesja albo przebieg w tle to nie cisza")
  func quiet() throws {
    #expect(try counts(0, 0).quietNote == "kafel zniknie po 30 min ciszy")
    #expect(try counts(0, 1).quietNote == nil && counts(1, 0).quietNote == nil && counts(0, 0, 1).quietNote == nil)
    #expect(try presentation(Self.full).quietNote == nil)
    // Limity i Mac nie przerywają ciszy — to nie praca.
    let quietWithStats = try presentation(
      #"{"waiting":0,"working":0,"finished":0,"limits":{"fiveHour":3},"mac":{"cpu":5},"updatedEpoch":1}"#)
    #expect(quietWithStats.quietNote != nil)
  }

  @Test("zdanie VoiceOvera: liczniki, przebiegi, „+N”, limity i Mac pełnymi słowami")
  func spoken() throws {
    #expect(try counts(0, 0).spoken == "Rarog: nic nie czeka i nic nie pracuje. Kafel zniknie po 30 min ciszy.")
    #expect(try counts(5, 0).spoken == "Rarog: 5 sesji czeka na decyzję.")
    #expect(try counts(0, 2, 1).spoken == "Rarog: nic nie czeka na decyzję, 2 pracują, 1 skończyła.")
    #expect(try presentation(Self.full).spoken == [
      "Rarog: 2 sesje czekają na decyzję, 3 pracują, 4 skończyły",
      "rarog, audyt-ux: faza 2 z 4, Weryfikacja",
      "atlas-web, review-changes: agenci 1 z 3",
      "Jeszcze 1 workflow",
      "Limit planu: 5 godzin 42%, tydzień 81%",
      "Mac: CPU 35%, RAM 70% (wysokie), dysk 60%",
    ].joined(separator: ". ") + ".")
  }

  @Test("nieświeże dane: godzina bezwzględna wyliczenia stanu, VoiceOver słyszy to samo")
  func staleNote() throws {
    let warsaw = try #require(TimeZone(identifier: "Europe/Warsaw"))
    let note = LiveActivityPresentation.staleNote(updatedAt: Date(timeIntervalSince1970: 1_791_367_200), timeZone: warsaw)
    #expect(note == "nieaktualne · stan z 12:00")
    let stale = try counts(1, 0)
    #expect(stale.spokenLabel(isStale: true, timeZone: warsaw)
      == "Rarog: 1 sesja czeka na decyzję. Dane nieaktualne, stan z \(Self.clock(Self.epoch, warsaw)).")
    #expect(stale.spokenLabel(isStale: false, timeZone: warsaw) == stale.spoken)
    // Cisza: zdanie o końcu kafla zostaje także przy nieświeżych danych, ostrzeżenie idzie po nim.
    #expect(try counts(0, 0).spokenLabel(isStale: true, timeZone: warsaw)
      == "Rarog: nic nie czeka i nic nie pracuje. Kafel zniknie po 30 min ciszy. Dane nieaktualne, stan z \(Self.clock(Self.epoch, warsaw)).")
    #expect(try counts(1, 0).updatedAt == Date(timeIntervalSince1970: TimeInterval(Self.epoch)))
  }

  @Test("adres tapnięcia: sesja, terminal Codexa z sesją w zapytaniu, bez sesji — sama apka")
  func link() throws {
    // Tło kafla i zwinięta wyspa: lista agentów, niezależnie od sesji wiodącej.
    let session = try presentation(#"{"waiting":1,"working":0,"finished":0,"top":{"sessionId":"demo-willow"},"updatedEpoch":1}"#)
    #expect(session.link.absoluteString == "rarog://list")
    #expect(try counts(0, 0).link.absoluteString == "rarog://list")
    // Liczby: adres rodzaju, nie sesji — sesję wybiera apka przy otwarciu.
    #expect(LiveActivityPresentation.jumpLink(.waiting).absoluteString == "rarog://jump/waiting")
    #expect(LiveActivityPresentation.jumpLink(.working).absoluteString == "rarog://jump/working")
    #expect(LiveActivityPresentation.jumpLink(.finished).absoluteString == "rarog://jump/finished")
  }

  @Test("prywatność: copy składa się wyłącznie z pól stanu — bez czasu pracy, narzędzia i etykiety")
  func privacy() throws {
    let presentation = try presentation(Self.full)
    var labels: Set<String> = []
    for child in Mirror(reflecting: presentation).children { if let label = child.label { labels.insert(label) } }
    #expect(labels == [
      "tone", "waiting", "working", "finished", "waitingWord", "workingWord", "finishedWord", "count", "limits",
      "workflows", "more", "mac", "macLine", "quietNote", "ring", "link", "spoken", "updatedAt",
    ])
    let words = ([presentation.spoken, presentation.macLine ?? "", presentation.more ?? ""]
      + presentation.workflows.flatMap { [$0.title, $0.progress] }).joined(separator: " ")
    // Id sesji to cel tapnięcia, nie copy.
    #expect(!words.contains("demo-") && !words.contains("zgoda") && !words.contains("pytanie"))
  }
}
