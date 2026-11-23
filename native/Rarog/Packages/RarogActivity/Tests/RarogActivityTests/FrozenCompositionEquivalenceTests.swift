import Foundation
@testable import RarogActivity
import RarogContract
import Testing

// Dowód równoważności kompozycji kafla (`docs/localization.md`, „Proof: Polish unchanged — composition”): kompozycja
// kafla z literałów w kodzie (własne `plural()`, sklejanie członów, `%02d:%02d`, podmiana „nieaktualne · ”
// w zdaniu czytnika, `prefix(1).uppercased()` zdania ciszy) ZAMROŻONA tutaj z dosłownymi polskimi formami i porównana z
// nową kompozycją z kluczy katalogu na tych samych stanach.
@Suite("kafel Live Activity mówi to samo co zamrożona kompozycja z literałów")
struct FrozenCompositionEquivalenceTests {
  static let warsaw = TimeZone(identifier: "Europe/Warsaw")!

  enum Old {
    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
      if n == 1 { return one }
      let mod10 = abs(n) % 10
      let mod100 = abs(n) % 100
      if (2...4).contains(mod10), !(12...14).contains(mod100) { return few }
      return many
    }

    static func clock(_ date: Date, _ zone: TimeZone) -> String {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      let parts = calendar.dateComponents([.hour, .minute], from: date)
      return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    static func staleNote(_ date: Date, _ zone: TimeZone) -> String { "nieaktualne · stan z \(clock(date, zone))" }

    /// Postęp i tytuł przebiegu z gałęzi bazowej (`row`): na kaflu, dla czytnika i tytuł.
    static func row(project: String, name: String, phase: (index: Int, count: Int, title: String)?, done: Int, agents: Int)
      -> (title: String, progress: String, spoken: String)
    {
      let progress: String
      let spokenProgress: String
      if let phase {
        let title = phase.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = !title.isEmpty && title.count <= 24
        progress = "faza \(phase.index)/\(phase.count)" + (named ? " · " + title : "")
        spokenProgress = "faza \(phase.index) z \(phase.count)" + (named ? ", \(title)" : "")
      } else {
        progress = "agenci \(done)/\(agents)"
        spokenProgress = "agenci \(done) z \(agents)"
      }
      return (project + " · " + name, progress, "\(project), \(name): \(spokenProgress)")
    }

    /// `LiveActivityPresentation.spoken` z gałęzi bazowej na liczbach i członach prezentacji; zdania przebiegów — z ``row``.
    static func spoken(_ p: LiveActivityPresentation, more: Int, rows: [String] = []) -> String {
      var parts: [String] = []
      let quiet = p.quietNote != nil
      // Jedyna świadoma różnica wobec gałęzi bazowej: nazwa produktu na początku zdania („Rarog: ”).
      if quiet {
        let note = "kafel zniknie po 30 min ciszy"
        parts.append("Rarog: nic nie czeka i nic nie pracuje")
        parts.append(note.prefix(1).uppercased() + note.dropFirst())
      } else {
        var line = p.waiting == 0
          ? "Rarog: nic nie czeka na decyzję"
          : "Rarog: \(p.waiting) \(plural(p.waiting, "sesja czeka", "sesje czekają", "sesji czeka")) na decyzję"
        if p.working > 0 { line += ", \(p.working) \(plural(p.working, "pracuje", "pracują", "pracuje"))" }
        if p.finished > 0 { line += ", \(p.finished) \(plural(p.finished, "skończyła", "skończyły", "skończyło"))" }
        parts.append(line)
      }
      parts += rows
      if more > 0 { parts.append("Jeszcze \(more) workflow") }
      if !p.limits.isEmpty {
        let windows = p.limits.map { "\($0.window == .fiveHour ? "5 godzin" : "tydzień") \($0.percent)%" }
        parts.append("Limit planu: " + windows.joined(separator: ", "))
      }
      if !p.mac.isEmpty {
        let metrics = p.mac.map { metric in
          let level: String? =
            switch metric.level {
            case .normal: nil
            case .warning: "wysokie"
            case .critical: "krytyczne"
            }
          return "\(metric.label) \(metric.value)" + (level.map { " (\($0))" } ?? "")
        }
        parts.append("Mac: " + metrics.joined(separator: ", "))
      }
      return parts.joined(separator: ". ") + "."
    }
  }

  static func state(_ waiting: Int, _ working: Int, _ finished: Int, extra: String = "") throws -> LiveActivityPresentation {
    let json = #"{"waiting":\#(waiting),"working":\#(working),"finished":\#(finished)\#(extra),"updatedEpoch":1791331200}"#
    return LiveActivityPresentation(
      try JSONDecoder().decode(LiveActivityContentState.self, from: Data(json.utf8)), machine: .mac)
  }

