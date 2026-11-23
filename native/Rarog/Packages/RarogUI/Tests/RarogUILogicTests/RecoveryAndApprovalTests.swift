import Foundation
import RarogCore
@testable import RarogUI
import Testing

@Suite("nieudana wysyłka: tekst nie ginie")
struct SendRecoveryTests {
  @Test("odmowa przy żywym ekranie: tekst do pola, wpis znika; po wyjściu z sesji wpis ZOSTAJE")
  func refused() {
    let id = UUID()
    let outcome = SendOutcome.refused(id, code: "refused", message: "Nie teraz.")
    #expect(SendRecovery.plan(outcome, screenAttached: true) == .restoreToField(discard: id))
    #expect(SendRecovery.plan(outcome, screenAttached: false) == .keepEntry)
  }

  @Test("blokada i odmowa dysku (bez wpisu): przy żywym ekranie do pola, bez ekranu do szkicu sesji")
  func withoutEntry() {
    #expect(SendRecovery.plan(.blocked(.herdrReadOnly), screenAttached: true) == .restoreToField(discard: nil))
    #expect(SendRecovery.plan(.blocked(.herdrReadOnly), screenAttached: false) == .saveDraft)
    #expect(SendRecovery.plan(.notPersisted("dysk"), screenAttached: false) == .saveDraft)
  }

  @Test("przyjęta, niepotwierdzona i pusta: nic do odzyskania (wpis sam stoi w transkrypcie)")
  func nothing() {
    #expect(SendRecovery.plan(.accepted(UUID()), screenAttached: false) == .none)
    #expect(SendRecovery.plan(.unconfirmed(UUID()), screenAttached: false) == .none)
    #expect(SendRecovery.plan(.empty, screenAttached: true) == .none)
  }

  @Test("the stop in the ring, before and during the request: nothing to the field or the draft, no sentence under it")
  func stop() {
    let id = UUID()
    let stopped = SendOutcome.refused(id, code: OutboxEntry.RefusalCode.cancelled, message: nil)
    for screenAttached in [true, false] {
      #expect(SendRecovery.plan(stopped, screenAttached: screenAttached) == .none, "before the request")
      #expect(SendRecovery.plan(.unconfirmed(id), screenAttached: screenAttached) == .none, "during the request")
    }
    let result = UICopy.sendResult(stopped, session: nil)
    #expect(result.text == nil && !result.restore, "the entry says it in the transcript")
  }

  @MainActor
  @Test("szkic sesji: nieudany tekst na górze, odczyt go zabiera, inne sesje nietknięte")
  func drafts() {
    let drafts = ComposerDrafts()
    drafts.save("pierwszy", note: "Powód A.", for: "s1")
    drafts.save("drugi", note: nil, for: "s1")
    #expect(drafts.take(for: "s2") == nil)
    #expect(drafts.take(for: "s1") == ComposerDrafts.Draft(text: "drugi\npierwszy", note: "Powód A."))
    #expect(drafts.take(for: "s1") == nil)
  }

  /// Regresja: szkic z ekranu zamkniętego w trakcie wysyłki czekał na NASTĘPNE
  /// otwarcie, choć ekran tej sesji już stał.
  @MainActor
  @Test("szkic dociera do ekranu otwartego w międzyczasie; ekran poza oknem zostawia go następnemu")
  func draftReachesOpenScreen() {
    let drafts = ComposerDrafts()
    var field: [String] = []
    var onScreen = true
    drafts.watch("s1") {
      guard onScreen, let draft = drafts.take(for: "s1") else { return }
      field.append(draft.text)
    }
    drafts.save("odmowa", note: "Powód.", for: "s1")
    #expect(field == ["odmowa"])
    #expect(drafts.take(for: "s1") == nil, "szkic trafił do pola, nie czeka drugi raz")
    onScreen = false
    drafts.save("później", note: nil, for: "s1")
    #expect(field == ["odmowa"])
    #expect(drafts.take(for: "s1")?.text == "później", "szkic czeka na następne otwarcie")
    drafts.save("inna", note: nil, for: "s2")
    #expect(field == ["odmowa"], "inna sesja nie budzi tego ekranu")
  }
}

