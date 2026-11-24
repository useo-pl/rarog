import Foundation
import RarogContract
import RarogTransport

/// Skąd przyszła ramka: strumień globalny (lista) albo strumień transkryptu jednej sesji.
public enum FrameSource: Sendable, Equatable {
  case global
  case session(String)
}

/// Wynik decyzji z punktu widzenia stanu karty.
public enum DecisionResultKind: Sendable, Equatable {
  /// Serwer przyjął — karta zostaje do rozstrzygnięcia z serwera.
  case accepted
  /// 409: zajęte na innym urządzeniu — karta znika ze śladem; karta kanału zgód zostaje (zdejmuje ją
  /// `permission-resolved` albo 410).
  case conflict
  /// 410: karty już nie ma — znika ze śladem „wygasła".
  case gone
  /// 422 albo błąd sieci: dialog dalej stoi, karta ZOSTAJE.
  case keep
}

/// Jedno zdarzenie rdzenia. Reduktor ``AppState/apply(_:now:)`` jest JEDYNYM miejscem zmiany stanu.
public enum CoreEvent: Sendable, Equatable {
  // MARK: Połączenie i logowanie
  case connecting(StreamScope)
  /// Strumień zestawiony; `resumedWithCursor` = otwarty z `Last-Event-ID` (brakujące delty nie wrócą).
  case streamOpened(StreamScope, resumedWithCursor: Bool)
  case streamDropped(StreamScope)
  case streamStopped(StreamScope)
  /// Ramka protokołu. `cursor` = `id:` z tego bloku (tylko ramki domknięte go niosą).
  case frame(ServerEvent, source: FrameSource, cursor: String?)
  case loggedIn
  case loggedOut(LogoutReason)
  /// Start bez klucza (ekran parowania): jak wylogowanie, ale plik pamięci podręcznej listy ZOSTAJE — lista
  /// w przestrzeni ze wskaźnika (np. po odpięciu z Maca) wraca przy parowaniu z jej serwerem; inny serwer kasuje ją
  /// `dataWiped`.
  case startedWithoutCredential(LogoutReason)
  /// Przełączenie poświadczenia albo serwera (parowanie, „Zapomnij serwer”): obraz poprzedniego połączenia
  /// znika jak przy wylogowaniu, zalogowanie wraca do `unknown` do pierwszej klatki nowego transportu.
  case switchingServer
  case viewSession(String?)

  // MARK: Kolejka wysyłki
  case outboxEnqueued(OutboxEntry)
  case outboxRestored([OutboxEntry])
  case outboxAccepted(UUID, at: Date)
  /// Brak echa po 15 s od 202 — tylko dla wpisu wciąż `sent` (echo mogło już przyjść).
  case outboxUnconfirmedIfStillSent(UUID)
  /// Zerwana sieć / timeout w trakcie żądania — wynik nieznany.
  case outboxUnconfirmed(UUID)
  case outboxRefused(UUID, code: String?, message: String?)
  case outboxRetrying(UUID)
  case outboxDiscarded(UUID)
  /// 202 z `queued: true`: serwer trzyma echo, aż CLI weźmie prompt — wpis czeka bez progu 15 s.
  case outboxQueued(UUID, at: Date)
  /// Sufit wpisu z echem odroczonym (``CoreTiming/queuedUnconfirmedAfter``) — tylko dla wpisu wciąż w kolejce.
  case outboxUnconfirmedIfQueued(UUID)
  /// Sesja poza turą od `since` (``CoreTiming/queuedIdleAfter``): wpisy w kolejce, których echo nie przyszło,
  /// kończą jako „Nie potwierdzono” — o ile okres bezczynności trwa od tej samej chwili.
  case outboxQueuedIdle(sessionId: String, since: Date)
  /// The countdown after the 202 of an accepted entry, started at `openedAt` (its session's stream came online, or its
  /// wait for that stream ended), ended: Not confirmed, unless the entry waits for the stream, a later start replaced
  /// this one, or an entry in the CLI queue is still before its cap.
  case outboxUnconfirmedAfterOpening(UUID, openedAt: Date)

  // MARK: Decyzje
  /// `answers` — odpowiedzi karty pytania per pytanie, do śladu decyzji; przy zgodzie puste.
  case decisionStarted(sessionId: String, cardId: String, choice: String, answers: [[String]] = [])
  case decisionFinished(sessionId: String, cardId: String, kind: CardNotice.Kind, result: DecisionResultKind)
  /// Zwolnienie karty kanału zgód do terminala (`release`) wyszło z tego urządzenia.
  case releaseStarted(sessionId: String, permId: String)
  case releaseFinished(sessionId: String, permId: String, result: DecisionResultKind)
  case pruneNotices(olderThan: Date)

