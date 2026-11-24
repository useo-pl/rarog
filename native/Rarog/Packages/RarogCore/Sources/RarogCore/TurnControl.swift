import Foundation
import RarogContract

// Przerwanie tury i „obejrzane" — stan,
// zdarzenia reduktora, wyniki akcji magazynu i selektory. Copy składa RarogUI.
// Właściciel: przerwanie i sterowanie sesją.

/// Stan przerwań i odbioru wyniku. Każde zalogowanie i wylogowanie zaczyna go od nowa
/// (`resetTurnControl` w `resetView`), z wyższym numerem zalogowania.
public struct TurnControlState: Sendable, Equatable {
  /// Przerwania w locie: sesja → chwila wysłania żądania (bramka gestu i „przerywa").
  /// Nowszy gest po sufitie bramki nadpisuje wpis; zdejmuje go wyłącznie rozstrzygnięcie TEJ próby.
  public internal(set) var interrupts: [String: Date] = [:]
  /// „Obejrzane" zgłoszone w tej wizycie: sesja → `stateSince` wyniku (raz na wynik).
  public internal(set) var seen: [String: String] = [:]
  /// Ręczne „nieprzeczytane” z tego urządzenia: sesje, których wyniku ekran nie odbiera sam do nowego
  /// wejścia w sesję. Blokada dotyczy WIZYTY, nie `stateSince` — serwer przestawia go przy adopcji panelu po swoim
  /// restarcie i przy imporcie historii, bez nowej tury. Zwalnia ją wejście w sesję, ręczne „Przeczytane”,
  /// start tury i zniknięcie sesji z listy (`noteListMemory`).
  public internal(set) var manualUnread: Set<String> = []
  /// Sessions of ``manualUnread`` whose card has since carried the server's `markedUnseen`. From then on the
  /// server field alone says whether the result was marked by hand, so a result of a turn this device did not see
  /// (the app was in the background) pulses even though the hold until the next visit still stands.
  public internal(set) var manualUnreadConfirmed: Set<String> = []
  /// Numer zalogowania. Wynik akcji sprzed wylogowania (albo ponownego logowania) idzie do kosza.
  public internal(set) var login = 0

  public init() {}
}

/// Zdarzenie przerwań i odbioru wyniku — jedna pozycja `CoreEvent.turnControl`, gałęzie
/// w `Reducer+SessionControl`.
public enum TurnControlEvent: Sendable, Equatable {
  case interruptStarted(sessionId: String, at: Date)
  /// Rozstrzygnięcie próby z chwilą `startedAt` — nowszej próby nie dotyka.
  case interruptSettled(sessionId: String, startedAt: Date)
  /// Świeża karta sesji z odpowiedzi 202: stan od razu, aktywność gaśnie.
  case interruptReplied(SessionSummary)
  case seenNoted(sessionId: String, stateSince: String)
  /// Wyjście z wyniku (zmiana ekranu albo stanu): następne wejście zgłasza od nowa.
  case seenForgotten(sessionId: String)
  /// Ręczne „nieprzeczytane”: ekran nie odbierze tego wyniku sam do nowego wejścia w sesję.
  case unreadMarked(sessionId: String)
  /// Koniec blokady ręcznego „nieprzeczytane”: nowe wejście w sesję albo ręczne „Przeczytane”.
  case unreadReleased(sessionId: String)
}

/// Stałe czasu przerwania (lustro PWA).
public enum TurnControlTiming {
  /// Sufit bramki gestu (`INTERRUPT_GUARD_MS`): normalnie bramkę zwalnia rozstrzygnięcie żądania,
  /// a po tylu sekundach od wysłania kolejny gest przechodzi, choćby odpowiedź jeszcze nie wróciła —
  /// świadome powtórzenie ma prawo dojść do serwera (tam jest prawdziwa idempotencja).
  public static let interruptGuard: TimeInterval = 4
  /// Odstęp jedynego ponowienia po błędzie sieci (PWA: 400 ms).
  public static let interruptRetryDelay: Duration = .milliseconds(400)
}

/// Wynik przerwania widziany przez klienta: trzy losy klawisza z drutu i odmowa Raroga,
/// której w protokole nie ma — od rozróżnienia zależy następny ruch człowieka.
public enum InterruptOutcome: Sendable, Equatable {
  /// Klawisz poszedł do panelu — także brak `delivered` (starszy serwer). `returnedPrompt`: the prompt Claude Code
  /// handed back to its own field, as the server reported it (`InterruptResponse.returnedPrompt`); `nil` = no
  /// hand-back, and then the app's field stays as it is, as the terminal's does.
  case delivered(returnedPrompt: String?)
  /// Panel nie przyjął Esc (`delivered: no` albo 5xx): droga wyjścia jest na Macu.
  case notDelivered
  /// Nie wiem: serwer przestał czekać albo sieć padła także po ponowieniu.
  case unsure
  /// Odmowa Raroga (4xx albo bramka klienta) PRZED panelem: zdanie serwera, gdy je podał.
  case refused(String?)
  /// Gest w oknie poprzedniego (bramka gestu) — nic nie poszło.
  case inFlight
  /// Nie ma czego przerywać albo kanał zamknięty (pole wygaszone) — nic nie poszło.
  case notAllowed
  /// Wylogowanie w trakcie (albo przed) — wynik nie należy do tego zalogowania.
  case loggedOut
}

