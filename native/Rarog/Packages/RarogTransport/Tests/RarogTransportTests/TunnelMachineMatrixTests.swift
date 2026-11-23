import Foundation
@testable import RarogTransport
import Testing

// Macierz maszyny generacji: każda para stan × zdarzenie (9 × 18) ma w tabeli wynik — stan i polecenia (bez linii
// logu) — z wiersza M albo jawne „bez zmian, bez poleceń”. Para bez wpisu przewraca test. Stany wyjściowe powstają
// zdarzeniami w chwili 0 (trasy HTTPS + iroh, lease ready, scena active, o ile stan nie mówi inaczej); zdarzenie
// przychodzi w chwili 1, a `tick` w chwili 20 (po wszystkich terminach). The attempt states of an HTTPS generation with
// both routes differ only in their results, so those pairs have their own table (`httpsAttemptPairs`).

private typealias F = MachineFixture

private enum StateKind: String, CaseIterable {
  case idle, opening, probing, ready, backgroundGrace, backgroundWork, closing, cooldown, retired
}

private enum EventKind: String, CaseIterable {
  case demand, cancelWaiter, scene, workStarted, workFinished, workExpired, timeExpired, networkChanged, opened,
    probeFinished, openFailed, connectionLost, abortTimedOut, closed, leaseChanged, retire, credentialChanged, tick
}

private let w1 = F.waiter(1)
private let w2 = F.waiter(2)
private let p1 = F.work(1)
private let p2 = F.work(2)

private func fixture(_ kind: StateKind) -> Machine {
  switch kind {
  case .idle:
    return .foreground()
  case .opening:
    return .opening()
  case .probing:
    return .probing()
  case .ready:
    return .ready()
  case .backgroundGrace:
    var machine = Machine.ready()
    _ = machine.send(.scene(.background))
    return machine
  case .backgroundWork:
    var machine = Machine.ready()
    _ = machine.send(.backgroundWorkStarted(p1, expiresAt: F.at(30)))
    _ = machine.send(.scene(.background))
    return machine
  case .closing:
    var machine = Machine.ready()
    _ = machine.send(.networkChanged)
    _ = machine.send(.demand(w1))
    return machine
  case .cooldown:
    var machine = Machine.opening()
    _ = machine.send(.openFailed(generation: 1, .timedOut))
    _ = machine.send(.closed(generation: 1))
    return machine
  case .retired:
    var machine = Machine.foreground()
    _ = machine.send(.retire)
    return machine
  }
}

private func event(_ kind: EventKind) -> (Machine.Event, Double) {
  switch kind {
  case .demand: (.demand(w2), 1)
  case .cancelWaiter: (.cancelWaiter(w1), 1)
  case .scene: (.scene(.background), 1)
  case .workStarted: (.backgroundWorkStarted(p2, expiresAt: F.at(40)), 1)
  case .workFinished: (.backgroundWorkFinished(p1), 1)
  case .workExpired: (.backgroundWorkExpired(p1), 1)
  case .timeExpired: (.backgroundTimeExpired, 1)
  case .networkChanged: (.networkChanged, 1)
  case .opened: (.opened(generation: 1), 1)
  case .probeFinished: (.probeFinished(generation: 1, .http(status: 200)), 1)
  case .openFailed: (.openFailed(generation: 1, .connectFailed("x")), 1)
  case .connectionLost: (.connectionLost(generation: 1), 1)
  case .abortTimedOut: (.abortTimedOut(generation: 1), 1)
  case .closed: (.closed(generation: 1), 1)
  case .leaseChanged: (.leaseChanged(.ready), 1)
  case .retire: (.retire, 1)
  case .credentialChanged: (.credentialChanged(F.httpsOnly), 1)
  case .tick: (.tick, 20)
  }
}

private struct Outcome: Equatable, CustomStringConvertible {
  let state: Machine.State
  let commands: [Machine.Command]
  var description: String { "\(state) \(commands)" }
}

