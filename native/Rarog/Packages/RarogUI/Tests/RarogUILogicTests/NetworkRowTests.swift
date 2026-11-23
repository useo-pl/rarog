import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Wiersz listy bez kontaktu ze źródłem. Właściciel: łączność.

@Suite("wiersz bez kontaktu ze źródłem")
struct NetworkRowTests {
  @Test("sesja `stale`: wygaszona, zegar stoi na chwili zamrożenia, bez linii etapu i „na co czeka”")
  func frozenRow() {
    let working = SessionRowModel(
      Sample.session(extra: #""stale":true,"activity":{"kind":"tool","toolName":"Read","summary":"a.ts"}"#), ordinal: nil)
    #expect(working.frozen && working.stage == nil && working.progress == nil && !working.backgroundDot)
    let waiting = SessionRowModel(Sample.session(
      state: "waiting-permission", extra: #""stale":true,"waitingFor":{"kind":"permission","tool":"Shell","text":"npm test"}"#),
      ordinal: nil)
    #expect(waiting.frozen && waiting.waiting == nil, "dialog mógł zostać odklikany przy biurku")
    #expect(!waiting.quiet, "nieświeże wygrywa z wyciszeniem")

    let frozenAt = Sample.now
    let later = Sample.now.addingTimeInterval(300)
    #expect(working.clockNow(later, frozenAt: frozenAt) == frozenAt)
    #expect(working.clock(now: working.clockNow(later, frozenAt: frozenAt)) == working.clock(now: frozenAt))
  }

  @Test("żywa sesja: zegar liczy od teraz, niezależnie od zapamiętanej chwili")
  func liveRow() {
    let row = SessionRowModel(Sample.session(), ordinal: nil)
    let later = Sample.now.addingTimeInterval(300)
    #expect(!row.frozen && row.clockNow(later, frozenAt: Sample.now) == later)
  }
}

@Suite("lista z pamięci podręcznej: zero akcji")
struct CachedListTests {
  private func cached(_ session: SessionSummary) -> AppState {
    var state = Sample.state(session: session)
    state.listCache.staleSince = Sample.now
    return state
  }

  @Test("wiersze zamrożone jak bez kontaktu z herdr; czytnik słyszy, że to stan sprzed połączenia")
  func rows() throws {
    let state = cached(Sample.session(extra: #""activity":{"kind":"tool","toolName":"Read","summary":"a.ts"}"#))
    let row = try #require(state.sessionRows.first)
    #expect(row.frozen && row.cached && !row.stale && row.stage == nil)
    #expect(row.spoken(now: Sample.now).hasSuffix(UICopy.cachedRowSpoken))
  }

  @Test("pole wygaszone z powodem, karta stanu bez akcji nie staje; świeża lista oddaje oba")
  func composerAndStateCard() {
    var state = cached(Sample.session(state: "limit-reached"))
    #expect(ComposerModel.make(state: state, sessionId: "s1") == ComposerModel(editable: false, reason: UICopy.staleComposer))
    #expect(StateCards.make(state: state, sessionId: "s1") == nil)
    state.listCache = ListCacheState()
    #expect(StateCards.make(state: state, sessionId: "s1") != nil)
    var working = cached(Sample.session(state: "waiting-input"))
    #expect(!ComposerModel.make(state: working, sessionId: "s1").editable)
    working.listCache = ListCacheState()
    #expect(ComposerModel.make(state: working, sessionId: "s1").editable)
  }

  @Test("„×” z Cmd+X i z nagłówka nie uzbraja się na liście z pamięci")
  @MainActor
  func closeUnavailable() {
    let state = cached(Sample.session(state: "waiting-input"))
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.requestClose("s1", state: state, now: Sample.now) == .unavailable)
  }
}

@Suite("banery w dwóch kolumnach")
struct BannerSlotsTests {
  private let herdrDown = HerdrStatus(available: false, agentCount: 0, readOnly: false, canLaunch: false, detail: "gniazdo milczy")

  private func failed() -> ConnectionMemory {
    var memory = ConnectionMemory()
    memory.observe(.connecting(since: Sample.now.addingTimeInterval(-5)), now: Sample.now.addingTimeInterval(-5))
    memory.observe(.offline(since: Sample.now), now: Sample.now)
    return memory
  }

  private func state() -> AppState {
    var state = Sample.state(session: Sample.session(extra: #""stale":true"#))
    state.sessions["s2"] = Sample.session(id: "s2", extra: #""stale":true"#, stateAgo: 600)
    state.herdr = herdrDown
    state.apply(.push(.status(enabled: true, degradedSince: Sample.iso(900))), now: Sample.now)
    state.viewedSessionId = "s1"
    return state
  }

  @Test("kolejność: niezgodność, brak serwera, transkrypt, herdr, pushe; globalne w jednej kolumnie naraz")
  func order() {
    var state = state()
    state.compat = .tooOld(minClientBuild: 9)
    let live = ConnectionMemory()
    let list = state.banners(in: .list, global: live, transcript: failed())
    #expect(list == [
      .incompatible(.tooOld(minClientBuild: 9)),
      .herdrUnavailable(detail: "gniazdo milczy", staleSince: Sample.iso(30)),
      .pushDegraded(since: Sample.iso(900)),
    ], "lista nie mówi o transkrypcie")
    let beside = state.banners(in: .detail(sessionId: "s1", listVisible: true), global: live, transcript: failed())
    #expect(beside == [.transcriptStalled], "przy widocznej liście prawa kolumna nie powtarza globalnych")
    let alone = state.banners(in: .detail(sessionId: "s1", listVisible: false), global: live, transcript: failed())
    #expect(alone == [.incompatible(.tooOld(minClientBuild: 9)), .transcriptStalled] + list.dropFirst())
  }

  @Test("baner powiadomień z przyczyną stoi w tym samym miejscu kolumny globalnej")
  func orderWithReason() {
    var state = state()
    state.apply(.push(.status(enabled: true, degradedSince: Sample.iso(900), reason: .envMismatch)), now: Sample.now)
    #expect(state.banners(in: .list, global: ConnectionMemory(), transcript: failed()) == [
      .herdrUnavailable(detail: "gniazdo milczy", staleSince: Sample.iso(30)),
      .pushDegraded(since: Sample.iso(900), reason: .envMismatch),
    ])
    #expect(state.banners(in: .detail(sessionId: "s1", listVisible: true), global: ConnectionMemory(), transcript: failed())
      == [.transcriptStalled])
  }

  @Test("jedna awaria = jeden baner: przy braku serwera milczą herdr, pushe i transkrypt")
  func serverDown() {
    var state = state()
    state.global = .offline(since: Sample.now)
    let alone = state.banners(in: .detail(sessionId: "s1", listVisible: false), global: failed(), transcript: failed())
    #expect(alone == [.serverUnreachable])
    #expect(state.banners(in: .detail(sessionId: "s1", listVisible: true), global: failed(), transcript: failed()).isEmpty)
  }

  @Test("transkrypt: tylko oglądana sesja, tylko po nieudanej próbie, bez mrugania w trakcie próby")
  func transcript() {
    let state = state()
    var link = failed()
    link.observe(.connecting(since: Sample.now.addingTimeInterval(1)), now: Sample.now.addingTimeInterval(1))
    #expect(state.banners(in: .detail(sessionId: "s1", listVisible: true), global: ConnectionMemory(), transcript: link)
      == [.transcriptStalled], "próba w toku nie gasi baneru")
    #expect(state.banners(in: .detail(sessionId: "s2", listVisible: true), global: ConnectionMemory(), transcript: link).isEmpty)
    #expect(state.banners(in: .detail(sessionId: nil, listVisible: true), global: ConnectionMemory(), transcript: link).isEmpty)
  }

  @Test("karta łączenia: w kolumnie czerwonego baneru, w jego miejscu; po porażce jedna karta, czerwona")
  func connectingCard() {
    var state = state()
    state.compat = .tooOld(minClientBuild: 9)
    state.global = .connecting(since: Sample.now)
    var link = ConnectionMemory()
    link.observe(.online, now: Sample.now)
    link.observe(.connecting(since: Sample.now), now: Sample.now)
    let card = Banner.connecting(visibleFrom: Sample.now)
    let list = state.banners(in: .list, global: link, transcript: ConnectionMemory())
    #expect(Array(list.prefix(2)) == [.incompatible(.tooOld(minClientBuild: 9)), card], "miejsce brakującego serwera")
    #expect(state.banners(in: .detail(sessionId: "s1", listVisible: false), global: link, transcript: ConnectionMemory())
      .contains(card), "lista schowana (telefon, Cmd+B): karta w kolumnie sesji")
    #expect(!state.banners(in: .detail(sessionId: "s1", listVisible: true), global: link, transcript: ConnectionMemory())
      .contains(card), "przy widocznej liście prawa kolumna nie powtarza")
    link.observe(.offline(since: Sample.now.addingTimeInterval(3.5)), now: Sample.now.addingTimeInterval(3.5))
    state.global = .offline(since: Sample.now.addingTimeInterval(3.5))
    #expect(state.banners(in: .list, global: link, transcript: ConnectionMemory())
      == [.incompatible(.tooOld(minClientBuild: 9)), .serverUnreachable], "jedna karta, nie dwie")
    link.observe(.online, now: Sample.now.addingTimeInterval(4))
    state.global = .online
    #expect(!state.banners(in: .list, global: link, transcript: ConnectionMemory()).contains { (banner: Banner) in
      if case .connecting = banner { true } else { banner == .serverUnreachable }
    }, "połączono: karty nie ma")
  }

  @Test("connecting card at start: not before its moment; a tunnel rebuilt in 1.4 s shows no card")
  func connectingCardDue() {
    let t0 = Sample.now
    var state = state()
    state.global = .connecting(since: t0)
    var link = ConnectionMemory()
    link.observe(.connecting(since: t0), now: t0)
    let banners = state.banners(in: .list, global: link, transcript: ConnectionMemory())
    #expect(!banners.visible(at: t0.addingTimeInterval(1.4)).contains(where: isConnecting))
    #expect(!banners.visible(at: t0.addingTimeInterval(2.9)).contains(where: isConnecting))
    #expect(banners.visible(at: t0.addingTimeInterval(3)).first == .connecting(visibleFrom: t0.addingTimeInterval(3)))
    #expect(banners.pendingUntil(t0.addingTimeInterval(1.4)) == t0.addingTimeInterval(3))
    #expect(banners.pendingUntil(t0.addingTimeInterval(3)) == nil)
    link.observe(.online, now: t0.addingTimeInterval(1.4))
    let after = state.banners(in: .list, global: link, transcript: ConnectionMemory())
    #expect(!after.contains { (banner: Banner) in if case .connecting = banner { true } else { false } })
  }

  // MARK: - Connection card from the viewed session's stream

  private func isConnecting(_ banner: Banner) -> Bool {
    if case .connecting = banner { true } else { false }
  }

  private func onlineGlobal(at moment: Date) -> ConnectionMemory {
    var memory = ConnectionMemory()
    memory.observe(.connecting(since: moment), now: moment)
    memory.observe(.online, now: moment)
    return memory
  }

  /// The viewed session's stream memory after the given statuses, all observed for `s1`.
  private func sessionLink(_ steps: [(ConnectionStatus, TimeInterval)], sessionId: String = "s1") -> TranscriptConnectionMemory {
    var link = TranscriptConnectionMemory()
    link.observe(.idle, sessionId: sessionId, now: Sample.now)
    for (status, at) in steps { link.observe(status, sessionId: sessionId, now: Sample.now.addingTimeInterval(at)) }
    return link
  }

  @Test("session stream connecting with the global stream online: no card at 2.5 s, the gray card at 3.2 s")
  func sessionStreamCard() {
    let t0 = Sample.now
    let state = state()
    let global = onlineGlobal(at: t0.addingTimeInterval(-60))
    let link = sessionLink([(.connecting(since: t0), 0)]).connection(for: "s1")
    let list = state.banners(in: .list, global: global, transcript: link)
    #expect(!list.visible(at: t0.addingTimeInterval(2.5)).contains(where: isConnecting))
    #expect(list.visible(at: t0.addingTimeInterval(3.2)).first == .connecting(visibleFrom: t0.addingTimeInterval(3)))
    #expect(list.pendingUntil(t0.addingTimeInterval(2.5)) == t0.addingTimeInterval(3), "the strip wakes up by itself")
    let alone = state.banners(in: .detail(sessionId: "s1", listVisible: false), global: global, transcript: link)
    #expect(alone.first == .connecting(visibleFrom: t0.addingTimeInterval(3)), "hidden list: the card in the session column")
    let beside = state.banners(in: .detail(sessionId: "s1", listVisible: true), global: global, transcript: link)
    #expect(!beside.contains(where: isConnecting), "the visible list carries it, the session column does not repeat it")
  }

  @Test("the 3 s count starts at the later moment: global online at 0.8 s, session connecting from 0 → the card from 3.8 s")
  func sessionStreamCardWaitsForGlobal() {
    let t0 = Sample.now
    let state = state()
    var global = ConnectionMemory()
    global.observe(.connecting(since: t0), now: t0)
    global.observe(.online, now: t0.addingTimeInterval(0.8))
    let link = sessionLink([(.connecting(since: t0), 0)]).connection(for: "s1")
    let list = state.banners(in: .list, global: global, transcript: link)
    #expect(!list.visible(at: t0.addingTimeInterval(3.7)).contains(where: isConnecting))
    #expect(list.visible(at: t0.addingTimeInterval(3.8)).first == .connecting(visibleFrom: t0.addingTimeInterval(3.8)))
  }

  @Test("idle session stream (no session, unknown session, terminal): no card")
  func idleSessionStream() {
    let state = state()
    let global = onlineGlobal(at: Sample.now.addingTimeInterval(-60))
    let link = sessionLink([(.connecting(since: Sample.now), 0), (.idle, 0.5)]).connection(for: "s1")
    let list = state.banners(in: .list, global: global, transcript: link)
    #expect(!list.visible(at: Sample.now.addingTimeInterval(10)).contains(where: isConnecting))
  }

  @Test("a failed session stream attempt or a dropped live stream: only the stalled transcript banner, no gray card")
  func failedSessionStream() {
    let t0 = Sample.now
    let state = state()
    let global = onlineGlobal(at: t0.addingTimeInterval(-60))
    let failedAttempt = sessionLink([(.connecting(since: t0), 0), (.offline(since: t0), 0.5), (.connecting(since: t0), 1)])
    let dropped = sessionLink([(.connecting(since: t0), 0), (.online, 0.2), (.offline(since: t0), 3), (.connecting(since: t0), 3.5)])
    for link in [failedAttempt, dropped] {
      let memory = link.connection(for: "s1")
      let alone = state.banners(in: .detail(sessionId: "s1", listVisible: false), global: global, transcript: memory)
        .visible(at: t0.addingTimeInterval(10))
      #expect(alone.contains(.transcriptStalled))
      #expect(!alone.contains(where: isConnecting), "one failure, one banner")
      #expect(!state.banners(in: .list, global: global, transcript: memory).contains(where: isConnecting))
    }
  }

  @Test("changing the session while the previous one is connecting starts the count from zero")
  func sessionChangeRestartsCount() {
    let t0 = Sample.now
    var state = state()
    let global = onlineGlobal(at: t0.addingTimeInterval(-60))
    var link = sessionLink([(.connecting(since: t0), 0)])
    // The status at the moment of the change still belongs to the previous session's stream.
    state.viewedSessionId = "s2"
    let switched = t0.addingTimeInterval(4)
    link.observe(.connecting(since: t0), sessionId: "s2", now: switched)
    #expect(!state.banners(in: .list, global: global, transcript: link.connection(for: "s2"))
      .visible(at: switched).contains(where: isConnecting), "no card carried over from the previous session")
    link.observe(.idle, sessionId: "s2", now: switched)
    link.observe(.connecting(since: switched), sessionId: "s2", now: switched)
    let list = state.banners(in: .list, global: global, transcript: link.connection(for: "s2"))
    #expect(!list.visible(at: switched.addingTimeInterval(2.5)).contains(where: isConnecting))
    #expect(list.visible(at: switched.addingTimeInterval(3)).first == .connecting(visibleFrom: switched.addingTimeInterval(3)))
  }

  @Test("the global stream fails while the session stream connects: one red card from the global stream")
  func globalFailureWins() {
    let t0 = Sample.now
    var state = state()
    var global = ConnectionMemory()
    global.observe(.connecting(since: t0), now: t0)
    global.observe(.offline(since: t0.addingTimeInterval(3.5)), now: t0.addingTimeInterval(3.5))
    state.global = .offline(since: t0.addingTimeInterval(3.5))
    let link = sessionLink([(.connecting(since: t0), 0)]).connection(for: "s1")
    let list = state.banners(in: .list, global: global, transcript: link).visible(at: t0.addingTimeInterval(10))
    #expect(list == [.serverUnreachable])
  }

  @Test("the scene back from the background as inactive keeps the streams stopped: the card after the start delay")
  func inactiveAfterBackground() {
    let t0 = Sample.now
    var state = state()
    state.global = .idle
    var global = onlineGlobal(at: t0.addingTimeInterval(-60))
    global.observe(.idle, now: t0.addingTimeInterval(-1))
    global.observeScene(.inactive, from: .background, stream: .idle, loggedIn: true, now: t0)
    let list = state.banners(in: .list, global: global, transcript: ConnectionMemory())
    #expect(!list.visible(at: t0.addingTimeInterval(1.4)).contains(where: isConnecting), "a tunnel rebuilt in 1.4 s does not flash")
    #expect(!list.visible(at: t0.addingTimeInterval(2.9)).contains(where: isConnecting))
    #expect(list.visible(at: t0.addingTimeInterval(3)).first == .connecting(visibleFrom: t0.addingTimeInterval(3)))
    // `active` resumes the streams: the card keeps its moment until the global stream is online.
    state.global = .connecting(since: t0.addingTimeInterval(5))
    global.observe(.connecting(since: t0.addingTimeInterval(5)), now: t0.addingTimeInterval(5))
    #expect(state.banners(in: .list, global: global, transcript: ConnectionMemory()).first
      == .connecting(visibleFrom: t0.addingTimeInterval(3)))
    // Back to the background: nothing waits.
    global.observeScene(.background, from: .inactive, stream: .idle, loggedIn: true, now: t0.addingTimeInterval(6))
    #expect(!state.banners(in: .list, global: global, transcript: ConnectionMemory()).contains(where: isConnecting))
    // Without a login no stream starts on `active`: nothing waits, so the first connection after pairing keeps its
    // start delay.
    var paired = ConnectionMemory()
    paired.observeScene(.inactive, from: .background, stream: .idle, loggedIn: false, now: t0)
    #expect(paired == ConnectionMemory())
    // `inactive` from `active` (Control Center), and any phase with a live stream (a second window), change nothing.
    var live = onlineGlobal(at: t0)
    live.observeScene(.inactive, from: .active, stream: .online, loggedIn: true, now: t0.addingTimeInterval(1))
    live.observeScene(.inactive, from: .background, stream: .online, loggedIn: true, now: t0.addingTimeInterval(2))
    live.observeScene(.background, from: .inactive, stream: .online, loggedIn: true, now: t0.addingTimeInterval(3))
    #expect(live == onlineGlobal(at: t0))
  }

  @Test("herdr: „stany sprzed X” z najświeższej sesji bez kontaktu; bez niej zdanie serwera")
  func herdrCopy() {
    #expect(state().herdrStaleSince == Sample.iso(30))
    let banner = Banner.herdrUnavailable(detail: "gniazdo milczy", staleSince: Sample.iso(240))
    #expect(UICopy.banner(banner, now: Sample.now) == "herdr niedostępny — stany sesji z terminala są sprzed 4\u{a0}min.")
    #expect(UICopy.banner(.herdrUnavailable(detail: nil, staleSince: nil))
      == "herdr niedostępny — stany sesji z terminala mogą być nieaktualne.")
    #expect(UICopy.banner(.herdrReadOnly(detail: nil)) == "herdr tylko do odczytu — panele widać, wysyłka nie działa.")
  }
}

