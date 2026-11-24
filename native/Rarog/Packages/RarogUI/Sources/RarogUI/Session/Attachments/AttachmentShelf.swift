import Foundation

/// Niewysłane załączniki per sesja, na czas życia procesu (przeżywają nawigację).
/// Właściciel: wysyłka.
///
/// Półka jest JEDYNYM stanem paska nad polem: pasek ją rysuje (``watch(_:_:)`` dostaje każdą zmianę),
/// a zmiany człowieka idą operacjami półki (``remove(_:for:)``, ``restore(_:for:)``) — pasek nigdy nie
/// nadpisuje półki swoją kopią. Dzięki temu przywrócenie nieudanej wysyłki z ekranu, którego już nie
/// ma, trafia do paska otwartego w międzyczasie i nie ginie przy jego następnej zmianie. Paczka
/// w trakcie wczytywania też należy do półki, nie do ekranu: wynik ląduje na półce także wtedy, gdy
/// ekran sesji zamknięto w trakcie, a otwarty pasek tej sesji dostaje zdania przez
/// ``observe(_:_:)``. Pliki leżą w ``AttachmentStaging``; po zabiciu apki półka zaczyna pusta, a załączniki
/// wracają z trwałego szkicu sesji (``ComposerDrafts``) — też operacją półki (``restore(_:for:)``).
@MainActor
public final class AttachmentShelf {
  public static let shared = AttachmentShelf()

  private var items: [String: [ComposerAttachment]] = [:]
  /// Wczytywane paczki, per sesja (jedna naraz: druga dostaje „Chwila…").
  private var loads: [String: Task<Void, Never>] = [:]
  /// Pasek sesji, który słucha końca wczytywania; ostatni zarejestrowany wygrywa.
  private var listeners: [String: @MainActor (AttachmentIntake.Result) -> Void] = [:]
  /// Pasek sesji, który rysuje półkę; ostatni zarejestrowany wygrywa.
  private var watchers: [String: @MainActor () -> Void] = [:]
  /// Grows on ``removeAll()``: a load result from before it does not land on the shelf and its staged files go.
  private var generation = 0

  public init() {}

  /// Everything leaves the shelf, loads in progress too ("Forget Server", another server): open strips get the
  /// change, and the staged files of the shelf and of a late load result leave the disk.
  public func removeAll() {
    generation += 1
    for task in loads.values { task.cancel() }
    loads = [:]
    let sessions = Array(items.keys)
    AttachmentStaging.discard(items.values.flatMap { $0 })
    items = [:]
    for sessionId in sessions { watchers[sessionId]?() }
  }

  public func attachments(for sessionId: String) -> [ComposerAttachment] {
    items[sessionId] ?? []
  }

  /// Zdejmuje wskazane załączniki (wysłane, zdjęte „×"). Reszta zostaje — także dołożona
  /// w międzyczasie z innego ekranu.
  public func remove(_ ids: Set<UUID>, for sessionId: String) {
    let current = attachments(for: sessionId)
    let rest = current.filter { !ids.contains($0.id) }
    guard rest.count != current.count else { return }
    store(rest, for: sessionId)
  }

  /// Dokłada załączniki nieudanej wysyłki (``SendRecovery``): nieudane na początku, jak tekst. Otwarty
  /// pasek sesji dostaje zmianę od razu, także gdy wysyłka wyszła z ekranu, którego już nie ma.
  public func restore(_ attachments: [ComposerAttachment], for sessionId: String) {
    guard !attachments.isEmpty else { return }
    store(AttachmentCounts.ordered(attachments + self.attachments(for: sessionId)), for: sessionId)
  }

  /// Pasek sesji rysuje półkę: dostaje każdą jej zmianę (po zmianie stan jest już na półce).
  public func watch(_ sessionId: String, _ watcher: @escaping @MainActor () -> Void) {
    watchers[sessionId] = watcher
  }

  private func store(_ attachments: [ComposerAttachment], for sessionId: String) {
    items[sessionId] = attachments.isEmpty ? nil : attachments
    watchers[sessionId]?()
  }

  /// Paczka sesji jeszcze się wczytuje („Wyślij" czeka, druga paczka dostaje „Chwila…").
  public func isLoading(_ sessionId: String) -> Bool {
    loads[sessionId] != nil
  }

  /// Wczytuje paczkę dla sesji; wynik dokłada do tego, co jest na półce W CHWILI końca (zdjęte
  /// w trakcie nie wraca). `false` = poprzednia paczka tej sesji jeszcze się wczytuje.
  @discardableResult
  public func ingest(_ candidates: [AttachmentCandidate], for sessionId: String) -> Bool {
    guard loads[sessionId] == nil else { return false }
    let existing = attachments(for: sessionId)
    let started = generation
    loads[sessionId] = Task { [self] in
      let result = await AttachmentIntake.process(candidates, existing: existing)
      guard started == generation else {
        // The shelf was emptied during the load: nobody holds these staged files.
        AttachmentStaging.discard(result.added)
        return
      }
      loads[sessionId] = nil
      if !result.added.isEmpty {
        store(AttachmentCounts.ordered(attachments(for: sessionId) + result.added), for: sessionId)
      }
      listeners[sessionId]?(result)
    }
    return true
  }

  /// Otwarty pasek sesji dostaje wynik wczytania (zdania, czytnik); półka jest już zaktualizowana.
  public func observe(_ sessionId: String, _ listener: @escaping @MainActor (AttachmentIntake.Result) -> Void) {
    listeners[sessionId] = listener
  }

  /// Koniec trwającego wczytywania sesji (testy; trwały szkic zapisuje po nim wynik, ``ComposerDrafts``).
  func loaded(_ sessionId: String) async {
    await loads[sessionId]?.value
  }
}