/// Oczekiwany wynik pary. `switch` bez `default`: para bez wpisu nie kompiluje się, a `nil` też przewraca test.
private func expected(_ state: StateKind, _ event: EventKind) -> Outcome? {
  let attempt1 = Machine.Attempt(generation: 1, since: F.at(0), choice: .iroh, deadline: F.at(15), waiters: [w1])
  let opening1 = Machine.State.opening(attempt1)
  let probing1 = Machine.State.probing(attempt1)
  let ready1 = Machine.State.ready(generation: 1, choice: .iroh)
  let grace1 = Machine.State.backgroundGrace(generation: 1, choice: .iroh, until: F.at(8))
  let work1 = Machine.State.backgroundWork(generation: 1, choice: .iroh)
  let closing1 = Machine.State.closing(.init(generation: 1, reason: .network, waiters: [w1]))
  let cooldown1 = Machine.State.cooldown(until: F.at(1))
  let failed = Outcome(state: .closing(.init(generation: 1, reason: .failed, waiters: [])),
                       commands: [.discard(generation: 1), .release([w1], .offline), .reportIroh(success: false)])
  let discard1 = [Machine.Command.discard(generation: 1)]
  func same(_ state: Machine.State, _ commands: [Machine.Command] = []) -> Outcome {
    Outcome(state: state, commands: commands)
  }
  func with(_ attempt: Machine.Attempt, waiters: [Machine.WaiterID], probing: Bool) -> Machine.State {
    var copy = attempt
    copy.waiters = waiters
    return probing ? .probing(copy) : .opening(copy)
  }

  switch (state, event) {
  // idle
  case (.idle, .demand):
    return same(.opening(.init(generation: 1, since: F.at(1), choice: .iroh, deadline: F.at(16), waiters: [w2])),
                [.open(generation: 1, choice: .iroh, budget: .seconds(15)), .schedule(at: F.at(16))])
  case (.idle, .cancelWaiter), (.idle, .scene), (.idle, .workStarted), (.idle, .workFinished),
    (.idle, .workExpired), (.idle, .timeExpired), (.idle, .networkChanged), (.idle, .leaseChanged),
    (.idle, .credentialChanged), (.idle, .tick):
    return same(.idle)
  case (.idle, .opened), (.idle, .probeFinished), (.idle, .openFailed), (.idle, .connectionLost),
    (.idle, .abortTimedOut), (.idle, .closed):
    return same(.idle, discard1)
  case (.idle, .retire):
    return same(.retired)

  // opening i probing
  case (.opening, .demand), (.probing, .demand):
    return same(with(attempt1, waiters: [w1, w2], probing: state == .probing))
  case (.opening, .cancelWaiter), (.probing, .cancelWaiter):
    return same(with(attempt1, waiters: [], probing: state == .probing), [.release([w1], .cancelled)])
  case (.opening, .scene), (.probing, .scene):
    return same(.closing(.init(generation: 1, reason: .background, waiters: [])),
                [.discard(generation: 1), .release([w1], .offline)])
  case (.opening, .workStarted), (.opening, .workFinished), (.opening, .workExpired), (.opening, .timeExpired),
    (.opening, .networkChanged), (.opening, .probeFinished), (.opening, .abortTimedOut), (.opening, .leaseChanged),
    (.opening, .credentialChanged):
    return same(opening1)
  case (.probing, .workStarted), (.probing, .workFinished), (.probing, .workExpired), (.probing, .timeExpired),
    (.probing, .networkChanged), (.probing, .opened), (.probing, .abortTimedOut), (.probing, .leaseChanged),
    (.probing, .credentialChanged):
    return same(probing1)
  case (.opening, .opened):
    return same(probing1, [.probe(generation: 1)])
  case (.probing, .probeFinished):
    return same(ready1, [.reportIroh(success: true), .release([w1], .ready(generation: 1))])
  case (.opening, .openFailed), (.opening, .connectionLost), (.opening, .closed), (.opening, .tick),
    (.probing, .openFailed), (.probing, .connectionLost), (.probing, .closed), (.probing, .tick):
    return failed
  case (.opening, .retire), (.probing, .retire):
    return same(.retired, [.release([w1], .cancelled), .discard(generation: 1)])

  // ready
  case (.ready, .demand):
    return same(ready1, [.release([w2], .ready(generation: 1))])
  case (.ready, .scene):
    return same(.backgroundGrace(generation: 1, choice: .iroh, until: F.at(9)), [.schedule(at: F.at(9))])
  case (.ready, .cancelWaiter), (.ready, .workStarted), (.ready, .workFinished), (.ready, .workExpired),
    (.ready, .timeExpired), (.ready, .opened), (.ready, .probeFinished), (.ready, .openFailed), (.ready, .leaseChanged),
    (.ready, .credentialChanged), (.ready, .tick):
    return same(ready1)
  case (.ready, .networkChanged):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [])), [.close(generation: 1)])
  case (.ready, .connectionLost), (.ready, .abortTimedOut):
    return same(.closing(.init(generation: 1, reason: .lost, waiters: [])), [.close(generation: 1)])
  case (.ready, .closed):
    return same(.idle)
  case (.ready, .retire):
    return same(.retired, [.close(generation: 1)])

  // backgroundGrace
  case (.backgroundGrace, .demand):
    return same(grace1, [.release([w2], .offline)])
  case (.backgroundGrace, .cancelWaiter), (.backgroundGrace, .scene), (.backgroundGrace, .workFinished),
    (.backgroundGrace, .workExpired), (.backgroundGrace, .opened), (.backgroundGrace, .probeFinished),
    (.backgroundGrace, .openFailed), (.backgroundGrace, .leaseChanged), (.backgroundGrace, .credentialChanged):
    return same(grace1)
  case (.backgroundGrace, .workStarted):
    return same(work1)
  case (.backgroundGrace, .networkChanged):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [])), [.close(generation: 1)])
  case (.backgroundGrace, .connectionLost), (.backgroundGrace, .abortTimedOut):
    return same(.closing(.init(generation: 1, reason: .lost, waiters: [])), [.close(generation: 1)])
  case (.backgroundGrace, .closed):
    return same(.idle)
  case (.backgroundGrace, .retire):
    return same(.retired, [.close(generation: 1)])
  case (.backgroundGrace, .tick), (.backgroundGrace, .timeExpired):
    return same(.closing(.init(generation: 1, reason: .background, waiters: [])), [.close(generation: 1)])

  // backgroundWork
  case (.backgroundWork, .demand):
    return same(work1, [.release([w2], .ready(generation: 1))])
  case (.backgroundWork, .cancelWaiter), (.backgroundWork, .scene), (.backgroundWork, .workStarted),
    (.backgroundWork, .timeExpired), (.backgroundWork, .opened), (.backgroundWork, .probeFinished),
    (.backgroundWork, .openFailed),
    (.backgroundWork, .leaseChanged), (.backgroundWork, .credentialChanged), (.backgroundWork, .tick):
    return same(work1)
  case (.backgroundWork, .workFinished), (.backgroundWork, .workExpired):
    return same(grace1, [.schedule(at: F.at(8))])  // last work ends before the grace deadline set when ready went to the background
  case (.backgroundWork, .networkChanged):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [])), [.close(generation: 1)])
  case (.backgroundWork, .connectionLost), (.backgroundWork, .abortTimedOut):
    return same(.closing(.init(generation: 1, reason: .lost, waiters: [])), [.close(generation: 1)])
  case (.backgroundWork, .closed):
    return same(.opening(.init(generation: 2, since: F.at(1), choice: .iroh, deadline: F.at(16), waiters: [])),
                [.open(generation: 2, choice: .iroh, budget: .seconds(15)), .schedule(at: F.at(16))])
  case (.backgroundWork, .retire):
    return same(.retired, [.close(generation: 1)])

  // closing(network) z czekającym w1
  case (.closing, .demand):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [w1, w2])))
  case (.closing, .cancelWaiter):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [])), [.release([w1], .cancelled)])
  case (.closing, .scene):
    return same(.closing(.init(generation: 1, reason: .network, waiters: [])), [.release([w1], .offline)])
  case (.closing, .workStarted), (.closing, .workFinished), (.closing, .workExpired), (.closing, .timeExpired),
    (.closing, .networkChanged),
    (.closing, .connectionLost), (.closing, .abortTimedOut), (.closing, .leaseChanged),
    (.closing, .credentialChanged), (.closing, .tick):
    return same(closing1)
  case (.closing, .opened), (.closing, .probeFinished), (.closing, .openFailed):
    return same(closing1, discard1)
  case (.closing, .closed):
    return same(.opening(.init(generation: 2, since: F.at(1), choice: .https, deadline: F.at(16), waiters: [w1])),
                [.rebindEndpoint(.policy), .open(generation: 2, choice: .https, budget: .seconds(15)),
                 .schedule(at: F.at(16))])
  case (.closing, .retire):
    return same(.retired, [.release([w1], .cancelled)])

  // cooldown
  case (.cooldown, .demand):
    return same(cooldown1, [.release([w2], .offline)])
  case (.cooldown, .cancelWaiter), (.cooldown, .scene), (.cooldown, .workStarted), (.cooldown, .workFinished),
    (.cooldown, .workExpired), (.cooldown, .timeExpired), (.cooldown, .leaseChanged),
    (.cooldown, .credentialChanged):
    return same(cooldown1)
  case (.cooldown, .networkChanged), (.cooldown, .tick):
    return same(.idle)
  case (.cooldown, .opened), (.cooldown, .probeFinished), (.cooldown, .openFailed), (.cooldown, .connectionLost),
    (.cooldown, .abortTimedOut), (.cooldown, .closed):
    return same(cooldown1, discard1)
  case (.cooldown, .retire):
    return same(.retired)

  // retired
  case (.retired, .demand):
    return same(.retired, [.release([w2], .cancelled)])
  case (.retired, .cancelWaiter), (.retired, .scene), (.retired, .workStarted), (.retired, .workFinished),
    (.retired, .workExpired), (.retired, .timeExpired), (.retired, .networkChanged), (.retired, .leaseChanged),
    (.retired, .retire),
    (.retired, .credentialChanged), (.retired, .tick):
    return same(.retired)
  case (.retired, .opened), (.retired, .probeFinished), (.retired, .openFailed), (.retired, .connectionLost),
    (.retired, .abortTimedOut), (.retired, .closed):
    return same(.retired, discard1)
  }
}

