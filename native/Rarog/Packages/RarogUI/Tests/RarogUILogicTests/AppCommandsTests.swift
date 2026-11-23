import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Komendy apki: rozpoznanie całego tekstu pola, lista podpowiedzi scalona z listą serwera i droga
// `/model`/`/effort` spójna z pigułką modelu. „Wyślij” w polu z fokusem: `RarogUIKitTests` (`AppCommandsUIKitTests`).
// Właściciel: pole.

@Suite("komendy apki: /model i /effort otwierają dymek modelu, /usage arkusz „Limity” (AppCommand)")
struct AppCommandsTests {
  @Test("rozpoznanie: cały tekst to /model, /effort albo /usage (i aliasy), bez względu na wielkość liter, z argumentem")
  func recognize() {
    for text in ["/model", "/MODEL", "/Model", "  /model", "\u{FEFF}\n/model", "/model opus", "/model\nopus",
      "/model\u{3000}opus", "/model ", "\t/model  sonnet[1m] "] {
      #expect(AppCommand.recognize(text)?.action == .modelSheet, "\(text.debugDescription)")
      #expect(AppCommand.recognize(text)?.name == "model")
    }
    #expect(AppCommand.recognize("/effort")?.name == "effort")
    #expect(AppCommand.recognize("/Effort high")?.action == .modelSheet)
    // `/usage` i aliasy CLI `/cost`, `/stats` — ta sama komenda apki (arkusz „Limity”).
    for text in ["/usage", "/Usage", " /USAGE teraz", "/cost", "/Cost", "/stats", "/stats\n"] {
      #expect(AppCommand.recognize(text)?.action == .usageSheet, "\(text.debugDescription)")
      #expect(AppCommand.recognize(text)?.name == "usage")
    }
    for text in ["/modelx", "/mode", "/models", "/effort-x", "model", "tekst /model", "/", "", "/ model", "//model",
      "\u{85}/model", "/model:x", "/usage-credits", "/usa", "/costs", "/stat", "usage", "/usage:x"] {
      #expect(AppCommand.recognize(text) == nil, "\(text.debugDescription) idzie zwykłą ścieżką")
    }
  }

  @Test("jedna lista: nazwy bez ukośnika, małymi literami, bez powtórzeń")
  func list() {
    #expect(AppCommand.all.map(\.name) == ["model", "effort", "usage"])
    for command in AppCommand.all {
      for name in command.names {
        #expect(name == name.lowercased() && !name.hasPrefix("/"))
        #expect(AppCommand.recognize("/\(name)") == command)
      }
    }
    let names = AppCommand.all.flatMap(\.names)
    #expect(Set(names).count == names.count, "nazwy i aliasy bez powtórzeń")
    #expect(AppCommand.all.first { $0.name == "usage" }?.aliases == ["cost", "stats"])
  }

  @Test("podpowiedzi: komendy apki wchodzą po nazwie między komendy serwera, kolejność serwera nietknięta")
  func merged() {
    let server = [
      CommandChoice(name: "clear", kind: .local, source: .builtin),
      CommandChoice(name: "compact", kind: .local, source: .builtin),
      CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Zrzut stanu"),
      CommandChoice(name: "Model", kind: .local, source: .skill),
      CommandChoice(name: "plan", kind: .local, source: .builtin),
      CommandChoice(name: "pr-review-toolkit:review-pr", kind: .prompt, source: .plugin),
      CommandChoice(name: "stats", kind: .local, source: .skill),
    ]
    let list = AppCommand.merged(with: server)
    #expect(list.map(\.name)
      == ["clear", "compact", "effort", "handoff", "model", "plan", "pr-review-toolkit:review-pr", "usage"],
      "wpis serwera o nazwie albo aliasie komendy apki ustępuje (wielkość liter się nie liczy); aliasów na liście nie ma")
    #expect(list.first { $0.name == "handoff" } == server[2], "wpisy serwera bez zmian")
    let model = list.first { $0.name == "model" }
    #expect(model?.description == "w apce · Model i effort")
    #expect(model?.argumentHint == nil)
    #expect(list.first { $0.name == "effort" }?.description == UICopy.appCommandNote(.modelSheet))
    #expect(list.first { $0.name == "usage" }?.description == "w apce · Limity")
    #expect(AppCommand.merged(with: []).map(\.name) == ["effort", "model", "usage"], "bez listy serwera same komendy apki")
    #expect(CommandSuggestions.filter(list, prefix: "us").map(\.name) == ["usage"])
    #expect(CommandSuggestions.filter(list, prefix: "co").map(\.name) == ["compact"], "alias /cost nie stoi na liście")
    #expect(CommandSuggestions.filter(list, prefix: "mo").map(\.name) == ["model"], "filtr prefiksem jak dla reszty")
  }

  @Test("droga /model: dymek jak po stuknięciu w pigułkę; zablokowany i bez pigułki — tekst zostaje")
  func route() {
    let idle = Sample.session(state: "waiting-input")
    #expect(AppCommand.modelSheetRoute(Sample.state(session: idle), sessionId: "s1") == .open(clearsField: true))
    let known = Sample.session(state: "waiting-input", extra: #""model":"claude-opus-5-5","effort":"xhigh""#)
    #expect(AppCommand.modelSheetRoute(Sample.state(session: known), sessionId: "s1") == .open(clearsField: true))

    // Tura: pigułka otwiera dymek z jednym zdaniem dlaczego i „Zamknij” — komenda też, ale pole zostaje.
    let running = Sample.state(session: Sample.session(state: "running"))
    #expect(running.modelChangeReason(for: "s1") == UICopy.modelBusy)
    #expect(AppCommand.modelSheetRoute(running, sessionId: "s1") == .open(clearsField: false))
    var stale = Sample.state(session: idle)
    stale.listCache.awaitingTranscripts = ["s1"]
    #expect(AppCommand.modelSheetRoute(stale, sessionId: "s1") == .open(clearsField: false))

    // Bez pigułki nie ma dymku: zdanie pod polem.
    let codex = Sample.state(session: Sample.session(state: "waiting-input", extra: #""engine":"codex""#))
    #expect(AppCommand.modelSheetRoute(codex, sessionId: "s1") == .explain(UICopy.modelBlock(.codex)))
    #expect(AppCommand.modelSheetRoute(Sample.state(session: idle), sessionId: "zzz") == .explain(UICopy.staleAction))
  }
}
