import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Notki harnessu: zdanie z faktów serwera i wiersz zamiast dymka „ty". Właściciel: notki i miniatury.

/// Wiadomość z notką harnessu tak, jak przychodzi od serwera: rola `user`, surowy wpis w blokach.
private func noticeMessage(seq: Int, notice: String, raw: String = "wpis harnessu") -> TranscriptMessage {
  let at = Sample.iso(100 - Double(seq))
  return Sample.decode(TranscriptMessage.self, #"""
    {"seq":\#(seq),"role":"user","blocks":\#(Sample.text(raw)),"at":"\#(at)","notice":\#(notice)}
    """#)
}

private func notice(_ json: String) -> TranscriptNotice {
  Sample.decode(TranscriptNotice.self, json)
}

@Suite("notki harnessu: zdanie z faktów serwera")
struct HarnessNoticeCopyTests {
  @Test("komenda: skończona z kodem, nieudana z ⚠, zatrzymana bez kodu, bez wyniku ≠ sukces")
  func command() {
    let done = UICopy.harnessNotice(notice(#"{"kind":"command","outcome":"done","name":"pnpm test","exitCode":0}"#))
    #expect(done.text == "Komenda w tle skończyła się (kod 0) — „pnpm test”. Pełny wynik w terminalu.")
    #expect(done.tone == .quiet)
    let failed = UICopy.harnessNotice(notice(#"{"kind":"command","outcome":"failed","name":"e2e","exitCode":1}"#))
    #expect(failed.text == "Komenda w tle NIE powiodła się (kod 1) — „e2e”. Pełny wynik w terminalu.")
    #expect(failed.tone == .failure)
    let halted = UICopy.harnessNotice(notice(#"{"kind":"command","outcome":"halted","name":"watch","exitCode":143}"#))
    #expect(halted.text == "Komenda w tle zatrzymana — „watch”. Pełny wynik w terminalu.")
    #expect(halted.tone == .quiet, "zatrzymanie to nie awaria")
    let unknown = UICopy.harnessNotice(notice(#"{"kind":"command"}"#))
    #expect(unknown.text == "Koniec komendy w tle, wynik nieznany. Pełny wynik w terminalu.")
    #expect(unknown.tone == .quiet)
  }

  @Test("subagent i workflow: trzy wyniki i brak wyniku; kod wyjścia tylko z danych")
  func agentAndWorkflow() {
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"done","name":"przegląd"}"#)).text
      == "Subagent skończył — „przegląd”. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"halted"}"#)).text
      == "Subagent zatrzymany. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"failed"}"#)) == (
      "Subagent NIE powiódł się. Pełny wynik w terminalu.", .failure))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent"}"#)).text == "Koniec subagenta, wynik nieznany. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"workflow","outcome":"done","name":"audyt"}"#)).text
      == "Workflow w tle skończył — „audyt”. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"workflow","outcome":"failed"}"#)).tone == .failure)
  }

  @Test("postój subagenta: „czeka na własne zadanie w tle”, spokojnie, bez „skończył”, kodu i odsyłacza do terminala")
  func waitingAgent() {
    let named = UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"waiting","name":"wspólne widoki"}"#))
    #expect(named == ("Subagent czeka na własne zadanie w tle — „wspólne widoki”.", .quiet))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"waiting"}"#)).text
      == "Subagent czeka na własne zadanie w tle.")
    // Postój nie ma kodu wyjścia; gdyby przyszedł, zdanie go nie niesie.
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"waiting","name":"x","exitCode":0}"#)).text
      == "Subagent czeka na własne zadanie w tle — „x”.")
    #expect(UICopy.harnessNoticeSpoken(named.text, tone: named.tone) == named.text, "czytnik: bez „Uwaga”")
  }

  @Test("`waiting` przy rodzaju innym niż subagent: zdanie jak przy braku wyniku, apka nie wymyśla postoju")
  func waitingOtherKinds() {
    for kind in ["command", "workflow", "monitor-end", "unknown"] {
      let waiting = UICopy.harnessNotice(notice(#"{"kind":"\#(kind)","outcome":"waiting","name":"x","exitCode":3}"#))
      let unknown = UICopy.harnessNotice(notice(#"{"kind":"\#(kind)","name":"x","exitCode":3}"#))
      #expect(waiting == unknown, "\(kind)")
      #expect(!waiting.text.contains("czeka"), "\(kind)")
    }
    // Zdarzenie monitora i sierota wyniku nie czytają wcale.
    #expect(UICopy.harnessNotice(notice(#"{"kind":"monitor-event","outcome":"waiting","name":"log"}"#))
      == ("Monitor zgłosił zdarzenie — „log”.", .quiet))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"orphan","outcome":"waiting"}"#)).tone == .warning)
  }

  @Test("monitor, sierota i kształt nieznany (także nieznany rodzaj z drutu) — nigdy pustka")
  func otherKinds() {
    #expect(UICopy.harnessNotice(notice(#"{"kind":"monitor-event","name":"log"}"#)) == ("Monitor zgłosił zdarzenie — „log”.", .quiet))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"monitor-end","outcome":"done"}"#)).text == "Monitor zakończył nasłuch.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"monitor-end","outcome":"failed","exitCode":2}"#))
      == ("Monitor zakończył nasłuch z błędem (kod 2).", .failure))
    let orphan = UICopy.harnessNotice(notice(#"{"kind":"orphan"}"#))
    #expect(orphan == ("Po restarcie CLI brak zapisu ukończenia zadań w tle — szczegóły w terminalu.", .warning))
    // Rodzaj nierozpoznany mówi o zadaniu w tle, jak `failed` i `halted`; bez wyniku nie twierdzi, że się udało.
    #expect(UICopy.harnessNotice(notice(#"{"kind":"unknown"}"#)).text
      == "Koniec zadania w tle, wynik nieznany. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"unknown","outcome":"done"}"#)).text
      == "Zadanie w tle skończyło się. Pełny wynik w terminalu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"z-przyszlosci","outcome":"inny","name":"x"}"#))
      == ("Koniec zadania w tle, wynik nieznany — „x”. Pełny wynik w terminalu.", .quiet))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"unknown","outcome":"failed"}"#)).tone == .failure)
  }

  @Test("koniec obserwacji artefaktu: cicha linia z tytułem, bez tytułu forma ogólna; wynik i kod nie grają")
  func artifactWatch() {
    let named = UICopy.harnessNotice(notice(#"{"kind":"artifact-watch","name":"Raport kwartalny"}"#))
    #expect(named == ("Koniec obserwacji artefaktu „Raport kwartalny”.", .quiet))
    #expect(UICopy.harnessNoticeSpoken(named.text, tone: named.tone) == named.text, "czytnik: bez „Uwaga”")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"artifact-watch"}"#)) == ("Koniec obserwacji artefaktu.", .quiet))
    #expect(UICopy.harnessNotice(notice(#"{"kind":"artifact-watch","name":""}"#)).text == "Koniec obserwacji artefaktu.")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"artifact-watch","outcome":"failed","name":"x","exitCode":1}"#))
      == ("Koniec obserwacji artefaktu „x”.", .quiet))
  }

  @Test("czytnik słyszy ostrzeżenie słowem; pusta nazwa nie daje cudzysłowu")
  func spoken() {
    #expect(UICopy.harnessNoticeSpoken("x", tone: .failure) == "Uwaga: x")
    #expect(UICopy.harnessNoticeSpoken("x", tone: .warning) == "Uwaga: x")
    #expect(UICopy.harnessNoticeSpoken("x", tone: .quiet) == "x")
    #expect(UICopy.harnessNotice(notice(#"{"kind":"agent","outcome":"done","name":""}"#)).text
      == "Subagent skończył. Pełny wynik w terminalu.")
  }
}

@Suite("wiersze: notka harnessu zamiast dymka „ty”")
struct HarnessNoticeRowsTests {
  @Test("notka = jedna cicha linia z głosem „system”, bez surowego wpisu; następny prompt znów „ty”")
  func noticeRow() {
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text("Puść testy w tle")),
      noticeMessage(seq: 2, notice: #"{"kind":"command","outcome":"done","name":"pnpm test","exitCode":0}"#),
      noticeMessage(seq: 3, notice: #"{"kind":"command","outcome":"failed","exitCode":1}"#),
      Sample.message(seq: 4, role: "user", blocks: Sample.text("Co poszło nie tak?")),
    ]
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1", calendar: Sample.calendar)
    #expect(rows == [
      .text(id: "m1.0", role: .user, voice: .user, markdown: "Puść testy w tle", turn: Sample.prompt(messages[0].at)),
      .harnessNotice(HarnessNoticeModel(
        id: "m2.n", voice: .system, text: "Komenda w tle skończyła się (kod 0) — „pnpm test”. Pełny wynik w terminalu.",
        tone: .quiet, turn: TurnMark(gap: .afterPrompt))),
      .harnessNotice(HarnessNoticeModel(
        id: "m3.n", voice: nil, text: "Komenda w tle NIE powiodła się (kod 1). Pełny wynik w terminalu.", tone: .failure)),
      // Notka z surową rolą `user` nie zaczyna tury; prompt po niej — tak.
      .text(id: "m4.0", role: .user, voice: .user, markdown: "Co poszło nie tak?", turn: Sample.prompt(messages[3].at, gap: .turn)),
    ])
    #expect(!rows.contains { $0.id.hasPrefix("m2.0") || $0.id.hasPrefix("m3.0") }, "surowy wpis nie ma wiersza")
  }

  @Test("postój subagenta w transkrypcie: jedna cicha linia notki, bez surowego wpisu")
  func waitingNoticeRow() {
    let messages = [
      Sample.message(seq: 1, role: "assistant", blocks: Sample.text("Puszczam przegląd w tle.")),
      noticeMessage(seq: 2, notice: #"{"kind":"agent","outcome":"waiting","name":"przegląd"}"#),
    ]
    let rows = TranscriptRows.build(state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1")
    #expect(rows.map(\.id) == ["m1.0", "m2.n"])
    guard case let .harnessNotice(model)? = rows.last else {
      Issue.record("notka o postoju nie dała wiersza notki: \(String(describing: rows.last))")
      return
    }
    #expect(model.text == "Subagent czeka na własne zadanie w tle — „przegląd”." && model.tone == .quiet)
  }

  @Test("rola efektywna: notka to głos systemu, nie prompt człowieka; zwykła wiadomość bez zmian")
  func effectiveRole() {
    let note = noticeMessage(seq: 1, notice: #"{"kind":"orphan"}"#)
    #expect(note.role == .user && note.effectiveRole == .system && !note.isHumanPrompt)
    let prompt = Sample.message(seq: 2, role: "user", blocks: Sample.text("a"))
    #expect(prompt.effectiveRole == .user && prompt.isHumanPrompt)
    #expect(!Sample.message(seq: 3, role: "assistant", blocks: Sample.text("b")).isHumanPrompt)
  }

  @Test("notka stoi pod znacznikiem godziny jak każda wiadomość; nie łapie się w serię agenta")
  func noticeBetweenAgentMessages() {
    let messages = [
      Sample.message(seq: 1, role: "assistant", blocks: Sample.text("Puszczam w tle.")),
      noticeMessage(seq: 2, notice: #"{"kind":"agent","outcome":"halted"}"#),
      Sample.message(seq: 3, role: "assistant", blocks: Sample.text("Wracam.")),
    ]
    let rows = TranscriptRows.build(state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1")
    // Notka (surowa rola `user`) przerywa serię agenta: odpowiedź po niej zaczyna się z głosem agenta.
    #expect(rows.map(\.id) == ["m1.0", "m2.n", "m3.0"])
    #expect(rows[2] == .text(id: "m3.0", role: .assistant, voice: .assistant, markdown: "Wracam."))
  }
}
