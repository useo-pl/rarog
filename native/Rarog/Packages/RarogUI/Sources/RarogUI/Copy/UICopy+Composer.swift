import Foundation
import RarogContract
import RarogCore

// Pole wiadomości i wynik wysyłki. Właściciel: wysyłka; sekcja dyktowania: dyktowanie.
extension UICopy {
  // MARK: Pole wiadomości

  public static var composerPlaceholder: String { L("composer.placeholder") }
  public static var send: String { L("composer.send") }
  /// Shift+Return w polu: tytuł skrótu w podglądzie skrótów klawiatury iPada (⌘ przytrzymane).
  public static var newLineCommand: String { L("composer.newLineCommand") }
  public static var sendFailed: String { L("composer.sendFailed") }
  public static var notPersisted: String { L("composer.notPersisted") }
  public static var unconfirmed: String { L("composer.unconfirmed") }
  public static var unconfirmedSpoken: String { L("composer.unconfirmedSpoken") }
  public static var retry: String { L("composer.retry") }
  public static var discard: String { L("composer.discard") }
  public static var refusedFallback: String { L("composer.refusedFallback") }

  /// Zdanie pod polem przy stojącej decyzji, gdy jej karta STOI w transkrypcie — odsyła do karty.
  /// Karta stoi NAD polem (na dnie transkryptu), więc „wyżej". Bez karty zostaje zdanie o terminalu.
  static var decisionOnCard: String { L("composer.decisionOnCard") }
  static var questionOnCard: String { L("composer.questionOnCard") }

  /// Powód wygaszenia pola — jedno zdanie pod polem. `cardShown` = karta tej decyzji
  /// stoi w transkrypcie (wtedy zdanie nie każe szukać dialogu w terminalu).
  public static func sendBlock(_ block: SendBlock, session: SessionSummary?, cardShown: Bool = false) -> String {
    switch block {
    case .codex: L("composer.sendBlock.codex")
    case .unsupported: unsupportedSession
    case .outOfScope: L("composer.sendBlock.outOfScope")
    case .herdrUnavailable: L("composer.sendBlock.herdrUnavailable")
    case .herdrReadOnly: L("composer.sendBlock.herdrReadOnly")
    case .decisionPending:
      switch (session?.state == .waitingQuestion, cardShown) {
      case (true, true): questionOnCard
      case (true, false): L("composer.sendBlock.questionNoCard")
      case (false, true): decisionOnCard
      case (false, false): L("composer.sendBlock.decisionNoCard")
      }
    case .starting: L("composer.startingReason")
    case let .stateCard(state): stateCardLine(state, detail: session?.stateDetail, ref: session?.stateDetailRef)
    }
  }

  /// Stan, w którym serwer wiadomości nie przyjmie (zdanie zamiast karty stanu z akcjami).
  static func stateCardLine(_ state: SessionState, detail: String?, ref: SentenceRef? = nil) -> String {
    switch state {
    case .limitReached: limitLine(detail, ref: ref)
    case .done: L("composer.stateCardLine.done")
    case .resumable: L("composer.stateCardLine.resumable")
    case .interrupted: L("composer.stateCardLine.interrupted")
    case .error: detail.map { L("composer.stateCardLine.errorDetail", $0) } ?? L("composer.stateCardLine.error")
    default: L("composer.stateCardLine.default")
    }
  }

  /// „Limit planu — spróbuj po 14:00." Godzina z chwili `args[0]` przy `stateDetailRef` kodu `state.limit-reached`
  /// (`stateDetail` bywa już przetłumaczonym zdaniem, więc tekstu się nie parsuje); zapas dla serwera bez
  /// `stateDetailRef`: token `resetAt=<ISO>` w `stateDetail`. Brak obu albo chwila nieczytelna → „spróbuj później".
  static func limitLine(_ detail: String?, ref: SentenceRef? = nil, timeZone: TimeZone = .current) -> String {
    let fromRef = ref.flatMap { $0.code == "state.limit-reached" ? $0.args.first : nil }
      .flatMap { ServerTime.clock($0, timeZone: timeZone) }
    let fromToken = detail.flatMap { $0.firstMatch(of: /resetAt=([^\s;,]+)/).map { String($0.output.1) } }
      .flatMap { ServerTime.clock($0, timeZone: timeZone) }
    guard let clock = fromRef ?? fromToken else { return L("composer.limitLine.later") }
    return L("composer.limitLine.at", clock)
  }

