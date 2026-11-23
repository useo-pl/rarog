import Foundation
import RarogContract
import RarogCore

// Transkrypt. Właściciel: transkrypt.
extension UICopy {
  // MARK: Transkrypt

  public static func roleLabel(_ role: MessageRole) -> String {
    switch role {
    case .user: L("transcript.roleLabel.user")
    case .assistant: L("transcript.roleLabel.assistant")
    case .system: L("transcript.roleLabel.system")
    }
  }

  /// Rola dla czytnika przed treścią wiadomości: „Ty", „Agent", „System" — ZAWSZE, choć na ekranie etykiet ról
  /// nie ma. Wpis w locie: „Ty, w drodze". Osobne klucze od ``roleLabel(_:)``:
  /// słowo na początku zdania czytnika (wielka litera to rzecz języka, nie `.capitalized` na gotowym tekście).
  public static func rolePrefix(_ role: MessageRole) -> String {
    switch role {
    case .user: L("transcript.rolePrefix.user")
    case .assistant: L("transcript.rolePrefix.assistant")
    case .system: L("transcript.rolePrefix.system")
    }
  }

  public static var pendingRolePrefix: String { L("transcript.pendingRolePrefix") }
  /// Wpis przyjęty przez serwer, czeka w kolejce Claude Code.
  public static var queuedRolePrefix: String { L("transcript.queuedRolePrefix") }
  /// VoiceOver action on a queued message: the queue back into the message field.
  static var queuedTakeBackAction: String { L("transcript.queuedTakeBackAction") }
  /// The status under a queued message while its queue is being taken back into the field.
  static var queuedTakingBack: String { L("transcript.queuedTakingBack") }
  /// The VoiceOver role before a queued message while its queue is being taken back.
  static var takingBackRolePrefix: String { L("transcript.takingBackRolePrefix") }

  /// Godzina przy dymku promptu dla czytnika.
  public static func promptClockSpoken(_ clock: String) -> String { L("transcript.promptClockSpoken", clock) }
  /// The time under a closed agent reply, for VoiceOver.
  public static func replyClockSpoken(_ clock: String) -> String { L("transcript.replyClockSpoken", clock) }

  /// Przycisk pod zwiniętym długim promptem: „Pokaż całość · 214 linii”.
  public static func promptFoldShow(lines: Int) -> String {
    L("transcript.promptFoldShow", lines)
  }

  /// Przycisk pod rozwiniętym długim promptem.
  public static var promptFoldHide: String { L("transcript.promptFoldHide") }

  // MARK: Prompt zablokowany przez hook

  /// Tytuł notki — stały, bo treść komunikatu zależy od hooka (powód stoi pod tytułem).
  public static var promptBlockedTitle: String { L("transcript.promptBlockedTitle") }
  /// Cytat promptu pod powodem — tylko w notce bez dymka promptu (prompt spoza Raroga).
  public static func promptBlockedQuote(_ prompt: String) -> String { L("transcript.promptBlockedQuote", prompt) }
  public static var promptBlockedResend: String { L("transcript.promptBlockedResend") }
  public static var promptBlockedRestarting: String { L("transcript.promptBlockedRestarting") }
  /// Podpowiedź czytnika przy przycisku: co się stanie, zanim człowiek tapnie.
  public static var promptBlockedResendHint: String { L("transcript.promptBlockedResendHint") }
  /// Porażka bez zdania serwera (odpowiedź spoza kontraktu, przerwane żądanie).
  public static var promptBlockedResendFailed: String { L("transcript.promptBlockedResendFailed") }

  /// Notka dla czytnika: trójkąt jest ukryty, więc ostrzeżenie mówi słowem, jak przy notce harnessu.
  public static func promptBlockedSpoken(_ detail: String) -> String {
    detail.isEmpty ? L("transcript.promptBlockedSpoken", promptBlockedTitle) : L("transcript.promptBlockedSpoken.detail", promptBlockedTitle, detail)
  }

  // MARK: Okno zaznaczania transkryptu

  /// Pozycja menu edycji tekstu wiadomości: okno z tekstem całego załadowanego transkryptu.
  public static var transcriptSelectMore: String { L("transcript.selectMore") }
  /// Rodzaj okna w pasku tytułu i tytuł dla czytnika.
  public static var transcriptSelectionTitle: String { L("transcript.selectionSheet.title") }

  public static var unsupportedBlock: String { L("transcript.unsupportedBlock") }
  public static var imagePlaceholder: String { L("transcript.imagePlaceholder") }
  public static var unsupportedSession: String { L("transcript.unsupportedSession") }

