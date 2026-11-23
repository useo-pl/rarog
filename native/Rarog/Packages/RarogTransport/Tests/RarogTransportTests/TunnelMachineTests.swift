import Foundation
@testable import RarogTransport
import Testing

// Tunnel generation machine: a test for each transition of the machine, the transport choice and sequences:
// background work before and after the scene leaves, return during closing, `rebindOnReturn` before `open`,
// retirement after pairing with another server, a series of failed probes, cold start, an HTTPS generation without
// a probe.

private typealias F = MachineFixture
private let w1 = F.waiter(1)
private let w2 = F.waiter(2)
private let p1 = F.work(1)
private let p2 = F.work(2)

@Suite("maszyna generacji tunelu: przejścia")
struct TunnelMachineTests {
  // MARK: - Popyt i czekający

  @Test("zimny start: scena inactive, lease ready, popyt otwiera generację iroh z budżetem 15 s")
  func coldStart() {
    var machine = Machine(routes: F.both)
    #expect(machine.scene == .inactive)
    let commands = machine.send(.demand(w1), at: 2)
    #expect(machine.state == .opening(.init(generation: 1, since: F.at(2), choice: .iroh, deadline: F.at(17),
                                             waiters: [w1])))
    #expect(commands == [.open(generation: 1, choice: .iroh, budget: .seconds(15)), .schedule(at: F.at(17))])
  }

  @Test("popyt w tle przy niepustych pracach otwiera generację")
  func backgroundWithWork() {
    var machine = Machine.foreground()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = machine.send(.scene(.background))
    #expect(machine.state == .idle)
    let commands = machine.send(.demand(w1), at: 1)
    #expect(commands == [.open(generation: 1, choice: .iroh, budget: .seconds(15)), .schedule(at: F.at(16))])
  }

  @Test("popyt w tle bez pracy: od razu offline, bez otwarcia")
  func backgroundNoWork() {
    var machine = Machine.foreground()
    _ = machine.send(.scene(.background))
    #expect(machine.send(.demand(w1)) == [.release([w1], .offline)])
    #expect(machine.state == .idle)
    #expect(machine.lastGeneration == 0)
  }

  @Test("popyt w opening i probing dopisuje czekającego bez poleceń")
  func demandWhileOpening() {
    var opening = Machine.opening()
    #expect(opening.send(.demand(w2)).isEmpty)
    guard case .opening(let attempt) = opening.state else { Issue.record("nie opening"); return }
    #expect(attempt.waiters == [w1, w2])

    var probing = Machine.probing()
    #expect(probing.send(.demand(w2)).isEmpty)
    guard case .probing(let probe) = probing.state else { Issue.record("nie probing"); return }
    #expect(probe.waiters == [w1, w2])
  }

  @Test("anulowanie czekającego w opening, probing i closing usuwa tylko jego, próba trwa")
  func cancelWaiter() {
    var opening = Machine.opening()
    _ = opening.send(.demand(w2))
    #expect(opening.send(.cancelWaiter(w1)) == [.release([w1], .cancelled)])
    guard case .opening(let attempt) = opening.state else { Issue.record("nie opening"); return }
    #expect(attempt.waiters == [w2])

    var probing = Machine.probing()
    #expect(probing.send(.cancelWaiter(w1)) == [.release([w1], .cancelled)])
    guard case .probing(let probe) = probing.state else { Issue.record("nie probing"); return }
    #expect(probe.waiters.isEmpty)

    var closing = Machine.ready()
    _ = closing.send(.networkChanged)
    _ = closing.send(.demand(w1))
    #expect(closing.send(.cancelWaiter(w1)) == [.release([w1], .cancelled)])
    #expect(closing.state == .closing(.init(generation: 1, reason: .network, waiters: [])))
    #expect(closing.send(.cancelWaiter(w2)).isEmpty)
  }

  @Test("scena active i zmiana sieci w tej samej chwili dają jedno otwarcie")
  func oneOpen() {
    var machine = Machine(routes: F.both)
    var commands = machine.send(.demand(w1), at: 1)
    commands += machine.send(.scene(.active), at: 1)
    commands += machine.send(.networkChanged, at: 1)
    #expect(Machine.opens(commands) == 1)
    guard case .opening(let attempt) = machine.state else { Issue.record("nie opening"); return }
    #expect(attempt.generation == 1)
  }

  @Test("scena inactive nie zmienia stanu i nie daje poleceń")
  func inactive() {
    for var machine in [Machine.foreground(), .opening(), .probing(), .ready()] {
      let before = machine.state
      #expect(machine.send(.scene(.inactive)).isEmpty)
      #expect(machine.state == before)
      #expect(machine.scene == .inactive)
    }
  }

  @Test("zejście w tło w opening i probing bez pracy: closing(background), discard, offline")
  func backgroundWhileOpening() {
    for var machine in [Machine.opening(), .probing()] {
      #expect(machine.send(.scene(.background)) == [.discard(generation: 1), .release([w1], .offline)])
      #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
    }
    var withWork = Machine.opening()
    _ = withWork.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    let before = withWork.state
    #expect(withWork.send(.scene(.background)).isEmpty)
    #expect(withWork.state == before)
  }

  // MARK: - Wyniki runtime

  @Test("an opened iroh generation, and an HTTPS one of a credential with both routes, goes to the probe")
  func openedIroh() {
    var machine = Machine.opening()
    #expect(machine.send(.opened(generation: 1)) == [.probe(generation: 1)])
    guard case .probing(let attempt) = machine.state else { Issue.record("nie probing"); return }
    #expect(attempt.generation == 1 && attempt.choice == .iroh && attempt.waiters == [w1])

    var https = Machine.opening(lease: .unavailable)
    #expect(https.send(.opened(generation: 1)) == [.probe(generation: 1)])
    guard case .probing(let probe) = https.state else { Issue.record("not probing"); return }
    #expect(probe.choice == .https && probe.waiters == [w1])
  }

  @Test("wynik ze starym numerem: bez zmian, discard starego")
  func staleResult() {
    var machine = Machine.opening()
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    _ = machine.send(.tick, at: 2)
    _ = machine.send(.demand(w2), at: 2)
    let before = machine.state
    for event: Machine.Event in [.opened(generation: 1), .probeFinished(generation: 1, .http(status: 200)),
                                 .openFailed(generation: 1, .timedOut), .connectionLost(generation: 1),
                                 .abortTimedOut(generation: 1), .closed(generation: 1)] {
      #expect(machine.send(event, at: 3) == [.discard(generation: 1)])
      #expect(machine.state == before)
    }
  }

  @Test("nieudane otwarcie iroh: closing(failed), discard, offline, pamięć porażki 2 min, porażka do lease")
  func openFailed() {
    var machine = Machine.opening()
    let commands = machine.send(.openFailed(generation: 1, .connectFailed("x")), at: 3)
    #expect(commands == [.discard(generation: 1), .release([w1], .offline), .reportIroh(success: false)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .failed, waiters: [])))
    #expect(machine.memory.retryIrohAt == F.at(123))
  }

  @Test("budżet minął w probing: tick po terminie jak nieudane otwarcie")
  func budgetElapsed() {
    var machine = Machine.probing()
    #expect(machine.send(.tick, at: 14).isEmpty)
    let commands = machine.send(.tick, at: 15)
    #expect(commands == [.discard(generation: 1), .release([w1], .offline), .reportIroh(success: false)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .failed, waiters: [])))
  }

  @Test("a failed HTTPS generation: no failure memory and no lease report; with both routes it ends the iroh pause, also when the probe runs out of budget")
  func httpsFailed() {
    var machine = Machine.opening(F.httpsOnly)
    let commands = machine.send(.openFailed(generation: 1, .connectFailed("x")))
    #expect(commands == [.discard(generation: 1), .release([w1], .offline)])
    #expect(machine.memory.retryIrohAt == nil)

    var both = Machine.opening(F.both)
    _ = both.send(.openFailed(generation: 1, .timedOut))
    _ = both.send(.closed(generation: 1))
    _ = both.send(.tick, at: 1)
    _ = both.send(.demand(w2), at: 1)
    _ = both.send(.opened(generation: 2), at: 1)
    #expect(both.memory.retryIrohAt == F.at(120))
    #expect(both.send(.tick, at: 16) == [.discard(generation: 2), .release([w2], .offline)])
    #expect(both.memory.retryIrohAt == nil)
    #expect(both.state == .closing(.init(generation: 2, reason: .failed, waiters: [])))
    #expect(both.send(.closed(generation: 2), at: 16) == [.schedule(at: F.at(17))])
    _ = both.send(.tick, at: 17)
    #expect(both.send(.demand(F.waiter(3)), at: 17).first == .open(generation: 3, choice: .iroh, budget: .seconds(15)))
  }

  @Test("a probe with an HTTP answer (401 too) gives readiness; iroh clears the memory and reports success to the lease, HTTPS keeps the memory without a report")
  func probeHttp() {
    var machine = Machine.probing()
    let commands = machine.send(.probeFinished(generation: 1, .http(status: 401)))
    #expect(commands == [.reportIroh(success: true), .release([w1], .ready(generation: 1))])
    #expect(machine.state == .ready(generation: 1, choice: .iroh))
    #expect(machine.memory.retryIrohAt == nil)

    var https = Machine.opening()
    _ = https.send(.openFailed(generation: 1, .timedOut))
    _ = https.send(.closed(generation: 1))
    _ = https.send(.tick, at: 1)
    _ = https.send(.demand(w2), at: 1)
    _ = https.send(.opened(generation: 2), at: 1)
    #expect(https.sendLogged(.probeFinished(generation: 2, .http(status: 401)), at: 1)
      == [.release([w2], .ready(generation: 2))])
    #expect(https.state == .ready(generation: 2, choice: .https))
    #expect(https.memory.retryIrohAt == F.at(120))
  }

  @Test("gotowość G przy scenie w tle: z pracą backgroundWork, bez pracy od razu closing i offline")
  func readinessInBackground() {
    var withWork = Machine.probing()
    _ = withWork.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = withWork.send(.scene(.background))
    #expect(withWork.send(.probeFinished(generation: 1, .http(status: 200)))
      == [.reportIroh(success: true), .release([w1], .ready(generation: 1))])
    #expect(withWork.state == .backgroundWork(generation: 1, choice: .iroh))

    var noWork = Machine.probing()
    _ = noWork.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = noWork.send(.scene(.background))
    _ = noWork.send(.backgroundWorkFinished(p1))
    #expect(noWork.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
  }

  @Test("a probe with a transport error: like a failed open; over HTTPS with both routes it ends the iroh pause without a lease report")
  func probeTransport() {
    var machine = Machine.probing()
    let commands = machine.send(.probeFinished(generation: 1, .transport), at: 4)
    #expect(commands == [.discard(generation: 1), .release([w1], .offline), .reportIroh(success: false)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .failed, waiters: [])))
    #expect(machine.memory.retryIrohAt == F.at(124))

    var https = Machine.opening(lease: .unavailable)
    _ = https.send(.opened(generation: 1))
    #expect(https.send(.probeFinished(generation: 1, .transport), at: 4)
      == [.discard(generation: 1), .release([w1], .offline)])
    #expect(https.state == .closing(.init(generation: 1, reason: .failed, waiters: [])))
    #expect(https.memory.retryIrohAt == nil)
  }

  // MARK: - Tło

  @Test("zejście w tło z ready: bez pracy backgroundGrace 8 s, z pracą backgroundWork")
  func readyToBackground() {
    var noWork = Machine.ready()
    #expect(noWork.send(.scene(.background), at: 5) == [.schedule(at: F.at(13))])
    #expect(noWork.state == .backgroundGrace(generation: 1, choice: .iroh, until: F.at(13)))

    var withWork = Machine.ready()
    _ = withWork.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    #expect(withWork.send(.scene(.background)).isEmpty)
    #expect(withWork.state == .backgroundWork(generation: 1, choice: .iroh))
  }

  @Test("generacja w tle potrzebuje czasu systemu od zejścia w tło do zamknięcia albo powrotu")
  func holdsBackgroundGeneration() {
    var machine = Machine.ready()
    #expect(!machine.holdsBackgroundGeneration)
    _ = machine.send(.scene(.background), at: 0)
    #expect(machine.holdsBackgroundGeneration)
    _ = machine.send(.tick, at: 8)
    #expect(machine.holdsBackgroundGeneration)  // closing: generacja jeszcze się zamyka
    _ = machine.send(.closed(generation: 1), at: 8.5)
    #expect(machine.state == .idle)
    #expect(!machine.holdsBackgroundGeneration)

    var back = Machine.ready()
    _ = back.send(.scene(.background), at: 0)
    _ = back.send(.scene(.inactive), at: 1)
    #expect(!back.holdsBackgroundGeneration, "scena poza tłem: proces nie stoi")

    var idle = Machine.foreground()
    _ = idle.send(.scene(.background), at: 0)
    #expect(!idle.holdsBackgroundGeneration, "bez generacji nie ma czego trzymać")
  }

  @Test("praca w tle w backgroundGrace przenosi do backgroundWork")
  func graceToWork() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    #expect(machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 2).isEmpty)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(machine.works == [p1: F.at(30)])
  }

  @Test("koniec backgroundGrace: closing(background) i close")
  func graceElapsed() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    #expect(machine.send(.tick, at: 7.9).isEmpty)
    #expect(machine.send(.tick, at: 8) == [.close(generation: 1)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
  }

  @Test("system zabrał czas w tle: łaska zamyka się od razu, przed terminem; praca w tle bez zmian")
  func backgroundTimeExpired() {
    var grace = Machine.ready()
    _ = grace.send(.scene(.background), at: 0)
    #expect(grace.send(.backgroundTimeExpired, at: 2) == [.close(generation: 1)])
    #expect(grace.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
    #expect(grace.send(.tick, at: 8).isEmpty)  // termin po wygaśnięciu niczego nie zamyka drugi raz

    var work = Machine.ready()
    _ = work.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0)
    _ = work.send(.scene(.background), at: 0)
    #expect(work.send(.backgroundTimeExpired, at: 2).isEmpty)
    #expect(work.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(work.grace == nil)  // łaska tego pobytu w tle przepada razem z czasem systemu
    // koniec ostatniej pracy przed terminem 8 s zamyka generację zamiast wracać do łaski bez zadania systemu
    #expect(work.send(.backgroundWorkFinished(p1), at: 3) == [.close(generation: 1)])
    #expect(work.state == .closing(.init(generation: 1, reason: .background, waiters: [])))

    // następne zejście w tło ma znów pełną łaskę
    var again = Machine.ready()
    _ = again.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0)
    _ = again.send(.scene(.background), at: 0)
    _ = again.send(.backgroundTimeExpired, at: 1)
    _ = again.send(.scene(.active), at: 2)
    _ = again.send(.scene(.background), at: 3)
    #expect(again.grace == .init(generation: 1, until: F.at(11)))
    #expect(again.send(.backgroundWorkFinished(p1), at: 4) == [.schedule(at: F.at(11))])
  }

  @Test("powrót na pierwszy plan z backgroundGrace i backgroundWork: ta sama generacja, prace zostają")
  func backToForeground() {
    var grace = Machine.ready()
    _ = grace.send(.scene(.background))
    #expect(grace.send(.scene(.active)).isEmpty)
    #expect(grace.state == .ready(generation: 1, choice: .iroh))

    var work = Machine.ready()
    _ = work.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = work.send(.scene(.background))
    #expect(work.send(.scene(.active)).isEmpty)
    #expect(work.state == .ready(generation: 1, choice: .iroh))
    #expect(work.works == [p1: F.at(30)])
  }

  @Test("koniec nieostatniej pracy: bez zmian; ostatniej w chwili terminu łaski albo po nim: closing(background)")
  func lastWorkEnds() {
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = machine.send(.backgroundWorkStarted(p2, expiresAt: F.at(40)))
    _ = machine.send(.scene(.background))
    #expect(machine.send(.backgroundWorkFinished(p1), at: 1).isEmpty)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(machine.send(.backgroundWorkExpired(p2), at: 9) == [.close(generation: 1)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))

    var atDeadline = Machine.ready()
    _ = atDeadline.send(.scene(.background), at: 0)
    _ = atDeadline.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 1)
    #expect(atDeadline.send(.tick, at: 8).isEmpty)  // tick terminu w backgroundWork niczego nie zamyka
    #expect(atDeadline.send(.backgroundWorkFinished(p1), at: 8) == [.close(generation: 1)])
    #expect(atDeadline.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
  }

  @Test("tło bez pracy, praca, koniec po 3 s: backgroundGrace z pierwotnym terminem, tick po nim zamyka")
  func workEndsWithinGrace() {
    var machine = Machine.ready()
    #expect(machine.send(.scene(.background), at: 0) == [.schedule(at: F.at(8))])
    #expect(machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0.2).isEmpty)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(machine.send(.backgroundWorkFinished(p1), at: 3) == [.schedule(at: F.at(8))])
    #expect(machine.state == .backgroundGrace(generation: 1, choice: .iroh, until: F.at(8)))
    // Następna praca w tej samej łasce nie przesuwa terminu.
    #expect(machine.send(.backgroundWorkStarted(p2, expiresAt: F.at(30)), at: 4).isEmpty)
    #expect(machine.send(.backgroundWorkFinished(p2), at: 5) == [.schedule(at: F.at(8))])
    #expect(machine.state == .backgroundGrace(generation: 1, choice: .iroh, until: F.at(8)))
    #expect(machine.send(.tick, at: 7.9).isEmpty)
    #expect(machine.send(.tick, at: 8) == [.close(generation: 1)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
  }

  @Test("tło z pracą po zejściu z ready: koniec ostatniej pracy przed upływem 8 s → backgroundGrace z tym terminem")
  func workFromForegroundEndsWithinGrace() {
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 1)
    #expect(machine.send(.scene(.background), at: 2).isEmpty)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(machine.send(.backgroundWorkFinished(p1), at: 9.9) == [.schedule(at: F.at(10))])
    #expect(machine.state == .backgroundGrace(generation: 1, choice: .iroh, until: F.at(10)))
    #expect(machine.send(.tick, at: 10) == [.close(generation: 1)])
  }

  @Test("wygaśnięcie ostatniej pracy przed terminem łaski: jak koniec, backgroundGrace")
  func workExpiresWithinGrace() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background), at: 0)
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(5)), at: 1)
    #expect(machine.send(.backgroundWorkExpired(p1), at: 5) == [.schedule(at: F.at(8))])
    #expect(machine.state == .backgroundGrace(generation: 1, choice: .iroh, until: F.at(8)))
    #expect(machine.works.isEmpty)
  }

  @Test("bez terminu łaski z zejścia w tło z ready (generacja otwarta w tle dla pracy, też po utracie połączenia): koniec zamyka")
  func noGraceWithoutReadyInForeground() {
    var opened = Machine.foreground()
    _ = opened.send(.scene(.background), at: 0)
    _ = opened.send(.backgroundWorkStarted(p1, expiresAt: F.at(20)), at: 1)
    _ = opened.send(.opened(generation: 1), at: 2)
    _ = opened.send(.probeFinished(generation: 1, .http(status: 200)), at: 2)
    #expect(opened.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(opened.send(.backgroundWorkFinished(p1), at: 3) == [.close(generation: 1)])

    // Termin łaski należy do generacji, która zeszła w tło gotowa; następna generacja go nie dziedziczy.
    var lost = Machine.ready()
    _ = lost.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0)
    _ = lost.send(.scene(.background), at: 0)
    _ = lost.send(.connectionLost(generation: 1), at: 1)
    _ = lost.send(.closed(generation: 1), at: 1)
    _ = lost.send(.opened(generation: 2), at: 2)
    _ = lost.send(.probeFinished(generation: 2, .http(status: 200)), at: 2)
    #expect(lost.state == .backgroundWork(generation: 2, choice: .iroh))
    #expect(lost.send(.backgroundWorkFinished(p1), at: 3) == [.close(generation: 2)])
  }

  @Test("powrót na pierwszy plan w łasce po końcu pracy: ready z tą samą generacją, bez otwarcia")
  func returnInGraceAfterWork() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background), at: 0)
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0.2)
    _ = machine.send(.backgroundWorkFinished(p1), at: 3)
    var commands = machine.send(.scene(.inactive), at: 4)
    commands += machine.send(.scene(.active), at: 4)
    commands += machine.send(.demand(w2), at: 4)
    #expect(commands == [.release([w2], .ready(generation: 1))])
    #expect(machine.state == .ready(generation: 1, choice: .iroh))
    #expect(machine.lastGeneration == 1)
    #expect(machine.send(.tick, at: 8).isEmpty)  // termin łaski po powrocie niczego nie zamyka
    #expect(machine.state == .ready(generation: 1, choice: .iroh))
  }

  @Test("powrót po terminie łaski bez ticka (proces stał): close, popyt dostaje nową generację, nie ready(1)")
  func returnAfterGraceDeadline() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background), at: 0)
    var commands = machine.send(.scene(.inactive), at: 20)
    commands += machine.send(.scene(.active), at: 20)
    #expect(commands == [.close(generation: 1)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
    #expect(machine.send(.demand(w2), at: 20).isEmpty)  // czeka na następną generację
    #expect(machine.send(.tick, at: 20).isEmpty)  // zaległy tick po powrocie nie zamyka drugi raz
    #expect(machine.send(.closed(generation: 1), at: 21)
      == [.rebindEndpoint(.policy), .open(generation: 2, choice: .https, budget: .seconds(15)),
          .schedule(at: F.at(36))])
    #expect(machine.send(.opened(generation: 2), at: 21) == [.probe(generation: 2)])
    #expect(machine.send(.probeFinished(generation: 2, .http(status: 200)), at: 21)
      == [.release([w2], .ready(generation: 2))])
    #expect(machine.state == .ready(generation: 2, choice: .https))
  }

  @Test("granica terminu łaski: przed nim ready(g), w chwili terminu close; zaległy tick przed sceną też")
  func graceDeadlineBoundary() {
    var before = Machine.ready()
    _ = before.send(.scene(.background), at: 0)
    #expect(before.send(.scene(.active), at: 7.9).isEmpty)
    #expect(before.state == .ready(generation: 1, choice: .iroh))

    var atDeadline = Machine.ready()
    _ = atDeadline.send(.scene(.background), at: 0)
    #expect(atDeadline.send(.scene(.active), at: 8) == [.close(generation: 1)])
    #expect(atDeadline.state == .closing(.init(generation: 1, reason: .background, waiters: [])))

    // Wyścig przy wznowieniu: zaległy tick przed sceną daje ten sam stan i jedno `close`.
    var tickFirst = Machine.ready()
    _ = tickFirst.send(.scene(.background), at: 0)
    var commands = tickFirst.send(.tick, at: 20)
    commands += tickFirst.send(.scene(.active), at: 20)
    #expect(commands == [.close(generation: 1)])
    #expect(tickFirst.state == atDeadline.state)

    // Praca trzyma generację: powrót po terminie łaski z `backgroundWork` daje tę samą generację.
    var work = Machine.ready()
    _ = work.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0)
    _ = work.send(.scene(.background), at: 0)
    #expect(work.send(.scene(.active), at: 20).isEmpty)
    #expect(work.state == .ready(generation: 1, choice: .iroh))
  }

  @Test("koniec pracy o nieznanym id: bez zmian")
  func unknownWork() {
    for var machine in [Machine.foreground(), .opening(), .ready()] {
      let before = machine.state
      #expect(machine.send(.backgroundWorkFinished(p2)).isEmpty)
      #expect(machine.send(.backgroundWorkExpired(p2)).isEmpty)
      #expect(machine.state == before)
    }
  }

  @Test("praca w tle w idle i cooldown otwiera generację w budżecie pracy; na pierwszym planie tylko zapis")
  func workOpensInBackground() {
    var idle = Machine.foreground()
    _ = idle.send(.scene(.background))
    let commands = idle.send(.backgroundWorkStarted(p1, expiresAt: F.at(10)), at: 0)
    #expect(commands == [.open(generation: 1, choice: .iroh, budget: .seconds(10)), .schedule(at: F.at(10))])

    var cooldown = Machine.opening(F.httpsOnly)
    _ = cooldown.send(.openFailed(generation: 1, .timedOut))
    _ = cooldown.send(.closed(generation: 1))
    _ = cooldown.send(.scene(.background))
    guard case .cooldown = cooldown.state else { Issue.record("nie cooldown"); return }
    #expect(cooldown.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0.5)
      == [.open(generation: 2, choice: .https, budget: .seconds(15)), .schedule(at: F.at(15.5))])

    var foreground = Machine.foreground()
    #expect(foreground.send(.backgroundWorkStarted(p1, expiresAt: F.at(30))).isEmpty)
    #expect(foreground.state == .idle)
    #expect(foreground.works == [p1: F.at(30)])
  }

  // MARK: - Sieć, utrata, zamykanie

  @Test("zmiana sieci w żywej generacji: closing(network), close, pamięć porażki czyszczona")
  func networkChanged() {
    var machine = Machine.opening()
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    _ = machine.send(.tick, at: 2)
    _ = machine.send(.demand(w2), at: 2)
    _ = machine.send(.opened(generation: 2), at: 2)
    _ = machine.send(.probeFinished(generation: 2, .http(status: 200)), at: 2)
    #expect(machine.state == .ready(generation: 2, choice: .https))
    #expect(machine.memory.retryIrohAt != nil)
    #expect(machine.send(.networkChanged, at: 3) == [.close(generation: 2)])
    #expect(machine.state == .closing(.init(generation: 2, reason: .network, waiters: [])))
    #expect(machine.memory.retryIrohAt == nil)

    var grace = Machine.ready()
    _ = grace.send(.scene(.background))
    #expect(grace.send(.networkChanged) == [.close(generation: 1)])
    #expect(grace.state == .closing(.init(generation: 1, reason: .network, waiters: [])))
  }

  @Test("utrata połączenia i termin abort w żywej generacji: closing(lost), close")
  func connectionLost() {
    var ready = Machine.ready()
    #expect(ready.send(.connectionLost(generation: 1)) == [.close(generation: 1)])
    #expect(ready.state == .closing(.init(generation: 1, reason: .lost, waiters: [])))

    var work = Machine.ready()
    _ = work.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = work.send(.scene(.background))
    #expect(work.send(.abortTimedOut(generation: 1)) == [.close(generation: 1)])
    #expect(work.state == .closing(.init(generation: 1, reason: .lost, waiters: [])))
  }

  @Test("popyt w closing: dopisany czekający; w closing(failed) od razu offline")
  func demandWhileClosing() {
    var closing = Machine.ready()
    _ = closing.send(.networkChanged)
    #expect(closing.send(.demand(w1)).isEmpty)
    #expect(closing.state == .closing(.init(generation: 1, reason: .network, waiters: [w1])))

    var failed = Machine.opening()
    _ = failed.send(.openFailed(generation: 1, .timedOut))
    #expect(failed.send(.demand(w2)) == [.release([w2], .offline)])
    #expect(failed.state == .closing(.init(generation: 1, reason: .failed, waiters: [])))
  }

  @Test("closed z popytem po tle: rebindEndpoint przed open, HTTPS przy obu trasach, czekający w nowej próbie")
  func closedWithDemand() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    _ = machine.send(.tick, at: 8)
    _ = machine.send(.scene(.active), at: 9)
    _ = machine.send(.demand(w2), at: 9)
    let commands = machine.send(.closed(generation: 1), at: 10)
    #expect(commands == [.rebindEndpoint(.policy), .open(generation: 2, choice: .https, budget: .seconds(15)),
                         .schedule(at: F.at(25))])
    #expect(machine.lease == .rebinding)
    #expect(machine.state == .opening(.init(generation: 2, since: F.at(10), choice: .https, deadline: F.at(25),
                                             waiters: [w2])))
  }

  @Test("closed z popytem w tle: budżet do terminu najdłuższej pracy")
  func budgetInBackground() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    _ = machine.send(.tick, at: 8)
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(14)), at: 9)
    let commands = machine.send(.closed(generation: 1), at: 10)
    #expect(commands == [.rebindEndpoint(.policy), .open(generation: 2, choice: .https, budget: .seconds(4)),
                         .schedule(at: F.at(14))])
  }

  @Test("closed bez popytu: idle; rebindEndpoint tylko po tle i sieci przy rebindOnReturn")
  func closedWithoutDemand() {
    var network = Machine.ready()
    _ = network.send(.networkChanged)
    #expect(network.send(.closed(generation: 1)) == [.rebindEndpoint(.policy)])
    #expect(network.state == .idle)

    var lost = Machine.ready()
    _ = lost.send(.connectionLost(generation: 1))
    #expect(lost.send(.closed(generation: 1)).isEmpty)
    #expect(lost.state == .idle)

    var reuse = Machine.ready(policy: .reuse)
    _ = reuse.send(.networkChanged)
    #expect(reuse.send(.closed(generation: 1)).isEmpty)
    #expect(reuse.state == .idle)
    #expect(reuse.lease == .ready)
  }

  @Test("cooldown: tick po terminie do idle, popyt dostaje offline, praca w tle od razu otwiera")
  func cooldown() {
    var machine = Machine.opening()
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    #expect(machine.state == .cooldown(until: F.at(1)))
    #expect(machine.send(.demand(w2), at: 0.5) == [.release([w2], .offline)])
    #expect(machine.send(.tick, at: 0.9).isEmpty)
    #expect(machine.send(.tick, at: 1) == [])
    #expect(machine.state == .idle)

    var background = Machine.opening()
    _ = background.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = background.send(.openFailed(generation: 1, .timedOut))
    _ = background.send(.closed(generation: 1))
    _ = background.send(.scene(.background), at: 0.5)
    #expect(background.send(.tick, at: 1)
      == [.open(generation: 2, choice: .https, budget: .seconds(15)), .schedule(at: F.at(16))])
  }

  @Test("cooldown tylko-iroh kończy leaseChanged(ready)")
  func cooldownLeaseReady() {
    var machine = Machine.foreground(F.irohOnly, lease: .unavailable)
    #expect(machine.send(.demand(w1)) == [.schedule(at: F.at(1)), .release([w1], .offline)])
    #expect(machine.state == .cooldown(until: F.at(1)))
    #expect(machine.send(.leaseChanged(.ready), at: 0.2).isEmpty)
    #expect(machine.state == .idle)
    #expect(machine.send(.demand(w2), at: 0.3)
      == [.open(generation: 1, choice: .iroh, budget: .seconds(30)), .schedule(at: F.at(30.3))])
  }

  // MARK: - Koniec życia i trasy

  @Test("retire: czekający cancelled, żywa generacja close, częściowa discard, prace czyszczone, lease bez zmian")
  func retire() {
    var ready = Machine.ready()
    _ = ready.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    #expect(ready.send(.retire) == [.close(generation: 1)])
    #expect(ready.state == .retired)
    #expect(ready.works.isEmpty)
    #expect(ready.lease == .ready)

    var opening = Machine.opening()
    #expect(opening.send(.retire) == [.release([w1], .cancelled), .discard(generation: 1)])
    #expect(opening.state == .retired)

    var closing = Machine.ready()
    _ = closing.send(.networkChanged)
    _ = closing.send(.demand(w2))
    #expect(closing.send(.retire) == [.release([w2], .cancelled)])
  }

  @Test("credentialChanged: stan bez zmian, nowe trasy dla następnej generacji")
  func credentialChanged() {
    var machine = Machine.ready()
    #expect(machine.send(.credentialChanged(F.httpsOnly)).isEmpty)
    #expect(machine.state == .ready(generation: 1, choice: .iroh))
    #expect(machine.routes == F.httpsOnly)
    _ = machine.send(.connectionLost(generation: 1))
    _ = machine.send(.closed(generation: 1))
    #expect(machine.send(.demand(w2), at: 1)
      == [.open(generation: 2, choice: .https, budget: .seconds(15)), .schedule(at: F.at(16))])
  }

  @Test("wybór transportu z tras, stanu lease i pamięci porażki iroh")
  func transportChoice() {
    func choice(_ routes: Machine.Routes, lease: LeaseReadiness, retryAt: Double? = nil, now: Double = 0)
      -> TransportChoice? {
      var machine = Machine(routes: routes, lease: lease)
      if let retryAt {
        // Pamięć porażki przez nieudaną próbę iroh w chwili retryAt − 120 s; without HTTPS the first pause of the
        // iroh-only series (1 s).
        let failedAt = retryAt - (routes.hasHTTPS ? 120 : 1)
        _ = machine.send(.scene(.active), at: failedAt)
        _ = machine.send(.demand(w1), at: failedAt)
        _ = machine.send(.openFailed(generation: 1, .timedOut), at: failedAt)
        #expect(machine.memory.retryIrohAt == F.at(retryAt))
      }
      return machine.choice(now: F.at(now))
    }
    #expect(choice(F.both, lease: .ready) == .iroh)
    #expect(choice(F.irohOnly, lease: .ready) == .iroh)
    #expect(choice(F.both, lease: .ready, retryAt: 120, now: 120) == .iroh)
    #expect(choice(F.both, lease: .rebinding) == .https)
    #expect(choice(F.both, lease: .ready, retryAt: 120, now: 119) == .https)
    #expect(choice(F.httpsOnly, lease: .ready) == .https)
    #expect(choice(F.httpsOnly, lease: .unavailable) == .https)
    #expect(choice(F.irohOnly, lease: .unavailable) == nil)
    #expect(choice(F.irohOnly, lease: .ready, retryAt: 120, now: 119) == nil)
    // tożsamość niedostępna to lease unavailable
    #expect(choice(F.both, lease: .unavailable) == .https)
    #expect(choice(F.irohOnly, lease: .rebinding) == .iroh)
    #expect(choice(F.irohOnly, lease: .rebinding, retryAt: 120, now: 119) == nil)

    // an HTTPS generation lives past retryIrohAt (after its probe)
    var https = Machine.opening()
    _ = https.send(.openFailed(generation: 1, .timedOut))
    _ = https.send(.closed(generation: 1))
    _ = https.send(.tick, at: 1)
    _ = https.send(.demand(w2), at: 1)
    _ = https.send(.opened(generation: 2), at: 1)
    _ = https.send(.probeFinished(generation: 2, .http(status: 200)), at: 1)
    #expect(https.send(.tick, at: 200).isEmpty)
    #expect(https.state == .ready(generation: 2, choice: .https))

    // zmiana sieci czyści pamięć, więc następna generacja próbuje iroh od razu
    var network = Machine.opening()
    _ = network.send(.openFailed(generation: 1, .timedOut))
    _ = network.send(.networkChanged, at: 0.1)
    #expect(network.choice(now: F.at(0.2)) == .iroh)
  }

  @Test("an HTTPS generation of an HTTPS-only credential: ready after opening, without a probe")
  func httpsWithoutProbe() {
    var machine = Machine.opening(F.httpsOnly)
    #expect(machine.send(.opened(generation: 1)) == [.release([w1], .ready(generation: 1))])
    #expect(machine.state == .ready(generation: 1, choice: .https))
  }

  @Test("closed po closing(failed): cooldown 1 s bez nowej próby mimo popytu")
  func failedClosed() {
    var machine = Machine.opening()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = machine.send(.openFailed(generation: 1, .timedOut), at: 2)
    #expect(machine.send(.closed(generation: 1), at: 3) == [.schedule(at: F.at(4))])
    #expect(machine.state == .cooldown(until: F.at(4)))
  }

  @Test("retired: popyt cancelled, wyniki discard, reszta pomijana, nigdy open")
  func retired() {
    var machine = Machine.ready()
    _ = machine.send(.retire)
    var commands: [Machine.Command] = []
    commands += machine.send(.demand(w2))
    commands += machine.send(.scene(.background))
    commands += machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    commands += machine.send(.networkChanged)
    commands += machine.send(.leaseChanged(.ready))
    commands += machine.send(.credentialChanged(F.httpsOnly))
    commands += machine.send(.tick, at: 100)
    commands += machine.send(.opened(generation: 1))
    commands += machine.send(.closed(generation: 1))
    #expect(commands == [.release([w2], .cancelled), .discard(generation: 1), .discard(generation: 1)])
    #expect(machine.state == .retired)
    #expect(machine.works.isEmpty)
    #expect(machine.routes == F.both)
  }

  @Test("próba w tle: koniec ostatniej pracy zamyka ją przez discard i offline")
  func attemptInBackgroundLosesWork() {
    var machine = Machine.foreground()
    _ = machine.send(.scene(.background))
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(10)))
    _ = machine.send(.demand(w1))
    #expect(machine.send(.backgroundWorkExpired(p1)) == [.discard(generation: 1), .release([w1], .offline)])
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))

    var probing = Machine.probing()
    _ = probing.send(.backgroundWorkStarted(p1, expiresAt: F.at(10)))
    _ = probing.send(.scene(.background))
    #expect(probing.send(.backgroundWorkFinished(p1)) == [.discard(generation: 1), .release([w1], .offline)])
  }

  @Test("praca rozpoczęta w closing: zapis, a po closed nowa próba w budżecie tej pracy")
  func workStartedWhileClosing() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    _ = machine.send(.tick, at: 8)
    #expect(machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(20)), at: 9).isEmpty)
    #expect(machine.state == .closing(.init(generation: 1, reason: .background, waiters: [])))
    #expect(machine.send(.closed(generation: 1), at: 10)
      == [.rebindEndpoint(.policy), .open(generation: 2, choice: .https, budget: .seconds(10)),
          .schedule(at: F.at(20))])
  }

  // MARK: - Sekwencje

  @Test("praca rozpoczęta przed zejściem w tło i po nim trzyma generację do końca ostatniej")
  func workBeforeAndAfterBackground() {
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 1)
    _ = machine.send(.scene(.background), at: 2)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    _ = machine.send(.backgroundWorkStarted(p2, expiresAt: F.at(40)), at: 3)
    #expect(machine.send(.backgroundWorkFinished(p1), at: 5).isEmpty)
    #expect(machine.send(.tick, at: 10).isEmpty)  // termin łaski minął, ale praca p2 trwa
    #expect(machine.send(.backgroundWorkFinished(p2), at: 16) == [.close(generation: 1)])
  }

  @Test("token Live Activity 10 s po zejściu w tło otwiera jedną generację w granicach terminu")
  func liveActivityTokenAfterGrace() {
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    _ = machine.send(.tick, at: 8)
    _ = machine.send(.closed(generation: 1), at: 8.1)
    #expect(machine.state == .idle)
    let commands = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(22)), at: 10)
    #expect(commands == [.open(generation: 2, choice: .https, budget: .seconds(12)), .schedule(at: F.at(22))])
    #expect(Machine.opens(machine.send(.backgroundWorkStarted(p2, expiresAt: F.at(25)), at: 10.5)) == 0)
  }

  @Test("zapis notatki z pierwszego planu trwa 20 s w tle: generacja żyje do końca zapisu")
  func noteSaveLastsInBackground() {
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 0)
    _ = machine.send(.scene(.background), at: 1)
    #expect(machine.send(.tick, at: 9).isEmpty)
    #expect(machine.send(.tick, at: 20).isEmpty)
    #expect(machine.state == .backgroundWork(generation: 1, choice: .iroh))
    #expect(machine.send(.backgroundWorkFinished(p1), at: 21) == [.close(generation: 1)])
  }

  @Test("powrót na pierwszy plan w trakcie closing(background): obie trasy → HTTPS, tylko iroh → iroh po rebind")
  func returnDuringBackgroundClosing() {
    for (routes, expected, budget) in [(F.both, TransportChoice.https, 15), (F.irohOnly, .iroh, 30)] {
      var machine = Machine.ready(routes)
      _ = machine.send(.scene(.background))
      _ = machine.send(.tick, at: 8)
      _ = machine.send(.scene(.active), at: 8.5)
      _ = machine.send(.demand(w2), at: 8.5)
      let commands = machine.send(.closed(generation: 1), at: 9)
      #expect(commands.first == .rebindEndpoint(.policy))
      #expect(commands.dropFirst().first == .open(generation: 2, choice: expected, budget: .seconds(budget)))
    }
  }

  @Test("utrata połączenia w backgroundWork z pracą: nowa próba do końca terminu pracy, bez rebind")
  func lostInBackgroundWork() {
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(25)))
    _ = machine.send(.scene(.background))
    _ = machine.send(.connectionLost(generation: 1), at: 12)
    let commands = machine.send(.closed(generation: 1), at: 13)
    #expect(commands == [.open(generation: 2, choice: .iroh, budget: .seconds(12)), .schedule(at: F.at(25))])
  }

  @Test("stary transport po retire (parowanie z drugim serwerem): popyt cancelled, licznik open bez zmian")
  func retiredAfterPairingOtherServer() {
    var machine = Machine.ready()
    var commands = machine.send(.retire)
    for raw in 10..<20 { commands += machine.send(.demand(F.waiter(UInt64(raw))), at: 1) }
    commands += machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)), at: 1)
    commands += machine.send(.scene(.active), at: 1)
    #expect(Machine.opens(commands) == 0)
    #expect(machine.lastGeneration == 1)
    #expect(commands.filter { $0 == .release([F.waiter(10)], .cancelled) }.count == 1)
  }

  @Test("5 kolejnych nieudanych sond: po każdej discard, cooldown i nowa generacja")
  func fiveFailedProbes() {
    var machine = Machine.foreground(F.irohOnly)
    var now = 0.0
    for round in 1...5 {
      let gen = UInt64(round)
      _ = machine.send(.networkChanged, at: now)  // pamięć porażki czyszczona, więc znowu iroh
      #expect(machine.send(.demand(F.waiter(gen)), at: now).first
        == .open(generation: gen, choice: .iroh, budget: .seconds(30)))
      _ = machine.send(.opened(generation: gen), at: now)
      let failed = machine.send(.probeFinished(generation: gen, .transport), at: now + 1)
      #expect(failed == [.discard(generation: gen), .release([F.waiter(gen)], .offline), .reportIroh(success: false)])
      #expect(machine.send(.closed(generation: gen), at: now + 2) == [.schedule(at: F.at(now + 3))])
      _ = machine.send(.tick, at: now + 3)
      #expect(machine.state == .idle)
      now += 10
    }
    #expect(machine.lastGeneration == 5)
  }

  @Test("log wymienia nieudaną generację i powód")
  func logsFailure() {
    var machine = Machine.opening()
    let commands = machine.sendLogged(.openFailed(generation: 1, .connectFailed("x")))
    #expect(commands.contains {
      if case .log(let line) = $0 { return line.contains("generation 1") && line.contains("failed") }
      return false
    })
  }

  // MARK: - Seria ponowień tylko-iroh i alarmy

  @Test("tylko-iroh na wierzchu: porażki dają ponowienia po 1, 2, 4, 8 s, potem co 15 s; w przerwie offline")
  func a1RetrySeries() {
    var machine = Machine.foreground(F.irohOnly)
    var now = 0.0
    for (index, delay) in [1.0, 2, 4, 8, 15, 15].enumerated() {
      let gen = UInt64(index + 1)
      #expect(machine.send(.demand(F.waiter(gen)), at: now).first
        == .open(generation: gen, choice: .iroh, budget: .seconds(30)), "próba \(gen)")
      _ = machine.send(.openFailed(generation: gen, .timedOut), at: now)
      #expect(machine.send(.closed(generation: gen), at: now) == [.schedule(at: F.at(now + delay))], "próba \(gen)")
      #expect(machine.state == .cooldown(until: F.at(now + delay)))
      let late = F.waiter(100 + gen)
      #expect(machine.send(.demand(late), at: now + delay - 0.1) == [.release([late], .offline)])
      #expect(machine.send(.tick, at: now + delay).isEmpty)
      #expect(machine.state == .idle)
      now += delay
    }
  }

  @Test("sukces i networkChanged zerują serię")
  func a1SeriesReset() {
    var machine = Machine.foreground(F.irohOnly)
    #expect(failIrohOnly(&machine, at: 0).until == F.at(1))
    #expect(failIrohOnly(&machine, at: 1).until == F.at(3))
    #expect(failIrohOnly(&machine, at: 3).until == F.at(7))
    // A network change in the pause ends it and starts the series over.
    #expect(machine.send(.networkChanged, at: 4).isEmpty)
    #expect(machine.state == .idle)
    #expect(failIrohOnly(&machine, at: 4).until == F.at(5))
    #expect(failIrohOnly(&machine, at: 5).until == F.at(7))
    succeedIrohOnly(&machine, at: 7)
    #expect(machine.send(.connectionLost(generation: 6), at: 8) == [.close(generation: 6)])
    _ = machine.send(.closed(generation: 6), at: 8)
    #expect(failIrohOnly(&machine, at: 9).until == F.at(10))
  }

  @Test("przerwa serii: leaseChanged(ready) jej nie kończy, spóźniony tick jej nie skraca")
  func a1PauseKeepsDeadline() {
    var machine = Machine.foreground(F.irohOnly)
    #expect(failIrohOnly(&machine, at: 0).until == F.at(1))
    #expect(failIrohOnly(&machine, at: 1).until == F.at(3))
    #expect(machine.send(.leaseChanged(.ready), at: 1.5).isEmpty)
    #expect(machine.state == .cooldown(until: F.at(3)))
    #expect(machine.send(.demand(w2), at: 1.6) == [.release([w2], .offline)])
    // A tick armed for an earlier deadline (the failed attempt's budget, the first pause) arrives late.
    #expect(machine.send(.tick, at: 2.9).isEmpty)
    #expect(machine.state == .cooldown(until: F.at(3)))
    #expect(machine.send(.tick, at: 3).isEmpty)
    #expect(machine.state == .idle)
    // The iroh-only cooldown that leaseChanged(ready) ends has no pause: the lease, not the series, kept iroh away.
    var unavailable = Machine.foreground(F.irohOnly, lease: .unavailable)
    _ = unavailable.send(.demand(w1))
    #expect(unavailable.send(.leaseChanged(.ready), at: 0.2).isEmpty)
    #expect(unavailable.state == .idle)
  }

  @Test("budżet próby: tylko-iroh na wierzchu 30 s; z HTTPS 15 s; w tle do terminu pracy, najwyżej 15 s")
  func a2AttemptBudget() {
    var irohOnly = Machine.foreground(F.irohOnly)
    #expect(irohOnly.send(.demand(w1)) == [.open(generation: 1, choice: .iroh, budget: .seconds(30)),
                                           .schedule(at: F.at(30))])
    _ = irohOnly.send(.opened(generation: 1), at: 1)
    #expect(irohOnly.send(.tick, at: 29.9).isEmpty)
    #expect(irohOnly.send(.tick, at: 30) == [.discard(generation: 1), .release([w1], .offline),
                                             .reportIroh(success: false)])

    var both = Machine.foreground(F.both)
    #expect(both.send(.demand(w1)).first == .open(generation: 1, choice: .iroh, budget: .seconds(15)))

    var background = Machine(routes: F.irohOnly)
    _ = background.send(.scene(.background))
    #expect(background.send(.backgroundWorkStarted(p1, expiresAt: F.at(40))).first
      == .open(generation: 1, choice: .iroh, budget: .seconds(15)))
    var short = Machine(routes: F.irohOnly)
    _ = short.send(.scene(.background))
    #expect(short.send(.backgroundWorkStarted(p1, expiresAt: F.at(6))).first
      == .open(generation: 1, choice: .iroh, budget: .seconds(6)))
  }

  @Test("tylko-iroh: porażka do dzierżawy najwyżej raz na 120 s")
  func a3ReportThrottle() {
    func reports(_ commands: [Machine.Command]) -> Int {
      commands.filter { $0 == .reportIroh(success: false) }.count
    }
    var quick = Machine.foreground(F.irohOnly)
    var commands: [Machine.Command] = []
    for now in [0.0, 1, 3] { commands += failIrohOnly(&quick, at: now).commands }
    #expect(quick.lastGeneration == 3)
    #expect(reports(commands) == 1, "trzy porażki w 60 s: jeden raport, więc bez rebind(.broken)")

    var slow = Machine.foreground(F.irohOnly)
    commands = []
    for now in [0.0, 120, 240] { commands += failIrohOnly(&slow, at: now).commands }
    #expect(reports(commands) == 3, "porażki co 120 s: raport po każdej, dzierżawa wiąże od nowa po trzeciej")

    var withHTTPS = Machine.opening(F.both)
    #expect(reports(withHTTPS.send(.openFailed(generation: 1, .timedOut))) == 1)
  }

  @Test("with HTTPS: an iroh failure gives HTTPS for 120 s or until a failed HTTPS attempt; iroh-only in the background without work: no attempts")
  func a4HTTPSAndBackground() {
    var both = Machine.opening(F.both)
    _ = both.send(.openFailed(generation: 1, .timedOut))
    #expect(both.memory.retryIrohAt == F.at(120))
    _ = both.send(.closed(generation: 1))
    _ = both.send(.tick, at: 1)
    #expect(both.send(.demand(w2), at: 1).first == .open(generation: 2, choice: .https, budget: .seconds(15)))
    #expect(both.choice(now: F.at(119)) == .https)
    #expect(both.choice(now: F.at(120)) == .iroh)

    var background = Machine.foreground(F.irohOnly)
    _ = failIrohOnly(&background, at: 0)
    _ = background.send(.scene(.background), at: 0.5)
    #expect(background.send(.tick, at: 1).isEmpty)
    #expect(background.state == .idle)
    #expect(background.send(.demand(w2), at: 2) == [.release([w2], .offline)])
    #expect(background.send(.tick, at: 20).isEmpty)
    #expect(background.lastGeneration == 1)
  }

  @Test("zamknięcie gotowej generacji iroh na wierzchu: alarm z numerem i powodem; w tle bez alarmu")
  func t1ForegroundCloseAlarm() {
    func closeLines(_ commands: [Machine.Command]) -> [String] {
      commands.compactMap {
        if case .log(let line) = $0, line.contains(" closed in foreground: ") { return line }
        return nil
      }
    }
    var network = Machine.ready()
    #expect(closeLines(network.sendLogged(.networkChanged)) == ["generation 1 (iroh) closed in foreground: network"])
    var lost = Machine.ready()
    #expect(closeLines(lost.sendLogged(.connectionLost(generation: 1)))
      == ["generation 1 (iroh) closed in foreground: lost"])
    var abort = Machine.ready()
    #expect(closeLines(abort.sendLogged(.abortTimedOut(generation: 1)))
      == ["generation 1 (iroh) closed in foreground: abort timed out"])
    var unasked = Machine.ready()
    #expect(closeLines(unasked.sendLogged(.closed(generation: 1)))
      == ["generation 1 (iroh) closed in foreground: lost, without a close command"])

    var grace = Machine.ready()
    _ = grace.send(.scene(.background))
    #expect(closeLines(grace.sendLogged(.networkChanged)).isEmpty)
    var work = Machine.ready()
    _ = work.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = work.send(.scene(.background))
    #expect(closeLines(work.sendLogged(.connectionLost(generation: 1))).isEmpty)
    var https = Machine.ready(F.httpsOnly)
    #expect(closeLines(https.sendLogged(.networkChanged)).isEmpty)
  }

  @Test("seria porażek tylko-iroh: dwie linie, pierwsza porażka z przyczyną i powrót po N próbach")
  func t2SeriesLines() {
    var machine = Machine.foreground(F.irohOnly)
    var lines: [String] = []
    func record(_ commands: [Machine.Command]) {
      for case .log(let line) in commands { lines.append(line) }
    }
    func attempt(at now: Double) {
      let gen = machine.lastGeneration + 1
      record(machine.sendLogged(.tick, at: now))
      record(machine.sendLogged(.demand(F.waiter(gen)), at: now))
      record(machine.sendLogged(.openFailed(generation: gen, .connectFailed("relay")), at: now))
      record(machine.sendLogged(.closed(generation: gen), at: now))
    }
    attempt(at: 0)
    attempt(at: 1)
    attempt(at: 3)
    record(machine.sendLogged(.networkChanged, at: 4))
    // The fourth attempt runs out of budget, as when its connection comes late: one failure of the series.
    record(machine.sendLogged(.demand(F.waiter(4)), at: 4))
    record(machine.sendLogged(.tick, at: 34))
    record(machine.sendLogged(.closed(generation: 4), at: 34))
    attempt(at: 35)
    record(machine.sendLogged(.tick, at: 37))
    record(machine.sendLogged(.demand(F.waiter(6)), at: 37))
    record(machine.sendLogged(.opened(generation: 6), at: 37))
    record(machine.sendLogged(.probeFinished(generation: 6, .http(status: 200)), at: 37.5))
    #expect(machine.state == .ready(generation: 6, choice: .iroh))
    #expect(lines == ["generation 1 (iroh) failed: open: connectFailed(\"relay\")",
                      "generation 6 (iroh) recovered after 5 attempts, 37 s"])
  }

  // MARK: - Stan początkowy

  @Test("stan początkowy: lease unavailable przy obu trasach daje pierwszą generację HTTPS")
  func initialUnavailableLeaseOpensHTTPS() {
    var machine = Machine(routes: F.both, lease: .unavailable, scene: .active)
    let commands = machine.send(.demand(w1))
    #expect(commands.first == .open(generation: 1, choice: .https, budget: .seconds(15)))
  }

  @Test("stan początkowy: praca w tle od startu, koniec pracy zostawia idle bez prac")
  func initialWorkEndedLeavesIdle() {
    var machine = Machine(routes: F.both, scene: .background, works: [p1: F.at(30)])
    #expect(machine.hasDemand)
    #expect(machine.send(.backgroundWorkFinished(p1)) == [])
    #expect(machine.state == .idle)
    #expect(machine.works.isEmpty)
    #expect(machine.send(.demand(w1)) == [.release([w1], .offline)])  // jak popyt w tle bez pracy
  }

  @Test("stan początkowy: praca w tle od startu i powtórzony jej start jak po zdarzeniach")
  func initialWorkMatchesEvents() {
    var initial = Machine(routes: F.both, scene: .background, works: [p1: F.at(30)])
    var events = Machine(routes: F.both)
    _ = events.send(.scene(.background))
    let fromEvents = events.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    #expect(initial.send(.backgroundWorkStarted(p1, expiresAt: F.at(30))) == fromEvents)
    #expect(initial.state == events.state)
    #expect(initial.works == events.works)
  }
}

