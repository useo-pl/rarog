import Foundation

// Prezentacja arkusza z numerem (arkusz „Model i effort"). Właściciel: nagłówek.

/// Arkusz, z którego wychodzi żądanie, dostaje numer prezentacji. Zamknięcie i ponowne otwarcie
/// to NOWA prezentacja: spóźniona odpowiedź starej nie zamyka nowej i nie kasuje świeżego wyboru
/// (inaczej sukces sprzed zamknięcia zamykałby arkusz otwarty od nowa).
public struct SheetPresentation: Sendable, Equatable {
  /// Numer prezentacji — element `popover(item:)`, więc nowy numer to nowy widok z czystym stanem.
  public struct Ticket: Sendable, Hashable, Identifiable {
    public let id: Int
  }

  /// Prezentacja, która stoi; `nil` = arkusz zamknięty.
  public private(set) var current: Ticket?
  private var issued = 0

  public init() {}

  /// Otwiera nową prezentację.
  @discardableResult
  public mutating func open() -> Ticket {
    issued += 1
    let ticket = Ticket(id: issued)
    current = ticket
    return ticket
  }

  /// Zamknięcie ręką (stuknięcie obok, przeciągnięcie) — dotyczy tego, co stoi.
  public mutating func dismiss() {
    current = nil
  }

  /// Zamknięcie z wyniku żądania albo z przycisku arkusza: tylko prezentacja, z której wyszło.
  public mutating func close(_ ticket: Ticket) {
    if current == ticket { current = nil }
  }

  /// Wynik żądania należy do tej prezentacji — inaczej idzie do kosza (prawdę i tak przynosi
  /// strumień listy).
  public func isCurrent(_ ticket: Ticket) -> Bool {
    current == ticket
  }
}