/// Czy Stop stoi i czy działa. Stop dzieli los pola wiadomości: przy kanale zamkniętym
/// stoi wygaszony, bo przerwanie jedzie do panelu tą samą drogą co wiadomość.
public enum InterruptAvailability: Sendable, Equatable {
  case hidden
  case disabled
  case enabled
}

/// Co robi przycisk akcji pola wiadomości: „Wyślij" albo Stop. Osobnego Stopu
/// nie ma — przy pracującej turze i pustym polu „Wyślij" staje się Stopem, a każdy wpis przywraca „Wyślij".
public enum ComposerPrimaryAction: Sendable, Equatable {
  case send
  /// Stop; `enabled == false`, gdy przerwanie i tak by nie doszło (kanał zamknięty, niezgodność).
  case stop(enabled: Bool)

  /// Reguła przycisku. „Wpis" to tekst w polu, załącznik w pasku (także wczytywany) albo trwające dyktowanie,
  /// również jego kończenie — przy którymkolwiek przycisk wysyła. Bez tury (`.hidden`) zawsze „Wyślij".
  /// Przez ``ComposerPrimaryTiming/sendGrace`` po wysyłce przycisk zostaje „Wyślij": pole czyści się od razu,
  /// a tura w drodze daje Stop, więc drugi tap podwójnego „Wyślij" przerwałby świeżo wysłaną wiadomość.
  /// Zegar cofnięty (wysyłka „w przyszłości") okna nie trzyma — przycisk wysyłający bez końca byłby gorszy.
  public static func resolve(
    availability: InterruptAvailability, hasDraft: Bool, hasAttachments: Bool, dictationActive: Bool,
    sentAt: Date?, now: Date
  ) -> ComposerPrimaryAction {
    if hasDraft || hasAttachments || dictationActive { return .send }
    if graceEnds(sentAt: sentAt, now: now) != nil { return .send }
    switch availability {
    case .hidden: return .send
    case .disabled: return .stop(enabled: false)
    case .enabled: return .stop(enabled: true)
    }
  }

  /// Czy wysyłka otwiera okno po sobie: gdy zabrała z pola cokolwiek — także same białe znaki, bo pole i tak
  /// się czyści, a przycisk przy pracującej turze od razu stałby się Stopem pod drugim tapem.
  /// Tap w już pustym polu okna nie odnawia.
  public static func opensGrace(rawText: String, attachments: Int) -> Bool {
    !rawText.isEmpty || attachments > 0
  }

  /// Koniec okna po wysyłce, gdy jeszcze trwa (`nil` = okna nie ma): wtedy przycisk trzeba przeliczyć.
  public static func graceEnds(sentAt: Date?, now: Date) -> Date? {
    guard let sentAt else { return nil }
    let since = now.timeIntervalSince(sentAt)
    guard since >= 0, since < ComposerPrimaryTiming.sendGrace else { return nil }
    return sentAt.addingTimeInterval(ComposerPrimaryTiming.sendGrace)
  }
}

/// Stałe czasu przycisku pola.
public enum ComposerPrimaryTiming {
  /// Okno po wysyłce, w którym przycisk nie staje się Stopem (podwójny tap „Wyślij").
  public static let sendGrace: TimeInterval = 0.7
}

extension AppState {
  /// Wysyłki naprawdę w drodze (bez „Nie potwierdzono" i odmów) — dowód tury w drodze.
  /// Przeterminowany wpis to dowód na jej BRAK: Esc nad stojącym panelem otwiera cofanie rozmowy.
  /// Wpis w kolejce CLI czeka minutami — tury dowodzi tylko wtedy, gdy sesja w niej jest.
  public func inFlightSends(for sessionId: String) -> Int {
    let inTurn = sessions[sessionId].map { Self.turnStates.contains($0.state) } ?? false
    return outbox.filter { $0.sessionId == sessionId && $0.isWaiting && (inTurn || !$0.isQueued) }.count
  }

