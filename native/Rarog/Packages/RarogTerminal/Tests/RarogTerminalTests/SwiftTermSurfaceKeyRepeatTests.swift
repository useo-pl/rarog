#if os(iOS)
import GameController
@testable import RarogTerminal
import RarogUI
// `@testable`: zegar powtarzania SwiftTerm (`keyRepeat`) jest wewnętrzny, a test musi go uruchomić bez `UIPress`.
@preconcurrency @testable import SwiftTerm
import Testing
import UIKit

// Seria strzałki klawiatury sprzętowej na prawdziwej powierzchni SwiftTerm. Przytrzymania
// klawisza XCUITest nie umie, a `UIPress` nie da się zbudować — testy idą hakami (`beginArrowRepeat`,
// `arrowKeyReleased`) z krótkim wstrzykniętym taktem. Drogę `pressesEnded` → kontener sprawdza się na iPadzie
// (ślad w `client.log`). Bajty syntetyczne. Właściciel: terminal.

@MainActor
// Szeregowo: powiadomienia sceny i klawiatury są globalne, a równoległy test zatrzymałby cudzą serię.
@Suite("terminal: seria strzałki na powierzchni SwiftTerm (iOS)", .serialized)
struct SwiftTermSurfaceKeyRepeatTests {
  private final class Recorder {
    var typed: [String] = []
    var ends: [TerminalKeyRepeatEnd] = []
  }

  /// Powierzchnia w oknie z krótkim taktem: 30 ms pauzy, co 10 ms, sufit 5 s; `GCKeyboard` „nie wiadomo".
  private func repeating(ceiling: Duration = .seconds(5)) -> (SwiftTermSurface, Recorder, UIWindow) {
    let surface = makeSurface()
    let recorder = Recorder()
    surface.onInput = { recorder.typed.append($0) }
    surface.onKeyRepeatEnded = { recorder.ends.append($0) }
    surface.keyRepeatTiming = (delay: .milliseconds(30), interval: .milliseconds(10), ceiling: ceiling)
    surface.keyIsPressed = { _ in nil }
    let window = host(surface)
    return (surface, recorder, window)
  }

  @Test("pierwsze bajty od razu, potem seria; puszczenie TEJ strzałki ją zatrzymuje, puszczenie Shift nie")
  func releaseStopsMatchingKeyOnly() async throws {
    let (surface, recorder, window) = repeating()
    defer { window.isHidden = true }
    surface.beginArrowRepeat(keyCode: .keyboardLeftArrow, bytes: "\u{1B}[1;2D")
    #expect(recorder.typed == ["\u{1B}[1;2D"], "pierwsza strzałka bez czekania")
    await waitUntil { recorder.typed.count >= 5 }
    #expect(recorder.typed.count >= 5, "seria po pauzie")
    #expect(Set(recorder.typed) == ["\u{1B}[1;2D"])

    surface.arrowKeyReleased(.keyboardLeftShift, cancelled: false)
    let afterShift = recorder.typed.count
    try await Task.sleep(for: .milliseconds(60))
    #expect(recorder.typed.count > afterShift, "puszczenie Shift serii nie zatrzymuje")

    surface.arrowKeyReleased(.keyboardLeftArrow, cancelled: false)
    let stopped = recorder.typed.count
    try await Task.sleep(for: .milliseconds(80))
    #expect(recorder.typed.count == stopped, "po puszczeniu strzałki nic nie wychodzi")
    #expect(surface.arrowRepeat == nil)
    let end = try #require(recorder.ends.last)
    #expect(recorder.ends.count == 1)
    #expect(end.reason == .released)
    #expect(end.repeats == stopped - 1, "powtórzenia = bajty poza pierwszymi")
  }

  @Test("tap (puszczenie przed pauzą): jedna strzałka, zero powtórzeń")
  func tapSendsOnce() async throws {
    let (surface, recorder, window) = repeating()
    defer { window.isHidden = true }
    surface.beginArrowRepeat(keyCode: .keyboardUpArrow, bytes: "\u{1B}[A")
    surface.arrowKeyReleased(.keyboardUpArrow, cancelled: false)
    try await Task.sleep(for: .milliseconds(80))
    #expect(recorder.typed == ["\u{1B}[A"])
    #expect(recorder.ends.map(\.reason) == [.released])
    #expect(recorder.ends.first?.repeats == 0)
  }

