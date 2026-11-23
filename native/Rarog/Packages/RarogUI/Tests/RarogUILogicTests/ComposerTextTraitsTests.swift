@testable import RarogUI
import Testing

// Cechy klawiatury pola wiadomości przy komendzie „/”. Zachowanie wysuniętej klawiatury
// (`reloadInputViews`) odbiera się na urządzeniu: `/compact --force` zostaje z `--`. Właściciel: pole.

@Suite("pole wiadomości: cechy klawiatury przy komendzie „/” (ComposerTextTraits)")
struct ComposerTextTraitsTests {
  /// Wszystko, co przerabia wpisany tekst, wyłączone.
  private func expectOff(_ traits: ComposerTextTraits, _ comment: Comment) {
    #expect(traits == .command, comment)
    #expect(!traits.autocorrects, comment)
    #expect(!traits.capitalizesSentences, comment)
    #expect(!traits.checksSpelling, comment)
    #expect(!traits.smartDashes, comment)
    #expect(!traits.smartQuotes, comment)
    #expect(!traits.smartInsertDelete, comment)
  }

  @Test("komenda: autokorekta, wielka litera, pisownia, myślniki, cudzysłowy i wstawianie wyłączone")
  func commandTurnsEverythingOff() {
    expectOff(ComposerTextTraits(text: "/compact --force"), "argumenty z `--`")
    expectOff(ComposerTextTraits(text: "/"), "sam ukośnik — zaraz pójdzie nazwa")
    expectOff(ComposerTextTraits(text: #"/rename "nowa nazwa""#), "cudzysłowy proste")
  }

  @Test("wiodące białe znaki nie zmieniają komendy w zwykły tekst (jak `trimStart` serwera)")
  func leadingWhitespace() {
    expectOff(ComposerTextTraits(text: "  /x"), "spacje")
    expectOff(ComposerTextTraits(text: "\n\t /compact"), "nowa linia i tabulator")
    expectOff(ComposerTextTraits(text: "\u{FEFF}/compact --force"), "BOM z wklejki: `trimStart` go zdejmuje")
    expectOff(ComposerTextTraits(text: "\u{3000}\u{A0}/x"), "spacja ideograficzna i twarda (Zs)")
    #expect(ComposerTextTraits(text: "\u{85}/x") == .message, "NEL: `trimStart` go nie zdejmuje, więc to prompt")
  }

  @Test("zwykła wiadomość i puste pole: cechy, które pole miało zawsze")
  func messageKeepsTodaysTraits() {
    let message = ComposerTextTraits.message
    #expect(message.autocorrects && message.capitalizesSentences && message.checksSpelling)
    #expect(message.smartDashes && message.smartQuotes && message.smartInsertDelete)
    #expect(ComposerTextTraits(text: "tekst / tekst") == .message, "ukośnik w środku")
    #expect(ComposerTextTraits(text: "") == .message, "puste pole")
    #expect(ComposerTextTraits(text: "   ") == .message, "same spacje")
    #expect(ComposerTextTraits(text: "a/b") == .message)
  }

  @Test("usunięcie ukośnika wraca do cech zwykłej wiadomości")
  func backFromCommand() {
    let before = ComposerTextTraits(text: "/a")
    let after = ComposerTextTraits(text: "a")
    #expect(before == .command)
    #expect(after == .message)
    #expect(before != after, "zmiana zestawu = jedno przeładowanie klawiatury")
  }

  /// Pole zapamiętuje, jakie cechy ma (`ComposerView.textTraits`), i przeładowuje klawiaturę tylko przy zmianie.
  /// Cecha zapisana w polu poza `ComposerTextTraits` rozjechałaby ten stan z tym, co pole ma naprawdę.
  @Test("cechy klawiatury pola zapisuje wyłącznie ComposerTextTraits")
  func singleRule() throws {
    let composer = try SessionListSourceTests.code("Session/ComposerView.swift")
    // The field's topic files (`ComposerView.swift` names them) write no trait of their own either.
    for file in [
      "ComposerView.swift", "ComposerTextView.swift", "ComposerView+Suggestions.swift", "ComposerView+Attachments.swift",
    ] {
      let code = try SessionListSourceTests.code("Session/\(file)")
      for trait in [
        "autocorrectionType", "autocapitalizationType", "spellCheckingType", "smartDashesType", "smartQuotesType",
        "smartInsertDeleteType",
      ] {
        #expect(!code.contains(trait), "\(file): \(trait)")
      }
    }
    #expect(composer.contains("textTraits.apply(to: textView)"), "cechy startowe z tego samego typu")
  }
}
