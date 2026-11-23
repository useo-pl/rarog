import Foundation
import RarogContract
import RarogTransport

// Notatki projektu: odczyt i zapis dokumentu jednego katalogu. Odczyt bez bramek; zapis to `PUT`, więc idzie
// przez bramkę zgodności transportu. Każdy udany odczyt i zapis odświeża bit „ma notatkę" w stanie — tak projekt
// spoza `notesCwds` (sam terminal, historia CLI) dostaje glif po pierwszym `GET`. Dokument, autozapis i konflikt
// trzyma model w RarogUI (`ProjectNotes`), nie stan apki: tekst do 48 k znaków nie należy do reduktora.
//
// Żądania idą przez `tracked` (jak sterowanie turą): wylogowanie je anuluje, a odpowiedź z poprzedniego zalogowania
// nie zmienia stanu i wraca jako `loggedOut`. Bit z odpowiedzi wchodzi do stanu tylko wtedy, gdy strumień nie
// przyniósł w międzyczasie nowszej wiadomości o tym katalogu (event `notes`, nowa epoka).
extension RarogStore {
  public func loadNote(cwd: String) async -> NoteFetchOutcome {
    let login = currentLogin
    let mark = noteMark(cwd)
    guard let result = await tracked({ transport in try await transport.notes(cwd: cwd) }) else {
      return .failed(.loggedOut)
    }
    switch result {
    case let .success(doc):
      probed(cwd, present: !NotesRules.isEmpty(doc.text), since: mark)
      return .loaded(doc)
    case let .failure(error):
      return .failed(noteFailure(error, login: login))
    }
  }

  /// Zapis całego dokumentu z wersją, na której człowiek pisał (`base`).
  public func saveNote(cwd: String, text: String, base: Double) async -> NoteSaveOutcome {
    let login = currentLogin
    let mark = noteMark(cwd)
    let body = NotesPutBody(cwd: cwd, text: text, updatedAt: base)
    guard let result = await tracked({ transport in try await transport.saveNotes(body) }) else {
      return .failed(.loggedOut)
    }
    switch result {
    case let .success(.saved(version)):
      probed(cwd, present: !NotesRules.isEmpty(text), since: mark)
      return .saved(version)
    case let .success(.conflict(current)):
      return .conflict(current)
    case let .failure(error):
      return .failed(noteFailure(error, login: login))
    }
  }

  /// Co strumień wiedział o katalogu w chwili żądania.
  private func noteMark(_ cwd: String) -> (revision: Int, epoch: Int) {
    (state.noteRevision(cwd), state.notesEpoch)
  }

  private func probed(_ cwd: String, present: Bool, since mark: (revision: Int, epoch: Int)) {
    guard noteMark(cwd) == mark else { return }
    dispatch(.notesProbed(cwd: cwd, present: present))
  }

  private func noteFailure(_ error: TransportError, login: Int) -> NoteFailure {
    switch error {
    case let .refused(refusal): return .refused(status: nil, message: refusal.message)
    case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
      if failure.status == 404 { return .disabled }
      if failure.status == 400, failure.code == "cwd-not-allowed" { return .badCwd(failure.message) }
      if failure.status >= 500 { return .server(failure.message) }
      return .refused(status: failure.status, message: failure.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .offline: return .offline
    case .timedOut: return .timedOut
    case .cancelled, .invalidResponse: return .failed
    }
  }
}
