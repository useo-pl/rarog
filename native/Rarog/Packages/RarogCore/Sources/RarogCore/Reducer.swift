import Foundation
import RarogContract
import RarogTransport

// Reduktor stanu: `(stan, zdarzenie) → stan`, czysty (czas podaje wołający, efekty wraca listą).
// Każda reguła ma powód przy kodzie.

extension AppState {
  /// Nakłada zdarzenie na stan. Zwraca skutki uboczne do wykonania przez magazyn.
  @discardableResult
  public mutating func apply(_ event: CoreEvent, now: Date, timing: CoreTiming = .production) -> [CoreEffect] {
    // An accepted entry whose wait for its session's stream this event ends gets a countdown (`Reducer+Send`).
    let waiting = entriesWaitingForStream()
    let effects = reduce(event, now: now, timing: timing)
    return effects + countdownsAfterTheWait(waiting, now: now, timing: timing)
  }

  private mutating func reduce(_ event: CoreEvent, now: Date, timing: CoreTiming) -> [CoreEffect] {
    switch event {
    case let .connecting(scope):
      setStatus(scope, .connecting(since: now))
    case let .streamOpened(scope, resumed):
      setStatus(scope, .online)
      if case let .session(id) = scope {
        if resumed { markGap(sessionId: id) }
        markJoin(sessionId: id)
        // Entries waiting for this stream (`Reducer+Send`).
        return unconfirmedChecksOnOpen(sessionId: id, now: now, timing: timing)
      }
    case let .streamDropped(scope):
      setStatus(scope, .offline(since: now))
    case let .streamStopped(scope):
      setStatus(scope, .idle)
    case let .frame(frame, source, cursor):
      let effects = applyFrame(frame, source: source, cursor: cursor, now: now, timing: timing)
      // Lista potwierdzona W TYM połączeniu (cel z pusha, rejestracja APNs, plakietka; `Reducer+Push`).
      if case .sessionsSnapshot = frame, source == .global { push.listConfirmed = true }
      // Obraz listy samego strumienia globalnego — źródło zapisu liczników kafla (`Selectors+LiveActivity`).
      if source == .global { noteGlobalList(frame) }
      // Ostrzeżenie o zaufaniu katalogu gaśnie, gdy sesja ruszy (karty, `Reducer+Decisions`).
      settleTrustPrompt()
      // Czas wejścia w czekanie na decyzję — okres łaski przed kartą „dialog w terminalu” (`Reducer+Decisions`).
      noteDecisionWaits(frame, now: now)
      // A model change in flight ends when the list shows its target (`Reducer+Session`).
      settleModelChanges()
      // A restart in progress ends when the list shows how it ended (`Reducer+Session`).
      return effects + settleRestarts(now: now)
    case .loggedIn:
      resetView()
      auth = .loggedIn
    case let .loggedOut(reason):
      // 401 kasuje obraz sprzed wylogowania — nie ma prawa mignąć po ponownym logowaniu.
      resetView()
      auth = .loggedOut(reason)
      return [.clearCaches]
    case let .startedWithoutCredential(reason):
      resetView()
      auth = .loggedOut(reason)
    case .switchingServer:
      // Nowe poświadczenie albo nowy serwer: obraz starego połączenia znika jak przy wylogowaniu. Pamięci podręcznej
      // listy nie kasujemy tutaj — przy tym samym serwerze to wciąż jego lista; inny serwer kasuje ją `dataWiped`.
      resetView()
      auth = .unknown
    case let .viewSession(id):
      viewedSessionId = id
      if let id, transcripts[id] != nil { touchTranscript(id) }
      // Lista komend należy do sesji na ekranie: inna sesja = inny katalog.
      forgetCommands(unless: id)
    case .outboxEnqueued, .outboxRestored, .outboxAccepted, .outboxUnconfirmedIfStillSent, .outboxUnconfirmed,
      .outboxRefused, .outboxRetrying, .outboxDiscarded, .outboxReplayed, .outboxProgress, .outboxQueued,
      .outboxUnconfirmedIfQueued, .outboxQueuedIdle, .outboxUnconfirmedAfterOpening:
      // Kolejka wysyłki: `Reducer+Send` (właściciel: wysyłka).
      return applySend(event, now: now, timing: timing)
    case let .decisionStarted(sessionId, cardId, choice, answers):
      transcripts[sessionId]?.decisions[cardId] = DecisionAttempt(choice: choice, startedAt: now)
      if let draft = transcripts[sessionId]?.traceDraft(cardId: cardId, choice: choice, answers: answers, at: now) {
        transcripts[sessionId]?.traceDrafts[cardId] = draft
      }
    case let .decisionFinished(sessionId, cardId, kind, result):
      finishDecision(sessionId: sessionId, cardId: cardId, kind: kind, result: result, now: now)
    case let .releaseStarted(sessionId, permId):
      transcripts[sessionId]?.releases[permId] = now
    case let .releaseFinished(sessionId, permId, result):
      finishRelease(sessionId: sessionId, permId: permId, result: result, now: now)
    case let .pruneNotices(cutoff):
      notices.removeAll { $0.at <= cutoff }
    case let .planUsageResult(outcome, at):
      applyPlanUsage(outcome, at: at)
    case let .versionProbed(info):
      applyVersion(info)
      settleInboxCapability()
    case let .catalog(event):
      return applyCatalog(event)
    case let .session(event):
      return applySession(event, now: now)
    case let .cards(event):
      applyCards(event)
    case let .turnControl(event):
      return applyTurnControl(event)
    case let .voice(event):
      applyVoice(event)
    case let .listCache(event):
      applyListCache(event)
    case let .terminals(event):
      applyTerminals(event)
    case let .push(event):
      applyPush(event)
    case let .list(event):
      applyList(event)
    case let .mac(event):
      applyMac(event)
    case let .commands(event):
      applyCommands(event)
    case let .notesProbed(cwd, present):
      // Własny odczyt apki: bit bez sygnału „przeczytaj jeszcze raz" — treść model notatek już ma.
      notesPresent[ProjectPath.normalized(cwd)] = present
    case let .pairing(event):
      return applyPairing(event)
    case let .queueTakeBack(event):
      return applyQueueTakeBack(event)
    case let .inbox(event):
      applyInbox(event)
    }
    return []
  }

