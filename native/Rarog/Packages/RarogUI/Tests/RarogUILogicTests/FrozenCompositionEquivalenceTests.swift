import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Composition equivalence proof (`docs/localization.md`, „Proof: Polish unchanged — composition”): the composition
// in code (`PolishPlural`, concatenation, `%02d:%02d`, month abbreviations, `prefix(1).uppercased()`) is FROZEN here,
// with its literal Polish forms, and compared with the catalog composition (plural variants of the catalog,
// sentences with parameters, formatters with the app's locale) on the same data, over wide ranges (numbers 0–300,
// around 1000, 10 000 and millions; every minute of the day; every day of the year). The catalog snapshots check
// the numbers 0, 1, 2, 5, 12, 22, 101; this suite covers the rest, digit grouping included (numbers without grouping).
@Suite("kompozycja katalogu daje te same polskie zdania co zamrożona kompozycja z kodu")
struct FrozenCompositionEquivalenceTests {
  static let numbers: [Int] =
    Array(0...300) + Array(990...1030) + Array(1100...1115) + [2002, 9999, 10_000, 10_001, 10_002, 10_012, 10_022, 12_345]
    + [100_002, 1_000_000, 1_000_001, 1_000_012]

  static let warsaw = TimeZone(identifier: "Europe/Warsaw")!
  static let polish = Locale(identifier: "pl_PL")

  /// Różnice: opis wejścia → (stare, nowe). Pusta lista = zgodne.
  static func diff<T>(_ inputs: [T], _ old: (T) -> String, _ new: (T) -> String) -> [String] {
    inputs.compactMap { input in
      let (a, b) = (old(input), new(input))
      return a == b ? nil : "\(input): stare \(String(reflecting: a)), nowe \(String(reflecting: b))"
    }
  }

  static func check<T>(_ name: String, _ inputs: [T], old: (T) -> String, new: (T) -> String) {
    let found = diff(inputs, old, new)
    #expect(found.isEmpty, "\(name): \(found.count) różnic, np. \(found.prefix(5).joined(separator: "; "))")
  }

  // MARK: Zamrożona kompozycja z kodu

  enum Old {
    static let nb = "\u{00A0}"

    /// `PolishPlural.form` z gałęzi bazowej.
    static func form(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
      if n == 1 { return one }
      let mod10 = abs(n) % 10
      let mod100 = abs(n) % 100
      if (2...4).contains(mod10), !(12...14).contains(mod100) { return few }
      return many
    }

    static func units(_ seconds: Int) -> (Int, Int) {
      let seconds = max(0, seconds)
      if seconds < 60 { return (seconds, 0) }
      let minutes = seconds / 60
      if minutes < 60 { return (minutes, 1) }
      let hours = minutes / 60
      if hours < 24 { return (hours, 2) }
      return (hours / 24, 3)
    }

    static func short(_ seconds: Int) -> String {
      let seconds = max(0, seconds)
      if seconds < 60 { return "\(seconds)\(nb)s" }
      let minutes = seconds / 60
      if minutes < 60 { return "\(minutes)\(nb)min" }
      let hours = minutes / 60
      if hours < 24 { return "\(hours)\(nb)h\(nb)\(String(format: "%02d", minutes % 60))" }
      return "\(hours / 24)\(nb)d"
    }

    static func spoken(_ seconds: Int) -> String {
      let (value, unit) = units(seconds)
      let forms: (String, String, String) =
        switch unit {
        case 0: ("sekunda", "sekundy", "sekund")
        case 1: ("minuta", "minuty", "minut")
        case 2: ("godzina", "godziny", "godzin")
        default: ("dzień", "dni", "dni")
        }
      return "\(value) \(form(value, forms.0, forms.1, forms.2))"
    }

    static func spokenSince(_ seconds: Int) -> String {
      let (value, unit) = units(seconds)
      let forms: (String, String) =
        switch unit {
        case 0: ("sekundy", "sekund")
        case 1: ("minuty", "minut")
        case 2: ("godziny", "godzin")
        default: ("dnia", "dni")
        }
      return "\(value) \(value == 1 ? forms.0 : forms.1)"
    }

