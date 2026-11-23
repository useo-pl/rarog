import Foundation
import RarogContract
import RarogCore

// Karty decyzji i ich słowa, wspólne z linią listy „na co czeka".
// Właściciel: karty.
extension UICopy {
  // MARK: Słowa rodzajów decyzji — wspólne dla nagłówka karty i linii listy

  static var waitingPermission: String { L("cards.waitingPermission") }
  static var waitingPlan: String { L("cards.waitingPlan") }
  static var waitingQuestion: String { L("cards.waitingQuestion") }
  static var waitingDialog: String { L("cards.waitingDialog") }
  static var dialogChip: String { L("cards.dialogChip") }
  /// Zastępnik karty decyzji w okresie łaski (`DecisionPendingView`): stan postępu, nie przycisk.
  static var decisionPending: String { L("cards.decisionPending") }

  /// Miejsce karty w kolejce decyzji, w nagłówku doku w miejscu pola: „1 z 3”.
  static func dockPosition(_ position: Int, of total: Int) -> String { L("cards.dock.position", position, total) }

  static func refuseEyebrow(_ reason: RefuseReason) -> String {
    switch reason {
    case .mismatch: L("cards.refuseEyebrow.mismatch")
    case .unreadable: L("cards.refuseEyebrow.unreadable")
    case .noJsonl: L("cards.refuseEyebrow.noJsonl")
    case .multiSelect: L("cards.refuseEyebrow.multiSelect")
    case .noDigit: L("cards.refuseEyebrow.noDigit")
    case .terminalOnly: L("cards.refuseEyebrow.terminalOnly")
    case .screenChanged: L("cards.refuseEyebrow.screenChanged")
    case .staleCard: L("cards.refuseEyebrow.staleCard")
    case .formSubmit: L("cards.refuseEyebrow.formSubmit")
    case .sendFailed: L("cards.refuseEyebrow.sendFailed")
    case .inFlight: L("cards.refuseEyebrow.inFlight")
    case .consentDialog: L("cards.refuseEyebrow.consentDialog")
    }
  }

  /// Klasa dialogu z rejestru sesji Claude Code po ludzku — fraza do chipu, linii listy
  /// i (wielką literą) pierwszego zdania karty bez decyzji. `other` frazy nie ma: „jakiś dialog"
  /// karta mówi i bez rejestru. `worker` z docs (`agent-view.md`, „List sessions as JSON”: `worker request`),
  /// niezmierzone na żywo; `goal` to klasa kontraktu bez wartości w rejestrze (`server/src/cli-version.ts`).
  static func cliDialogPhrase(_ cliDialog: CliDialogClass?) -> String? {
    switch cliDialog {
    case .permission?: L("cards.cliDialogPhrase.permission")
    case .input?: L("cards.cliDialogPhrase.input")
    case .sandbox?: L("cards.cliDialogPhrase.sandbox")
    case .worker?: L("cards.cliDialogPhrase.worker")
    case .dialog?: L("cards.cliDialogPhrase.dialog")
    case .goal?: L("cards.cliDialogPhrase.goal")
    case .other?, nil: nil
    }
  }

  /// Pierwsze zdanie karty bez decyzji: „Zgoda na sieć w terminalu.” albo pusty napis bez klasy. Osobne klucze od
  /// ``cliDialogPhrase(_:)``: zdanie z klasą na początku, nie fraza wielką literą z doklejonym ogonem.
  static func cliDialogLead(_ cliDialog: CliDialogClass?) -> String {
    switch cliDialog {
    case .permission?: L("cards.cliDialogLead.permission")
    case .input?: L("cards.cliDialogLead.input")
    case .sandbox?: L("cards.cliDialogLead.sandbox")
    case .worker?: L("cards.cliDialogLead.worker")
    case .dialog?: L("cards.cliDialogLead.dialog")
    case .goal?: L("cards.cliDialogLead.goal")
    case .other?, nil: ""
    }
  }

  /// Zdanie klasy dialogu przed drugim zdaniem karty: „Zgoda na sieć w terminalu. Odpowiedz tam albo odrzuć
  /// dialog.”; bez klasy samo drugie zdanie.
  static func cliDialogText(_ cliDialog: CliDialogClass?, then text: String) -> String {
    let lead = cliDialogLead(cliDialog)
    return lead.isEmpty ? text : L("cards.cliDialogLead.withText", lead, text)
  }

