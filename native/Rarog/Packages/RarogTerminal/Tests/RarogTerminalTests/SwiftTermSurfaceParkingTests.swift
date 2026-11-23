#if os(iOS)
import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Powierzchnia SwiftTerm poza oknem (parking ekranów terminala): zaparkowany ekran dalej dostaje bajty PTY,
// a po ponownym osadzeniu ma pokazać bieżący ekran. Źródła SwiftTerm 1.19.0: `CADisplayLink` odświeżania stoi
// zatrzymany poza `feed` (`setupDisplayUpdates`, `feedPrepare`/`feedFinish`), rysowanie idzie przez
// `setNeedsDisplay` z `queuePendingDisplay` — więc poza oknem nic nie chodzi w pętli, a warstwa czeka na rysowanie.
// Bajty SYNTETYCZNE. Właściciel: terminal.

@MainActor
@Suite("terminal: powierzchnia SwiftTerm poza oknem")
struct SwiftTermSurfaceParkingTests {
  @Test("poza oknem bajty trafiają do emulatora, a warstwa czeka na rysowanie; po powrocie do okna rysuje się")
  func feedOffWindowDrawsAfterReturn() async throws {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    surface.feed(Data("\u{1B}[2J\u{1B}[Hraz".utf8))
    #expect(try await drawn(surface), "w oknie narysowane")

    surface.removeFromSuperview()
    #expect(surface.window == nil)
    surface.feed(Data("\r\ndwa".utf8))
    try await Task.sleep(for: .milliseconds(100))
    #expect(surface.visibleText == "raz\ndwa", "emulator ma bieżący ekran")
    #expect(surface.layer.needsDisplay(), "poza oknem warstwa czeka na rysowanie")

    window.addSubview(surface)
    surface.layoutIfNeeded()
    #expect(try await drawn(surface), "po powrocie do okna narysowane")
    #expect(surface.visibleText == "raz\ndwa")
  }

  /// Rysowanie w oknie przychodzi z pętlą układu, nie w stałym czasie: zimny symulator potrzebował ponad 100 ms.
  /// Czekamy do 2 s, sprawdzając co 20 ms.
  private func drawn(_ surface: UIView) async throws -> Bool {
    for _ in 0..<100 {
      if !surface.layer.needsDisplay() { return true }
      try await Task.sleep(for: .milliseconds(20))
    }
    return !surface.layer.needsDisplay()
  }
}
#endif