@MainActor
@Suite("dymek o innej sesji i komunikaty apki")
struct ToastCenterTests {
  private func state() -> AppState {
    var state = Sample.state(session: Sample.session(id: "s1", state: "waiting-permission"))
    state.sessions["s2"] = Sample.session(id: "s2", title: "rarog", label: nil)
    return state
  }

  private func signal(_ sessionId: String, _ kind: SessionSignal.Kind, serial: Int = 1) -> SessionSignal {
    SessionSignal(sessionId: sessionId, kind: kind, serial: serial)
  }

  @Test("tylko gdy człowiek ogląda INNĄ sesję: słowo rodzaju w tonie i „projekt · sesja”")
  func onlyOtherSession() throws {
    let toasts = ToastCenter()
    toasts.offer(signal("s1", .permission), state: state(), viewing: nil)
    #expect(toasts.current == nil, "na liście dymek dublowałby kropkę")
    toasts.offer(signal("s1", .permission), state: state(), viewing: "s1")
    #expect(toasts.current == nil, "we własnej sesji stoi karta")
    toasts.offer(signal("s1", .permission), state: state(), viewing: "s2")
    let toast = try #require(toasts.current)
    #expect(toast.sessionId == "s1" && toast.kind == "Czeka na zgodę" && toast.place == "willow · zapis notatek")
    #expect(toast.text == "Czeka na zgodę · willow · zapis notatek" && toast.tone == .waiting)
    toasts.offer(signal("s2", .done, serial: 2), state: state(), viewing: "s1")
    #expect(toasts.current?.text == "Skończył · rarog" && toasts.current?.tone == .unread, "jeden dymek naraz, nowy wypiera")
    toasts.offer(signal("zniknęła", .error, serial: 3), state: state(), viewing: "s1")
    #expect(toasts.current?.sessionId == "s2", "sesji spoza listy nie ma dokąd otworzyć")
  }