  /// The sentence after the result of "Send"; `restore` = the text goes back to the field.
  public static func sendResult(_ outcome: SendOutcome, session: SessionSummary?) -> (text: String?, isError: Bool, restore: Bool) {
    switch outcome {
    // An empty send stays silent: a sentence under the field on Return in an empty field only got in the
    // way. A stop in the progress ring says it in the transcript ("Sending stopped." with Retry), not under the field.
    case .accepted, .unconfirmed, .ignored, .empty, .refused(_, OutboxEntry.RefusalCode.cancelled?, _):
      (nil, false, false)
    case let .blocked(block): (sendBlock(block, session: session), false, true)
    case .notPersisted: (notPersisted, true, true)
    case let .refused(_, code, message):
      (refusal(code: code, message: message).map { L("composer.sendResult", $0) } ?? sendFailed, true, true)
    }
  }

  /// The sentence under the field after a queue take-back, or `nil` for silence (texts in the field, a gesture that
  /// sent nothing). A take-back without an answer says there is no connection, and a draft the disk refused says so:
  /// the next gesture asks again with the same id.
  static func queueTakeBackResult(_ outcome: QueueTakeBackOutcome) -> (text: String, isError: Bool)? {
    switch outcome {
    case let .taken(response): response.incomplete ? (L("composer.takeBackIncomplete"), false) : nil
    case let .refused(message): (message ?? L("composer.takeBackFailed"), true)
    case .serverTooOld: (CoreCopy.updateServer, true)
    case .unsure: (CoreCopy.noConnection, true)
    case .notSaved: (L("composer.takeBackNotSaved"), true)
    case .inFlight, .loggedOut: nil
    }
  }

  // MARK: Podpowiedzi slash-komend nad polem

  /// Nazwa listy dla czytnika.
  static var commandSuggestionsLabel: String { L("composer.commandSuggestionsLabel") }
  static var commandSuggestionHint: String { L("composer.commandSuggestionHint") }

  /// Wiersz dla czytnika: „/compact”, potem podpowiedź argumentu i opis, jeśli są.
  static func commandSuggestionLabel(_ choice: CommandChoice) -> String {
    list(["/\(choice.name)"] + [choice.argumentHint, choice.description].compactMap { $0 }, .comma)
  }

  // MARK: Komendy apki

  /// Dopisek komendy apki w wierszu podpowiedzi (w miejscu opisu): apka obsługuje ją sama, do panelu nic nie idzie.
  static func appCommandNote(_ action: AppCommand.Action) -> String {
    switch action {
    case .modelSheet: L("composer.appCommandNote.modelSheet", modelSheetTitle)
    case .usageSheet: L("composer.appCommandNote.usageSheet", usageSheetTitle)
    }
  }

  // MARK: Odmowy wpisu kolejki

  static var attachmentMissing: String { L("composer.attachmentMissing") }
  static var encodingFailed: String { L("composer.encodingFailed") }
  static var clientIdConflict: String { L("composer.clientIdConflict") }
  /// The stop in the progress ring before the request: the status line of the entry.
  static var sendStopped: String { L("composer.sendStopped") }

  /// The sentence of a refusal: the client codes and a stopped send have sentences of their own, the rest is the server's.
  static func refusal(code: String?, message: String?) -> String? {
    switch code {
    case OutboxEntry.RefusalCode.attachmentMissing?: attachmentMissing
    case OutboxEntry.RefusalCode.encodingFailed?: encodingFailed
    case OutboxEntry.RefusalCode.clientIdConflict?: clientIdConflict
    case OutboxEntry.RefusalCode.cancelled?: sendStopped
    default: message
    }
  }

