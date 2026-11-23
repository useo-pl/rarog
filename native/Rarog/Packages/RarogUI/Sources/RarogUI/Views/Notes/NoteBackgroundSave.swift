#if os(iOS)
import RarogCore

/// Zejście apki w tło z notatką w trakcie: szkice na dysk od razu, zapis pól z niezapisaną treścią w pracy w tle
/// z serwerem (`RarogStore.beginBackgroundWork`) — system daje na to kilkadziesiąt sekund. Pusty dokument nie idzie
/// (zabicie apki w tle nie kasuje notatki). Wygaśnięcie czasu zamyka zadanie adapter; późniejszy koniec jest wtedy
/// bez skutku. Wzór: dokończenie dyktowania w tle (`ComposerDictation.enteredBackground`). Właściciel: notatki
/// (apka natywna).
@MainActor
enum NoteBackgroundSave {
  /// Najdłużej tyle czeka praca w tle na koniec zapisu; potem oddaje czas systemowi (szkic i tak jest na dysku).
  static let limit: Duration = .seconds(25)

  static func run(_ notes: ProjectNotes, store: RarogStore) {
    let work = store.beginBackgroundWork("notatka", needsServer: true)
    notes.enterBackground()
    Task { @MainActor in
      let deadline = ContinuousClock.now + limit
      while notes.saving, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(100))
      }
      store.endBackgroundWork(work)
    }
  }
}
#endif
