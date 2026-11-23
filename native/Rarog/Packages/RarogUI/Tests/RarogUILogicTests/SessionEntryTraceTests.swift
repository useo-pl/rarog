import Foundation
import RarogContract
@testable import RarogUI
import Testing

// Okno wejścia do sesji i jego podbudżet 6 linii na godzinę. Linię składa
// `DiagnosticsTrace.sessionEntry` (testy w `DiagnosticsTraceLineTests`); ekran, który karmi okno, to
// `SessionViewController` (UIKit). Właściciel: transkrypt.

@Suite("ślad wejścia do sesji: okno od otwarcia do ciszy i podbudżet")
struct SessionEntryTraceTests {
  private let t0 = ContinuousClock.now

  private func at(_ milliseconds: Int) -> ContinuousClock.Instant { t0 + .milliseconds(milliseconds) }

  private func counts(_ renders: Int, _ settles: Int, _ bottomScrolls: Int) -> SessionEntryCounts {
    SessionEntryCounts(renders: renders, settles: settles, bottomScrolls: bottomScrolls)
  }

  @Test("szkielet: pierwsza ramka = pierwszy nowy pełny stan; cisza 500 ms po ostatniej zmianie liczników zamyka okno")
  func coldEntry() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 0, counts: counts(0, 0, 0))
    let skeleton = window.observe(.renderStart, snapshots: 0, counts: counts(1, 1, 0), now: at(10))
    #expect(!skeleton, "szkielet bez ramki")
    let beforeFrame = window.check(counts: counts(1, 1, 0), now: at(300))
    #expect(beforeFrame == .wait(until: at(10_000)))
    let frame = window.observe(.renderStart, snapshots: 1, counts: counts(2, 1, 0), now: at(412))
    #expect(frame, "pierwsza ramka")
    let settle = window.observe(.layout, snapshots: 1, counts: counts(2, 2, 3), now: at(500))
    let render = window.observe(.renderEnd, snapshots: 1, counts: counts(3, 3, 4), now: at(642))
    #expect(!settle && !render)
    let early = window.check(counts: counts(3, 3, 4), now: at(900))
    #expect(early == .wait(until: at(1142)))
    let quiet = window.check(counts: counts(3, 3, 4), now: at(1142))
    #expect(quiet == .done(.init(origin: .skeleton, firstFrame: 412, settled: 230, counts: counts(3, 3, 4))))
    let again = window.check(counts: counts(9, 9, 9), now: at(5000))
    #expect(again == .abandoned, "okno zamknięte raz")
  }

  @Test("z pamięci: liczniki od otwarcia ekranu, ramka dopiero po nowym pełnym stanie; zmiana złapana przy sprawdzeniu")
  func memoryEntry() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 2, counts: counts(1, 0, 0))
    let old = window.observe(.renderStart, snapshots: 2, counts: counts(2, 1, 1), now: at(5))
    #expect(!old, "stary stan to nie ramka")
    let frame = window.observe(.renderStart, snapshots: 3, counts: counts(3, 1, 1), now: at(180))
    #expect(frame)
    // Zmiana bez punktu obserwacji (np. przewinięcie w `+Pinning`) liczy się od chwili sprawdzenia.
    let caught = window.check(counts: counts(3, 2, 2), now: at(680))
    #expect(caught == .wait(until: at(1180)))
    let quiet = window.check(counts: counts(3, 2, 2), now: at(1180))
    #expect(quiet == .done(.init(origin: .memory, firstFrame: 180, settled: 500, counts: counts(2, 2, 2))))
  }

  @Test("nowy stan widziany przez układ albo przewinięcie przed renderem nie otwiera ramki; otwiera ją początek renderu")
  func frameOnlyFromRenderStart() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 0, counts: counts(0, 0, 0))
    // Migawka już w magazynie, render czeka na dławik 60 ms; układ i zmiana wysokości treści widzą nowy stan.
    let layout = window.observe(.layout, snapshots: 1, counts: counts(1, 1, 0), now: at(400))
    let scroll = window.observe(.layout, snapshots: 1, counts: counts(1, 1, 1), now: at(420))
    let end = window.observe(.renderEnd, snapshots: 1, counts: counts(1, 1, 1), now: at(430))
    #expect(!layout && !scroll && !end, "bez początku renderu ramki nie ma")
    let start = window.observe(.renderStart, snapshots: 1, counts: counts(2, 1, 1), now: at(460))
    #expect(start, "pierwsza ramka z czasem początku renderu")
    let quiet = window.check(counts: counts(2, 1, 1), now: at(960))
    #expect(quiet == .done(.init(origin: .skeleton, firstFrame: 460, settled: 0, counts: counts(2, 1, 1))))
  }

  @Test("rozmiar ramki poza głównym aktorem: JSON wiadomości w kB, jak liczony na miejscu")
  @MainActor
  func frameKilobytes() async throws {
    let text = String(repeating: "x", count: 3000)
    let messages = (1...40).map { seq in
      Sample.decode(TranscriptMessage.self,
        #"{"seq":\#(seq),"role":"assistant","blocks":[{"type":"text","text":"\#(text)"}],"at":"2026-11-10T10:00:00Z"}"#)
    }
    let expected = SessionEntryWindow.kilobytes(bytes: try JSONEncoder().encode(messages).count)
    #expect(expected >= 117)
    let measured = await SessionEntryWindow.kilobytes(of: messages)
    #expect(measured == expected)
    let cancelled = Task { @MainActor in
      withUnsafeCurrentTask { $0?.cancel() }
      return await SessionEntryWindow.kilobytes(of: messages)
    }
    let cancelledKilobytes = await cancelled.value
    #expect(cancelledKilobytes == 0, "anulowane zadanie nie koduje")
  }

  @Test("koniec renderu pierwszej ramki liczy się do czasu ciszy, choć liczniki stoją")
  func renderEnd() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 0, counts: counts(0, 0, 0))
    let frame = window.observe(.renderStart, snapshots: 1, counts: counts(2, 0, 0), now: at(300))
    let end = window.observe(.renderEnd, snapshots: 1, counts: counts(2, 0, 0), now: at(420))
    let layout = window.observe(.layout, snapshots: 1, counts: counts(2, 0, 0), now: at(450))
    #expect(frame && !end && !layout)
    let quiet = window.check(counts: counts(2, 0, 0), now: at(920))
    #expect(quiet == .done(.init(origin: .skeleton, firstFrame: 300, settled: 120, counts: counts(2, 0, 0))))
  }

  @Test("bez ciszy do sufitu 10 s od ramki: linia z sufitem zamiast czasu ciszy")
  func ceiling() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 0, counts: counts(0, 0, 0))
    let frame = window.observe(.renderStart, snapshots: 1, counts: counts(1, 0, 0), now: at(100))
    #expect(frame)
    for step in 1...40 { _ = window.observe(.layout, snapshots: 1, counts: counts(1 + step, step, step), now: at(100 + step * 249)) }
    let last = counts(41, 40, 40)
    let early = window.check(counts: last, now: at(10_080))
    #expect(early == .wait(until: at(10_100)))
    let capped = window.check(counts: last, now: at(10_100))
    #expect(capped == .done(.init(origin: .skeleton, firstFrame: 100, settled: nil, counts: last)))
  }

  @Test("ramka nie przyszła w 10 s od otwarcia (ogon bez pełnego stanu): okno porzucone, bez linii")
  func noFrame() {
    var window = SessionEntryWindow(opened: at(0), snapshotsAtEntry: 1, counts: counts(0, 0, 0))
    let tail = window.observe(.renderStart, snapshots: 1, counts: counts(4, 2, 2), now: at(3000))
    #expect(!tail)
    let expired = window.check(counts: counts(4, 2, 2), now: at(10_000))
    #expect(expired == .abandoned)
    let late = window.observe(.renderStart, snapshots: 2, counts: counts(5, 2, 2), now: at(11_000))
    #expect(!late, "po porzuceniu ramka nic nie zmienia")
  }

  @Test("kilobajty zaokrąglone, nigdy ujemne")
  func kilobytes() {
    #expect(SessionEntryWindow.kilobytes(bytes: 187_000) == 183)
    #expect(SessionEntryWindow.kilobytes(bytes: 511) == 0)
    #expect(SessionEntryWindow.kilobytes(bytes: 512) == 1)
    #expect(SessionEntryWindow.kilobytes(bytes: -5) == 0)
  }

  @Test("podbudżet: 6 linii na godzinę, siódme wejście w godzinie nie pisze; nowe okno od nowa")
  func budget() {
    var budget = SessionEntryTraceBudget()
    let admitted = (0..<8).map { budget.admit(now: t0 + .seconds($0 * 60)) }
    #expect(admitted == [true, true, true, true, true, true, false, false])
    let lastMinute = budget.admit(now: t0 + .seconds(3599))
    #expect(!lastMinute, "do końca okna cisza")
    let nextWindow = budget.admit(now: t0 + .seconds(3600))
    #expect(nextWindow, "nowe okno")
    let next = (1..<7).map { budget.admit(now: t0 + .seconds(3600 + $0)) }
    #expect(next == [true, true, true, true, true, false])
  }

  @Test("podbudżet nie zjada budżetu ogólnego: po 8 wejściach w godzinie zostaje 14 z 20 śladów, terminal liczy osobno")
  func budgetShare() {
    // Budżet ogólny `ContractReporter.traceCap` = 20 na godzinę (RarogCore, `DiagnosticsTraceTests`).
    let generalCap = 20
    var entries = SessionEntryTraceBudget()
    var terminal = TerminalOpenTraceBudget()
    let entryLines = (0..<8).filter { entries.admit(now: t0 + .seconds($0)) }.count
    #expect(entryLines == SessionEntryTraceBudget.cap)
    #expect(generalCap - entryLines == 14)
    let terminalLine = terminal.admit(now: t0 + .seconds(9))
    #expect(terminalLine, "podbudżet terminala nie dzieli licznika z wejściem do sesji")
  }
}