  // MARK: Postęp

  /// The VoiceOver action on a thumbnail of an entry in flight: the stop in the center of the progress ring.
  static var cancelSend: String { L("composer.cancelSend") }

  /// The state of a thumbnail of an outbox entry for VoiceOver (the value next to the name "Photo 1"); `nil` = no
  /// state. An entry without text after 202 (`awaitingEcho`) is still "sending": the only trace that the echo has not
  /// come yet. A stopped entry is "not sent", as a refused one: nothing went out.
  static func pendingTile(_ indicator: PendingIndicator, awaitingEcho: Bool = false) -> String? {
    switch indicator {
    case .indeterminate: L("composer.pendingTile.indeterminate")
    case let .progress(fraction): L("composer.pendingTile.progress", Int((fraction * 100).rounded(.down)))
    case .awaitingResponse: L("composer.pendingTile.awaitingResponse")
    case .unconfirmed: L("composer.pendingTile.unconfirmed")
    case .refused, .stopped: L("composer.pendingTile.refused")
    case .none: awaitingEcho ? L("composer.pendingTile.none") : nil
    }
  }

  // MARK: Załączniki

  public static var attach: String { L("composer.attach") }
  static var hideKeyboard: String { L("composer.hideKeyboard") }
  public static var attachPhotos: String { L("composer.attachPhotos") }
  public static var attachFiles: String { L("composer.attachFiles") }
  static var attachmentsStrip: String { L("composer.attachmentsStrip") }
  static var attachmentsBusy: String { L("composer.attachmentsBusy") }
  static var attachmentsStillLoading: String { L("composer.attachmentsStillLoading") }
  static var attachmentsNotAccepted: String { L("composer.attachmentsNotAccepted") }
  static var attachmentsOverLimit: String { L("composer.attachmentsOverLimit", AttachmentLimits.maxImages, AttachmentLimits.maxFiles) }

  static func photos(_ n: Int) -> String { L("composer.photos", n) }
  static func files(_ n: Int) -> String { L("composer.files", n) }

  /// Ogłoszenie dla czytnika po dodaniu; `nil` = nic nie doszło.
  static func attachmentsAdded(images: Int, files: Int) -> String? {
    switch (images, files) {
    case (0, 0): nil
    case (_, 0): L("composer.attachmentsAdded.photos", photos(images))
    case (0, _): L("composer.attachmentsAdded.files", self.files(files))
    default: L("composer.attachmentsAdded.both", photos(images), self.files(files))
    }
  }

  static func attachmentRemoved(_ kind: ComposerAttachment.Kind, remaining: [ComposerAttachment]) -> String {
    switch kind {
    case .image: L("composer.attachmentRemoved.image", photos(AttachmentCounts.images(remaining)))
    case .file: L("composer.attachmentRemoved.file", files(AttachmentCounts.files(remaining)))
    }
  }

  /// Opis kafelka dla czytnika: „Zdjęcie 2, 840 kB" / „raport.pdf, 1,2 MB".
  static func attachmentLabel(_ attachment: ComposerAttachment, imageIndex: Int) -> String {
    switch attachment.kind {
    case .image: L("composer.attachmentLabel", imageIndex, bytes(attachment.bytes))
    case .file: list([attachment.name, bytes(attachment.bytes)], .comma)
    }
  }

  static func removeAttachment(_ attachment: ComposerAttachment, imageIndex: Int) -> String {
    switch attachment.kind {
    case .image: L("composer.removeAttachment.image", imageIndex)
    case .file: L("composer.removeAttachment.file", attachment.name)
    }
  }