  /// Bit „ma notatkę" od serwera (snapshot): zmiana względem znanego to też sygnał dla modelu notatek.
  private mutating func noteServerBit(_ cwd: String, present: Bool) {
    if let known = notesPresent[cwd], known != present { notesRevision[cwd, default: 0] += 1 }
    notesPresent[cwd] = present
  }

  // MARK: - Ramki

  private mutating func applyFrame(
    _ frame: ServerEvent, source: FrameSource, cursor: String?, now: Date, timing: CoreTiming
  ) -> [CoreEffect] {
    if case let .session(id) = source, let cursor, transcripts[id] != nil {
      transcripts[id]?.cursor = cursor
    }
    if case .hello = frame {
      // Samo `hello` nie potwierdza starego obrazu listy po wznowieniu.
    } else if case .global = source, sessionsLoaded, !listStale {
      listCache.confirmedAt = now
    }
    switch frame {
    case let .hello(hello):
      // A new connection of the list: the server sends the closed folders again right after the full state.
      if case .global = source { clearMacFolders() }
      compat = Compatibility.evaluate(hello, build: clientBuild)
      serverStartId = hello.serverStartId

    case let .sessionsSnapshot(snapshot):
      // Pełny stan (np. po powrocie z tła) z innym gitem albo kontekstem unieważnia patch sesji —
      // `git-status` strumienia sesji może przyjść dopiero później.
      for session in snapshot.sessions where sessions[session.id].map({ session.repoDiffers(from: $0) }) ?? true {
        transcripts[session.id]?.repoRevision += 1
      }
      // Znak wodny przeżywa pełny stan, który cofa czas tego samego stanu; znika z sesją.
      let listed = Set(snapshot.sessions.map(\.id))
      for id in listed { raiseStateFloor(id) }
      stateFloors = stateFloors.filter { listed.contains($0.key) }
      // Pełny stan podmienia CAŁOŚĆ — także banery: brak pola gasi baner.
      sessions = Dictionary(snapshot.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
      noteListMemory(snapshot: listed)
      sessionsLoaded = true
      herdr = snapshot.herdrStatus
      notesEpoch += 1
      if let cwds = snapshot.notesCwds {
        let withNotes = Set(cwds.map(ProjectPath.normalized))
        for session in snapshot.sessions {
          let cwd = ProjectPath.normalized(session.cwd)
          noteServerBit(cwd, present: withNotes.contains(cwd))
        }
        for cwd in withNotes { noteServerBit(cwd, present: true) }
      } else {
        notesPresent.removeAll()
      }
      // Jedyne wyjście z listy nieświeżej i jedyna lista warta pamięci podręcznej.
      listCache.staleSince = nil
      listCache.confirmedAt = now
      listCache.awaitingTranscripts.formIntersection(snapshot.sessions.filter(\.showsTranscript).map(\.id))
      return [.persistListCache]

    case let .sessionChanged(changed):
      // Strumień sesji AKTUALIZUJE znaną kartę, ale NIGDY jej nie tworzy: spóźniona ramka po
      // snapshocie, który kartę zdjął, wskrzeszała ją jako martwą kartę.
      if case .session = source, sessions[changed.session.id] == nil { return [] }
      guard !isOlderStateChange(changed.session.id, state: changed.session.state, since: changed.session.stateSince) else { return [] }
      if sessions[changed.session.id].map({ changed.session.repoDiffers(from: $0) }) ?? true {
        transcripts[changed.session.id]?.repoRevision += 1
      }
      noteSignal(before: sessions[changed.session.id], after: changed.session)
      raiseStateFloor(changed.session.id)
      sessions[changed.session.id] = changed.session
      // Karta dostała terminal jako ekran (`termId` przyszedł po liście): transkryptu już nikt nie otworzy,
      // więc sesja z pamięci podręcznej nie ma na co czekać. Bramka nieświeżej listy zostaje osobno.
      if !changed.session.showsTranscript { listCache.awaitingTranscripts.remove(changed.session.id) }
      noteListMemory(changed.session.id)

    case let .transcriptSnapshot(snapshot):
      listCache.awaitingTranscripts.remove(snapshot.sessionId)
      return applyTranscriptSnapshot(snapshot, now: now, timing: timing)

    case let .message(event):
      return applyMessage(event, source: source, timing: timing)

    case let .delta(delta):
      ensureTranscript(delta.sessionId)
      // Nowa otwarta wiadomość po dołączeniu w trakcie tury mogła stracić początek (delty są ulotne,
      // bez replayu: `docs/implementation-spec.md`): akapit „…" mówi to wprost, zamiast udawać kompletny
      // tekst.
      let joined = transcripts[delta.sessionId]?.joinedMidTurn == true
      var open = transcripts[delta.sessionId]?.open
        ?? OpenAgentMessage(text: joined ? "…\n\n" : "", leadingGap: joined)
      open.text += delta.text
      open.gap = false
      transcripts[delta.sessionId]?.open = open
      transcripts[delta.sessionId]?.deltaSinceOpen = true
      // Kursor otwartej wiadomości przejmuje sygnał „coś się dzieje" — dwa naraz to szum.
      setActivity(delta.sessionId, nil, now: now)

    case let .activity(event):
      // Bez zakładania transkryptu: aktywność płynie kanałem globalnym dla WSZYSTKICH sesji,
      // a pusty transkrypt wypychałby z LRU te czytane.
      let activity = event.activity.kind == .idle ? nil : event.activity
      if transcripts[event.sessionId] != nil { setActivity(event.sessionId, activity, now: now) }
      sessions[event.sessionId]?.activity = activity
      if activity != nil { noteTurnEvent(event.sessionId, source: source) }
      // Delegacja zostaje w pamięci tury: następna `message` zeruje aktywność, linia listy nie.
      if sessions[event.sessionId] != nil { noteListMemory(event.sessionId) }

    case let .permissionPending(event):
      // Karta trafia tylko do istniejącego transkryptu; snapshot niesie pełne `pendingPermissions`.
      let request = event.request
      guard var view = transcripts[request.sessionId] else { return [] }
      if let index = view.pendingPermissions.firstIndex(where: { $0.permId == request.permId }) {
        // Karta kanału zgód ma stały `permId` (klucz hooka): nowa karta ZASTĘPUJE poprzednią w miejscu.
        // Powtórzona karta ekranowa zostaje, jak była.
        if request.isHookChannel { view.pendingPermissions[index] = request }
      } else {
        view.pendingPermissions.append(request)
      }
      transcripts[request.sessionId] = view

    case let .permissionSettled(event):
      settleCard(event)

    case let .permissionResolved(event):
      resolveCard(
        sessionId: event.sessionId, cardId: event.permId, kind: .permission,
        expired: event.decision == .expired || event.decision == .unsupported, by: event.by, now: now)

    case let .questionPending(event):
      let request = event.request
      guard var view = transcripts[request.sessionId] else { return [] }
      if !view.pendingQuestions.contains(where: { $0.qId == request.qId }) {
        view.pendingQuestions.append(request)
      }
      transcripts[request.sessionId] = view

    case let .questionResolved(event):
      resolveCard(sessionId: event.sessionId, cardId: event.qId, kind: .question, expired: false, by: nil, now: now)

    case let .state(event):
      guard !isOlderStateChange(event.sessionId, state: event.state, since: event.since) else { return [] }
      // Sesja, która przestała pracować, nie „myśli" dalej — także gdy karty jeszcze nie znamy.
      if event.state != .running, event.state != .starting {
        setActivity(event.sessionId, nil, now: now)
        // Koniec tury: następna wiadomość agenta zacznie się od początku, przy nas.
        transcripts[event.sessionId]?.joinedMidTurn = false
      }
      guard var session = sessions[event.sessionId] else { return [] }
      let before = session
      // Powtórzony stan to nie zdarzenie: nie zeruje „czeka od" i nie udaje aktywności.
      if event.state != session.state {
        session.stateSince = event.since
        session.lastActivityAt = event.since
      }
      session.state = event.state
      // Szczegół i jego kod to para: ramka bez `detail` gasi oba, tekst nie zostaje z cudzym `ref`.
      session.stateDetail = event.detail
      session.stateDetailRef = event.detailRef
      noteSignal(before: before, after: session)
      sessions[event.sessionId] = session
      noteListMemory(event.sessionId)

    case let .gitStatus(event):
      // Ramka niesie CAŁĄ prawdę o gicie, także jej brak (zniknięty upstream czyści ahead/behind,
      // ramka bez `fileDetails` gasi szczegóły plików z poprzedniej).
      ensureTranscript(event.sessionId)
      transcripts[event.sessionId]?.git = event
      transcripts[event.sessionId]?.repoRevision += 1
      if var session = sessions[event.sessionId] {
        session.branch = event.branch
        session.dirtyCount = event.dirtyCount
        session.ahead = event.ahead
        session.behind = event.behind
        session.fileKinds = event.fileKinds
        session.lastCommit = event.lastCommit
        sessions[event.sessionId] = session
      }

    case let .usage(event):
      sessions[event.sessionId]?.usage = SessionUsage(contextTokens: event.contextTokens, contextLimit: event.contextLimit)
      transcripts[event.sessionId]?.repoRevision += 1

    case let .herdrStatus(event):
      // Ramka węższa od stanu startowego: brak `canLaunch` = „nie wiem" → ostatnia znana wartość,
      // a bez niej `false` (fail-closed); `version`/`protocol` zostają z ramki startowej.
      herdr = HerdrStatus.merged(previous: herdr, event: event)

    case let .notes(event):
      let cwd = ProjectPath.normalized(event.cwd)
      notesPresent[cwd] = !event.empty
      notesRevision[cwd, default: 0] += 1

    case .inboxHeads, .inboxHead, .inboxRemoved:
      applyInboxFrame(frame, source: source)

    case let .folderAccess(event):
      applyFolderAccess(event)
    }
    return []
  }

  /// Globalne SSE i replay sesji nie mają wspólnej kolejności. Starsze przejście nie cofa
  /// karty ani nie gasi aktywności nowszej tury. Porównujemy tylko ZMIANĘ stanu: import
  /// historii na serwerze celowo koryguje stateSince tego samego stanu wstecz do czasu z jsonl.
  /// Miarą jest znak wodny (``stateFloors``), nie bieżący `stateSince`: replay przez dwie tury
  /// najpierw cofa zegar tego samego stanu, a dopiero potem niesie starsze przejście.
  private func isOlderStateChange(_ id: String, state incoming: SessionState, since: String) -> Bool {
    guard let known = sessions[id], incoming != known.state, let incomingAt = ISOTime.parse(since),
      let floor = [ISOTime.parse(known.stateSince), stateFloors[id]].compactMap({ $0 }).max()
    else { return false }
    return incomingAt < floor
  }

  /// Podnosi znak wodny sesji do jej bieżącego `stateSince` — przed podmianą podsumowania.
  private mutating func raiseStateFloor(_ id: String) {
    guard let since = sessions[id].flatMap({ ISOTime.parse($0.stateSince) }) else { return }
    stateFloors[id] = max(stateFloors[id] ?? since, since)
  }

  private mutating func applyTranscriptSnapshot(
    _ snapshot: TranscriptSnapshotEvent, now: Date, timing: CoreTiming
  ) -> [CoreEffect] {
    ensureTranscript(snapshot.sessionId)
    guard var view = transcripts[snapshot.sessionId] else { return [] }
    let before = view.messages
    view.messages = snapshot.messages.sorted { $0.seq < $1.seq }
    view.messagesEpoch = serverStartId
    view.snapshots += 1
    // Delty są ulotne — po pełnym stanie otwarta wiadomość zaczyna się od nowa. Pełny
    // stan = dołączamy do strumienia: przy pracującej sesji pierwsza delta bywa środkiem wiadomości.
    view.open = nil
    view.joinedMidTurn = sessions[snapshot.sessionId].map { $0.state == .running || $0.state == .starting } ?? false
    view.deltaSinceOpen = false
    // Pełny stan niesie też BRAK aktywności: pole nieobecne = agent nic nie robi.
    view.activity = snapshot.activity
    view.activityAt = snapshot.activity == nil ? nil : now
    view.pendingPermissions = snapshot.pendingPermissions
    view.pendingQuestions = snapshot.pendingQuestions
    let live = { (id: String) in
      snapshot.pendingPermissions.contains { $0.permId == id } || snapshot.pendingQuestions.contains { $0.qId == id }
    }
    // Karta kanału po przyjętej decyzji, której zdjęcia strumień nie doniósł (zgubiona ramka): ślad jak przy zdjęciu.
    for (id, attempt) in view.decisions where attempt.accepted && !live(id) {
      view.recordHookTrace(id)
    }
    view.decisions = view.decisions.filter { id, _ in live(id) }
    view.releases = view.releases.filter { id, _ in snapshot.pendingPermissions.contains { $0.permId == id } }
    transcripts[snapshot.sessionId] = view
    // Pogodzenie: gasi WYŁĄCZNIE wiadomość, której wcześniej nie było (nie archiwalne „ok").
    var known = Set(before.filter { $0.role == .user }.map(EchoMatching.identity))
    var effects: [CoreEffect] = []
    for message in view.messages where message.role == .user {
      let identity = EchoMatching.identity(message)
      guard known.insert(identity).inserted else { continue }
      effects += reconcileEcho(sessionId: snapshot.sessionId, message: message, timing: timing)
    }
    return effects
  }

  private mutating func applyMessage(_ event: MessageEvent, source: FrameSource, timing: CoreTiming) -> [CoreEffect] {
    ensureTranscript(event.sessionId)
    guard var view = transcripts[event.sessionId] else { return [] }
    let fresh = Self.upsert(event.message, into: &view.messages)
    // Domknięta wiadomość AGENTA zastępuje strumień — tylko agenta: wtrącenie systemowe w środku
    // tury nie kasuje płynącego akapitu.
    if event.message.role == .assistant {
      // Zastąpiła częściową wiadomość widzianą na żywo — następna zaczyna się od początku. Powtórka
      // starszych wiadomości z bufora (przed pierwszą deltą) znacznika nie zdejmuje.
      if view.open != nil, view.deltaSinceOpen { view.joinedMidTurn = false }
      view.open = nil
    }
    // Treść jest zawsze mocniejsza od „pracuje…".
    view.activity = nil
    view.activityAt = nil
    transcripts[event.sessionId] = view
    // Serwer zeruje aktywność karty BEZ `session-changed` — lista nie może trzymać starej.
    sessions[event.sessionId]?.activity = nil
    if fresh { noteTurnEvent(event.sessionId, source: source) }
    // Replay tej samej ramki nie gasi drugiego wpisu.
    return fresh ? reconcileEcho(sessionId: event.sessionId, message: event.message, timing: timing) : []
  }

  /// Wstawia wiadomość po `seq` bez duplikatów. `true` = treść świeża: nowa albo inna pod tym
  /// samym numerem (restart serwera przebudowuje wiadomość, powtórka niczego nie zmienia).
  static func upsert(_ message: TranscriptMessage, into messages: inout [TranscriptMessage]) -> Bool {
    if let index = messages.firstIndex(where: { $0.seq == message.seq }) {
      let before = messages[index]
      messages[index] = message
      return before != message
    }
    if let after = messages.firstIndex(where: { $0.seq > message.seq }) {
      messages.insert(message, at: after)
    } else {
      messages.append(message)
    }
    let over = messages.count - CoreLimits.maxTranscriptMessages
    if over > 0 { messages.removeFirst(over) }
    return true
  }

  // MARK: - Karty decyzji

  private mutating func resolveCard(
    sessionId: String, cardId: String, kind: CardNotice.Kind, expired: Bool, by: String?, now: Date
  ) {
    guard var view = transcripts[sessionId] else { return }
    let existed = Self.removeCard(cardId, kind: kind, from: &view)
    let attempt = view.decisions.removeValue(forKey: cardId)
    let decided = attempt != nil
    // Karta kanału po NASZEJ przyjętej decyzji zostawia ślad „wysłana”, nie „wygasła”.
    if attempt?.accepted == true { view.recordHookTrace(cardId) }
    let released = kind == .permission && view.releases.removeValue(forKey: cardId) != nil
    let ours = decided || released
    transcripts[sessionId] = view
    guard existed, !ours else { return }
    // Karta zdjęta nie z naszej decyzji zostawia ślad z powodem.
    let reason: CardNotice.Reason = expired ? .expired : .resolvedElsewhere(by: by)
    notices.append(CardNotice(cardId: cardId, sessionId: sessionId, kind: kind, reason: reason, at: now))
  }

  private mutating func finishDecision(
    sessionId: String, cardId: String, kind: CardNotice.Kind, result: DecisionResultKind, now: Date
  ) {
    guard var view = transcripts[sessionId] else { return }
    // Ślad własnej decyzji dopiero po przyjęciu (200), jak „Wysłano” na karcie; inny wynik kasuje szkic.
    let draft = view.traceDrafts.removeValue(forKey: cardId)
    switch result {
    case .accepted:
      // Przyjęcie zapisuje się tylko na istniejącym wpisie: strumień mógł już zdjąć kartę (`*-resolved` przed 200),
      // a wtedy wpis nie wraca.
      view.decisions[cardId]?.accepted = true
      if let draft {
        // Karta kanału, która jeszcze stoi, mówi „wysłana” stopką; ślad staje, gdy zniknie (`resolveCard`).
        let standing = kind == .permission && view.pendingPermissions.contains { $0.permId == cardId }
        if draft.hookChannel && standing {
          view.traceDrafts[cardId] = draft
        } else {
          view.record(draft)
        }
      }
      transcripts[sessionId] = view
      // Karta znika dopiero, gdy serwer zgłosi rozstrzygnięcie (`*-resolved`).
      return
    case .keep:
      view.decisions.removeValue(forKey: cardId)
      transcripts[sessionId] = view
    case .conflict where kind == .permission
      && view.pendingPermissions.contains(where: { $0.permId == cardId && $0.isHookChannel }):
      // Karta kanału zgód po 409 `conflict` zostaje: decyzja z innego urządzenia idzie dalej strumieniem
      // (`permission-settled`), a póki hook czeka, wolno ją jeszcze zwolnić do terminala. Kartę zdejmuje
      // `permission-resolved` albo 410; zdanie „decyzja zapadła na innym urządzeniu” stoi pod kartą (RarogUI).
      view.decisions.removeValue(forKey: cardId)
      transcripts[sessionId] = view
    case .conflict, .gone:
      view.decisions.removeValue(forKey: cardId)
      let existed = Self.removeCard(cardId, kind: kind, from: &view)
      transcripts[sessionId] = view
      // Ślad zostaje także wtedy, gdy strumień zdjął kartę, zanim wróciła odpowiedź: `resolveCard`
      // uznał wtedy rozstrzygnięcie za nasze i śladu nie zostawił, a karta trzymana potwierdzeniem
      // znika z wynikiem. Taka karta zostawia ślad tylko w sesji, która wciąż jest na liście
      // (zamknięta nie dostaje „wygasło"). Jeden ślad na kartę — wiersz śladu ma jej identyfikator.
      let traced = notices.contains { $0.sessionId == sessionId && $0.cardId == cardId }
      guard !traced, existed || sessions[sessionId] != nil else { return }
      let reason: CardNotice.Reason = result == .conflict ? .alreadyDecided : .expired
      notices.append(CardNotice(cardId: cardId, sessionId: sessionId, kind: kind, reason: reason, at: now))
    }
  }

  /// `permission-settled`: stan, przyciski i powód karty kanału W MIEJSCU. Bez karty o tym `permId` nic (spóźniona
  /// zmiana nie przywraca zdjętej karty). Karta w stanie końcowym nie wraca do stanu niekońcowego, a po `unknown`
  /// przyjmuje tylko stan końcowy (spóźniony dowód skutku).
  private mutating func settleCard(_ event: PermissionSettledEvent) {
    guard var view = transcripts[event.sessionId],
      let index = view.pendingPermissions.firstIndex(where: { $0.permId == event.permId && $0.isHookChannel })
    else { return }
    let current = view.pendingPermissions[index].state
    if let current, current.closesCard || current == .unknown, !event.state.closesCard { return }
    view.pendingPermissions[index].settle(event)
    transcripts[event.sessionId] = view
  }

  /// Koniec zwolnienia do terminala: 200 i odmowa zostawiają kartę (stan przyjdzie strumieniem), 410 ją zdejmuje
  /// ze śladem „wygasła”. Przyjęte zwolnienie zostaje w `releases` jak przyjęta decyzja w `decisions`, aż serwer
  /// zdejmie kartę: zdjęcie (`expired`) przed odpowiedzią i po niej jest wtedy tak samo nasze, bez śladu „wygasła”.
  /// Wpis decyzji (`decisions`) tej karty zostaje nietknięty.
  private mutating func finishRelease(sessionId: String, permId: String, result: DecisionResultKind, now: Date) {
    guard var view = transcripts[sessionId] else { return }
    switch result {
    case .accepted:
      return
    case .keep, .conflict:
      view.releases.removeValue(forKey: permId)
      transcripts[sessionId] = view
    case .gone:
      view.releases.removeValue(forKey: permId)
      let existed = Self.removeCard(permId, kind: .permission, from: &view)
      view.decisions.removeValue(forKey: permId)
      transcripts[sessionId] = view
      let traced = notices.contains { $0.sessionId == sessionId && $0.cardId == permId }
      guard !traced, existed || sessions[sessionId] != nil else { return }
      notices.append(CardNotice(cardId: permId, sessionId: sessionId, kind: .permission, reason: .expired, at: now))
    }
  }

  private static func removeCard(_ cardId: String, kind: CardNotice.Kind, from view: inout TranscriptState) -> Bool {
    switch kind {
    case .permission:
      let before = view.pendingPermissions.count
      view.pendingPermissions.removeAll { $0.permId == cardId }
      return view.pendingPermissions.count != before
    case .question:
      let before = view.pendingQuestions.count
      view.pendingQuestions.removeAll { $0.qId == cardId }
      return view.pendingQuestions.count != before
    }
  }

  // MARK: - Pomocnicze

  private mutating func setStatus(_ scope: StreamScope, _ status: ConnectionStatus) {
    switch scope {
    case .global:
      global = status
      // Każda zmiana strumienia listy (łączę, otwarty, zerwany, zatrzymany w tle) czeka na nowy pełny stan.
      push.listConfirmed = false
    case .session: sessionStream = status
    }
  }

  /// Po ponownym połączeniu z ważnym kursorem brakujące delty nie wrócą (delty są ulotne, bez replayu:
  /// `docs/implementation-spec.md`): otwarta wiadomość dostaje „…" i czeka na domkniętą `message`.
  private mutating func markGap(sessionId: String) {
    guard var open = transcripts[sessionId]?.open, !open.text.isEmpty, !open.gap else { return }
    open.text += "…"
    open.gap = true
    transcripts[sessionId]?.open = open
  }

  /// Strumień sesji otwarty (pierwszy raz albo po zerwaniu): przy pracującej sesji pierwsza
  /// otwarta wiadomość mogła się zacząć, zanim słuchaliśmy.
  private mutating func markJoin(sessionId: String) {
    guard transcripts[sessionId] != nil else { return }
    let working = sessions[sessionId].map { $0.state == .running || $0.state == .starting } ?? false
    transcripts[sessionId]?.joinedMidTurn = working
    transcripts[sessionId]?.deltaSinceOpen = false
  }

  private mutating func setActivity(_ sessionId: String, _ activity: Activity?, now: Date) {
    guard transcripts[sessionId] != nil else { return }
    transcripts[sessionId]?.activity = activity
    transcripts[sessionId]?.activityAt = activity == nil ? nil : now
  }

  /// Zakłada transkrypt (jeśli go nie ma) i przesuwa go na czoło LRU; oglądany jest nietykalny.
  private mutating func ensureTranscript(_ sessionId: String) {
    if transcripts[sessionId] == nil { transcripts[sessionId] = TranscriptState() }
    touchTranscript(sessionId)
    while transcriptOrder.count > CoreLimits.maxTranscripts,
      let victim = transcriptOrder.last(where: { $0 != viewedSessionId && $0 != sessionId })
    {
      transcriptOrder.removeAll { $0 == victim }
      transcripts[victim] = nil
    }
  }

  private mutating func touchTranscript(_ sessionId: String) {
    transcriptOrder.removeAll { $0 == sessionId }
    transcriptOrder.insert(sessionId, at: 0)
  }

  private mutating func resetView() {
    sessions = [:]
    globalList = [:]
    sessionsLoaded = false
    herdr = nil
    notesPresent = [:]
    notesRevision = [:]
    transcripts = [:]
    transcriptOrder = []
    notices = []
    compat = .unknown
    serverStartId = nil
    global = .idle
    sessionStream = .idle
    resetServerInfo()
    catalog = CatalogState()
    cards = CardsState()
    resetTurnControl()
    queueTakeBack = QueueTakeBackState()
    clearInbox()
    listCache = ListCacheState()
    terminals = TerminalListState()
    signal = nil
    stateFloors = [:]
    turnStage = [:]
    heldUnread = [:]
    heldOpen = [:]
    queuedIdleSince = [:]
    commands = CommandListState()
    clearMacFolders()
    resetPushView()
  }
}

extension SessionSummary {
  /// Podsumowanie opisuje inny stan repozytorium niż `previous`: metadane gita (gałąź, licznik, rozjazd
  /// z upstreamem, rodzaje plików, ostatni commit) albo kontekst (praca agenta w sesji bez ramek `usage`).
  /// Taka zmiana podbija `TranscriptState.repoRevision` — patch sprzed niej nie opisuje repozytorium.
  func repoDiffers(from previous: SessionSummary) -> Bool {
    branch != previous.branch || dirtyCount != previous.dirtyCount || ahead != previous.ahead
      || behind != previous.behind || fileKinds != previous.fileKinds || lastCommit != previous.lastCommit
      || context != previous.context
  }
}

extension HerdrStatus {
  /// Stan po ramce `herdr-status` (węższej od stanu startowego).
  static func merged(previous: HerdrStatus?, event: HerdrStatusEvent) -> HerdrStatus {
    HerdrStatus(
      available: event.available,
      agentCount: event.agentCount,
      readOnly: event.readOnly,
      canLaunch: event.canLaunch ?? previous?.canLaunch ?? false,
      version: previous?.version,
      protocol: previous?.protocol,
      detail: event.detail,
      detailRef: event.detailRef
    )
  }
}

extension ConsentCardState {
  /// Stan, po którym karta kanału czeka już tylko na zdjęcie (`permission-resolved`): bez decyzji i zwolnienia.
  var closesCard: Bool {
    switch self {
    case .applied, .settledAtDesk, .revoked, .released: true
    case .pending, .sent, .claimed, .running, .unknown, .unsupported: false
    }
  }
}
