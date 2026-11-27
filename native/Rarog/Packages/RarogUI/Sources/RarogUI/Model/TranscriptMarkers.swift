import Foundation
import RarogContract
import RarogCore

// Znaczniki w transkrypcie: godzina po przerwie, linia „NOWE" z pamięcią urządzenia
// i pigułka „N nowych wiadomości" nad nią. Czyste reguły, testowane na macOS.
// Właściciel: transkrypt.

/// Separator czasu nad wiadomością: `— HH:MM —` po przerwie
/// ≥ 10 min, ale NIE nad promptem (jego godzina stoi przy dymku) i nie nad krokiem narzędzia (bywa schowany w serii);
/// zmiana dnia kalendarzowego daje separator z datą także nad promptem, a gdy wypada na schowanym kroku albo na samym
/// narzędziu — przenosi się na pierwszy widoczny wiersz.
public enum TimeGap {
  /// Dziesięć minut: krótsza dziura to zwykle jedna tura agenta, a znacznik nad każdą turą byłby
  /// szumem. Dłuższa znaczy „wróciłeś do sesji" i wtedy godzina jest nową informacją.
  public static let threshold: TimeInterval = 10 * 60

  /// Godzina NOWSZEJ wiadomości (strefa urządzenia) albo `nil`, gdy przerwa krótsza od progu albo
  /// czas jest nieczytelny.
  public static func clock(previous: String, next: String, timeZone: TimeZone = .current) -> String? {
    guard let before = ServerTime.parse(previous), let after = ServerTime.parse(next),
      after.timeIntervalSince(before) >= threshold
    else { return nil }
    return ServerTime.clock(next, timeZone: timeZone)
  }

  /// Czy `next` leży w innym dniu kalendarzowym niż `previous` (strefa kalendarza); nieczytelny czas — nie.
  public static func dayChanged(previous: String, next: String, calendar: Calendar) -> Bool {
    guard let before = ServerTime.parse(previous), let after = ServerTime.parse(next) else { return false }
    return !calendar.isDate(before, inSameDayAs: after)
  }

  /// Separator nad wiadomością `next`. `dayChange` — zaległa (albo bieżąca) zmiana dnia; `prompt` — wiadomość
  /// człowieka; `toolOnly` — same narzędzia. `nil` = bez separatora.
  public static func mark(
    previous: String, next: String, dayChange: Bool, prompt: Bool, toolOnly: Bool, calendar: Calendar
  ) -> TimeMark? {
    if dayChange, let date = ServerTime.parse(next) {
      // Nad promptem sama data — godzinę niesie dymek; nad resztą data z godziną (nowa informacja po nocy).
      let clock = prompt ? nil : ServerTime.clock(next, timeZone: calendar.timeZone)
      return TimeMark(day: day(date, calendar: calendar), spokenDay: spokenDay(date, calendar: calendar), clock: clock)
    }
    guard !prompt, !toolOnly, let clock = clock(previous: previous, next: next, timeZone: calendar.timeZone) else { return nil }
    return TimeMark(clock: clock)
  }

  /// „pt. 9 paź” — dzień tygodnia i miesiąc skrótem; wzorzec i nazwy w języku apki (`UICopy.timeGapDayPattern`).
  public static func day(_ date: Date, calendar: Calendar, locale: Locale = CopyLocale.current) -> String {
    CopyDate.string(date, pattern: UICopy.timeGapDayPattern, timeZone: calendar.timeZone, locale: locale)
  }

  /// „Piątek, 9 października” — dla czytnika, w formie na POCZĄTEK zdania (`UICopy.timeGapSpoken` stawia datę
  /// pierwszą): wielką literę daje formatter (`.beginningOfSentence`), nie przeróbka gotowego tekstu.
  public static func spokenDay(_ date: Date, calendar: Calendar, locale: Locale = CopyLocale.current) -> String {
    CopyDate.string(
      date, pattern: UICopy.timeGapSpokenDayPattern, timeZone: calendar.timeZone, locale: locale, context: .beginningOfSentence)
  }
}