@Suite("zgoda wyłącznie gestem")
struct ApprovalGateTests {
  @Test("dotyk i klik wskaźnikiem zatwierdzają; akcja dostępności tylko pod VoiceOverem (dwukrotne stuknięcie)")
  func gate() {
    for keyboard in [false, true] {
      #expect(ApprovalGate.accepts(.touchOrPointer, voiceOverRunning: false, hardwareKeyboard: keyboard))
      #expect(ApprovalGate.accepts(.touchOrPointer, voiceOverRunning: true, hardwareKeyboard: keyboard))
    }
    // VoiceOver bez klawiatury: jedyną drogą do akcji jest gest — dwukrotne stuknięcie zatwierdza.
    #expect(ApprovalGate.accepts(.accessibilityActivation, voiceOverRunning: true, hardwareKeyboard: false))
    // Spacja/Enter na przycisku z fokusem (Full Keyboard Access) to ta sama akcja bez VoiceOvera.
    #expect(!ApprovalGate.accepts(.accessibilityActivation, voiceOverRunning: false, hardwareKeyboard: true))
    #expect(!ApprovalGate.accepts(.accessibilityActivation, voiceOverRunning: false, hardwareKeyboard: false))
    #expect(ApprovalGate.refusalSpoken(.accessibilityActivation, voiceOverRunning: false, hardwareKeyboard: true) == nil)
  }

