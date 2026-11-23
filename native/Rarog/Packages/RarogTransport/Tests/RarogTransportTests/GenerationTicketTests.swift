import Foundation
import RarogTransport
import Synchronization
import Testing

// Bilet generacji: `begin()` atomowo wyklucza start żądania po `startClosing()`, licznik
// żądań nie schodzi poniżej zera, `drained(within:)` mówi prawdę dopiero przy liczniku 0. Na tym stoi reguła
// „żądanie nie startuje na unieważnionej sesji URL”.

/// Znacznik „`startClosing()` już wróciło” widziany przez inne zadania (porządek acquire/release).
private final class ClosedFlag: Sendable {
  private let raised = Atomic<Bool>(false)
  func raise() { raised.store(true, ordering: .releasing) }
  var isRaised: Bool { raised.load(ordering: .acquiring) }
}

/// Wynik jednego `begin()` w wyścigu: czy wołający widział już zamknięcie i co dostał.
private struct BeginOutcome: Sendable {
  let sawClosed: Bool
  let began: Bool
}

@Suite("bilet generacji: begin/end/startClosing/drained")
struct GenerationTicketTests {
  @Test("1000 wyścigów begin() ze startClosing() w losowej kolejności: po zamknięciu begin() == fałsz, drained dopiero przy zerze")
  func beginRacesStartClosing() async {
    for _ in 0..<1000 {
      let ticket = GenerationTicket()
      let closed = ClosedFlag()
      let closer = Int.random(in: 0...8)
      let outcomes = await withTaskGroup(of: BeginOutcome?.self) { group in
        for slot in 0...8 {
          if slot == closer {
            group.addTask {
              if Bool.random() { await Task.yield() }
              ticket.startClosing()
              closed.raise()
              // To samo zadanie po zamknięciu: begin() musi odmówić.
              return BeginOutcome(sawClosed: true, began: ticket.begin())
            }
          } else {
            group.addTask {
              if Bool.random() { await Task.yield() }
              let sawClosed = closed.isRaised
              return BeginOutcome(sawClosed: sawClosed, began: ticket.begin())
            }
          }
        }
        var outcomes: [BeginOutcome] = []
        for await outcome in group { if let outcome { outcomes.append(outcome) } }
        return outcomes
      }

      #expect(outcomes.count == 9)
      #expect(outcomes.allSatisfy { !$0.sawClosed || !$0.began }, "begin() po startClosing() zwróciło prawdę")
      #expect(ticket.closedByRuntime)
      #expect(ticket.begin() == false)

      let active = outcomes.filter(\.began).count
      for _ in 0..<active {
        #expect(await ticket.drained(within: .zero) == false, "drained przy niezerowym liczniku")
        ticket.end()
      }
      #expect(await ticket.drained(within: .zero))
      ticket.end()  // nadmiarowe end() po zamknięciu
      #expect(await ticket.drained(within: .zero))
      #expect(ticket.begin() == false)
    }
  }

  @Test("end() bez begin() nie schodzi poniżej zera")
  func endWithoutBeginStaysAtZero() async {
    let ticket = GenerationTicket()
    ticket.end()
    ticket.end()
    ticket.end()
    #expect(await ticket.drained(within: .zero))
    #expect(ticket.begin())
    // Licznik 1, nie −2: jedno żądanie w locie.
    #expect(await ticket.drained(within: .milliseconds(20)) == false)
    ticket.end()
    #expect(await ticket.drained(within: .zero))
  }

  @Test("równoczesne end() z wielu zadań: licznik schodzi dokładnie do zera, nadmiar nie robi długu")
  func concurrentEnds() async {
    let ticket = GenerationTicket()
    for _ in 0..<500 { #expect(ticket.begin()) }
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<800 { group.addTask { ticket.end() } }
    }
    #expect(await ticket.drained(within: .zero))
    #expect(ticket.begin())
    #expect(await ticket.drained(within: .zero) == false)
    ticket.end()
    #expect(await ticket.drained(within: .zero))
  }

  @Test("drained czeka na ostatnie end() i nie wcześniej; wszyscy czekający dostają prawdę")
  func drainedWaitsForLastEnd() async {
    let ticket = GenerationTicket()
    for _ in 0..<3 { #expect(ticket.begin()) }
    ticket.startClosing()
    let finished = Atomic<Int>(0)
    let waiters = (0..<5).map { _ in
      Task {
        let drained = await ticket.drained(within: .seconds(30))
        finished.add(1, ordering: .relaxed)
        return drained
      }
    }
    try? await Task.sleep(for: .milliseconds(20))
    ticket.end()
    ticket.end()
    try? await Task.sleep(for: .milliseconds(50))
    #expect(finished.load(ordering: .relaxed) == 0, "drained wróciło przy liczniku 1")

    let start = ContinuousClock.now
    ticket.end()
    for waiter in waiters { #expect(await waiter.value) }
    #expect(ContinuousClock.now - start < .seconds(5))
  }

  @Test("drained po terminie → fałsz; żądanie w locie dalej się liczy")
  func drainedTimesOut() async {
    let ticket = GenerationTicket()
    #expect(ticket.begin())
    ticket.startClosing()
    let start = ContinuousClock.now
    #expect(await ticket.drained(within: .milliseconds(30)) == false)
    #expect(ContinuousClock.now - start >= .milliseconds(30))
    ticket.end()
    #expect(await ticket.drained(within: .zero))
  }

  @Test("anulowanie czekającego na drained → fałsz od razu, bez czekania na termin")
  func drainedHonoursCancellation() async {
    let ticket = GenerationTicket()
    #expect(ticket.begin())
    let start = ContinuousClock.now
    let waiter = Task { await ticket.drained(within: .seconds(30)) }
    try? await Task.sleep(for: .milliseconds(10))
    waiter.cancel()
    #expect(await waiter.value == false)
    #expect(ContinuousClock.now - start < .seconds(5))
    ticket.end()
    #expect(await ticket.drained(within: .zero))
  }

  @Test("startClosing() nie zeruje licznika i jest idempotentne; closedByRuntime od zamknięcia")
  func startClosingKeepsCount() async {
    let ticket = GenerationTicket()
    #expect(ticket.closedByRuntime == false)
    #expect(ticket.begin())
    #expect(ticket.begin())
    ticket.startClosing()
    ticket.startClosing()
    #expect(ticket.closedByRuntime)
    #expect(ticket.begin() == false)
    #expect(await ticket.drained(within: .zero) == false)
    ticket.end()
    #expect(await ticket.drained(within: .zero) == false)
    ticket.end()
    #expect(await ticket.drained(within: .zero))
  }
}
