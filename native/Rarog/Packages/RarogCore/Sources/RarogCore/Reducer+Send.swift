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
      // Each accepted entry gets its countdown from the store (`restoreOutbox`), whether it waits or not.
      outbox = entries.sorted { $0.createdAt < $1.createdAt }
    case let .outboxAccepted(id, at):
      // A new 202 has its own countdown (`deliver`), counted from it.
      unconfirmedOpenings[id] = nil
      return updateOutboxEntry(id) { entry in
        guard entry.state == .queued else { return false }
        entry.state = .sent(acceptedAt: at)
        return true
      }
    case let .outboxUnconfirmedIfStillSent(id):
      let unwatched = outbox.first { $0.id == id }.map(waitsForOpenStream) ?? false
      // After the stream's opening only the opening's own countdown counts (`outboxUnconfirmedAfterOpening`).
      let opened = unconfirmedOpenings[id] != nil
      return updateOutboxEntry(id) { entry in
        // Wpis w kolejce CLI nie ma progu 15 s — także gdy stary licznik z wcześniejszego przyjęcia
        // odpali po powtórce z `queued`.
        guard case .sent = entry.state, entry.queuedAt == nil, !unwatched, !opened else { return false }
        entry.state = .unconfirmed
        return true
      }
    case let .outboxUnconfirmedAfterOpening(id, openedAt):
      let unwatched = outbox.first { $0.id == id }.map(waitsForOpenStream) ?? false
      guard unconfirmedOpenings[id] == openedAt else { return [] }
      return updateOutboxEntry(id) { entry in
        guard case .sent = entry.state, !unwatched else { return false }
        // An entry in the CLI queue gets this countdown only when its wait ends (`countdownsAfterTheWait`); before its
        // cap, the cap's own check decides.
        if let queuedAt = entry.queuedAt,
          now.timeIntervalSince(queuedAt) < timing.queuedUnconfirmedAfter.timeInterval
        {
          return false
        }
        entry.state = .unconfirmed
        return true
      }
    case let .outboxQueued(id, at):
      // A new 202 has its own cap's check (`deliver`).
      unconfirmedOpenings[id] = nil
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
      let unwatched = outbox.first { $0.id == id }.map(waitsForOpenStream) ?? false
      return updateOutboxEntry(id) { entry in
        guard entry.isQueued, !unwatched, let queuedAt = entry.queuedAt,
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
      for entry in outbox where entry.sessionId == sessionId && entry.isQueued && !waitsForOpenStream(entry) {
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
    // An entry counts only while its session's stream is open: the period starts when it opens.
    let waiting = Set(outbox.filter { $0.isQueued && !waitsForOpenStream($0) }.map(\.sessionId))
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

  /// Whether an accepted entry waits for its session's stream to open, whoever sent it (the session screen, an Inbox
  /// card, the voice agent): only while the session is on a fresh list, can open a transcript stream
  /// (``SessionSummary/showsTranscript``) and its stream is not open. While waiting no echo can reach the app, so a
  /// check that comes then (the 15 s after the 202, the idle period, the cap) changes nothing; opening the session
  /// reconciles it with the transcript and starts the deadlines again (`unconfirmedChecksOnOpen`). A session off a
  /// fresh list, or one in a Rarog terminal, never opens that stream, so its entries do not wait. Without a fresh list
  /// (none yet, or one from the cache) nobody knows whether the session is still there, so its entries wait.
  func waitsForOpenStream(_ entry: OutboxEntry) -> Bool {
    if sessionStreamOpen(entry.sessionId) { return false }
    guard sessionsLoaded, !listStale else { return true }
    return sessions[entry.sessionId]?.showsTranscript == true
  }

  private func sessionStreamOpen(_ sessionId: String) -> Bool {
    viewedSessionId == sessionId && sessionStream == .online
  }

  /// The accepted entries that wait for their session's stream, read by `apply` before every event.
  func entriesWaitingForStream() -> Set<UUID> {
    var waiting: Set<UUID> = []
    for entry in outbox where waitsForOpenStream(entry) {
      if case .sent = entry.state { waiting.insert(entry.id) }
    }
    return waiting
  }

  /// Entries of `waiting` whose wait the event ended without their stream coming online (an opening starts its own
  /// deadlines, `unconfirmedChecksOnOpen`): the session left a fresh list, moved into a Rarog terminal, or the first
  /// fresh list came without it. Each gets a countdown from now (`countdownFromNow`), also when its check already
  /// came while it waited, so the check is decided again later and not at once: a session off the list for a moment
  /// (a server restart) and back before the countdown ends keeps its entries waiting. Called by `apply` after every
  /// event, as the one place that sees the wait end.
  mutating func countdownsAfterTheWait(_ waiting: Set<UUID>, now: Date, timing: CoreTiming) -> [CoreEffect] {
    guard !waiting.isEmpty else { return [] }
    var effects: [CoreEffect] = []
    for entry in outbox where waiting.contains(entry.id) {
      guard case .sent = entry.state, !waitsForOpenStream(entry), !sessionStreamOpen(entry.sessionId) else { continue }
      effects += countdownFromNow(entry, now: now, timing: timing)
    }
    return effects
  }

  /// The session's stream came online at `now`: each entry of it still waiting for its echo after a 202 gets the
  /// ordinary deadlines from here (`openingDeadlines`).
  mutating func unconfirmedChecksOnOpen(sessionId: String, now: Date, timing: CoreTiming) -> [CoreEffect] {
    var effects: [CoreEffect] = []
    for entry in outbox where entry.sessionId == sessionId {
      effects += openingDeadlines(entry, now: now, timing: timing)
    }
    return effects
  }

  /// The deadlines of an accepted entry counted from its session stream's opening at `now`. Outside the CLI queue:
  /// the countdown from this moment (`countdownFromNow`). In the CLI queue: the cap's check for what is left of the
  /// cap since the entry was queued (its check while it waited, or the one after a restart, changed nothing); the
  /// idle period opens in `syncQueuedIdle`.
  private mutating func openingDeadlines(_ entry: OutboxEntry, now: Date, timing: CoreTiming) -> [CoreEffect] {
    guard case .sent = entry.state else { return [] }
    if let queuedAt = entry.queuedAt { return [.scheduleQueuedCeilingCheck(entry.id, queuedAt: queuedAt)] }
    return countdownFromNow(entry, now: now, timing: timing)
  }

  /// The countdown after the 202 counted from `now`: it replaces the countdown the entry had (`unconfirmedOpenings`),
  /// so a check scheduled before changes nothing.
  private mutating func countdownFromNow(_ entry: OutboxEntry, now: Date, timing: CoreTiming) -> [CoreEffect] {
    unconfirmedOpenings[entry.id] = now
    return [.scheduleUnconfirmedCheck(entry.id, after: timing.unconfirmedAfter(for: entry), openedAt: now)]
  }

  /// Echo gasi wpis (najpierw po `clientMessageId`, potem po podpisie) — także wpis jeszcze
  /// `queued`: serwer wysyła echo PRZED odpowiedzią 202.
  mutating func reconcileEcho(sessionId: String, message: TranscriptMessage, timing: CoreTiming) -> [CoreEffect] {
    guard let index = EchoMatching.matchIndex(
      in: outbox, sessionId: sessionId, message: message, serverStartId: serverStartId, skew: timing.echoClockSkew)
    else { return [] }
    let entry = outbox.remove(at: index)
    sendProgress[entry.id] = nil
    unconfirmedOpenings[entry.id] = nil
    echoed[entry.id] = message.seq
    if let prompt = CompanionPrompt(entry) { echoedPrompts[entry.id] = prompt }
    return [.forgetOutboxEntry(entry.id)]
  }

  private mutating func removeOutboxEntry(_ id: UUID) -> [CoreEffect] {
    guard outbox.contains(where: { $0.id == id }) else { return [] }
    outbox.removeAll { $0.id == id }
    sendProgress[id] = nil
    unconfirmedOpenings[id] = nil
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