  @Test("słowa liczników i zdanie czytnika: warianty katalogu = zamrożone plural() dla 0–40, 101–125 i dużych liczb")
  func countersAndSpoken() throws {
    let numbers = Array(0...40) + Array(101...125) + [1001, 1002, 12_345]
    var differences: [String] = []
    for waiting in numbers {
      for (working, finished) in [(0, 0), (waiting, 0), (0, waiting), (2, 5), (12, 22), (1, 1)] {
        let p = try Self.state(waiting, working, finished)
        let words = (Old.plural(waiting, "czeka", "czekają", "czeka"), Old.plural(working, "pracuje", "pracują", "pracuje"),
          Old.plural(finished, "skończyła", "skończyły", "skończyło"))
        if (p.waitingWord, p.workingWord, p.finishedWord) != words { differences.append("słowa \(waiting)/\(working)/\(finished)") }
        if p.spoken != Old.spoken(p, more: 0) { differences.append("\(waiting)/\(working)/\(finished): \(p.spoken) ≠ \(Old.spoken(p, more: 0))") }
      }
    }
    #expect(differences.isEmpty, "\(differences.count) różnic: \(differences.prefix(5))")
  }

  @Test("przebiegi, limity, Mac i „+N” w zdaniu czytnika i na kaflu: te same zdania co zamrożona kompozycja")
  func fullTile() throws {
    let extras = [
      #","limits":{"fiveHour":42,"weekly":81}"#, #","mac":{"cpu":35,"ram":70,"disk":95}"#, #","moreWorkflows":3"#,
      #","workflows":[{"sessionId":"a","project":"rarog","name":"audyt-ux","agents":7,"done":3,"phase":{"index":2,"count":4,"title":"Weryfikacja"},"segments":[100,60,0,0]},{"sessionId":"b","project":"atlas","name":"review","agents":3,"done":1,"phase":{"index":1,"count":2,"title":"Tytuł ponad dwadzieścia cztery znaki"},"segments":[33,0]}]"#,
    ]
    let oldRows = [
      Old.row(project: "rarog", name: "audyt-ux", phase: (2, 4, "Weryfikacja"), done: 3, agents: 7),
      Old.row(project: "atlas", name: "review", phase: (1, 2, "Tytuł ponad dwadzieścia cztery znaki"), done: 1, agents: 3),
    ]
    for extra in extras + [extras.joined()] {
      let p = try Self.state(2, 3, 4, extra: extra)
      let more = extra.contains("moreWorkflows") ? 3 : 0
      let rows = extra.contains("workflows") ? oldRows.map(\.spoken) : []
      #expect(p.spoken == Old.spoken(p, more: more, rows: rows), "\(extra)")
      #expect(p.macLine == (p.mac.isEmpty ? nil : "Mac  " + p.mac.map { "\($0.label) \($0.value)" }.joined(separator: " · ")))
    }
    let p = try Self.state(0, 1, 0, extra: extras[3])
    #expect(p.workflows.map(\.progress) == oldRows.map(\.progress))
    #expect(p.workflows.map(\.title) == oldRows.map(\.title))
    let untitled = try Self.state(0, 1, 0, extra: #","workflows":[{"sessionId":"c","project":"p","name":"n","agents":7,"done":3,"segments":[40]}]"#)
    let oldUntitled = Old.row(project: "p", name: "n", phase: nil, done: 3, agents: 7)
    #expect(untitled.workflows.map(\.progress) == [oldUntitled.progress])
    #expect(untitled.spoken == Old.spoken(untitled, more: 0, rows: [oldUntitled.spoken]))
    let limits = try Self.state(0, 0, 0, extra: extras[0]).limits
    #expect(limits.map(\.percentText) == ["42%", "81%"] && limits.map(\.label) == ["limit 5h", "limit 7d"])
  }

  @Test("nieświeże dane: notka i zdanie czytnika co minutę doby — bez podmiany tekstu, to samo zdanie")
  func stale() throws {
    let quiet = try Self.state(0, 0, 0)
    let busy = try Self.state(1, 2, 0)
    let start = Date(timeIntervalSince1970: 1_767_222_000)
    for minute in 0..<(24 * 60) {
      let date = start.addingTimeInterval(TimeInterval(minute * 60))
      let note = LiveActivityPresentation.staleNote(updatedAt: date, timeZone: Self.warsaw, locale: Locale(identifier: "pl_PL"))
      #expect(note == Old.staleNote(date, Self.warsaw))
    }
    for p in [quiet, busy] {
      let old = "\(p.spoken) \(Old.staleNote(p.updatedAt, Self.warsaw).replacing("nieaktualne · ", with: "Dane nieaktualne, "))."
      #expect(p.spokenLabel(isStale: true, timeZone: Self.warsaw, locale: Locale(identifier: "pl_PL")) == old)
    }
  }
}
