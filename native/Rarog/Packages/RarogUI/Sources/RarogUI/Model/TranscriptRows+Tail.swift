import Foundation
import RarogContract
import RarogCore

// Wiersze pod treścią: wpisy kolejki, karty decyzji i ślady kart.
// Właściciele: wpisy kolejki (`pendingRows`) — wysyłka; karty i ślady — karty.
extension TranscriptRows {
  /// Wpisy kolejki, karty i ślady — pod treścią, w tej kolejności (karta stoi na dnie).
  static func tail(
    state: AppState, sessionId: String, session: SessionSummary?, ui: TranscriptUIState, docked: DecisionCard? = nil,
    dockedPending: Bool = false, previous: MessageRole?, calendar: Calendar = deviceCalendar, now: Date = Date()
  ) -> [TranscriptRow] {
    var rows = pendingRows(state: state, sessionId: sessionId, ui: ui, previous: previous, calendar: calendar)
    guard let view = state.transcripts[sessionId] else { return rows }
    let locked = lockedReason(state: state, session: session)
    // Ostrzeżenie o zaufaniu katalogu nad kartą, która może po nim przyjść.
    if state.showsTrustPrompt(sessionId) {
      rows.append(.notice(id: "trust", text: UICopy.trustPrompt))
    }
    // Karta w doku stoi w miejscu pola, nie w transkrypcie (`DecisionDock`).
    for request in view.pendingPermissions where docked != .permission(permId: request.permId) {
      rows.append(.permission(permissionCard(request, view: view, session: session, ui: ui, locked: locked)))
    }
    // Karty pytań (z kolejki i trzymane potwierdzeniem): `Model/QuestionCardModel`.
    rows += questionRows(view: view, ui: ui, locked: locked, docked: docked)
    // Karta „dialog w terminalu" nie staje, gdy odpowiedź na pytanie leci albo stoi jej potwierdzenie:
    // sesja jeszcze czeka, ale to czekanie jest już rozstrzygane z tej karty.
    // Karta w doku stoi w miejscu pola, nie tutaj.
    if !ui.questions.holdsDialogCard, !docked.isHerdrDialog {
      if let dialog = HerdrDialogCards.make(state: state, sessionId: sessionId, ui: ui.dialog, locked: locked, now: now) {
        rows.append(.herdrDialog(dialog))
      } else if !dockedPending, state.decisionLoading(for: sessionId, now: now) {
        // Okres łaski: karta docelowa zwykle dochodzi w ok. 0,6–1,3 s, a karta zapasowa mignęłaby przed nią.
        // Z dokiem zastępnik stoi w miejscu pola (`dockedPending`), nie tutaj.
        rows.append(.decisionPending)
      }
    }
    // Ślady kart zdjętych nie z naszej decyzji (6 s). Ślad WŁASNEJ decyzji stoi między wiadomościami, na miejscu
    // decyzji, nie tutaj (`TranscriptRows+Traces`).
    for notice in state.notices where notice.sessionId == sessionId {
      let text = notice.kind == .question ? UICopy.questionNotice(notice.reason) : UICopy.notice(notice.reason)
      rows.append(.notice(id: "n\(notice.cardId)", text: text))
    }
    return rows
  }

  /// Wpisy kolejki w układzie przyszłego echa: tekst, miniatury załączników z pierścieniem postępu, a wiersz statusu
  /// tylko wtedy, gdy człowiek ma coś zrobić („Nie potwierdzono" z „Ponów", odmowa). Sam załącznik bez tekstu to
  /// wiadomość bez wiersza tekstu. Właściciel: wysyłka.
  static func pendingRows(
    state: AppState, sessionId: String, ui: TranscriptUIState, previous: MessageRole?, calendar: Calendar = deviceCalendar
  ) -> [TranscriptRow] {
    var rows: [TranscriptRow] = []
    var last = previous
    // Każdy wpis to wiadomość człowieka: nowa tura nad pierwszym wierszem, jak u przyszłego echa.
    var turns = TurnBoundaries()
    turns.continueAfterContent()
    // A take-back without an answer: the server may hold the texts of Not confirmed bubbles too.
    let keepsTakeBack = state.keepsTakeBack(sessionId)
    // A take-back request in flight: every queued entry shows it from the gesture until the answer.
    let takingBack = state.isTakingBackQueue(sessionId)
    for entry in state.outboxEntries(for: sessionId) {
      let voice: VoiceLabel? = last == .user ? nil : .user
      let progress = state.sendProgress[entry.id]
      let entryTakingBack = takingBack && entry.isQueued
      var block: [TranscriptRow] = []
      if !entry.text.isEmpty {
        block.append(.pending(
          entry: entry.id, voice: voice, text: entry.text, inFlight: entry.isWaiting, queued: entry.isQueued,
          replaysTakeBack: keepsTakeBack && entry.state == .unconfirmed, takingBack: entryTakingBack))
      }
      let mediaVoice = entry.text.isEmpty ? voice : nil
      if let media = PendingMediaModel.make(entry: entry, voice: mediaVoice, progress: progress) {
        block.append(.attachments(media))
      }
      // Godzina wpisu z chwili wysłania na urządzeniu (echo przyniesie czas serwera, zwykle tę samą minutę).
      block.markPrompt(
        clock: ServerTime.clock(entry.createdAt, timeZone: calendar.timeZone), expanded: ui.reading.expandedPrompts)
      turns.mark(&block, prompt: true)
      rows += block
      last = .user
      let retrying = ui.retrying.contains(entry.id)
      switch entry.state {
      case .queued, .sent:
        // An entry in flight has no status row: the plate's shimmer (`PlateShimmer`) says it is still on its way,
        // the ring on the thumbnails shows an attachment's progress, and VoiceOver hears „w drodze”. A status row
        // would add height and vanish with the echo, so the transcript would jump. The exception is a queued entry
        // while its take-back waits for the server: the human must see at once that the gesture worked, and a taken
        // bubble leaves with its row anyway.
        if entryTakingBack {
          rows.append(.pendingStatus(entry: entry.id, status: .takingBack, retrying: retrying))
        }
      case .unconfirmed:
        rows.append(.pendingStatus(entry: entry.id, status: .unconfirmed, retrying: retrying))
      case .refused(OutboxEntry.RefusalCode.cancelled?, _):
        // The user's own stop is not an error: the muted line of "Not confirmed.", not the red refusal.
        rows.append(.pendingStatus(entry: entry.id, status: .stopped, retrying: retrying))
      case let .refused(code, message):
        let text = UICopy.refusal(code: code, message: message) ?? UICopy.refusedFallback
        rows.append(.pendingStatus(
          entry: entry.id, status: entry.isRetryable ? .refused(text) : .refusedFinal(text), retrying: retrying))
      }
    }
    return rows
  }