  @Test("VO+Spacja z klawiatury sprzętowej nie zatwierdza: ta sama akcja co stuknięcie, więc z klawiaturą żadna")
  func voiceOverWithKeyboard() throws {
    // Fokus VoiceOvera na „Zatwierdź" (także opcja eskalująca, zaufanie, zmiana modelu) → VO+Spacja →
    // domyślna akcja dostępności. Nie da się jej odróżnić od dwukrotnego stuknięcia — fail-closed.
    #expect(!ApprovalGate.accepts(.accessibilityActivation, voiceOverRunning: true, hardwareKeyboard: true))
    #expect(ApprovalGate.refusalSpoken(.accessibilityActivation, voiceOverRunning: true, hardwareKeyboard: true)
      == UICopy.approvalKeyboardSpoken)
    #expect(ApprovalGate.refusalSpoken(.touchOrPointer, voiceOverRunning: true, hardwareKeyboard: true) == nil)
    // Przycisk pyta o klawiaturę w chwili aktywacji, każdą drogą przez tę samą bramkę.
    let buttons = try String(contentsOf: Self.sourceFile("Session/Buttons.swift"), encoding: .utf8)
    #expect(buttons.contains("let keyboard = GCKeyboard.coalesced != nil"))
    #expect(buttons.contains(".accessibilityAction { activate(.accessibilityActivation) }"))
    #expect(buttons.contains(".onTapGesture { activate(.touchOrPointer) }"))
  }

  @Test("karta zgody: „Zatwierdź” to GestureOnlyButton, nie systemowy Button; bez skrótu klawiszowego")
  func cardSource() throws {
    let source = try String(contentsOf: Self.sourceFile("Session/Cards/PermissionCard.swift"), encoding: .utf8)
    let code = Self.withoutComments(source)
    // Każda zgoda (zwykła, planu, eskalująca) wychodzi z akcji `GestureOnlyButton`: najbliższy konstruktor
    // przycisku przed `decide(.allow…)` jest gestowy. Sama obecność `GestureOnlyButton(` w pliku nie
    // wystarczała — spełniał ją przycisk eskalacji, gdy zgoda główna była systemowym `Button(`.
    for call in ["decide(.allow)", "decide(.allowAlways)"] {
      let owners = Self.buttonOwners(of: call, in: code)
      #expect(!owners.isEmpty, "\(call) zniknęło z karty — strażnik nie ma czego pilnować")
      #expect(owners.allSatisfy { $0 == "GestureOnlyButton" }, "\(call) w przyciskach: \(owners)")
    }
    // Systemowe przyciski karty to wyłącznie okno całego wejścia (podgląd bez decyzji, `ConsentInputSheet`)
    // i „Odrzuć"; każdy nowy `Button` trzeba tu świadomie dopisać. Karta nie oddaje decyzji do terminala (bez
    // „Odpowiedz w terminalu”) i nie ma przycisku, który pokazuje coś w herdr.
    #expect(Self.systemButtons(in: code) == [
      "Button(UICopy.consentShowFullInput(lines: full.lines), action: showFullInput)",
      "Button(UICopy.deny) {",
    ])
    // Okno całego wejścia tylko pokazuje tekst: żadnej decyzji z niego.
    let sheet = Self.withoutComments(
      try String(contentsOf: Self.sourceFile("Session/Cards/ConsentInputSheet.swift"), encoding: .utf8))
    #expect(!sheet.contains("decide("))
    #expect(!sheet.contains("GestureOnlyButton"))
    // Wiersz stanu zastępuje całą stopkę: po własnej decyzji nie zostaje obok niego żaden przycisk.
    #expect(!code.contains("kept:"))
    #expect(code.contains(#"title: autoPlan ? "\(card.allowTitle)"#))
    #expect(!code.contains(".keyboardShortcut"))
    // `GestureOnlyButton` i style przycisków mieszkają w `Buttons.swift` — tam też bez skrótu.
    let buttons = try String(contentsOf: Self.sourceFile("Session/Buttons.swift"), encoding: .utf8)
    #expect(buttons.contains("struct GestureOnlyButton"))
    #expect(!buttons.contains(".keyboardShortcut"))
    // Odmowa zostaje zwykłym przyciskiem.
    #expect(source.contains("Button(UICopy.deny"))
    // Esc z fokusem na karcie = „Odrzuć": fokus dostają wyłącznie komórki kart, Esc to `UIKeyCommand`
    // kontrolera, który odrzuca kartę z fokusem; „Zatwierdź" żadnym klawiszem.
    // Kontroler jest rozcięty na pliki-rozszerzenia (`SessionViewController+*.swift`) — czytamy wszystkie.
    let controller = try Self.sourceFiles(in: "Session", prefix: "SessionViewController")
      .map { try String(contentsOf: $0, encoding: .utf8) }
      .joined(separator: "\n")
    #expect(controller.contains("canFocusItemAt"))
    #expect(controller.contains("UIKeyCommand.inputEscape"))
    #expect(controller.contains("decide(card, .deny)"))
    #expect(!controller.contains("decide(card, .allow)"))
  }

  /// Kod bez komentarzy `//`: zdanie komentarza o `Button` nie może przestawić strażnika w żadną stronę.
  static func withoutComments(_ source: String) -> String {
    source.split(separator: "\n", omittingEmptySubsequences: false)
      .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
      .joined(separator: "\n")
  }

  /// Konstruktor przycisku: `GestureOnlyButton(` albo systemowy `Button(` / `Button {` (nie `…ButtonStyle(`).
  private static let buttonConstructor = try! NSRegularExpression(
    pattern: #"(?<![A-Za-z0-9_])(GestureOnlyButton|Button)\s*[({]"#)

  /// Dla każdego wystąpienia `call` — rodzaj przycisku, którego konstruktor stoi najbliżej przed nim.
  static func buttonOwners(of call: String, in code: String) -> [String] {
    let text = code as NSString
    let constructors = buttonConstructor.matches(in: code, range: NSRange(location: 0, length: text.length))
    var owners: [String] = []
    var from = 0
    while true {
      let hit = text.range(of: call, range: NSRange(location: from, length: text.length - from))
      guard hit.location != NSNotFound else { break }
      let owner = constructors.last { $0.range.location < hit.location }
      owners.append(owner.map { text.substring(with: $0.range(at: 1)) } ?? "brak")
      from = hit.location + hit.length
    }
    return owners
  }

  /// Linie z systemowym `Button` (od konstruktora do końca linii).
  static func systemButtons(in code: String) -> [String] {
    let text = code as NSString
    return buttonConstructor.matches(in: code, range: NSRange(location: 0, length: text.length))
      .filter { text.substring(with: $0.range(at: 1)) == "Button" }
      .map { match in
        let line = text.lineRange(for: match.range)
        let tail = NSRange(location: match.range.location, length: NSMaxRange(line) - match.range.location)
        return text.substring(with: tail).trimmingCharacters(in: .whitespacesAndNewlines)
      }
  }

  static func sourceFile(_ relative: String) -> URL {
    URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appending(path: "Sources/RarogUI/\(relative)")
  }

  /// Pliki `.swift` katalogu źródeł zaczynające się od `prefix` (np. kontroler i jego rozszerzenia).
  static func sourceFiles(in directory: String, prefix: String) throws -> [URL] {
    let files = try FileManager.default.contentsOfDirectory(at: sourceFile(directory), includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix(prefix) && $0.pathExtension == "swift" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    #expect(files.count > 1, "kontroler bez rozszerzeń — test czyta za mało")
    return files
  }
}
