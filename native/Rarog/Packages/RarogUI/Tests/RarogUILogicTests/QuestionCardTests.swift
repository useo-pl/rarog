import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Karta pytania: model z pól serwera, szkic odpowiedzi, klawisze, okno
// potwierdzenia i wiersze transkryptu. Właściciel: karty pytań.

private enum Q {
  /// Jedno pytanie z ekranu (karta odpowiadana cyfrą): chrome CLI, opcja eskalująca, rekomendacja.
  static let screen = #"""
    {"qId":"screen:q:1","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,
     "questions":[{"question":"Jak traktować zgody?\nDruga linia.","header":"Testy","multiSelect":false,"options":[
       {"label":"Tylko ten raz","description":"Zgoda na jedno uruchomienie.","role":"answer"},
       {"label":"Yes, and don't ask again","terminalOnly":true,"role":"answer"},
       {"label":"Za każdym razem (Recommended)","role":"answer"},
       {"label":"Wpisz coś.","role":"custom"},
       {"label":"Wyjście","role":"exit"}]}]}
    """#

  /// Formularz z pliku: dwa pytania, drugie wielokrotnego wyboru, pole własnej odpowiedzi.
  static let form = #"""
    {"qId":"q2","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":true,
     "questions":[
      {"question":"Gdzie trzymamy ramki?","header":"Fixtures","multiSelect":false,"options":[
        {"label":"shared/fixtures/sse","role":"answer"},{"label":"server/test/fixtures","role":"answer"}]},
      {"question":"Które klienty?","header":"Klienci","multiSelect":true,"options":[
        {"label":"PWA"},{"label":"Swift"}]}]}
    """#

  /// Jedno pytanie jednokrotnego wyboru z podanym nagłówkiem CLI (jak scenariusz demo `question`).
  static func single(header: String) -> String {
    #"""
    {"qId":"q1","sessionId":"s1","createdAt":"\#(Sample.iso(5))",
     "questions":[{"question":"Jak odebrać M1?","header":"\#(header)","multiSelect":false,"options":[
       {"label":"Sprawdź aplikację","description":"Zwykła odpowiedź"}]}]}
    """#
  }

  static func request(_ json: String) -> QuestionRequest { Sample.decode(QuestionRequest.self, json) }

  static func card(_ json: String) -> QuestionCardModel { QuestionCardModel.make(request(json)) }

  static func state(_ questions: [String]) -> AppState {
    var state = Sample.state(session: Sample.session(state: "waiting-question"))
    state.transcripts["s1"]?.pendingQuestions = questions.map(request)
    return state
  }

  static func cards(_ rows: [TranscriptRow]) -> [QuestionCardModel] {
    rows.compactMap { if case let .question(card) = $0 { card } else { nil } }
  }
}

@Suite("karta pytania: model z pól serwera")
struct QuestionCardModelTests {
  @Test("chrome CLI po roli odpada, rekomendacja na górze ze słowem, opcja terminalowa z kreską, wyjście dosłownie")
  func screenCard() {
    let card = Q.card(Q.screen)
    let options = card.sections[0].options
    #expect(options.map(\.label) == ["Za każdym razem (Recommended)", "Tylko ten raz", "Yes, and don't ask again"])
    #expect(options.map(\.key) == ["1", "2", "–"])
    #expect(options.map(\.recommended) == [true, false, false])
    #expect(options.map(\.selectable) == [true, true, false])
    #expect(options[1].description == "Zgoda na jedno uruchomienie.")
    #expect(card.exitLabel == "Wyjście")
    #expect(card.instant, "jedno pytanie jednokrotnego wyboru bez pola = tapnięcie wysyła")
    #expect(!card.hasSubmit)
    #expect(card.sections[0].head == "", "nagłówek CLI stoi w etykiecie karty, nie w drugiej linii")
    #expect(card.sections[0].question == "Jak traktować zgody?\nDruga linia.", "podziały wierszy zostają")
    #expect(card.eyebrow == "pytanie · Testy")
    #expect(card.spokenHeader == "Pytanie od agenta, Testy")
  }

  @Test("jedno pytanie: jedna linia etykiety „pytanie · nagłówek”, bez linii sekcji; pusty nagłówek = „pytanie”")
  func singleQuestionLabel() {
    let card = Q.card(Q.single(header: "Odbiór M1"))
    #expect(card.eyebrow == "pytanie · Odbiór M1")
    #expect(card.sections.map(\.head) == [""], "linia sekcji pusta")
    #expect(card.spokenHeader == "Pytanie od agenta, Odbiór M1")

    let bare = Q.card(Q.single(header: ""))
    #expect(bare.eyebrow == "pytanie")
    #expect(bare.sections.map(\.head) == [""])
    #expect(bare.spokenHeader == "Pytanie od agenta")

    // Długi nagłówek nie jest przycinany w modelu: zawija go widok (zegar ma stałą szerokość obok).
    let long = String(repeating: "Nagłówek ", count: 9).trimmingCharacters(in: .whitespaces)
    #expect(long.count >= 80)
    let wide = Q.card(Q.single(header: long))
    #expect(wide.eyebrow == "pytanie · \(long)")
    #expect(wide.spokenHeader == "Pytanie od agenta, \(long)")

    // Ta sama karta w innym etapie (trzymana potwierdzeniem) niesie tę samą etykietę i głos.
    let held = card.with(phase: .sent(QuestionAnswered(answers: [["Sprawdź aplikację"]])), held: true)
    #expect(held.eyebrow == card.eyebrow && held.spokenHeader == card.spokenHeader)
  }

  @Test("dwa pytania: etykieta karty „pytanie”, numeracja w liniach sekcji bez zmian")
  func formLabelUnchanged() {
    let card = Q.card(Q.form)
    #expect(card.eyebrow == "pytanie")
    #expect(card.sections.map(\.head) == ["pytanie 1/2 · Fixtures", "pytanie 2/2 · Klienci"])
    #expect(card.spokenHeader == "Formularz od agenta, 2 pytania")
  }

  @Test("formularz: sekcje „pytanie N/M · nagłówek”, pole własnej odpowiedzi, „Odpowiedz”, bez wyjścia")
  func form() {
    let card = Q.card(Q.form)
    #expect(card.sections.map(\.head) == ["pytanie 1/2 · Fixtures", "pytanie 2/2 · Klienci"])
    #expect(card.sections.map(\.customAnswer) == [true, true])
    #expect(card.sections.map(\.multiSelect) == [false, true])
    #expect(!card.instant && card.hasSubmit)
    #expect(card.exitLabel == nil)
    #expect(card.spokenHeader == "Formularz od agenta, 2 pytania")
    #expect(UICopy.questionSpokenHeader(total: 5) == "Formularz od agenta, 5 pytań")
    #expect(UICopy.questionSpokenHeader(total: 22) == "Formularz od agenta, 22 pytania")
  }

  @Test("rekomendacja: sufiks na końcu etykiety, po polsku i angielsku, bez względu na wielkość liter")
  func recommended() {
    #expect(QuestionCardModel.isRecommended("SQLite (Recommended)"))
    #expect(QuestionCardModel.isRecommended("SQLite (rekomendacja)."))
    #expect(!QuestionCardModel.isRecommended("(Recommended) SQLite"))
    #expect(!QuestionCardModel.isRecommended("SQLite"))
  }

  @Test("karta zablokowana i karta w drodze nie przyjmują gestu ani klawisza")
  func interactive() {
    let request = Q.request(Q.form)
    #expect(QuestionCardModel.make(request).interactive)
    #expect(!QuestionCardModel.make(request, locked: "herdr tylko do odczytu").interactive)
    #expect(!QuestionCardModel.make(request, phase: .sending(QuestionAnswered(answers: [["PWA"]]))).interactive)
  }

  /// A layer 2 card as the server sends it (one question, `header` = block title, `question` = the
  /// whole literal block from title to footer, `options` = the button labels, no `terminalOnly`, no `customAnswer`).
  @Test("layer 2 card: the section carries all 15 lines of the block verbatim, the tap sends")
  func layer2WholeBlock() throws {
    let lines = [
      "Switch model?",
      "",
      "  Switching from Opus 5.5 to Sonnet 5.5 mid-conversation",
      "  clears the prompt cache for this session.",
      "",
      "  The next reply re-reads the whole conversation:",
      "    - about 180k tokens of context",
      "    - billed at the input rate of the new model",
      "",
      "  You can switch back with /model at any time.",
      "",
      "  ❯ 1. Yes, switch to Sonnet 5.5",
      "    2. No, go back",
      "",
      "  Enter to confirm · Esc to cancel",
    ]
    #expect(lines.count == 15)
    let block = lines.joined(separator: "\n")
    let labels = ["Yes, switch to Sonnet 5.5", "No, go back", "Esc to cancel"]
    let payload: [String: Any] = [
      "qId": "layer2:s1:7", "sessionId": "s1", "createdAt": Sample.iso(5),
      "questions": [[
        "question": block, "header": "Switch model?", "multiSelect": false,
        "options": labels.map { ["label": $0] },
      ]],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let json = try #require(String(data: data, encoding: .utf8))
    let card = Q.card(json)
    let section = try #require(card.sections.first)
    #expect(card.sections.count == 1)
    #expect(section.question == block, "the whole block, not its title or first line")
    #expect(section.question.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) == lines)
    #expect(section.options.map(\.label) == labels)
    #expect(section.options.map(\.key) == ["1", "2", "3"])
    #expect(section.options.map(\.selectable) == [true, true, true])
    #expect(card.instant, "one single-choice question without a custom answer: the tap sends")
    #expect(card.eyebrow.hasSuffix("Switch model?"))
  }
}

@Suite("karta pytania: szkic, klawisze, wysyłka")
struct QuestionDraftTests {
  @Test("jednokrotny wybór: ponowny tap odznacza; wielokrotny przełącza")
  func toggle() {
    var draft = QuestionDraft(sections: 2)
    draft.toggle("a", in: 0, multiSelect: false)
    draft.toggle("b", in: 0, multiSelect: false)
    #expect(draft.picks[0] == ["b"])
    draft.toggle("b", in: 0, multiSelect: false)
    #expect(draft.picks[0].isEmpty)
    draft.toggle("PWA", in: 1, multiSelect: true)
    draft.toggle("Swift", in: 1, multiSelect: true)
    draft.toggle("PWA", in: 1, multiSelect: true)
    #expect(draft.picks[1] == ["Swift"])
  }

  @Test("tekst i zaznaczenie wykluczają się — wygrywa świeższe")
  func freshestWins() {
    var draft = QuestionDraft(sections: 1)
    draft.toggle("a", in: 0, multiSelect: false)
    draft.setCustom("  ", in: 0)
    #expect(draft.picks[0] == ["a"], "same spacje to jeszcze nie odpowiedź")
    draft.setCustom("coś innego", in: 0)
    #expect(draft.picks[0].isEmpty && draft.customActive(in: 0))
    draft.toggle("a", in: 0, multiSelect: false)
    #expect(draft.customText(in: 0).isEmpty && draft.picks[0] == ["a"])
    draft.setCustom(String(repeating: "x", count: 2_100), in: 0)
    #expect(draft.customText(in: 0).utf16.count == AnswerLimits.maxTextUnits, "pole do 2000 znaków")
  }

  @Test("wysyłka: tekst zastępuje zaznaczenie, brak odpowiedzi nazywa pytanie, opcja terminalowa nie przechodzi")
  func submission() {
    let form = Q.card(Q.form)
    var draft = QuestionDraft(sections: 2)
    draft.toggle("server/test/fixtures", in: 0, multiSelect: false)
    #expect(form.submission(draft) == .missing(section: 1, message: "Brakuje odpowiedzi na pytanie: Które klienty?"))
    draft.setCustom("  oba, ale później  ", in: 1)
    #expect(form.submission(draft) == .send([["server/test/fixtures"], ["oba, ale później"]]))

    let screen = Q.card(Q.screen)
    var picked = QuestionDraft(sections: 1)
    picked.toggle("Yes, and don't ask again", in: 0, multiSelect: false)
    #expect(screen.submission(picked) == .missing(section: 0, message: "Wybierz odpowiedź."))
    #expect(UICopy.questionMissing(total: 1, question: "x", customAnswer: true) == "Wybierz odpowiedź albo wpisz własną.")
    #expect(UICopy.questionMissing(total: 2, question: " ", customAnswer: false) == "Wybierz odpowiedź na każde pytanie.")
  }

  @Test("cyfry: n-ta widoczna opcja pytania, które ma klawiaturę; Enter tylko przy „Odpowiedz”")
  func keys() {
    let form = Q.card(Q.form)
    var draft = QuestionDraft(sections: 2)
    #expect(form.keyAction(.digit(2), draft: draft) == .pick(section: 0, label: "server/test/fixtures"))
    draft.toggle("server/test/fixtures", in: 0, multiSelect: false)
    // Pierwsze pytanie ma odpowiedź — klawiatura przechodzi do następnego bez odpowiedzi.
    #expect(form.keyAction(.digit(1), draft: draft) == .pick(section: 1, label: "PWA"))
    #expect(form.keyAction(.digit(3), draft: draft) == nil, "opcji 3 w tym pytaniu nie ma")
    draft.toggle("PWA", in: 1, multiSelect: true)
    // Każde pytanie ma odpowiedź: cyfry wracają do pytania z ostatnim gestem.
    #expect(form.keyAction(.digit(2), draft: draft) == .pick(section: 1, label: "Swift"))
    #expect(form.keyAction(.enter, draft: draft) == .submit)

    let screen = Q.card(Q.screen)
    let empty = QuestionDraft(sections: 1)
    #expect(screen.keyAction(.digit(1), draft: empty) == .pick(section: 0, label: "Za każdym razem (Recommended)"))
    #expect(screen.keyAction(.digit(3), draft: empty) == nil, "opcja „tylko w terminalu” nie bierze klawisza")
    #expect(screen.keyAction(.enter, draft: empty) == nil, "karta bez „Odpowiedz”")
    let locked = QuestionCardModel.make(Q.request(Q.screen), locked: "x")
    #expect(locked.keyAction(.digit(1), draft: empty) == nil)
  }

  @Test("przytrzymanie nie jest drugą decyzją: ten sam klawisz w oknie milczy, okno się przesuwa")
  func keyRepeat() {
    let t0 = Sample.now
    let first = QuestionKeyRepeat.Stamp(input: "1", at: t0)
    #expect(QuestionKeyRepeat.accepts("1", previous: nil, now: t0))
    #expect(!QuestionKeyRepeat.accepts("1", previous: first, now: t0.addingTimeInterval(0.4)))
    let repeated = QuestionKeyRepeat.Stamp(input: "1", at: t0.addingTimeInterval(0.4))
    #expect(!QuestionKeyRepeat.accepts("1", previous: repeated, now: t0.addingTimeInterval(0.9)))
    #expect(QuestionKeyRepeat.accepts("2", previous: first, now: t0.addingTimeInterval(0.1)))
    #expect(QuestionKeyRepeat.accepts("1", previous: first, now: t0.addingTimeInterval(0.7)))
  }

  @Test("przytrzymana cyfra nie odpowiada na następną kartę: q1 `instant` gaśnie, powtórzenia trafiają w q2")
  func holdAcrossCards() throws {
    // Przebieg jak na ekranie: pierwsze naciśnięcie odpowiada na q1 (karta `instant` gaśnie),
    // klawisze przechodzą na q2, a system dosyła powtórzenia przytrzymanej cyfry.
    let t0 = Sample.now
    var last: QuestionKeyRepeat.Stamp?
    var answered: [String] = []
    let presses: [(after: TimeInterval, card: String)] = [(0, "q1"), (0.5, "q2"), (0.6, "q2"), (0.7, "q2"), (1.6, "q2")]
    for press in presses {
      let now = t0.addingTimeInterval(press.after)
      if QuestionKeyRepeat.accepts("1", previous: last, now: now) { answered.append(press.card) }
      last = QuestionKeyRepeat.Stamp(input: "1", at: now)
    }
    #expect(answered == ["q1", "q2"], "q2 odpowiada dopiero nowe naciśnięcie po puszczeniu klawisza")

    // Pierwsza zapora: skróty cyfr i Enteru nie dostają powtórzeń od systemu.
    let source = try String(contentsOf: ApprovalGateTests.sourceFile("Session/SessionViewController+KeysAnswers.swift"), encoding: .utf8)
    #expect(source.contains("for command in commands { command.repeatBehavior = .nonRepeatable }"))
    #expect(source.contains("let commands = digits + [enter]"))
  }
}

@MainActor
@Suite("karta pytania: odpowiedź i okno potwierdzenia")
struct QuestionFlightTests {
  @Test("wysłano → przyjęta → pytanie zdjęte: karta stoi potwierdzeniem 6 s bez następcy, potem znika")
  func holdWithoutSuccessor() {
    let state = Q.state([Q.form])
    var ui = TranscriptUIState()
    let card = Q.card(Q.form)
    ui.questions.begin(card, answers: [["shared/fixtures/sse"], ["PWA", "Swift"]])
    var cards = Q.cards(TranscriptRows.build(state: state, sessionId: "s1", ui: ui))
    #expect(cards.first?.phase == .sending(QuestionAnswered(answers: [["shared/fixtures/sse"], ["PWA", "Swift"]])))
    #expect(UICopy.questionSending(cards.first.map(answeredSummary) ?? "") == "Wysłano „shared/fixtures/sse, PWA, Swift” → czekam na ekran")
    #expect(ui.questions.holdsDialogCard, "karta „dialog w terminalu” w tym oknie nie staje")
    let spoken = ui.questions.finish("q2", .accepted)
    #expect(spoken == "Odpowiedź przyjęta: „shared/fixtures/sse, PWA, Swift”")

    var gone = state
    gone.transcripts["s1"]?.pendingQuestions = []
    let t0 = Sample.now
    #expect(ui.questions.settle(pending: [], now: t0) == t0.addingTimeInterval(QuestionTiming.sentGap))
    cards = Q.cards(TranscriptRows.build(state: gone, sessionId: "s1", ui: ui))
    #expect(cards.count == 1 && cards[0].held && !cards[0].interactive)
    #expect(cards[0].phase == .sent(QuestionAnswered(answers: [["shared/fixtures/sse"], ["PWA", "Swift"]])))
    // Okno liczy się od PIERWSZEGO stanu bez pytania — kolejny render go nie przedłuża.
    #expect(ui.questions.settle(pending: [], now: t0.addingTimeInterval(3)) == t0.addingTimeInterval(QuestionTiming.sentGap))
    #expect(ui.questions.settle(pending: [], now: t0.addingTimeInterval(6)) == nil)
    #expect(!ui.questions.holdsDialogCard)
    #expect(Q.cards(TranscriptRows.build(state: gone, sessionId: "s1", ui: ui)).isEmpty)
  }

  @Test("następny krok formularza: nowa karta stoi nad potwierdzeniem, które ustępuje po 1,5 s")
  func holdWithSuccessor() {
    var ui = TranscriptUIState()
    ui.questions.begin(Q.card(Q.screen), answers: [["Tylko ten raz"]])
    ui.questions.finish("screen:q:1", .accepted)
    let t0 = Sample.now
    #expect(ui.questions.settle(pending: ["q2"], now: t0) == t0.addingTimeInterval(QuestionTiming.sentHold))
    let cards = Q.cards(TranscriptRows.build(state: Q.state([Q.form]), sessionId: "s1", ui: ui))
    #expect(cards.map(\.qId) == ["q2", "screen:q:1"], "trzymana karta nie przesuwa kolejnych")
    #expect(cards.map(\.held) == [false, true])
    #expect(ui.questions.settle(pending: ["q2"], now: t0.addingTimeInterval(1.5)) == nil)
  }

  @Test("odmowa i błąd wracają do wyboru z powodem; wygasła i rozstrzygnięta gdzie indziej — bez zdania pod kartą")
  func failures() {
    var ui = TranscriptUIState()
    let card = Q.card(Q.form)
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    let message = "Wielokrotny wybór zrób w terminalu — Rarog wyśle jedną odpowiedź."
    #expect(ui.questions.finish("q2", .refused(message: message)) == message)
    let rows = Q.cards(TranscriptRows.build(state: Q.state([Q.form]), sessionId: "s1", ui: ui))
    #expect(rows.first?.phase == .choose && rows.first?.error == message)
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    #expect(ui.questions.errors["q2"] == nil, "nowa próba gasi stare zdanie")
    #expect(ui.questions.finish("q2", .failed) == "Nie udało się wysłać. Spróbuj ponownie.")
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    #expect(ui.questions.finish("q2", .offline) == UICopy.questionOffline)
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    #expect(ui.questions.finish("q2", .refused(message: nil)) == UICopy.questionRefusedFallback)
    ui.questions.errors = [:]
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    #expect(ui.questions.finish("q2", .expired) == "Pytanie wygasło — wznów sesję.")
    #expect(ui.questions.errors.isEmpty && ui.questions.flights.isEmpty)
    ui.questions.begin(card, answers: [["x"], ["PWA"]])
    #expect(ui.questions.finish("q2", .discarded) == nil)
    #expect(ui.questions.flights.isEmpty)
  }

  @Test("odpowiedź z poprzedniej wizyty w drodze: karta mówi podpis z rdzenia; zablokowana sesja blokuje kartę")
  func coreFlightAndLock() {
    var state = Q.state([Q.form])
    state.apply(.decisionStarted(sessionId: "s1", cardId: "q2", choice: "PWA"), now: Sample.now)
    let card = Q.cards(TranscriptRows.build(state: state, sessionId: "s1")).first
    #expect(card?.phase == .sending(QuestionAnswered(summary: "PWA")))
    var locked = Q.state([Q.form])
    locked.herdr = Sample.decode(HerdrStatus.self, #"{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(Q.cards(TranscriptRows.build(state: locked, sessionId: "s1")).first?.lockedReason
      == "herdr tylko do odczytu — wysyłka do panelu wyłączona.")
  }

  @Test("ślad pytania: wygasłe — „Pytanie wygasło”, z innego urządzenia — „Decyzja zapadła…”")
  func notices() {
    var state = Q.state([Q.form])
    state.apply(.decisionStarted(sessionId: "s1", cardId: "q2", choice: "PWA"), now: Sample.now)
    state.apply(.decisionFinished(sessionId: "s1", cardId: "q2", kind: .question, result: .gone), now: Sample.now)
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(rows.last == .notice(id: "nq2", text: "Pytanie wygasło — wznów sesję."))
    #expect(UICopy.questionNotice(.resolvedElsewhere(by: nil)) == "Decyzja zapadła już na innym urządzeniu.")
  }

  @Test("szkice trzymają się `qId` karty i znikają z kartą")
  func drafts() {
    let book = QuestionDraftBook()
    book.update("q2", sections: 2) { $0.setCustom("tekst", in: 1) }
    #expect(book.draft("q2", sections: 2).customText(in: 1) == "tekst")
    #expect(book.draft("q2", sections: 3).customText(in: 1) == "tekst", "przebudowana karta nie kasuje pola")
    book.keep(only: ["inna"])
    #expect(book.draft("q2", sections: 2).customText(in: 1).isEmpty)
  }

  private func answeredSummary(_ card: QuestionCardModel) -> String {
    switch card.phase {
    case let .sending(answered), let .sent(answered): answered.summary
    case .choose: ""
    }
  }
}

private enum P {
  /// Pytanie z podglądem: rekomendacja na górę, opcja bez podglądu, pusty podgląd = brak.
  static let preview = #"""
    {"qId":"hook:1:p","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,
     "questions":[{"question":"Jaki układ?","header":"Układ","multiSelect":false,"options":[
       {"label":"Jedna kolumna","preview":"001 │ ──\n002 │ ──"},
       {"label":"Dwie kolumny (Rekomendacja)","description":"Lista obok.","preview":"┌──┬──┐\n│ a│ b│\n└──┴──┘"},
       {"label":"Bez listy"},
       {"label":"Pusta","preview":""}]}]}
    """#

  /// Wielokrotny wybór z podglądami: podgląd idzie za OSTATNIO zaznaczoną opcją z podglądem.
  static let multi = #"""
    {"qId":"hook:2:m","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":true,
     "questions":[{"question":"Które warstwy?","header":"","multiSelect":true,"options":[
       {"label":"A","preview":"aaa"},{"label":"B"},{"label":"C","preview":"  c\n   c"}]}]}
    """#

  /// Ekran przeglądu formularza: surowa treść zostaje w `question`, pary liczy serwer.
  static let review = #"""
    {"qId":"screen:q:r","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,
     "questions":[{"question":"surowy tekst ekranu\n● P1?\n→ x","header":"","multiSelect":false,"options":[
       {"label":"Wyślij formularz","role":"answer"},{"label":"Wróć","role":"answer"}],
       "review":[{"question":"Na którą wartość?","answers":["52 px, szeroko"]},
                 {"question":"Które dodatki?","answers":["Posypka","Polewa"]},
                 {"question":"Puste?","answers":[]}]}]}
    """#

  /// Ten sam formularz od starszego serwera — bez pól `preview` i `review`.
  static let legacy = #"""
    {"qId":"q0","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,
     "questions":[{"question":"Jaki układ?\nDruga linia.","header":"Układ","multiSelect":false,"options":[
       {"label":"Jedna kolumna"},{"label":"Dwie kolumny"}]}]}
    """#
}

@Suite("karta pytania: podgląd opcji i przegląd formularza")
struct QuestionPreviewReviewTests {
  @Test("ramka bez `preview` i `review` (starszy serwer) = zwykła karta: tapnięcie wysyła, surowa treść")
  func legacyCard() {
    let card = Q.card(P.legacy)
    #expect(card.sections[0].options.map(\.preview) == [nil, nil])
    #expect(card.sections[0].review == nil && !card.sections[0].hasPreview)
    #expect(card.instant && !card.hasSubmit)
    #expect(card.sections[0].question == "Jaki układ?\nDruga linia.")
    #expect(card.sections[0].previewOption(picked: []) == nil)
  }

  @Test("opcja niesie podgląd w kolejności karty; pusty podgląd to brak; podgląd wyłącza `instant`")
  func previewModel() {
    let card = Q.card(P.preview)
    let options = card.sections[0].options
    #expect(options.map(\.label) == ["Dwie kolumny (Rekomendacja)", "Jedna kolumna", "Bez listy", "Pusta"])
    #expect(options.map(\.preview) == ["┌──┬──┐\n│ a│ b│\n└──┴──┘", "001 │ ──\n002 │ ──", nil, nil])
    #expect(card.sections[0].hasPreview)
    #expect(!card.instant && card.hasSubmit, "jedno pytanie jednokrotne z podglądem: zaznaczenie + „Odpowiedz”")
    // Klawiatura jak na każdej karcie z „Odpowiedz”: cyfra zaznacza, Enter wysyła.
    let draft = QuestionDraft(sections: 1)
    #expect(card.keyAction(.digit(2), draft: draft) == .pick(section: 0, label: "Jedna kolumna"))
    #expect(card.keyAction(.enter, draft: draft) == .submit)
  }

  @Test("który podgląd: przed wyborem pierwszy widoczny, potem zaznaczonej opcji; wybór bez podglądu — żaden")
  func previewSingle() throws {
    let section = Q.card(P.preview).sections[0]
    #expect(section.previewOption(picked: [])?.label == "Dwie kolumny (Rekomendacja)", "pierwsza WIDOCZNA (rekomendacja na górze)")
    #expect(section.previewOption(picked: ["Jedna kolumna"])?.preview == "001 │ ──\n002 │ ──")
    #expect(section.previewOption(picked: ["Bez listy"]) == nil, "podpis cudzego podglądu kłamałby o zaznaczeniu")
    #expect(section.previewOption(picked: ["Pusta"]) == nil)
    #expect(section.previewOption(picked: [], customActive: true) == nil, "własna odpowiedź to wybór bez podglądu")
    // Szkic → reguła: ponowny tap odznacza i wraca podgląd pierwszej opcji.
    var draft = QuestionDraft(sections: 1)
    draft.toggle("Jedna kolumna", in: 0, multiSelect: false)
    #expect(section.previewOption(picked: draft.picks[0])?.label == "Jedna kolumna")
    draft.toggle("Jedna kolumna", in: 0, multiSelect: false)
    #expect(section.previewOption(picked: draft.picks[0])?.label == "Dwie kolumny (Rekomendacja)")
  }

  @Test("wielokrotny wybór: podgląd ostatnio zaznaczonej opcji Z PODGLĄDEM, spacje zostają")
  func previewMulti() {
    let card = Q.card(P.multi)
    let section = card.sections[0]
    #expect(!card.instant)
    var draft = QuestionDraft(sections: 1)
    draft.toggle("C", in: 0, multiSelect: true)
    draft.toggle("A", in: 0, multiSelect: true)
    #expect(section.previewOption(picked: draft.picks[0])?.label == "A")
    draft.toggle("B", in: 0, multiSelect: true)
    #expect(section.previewOption(picked: draft.picks[0])?.label == "A", "B nie ma podglądu — zostaje A")
    draft.toggle("A", in: 0, multiSelect: true)
    #expect(section.previewOption(picked: draft.picks[0])?.preview == "  c\n   c")
    // Podgląd nie jest odpowiedzią: wysyłka niesie same etykiety.
    #expect(card.submission(draft) == .send([["C", "B"]]))
  }

  @Test("przegląd formularza: pary od serwera, surowa treść i opcje dosłownie; pusta lista = zwykłe pytanie")
  func reviewModel() throws {
    let card = Q.card(P.review)
    let section = card.sections[0]
    let pairs = try #require(section.review)
    #expect(pairs.map(\.question) == ["Na którą wartość?", "Które dodatki?", "Puste?"])
    #expect(pairs.map(\.answers) == [["52 px, szeroko"], ["Posypka", "Polewa"], []])
    #expect(section.question.hasPrefix("surowy tekst ekranu"), "treść zostaje w modelu — widok jej nie pokazuje")
    #expect(section.options.map(\.label) == ["Wyślij formularz", "Wróć"])
    #expect(card.instant, "przegląd to jedno pytanie jednokrotne bez pola — tapnięcie wysyła, jak dotąd")

    let empty = Q.card(P.review.replacing(/"review":\[[\s\S]*\]\}\]\}/, with: #""review":[]}]}"#))
    #expect(empty.sections[0].review == nil)
  }

  @Test("copy: podpis i etykieta czytnika podglądu, nagłówek przeglądu, para dla czytnika")
  func copy() {
    #expect(UICopy.questionPreviewCaption("Dwie kolumny") == "Podgląd: „Dwie kolumny”")
    #expect(UICopy.questionPreviewSpoken(label: "Dwie kolumny", preview: "a\nb") == "Podgląd opcji „Dwie kolumny”: a\nb")
    #expect(UICopy.questionReviewTitle == "Sprawdź odpowiedzi przed wysłaniem")
    #expect(UICopy.questionReviewSpoken(question: "Które?", answers: ["Posypka", "Polewa"]) == "Które?: Posypka, Polewa")
    #expect(UICopy.questionReviewSpoken(question: "Puste?", answers: []) == "Puste?: bez odpowiedzi")
  }

  @Test("sufit bloku: komenda 10/16, plan i podgląd 20/32 linii")
  func ceiling() {
    #expect(CardBlockCeiling.lines(readable: false, regular: false) == 10)
    #expect(CardBlockCeiling.lines(readable: false, regular: true) == 16)
    #expect(CardBlockCeiling.lines(readable: true, regular: false) == 20)
    #expect(CardBlockCeiling.lines(readable: true, regular: true) == 32)
  }
}

private enum N {
  /// Pytanie z podglądem i polem notatki — `notes` liczy serwer.
  static let single = #"""
    {"qId":"hook:3:n","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":true,
     "questions":[{"question":"Jaki układ?","header":"Układ","multiSelect":false,"notes":true,"options":[
       {"label":"Dwie kolumny","preview":"┌─┬─┐"},{"label":"Jedna kolumna","preview":"│ │"},
       {"label":"Zawsze tak","terminalOnly":true}]}]}
    """#

  /// Formularz: notatka tylko przy pierwszym pytaniu.
  static let form = #"""
    {"qId":"hook:4:f","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,
     "questions":[
      {"question":"Układ?","header":"","multiSelect":false,"notes":true,"options":[{"label":"A","preview":"a"},{"label":"B"}]},
      {"question":"Testy?","header":"","multiSelect":true,"notes":false,"options":[{"label":"X"},{"label":"Y"}]}]}
    """#

  /// Cztery pytania z notatką — cztery notatki po sufit przekraczają sumę żądania.
  static let four: String = {
    let question = #"{"question":"P?","header":"","multiSelect":false,"notes":true,"options":[{"label":"A","preview":"a"}]}"#
    return #"{"qId":"hook:5:x","sessionId":"s1","createdAt":"\#(Sample.iso(5))","customAnswer":false,"questions":["#
      + Array(repeating: question, count: 4).joined(separator: ",") + "]}"
  }()
}

@MainActor
@Suite("karta pytania: notatka do wybranej opcji")
struct QuestionNoteTests {
  @Test("pole notatki stoi wyłącznie przy `notes: true` od serwera")
  func model() {
    #expect(Q.card(N.single).sections.map(\.notes) == [true])
    #expect(Q.card(N.form).sections.map(\.notes) == [true, false])
    #expect(Q.card(P.preview).sections.map(\.notes) == [false], "podgląd sam pola nie daje — liczy serwer")
  }

  @Test("szkic: notatka nie jest odpowiedzią — nie rusza zaznaczeń ani pola własnej odpowiedzi; sufit 8192")
  func draft() {
    var draft = QuestionDraft(sections: 1)
    draft.toggle("Dwie kolumny", in: 0, multiSelect: false)
    draft.setNote("bez paska 123", in: 0)
    #expect(draft.picks[0] == ["Dwie kolumny"] && draft.noteText(in: 0) == "bez paska 123")
    #expect(draft.keyboardSection(sections: 1) == 0)
    draft.setNote(String(repeating: "n", count: AnswerLimits.maxNoteUnits + 3), in: 0)
    #expect(draft.noteText(in: 0).utf16.count == AnswerLimits.maxNoteUnits)
    #expect(QuestionDraft(sections: 1).noteText(in: 5).isEmpty)
    let book = QuestionDraftBook()
    book.update("q", sections: 1) { $0.setNote("x", in: 0) }
    #expect(book.draft("q", sections: 2).noteText(in: 0) == "x", "przebudowana karta nie kasuje notatki")
  }

  @Test("wysyłka: notatka równolegle do odpowiedzi, bez białych brzegów; pusta = ciało bez notatek")
  func send() {
    let card = Q.card(N.single)
    #expect(!card.instant && card.hasSubmit)
    var draft = QuestionDraft(sections: 1)
    draft.toggle("Jedna kolumna", in: 0, multiSelect: false)
    #expect(card.submission(draft) == .send([["Jedna kolumna"]]))
    draft.setNote("  ale bez paska bocznego \n", in: 0)
    #expect(card.submission(draft) == .send([["Jedna kolumna"]], notes: ["ale bez paska bocznego"]))
    draft.setNote(" \n ", in: 0)
    #expect(card.submission(draft) == .send([["Jedna kolumna"]]))

    let form = Q.card(N.form)
    var both = QuestionDraft(sections: 2)
    both.toggle("A", in: 0, multiSelect: false)
    both.toggle("X", in: 1, multiSelect: true)
    both.setNote("uwaga", in: 0)
    both.setNote("niewidoczna", in: 1)
    #expect(form.submission(both) == .send([["A"], ["X"]], notes: ["uwaga", nil]), "notatka tylko z pola, które stoi")
  }

  @Test("notatka bez jednej opcji z listy: zdanie serwera przed wysyłką, szkic zostaje; brak odpowiedzi — najpierw on")
  func rejected() {
    let card = Q.card(N.single)
    var draft = QuestionDraft(sections: 1)
    draft.setNote("uwaga", in: 0)
    #expect(card.submission(draft) == .missing(section: 0, message: "Wybierz odpowiedź albo wpisz własną."))
    draft.setCustom("coś swojego", in: 0)
    #expect(card.submission(draft) == .noteRejected(
      section: 0, message: "Notatka dotyczy wybranej opcji — wybierz jedną opcję z listy albo usuń notatkę."))
    #expect(draft.noteText(in: 0) == "uwaga" && draft.customText(in: 0) == "coś swojego")
    // Własna odpowiedź równa etykiecie opcji to dalej własna odpowiedź.
    draft.setCustom("Dwie kolumny", in: 0)
    #expect(card.submission(draft) == .noteRejected(section: 0, message: UICopy.questionNoteNeedsOption))
    draft.toggle("Dwie kolumny", in: 0, multiSelect: false)
    #expect(card.submission(draft) == .send([["Dwie kolumny"]], notes: ["uwaga"]))
  }

  @Test("suma odpowiedzi i notatek ponad 32768 — zdanie serwera, fokus na pierwszej notatce")
  func total() {
    let card = Q.card(N.four)
    var draft = QuestionDraft(sections: 4)
    for index in 0..<4 {
      draft.toggle("A", in: index, multiSelect: false)
      draft.setNote(String(repeating: "n", count: AnswerLimits.maxNoteUnits), in: index)
    }
    #expect(card.submission(draft) == .noteRejected(section: 0, message: "Odpowiedzi z notatkami są za długie — skróć notatkę."))
    draft.setNote("krótka", in: 3)
    if case let .send(answers, notes)? = card.submission(draft) {
      #expect(answers == Array(repeating: ["A"], count: 4) && notes?.count == 4)
    } else {
      Issue.record("pod sufitem karta ma wysłać")
    }
  }

  @Test("szkic notatki przeżywa 422 i błąd sieci jak pole własnej odpowiedzi")
  func survivesRefusal() {
    var ui = TranscriptUIState()
    let card = Q.card(N.single)
    ui.questions.drafts.update(card.qId, sections: 1) {
      $0.toggle("Dwie kolumny", in: 0, multiSelect: false)
      $0.setNote("bez paska", in: 0)
    }
    for outcome in [AnswerOutcome.refused(message: "Nic nie doszło do panelu — sprawdź herdr i spróbuj ponownie."), .failed] {
      ui.questions.begin(card, answers: [["Dwie kolumny"]])
      ui.questions.finish(card.qId, outcome)
      _ = ui.questions.settle(pending: [card.qId], now: Sample.now)
      ui.questions.drafts.keep(only: Set([card.qId]).union(ui.questions.flights.keys))
      let draft = ui.questions.drafts.draft(card.qId, sections: 1)
      #expect(draft.noteText(in: 0) == "bez paska" && draft.picks[0] == ["Dwie kolumny"])
      #expect(ui.questions.flights.isEmpty && ui.questions.errors[card.qId] != nil, "karta wraca do wyboru z powodem")
    }
  }

  @Test("copy pola notatki dosłownie jak w PWA")
  func copy() {
    #expect(UICopy.questionNoteLabel == "Notatka")
    #expect(UICopy.questionNotePlaceholder == "Uwaga do wybranej opcji (opcjonalnie)")
  }
}
