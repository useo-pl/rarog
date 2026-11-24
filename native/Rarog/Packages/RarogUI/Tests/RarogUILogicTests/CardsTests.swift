import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

@Suite("karty: eskalacja, plan, dialog w panelu, karta stanu, klawisze")
struct CardsTests {
  private func permissions(_ state: AppState, ui: TranscriptUIState = TranscriptUIState()) -> [PermissionCardModel] {
    TranscriptRows.build(state: state, sessionId: "s1", ui: ui).compactMap { row in
      if case let .permission(card) = row { card } else { nil }
    }
  }

  private func dialog(_ state: AppState, ui: TranscriptUIState = TranscriptUIState()) -> HerdrDialogCardModel? {
    TranscriptRows.build(state: state, sessionId: "s1", ui: ui).compactMap { row in
      if case let .herdrDialog(card) = row { card } else { nil }
    }.first
  }

  @Test("eskalacja: dosłowna etykieta od serwera tylko na karcie, którą da się zatwierdzić; plan ma swoją")
  func escalation() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1", extra: #""alwaysLabel":"Yes, and don’t ask again for: npm test""#),
      Sample.permission(permId: "p2", extra: #""alwaysLabel":"Yes, always","canAllow":false"#),
      Sample.permission(permId: "p3", extra: #""subject":"plan","alwaysLabel":"Yes, and use auto mode""#),
      Sample.permission(permId: "p4", extra: #""alwaysLabel":"""#),
    ]
    let cards = permissions(state)
    #expect(cards.map(\.alwaysLabel) == ["Yes, and don’t ask again for: npm test", nil, "Yes, and use auto mode", nil])
    #expect(cards[2].plan && cards[2].eyebrow == "plan")
    #expect(UICopy.allowingAlways("Yes, and use auto mode") == "Zatwierdzam: „Yes, and use auto mode”…")
  }

  @Test("plan wraca do auto tylko z opcją serwera; zwykła zgoda zostaje jednorazowa")
  func planPrimaryDecision() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1", extra: #""subject":"plan","alwaysLabel":"Yes, and use auto mode""#),
      Sample.permission(permId: "p2", extra: #""subject":"plan""#),
      Sample.permission(permId: "p3", extra: #""alwaysLabel":"Yes, always""#),
      Sample.permission(permId: "p4", extra: #""subject":"plan","canAllow":false,"alwaysLabel":"Yes, auto""#),
      Sample.permission(permId: "p5", extra: #""subject":"plan","alwaysLabel":"""#),
      Sample.permission(permId: "p6", extra: #""subject":"plan","alwaysLabel":" \n ""#),
    ]
    let cards = permissions(state)
    #expect(cards.map(\.primaryDecision) == [.allowAlways, nil, .allow, nil, nil, nil])
    #expect(cards[0].approvalUnavailable == nil)
    #expect(cards[1].approvalUnavailable == UICopy.planAutoUnavailable)
    #expect(cards[3].approvalUnavailable == UICopy.denyOnly)
  }

  @Test("komenda w kolorach składni tylko z `inputKind: shell` od serwera; brak pola, JSON i plan bez koloru")
  func commandSyntax() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1", extra: #""inputKind":"shell""#),
      Sample.permission(permId: "p2"),
      Sample.permission(permId: "p3", extra: #""inputKind":"json""#),
      Sample.permission(permId: "p4", extra: #""subject":"plan","inputKind":"shell""#),
    ]
    let cards = permissions(state)
    #expect(cards.map(\.permId) == ["p1", "p2", "p3", "p4"])
    // Te same tokeny co skaner powłoki dla dosłownego `displayText` — kolor bez zmiany tekstu.
    #expect(cards[0].command == "npm test")
    #expect(cards[0].commandSyntax == SyntaxHighlight.tokens("npm test", language: "sh"))
    #expect(!cards[0].commandSyntax.isEmpty)
    #expect(cards[1].commandSyntax.isEmpty && cards[2].commandSyntax.isEmpty && cards[3].commandSyntax.isEmpty)
  }

  @Test("zdanie informacyjne pod kartą zgody zostaje przy karcie (decyzja z innego urządzenia)")
  func permissionNote() {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1", extra: #""canAllow":false"#)]
    var ui = TranscriptUIState()
    ui.notes["p1"] = UICopy.decidedElsewhere
    #expect(permissions(state, ui: ui).first?.note == UICopy.decidedElsewhere)
  }

  @Test("karta zgody bez przycisków: stopka tylko z przyciskiem albo wierszem stanu")
  func permissionFooter() throws {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1", extra: #""canAllow":false"#)]
    let screen = try #require(permissions(state).first)
    #expect(screen.primaryDecision == nil && screen.canDeny && screen.hasFooter, "karta ekranowa: samo „Odrzuć”")
    var running = screen
    running.hookChannel = true
    running.awaitingDecision = false
    #expect(!running.canDeny && !running.hasFooter, "karta kanału, której hook już nie słucha: bez stopki")
  }

  @Test("dialog nierozpoznany: powód w etykiecie i zdaniu, wycinek ekranu, bez „Zatwierdź”; zgoda CLI")
  func unknownDialog() throws {
    let state = Sample.state(session: Sample.session(
      state: "waiting-permission",
      extra: #""herdrDialogReason":"consent-dialog","herdrDialogScreen":"❯ 1. Yes\n  2. No""#))
    let card = try #require(dialog(state))
    #expect(card.eyebrow == "dialog w terminalu · zgoda CLI")
    #expect(card.text.hasPrefix("Panel pyta o zgodę na skanowanie środowiska"))
    #expect(card.allowLabel == nil && card.denyLabel == "Odrzuć dialog" && card.screen == "❯ 1. Yes\n  2. No")
    #expect(!card.channelDead && card.lockedReason == nil)

    let bare = try #require(dialog(Sample.state(session: Sample.session(state: "waiting-question"))))
    #expect(bare.eyebrow == "dialog w terminalu" && bare.text == UICopy.dialogHint && bare.screen == nil)
  }

  @Test("`mismatch` nie twierdzi „inne narzędzie”; wskaźnik wycinka mówi „w górę”")
  func mismatchIsNeutral() throws {
    // Najczęstszy `mismatch` to to samo narzędzie z ramką uciętą u góry panelu — Rarog wie tylko, że nie potwierdził.
    let state = Sample.state(session: Sample.session(
      state: "waiting-permission", extra: #""herdrDialogReason":"mismatch","herdrDialogScreen":"❯ 1. Yes\n  2. No""#))
    let card = try #require(dialog(state))
    #expect(card.eyebrow == "dialog w terminalu · brak zgodności")
    #expect(card.text == "Rarog nie potwierdził, że karta opisuje dialog w terminalu — sprawdź go tam.")
    #expect(UICopy.waitingLine(try #require(state.sessions["s1"])) == "dialog w terminalu · brak zgodności")
    // Blok „Co widać w terminalu” startuje od dołu (`ScreenBlockView`), więc ucięta część jest nad nim; blok
    // komendy karty zgody startuje od góry i zostaje przy „przewiń w bloku”.
    #expect(UICopy.screenClipped(shown: 8, total: 40) == "⌃ widzisz 8 z 40 linii — przewiń w górę")
    #expect(UICopy.commandClipped(shown: 10, total: 12) == "⌄ widzisz 10 z 12 linii — przewiń w bloku")
  }

  @Test("klasa z rejestru CLI: pierwsze zdanie karty, `no-jsonl` jej ustępuje, inny powód zostaje")
  func cliDialogClass() throws {
    let open = Sample.state(session: Sample.session(
      state: "waiting-permission", extra: #""herdrDialogReason":"no-jsonl","cliDialog":"dialog""#))
    let card = try #require(dialog(open))
    // Klasa `dialog open` to kilkanaście różnych dialogów CLI (pauza sesji, wybór modelu…), nie tylko okno komendy.
    #expect(card.eyebrow == "dialog w terminalu · dialog CLI")
    #expect(card.text == "Dialog CLI w terminalu. Odpowiedz tam albo odrzuć dialog.")
    #expect(card.allowLabel == nil && card.denyLabel == "Odrzuć dialog")
    #expect(card.signature.cliDialog == .dialog)
    #expect(UICopy.waitingLine(try #require(open.sessions["s1"])) == "dialog w terminalu · dialog CLI")

    let multi = Sample.state(session: Sample.session(
      state: "waiting-permission", extra: #""herdrDialogReason":"multi-select","cliDialog":"input""#))
    let multiCard = try #require(dialog(multi))
    #expect(multiCard.eyebrow == "dialog w terminalu · wielokrotny wybór")
    #expect(multiCard.text == "Pytanie albo formularz w terminalu. " + UICopy.refuseMessage(.multiSelect))
    // Linia listy mówi, NA CO czeka — klasa bije powód.
    #expect(UICopy.waitingLine(try #require(multi.sessions["s1"])) == "dialog w terminalu · pytanie albo formularz")

    // `other` i brak klasy = zdanie bez klasy dialogu CLI; dialog rozpoznany klasy nie słucha; nic nie dokłada
    // zatwierdzania.
    for reason in [nil] + RefuseReason.allCases.map(Optional.some) {
      #expect(UICopy.herdrDialog(nil, reason: reason, cliDialog: .other) == UICopy.herdrDialog(nil, reason: reason))
    }
    for cliDialog in CliDialogClass.allCases {
      #expect(UICopy.herdrDialog(.trust, reason: nil, cliDialog: cliDialog) == UICopy.herdrDialog(.trust, reason: nil))
      #expect(UICopy.herdrDialog(nil, reason: .noJsonl, cliDialog: cliDialog).allowLabel == nil)
    }
    #expect(UICopy.cliDialogPhrase(.other) == nil && UICopy.cliDialogLead(nil).isEmpty)
    let phrases = CliDialogClass.allCases.compactMap(UICopy.cliDialogPhrase)
    #expect(phrases.count == CliDialogClass.allCases.count - 1 && Set(phrases).count == phrases.count)

    // `waitingFor` (karta zgody z jsonl) jest dokładniejszy niż klasa — linia listy zostaje przy nim.
    let waiting = Sample.session(
      state: "waiting-permission", extra: #""waitingFor":{"kind":"permission","tool":"Shell"},"cliDialog":"permission""#)
    #expect(UICopy.waitingLine(waiting) == "zgoda: Shell")

    // Karta zgody bez zatwierdzania: zdanie klasy przed „Nie znam opcji…"; karta z decyzją go nie ma.
    var perm = Sample.state(session: Sample.session(state: "waiting-permission", extra: #""cliDialog":"sandbox""#))
    perm.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1", extra: #""canAllow":false"#), Sample.permission(permId: "p2"),
    ]
    let cards = permissions(perm)
    #expect(cards[0].approvalUnavailable == "Zgoda na sieć w terminalu. " + UICopy.denyOnly)
    #expect(cards[1].approvalUnavailable == nil && cards[1].cliDialog == nil)
  }

  @Test("dialog rozpoznany: dosłowne etykiety, drugi tap uzbrojony 5 s; martwy kanał gasi zatwierdzanie")
  func knownDialog() throws {
    var state = Sample.state(session: Sample.session(state: "waiting-permission", extra: #""herdrDialog":"trust""#))
    var card = try #require(dialog(state))
    #expect(card.eyebrow == "zaufanie katalogu" && card.allowLabel == "Tak, ufam temu katalogowi" && card.denyLabel == "Nie ufam")
    #expect(!card.allowArmed)
    var ui = TranscriptUIState()
    var local = DialogCardUI(identity: card.identity)
    local.arm(card.signature, until: Date().addingTimeInterval(5))
    ui.dialog = local
    card = try #require(dialog(state, ui: ui))
    #expect(card.allowArmed)
    // Stan z innego czekania (sesja ruszyła i stanęła znów) nie przechodzi na nową kartę.
    ui.dialog = DialogCardUI(identity: "inne")
    #expect(try #require(dialog(state, ui: ui)).allowArmed == false)

    state.sessions["s1"] = Sample.session(state: "waiting-permission", extra: #""herdrDialog":"model""#)
    #expect(try #require(dialog(state)).allowLabel == "Tak, zmień model")
    state.herdr = Sample.decode(HerdrStatus.self, #"{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    card = try #require(dialog(state))
    #expect(card.allowLabel == nil && card.channelDead)
    let allowed = UICopy.dialogResult(.accepted, decision: .allow, allowSpoken: "Zmiana modelu potwierdzona.")
    #expect(allowed?.text == "Zmiana modelu potwierdzona." && allowed?.isError == false)
    let denied = UICopy.dialogResult(.accepted, decision: .deny, allowSpoken: "")
    #expect(denied?.text == "Wysłałem Esc — panel powinien anulować dialog." && denied?.isError == false)
    #expect(UICopy.dialogResult(.refused(message: nil), decision: .deny, allowSpoken: "")?.text == UICopy.dialogFailed)
  }

  @Test("uzbrojenie na zaufaniu nie przechodzi na zmianę modelu pod tym samym czekaniem; podmiana rozbraja")
  func armedDialogSwapped() throws {
    var state = Sample.state(session: Sample.session(state: "waiting-permission", extra: #""herdrDialog":"trust""#))
    let trust = try #require(dialog(state))
    var ui = TranscriptUIState()
    var local = DialogCardUI(identity: trust.identity)
    local.arm(trust.signature, until: Date().addingTimeInterval(5))
    local.status = "zdanie wyniku"
    ui.dialog = local
    #expect(try #require(dialog(state, ui: ui)).allowArmed)

    // Serwer podmienia dialog w tym samym stanie: `stateSince` (czekanie) stoi, dialog nie.
    state.sessions["s1"] = Sample.session(state: "waiting-permission", extra: #""herdrDialog":"model""#)
    let model = try #require(dialog(state, ui: ui))
    #expect(model.identity == trust.identity && model.signature != trust.signature)
    #expect(!model.allowArmed, "zmiana modelu wymaga własnych dwóch tapnięć")
    let settled = try #require(HerdrDialogCards.settle(ui.dialog, state: state, sessionId: "s1"))
    #expect(settled.armedFor == nil && settled.armedUntil == nil, "podmiana rozbraja na stałe (powrót A→B→A też)")
    #expect(settled.status == "zdanie wyniku", "wynik należy do czekania, nie do dialogu")
    state.sessions["s1"] = Sample.session(state: "waiting-permission", extra: #""herdrDialog":"trust""#)
    ui.dialog = settled
    #expect(try #require(dialog(state, ui: ui)).allowArmed == false)

    // Inne czekanie (sesja ruszyła i stanęła znów) albo brak karty — stan karty od zera.
    state.sessions["s1"] = Sample.session(state: "running")
    #expect(HerdrDialogCards.settle(settled, state: state, sessionId: "s1") == nil)
    #expect(UICopy.dialogResult(.changed, decision: .allow, allowSpoken: "")?.text == UICopy.dialogChanged)
  }

  @Test("karta dialogu nie staje obok karty z treścią; sesja nieobsługiwana = karta bez decyzji")
  func dialogExclusions() throws {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    #expect(dialog(state) == nil)
    state.transcripts["s1"]?.pendingPermissions = []
    state.sessions["s1"] = Sample.session(state: "running")
    #expect(dialog(state) == nil)
    state.sessions["s1"] = Sample.session(state: "waiting-permission", extra: #""engine":"zzz","herdrDialog":"trust""#)
    let card = try #require(dialog(state))
    #expect(card.lockedReason == UICopy.unsupportedSession && card.allowLabel == nil)
  }

  @Test("ostrzeżenie o zaufaniu stoi w transkrypcie nad kartą")
  func trustNotice() {
    var state = Sample.state(session: Sample.session(state: "starting"))
    state.apply(.cards(.trustPromptArmed(sessionId: "s1")), now: Sample.now)
    #expect(TranscriptRows.build(state: state, sessionId: "s1").contains(.notice(id: "trust", text: UICopy.trustPrompt)))
  }

  @Test("karta stanu: limit z godziną i żywym panelem, Wznów tylko bez panelu, gotowe z Nową sesją")
  func stateCards() throws {
    func card(_ state: String, extra: String = "") -> StateCardModel? {
      StateCards.make(state: Sample.state(session: Sample.session(state: state, extra: extra)), sessionId: "s1")
    }
    let limit = try #require(card("limit-reached", extra: #""stateDetail":"resetAt=2026-10-05T12:00:00.000Z""#))
    #expect(limit.eyebrow == "limit" && limit.actions == .livePanel && limit.tone == .failed)
    #expect(limit.text.hasPrefix("Limit planu — spróbuj po ") && limit.text.hasSuffix("Sesja żyje w terminalu — nie ma czego wznawiać."))
    let resumable = try #require(card("resumable", extra: #""stateDetail":"przerwana — backend zrestartowany""#))
    #expect(resumable.eyebrow == "przerwana" && resumable.text == "przerwana — backend zrestartowany" && resumable.actions == .resume)
    #expect(try #require(card("interrupted")).text == "Sesja przerwana. Sesja żyje w terminalu — nie ma czego wznawiać.")
    #expect(try #require(card("error", extra: #""stateDetail":"silnik padł""#)).text.hasPrefix("silnik padł"))
    let done = try #require(card("done", extra: #""lastSummary":"Gotowe: testy zielone.""#))
    #expect(done.eyebrow == "gotowe" && done.text == "Gotowe: testy zielone." && done.actions == .newSession(cwd: "/Users/demo/Projects/willow"))
    #expect(try #require(card("done")).text == "Sesja zamknięta.")
    #expect(try #require(card("zzz-nowy")).actions == .none)
    #expect(try #require(card("waiting-input", extra: #""outOfScope":true"#)).eyebrow == "poza zasięgiem")
    for working in ["starting", "running", "waiting-input", "waiting-permission", "waiting-question"] {
      #expect(card(working) == nil, "\(working)")
    }
  }

  @Test("the state card's “Close Pane” / “×”: keyboard focus leaving the button disarms")
  func stateCardCloseDisarmsOnBlur() throws {
    // Focus on "Close Pane in herdr" → the first activation arms → Tab elsewhere → coming back within 5 s must not
    // close the pane: losing focus disarms, as at the tab's "×" (`TabCloseButton`). The focus behavior (Full Keyboard
    // Access) is checked by hand; here we guard the wiring.
    let card = try String(contentsOf: ApprovalGateTests.sourceFile("Session/Cards/StateCard.swift"), encoding: .utf8)
    #expect(card.contains("@FocusState private var closeFocused: Bool"))
    #expect(card.contains(".focused($closeFocused)"))
    #expect(card.contains("if wasFocused, !isFocused { navigation.disarmClose() }"))
    let tab = try String(contentsOf: ApprovalGateTests.sourceFile("Views/Projects/TabCloseButton.swift"), encoding: .utf8)
    #expect(tab.contains(".focused($focused)") && tab.contains("if wasFocused, !isFocused { blur() }"), "the tab's pattern")
    let slot = try String(contentsOf: ApprovalGateTests.sourceFile("Views/Header/HeaderTabsSlot.swift"), encoding: .utf8)
    #expect(slot.contains("closeBlur: { navigation.disarmClose() }"), "the tab's blur disarms")
  }

  @Test("pole znika przy karcie stanu i przy sesji nieznanej")
  func composerShown() {
    // Reguła stopy (`FootContent`) zastąpiła `StateCards.composerShown`; pole stoi przy `.composer` (i bez doku
    // przy `.decision`), nie stoi przy `.none` i `.stateCard`.
    let state = Sample.state(session: Sample.session(state: "running"))
    let ui = TranscriptUIState()
    #expect(FootContent.make(state: state, sessionId: "s1", ui: ui) == .composer)
    #expect(FootContent.make(state: state, sessionId: "nie-ma", ui: ui) == .none)
    let done = Sample.state(session: Sample.session(state: "done"))
    #expect(FootContent.make(state: done, sessionId: "s1", ui: ui) == .stateCard)
  }

  @Test("klawisze: Tab najpierw na kartę, bez karty do pola, w polu zostaje polu; Esc tylko na karcie w spoczynku")
  func keys() throws {
    #expect(CardKeys.tabTarget(typing: false, cardFocused: false, hasCard: true, composerUsable: false) == .card)
    #expect(CardKeys.tabTarget(typing: false, cardFocused: true, hasCard: true, composerUsable: false) == nil)
    #expect(CardKeys.tabTarget(typing: false, cardFocused: false, hasCard: false, composerUsable: true) == .composer)
    #expect(CardKeys.tabTarget(typing: false, cardFocused: false, hasCard: false, composerUsable: false) == nil)
    #expect(CardKeys.tabTarget(typing: true, cardFocused: false, hasCard: true, composerUsable: true) == nil)

    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    let idle = try #require(TranscriptRows.build(state: state, sessionId: "s1").last)
    #expect(CardKeys.focusable(idle) && CardKeys.escapeDenies(idle))
    state.apply(.decisionStarted(sessionId: "s1", cardId: "p1", choice: "deny"), now: Sample.now)
    let sending = try #require(TranscriptRows.build(state: state, sessionId: "s1").last)
    #expect(CardKeys.focusable(sending) && !CardKeys.escapeDenies(sending), "w trakcie decyzji fokus zostaje, Esc nic nie robi")
    #expect(!CardKeys.focusable(.notice(id: "n", text: "x")))
  }

  @Test("screen card without the approve button: the server's reason picks the sentence, no field keeps deny only")
  func screenCardReason() throws {
    var state = Sample.state(session: Sample.session(state: "waiting-permission", extra: #""cliDialog":"sandbox""#))
    let reasons = ConsentUnavailableReason.allCases.filter { $0 != .unsupported }
    let hook = #""channel":"\#(PermissionChannel.hook.rawValue)""#
    state.transcripts["s1"]?.pendingPermissions = reasons.map { reason in
      Sample.permission(permId: "p-\(reason.rawValue)", extra: #""canAllow":false,"unavailable":"\#(reason.rawValue)""#)
    } + [
      Sample.permission(permId: "p-none", extra: #""canAllow":false"#),
      Sample.permission(permId: "p-allow", extra: #""unavailable":"settings-changed""#),
      Sample.permission(permId: "k-wait", extra: hook + #","state":"pending","canAllow":false,"unavailable":"no-channel""#),
      Sample.permission(permId: "k-run", extra: hook + #","state":"running","canAllow":false,"unavailable":"no-channel""#),
    ]
    let byId = Dictionary(uniqueKeysWithValues: permissions(state).map { ($0.permId, $0) })
    for reason in reasons {
      let card = try #require(byId["p-\(reason.rawValue)"])
      #expect(card.consentUnavailable == reason, "\(reason)")
      #expect(card.approvalUnavailable == UICopy.consentUnavailable(reason), "\(reason)")
      #expect(card.canDeny && card.primaryDecision == nil, "\(reason)")
    }
    // The screen values word for word (the tests run in Polish), each its own sentence.
    #expect(UICopy.consentUnavailable(.settingsChanged) == "Ustawienia tej sesji zmieniły się po jej starcie, więc "
      + "Rarog nie zatwierdzi próśb jej subagentów. Odpowiedz w terminalu albo uruchom sesję ponownie.")
    #expect(UICopy.consentUnavailable(.otherHook)
      == "W tej sesji działa inny hook zgód, więc tę prośbę zatwierdzisz tylko w terminalu.")
    #expect(UICopy.consentUnavailable(.unverifiedHooks)
      == "Rarog nie może potwierdzić, że jego hook jest jedynym hookiem zgód w tej sesji. Odpowiedz w terminalu.")
    let screen = [ConsentUnavailableReason.settingsChanged, .otherHook, .unverifiedHooks].map(UICopy.consentUnavailable)
    #expect(Set(screen + [UICopy.consentUnavailable(.noChannel), UICopy.denyOnly]).count == 5)
    // No field: the CLI class sentence before "deny only", as before.
    #expect(byId["p-none"]?.consentUnavailable == nil)
    #expect(byId["p-none"]?.approvalUnavailable == "Zgoda na sieć w terminalu. " + UICopy.denyOnly)
    // A card that can be allowed ignores the field.
    let allowed = try #require(byId["p-allow"])
    #expect(allowed.consentUnavailable == nil && allowed.approvalUnavailable == nil && allowed.primaryDecision == .allow)
    // A channel card as before: the reason while it waits for a decision, the state sentence after.
    #expect(byId["k-wait"]?.approvalUnavailable == UICopy.consentUnavailable(.noChannel))
    #expect(byId["k-run"]?.approvalUnavailable == nil && byId["k-run"]?.consentUnavailable == .noChannel)
  }
}

// Zdania serwera składane w apce z kodu rejestru: odmowa na karcie bez decyzji, stopka ucięcia, godzina limitu.
// Fasada `ServerText.sentence` sięga do katalogu RarogContract, więc zdanie jest w języku apki, nie serwera.
@Suite("zdania serwera w kartach: odmowa z fasady, stopka ucięcia z `truncation`, limit z `stateDetailRef`")
struct ServerSentenceCardsTests {
  /// Stopka, którą serwer dokleja do ciętego tekstu (angielski `transcript.truncation-footer` przy 1200).
  static let serverFooter = "\n… (1200 characters cut off)"
  static var truncation: String { #""truncation":{"cut":1200,"footer":\#(serverFooter.unicodeScalars.count)}"# }

  static func json(_ value: String) -> String {
    String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
  }

  @Test("odmowa `multi-select`: po polsku i po angielsku z katalogu zdań serwera, nie z katalogu RarogUI")
  func refuseMultiSelect() {
    #expect(UICopy.refuseMessage(.multiSelect) == "Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę.")
    #expect(UICopy.refuseMessage(.multiSelect, language: .pl)
      == "Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę.")
    #expect(UICopy.refuseMessage(.multiSelect, language: .en)
      == "Make multiple selections in the terminal. Rarog sends only one digit.")
  }

  @Test("każdy powód odmowy ma kod `dialogs.refuse.<powód>` w katalogu: zdanie, nie sam kod, w obu językach")
  func everyReasonHasCode() {
    for reason in RefuseReason.allCases {
      let code = "dialogs.refuse.\(reason.rawValue)"
      for language in [CopyLanguage.pl, .en] {
        let sentence = UICopy.refuseMessage(reason, language: language)
        #expect(sentence == ServerText.sentence(code: code, language: language), "\(reason) [\(language)]")
        #expect(sentence != code, "\(reason) [\(language)]: kod spoza deskryptorów")
      }
      #expect(UICopy.refuseMessage(reason, language: .pl) != UICopy.refuseMessage(reason, language: .en), "\(reason)")
    }
  }

  @Test("karta nierozpoznanego dialogu po polsku: powód odmowy z fasady na końcu zdania")
  func unknownDialogCard() {
    let copy = UICopy.herdrDialog(nil, reason: .multiSelect)
    #expect(copy.text.hasSuffix("Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę."), "\(copy.text)")
  }

  @Test("stopka ucięcia: prefiks bez stopki serwera + stopka apki z `cut`; bez `truncation` tekst bez zmian")
  func truncatedText() {
    let cut = Truncation(cut: 1200, footer: Self.serverFooter.unicodeScalars.count)
    let wire = "ls -la" + Self.serverFooter
    #expect(UICopy.truncated(wire, cut) == "ls -la\n… (ucięto 1200 znaków)")
    #expect(UICopy.truncated(wire, cut, language: .pl) == "ls -la\n… (ucięto 1200 znaków)")
    #expect(UICopy.truncated(wire, cut, language: .en) == "ls -la\n… (1200 characters cut off)")
    #expect(UICopy.truncated(wire, nil) == wire)
    #expect(UICopy.truncated("abc", Truncation(cut: 1, footer: 0), language: .en) == "abc\n… (1 character cut off)")
    // Stopka liczona w skalarach Unicode (JS `[...text].length`), nie w bajtach UTF-8 (`…` to trzy bajty).
    #expect(UICopy.truncated("é👍🏽" + Self.serverFooter, cut) == "é👍🏽\n… (ucięto 1200 znaków)")
  }

  @Test("karta narzędzia: `detail` z `truncation` pokazuje prefiks i stopkę apki; bez `truncation` bez zmian")
  func toolDetail() throws {
    let wire = "ls -la" + Self.serverFooter
    func detail(_ extra: String) throws -> String? {
      let blocks = #"[{"type":"tool-call","toolName":"Frobnicate","summary":"ls","detail":\#(Self.json(wire))\#(extra)}]"#
      let message = Sample.message(seq: 3, role: "assistant", blocks: blocks)
      let rows = TranscriptRows.build(state: Sample.state(session: Sample.session(), messages: [message]), sessionId: "s1")
      return try #require(rows.compactMap { if case let .tool(card) = $0 { card } else { nil } }.first).detail
    }
    #expect(try detail("," + Self.truncation) == "ls -la\n… (ucięto 1200 znaków)")
    #expect(try detail("") == wire, "serwer bez kodów zdań albo tekst w całości")
  }

  @Test("karta zgody: komenda i plan z `truncation` pokazują prefiks i stopkę apki; bez `truncation` bez zmian")
  func permissionText() {
    let wire = "## Plan\n\n1. krok" + Self.serverFooter
    func command(_ extra: String) -> String? {
      var state = Sample.state(session: Sample.session(state: "waiting-permission"))
      state.transcripts["s1"]?.pendingPermissions = [Sample.decode(PermissionRequest.self, #"""
        {"permId":"p1","sessionId":"s1","toolName":"Frobnicate","displayText":\#(Self.json(wire)),
         "risk":"normal","cwd":"/Users/demo/Projects/willow","createdAt":"\#(Sample.iso(30))"\#(extra)}
        """#)]
      return TranscriptRows.build(state: state, sessionId: "s1").compactMap { row in
        if case let .permission(card) = row { card.command } else { nil }
      }.first
    }
    #expect(command(#","subject":"plan","# + Self.truncation) == "## Plan\n\n1. krok\n… (ucięto 1200 znaków)")
    #expect(command("," + Self.truncation) == "## Plan\n\n1. krok\n… (ucięto 1200 znaków)", "komenda")
    #expect(command(#","subject":"plan""#) == wire)
  }

  @Test("karta limitu: godzina z `stateDetailRef.args[0]`, także gdy `stateDetail` przyszedł już przetłumaczony")
  func limitCard() throws {
    let reset = "2026-10-04T12:00:00Z"
    let clock = try #require(ServerTime.clock(reset))
    let session = Sample.session(state: "limit-reached", extra: #"""
      "stateDetail":"Limit planu — spróbuj po 09:41.","stateDetailRef":{"code":"state.limit-reached","args":["\#(reset)"]}
      """#)
    let card = try #require(StateCards.make(state: Sample.state(session: session), sessionId: "s1"))
    #expect(card.text.hasPrefix("Limit planu — spróbuj po \(clock)."), "\(card.text)")
    #expect(UICopy.sendBlock(.stateCard(.limitReached), session: session) == "Limit planu — spróbuj po \(clock).")
  }
}
