import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Przerwanie tury, „obejrzane" i formularz
// nowej sesji — reduktor, selektory i akcje magazynu. Właściciel: sterowanie sesją.

@Suite("reduktor i selektory: przerwanie, prompt, obejrzane")
struct ReducerTurnControlTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  private func state(_ summaries: [String], herdr: String = "") throws -> AppState {
    var state = AppState(clientBuild: 1)
    state.apply(.loggedIn, now: t0)
    state.apply(.frame(try Frames.snapshot(summaries, extra: herdr), source: .global, cursor: nil), now: t0)
    return state
  }

  private func entry(_ sessionId: String, _ text: String, state: OutboxEntry.State = .queued, at: TimeInterval = 0) -> OutboxEntry {
    OutboxEntry(sessionId: sessionId, text: text, createdAt: t0.addingTimeInterval(at), state: state)
  }

  @Test("Stop: przy pracy i przy wpisie w locie; „Nie potwierdzono” go nie daje; kanał zamknięty wygasza")
  func availability() throws {
    var state = try state([
      Frames.summary("run", state: "running"),
      Frames.summary("start", state: "starting"),
      Frames.summary("ready", state: "waiting-input"),
      Frames.summary("ask", state: "waiting-permission"),
    ])
    #expect(state.interruptAvailability(for: "run") == .enabled)
    #expect(state.interruptAvailability(for: "start") == .enabled)
    #expect(state.interruptAvailability(for: "ready") == .hidden)
    #expect(state.interruptAvailability(for: "nie-ma") == .hidden)

    state.apply(.outboxEnqueued(entry("ready", "zrób to")), now: t0)
    #expect(state.interruptAvailability(for: "ready") == .enabled, "wpis w locie = tura w drodze")
    let id = try #require(state.outbox.first?.id)
    state.apply(.outboxUnconfirmed(id), now: t0)
    #expect(state.interruptAvailability(for: "ready") == .hidden, "„Nie potwierdzono” to dowód na brak tury")

    state.apply(.outboxEnqueued(entry("ask", "tak")), now: t0)
    #expect(state.interruptAvailability(for: "ask") == .disabled, "przy stojącej decyzji pole jest wygaszone")

    let readOnly = try self.state(
      [Frames.summary("run", state: "running")],
      herdr: #","herdrStatus":{"available":true,"agentCount":1,"readOnly":true,"canLaunch":false}"#)
    #expect(readOnly.interruptAvailability(for: "run") == .disabled, "herdr tylko do odczytu")
  }

  @Test("bramka gestu: trzyma do rozstrzygnięcia, najwyżej 4 s; rozstrzygnięcie starszej próby nie zdejmuje nowszej")
  func gestureGate() throws {
    var state = try state([Frames.summary("run", state: "running")])
    state.apply(.turnControl(.interruptStarted(sessionId: "run", at: t0)), now: t0)
    #expect(state.isInterrupting("run"))
    #expect(state.interruptHeld("run", now: t0.addingTimeInterval(1)))
    #expect(!state.interruptHeld("run", now: t0.addingTimeInterval(4)), "sufit 4 s")
    #expect(!state.interruptHeld("run", now: t0.addingTimeInterval(-1)), "zegar cofnięty otwiera bramkę")

    let later = t0.addingTimeInterval(5)
    state.apply(.turnControl(.interruptStarted(sessionId: "run", at: later)), now: later)
    state.apply(.turnControl(.interruptSettled(sessionId: "run", startedAt: t0)), now: later)
    #expect(state.isInterrupting("run"), "starsza próba nie gasi nowszej")
    state.apply(.turnControl(.interruptSettled(sessionId: "run", startedAt: later)), now: later)
    #expect(!state.isInterrupting("run"))
  }

  @Test("odpowiedź na przerwanie: stan od razu i aktywność gaśnie; karta zdjęta nie wraca, starsza nie cofa nowszej")
  func interruptReply() throws {
    var state = try state([Frames.summary("run", state: "running", stateSince: "2026-10-03T08:00:00.000Z")])
    state.apply(.viewSession("run"), now: t0)
    state.apply(.frame(try Frames.transcript("run", activity: #"{"kind":"tool","toolName":"Read","summary":"a.ts"}"#),
                       source: .session("run"), cursor: nil), now: t0)
    state.apply(.frame(try Frames.activity("run", kind: "thinking"), source: .global, cursor: nil), now: t0)
    #expect(state.transcripts["run"]?.activity != nil)

    let stopped = try summary(Frames.summary("run", state: "waiting-input", stateSince: "2026-10-03T08:01:00.000Z"))
    state.apply(.turnControl(.interruptReplied(stopped)), now: t0)
    #expect(state.sessions["run"]?.state == .waitingInput)
    #expect(state.sessions["run"]?.activity == nil)
    #expect(state.transcripts["run"]?.activity == nil)

    let stale = try summary(Frames.summary("run", state: "running", stateSince: "2026-10-03T07:59:00.000Z"))
    state.apply(.turnControl(.interruptReplied(stale)), now: t0)
    #expect(state.sessions["run"]?.state == .waitingInput, "spóźniona odpowiedź nie cofa nowszego stanu")

    let gone = try summary(Frames.summary("zamknieta", state: "waiting-input"))
    state.apply(.turnControl(.interruptReplied(gone)), now: t0)
    #expect(state.sessions["zamknieta"] == nil, "odpowiedź nie wskrzesza karty")
  }

  @Test("prompt text: a human message with text, trimmed; a harness notice, an attachment alone and the agent are not")
  func promptText() throws {
    var state = try state([Frames.summary("s1", state: "running")])
    let notice = #"{"seq":3,"role":"user","blocks":[{"type":"text","text":"<x>"}],"at":"2026-10-03T08:03:00.000Z","notice":{"kind":"command"}}"#
    let image = #"{"seq":2,"role":"user","blocks":[],"at":"2026-10-03T08:02:00.000Z","attachments":[{"kind":"image","name":"","bytes":3,"mime":"image/jpeg"}]}"#
    state.apply(.frame(try Frames.transcript("s1", messages: [
      Frames.messageJSON(seq: 1, role: "user", text: "  napraw test  "), image, notice,
      Frames.messageJSON(seq: 4, role: "assistant", text: "Robię."),
    ]), source: .session("s1"), cursor: nil), now: t0)
    let texts = try #require(state.transcripts["s1"]?.messages).map(AppState.promptText)
    #expect(texts == ["napraw test", nil, nil, nil])
  }

  @Test("„Pokaż w herdr” wycofane: rdzeń i transport apki nie mają akcji ani trasy focus")
  func showInHerdrRemoved() throws {
    // Przycisk zniknął z apki, więc nie ma też selektora, akcji magazynu ani trasy `POST …/focus` po stronie apki.
    // Kontrakt i serwer zostają bez zmian (osobna decyzja).
    let packages = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let roots = ["RarogCore/Sources", "RarogTransport/Sources"].map { packages.appending(path: $0) }
    var files: [URL] = []
    for root in roots {
      let found = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      files += found.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }
    #expect(files.count > 50, "test czyta za mało plików: \(files.count)")
    for file in files {
      let code = try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
        .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
        .joined(separator: "\n")
      for name in ["showInHerdr", "ShowInHerdr", "focusSession", "/focus\""] {
        #expect(!code.contains(name), "\(file.lastPathComponent): \(name)")
      }
    }
  }

  @Test("cel „obejrzane”: wynik nieodebrany przy żywym strumieniu; tura, odebrany i nieświeża lista — nie")
  func seenTarget() throws {
    var state = try state([
      Frames.summary("ready", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z"),
      Frames.summary("seen", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("run", state: "running"),
    ])
    #expect(state.seenTarget("ready") == nil, "bez żywego strumienia lista nie jest dowodem")
    state.apply(.streamOpened(.global, resumedWithCursor: false), now: t0)
    #expect(state.seenTarget("ready") == "2026-10-03T08:05:00.000Z")
    #expect(state.seenTarget("seen") == nil)
    #expect(state.seenTarget("run") == nil, "zerknięcie w trakcie tury to nie odbiór")
  }

  /// Catches a session the voice agent picked up keeping `seenBy` after a person opens it: the screen would send no
  /// receipt, so the list would go on saying "discussed by voice" about a result the person has read.
  @Test("seen target: a standing result the voice agent picked up is a person's receipt to send; other guards stand")
  func seenTargetAfterPickUp() throws {
    let picked = #","seen":true,"seenBy":"voice-agent""#
    var state = try state([
      Frames.summary("voice", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z", extra: picked),
      Frames.summary("human", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z", extra: #","seen":true"#),
      Frames.summary("work", state: "running", stateSince: "2026-10-03T08:05:00.000Z", extra: picked),
      Frames.summary("held", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z", extra: picked),
    ])
    state.apply(.streamOpened(.global, resumedWithCursor: false), now: t0)
    state.apply(.turnControl(.unreadMarked(sessionId: "held")), now: t0)
    #expect(state.seenTarget("voice") == "2026-10-03T08:05:00.000Z")
    #expect(state.seenTarget("human") == nil, "a person's receipt stands: nothing to send")
    #expect(state.seenTarget("work") == nil, "a glance during a turn is no receipt")
    #expect(state.seenTarget("held") == nil, "a result marked unread by hand is not taken back by the screen")
  }

  @Test("przełącznik odbioru: tylko stojący wynik przy żywym strumieniu i świeżej liście; kierunek z `seen`")
  func readToggle() throws {
    var state = try state([
      Frames.summary("ready", state: "waiting-input"),
      Frames.summary("seen", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("run", state: "running"),
      Frames.summary("err", state: "error"),
      Frames.summary("stale", state: "waiting-input", extra: #","seen":true,"stale":true"#),
    ])
    #expect(state.readToggle("seen") == nil, "bez żywego strumienia")
    state.apply(.streamOpened(.global, resumedWithCursor: false), now: t0)
    #expect(state.readToggle("ready") == .markRead)
    #expect(state.readToggle("seen") == .markUnread)
    #expect(state.readToggle("run") == nil, "w trakcie tury wyniku nie ma")
    #expect(state.readToggle("err") == nil, "awaria stoi w uwadze niezależnie od `seen`")
    #expect(state.readToggle("stale") == nil, "bez kontaktu z herdr")
    #expect(state.readToggle("nie-ma") == nil)
  }

  @Test("blokada ręcznego „nieprzeczytane”: ekran nie odbiera; zwalnia ją wejście i tura, nie zmiana `stateSince`")
  func manualUnreadHold() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z")])
    state.apply(.streamOpened(.global, resumedWithCursor: false), now: t0)
    state.apply(.turnControl(.unreadMarked(sessionId: "s1")), now: t0)
    #expect(state.seenTarget("s1") == nil, "ekran obok listy nie odbiera wyniku z powrotem")

    // Serwer przestawia `stateSince` bez nowej tury (adopcja po swoim restarcie, import historii) — blokada stoi,
    // także po pełnej liście z ponownego połączenia.
    let moved = Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:01:00.000Z")
    state.apply(.frame(try Frames.sessionChanged(moved), source: .global, cursor: nil), now: t0)
    state.apply(.frame(try Frames.snapshot([moved]), source: .global, cursor: nil), now: t0)
    #expect(state.seenTarget("s1") == nil)

    state.apply(.turnControl(.unreadReleased(sessionId: "s1")), now: t0)
    #expect(state.seenTarget("s1") == "2026-10-03T08:01:00.000Z", "nowe wejście odbiera jak zwykle")

    state.apply(.turnControl(.unreadMarked(sessionId: "s1")), now: t0)
    let turn = Frames.summary("s1", state: "running", stateSince: "2026-10-03T08:09:00.000Z")
    state.apply(.frame(try Frames.sessionChanged(turn), source: .global, cursor: nil), now: t0)
    #expect(state.turnControl.manualUnread.isEmpty, "nowa tura da nowy wynik")

    state.apply(.turnControl(.unreadMarked(sessionId: "s1")), now: t0)
    state.apply(.frame(try Frames.snapshot([]), source: .global, cursor: nil), now: t0)
    #expect(state.turnControl.manualUnread.isEmpty, "sesja zniknęła z listy")

    state.apply(.turnControl(.unreadMarked(sessionId: "s1")), now: t0)
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(state.turnControl.manualUnread.isEmpty, "wylogowanie")
  }

  @Test("fresh result: an unread result nobody marked by hand; not marked, held, received or background work")
  func freshResult() throws {
    var state = try state([
      Frames.summary("fresh", state: "waiting-input"),
      Frames.summary("done", state: "waiting-input", extra: #","seen":false"#),
      Frames.summary("marked", state: "waiting-input", extra: #","markedUnseen":true"#),
      Frames.summary("held", state: "waiting-input"),
      Frames.summary("read", state: "waiting-input", extra: #","seen":true"#),
      Frames.summary("bg", state: "waiting-input",
                     extra: #","backgroundTasks":[{"id":"t","kind":"command","command":"pnpm test"}]"#),
      Frames.summary("run", state: "running"),
    ])
    state.apply(.turnControl(.unreadMarked(sessionId: "held")), now: t0)
    let held = state
    func fresh(_ id: String) -> Bool { held.sessions[id].map(held.freshResult) ?? false }
    #expect(fresh("fresh"))
    #expect(fresh("done"), "a `done` badge in herdr is an unread result too")
    #expect(!fresh("marked"), "marked unread by hand on the server")
    #expect(!fresh("held"), "marked unread on this device, before the server frame")
    #expect(!fresh("read"))
    #expect(state.sessions["bg"]?.statusTone == .working)
    #expect(!fresh("bg"), "background work has the working tone, not the unread one")
    #expect(!fresh("run"))
  }

  @Test("fresh result: once the server confirmed the hand mark, a later result it does not mark pulses")
  func freshResultAfterConfirmedMark() throws {
    var state = try state([Frames.summary("s1", state: "waiting-input", extra: #","seen":true"#)])
    state.apply(.turnControl(.unreadMarked(sessionId: "s1")), now: t0)
    let pending = Frames.summary("s1", state: "waiting-input")
    state.apply(.frame(try Frames.sessionChanged(pending), source: .global, cursor: nil), now: t0)
    #expect(state.sessions["s1"].map(state.freshResult) == false, "the server frame with the mark has not come yet")

    let marked = Frames.summary("s1", state: "waiting-input", extra: #","markedUnseen":true"#)
    state.apply(.frame(try Frames.sessionChanged(marked), source: .global, cursor: nil), now: t0)
    #expect(state.sessions["s1"].map(state.freshResult) == false)

    // The app was in the background while a whole turn ran on the Mac: the snapshot brings a new result without
    // the mark, and the hold until the next visit is still there.
    let next = Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T09:00:00.000Z")
    state.apply(.frame(try Frames.snapshot([next]), source: .global, cursor: nil), now: t0)
    #expect(state.turnControl.manualUnread.contains("s1"))
    #expect(state.sessions["s1"].map(state.freshResult) == true)
  }

  @Test("zalogowanie i wylogowanie zaczynają stan od nowa z wyższym numerem")
  func resetOnAuth() throws {
    var state = try state([Frames.summary("run", state: "running")])
    let login = state.turnControl.login
    state.apply(.turnControl(.interruptStarted(sessionId: "run", at: t0)), now: t0)
    state.apply(.turnControl(.seenNoted(sessionId: "run", stateSince: "x")), now: t0)
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(state.turnControl.interrupts.isEmpty && state.turnControl.seen.isEmpty)
    #expect(state.turnControl.login == login + 1)
    state.apply(.loggedIn, now: t0)
    #expect(state.turnControl.login == login + 2)
  }

  private func summary(_ json: String) throws -> SessionSummary {
    guard case let .sessionChanged(event) = try Frames.sessionChanged(json) else { throw Unexpected() }
    return event.session
  }

  struct Unexpected: Error {}
}

@MainActor
@Suite("magazyn: przerwanie tury")
struct StoreInterruptTests {
  @Test("sukces: karta z odpowiedzi od razu; brak `delivered` = przerwane; „przerywa” tylko w trakcie")
  func delivered() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let gate = AsyncStream<Void>.makeStream()
    let stopped = Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:01:00.000Z")
    probe.set { calls in
      calls.interruptResults = [.success(#"{"ok":true,"session":\#(stopped)}"#)]
      calls.onInterrupt = { _ in for await _ in gate.stream { return } }
    }
    let first = Task { await store.interrupt("s1") }
    await until("przerywa") { store.state.isInterrupting("s1") }
    #expect(await store.interrupt("s1") == .inFlight, "drugie naciśnięcie w jednym geście nic nie wysyła")
    gate.continuation.yield()
    #expect(await first.value == .delivered(returnedPrompt: nil))
    #expect(!store.state.isInterrupting("s1"))
    #expect(store.state.sessions["s1"]?.state == .waitingInput, "stan z odpowiedzi, bez czekania na strumień")
    #expect(probe.read(\.interrupts) == ["s1"])
    #expect(await store.interrupt("s1") == .notAllowed, "sesja stoi i nic nie leci — nie ma czego przerywać")
  }

  @Test("delivered carries the prompt Claude Code handed back, word for word; no field or an empty one = none, also with a queued entry")
  func returnedPrompt() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    probe.set {
      $0.interruptResults = [
        .success(#"{"ok":true,"delivered":"yes","returnedPrompt":"  Refactor the parser\nkeep tests  "}"#),
        .success(#"{"ok":true,"returnedPrompt":"older server shape"}"#),
        .success(#"{"ok":true,"delivered":"yes","returnedPrompt":""}"#),
        .success(#"{"ok":true,"delivered":"yes"}"#),
      ]
    }
    #expect(await store.interrupt("s1") == .delivered(returnedPrompt: "  Refactor the parser\nkeep tests  "))
    #expect(await store.interrupt("s1") == .delivered(returnedPrompt: "older server shape"), "missing `delivered` = delivered")
    #expect(await store.interrupt("s1") == .delivered(returnedPrompt: nil), "an empty field is no hand-back")
    let queued = OutboxEntry(sessionId: "s1", text: "Queued next step", createdAt: Date())
    store.dispatch(.outboxEnqueued(queued))
    store.dispatch(.outboxQueued(queued.id, at: Date()))
    #expect(await store.interrupt("s1") == .delivered(returnedPrompt: nil), "a queued text is never a hand-back")
  }

  @Test("los klawisza: no → panel nie przyjął, pending → nie wiem; 4xx bramka Raroga zdaniem serwera, 5xx → panel")
  func verdicts() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let refusal = APIFailure(status: 409, code: "bad-state", message: "herdr jest w trybie tylko do odczytu.")
    probe.set {
      $0.interruptResults = [
        .success(#"{"ok":true,"delivered":"no"}"#),
        .success(#"{"ok":true,"delivered":"pending"}"#),
        .failure(.http(refusal)),
        .failure(.http(APIFailure(status: 500, code: "internal", message: "x"))),
        .success(#"{"ok":true,"delivered":"kiedyś"}"#),
      ]
    }
    #expect(await store.interrupt("s1") == .notDelivered)
    #expect(await store.interrupt("s1") == .unsure)
    #expect(await store.interrupt("s1") == .refused(refusal.message))
    #expect(await store.interrupt("s1") == .notDelivered)
    #expect(await store.interrupt("s1") == .unsure, "los spoza kontraktu nie jest sukcesem")
  }

  @Test("błąd sieci: jedno ponowienie; drugi błąd = nie wiem")
  func retry() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    probe.set { $0.interruptResults = [.failure(.timedOut), .success(#"{"ok":true,"delivered":"yes"}"#)] }
    #expect(await store.interrupt("s1") == .delivered(returnedPrompt: nil))
    #expect(probe.read(\.interrupts).count == 2)
    probe.set { $0.interruptResults = [.failure(.offline(.networkConnectionLost)), .failure(.timedOut)] }
    #expect(await store.interrupt("s1") == .unsure)
    #expect(probe.read(\.interrupts).count == 4, "tylko jedno ponowienie")
  }

  @Test("ponowienie należy do zalogowania gestu: wylogowanie i logowanie w przerwie = nic więcej nie wychodzi")
  func retryAcrossRelogin() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    probe.set { $0.interruptResults = [.failure(.timedOut), .success(#"{"ok":true,"delivered":"yes"}"#)] }
    let request = Task { await store.interrupt("s1") }
    // Pierwsza próba rozstrzygnięta (rejestr żądań pusty) — magazyn czeka na ponowienie.
    await until("przerwa przed ponowieniem") { probe.read(\.interrupts).count == 1 && store.turnRequests.cancels.isEmpty }
    store.handleUnauthorized()
    store.enterLoggedIn()
    // Nowe zalogowanie ma żywy strumień i tę samą pracującą sesję — bramka klienta niczego by nie zatrzymała.
    await until("online po logowaniu") { store.state.global == .online }
    probe.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s"}"#)
    probe.base.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "running"))]}"#)
    #expect(await request.value == .loggedOut)
    #expect(probe.read(\.interrupts).count == 1, "gest sprzed wylogowania nie przerywa tury w nowym zalogowaniu")
    #expect(store.state.auth == .loggedIn)
    #expect(store.state.turnControl.interrupts.isEmpty)
  }

  @Test("wylogowanie w trakcie: żądanie anulowane, wynik do kosza, nowy stan bez śladu")
  func logoutDuringRequest() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "running")])
    let gate = AsyncStream<Void>.makeStream()
    probe.set { $0.onInterrupt = { _ in for await _ in gate.stream { return } } }
    let request = Task { await store.interrupt("s1") }
    await until("w locie") { !probe.read(\.interrupts).isEmpty }
    store.handleUnauthorized()
    gate.continuation.yield()
    #expect(await request.value == .loggedOut)
    #expect(store.state.turnControl.interrupts.isEmpty)
    #expect(store.turnRequests.cancels.isEmpty)
  }

  @Test("sesja nieobsługiwana i przerwanie bez pracy: nic nie wychodzi")
  func gates() async throws {
    let (store, probe) = try await turnStore([
      Frames.summary("odd", state: "nowy-stan"), Frames.summary("ready", state: "waiting-input"),
    ])
    #expect(await store.interrupt("odd") == .notAllowed)
    #expect(await store.interrupt("ready") == .notAllowed)
    #expect(probe.read(\.interrupts).isEmpty)
  }
}

@MainActor
@Suite("magazyn: obejrzane")
struct StoreFocusSeenTests {
  @Test("obejrzane: raz na wynik; nowy wynik i ponowne wejście zgłaszają od nowa; tura i odebrany — nie")
  func seenOncePerResult() async throws {
    let (store, probe) = try await turnStore([
      Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z"),
    ])
    store.noteResultViewed("s1")
    store.noteResultViewed("s1")
    await until("POST") { probe.read(\.seen).count == 1 }

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "running", stateSince: "2026-10-03T08:06:00.000Z"))}"#)
    await until("tura") { store.state.sessions["s1"]?.state == .running }
    store.noteResultViewed("s1")
    #expect(store.state.turnControl.seen["s1"] == nil, "wynik zniknął — pamięć od nowa")

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:07:00.000Z"))}"#)
    await until("nowy wynik") { store.state.sessions["s1"]?.stateSince == "2026-10-03T08:07:00.000Z" }
    store.noteResultViewed("s1")
    await until("drugi POST") { probe.read(\.seen).count == 2 }

    store.leaveResultView("s1")
    store.noteResultViewed("s1")
    await until("ponowne wejście") { probe.read(\.seen).count == 3 }

    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:07:00.000Z", extra: #","seen":true"#))}"#)
    await until("odebrany") { store.state.sessions["s1"]?.seen == true }
    store.leaveResultView("s1")
    store.noteResultViewed("s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(probe.read(\.seen).count == 3, "odebrany wynik nie wysyła niczego")
  }

  /// Catches two failures of a person's receipt over the voice agent's pick-up: none at all (`seenBy` would stay),
  /// and one on every report while the screen stands (each frame re-renders the screen until the server's frame
  /// takes `seenBy` away).
  @Test("a result the voice agent picked up: the screen's report sends one receipt, before and after the server frame")
  func pickedUpResultOnce() async throws {
    let since = "2026-10-03T08:05:00.000Z"
    let (store, probe) = try await turnStore([
      Frames.summary("s1", state: "waiting-input", stateSince: since, extra: #","seen":true,"seenBy":"voice-agent""#),
    ])
    store.noteResultViewed("s1")
    await until("POST seen") { probe.read(\.seen) == ["s1"] }
    store.noteResultViewed("s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(probe.read(\.seen) == ["s1"], "a second report of the same result sends nothing")

    let received = Frames.summary("s1", state: "waiting-input", stateSince: since, extra: #","seen":true"#)
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(received)}"#)
    await until("seenBy gone") { store.state.sessions["s1"]?.seenBy == nil }
    store.noteResultViewed("s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(probe.read(\.seen) == ["s1"], "the person's receipt stands: nothing more to send")
  }

  @Test("przeczytane / nieprzeczytane: właściwe żądanie; ekran z blokadą nie odbiera, wejście ją zwalnia")
  func readToggleRequests() async throws {
    let read = Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z", extra: #","seen":true"#)
    let (store, probe) = try await turnStore([read])
    store.setResultRead("s1", read: false)
    await until("POST unseen") { probe.read(\.unseen) == ["s1"] }
    let unread = Frames.summary("s1", state: "waiting-input", stateSince: "2026-10-03T08:05:00.000Z")
    probe.base.push(.global, json: #"{"type":"session-changed","session":\#(unread)}"#)
    await until("nieodebrany") { store.state.sessions["s1"]?.seen == nil }

    // Sesja otwarta obok listy: render ekranu nie odbiera wyniku, który człowiek oznaczył jako nieprzeczytany.
    store.noteResultViewed("s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(probe.read(\.seen).isEmpty)

    store.enterResultView("s1")
    store.noteResultViewed("s1")
    await until("wejście odbiera") { probe.read(\.seen) == ["s1"] }

    store.setResultRead("s1", read: true)
    await until("POST seen") { probe.read(\.seen).count == 2 }
    #expect(store.state.turnControl.manualUnread.isEmpty)
  }
}

@MainActor
@Suite("magazyn: formularz nowej sesji")
struct StoreNewSessionTests {
  @Test("katalog: listing, odmowa serwera zdaniem; listy do wznowienia: pełna i ostatnie")
  func reads() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "waiting-input")])
    probe.set {
      $0.directoryResult = .success(#"{"path":"/r","parent":null,"entries":[{"name":"a","path":"/r/a","git":true,"history":false}],"truncated":false}"#)
    }
    guard case let .loaded(listing) = await store.listDirectory("/r") else {
      Issue.record("listing")
      return
    }
    #expect(listing.entries.map(\.path) == ["/r/a"] && listing.entries.first?.git == true)
    probe.set { $0.directoryResult = .failure(.http(APIFailure(status: 400, code: "cwd-not-allowed", message: "Poza allow-listą."))) }
    #expect(await store.listDirectory("/x") == .refused("Poza allow-listą."))
    #expect(probe.read(\.directories) == ["/r", "/x"])

    let entry = #"{"engineSessionId":"e1","cwd":"/r/a","mtime":"2026-10-03T08:00:00.000Z","firstPrompt":"start","liveInHerdr":false}"#
    probe.set { $0.resumableResult = .success(#"{"sessions":[\#(entry)]}"#) }
    guard case let .loaded(list) = await store.resumableSessions(cwd: "/r/a") else {
      Issue.record("lista")
      return
    }
    #expect(list.map(\.engineSessionId) == ["e1"])
    #expect(await store.resumableSessions(cwd: "/r/a", recent: true) != .failed)
    probe.set { $0.resumableResult = .failure(.offline(.notConnectedToInternet)) }
    #expect(await store.resumableSessions(cwd: "/r/a") == .failed)
    #expect(probe.read { $0.resumable.map(\.recent) } == [false, true, false])
  }

  @Test("New Directory: the row from 200; 409 dir-exists apart from other refusals (409, 429, 400) and the network")
  func createDirectory() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "waiting-input")])
    #expect(await store.createDirectory(parent: "/r", name: "new")
      == .created(DirEntry(name: "new", path: "/r/new", git: false, history: false)))
    #expect(probe.read(\.made) == [MakeDirBody(parent: "/r", name: "new")])

    let exists = APIFailure(status: 409, code: "dir-exists", message: "Something with that name already exists here.")
    let disabled = APIFailure(status: 409, code: "mkdir-disabled", message: "Creating directories is turned off.")
    let busy = APIFailure(status: 429, code: "mkdir-busy", message: "Another directory is being created.")
    let invalid = APIFailure(status: 400, code: "dir-name-invalid", message: "That name can't be used.")
    let cases: [(TransportError, DirectoryCreateOutcome)] = [
      (.http(exists), .exists(exists.message)),
      (.http(disabled), .refused(disabled.message)),
      (.rateLimited(busy), .refused(busy.message)),
      (.http(invalid), .refused(invalid.message)),
      (.offline(.notConnectedToInternet), .offline),
      (.timedOut, .timedOut),
    ]
    for (error, outcome) in cases {
      probe.set { $0.makeResult = .failure(error) }
      #expect(await store.createDirectory(parent: "/r", name: "new") == outcome, "\(error)")
    }
    #expect(probe.read(\.made).count == cases.count + 1, "one request per call")
  }

  @Test("„Uruchom”: ciało z ustawieniami; 400 o katalogu przy polu, model-unknown i 409 jako zdanie; blokada bez żądania")
  func launch() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "waiting-input")])
    let body = CreateSessionBody(cwd: "/r/a", permissionMode: .auto, model: "opus[1m]", effort: .xhigh)
    #expect(await store.launchSession(body) == .created(sessionId: "new-1", trustPrompt: false))
    #expect(probe.base.read(\.created) == [body])

    let cwd = APIFailure(status: 400, code: "cwd-not-allowed", message: "Katalog poza allow-listą.")
    let model = APIFailure(status: 400, code: "model-unknown", message: "Ten model nie jest dostępny.")
    let full = APIFailure(status: 409, code: "bad-state", message: "Sufit paneli.")
    probe.base.set { $0.createResults = [.failure(.http(cwd)), .failure(.http(model)), .failure(.http(full))] }
    #expect(await store.launchSession(body) == .cwdRefused(cwd.message))
    #expect(await store.launchSession(body) == .refused(model.message), "model wybrany ręką nie startuje po cichu na innym")
    #expect(await store.launchSession(body) == .refused(full.message))

    probe.base.push(.global, json: #"{"type":"herdr-status","available":true,"agentCount":1,"readOnly":false,"canLaunch":false,"detail":"Zakładanie wyłączone."}"#)
    await until("blokada") { store.state.launchBlocked }
    #expect(await store.launchSession(body) == .blocked("Zakładanie wyłączone."))
    #expect(probe.base.read(\.created).count == 4)
  }

  @Test("„Uruchom” z ultracode: 400 ultracode-refused to zdanie o ustawieniach startu, inna 400 zostaje przy polu")
  func launchUltracodeRefused() async throws {
    let (store, probe) = try await turnStore([Frames.summary("s1", state: "waiting-input")])
    let body = CreateSessionBody(cwd: "/r/a", model: "opus[1m]", ultracode: true)
    let gate = APIFailure(
      status: 400, code: "ultracode-refused",
      message: "Nie znam wersji Claude Code, a ultracode wymaga wersji 2.1.284 albo nowszej.")
    let other = APIFailure(status: 400, code: "bad-request", message: "Katalog nie istnieje.")
    probe.base.set { $0.createResults = [.failure(.http(gate)), .failure(.http(other))] }
    #expect(await store.launchSession(body) == .ultracodeRefused(gate.message), "odmowa ultracode nie mówi o katalogu")
    #expect(await store.launchSession(body) == .cwdRefused(other.message))
    #expect(probe.base.read(\.created) == [body, body])
  }
}