/// Iroh-only attempt that fails at `now` (open failure, then `closed`); a `tick` first ends a pause that is over.
/// `until` is the end of the pause after the failure, `nil` when no attempt opened.
private func failIrohOnly(_ machine: inout Machine, at now: Double)
  -> (until: Machine.Instant?, commands: [Machine.Command]) {
  var commands = machine.send(.tick, at: now)
  let gen = machine.lastGeneration + 1
  commands += machine.send(.demand(F.waiter(gen)), at: now)
  guard machine.currentGeneration == gen else { return (nil, commands) }
  commands += machine.send(.openFailed(generation: gen, .timedOut), at: now)
  commands += machine.send(.closed(generation: gen), at: now)
  guard case .cooldown(let until) = machine.state else { return (nil, commands) }
  return (until, commands)
}

/// Iroh-only attempt that gets ready at `now`.
private func succeedIrohOnly(_ machine: inout Machine, at now: Double) {
  _ = machine.send(.tick, at: now)
  let gen = machine.lastGeneration + 1
  _ = machine.send(.demand(F.waiter(gen)), at: now)
  _ = machine.send(.opened(generation: gen), at: now)
  _ = machine.send(.probeFinished(generation: gen, .http(status: 200)), at: now)
}

// MARK: - Server restart with the app in the foreground

