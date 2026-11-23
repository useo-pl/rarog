import RarogContract
@testable import RarogUI
import UIKit
import XCTest

/// Dyktowanie do notatki projektu na prawdziwych częściach UIKit: cel dyktowania pisze do MODELU dokumentu
/// i do pola, które nie jest pierwszym respondentem (nagranie z dymka bez klawiatury), dopisek z dymka zaczyna
/// nową linię, dyktowanie nie przechodzi sufitu dokumentu, a mikrofon przechodzi między gospodarzami (pole
/// wiadomości ↔ notatka) z oddaniem tekstu poprzedniego miejsca. Właściciel: notatki (apka natywna).
@MainActor
final class NoteDictationTests: XCTestCase {
  private let cwd = "/Users/demo/Projects/rarog"

  /// Dokument po pierwszym odczycie: pole przyjmuje tekst.
  private func loadedDocument(_ text: String) async throws -> NoteDocument {
    let notes = ProjectNotes(io: NoteIO(
      fetch: { _ in .loaded(NotesDoc(text: text, updatedAt: 1)) },
      save: { _, _, _ in .saved(2) },
      sleep: { _ in try? await Task.sleep(for: .seconds(3600)) }))
    let doc = notes.document(cwd)
    doc.open()
    for _ in 0..<200 where !doc.editable {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(doc.editable, "pierwszy odczyt dał pole do pisania")
    return doc
  }

  func testDictationFromBubbleWritesModelAndUnfocusedFieldOnNewLine() async throws {
    let doc = try await loadedDocument("- punkt")
    let editor = NoteTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 200), textContainer: nil)
    editor.text = doc.text
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    window.addSubview(editor)
    window.isHidden = false
    XCTAssertFalse(editor.isFirstResponder, "nagranie z dymka: klawiatura nie wstaje")
    let target = NoteVoiceTarget(doc: doc, editor: editor)
    let binding = VoiceFieldBinding(target: target, newLine: true)

    binding.show(VoiceBuffers(committed: " Dyktuję", provisional: " z"), final: false)
    XCTAssertEqual(doc.text, "- punkt\nDyktuję z", "model dostaje dopisek od nowej linii")
    XCTAssertEqual(editor.text, doc.text, "pole bez fokusu pokazuje to samo")

    target.editor = nil
    binding.show(VoiceBuffers(committed: " Dyktuję z iPada."), final: true)
    XCTAssertEqual(doc.text, "- punkt\nDyktuję z iPada.", "bez pola (formularz zamknięty) koniec nagrania trafia do modelu")
    XCTAssertTrue(doc.isDirty, "dopisek czeka na zapis")
  }

  func testDictationStopsAtDocumentCeilingWithoutSplittingCharacters() async throws {
    let doc = try await loadedDocument(String(repeating: "x", count: NotesRules.maxUnits - 3))
    let target = NoteVoiceTarget(doc: doc, editor: nil)
    let binding = VoiceFieldBinding(target: target)
    binding.show(VoiceBuffers(committed: "ab"), final: false)
    XCTAssertFalse(target.full)
    XCTAssertEqual(NotesRules.units(doc.text), NotesRules.maxUnits, "spacja i dwie litery mieszczą się co do jednostki")
    binding.show(VoiceBuffers(committed: "ab 👍🏽"), final: false)
    XCTAssertTrue(target.full, "nadmiar zatrzymuje nagranie")
    XCTAssertLessThanOrEqual(NotesRules.units(doc.text), NotesRules.maxUnits)
    XCTAssertTrue(doc.text.hasSuffix(" ab"), "emoji nie wchodzi w połowie: \(doc.text.suffix(4))")
    XCTAssertEqual(NoteVoiceTarget.prefix("a👍🏽b", units: 3), "a", "emoji z modyfikatorem to jeden znak — w całości albo wcale")
  }

  func testMicrophoneMovesBetweenHostsWithHandOff() {
    let composer = Host()
    let note = Host()
    DictationCenter.shared.claim(composer)
    DictationCenter.shared.claim(composer)
    XCTAssertEqual(composer.handOffs, 0, "ten sam gospodarz nie przejmuje mikrofonu od siebie")
    DictationCenter.shared.claim(note)
    XCTAssertEqual(composer.handOffs, 1, "notatka przejmuje mikrofon od pola wiadomości")
    DictationCenter.shared.claim(composer)
    XCTAssertEqual(note.handOffs, 1, "i odwrotnie")
  }

  private final class Host: DictationHost {
    var handOffs = 0
    func handOff() { handOffs += 1 }
  }
}