  static func permissionCard(
    _ request: PermissionRequest, view: TranscriptState, session: SessionSummary?, ui: TranscriptUIState, locked: String?
  ) -> PermissionCardModel {
    let risky = request.risk == .red
    let plan = request.subject == .plan
    let phase: CardPhase
    // Przyjęcie (200) stoi we wpisie decyzji w store, więc „wysłano” przeżywa zmianę sesji (nowy kontroler ekranu).
    if let attempt = view.decisions[request.permId], let choice = PermissionDecision(rawValue: attempt.choice) {
      phase = attempt.accepted ? .sent(choice) : .sending(choice)
    } else {
      phase = .idle
    }
    // Karta kanału, której stanu albo uwagi ta wersja apki nie zna, nie ma żadnego przycisku.
    let canAllow = request.canAllow != false && !request.isUnsupportedHookCard
    // Opcja eskalująca tylko z etykietą od serwera i tylko na karcie, którą da się zatwierdzić. Karta kanału:
    // dosłowne zmiany z listy `always` z celem zapisu, bez opcji na karcie planu.
    let always: String? = if !canAllow {
      nil
    } else if request.isHookChannel {
      plan ? nil : UICopy.consentAlways(request.always ?? [])
    } else {
      request.alwaysLabel.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }
    // Komenda albo plan ucięte przez serwer (`truncation`) kończą się stopką apki, nie angielską z drutu.
    // A long input (channel card up to 1 MiB) shows a preview in the block; the whole input waits for the window.
    let shown = ConsentInputPreview.card(
      command: UICopy.truncated(request.displayText, request.truncation),
      fields: request.isHookChannel ? request.fields ?? [] : [])
    let command = shown.command
    // Kolor po polu od serwera, nigdy po nazwie narzędzia — karta z ekranu też bywa „Bash", a jej tekst
    // to linie dialogu z opisem. Plan to markdown, nie komenda. Karta przelicza się przy każdej zmianie stanu,
    // więc tokeny idą z pamięci skanów (tekst karty się nie zmienia).
    let commandSyntax = request.inputKind == .shell && !plan
      ? SyntaxCache.shared.tokens(command, language: "sh", closed: true) : []
    var model = PermissionCardModel(
      permId: request.permId,
      sessionId: request.sessionId,
      eyebrow: UICopy.permissionEyebrow(toolName: request.toolName, risky: risky, plan: plan),
      toolName: request.toolName,
      risky: risky,
      plan: plan,
      cwd: PathText.shortPath(request.cwd),
      command: command,
      commandSyntax: commandSyntax,
      createdAt: ServerTime.parse(request.createdAt),
      canAllow: canAllow,
      screen: canAllow || request.isHookChannel ? nil : session?.herdrDialogScreen,
      cliDialog: canAllow || request.isHookChannel ? nil : session?.cliDialog,
      phase: phase,
      error: ui.errors[request.permId],
      lockedReason: locked,
      alwaysLabel: always,
      note: ui.notes[request.permId]
    )
    model.fullInput = shown.full
    // The window with the whole input appeared on this screen: the consent of a long request unlocks.
    model.fullInputRead = ui.fullInputRead.contains(request.permId)
    if request.isHookChannel {
      model.hookChannel = true
      model.consentFields = shown.fields
      model.sandboxWarning = (request.notes ?? []).contains(.sandboxDisabled) ? UICopy.consentSandboxDisabled : nil
      model.consentStatus = UICopy.consentState(request.isUnsupportedHookCard ? .unsupported : request.state)
      model.awaitingDecision = request.isHookAwaitingDecision
      model.consentUnavailable = request.unavailable
    } else if !canAllow {
      // A screen card without the approve button: the server's reason, when it sent one (absent = "deny only").
      model.consentUnavailable = request.unavailable
    }
    return model
  }

  /// Karta bez decyzji, bo serwer i tak by odmówił: sesja nieobsługiwana, herdr
  /// niedostępny albo „widzę, nie ruszam", apka niezgodna z serwerem.
  static func lockedReason(state: AppState, session: SessionSummary?) -> String? {
    switch state.compat {
    case .tooOld, .protocolMismatch: return UICopy.banner(.incompatible(state.compat))
    case .unknown, .ok: break
    }
    if session?.isUnsupported == true { return UICopy.unsupportedSession }
    if let herdr = state.herdr {
      if !herdr.available { return UICopy.sendBlock(.herdrUnavailable, session: session) }
      if herdr.readOnly { return UICopy.sendBlock(.herdrReadOnly, session: session) }
    }
    return nil
  }
}