  @Test("anulowanie, oddanie fokusu, zejście z okna i `close()` zatrzymują serię")
  func otherStops() async throws {
    let cases: [(TerminalKeyRepeatStop, @MainActor (SwiftTermSurface) -> Void)] = [
      (.cancelled, { $0.arrowKeyReleased(.keyboardRightShift, cancelled: true) }),
      (.cancelled, { $0.pressesCancelled([], with: nil) }),
      (.resigned, { _ = $0.resignFirstResponder() }),
      (.detached, { $0.removeFromSuperview() }),
      (.closed, { $0.close() }),
    ]
    for (reason, stop) in cases {
      let (surface, recorder, window) = repeating()
      surface.beginArrowRepeat(keyCode: .keyboardDownArrow, bytes: "\u{1B}[B")
      await waitUntil { recorder.typed.count >= 3 }
      stop(surface)
      let stopped = recorder.typed.count
      try await Task.sleep(for: .milliseconds(60))
      #expect(recorder.typed.count == stopped, "\(reason): seria stoi")
      #expect(surface.arrowRepeat == nil, "\(reason)")
      #expect(recorder.ends.map(\.reason) == [reason], "\(reason): ślad przed odpięciem wywołań zwrotnych")
      window.isHidden = true
    }
  }

  @Test("scena traci aktywność albo klawiatura odchodzi: seria staje bezwarunkowo")
  func sceneAndKeyboardStop() async throws {
    for (reason, name) in [
      (TerminalKeyRepeatStop.sceneInactive, UIScene.willDeactivateNotification),
      (.keyboardDisconnected, Notification.Name.GCKeyboardDidDisconnect),
    ] {
      let (surface, recorder, window) = repeating()
      surface.beginArrowRepeat(keyCode: .keyboardDownArrow, bytes: "\u{1B}[B")
      NotificationCenter.default.post(name: name, object: nil)
      await waitUntil { surface.arrowRepeat == nil }
      #expect(surface.arrowRepeat == nil, "\(reason)")
      #expect(recorder.ends.map(\.reason) == [reason])
      window.isHidden = true
    }
  }

  @Test("zapas GCKeyboard: „puszczony” po „wciśnięty” zatrzymuje; bez „wciśnięty” — dopiero sufit")
  func gameControllerAndCeiling() async throws {
    let (surface, recorder, window) = repeating()
    defer { window.isHidden = true }
    var pressed = true
    surface.keyIsPressed = { _ in pressed }
    surface.beginArrowRepeat(keyCode: .keyboardLeftArrow, bytes: "\u{1B}[D")
    await waitUntil { recorder.typed.count >= 3 }
    pressed = false
    await waitUntil { surface.arrowRepeat == nil }
    #expect(recorder.ends.map(\.reason) == [.gameController])

    // Sufit z zapasem na zajęty główny aktor. W pełnym przebiegu pakietu zestawy `@MainActor` z innych plików
    // biegną równolegle i trzymają go po 70–165 ms naraz (pomiar pod obciążeniem), a obrót spóźniony za sufit nic
    // nie wysyła (`ceilingIsWallClock`). Przy 120 ms seria nie zdążała ruszyć; 1 s mieści wiele takich przestojów.
    let (blind, blindRecorder, blindWindow) = repeating(ceiling: .seconds(1))
    defer { blindWindow.isHidden = true }
    blind.keyIsPressed = { _ in false }  // GCKeyboard nie widzi klawisza wcale — jego „puszczony” nic nie znaczy
    blind.beginArrowRepeat(keyCode: .keyboardLeftArrow, bytes: "\u{1B}[D")
    await waitUntil { blind.arrowRepeat == nil }
    #expect(blindRecorder.ends.map(\.reason) == [.ceiling])
    #expect(blindRecorder.typed.count > 3, "do sufitu seria szła")
  }