  @Test("gaśnie, gdy człowiek dojdzie do sesji; upływ czasu starego nie zdejmuje nowszego")
  func dismissal() throws {
    let toasts = ToastCenter()
    toasts.offer(signal("s1", .error), state: state(), viewing: "s2")
    let first = try #require(toasts.current)
    toasts.reached("s2")
    #expect(toasts.current == first)
    toasts.reached("s1")
    #expect(toasts.current == nil)
    toasts.offer(signal("s1", .limit, serial: 2), state: state(), viewing: "s2")
    let older = try #require(toasts.current)
    toasts.notice("Powiadomienia włączone")
    toasts.dismiss(older.id)
    #expect(toasts.current?.text == "Powiadomienia włączone" && toasts.current?.sessionId == nil)
    #expect(toasts.current?.kind == nil && toasts.current?.tone == nil, "komunikat apki bez tonu i bez akcji")
    toasts.notice("   ")
    #expect(toasts.current?.text == "Powiadomienia włączone", "puste zdanie niczego nie wypiera")
  }

  @Test("potwierdzenie wypiera tylko komunikat bez akcji i inne potwierdzenie; dymek o sesji i dymek z akcją zostają")
  func confirmationYields() throws {
    let toasts = ToastCenter()
    toasts.notice("Powiadomienia włączone")
    toasts.notice("Skopiowano do schowka.", hold: 2)
    #expect(toasts.current?.text == "Skopiowano do schowka." && toasts.current?.style == .confirmation)
    let first = try #require(toasts.current)
    toasts.notice("Skopiowano do schowka.", hold: 2)
    #expect(toasts.current != first && toasts.current?.style == .confirmation, "druga kopia to nowy dymek")
    toasts.offer(signal("s1", .permission), state: state(), viewing: "s2")
    let session = try #require(toasts.current)
    toasts.notice("Skopiowano do schowka.", hold: 2)
    #expect(toasts.current == session, "dymek o sesji nie ustępuje potwierdzeniu")
    toasts.reached("s1")
    toasts.notice("Usunięto notatkę", action: ToastAction(label: "Cofnij", identifier: "toast.note.undo")) {}
    let undo = try #require(toasts.current)
    toasts.notice("Skopiowano do schowka.", hold: 2)
    #expect(toasts.current == undo, "„Cofnij” nie przepada przez kopię")
    toasts.notice("   ", hold: 2)
    #expect(toasts.current == undo, "puste zdanie niczego nie wypiera")
  }
}

