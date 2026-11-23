import CoreGraphics
import RarogCore

// Kotwica zaznaczonej sesji w drzewie projektów listy: czyste liczby i przejścia stanów,
// testowane na macOS (`TreeListAnchorMathTests`). Odczyt i korekta na żywej kolekcji UIKit: `Views/List/
// TreeListAnchor.swift`. Właściciel: lista.

/// Geometria kotwicy w punktach przewijanej kolekcji: `contentOffset.y`, ramki wierszy z układu i wstawki
/// `adjustedContentInset` (u góry pasek nawigacji, u dołu stopka limitów).
public enum TreeListAnchorMath {
  /// Tolerancja „cały na ekranie”: pół punktu, bo układ zaokrągla ramki do pikseli ekranu.
  public static let edgeTolerance: CGFloat = 0.5

  /// Przesunięcie `y` w granicach treści: od `−insetTop` (lista na samej górze) do `contentHeight + insetBottom −
  /// boundsHeight` (na samym dole). Treść krótsza od widoku stoi u góry — kolekcja i tak by ją tam cofnęła.
  public static func clamp(
    _ y: CGFloat, contentHeight: CGFloat, boundsHeight: CGFloat, insetTop: CGFloat, insetBottom: CGFloat
  ) -> CGFloat {
    let minY = -insetTop
    let maxY = max(minY, contentHeight + insetBottom - boundsHeight)
    return min(max(y, minY), maxY)
  }

  /// Wiersz (`minY`…`maxY` w układzie treści) stoi CAŁY w widocznej części listy: pod wstawką górną i nad dolną.
  /// Wiersz ucięty z którejkolwiek strony albo wyższy od widocznej części — nie.
  public static func wholeOnScreen(
    minY: CGFloat, maxY: CGFloat, offset: CGFloat, boundsHeight: CGFloat, insetTop: CGFloat, insetBottom: CGFloat
  ) -> Bool {
    let top = offset + insetTop
    let bottom = offset + boundsHeight - insetBottom
    return minY >= top - edgeTolerance && maxY <= bottom + edgeTolerance
  }
}

/// Stan kotwicy: TRZY zbiory tożsamości wierszy zamiast jednego, bo SwiftUI liczy ciało listy, ZANIM kolekcja
/// dostanie nowe wiersze (`performBatchUpdates`), a `onChange` przychodzi dopiero PO jej aktualizacji (zmierzone na
/// iOS 26.2 i 27). Liczba wierszy nie mówi, które drzewo kolekcja ma: snapshot „jedna zamknięta
/// nad + jedna nowa pod” zmienia indeks zaznaczonej przy tej samej liczbie.
/// - `applied` — tożsamości, które kolekcja NAPRAWDĘ ma (z `onChange` wierszy); względem nich idzie odczyt „przed”;
/// - `target` — tożsamości z ostatniego ciała: na nie czeka korekta „po”;
/// - `pending` — odczyt zaznaczonej sprzed zmiany (sesja, miejsce na ekranie, rozmiar i właściciel kolekcji).
///
/// Ciało z tym samym `target` niczego nie zmienia (SwiftUI liczy je wiele razy), a seria A→B→C przed aktualizacją
/// kolekcji zostawia odczyt z A i przestawia cel na C. Po pierwszej korekcie odczyt zostaje na okno dogrywki
/// (`settledTop` — miejsce zaznaczonej na ekranie po tej korekcie). Nowy cel w dogrywce to nowy odczyt, ale z miejscem
/// po korekcie, nie sprzed poprzedniej zmiany: korekta przycięta przy końcu treści stawia sesję gdzie indziej, niż
/// stała, a stare miejsce przesunęłoby ją przy następnej zmianie (wiersz dochodzi pod sesją
/// po przyciętej korekcie — sesja skoczyłaby o 49,5 pt). Z żywej ramki odczytu nie ma: w trakcie animacji „wszystkich”
/// model kolekcji stoi przesunięty prywatną kotwicą UIKit.
public struct TreeListAnchorState: Sendable, Equatable {
  /// Odczyt zaznaczonej sesji sprzed zmiany wierszy.
  public struct Pending: Sendable, Equatable {
    public let session: String
    /// Górna krawędź wiersza minus `contentOffset.y` (w punktach kolekcji): to ma stać po zmianie.
    public let screenTop: CGFloat
    /// Rozmiar kolekcji w chwili odczytu: obrót, okno albo klawiatura między odczytem a korektą go unieważniają.
    public let size: CGSize
    /// Kolekcja, z której odczyt pochodzi (`ObjectIdentifier`): inna kolekcja — odczyt nieważny.
    public let owner: ObjectIdentifier