extension TunnelMachineTests {
  @Test("restart in the foreground, HTTPS and iroh, HTTPS dead: the failed HTTPS probe ends the iroh pause, iroh is back within 40 s on the same endpoint")
  func restartForegroundBothRoutes() {
    var world = RestartWorld(RestartWorld.Script())
    world.run()
    let back = world.readyAt.first { $0.at > world.script.down && $0.choice == .iroh }
    #expect(back.map { $0.at <= 40 } == true, "iroh ready at \(back?.at ?? -1) s\n\(world.trace)")
    guard case .ready(_, .iroh) = world.machine.state else {
      Issue.record("not ready over iroh at the end\n\(world.trace)")
      return
    }
    #expect(world.binds == [0], "the endpoint from before the restart reconnects (measured live: 67 ms)")
    #expect(world.machineLog.contains { $0.contains(" (https) failed: probe: transport error") }, "\(world.trace)")
  }

  @Test("restart in the foreground, HTTPS and iroh, then a hide: iroh before the hide; under backgroundGrace the same generation, longer a fresh endpoint and iroh again",
        arguments: [(60.0, 5.0, false), (60, 20, false), (200, 5, false), (200, 20, false), (200, 20, true)])
  func restartForegroundWithHide(at: Double, hidden: Double, staleEndpointFails: Bool) {
    var script = RestartWorld.Script(staleEndpointFails: staleEndpointFails)
    script.scenes = [(at, .background), (at + hidden, .active)]
    var world = RestartWorld(script)
    world.run()
    let back = at + hidden
    guard case let .ready(generation, .iroh) = world.machine.state else {
      Issue.record("not ready over iroh at the end\n\(world.trace)")
      return
    }
    if hidden < 8 {
      #expect(generation == world.readyAt.last { $0.at < at }?.gen, "M16: the same generation\n\(world.trace)")
      #expect(world.binds == [0], "\(world.trace)")
    } else {
      #expect((world.binds.last ?? 0) >= back, "a fresh endpoint after the policy rebind\n\(world.trace)")
    }
  }

