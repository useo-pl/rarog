import Foundation

// Kiedy zapisać trwały szkic pola wiadomości. Reguła bez UIKit, testowana na macOS;
// odliczanie i zapis prowadzi `SessionViewController+Drafts`. Właściciel: sterowanie sesją.

/// Stan pola, który ląduje na dysku — porównanie decyduje, czy jest co zapisać.
struct DraftSnapshot: Equatable {
  let text: String
  let attachments: [UUID]
}

/// Odliczanie przed zapisem rusza od ZMIANY pola, nie od renderu: strumień odpowiedzi renderuje ekran
/// częściej niż co 300 ms, a pole, którego nikt nie rusza, nie może bez końca odsuwać zapisu.
struct DraftSaveSchedule {
  /// Ostatni stan oddany na dysk (`nil` = nic albo dysk go nie przyjął).
  private(set) var saved: DraftSnapshot?
  /// Stan, na który czeka trwające odliczanie.
  private(set) var pending: DraftSnapshot?

  /// Pole mogło się zmienić (render, pisanie, pasek załączników): `true` = odlicz od nowa.
  mutating func changed(_ current: DraftSnapshot) -> Bool {
    guard current != saved, current != pending else { return false }
    pending = current
    return true
  }

  /// Zapis teraz (koniec odliczania, wyjście z ekranu, tło): `true` = jest co oddać na dysk.
  mutating func persist(_ current: DraftSnapshot) -> Bool {
    pending = nil
    guard writes(current) else { return false }
    saved = current
    return true
  }

  /// ``persist(_:)`` would hand `current` to the disk: it differs from the state saved last.
  func writes(_ current: DraftSnapshot) -> Bool {
    current != saved
  }

  /// Dysk nie przyjął stanu: przestaje być zapisany, chyba że po nim poszedł już nowszy.
  mutating func failed(_ snapshot: DraftSnapshot) {
    if saved == snapshot { saved = nil }
  }
}