    static func ago(_ seconds: Int) -> String {
      let (value, unit) = units(seconds)
      switch unit {
      case 0: return "przed\(nb)chwilą"
      case 1: return "\(value)\(nb)min\(nb)temu"
      case 2: return "\(value)\(nb)h\(nb)temu"
      default: return "\(value)\(nb)d\(nb)temu"
      }
    }

    static func spokenAgo(_ seconds: Int) -> String {
      let (value, unit) = units(seconds)
      guard unit > 0 else { return "przed chwilą" }
      let forms: (String, String, String) =
        switch unit {
        case 1: ("minutę", "minuty", "minut")
        case 2: ("godzinę", "godziny", "godzin")
        default: ("dzień", "dni", "dni")
        }
      return "\(value) \(form(value, forms.0, forms.1, forms.2)) temu"
    }

    static func clock(_ date: Date, _ zone: TimeZone) -> String {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      let parts = calendar.dateComponents([.hour, .minute], from: date)
      return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    static let months = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"]

    static func day(_ date: Date, _ zone: TimeZone) -> String {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      let parts = calendar.dateComponents([.month, .day], from: date)
      return "\(parts.day ?? 0) \(months[max(0, min(11, (parts.month ?? 1) - 1))])"
    }

    static func patterned(_ date: Date, _ pattern: String, _ zone: TimeZone) -> String {
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "pl_PL")
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      formatter.calendar = calendar
      formatter.timeZone = zone
      formatter.dateFormat = pattern
      return formatter.string(from: date)
    }

    static func lead(_ cliDialog: CliDialogClass?) -> String {
      let phrase: String? =
        switch cliDialog {
        case .permission?: "zgoda na narzędzie"
        case .input?: "pytanie albo formularz"
        case .sandbox?: "zgoda na sieć"
        case .worker?: "prośba workera"
        // The one deliberate difference: „dialog CLI”, not „okno komendy CLI”, because the class `dialog open` covers
        // a dozen different dialogs.
        case .dialog?: "dialog CLI"
        case .goal?: "propozycja celu"
        case .other?, nil: nil
        }
      guard let phrase else { return "" }
      return phrase.prefix(1).uppercased() + phrase.dropFirst() + " w terminalu. "
    }

    static func grouped(_ value: Int) -> String {
      let digits = String(value)
      var out = ""
      for (index, char) in digits.enumerated() {
        if index > 0, (digits.count - index) % 3 == 0 { out += nb }
        out.append(char)
      }
      return out
    }

