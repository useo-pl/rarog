import Foundation
import RarogContract
import RarogTransport

// Inbox actions and reads: open and leave the Inbox, hold a card, remove a card with Undo, and the reads the open
// Inbox needs (card texts, and the transcript of every visible decision card, whose pending card gives the
// buttons and whose pane dialog card gives the dismiss action). The reads follow the state after every event
// (`syncInbox`), so a duplicate head or a burst of events asks once. Owner: Inbox.

/// Reads and requests of the Inbox in flight. Owner: `RarogStore+Inbox`.
struct InboxRuntime {
  /// `GET /api/inbox` is wanted: the Inbox opened, or `inbox-heads` came while it was open.
  var listWanted = false
  var listInFlight = false
  /// Session → the head version whose text a single read asked for: one read per version, also when the answer
  /// carries another version (a head that lags behind the text).
  var askedVersions: [String: String] = [:]
  var cardReads: Set<String> = []
  /// The one transcript read of the Inbox in flight: a session stream opened without a cursor, closed after its
  /// `transcript-snapshot`. One at a time and never open for long: each SSE stream holds a connection.
  var transcriptLoad: InboxTranscriptLoad?
  var loadGeneration = 0
  /// Session → the head version whose transcript stream answered 404 (no stream for that session): not asked again
  /// while that version stays, so the queue moves on to the next card. Versions are content digests and repeat, so
  /// the entry goes when the head leaves, changes its version, or its session goes, and on every `inbox-heads`
  /// (a global stream opened again: reconnect or server switch).
  var streamless: [String: String] = [:]
  /// Removals in flight, by session; Undo waits for its removal's answer before it restores.
  var removals: [String: Task<InboxRemoveOutcome, Never>] = [:]
  /// The session whose next transcript stream opens without a cursor, so it starts with a `transcript-snapshot`
  /// (``RarogStore/refreshTranscript(_:)``); taken by that open.
  var freshTranscript: String?
}

struct InboxTranscriptLoad {
  let id: Int
  let sessionId: String
  let version: String
  let task: Task<Void, Never>
}

extension RarogStore {
  // MARK: - Navigation

  /// The Inbox appeared: texts and decision transcripts start loading.
  public func inboxOpened() {
    guard !state.inbox.open else { return }
    inboxRuntime.listWanted = true
    dispatch(.inbox(.opened(true)))
  }

  /// The person left the Inbox (another screen on iPad, back to the list on iPhone; opening a session from a card is
  /// not leaving): every hold ends and the reads stop.
  public func inboxClosed() {
    guard state.inbox.open else { return }
    dispatch(.inbox(.opened(false)))
  }

  /// The person answered, decided or sent a voice prompt from this card: it stays in place with its work dot.
  public func holdInboxCard(_ sessionId: String) {
    dispatch(.inbox(.held(sessionId: sessionId)))
  }

  /// The voice agent of a card talks about this session only after a `transcript-snapshot` of it: a transcript kept in
  /// memory since an earlier visit can be many turns old, and a stream that resumes from its cursor brings no
  /// snapshot. The next transcript stream of the session opens without a cursor; when it is the session on screen,
  /// its stream opens again now. The snapshot counts in ``TranscriptState/snapshots``, so after this call only a
  /// stream opened after it may count one: the Inbox's transcript read of the session asked before stops here (its
  /// late snapshot would count as fresh; a read the next sync asks is fresh again), as an older stream of the session
  /// on screen does when its loop opens again.
  public func refreshTranscript(_ sessionId: String) {
    inboxRuntime.freshTranscript = sessionId
    if inboxRuntime.transcriptLoad?.sessionId == sessionId { stopInboxLoads() }
    if state.viewedSessionId == sessionId { syncSessionLoop(force: true) }
  }

  // MARK: - Removal and Undo