  static func knownDialog(_ dialog: KnownDialogID) -> String {
    switch dialog {
    case .trust: L("cards.knownDialog.trust")
    case .model: L("cards.knownDialog.model")
    }
  }

  /// Nagłówek karty pytania: „pytanie" przy jednym, „pytanie 2/3" przy kilku.
  public static func questionEyebrow(index: Int, total: Int) -> String {
    total <= 1 ? waitingQuestion : L("cards.questionEyebrow.numbered", index, total)
  }

  /// Nagłówek karty zgody: ryzyko bije nazwę narzędzia, plan nie jest „zgodą na narzędzie".
  public static func permissionEyebrow(toolName: String, risky: Bool, plan: Bool) -> String {
    if risky { return L("cards.permissionEyebrow", waitingPermission) }
    return plan ? waitingPlan : L("cards.permissionEyebrow.tool", toolName)
  }
  // MARK: Karta zgody

  public static var allow: String { L("cards.allow") }
  public static var allowPlanAuto: String { L("cards.allowPlanAuto") }
  public static var planAutoUnavailable: String { L("cards.planAutoUnavailable") }
  public static var deny: String { L("cards.deny") }
  public static var allowing: String { L("cards.allowing") }
  public static var denying: String { L("cards.denying") }
  public static var allowedWaiting: String { L("cards.allowedWaiting") }
  public static var deniedWaiting: String { L("cards.deniedWaiting") }
  public static var denyOnly: String { L("cards.denyOnly") }

  // MARK: Karta kanału zgód

  public static var consentSandboxDisabled: String { L("cards.consent.sandboxDisabled") }
  public static var consentAllowPlan: String { L("cards.consent.allowPlan") }
  /// Stopka i VoiceOver karty kanału po przyjętej (200) zgodzie albo odmowie z tego urządzenia: 200 znaczy tylko, że
  /// serwer przyjął odpowiedź, więc zdanie nie mówi „Zatwierdzono” ani „czekam na ekran” (stan niesie `consentState`).
  public static var consentAllowSent: String { L("cards.consent.allowSent") }
  public static var consentDenySent: String { L("cards.consent.denySent") }
  /// Pole wejścia karty kanału pod komendą: nazwa pola i wartość, obie dosłownie od serwera.
  public static func consentField(name: String, value: String) -> String { L("cards.consent.field", name, value) }
  public static var consentPlanReturns: String { L("cards.consent.planReturns") }
  /// Button under the preview of a long request: opens the window with the whole input, „Pokaż całą prośbę · 3200 linii”.
  public static func consentShowFullInput(lines: Int) -> String { L("cards.consent.showFullInput", lines) }
  /// Kind of the window with the whole input, before the tool name in its title.
  public static var consentFullInputTitle: String { L("cards.consent.fullInputTitle") }
  /// Line by the greyed consent buttons of a long request until its window was open.
  public static var consentOpenFullToAllow: String { L("cards.consent.openFullToAllow") }
  /// The same line by the greyed plan approval.
  public static var consentOpenFullToApprove: String { L("cards.consent.openFullToApprove") }
  /// Nagłówek kafla „zawsze” karty kanału; pod nim drobno ``consentAlways(_:)``.
  public static var consentAlwaysHead: String { L("cards.consent.alwaysHead") }