    static func bytes(_ count: Int) -> String {
      let megabyte = 1024 * 1024
      if count >= megabyte {
        let tenths = Int((Double(count) / Double(megabyte) * 10).rounded())
        let text = tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10),\(tenths % 10)"
        return "\(text)\(nb)MB"
      }
      return "\(Int((Double(count) / 1024).rounded()))\(nb)kB"
    }
  }

  // MARK: Liczba mnoga

  @Test("liczniki z odmianą: warianty katalogu = PolishPlural na liczbach 0–300, 1000+, 10 000+ i milionach")
  func countedNouns() {
    let n = Self.numbers
    let nb = Old.nb
    Self.check("filesCount", n, old: { "\($0)\(nb)\(Old.form($0, "plik", "pliki", "plików"))" }, new: UICopy.filesCount)
    Self.check("diffFilesCount", n, old: { "\($0)\(nb)\(Old.form($0, "plik", "pliki", "plików"))" }, new: { UICopy.diffFilesCount($0) })
    Self.check(
      "dirtySpoken", n,
      old: { $0 > 0 ? "\($0) \(Old.form($0, "zmieniony plik", "zmienione pliki", "zmienionych plików"))" : "bez zmian" },
      new: UICopy.dirtySpoken)
    Self.check(
      "dirtyRefreshing", n, old: { "\($0) \(Old.form($0, "zmieniony plik", "zmienione pliki", "zmienionych plików")) — odświeżam listę…" },
      new: UICopy.dirtyRefreshing)
    Self.check("agentsCount", n, old: { "\($0) \(Old.form($0, "agent", "agenty", "agentów"))" }, new: UICopy.agentsCount)
    Self.check("agentsDone", n, old: { "\($0) \(Old.form($0, "skończył", "skończyło", "skończyło"))" }, new: UICopy.agentsDone)
    Self.check("subagentsCount", n, old: { "\($0) \(Old.form($0, "subagent", "subagenty", "subagentów"))" }, new: UICopy.subagentsCount)
    Self.check("workflowRunning", n, old: { "\($0) \(Old.form($0, "pracuje", "pracują", "pracuje"))" }, new: UICopy.workflowRunning)
    Self.check(
      "workflowDoneGroupSpoken", n, old: { "Review: \($0) \(Old.form($0, "skończył", "skończyło", "skończyło"))" },
      new: { UICopy.workflowDoneGroupSpoken(title: "Review", count: $0) })
    Self.check("dirtyFiles", n, old: { "\($0) \(Old.form($0, "zmiana", "zmiany", "zmian"))" }, new: UICopy.dirtyFiles)
    Self.check(
      "openSessions", n, old: { "\($0) \(Old.form($0, "otwarta sesja", "otwarte sesje", "otwartych sesji"))" }, new: UICopy.openSessions)
    Self.check("photos", n, old: { "\($0)\(nb)\(Old.form($0, "zdjęcie", "zdjęcia", "zdjęć"))" }, new: UICopy.photos)
    Self.check("files", n, old: { "\($0)\(nb)\(Old.form($0, "plik", "pliki", "plików"))" }, new: UICopy.files)
    Self.check("noteShowAll", n, old: { "Pokaż całość · \($0)\(nb)\(Old.form($0, "linia", "linie", "linii"))" }, new: { UICopy.noteShowAll(lines: $0) })
    Self.check(
      "promptFoldShow", n, old: { "Pokaż całość · \($0)\(nb)\(Old.form($0, "linia", "linie", "linii"))" },
      new: { UICopy.promptFoldShow(lines: $0) })
    Self.check("tableSpoken", n, old: { "Tabela, \($0)\(nb)\(Old.form($0, "wiersz", "wiersze", "wierszy"))" }, new: { UICopy.tableSpoken(rows: $0) })
    Self.check("diffMore", n, old: { "… jeszcze \($0) \(Old.form($0, "linia", "linie", "linii"))" }, new: UICopy.diffMore)
    Self.check("newPill", n, old: { "\($0) \(Old.form($0, "nowa wiadomość", "nowe wiadomości", "nowych wiadomości"))" }, new: UICopy.newPill)
    Self.check(
      "newPillSpoken", n, old: { "\($0) \(Old.form($0, "nowa wiadomość", "nowe wiadomości", "nowych wiadomości")), przewiń do pierwszej" },
      new: UICopy.newPillSpoken)
    Self.check("agentsSpoken", n, old: { $0 == 1 ? "1 agent" : "agentów: \($0)" }, new: UICopy.agentsSpoken)
    Self.check(
      "questionSpokenHeader", n,
      old: { total in
        guard total > 1 else { return "Pytanie od agenta" }
        let noun = (2...4).contains(total % 10) && !(12...14).contains(total % 100) ? "pytania" : "pytań"
        return "Formularz od agenta, \(total) \(noun)"
      },
      new: { UICopy.questionSpokenHeader(total: $0) })
    Self.check(
      "backgroundSpoken", Array(0...40) + [101, 112, 122],
      old: { count in
        let items = (0..<count).map { "z\($0)" }
        guard count > 0 else { return "Nic nie działa w tle" }
        return "\(count) \(Old.form(count, "zadanie", "zadania", "zadań")) w tle: \(items.joined(separator: ", "))"
      },
      new: { UICopy.backgroundSpoken((0..<$0).map { "z\($0)" }) })
  }

  @Test("człony liczone parami i trójkami: kolejność, rzeczownik przy pierwszym członie, separatory")
  func countedLists() {
    let small = Array(0...24) + [101, 112, 1002, 12_345]
    let pairs = small.flatMap { a in small.map { (a, $0) } }
    Self.check(
      "aheadBehindSpoken", pairs,
      old: { pair in
        let (ahead, behind) = pair
        func commits(_ n: Int, _ what: String) -> String { "\(n) \(Old.form(n, "commit", "commity", "commitów")) \(what)" }
        let parts = [behind > 0 ? commits(behind, "do pobrania") : nil, ahead > 0 ? commits(ahead, "do wypchnięcia") : nil].compactMap { $0 }
        return parts.isEmpty ? "nil" : parts.joined(separator: ", ")
      },
      new: { UICopy.aheadBehindSpoken(ahead: $0.0, behind: $0.1) ?? "nil" })
    Self.check(
      "backgroundSplit", pairs,
      old: { pair in
        var parts: [String] = []
        if pair.0 > 0 { parts.append("\(pair.0)\(Old.nb)\(Old.form(pair.0, "pracuje", "pracują", "pracuje"))") }
        if pair.1 > 0 { parts.append("\(pair.1)\(Old.nb)\(Old.form(pair.1, "czeka", "czekają", "czeka"))") }
        return parts.joined(separator: " · ")
      },
      new: { UICopy.backgroundSplit(working: $0.0, waiting: $0.1) })
    let oldLine = { (added: Int, deleted: Int, forms: (String, String, String, String, String, String)) -> [String] in
      var parts: [String] = []
      if added > 0 { parts.append("\(added) \(Old.form(added, forms.0, forms.1, forms.2))") }
      if deleted > 0 { parts.append("\(deleted) \(Old.form(deleted, forms.3, forms.4, forms.5))") }
      return parts
    }
    let lineForms = ("dodana linia", "dodane linie", "dodanych linii", "usunięta linia", "usunięte linie", "usuniętych linii")
    Self.check(
      "toolSpoken", pairs, old: { (["Edit: a.swift"] + oldLine($0.0, $0.1, lineForms)).joined(separator: ", ") },
      new: { UICopy.toolSpoken(line: "Edit: a.swift", added: $0.0, deleted: $0.1) })
    Self.check(
      "diffFileSpoken", pairs, old: { (["a.swift, zmieniony"] + oldLine($0.0, $0.1, lineForms)).joined(separator: ", ") },
      new: { UICopy.diffFileSpoken(path: "a.swift", status: .modified, added: $0.0, deleted: $0.1) })
    let triples = Array(0...14).flatMap { a in Array(0...14).flatMap { m in [0, 1, 2, 5, 22, 112].map { (a, m, $0) } } }
    Self.check(
      "fileKindsSpoken", triples,
      old: { kinds in
        var parts: [String] = []
        func say(_ n: Int, _ one: String, _ few: String, _ many: String) {
          guard n > 0 else { return }
          let noun = parts.isEmpty ? " " + Old.form(n, "plik", "pliki", "plików") : ""
          parts.append("\(n) \(Old.form(n, one, few, many))\(noun)")
        }
        say(kinds.0, "dodany", "dodane", "dodanych")
        say(kinds.1, "zmieniony", "zmienione", "zmienionych")
        say(kinds.2, "usunięty", "usunięte", "usuniętych")
        return parts.isEmpty ? "nil" : parts.joined(separator: ", ")
      },
      new: { UICopy.fileKindsSpoken(added: $0.0, modified: $0.1, deleted: $0.2) ?? "nil" })
  }

  @Test("czas: krótki, mówiony w trzech przypadkach i „ile temu” — każda skala od sekund po lata")
  func relativeTime() {
    let seconds = Array(0...130) + (0...130).map { $0 * 60 + 7 } + (0...30).map { $0 * 3600 + 125 } + (0...400).map { $0 * 86_400 + 9 }
      + [-30, 3599, 3600, 86_399, 86_400]
    let now = Date(timeIntervalSince1970: 1_761_134_400)
    let since = { (s: Int) in now.addingTimeInterval(-TimeInterval(s)) }
    Self.check("RelativeTime.short", seconds, old: Old.short, new: { RelativeTime.short(since: since($0), now: now) })
    Self.check("RelativeTime.spoken", seconds, old: Old.spoken, new: { RelativeTime.spoken(since: since($0), now: now) })
    Self.check("RelativeTime.spokenSince", seconds, old: Old.spokenSince, new: { RelativeTime.spokenSince(since: since($0), now: now) })
    Self.check("RelativeTime.ago", seconds, old: Old.ago, new: { RelativeTime.ago(since: since($0), now: now) })
    Self.check("RelativeTime.spokenAgo", seconds, old: Old.spokenAgo, new: { RelativeTime.spokenAgo(since: since($0), now: now) })
    Self.check(
      "newSession.spokenAgo", seconds.filter { $0 >= 0 },
      old: { s in
        if s < 60 { return "\(s) \(Old.form(s, "sekunda", "sekundy", "sekund"))" }
        let m = s / 60
        if m < 60 { return "\(m) \(Old.form(m, "minuta", "minuty", "minut"))" }
        let h = m / 60
        if h < 24 { return "\(h) \(Old.form(h, "godzina", "godziny", "godzin"))" }
        return "\(h / 24) \(Old.form(h / 24, "dzień", "dni", "dni"))"
      },
      new: UICopy.spokenAgo)
    Self.check(
      "voiceLimitSpoken", Array(0...7200),
      old: { s in
        let m = max(1, Int((Double(s) / 60).rounded(.up)))
        return "Do końca nagrania \(Old.form(m, "została", "zostały", "zostało")) \(m) \(Old.form(m, "minuta", "minuty", "minut"))."
      },
      new: { UICopy.voiceLimitSpoken(seconds: $0) })
    Self.check(
      "voiceClock", Array(-5...4000),
      old: { s in
        let safe = max(0, s)
        let rest = safe % 60
        return "\(safe / 60):\(rest < 10 ? "0" : "")\(rest)"
      },
      new: UICopy.voiceClock)
  }

  @Test("godzina i daty po polsku: każda minuta doby i każdy dzień roku w dwóch strefach")
  func clockAndDays() {
    let start = Date(timeIntervalSince1970: 1_767_222_000)  // 31 Dec 2025, 23:00 UTC = midnight of 1 Jan 2026 in Warsaw
    let minutes = (0..<(24 * 60)).map { start.addingTimeInterval(TimeInterval($0 * 60)) }
    let days = (0..<366).map { start.addingTimeInterval(TimeInterval($0 * 86_400 + 13 * 3600)) }
    for zone in [Self.warsaw, TimeZone(identifier: "Pacific/Auckland")!] {
      Self.check("ServerTime.clock \(zone.identifier)", minutes, old: { Old.clock($0, zone) },
        new: { ServerTime.clock($0, timeZone: zone, locale: Self.polish) })
      Self.check("ServerTime.day \(zone.identifier)", days, old: { Old.day($0, zone) }, new: { ServerTime.day($0, timeZone: zone, locale: Self.polish) })
      Self.check("TimeGap.day \(zone.identifier)", days, old: { Old.patterned($0, "EEE d MMM", zone) }, new: {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return TimeGap.day($0, calendar: calendar, locale: Self.polish)
      })
      // Screen reader sentence of the separator: the frozen side capitalises a lowercase date with
      // `prefix(1).uppercased()`, the catalog side takes the sentence-start form from the formatter — the same
      // sentence for every weekday and month.
      Self.check("TimeGap.spokenDay → timeGapSpoken \(zone.identifier)", days,
        old: { date in
          let day = Old.patterned(date, "EEEE, d MMMM", zone)
          return "\(day.prefix(1).uppercased() + day.dropFirst()), od 08:15"
        },
        new: { date in
          var calendar = Calendar(identifier: .gregorian)
          calendar.timeZone = zone
          return UICopy.timeGapSpoken(TimeMark(day: nil, spokenDay: TimeGap.spokenDay(date, calendar: calendar, locale: Self.polish), clock: "08:15"))
        })
      Self.check("dayClock \(zone.identifier)", days, old: { "\(Old.day($0, zone)) \(Old.clock($0, zone))" },
        new: { ServerTime.dayClock($0, timeZone: zone, locale: Self.polish) })
      let now = days[200]
      Self.check("GitChangesModel.commitWhen \(zone.identifier)", days + [start.addingTimeInterval(-90 * 86_400)],
        old: { date in
          var calendar = Calendar(identifier: .gregorian)
          calendar.timeZone = zone
          let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
          let month = Old.months[max(0, min(11, (parts.month ?? 1) - 1))]
          guard calendar.component(.year, from: now) == parts.year else { return "\(parts.day ?? 0) \(month) \(parts.year ?? 0)" }
          return "\(parts.day ?? 0) \(month) " + String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        },
        new: { date in
          GitChangesModel.commitWhen(date.formatted(.iso8601), now: now, timeZone: zone, locale: Self.polish) ?? "nil"
        })
      Self.check("PlanUsageModel.resetClock \(zone.identifier)", Array(days.prefix(40) + minutes.prefix(90)),
        old: { date in
          var calendar = Calendar(identifier: .gregorian)
          calendar.timeZone = zone
          let clock = Old.clock(date, zone)
          guard !calendar.isDate(date, inSameDayAs: start) else { return clock }
          let parts = calendar.dateComponents([.month, .day], from: date)
          return String(format: "%02d.%02d", parts.day ?? 0, parts.month ?? 0) + Old.nb + clock
        },
        new: { PlanUsageModel.resetClock($0, now: start, timeZone: zone, locale: Self.polish) })
    }
  }

  @Test("zdania z parametrami zamiast sklejania: te same zdania przy tych samych danych")
  func sentences() {
    for cliDialog in [nil] + CliDialogClass.allCases.map(Optional.some) {
      for text in ["", "Nie znam opcji.", "⟦t⟧"] {
        #expect(UICopy.cliDialogText(cliDialog, then: text) == Old.lead(cliDialog) + text, "\(String(describing: cliDialog))")
      }
    }
    let rails: [(done: Int, total: Int)?] = [nil, (0, 3), (1, 3), (3, 3)]
    let tallies: [[String]] = [[], ["16 skończyło"], ["1 pracuje"], ["16 skończyło", "1 pracuje"]]
    for rail in rails {
      for tally in tallies {
        let joined = tally.joined(separator: " · ")
        let oldSummary = [rail.map { "\($0.done)/\($0.total) faz" } ?? "", joined].filter { !$0.isEmpty }.joined(separator: " · ")
        #expect(UICopy.workflowSummary(rail: rail, tally: tally) == oldSummary)
        for sentence in ["", "Faza A: #1 skończył"] {
          var head: [String] = []
          if let rail { head.append("skończone fazy \(rail.done) z \(rail.total)") }
          if !joined.isEmpty { head.append(joined.replacingOccurrences(of: " · ", with: ", ")) }
          let lead = "Przebieg workflow: \(head.joined(separator: ", "))"
          #expect(UICopy.workflowSummarySpoken(rail: rail, tally: tally, sentence: sentence) == (sentence.isEmpty ? lead : "\(lead). \(sentence)"))
        }
      }
    }
    #expect(UICopy.inspectorChangesClean("7cdfbe4b") == "Czysto od" + " " + "7cdfbe4b")
    Self.check("noteCounter", Array(stride(from: 0, through: 120_000, by: 7)), old: { "\(Old.grouped($0)) / \(Old.grouped(NotesRules.maxUnits))" },
      new: UICopy.noteCounter)
    Self.check("bytes", Array(stride(from: 0, through: 30 * 1024 * 1024, by: 9_973)) + [1_048_576, 1_101_005, 2_202_009],
      old: Old.bytes, new: UICopy.bytes)
  }

  /// Nowe testy liczby mnogiej: polska kategoria z wariantów katalogu dla liczb z różnych reguł — 12–14 i 112
  /// to „many” mimo końcówki 2–4, 21 i 101 to „many” mimo końcówki 1, 22 — „few”.
  @Test(
    "liczba mnoga z katalogu: 0, 1, 2, 5, 12, 21, 22, 25, 101, 112",
    arguments: [
      (0, "0\u{00A0}plików", "0 minut temu"), (1, "1\u{00A0}plik", "1 minutę temu"), (2, "2\u{00A0}pliki", "2 minuty temu"),
      (5, "5\u{00A0}plików", "5 minut temu"), (12, "12\u{00A0}plików", "12 minut temu"), (21, "21\u{00A0}plików", "21 minut temu"),
      (22, "22\u{00A0}pliki", "22 minuty temu"), (25, "25\u{00A0}plików", "25 minut temu"), (101, "101\u{00A0}plików", "101 minut temu"),
      (112, "112\u{00A0}plików", "112 minut temu"),
    ])
  func polishPlural(count: Int, files: String, ago: String) {
    #expect(UICopy.filesCount(count) == files)
    #expect(L("format.spokenAgo.minutes", language: .pl, count) == ago)
  }
}