  /// Removes a visible card: it disappears at once and the request goes out at once. A 409 (the card changed) or a
  /// failure brings it back; a 409 also reads its text again.
  @discardableResult
  public func removeInboxCard(_ sessionId: String) async -> InboxRemoveOutcome {
    // The head the card shows (a held card may show the one it had when the hold began; the server answers 409 when
    // that card moved on).
    guard let head = state.inboxItems.first(where: { $0.id == sessionId })?.head,
      inboxRuntime.removals[sessionId] == nil
    else { return .notAllowed }
    guard state.global == .online else { return .offline }
    dispatch(.inbox(.removeStarted(sessionId: sessionId, at: areaNow)))
    let startedAt = state.inbox.removals[sessionId]?.at
    scheduleUndoExpiry(sessionId, at: startedAt)
    let transport = transport
    let login = currentLogin
    let body = InboxActionBody(turnId: head.turnId, version: head.version)
    let task = Task { [weak self] () -> InboxRemoveOutcome in
      let result: Result<InboxActionResponse, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.removeInboxCard(sessionId: sessionId, body))
      } catch {
        result = .failure(error)
      }
      guard let self else { return .failed }
      return self.finishRemoval(sessionId, head: head, result: result, login: login)
    }
    inboxRuntime.removals[sessionId] = task
    let outcome = await task.value
    if inboxRuntime.removals[sessionId] == task { inboxRuntime.removals[sessionId] = nil }
    return outcome
  }

  /// Undo of a removal within ``CoreTiming/inboxUndoWindow``: `restore` with the removal's `{turnId, version}`. A removal
  /// still in flight is awaited first, so the restore never reaches the server before it.
  @discardableResult
  public func undoInboxRemoval(_ sessionId: String) async -> InboxUndoOutcome {
    guard state.inboxUndoable(sessionId, now: areaNow, timing: timing) else { return .expired }
    if let pending = inboxRuntime.removals[sessionId] {
      switch await pending.value {
      case .removed: break
      case .loggedOut: return .loggedOut
      default: return .notRemoved
      }
    }
    guard let removal = state.inbox.removals[sessionId], removal.phase == .removed else { return .expired }
    guard state.global == .online else { return .offline }
    let (turnId, version) = (removal.head.turnId, removal.head.version)
    dispatch(.inbox(.restoreStarted(sessionId: sessionId)))
    let transport = transport
    let login = currentLogin
    let body = InboxActionBody(turnId: turnId, version: version)
    let result: Result<InboxActionResponse, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.restoreInboxCard(sessionId: sessionId, body))
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login) else { return .loggedOut }
    switch result {
    case .success:
      dispatch(.inbox(.restoreFinished(sessionId: sessionId, turnId: turnId, version: version, restored: true)))
      return .restored
    case let .failure(error):
      dispatch(.inbox(.restoreFinished(sessionId: sessionId, turnId: turnId, version: version, restored: false)))
      switch error {
      case let .http(failure) where failure.status == 409:
        readInboxCard(sessionId)
        return .changed
      case .unauthorized:
        handleUnauthorized(since: login)
        return .loggedOut
      case .offline:
        return .offline
      default:
        return .failed
      }
    }
  }

  private func finishRemoval(
    _ sessionId: String, head: InboxHead, result: Result<InboxActionResponse, TransportError>, login: Int
  ) -> InboxRemoveOutcome {
    guard isCurrentLogin(login) else { return .loggedOut }
    let finish = { (result: InboxRemoveResult) in
      self.dispatch(.inbox(.removeFinished(
        sessionId: sessionId, turnId: head.turnId, version: head.version, result: result)))
    }
    switch result {
    case let .success(answer):
      finish(.done)
      return .removed(receiptSkipped: answer.receipt == .skipped)
    case let .failure(error):
      switch error {
      case let .http(failure) where failure.status == 409:
        finish(.stale)
        readInboxCard(sessionId)
        return .changed
      case .unauthorized:
        finish(.failed)
        handleUnauthorized(since: login)
        return .loggedOut
      default:
        finish(.failed)
        return .failed
      }
    }
  }

  private func scheduleUndoExpiry(_ sessionId: String, at: Date?) {
    guard let at else { return }
    let window = timing.inboxUndoWindow
    Task { [weak self] in
      try? await Task.sleep(for: window)
      self?.dispatch(.inbox(.undoExpired(sessionId: sessionId, at: at)))
    }
  }

  // MARK: - Reads that follow the state

  /// Notes what an event asks of the reads: `inbox-heads` replaced the heads, so the texts are read again in full.
  func noteInboxEvent(_ event: CoreEvent) {
    if case .frame(.inboxHeads, .global, _) = event {
      inboxRuntime.listWanted = true
      inboxRuntime.askedVersions = [:]
      inboxRuntime.streamless = [:]
    }
  }

  /// Starts the reads the open Inbox lacks and stops those nobody wants. Called after every event.
  func syncInbox() {
    pruneStreamless()
    let canRead = state.inbox.open && state.auth == .loggedIn && areaPhase != .background && state.sessionsLoaded
      && !state.listStale
    guard canRead else {
      stopInboxLoads()
      return
    }
    syncInboxTexts()
    syncInboxTranscript()
  }

  /// A 404 blocks the transcript read only while the same head version stays continuously: an entry whose session
  /// has neither a head nor a held head of that version is dropped. The card's head is one of the two, so an entry
  /// that still blocks a wanted read is never dropped, and a stream that keeps answering 404 is not asked in a loop.
  private func pruneStreamless() {
    guard !inboxRuntime.streamless.isEmpty else { return }
    inboxRuntime.streamless = inboxRuntime.streamless.filter { sessionId, version in
      state.sessions[sessionId] != nil
        && (state.inbox.heads[sessionId]?.version == version || state.inbox.held[sessionId]?.head.version == version)
    }
  }

  private func syncInboxTexts() {
    if inboxRuntime.listWanted, !inboxRuntime.listInFlight {
      readInboxList()
      return
    }
    // The list read covers every card; single reads wait for it.
    guard !inboxRuntime.listInFlight else { return }
    for item in state.inboxItems where item.card == nil {
      let version = item.head.version
      guard inboxRuntime.askedVersions[item.id] != version, !inboxRuntime.cardReads.contains(item.id) else { continue }
      inboxRuntime.askedVersions[item.id] = version
      readInboxCard(item.id)
    }
  }

  private func readInboxList() {
    inboxRuntime.listWanted = false
    inboxRuntime.listInFlight = true
    let transport = transport
    let login = currentLogin
    Task { [weak self] in
      let result: Result<InboxList, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.inboxCards())
      } catch {
        result = .failure(error)
      }
      guard let self, self.isCurrentLogin(login) else { return }
      self.inboxRuntime.listInFlight = false
      switch result {
      case let .success(list):
        // The list marks no version as asked: a text the state kept keeps its card out of the single reads, and one
        // it dropped (no head, or a late version) is read again when its head comes.
        self.dispatch(.inbox(.cardsRead(list.cards)))
      case let .failure(error):
        if case .unauthorized = error { self.handleUnauthorized(since: login) } else { self.syncInbox() }
      }
    }
  }

  /// `GET /api/inbox/<id>` of one card; a second read of the same session waits for the first.
  private func readInboxCard(_ sessionId: String) {
    guard !inboxRuntime.cardReads.contains(sessionId) else { return }
    inboxRuntime.cardReads.insert(sessionId)
    let transport = transport
    let login = currentLogin
    Task { [weak self] in
      let result: Result<InboxCardResponse, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.inboxCard(sessionId: sessionId))
      } catch {
        result = .failure(error)
      }
      guard let self, self.isCurrentLogin(login) else { return }
      self.inboxRuntime.cardReads.remove(sessionId)
      switch result {
      case let .success(answer):
        self.dispatch(.inbox(.cardRead(sessionId: sessionId, card: answer.card)))
      case let .failure(error):
        if case .unauthorized = error { self.handleUnauthorized(since: login) }
      }
    }
  }

  /// Sessions whose decision card needs the transcript, in Inbox order, with the head version to load it for: a
  /// pending card named by `requestId` gives the decision buttons, and a dialog in the pane without a card gets its
  /// dismiss action from the transcript's pane dialog card. The
  /// session on screen has its own live stream, and a second stream of one session would double its deltas; a head
  /// version whose stream answered 404 takes no place. At most
  /// as many as the transcript memory keeps next to the session on screen (``CoreLimits/maxTranscripts``): more would
  /// push each other out and load again without end.
  private var inboxTranscriptsWanted: [(sessionId: String, version: String)] {
    let decisions = state.inboxItems.filter { item in
      guard item.head.kind == .decision, item.session.showsTranscript, item.id != state.viewedSessionId,
        inboxRuntime.streamless[item.id] != item.head.version
      else { return false }
      if item.head.paneDialog(card: item.card) { return true }
      switch item.card?.dialog {
      case .permission(_, _?)?, .question(_, _?)?: return true
      case .permission?, .question?, .panel?, nil: return false
      }
    }
    return decisions.prefix(CoreLimits.maxTranscripts - 1).compactMap { item in
      let loaded = state.inbox.transcriptVersions[item.id] == item.head.version
        && (state.transcripts[item.id]?.snapshots ?? 0) > 0
      return loaded ? nil : (item.id, item.head.version)
    }
  }

  private func syncInboxTranscript() {
    let wanted = inboxTranscriptsWanted
    if let load = inboxRuntime.transcriptLoad {
      if wanted.contains(where: { $0.sessionId == load.sessionId && $0.version == load.version }) { return }
      stopInboxLoads()
    }
    guard let next = wanted.first else { return }
    inboxRuntime.loadGeneration += 1
    let id = inboxRuntime.loadGeneration
    let (sessionId, version) = next
    let supervisor = StreamSupervisor(
      scope: .session(id: sessionId), transport: transport, timing: timing, render: renderer,
      threshold: stallThreshold, clock: streamClock
    ) { [weak self] signal in
      await self?.handleInboxLoad(signal, id: id)
    }
    let task = Task.detached { await supervisor.run(cursor: nil) }
    inboxRuntime.transcriptLoad = InboxTranscriptLoad(id: id, sessionId: sessionId, version: version, task: task)
  }

  /// Signals of the Inbox's transcript read. Only its `transcript-snapshot` reaches the reducer; the stream's
  /// connection states are not the session screen's banner, so they go nowhere.
  private func handleInboxLoad(_ signal: SupervisorSignal, id: Int) async {
    guard let load = inboxRuntime.transcriptLoad, load.id == id else { return }
    switch signal {
    case let .frame(outcome, data, cursor):
      reporter.record(ContractReporter.lines(for: outcome, data: data))
      flushReport()
      guard case let .success(decoded) = outcome, case .transcriptSnapshot = decoded.event else { return }
      load.task.cancel()
      // The load stays recorded until both events are in, so the sync they run does not start it again.
      dispatch(.frame(decoded.event, source: .session(load.sessionId), cursor: cursor))
      dispatch(.inbox(.transcriptLoaded(sessionId: load.sessionId, version: load.version)))
      if inboxRuntime.transcriptLoad?.id == id { inboxRuntime.transcriptLoad = nil }
    case .sessionGone:
      inboxRuntime.transcriptLoad = nil
      // Not asked again for this version: the session has no stream. No transcript came, so nothing is recorded as
      // loaded; the next card's read starts now.
      inboxRuntime.streamless[load.sessionId] = load.version
      syncInbox()
    case .unauthorized:
      inboxRuntime.transcriptLoad = nil
      handleUnauthorized()
    case .connecting, .opened, .dropped:
      break
    }
  }

  /// The transcript read stops: the Inbox closed, background, logout, or nobody wants it.
  func stopInboxLoads() {
    inboxRuntime.transcriptLoad?.task.cancel()
    inboxRuntime.transcriptLoad = nil
  }

  /// Logout or server switch: nothing in flight belongs to the next login.
  func forgetInbox() {
    stopInboxLoads()
    for task in inboxRuntime.removals.values { task.cancel() }
    inboxRuntime = InboxRuntime()
  }
}