  @Test("restart in the foreground, iroh only (comparison): the retry series reconnects; a stale endpoint only after rebind(broken)",
        arguments: [false, true])
  func restartForegroundIrohOnly(staleEndpointFails: Bool) {
    var script = RestartWorld.Script(routes: F.irohOnly, staleEndpointFails: staleEndpointFails)
    script.end = 420
    var world = RestartWorld(script)
    world.run()
    guard case let .ready(_, choice) = world.machine.state else {
      Issue.record("not ready at the end\n\(world.trace)")
      return
    }
    #expect(choice == .iroh)
    if staleEndpointFails {
      #expect(world.binds.count == 2, "only the endpoint broken after three reported failures reconnects")
    } else {
      #expect(world.binds == [0])
      #expect(world.firstReady(after: 10) ?? .infinity < 45, "the first attempt after the server is back")
    }
  }

  @Test("HTTPS and iroh, both down for 5 min: attempts alternate, one failure line per route and a lease report at most every 120 s")
  func bothRoutesDown() {
    var script = RestartWorld.Script()
    script.up = 10_000
    var world = RestartWorld(script)
    world.run()
    let irohLines = world.machineLog.filter { $0.contains(" (iroh) failed: ") }
    let httpsLines = world.machineLog.filter { $0.contains(" (https) failed: ") }
    #expect(irohLines.count == 1, "\(world.trace)")
    #expect(httpsLines.count == 1, "\(world.trace)")
    #expect(world.connects.count > 3, "iroh is tried again after each failed HTTPS probe\n\(world.trace)")
    let reports = world.lines.filter { $0.contains("LEASE reportIroh(failure)") }.count
    #expect(reports <= 3, "today's rate: one report per irohRetryDelay\n\(world.trace)")
  }

