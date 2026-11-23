import Foundation
import Synchronization

/// Kolejki dysku szkiców apki — pól wiadomości (`ComposerDrafts`) i notatek (`NoteDrafts`). Każdy katalog ma JEDNĄ
/// szeregową kolejkę, wspólną dla wszystkich instancji tego katalogu: zapisy starej i nowej instancji (interfejs
/// zbudowany od nowa) idą po kolei, a długa operacja szkiców pól nie blokuje otwarcia notatek (i odwrotnie).
/// Izolację danych serwerów daje katalog: szkice leżą w przestrzeni bieżącego serwera (`ServerSpaces`), więc
/// spóźniony zapis instancji poprzedniego serwera trafia do jej przestrzeni, której nikt już nie czyta.
/// Właściciel: szkice (apka natywna).
final class DraftsDisk: Sendable {
  /// Katalog instancji i jego kolejka.
  struct Ticket: Sendable {
    let directory: URL
    fileprivate let queue: DispatchQueue
  }

  static let shared = DraftsDisk()

  /// Testy: woła się na kolejce przed operacją na plikach (katalog operacji).
  static let pauseBeforeOperation = Mutex<(@Sendable (URL) -> Void)?>(nil)

  private let queues = Mutex<[String: DispatchQueue]>([:])

  /// Kolejka katalogu bez czekania na nią.
  func ticket(_ directory: URL) -> Ticket {
    let key = directory.standardizedFileURL.path
    let queue = queues.withLock { queues in
      if let queue = queues[key] { return queue }
      let queue = DispatchQueue(label: "pl.useo.rarog.drafts-disk.\(directory.lastPathComponent)")
      queues[key] = queue
      return queue
    }
    return Ticket(directory: directory, queue: queue)
  }

  /// Otwarcie instancji z pierwszym odczytem katalogu na jego kolejce, za zapisami zleconymi wcześniej (szkice notatek
  /// czytają się przy otwarciu synchronicznie).
  func open<T>(_ directory: URL, _ read: () -> T) -> (Ticket, T) {
    let ticket = ticket(directory)
    return (ticket, ticket.queue.sync(execute: read))
  }

  /// Operacja w tle na kolejce katalogu.
  func async(_ ticket: Ticket, _ operation: @escaping @Sendable () -> Void) {
    ticket.queue.async {
      Self.pauseBeforeOperation.withLock { $0 }?(ticket.directory)
      operation()
    }
  }

  /// Odczyt czekający na operacje tego katalogu przed sobą.
  func sync<T>(_ ticket: Ticket, _ read: () -> T) -> T {
    ticket.queue.sync(execute: read)
  }

  /// Czeka, aż zlecone operacje katalogu się wykonają (zejście apki w tło, testy).
  func flush(_ ticket: Ticket) {
    ticket.queue.sync {}
  }
}