/// Linia „NOWE": przed pierwszą wiadomością agenta (albo notką) nowszą niż to, co TO urządzenie widziało przy
/// ostatniej wizycie w sesji.
public enum NewMarker {
  /// Indeks wiadomości z linią albo `nil`. Wiadomości z samymi narzędziami są pomijane: bywają
  /// schowanym krokiem serii, a linia do środka zwiniętej serii wejść nie może. Prompt człowieka też:
  /// linia mówi „stąd agent pisał pod twoją nieobecność", a prompt to twoje
  /// słowa — także wpisany w terminalu na Macu. Notka harnessu zostaje nowa: mówi, co się stało pod
  /// nieobecność. Porównanie ostre — wiadomość, na której skończyło się czytanie, nie jest nowa;
  /// nieczytelny czas nie jest „nowszy". `bornBefore` (początek wizyty): wiadomość urodzona później
  /// przyszła na żywo, na oczach czytającego, i linii nie dostaje.
  public static func index(_ messages: [TranscriptMessage], seenAt: String?, bornBefore: Date? = nil) -> Int? {
    guard let seenAt, let seen = ServerTime.parse(seenAt) else { return nil }
    for (index, message) in messages.enumerated() {
      guard let at = ServerTime.parse(message.at), at > seen, !message.isHumanPrompt, !ToolRuns.isToolOnly(message)
      else { continue }
      if let bornBefore, at >= bornBefore { continue }
      return index
    }
    return nil
  }

  /// Liczba na pigułce „N nowych wiadomości": BLOKI tekstu agenta od wiadomości z linią w dół, nie
  /// wiadomości — historia po restarcie serwera skleja turę asystenta w jedną wiadomość, a ogon na żywo daje wiadomość
  /// na wpis, więc liczba wiadomości zależałaby od drogi, którą treść przyszła. Narzędzia, prompty, notki i pusty tekst
  /// się nie liczą. `bornBefore` jak w ``index(_:seenAt:bornBefore:)``: wiadomość urodzona później przyszła na żywo.
  public static func count(_ messages: some Collection<TranscriptMessage>, bornBefore: Date? = nil) -> Int {
    messages.reduce(0) { total, message in
      guard message.effectiveRole == .assistant else { return total }
      if let bornBefore, let at = ServerTime.parse(message.at), at >= bornBefore { return total }
      return total + message.blocks.filter { block in
        guard case let .text(text, _) = block else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }.count
    }
  }
}

/// Skok do linii „NOWE" po tapie w pigułkę.
public enum NewLineJump {
  /// Odstęp pigułki od paska cytatu albo od góry safe area — i linii od nich po skoku.
  public static let gap: Double = 6

  /// The list offset (`contentOffset.y`) at which the line stands `gap` under the quote bar. The bar hangs from the
  /// safe area's top (the header's edge), so the band above the line is the bar's height and one gap, as for the jump
  /// to a turn from the prompts list.
  /// `bar == nil` — w transkrypcie nie ma promptów, paska nie będzie: linia `gap` pod górą. Przy samej górze treści
  /// pasek zostaje schowany (`PromptBar.nearTop` liczy się od przesunięcia), więc lista staje tuż przed progiem:
  /// linia bez pustego pasa po pasku i bez paska, który by ją zasłonił.
  public static func offset(lineMinY: Double, insetTop: Double, bar: Double?) -> Double {
    let bare = lineMinY - insetTop - gap
    guard let bar else { return bare }
    let underBar = lineMinY - insetTop - bar - gap
    if underBar + insetTop >= PromptBar.nearTop { return underBar }
    return min(bare, PromptBar.nearTop - insetTop - 1)
  }

  /// Wiersz, na który po skoku idzie fokus czytnika: pierwszy wiersz treści wiadomości za linią — nie znacznik
  /// godziny po przerwie, który stoi między nimi (`TranscriptRows.messageRows`).
  public static func focusRow(_ ids: [String]) -> String? {
    guard let line = ids.firstIndex(of: TranscriptRow.newMarker().id) else { return nil }
    return ids[(line + 1)...].first { $0.hasPrefix("m") }
  }
}

/// Pigułka „N nowych wiadomości" w jednej ocenie: schowana, stoi z liczbą albo czeka jeszcze tyle sekund na ciszę.
public enum NewPillState: Sendable, Equatable {
  case hidden
  case shown(Int)
  case wait(TimeInterval)
}

/// Gdzie leży linia „NOWE" względem widocznego obszaru listy (pigułka).
public enum NewLinePlace: Sendable, Equatable {
  case above, visible, below

  /// Krawędzie w układzie listy: `top` pod paskiem cytatu albo paskami systemu, `bottom` nad wstawką dna. Linia
  /// choćby częściowo między nimi jest na ekranie.
  public static func of(lineMinY: Double, lineMaxY: Double, top: Double, bottom: Double) -> NewLinePlace {
    if lineMaxY <= top { return .above }
    if lineMinY >= bottom { return .below }
    return .visible
  }
}