    public init(session: String, screenTop: CGFloat, size: CGSize, owner: ObjectIdentifier) {
      self.session = session
      self.screenTop = screenTop
      self.size = size
      self.owner = owner
    }
  }

  /// Co ciało ma zrobić z żywą kolekcją.
  public enum Step: Sendable, Equatable {
    case none
    /// Zmierzyć zaznaczoną w kolekcji, która ma jeszcze `applied` (`measureIndex`).
    case measure
    /// Nowy cel w oknie dogrywki: te same warunki co `measure`, ale miejsce na ekranie z ostatniej korekty. Warunek
    /// niespełniony — odczyt z dogrywki przepada (bez przeniesienia).
    case carry(screenTop: CGFloat)
  }

  /// Czy kolekcja pokazuje już `target` (korekta), jeszcze `applied` (czekać) albo coś trzeciego (odczyt nieważny).
  public enum Confirmation: Sendable, Equatable {
    /// Kolekcja ma `target`; zaznaczona stoi pod tym indeksem.
    case target(Int)
    case waiting
    case lost
  }

  public private(set) var applied: [ProjectTreeID]?
  public private(set) var target: [ProjectTreeID] = []
  public private(set) var pending: Pending?
  /// Miejsce zaznaczonej na ekranie po ostatniej korekcie (`frame.minY − przesunięcie`, po przycięciu do treści);
  /// `nil` — korekty tego odczytu jeszcze nie było. Ustawione = okno dogrywki.
  public private(set) var settledTop: CGFloat?
  /// Zapowiedź gestu jednego projektu (`TreeAnchorSkip`).
  public private(set) var skip = TreeAnchorSkip()
  /// Zmiana zapowiedziana gestem jednego projektu jest w drodze do kolekcji: cała ta aktualizacja idzie bez kotwicy,
  /// także zmiana serwera, która dołączy do niej przed narysowaniem (nagłówek, w który człowiek stuknął, stoi).
  public private(set) var skipping = false

  public init() {}

  /// Gest zapowiada wiersze po zmianie (`TreeAnchorSkip.expect`); `nil` kasuje zapowiedź.
  public mutating func expect(_ ids: [ProjectTreeID]?) {
    skip.expect(ids)
  }

  /// Odczyt po pierwszej korekcie — okno dogrywki.
  public var settling: Bool { pending != nil && settledTop != nil }

  /// Ciało listy z wierszami `ids` i zaznaczoną sesją `selected`. Zmiana zaznaczenia unieważnia odczyt; pierwsze
  /// ciało ustawia oba zbiory (kolekcji jeszcze nie ma). Odczyt tylko przy nowym celu, bez zapowiedzi gestu i bez gestu
  /// w drodze; odczyt czekający na pierwszą korektę zostaje (A→B→C), a w dogrywce nowy cel przenosi miejsce po
  /// korekcie (`carry`).
  public mutating func body(_ ids: [ProjectTreeID], selected: String?) -> Step {
    if let pending, pending.session != selected { drop() }
    guard let applied else {
      applied = ids
      target = ids
      return .none
    }
    guard ids != target else { return .none }
    target = ids
    // Zapowiedź zużywa każda zmiana celu, trafiona czy nie (`TreeAnchorSkip.holds`).
    let announced = !skip.holds(after: ids)
    if ids == applied {
      // Cel wrócił do tego, co kolekcja ma: nic się nie zmieni, więc nie ma czego trzymać.
      skipping = false
      drop()
      return .none
    }
    if announced {
      skipping = true
      drop()
      return .none
    }
    if skipping || selected == nil { return .none }
    if pending != nil {
      guard let settledTop else { return .none }
      return .carry(screenTop: settledTop)
    }
    return .measure
  }