  /// Stop przy pracy ORAZ przy nieprzeterminowanym wpisie w locie (okno „wysłałem i chcę cofnąć");
  /// wygaszony, gdy wiadomość i tak by nie doszła (pole wygaszone kanałem albo niezgodnością).
  public func interruptAvailability(for sessionId: String) -> InterruptAvailability {
    guard let session = sessions[sessionId] else { return .hidden }
    let working = session.state == .running || session.state == .starting
    guard working || inFlightSends(for: sessionId) > 0 else { return .hidden }
    // Lista z pamięci podręcznej nie wie, czy tura trwa — bez Stopu do świeżego stanu.
    if sessionStale(sessionId) { return .hidden }
    switch compat {
    case .tooOld, .protocolMismatch: return .disabled
    case .unknown, .ok: break
    }
    // Start agenta wygasza samo pole, nie przerwanie: Esc jedzie do panelu bez bramki stanu wysyłki.
    switch sendBlock(for: sessionId) {
    case nil, .starting?: return .enabled
    default: return .disabled
    }
  }

  /// Przerwanie tej sesji leci, a gest jest w oknie bramki (sufit ``TurnControlTiming/interruptGuard``).
  /// Zegar cofnięty (zmiana czasu) otwiera bramkę — klawisz martwy do końca sesji byłby gorszy.
  public func interruptHeld(_ sessionId: String, now: Date) -> Bool {
    guard let sentAt = turnControl.interrupts[sessionId] else { return false }
    let since = now.timeIntervalSince(sentAt)
    return since >= 0 && since < TurnControlTiming.interruptGuard
  }

  /// Wiersz aktywności mówi „przerywa": żądanie przerwania tej sesji jest w drodze.
  public func isInterrupting(_ sessionId: String) -> Bool {
    turnControl.interrupts[sessionId] != nil
  }

  /// Tekst promptu z wiadomości albo `nil`, gdy wiadomość promptem nie jest (nie człowiek, notka
  /// harnessu, sam załącznik).
  public static func promptText(_ message: TranscriptMessage) -> String? {
    // Wspólna reguła roli efektywnej (`EffectiveRole.swift`): notka harnessu promptem nie jest.
    guard message.isHumanPrompt else { return nil }
    let text = message.blocks.compactMap { block -> String? in
      if case let .text(text, _) = block { return text }
      return nil
    }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  /// Wynik do zgłoszenia jako obejrzany: `stateSince` stojącego wyniku albo `nil`.
  /// Nie przy liście nieświeżej (strumień nie żyje), nie bez zalogowania i nie w trakcie tury —
  /// zerknięcie w transkrypt pracującej sesji nie jest odbiorem.
  /// A result the voice agent picked up (`seenBy`) is received but not by a person: the person's receipt takes
  /// `seenBy` away on the server, so the screen reports it like an unread result.
  public func seenTarget(_ sessionId: String) -> String? {
    guard auth == .loggedIn, global == .online, !sessionStale(sessionId), let session = sessions[sessionId] else { return nil }
    let receivedByPerson = session.seen == true && session.seenBy == nil
    guard session.state == .waitingInput, !receivedByPerson, !session.isUnsupported else { return nil }
    // Wynik oznaczony tu jako nieprzeczytany: ekran, który go akurat pokazuje, nie odbiera go z powrotem.
    guard !turnControl.manualUnread.contains(sessionId) else { return nil }
    return session.stateSince
  }

  /// Przełącznik odbioru z listy albo `nil`: tylko stojący wynik (`waiting-input`) przy zalogowaniu, żywym
  /// strumieniu i świeżej liście (z pamięci podręcznej lista nie wie, czy wynik jeszcze stoi — jak „×”).
  public func readToggle(_ sessionId: String) -> ReadToggle? {
    guard auth == .loggedIn, global == .online, !listStale, let session = sessions[sessionId] else { return nil }
    guard session.state == .waitingInput, session.stale != true, !session.isUnsupported else { return nil }
    return session.resultSeen ? .markUnread : .markRead
  }

  /// A result the agent has just handed over and nobody has taken yet: the list dot pulses. A result marked
  /// unread by hand is not fresh: the server says so in `markedUnseen`, and this device's own mark covers the
  /// moment between the gesture and that frame (``TurnControlState/manualUnreadConfirmed``). Background work has the
  /// working tone, so it never pulses. A frozen row (the session's source or the whole list is stale) has a still
  /// dot too: the list filter and the jump pill count the pulse from here, so they agree with the row.
  public func freshResult(_ session: SessionSummary) -> Bool {
    let pendingMark = turnControl.manualUnread.contains(session.id)
      && !turnControl.manualUnreadConfirmed.contains(session.id)
    return session.statusTone == .unread && session.markedUnseen != true && !pendingMark
      && session.stale != true && !listStale
  }
}

/// Co zrobi przełącznik odbioru wyniku z listy: prawe przesunięcie wiersza, menu kontekstowe, Shift+Cmd+U.
public enum ReadToggle: Sendable, Equatable {
  case markRead
  case markUnread
}