  // MARK: Markdown i kopiowanie (właściciel: transkrypt)

  /// Nazwa przycisku kopiowania bloku kodu (sama ikona, więc to jedyna nazwa).
  public static var codeCopyHint: String { L("transcript.codeCopyHint") }
  /// Nazwa po skopiowaniu — widocznie zmienia się ikona (ptaszek), nie napis.
  public static var codeCopyDone: String { L("transcript.codeCopyDone") }
  /// Porażka kopiowania nie udaje sukcesu.
  public static var copyFailed: String { L("transcript.copyFailed") }

  /// Początek tabeli czytanej przez VoiceOver: „Tabela, 3 wiersze".
  public static func tableSpoken(rows: Int) -> String {
    L("transcript.tableSpoken", rows)
  }

  /// Początek tabeli z nagłówkiem dla czytnika: „Tabela, 3 wiersze: Nazwa, Wartość”.
  public static func tableSpokenHeader(rows: Int, header: String) -> String {
    L("transcript.tableSpokenHeader", tableSpoken(rows: rows), header)
  }

  /// Pusty transkrypt — zdanie zależne od stanu (`emptyCopy`).
  public static func emptyTranscript(_ state: SessionState) -> (text: String, sub: String?) {
    switch state {
    case .running: (L("transcript.emptyTranscript.running.text"), L("transcript.emptyTranscript.running.sub"))
    case .starting: (L("transcript.emptyTranscript.starting.text"), nil)
    // Zdanie pustego transkryptu stoi NAD kartą (karta to następny wiersz), więc tu zostaje „niżej";
    // „wyżej" mówi zdanie pod polem wiadomości (`decisionOnCard`).
    case .waitingPermission: (L("transcript.emptyTranscript.waitingPermission.text"), nil)
    case .waitingQuestion: (L("transcript.emptyTranscript.waitingQuestion.text"), nil)
    case .unsupported: (unsupportedSession, nil)
    default: (L("transcript.emptyTranscript.default.text"), nil)
    }
  }

  // MARK: Karty narzędzi, serie, znaczniki, pasek „na dół"

  /// Rozwijak serii. Liczba w nawiasie omija odmianę — schowanych jest zawsze 2+.
  public static func toolRunLabel(hidden: Int, expanded: Bool) -> String {
    expanded ? L("transcript.toolRunLabel.expanded") : L("transcript.toolRunLabel.collapsed", hidden)
  }

  /// Ogon długiego mini-diffu: „… jeszcze 7 linii".
  public static func diffMore(_ lines: Int) -> String {
    L("transcript.diffMore", lines)
  }

  /// Karta narzędzia dla czytnika: linia i bilans słowami („2 dodane linie, 1 usunięta linia").
  public static func toolSpoken(line: String, added: Int, deleted: Int) -> String {
    var parts = [line]
    if added > 0 { parts.append(L("transcript.toolSpoken.added", added)) }
    if deleted > 0 { parts.append(L("transcript.toolSpoken.deleted", deleted)) }
    return list(parts, .comma)
  }

  public static var disclosureExpanded: String { L("transcript.disclosureExpanded") }
  public static var disclosureCollapsed: String { L("transcript.disclosureCollapsed") }

  /// Linia „NOWE" — jedno słowo; wielkie litery robi widok, czytnik czyta słowo.
  public static var newMarker: String { L("transcript.newMarker") }

  /// Pigułka nad transkryptem: ile bloków tekstu agenta przyszło od linii „NOWE".
  public static func newPill(_ count: Int) -> String { L("transcript.newPill", count) }

  /// Pigułka dla czytnika: liczba i to, co zrobi tap.
  public static func newPillSpoken(_ count: Int) -> String { L("transcript.newPillSpoken", newPill(count)) }

  /// „×” pigułki i ta sama akcja czytnika: zamyka pigułkę, zdejmuje linię „NOWE”.
  public static var newPillDismiss: String { L("transcript.newPillDismiss") }

  /// Znacznik przerwy nad wiadomością.
  public static func timeGap(_ clock: String) -> String { L("transcript.timeGap", clock) }
  public static func timeGapSpoken(_ clock: String) -> String { L("transcript.timeGapSpoken.clock", clock) }

