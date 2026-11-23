import Foundation

/// Reguły klawiatury na kartach decyzji — czyste, testowane na macOS;
/// wykonanie w `SessionViewController+KeysCards`. Właściciel: karty.
public enum CardKeys {
  /// Dokąd Tab przenosi fokus z ekranu sesji.
  public enum TabTarget: Sendable, Equatable {
    /// Na kartę decyzji (zgoda, pytanie, dialog w panelu) — przy stojącej decyzji ona jest pierwsza.
    case card
    /// Do pola wiadomości — powrót do pisania jednym klawiszem.
    case composer
  }

  /// Fokus klawiatury staje tylko na kartach, które mają decyzję (karta zablokowana jej nie ma,
  /// karta pytania trzymana samym potwierdzeniem też nie). Karta w trakcie decyzji fokus zachowuje —
  /// inaczej fokus uciekałby w chwili Esc albo Enter; cyfry i Enter karty pytania i tak działają
  /// tylko na karcie, która przyjmuje gest (`QuestionCardModel.interactive`, `+KeysAnswers`).
  public static func focusable(_ row: TranscriptRow) -> Bool {
    switch row {
    case let .permission(card): card.lockedReason == nil
    case let .herdrDialog(card): card.lockedReason == nil
    case let .question(card): card.lockedReason == nil && !card.held
    default: false
    }
  }

  /// Esc z fokusem na karcie = „Odrzuć" — tylko gdy odrzucenie może teraz wyjść. Karta pytania
  /// odrzucenia nie ma (wyjście z formularza to odpowiedź z etykietą): Esc na niej
  /// należy do ekranu.
  public static func escapeDenies(_ row: TranscriptRow) -> Bool {
    switch row {
    case let .permission(card): card.phase == .idle && card.lockedReason == nil
    case let .herdrDialog(card): card.phase == .idle && card.lockedReason == nil && !card.channelDead
    default: false
    }
  }

  /// Tab bez modyfikatorów: w polu edycji należy do pola; przy stojącej decyzji idzie na kartę (a z
  /// karty dalej — systemowi); bez decyzji stawia fokus w polu, gdy pole przyjmuje tekst. `nil` =
  /// klawisz zostaje systemowi.
  public static func tabTarget(typing: Bool, cardFocused: Bool, hasCard: Bool, composerUsable: Bool) -> TabTarget? {
    if typing { return nil }
    if hasCard { return cardFocused ? nil : .card }
    return composerUsable ? .composer : nil
  }
}