  /// Opcja „zawsze” karty kanału: każda zmiana w osobnym wierszu, dosłownie (reguła, tryb, katalog), z celem
  /// zapisu; `nil` = pusta lista, bez opcji.
  public static func consentAlways(_ entries: [ConsentAlwaysEntry]) -> String? {
    let lines = entries.map { entry in
      let what = switch entry.kind {
      case .rule: entry.value
      case .mode: L("cards.consent.alwaysMode", entry.value)
      case .directory: L("cards.consent.alwaysDirectory", entry.value)
      }
      return switch entry.destination {
      case .session: L("cards.consent.alwaysSession", what)
      case .localSettings: L("cards.consent.alwaysLocalSettings", what)
      }
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
  }

  /// Zdanie stanu karty kanału pod komendą; `nil` = karta czeka na decyzję (bez zdania).
  public static func consentState(_ state: ConsentCardState?) -> String? {
    switch state {
    case nil, .pending: nil
    case .sent: L("cards.consent.state.sent")
    case .claimed: L("cards.consent.state.claimed")
    case .running: L("cards.consent.state.running")
    case .unknown: L("cards.consent.state.unknown")
    case .applied, .settledAtDesk, .revoked, .released: L("cards.consent.state.final")
    case .unsupported: L("cards.consent.state.unsupported")
    }
  }

  /// Why a card cannot be allowed from the phone: a channel card always, a screen card when the server sent the
  /// reason (without it the screen card keeps "deny only").
  public static func consentUnavailable(_ reason: ConsentUnavailableReason?) -> String {
    switch reason {
    case .terminalOnly: L("cards.consent.unavailable.subagent")
    case .truncated, .noContent, .hiddenChars: L("cards.consent.unavailable.notShown")
    case .settingsChanged: L("cards.consent.unavailable.settingsChanged")
    case .otherHook: L("cards.consent.unavailable.otherHook")
    case .unverifiedHooks: L("cards.consent.unavailable.unverifiedHooks")
    case nil, .noChannel, .cardMismatch, .keyBlocked, .hookDead, .noProof, .serverRestart, .unsupported:
      L("cards.consent.unavailable.terminal")
    }
  }
  public static var screenHeader: String { L("cards.screenHeader") }
  public static var decidedElsewhere: String { L("cards.decidedElsewhere") }
  public static var permissionExpired: String { L("cards.permissionExpired") }
  public static var decisionFailed: String { L("cards.decisionFailed") }
  public static var decisionOffline: String { L("cards.decisionOffline") }
  public static var decisionTerminalOnly: String { L("cards.decisionTerminalOnly") }

  /// Nagłówek karty zgody dla czytnika: rodzaj, narzędzie, ryzyko, katalog — człony po przecinku.
  public static var permissionPlanSpoken: String { L("cards.permissionPlanSpoken") }
  public static func permissionToolSpoken(_ toolName: String) -> String { L("cards.permissionToolSpoken", toolName) }
  public static var permissionRiskySpoken: String { L("cards.permissionRiskySpoken") }
  public static func permissionDirectorySpoken(_ cwd: String) -> String { L("cards.permissionDirectorySpoken", cwd) }
  /// Blok komendy karty zgody dla czytnika: „Plan: …” albo „Komenda: …”.
  public static func permissionCommandSpoken(_ command: String, plan: Bool) -> String {
    plan ? L("cards.permissionCommandSpoken.plan", command) : L("cards.permissionCommandSpoken.command", command)
  }

  /// „⌄ widzisz N z M linii — przewiń w bloku": sufit bez wskaźnika to ciche ucięcie.
  public static func commandClipped(shown: Int, total: Int) -> String {
    L("cards.commandClipped", shown, total)
  }

  /// „⌃ widzisz N z M linii — przewiń w górę" pod blokiem „Co widać w terminalu": blok startuje od dołu ekranu
  /// (dialog z opcjami), więc ucięta część jest NAD nim.
  public static func screenClipped(shown: Int, total: Int) -> String {
    L("cards.screenClipped", shown, total)
  }

  /// Zdanie pod kartą po wyniku decyzji; `nil` = nic do powiedzenia (karta znika albo czeka).
  public static func decisionResult(_ outcome: DecisionOutcome) -> String? {
    switch outcome {
    case .accepted, .cardGone, .alreadyInFlight, .loggedOut, .alreadyDecided, .expired: nil
    case .notAllowed: decisionTerminalOnly
    case .offline: decisionOffline
    case let .refusedByClient(message): message
    case let .refused(message): message ?? decisionFailed
    case .failed: decisionFailed
    }
  }

  /// Ślad karty zdjętej nie z naszej decyzji.
  public static func notice(_ reason: CardNotice.Reason) -> String {
    switch reason {
    case .resolvedElsewhere, .alreadyDecided: decidedElsewhere
    case .expired: permissionExpired
    }
  }

  // MARK: Karta pytania. Właściciel: karty pytań.

  public static var questionSubmit: String { L("cards.questionSubmit") }
  /// Karta bez „Odpowiedz" mówi, że tapnięcie wysyła.
  public static var questionInstantHint: String { L("cards.questionInstantHint") }
  public static var questionCustomLabel: String { L("cards.questionCustomLabel") }
  public static var questionCustomPlaceholder: String { L("cards.questionCustomPlaceholder") }
  /// Plakietka rekomendacji autora — SŁOWO, nie sam kolor.
  public static var questionRecommended: String { L("cards.questionRecommended") }
  /// Dopisek przy opcji, której z telefonu wybrać nie można.
  public static var questionTerminalOnly: String { L("cards.questionTerminalOnly") }
  /// Skutek przycisku wyjścia z formularza (etykieta przycisku jest dosłowna).
  public static var questionExitNote: String { L("cards.questionExitNote") }
  public static var questionExpired: String { L("cards.questionExpired") }
  public static var questionOffline: String { L("cards.questionOffline") }
  /// Odmowa serwera bez zdania (normalnie treść niesie ciało odpowiedzi).
  public static var questionRefusedFallback: String { L("cards.questionRefusedFallback") }
  public static var questionMissingAny: String { L("cards.questionMissingAny") }

  /// Ekran przeglądu formularza: zdanie w miejscu surowej treści ekranu.
  public static var questionReviewTitle: String { L("cards.questionReviewTitle") }
  /// Para przeglądu bez wartości (serwer nie odczytał odpowiedzi z ekranu).
  public static var questionReviewNoAnswer: String { L("cards.questionReviewNoAnswer") }

  /// Para przeglądu dla czytnika: „pytanie: odpowiedź, odpowiedź".
  public static func questionReviewSpoken(question: String, answers: [String]) -> String {
    L("cards.questionReviewSpoken", question, answers.isEmpty ? questionReviewNoAnswer : list(answers, .comma))
  }

  /// Podpis bloku podglądu opcji — mówi, CZYJ to podgląd.
  public static func questionPreviewCaption(_ label: String) -> String { L("cards.questionPreviewCaption", label) }

  /// Blok podglądu dla czytnika: etykieta opcji i cała treść (blok jest jednym elementem).
  public static func questionPreviewSpoken(label: String, preview: String) -> String {
    L("cards.questionPreviewSpoken", label, preview)
  }

  /// Pole notatki do wybranej opcji — etykieta i podpowiedź.
  public static var questionNoteLabel: String { L("cards.questionNoteLabel") }
  public static var questionNotePlaceholder: String { L("cards.questionNotePlaceholder") }
  /// Notatka bez jednej opcji z listy — to samo zdanie, którym odmawia serwer (`checkAnswerNotes`).
  public static var questionNoteNeedsOption: String { L("cards.questionNoteNeedsOption") }
  /// Suma odpowiedzi i notatek ponad sufit żądania — to samo zdanie co serwer.
  public static var questionNotesTooLong: String { L("cards.questionNotesTooLong") }

  /// Nagłówek sekcji: „pytanie 2/3 · nagłówek" przy kilku pytaniach, sam nagłówek przy jednym.
  public static func questionSectionHead(index: Int, total: Int, header: String) -> String {
    let number = total > 1 ? questionEyebrow(index: index, total: total) : ""
    return list([number, header].filter { !$0.isEmpty }, .dot)
  }

  /// Nagłówek karty pytania dla czytnika ekranu.
  public static func questionSpokenHeader(total: Int) -> String {
    total > 1 ? L("cards.questionSpokenHeader.form", total) : L("cards.questionSpokenHeader.single")
  }

  /// Karta w locie: NAZYWA to, co poszło, i mówi, na co Rarog czeka.
  public static func questionSending(_ summary: String) -> String {
    summary.isEmpty ? L("cards.questionSending.empty") : L("cards.questionSending", summary)
  }

  /// Karta po sukcesie — to samo zdanie w czasie przeszłym.
  public static func questionSent(_ summary: String) -> String {
    summary.isEmpty ? L("cards.questionSent.empty") : L("cards.questionSent", summary)
  }

  /// „Brakuje odpowiedzi" — z nazwą pytania, gdy pytań jest kilka; przy polu własnej
  /// odpowiedzi zdanie wymienia obie drogi.
  public static func questionMissing(total: Int, question: String, customAnswer: Bool) -> String {
    if total <= 1 { return customAnswer ? L("cards.questionMissing.orCustom") : L("cards.questionMissing.single") }
    let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? questionMissingAny : L("cards.questionMissing.named", trimmed)
  }

  /// Zdanie pod kartą po wyniku odpowiedzi; `nil` = nic do powiedzenia (karta znika, czeka albo
  /// ekran wylogowany).
  public static func answerResult(_ outcome: AnswerOutcome) -> String? {
    switch outcome {
    case .accepted, .cardGone, .alreadyInFlight, .loggedOut, .discarded, .alreadyDecided, .expired: nil
    case .incomplete: questionMissingAny
    case .offline: questionOffline
    case let .refusedByClient(message): message
    case let .refused(message): message ?? questionRefusedFallback
    case .failed: decisionFailed
    }
  }

  /// Ślad karty pytania zdjętej nie z naszej odpowiedzi.
  public static func questionNotice(_ reason: CardNotice.Reason) -> String {
    switch reason {
    case .resolvedElsewhere, .alreadyDecided: decidedElsewhere
    case .expired: questionExpired
    }
  }

  // MARK: Ślad własnej decyzji w transkrypcie

  /// „Zatwierdzono: Bash · npm test”, „Odrzucono: plan”, „Odpowiedź: Postgres”, „Odpowiedzi: Postgres · PWA, Swift”:
  /// przedmiot jak w nagłówku karty (narzędzie i skrót komendy albo „plan”), odpowiedzi w kolejności pytań —
  /// pytania po „·”, wartości jednego pytania po przecinku. Treść z CLI i od człowieka skracana, bez tłumaczenia.
  /// Karta kanału zgód mówi „Zgoda wysłana: …” / „Odmowa wysłana: …”, nigdy „Zatwierdzono”: 200 znaczy tylko,
  /// że serwer przyjął odpowiedź i oddał ją hookowi, nie że narzędzie się wykonało.
  public static func decisionTrace(_ trace: DecisionTrace) -> String {
    switch trace.outcome {
    case .allowed where trace.hookChannel: return L("cards.trace.allowSent", decisionTraceSubject(trace))
    case .denied where trace.hookChannel: return L("cards.trace.denySent", decisionTraceSubject(trace))
    // Zgoda na plan po angielsku to „Approved” (słownik `native/Rarog/Localization/TRANSLATION.md`, „Decisions”).
    case .allowed where trace.plan: return L("cards.trace.allowed.plan")
    case .allowed: return L("cards.trace.allowed", decisionTraceSubject(trace))
    case .denied: return L("cards.trace.denied", decisionTraceSubject(trace))
    case .answered:
      let answers = trace.answers.map { list($0.map(DecisionTraceText.clip), .comma) }
      return answers.count > 1
        ? L("cards.trace.answers", list(answers, .dot)) : L("cards.trace.answer", answers.first ?? "")
    }
  }

  private static func decisionTraceSubject(_ trace: DecisionTrace) -> String {
    if trace.plan { return waitingPlan }
    let command = DecisionTraceText.clip(trace.command ?? "")
    let tool = trace.toolName ?? ""
    return list([tool, command].filter { !$0.isEmpty }, .dot)
  }

  // MARK: Pełny przebieg karty zgody i eskalacja

  /// Wiersz stanu po tapnięciu w opcję eskalującą: jej dosłowna etykieta jest całym jej znaczeniem.
  public static func allowingAlways(_ label: String) -> String { L("cards.allowingAlways", label) }
  public static func allowedAlwaysWaiting(_ label: String) -> String { L("cards.allowedAlwaysWaiting", label) }
  public static var allowedSpoken: String { L("cards.allowedSpoken") }
  public static var deniedSpoken: String { L("cards.deniedSpoken") }
  /// Etykieta dostępna przycisku eskalacji: czytnik słyszy, że to więcej niż „ten jeden raz".
  public static func alwaysSpoken(_ label: String) -> String { L("cards.alwaysSpoken", label) }

  // MARK: Dialog w terminalu

  static var dialogDeny: String { L("cards.dialogDeny") }
  static var dialogHint: String { L("cards.dialogHint") }
  /// Druga połowa `dialogHint` po zdaniu klasy z rejestru CLI.
  static var cliDialogHint: String { L("cards.cliDialogHint") }
  static var dialogConfirm: String { L("cards.dialogConfirm") }
  static var dialogConfirmSpoken: String { L("cards.dialogConfirmSpoken") }
  static var dialogDenied: String { L("cards.dialogDenied") }
  static var dialogAllowedFallback: String { L("cards.dialogAllowedFallback") }
  static var dialogDenying: String { L("cards.dialogDenying") }
  static var dialogFailed: String { L("cards.dialogFailed") }
  static var dialogGone: String { L("cards.dialogGone") }
  /// Zatwierdzenie karty, pod którą serwer podmienił dialog — nic nie wyszło.
  static var dialogChanged: String { L("cards.dialogChanged") }
  /// VoiceOver z podłączoną klawiaturą: aktywacja „Zatwierdź" nie zatwierdza, bo VO+Spacja i dwukrotne
  /// stuknięcie przychodzą tą samą akcją (`ApprovalGate`).
  static var approvalKeyboardSpoken: String { L("cards.approvalKeyboardSpoken") }

  /// Copy karty dialogu: `allowLabel == nil` = KARTA BEZ ZATWIERDZANIA (dialog spoza zamkniętej
  /// listy sygnatur — Rarog nie wie, co zatwierdza). Bez „(Esc)" w etykietach: iPhone nie ma
  /// tego klawisza, a Esc to sposób, w jaki serwer wysyła decyzję, nie coś do naciśnięcia.
  struct HerdrDialogCopy: Equatable {
    let eyebrow: String
    let text: String
    let allowLabel: String?
    let allowSpoken: String
    let denyLabel: String
  }

  static func herdrDialog(
    _ id: KnownDialogID?, reason: RefuseReason?, cliDialog: CliDialogClass? = nil
  ) -> HerdrDialogCopy {
    switch id {
    case .trust?:
      HerdrDialogCopy(
        eyebrow: knownDialog(.trust),
        text: L("cards.herdrDialog.trust.text"),
        allowLabel: L("cards.herdrDialog.trust.allowLabel"), allowSpoken: L("cards.herdrDialog.trust.allowSpoken"), denyLabel: L("cards.herdrDialog.trust.denyLabel"))
    case .model?:
      HerdrDialogCopy(
        eyebrow: knownDialog(.model),
        text: L("cards.herdrDialog.model.text"),
        allowLabel: L("cards.herdrDialog.model.allowLabel"), allowSpoken: L("cards.herdrDialog.model.allowSpoken"), denyLabel: L("cards.herdrDialog.model.denyLabel"))
    case nil:
      unknownDialog(reason: reason, cliDialog: cliDialog)
    }
  }

  /// Karta dialogu nierozpoznanego. POWÓD w etykiecie i w zdaniu: bez niego zostaje ogólnik dla
  /// starszego serwera. KLASA z rejestru CLI stoi pierwszym zdaniem i zastępuje wyłącznie
  /// powód `no-jsonl` („Rarog nie wie, co stoi w tym dialogu") — na dokładnie to pytanie odpowiada.
  private static func unknownDialog(reason: RefuseReason?, cliDialog: CliDialogClass?) -> HerdrDialogCopy {
    let classified = !cliDialogLead(cliDialog).isEmpty
    let why = classified && reason == .noJsonl ? nil : reason
    let tail = why.map(refuseEyebrow) ?? cliDialogPhrase(cliDialog)
    return HerdrDialogCopy(
      eyebrow: tail.map(dialogChipDetail) ?? dialogChip,
      text: cliDialogText(cliDialog, then: why.map { refuseMessage($0) } ?? (classified ? cliDialogHint : dialogHint)),
      allowLabel: nil, allowSpoken: "", denyLabel: dialogDeny)
  }

  /// Etykieta karty i linia listy przy dialogu w terminalu z dopiskiem: „dialog w terminalu · zgoda na sieć”.
  static func dialogChipDetail(_ detail: String) -> String { L("cards.dialogChipDetail", detail) }

  /// Zdanie powodu odmowy: kod `dialogs.refuse.<powód>` z rejestru zdań serwera, złożony fasadą
  /// ``ServerText/sentence(code:args:language:)`` z katalogu RarogContract — to samo zdanie, które serwer wysyła
  /// w ciele 422 (`REFUSE_MESSAGES` w `shared/src/protocol.ts` = `en` rejestru). `switch` jest wyczerpujący: nowy
  /// powód bez kodu nie kompiluje się, a kod spoza rejestru łapie `ServerSentenceCardsTests`.
  static func refuseMessage(_ reason: RefuseReason, language: CopyLanguage = .current) -> String {
    let code = switch reason {
    case .mismatch: "dialogs.refuse.mismatch"
    case .unreadable: "dialogs.refuse.unreadable"
    case .noJsonl: "dialogs.refuse.no-jsonl"
    case .multiSelect: "dialogs.refuse.multi-select"
    case .noDigit: "dialogs.refuse.no-digit"
    case .terminalOnly: "dialogs.refuse.terminal-only"
    case .screenChanged: "dialogs.refuse.screen-changed"
    case .staleCard: "dialogs.refuse.stale-card"
    case .formSubmit: "dialogs.refuse.form-submit"
    case .sendFailed: "dialogs.refuse.send-failed"
    case .inFlight: "dialogs.refuse.in-flight"
    case .consentDialog: "dialogs.refuse.consent-dialog"
    }
    return ServerText.sentence(code: code, language: language)
  }

  /// Tekst ucięty przez serwer (`truncation` przy `detail` narzędzia i `displayText` karty zgody): prefiks bez
  /// angielskiej stopki serwera (`footer` skalarów Unicode z końca) i stopka apki `transcript.truncation-footer`
  /// z liczbą uciętych znaków. Bez `truncation` (tekst w całości albo serwer bez tego pola) tekst bez zmian.
  static func truncated(_ text: String, _ truncation: Truncation?, language: CopyLanguage = .current) -> String {
    guard let truncation else { return text }
    let scalars = text.unicodeScalars
    let kept = String(String.UnicodeScalarView(scalars.prefix(max(0, scalars.count - truncation.footer))))
    return kept + ServerText.sentence(
      code: "transcript.truncation-footer", args: [String(truncation.cut)], language: language)
  }

  /// Podpis obrazu zastępczego serwera (`placeholder: true`): zdanie `transcript.snapshot-image-alt` w języku apki.
  static func snapshotImageAlt(language: CopyLanguage = .current) -> String {
    ServerText.sentence(code: "transcript.snapshot-image-alt", language: language)
  }

  /// Zdanie po decyzji o dialogu; `nil` = nic do powiedzenia (wylogowanie, drugi tap w locie).
  static func dialogResult(
    _ outcome: DialogDecisionOutcome, decision: PermissionDecision, allowSpoken: String
  ) -> (text: String, isError: Bool)? {
    switch outcome {
    case .accepted:
      decision == .deny ? (dialogDenied, false) : (allowSpoken.isEmpty ? dialogAllowedFallback : allowSpoken, false)
    case .inFlight, .loggedOut, .notShown: nil
    case .notAllowed: (decisionTerminalOnly, true)
    case .offline: (decisionOffline, true)
    case let .refused(message): (message ?? dialogFailed, true)
    case .expired: (dialogGone, true)
    case .changed: (dialogChanged, true)
    case .failed: (dialogFailed, true)
    }
  }

  // MARK: Karta stanu

  static var stateEyebrowLimit: String { L("cards.stateEyebrowLimit") }
  static var stateEyebrowInterrupted: String { L("cards.stateEyebrowInterrupted") }
  static var stateEyebrowError: String { L("cards.stateEyebrowError") }
  static var stateEyebrowDone: String { L("cards.stateEyebrowDone") }
  static var stateEyebrowUnsupported: String { L("cards.stateEyebrowUnsupported") }
  static var stateEyebrowCodex: String { L("cards.stateEyebrowCodex") }
  static var stateEyebrowOutOfScope: String { L("cards.stateEyebrowOutOfScope") }
  static var stateInterrupted: String { L("cards.stateInterrupted") }
  static var stateResumable: String { L("cards.stateResumable") }
  static var stateError: String { L("cards.stateError") }
  static var stateDone: String { L("cards.stateDone") }
  /// Sesja z żywym panelem: wznawiać nie ma czego, agent czeka w terminalu.
  static var herdrLiveCard: String { L("cards.herdrLiveCard") }
  public static var resume: String { L("cards.resume") }
  public static var resuming: String { L("cards.resuming") }
  static var resumeFailed: String { L("cards.resumeFailed") }
  public static var newSession: String { L("cards.newSession") }
  static var closePanelQuestion: String { L("cards.closePanelQuestion") }

  /// Zdanie po „Wznów"; `nil` = bez zdania (sukces mówi „Wznawiam…" do zmiany stanu).
  static func resumeResult(_ outcome: CardActionOutcome) -> String? {
    switch outcome {
    case .accepted, .loggedOut, .inFlight: nil
    case .notAllowed: herdrLiveCard
    case let .refused(message): message ?? resumeFailed
    case .offline: decisionOffline
    case .timedOut: timedOut
    case .failed: resumeFailed
    }
  }

  /// Zdanie dla czytnika przy karcie stanu: rodzaj i treść.
  static func stateCardSpoken(_ card: StateCardModel) -> String { L("cards.stateCardSpoken", card.eyebrow, card.text) }
}