  /// Wzorce dat separatora (wzorzec Unicode w katalogu, nazwy dni i miesięcy z locale apki): „pt. 9 paź” na ekranie,
  /// „piątek, 9 października” dla czytnika (`TimeGap.day`, `TimeGap.spokenDay`).
  static var timeGapDayPattern: String { L("transcript.timeGapDayPattern") }
  static var timeGapSpokenDayPattern: String { L("transcript.timeGapSpokenDayPattern") }

  /// Separator czasu: „— 14:05 —", „— pt. 9 paź —" albo „— pt. 9 paź · 08:15 —".
  public static func timeGap(_ mark: TimeMark) -> String {
    L("transcript.timeGap", list([mark.day, mark.clock].compactMap { $0 }, .dot))
  }

  /// Separator dla czytnika: zmiana dnia mówi datą („Piątek, 9 października, od 08:15"), przerwa — godziną. Data
  /// przychodzi już w formie na początek zdania (`TimeMark.spokenDay`).
  public static func timeGapSpoken(_ mark: TimeMark) -> String {
    guard let day = mark.spokenDay else { return timeGapSpoken(mark.clock ?? "") }
    return mark.clock.map { L("transcript.timeGapSpoken.mark", day, $0) } ?? day
  }

  /// Pasek po odjechaniu od dna; przy stojącej decyzji skok na dół jest skokiem do niej.
  public static func jumpLabel(decision: Bool) -> String {
    decision ? L("transcript.jumpLabel.decision") : L("transcript.jumpLabel.bottom")
  }

  // MARK: Notki harnessu (właściciel: notki i miniatury)

  /// Zdanie notki harnessu z faktów policzonych przez
  /// serwer, nie z tekstu wpisu. Ton: ostrzeżenie dla sieroty po restarcie CLI, niepowodzenie dla
  /// `failed`; zatrzymanie nie jest awarią. Kod wyjścia tylko z danych, brak wyniku nie znaczy sukcesu.
  /// Postój subagenta (`waiting`) to spokojne zdanie „czeka na własne zadanie w tle", nie „skończył".
  /// Koniec obserwacji artefaktu to cicha linia z tytułem; wyniku i kodu nie czyta (to nie zadanie).
  public static func harnessNotice(_ notice: TranscriptNotice) -> (text: String, tone: NoticeTone) {
    let name = notice.name.flatMap { $0.isEmpty ? nil : $0 }
    let code = notice.exitCode
    switch notice.kind {
    case .orphan:
      return (L("transcript.harnessNotice.orphan"), .warning)
    case .monitorEvent:
      return (name.map { L("transcript.harnessNotice.monitorEvent.named", $0) } ?? L("transcript.harnessNotice.monitorEvent"), .quiet)
    case .artifactWatch:
      return (name.map { L("transcript.harnessNotice.artifactWatch.named", $0) } ?? L("transcript.harnessNotice.artifactWatch"), .quiet)
    case .monitorEnd:
      return taskSentence(notice.outcome, NoticeForms(
        failed: L("transcript.harnessNotice.monitorEnd.failed"), halted: L("transcript.harnessNotice.monitorEnd.halted"),
        done: L("transcript.harnessNotice.monitorEnd.done"), unknown: L("transcript.harnessNotice.monitorEnd.unknown")),
        code: code, name: name, fullResult: false)
    case .command:
      return taskSentence(notice.outcome, NoticeForms(
        failed: L("transcript.harnessNotice.command.failed"), halted: L("transcript.harnessNotice.command.halted"),
        done: L("transcript.harnessNotice.command.done"), unknown: L("transcript.harnessNotice.command.unknown")), code: code, name: name)
    case .agent:
      return taskSentence(notice.outcome, NoticeForms(
        failed: L("transcript.harnessNotice.agent.failed"), halted: L("transcript.harnessNotice.agent.halted"),
        done: L("transcript.harnessNotice.agent.done"), unknown: L("transcript.harnessNotice.agent.unknown"),
        waiting: L("transcript.harnessNotice.agent.waiting")), code: code, name: name)
    case .workflow:
      return taskSentence(notice.outcome, NoticeForms(
        failed: L("transcript.harnessNotice.workflow.failed"), halted: L("transcript.harnessNotice.workflow.halted"),
        done: L("transcript.harnessNotice.workflow.done"), unknown: L("transcript.harnessNotice.workflow.unknown")), code: code, name: name)
    case .unknown:
      // Kształt, którego serwer nie rozpoznał: zdanie ogólne, nigdy pustka.
      return taskSentence(notice.outcome, NoticeForms(
        failed: L("transcript.harnessNotice.unknown.failed"), halted: L("transcript.harnessNotice.unknown.halted"),
        done: L("transcript.harnessNotice.unknown.done"), unknown: L("transcript.harnessNotice.unknown.unknown")), code: code, name: name)
    }
  }

