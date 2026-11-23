import Foundation
@testable import RarogUI
import Testing

// Wejście w sesję na ekranie stanu Codexa i terminala Raroga: zwalnia ręczne „nieprzeczytane” raz na wejście.

@Suite("wejście w sesję bez kontrolera sesji")
struct ResultEntryMemoryTests {
  @Test("raz na wejście; inna sesja to nowe wejście; ten sam wynik i powrót apki — nie")
  func oncePerEntry() {
    var memory = ResultEntryMemory()
    let entries = ["s1", "s1", "s2", "s1"].map { memory.enters($0) }
    // Drugie `s1`: zmiana wyniku albo powrót apki na wierzch to nie nowe wejście.
    #expect(entries == [true, false, true, true])
  }

  @Test("terminal bez agenta zeruje pamięć — powrót do tej samej sesji jest nowym wejściem")
  func bareTerminalResets() {
    var memory = ResultEntryMemory()
    let entries = ["s1", nil, "s1"].map { memory.enters($0) }
    #expect(entries == [true, false, true])
  }
}