  @Test("przejęcie strzałki: bajty z mapy, DECCKM z emulatora, Cmd nie; po `ESC[>1u` (kitty) — SwiftTerm")
  func capture() {
    let (surface, _, window) = repeating()
    defer { window.isHidden = true }
    #expect(surface.arrowCapture(.keyboardUpArrow, modifiers: []) == "\u{1B}[A")
    #expect(surface.arrowCapture(.keyboardLeftArrow, modifiers: .alternate) == "\u{1B}b")
    #expect(surface.arrowCapture(.keyboardRightArrow, modifiers: [.shift, .control]) == "\u{1B}[1;6C")
    #expect(surface.arrowCapture(.keyboardUpArrow, modifiers: .command) == nil)
    #expect(surface.arrowCapture(.keyboardHome, modifiers: []) == nil, "nie strzałka")
    surface.feed(Data("\u{1B}[?1h".utf8))
    #expect(surface.arrowCapture(.keyboardUpArrow, modifiers: []) == "\u{1B}OA", "tryb kursorów aplikacji")
    surface.feed(Data("\u{1B}[?1l\u{1B}[>1u".utf8))
    #expect(!surface.getTerminal().keyboardEnhancementFlags.isEmpty)
    #expect(surface.arrowCapture(.keyboardUpArrow, modifiers: []) == nil, "protokół kitty: koduje SwiftTerm")
  }

  @Test("przejęta strzałka gasi zegar powtarzania SwiftTerm klawisza trzymanego wcześniej")
  func stopsSwiftTermRepeat() async throws {
    let (surface, recorder, window) = repeating()
    defer { window.isHidden = true }
    // Zegar SwiftTerm jak po przytrzymanym F5 (`pressesBegan` → `keyRepeat`, 0,4 s + 0,1 s; tu krócej).
    let timer = Timer(fire: Date(), interval: 0.01, repeats: true) { _ in
      MainActor.assumeIsolated { surface.send(txt: "\u{1B}[15~") }
    }
    RunLoop.main.add(timer, forMode: .common)
    surface.keyRepeat = timer
    await waitUntil { recorder.typed.count >= 3 }
    #expect(recorder.typed.allSatisfy { $0 == "\u{1B}[15~" }, "zegar SwiftTerm biegnie")
    let before = recorder.typed.count
    surface.beginArrowRepeat(keyCode: .keyboardUpArrow, bytes: "\u{1B}[A")
    try await Task.sleep(for: .milliseconds(150))
    let after = recorder.typed.dropFirst(before)
    #expect(!after.isEmpty)
    #expect(after.allSatisfy { $0 == "\u{1B}[A" }, "po przejęciu wychodzą wyłącznie strzałki: \(Array(after))")
    #expect(surface.keyRepeat == nil || surface.keyRepeat?.isValid == false)
    timer.invalidate()
  }

  @Test("sufit liczy realny czas: obrót spóźniony za sufit nic nie wysyła")
  func ceilingIsWallClock() async throws {
    let (surface, recorder, window) = repeating(ceiling: .milliseconds(100))
    defer { window.isHidden = true }
    surface.beginArrowRepeat(keyCode: .keyboardRightArrow, bytes: "\u{1B}[C")
    // Główny aktor zajęty dłużej niż sufit (np. ciężki render): zadanie serii wznawia się dopiero po nim.
    blockMainActor(seconds: 0.3)
    await waitUntil { surface.arrowRepeat == nil }
    #expect(recorder.typed == ["\u{1B}[C"], "po wznowieniu za sufitem żadnego powtórzenia")
    #expect(recorder.ends.map(\.reason) == [.ceiling])
  }

  /// Główny aktor zajęty synchronicznie (zadania na nim czekają) — `Thread.sleep` wprost z kontekstu `async` jest
  /// niedostępny.
  private func blockMainActor(seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }

  @Test("nowa seria zastępuje poprzednią bez śladu „inny klawisz” z haka")
  func newSeriesReplaces() async throws {
    let (surface, recorder, window) = repeating()
    defer { window.isHidden = true }
    surface.beginArrowRepeat(keyCode: .keyboardUpArrow, bytes: "\u{1B}[A")
    surface.beginArrowRepeat(keyCode: .keyboardDownArrow, bytes: "\u{1B}[B")
    await waitUntil { recorder.typed.count >= 4 }
    #expect(recorder.typed.first == "\u{1B}[A")
    #expect(recorder.typed.dropFirst().allSatisfy { $0 == "\u{1B}[B" }, "stara seria nie wróciła")
    surface.arrowKeyReleased(.keyboardDownArrow, cancelled: false)
    #expect(recorder.ends.map(\.reason) == [.released])
  }
}
#endif