/// Decyzja o linii „NOWE" w jednej wizycie. Zapada RAZ, na pierwszej świeżej treści z serwera:
/// transkrypt z pamięci (LRU rdzenia) to stan sprzed wyjścia, na którym nowego nie ma nigdy.
/// Do tej chwili linia liczy się z tego, co jest, ale się nie zamraża. Po zamrożeniu stoi —
/// wiadomości na żywo jej nie przesuwają.
///
/// Wizyta zaczyna się wejściem na ekran sesji albo powrotem apki z tła z tą sesją na ekranie (jak
/// w Slacku po przerwie). Powrót zakłada NOWĄ decyzję od tego, co ekran zapisał
/// przy zejściu w tło; granicą „na żywo" jest wtedy chwila powrotu, a zamyka ją to samo co przy wejściu.
///
/// Świeża treść przychodzi dwiema drogami. Bez kursora (pierwsze wejście, kursor za stary) —
/// pełnym stanem, który podbija licznik snapshotów. Z ważnym kursorem (powrót do sesji
/// z pamięci) serwer odtwarza ramki z bufora BEZ snapshotu i bez znacznika końca powtórki.
/// Granicą jest wtedy chwila wejścia: wiadomość urodzona wcześniej przyszła pod nieobecność
/// (powtórka), późniejsza — na żywo, linii nie dostaje, a pierwsza taka zamyka decyzję
/// (powtórka idzie w kolejności bufora, przed każdą ramką na żywo). `at` to zegar serwera,
/// wejście — urządzenia; oba chodzą za czasem sieciowym, rozjazd liczy się w milisekundach.
public struct NewMarkerDecision: Sendable, Equatable {
  /// `at` najnowszej wiadomości widzianej przy poprzedniej wizycie; `nil` = pierwsza wizyta (bez linii).
  public let seenAt: String?
  /// Ile pełnych stanów miał transkrypt przy wejściu — świeży jest dopiero następny.
  public let snapshotsAtEntry: Int
  /// Chwila wejścia do sesji albo powrotu z tła; `nil` = bez granicy (tylko snapshot zamyka decyzję).
  public let enteredAt: Date?
  public private(set) var seq: Int?
  public private(set) var fixed = false
  /// Bloki tekstu agenta od linii w dół (``NewMarker/count(_:bornBefore:)``) — liczone razem z linią, po zamrożeniu
  /// stoją jak ona: wiadomości na żywo liczby nie zmieniają.
  public private(set) var count = 0
  /// Człowiek doszedł do linii: wjechała na ekran pod jego gestem albo stuknął w pigułkę. Pigułka już nie wraca.
  /// Nowa wizyta to nowa decyzja, więc zeruje się sama.
  public private(set) var lineSeen = false
  /// Ostatnia zmiana linii albo liczby (`settle`): pigułka przed zamrożeniem czeka na ciszę (``pillQuiet``).
  public private(set) var changedAt: Date?
  /// Pigułka mogła już stanąć w tej wizycie (zamrożenie albo cisza): dalsze zmiany liczby jej nie chowają.
  public private(set) var pillReady = false

  /// Cisza, po której linia i liczba uchodzą za ustalone bez zamrożenia: powtórka z bufora przychodzi seriami ramek
  /// w odstępach renderu (60 ms), a końca nie zgłasza.
  public static let pillQuiet: TimeInterval = 0.5

  public init(seenAt: String? = nil, snapshotsAtEntry: Int = 0, enteredAt: Date? = nil) {
    self.seenAt = seenAt
    self.snapshotsAtEntry = snapshotsAtEntry
    self.enteredAt = enteredAt
  }

  public mutating func settle(_ view: TranscriptState?, now: Date = Date()) {
    guard !fixed, let view, view.snapshots > 0, let newest = view.messages.last else { return }
    let index = NewMarker.index(view.messages, seenAt: seenAt, bornBefore: enteredAt)
    let line = index.map { view.messages[$0].seq }
    let missed = index.map { NewMarker.count(view.messages[$0...], bornBefore: enteredAt) } ?? 0
    // Linia przeszła gdzie indziej przed zamrożeniem: tamtej człowiek nie widział jako tej, pigułka czeka od nowa.
    if line != seq {
      lineSeen = false
      pillReady = false
    }
    if line != seq || missed != count { changedAt = now }
    seq = line
    count = missed
    fixed = view.snapshots > snapshotsAtEntry || bornLive(newest)
  }

