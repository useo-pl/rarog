import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Sesja terminala: czysta maszyna stanów i sesja na atrapach transportu i gniazda. Rytm ponawiania
// liczy zegar wirtualny — wynik nie zależy od obciążenia maszyny.

private let cwd = "/Users/demo/Projects/rarog"
private let termId = "0123456789abcdef"

private func response(_ id: String = termId, slot: Int, role: TerminalRole = .shell) -> TerminalOpenResponse {
  TerminalOpenResponse.make(id: id, slot: slot, role: role)
}

/// Zegar monotoniczny znaczników próby pod kontrolą testu: czas stoi, dopóki test go nie przesunie.
@MainActor
private final class StepClock {
  let origin = ContinuousClock.now
  private var elapsed: Duration = .zero
  var now: ContinuousClock.Instant { origin + elapsed }
  func advance(by step: Duration) { elapsed += step }
}

@Suite("terminal: maszyna stanów połączenia")
struct TerminalMachineTests {
  @Test("start: POST z katalogiem, slotem i rolą → gniazdo świeże → żywe; `rs` po otwarciu")
  func happyPath() throws {
    var machine = TerminalMachine(target: try #require(.shell(cwd: cwd, slot: 2)))
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(2), role: .shell))
    #expect(machine.handle(.start) == [.open(generation: 1, body)])
    #expect(machine.phase == .connecting)
    #expect(machine.handle(.opened(generation: 1, response(slot: 2))) == [.connect(generation: 1, id: termId, fresh: true)])
    #expect(machine.handle(.socketOpened(generation: 1)) == [.syncGrid])
    #expect(machine.phase == .live)
    #expect(machine.handle(.serverFrame(generation: 1, .hello(backend: "herdr"))) == [])
  }

  @Test("zerwanie: rytm 1/2/5/5 s, przed KAŻDĄ próbą POST z TYM SAMYM slotem i rolą, gniazdo nie-świeże")
  func reconnectKeepsSlotAndRole() throws {
    var machine = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    let next = try #require(TerminalOpenBody(cwd: cwd, slot: .next, role: .shell))
    #expect(machine.handle(.start) == [.open(generation: 1, next)])
    // `next` rozstrzyga serwer — od tej chwili ten numer, nie kolejny nowy terminal.
    _ = machine.handle(.opened(generation: 1, response(slot: 3)))
    _ = machine.handle(.socketOpened(generation: 1))
    let slot3 = try #require(TerminalOpenBody(cwd: cwd, slot: .number(3), role: .shell))
    var generation = 1
    for (failures, delay) in [(1, 1), (2, 2), (3, 5), (4, 5)] {
      let closed = machine.handle(.socketClosed(generation: generation))
      generation += 1
      #expect(closed == [.disconnect, .retry(generation: generation, after: .seconds(delay))])
      #expect(machine.phase == .reconnecting(attempt: failures))
      generation += 1
      #expect(machine.handle(.retryDue(generation: generation - 1)) == [.open(generation: generation, slot3)])
      #expect(machine.handle(.opened(generation: generation, response(slot: 3)))
        == [.connect(generation: generation, id: termId, fresh: false)])
    }
    // Udane otwarcie zeruje licznik zerwań.
    _ = machine.handle(.socketOpened(generation: generation))
    #expect(machine.failures == 0 && machine.phase == .live)
  }

  @Test("popup (lazygit, popup): ciało bez slotu przy każdej próbie")
  func popupBody() throws {
    var machine = TerminalMachine(target: try #require(.popup(cwd: cwd, role: .lazygit)))
    let body = try #require(TerminalOpenBody(cwd: cwd, role: .lazygit))
    #expect(machine.handle(.start) == [.open(generation: 1, body)])
    _ = machine.handle(.opened(generation: 1, response(slot: 0, role: .lazygit)))
    _ = machine.handle(.socketClosed(generation: 1))
    #expect(machine.handle(.retryDue(generation: 2)) == [.open(generation: 3, body)])
  }

  @Test("„nie ma terminala” WYŁĄCZNIE bez katalogu: trzy zerwania z rzędu; z katalogiem ponawia bez końca")
  func missingOnlyWithoutCwd() throws {
    var bare = TerminalMachine(target: try #require(.id(termId)))
    #expect(bare.handle(.start) == [.connect(generation: 1, id: termId, fresh: true)])
    _ = bare.handle(.socketClosed(generation: 1))
    _ = bare.handle(.retryDue(generation: 2))
    _ = bare.handle(.socketClosed(generation: 3))
    _ = bare.handle(.retryDue(generation: 4))
    #expect(bare.handle(.socketClosed(generation: 5)) == [.disconnect, .cancelRetry])
    #expect(bare.phase == .missing)

    var known = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = known.handle(.start)
    var generation = 1
    for _ in 0..<10 {
      _ = known.handle(.openFailed(generation: generation, .transient(maybeProcessed: true)))
      generation += 1
      _ = known.handle(.retryDue(generation: generation))
      generation += 1
      _ = known.handle(.opened(generation: generation, response(slot: 1)))
      _ = known.handle(.socketClosed(generation: generation))
      generation += 1
      _ = known.handle(.retryDue(generation: generation))
      generation += 1
    }
    #expect(known.phase != .missing && !known.phase.isHalted)
  }

  @Test("KAŻDY `err` zatrzymuje automat (też w popupie); `exit` to koniec powłoki z powiadomieniem")
  func errAndExitHalt() throws {
    for target in [try #require(TerminalTarget.shell(cwd: cwd)), try #require(TerminalTarget.popup(cwd: cwd, role: .popup))] {
      var machine = TerminalMachine(target: target)
      _ = machine.handle(.start)
      _ = machine.handle(.opened(generation: 1, response(slot: target.role.isPopup ? 0 : 1, role: target.role)))
      _ = machine.handle(.socketOpened(generation: 1))
      #expect(machine.handle(.serverFrame(generation: 1, .error(message: "Terminal został przejęty."))) == [.disconnect, .cancelRetry])
      #expect(machine.phase == .failed(.server("Terminal został przejęty.")))
      // Zamknięcie gniazda po `err` (1008) nie budzi automatu.
      #expect(machine.handle(.socketClosed(generation: 1)) == [])
      #expect(machine.handle(.retryDue(generation: 2)) == [])
    }
    var shell = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = shell.handle(.start)
    _ = shell.handle(.opened(generation: 1, response(slot: 1)))
    _ = shell.handle(.socketOpened(generation: 1))
    #expect(shell.handle(.serverFrame(generation: 1, .exit)) == [.disconnect, .cancelRetry, .notify(.exited)])
    #expect(shell.phase == .exited && shell.phase.isHalted)
  }

  @Test("odmowa POST: 4xx/5xx i niezgodność stają ze zdaniem, 401 też powiadamia, sieć ponawia")
  func openFailures() throws {
    let target = try #require(TerminalTarget.shell(cwd: cwd))
    let cases: [(TerminalMachine.OpenFailure, TerminalPhase)] = [
      (.answered("Limit 4 terminali w projekcie — zamknij jeden."), .failed(.server("Limit 4 terminali w projekcie — zamknij jeden."))),
      (.incompatible("Zaktualizuj apkę."), .failed(.incompatible("Zaktualizuj apkę."))),
      (.unauthorized, .failed(.unauthorized)),
      (.transient(maybeProcessed: false), .reconnecting(attempt: 1)),
      // Slot konkretny jest idempotentny: niepewny wynik i tak wolno ponowić.
      (.transient(maybeProcessed: true), .reconnecting(attempt: 1)),
    ]
    for (failure, phase) in cases {
      var machine = TerminalMachine(target: target)
      _ = machine.handle(.start)
      let effects = machine.handle(.openFailed(generation: 1, failure))
      #expect(machine.phase == phase)
      #expect(effects.contains(.notify(.unauthorized)) == (failure == .unauthorized))
    }
  }

  @Test("nowy terminal (`next`): niepewny wynik nie daje drugiego `next`; pewny brak żądania — wolno ponowić")
  func nextAllocationNotRepeated() throws {
    let next = try #require(TerminalOpenBody(cwd: cwd, slot: .next, role: .shell))
    var lost = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = lost.handle(.start)
    // Limit czasu: serwer mógł już założyć slot — automat staje zamiast prosić o kolejny.
    #expect(lost.handle(.openFailed(generation: 1, .transient(maybeProcessed: true))) == [.disconnect, .cancelRetry])
    #expect(lost.phase == .failed(.newTerminalUnconfirmed))
    // Świadomy gest prosi od nowa.
    #expect(lost.handle(.restart) == [.disconnect, .cancelRetry, .open(generation: 3, next)])

    var offline = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = offline.handle(.start)
    _ = offline.handle(.openFailed(generation: 1, .transient(maybeProcessed: false)))
    #expect(offline.handle(.retryDue(generation: 2)) == [.open(generation: 3, next)])
  }

  @Test("nowy terminal: tło w trakcie `next` — odpowiedź poprowadzi powrót (bez drugiego `next`)")
  func nextAllocationSurvivesSuspend() throws {
    var machine = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = machine.handle(.start)
    _ = machine.handle(.suspend)
    // Powrót, zanim przyszła odpowiedź: próba czeka na zaległy przydział, nie wysyła własnego.
    #expect(machine.handle(.resume) == [])
    #expect(machine.phase == .connecting)
    #expect(machine.handle(.opened(generation: 1, response(slot: 2))) == [.connect(generation: 3, id: termId, fresh: true)])
    _ = machine.handle(.socketOpened(generation: 3))
    _ = machine.handle(.socketClosed(generation: 3))
    let slot2 = try #require(TerminalOpenBody(cwd: cwd, slot: .number(2), role: .shell))
    #expect(machine.handle(.retryDue(generation: 4)) == [.open(generation: 5, slot2)])

    // Odpowiedź w tle: wiedza o slocie i id zostaje — powrót idzie gniazdem bez `POST`, a po odmowie
    // prosi już o numer, nie o `next`.
    var background = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = background.handle(.start)
    _ = background.handle(.suspend)
    #expect(background.handle(.opened(generation: 1, response(slot: 4))) == [])
    #expect(background.handle(.resume) == [.connect(generation: 3, id: termId, fresh: true, direct: true)])
    let slot4 = try #require(TerminalOpenBody(cwd: cwd, slot: .number(4), role: .shell))
    #expect(background.handle(.socketClosed(generation: 3)) == [.disconnect, .open(generation: 4, slot4)])

    // Zaległy `next`, który na pewno nie wyszedł: czekająca próba wysyła własny.
    var notSent = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = notSent.handle(.start)
    _ = notSent.handle(.suspend)
    _ = notSent.handle(.resume)
    let next = try #require(TerminalOpenBody(cwd: cwd, slot: .next, role: .shell))
    #expect(notSent.handle(.openFailed(generation: 1, .transient(maybeProcessed: false)))
      == [.retry(generation: 4, after: .seconds(1))])
    #expect(notSent.handle(.retryDue(generation: 4)) == [.open(generation: 5, next)])
  }

  @Test("generacja: spóźnione odpowiedzi, zamknięcia i budziki po zmianie próby niczego nie ruszają")
  func staleGenerationsIgnored() throws {
    var machine = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = machine.handle(.start)
    #expect(machine.handle(.suspend) == [.disconnect, .cancelRetry])
    #expect(machine.phase == .suspended)
    // POST sprzed tła wraca po nim.
    #expect(machine.handle(.opened(generation: 1, response(slot: 1))) == [])
    #expect(machine.handle(.openFailed(generation: 1, .answered("x"))) == [])
    #expect(machine.phase == .suspended)
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(1), role: .shell))
    #expect(machine.handle(.resume) == [.open(generation: 3, body)])
    _ = machine.handle(.opened(generation: 3, response(slot: 1)))
    _ = machine.handle(.socketOpened(generation: 3))
    // Gniazdo z poprzedniej próby i jej budzik.
    #expect(machine.handle(.socketClosed(generation: 1)) == [])
    #expect(machine.handle(.retryDue(generation: 2)) == [])
    #expect(machine.handle(.serverFrame(generation: 1, .exit)) == [])
    #expect(machine.phase == .live)

    // Gest w trakcie POST: odpowiedź starej próby przychodzi, gdy nowa też jest w toku.
    var racing = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = racing.handle(.start)
    _ = racing.handle(.restart)
    #expect(racing.phase == .connecting)
    #expect(racing.handle(.opened(generation: 1, response("fedcba9876543210", slot: 1))) == [])
    #expect(racing.handle(.openFailed(generation: 1, .answered("stara odmowa"))) == [])
    #expect(racing.handle(.socketOpened(generation: 1)) == [])
    #expect(racing.target.id == nil && racing.phase == .connecting)
  }

  @Test("tło: zawieszenie bez ponawiania; powrót = świeże gniazdo od zera; stan zatrzymany zostaje")
  func suspendResume() throws {
    var machine = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = machine.handle(.start)
    _ = machine.handle(.opened(generation: 1, response(slot: 1)))
    _ = machine.handle(.socketOpened(generation: 1))
    _ = machine.handle(.socketClosed(generation: 1))
    #expect(machine.phase == .reconnecting(attempt: 1))
    _ = machine.handle(.suspend)
    #expect(machine.handle(.retryDue(generation: 2)) == [])
    // Id znane z pierwszego `POST`: powrót od razu gniazdem bez `POST`.
    #expect(machine.handle(.resume) == [.connect(generation: 4, id: termId, fresh: true, direct: true)])
    #expect(machine.phase == .connecting && machine.failures == 0)

    var halted = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = halted.handle(.start)
    _ = halted.handle(.openFailed(generation: 1, .answered(nil)))
    #expect(halted.handle(.suspend) == [] && halted.handle(.resume) == [])
    #expect(halted.phase == .failed(.server(nil)))
  }

  @Test("gest „Spróbuj od nowa” wychodzi z każdego zatrzymania, łączy od razu i od zera")
  func restart() throws {
    var machine = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = machine.handle(.start)
    _ = machine.handle(.openFailed(generation: 1, .answered("Limit")))
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(1), role: .shell))
    #expect(machine.handle(.restart) == [.disconnect, .cancelRetry, .open(generation: 3, body)])
    #expect(machine.phase == .connecting)
    #expect(machine.handle(.opened(generation: 3, response(slot: 1))) == [.connect(generation: 3, id: termId, fresh: true)])
  }

  @Test("inny id z POST (przeniesiony katalog): sesja przechodzi na niego i mówi o tym widokowi")
  func retargeted() throws {
    let entry = try #require(TerminalList.make([(termId, cwd, 1, .shell)]).terminals.first)
    var machine = TerminalMachine(target: .existing(entry))
    _ = machine.handle(.start)
    let moved = "fedcba9876543210"
    #expect(machine.handle(.opened(generation: 1, response(moved, slot: 1)))
      == [.notify(.retargeted(id: moved)), .connect(generation: 1, id: moved, fresh: true)])
    #expect(machine.target.id == moved)
  }

  @Test("niezgodność trwała zatrzymuje żywy terminal; `stop` kończy wszystko i nic po nim nie działa")
  func incompatibleAndStop() throws {
    var machine = TerminalMachine(target: try #require(.shell(cwd: cwd)))
    _ = machine.handle(.start)
    _ = machine.handle(.opened(generation: 1, response(slot: 1)))
    _ = machine.handle(.socketOpened(generation: 1))
    #expect(machine.handle(.incompatible("Zaktualizuj apkę.")) == [.disconnect, .cancelRetry])
    #expect(machine.phase == .failed(.incompatible("Zaktualizuj apkę.")))
    #expect(machine.handle(.stop) == [.disconnect, .cancelRetry])
    #expect(machine.phase == .idle)
    #expect(machine.handle(.incompatible("x")) == [] && machine.handle(.resume) == [])
  }

  // MARK: Gniazdo bez `POST`

  /// Wpis z listy (id znane, katalog, rola, slot).
  private func listed(_ role: TerminalRole, slot: Int = 1) throws -> TerminalTarget {
    .existing(try #require(TerminalList.make([(termId, cwd, role.isPopup ? 0 : slot, role)]).terminals.first))
  }

  @Test("start i powrót z tła przy znanym id powłoki i okna Cmd+F — gniazdo bez POST, ze znacznikiem")
  func directOnStartAndResume() throws {
    for role in [TerminalRole.shell, .popup] {
      var machine = TerminalMachine(target: try listed(role))
      #expect(machine.handle(.start) == [.connect(generation: 1, id: termId, fresh: true, direct: true)])
      #expect(machine.phase == .connecting)
      #expect(machine.handle(.socketOpened(generation: 1)) == [.syncGrid])
      #expect(machine.phase == .live)
      _ = machine.handle(.suspend)
      #expect(machine.handle(.resume) == [.connect(generation: 3, id: termId, fresh: true, direct: true)])
    }
    // Id poznane z pierwszego `POST` (konkretny slot): powrót z tła też bez `POST`.
    var shell = TerminalMachine(target: try #require(.shell(cwd: cwd, slot: 2)))
    _ = shell.handle(.start)
    _ = shell.handle(.opened(generation: 1, response(slot: 2)))
    _ = shell.handle(.socketOpened(generation: 1))
    _ = shell.handle(.suspend)
    #expect(shell.handle(.resume) == [.connect(generation: 3, id: termId, fresh: true, direct: true)])
  }

  @Test("odmowa (zamknięcie przed otwarciem) → POST od razu, bez zerwania na liczniku, `fresh` zachowany; raz")
  func directRefusalFallsBackToPost() throws {
    for role in [TerminalRole.shell, .popup] {
      var machine = TerminalMachine(target: try listed(role))
      let body = try #require(TerminalOpenBody(cwd: cwd, slot: role.isPopup ? nil : .number(1), role: role))
      _ = machine.handle(.start)
      #expect(!machine.retriesAfterDirectRefusal)
      #expect(machine.handle(.socketClosed(generation: 1)) == [.disconnect, .open(generation: 2, body)])
      #expect(machine.phase == .connecting && machine.failures == 0)
      #expect(machine.retriesAfterDirectRefusal)
      // Gniazdo po `POST`: zwykłe (bez znacznika) i nadal świeże.
      #expect(machine.handle(.opened(generation: 2, response(slot: role.isPopup ? 0 : 1, role: role)))
        == [.connect(generation: 2, id: termId, fresh: true)])
      // Jego zamknięcie przed otwarciem to już zwykłe zerwanie: licznik i rytm 1/2/5 s, bez drugiego skrótu.
      #expect(machine.handle(.socketClosed(generation: 2)) == [.disconnect, .retry(generation: 3, after: .seconds(1))])
      #expect(machine.phase == .reconnecting(attempt: 1))
      #expect(machine.handle(.retryDue(generation: 3)) == [.open(generation: 4, body)])
      #expect(!machine.retriesAfterDirectRefusal)
      // Spóźnione zamknięcie odrzuconego gniazda niczego nie rusza.
      #expect(machine.handle(.socketClosed(generation: 1)) == [])
    }
  }

  @Test("zerwanie gniazda bez POST PO otwarciu idzie zwykłą drogą — rytm i POST przy ponowieniu")
  func directDropAfterOpenUsesBackoff() throws {
    var machine = TerminalMachine(target: try listed(.shell))
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(1), role: .shell))
    _ = machine.handle(.start)
    _ = machine.handle(.socketOpened(generation: 1))
    #expect(machine.handle(.socketClosed(generation: 1)) == [.disconnect, .retry(generation: 2, after: .seconds(1))])
    #expect(machine.failures == 1)
    #expect(machine.handle(.retryDue(generation: 2)) == [.open(generation: 3, body)])
    #expect(machine.handle(.opened(generation: 3, response(slot: 1))) == [.connect(generation: 3, id: termId, fresh: false)])
  }

  @Test("`err` i `exit` w próbie bez POST stają jak dziś — zamknięcie po nich nie daje POST")
  func directErrAndExitHalt() throws {
    var failed = TerminalMachine(target: try listed(.shell))
    _ = failed.handle(.start)
    _ = failed.handle(.socketOpened(generation: 1))
    #expect(failed.handle(.serverFrame(generation: 1, .error(message: "Limit"))) == [.disconnect, .cancelRetry])
    #expect(failed.handle(.socketClosed(generation: 1)) == [])
    #expect(failed.phase == .failed(.server("Limit")))

    var exited = TerminalMachine(target: try listed(.popup))
    _ = exited.handle(.start)
    _ = exited.handle(.socketOpened(generation: 1))
    #expect(exited.handle(.serverFrame(generation: 1, .exit)) == [.disconnect, .cancelRetry, .notify(.exited)])
    #expect(exited.handle(.socketClosed(generation: 1)) == [])
    #expect(exited.phase == .exited)
  }

  @Test("tło, gest i stop w trakcie przejścia odmowa → POST odcinają spóźnione zdarzenia")
  func directTransitionInterrupted() throws {
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(1), role: .shell))
    // Tło w trakcie `POST` po odmowie: odpowiedź sprzed tła ignorowana, powrót znowu bez `POST`.
    var suspended = TerminalMachine(target: try listed(.shell))
    _ = suspended.handle(.start)
    _ = suspended.handle(.socketClosed(generation: 1))
    #expect(suspended.handle(.suspend) == [.disconnect, .cancelRetry])
    #expect(suspended.handle(.opened(generation: 2, response(slot: 1))) == [])
    #expect(suspended.handle(.openFailed(generation: 2, .unauthorized)) == [])
    #expect(suspended.phase == .suspended)
    #expect(suspended.handle(.resume) == [.connect(generation: 4, id: termId, fresh: true, direct: true)])

    // Gest w trakcie `POST` po odmowie: zawsze `POST`; stara odpowiedź i stare gniazdo bez skutku.
    var restarted = TerminalMachine(target: try listed(.shell))
    _ = restarted.handle(.start)
    _ = restarted.handle(.socketClosed(generation: 1))
    #expect(restarted.handle(.restart) == [.disconnect, .cancelRetry, .open(generation: 3, body)])
    #expect(restarted.handle(.opened(generation: 2, response("fedcba9876543210", slot: 1))) == [])
    #expect(restarted.handle(.socketClosed(generation: 1)) == [])
    #expect(!restarted.retriesAfterDirectRefusal)
    #expect(restarted.handle(.opened(generation: 3, response(slot: 1))) == [.connect(generation: 3, id: termId, fresh: true)])

    // Gest, zanim gniazdo bez `POST` odpowiedziało: jego późniejsze zamknięcie nie robi drugiego `POST`.
    var early = TerminalMachine(target: try listed(.shell))
    _ = early.handle(.start)
    #expect(early.handle(.restart) == [.disconnect, .cancelRetry, .open(generation: 2, body)])
    #expect(early.handle(.socketClosed(generation: 1)) == [])

    // Stop w trakcie przejścia: nic po nim.
    var stopped = TerminalMachine(target: try listed(.shell))
    _ = stopped.handle(.start)
    _ = stopped.handle(.socketClosed(generation: 1))
    #expect(stopped.handle(.stop) == [.disconnect, .cancelRetry])
    #expect(stopped.handle(.opened(generation: 2, response(slot: 1))) == [])
    #expect(stopped.phase == .idle)
  }

  @Test("401 przy POST po odmowie wylogowuje jak dziś; 4xx staje ze zdaniem")
  func directRefusalThenPostFails() throws {
    var machine = TerminalMachine(target: try listed(.popup))
    _ = machine.handle(.start)
    _ = machine.handle(.socketClosed(generation: 1))
    #expect(machine.handle(.openFailed(generation: 2, .unauthorized)) == [.disconnect, .cancelRetry, .notify(.unauthorized)])
    #expect(machine.phase == .failed(.unauthorized))

    var limited = TerminalMachine(target: try listed(.shell))
    _ = limited.handle(.start)
    _ = limited.handle(.socketClosed(generation: 1))
    _ = limited.handle(.openFailed(generation: 2, .answered("Limit")))
    #expect(limited.phase == .failed(.server("Limit")))
  }

  @Test("przeniesiony terminal — odmowa, POST z innym id, `retargeted`; ten sam id po odmowie bez `retargeted`")
  func directRefusalRetargets() throws {
    var moved = TerminalMachine(target: try listed(.shell))
    _ = moved.handle(.start)
    _ = moved.handle(.socketClosed(generation: 1))
    let other = "fedcba9876543210"
    #expect(moved.handle(.opened(generation: 2, response(other, slot: 1)))
      == [.notify(.retargeted(id: other)), .connect(generation: 2, id: other, fresh: true)])
    #expect(moved.target.id == other)

    // Wpis okna skasowany po `exit` (nieświeża lista): deterministyczny id wraca ten sam.
    var popup = TerminalMachine(target: try listed(.popup))
    _ = popup.handle(.start)
    _ = popup.handle(.socketClosed(generation: 1))
    #expect(popup.handle(.opened(generation: 2, response(slot: 0, role: .popup)))
      == [.connect(generation: 2, id: termId, fresh: true)])
  }

  @Test("gest, `next`, lazygit i cel bez katalogu — dzisiejsza ścieżka; próg trzech zerwań bez zmian")
  func directExclusions() throws {
    // Gest „Spróbuj od nowa” — także z `idle` — zawsze `POST`.
    let body = try #require(TerminalOpenBody(cwd: cwd, slot: .number(1), role: .shell))
    var restarted = TerminalMachine(target: try listed(.shell))
    #expect(restarted.handle(.restart) == [.open(generation: 1, body)])
    _ = restarted.handle(.opened(generation: 1, response(slot: 1)))
    _ = restarted.handle(.serverFrame(generation: 1, .exit))
    #expect(restarted.handle(.restart) == [.disconnect, .cancelRetry, .open(generation: 3, body)])

    // „Nowy terminal”: `next` przez `POST`.
    var fresh = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    let next = try #require(TerminalOpenBody(cwd: cwd, slot: .next, role: .shell))
    #expect(fresh.handle(.start) == [.open(generation: 1, next)])

    // Lazygit z listy: zawsze `POST`, także po powrocie z tła.
    var lazygit = TerminalMachine(target: try listed(.lazygit))
    let lazyBody = try #require(TerminalOpenBody(cwd: cwd, role: .lazygit))
    #expect(lazygit.handle(.start) == [.open(generation: 1, lazyBody)])
    _ = lazygit.handle(.opened(generation: 1, response(slot: 0, role: .lazygit)))
    _ = lazygit.handle(.suspend)
    #expect(lazygit.handle(.resume) == [.open(generation: 3, lazyBody)])

    // Cel bez katalogu: gniazdo wprost jak dziś, BEZ znacznika; „nie ma” po trzech zerwaniach.
    var bare = TerminalMachine(target: try #require(.id(termId)))
    #expect(bare.handle(.start) == [.connect(generation: 1, id: termId, fresh: true, direct: false)])
    #expect(bare.handle(.socketClosed(generation: 1)) == [.disconnect, .retry(generation: 2, after: .seconds(1))])
    _ = bare.handle(.retryDue(generation: 2))
    _ = bare.handle(.socketClosed(generation: 3))
    _ = bare.handle(.retryDue(generation: 4))
    _ = bare.handle(.socketClosed(generation: 5))
    #expect(bare.phase == .missing)
  }

  @Test("przydział `next` przed i po powrocie z tła — bez drugiego `next`, potem bez POST")
  func nextAllocationThenDirect() throws {
    var machine = TerminalMachine(target: try #require(.newShell(cwd: cwd)))
    _ = machine.handle(.start)
    _ = machine.handle(.suspend)
    // Powrót przed odpowiedzią: czeka na zaległy przydział (bez żadnego skutku), a nie łączy się wprost.
    #expect(machine.handle(.resume) == [])
    #expect(machine.handle(.opened(generation: 1, response(slot: 2))) == [.connect(generation: 3, id: termId, fresh: true)])
    _ = machine.handle(.socketOpened(generation: 3))
    // Kolejny powrót: id i slot znane — gniazdo bez `POST`; po odmowie `POST` o slot 2, nie o `next`.
    _ = machine.handle(.suspend)
    #expect(machine.handle(.resume) == [.connect(generation: 5, id: termId, fresh: true, direct: true)])
    let slot2 = try #require(TerminalOpenBody(cwd: cwd, slot: .number(2), role: .shell))
    #expect(machine.handle(.socketClosed(generation: 5)) == [.disconnect, .open(generation: 6, slot2)])
  }
}

@MainActor
@Suite("terminal: sesja na atrapach transportu i gniazda")
struct TerminalSessionTests {
  private func session(
    _ target: TerminalTarget, backend: FakeTerminalBackend = FakeTerminalBackend(), clock: VirtualClock = VirtualClock()
  ) -> (TerminalSession, FakeTerminalBackend, VirtualClock) {
    let session = TerminalSession(target: target, transport: backend, sleep: { await clock.sleep($0) })
    return (session, backend, clock)
  }

  @Test("POST → gniazdo świeże z rozmiarem zmierzonym przed upgrade'em → `rs` po otwarciu → bajty i wejście")
  func happyPath() async throws {
    let (session, backend, _) = session(try #require(.shell(cwd: cwd)))
    let grid = try #require(TerminalGrid(cols: 104, rows: 41))
    session.gridProvider = { grid }
    var received = Data()
    session.onBytes = { received.append($0) }
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    #expect(backend.opens.map(\.cwd) == [cwd])
    #expect(backend.socketCalls == [.init(id: termId, fresh: true, grid: grid)])
    let socket = try #require(backend.lastSocket)
    #expect(session.send("x") == .notConnected)
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    socket.emit(.frame(.hello(backend: "herdr")))
    socket.emit(.bytes(Data("\u{1B}[2J$ ".utf8)))
    #expect(session.send("ls\r") == .queued)
    #expect(session.send("") == .empty)
    await until("ramki") { socket.sent.count == 2 }
    #expect(socket.sent == [.resize(grid), .input("ls\r")])
    await until("bajty") { received == Data("\u{1B}[2J$ ".utf8) }
    #expect(session.terminalId == termId)
  }

  @Test("zerwanie → 1 s → POST z tym samym slotem i rolą (nie `next`) → nowe gniazdo nie-świeże")
  func reconnect() async throws {
    let (session, backend, clock) = session(try #require(.newShell(cwd: cwd)))
    var received: [Data] = []
    session.onBytes = { received.append($0) }
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let first = try #require(backend.lastSocket)
    first.emit(.opened)
    await until("żywe") { session.phase == .live }
    first.drop()
    await until("ponawianie") { session.phase == .reconnecting(attempt: 1) }
    await until("budzik 1 s") { clock.sleeping == [.seconds(1)] }
    clock.advance(by: .seconds(1))
    await until("drugie gniazdo") { backend.sockets.count == 2 }
    #expect(backend.opens.map(\.slot) == [.next, .number(3)])
    #expect(backend.opens.allSatisfy { $0.role == .shell })
    #expect(backend.socketCalls.map(\.fresh) == [true, false])
    let second = try #require(backend.lastSocket)
    second.emit(.opened)
    second.emit(.bytes(Data("nowe".utf8)))
    await until("nowe bajty") { received.count == 1 }
    #expect(received == [Data("nowe".utf8)])
  }

  @Test("zerwanie w środku wklejki porzuca resztę: po ponownym połączeniu nic nie dosyła się samo")
  func pasteInterrupted() async throws {
    let (session, backend, clock) = session(try #require(.shell(cwd: cwd)))
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let first = try #require(backend.lastSocket)
    first.emit(.opened)
    await until("żywe") { session.phase == .live }
    first.holdSends(true)
    let paste = String(repeating: String(repeating: "x", count: 79) + "\n", count: 250)
    #expect(session.paste(paste) == .queued)
    await until("pierwsza ramka w drodze") { first.sent.count == 1 }
    first.drop()
    await until("ponawianie") { session.phase == .reconnecting(attempt: 1) }
    await until("budzik") { clock.sleeping.count == 1 }
    clock.advance(by: .seconds(1))
    await until("drugie gniazdo") { backend.sockets.count == 2 }
    let second = try #require(backend.lastSocket)
    second.emit(.opened)
    await until("żywe") { session.phase == .live }
    try? await Task.sleep(for: .milliseconds(50))
    #expect(first.sent.count == 1)
    #expect(second.sent.isEmpty)
    // Pisanie po powrocie nie wypycha przed sobą reszty starej wklejki.
    #expect(session.send("y") == .queued)
    await until("ramka pisania") { !second.sent.isEmpty }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(second.sent == [.input("y")])
    // Wklejka jedzie ramkami `pa` (nigdy `in`), surowo — końce linii czyści serwer.
    guard case let .paste(text, end) = first.sent.first else { Issue.record("brak ramki `pa`"); return }
    #expect(text.contains("\n") && !end)
  }

  @Test("wklejka ponad 512 kB: nic nie wychodzi i widok wie dlaczego; pisanie w trakcie wklejki idzie ZA nią")
  func pasteCeilingAndOrder() async throws {
    let (session, backend, _) = session(try #require(.shell(cwd: cwd)))
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    #expect(session.paste(String(repeating: "x", count: TerminalWire.maxPasteBytes + 1)) == .tooLarge)
    #expect(session.paste(String(repeating: "x", count: 20_000)) == .queued)
    #expect(session.send("q") == .queued)
    await until("ramki") { socket.sent.count == 4 }
    #expect(socket.sent.map(\.type) == ["pa", "pa", "pa", "in"])
    guard case let .paste(_, end) = socket.sent[2] else { Issue.record("brak ramki `pa`"); return }
    #expect(end)
  }

  @Test("bramka zgodności odmawia wejścia: nic nie wychodzi, gniazdo zamknięte, terminal stoi ze zdaniem")
  func gateRefusesInput() async throws {
    let (session, backend, _) = session(try #require(.shell(cwd: cwd)))
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    await until("bramka przed gniazdem") { backend.read(\.gateChecks) == 1 }
    backend.set { $0.inputRefusal = CoreCopy.updateApp }
    #expect(session.send("rm -rf build\r") == .queued)
    await until("zatrzymanie") { session.phase.isHalted }
    #expect(session.phase == .failed(.incompatible(CoreCopy.updateApp)))
    #expect(socket.sent.isEmpty)
    #expect(socket.closedByClient)
    #expect(session.send("x") == .notConnected)
  }

  @Test("spóźniona odmowa bramki porzuconej próby nie zatrzymuje nowszej")
  func staleGateRefusalIgnored() async throws {
    let backend = FakeTerminalBackend()
    backend.hold("gate")
    // Pierwsza próba usłyszy odmowę, druga (po geście) — zgodę.
    backend.set { $0.gateResults = [CoreCopy.updateApp, nil] }
    let (session, _, _) = session(try #require(.id(termId)), backend: backend)
    session.start()
    await until("pierwsza bramka czeka") { backend.heldCount("gate") == 1 }
    session.restart()
    await until("druga bramka czeka") { backend.heldCount("gate") == 2 }
    backend.release("gate")
    await until("gniazdo drugiej próby") { backend.sockets.count == 1 }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(!session.phase.isHalted)
    #expect(session.phase == .connecting)
  }

  @Test("bramka przed gniazdem: terminal bez katalogu przy niezgodności trwałej nie otwiera gniazda")
  func gateBeforeSocket() async throws {
    let backend = FakeTerminalBackend()
    backend.set { $0.inputRefusal = CoreCopy.updateServer }
    let (session, _, _) = session(try #require(.id(termId)), backend: backend)
    session.start()
    await until("zatrzymanie") { session.phase.isHalted }
    #expect(session.phase == .failed(.incompatible(CoreCopy.updateServer)))
    #expect(backend.sockets.isEmpty)
  }

  @Test("`err` zatrzymuje automat: zamknięcie po nim i czas nie dają nowego POST")
  func errStopsAutomaton() async throws {
    let (session, backend, clock) = session(try #require(.shell(cwd: cwd)))
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    socket.emit(.frame(.error(message: "Limit otwartych terminali — zamknij inny terminal i spróbuj ponownie.")))
    socket.drop()
    await until("zatrzymanie") { session.phase.isHalted }
    clock.advance(by: .seconds(30))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(backend.opens.count == 1)
    #expect(session.phase == .failed(.server("Limit otwartych terminali — zamknij inny terminal i spróbuj ponownie.")))
    // Gest człowieka łączy od nowa.
    session.restart()
    await until("drugi POST") { backend.opens.count == 2 }
  }

  @Test("`err` z `msgRef`: zdanie w języku apki z renderera sesji; kod nieznany zostaje tekstem serwera")
  func errTranslated() async throws {
    for (ref, expected) in [
      (SentenceRef(code: "term.taken-over"), "Terminal został przejęty — otwórz go od nowa."),
      (SentenceRef(code: "term.from-the-future"), "The terminal was taken over. Open it again."),
    ] {
      let backend = FakeTerminalBackend()
      let session = TerminalSession(
        target: try #require(.shell(cwd: cwd)), transport: backend, renderer: ServerText.renderer(language: .pl))
      session.start()
      await until("gniazdo") { backend.lastSocket != nil }
      let socket = try #require(backend.lastSocket)
      socket.emit(.opened)
      socket.emit(.frame(.error(message: "The terminal was taken over. Open it again.", ref: ref)))
      await until("zatrzymanie") { session.phase.isHalted }
      #expect(session.phase == .failed(.server(expected)))
      session.stop()
    }
  }

  @Test("tło w trakcie POST: odpowiedź sprzed tła ignorowana; powrót = nowy POST i gniazdo `fresh=1`")
  func suspendDuringOpen() async throws {
    let backend = FakeTerminalBackend()
    backend.set { $0.holdOpens = true }
    let (session, _, _) = session(try #require(.shell(cwd: cwd)), backend: backend)
    session.start()
    await until("POST w drodze") { backend.opens.count == 1 }
    session.suspend()
    #expect(session.phase == .suspended)
    backend.releaseOpens()
    try? await Task.sleep(for: .milliseconds(30))
    #expect(backend.sockets.isEmpty)
    session.resume()
    await until("gniazdo po powrocie") { backend.sockets.count == 1 }
    #expect(backend.opens.count == 2)
    #expect(backend.socketCalls.first?.fresh == true)
  }

  @Test("`rs`: tylko przy zmianie (albo `force`), przed otwarciem rozmiar idzie do query następnego gniazda")
  func resizeRules() async throws {
    let (session, backend, _) = session(try #require(.shell(cwd: cwd)))
    let small = try #require(TerminalGrid(cols: 80, rows: 24))
    let big = try #require(TerminalGrid(cols: 151, rows: 12))
    session.resize(small)
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    #expect(backend.socketCalls.first?.grid == small)
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    await until("`rs` po otwarciu") { socket.sent == [.resize(small)] }
    session.resize(small)
    session.resize(big)
    session.resize(big)
    session.resize(big, force: true)
    await until("dwa kolejne `rs`") { socket.sent.count == 3 }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(socket.sent == [.resize(small), .resize(big), .resize(big)])
  }

  @Test("przewinięcie dzielone na ramki ±200 z komórką pod palcem; bez gniazda nic")
  func scroll() async throws {
    let (session, backend, _) = session(try #require(.shell(cwd: cwd)))
    let cell = try #require(TerminalCell(col: 40, row: 10))
    session.scroll(lines: 5, cell: cell)
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    session.scroll(lines: -450, cell: cell)
    await until("ramki") { socket.sent.count == 3 }
    #expect(socket.sent.map { frame -> Int in
      if case let .scroll(step) = frame { return step.lines }
      return 0
    } == [-200, -200, -50])
  }

  // MARK: Czasy próby świeżej (ślad otwarcia terminala)

  /// Sesja z zegarem monotonicznym pod kontrolą testu; sen ponawiania na zegarze wirtualnym.
  private func timedSession(
    _ target: TerminalTarget, backend: FakeTerminalBackend = FakeTerminalBackend()
  ) -> (TerminalSession, FakeTerminalBackend, VirtualClock, StepClock) {
    let sleeper = VirtualClock()
    let ticks = StepClock()
    let session = TerminalSession(
      target: target, transport: backend, sleep: { await sleeper.sleep($0) }, clock: { ticks.now })
    return (session, backend, sleeper, ticks)
  }

  @Test("start: znaczniki startu, odpowiedzi `POST`, otwarcia gniazda i pierwszych bajtów — raz, przed bajtami")
  func connectTimingOfStart() async throws {
    let backend = FakeTerminalBackend()
    backend.set { $0.holdOpens = true }
    let (session, _, _, ticks) = timedSession(try #require(.shell(cwd: cwd)), backend: backend)
    var log: [String] = []
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0); log.append("czasy") }
    session.onBytes = { _ in log.append("bajty") }
    let started = ticks.now
    session.start()
    await until("POST w drodze") { backend.opens.count == 1 }
    ticks.advance(by: .milliseconds(118))
    backend.releaseOpens()
    await until("gniazdo") { backend.lastSocket != nil }
    let socket = try #require(backend.lastSocket)
    ticks.advance(by: .milliseconds(205))
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    ticks.advance(by: .milliseconds(9))
    socket.emit(.bytes(Data("$ ".utf8)))
    socket.emit(.bytes(Data("ls".utf8)))
    await until("bajty") { log.count == 3 }
    #expect(log == ["czasy", "bajty", "bajty"], "czasy raz, przed pierwszymi bajtami")
    let timing = try #require(timings.first)
    #expect(timing == TerminalConnectTiming(
      trigger: .start, started: started, open: .answered(started + .milliseconds(118)),
      socketOpened: started + .milliseconds(323), firstBytes: started + .milliseconds(332)))
    #expect(timing.openEnded == started + .milliseconds(118))
  }

  @Test("cel bez katalogu: `POST` pominięty, gniazdo liczy się od startu próby")
  func connectTimingWithoutPost() async throws {
    let (session, backend, _, ticks) = timedSession(try #require(.id(termId)))
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0) }
    let started = ticks.now
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    #expect(backend.opens.isEmpty)
    let socket = try #require(backend.lastSocket)
    ticks.advance(by: .milliseconds(150))
    socket.emit(.opened)
    await until("żywe") { session.phase == .live }
    socket.emit(.bytes(Data("$ ".utf8)))
    await until("czasy") { timings.count == 1 }
    #expect(timings.first?.open == .skipped)
    #expect(timings.first?.openEnded == started)
    #expect(timings.first?.socketOpened == started + .milliseconds(150))
  }

  @Test("ponowienie po zerwaniu i gest „Spróbuj od nowa” bez czasów; powrót z tła z czasami `resume`")
  func connectTimingOnlyForFreshAttempts() async throws {
    let (session, backend, sleeper, _) = timedSession(try #require(.shell(cwd: cwd)))
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0) }
    var bytes = 0
    session.onBytes = { _ in bytes += 1 }
    // Pierwsza próba zerwana przed otwarciem gniazda: porzucona bez czasów, ponowienie też bez nich.
    session.start()
    await until("gniazdo") { backend.sockets.count == 1 }
    backend.sockets[0].drop()
    await until("budzik") { sleeper.sleeping.count == 1 }
    sleeper.advance(by: .seconds(1))
    await until("drugie gniazdo") { backend.sockets.count == 2 }
    backend.sockets[1].emit(.opened)
    await until("żywe") { session.phase == .live }
    backend.sockets[1].emit(.bytes(Data("a".utf8)))
    await until("bajty ponowienia") { bytes == 1 }
    #expect(timings.isEmpty, "ponowienie po zerwaniu nie ma śladu")
    // Tło i powrót: nowa próba świeża.
    session.suspend()
    session.resume()
    await until("gniazdo po powrocie") { backend.sockets.count == 3 }
    backend.sockets[2].emit(.opened)
    await until("żywe po powrocie") { session.phase == .live }
    backend.sockets[2].emit(.bytes(Data("b".utf8)))
    await until("czasy powrotu") { timings.count == 1 }
    #expect(timings.map(\.trigger) == [.resume])
    // `err`, potem gest: łączy od nowa, ale bez śladu otwarcia.
    backend.sockets[2].emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
    await until("zatrzymanie") { session.phase.isHalted }
    session.restart()
    await until("gniazdo po geście") { backend.sockets.count == 4 }
    backend.sockets[3].emit(.opened)
    await until("żywe po geście") { session.phase == .live }
    backend.sockets[3].emit(.bytes(Data("c".utf8)))
    await until("bajty po geście") { bytes == 3 }
    #expect(timings.count == 1, "gest „Spróbuj od nowa” bez śladu")
  }

  @Test("nowy terminal: powrót z tła w trakcie `next` — odpowiedź starego `POST` daje jedne czasy, wznowienia")
  func connectTimingWhileAwaitingAllocation() async throws {
    let backend = FakeTerminalBackend()
    backend.set { $0.holdOpens = true }
    let (session, _, _, ticks) = timedSession(try #require(.newShell(cwd: cwd)), backend: backend)
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0) }
    session.start()
    await until("`next` w drodze") { backend.opens.count == 1 }
    session.suspend()
    ticks.advance(by: .seconds(5))
    let resumed = ticks.now
    session.resume()
    ticks.advance(by: .milliseconds(40))
    backend.releaseOpens()
    await until("gniazdo po powrocie") { backend.sockets.count == 1 }
    #expect(backend.opens.count == 1, "bez drugiego `next`")
    backend.sockets[0].emit(.opened)
    await until("żywe") { session.phase == .live }
    backend.sockets[0].emit(.bytes(Data("$ ".utf8)))
    backend.sockets[0].emit(.bytes(Data("ls".utf8)))
    await until("czasy") { !timings.isEmpty }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(timings.count == 1)
    #expect(timings.first?.trigger == .resume)
    #expect(timings.first?.started == resumed)
    #expect(timings.first?.open == .answered(resumed + .milliseconds(40)))
  }

  // MARK: Gniazdo bez `POST`

  @Test("wpis z listy — gniazdo `direct=1` bez POST; odmowa → POST i zwykłe gniazdo od razu, bez budzika")
  func directSocketThenFallback() async throws {
    let entry = try #require(TerminalList.make([(termId, cwd, 1, .shell)]).terminals.first)
    let (session, backend, clock) = session(.existing(entry))
    var events: [TerminalSessionEvent] = []
    session.onEvent = { events.append($0) }
    session.start()
    await until("gniazdo bez POST") { backend.sockets.count == 1 }
    #expect(backend.opens.isEmpty)
    #expect(backend.socketCalls.first?.direct == true && backend.socketCalls.first?.fresh == true)
    backend.sockets[0].drop()
    await until("POST i drugie gniazdo") { backend.sockets.count == 2 }
    #expect(backend.opens.map(\.slot) == [.number(1)])
    #expect(backend.socketCalls.map(\.direct) == [true, false])
    #expect(backend.socketCalls.map(\.fresh) == [true, true])
    #expect(clock.sleeping.isEmpty, "bez czekania")
    #expect(session.phase == .connecting)
    backend.sockets[1].emit(.opened)
    await until("żywe") { session.phase == .live }
    #expect(events.isEmpty, "ten sam id — bez `retargeted`")
    #expect(backend.read(\.gateChecks) == 2, "bramka zgodności przed każdym gniazdem")
  }

  @Test("ślad — gniazdo bez POST to „POST pominięty”; odmowa daje „POST po odmowie” liczony od startu próby")
  func connectTimingOfDirectAttempts() async throws {
    let entry = try #require(TerminalList.make([(termId, cwd, 0, .popup)]).terminals.first)
    // Gniazdo przyjęte.
    let (direct, directBackend, _, directTicks) = timedSession(.existing(entry))
    var directTimings: [TerminalConnectTiming] = []
    direct.onConnectTiming = { directTimings.append($0) }
    let directStarted = directTicks.now
    direct.start()
    await until("gniazdo") { directBackend.sockets.count == 1 }
    directTicks.advance(by: .milliseconds(150))
    directBackend.sockets[0].emit(.opened)
    await until("żywe") { direct.phase == .live }
    directBackend.sockets[0].emit(.bytes(Data("$ ".utf8)))
    await until("czasy") { directTimings.count == 1 }
    #expect(directTimings.first?.open == .skipped)
    #expect(directTimings.first?.socketOpened == directStarted + .milliseconds(150))

    // Gniazdo odrzucone, potem `POST`.
    let backend = FakeTerminalBackend()
    backend.set { $0.holdOpens = true }
    let (session, _, _, ticks) = timedSession(.existing(entry), backend: backend)
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0) }
    let started = ticks.now
    session.start()
    await until("gniazdo bez POST") { backend.sockets.count == 1 }
    ticks.advance(by: .milliseconds(100))
    backend.sockets[0].drop()
    await until("POST po odmowie") { backend.opens.count == 1 }
    ticks.advance(by: .milliseconds(80))
    backend.releaseOpens()
    await until("drugie gniazdo") { backend.sockets.count == 2 }
    ticks.advance(by: .milliseconds(200))
    backend.sockets[1].emit(.opened)
    await until("żywe") { session.phase == .live }
    ticks.advance(by: .milliseconds(9))
    backend.sockets[1].emit(.bytes(Data("$ ".utf8)))
    await until("czasy") { timings.count == 1 }
    #expect(timings.first == TerminalConnectTiming(
      trigger: .start, started: started, open: .answeredAfterRefusal(started + .milliseconds(180)),
      socketOpened: started + .milliseconds(380), firstBytes: started + .milliseconds(389)))
  }

  @Test("odmowa, potem zerwanie także gniazda po POST — ponowienie po rytmie i bez śladu otwarcia")
  func directFallbackDropUsesBackoffWithoutTiming() async throws {
    let entry = try #require(TerminalList.make([(termId, cwd, 1, .shell)]).terminals.first)
    let (session, backend, sleeper, _) = timedSession(.existing(entry))
    var timings: [TerminalConnectTiming] = []
    session.onConnectTiming = { timings.append($0) }
    session.start()
    await until("gniazdo bez POST") { backend.sockets.count == 1 }
    backend.sockets[0].drop()
    await until("gniazdo po POST") { backend.sockets.count == 2 }
    backend.sockets[1].drop()
    await until("budzik 1 s") { sleeper.sleeping == [.seconds(1)] }
    #expect(session.phase == .reconnecting(attempt: 1))
    sleeper.advance(by: .seconds(1))
    await until("trzecie gniazdo") { backend.sockets.count == 3 }
    #expect(backend.opens.count == 2)
    #expect(backend.socketCalls.map(\.direct) == [true, false, false])
    backend.sockets[2].emit(.opened)
    await until("żywe") { session.phase == .live }
    backend.sockets[2].emit(.bytes(Data("$ ".utf8)))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(timings.isEmpty, "ponowienie po zerwaniu nie ma śladu")
  }

  @Test("`exit`: stan zakończony i zdarzenie dla popupu; `stop` zamyka gniazdo, spóźnione zdarzenia bez skutku")
  func exitAndStop() async throws {
    let (session, backend, _) = session(try #require(.popup(cwd: cwd, role: .lazygit)))
    var events: [TerminalSessionEvent] = []
    session.onEvent = { events.append($0) }
    session.start()
    await until("gniazdo") { backend.lastSocket != nil }
    #expect(backend.opens.first?.slot == nil && backend.opens.first?.role == .lazygit)
    let socket = try #require(backend.lastSocket)
    socket.emit(.opened)
    socket.emit(.frame(.exit))
    await until("koniec") { session.phase == .exited }
    #expect(events == [.exited])
    session.restart()
    await until("drugie gniazdo") { backend.sockets.count == 2 }
    session.stop()
    #expect(session.phase == .idle)
    #expect(backend.lastSocket?.closedByClient == true)
    backend.lastSocket?.emit(.opened)
    try? await Task.sleep(for: .milliseconds(30))
    #expect(session.phase == .idle)
  }
}
