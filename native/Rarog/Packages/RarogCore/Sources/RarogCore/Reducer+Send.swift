import Foundation
import RarogContract

// Reduktor kolejki wysyłki. Właściciel: wysyłka. Główny `apply` oddaje tu
// każde zdarzenie `outbox*`; echo z transkryptu woła `reconcileEcho`.
extension AppState {
  mutating func applySend(_ event: CoreEvent, now: Date, timing: CoreTiming) -> [CoreEffect] {
    switch event {
    case let .outboxEnqueued(entry):
      outbox.append(entry)
    case let .outboxRestored(entries):
      outbox = entries.sorted { $0.createdAt < $1.createdAt }
    case let .outboxAccepted(id, at):
      return updateOutboxEntry(id) { entry in
        guard entry.state == .queued else { return false }
        entry.state = .sent(acceptedAt: at)
        return true
      }
    case let .outboxUnconfirmedIfStillSent(id):
      return updateOutboxEntry(id) { entry in
        // Wpis w kolejce CLI nie ma progu 15 s — także gdy stary licznik z wcześniejszego przyjęcia
        // odpali po powtórce z `queued`.
        guard case .sent = entry.state, entry.queuedAt == nil else { return false }
        entry.state = .unconfirmed
        return true
      }
    case let .outboxQueued(id, at):
      return updateOutboxEntry(id) { entry in
        switch entry.state {
        case .queued, .sent: break
        case .unconfirmed, .refused: return false
        }
        entry.state = .sent(acceptedAt: at)
        // Sufit liczy się od PIERWSZEGO przyjęcia — powtórka z `queued` go nie przesuwa.
        if entry.queuedAt == nil { entry.queuedAt = at }
        return true
      }
    case let .outboxUnconfirmedIfQueued(id):
      return updateOutboxEntry(id) { entry in
        guard entry.isQueued, let queuedAt = entry.queuedAt,
          now.timeIntervalSince(queuedAt) >= timing.queuedUnconfirmedAfter.timeInterval
        else { return false }
        entry.state = .unconfirmed
        return true
      }
    case let .outboxQueuedIdle(sessionId, since):
      // Tylko ten sam okres bezczynności: sesja mogła w międzyczasie wrócić do tury i znowu z niej wyjść.
      guard queuedIdleSince[sessionId] == since,
        now.timeIntervalSince(since) >= timing.queuedIdleAfter.timeInterval
      else { return [] }
      var effects: [CoreEffect] = []
      for entry in outbox where entry.sessionId == sessionId && entry.isQueued {
        effects += updateOutboxEntry(entry.id) { entry in
          entry.state = .unconfirmed
          return true
        }
      }
      return effects
    case let .outboxUnconfirmed(id):
      return updateOutboxEntry(id) { entry in
        guard entry.state == .queued else { return false }
        entry.state = .unconfirmed
        return true
      }
    case let .outboxRefused(id, code, message):
      return updateOutboxEntry(id) { entry in
        entry.state = .refused(code: code, message: message)
        return true
      }
    case let .outboxRetrying(id):
      // Magazyn zapisał stan `queued` na dysk PRZED tym zdarzeniem (i przed żądaniem) — bez
      // drugiego, asynchronicznego zapisu.
      guard let index = outbox.firstIndex(where: { $0.id == id }) else { return [] }
      switch outbox[index].state {
      case .unconfirmed, .refused: outbox[index].state = .queued
      case .queued, .sent: break
      }
    case let .outboxDiscarded(id):
      return removeOutboxEntry(id)
    case let .outboxReplayed(id):
      // Powtórka przyjętej: wiadomość jest w rozmowie od pierwszego przyjęcia, a jej echo
      // mogło przyjść wcześniej albo przepaść (restart Raroga). Wpis gaśnie jako przyjęty.
      return removeOutboxEntry(id)
    case let .outboxProgress(id, progress):
      // Spóźniony raport po 202 albo po echu nie wskrzesza paska postępu.
      guard outbox.contains(where: { $0.id == id && $0.state == .queued }) else { return [] }
      sendProgress[id] = progress
    default:
      break
    }
    return []
  }

  /// Echo odroczone: okres bezczynności każdej sesji z wpisem w kolejce CLI. Sesja w turze (praca albo
  /// decyzja — karta zgody to dalej tura) okres zamyka; sesja poza turą otwiera go raz i dostaje sprawdzenie za
  /// ``CoreTiming/queuedIdleAfter``. Stan nieznany (sesji nie ma na liście albo lista nieświeża) okresu nie
  /// otwiera — wtedy pilnuje sufit. Wołane przez magazyn po KAŻDYM zdarzeniu, więc łapie stan z dowolnej ramki
  /// (lista, zmiana sesji, odtworzenie po połączeniu i po starcie apki).
  mutating func syncQueuedIdle(now: Date) -> [CoreEffect] {
    let waiting = Set(outbox.filter(\.isQueued).map(\.sessionId))
    var effects: [CoreEffect] = []
    for sessionId in Array(queuedIdleSince.keys) where !waiting.contains(sessionId) {
      queuedIdleSince[sessionId] = nil
    }
    for sessionId in waiting {
      guard let session = sessions[sessionId], !sessionStale(sessionId) else {
        queuedIdleSince[sessionId] = nil
        continue
      }
      if Self.turnStates.contains(session.state) {
        queuedIdleSince[sessionId] = nil
      } else if queuedIdleSince[sessionId] == nil {
        queuedIdleSince[sessionId] = now
        effects.append(.scheduleQueuedIdleCheck(sessionId: sessionId, since: now))
      }
    }
    return effects
  }

  /// Echo gasi wpis (najpierw po `clientMessageId`, potem po podpisie) — także wpis jeszcze
  /// `queued`: serwer wysyła echo PRZED odpowiedzią 202.
  mutating func reconcileEcho(sessionId: String, message: TranscriptMessage, timing: CoreTiming) -> [CoreEffect] {
    guard let index = EchoMatching.matchIndex(
      in: outbox, sessionId: sessionId, message: message, serverStartId: serverStartId, skew: timing.echoClockSkew)
    else { return [] }
    let entry = outbox.remove(at: index)
    sendProgress[entry.id] = nil
    echoed[entry.id] = message.seq
    return [.forgetOutboxEntry(entry.id)]
  }

  private mutating func removeOutboxEntry(_ id: UUID) -> [CoreEffect] {
    guard outbox.contains(where: { $0.id == id }) else { return [] }
    outbox.removeAll { $0.id == id }
    sendProgress[id] = nil
    return [.forgetOutboxEntry(id)]
  }

  /// Zmiana stanu wpisu: zapis na dysk, a pasek postępu żyje wyłącznie przy `queued`.
  private mutating func updateOutboxEntry(_ id: UUID, _ change: (inout OutboxEntry) -> Bool) -> [CoreEffect] {
    guard let index = outbox.firstIndex(where: { $0.id == id }) else { return [] }
    guard change(&outbox[index]) else { return [] }
    if outbox[index].state != .queued { sendProgress[id] = nil }
    return [.persistOutboxEntry(outbox[index])]
  }
}