  /// Zdania odrzuceń — jedno na powód, nie jedno na element; zdjęcia przed plikami (`rejectionCopy`).
  static func attachmentRejections(_ rejections: [AttachmentRejection]) -> [String] {
    var lines: [String] = []
    for kind in [ComposerAttachment.Kind.image, .file] {
      let mine = rejections.filter { $0.kind == kind }
      let tooMany = mine.filter { $0.reason == .tooMany }
      let tooLarge = mine.filter { if case .tooLarge = $0.reason { true } else { false } }
      let unreadable = mine.filter { $0.reason == .unreadable }
      let image = kind == .image
      if !tooMany.isEmpty {
        lines.append(image
          ? L("composer.attachmentRejections.tooManyPhotos", photos(AttachmentLimits.maxImages), photos(tooMany.count))
          : L("composer.attachmentRejections.tooManyFiles", files(AttachmentLimits.maxFiles), files(tooMany.count)))
      }
      let limit = bytes(image ? AttachmentLimits.maxImageDataURL : AttachmentLimits.maxFileBytes)
      if tooLarge.count == 1, let only = tooLarge.first, case let .tooLarge(weight) = only.reason {
        let subject = quoted(only.name, image: image)
        let line: String =
          switch (image, weight) {
          case let (true, weight?): L("composer.attachmentRejections.photoWeighs", subject, bytes(weight), limit)
          case (true, nil): L("composer.attachmentRejections.photoTooLarge", subject, limit)
          case let (false, weight?): L("composer.attachmentRejections.fileWeighs", subject, bytes(weight), limit)
          case (false, nil): L("composer.attachmentRejections.fileTooLarge", subject, limit)
          }
        lines.append(line)
      } else if tooLarge.count > 1 {
        lines.append(image
          ? L("composer.attachmentRejections.photosTooLarge", photos(tooLarge.count), limit)
          : L("composer.attachmentRejections.filesTooLarge", files(tooLarge.count), limit))
      }
      if unreadable.count == 1, let only = unreadable.first {
        lines.append(L("composer.attachmentRejections.oneUnreadable", quoted(only.name, image: image)))
      } else if unreadable.count > 1 {
        lines.append(L("composer.attachmentRejections.manyUnreadable", image ? photos(unreadable.count) : files(unreadable.count)))
      }
    }
    return lines
  }

  /// Nazwa w cudzysłowie, skrócona do 32 znaków; zdjęcie bez nazwy to „Zdjęcie".
  private static func quoted(_ name: String, image: Bool) -> String {
    if name.isEmpty { return image ? L("composer.quoted.photo") : L("composer.quoted.file") }
    let short = name.count <= 32 ? name : "\(name.prefix(31))…"
    return L("composer.quoted.name", short)
  }

  // MARK: Przerwanie tury (właściciel: sterowanie sesją)

  public static var stop: String { L("composer.stop") }
  /// Podpowiedź czytnika przy przycisku pola w trybie Stopu.
  static var stopHint: String { L("composer.stopHint") }
  /// Esc in the iPadOS menu bar and in the shortcut sheet under a held Cmd.
  static var shortcutInterrupt: String { L("composer.shortcutInterrupt") }
  /// Zdanie dla czytnika w chwili gestu — na ekranie status niesie wiersz aktywności („przerywa").
  static var interruptSent: String { L("composer.interruptSent") }
  /// Wiersz aktywności w trakcie przerywania.
  static var activityInterrupting: String { L("composer.activityInterrupting") }
  /// Panel NIE przyjął Esc: droga wyjścia jest na maszynie serwera („Mac” albo „VPS”, ``ServerMachine``).
  static func interruptFailed(_ machine: ServerMachine) -> String {
    machine == .mac ? L("composer.interruptFailed") : L("composer.interruptFailed.vps")
  }
  /// Odmowa Raroga (bramka, zanim cokolwiek ruszyło do panelu) — NIE odsyła do Maca: panel działa.
  static var interruptGate: String { L("composer.interruptGate") }
  /// Apka odpuściła czekanie albo sieć padła — ton neutralny, ponowienie to ten sam gest.
  static var interruptUnsure: String { L("composer.interruptUnsure") }
  static var interrupted: String { L("composer.interrupted") }
  static var interruptedRestored: String { L("composer.interruptedRestored") }
  static var interruptedTyping: String { L("composer.interruptedTyping") }