@Suite("linie śladów diagnostyki: fakty, bez treści")
struct DiagnosticsTraceLineTests {
  @Test("pasek skrótów: wymiary prowadnicy i układ ekranu sesji od krawędzi okna")
  func shortcutBar() {
    let rest = DiagnosticsTrace.ShortcutBarLayout(screenShort: 0, safeBottom: 25, fieldGap: 12)
    #expect(DiagnosticsTrace.shortcutBar(height: 71, width: 1408, layout: rest)
      == "pasek skrótów 71×1408 pt: nakładka nad polem; ekran 0 pt nad krawędzią okna, wstawka 25 pt, "
      + "pole 12 pt nad krawędzią")
    // Regresja: ekran kończył się nad pasem wskaźnika home i pole podjeżdżało o 21 pt.
    let lifted = DiagnosticsTrace.ShortcutBarLayout(screenShort: 25, safeBottom: 0, fieldGap: 33)
    #expect(DiagnosticsTrace.shortcutBar(height: 71, width: 1408, layout: lifted)
      == "pasek skrótów 71×1408 pt: nakładka nad polem; ekran 25 pt nad krawędzią okna, wstawka 0 pt, "
      + "pole 33 pt nad krawędzią")
  }

  @Test("powrót do apki: czas w tle, kto trzyma klawiaturę, czy jest sprzętowa")
  func resume() {
    #expect(DiagnosticsTrace.resume(awaySeconds: 42, responder: .field, hardwareKeyboard: true)
      == "powrót do apki po 42 s: klawiatura=pole, sprzętowa=tak")
    #expect(DiagnosticsTrace.resume(awaySeconds: -1, responder: .nobody, hardwareKeyboard: false)
      == "powrót do apki po 0 s: klawiatura=nikt, sprzętowa=nie")
  }

  @Test("przerwanie: źródło gestu, wynik bez zdania serwera, czas od gestu do rozstrzygnięcia")
  func interrupt() {
    #expect(DiagnosticsTrace.interrupt(trigger: .escape, outcome: .delivered, milliseconds: 312)
      == "przerwanie (Esc): klawisz doszedł po 312 ms")
    #expect(DiagnosticsTrace.interrupt(trigger: .stop, outcome: .refused("Sesja nie pracuje — zdanie serwera"), milliseconds: 40)
      == "przerwanie (Stop): odmowa Raroga po 40 ms")
  }

  @Test("wejście do sesji: ramka, rozmiar, czas do ciszy i przyrost liczników; skrót id, bez treści sesji")
  func sessionEntry() {
    let counts = SessionEntryCounts(renders: 3, settles: 3, bottomScrolls: 4)
    let cold = SessionEntryWindow.Result(origin: .skeleton, firstFrame: 412, settled: 230, counts: counts)
    #expect(DiagnosticsTrace.sessionEntry(sessionId: "herdr-w1-p1", result: cold, kilobytes: 183)
      == "wejście do sesji …-w1-p1 (szkielet): ramka po 412 ms, 183 kB; widok stoi po 230 ms; "
      + "renders 3, settles 3, bottomScrolls 4")
    let warm = SessionEntryWindow.Result(origin: .memory, firstFrame: 180, settled: nil, counts: counts)
    #expect(DiagnosticsTrace.sessionEntry(sessionId: "s1", result: warm, kilobytes: 0)
      == "wejście do sesji s1 (z pamięci): ramka po 180 ms, 0 kB; widok bez ciszy po 10000 ms; "
      + "renders 3, settles 3, bottomScrolls 4")
    // Identyfikator z nazwą projektu i ścieżką zostaje skrótem z sześciu ostatnich znaków; linia
    // z największymi liczbami mieści się w 200 znakach.
    let huge = SessionEntryCounts(renders: 999_999, settles: 999_999, bottomScrolls: 999_999)
    let worst = SessionEntryWindow.Result(origin: .memory, firstFrame: 9_999_999, settled: 9_999_999, counts: huge)
    let line = DiagnosticsTrace.sessionEntry(
      sessionId: "/Users/ktos/Projects/tajny-klient/sesja-w12-p3", result: worst, kilobytes: 9_999_999)
    #expect(!line.contains("tajny") && !line.contains("Projects") && !line.contains("/"))
    #expect(line.count <= 200, "długość \(line.count)")
  }
}

@Suite("odmowa z nieznanym kodem: zdanie ogólne obszaru")
struct UnknownRefusalCopyTests {
  @Test("bez zdania serwera każdy obszar mówi własne zdanie ogólne, nigdy pustkę")
  func generalSentences() {
    let sentences: [String?] = [
      UICopy.decisionResult(.refused(message: nil)),
      UICopy.answerResult(.refused(message: nil)),
      UICopy.resumeResult(.refused(message: nil)),
      UICopy.createMessage(.refused(nil)),
      UICopy.closeMessage(.refused(nil)),
      UICopy.sendResult(.refused(UUID(), code: "kod-z-przyszlosci", message: nil), session: nil).text,
    ]
    for sentence in sentences {
      #expect(!(sentence ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
    }
    #expect(UICopy.decisionResult(.refused(message: "Zdanie serwera.")) == "Zdanie serwera.", "zdanie serwera stoi wprost")
  }
}