  /// Indeks zaznaczonej sesji w `applied`, gdy kolekcja (`items` wierszy, zaznaczone `selectedItems`) naprawdę je
  /// pokazuje; inaczej `nil` — odczyt byłby z innego drzewa.
  public func measureIndex(session: String, items: Int, selectedItems: [Int]) -> Int? {
    guard let applied, items == applied.count, let index = applied.firstIndex(of: .session(session)),
      selectedItems == [index]
    else { return nil }
    return index
  }

  /// Nowy odczyt (także przeniesiony z dogrywki): czeka na pierwszą korektę swojego celu.
  public mutating func measured(_ pending: Pending) {
    self.pending = pending
    settledTop = nil
  }

  /// Korekta (albo sprawdzenie, że korekty nie trzeba) postawiła zaznaczoną `top` od góry widocznej części kolekcji.
  public mutating func corrected(settledTop top: CGFloat) {
    guard pending != nil else { return }
    settledTop = top
  }

  /// Kolekcja (`items` wierszy, zaznaczone `selectedItems`) a cel: liczba wierszy sama nie wystarcza, więc liczy się
  /// też zaznaczony element (UIKit przemapowuje zaznaczenie przez `performBatchUpdates`).
  public func confirmation(items: Int, selectedItems: [Int]) -> Confirmation {
    guard let pending, let index = target.firstIndex(of: .session(pending.session)) else { return .lost }
    if items == target.count, selectedItems == [index] { return .target(index) }
    if measureIndex(session: pending.session, items: items, selectedItems: selectedItems) != nil { return .waiting }
    return .lost
  }

  /// Kolekcja ma nowe wiersze (`onChange`, po `performBatchUpdates`).
  public mutating func didApply(_ ids: [ProjectTreeID]) {
    applied = ids
    if ids == target { skipping = false }
  }

  /// Odczyt wykorzystany albo nieważny.
  public mutating func drop() {
    pending = nil
    settledTop = nil
  }
}

/// Zapowiedź gestu, przy którym kotwica milczy (`TreeToggleGesture.project`): tożsamości wierszy, których gest
/// oczekuje po zmianie. Kotwica pomija tylko zmianę, która dała dokładnie te wiersze, a zapowiedź znika przy każdej
/// zmianie wierszy, trafiona czy nie. Zwinięcie, które tożsamości nie zmienia (wszyscy agenci projektu zostają jako
/// trzymani), żadnej zmiany nie wywoła — zapowiedź równa obecnym wierszom nie pasuje więc do żadnej następnej zmiany
/// i nie zje kotwicy przy niezwiązanej zmianie (zwykła flaga „pomiń następną” by ją zjadła). Świadomie zostaje
/// jeden wyścig: zmiana serwera, która weszła do rdzenia, a lista jej jeszcze nie
/// narysowała, jedzie razem z gestem bez kotwicy. Okno to milisekundy do następnego rysowania, a kotwica w takiej
/// połączonej zmianie przesunęłaby nagłówek, w który człowiek właśnie stuknął.
public struct TreeAnchorSkip: Sendable, Equatable {
  /// Wiersze, których oczekuje gest; `nil` = brak zapowiedzi.
  public private(set) var expected: [ProjectTreeID]?

  public init() {}

  /// Gest zapowiada wiersze po zmianie; `nil` kasuje zapowiedź (gest, przy którym kotwica trzyma).
  public mutating func expect(_ ids: [ProjectTreeID]?) {
    expected = ids
  }

  /// Wiersze drzewa się zmieniły: czy kotwica ma trzymać zaznaczony wiersz. Zużywa zapowiedź.
  public mutating func holds(after ids: [ProjectTreeID]) -> Bool {
    defer { expected = nil }
    return expected != ids
  }
}