  /// Notka dla czytnika: ostrzeżenie mówi słowem, bo ikona jest ukryta.
  public static func harnessNoticeSpoken(_ text: String, tone: NoticeTone) -> String {
    tone == .quiet ? text : L("transcript.harnessNoticeSpoken", text)
  }

  /// Formy zdania notki dla jednego rodzaju zadania.
  private struct NoticeForms {
    let failed: String
    let halted: String
    let done: String
    let unknown: String
    /// Postój (`waiting`): zadanie stanęło i czeka na własne zadanie w tle. Ma go tylko subagent; `nil` =
    /// rodzaj, dla którego serwer tej wartości nie nadaje.
    var waiting: String?
  }

  /// Zdanie zatrzymanego zadania nie niesie kodu wyjścia (meldunek „was stopped" go nie ma). Postój subagenta
  /// też nie: nic się nie skończyło, więc nie ma ani kodu, ani wyniku do obejrzenia w terminalu. Zdanie rośnie
  /// kluczami z parametrami, po kolei: stan zadania, kod wyjścia, nazwa zadania, kropka, zdanie o terminalu —
  /// każdy krok to cała fraza w katalogu (`transcript.harnessNotice.with*`), bez doklejania kawałków.
  private static func taskSentence(
    _ outcome: NoticeOutcome?, _ forms: NoticeForms, code: Int?, name: String?, fullResult: Bool = true
  ) -> (text: String, tone: NoticeTone) {
    func sentence(_ head: String, code: Int?, full: Bool) -> String {
      var text = code.map { L("transcript.harnessNotice.withExitCode", head, $0) } ?? head
      if let name { text = L("transcript.harnessNotice.withName", text, name) }
      text = L("transcript.harnessNotice.sentence", text)
      return full ? L("transcript.harnessNotice.withFullResult", text) : text
    }
    let unknown: (text: String, tone: NoticeTone) = (sentence(forms.unknown, code: code, full: fullResult), .quiet)
    switch outcome {
    case .failed: return (sentence(forms.failed, code: code, full: fullResult), .failure)
    case .halted: return (sentence(forms.halted, code: nil, full: fullResult), .quiet)
    case .done: return (sentence(forms.done, code: code, full: fullResult), .quiet)
    case .waiting:
      // Postój melduje wyłącznie subagent. Przy innym rodzaju zadania `waiting` nie powinno przyjść; gdyby
      // przyszło, zdanie jest takie samo jak przy braku wyniku — apka nie wymyśla postoju komendy ani workflow.
      guard let waiting = forms.waiting else { return unknown }
      return (sentence(waiting, code: nil, full: false), .quiet)
    case nil: return unknown
    }
  }

  // MARK: Zdjęcia i załączniki wiadomości (właściciel: notki i miniatury)

  /// Zdjęcie załączone do wiadomości: „Zdjęcie 2" (numer wśród zdjęć wiadomości).
  public static func photoLabel(_ index: Int) -> String { L("transcript.photoLabel", index) }
  /// Obrazek w treści bez opisu.
  public static var inlineImageLabel: String { L("transcript.inlineImageLabel") }
  /// Plik bez nazwy (nie powinien się zdarzyć — nazwa pliku przychodzi zawsze).
  public static var fileFallbackName: String { L("transcript.fileFallbackName") }
  /// Podpowiedź miniatury dla czytnika.
  public static var thumbnailHint: String { L("transcript.thumbnailHint") }
  /// Stan miniatury, która jeszcze się wczytuje.
  public static var thumbnailLoading: String { L("transcript.thumbnailLoading") }
  /// Kafel zdjęcia, którego nie da się pokazać (404 po 48 h, brak sieci): „Zdjęcie" i waga.
  public static func photoGone(bytes: Int) -> String {
    bytes > 0 ? list([imagePlaceholder, UICopy.bytes(bytes)], .comma) : imagePlaceholder
  }
  /// Chip pliku dla czytnika: „raport.pdf, 178 kB".
  public static func attachmentChipSpoken(name: String, size: String?) -> String {
    size.map { list([name, $0], .comma) } ?? name
  }
  /// Zamknięcie podglądu zdjęcia: przycisk w pasku i nazwa skrótu Esc.
  public static var previewClose: String { L("transcript.previewClose") }
}