@Suite("maszyna generacji tunelu: macierz stan × zdarzenie")
struct TunnelMachineMatrixTests {
  @Test("macierz 9 × 18: każda para ma wpis i maszyna daje dokładnie wpisany stan i polecenia")
  func everyPair() {
    #expect(StateKind.allCases.count == 9)
    #expect(EventKind.allCases.count == 18)
    var checked = 0
    for stateKind in StateKind.allCases {
      for eventKind in EventKind.allCases {
        guard let want = expected(stateKind, eventKind) else {
          Issue.record("brak wpisu w macierzy: \(stateKind.rawValue) × \(eventKind.rawValue)")
          continue
        }
        var machine = fixture(stateKind)
        let (input, at) = event(eventKind)
        let commands = machine.send(input, at: at)
        let got = Outcome(state: machine.state, commands: commands)
        #expect(got == want, "\(stateKind.rawValue) × \(eventKind.rawValue)")
        checked += 1
      }
    }
    #expect(checked == 162)
  }

  @Test("HTTPS attempt with both routes: opening × opened probes; probing × results like iroh, without lease reports")
  func httpsAttemptPairs() {
    let attempt = Machine.Attempt(generation: 1, since: F.at(0), choice: .https, deadline: F.at(15), waiters: [w1])
    let failed = Outcome(state: .closing(.init(generation: 1, reason: .failed, waiters: [])),
                         commands: [.discard(generation: 1), .release([w1], .offline)])
    var probing = Machine.opening(lease: .unavailable)
    #expect(probing.state == .opening(attempt))
    let opened = probing.send(.opened(generation: 1), at: 1)
    #expect(Outcome(state: probing.state, commands: opened) == Outcome(state: .probing(attempt),
                                                                        commands: [.probe(generation: 1)]))
    let ready = Outcome(state: .ready(generation: 1, choice: .https), commands: [.release([w1], .ready(generation: 1))])
    let pairs: [(String, Machine.Event, Double, Outcome)] = [
      ("probeFinished http", .probeFinished(generation: 1, .http(status: 200)), 1, ready),
      ("probeFinished transport", .probeFinished(generation: 1, .transport), 1, failed),
      ("openFailed", .openFailed(generation: 1, .connectFailed("x")), 1, failed),
      ("connectionLost", .connectionLost(generation: 1), 1, failed),
      ("closed", .closed(generation: 1), 1, failed),
      ("tick", .tick, 20, failed),
    ]
    for (name, input, at, want) in pairs {
      var machine = probing
      let commands = machine.send(input, at: at)
      #expect(Outcome(state: machine.state, commands: commands) == want, "probing(https) × \(name)")
    }
  }

  @Test("stany wyjściowe macierzy są tymi, które nazywają")
  func fixturesMatchKinds() {
    for kind in StateKind.allCases {
      let state = fixture(kind).state
      let name: String =
        switch state {
        case .idle: "idle"
        case .opening: "opening"
        case .probing: "probing"
        case .ready: "ready"
        case .backgroundGrace: "backgroundGrace"
        case .backgroundWork: "backgroundWork"
        case .closing: "closing"
        case .cooldown: "cooldown"
        case .retired: "retired"
        }
      #expect(name == kind.rawValue)
    }
  }
}