  /// „2,1 MB" / „840 kB" — twarda spacja, przecinek dziesiętny.
  static func bytes(_ count: Int) -> String {
    let megabyte = 1024 * 1024
    if count >= megabyte {
      let tenths = Int((Double(count) / Double(megabyte) * 10).rounded())
      return tenths % 10 == 0
        ? L("composer.bytes.megabytes", tenths / 10) : L("composer.bytes.megabytesTenths", tenths / 10, tenths % 10)
    }
    return L("composer.bytes.kilobytes", Int((Double(count) / 1024).rounded()))
  }

  // MARK: Dyktowanie (właściciel: dyktowanie)

  /// Nazwa mikrofonu jest STAŁA, stan niesie cecha „zaznaczony".
  public static var voiceMic: String { L("composer.voiceMic") }
  static var voiceMicHint: String { L("composer.voiceMicHint") }
  static var voiceMicStopHint: String { L("composer.voiceMicStopHint") }
  static var voiceSettings: String { L("composer.voiceSettings") }
  static var voiceSettingsHint: String { L("composer.voiceSettingsHint") }
  /// Opis skrótu ⌥⌘M w nakładce skrótów (klawisze dokłada system): zaczyna i kończy z zatwierdzeniem.
  public static var shortcutDictation: String { L("composer.shortcutDictation") }

  static var voiceDisabled: String { L("composer.voiceDisabled") }
  static var voiceRateLimited: String { L("composer.voiceRateLimited") }
  static var voiceMintFailed: String { L("composer.voiceMintFailed") }

  /// Jedno zdanie w wierszu dyktowania; komunikat wygrywa ze stanem. Puste = nic do powiedzenia.
  public static func voiceStatus(_ view: VoiceView) -> String {
    if let notice = view.notice { return voiceNotice(notice) }
    switch view.phase {
    case .idle: return ""
    case .starting: return L("composer.voiceStatus.starting")
    case .recording:
      return view.secondsLeft.map { L("composer.voiceStatus.recordingLeft", voiceClock($0)) } ?? L("composer.voiceStatus.recording")
    case .reconnecting: return L("composer.voiceStatus.reconnecting")
    case .finalizing: return L("composer.voiceStatus.finalizing")
    }
  }

  public static func voiceNotice(_ notice: VoiceNotice) -> String {
    switch notice {
    case .silence: L("composer.voiceNotice.silence")
    case .sessionLimit: L("composer.voiceNotice.sessionLimit")
    case .interrupted: L("composer.voiceNotice.interrupted")
    case .streamFailed: L("composer.voiceNotice.streamFailed")
    case let .microphone(error): microphoneError(error)
    case let .dictation(failure): dictationFailure(failure)
    case let .message(text): text
    }
  }

  static func microphoneError(_ error: VoiceMicError) -> String {
    switch error {
    case .denied: L("composer.microphoneError.denied")
    case .unavailable: L("composer.microphoneError.unavailable")
    case .busy: L("composer.microphoneError.busy")
    case .failed: L("composer.microphoneError.failed")
    }
  }

  /// Ostrzeżenie o limicie dla czytnika — raz, bez odliczania sekund na głos.
  static func voiceLimitSpoken(seconds: Int) -> String {
    let minutes = max(1, Int((Double(seconds) / 60).rounded(.up)))
    return L("composer.voiceLimitSpoken", minutes)
  }

  /// `m:ss` — licznik jest głosem maszyny, więc bez „minut" i „sekund".
  static func voiceClock(_ seconds: Int) -> String {
    let safe = max(0, seconds)
    return L("composer.voiceClock", safe / 60, safe % 60)
  }
}
