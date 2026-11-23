import Foundation
import Observation
import RarogContract
import RarogCore

/// Notatki projektów w apce: jeden dokument na katalog, jeden rejestr na apkę (właściciel: `RarogRootView`,
/// jak `ComposerDrafts`). Rejestr żyje dłużej niż dymek i formularz — dokument kończy zapis i nagranie także po
/// zamknięciu widoku. Sygnały ze strumienia (`notesRevision`, `notesEpoch`, `capabilities.notes`) rozchodzą się stąd
/// do dokumentów. Logika bez UIKit — testy na macOS. Właściciel: notatki (apka natywna).
@MainActor
@Observable
public final class ProjectNotes {
  @ObservationIgnored private let io: NoteIO
  @ObservationIgnored private let drafts: NoteDrafts?
  /// Zdarzenia dokumentów dla dymków apki (ustawia korzeń widoków).
  @ObservationIgnored public var onEvent: (@MainActor (NoteEvent) -> Void)?
  private var documents: [String: NoteDocument] = [:]
  /// Licznik zmian z serwera, który dokument już obsłużył (`AppState.notesRevision`).
  @ObservationIgnored private var revisions: [String: Int] = [:]
  @ObservationIgnored private var epoch = 0
  /// Katalogi, o które apka już raz zapytała w tej epoce (sonda paska projektu spoza `notesCwds`).
  @ObservationIgnored private var probed: Set<String> = []

  public init(io: NoteIO, drafts: NoteDrafts? = nil) {
    self.io = io
    self.drafts = drafts
    // Szkice z poprzedniego uruchomienia stają od razu jako dokumenty: ikona w pasku pokazuje „nie zapisana”,
    // a otwarcie projektu prowadzi wprost do formularza ze szkicem.
    for draft in drafts?.all ?? [] {
      let cwd = ProjectPath.normalized(draft.cwd)
      documents[cwd] = make(cwd, restored: draft)
    }
  }

  /// Rejestr apki na prawdziwym magazynie i trwałych szkicach.
  public static func live(store: RarogStore, drafts: NoteDrafts) -> ProjectNotes {
    ProjectNotes(
      io: NoteIO(
        fetch: { [weak store] cwd in await store?.loadNote(cwd: cwd) ?? .failed(.failed) },
        save: { [weak store] cwd, text, base in await store?.saveNote(cwd: cwd, text: text, base: base) ?? .failed(.failed) }),
      drafts: drafts)
  }

  /// Dokument katalogu (zakładany przy pierwszym pytaniu).
  public func document(_ cwd: String) -> NoteDocument {
    let key = ProjectPath.normalized(cwd)
    if let existing = documents[key] { return existing }
    let created = make(key, restored: nil)
    documents[key] = created
    return created
  }

  /// Dokument, jeśli już istnieje — bez zakładania (odczyt w renderze).
  public func existing(_ cwd: String) -> NoteDocument? {
    documents[ProjectPath.normalized(cwd)]
  }

  /// Na tym urządzeniu leży niezapisany tekst notatki katalogu (znak na ikonie w pasku).
  public func unsaved(_ cwd: String) -> Bool {
    existing(cwd)?.unsaved ?? false
  }

  private func make(_ cwd: String, restored: NoteDrafts.Draft?) -> NoteDocument {
    NoteDocument(cwd: cwd, io: io, drafts: drafts, epoch: epoch, restored: restored) { [weak self] event in
      self?.onEvent?(event)
    }
  }

  // MARK: - Sygnały ze strumienia

  /// Wejście w projekt (pasek): jeden odczyt na katalog na epokę, gdy bitu nie ma albo treść może być stara.
  public func probe(_ cwd: String, state: AppState) {
    let key = ProjectPath.normalized(cwd)
    guard state.notesAvailable, !probed.contains(key) else { return }
    probed.insert(key)
    let doc = document(key)
    if state.hasNote(key) == nil || doc.ancestor != nil { doc.open() }
  }

  /// Stan apki po każdej zmianie sygnałów notatek: nowa epoka (powrót strumienia), zmiany katalogów z serwera
  /// i flaga możliwości.
  public func sync(_ state: AppState) {
    if state.notesEpoch != epoch {
      epoch = state.notesEpoch
      probed.removeAll()
      for doc in documents.values { doc.epochChanged(epoch) }
    }
    for (cwd, revision) in state.notesRevision where revisions[cwd] != revision {
      revisions[cwd] = revision
      documents[cwd]?.remoteChanged()
    }
    if state.notesAvailable {
      for doc in documents.values { doc.reenable() }
    }
  }

  /// Apka wraca na wierzch: niezapisane próbują znowu, otwarte sprawdzają treść.
  public func enterForeground() {
    for doc in documents.values {
      doc.retry()
      if doc.presented { doc.refresh() }
    }
  }

  /// Zejście apki w tło: szkice na dysk (do końca zapisu), potem zapis pól z niezapisaną treścią. Pusty dokument
  /// nie idzie — zabicie apki w tle nie kasuje notatki.
  public func enterBackground() {
    for doc in documents.values {
      // Szkic teraz, nie po odliczeniu: zadanie tła kończy się na `drafts.flush()` niżej.
      doc.persistDraftNow()
      if doc.isDirty { doc.flush() }
    }
    drafts?.flush()
  }

  /// Czy jakiś zapis jeszcze leci (zadanie tła apki czeka na koniec).
  public var saving: Bool { documents.values.contains { $0.saving } }

  /// Wylogowanie: dokumenty przestają reagować na odpowiedzi, szkice zostają na dysku, a po ponownym logowaniu
  /// wracają jako dokumenty ze szkicu.
  public func loggedOut() {
    for doc in documents.values { doc.detachForLogout() }
    drafts?.flush()
    documents.removeAll()
    revisions.removeAll()
    probed.removeAll()
    for draft in drafts?.all ?? [] {
      let cwd = ProjectPath.normalized(draft.cwd)
      documents[cwd] = make(cwd, restored: draft)
    }
  }
}