  /// Pigułka „N nowych wiadomości". Stoi, póki linia leży NAD ekranem, a człowiek do niej nie doszedł:
  /// gaśnie do końca wizyty, gdy linia wjedzie na ekran pod GESTEM (`gesture`) albo po tapie (``reachLine()``).
  /// Przewinięcie bez gestu (zejście na dno przy wejściu, powrót na miejsce, dogrywanie treści, „Przewiń na dół")
  /// jej nie gasi, nawet gdy linia przez chwilę była na ekranie — automat nie „odczytuje” za człowieka.
  /// `place == nil` — linii nie ma w danych listy (wycięta przycięciem do 500 wiadomości
  /// albo jej nie ma). Bez bloków tekstu agenta (nowe są same notki) pigułki nie ma — linia wystarczy.
  ///
  /// Pierwszy raz staje po zamrożeniu decyzji albo po ``pillQuiet`` bez zmiany linii i liczby (`.wait` mówi, ile
  /// jeszcze), żeby nie migała w trakcie dogrywania. Samo zamrożenie nie wystarczy jako warunek: powrót z kursorem
  /// dostaje powtórkę bez znacznika końca, a decyzję zamyka dopiero pierwsza wiadomość na żywo — przy bezczynnym
  /// agencie nigdy.
  public mutating func pill(_ place: NewLinePlace?, gesture: Bool, now: Date = Date()) -> NewPillState {
    guard seq != nil, let place, !lineSeen else { return .hidden }
    switch place {
    case .visible:
      if gesture { lineSeen = true }
      return .hidden
    case .below:
      return .hidden
    case .above:
      guard count > 0 else { return .hidden }
      if !pillReady {
        let left = fixed ? 0 : Self.pillQuiet - now.timeIntervalSince(changedAt ?? now)
        guard left <= 0 else { return .wait(left) }
        pillReady = true
      }
      return .shown(count)
    }
  }

  /// Tap w pigułkę: lista jedzie do linii, pigułka w tej wizycie nie wraca.
  public mutating func reachLine() {
    lineSeen = true
  }

  /// „×” na pigułce zamyka ją i oznacza rzeczy jako przeczytane: linia i pigułka znikają do końca wizyty, a decyzja zamarza, więc dogrywanie treści ich nie
  /// przywraca. „Doczytane” zapisuje ekran.
  public mutating func dismiss() {
    seq = nil
    count = 0
    fixed = true
    lineSeen = true
  }

  /// Wiadomość urodzona po wejściu = przyszła na żywo, więc powtórka (jeśli była) już doszła.
  private func bornLive(_ message: TranscriptMessage) -> Bool {
    guard let enteredAt, let at = ServerTime.parse(message.at) else { return false }
    return at >= enteredAt
  }
}

/// „Dokąd TO urządzenie doczytało sesję": identyfikator i `at` najnowszej wiadomości przy wyjściu.
/// Zero treści. Sufit 32, wypada najdawniej oglądana. Uszkodzony zapis = brak pamięci (stan legalny).
public struct LastSeenMemory: Sendable, Equatable, Codable {
  public static let capacity = 32
  public static let key = "rarog.transcript.lastSeen"

  public struct Entry: Sendable, Equatable, Codable {
    public let id: String
    public let at: String
  }

  /// Najdawniej oglądana pierwsza.
  public private(set) var entries: [Entry] = []

  public init() {}

  public func seenAt(_ sessionId: String) -> String? {
    entries.last { $0.id == sessionId }?.at
  }

  /// Notuje wizytę; `true` = zmiana (zapis tylko wtedy).
  @discardableResult
  public mutating func note(_ sessionId: String, at: String) -> Bool {
    guard !sessionId.isEmpty, !at.isEmpty else { return false }
    if entries.last == Entry(id: sessionId, at: at) { return false }
    entries.removeAll { $0.id == sessionId }
    entries.append(Entry(id: sessionId, at: at))
    if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    return true
  }

  enum CodingKeys: String, CodingKey { case entries }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let raw = (try? c.decode([Entry].self, forKey: .entries)) ?? []
    entries = Array(raw.filter { !$0.id.isEmpty && !$0.at.isEmpty }.suffix(Self.capacity))
  }

  public static func load(from store: PreferenceStore) -> LastSeenMemory {
    guard let data = store.data(forKey: key) else { return LastSeenMemory() }
    return (try? JSONDecoder().decode(LastSeenMemory.self, from: data)) ?? LastSeenMemory()
  }

  public func save(to store: PreferenceStore) {
    guard let data = try? JSONEncoder().encode(self) else { return }
    store.set(data, forKey: Self.key)
  }
}
