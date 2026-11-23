import Foundation
import RarogContract
import RarogCore

// Wiersz stanu notatki projektu pod polem i w stopce formularza: jedno zdanie, ton i najwyżej jedna akcja.
// Kolor dostaje WYŁĄCZNIE porażka i sufit (`docs/design.md` „Project note"); zwykły zapis jest cichy. Czysta
// funkcja stanu dokumentu — testy na macOS. Właściciel: notatki (apka natywna).

public struct NoteStatusLine: Sendable, Equatable {
  public enum Tone: Sendable, Equatable {
    case quiet
    case error
  }

  public enum Action: Sendable, Equatable {
    /// „Spróbuj ponownie" (porażka zapisu, szkic z dysku).
    case retry
    /// „Przywróć" (puste pole: treść sprzed wyczyszczenia albo z kosza).
    case restore
    /// „Cofnij" (po „Połącz" i „Weź z serwera").
    case undo
    /// „Ustawienia" (dyktowanie: odmowa zgody na mikrofon albo na rozpoznawanie mowy, `VoiceNotice.opensSettings`).
    case settings
  }

  public let text: String
  public let tone: Tone
  public let action: Action?

  init(_ text: String, tone: Tone = .quiet, action: Action? = nil) {
    self.text = text
    self.tone = tone
    self.action = action
  }
}

extension NoteDocument {
  /// Wiersz stanu. `savingVisible` = zapis trwa dłużej niż 400 ms (szybki zapis nie miga „zapisuję…"); `machine` =
  /// słowo maszyny serwera w zdaniu braku kontaktu (``AppState/serverMachine``).
  public func statusLine(now: Date = Date(), savingVisible: Bool = false, machine: ServerMachine) -> NoteStatusLine? {
    if readOnly != nil { return nil }
    if ancestor == nil { return loading ? NoteStatusLine(UICopy.noteLoading) : nil }
    if conflict != nil { return NoteStatusLine(UICopy.noteConflictStatus) }
    if let problem {
      switch problem {
      case .offline: return NoteStatusLine(UICopy.noteOffline(machine))
      case .server: return NoteStatusLine(UICopy.noteServerFailed, tone: .error, action: .retry)
      case let .refused(message): return NoteStatusLine(message ?? UICopy.noteRefusedFallback, tone: .error, action: .retry)
      case .loggedOut: return NoteStatusLine(UICopy.noteLoggedOut)
      case .disk: return NoteStatusLine(UICopy.noteDiskFailed, tone: .error)
      }
    }
    if emptyWillDelete { return NoteStatusLine(UICopy.noteEmptyWillDelete, action: .restore) }
    if NotesRules.isEmpty(text), trash != nil { return NoteStatusLine(UICopy.noteDeletedStatus, action: .restore) }
    if let notice {
      switch notice {
      case let .refreshed(version): return NoteStatusLine(UICopy.noteRefreshed(version, now: now))
      case let .merged(version, _): return NoteStatusLine(UICopy.noteMerged(version, now: now), action: .undo)
      case let .took(version, _): return NoteStatusLine(UICopy.noteTook(version, now: now), action: .undo)
      }
    }
    if let restoredAt, isDirty { return NoteStatusLine(UICopy.noteRestored(restoredAt), action: .retry) }
    if saving, savingVisible { return NoteStatusLine(UICopy.noteSaving) }
    guard let version = ancestor?.updatedAt, version > 0 else { return NoteStatusLine(UICopy.noteNew) }
    return NoteStatusLine(UICopy.noteSavedAt(version, now: now))
  }

  /// Licznik od 90 % sufitu (`nil` niżej); `full` = pole doszło do sufitu (kolor błędu i zdanie).
  public var counter: (text: String, full: Bool)? {
    let units = NotesRules.units(text)
    guard units >= UICopy.noteCounterFrom else { return nil }
    return (UICopy.noteCounter(units), units >= NotesRules.maxUnits)
  }
}