  // MARK: Kolejka wysyłki
  /// 202 z `replayed: true`: wiadomość przyjęta już wcześniej, echa tej odpowiedzi nie będzie.
  case outboxReplayed(UUID)
  /// Etap wysyłki wpisu z załącznikiem (tylko dla wpisu wciąż `queued`).
  case outboxProgress(UUID, SendProgress)

  // MARK: Limity planu i sonda możliwości (`Reducer+Usage`)
  /// Wynik odczytu `GET /api/usage`.
  case planUsageResult(PlanUsageOutcome, at: Date)
  /// Odpowiedź sondy `GET /api/version`: flagi możliwości i nazwa tailnetu.
  case versionProbed(VersionInfo)

  // MARK: Katalog projektów (gałęzie w `Reducer+Catalog`)
  case catalog(CatalogEvent)

  // MARK: Sterowanie sesją z nagłówka (gałęzie w `Reducer+Session`)
  case session(SessionControlEvent)

  // MARK: Karty decyzji i karta stanu (gałęzie w `Reducer+Decisions`)
  case cards(CardsEvent)

  // MARK: Przerwanie tury i odbiór wyniku (gałęzie w `Reducer+SessionControl`)
  case turnControl(TurnControlEvent)

  // MARK: Dyktowanie (gałęzie w `Reducer+Voice`)
  case voice(VoiceEvent)

  // MARK: Pamięć podręczna listy (gałęzie w `Reducer+ListCache`)
  case listCache(ListCacheEvent)

  // MARK: Lista terminali (gałęzie w `Reducer+Terminal`)
  case terminals(TerminalListEvent)

  // MARK: Powiadomienia APNs (gałęzie w `Reducer+Push`)
  case push(PushEvent)

  // MARK: Pamięć listy urządzenia (gałęzie w `Reducer+List`)
  case list(ListEvent)

  // MARK: Obciążenie Maca (gałęzie w `Reducer+Mac`)
  case mac(MacLoadEvent)

  // MARK: Slash-komendy sesji (gałęzie w `Commands.swift`)
  case commands(CommandListEvent)

  // MARK: Notatki projektu (`RarogStore+Notes`)
  /// Odczyt albo zapis notatki z apki powiedział, czy katalog ma notatkę (sonda projektu spoza `notesCwds`).
  case notesProbed(cwd: String, present: Bool)

  // MARK: Parowanie i klucz urządzenia (gałęzie w `Reducer+Pairing`)
  case pairing(PairingEvent)

  // MARK: Queue take-back (branches in `Reducer+QueueTakeBack`)
  case queueTakeBack(QueueTakeBackEvent)

  // MARK: Inbox (branches in `Reducer+Inbox`)
  case inbox(InboxEvent)
}

/// Skutek uboczny reduktora do wykonania przez magazyn (reduktor sam nie dotyka dysku ani sieci).
public enum CoreEffect: Sendable, Equatable {
  /// Wpis kolejki dostał echo — jego plik ma zniknąć z dysku.
  case forgetOutboxEntry(UUID)
  /// Wpis zmienił stan — zapisz go ponownie.
  case persistOutboxEntry(OutboxEntry)
  /// Wylogowanie — kasuj pamięć podręczną.
  case clearCaches
  /// Przyszła świeża lista — zapisz ją do pamięci podręcznej (`RarogStore+Cache`).
  case persistListCache
  /// Sesja z wpisem w kolejce CLI wyszła z tury: sprawdź za ``CoreTiming/queuedIdleAfter``.
  case scheduleQueuedIdleCheck(sessionId: String, since: Date)
  /// An accepted entry's countdown started at `openedAt` (its session's stream came online, or its wait for that
  /// stream ended): check for Not confirmed after `after` (``CoreEvent/outboxUnconfirmedAfterOpening(_:openedAt:)``).
  case scheduleUnconfirmedCheck(UUID, after: Duration, openedAt: Date)
  /// An entry in the CLI queue met its session's stream coming online: check the cap
  /// (``CoreTiming/queuedUnconfirmedAfter``) counted from `queuedAt`, for what is left of it.
  case scheduleQueuedCeilingCheck(UUID, queuedAt: Date)
  /// A restarted card stands live again with the old `cliUpdate`: check after ``SessionControlTiming/restartSettleGrace``.
  case scheduleRestartGrace(sessionId: String, settledAt: Date)
}