  @Test("HTTPS and iroh, HTTPS answers: the HTTPS generation is probed, ready, keeps the iroh failure memory, no lease report and no line; it outlives the iroh retry time for 5 min")
  func httpsProbeReadyKeepsMemory() {
    var machine = Machine.opening(F.both)
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    _ = machine.send(.tick, at: 1)
    #expect(machine.send(.demand(w2), at: 1).first == .open(generation: 2, choice: .https, budget: .seconds(15)))
    #expect(machine.send(.opened(generation: 2), at: 1) == [.probe(generation: 2)])
    #expect(machine.sendLogged(.probeFinished(generation: 2, .http(status: 200)), at: 1.2)
      == [.release([w2], .ready(generation: 2))])
    #expect(machine.state == .ready(generation: 2, choice: .https))
    #expect(machine.memory.retryIrohAt == F.at(120))
    for now in stride(from: 10.0, through: 300, by: 10) { #expect(machine.send(.tick, at: now).isEmpty) }
    let w3 = F.waiter(3)
    #expect(machine.send(.demand(w3), at: 300) == [.release([w3], .ready(generation: 2))])
    #expect(machine.state == .ready(generation: 2, choice: .https))
  }

  @Test("HTTPS and iroh: the late probe result of an HTTPS generation closed at the attempt budget changes nothing in the next generation and releases no waiter again")
  func lateProbeOfClosedHTTPSGeneration() {
    var machine = Machine.opening(F.both)
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    _ = machine.send(.tick, at: 1)
    _ = machine.send(.demand(w2), at: 1)
    #expect(machine.send(.opened(generation: 2), at: 1) == [.probe(generation: 2)])
    #expect(machine.send(.tick, at: 16) == [.discard(generation: 2), .release([w2], .offline)])
    _ = machine.send(.closed(generation: 2), at: 16)
    _ = machine.send(.tick, at: 17)
    let w3 = F.waiter(3)
    #expect(machine.send(.demand(w3), at: 17) == [
      .open(generation: 3, choice: .iroh, budget: .seconds(15)), .schedule(at: F.at(32)),
    ])
    let opening = machine
    for outcome: Machine.ProbeOutcome in [.http(status: 200), .transport] {
      #expect(machine.sendLogged(.probeFinished(generation: 2, outcome), at: 17.5) == [.discard(generation: 2)])
      #expect(machine == opening, "\(outcome)")
    }
    #expect(machine.send(.opened(generation: 3), at: 18) == [.probe(generation: 3)])
    let probing = machine
    for outcome: Machine.ProbeOutcome in [.http(status: 200), .transport] {
      #expect(machine.sendLogged(.probeFinished(generation: 2, outcome), at: 18.1) == [.discard(generation: 2)])
      #expect(machine == probing, "\(outcome)")
    }
    #expect(machine.send(.probeFinished(generation: 3, .http(status: 200)), at: 18.2) == [
      .reportIroh(success: true), .release([w3], .ready(generation: 3)),
    ])
  }

  @Test("HTTPS and iroh, both down and the endpoint broken (iroh fails on it until a rebind): the limit of lease reports still reaches rebind(broken), and iroh is back on a fresh endpoint")
  func bothRoutesDownBrokenEndpoint() {
    var script = RestartWorld.Script(staleEndpointFails: true)
    script.end = 600
    var world = RestartWorld(script)
    world.run()
    // One cycle from one iroh failure to the next: the iroh attempt runs out its budget, and on each side of the
    // HTTPS attempt between them come a cooldown and at most two consumer retries of 8 s (a demand in the cooldown
    // gets `.offline`); 1 s covers the open, probe and close steps of the world. The first report comes within one
    // cycle after `down`, each next one after `irohRetryDelay` plus at most one cycle, and after the
    // `brokenAfterFailures`-th report one more cycle (an HTTPS attempt, then iroh on the fresh endpoint) gives a ready
    // iroh generation.
    let budget = Double(TunnelMachine.attemptBudget.components.seconds)
    let cooldown = Double(TunnelMachine.cooldown.components.seconds)
    let retry = Double(TunnelMachine.irohRetryDelay.components.seconds)
    let cycle = budget + 2 * (cooldown + 2 * 8) + 1
    let bound = script.down + cycle + Double(EndpointLease.brokenAfterFailures - 1) * (retry + cycle) + cycle
    let reports = world.lines.filter { $0.contains("LEASE reportIroh(failure)") }.count
    #expect(reports == EndpointLease.brokenAfterFailures, "\(world.trace)")
    #expect(world.lines.contains { $0.contains("LEASE: rebind (broken)") }, "\(world.trace)")
    #expect(world.binds.count == 2, "only the broken endpoint is replaced\n\(world.trace)")
    let back = world.readyAt.first { $0.at > (world.binds.last ?? .infinity) && $0.choice == .iroh }
    #expect(back.map { $0.at <= bound } == true, "iroh ready at \(back?.at ?? -1) s, bound \(bound) s\n\(world.trace)")
    guard case .ready(_, .iroh) = world.machine.state else {
      Issue.record("not ready over iroh at the end\n\(world.trace)")
      return
    }
  }
}
