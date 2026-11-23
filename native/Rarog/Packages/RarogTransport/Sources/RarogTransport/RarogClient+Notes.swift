import Foundation
import RarogContract

// Notatki projektu: jeden dokument na katalog. Odczyt idzie bez bramki; zapis to `PUT`, więc przechodzi bramkę
// zgodności (`MutationGate.isMutation`). Konflikt wersji (409) jest WYNIKIEM zapisu, nie błędem: jego ciało niesie
// aktualny dokument, którego apka potrzebuje do banera i „Połącz”. Właściciel: notatki (apka natywna).
extension RarogClient {
  /// `GET /api/notes?cwd=…` — cały dokument; brak notatek = `{text: "", updatedAt: 0}`. Killswitch `RAROG_NOTES=0`:
  /// 404; katalog spoza projektów albo skasowany: 400 `cwd-not-allowed`.
  public func notes(cwd: String) async throws(TransportError) -> NotesDoc {
    let response = try await perform(.get(Self.notesRoute(cwd: cwd)))
    // Ścieżka katalogu nie wchodzi do opisu błędu: ten trafia do logu diagnostycznego.
    return try decodeCatalog(NotesDoc.self, from: response.body, path: "/api/notes")
  }

  /// `PUT /api/notes {cwd, text, updatedAt}` → nowa wersja albo konflikt z aktualnym dokumentem. 409 bez poprawnego
  /// `current` to odpowiedź spoza kontraktu, nie konflikt: bez cudzej wersji nie ma czego postawić obok swojej.
  public func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult {
    let response = try await perform(.put("/api/notes", json: body), accepting: [Self.notesConflictStatus])
    if response.status == Self.notesConflictStatus {
      return .conflict(try decodeCatalog(NotesConflictBody.self, from: response.body, path: "/api/notes").current)
    }
    return .saved(try decodeCatalog(NotesSaved.self, from: response.body, path: "/api/notes").updatedAt)
  }

  static let notesConflictStatus = 409

  /// Adres odczytu. Katalog w query kodowany RĘCZNIE zamkniętym zbiorem znaków (`segment`), jak ścieżka pliku diffa:
  /// `URLComponents` zostawiłby `+`, a serwer czyta plus w query jako spację.
  static func notesRoute(cwd: String) -> String {
    "/api/notes?cwd=\(segment(cwd))"
  }
}
