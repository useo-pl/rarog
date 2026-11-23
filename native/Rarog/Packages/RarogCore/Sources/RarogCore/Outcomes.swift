import Foundation

/// Faza sceny — wejście, które UI podaje z `scenePhase` (rdzeń nie importuje SwiftUI).
public enum ScenePhase: Sendable, Equatable {
  case active
  case inactive
  case background
}

/// Wynik „Wyślij". Wpis kolejki jest na ekranie, zanim to wróci — wynik mówi, jak się skończyło.
public enum SendOutcome: Sendable, Equatable {
  /// 202 — czekamy na echo (15 s, potem „Nie potwierdzono").
  case accepted(UUID)
  /// Nie wiadomo, czy doszła (zerwana sieć, limit czasu) — „Ponów" robi człowiek.
  case unconfirmed(UUID)
  /// Odmowa bramki albo serwera, ze zdaniem do pokazania; wpis zostaje do „Ponów"/„Odrzuć".
  case refused(UUID, code: String?, message: String?)
  /// Pusty tekst bez załączników — nic nie idzie, bez zdania pod polem, fokus zostaje.
  case empty
  /// Pole wygaszone — serwer i tak by nie przyjął.
  case blocked(SendBlock)
  /// Dysk odmówił zapisu — wiadomość NIE wyszła.
  case notPersisted(String)
  /// „Ponów" na wpisie, który już jest w drodze albo nie istnieje.
  case ignored
}

/// Wynik zwolnienia karty kanału zgód do terminala (`release`). Osobny od ``DecisionOutcome``: przyjęte zwolnienie
/// nie jest zgodą ani odmową i nic o skutku nie mówi.
public enum ReleaseOutcome: Sendable, Equatable {
  /// Serwer przyjął: hook wychodzi bez wyniku, dialog zostaje w terminalu; stan karty przyjdzie strumieniem.
  case accepted
  /// Karty już nie ma — nic nie wysłano.
  case cardGone
  /// Zwolnienie tej karty już leci z tego urządzenia.
  case alreadyInFlight
  /// Karta nie jest kartą kanału zgód albo apka nie zna jej stanu.
  case notAllowed
  /// Brak połączenia — odmowa od razu.
  case offline
  /// Bramka klienta — zdanie bramki.
  case refusedByClient(message: String)
  /// 409 `too-late`: hook już nie czeka (stan `unknown`); karta zostaje.
  case tooLate(message: String?)
  /// Inne 409 i 422 (np. odpowiedź już odebrana): zdanie serwera; karta zostaje.
  case refused(message: String?)
  /// 410 — karty już nie ma.
  case expired
  /// Błąd sieci; karta zostaje.
  case failed
  /// 401 — wylogowanie.
  case loggedOut
}

/// Wynik decyzji na karcie zgody.
public enum DecisionOutcome: Sendable, Equatable {
  /// Serwer przyjął; karta zniknie, gdy przyjdzie rozstrzygnięcie.
  case accepted
  /// Karty już nie ma — nic nie wysłano (decyzja adresuje kartę z chwili naciśnięcia).
  case cardGone
  /// Decyzja o tej karcie już leci z tego urządzenia.
  case alreadyInFlight
  /// `canAllow == false` — zatwierdzić da się tylko w terminalu.
  case notAllowed
  /// Brak połączenia — zgód nie kolejkujemy, odmowa od razu.
  case offline
  /// Bramka klienta (sesja nieobsługiwana, niezgodność) — zdanie bramki.
  case refusedByClient(message: String)
  /// 409 — „Decyzja zapadła już na innym urządzeniu."
  case alreadyDecided
  /// 410 — „Zgoda wygasła — wznów sesję, żeby agent zapytał ponownie."
  case expired
  /// 422 — zdanie serwera; karta zostaje.
  case refused(message: String?)
  /// Błąd sieci — „Nie udało się wysłać. Spróbuj ponownie."; karta zostaje.
  case failed
  /// 401 — wylogowanie.
  case loggedOut
}
