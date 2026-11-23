import Foundation
import RarogContract

// Selektory kart decyzji i karty stanu: fakty i rozstrzygnięcia dla widoku, zdania składa RarogUI.
// Właściciel: karty.
extension AppState {
  /// Karta „dialog w terminalu": sesja czeka (zgoda albo pytanie), a żadnej
  /// karty decyzji nie ma — Rarog wie, że coś blokuje agenta, i nie wie co. Gdy karta z treścią
  /// stoi, ta nie staje obok: dwie karty o jednym dialogu, z których jedna twierdzi, że nie wie.
  /// Przed pełnym stanem transkryptu kart nie znamy, więc karty fallbacku też nie ma (bez mignięcia).
  /// W okresie łaski (``decisionLoading(for:now:)``) karty też nie ma: stoi zastępnik bez przycisków.
  public func herdrDialogShown(for sessionId: String, now: Date = Date()) -> Bool {
    guard let session = sessions[sessionId], session.isWaitingForDecision, !sessionStale(sessionId) else { return false }
    guard let view = transcripts[sessionId], view.snapshots > 0 else { return false }
    guard view.pendingPermissions.isEmpty && view.pendingQuestions.isEmpty else { return false }
    return decisionGraceEnds(for: sessionId, now: now) == nil
  }

  /// Okres łaski przed kartą „dialog w terminalu” (``DecisionGraceTiming``): sesja czeka na decyzję, kart z treścią
  /// jeszcze nie ma, driver jeszcze nie ocenił ekranu (żadnego z pól `herdrDialog`, `herdrDialogReason`,
  /// `herdrDialogScreen`, `cliDialog`), a od wejścia w czekanie minęło mniej niż `window`. Wtedy zamiast karty
  /// zapasowej z „Odrzuć dialog” stoi zastępnik bez przycisków — karta docelowa przychodzi zwykle w ok. 0,6–1,3 s.
  /// Niepewny czas wejścia (``DecisionWaitStart/at`` `nil`, cofnięty zegar) = bez okresu łaski.
  public func decisionLoading(for sessionId: String, now: Date = Date()) -> Bool {
    guard let session = sessions[sessionId], session.isWaitingForDecision, !sessionStale(sessionId) else { return false }
    let view = transcripts[sessionId]
    guard view?.pendingPermissions.isEmpty ?? true, view?.pendingQuestions.isEmpty ?? true else { return false }
    let evaluated = session.herdrDialog != nil || session.herdrDialogReason != nil || session.cliDialog != nil
      || !(session.herdrDialogScreen ?? "").isEmpty
    guard !evaluated, let wait = cards.decisionWaits[sessionId], wait.stateSince == session.stateSince,
      let at = wait.at
    else { return false }
    let since = now.timeIntervalSince(at)
    return since >= 0 && since < DecisionGraceTiming.window
  }

  /// Koniec okresu łaski tej sesji, gdy jeszcze trwa (`nil` = okresu nie ma): wtedy ekran trzeba przeliczyć na
  /// termin, bo karta zapasowa nie ma innej ramki, która by ją postawiła.
  public func decisionGraceEnds(for sessionId: String, now: Date = Date()) -> Date? {
    guard decisionLoading(for: sessionId, now: now), let at = cards.decisionWaits[sessionId]?.at else { return nil }
    return at.addingTimeInterval(DecisionGraceTiming.window)
  }

  /// Podpis dialogu, który pokazuje karta „dialog w terminalu" tej sesji; `nil` = karty nie ma.
  public func herdrDialogSignature(for sessionId: String, now: Date = Date()) -> HerdrDialogSignature? {
    guard herdrDialogShown(for: sessionId, now: now), let session = sessions[sessionId] else { return nil }
    return HerdrDialogSignature(session)
  }

  /// Rozpoznany dialog, który wolno TERAZ zatwierdzić: karta stoi, serwer podał
  /// identyfikator z zamkniętej listy sygnatur i kanał do panelu żyje. `nil` = karta bez
  /// „Zatwierdź". Cyfry nie ma tu ani w jednym miejscu — składa ją serwer z etykiety opcji.
  public func dialogAllowId(for sessionId: String, now: Date = Date()) -> KnownDialogID? {
    guard herdrDialogShown(for: sessionId, now: now), let id = sessions[sessionId]?.herdrDialog else { return nil }
    // Stojąca decyzja jest tu NORMALNYM stanem (to właśnie ten dialog); każda inna przeszkoda nie.
    switch sendBlock(for: sessionId) {
    case nil, .decisionPending?: return id
    default: return nil
    }
  }

  /// Kanał do panelu martwy (herdr niedostępny, tylko do odczytu, karta nieświeża): „Odrzuć dialog"
  /// gaśnie, bo obiecywałoby klawisz, który nie dojdzie.
  public func herdrChannelDead(for sessionId: String) -> Bool {
    if sessions[sessionId]?.stale == true { return true }
    guard let herdr else { return false }
    return !herdr.available || herdr.readOnly
  }

  /// Ostrzeżenie o zaufaniu katalogu w transkrypcie tej sesji.
  public func showsTrustPrompt(_ sessionId: String) -> Bool {
    cards.trustPromptSessionId == sessionId
  }

  /// „Wznów" należy się WYŁĄCZNIE sesji bez panelu (`resumable`): każda inna ma po drugiej stronie
  /// żywy panel, a serwer i tak odpowiedziałby odmową.
  public func canResume(_ sessionId: String) -> Bool {
    guard let session = sessions[sessionId], !sessionStale(sessionId) else { return false }
    return session.state == .resumable && !session.isUnsupported
  }
}
