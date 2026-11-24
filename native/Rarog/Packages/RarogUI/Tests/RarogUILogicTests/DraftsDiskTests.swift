import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Synchronization
import Testing

// Kolejki dysku szkiców (`DraftsDisk`) w przestrzeniach danych per serwer:
// spóźniony zapis instancji poprzedniego serwera trafia do JEJ przestrzeni, nowa go nie widzi; kolejka jest per
// katalog, więc długa operacja szkiców pól nie blokuje otwarcia notatek na głównym aktorze, a zapisy dwóch instancji
// tego samego katalogu idą po kolei.

/// Praca blokująca (semafor, `queue.sync`) poza pulą współbieżności Swifta.
private func onThread<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(returning: work()) }
  }
}

@Suite("szkice w przestrzeniach serwerów: kolejki dysku per katalog", .serialized)
struct DraftsDiskTests {
  private let cwd = "/Users/x/projekt"

  private func root() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "rarog-drafts-spaces/\(UUID().uuidString)", directoryHint: .isDirectory)
  }

  private func note(_ text: String) -> NoteDrafts.Draft {
    NoteDrafts.Draft(cwd: cwd, text: text, ancestor: nil, savedAt: Date(timeIntervalSince1970: 1_790_000_000))
  }

  /// Blokuje pierwszą operację na katalogu `directory` przed operacją na plikach, do zwolnienia.
  final class Pause: Sendable {
    let paused = DispatchSemaphore(value: 0)
    let go = DispatchSemaphore(value: 0)
    let fired = Atomic<Bool>(false)
    let released = Atomic<Bool>(false)

    init(_ directory: URL) {
      let path = directory.standardizedFileURL.path
      DraftsDisk.pauseBeforeOperation.withLock {
        $0 = { [self] dir in
          guard dir.standardizedFileURL.path == path, !fired.exchange(true, ordering: .acquiringAndReleasing) else { return }
          paused.signal()
          go.wait()
        }
      }
    }

    /// `false` = operacja nie stanęła w 10 s (test nie wisi bez końca).
    func waitPaused() async -> Bool {
      await onThread { [paused] in paused.wait(timeout: .now() + 10) == .success }
    }

    /// Zwolnienie z wątku poza głównym: wstrzymana kolejka blokuje `queue.sync` innych zestawów na głównym wątku.
    func release(afterMilliseconds delay: Int) {
      DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delay)) { [self] in
        DraftsDisk.pauseBeforeOperation.withLock { $0 = nil }
        released.store(true, ordering: .releasing)
        go.signal()
      }
    }
  }

  @Test("notatka: spóźniony zapis i kasowanie instancji serwera A zostają w przestrzeni A, przestrzeń B ich nie widzi")
  func lateNoteOpsStayInOldSpace() async throws {
    let base = root()
    defer { try? FileManager.default.removeItem(at: base) }
    let spaceA = base.appending(path: "a")
    let spaceB = base.appending(path: "b")
    let old = NoteDrafts.inSpace(spaceA)
    let fresh = NoteDrafts.inSpace(spaceB)
    fresh.save(note("B"))
    // Instancja A po przełączeniu: odliczanie szkicu i odpowiedź zapisu z poprzedniego serwera.
    old.save(note("A"))
    old.remove("/inny")
    old.flush()
    fresh.flush()
    #expect(NoteDrafts.inSpace(spaceB).all.map(\.text) == ["B"], "B: tylko własny szkic")
    #expect(NoteDrafts.inSpace(spaceA).all.map(\.text) == ["A"], "A: szkic w przestrzeni A")
  }

  @MainActor
  @Test("pole wiadomości: spóźniony zapis instancji serwera A nie trafia do przestrzeni B")
  func composerLateWriteStaysInOldSpace() async throws {
    let base = root()
    defer { try? FileManager.default.removeItem(at: base) }
    let old = ComposerDrafts.inSpace(base.appending(path: "a"))
    let fresh = ComposerDrafts.inSpace(base.appending(path: "b"))
    // Stary ekran sesji schodzi (odliczanie, wyjście) i nieudana wysyłka do A wraca do szkicu po przełączeniu.
    old.persist(text: "A po", attachments: [], for: "s1")
    old.save("A z wysyłki", note: nil, for: "s2")
    await Task.yield()
    try await Task.sleep(for: .milliseconds(50))
    old.flush()
    fresh.persist(text: "B", attachments: [], for: "s3")
    fresh.flush()
    let reopened = ComposerDrafts.inSpace(base.appending(path: "b"))
    #expect(reopened.take(for: "s1") == nil && reopened.take(for: "s2") == nil, "szkice serwera A nie wracają w B")
    #expect(reopened.take(for: "s3")?.text == "B")
    #expect(ComposerDrafts.inSpace(base.appending(path: "a")).take(for: "s1")?.text == "A po")
  }

  @Test("ten sam katalog: zapis starej instancji wstrzymany przed plikiem, nowa instancja pisze za nim — wygrywa nowa")
  func sameDirectoryWritesStayOrdered() async throws {
    let base = root()
    defer { try? FileManager.default.removeItem(at: base) }
    let space = base.appending(path: "a")
    let old = NoteDrafts.inSpace(space)
    let pause = Pause(space.appending(path: "note-drafts"))
    old.save(note("stary interfejs"))
    #expect(await pause.waitPaused(), "zapis stanął przed plikiem")
    // Interfejs zbudowany od nowa (ten sam serwer): nowa instancja otwiera katalog za wstrzymanym zapisem.
    pause.release(afterMilliseconds: 150)
    let fresh = await onThread {
      let fresh = NoteDrafts.inSpace(space)
      return fresh
    }
    fresh.save(note("nowy interfejs"))
    fresh.flush()
    #expect(NoteDrafts.inSpace(space).all.map(\.text) == ["nowy interfejs"])
  }

  /// Długa operacja szkiców pól (kopiowanie załączników) nie blokuje głównego
  /// aktora otwierającego szkice notatek — kolejki są per katalog.
  @MainActor
  @Test("wstrzymana kolejka szkicu pola: otwarcie notatek i inne zadanie głównego aktora nie czekają")
  func otherKindDoesNotBlockMainActor() async throws {
    let base = root()
    defer { try? FileManager.default.removeItem(at: base) }
    let space = base.appending(path: "a")
    let composer = ComposerDrafts.inSpace(space)
    composer.flush()
    let pause = Pause(space.appending(path: "drafts"))
    composer.persist(text: "A", attachments: [], for: "s1")
    #expect(await pause.waitPaused(), "zapis szkicu pola stanął przed plikiem")
    // Siatka bezpieczeństwa: gdyby notatki czekały na tę kolejkę, główny aktor stałby do zwolnienia.
    pause.release(afterMilliseconds: 2000)
    let started = ContinuousClock.now
    let notes = NoteDrafts.inSpace(space)
    let other = Task { @MainActor in ContinuousClock.now }
    let otherRan = await other.value
    let releasedEarly = pause.released.load(ordering: .acquiring)
    #expect(!releasedEarly, "otwarcie notatek i inne zadanie przed zwolnieniem")
    #expect(otherRan - started < .seconds(1), "główny aktor nie czekał na kolejkę szkicu pola")
    #expect(notes.all.isEmpty)
    composer.flush()
    #expect(ComposerDrafts.inSpace(space).take(for: "s1")?.text == "A")
  }

  // Catches a wait that returns while the draft write still stands in the queue: a dictation that ends in the
  // background lets its background time go after this wait, and a write that has not run is lost with the process.
  @MainActor
  @Test("the wait for the composer draft's disk returns only after the queued write ran")
  func writtenWaitsForTheQueuedWrite() async throws {
    let base = root()
    defer { try? FileManager.default.removeItem(at: base) }
    let space = base.appending(path: "a")
    let composer = ComposerDrafts.inSpace(space)
    composer.flush()
    let pause = Pause(space.appending(path: "drafts"))
    composer.persist(text: "A", attachments: [], for: "s1")
    #expect(await pause.waitPaused(), "the write stands before its file")
    let wait = Task { @MainActor in
      await composer.written()
      return pause.released.load(ordering: .acquiring)
    }
    for _ in 0..<50 { await Task.yield() }
    pause.release(afterMilliseconds: 200)
    let afterRelease = await wait.value
    #expect(afterRelease, "the wait returned only after the paused write was released")
    #expect(ComposerDrafts.inSpace(space).take(for: "s1")?.text == "A")
  }

  @Test("preferencje zależne od serwera, kasowane przy nowej przestrzeni, obejmują pamięć doczytania transkryptu")
  func serverScopedPreferencesCoverLastSeen() {
    #expect(NavigationPreferences.serverScoped.contains(LastSeenMemory.key))
  }
}
